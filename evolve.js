// evolve.js —— 垂直领域 playbook：把已验证的整套流程沉淀成「可直接实例化的模板算例 + 分阶段配方 + 基准 KPI + 效率指标」
import fs from 'fs/promises';
import fssync from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = process.env.NF_VERTICAL_DIR || path.join(__dirname, 'skills', 'verticals');

const FILE_MAX = 5 * 1024 * 1024, TOTAL_MAX = 60 * 1024 * 1024;
const SKIP_DIR = /^(processor\d+|postProcessing|lnInclude|linux64\w*|Make\/linux64\w*|\.git|__pycache__|VTK|dynamicCode)$/;
const SKIP_FILE = /^(log\.|core(\.\d+)?$)|\.(o|dep|so|vtk|vtu|foam)$/;

function _slug(s) { return String(s || 'vertical').toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'vertical'; }
const _exp = (p) => String(p || '').replace(/^~(?=\/|\\|$)/, os.homedir());
export const expandHome = _exp;

// ---------------------------------------------------------------- 运行中轨迹记录（挂在 task 上，随任务持久化）
export function evo(session) {
  const h = session.task || session;
  if (!h.evo) h.evo = { startedAt: Date.now(), llmSteps: 0, toolCalls: 0, errors: 0, stages: [], cur: { tools: [], files: [], errors: [] }, playbookUsed: null };
  return h.evo;
}
export function onLlmStep(session) { evo(session).llmSteps++; }
export function onTool(session, name, args, result) {
  const e = evo(session);
  e.toolCalls++;
  if (!['read_file', 'list_dir', 'grep_search', 'glob', 'update_todos', 'run_status_load'].includes(name)) e.cur.tools.push(name);
  if (args && args.path && ['write_file', 'edit_file', 'multi_edit'].includes(name) && !e.cur.files.includes(args.path)) e.cur.files.push(String(args.path));
  const txt = String(result || '');
  if (/FOAM FATAL|Traceback \(most recent|Segmentation fault|sigFpe|执行失败|\[退出码 [1-9]/.test(txt)) {
    e.errors++;
    const i = Math.max(0, txt.search(/FOAM FATAL|Traceback|Segmentation|sigFpe|执行失败|\[退出码/));
    if (e.cur.errors.length < 6) e.cur.errors.push(txt.slice(i, i + 200).replace(/\s+/g, ' '));
  }
  if (name === 'vertical_instantiate' && /✅/.test(txt) && args && args.id) e.playbookUsed = args.id;
  if (name === 'run_stage_done') {
    e.stages.push({ name: String(args.stage || ''), passed: args.passed !== false, memo: String(args.memo || '').slice(0, 600), tools: _dedup(e.cur.tools).slice(0, 30), files: e.cur.files.slice(0, 40), errors: e.cur.errors, t: Date.now() });
    e.cur = { tools: [], files: [], errors: [] };
  }
}
function _dedup(a) { const o = []; for (const x of a) if (o[o.length - 1] !== x) o.push(x); return o; }

export function metricsOf(session) {
  const e = evo(session);
  return { llmSteps: e.llmSteps, toolCalls: e.toolCalls, errors: e.errors, stages: e.stages.length, wallMin: +((Date.now() - e.startedAt) / 60000).toFixed(1), playbookUsed: e.playbookUsed };
}

// ---------------------------------------------------------------- playbook 存取
async function _readJson(p, d) { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return d; } }
function _pbPath(id) { return path.join(ROOT, id, 'playbook.json'); }
export async function loadPlaybook(id) { return _readJson(_pbPath(id), null); }
export function listPlaybooks() {
  let dirs = []; try { dirs = fssync.readdirSync(ROOT); } catch { return []; }
  return dirs.map(d => { try { return JSON.parse(fssync.readFileSync(_pbPath(d), 'utf8')); } catch { return null; } }).filter(Boolean);
}

async function _copyTree(src, dst, budget) {
  let st; try { st = await fs.stat(src); } catch { return; }
  if (st.isFile()) {
    if (st.size > FILE_MAX || budget.left < st.size || SKIP_FILE.test(path.basename(src))) return;
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst); budget.left -= st.size; budget.files++;
    return;
  }
  for (const ent of await fs.readdir(src, { withFileTypes: true })) {
    const n = ent.name;
    if (ent.isDirectory()) {
      if (SKIP_DIR.test(n)) continue;
      if (/^\d+(\.\d+)?(e[-+]?\d+)?$/.test(n) && n !== '0') continue;           // 结果时间步不入模板
      if (n === 'polyMesh' && path.basename(src) === 'constant') continue;      // 网格可由脚本重建
      await _copyTree(path.join(src, n), path.join(dst, n), budget);
    } else if (ent.isFile()) await _copyTree(path.join(src, n), path.join(dst, n), budget);
  }
}

// 沉淀：从当前任务轨迹 + 已验证算例生成/升级 playbook（版本化，旧版本保留可回滚）
export async function distill(session, { id, title, triggers = [], case_path, extra_paths = [], kpis = {}, benchmarks = {}, notes = '', pitfalls = [] }, summarize = null) {
  if (!case_path) return { ok: false, error: 'case_path 必填（已验证的算例目录）' };
  const casePath = _exp(case_path);
  if (!fssync.existsSync(casePath)) return { ok: false, error: '算例不存在: ' + casePath };
  const e = evo(session);
  const pid = _slug(id || title);
  const old = await loadPlaybook(pid);
  const version = (old ? old.version : 0) + 1;
  const vdir = path.join(ROOT, pid, `v${version}`);
  const budget = { left: TOTAL_MAX, files: 0 };
  await _copyTree(casePath, path.join(vdir, 'case'), budget);
  const extras = [];
  for (const p of extra_paths || []) {
    const src = _exp(p);
    if (!fssync.existsSync(src)) continue;
    const name = path.basename(src);
    await _copyTree(src, path.join(vdir, 'extra', name), budget);
    extras.push({ name, origin: p });
  }
  if (!extras.length && old && (old.extras || []).length) {
    for (const x of old.extras) {
      await _copyTree(path.join(ROOT, pid, `v${old.current}`, 'extra', x.name), path.join(vdir, 'extra', x.name), budget);
      extras.push(x);
    }
  }
  let stages = e.stages.filter(s => s.passed).map(s => ({ name: s.name, memo: s.memo, tools: s.tools, files: s.files, fixed_errors: s.errors }));
  if (summarize && stages.length) {
    try {
      const out = await summarize(stages);
      const j = JSON.parse(String(out || '').replace(/^```(json)?|```$/gm, '').trim());
      if (Array.isArray(j)) stages = stages.map((s, i) => ({ ...s, recipe: j[i] && j[i].recipe, pitfall: j[i] && j[i].pitfall }));
    } catch {}
  }
  const run = { version, ts: new Date().toISOString(), ...metricsOf(session), kpis };
  const pb = {
    id: pid, title: title || (old && old.title) || pid,
    triggers: Array.from(new Set([...(old ? old.triggers : []), ...triggers.map(t => String(t).toLowerCase())])).slice(0, 30),
    version, current: version,
    stages: stages.length ? stages : (old ? old.stages : []),
    benchmarks: { ...(old ? old.benchmarks : {}), ...benchmarks },
    pitfalls: Array.from(new Set([...(old ? old.pitfalls : []), ...pitfalls])).slice(0, 20),
    notes: notes || (old && old.notes) || '',
    extras, template_files: budget.files,
    runs: [...(old ? old.runs : []), run].slice(-30),
  };
  await fs.mkdir(path.join(ROOT, pid), { recursive: true });
  await fs.writeFile(_pbPath(pid), JSON.stringify(pb, null, 2), 'utf8');
  return { ok: true, id: pid, version, files: budget.files, dir: vdir, run };
}

// 实例化：把模板算例（+附加目录）拷到新位置，返回差异化清单
export async function instantiate(id, dest, version = null) {
  const pb = await loadPlaybook(id);
  if (!pb) return { ok: false, error: 'playbook 不存在: ' + id };
  const v = version || pb.current;
  const vdir = path.join(ROOT, id, `v${v}`);
  const to = _exp(dest);
  if (fssync.existsSync(to) && fssync.readdirSync(to).length) return { ok: false, error: '目标目录非空: ' + to };
  const budget = { left: TOTAL_MAX * 2, files: 0 };
  await _copyTree(path.join(vdir, 'case'), to, budget);
  const extras = [];
  for (const x of pb.extras || []) {
    const target = path.join(path.dirname(to), x.name);
    if (!fssync.existsSync(target)) { await _copyTree(path.join(vdir, 'extra', x.name), target, budget); extras.push(target); }
  }
  return { ok: true, pb, version: v, dest: to, files: budget.files, extras };
}

// ---------------------------------------------------------------- 检索注入
function _score(pb, t) { let h = 0; for (const k of pb.triggers || []) if (k && t.includes(k)) h++; return h; }
export function injectionFor(text) {
  const t = String(text || '').toLowerCase();
  const hits = listPlaybooks().map(pb => ({ pb, s: _score(pb, t) })).filter(x => x.s >= 2).sort((a, b) => b.s - a.s).slice(0, 2);
  if (!hits.length) return '';
  const L = ['\n\n# 🚀 已有垂直领域 playbook（命中当前任务 · 先用它，不要从零开始）'];
  for (const { pb } of hits) {
    const runs = pb.runs || [];
    const first = runs[0], last = runs[runs.length - 1];
    L.push(`\n## ${pb.title}  [id=${pb.id} v${pb.current}]`);
    L.push(`第一步：vertical_instantiate({id:"${pb.id}", dest:"<新算例目录>"}) 拷贝已验证模板（${pb.template_files} 个文件${(pb.extras || []).length ? ' + ' + pb.extras.map(x => x.name).join('/') : ''}），只改与本任务不同的参数；已验证阶段不必重新探索。`);
    if (first && last) L.push(`历史效率：首次 ${first.llmSteps} 步/${first.errors} 次报错/${first.wallMin} min → 最近 ${last.llmSteps} 步/${last.errors} 次报错/${last.wallMin} min（共 ${runs.length} 次）。`);
    if (Object.keys(pb.benchmarks || {}).length) L.push('基准 KPI（用于验收）：' + Object.entries(pb.benchmarks).map(([k, v]) => `${k}=${v}`).join('; '));
    if ((pb.pitfalls || []).length) L.push('必须避开：' + pb.pitfalls.slice(0, 8).map((p, i) => `${i + 1}) ${p}`).join(' '));
    (pb.stages || []).slice(0, 12).forEach((s, i) => L.push(`  阶段${i + 1} ${s.name}: ${s.recipe || s.memo || ''}`.slice(0, 300) + (s.pitfall ? ` ⚠${s.pitfall}`.slice(0, 160) : '')));
  }
  return L.join('\n') + '\n';
}

export function isEvolvable(session) {
  const e = evo(session);
  return e.stages.filter(s => s.passed).length >= 2;
}
