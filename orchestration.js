// 调度与多智能体的纯逻辑：物理核数、核占用登记、求解排队、作业归组、子智能体定义、共享笔记。
// 这里不碰会话和进程，便于单测；有副作用的部分在 server.js。
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------- 物理核数
// /proc/cpuinfo 里不同的 (physical id, core id) 组合数；超线程的两个逻辑核只算一个
export function physicalCoresFromCpuinfo(text) {
  const seen = new Set();
  let phys = '', logical = 0;
  for (const line of String(text || '').split('\n')) {
    const m = /^(physical id|core id|processor)\s*:\s*(\d+)/.exec(line);
    if (!m) continue;
    if (m[1] === 'processor') logical++;
    else if (m[1] === 'physical id') phys = m[2];
    else seen.add(phys + ':' + m[2]);
  }
  return seen.size || logical || 0;
}
export function physicalCores(logical, cpuinfoText = '') {
  const p = physicalCoresFromCpuinfo(cpuinfoText);
  return p > 0 && p <= logical ? p : logical;
}

// ---------------------------------------------------------------- 核占用登记（与 rsi/core/claims.py 同一个文件格式）
// { name: { np, t(秒), owner, max_age(秒) } }；过期条目忽略
export function readClaims(file, now = Date.now(), read = f => fs.readFileSync(f, 'utf8')) {
  try {
    const out = {};
    for (const [k, v] of Object.entries(JSON.parse(read(file)) || {})) {
      if (!v) continue;
      const age = now / 1000 - Number(v.t || 0);
      if (age < Number(v.max_age || 10800)) out[k] = { np: Number(v.np) || 0, owner: String(v.owner || ''), age };
    }
    return out;
  } catch (e) { return {}; }
}
// 别人登记、还在启动期的核数（网格/分解阶段还没有求解进程，按进程数统计会漏掉）
export function startingClaims(claims, owner, windowS = 600) {
  let n = 0;
  const list = Object.values(claims ? claims : Object.create(null));
  for (const v of list) if (v.owner !== owner && v.age < windowS) n += v.np;
  return n;
}
export function writeClaim(file, name, entry) {
  let d = {};
  try { d = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { d = {}; }
  if (entry) d[name] = entry;
  else if (name in d) delete d[name];
  else return;
  const tmp = `${file}.tmp${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 1));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- 求解排队
// 先来先到。队首放不下时后面放得下的小作业可以先跑（回填）；队首等满 holdMs 后不再回填，免得大作业一直等
export function queuePick(queue, free, now = Date.now(), holdMs = 2 * 3600_000) {
  if (!queue.length) return null;
  const head = queue[0];
  if (head.np <= free) return head;
  if (now - head.since >= holdMs) return null;
  for (let i = 1; i < queue.length; i++) if (queue[i].np <= free) return queue[i];
  return null;
}

// 作业属于哪条工作线：工作区内的算工作区名，其余取主目录下的第一级目录名
export function streamOf(caseDir, { home = '', workspace = '' } = {}) {
  const norm = s => String(s || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const d = norm(caseDir), w = norm(workspace), h = norm(home);
  if (w && (d === w || d.startsWith(w + '/'))) return w.split('/').pop();
  const rel = h && d.startsWith(h + '/') ? d.slice(h.length + 1) : d;
  return rel.split('/').filter(Boolean)[0] || d;
}

// ---------------------------------------------------------------- 子智能体
export const SUBAGENT_PREFIX = '你是由另一个会话派生的子智能体。\n';
const RESULT_RULE = '你的最后一条回复就是交给主智能体的全部结果：它看不到你的中间过程。把结论、证据（绝对路径、行号、数值）和没能确认的事项写完整；不要提问，不要等待回复。\n';
const READONLY_TOOLS = new Set(['list_dir', 'read_file', 'grep_search', 'glob', 'web_search', 'fetch_url', 'paper_search', 'paper_fetch', 'read_paper', 'read_document',
  'paper_extract', 'paper_figures', 'image_crop', 'vision_analyze', 'foam_inspect_case', 'foam_find_tutorial', 'foam_find_source', 'foam_solver_status',
  'foam_residual_series', 'foam_postproc_list', 'foam_postproc_stats', 'foam_env_check', 'run_status_load', 'skill_recall', 'skill_list', 'skill_pack_read',
  'git_log_recent', 'git_diff', 'case_probe_facts', 'diagnose_error', 'post_view']);
// 任何子智能体都拿不到的工具：再派生、收尾、求解器的启动与停止、优化流水线、技能库写入、向用户提问
const CHILD_DENY = /^(subagent|task_complete|update_todos|request_user_digitize|workspace_note|git_revert_to|solver_wait|kpi_credibility|foam_run_solver_async|foam_solver_stop|sim_run_openfoam|sim_open_paraview|mfix_run_solver_async|mfix_solver_stop|lbm_run_async|lbm_solver_stop|opt_\w+|vertical_\w+|run_stage_\w+|learn_error_pattern|skill_(save|forget|import|export\w*|eval\w*))$/;
export const BUILTIN_AGENTS = {
  explore: { id: 'explore', readonly: true, steps: 30,
    description: '只读检索：在工作区和算例里找文件，读日志、字典、论文，汇总事实。调用时说明要多细（quick / medium / very thorough）。',
    system: '\n\n# 子智能体：explore（只读）\n只做检索和阅读，不改文件、不运行命令。互不依赖的查找同时发起。结论里给出处：文件绝对路径和行号，论文给页码或表号。\n' },
  general: { id: 'general', readonly: false, steps: 40,
    description: '通用子智能体：独立完成一块多步工作（调研、写脚本、后处理、核对）。可以同时派发多个互不重叠的子任务。不能启动或停止求解器。',
    system: '\n\n# 子智能体：general\n独立完成交给你的这一块工作。不能启动或停止求解器，不改运行中算例的 system/ 和 constant/；需要跑求解时，把命令和理由写进结论交给主智能体。\n' },
};
// 自定义子智能体：<工作区>/.cfdriver/agents/<名字>.md，可选 frontmatter（description / tools: readonly|all / steps / model），正文是它的系统提示
export function parseAgentFile(id, text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text || ''));
  const meta = {};
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\w+)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  const body = (m ? m[2] : String(text || '')).trim();
  if (!body && !meta.description) return null;
  if (meta.mode && !/^(subagent|all)$/.test(meta.mode)) return null;
  return { id, custom: true, readonly: !/^(all|write)$/.test(meta.tools || 'readonly'), steps: Math.min(Math.max(Number(meta.steps) || 30, 5), 120),
    model: meta.model || '', description: (meta.description || id).slice(0, 300), system: `\n\n# 子智能体：${id}\n${body.slice(0, 8000)}\n` };
}
export function loadAgents(dir) {
  const out = { ...BUILTIN_AGENTS };
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const id = f.slice(0, -3).toLowerCase().replace(/[^a-z0-9_-]/g, '');
      const a = id && parseAgentFile(id, fs.readFileSync(path.join(dir, f), 'utf8'));
      if (a) out[id] = a;
    }
  } catch (e) { return out; }
  return out;
}
export function childToolAllowed(agent, name, { parentReadonly = false } = {}) {
  if (CHILD_DENY.test(name)) return false;
  if (agent.readonly || parentReadonly) return READONLY_TOOLS.has(name);
  return true;
}
export function agentSystem(agent) { return agent.system + RESULT_RULE; }
export function agentListText(agents) {
  return '\n可用子智能体：\n' + Object.values(agents).sort((a, b) => (a.id < b.id ? -1 : 1)).map(a => `- ${a.id}: ${a.description}`).join('\n');
}
export function lastAssistantText(messages) {
  for (let i = (messages || []).length - 1; i > 0; i--) {
    const m = messages[i];
    if (m && m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) return m.content.trim();
  }
  return '';
}
export function wrapResult({ id, agent, state, description, text }) {
  const d = description ? ` description="${String(description).replace(/"/g, "'").slice(0, 80)}"` : '';
  return `<subagent sessionID="${id}" agent="${agent}" state="${state}"${d}>\n${String(text || '').trim() || '子智能体结束了，但没有文本回复。'}\n</subagent>`;
}
// "接口id/模型" 或只有模型名；接口 id 不认识时整串当模型名（模型名本身可以带斜杠）
export function parseModelRef(text, providers = []) {
  const s = String(text || '').trim();
  if (!s) return null;
  const i = s.indexOf('/');
  const head = i > 0 ? s.slice(0, i) : '';
  if (head && (head === 'main' || providers.some(p => p && p.id === head))) return { provider: head, model: s.slice(i + 1) };
  return { provider: 'main', model: s };
}

// ---------------------------------------------------------------- 工作区共享笔记
export function notesBlock(text, cap = 6000) {
  const t = String(text || '').trim();
  if (!t) return '';
  const body = t.length > cap ? t.slice(0, Math.round(cap * 0.6)) + '\n…（中间省略，全文在工作区根目录的 CFDRIVER.md）…\n' + t.slice(-Math.round(cap * 0.4)) : t;
  return `\n\n# 📌 工作区共享笔记（本工作区所有任务可见）\n${body}\n`;
}
export function looksLikePythonIndentError(text) {
  return /IndentationError|TabError|unexpected indent|expected an indented block|unindent does not match/.test(String(text || ''));
}
