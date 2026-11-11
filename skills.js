// ============================================================================
// skills.js —— CFDriver 经验自进化模块（独立、可导出、verifier-grounded）
// ----------------------------------------------------------------------------
// 设计原则（每条都是为了"避坑"而焊死的）：
//  1. 只沉淀「verifier 盖章通过」的经验 → grounded，杜绝模型自夸幻觉。
//  2. 每个技能 = 一个独立 .skill.json 文件 → 可单独 copy / 分享 / git / 打包导出。
//  3. 注入时按 (命中触发词数 · 含坑含参 · 命中数 hits · 新鲜度) 排序 + 封顶 top-K + content-hash 去重。
//  4. 技能/错误记忆与 harness 彻底分离（本模块 + skills/ 目录，绝不塞进大 system prompt）。
//  5. 错误模式可成长：撞过的坑修好→追加一条，diagnose_error 下次秒命中。
// 与 server.js 的耦合面极小：init / injectionFor / learnedErrorPatterns /
//  saveSkill / listSkills / removeSkill / exportBundle / importBundle /
//  analyzeTrajectory / draftFromTrajectory / addErrorPattern。
// ============================================================================
import fs from 'fs/promises';
import fssync from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 技能库存放在“应用目录”而非用户算例工作区 —— 它是跨算例复用的领域经验，应随程序持久化。
const ROOT = path.join(__dirname, 'skills');
const DOMAINS = ['foam', 'mfix', 'lbm', 'general'];
const ERR_FILE = path.join(ROOT, 'error_patterns.json');

const INJECT_CAP = 3;          // 注入封顶（避免盖过长程规则）
const RECIPE_MAX_STEPS = 10;   // 单卡配方步数上限（保持短）

let _skills = new Map();        // id -> skill object
let _hashIndex = new Map();     // content_hash -> id（去重）
let _errPatterns = [];          // 学到的错误模式（{pattern,flags,category,causes,steps,hits,ts}）
let _ready = false;

function _sha1(s) { return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16); }

function _slug(s) {
  return String(s || 'skill').toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'skill';
}

function _contentHash(sk) {
  // 内容指纹只取“配方语义”字段，触发词/统计变化不影响去重
  return _sha1(JSON.stringify({
    d: sk.domain, s: sk.solver || '', p: sk.physics || '',
    r: (sk.recipe || []).map(x => String(x).trim()).join('|'),
    k: sk.key_params || {}
  }));
}

async function _ensureDirs() {
  await fs.mkdir(ROOT, { recursive: true });
  for (const d of DOMAINS) await fs.mkdir(path.join(ROOT, d), { recursive: true });
}

function _filePathFor(sk) {
  const dom = DOMAINS.includes(sk.domain) ? sk.domain : 'general';
  return path.join(ROOT, dom, `${sk.id}.skill.json`);
}

// ----------------------------------------------------------------------------
// 初始化：扫描所有 .skill.json + 载入错误模式
// ----------------------------------------------------------------------------
export async function init() {
  await _ensureDirs();
  _skills = new Map(); _hashIndex = new Map();
  for (const d of DOMAINS) {
    const dir = path.join(ROOT, d);
    let files = [];
    try { files = await fs.readdir(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.skill.json')) continue;
      try {
        const sk = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
        if (sk && sk.id) { _skills.set(sk.id, sk); if (sk.content_hash) _hashIndex.set(sk.content_hash, sk.id); }
      } catch {}
    }
  }
  try { _errPatterns = JSON.parse(await fs.readFile(ERR_FILE, 'utf8')); if (!Array.isArray(_errPatterns)) _errPatterns = []; }
  catch { _errPatterns = []; }
  _ready = true;
  return { skills: _skills.size, errorPatterns: _errPatterns.length };
}

function _norm(sk) {
  const out = {
    id: sk.id || '',
    title: String(sk.title || '未命名技能').slice(0, 120),
    domain: DOMAINS.includes(sk.domain) ? sk.domain : 'general',
    triggers: Array.from(new Set((sk.triggers || []).map(t => String(t).trim().toLowerCase()).filter(Boolean))).slice(0, 24),
    solver: sk.solver ? String(sk.solver).slice(0, 60) : '',
    physics: sk.physics ? String(sk.physics).slice(0, 200) : '',
    recipe: (sk.recipe || []).map(x => String(x).trim()).filter(Boolean).slice(0, RECIPE_MAX_STEPS),
    key_params: (sk.key_params && typeof sk.key_params === 'object') ? sk.key_params : {},
    verify_seq: (sk.verify_seq || []).map(x => String(x)).slice(0, 8),
    pitfalls: (sk.pitfalls || []).map(x => String(x).trim()).filter(Boolean).slice(0, 8),
    provenance: sk.provenance || {},
    stats: sk.stats || {},
  };
  if (!out.id) out.id = `${out.domain}-${_slug(out.solver || out.title)}-${_sha1(out.title + Date.now()).slice(0, 6)}`;
  out.content_hash = _contentHash(out);
  const now = Date.now();
  out.stats.created = out.stats.created || now;
  out.stats.updated = now;
  out.stats.hits = out.stats.hits || 0;
  return out;
}

// ----------------------------------------------------------------------------
// 保存技能：内容去重（同配方→并 hits 不新建），写成独立文件
// ----------------------------------------------------------------------------
export async function saveSkill(input) {
  if (!_ready) await init();
  const sk = _norm(input);
  const dupId = _hashIndex.get(sk.content_hash);
  if (dupId && _skills.has(dupId)) {
    const ex = _skills.get(dupId);
    ex.stats.hits = (ex.stats.hits || 0) + 1;
    ex.stats.updated = Date.now();
    // 触发词做并集（同配方可能在新任务里多了一种说法）
    ex.triggers = Array.from(new Set([...(ex.triggers || []), ...sk.triggers])).slice(0, 24);
    await fs.writeFile(_filePathFor(ex), JSON.stringify(ex, null, 2), 'utf8');
    _skills.set(ex.id, ex);
    return { ok: true, id: ex.id, path: _filePathFor(ex), deduped: true };
  }
  const fp = _filePathFor(sk);
  await fs.writeFile(fp, JSON.stringify(sk, null, 2), 'utf8');
  _skills.set(sk.id, sk); _hashIndex.set(sk.content_hash, sk.id);
  return { ok: true, id: sk.id, path: fp, deduped: false };
}

export async function removeSkill(id) {
  if (!_ready) await init();
  const sk = _skills.get(id);
  if (!sk) return { ok: false, error: '技能不存在: ' + id };
  try { await fs.unlink(_filePathFor(sk)); } catch {}
  _skills.delete(id); if (sk.content_hash) _hashIndex.delete(sk.content_hash);
  return { ok: true, id };
}

export function listSkills(filter = {}) {
  const arr = Array.from(_skills.values());
  const f = filter.domain ? arr.filter(s => s.domain === filter.domain) : arr;
  return f.map(s => ({ id: s.id, title: s.title, domain: s.domain, solver: s.solver,
    triggers: s.triggers, hits: s.stats?.hits || 0, updated: s.stats?.updated,
    verified_by: s.provenance?.verified_by || [] }));
}

export function getSkill(id) { return _skills.get(id) || null; }

// ----------------------------------------------------------------------------
// 检索注入：按相关度排序 + 封顶 + 去重，返回一段简短可注入文本（无命中返回 ''）
// ----------------------------------------------------------------------------
function _score(sk, text, modes) {
  const t = (text || '').toLowerCase();
  let hit = 0;
  for (const tr of sk.triggers) if (tr && t.includes(tr)) hit++;
  if (sk.solver && t.includes(sk.solver.toLowerCase())) hit += 1;
  if (hit === 0) return -1; // 不相关
  let score = hit * 10;
  if (modes && modes[sk.domain]) score += 4;           // 当前 Beta 模式匹配
  if ((sk.pitfalls || []).length) score += 2;          // 含踩坑经验更有价值
  if (Object.keys(sk.key_params || {}).length) score += 2;
  score += Math.min(sk.stats?.hits || 0, 10);          // 被复用越多越靠前（封顶）
  const ageDays = (Date.now() - (sk.stats?.updated || 0)) / 8.64e7;
  score += Math.max(0, 3 - ageDays / 30);              // 新鲜度小幅加权
  return score;
}

export function injectionFor(userText, modes = {}, cap = INJECT_CAP) {
  if (!_ready || _skills.size === 0) return '';
  const scored = [];
  for (const sk of _skills.values()) {
    const s = _score(sk, userText, modes);
    if (s >= 0) scored.push({ sk, s });
  }
  if (!scored.length) return '';
  scored.sort((a, b) => b.s - a.s);
  const pick = scored.slice(0, cap);
  // 注入是「分模块 + 排序」的：LLM 对靠前内容注意力最高 → 必须避开的坑置顶，其次可复用配方。
  const lines = [
    '\n\n# 📚 已验证经验（命中当前任务·按重要性自上而下排列，务必优先遵守）',
    '> 过去被 *_verify 盖章通过的可复用经验。可直接参考，但**本案仍必须走自己的 *_verify 闭环**核验。'
  ];
  // 模块一 · 必须避开的坑（hard，置顶，最高优先级）
  const pit = [];
  for (const { sk } of pick) for (const p of (sk.pitfalls || [])) pit.push(`${p}　〈${sk.title}〉`);
  const pitUniq = Array.from(new Set(pit)).slice(0, 6);
  if (pitUniq.length) {
    lines.push('\n## ⚠ 必须避开的坑（最高优先级，先看这一段）');
    pitUniq.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
  }
  // 模块二 · 可复用配方（按相关度排序）
  lines.push('\n## 🔧 可复用配方（按相关度，最多 ' + cap + ' 条）');
  pick.forEach(({ sk }, i) => {
    const matched = sk.triggers.filter(tr => (userText || '').toLowerCase().includes(tr));
    lines.push(`\n[${i + 1}] ${sk.title}（命中: ${matched.join(', ') || sk.domain}）`);
    if (sk.solver || sk.physics) lines.push(`  求解器: ${sk.solver || '—'} | 物理: ${sk.physics || '—'}`);
    if (sk.recipe.length) lines.push('  配方: ' + sk.recipe.map((r, k) => `${k + 1}) ${r}`).join('  '));
    const kp = Object.entries(sk.key_params || {});
    if (kp.length) lines.push('  关键参数: ' + kp.map(([k, v]) => `${k}=${v}`).join('; '));
    if ((sk.verify_seq || []).length) lines.push('  verify: ' + sk.verify_seq.join('→'));
  });
  // 命中即累加 hits（异步落盘，不阻塞）
  _bumpHits(pick.map(p => p.sk.id)).catch(() => {});
  return lines.join('\n');
}

async function _bumpHits(ids) {
  for (const id of ids) {
    const sk = _skills.get(id); if (!sk) continue;
    sk.stats.hits = (sk.stats.hits || 0) + 1; sk.stats.updated = Date.now();
    try { await fs.writeFile(_filePathFor(sk), JSON.stringify(sk, null, 2), 'utf8'); } catch {}
  }
}

// ----------------------------------------------------------------------------
// 错误模式（成长型）：返回已编译的 RegExp 数组，供 server 与内置 16 条合并
// ----------------------------------------------------------------------------
export function learnedErrorPatterns() {
  const out = [];
  for (const p of _errPatterns) {
    try { out.push({ re: new RegExp(p.pattern, p.flags || 'i'), category: p.category, causes: p.causes || [], steps: p.steps || [], learned: true }); }
    catch {}
  }
  return out;
}

export async function addErrorPattern({ pattern, flags, category, causes, steps }) {
  if (!_ready) await init();
  if (!pattern || !category) return { ok: false, error: 'pattern 和 category 必填' };
  try { new RegExp(pattern, flags || 'i'); } catch (e) { return { ok: false, error: '非法正则: ' + e.message }; }
  const key = _sha1(pattern + '|' + (flags || 'i'));
  const ex = _errPatterns.find(p => _sha1(p.pattern + '|' + (p.flags || 'i')) === key);
  if (ex) {
    ex.hits = (ex.hits || 0) + 1; ex.ts = Date.now();
    // 冲突消解：同 pattern 但本次给了更具体的 causes/steps → 合并（去重，不覆盖原有）
    if (Array.isArray(causes)) ex.causes = Array.from(new Set([...(ex.causes || []), ...causes])).slice(0, 8);
    if (Array.isArray(steps) && steps.length && !(ex.steps && ex.steps.length)) ex.steps = steps.slice(0, 8);
    if (category && ex.category !== category) ex.category = category; // 以最新归类为准
  } else {
    _errPatterns.push({ pattern, flags: flags || 'i', category, causes: causes || [], steps: steps || [], hits: 1, ts: Date.now() });
  }
  const pruned = _pruneErrPatterns();
  await fs.writeFile(ERR_FILE, JSON.stringify(_errPatterns, null, 2), 'utf8');
  return { ok: true, total: _errPatterns.length, deduped: !!ex, pruned };
}

// 错误模式衰减 + 封顶：按 rank(命中数权重 − 陈旧惩罚) 排序，超过上限淘汰低分（避免噪声堆积喧宾夺主）。
const MAX_ERR_PATTERNS = 200;
function _rankErr(p) { const ageDays = (Date.now() - (p.ts || 0)) / 864e5; return (p.hits || 1) * 2 - Math.min(ageDays / 30, 3); }
function _pruneErrPatterns() {
  if (_errPatterns.length <= MAX_ERR_PATTERNS) return 0;
  _errPatterns.sort((a, b) => _rankErr(b) - _rankErr(a));
  const removed = _errPatterns.length - MAX_ERR_PATTERNS;
  _errPatterns = _errPatterns.slice(0, MAX_ERR_PATTERNS);
  return removed;
}

// ----------------------------------------------------------------------------
// 轨迹分析：从一轮对话 messages 里判定“是否 verifier 通过”+ 抽 provenance/工具序列/参数
// messages: OpenAI 格式（assistant.tool_calls + role:'tool' 结果字符串）
// ----------------------------------------------------------------------------
const VERIFY_TOOLS = ['foam_mesh_verify', 'foam_geom_verify', 'foam_solve_verify', 'foam_post_verify', 'paper_param_verify'];
const PASS_RE = /"?pass(ed)?"?\s*[:=]\s*true|passed\s*[:=]\s*true|✅\s*通过|核验通过|pass\s*=\s*true/i;
const FAIL_RE = /"?pass(ed)?"?\s*[:=]\s*false|passed\s*[:=]\s*false|核验未通过|pass\s*=\s*false/i;
const NON_MUTATING_TOOLS = new Set([
  'read_file', 'list_dir', 'grep_search', 'glob', 'file_search', 'vision_analyze',
  'update_todos', 'run_stage_done', 'task_complete',
]);

function toolResult(content) {
  if (content && typeof content === 'object' && !Array.isArray(content)) return content;
  try { const result = JSON.parse(content); return result && typeof result === 'object' && !Array.isArray(result) ? result : null; } catch { return null; }
}

function successfulTrial(result) {
  const trial = result?.result || result;
  return typeof result?.evidence_path === 'string' && result.evidence_path.trim() !== '' &&
    result.ok !== false && !result.error && trial?.version === 1 && trial.passed === true && !trial.error &&
    Number.isFinite(trial.value) && /^[a-f0-9]{64}$/i.test(trial.configHash || '') &&
    Array.isArray(trial.stages) && trial.stages.length === 4 &&
    ['generate', 'mesh', 'solve', 'verify'].every((name, index) => {
      const stage = trial.stages[index];
      return stage?.name === name && stage.status === 'passed' && stage.exitCode === 0 &&
        stage.signal === null && stage.timedOut === false && !stage.error && !stage.validationError;
    }) && Array.isArray(trial.checks) && trial.checks.length > 0 &&
    trial.checks.every(check => check?.passed === true && Number.isFinite(check.measured) &&
      (Number.isFinite(check.min) || Number.isFinite(check.max)) &&
      (check.min === undefined || (Number.isFinite(check.min) && check.measured >= check.min)) &&
      (check.max === undefined || (Number.isFinite(check.max) && check.measured <= check.max)));
}

export function analyzeTrajectory(messages = []) {
  const toolSeq = [];
  const params = {};
  let casePath = '', runId = '';
  const verifiedBy = new Set();
  let taskDone = false, verificationFailed = false, epoch = 0;
  const pending = new Set();
  const invalidate = () => { verifiedBy.clear(); pending.clear(); taskDone = false; epoch++; };
  // 配对 assistant.tool_calls(name/args) 与其后的 tool 结果
  const idToName = new Map();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const name = tc.function?.name; if (!name) continue;
        toolSeq.push(name);
        let a = {}; try { a = JSON.parse(tc.function.arguments || '{}'); } catch {}
        a = a && typeof a === 'object' ? a : {};
        const isVerifier = VERIFY_TOOLS.includes(name) || name === 'opt_run_trial';
        if (!NON_MUTATING_TOOLS.has(name) && !VERIFY_TOOLS.includes(name)) invalidate();
        const calledCase = typeof a.case_path === 'string' ? a.case_path.trim() : '';
        if (isVerifier) {
          if (!calledCase || calledCase !== casePath) invalidate();
          casePath = calledCase;
          runId = typeof a.run_id === 'string' ? a.run_id : '';
          pending.add(tc.id);
          taskDone = false;
        }
        idToName.set(tc.id, { name, args: a, epoch });
        if (calledCase && !casePath) casePath = calledCase;
        if (a.run_id && !runId) runId = a.run_id;
        if (name === 'task_complete') taskDone = false;
        // 收集 edit/write 的关键参数线索（仅记 key，值过长截断）
        if ((name === 'edit_file' || name === 'write_file') && a.path) {
          // 不抓正文，避免噪声；配方由模型在 skill_save 时给
        }
      }
    } else if (m.role === 'tool') {
      const call = idToName.get(m.tool_call_id);
      if (!call) continue;
      idToName.delete(m.tool_call_id);
      const { name, args } = call;
      if (call.epoch !== epoch) continue;
      const c = String(m.content || '');
      const result = toolResult(m.content);
      const failed = result?.ok === false || !!result?.error || result?.passed === false || result?.pass === false || FAIL_RE.test(c);
      if (VERIFY_TOOLS.includes(name) || name === 'opt_run_trial') {
        pending.delete(m.tool_call_id);
        const passed = !failed && (name === 'opt_run_trial' ? successfulTrial(result) :
          result ? (result.passed === true || result.pass === true) : PASS_RE.test(c));
        if (!passed) {
          invalidate();
          verificationFailed = true;
        } else if (casePath && args.case_path?.trim() === casePath &&
          (!result?.case_path || result.case_path === casePath)) {
          verifiedBy.add(name + ':pass');
          verificationFailed = false;
        } else {
          invalidate();
          verificationFailed = true;
        }
      }
      if (name === 'task_complete') taskDone = !failed &&
        (result?.ok === true || result?.success === true);
    }
  }
  const verified = !verificationFailed && pending.size === 0 &&
    (verifiedBy.has('opt_run_trial:pass') ||
      (verifiedBy.has('foam_solve_verify:pass') && verifiedBy.has('foam_post_verify:pass')));
  return {
    verified, verifiers: Array.from(verifiedBy), casePath, runId, taskDone,
    toolSeq, params, verificationFailed,
  };
}

// 从轨迹草拟一张技能卡（不落盘，仅供 UI/agent 参考确认 —— opt-in）
// facts：来自 server 的会话工作记忆（solver/key_params/pitfalls/case_path），用来自动填充卡片，
//        让自动沉淀的技能不再只有空配方占位（draft 质量直接决定下次注入的价值）。
export function draftFromTrajectory({ userText, messages, modes, facts }) {
  const a = analyzeTrajectory(messages);
  if (!a.verified) return null;
  const domain = (modes && (modes.foam ? 'foam' : modes.mfix ? 'mfix' : modes.lbm ? 'lbm' : 'general')) || 'general';
  const triggers = _extractTriggers(userText, domain);
  // 配方用“去抖后的关键工具序列”作占位，真正配方建议由模型在 skill_save 时补全
  const keyTools = a.toolSeq.filter(n => !['read_file', 'list_dir', 'grep_search', 'glob', 'update_todos', 'vision_analyze'].includes(n));
  const recipe = _dedupSeq(keyTools).slice(0, RECIPE_MAX_STEPS).map(n => `调用 ${n}`);
  const f = facts || {};
  return {
    title: (userText || '').slice(0, 60) || '已验证案例',
    domain, triggers,
    solver: f.solver || '', physics: f.physics || '',
    recipe,
    key_params: (f.key_params && typeof f.key_params === 'object') ? f.key_params : {},
    verify_seq: a.verifiers.map(v => v.split(':')[0]),
    pitfalls: Array.isArray(f.pitfalls) ? f.pitfalls.slice(0, 8) : [],
    provenance: { case_path: a.casePath || f.case_path || '', run_id: a.runId, verified_by: a.verifiers, ts: Date.now() },
  };
}

function _dedupSeq(arr) { const out = []; for (const x of arr) if (out[out.length - 1] !== x) out.push(x); return out; }

const _KW = {
  foam: ['snappy', 'blockmesh', '外流', '绕流', 'stl', '边界层', 'y+', 'simplefoam', 'pimplefoam', 'interfoam', '多相', 'vof', '湍流', 'les', 'rans', '管流', '换热', '自然对流'],
  mfix: ['流化床', 'tfm', 'dem', '气固', '颗粒', 'fluidized', 'bubbling', 'spout'],
  lbm: ['lbm', '格子', 'boltzmann', 'd2q9', 'd3q19', '多孔'],
  general: ['优化', 'optuna', '论文', '复现', '网格无关', '收敛']
};
function _extractTriggers(text, domain) {
  const t = (text || '').toLowerCase();
  const pool = [...(_KW[domain] || []), ...(_KW.general)];
  const hits = pool.filter(k => t.includes(k.toLowerCase()));
  return Array.from(new Set(hits)).slice(0, 8);
}

// ----------------------------------------------------------------------------
// 导出 / 导入（技能可迁移：打成单个 bundle.json）
// ----------------------------------------------------------------------------
export async function exportBundle(outPath, ids = null) {
  if (!_ready) await init();
  const skills = (ids && ids.length) ? ids.map(i => _skills.get(i)).filter(Boolean) : Array.from(_skills.values());
  const bundle = { version: 1, exported_at: Date.now(), count: skills.length, skills, error_patterns: _errPatterns };
  const fp = path.isAbsolute(outPath) ? outPath : path.join(ROOT, outPath);
  await fs.writeFile(fp, JSON.stringify(bundle, null, 2), 'utf8');
  return { ok: true, path: fp, count: skills.length };
}

export async function importBundle(inPath) {
  if (!_ready) await init();
  const fp = path.isAbsolute(inPath) ? inPath : path.join(ROOT, inPath);
  const bundle = JSON.parse(await fs.readFile(fp, 'utf8'));
  let n = 0;
  for (const sk of (bundle.skills || [])) { await saveSkill(sk); n++; }
  for (const ep of (bundle.error_patterns || [])) { await addErrorPattern(ep); }
  return { ok: true, imported: n, errorPatterns: (bundle.error_patterns || []).length };
}

// ----------------------------------------------------------------------------
// 第 4 层：把"已被 verifier 盖章"的整条轨迹导出成 SFT 语料（jsonl，将来微调本地模型用）
// 只导出 analyzeTrajectory().verified===true 的轨迹，保证零幻觉、带 provenance。
// ----------------------------------------------------------------------------
export function buildSftSample(messages = [], meta = {}) {
  const a = analyzeTrajectory(messages);
  if (!a.verified) return null;  // 未通过验证的轨迹一律不进语料
  const sys = messages.find(m => m.role === 'system');
  const conv = messages.filter(m => m.role !== 'system').map(m => {
    if (m.role === 'assistant') {
      const o = { role: 'assistant', content: m.content || '' };
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) o.tool_calls = m.tool_calls;
      return o;
    }
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: String(m.content || '').slice(0, 4000) };
    return { role: m.role, content: m.content || '' };
  });
  const out = [];
  if (sys) out.push({ role: 'system', content: String(sys.content || '').slice(0, 8000) });
  out.push(...conv);
  return {
    schema: 'cfdriver-sft-v1', verified: true, verified_by: a.verifiers,
    case_path: a.casePath, run_id: a.runId,
    domain: meta.domain || '', label: meta.label || '', ts: Date.now(),
    messages: out,
  };
}

export async function appendSft(sample, outPath = null) {
  if (!_ready) await init();
  if (!sample) return { ok: false, error: '样本为空（轨迹未通过 verifier，拒绝导出）' };
  const dir = path.join(ROOT, 'sft');
  await fs.mkdir(dir, { recursive: true });
  const fp = outPath ? (path.isAbsolute(outPath) ? outPath : path.join(ROOT, outPath)) : path.join(dir, 'verified_trajectories.jsonl');
  await fs.appendFile(fp, JSON.stringify(sample) + '\n', 'utf8');
  let total = 0; try { total = (await fs.readFile(fp, 'utf8')).split('\n').filter(Boolean).length; } catch {}
  return { ok: true, path: fp, total };
}

export function stats() { return { ready: _ready, skills: _skills.size, errorPatterns: _errPatterns.length }; }

// ----------------------------------------------------------------------------
// skill 升级检验（A/B）：同一固定案例在「无技能 / 有技能」两臂各跑一次，记录指标并对比，
// 用客观数据证明技能注入是否真有帮助（verifier 通过率、错误迭代次数）。
// ----------------------------------------------------------------------------
export function evalMetrics(messages = []) {
  const idToName = new Map();
  let vPass = 0, vFail = 0, errIters = 0, diagnoses = 0;
  const verifiers = [];
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) { const n = tc.function?.name; if (n) { idToName.set(tc.id, n); if (n === 'diagnose_error') diagnoses++; } }
    } else if (m.role === 'tool') {
      const n = idToName.get(m.tool_call_id) || '';
      const c = String(m.content || '');
      if (VERIFY_TOOLS.includes(n)) {
        if (PASS_RE.test(c) && !FAIL_RE.test(c)) { vPass++; verifiers.push(n + ':pass'); }
        else if (FAIL_RE.test(c)) { vFail++; verifiers.push(n + ':fail'); }
      }
      if (/error|FATAL|exception|segfault|\bnan\b|traceback/i.test(c)) errIters++;
    }
  }
  const total = vPass + vFail;
  return { verifyPass: vPass, verifyFail: vFail, verifyPassRate: total ? +(vPass / total).toFixed(3) : null, errorIters: errIters, diagnoses, verifiers };
}

const EVAL_FILE = path.join(ROOT, 'eval_runs.json');
export async function recordEval(rec) {
  if (!_ready) await init();
  let arr = []; try { arr = JSON.parse(await fs.readFile(EVAL_FILE, 'utf8')); if (!Array.isArray(arr)) arr = []; } catch {}
  arr.push({ ...rec, ts: Date.now() });
  await fs.writeFile(EVAL_FILE, JSON.stringify(arr, null, 2), 'utf8');
  return { ok: true, total: arr.length, path: EVAL_FILE };
}
export async function loadEvals() {
  if (!_ready) await init();
  try { const a = JSON.parse(await fs.readFile(EVAL_FILE, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; }
}

export default {
  init, saveSkill, removeSkill, listSkills, getSkill, injectionFor,
  learnedErrorPatterns, addErrorPattern, analyzeTrajectory, draftFromTrajectory,
  exportBundle, importBundle, stats, buildSftSample, appendSft,
};
