// fidelity.js —— 论文复现保真度门 + 自动事故/教训记录（与 server.js 低耦合）
import fs from 'fs/promises';
import fssync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseLog, findLog, sigOf, titleKey, OPEN_STATUS, STATUS_WORD, applyDecisions, writeLog, collectEvidence, decisionMessage } from './deviations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LESSON_FILE = process.env.NF_LESSON_FILE || path.join(__dirname, 'skills', 'lessons.jsonl');

// 重大偏离：未经用户批准不得启动求解 / 收尾
const MAJOR_RULES = [
  { id: 'dimension', label: '降维（3D→2D/轴对称/楔形）', re: /(\b2D\b|二维|轴对称|axisymmetric|\bwedge\b|楔形|降维|quasi-?2D|伪二维)/i },
  { id: 'geometry', label: '删减/简化几何部件', re: /(不建|省略|去掉|删除|简化|不含|omit|remov|skip|without|neglect)[^\n]{0,30}(分布器|分布板|distributor|提升管|riser|入口|inlet|出口|outlet|挡板|baffle|内构件|几何)/i },
  { id: 'model', label: '更换论文指定物理模型', re: /(曳力|drag|湍流模型|turbulence model|KTGF|动理学|闭合|closure|反应模型)[^\n]{0,40}(改用|换成|替代|代替|首轮|instead|replace|→|->)/i },
  { id: 'bc', label: '边界条件简化/替代', re: /(均匀进气|uniform inlet|体积源项|源项近似|边界[^\n]{0,10}(简化|替代|近似))/i },
];
const APPROVED_RE = /user_approved\s*[:=]\s*(yes|true|是|已批准)/i;

export function labelOf(id) { return (MAJOR_RULES.find(r => r.id === id) || {}).label || id; }

// 登记条目 + 命中的重大偏离规则。编号形如 [DEV-001] [DEV-R2-003] [G1]；状态词见 deviations.js
export function parseDeviations(text) {
  return parseLog(text).map(e => {
    const p = ('[' + e.id + '] ' + e.head + '\n' + e.body).trim();
    return { ...e, text: p.slice(0, 600), majors: MAJOR_RULES.filter(r => r.re.test(p)).map(r => r.id), approved: e.status === 'approved' };
  });
}

export function isRepro(taskText) { return /(复现|重现|reproduc|replicat|论文|文献|这篇文章|原文|paper)/i.test(String(taskText || '')); }
function allows2D(taskText) {
  const t = String(taskText || '');
  if (/(必须|严格|禁止降维|不(要|许|准|得)[^\n]{0,6}(2D|二维|轴对称))/.test(t) && /(3D|三维)/.test(t)) return false;
  if (/(2D|二维|轴对称)[^\n]{0,12}(均可|可以|允许)|(允许|可以)[^\n]{0,12}(2D|二维|轴对称)/.test(t)) return true;
  // 任务本身就规定了二维/轴对称（如 Hysing 2009 二维气泡基准），且通篇没提三维：2D 是原题，不是降维
  return /(\b2D\b|二维|轴对称|axisymmetric|two-dimensional)/i.test(t) && !/(\b3D\b|三维|three-dimensional)/i.test(t);
}

// 保真度状态挂在任务上（持久化、无人值守续跑共享）
function _st(session) {
  const holder = session.task || session;
  return holder.fidelity || (holder.fidelity = { holds: [], userAckAt: 0, approved: [] });
}
export function holds(session) { return _st(session).holds; }
function addHold(session, key, label, detail, src) {
  const f = _st(session);
  if (f.holds.some(h => h.key === key)) return false;
  f.holds.push({ key, label, detail: String(detail).slice(0, 300), ts: Date.now(), src: src || '' });
  return true;
}
function dropHold(session, key, src) {
  const f = _st(session);
  f.holds = f.holds.filter(h => !(h.key === key && (!h.src || h.src === src)));
}

// 登记条目 → 该拦的项：
// · 明确标了 PENDING / REJECTED / REVISE 的：一律拦，直到用户批准；
// · 没标状态的（旧格式）和 INFO：命中重大偏离规则才拦；
// · 标了 APPROVED 的要有来历：审批卡片上批准过且标题没再改，或登记为待批之后用户回过话。
//   用户没回复（提问超时）时智能体自己把 PENDING 改成 APPROVED，过不了这一条。
const OPEN_LABEL = { pending: '待用户批准的偏离', rejected: '用户未批准的偏离', revise: '用户要求修改的偏离' };
export function logHolds(f, entries, taskText, now = Date.now()) {
  const want = [];
  const seen = f.seen || (f.seen = {});
  const cards = f.decisions || {};
  const ok = key => f.approved.includes(key);
  for (const d of entries) {
    const detail = `[${d.id}] ${d.title || d.head || ''}`;
    const majors = d.majors.filter(k => !(k === 'dimension' && allows2D(taskText)));
    if (OPEN_STATUS.has(d.status)) {
      if (!seen[d.id]) seen[d.id] = now;
      const label = OPEN_LABEL[d.status];
      if (!majors.length) { if (!ok(`${d.id}:approval`)) want.push({ key: `${d.id}:approval`, label, detail }); continue; }
      for (const k of majors) if (!ok(`${d.id}:${k}`)) want.push({ key: `${d.id}:${k}`, label: `${label} · ${labelOf(k)}`, detail });
      continue;
    }
    if (d.status === 'approved') {
      const card = cards[d.id];
      const byCard = !!card && card.decision === 'approve' && card.title === titleKey(d);
      const since = byCard ? 0 : card ? card.at : (seen[d.id] || 0);
      const key = `${d.id}:selfapproved`;
      if (since && !((f.userAckAt || 0) >= since) && !ok(key)) want.push({ key, label: '登记为已批准，但没有用户批准的记录', detail });
      else delete seen[d.id];   // 这次批准有来历：之后再改回待批，从那时起重新要依据
      continue;
    }
    // 已撤回（改回按原文做了）：留痕，不拦
    if (d.status === 'withdrawn') continue;
    for (const k of majors) {
      if (ok(`${d.id}:${k}`) || ok(k)) continue;
      want.push({ key: `${d.id}:${k}`, label: labelOf(k), detail });
    }
  }
  return want;
}

// 审批卡片上的决定：记进任务状态（批准的来历），并按决定收放对应的 hold
// list: [{ id, decision: 'approve' | 'reject' | 'modify', note, title, detail, sig }]（text 留作复现档案的「用户批的是哪一版」）
export async function recordDecisions(session, list, now = Date.now()) {
  const f = _st(session);
  const cards = f.decisions || (f.decisions = {});
  for (const x of list) {
    cards[x.id] = { decision: x.decision, at: now, title: titleKey(x), sig: x.sig || sigOf(x), note: String(x.note || '').slice(0, 500), text: (String(x.title || '') + '\n' + String(x.detail || '')).trim().slice(0, 1500) };
    const mine = k => String(k).startsWith(x.id + ':');
    f.approved = f.approved.filter(k => !mine(k));
    if (x.decision === 'approve') f.holds = f.holds.filter(h => !mine(h.key));
  }
  await recordLesson({ kind: 'deviation_decision', detail: list.map(x => `${x.id}=${x.decision}${x.note ? '（' + String(x.note).slice(0, 120) + '）' : ''}`).join(', ') });
}

// 智能体向用户提问的那一刻记下哪些条目还在待批（之后「已批准」要有用户回话或卡片批准作依据）
export async function noteCase(session, caseDir) {
  const log = await findLog(caseDir);
  if (!log) return [];
  const f = _st(session);
  const entries = parseDeviations(log.text);
  logHolds(f, entries, f.taskText || '');
  return entries.filter(e => OPEN_STATUS.has(e.status)).map(e => e.id);
}

async function _read(p) { try { return await fs.readFile(p, 'utf8'); } catch { return ''; } }

// ---------------------------------------------------------------- 偏离审批卡片（/api/deviations）
const _rel = (root, f) => path.relative(root, f).split(path.sep).join('/');
const _inside = (root, f) => { const r = path.relative(root, f); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
async function _taskLog(task, workspace, caseDir) {
  const log = task && caseDir ? await findLog(caseDir) : null;
  return log && _inside(path.resolve(workspace), log.file) ? log : null;
}
// 证据图要在算例目录里找文件：同一版登记 20 s 内不重复找（界面每几秒刷新一次卡片）
const _evCache = new Map();
async function _evidence(workspace, caseDir, log, entries) {
  const key = log.mtime + ':' + log.size;
  const hit = _evCache.get(log.file);
  if (hit && hit.key === key && Date.now() - hit.at < 20000) return hit.ev;
  const ev = await collectEvidence({ workspace, caseDir, entries });
  _evCache.set(log.file, { key, at: Date.now(), ev });
  if (_evCache.size > 50) _evCache.delete(_evCache.keys().next().value);
  return ev;
}

// 卡片视图：登记里的每一条、状态、证据图、是否在等用户决定。noted = 任务状态有新记录，需要落盘
export async function deviationView({ task, workspace, caseDir }) {
  const log = await _taskLog(task, workspace, caseDir);
  if (!log) return { data: { file: '', caseDir: '', entries: [], caseImages: [], waiting: 0, gated: false }, noted: false };
  const f = _st({ task });
  const before = Object.keys(f.seen || {}).length;
  const taskText = f.taskText || task.taskText || '';
  const gated = isRepro(taskText);
  const entries = parseDeviations(log.text);
  const want = logHolds(f, entries, taskText);
  const ev = await _evidence(workspace, caseDir, log, entries);
  const cards = f.decisions ? f.decisions : Object.create(null);
  const list = entries.map(e => {
    const sig = sigOf(e);
    const card = cards[e.id] || null;
    const unbacked = want.some(w => w.key === `${e.id}:selfapproved`);
    const blocking = gated && want.some(w => w.key.startsWith(e.id + ':'));
    return {
      id: e.id, status: e.status, title: e.title, detail: e.detail, sig, majors: e.majors.map(labelOf),
      evidence: ev.byId.get(e.id) || [], userNote: e.userNote, unbacked, blocking,
      needsUser: e.status === 'pending' || unbacked || (blocking && !OPEN_STATUS.has(e.status)),
      decided: card ? { decision: card.decision, at: card.at, note: card.note, changed: card.sig !== sig } : null,
    };
  });
  return {
    data: { file: _rel(workspace, log.file), caseDir: _rel(workspace, caseDir), mtime: log.mtime, entries: list, caseImages: ev.caseImages, waiting: list.filter(e => e.needsUser).length, gated },
    noted: Object.keys(f.seen).length !== before,
  };
}

// 提交决定：校验 → 写回登记 → 记进任务状态 → 生成发给智能体的消息
// decisions: [{ id, decision: 'approve' | 'reject' | 'modify', note, sig }]；sig 是用户看到的那一版条目的指纹
export async function decideDeviations({ task, workspace, caseDir, decisions }) {
  const log = await _taskLog(task, workspace, caseDir);
  if (!log) return { ok: false, status: 404, error: '这个任务的算例目录里没有 deviations.log.md' };
  const entries = parseLog(log.text);
  const list = [];
  for (const x of Array.isArray(decisions) ? decisions.slice(0, 60) : []) {
    const e = x && entries.find(k => k.id === x.id);
    if (!e || !STATUS_WORD[x.decision]) return { ok: false, status: 400, error: `无效的决定：${x && x.id}` };
    if (list.some(k => k.id === e.id)) return { ok: false, status: 400, error: `${e.id} 重复提交` };
    if (x.sig !== sigOf(e)) return { ok: false, status: 409, stale: e.id, error: `${e.id} 的内容在你查看之后被改过，请按最新内容重新决定` };
    const note = String(x.note || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (x.decision === 'modify' && !note) return { ok: false, status: 400, error: `${e.id}：要求修改时请写明怎么改` };
    list.push({ id: e.id, decision: x.decision, note, title: e.title, detail: e.detail, sig: sigOf(e) });
  }
  if (!list.length) return { ok: false, status: 400, error: '没有要提交的决定' };
  const at = id => entries.findIndex(k => k.id === id);
  list.sort((a, b) => at(a.id) - at(b.id));
  const out = applyDecisions(log.text, list);
  await writeLog(log.file, out.text);
  await recordDecisions({ task }, list);
  const f = _st({ task });
  const after = parseDeviations(out.text);
  const want = logHolds(f, after, f.taskText || task.taskText || '');
  f.holds = f.holds.filter(h => h.src !== log.file || want.some(w => w.key === h.key));
  const open = after.filter(e => OPEN_STATUS.has(e.status));
  return { ok: true, applied: out.applied, open: open.map(e => ({ id: e.id, status: e.status })), message: decisionMessage(list, open, _rel(workspace, log.file)) };
}

// 扫描算例：网格是否降维 + 偏离记录里的重大偏离；返回新增的 hold 列表
export async function scanCase(session, caseDir, taskText) {
  const f = _st(session);
  taskText = f.taskText || taskText;
  if (!isRepro(taskText) || !caseDir) return [];
  const added = [];
  const bnd = await _read(path.join(caseDir, 'constant', 'polyMesh', 'boundary'));
  if (/type\s+(wedge|empty)\s*;/.test(bnd) && !allows2D(taskText) && !f.approved.includes('dimension')) {
    const kind = /type\s+wedge/.test(bnd) ? '轴对称 wedge' : '2D empty';
    if (addHold(session, 'dimension', labelOf('dimension'), `${caseDir} 网格含 ${kind} patch，论文为 3D`, caseDir)) added.push('dimension');
  } else if (!/type\s+(wedge|empty)\s*;/.test(bnd)) dropHold(session, 'dimension', caseDir);
  let cm = '';
  try { for (const fn of fssync.readdirSync(caseDir).filter(n => /^log\.checkMesh/.test(n))) { cm = await _read(path.join(caseDir, fn)); if (/bounding box/.test(cm)) break; } } catch {}
  const gw = gravityWarning(await _read(path.join(caseDir, 'constant', 'g')), cm ? '' : await _read(path.join(caseDir, 'constant', 'polyMesh', 'points')), cm);
  if (!gw) dropHold(session, 'gravity', caseDir);
  else if (!f.approved.includes('gravity') && addHold(session, 'gravity', '重力方向与几何竖直轴不一致', gw, caseDir)) added.push('gravity');
  const log = await findLog(caseDir);
  if (log) {
    const entries = parseDeviations(log.text);
    const want = logHolds(f, entries, taskText);
    const ids = new Set(entries.map(e => e.id));
    // 这份登记管的 hold：条目已修正 / 删除 / 获批的，解除
    const mine = h => h.src === log.file || (!h.src && h.key.includes(':') && ids.has(h.key.slice(0, h.key.indexOf(':'))));
    f.holds = f.holds.filter(h => !mine(h) || want.some(w => w.key === h.key));
    for (const w of want) if (addHold(session, w.key, w.label, w.detail, log.file)) added.push(w.key);
  }
  if (added.length) await recordLesson({ kind: 'fidelity_hold', task: String(taskText).slice(0, 160), case: caseDir, detail: f.holds.filter(h => added.includes(h.key)).map(h => `${h.label}: ${h.detail}`).join(' | ') });
  return added;
}

// KPI 可信度：统计窗起点须 ≥ 反应开启 + n·τ；窗长 ≥ τ；与原文吻合过好(<0.5%)但窗口不足时判"初值主导"
// kpis: [{name, this, paper, init?}]；init 为初值（如 CSTR 解），this≈init 说明 CFD 没改变它
export function kpiCredibility({ t_react_start, t_window = [], tau, n_tau = 2, kpis = [], outlet_min_flux = null } = {}) {
  const issues = [], notes = [];
  const [w0, w1] = Array.isArray(t_window) ? t_window : [];
  const validTau = Number.isFinite(tau) && tau > 0;
  const validWindow = Array.isArray(t_window) && t_window.length === 2 &&
    Number.isFinite(w0) && Number.isFinite(w1) && w0 >= 0 && w1 > w0;
  const validStart = Number.isFinite(t_react_start) && t_react_start >= 0;
  const validNTau = Number.isFinite(n_tau) && n_tau > 0;
  if (!validTau) issues.push('缺停留时间 τ（=反应区体积/气相体积流量），无法判断是否达到准稳态');
  if (!validWindow) issues.push('缺统计时间窗 t_window=[t0,t1]');
  if (!validStart) issues.push('反应开启时间必须为非负有限数值');
  if (!validNTau) issues.push('n_tau 必须为正有限数值');
  if (validTau && validWindow && validStart && validNTau) {
    const need = t_react_start + n_tau * tau;
    if (!Number.isFinite(need) || !Number.isFinite(w1 - w0)) issues.push('时间计算超出有限数值范围');
    if (w0 < need) issues.push(`统计窗起点 ${w0} s < 反应开启 ${t_react_start} s + ${n_tau}τ(${(n_tau * tau).toFixed(1)} s) = ${need.toFixed(1)} s，出口未达准稳态`);
    if (w1 - w0 < tau) issues.push(`统计窗长 ${(w1 - w0).toFixed(1)} s < τ=${tau.toFixed(1)} s，统计不足`);
  }
  if (outlet_min_flux !== null && !Number.isFinite(outlet_min_flux)) issues.push('出口通量必须为有限数值');
  else if (outlet_min_flux !== null && outlet_min_flux < 1e-9) issues.push(`出口有组分通量仅 ${outlet_min_flux.toExponential(2)} kg/s，产物尚未到达出口，相应 KPI 无意义`);
  if (!Array.isArray(kpis) || !kpis.length) issues.push('缺少非空 KPI 列表');
  const initDominated = [];
  const validKpis = [];
  for (const k of Array.isArray(kpis) ? kpis : []) {
    if (!k || !Number.isFinite(k.this) || !Number.isFinite(k.paper) ||
      (Object.hasOwn(k, 'init') && !Number.isFinite(k.init))) {
      issues.push('KPI 的 this/paper/init 必须为有限数值');
      continue;
    }
    validKpis.push(k);
    const v = k.this, p = k.paper;
    if (p) notes.push(`${k.name}: 本次 ${v} vs 原文 ${p}（${((v - p) / p * 100).toFixed(2)}%）`);
    if (Object.hasOwn(k, 'init') && Math.abs(v - k.init) <= 0.005 * Math.abs(k.init || 1)) initDominated.push(k.name);
  }
  if (initDominated.length) notes.push(`初值主导（本次≈初值，CFD 未改变它，不能作复现证据）：${initDominated.join(', ')}`);
  const evidence = validKpis.filter(k => !initDominated.includes(k.name)).map(k => k.name);
  if (validKpis.length && !evidence.length) issues.push('所有 KPI 都是初值主导，没有对流场敏感的证据量（加入转化率、组分轴向分布、压降等）');
  return { passed: issues.length === 0, issues, notes, evidence };
}

// 立式设备：g 必须沿包围盒最长轴且为负向；ASCII points 才能读出包围盒，binary 时只靠 g 本身是否非零单轴
export function gravityWarning(gTxt, pointsTxt, checkMeshTxt) {
  const m = /value\s*\(\s*([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s*\)/.exec(String(gTxt || ''));
  if (!m) return '';
  const g = m.slice(1, 4).map(Number);
  const gAxis = g.map(Math.abs).indexOf(Math.max(...g.map(Math.abs)));
  if (Math.abs(g[gAxis]) < 1e-6) return '';
  const N = '([-\\d.eE+]+)';
  const bb = new RegExp(`bounding box\\s*\\(${N}\\s+${N}\\s+${N}\\)\\s*\\(${N}\\s+${N}\\s+${N}\\)`).exec(String(checkMeshTxt || ''));
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  if (bb) { lo = bb.slice(1, 4).map(Number); hi = bb.slice(4, 7).map(Number); }
  else {
    const head = String(pointsTxt || '').slice(0, 4e6);
    if (/format\s+binary/.test(head)) return '';
    for (const p of head.matchAll(/\(\s*([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s*\)/g)) {
      for (let i = 0; i < 3; i++) { const v = +p[i + 1]; if (v < lo[i]) lo[i] = v; if (v > hi[i]) hi[i] = v; }
    }
  }
  if (!isFinite(lo[0])) return '';
  const span = hi.map((h, i) => h - lo[i]);
  const longAxis = span.indexOf(Math.max(...span));
  const sorted = [...span].sort((a, b) => b - a);
  if (sorted[0] < 2 * sorted[1] || gAxis === longAxis) return '';
  const ax = 'xyz';
  return `g=(${g.join(' ')}) 沿 ${ax[gAxis]} 轴，但网格最长轴是 ${ax[longAxis]}（跨度 ${span[longAxis].toFixed(3)} m vs ${span[gAxis].toFixed(3)} m）。立式反应器/流化床重力应为 ${ax[longAxis]} 负向，请核对 constant/g`;
}

export function gateMessage(session, action) {
  const hs = holds(session);
  if (!hs.length) return '';
  const list = hs.map((h, i) => `  ${i + 1}) [${h.key}] ${h.label} —— ${h.detail}`).join('\n');
  return `[保真度门] ⛔ 拦截 ${action}：论文复现存在 ${hs.length} 项未经用户批准的重大偏离：\n${list}\n` +
    `规则：降维 / 删几何部件（分布器、入口、提升管等）/ 换论文指定模型 / 简化边界 必须先获用户明确批准，任务文字里的"可选/均可"不算批准。\n` +
    `下一步：① 优先按原文修正（建 3D、补全几何、用原文模型），修正后把 deviations.log.md 里该条标 WITHDRAWN 并写明已按原文实现（不要删条目）；` +
    `② 确实做不到 → 在 deviations.log.md 把该条标 PENDING（附 evidence: 图片路径），向用户发「偏离申报」并等待：界面会给每条显示审批卡片，用户在卡片上批准后系统自动放行；` +
    `用户在对话里明确批准的条目，由你把该条状态改为 APPROVED 并注明依据。用户没有回复时不得自行改成 APPROVED。不要绕过本门。`;
}

const APPROVE_WORDS = /(批准|同意|允许|可以降|接受|approve|ok\b|确认偏离)/i;
const REJECT_WORDS = /(不(行|可以|同意|允许|批准)|必须|按原文|拒绝|reject)/i;
// 用户消息：批准 → 放行；批评/纠错 → 自动记一条教训
export async function onUserMessage(session, text) {
  const f = _st(session);
  const t = String(text || '');
  // 审批卡片的汇总消息：决定已逐条记录，不按关键词整体放行，也不算一次「用户回话」
  const fromCards = /^偏离审批/.test(t.trim());
  if (!fromCards && t.trim() && !/^继续推进未完成的工作$/.test(t.trim())) f.userAckAt = Date.now();
  if (isRepro(t) && (!f.taskText || t.length > 200)) f.taskText = t.slice(0, 4000);
  if (!fromCards && f.holds.length && APPROVE_WORDS.test(t) && !REJECT_WORDS.test(t)) {
    for (const h of f.holds) f.approved.push(h.key);
    await recordLesson({ kind: 'deviation_approved', detail: f.holds.map(h => h.key).join(', '), user: t.slice(0, 300) });
    f.holds = [];
  }
  if (/(不对|错了|有问题|为什么(不|没)|怎么(不|没)|必须|不能|别再|又)/.test(t) && t.length > 4 && t.length < 600) {
    await recordLesson({ kind: 'user_correction', user: t.slice(0, 400) });
  }
}

// ---------------------------------------------------------------- 教训库
export async function recordLesson(rec) {
  try {
    await fs.mkdir(path.dirname(LESSON_FILE), { recursive: true });
    await fs.appendFile(LESSON_FILE, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n', 'utf8');
  } catch {}
}
export function loadLessons() {
  try { return fssync.readFileSync(LESSON_FILE, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}
// 规则型教训（kind=rule）按关键词命中注入 system prompt；最多 cap 条
export function lessonsFor(taskText, cap = 8) {
  const t = String(taskText || '').toLowerCase();
  const rules = loadLessons().filter(l => l.kind === 'rule' && l.rule);
  const hit = rules.filter(l => !(l.triggers || []).length || l.triggers.some(k => t.includes(String(k).toLowerCase())));
  if (!hit.length) return '';
  const seen = new Set();
  const lines = [];
  for (const l of hit.reverse()) { if (seen.has(l.rule)) continue; seen.add(l.rule); lines.push(`- ${l.rule}`); if (lines.length >= cap) break; }
  return `\n\n# 🧯 历史事故教训（自动记录 · 必须遵守）\n${lines.join('\n')}\n`;
}

// 新报错自动学习：让 LLM 从「报错 + 之后的修复轨迹」总结正则模式；正则必须能匹配原报错才入库
// 去掉 gdb / 栈回溯 / MPI 噪声，只保留真正的报错语义行；噪声占比过高的样本直接丢弃
const _NOISE_RE = /^\s*(#\d+\s|\[Thread |\[New Thread|\(gdb\)|Reading symbols|Using host libthread|0x[0-9a-f]{6,}|in \?\?|warning: |--------+$|MPI_ABORT|mpirun (has exited|noticed)|Primary job|prterun|\[\w+:\d+\] )/i;
export function cleanErrorText(err) {
  const lines = String(err || '').split(/\r?\n/);
  const keep = lines.filter(l => l.trim() && !_NOISE_RE.test(l));
  return { text: keep.join('\n').trim(), noiseRatio: lines.length ? 1 - keep.length / lines.length : 1 };
}

export async function autoLearnErrors(novel, trajectory, llm, addPattern) {
  const done = [];
  for (const raw of (novel || []).slice(0, 5)) {
    const { text: err, noiseRatio } = cleanErrorText(raw);
    if (err.length < 30 || noiseRatio > 0.7 || !/FATAL|sigFpe|Segmentation|Traceback|Error|error/.test(err)) continue;
    const sys = '你是 CFD 报错知识库维护者。根据报错和随后的修复轨迹，输出唯一一个 JSON 对象：{"pattern":"能稳定匹配该类报错的 JS 正则(不含斜杠,取报错里的固定关键字)","category":"简短类别","causes":["根因"],"steps":["修复步骤"]}。只输出 JSON。';
    const out = await llm(sys, `报错:\n${err}\n\n之后的修复轨迹(节选):\n${String(trajectory).slice(-3000)}`);
    if (!out) continue;
    let j; try { j = JSON.parse(out.replace(/^```(json)?|```$/gm, '').trim()); } catch { continue; }
    try { if (!j.pattern || !new RegExp(j.pattern, 'i').test(err)) continue; } catch { continue; }
    // 拒绝过宽 / 噪声模式：太短、或能匹配普通求解日志行
    if (j.pattern.replace(/[^\w\u4e00-\u9fa5]/g, '').length < 6) continue;
    if (/gdb|Thread|0x|mpirun|MPI_ABORT/i.test(j.pattern)) continue;
    try { if (new RegExp(j.pattern, 'i').test('Time = 0.1\nCourant Number mean: 0.1 max: 0.5\nExecutionTime = 1 s')) continue; } catch { continue; }
    const r = await addPattern({ pattern: j.pattern, flags: 'i', category: j.category || '自动学习', causes: j.causes || [], steps: j.steps || [] });
    if (r && r.ok) { done.push(j.category); await recordLesson({ kind: 'error_pattern', detail: `${j.category}: /${j.pattern}/`, error: err.slice(0, 200) }); }
  }
  return done;
}
