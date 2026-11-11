import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import fs from 'fs/promises';
import fssync from 'fs';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import os from 'os';
import { EventEmitter } from 'events';
import * as SkillLib from './skills.js';
import * as FoamPost from './foam_postproc.js';
import * as Fidelity from './fidelity.js';
import * as Evolve from './evolve.js';
import { RecoveryManager, repairDanglingToolCalls, isTransientLLMError } from './agent_recovery.js';
import { applyEdit, classifyLlmHttp, parseRetryAfter, llmRetryDelay, isNetworkError, isTimeoutError, clipToolOutput, sweepToolOutput } from './agent_core.js';
import { resolveMentioned } from './path_resolve.js';
import { setMaxListeners } from 'node:events';
// 抑制 AbortSignal 上限监听器警告（每个 callLLM 会给 abort signal 加 listener）
setMaxListeners(0);
import { createTaskTransport, taskOwner, syncTaskObservers } from './task_transport.js';

// A1: 显式任务状态枚举（统一语义；现有散落字段仍保留，向下兼容）
const TASK_STATE = Object.freeze({
  IDLE:          'idle',
  RUNNING:       'running',
  AWAITING_USER: 'awaiting_user',
  PAUSED:        'paused',
  COMPLETE:      'complete',
  STOPPED:       'stopped',
  ERROR:         'error',
  STALLED:       'stalled',
});
/** 从 session 散落字段派生当前状态（单一真源，向下兼容） */
function getTaskState(session) {
  if (!session) return TASK_STATE.IDLE;
  if (session._running)                                    return TASK_STATE.RUNNING;
  if (session.aborted)                                     return TASK_STATE.STOPPED;
  if (session.taskComplete)                                return TASK_STATE.COMPLETE;
  if (session._endReasonDetail === 'llm_circuit')          return TASK_STATE.ERROR;
  if (session.awaitingUserChoice || session.pendingQuestion) return TASK_STATE.AWAITING_USER;
  if (session._budgetExhausted)                            return TASK_STATE.PAUSED;
  if (session._endReasonDetail === 'stalled')              return TASK_STATE.STALLED;
  return TASK_STATE.IDLE;
}
import { apiDefaults, resolveChatConfig, validateApiUpdate, settingsForRef, validateProvider } from './api_config.js';
import * as AccessAuth from './access_auth.js';
import * as Notify from './notify.js';
import * as ExtRuns from './external_runs.js';
import * as Monitor from './monitor.js';
import * as Prelaunch from './foam_prelaunch.js';
import * as Cap from './capabilities.js';
// 多用户网关里的实例没有直连网络：所有出网请求（模型 API、搜索、下载）走网关代理
if (process.env.CFD_EGRESS_PROXY) {
  try { const U = await import('undici'); U.setGlobalDispatcher(new U.EnvHttpProxyAgent()); }
  catch (e) { console.warn('[egress] 代理未生效:', e.message); }
}

// 可选：HTTPS_PROXY / HTTP_PROXY 支持（GitHub 偶发 fetch failed 时可设置代理）
try {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (proxy) {
    const undici = await import('undici');
    if (undici.setGlobalDispatcher && undici.ProxyAgent) {
      undici.setGlobalDispatcher(new undici.ProxyAgent(proxy));
      console.log('[net] 已启用代理:', proxy);
    }
  }
} catch {}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 技能自进化库（独立模块）初始化 —— 跨算例持久化的 verifier-grounded 经验
try { await SkillLib.init(); console.log('[skills] 技能库就绪：', SkillLib.stats()); }
catch (e) { console.warn('[skills] 初始化失败：', e.message); }

const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const IS_WIN = process.platform === 'win32';

const DEFAULT_SETTINGS = {
  ...apiDefaults(process.env),
  copilotModel: 'gpt-4.1',         // 当 provider=copilot 时使用
  // 推理模型（Qwen3.6 / GLM-5.1 / DeepSeek-R1 等）的"思考预算"上限（top-level thinking_budget，单位 token）。
  // 这是治"模型一步想把所有事做完、长时间空转思考"的关键开关：把每一轮思考限定在合理长度，
  // 配合"小步快走"系统提示，既高效又不丢准确度。0 = 不限制；普通非推理模型会忽略此字段。
  thinkingBudget: 4096,
  maxAutoSteps: 120,               // 单轮 agent 最大步数；长程依靠下面的自动续跑分段推进
  autoResume: true,                // 后台求解作业结束时自动唤醒对应任务的 agent
  autoResumeMax: 20,               // 无用户输入时最多连续自动唤醒次数
  paraviewExe: '',
  paraviewPython: '',
  openfoamBash: '',
  pythonPath: '',
  foamRoot: process.env.FOAM_ROOT || '',  // OpenFOAM 安装根（含 tutorials/ src/ applications/）
  foamMode: false,                          // Beta：OpenFOAM 仿真智能体模式
  mfixRoot: process.env.MFIX_ROOT || '',    // MFIX 安装根（含 tutorials/ model/）
  mfixBash: process.env.MFIX_BASH || '',    // MFIX activate/bashrc（source 后能跑 mfixsolver）
  mfixMode: false,                          // Beta：MFIX 仿真智能体模式
  lbmTutorialRoot: process.env.LBM_TUTORIAL_ROOT || '',  // 用户提供的 LBM 算例根目录（无固定框架）
  lbmRunCmd: '',                            // LBM 默认运行命令模板（如 "python run.py" / "./lb_main"）
  lbmMode: false,                           // Beta：LBM 仿真智能体模式
  customMode: false,                        // Beta：用户自定义工作流 prompt 模式
  customName: '',                           // 自定义工作流名称（如 "DEM 颗粒料仓"）
  customRoot: '',                           // 自定义工作流可选根目录（传给 agent 作为上下文）
  customPrompt: '',                         // 用户手写的流水式提示词（会拼到 system prompt）
  workspace: process.env.WORKSPACE_DIR || process.cwd()
};
let SETTINGS = { ...DEFAULT_SETTINGS };
// 外部通知（手机）：配置存 SETTINGS.notify；环境变量 CFD_NOTIFY_WEBHOOK 可直接启用
const NOTIFIER = Notify.createNotifier({
  getConfig: () => {
    const c = SETTINGS.notify || {};
    if (!c.webhook && process.env.CFD_NOTIFY_WEBHOOK) return { enabled: true, webhook: process.env.CFD_NOTIFY_WEBHOOK, kind: Notify.detectKind(process.env.CFD_NOTIFY_WEBHOOK), events: Notify.EVENT_KINDS, publicUrl: process.env.CFD_PUBLIC_URL || '' };
    return c;
  },
});
function notifyEvent(event) { NOTIFIER.send(event).catch(() => {}); }
function _taskTitle(id) { try { return (id && TASKS.get(id)?.title) || ''; } catch { return ''; } }
let WORKSPACE = path.resolve(DEFAULT_SETTINGS.workspace);

async function loadSettings() {
  try { SETTINGS = { ...DEFAULT_SETTINGS, ...JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8')) }; } catch {}
  WORKSPACE = path.resolve(SETTINGS.workspace || process.cwd());
}
async function saveSettings() { await fs.writeFile(SETTINGS_FILE, JSON.stringify(SETTINGS, null, 2), 'utf8'); }

// ====================== 启动期自动探测（Linux/Mac/WSL 无配置即可用）======================
function whichSync(name) {
  try {
    const r = spawnSync(IS_WIN ? 'where' : 'which', [name], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout) return r.stdout.split(/\r?\n/)[0].trim();
  } catch {}
  return '';
}
async function pathExistsSync(p) { try { await fs.access(p); return true; } catch { return false; } }
let ENV_INFO = null;
async function autoProbeEnvironment() {
  let changed = false;
  // ParaView
  if (!SETTINGS.paraviewExe) {
    const cand = [whichSync('paraview'), '/usr/bin/paraview', '/usr/local/bin/paraview', '/Applications/ParaView.app/Contents/MacOS/paraview'].filter(Boolean);
    for (const c of cand) { if (await pathExistsSync(c)) { SETTINGS.paraviewExe = c; changed = true; break; } }
  }
  if (!SETTINGS.paraviewPython) {
    const cand = [whichSync('pvpython'), '/usr/bin/pvpython', '/usr/local/bin/pvpython', '/Applications/ParaView.app/Contents/bin/pvpython'].filter(Boolean);
    for (const c of cand) { if (await pathExistsSync(c)) { SETTINGS.paraviewPython = c; changed = true; break; } }
  }
  // OpenFOAM：capabilities.detectEnv 统一探测（已 source 的环境、~/OpenFOAM/OpenFOAM-*、/opt、/usr/lib/openfoam、Windows 下走 WSL），
  // 用户不需要再填路径；手填的路径失效了也用探测结果顶上
  try {
    ENV_INFO = await Cap.detectEnv();
    const f = ENV_INFO.openfoam;
    if (f.found && !IS_WIN) {
      if (!SETTINGS.openfoamBash || !fssync.existsSync(SETTINGS.openfoamBash)) { SETTINGS.openfoamBash = f.bashrc; changed = true; }
      if (f.root && (!SETTINGS.foamRoot || !fssync.existsSync(SETTINGS.foamRoot))) { SETTINGS.foamRoot = f.root; changed = true; }
    }
  } catch (e) { console.warn('[env] 探测失败:', e.message); }
  // 兜底：老的 /opt 扫描
  if (!SETTINGS.foamRoot && !IS_WIN) {
    const candDirs = ['/usr/lib/openfoam', '/opt/openfoam', '/opt/OpenFOAM', '/opt'];
    const FOAM_RE = /^(?:openfoam|OpenFOAM[-_]?)[\w.-]*$/i;
    for (const base of candDirs) {
      try {
        const ents = await fs.readdir(base, { withFileTypes: true });
        for (const e of ents) {
          if (!e.isDirectory()) continue;
          if (!FOAM_RE.test(e.name)) continue;
          const root = path.join(base, e.name);
          // OpenFOAM 真正源码根：含 etc/bashrc + tutorials
          if (await pathExistsSync(path.join(root, 'etc', 'bashrc')) && await pathExistsSync(path.join(root, 'tutorials'))) {
            SETTINGS.foamRoot = root; SETTINGS.openfoamBash = path.join(root, 'etc', 'bashrc'); changed = true; break;
          }
          // ESI 风格：openfoam2312/{etc,tutorials} 嵌一层
          for (const sub of [e.name, 'OpenFOAM-' + e.name.replace(/^openfoam/i, ''), '']) {
            const inner = sub ? path.join(root, sub) : root;
            if (await pathExistsSync(path.join(inner, 'etc', 'bashrc')) && await pathExistsSync(path.join(inner, 'tutorials'))) {
              SETTINGS.foamRoot = inner; SETTINGS.openfoamBash = path.join(inner, 'etc', 'bashrc'); changed = true; break;
            }
          }
          if (SETTINGS.foamRoot) break;
        }
      } catch {}
      if (SETTINGS.foamRoot) break;
    }
  }
  // 环境变量后备
  if (!SETTINGS.foamRoot && process.env.FOAM_INST_DIR) {
    if (await pathExistsSync(process.env.FOAM_INST_DIR)) { SETTINGS.foamRoot = process.env.FOAM_INST_DIR; changed = true; }
  }
  if (!SETTINGS.openfoamBash && process.env.FOAM_BASH) {
    if (await pathExistsSync(process.env.FOAM_BASH)) { SETTINGS.openfoamBash = process.env.FOAM_BASH; changed = true; }
  }
  if (changed) { try { await saveSettings(); } catch {} }
}

// 端口优先级：命令行参数 > 环境变量 > 默认 5174
// 支持：node server.js --port 5180 / -p 5180 / --port=5180 / 5180（首个数字位置参数）
function parseCliPort() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') { const v = parseInt(argv[i+1], 10); if (v > 0 && v < 65536) return v; }
    const m = a.match(/^--port=(\d+)$/); if (m) { const v = parseInt(m[1], 10); if (v > 0 && v < 65536) return v; }
    if (/^\d+$/.test(a)) { const v = parseInt(a, 10); if (v > 0 && v < 65536) return v; }
  }
  return null;
}
function parseCliHost() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host' || a === '-h') { const v = argv[i+1]; if (v) return v; }
    const m = a.match(/^--host=(.+)$/); if (m) return m[1];
  }
  return null;
}
const PORT = parseCliPort() || parseInt(process.env.PORT || '5174', 10);
const IGNORE = new Set(['node_modules', '.git', '.next', 'dist', 'build', '__pycache__', '.venv', 'venv']);
const MAX_AUTO_STEPS_DEFAULT = 120;

// ====================== 内存防护（防 OOM） ======================
// 单条工具返回最大字符数（超过则截断保存到上下文，但仍把原文回送给前端做显示）
const MAX_TOOL_RESULT_CHARS = parseInt(process.env.MAX_TOOL_RESULT_CHARS || '20000', 10);
const LLM_CONNECT_TIMEOUT_MS = parseInt(process.env.LLM_CONNECT_TIMEOUT_MS || '90000', 10);
// 整段对话上下文软上限（字符）。超过则自动压缩（保留 system + 最近 6 条）
const MAX_HISTORY_CHARS    = parseInt(process.env.MAX_HISTORY_CHARS    || '300000', 10);
// 命令输出累积器：保留开头 HEAD 与结尾 TAIL 字符，中间丢弃（报错通常在尾部；避免长命令无限增长）
function headTailBuffer(HEAD = 12000, TAIL = 30000) {
  let head = '', tail = '', dropped = 0;
  return {
    push(s) {
      if (head.length < HEAD) { const k = Math.min(s.length, HEAD - head.length); head += s.slice(0, k); s = s.slice(k); }
      if (!s) return;
      tail += s;
      if (tail.length > TAIL * 2) { dropped += tail.length - TAIL; tail = tail.slice(-TAIL); }
    },
    toString() {
      if (tail.length > TAIL) { dropped += tail.length - TAIL; tail = tail.slice(-TAIL); }
      return dropped ? `${head}\n…[中间省略 ${dropped} 字符]…\n${tail}` : head + tail;
    },
  };
}
// 超长的工具输出：模型拿头尾，全文存工作区 .nullflux/tool-output/（保留 7 天），截断提示里写明路径，模型可分段读回
const TOOL_OUTPUT_DIR = () => path.join(WORKSPACE, '.nullflux', 'tool-output');
function clipForHistory(s, name) {
  return clipToolOutput(s, { max: MAX_TOOL_RESULT_CHARS, dir: TOOL_OUTPUT_DIR(), relBase: WORKSPACE, name: name || 'tool' });
}
setInterval(() => sweepToolOutput(TOOL_OUTPUT_DIR()), 6 * 3600_000).unref();
function historyCharCount(messages) {
  let n = 0;
  for (const m of messages) {
    const c = m.content;
    if (typeof c === 'string') n += c.length;
    else if (Array.isArray(c)) for (const p of c) n += (p && p.text) ? p.text.length : 0;
    if (m.tool_calls) for (const t of m.tool_calls) n += (t.function?.arguments || '').length + (t.function?.name || '').length;
  }
  return n;
}
// 旧工具输出裁剪（学 OpenCode 的 prune）：长任务里早先的 cat/sed 字典全文、日志尾巴后面基本用不上，
// 却每一步都随上下文重发。最近 PRUNE_KEEP 条消息不动；更早的大块工具输出只留头尾。
// 为了少破坏提示缓存，攒够 PRUNE_BATCH 字符才裁一次（一次裁一批）。PRUNE=0 关闭。
const PRUNE_KEEP = 8, PRUNE_MIN = 1500, PRUNE_BATCH = Number(process.env.PRUNE_BATCH) || 6000;
const PRUNE_MARK = '…[旧工具输出已裁剪';
// 旧的工具调用参数（write_file 的整份内容、run_command 里的 heredoc 脚本）和工具输出一样每步重发，而内容早已落盘/执行过：
// 较早的调用里超长的字符串参数只留头尾（仍是合法 JSON）。最近 PRUNE_ARGS_KEEP 条消息不动，保留完整范例。PRUNE_ARGS=0 关闭。
const PRUNE_ARGS_KEEP = 24, PRUNE_ARG_MIN = 1200, PRUNE_ARG_MARK = '…[旧调用参数已裁剪';
function _slimToolArgs(raw) {
  if (typeof raw !== 'string' || raw.length <= PRUNE_ARG_MIN || raw.includes(PRUNE_ARG_MARK)) return '';
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { return ''; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '';
  let cut = false;
  const walk = v => {
    if (typeof v === 'string' && v.length > 700) { cut = true; return v.slice(0, 400) + `\n${PRUNE_ARG_MARK}：原 ${v.length} 字符，这是历史记录的缩略，不是当时的原文；需要原文就重新读文件]…\n` + v.slice(-150); }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out = JSON.stringify(walk(obj));
  return cut && out.length < raw.length - 300 ? out : '';
}
function pruneOldToolResults(session) {
  if (process.env.PRUNE === '0') return 0;
  const ms = session.messages || [];
  const end = ms.length - PRUNE_KEEP;
  const cand = [];
  let gain = 0;
  for (let i = 1; i < end; i++) {
    const m = ms[i];
    if (m.role !== 'tool' || typeof m.content !== 'string' || m.content.length <= PRUNE_MIN || m.content.includes(PRUNE_MARK)) continue;
    cand.push(i); gain += m.content.length - 1300;
  }
  const argCand = [];
  if (process.env.PRUNE_ARGS !== '0') {
    for (let i = 1; i < ms.length - PRUNE_ARGS_KEEP; i++) {
      for (const tc of (ms[i].role === 'assistant' && ms[i].tool_calls) || []) {
        const slim = _slimToolArgs(tc.function && tc.function.arguments);
        if (slim) { argCand.push([i, tc.id, slim]); gain += tc.function.arguments.length - slim.length; }
      }
    }
  }
  if (gain < PRUNE_BATCH) return 0;
  for (const i of cand) {
    const c = ms[i].content;
    ms[i] = { ...ms[i], content: c.slice(0, 800) + `\n${PRUNE_MARK}：原 ${c.length} 字符，只留头尾；需要细节就重新读文件/日志]…\n` + c.slice(-400) };
  }
  for (const [i, id, slim] of argCand) {
    ms[i] = { ...ms[i], tool_calls: ms[i].tool_calls.map(tc => tc.id === id ? { ...tc, function: { ...tc.function, arguments: slim } } : tc) };
  }
  return gain;
}
// 非流式、无工具的一次性调用（用于压缩摘要）；失败返回 null，由调用方兜底
async function llmOneShot(system, user, { maxTokens = 2000, signal, timeoutMs = 120_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let url, headers, model;
    if (SETTINGS.provider === 'copilot') {
      url = 'https://api.githubcopilot.com/chat/completions';
      headers = copilotHeaders(await copilotRefreshApiToken());
      model = SETTINGS.copilotModel || SETTINGS.model || 'gpt-4.1';
    } else {
      const config = resolveChatConfig(SETTINGS);
      url = config.url;
      headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey || 'local'}` };
      model = config.model;
    }
    const body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.1, max_tokens: maxTokens, stream: false };
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: _combineSignals(signal, ctrl.signal) });
    if (!resp.ok) return null;
    const j = await resp.json();
    const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    return typeof c === 'string' && c.trim() ? c.trim() : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

const COMPACT_SYS = '你是长程 CFD 智能体的上下文压缩器。把给定的历史轨迹压成一份接续笔记，让另一个智能体只看笔记就能接着干。严格按以下小节输出（没有就写"无"）：\n## 目标与用户要求\n## 已完成（含关键数值、路径、runId）\n## 已验证的事实/结论\n## 失败与教训（试过什么、为什么失败，禁止重复）\n## 进行中的后台作业\n## 下一步\n规则：只写轨迹里出现过的事实，不要编造；保留精确的文件路径、参数值、报错关键字；中文；不超过 1800 字。';

async function autoCompactIfNeeded(session, ws, signal, force = false) {
  const total = historyCharCount(session.messages);
  if (!force && total <= MAX_HISTORY_CHARS) return false;
  const before = session.messages.length;
  if (before > 10) {
    const sys = session.messages[0];
    // 安全切点：从 -6 起，若切点落在 role:'tool' 上，向左回退到拥有它的 assistant（含 tool_calls）。
    // 否则 tail 里的 tool 消息会指向已被压缩进 summary 的 tool_call_id → OpenAI 返回 400。
    let cutIdx = Math.max(1, before - 6);
    while (cutIdx > 1 && session.messages[cutIdx].role === 'tool') cutIdx--;
    // 若切点上方是 assistant + tool_calls，且其全部 tool 响应都在 tail 中，则保持 cut 不变；
    // 否则把这个 assistant 也并入 tail，避免它在 middle 里却没有对应工具响应。
    const tailMsgs = session.messages.slice(cutIdx);
    const middle = session.messages.slice(1, cutIdx);
    // 再保险：丢弃 tail 顶端找不到对应 assistant.tool_calls 的孤儿 tool 消息
    const tailIds = new Set();
    for (const m of tailMsgs) if (m.role === 'assistant' && m.tool_calls) for (const tc of m.tool_calls) tailIds.add(tc.id);
    const cleanTail = tailMsgs.filter(m => m.role !== 'tool' || tailIds.has(m.tool_call_id));
    const summary = middle.map(x => {
      if (x.role === 'user')      return `[用户] ${(typeof x.content === 'string' ? x.content : JSON.stringify(x.content)).slice(0, 200)}`;
      if (x.role === 'assistant') return `[助手] ${(x.content || '').toString().slice(0, 300)}` + (x.tool_calls ? ` (调用 ${x.tool_calls.map(t => t.function?.name).join(',')})` : '');
      if (x.role === 'tool')      return `[工具返回] ${String(x.content || '').slice(0, 160)}`;
      return '';
    }).filter(Boolean).join('\n');
    // 先让 LLM 写结构化接续笔记；输入用机械摘要（已各条截断）叠加上次笔记，控制在 ~120k 字内
    const holder = session.task || session;
    const prevNote = holder.compactNote ? `【上一版接续笔记】\n${holder.compactNote}\n\n` : '';
    const digest = summary.length > 120_000 ? summary.slice(0, 40_000) + '\n…\n' + summary.slice(-80_000) : summary;
    if (ws) try { ws.send(JSON.stringify({ type: 'agent_phase', phase: 'compacting', detail: '上下文超限 → LLM 生成接续笔记' })); } catch {}
    const note = await llmOneShot(COMPACT_SYS, prevNote + '【待压缩轨迹】\n' + digest, { maxTokens: 2500, signal });
    if (note) holder.compactNote = note;
    const body = note ? `以下是之前会话的接续笔记（LLM 压缩），请据此继续任务：\n${note}` : '以下是之前会话的压缩总结，请继续任务：\n' + summary.slice(-60_000);
    // 原地改写：同一任务的其他会话（多窗口/无人值守续跑）共享这个数组引用
    session.messages.splice(0, session.messages.length, sys, { role: 'user', content: body }, ...cleanTail);
  }
  // 压缩后用最新工作记忆刷新 system，保证 pinned 事实（case 事实/已验证/当前阶段）不被压没
  try { session.messages[0] = { role: 'system', content: buildSystemPrompt(session) }; } catch {}
  if (ws) try { ws.send(JSON.stringify({ type: 'term', line: `[自动压缩上下文：${(total/1024).toFixed(0)} KB 超限，消息 ${before} → ${session.messages.length}] `})); } catch {}
  return true;
}

// glob → RegExp（支持 **、*、?）
function globToRegExp(glob) {
  let re = '^'; let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i+1] === '*') { re += '.*'; i += 2; if (glob[i] === '/') i++; }
      else { re += '[^/]*'; i++; }
    } else if (c === '?') { re += '[^/]'; i++; }
    else if ('.+^$|()[]{}\\'.includes(c)) { re += '\\' + c; i++; }
    else { re += c; i++; }
  }
  re += '$';
  return new RegExp(re);
}

const TOOLS = [
  { type: 'function', function: { name: 'list_dir', description: '列出目录内容', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  { type: 'function', function: { name: 'read_file', description: '读取文本文件。可传 start_line/end_line (1-indexed, 闭区间) 只读一部分。', parameters: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'number' }, end_line: { type: 'number' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: '写入/创建文件', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'edit_file', description: '在文件中替换字符串。old_str 必须唯一匹配（行尾空白、弯引号差异自动容错；找不到时会返回文件里最接近的几行）。要替换全部出现处传 replace_all:true。', parameters: { type: 'object', properties: { path: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['path', 'old_str', 'new_str'] } } },
  { type: 'function', function: { name: 'multi_edit', description: '对同一个文件依次应用多个 edit_file 替换（原子：任一失败全部不写入）。快于多次调 edit_file。', parameters: { type: 'object', properties: { path: { type: 'string' }, edits: { type: 'array', items: { type: 'object', properties: { old_str: { type: 'string' }, new_str: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['old_str','new_str'] } } }, required: ['path','edits'] } } },
  { type: 'function', function: { name: 'glob', description: '按通配符查找文件（支持 ** 、 *）。例：**/*.py 、 src/**/*.ts。', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'grep_search', description: '正则搜索代码（返回文件:行号: 内容）', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'run_command', description: '执行 shell 命令（用户审批）。命令中的 python/python3/pip/jupyter 会被自动替换为用户在顶部选中的解释器。', parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_ms: { type: 'number', description: '超时毫秒，默认 120000；到时命令及其子进程会被终止' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'update_todos', description: '维护待办清单', parameters: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, done: { type: 'boolean' } }, required: ['text'] } } }, required: ['items'] } } },
  { type: 'function', function: { name: 'task_complete', description: '声明任务完成', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } } },
  { type: 'function', function: { name: 'web_search', description: '联网搜索。自动按优先级选用 Tavily(若 TAVILY_API_KEY) → Serper(SERPER_API_KEY) → Brave(BRAVE_API_KEY) → SearXNG(SEARXNG_URL) → DuckDuckGo HTML → Bing → Baidu。Tavily 会附带 LLM 摘要 answer。可指定 topic=news/general、time_range=day|week|month|year。', parameters: { type: 'object', properties: { query: { type: 'string' }, top_k: { type: 'number' }, topic: { type: 'string', enum: ['general','news'] }, time_range: { type: 'string', enum: ['day','week','month','year'] }, include_answer: { type: 'boolean', description: '默认 true（仅 Tavily 生效）' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'paper_search', description: '【学术】文献检索（合并 Semantic Scholar + arXiv，去重按 DOI/标题；无需 API Key）。返回 title / authors / year / venue / citationCount / abstract / DOI / openAccessPdf 链接，按引用数与年份综合排序。比 web_search 更适合找算法原文。', parameters: { type: 'object', properties: { query: { type: 'string' }, top_k: { type: 'number' }, year: { type: 'string', description: '如 2020-2025 / 2023- / -2018' }, open_access_only: { type: 'boolean' }, fields_of_study: { type: 'string', description: 'Semantic Scholar 字段过滤，如 Physics,Engineering,Computer Science（逗号分隔）' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'paper_fetch', description: '【学术】按 ID 取论文详情（abstract + tldr + references 列表 + OA PDF 链接）。id 可为 DOI:10.x/x、ARXIV:2106.15928、Semantic Scholar paperId（40 位 hex），或裸 arXiv id。可选 download=true 把 OA PDF 下载到 downloads/papers/ 便于后续 read_paper。', parameters: { type: 'object', properties: { id: { type: 'string' }, download: { type: 'boolean' }, max_refs: { type: 'number' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'read_paper', description: '【学术】比 read_document 更强：先 read_document 拿全文，再做章节切分与关键信息抽取——Abstract / Introduction / Methods / Equations / Results / Conclusion / References。返回结构化 Markdown。可选 focus 定位特定章节段落。', parameters: { type: 'object', properties: { path: { type: 'string' }, focus: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'post_view', description: '后处理出图（用户说"给我看 z=0.5 m 截面的乙烯云图""把颗粒浓度剖开看""画速度流线"时直接调用）。在右侧「可视化」里打开对应三维视图，并返回每层的数值统计；slice 层另存一张出版级 PNG 供 vision_analyze 检查。layers 每项：type=slice|clip|iso|threshold|stream|glyph|volume|surface|outline；field 场名（如 C2H4.gas、alpha.particles、U.gas）；comp=mag|x|y|z；axis=x|y|z（截面法向）与 position（米，沿 axis 的坐标；不给就取中间）；iso 用 values=[...]；threshold 用 lo/hi；stream 用 vector 与 p1/p2 种子线（不给自动取底部横线）；可选 cmap、lo/hi 色标范围、log、contours（截面等值线条数）、opacity。先不知道有哪些场时 layers 可省略，返回会列出场名和范围。', parameters: { type: 'object', properties: { case: { type: 'string', description: '算例目录（工作区内）' }, time: { type: 'string', description: '时刻，默认最新' }, mode: { type: 'string', enum: ['post', 'mesh'], description: 'mesh=网格与几何视图' }, layers: { type: 'array', items: { type: 'object' } }, show: { type: 'boolean', description: '是否在界面打开，默认 true' } }, required: ['case'] } } },
  { type: 'function', function: { name: 'skill_pack_read', description: '读官方技能包（OpenFOAM、LBM 等）的说明或参考文件。系统提示里列了已启用的包；需要字典模板、边界条件写法、报错对照、LBM 格子/碰撞算子细节时调用。file 省略读 SKILL.md，否则如 reference/boundary-conditions.md、templates/xxx。', parameters: { type: 'object', properties: { pack: { type: 'string' }, file: { type: 'string' } }, required: ['pack'] } } },  { type: 'function', function: { name: 'paper_figures', description: '把论文 PDF 里的嵌入图按原始分辨率抽出来（整页渲染会把小插图糊掉），附所在页与图注。建几何前必做：几何图里的部件（分布器圈数、孔、板厚、进气室、尺寸线起点）正文常常不写。', parameters: { type: 'object', properties: { path: { type: 'string', description: '论文 PDF 路径' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'image_crop', description: '裁剪并放大图片的一部分（LANCZOS），可选像素测距：ref={p1,p2,mm} 用图上已标注尺寸定比例尺（ref 必须和被测部件在同一个视图里：放大插图有自己的比例尺，用主图的尺寸线会差几倍），measure=[[p1,p2],...] 返回 px 与 mm（坐标用原图像素）。用于看清小插图里的部件并量尺寸，之后 vision_analyze。', parameters: { type: 'object', properties: { path: { type: 'string' }, box: { type: 'array', items: { type: 'number' }, description: '[x0,y0,x1,y1] 原图像素；不给就整张' }, scale: { type: 'number', description: '放大倍数 1–12，默认 4' }, ref: { type: 'object', description: '{p1:[x,y], p2:[x,y], mm: 实际长度}' }, measure: { type: 'array', items: { type: 'array' }, description: '[[[x1,y1],[x2,y2]], ...]' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'paper_extract', description: '【学术·精准抽取】从论文 PDF 抽出「grounded 结构化要素」：带编号方程(含所在页)、表格(还原成 Markdown)、带单位数值参数(去重)。只抽原文真实出现的内容、不臆造。复杂/图片型公式建议 render_pages=true 渲染整页，再用 vision_analyze 逐字精转写、paper_param_verify 核验单位量纲。比 read_paper 更适合「精确拿数值/方程/表格」。', parameters: { type: 'object', properties: { path: { type: 'string' }, focus: { type: 'string', description: '可选：聚焦关键词，命中段落附在末尾' }, render_pages: { type: 'boolean', description: '渲染整页 PNG 供 vision_analyze 精转写方程/表格' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'vision_analyze', description: '【视觉】对一张或多张本地/网络图片做"高清细看"——以 detail=high 把图片发给多模态模型并按 question 抽取结构化信息。适用于：读图表数值、读公式、读表格、读流程图。images 是路径数组（相对工作区或绝对，或 http(s) URL）。', parameters: { type: 'object', properties: { images: { type: 'array', items: { type: 'string' } }, question: { type: 'string' }, max_tokens: { type: 'number' } }, required: ['images','question'] } } },
  { type: 'function', function: { name: 'image_search', description: '【图片搜索】专门搜图片（Bing Images），返回缩略图+原图 URL+来源页。结果会自动出现在右侧"图片库"面板中可双击大图、可下载。适合"找论文里 XX 现象的图"。', parameters: { type: 'object', properties: { query: { type: 'string' }, top_k: { type: 'number', description: '默认 12，最多 30' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'fetch_url', description: '拉取网页可读文本；自动追加图片链接列表（最多前 20 张）和正文图片描述。', parameters: { type: 'object', properties: { url: { type: 'string' }, max_chars: { type: 'number' }, with_images: { type: 'boolean' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'read_document', description: '读取本地 PDF/DOCX/PPTX/XLSX/图片(OCR)/纯文本 文件，返回提取出的纯文本内容。需用户已配置 Python 解释器。', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'request_user_digitize', description: '【V3 手动标注】当你从论文图表/截图里需要精准的 (x,y) 数据点作为参考或对比基准，但大模型抽不准时调用。会在用户界面弹出手动标注仪（类 WebPlotDigitizer），用户点何点为数据点后保存为 CSV，返回该 CSV 的路径供后续读取。阻塞等待，默认超时 600s。', parameters: { type: 'object', properties: { image_path: { type: 'string', description: '可选，工作区内的图片路径；传了会预加载到标注仪。不传则让用户自己选图。' }, hint: { type: 'string', description: '给用户的提示，如 “请标 Fig.5 里 baseline 曲线上 8–10 个点”' }, name: { type: 'string', description: '保存 CSV 的名字（默认 plot）' }, timeout_sec: { type: 'number', description: '等待用户完成的超时（秒），默认 600' } }, required: [] } } },
  { type: 'function', function: { name: 'download_file', description: '从 URL 下载到本地（默认到 downloads/ 目录）。可用于保存网页里的图片或 PDF/zip 等。', parameters: { type: 'object', properties: { url: { type: 'string' }, save_as: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'sim_render', description: '【仿真】用 pvpython 离屏渲染一帧为 PNG 并显示到右侧。可选 field 上色、time_step 选时间步。', parameters: { type: 'object', properties: { case_path: { type: 'string' }, field: { type: 'string', description: '上色场名（如 U / p / T）。不传则单色显示。' }, time_step: { type: 'number', description: '时间步索引（从 0 开始），或传 -1 表示最后一个。' }, azimuth: { type: 'number' }, elevation: { type: 'number' }, zoom: { type: 'number' } }, required: ['case_path'] } } },
  { type: 'function', function: { name: 'sim_open_paraview', description: '【仿真】启动本机 ParaView GUI 作为独立窗口（不嵌入）。', parameters: { type: 'object', properties: { case_path: { type: 'string' } } } } },
  { type: 'function', function: { name: 'sim_run_openfoam', description: '【仿真】在算例目录执行 OpenFOAM 命令。需审批。', parameters: { type: 'object', properties: { case_path: { type: 'string' }, command: { type: 'string' } }, required: ['case_path', 'command'] } } },
  { type: 'function', function: { name: 'foam_find_tutorial', description: '【FOAM-Beta】在 OpenFOAM 安装的 tutorials/ 中按关键字搜索算例（含 system/controlDict 的目录）。返回候选路径列表。', parameters: { type: 'object', properties: { query: { type: 'string' }, top_k: { type: 'number' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'foam_find_source', description: '【FOAM-Beta】在 OpenFOAM 源码中按关键字搜索（src/ + applications/）。kind：solver/model/bc/all。常用于查找曳力模型(WenYu/Ergun/SchillerNaumann)、湍流模型、求解器、边界条件等参考实现。', parameters: { type: 'object', properties: { query: { type: 'string' }, kind: { type: 'string', enum: ['solver','model','bc','all'] }, top_k: { type: 'number' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'foam_clone_tutorial', description: '【FOAM-Beta】把 OpenFOAM tutorials/ 下的某个算例完整复制到工作区指定目录。tutorial_path 既可以是绝对路径，也可以是相对 tutorials/ 的路径（如 multiphase/twoPhaseEulerFoam/RAS/bubbleColumn）。', parameters: { type: 'object', properties: { tutorial_path: { type: 'string' }, dest: { type: 'string', description: '相对工作区的目标目录' } }, required: ['tutorial_path', 'dest'] } } },
  { type: 'function', function: { name: 'foam_inspect_case', description: '【FOAM-Beta】检查算例：列出 0/ constant/ system/ 内容，提取每个 patch 在每个场上的边界类型 / 求解器 / 时间步 / 关键物理参数；用于确定下一步要让用户改什么。最后附上递归文件清单。', parameters: { type: 'object', properties: { case_path: { type: 'string' } }, required: ['case_path'] } } },
  { type: 'function', function: { name: 'foam_run_solver_async', description: '【FOAM-Beta】启动求解器（或任何 OpenFOAM 命令）为后台作业。返回 runId 供轮询。避免主会话被长任务阻塞。需审批。', parameters: { type: 'object', properties: { case_path: { type: 'string' }, command: { type: 'string' }, skip_prelaunch: { type: 'boolean', description: '跳过启动前 controlDict 写出检查（仅在确认无碍时）' } }, required: ['case_path','command'] } } },
  { type: 'function', function: { name: 'foam_solver_status', description: '【FOAM-Beta】查看某个后台求解器作业的最新状态：当前Time、最近残差、log tail、是否还在跑。', parameters: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'] } } },
  { type: 'function', function: { name: 'foam_solver_stop', description: '【FOAM-Beta】中止某个后台求解器作业。', parameters: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'] } } },
  { type: 'function', function: { name: 'foam_stl_inspect', description: '【FOAM-Beta v6】读取 STL（ASCII/二进制）几何信息：三角形数、bbox、质心、体积、是否封闭、单位猜测、最薄边长 q05/q50（薄壁特征）、internal_seed/external_seed（射线投射得到的内/外种子点）、domain_type_hint。foam_mesh_plan 强烈依赖这些字段。', parameters: { type: 'object', properties: { stl_path: { type: 'string' } }, required: ['stl_path'] } } },
  { type: 'function', function: { name: 'foam_mesh_plan', description: '【FOAM-Beta v6 史诗增强】生成 blockMeshDict + snappyHexMeshDict + surfaceFeaturesDict。**核心：必须显式指定 domain.type（external/internal/box/wrap），否则计算域可能与论文不符**。支持多 STL/多 patch、距离场加密、绝对边界层厚度（米）、紧化的尖角保留参数。需审批。', parameters: { type: 'object', properties: {
      case_path: { type: 'string', description: '目标 case 目录' },
      stl_path: { type: 'string', description: '单 STL 路径（与 surfaces[] 二选一）' },
      surfaces: { type: 'array', description: '多 STL/多 patch 模式：[{file, patch_name, level:[min,max], layers, region:{mode:"distance"|"inside", distances?, levels?, level?}}]。每个 STL 可独立加密级别和距离场。', items: { type: 'object' } },
      domain: { type: 'object', description: '**计算域显式定义（强烈建议）**。type=external 外流绕流（参数 upstream/downstream/lateral/vertical_top/vertical_bottom，以 STL 最大尺寸为单位的倍数）；type=internal 内流场（STL 即外壁，背景域紧贴 STL bbox）；type=box 用户给定 bbox_min[3]/bbox_max[3]（论文规定计算域时用）；type=wrap 兼容旧默认（不推荐）。' },
      target_cell_size: { type: 'number', description: '背景 cell 边长（米）。不给则按 STL/30 估算。' },
      refinement_level_min: { type: 'number', description: 'snappy 表面加密最小级（默认 1，多 STL 时被 surfaces[].level 覆盖）' },
      refinement_level_max: { type: 'number', description: 'snappy 表面加密最大级（默认 3）' },
      feature_level: { type: 'number', description: '特征边加密级（默认 = max surface level）' },
      n_cells_between_levels: { type: 'number', description: '跨级 buffer cell 数（默认 5，比旧版 3 更保守）' },
      resolve_feature_angle: { type: 'number', description: 'snap 时保留尖角的角度阈值（默认 25°，越小越细致）' },
      n_layers: { type: 'number', description: '边界层层数（旧字段，多 patch 时改用 surfaces[].layers）' },
      first_layer_thickness: { type: 'number', description: '**第一层绝对厚度（米）**。给定后用 relativeSizes=false，由 y+ 反算（先调 foam_compute_first_layer 得到此值）。' },
      expansion_ratio: { type: 'number', description: '边界层膨胀比（默认 1.2）' },
      max_global_cells: { type: 'number', description: '全局单元数上限（默认 8e6）' },
      location_in_mesh: { type: 'array', items: { type: 'number' }, description: '内部种子点 [x,y,z]。不给则按 domain 类型从 STL 射线测试结果选 internal_seed/external_seed。' },
      flow_direction: { type: 'string', enum: ['x','y','z'], description: '主流方向（仅 external 用于命名 inlet/outlet）' },
      strategy: { type: 'string', enum: ['default','coarsen','minimal','box_stl'], description: '重试策略；default=默认；coarsen=粗化；minimal=只castellated；box_stl=额外写外域box' }
    }, required: ['case_path'] } } },
  { type: 'function', function: { name: 'foam_compute_first_layer', description: '【FOAM-Beta v6 y+ 反算】根据参考速度 U_ref、参考长度 L_ref、运动粘度 nu、目标 y+ 反算第一层厚度、推荐层数 N、总厚度。直接把输出的 first_layer_thickness/n_layers/expansion_ratio 传给 foam_mesh_plan。', parameters: { type: 'object', properties: { U_ref: { type: 'number', description: '参考速度（m/s）' }, L_ref: { type: 'number', description: '参考长度（米；外流场常用弦长/直径，内流场用水力直径）' }, nu: { type: 'number', description: '运动粘度（m²/s，默认 1.5e-5 空气）' }, y_plus_target: { type: 'number', description: '目标 y+（默认 1.0；用壁函数则 30~100）' }, expansion_ratio: { type: 'number', description: '层膨胀比（默认 1.2）' }, coverage: { type: 'number', description: '层覆盖 BL 比例（默认 0.7）' } }, required: ['U_ref','L_ref'] } } },
  { type: 'function', function: { name: 'foam_mesh_box_stl', description: '【FOAM-Beta】在 case/constant/triSurface/ 下写一个 axis-aligned box STL（外域包围盒）。用于 blockMesh 反复失败后转“双 STL + snappyHexMesh”倒换策略：用 box STL 当外埌，物体 STL 当内部加密。需审批。', parameters: { type: 'object', properties: { case_path: { type: 'string' }, bbox_min: { type: 'array', items: { type: 'number' }, description: '[xmin,ymin,zmin]（米）' }, bbox_max: { type: 'array', items: { type: 'number' }, description: '[xmax,ymax,zmax]（米）' }, name: { type: 'string', description: 'STL 名（不含 .stl，默认 domain_box）' } }, required: ['case_path','bbox_min','bbox_max'] } } },
  { type: 'function', function: { name: 'foam_stl_generate', description: '【FOAM-Beta v6 几何生成】参数化生成水密(watertight) STL 几何，单位=米，写到 case/constant/triSurface/（或指定 out_path）。优先用 Python trimesh（基元/布尔/变换/水密检查最准），缺库时自动回退到内置纯 Python 生成器（支持 box/sphere/cylinder/cone/pipe，法向已保证朝外）。\n支持：单基元 shape+params；多基元 parts[]（合并）；subtract[]（从主体挖孔做内流域/管道，需 trimesh+manifold3d）。每个基元可带 translate[3] 和 rotate_deg[3]（XYZ 欧拉角）。\n基元类型与 params：box{lx,ly,lz | size[3]}；sphere{r,segments?}；cylinder{r,h,sections?}；cone{r,h,sections?}；pipe{r_outer,r_inner,h,sections?}（环形管/空心圆柱）；capsule{r,h}(trimesh)；torus{r_major,r_minor}(trimesh)；naca{digits:"0012",chord,span,sections?}(trimesh 机翼拉伸)。\n典型用法：① 外流绕流物体（球/圆柱/机翼）；② 内流管道(pipe 或 box 外壳 subtract 内腔)；③ 组合几何(parts 多个基元)。生成后建议接 foam_stl_inspect / foam_stl_render 目检。需审批。', parameters: { type: 'object', properties: {
      out_path: { type: 'string', description: '输出 STL 路径（相对工作区或绝对）。与 case_path+name 二选一。' },
      case_path: { type: 'string', description: '目标 case 目录；配合 name 写到 case/constant/triSurface/<name>.stl' },
      name: { type: 'string', description: 'STL 名（不含 .stl，默认 geometry）' },
      shape: { type: 'string', enum: ['box','sphere','cylinder','cone','pipe','capsule','torus','naca'], description: '单基元几何类型（与 parts 二选一）' },
      params: { type: 'object', description: '该 shape 的参数，单位米。见工具描述里各基元的字段。' },
      parts: { type: 'array', description: '多基元模式：[{shape, params, translate?:[x,y,z], rotate_deg?:[rx,ry,rz]}]，结果合并为一个 STL。', items: { type: 'object' } },
      subtract: { type: 'array', description: '从主体挖去的基元列表（布尔差，需 trimesh+manifold3d），用于做内流腔/管道。结构同 parts。', items: { type: 'object' } },
      scale: { type: 'number', description: '整体缩放系数（如几何按 mm 建则填 0.001 转米）。默认 1。' }
    }, required: [] } } },
  { type: 'function', function: { name: 'foam_env_check', description: '【FOAM-Beta v6 环境体检】检查 OpenFOAM 环境（foamRoot、关键命令、版本、Python/ParaView），每个失败项附修复建议。开局或"命令找不到"时调用。', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'foam_residual_series', description: '【FOAM-Beta】解析后台求解器 log，返回结构化的时间步与残差时序（JSON）。LLM 用来判断收敛趋势、是否震荡、何时建议改 nNonOrthoCorrectors / 松弛因子等。', parameters: { type: 'object', properties: { run_id: { type: 'string' }, max_points: { type: 'number', description: '最多返回多少个时间步（默认 60，倒数取最新）' }, fields: { type: 'array', items: { type: 'string' }, description: '只关心的场名，例如 ["U","p","k","epsilon"]' } }, required: ['run_id'] } } },
  { type: 'function', function: { name: 'foam_compare_render', description: '【FOAM-Beta】并排渲染两个 case 的同一场同一时间步，结果以 sim_compare 消息推送到前端聊天，方便定性对比（如新模型 vs baseline / 网格无关性 / 论文复现）。', parameters: { type: 'object', properties: { case_a: { type: 'string' }, case_b: { type: 'string' }, label_a: { type: 'string' }, label_b: { type: 'string' }, field: { type: 'string' }, time_step: { type: 'string' }, azimuth: { type: 'number' }, elevation: { type: 'number' } }, required: ['case_a','case_b'] } } },
  { type: 'function', function: { name: 'foam_mesh_verify', description: '【FOAM-Beta v6 网格自动核对】blockMesh / snappyHexMesh 之后必走的视觉验证闭环：① 在 case 内运行 checkMesh -allTopology -allGeometry 抓 negVol/maxSkew/maxNonOrtho/aspectRatio/openCells/failed checks；② 多角度离屏渲染网格；③ 把渲染图丢给 vision_analyze 让 VLM 按硬性 checklist 判通过；返回 JSON: {pass, stage, metrics, renders, vision, suggestions}。pass=false 时 LLM 应立刻 edit_file 修 Dict 或 foam_mesh_plan(strategy=coarsen/minimal/box_stl) 倒档重试（最多 3 次）。', parameters: { type: 'object', properties: { case_path: { type: 'string' }, stage: { type: 'string', enum: ['blockMesh','snappy','layers','final'], description: '当前在哪一关：blockMesh=刚跑完 blockMesh；snappy=刚跑完 snappyHexMesh；layers=带边界层后；final=求解前最终确认' }, ask_vision: { type: 'boolean', description: '默认 true。false 时只跑 checkMesh+渲染不调 VLM（节流）' }, n_views: { type: 'number', description: '渲染视角数 1-4，默认 2（等角 + 切片）' } }, required: ['case_path'] } } },
  { type: 'function', function: { name: 'foam_stl_render', description: '【FOAM-Beta v6 STL 预检】在 snappyHexMesh 之前先把 STL 几何渲染 3-4 视角，让 LLM/VLM 肉眼确认：法向朝外、是否封闭、有无破洞、bbox 比例正确。返回渲染路径与 bbox/三角形数等元数据。比 foam_stl_inspect 多了视觉一层。', parameters: { type: 'object', properties: { stl_path: { type: 'string' }, n_views: { type: 'number', description: '默认 3：front/top/iso' } }, required: ['stl_path'] } } },
  { type: 'function', function: { name: 'foam_mesh_stl_check', description: '【FOAM-Beta v6 STL 贴合度核验】snappyHexMesh 跑完之后必走的几何对齐检查：① 用 surfaceMeshTriangulate 把指定 patch 导出为 STL；② 与原始 STL 做双向 Hausdorff 采样（默认 5000 点/方向）；③ 对比 bbox 与表面积；④ 输出 mean/p95/max 距离占 bbox 对角线百分比 + pass/fail + issues 列表。能抓出 snap 没贴上、castellated 吞面、locationInMesh 选反、layer 鼓包等仅看 checkMesh 看不出来的问题。pass=false 时 LLM 必须 edit_file 改 snappyHexMeshDict（提 refinement level / featureAngle / snap iter）再 foam_run_solver_async 重跑。', parameters: { type: 'object', properties: { case_path: { type: 'string' }, ref_stl: { type: 'string', description: '原始几何 STL 的路径（绝对或相对 case_path；通常是 constant/triSurface/xxx.stl）' }, patches: { type: 'array', items: { type: 'string' }, description: 'snappy 切出来的 patch 名列表，对应 ref_stl 的几何（如 ["car"] / ["hull","propeller"]）' }, samples: { type: 'number', description: '每方向采样点数，默认 5000；几何复杂可提到 20000' }, tol_mean_pct: { type: 'number', description: 'mean 距离阈值占 bbox 对角线 %，默认 2.0' }, tol_p95_pct:  { type: 'number', description: 'p95 阈值 %，默认 5.0' }, tol_max_pct:  { type: 'number', description: 'Hausdorff 阈值 %，默认 10.0' } }, required: ['case_path','ref_stl','patches'] } } },
  { type: 'function', function: { name: 'foam_patch_diff', description: '【FOAM-Beta v6 patch 对照】解析 constant/polyMesh/boundary 给出当前所有 patch 名 / type / nFaces；可选传 snapshot_before（上一次的 patch 列表 JSON 字符串）做 diff，输出新增/丢失/类型变化。常用于 snappy 之后核对是否把 STL 切成了正确的命名 patch（inlet/outlet/walls），以及 createPatch 改名是否成功。', parameters: { type: 'object', properties: { case_path: { type: 'string' }, snapshot_before: { type: 'string', description: '可选：上一次 foam_patch_diff 返回里的 patches JSON，传入做 diff' } }, required: ['case_path'] } } },

  // ---------- MFIX Beta ----------
  { type: 'function', function: { name: 'mfix_find_tutorial', description: '【MFIX-Beta】在 MFIX 安装目录的 tutorials/（含 mfix.dat 或 *.mfx 的子目录）中按关键字搜索算例。返回候选路径列表。', parameters: { type: 'object', properties: { query: { type: 'string' }, top_k: { type: 'number' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'mfix_clone_tutorial', description: '【MFIX-Beta】把 MFIX tutorials/ 下的某个算例完整复制到工作区。tutorial_path 既可绝对，也可相对 tutorials/。', parameters: { type: 'object', properties: { tutorial_path: { type: 'string' }, dest: { type: 'string', description: '相对工作区的目标目录' } }, required: ['tutorial_path','dest'] } } },
  { type: 'function', function: { name: 'mfix_inspect_case', description: '【MFIX-Beta】检查 MFIX 算例：解析 mfix.dat 或 *.mfx，提取关键 keyword（RUN_TYPE / TIME / DT / GEOMETRY / IMAX-JMAX-KMAX / MMAX / 边界条件 BC_* / 初始条件 IC_*），并附递归文件清单。', parameters: { type: 'object', properties: { case_path: { type: 'string' } }, required: ['case_path'] } } },
  { type: 'function', function: { name: 'mfix_run_solver_async', description: '【MFIX-Beta】启动 mfixsolver（或任何 MFIX 命令）为后台作业。返回 runId 供轮询。需审批。', parameters: { type: 'object', properties: { case_path: { type: 'string' }, command: { type: 'string', description: '默认为 mfixsolver；可传 mpirun -np N mfixsolver / mfixsolver -f xxx.mfx 等' } }, required: ['case_path'] } } },
  { type: 'function', function: { name: 'mfix_solver_status', description: '【MFIX-Beta】查看 MFIX 后台作业最新状态：当前 Time、最近残差行、log tail、是否还在跑。', parameters: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'] } } },
  { type: 'function', function: { name: 'mfix_solver_stop', description: '【MFIX-Beta】中止某个 MFIX 后台作业。', parameters: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'] } } },

  // ---------- LBM Beta ----------
  { type: 'function', function: { name: 'lbm_find_tutorial', description: '【LBM-Beta】在用户提供的 LBM 算例根目录（lbmTutorialRoot）中按关键字搜索算例（任何含 README / *.py / *.cpp / input.* / params.* 的子目录都算候选）。返回候选路径列表。', parameters: { type: 'object', properties: { query: { type: 'string' }, top_k: { type: 'number' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'lbm_clone_tutorial', description: '【LBM-Beta】把 LBM 教程根下的某个算例完整复制到工作区。', parameters: { type: 'object', properties: { tutorial_path: { type: 'string' }, dest: { type: 'string' } }, required: ['tutorial_path','dest'] } } },
  { type: 'function', function: { name: 'lbm_inspect_case', description: '【LBM-Beta】检查 LBM 算例：列出文件清单 + 自动识别算法骨架（D2Q9/D3Q19/D3Q27、BGK/MRT/TRT/Cumulant/Regularized、是否多相/多相场、是否含 collision 函数 / propagate / equilibrium），并提取 README / params 中关键参数。', parameters: { type: 'object', properties: { case_path: { type: 'string' }, algorithm: { type: 'string', description: '用户已知的算法名提示（可选，如 "D3Q19 MRT" / "Palabos BGK"）' } }, required: ['case_path'] } } },
  { type: 'function', function: { name: 'lbm_run_async', description: '【LBM-Beta】在算例目录后台执行任意命令（如 python3 main.py / ./lb / mpirun -np 4 ./lb）。返回 runId。需审批。', parameters: { type: 'object', properties: { case_path: { type: 'string' }, command: { type: 'string', description: '不传则使用 SETTINGS.lbmRunCmd 默认模板' } }, required: ['case_path'] } } },
  { type: 'function', function: { name: 'lbm_solver_status', description: '【LBM-Beta】查看 LBM 后台作业状态：log tail、提取的时间步与误差/macroscopic 指标（适配通用 print 风格）。', parameters: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'] } } },
  { type: 'function', function: { name: 'lbm_solver_stop', description: '【LBM-Beta】中止某个 LBM 后台作业。', parameters: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'] } } },

  // ---------- v0.6.0 自治可靠性 ----------
  { type: 'function', function: { name: 'run_status_load', description: '\u3010v6\u3011读取当前 Run 状态（已完成的 stages / memos / failCount）。任务开始或中途想接续时调用一次。', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'run_stage_start', description: '\u3010v6\u3011声明进入一个阶段（如 mesh / solve / post）。Stage 名称建议: geom / mesh / setup / solve / post / verify / report。', parameters: { type: 'object', properties: { stage: { type: 'string' }, label: { type: 'string', description: '可选，整个 Run 的标签（首次调用时设置）' } }, required: ['stage'] } } },
  { type: 'function', function: { name: 'run_stage_done', description: '\u3010v6\u3011标记阶段完成（或失败）。需在每个阶段结尾调用，写入 runs/<runId>/state.json，便于断点续跑。', parameters: { type: 'object', properties: { stage: { type: 'string' }, passed: { type: 'boolean' }, memo: { type: 'string', description: '决策备忘：为什么这么做 / 关键参数 / 下一步建议' }, artifacts: { type: 'array', items: { type: 'string' } } }, required: ['stage'] } } },
  { type: 'function', function: { name: 'foam_geom_verify', description: '\u3010v6 几何核验】在 mesh 之前用 VLM 检查 STL/几何渲染图：法向、封闭、比例、单位是否与论文/任务一致。返回 {passed, score, reasons, suggestions}。', parameters: { type: 'object', properties: { images: { type: 'array', items: { type: 'string' } }, expected: { type: 'string', description: '期望特征描述（如 "圆管 D=0.1m 长 L=1m"）' } }, required: ['images'] } } },
  { type: 'function', function: { name: 'foam_solve_verify', description: '\u3010v6 求解核验】根据 foam_residual_series + 终态渲染图判定收敛与物理合理性。返回 {passed, score, reasons, suggestions}。', parameters: { type: 'object', properties: { run_id: { type: 'string' }, images: { type: 'array', items: { type: 'string' } }, expected: { type: 'string' } }, required: ['run_id'] } } },
  { type: 'function', function: { name: 'foam_post_verify', description: '\u3010v6 后处理核验】对最终云图/切片/曲线图做 VLM 体检：是否有明显数值发散、对称破缺、单位异常。返回 {passed, score, reasons, suggestions}。', parameters: { type: 'object', properties: { images: { type: 'array', items: { type: 'string' } }, expected: { type: 'string' } }, required: ['images'] } } },
  { type: 'function', function: { name: 'paper_param_verify', description: '【v6 参数核验】把从论文里抽取的关键参数表交叉核对一遍（数值范围、单位、量纲）。可附带原文页图请 VLM 比对。返回 {passed, reasons, suggestions}。', parameters: { type: 'object', properties: { params: { type: 'object', description: '抽取的参数 key->value' }, expected_units: { type: 'object', description: '期望单位 key->unit' }, images: { type: 'array', items: { type: 'string' }, description: '可选：原文页图' } }, required: ['params'] } } },
  { type: 'function', function: { name: 'opt_study_create', description: '【v6 优化】创建/重连一个 Optuna 优化 study。必须先调它再调 opt_suggest_next。study_id 是英文短名（如 bubcol_holdup_v1）。base_case 是要复制的基线 case 路径。search_space 是参数列表：每项 {name, type:float/int/cat, low, high, log?, choices?}。objective.direction= minimize|maximize。sampler= TPE(默认,贝叶斯) / GP(高斯过程BO) / CMA(进化策略) / Random / Grid。需审批（会写 study.json + Optuna SQLite）。', parameters: { type: 'object', properties: {
      study_id: { type: 'string' },
      base_case: { type: 'string', description: '基线 case 路径（每个 trial 会拷贝它）' },
      objective: { type: 'object', description: '{ name: string, direction:"minimize"|"maximize", target?: number }' },
      search_space: { type: 'array', description: '[{name, type, low?, high?, log?, choices?, step?}]', items: { type: 'object' } },
      sampler: { type: 'string', enum: ['TPE','GP','CMA','Random','Grid'], description: '默认 TPE' },
      pruner: { type: 'string', enum: ['Median','Hyperband'], description: '可选剪枝器' },
      n_trials_budget: { type: 'number', description: '总预算 trial 数，默认 30' },
      seed: { type: 'number' },
      kpi_extract: { type: 'object', description: '可选：默认 KPI 提取配置（method/regex/script）' },
      param_mapping: { type: 'object', description: '可选：默认参数→字典路径映射 {name:"<file>::<entry>"}' },
      pipeline: { type: 'object', description: '必填：固定 stages(generate/mesh/solve/verify，各含 command 数组和 timeoutMs) 与 acceptance；含 fit/holdout 指标及统计窗。见 docs/CFD_TRIAL_PIPELINE.md' },
      notes: { type: 'string' }
    }, required: ['study_id','base_case','search_space','objective','pipeline'] } } },
  { type: 'function', function: { name: 'opt_run_trial', description: '执行已锁定 study 合同的隔离 CFD trial：生成→网格→求解→独立验收。失败即停，不复制旧结果；仅验收通过可回填 COMPLETE。', parameters: { type: 'object', properties: { study_id: { type: 'string' }, trial_id: { type: 'integer' } }, required: ['study_id','trial_id'] } } },
  { type: 'function', function: { name: 'opt_suggest_next', description: '【v6 优化】从 study 中拿下一个 trial 的参数建议。返回 {trial_id, params, trial_dir_suggested}。拿到后 agent 自己负责：① 拷贝 base_case 到 trial 目录；② 用 opt_apply_params 或 edit_file 写入参数；③ 跑 mesh/solve；④ opt_extract_kpi 取 KPI；⑤ opt_record_result 回填。', parameters: { type: 'object', properties: { study_id: { type: 'string' } }, required: ['study_id'] } } },
  { type: 'function', function: { name: 'opt_apply_params', description: '【v6 优化】把一组参数值写入 case 的 OpenFOAM 字典。用 foamDictionary 命令做精确替换（需要 OpenFOAM 环境已 source）。mapping 把参数名映射到 "<相对文件路径>::<dict entry path>"，如 {"nu":"constant/transportProperties::nu", "U_in":"0/U::boundaryField/inlet/value"}。需审批（会修改 case 文件）。', parameters: { type: 'object', properties: {
      case_path: { type: 'string' },
      params:    { type: 'object', description: '{ param_name: value }' },
      mapping:   { type: 'object', description: '{ param_name: "<file>::<entry>" }' }
    }, required: ['case_path','params','mapping'] } } },
  { type: 'function', function: { name: 'opt_extract_kpi', description: '【v6 优化】从 trial 的 case 目录提取一个标量 KPI。method=regex：从 file 用 pattern 抓数字（第一个捕获组）；method=pvpython：跑 pvpython script case_path …，约定脚本最后一行打印数字或 {"kpi":num}；method=script：同上但用普通 python。', parameters: { type: 'object', properties: {
      case_path: { type: 'string' },
      method:    { type: 'string', enum: ['regex','pvpython','script','postproc'] },
      function_object: { type: 'string', description: 'postproc 方法：postProcessing 子目录名' },
      column:    { type: 'string', description: 'postproc 方法：要取时均的列名（见 foam_postproc_stats 输出）' },
      t_start:   { type: 'number', description: 'postproc 方法：时均起点；缺省取末尾 40%' },
      t_end:     { type: 'number' },
      last_fraction: { type: 'number' },
      allow_nonstationary: { type: 'boolean', description: 'postproc 方法：窗口未平稳时仍返回均值（默认拒绝）' },
      file:      { type: 'string', description: 'regex 方法：要扫的文件（log 或 postProcessing/*.dat）' },
      pattern:   { type: 'string', description: 'regex 方法：JS 正则，第一个捕获组= KPI 值' },
      flags:     { type: 'string', description: 'regex flags，如 m' },
      script:    { type: 'string', description: 'pvpython/script 方法：脚本路径' },
      script_args: { type: 'array', items: { type: 'string' }, description: '额外命令行参数' }
    }, required: ['case_path','method'] } } },
  { type: 'function', function: { name: 'opt_record_result', description: '【v6 优化】把这个 trial 的目标值告知 Optuna。state=COMPLETE 时必须给 value。PRUNED 表示中途因剪枝/资源问题终止；FAIL 表示算例本身失败。', parameters: { type: 'object', properties: {
      study_id: { type: 'string' },
      trial_id: { type: 'number' },
      value:    { type: 'number' },
      evidence_path: { type: 'string', description: 'COMPLETE 必填：opt_run_trial 返回的 trial-result.json 路径，将重新核验合同及产物哈希' },
      state:    { type: 'string', enum: ['COMPLETE','PRUNED','FAIL'] }
    }, required: ['study_id','trial_id'] } } },
  { type: 'function', function: { name: 'opt_status', description: '【v6 优化】查 study 当前状态：n_done / best / 最近 5 次收敛曲线 / 参数重要性（≥10 trial 才有）。每 5 个 trial 调一次贴回聊天。', parameters: { type: 'object', properties: { study_id: { type: 'string' } }, required: ['study_id'] } } },
  { type: 'function', function: { name: 'opt_render', description: '【v6 优化】渲染优化过程图并推到聊天界面。kind=history（收敛曲线）/ importance（参数重要性）/ parallel（平行坐标）/ slice（参数切片）。', parameters: { type: 'object', properties: { study_id: { type: 'string' }, kind: { type: 'string', enum: ['history','importance','parallel','slice'] } }, required: ['study_id','kind'] } } },

  // ====================== v0.9.0 (V8) 招1：Git 自动版本 ======================
  { type: 'function', function: { name: 'git_log_recent', description: '【V8 招1】列出最近 N 个 git commit（SHA + 消息 + 改动文件数）。出错/越改越差时**第一步**调它定位"上一个能跑的快照"。', parameters: { type: 'object', properties: { n: { type: 'integer', default: 10 } } } } },
  { type: 'function', function: { name: 'git_diff', description: '【V8 招1】查看两个 commit 之间的 diff（默认 HEAD~1..HEAD）。可选 path_glob 只看某些文件。', parameters: { type: 'object', properties: { from: { type: 'string', description: 'SHA 或 HEAD~N，缺省 HEAD~1' }, to: { type: 'string', description: 'SHA，缺省 HEAD' }, path_glob: { type: 'string' } } } } },
  { type: 'function', function: { name: 'git_revert_to', description: '【V8 招1】把工作区文件还原到指定 SHA 的快照，并生成一次新 commit（**不**丢失历史）。同一报错连续修 3 次失败时**必须**调它回滚。', parameters: { type: 'object', properties: { sha: { type: 'string', description: '目标 SHA（git_log_recent 给的）' }, note: { type: 'string', description: '回滚原因，写进 commit msg' } }, required: ['sha'] } } },

  // ====================== v0.9.0 (V8) 招3：错误诊断 ======================
  { type: 'function', function: { name: 'diagnose_error', description: '【V8 招3】把工具返回的报错文本（log tail 或 [error] 段）传进来，按内置 15 条 OpenFOAM/C++ 错误模式匹配，返回 {category, causes, next_steps}。**任何工具返回非零 exit / FOAM FATAL / exception 时下一动作必须先调它**。', parameters: { type: 'object', properties: { text: { type: 'string', description: 'log tail 或错误段落（≤ 8000 字符即可）' } }, required: ['text'] } } },

  // ====================== v0.9.0 (V8) 算法植入四步法 ======================
  { type: 'function', function: { name: 'algo_extract_contract', description: '【V8 四步法·步1】从论文 PDF / 已存在的 .H/.C 文件抽出算法契约：inputs / outputs / dimensions / equations / governing_type / 假设条件。**未做此步禁止 write_file 新算法源码**。', parameters: { type: 'object', properties: { source_file: { type: 'string', description: '相对路径，.pdf 或 .H/.C/.py' }, algorithm_name: { type: 'string' } }, required: ['source_file'] } } },
  { type: 'function', function: { name: 'case_probe_facts', description: '【V8 四步法·步2】体检 case，返回**实际**事实：求解器名/相数/湍流模型/可压性/维度/patch 列表/含的字段。**未做此步禁止修改 case 的 BC/物性**。', parameters: { type: 'object', properties: { case_path: { type: 'string' } }, required: ['case_path'] } } },
  { type: 'function', function: { name: 'algo_case_audit', description: '【V8 四步法·步3】比对算法契约（步1 输出）与 case 事实（步2 输出），列出 mismatch（求解器类型不符 / 相数不符 / 字段缺失 / 量纲不一致）。**mismatch 非空时禁止进入第 4 步植入**。', parameters: { type: 'object', properties: { contract: { type: 'object', description: '步1 返回的 JSON' }, case_facts: { type: 'object', description: '步2 返回的 JSON' } }, required: ['contract','case_facts'] } } },
  { type: 'function', function: { name: 'foam_dry_compile', description: '【V8 四步法·步4 辅助】对 OpenFOAM 源码模块跑一次"只编不链"的快速语法检查（wmake，捕获首个编译错误立即返回），避免 wmake libso 跑半天才报错。', parameters: { type: 'object', properties: { module_path: { type: 'string', description: '含 Make/ 目录的源码模块路径' } }, required: ['module_path'] } } },

  // ====================== 自进化：技能库 + 成长型错误记忆 ======================
  { type: 'function', function: { name: 'skill_save', description: '【自进化】把本轮“已被 *_verify / run_stage_done 验证通过”的可复用做法沉淀成一张独立技能卡（写成 skills/<domain>/<slug>.skill.json，可单独导出/分享）。仅在任务跑通且 verifier 盖章后调用；recipe 写 3-10 条精炼可执行步骤，key_params 写关键数值，pitfalls 写本轮踩过的坑，triggers 写下次该被命中的关键词。', parameters: { type: 'object', properties: { title: { type: 'string' }, domain: { type: 'string', enum: ['foam','mfix','lbm','general'] }, triggers: { type: 'array', items: { type: 'string' } }, solver: { type: 'string' }, physics: { type: 'string' }, recipe: { type: 'array', items: { type: 'string' } }, key_params: { type: 'object' }, verify_seq: { type: 'array', items: { type: 'string' } }, pitfalls: { type: 'array', items: { type: 'string' } }, force: { type: 'boolean', description: '无 verifier 记录时强行保存（需你已人工核验）' } }, required: ['title'] } } },
  { type: 'function', function: { name: 'skill_recall', description: '【自进化】按关键词从技能库召回最相关的已验证配方（排序+封顶）。开新任务想先看“以前怎么干成的”就调它。', parameters: { type: 'object', properties: { query: { type: 'string' }, top_k: { type: 'integer', default: 3 } }, required: ['query'] } } },
  { type: 'function', function: { name: 'skill_list', description: '【自进化】列出技能库全部技能（id/领域/标题/触发词/命中数）。', parameters: { type: 'object', properties: { domain: { type: 'string' } } } } },
  { type: 'function', function: { name: 'skill_forget', description: '【自进化】删除一张技能卡（按 id）。', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'skill_export', description: '【自进化】把技能库打包成单个 bundle.json 导出（可分享/迁移/将来当微调语料）。', parameters: { type: 'object', properties: { out_path: { type: 'string' }, ids: { type: 'array', items: { type: 'string' } } } } } },
  { type: 'function', function: { name: 'skill_import', description: '【自进化】从 bundle.json 导入技能与错误模式（内容去重）。', parameters: { type: 'object', properties: { in_path: { type: 'string' } }, required: ['in_path'] } } },
  { type: 'function', function: { name: 'learn_error_pattern', description: '【自进化·成长型错误记忆】排查并修好一个“内置模式没覆盖”的新报错后，把它登记成可复用模式：pattern=能匹配该报错的正则，category=归类，causes=根因数组，steps=修复步骤数组。下次同类报错 diagnose_error 会秒命中。', parameters: { type: 'object', properties: { pattern: { type: 'string' }, flags: { type: 'string' }, category: { type: 'string' }, causes: { type: 'array', items: { type: 'string' } }, steps: { type: 'array', items: { type: 'string' } } }, required: ['pattern','category'] } } },
  { type: 'function', function: { name: 'skill_export_sft', description: '【自进化·第4层】把本轮“已被 verifier 盖章通过”的整条轨迹导出成一条 SFT 语料（jsonl，将来微调本地模型用）。未通过验证会被拒绝。label=可选标注，domain=foam/mfix/lbm/general。', parameters: { type: 'object', properties: { label: { type: 'string' }, domain: { type: 'string' }, out_path: { type: 'string' } } } } },
  { type: 'function', function: { name: 'skill_eval_record', description: '【skill 升级检验·A/B】记录一次“固定案例”的运行结果，用于对比技能注入前后的效果。label 区分臂（如 baseline_无技能 / withskill_有技能）；folder=本次跑的案例文件夹；task=任务描述（两臂必须一致才可比）。verifier 通过情况与错误迭代次数自动从本轮轨迹抽取。', parameters: { type: 'object', properties: { label: { type: 'string' }, folder: { type: 'string' }, task: { type: 'string' }, note: { type: 'string' } }, required: ['label'] } } },
  { type: 'function', function: { name: 'skill_eval_compare', description: '【skill 升级检验·A/B】对比同一 task 的两臂记录（baseline vs withskill），报告技能是否真的有帮助：verifier 通过率、错误迭代次数、用了哪些技能。task 不传则对比最近两条记录。', parameters: { type: 'object', properties: { task: { type: 'string' }, label_a: { type: 'string' }, label_b: { type: 'string' } } } } },
  { type: 'function', function: { name: 'solver_wait', description: '【长进程·事件等待】阻塞等待后台求解作业（foam/mfix/lbm_run_*_async 或 run_command 登记的 runId）结束，或日志出现 until_regex，或超时。只占 1 个 agent 步，取代反复调 foam_solver_status 轮询（每次轮询都烧一步+上下文）。mode=any 任一结束即返回；mode=all 全部结束或任一失败才返回（其它作业结束不会打断）。End 之后收尾卡住会自动判结束。返回每个作业的 exit/用时/最后 Time/日志尾。', parameters: { type: 'object', properties: {
      run_ids: { type: 'array', items: { type: 'string' } },
      allow_short: { type: 'boolean', description: '允许 ≤300 s 的短等待（默认会自动延长）' },
      mode: { type: 'string', enum: ['any','all'] },
      timeout_s: { type: 'number', description: '最长等待秒数，默认 3600，上限 43200' },
      until_regex: { type: 'string', description: '可选：日志新行匹配即提前返回（如 "^Time = 60\\b" 或 "FOAM FATAL"）' },
      tail_lines: { type: 'number', description: '每个作业返回的日志尾行数，默认 15' }
    }, required: ['run_ids'] } } },
  { type: 'function', function: { name: 'foam_postproc_list', description: '【FOAM 后处理】列出 case/postProcessing 下所有 functionObject、各自的起始时间目录与 .dat 文件。出口组分/固含率/力等标量 KPI 前先用它看有哪些数据。', parameters: { type: 'object', properties: { case_path: { type: 'string' } }, required: ['case_path'] } } },
  { type: 'function', function: { name: 'foam_postproc_stats', description: '【FOAM 后处理·时均统计】解析 postProcessing/<function_object>/*/<file>（自动拼接重启段），在时间窗内求每列 mean/std/批均值标准误 sem/半窗漂移 rel_drift/stationary。流化床等强波动体系务必用时均值+stationary 判据当 KPI，不要取最后一个瞬时值。矢量列展开为 _x/_y/_z。', parameters: { type: 'object', properties: {
      case_path: { type: 'string' },
      function_object: { type: 'string', description: 'postProcessing 下的子目录名' },
      file: { type: 'string', description: '目录内有多个 .dat 时必填，如 surfaceFieldValue.dat' },
      columns: { type: 'array', items: { type: 'string' }, description: '只统计这些列；缺省=全部' },
      t_start: { type: 'number', description: '时均起点（含）' },
      t_end: { type: 'number' },
      last_fraction: { type: 'number', description: '未给 t_start 时取末尾这一比例的时长，如 0.4' },
      drift_tol: { type: 'number', description: '平稳判据：半窗均值相对漂移阈值，默认 0.05' },
      write_json: { type: 'string', description: '可选：把完整统计写到这个 JSON 文件（相对算例目录），后处理/交付直接引用，免写脚本' },
      json: { type: 'boolean', description: '返回里附完整 JSON（列多时默认省略）' }
    }, required: ['case_path','function_object'] } } },
  { type: 'function', function: { name: 'vertical_distill', description: '【持续进化·垂直领域 playbook】一个垂直问题（如 MTO 流化床、某类反应器）的整套流程已验证通过后调用：把算例模板（字典/0.orig/生成脚本/自定义库源码）+ 各阶段配方 + 踩过的坑 + 基准 KPI + 本次效率指标版本化存入 playbook。下次同类任务自动注入并可 vertical_instantiate 一键实例化。同 id 再次调用=升级版本。', parameters: { type: 'object', properties: {
      id: { type: 'string', description: '稳定英文 id，如 mto-dmto-fluidized-bed' },
      title: { type: 'string' },
      triggers: { type: 'array', items: { type: 'string' }, description: '触发词（至少 4 个，含中英文：如 MTO/甲醇制烯烃/DMTO/流化床/fluidized/EMMS）' },
      case_path: { type: 'string', description: '已验证算例目录（结果时间步/processor*/日志自动跳过）' },
      extra_paths: { type: 'array', items: { type: 'string' }, description: '附带目录：自定义模型源码(src/EMMSbubbling)、CSTR 脚本、后处理脚本等' },
      kpis: { type: 'object', description: '本次计算得到的 KPI' },
      benchmarks: { type: 'object', description: '验收基准（论文/实验值）' },
      pitfalls: { type: 'array', items: { type: 'string' } },
      notes: { type: 'string', description: '适用范围、哪些参数换工况要改' }
    }, required: ['id','case_path','triggers'] } } },
  { type: 'function', function: { name: 'vertical_instantiate', description: '【持续进化】把已验证的 playbook 模板算例拷到新目录（附带目录拷到其同级），返回各阶段配方。之后只改与本任务不同的工况参数，重建网格→验证→求解。', parameters: { type: 'object', properties: { id: { type: 'string' }, dest: { type: 'string' }, version: { type: 'number' } }, required: ['id','dest'] } } },
  { type: 'function', function: { name: 'kpi_credibility', description: '【复现 KPI 可信度】报告/收尾前必用：给出反应开启时刻、统计时间窗、气相停留时间 τ、各 KPI 本次值/原文值/初值，判断统计窗是否已过 n·τ 准稳态、窗长是否 ≥τ、哪些 KPI 只是初值主导（不能作证据）。论文复现任务未通过本检查不得 task_complete。', parameters: { type: 'object', properties: { t_react_start: { type: 'number' }, t_window: { type: 'array', items: { type: 'number' }, description: '[t0, t1] 统计窗 (s)' }, tau: { type: 'number', description: '气相停留时间 V/Qg (s)' }, n_tau: { type: 'number', description: '默认 2' }, outlet_min_flux: { type: 'number', description: '出口各产物组分通量最小值 kg/s（可选）' }, kpis: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, this: { type: 'number' }, paper: { type: 'number' }, init: { type: 'number' } }, required: ['name', 'this'] } } }, required: ['t_window', 'tau', 'kpis'] } } },
  { type: 'function', function: { name: 'foam_locate', description: '【FOAM 发散定位】求解发散/时间步崩塌后第一步必用：对最近 n 个写出时刻跑 fieldMinMax（并行算例自动 mpirun），返回各场极值单元坐标、极值随时间的增长倍数、是否钉在同一单元、离得最近的 3 个 patch。用它确定发散源（哪个入口/出口/内构件）再对症修，不要凭猜测改时间步或网格。', parameters: { type: 'object', properties: { case_path: { type: 'string' }, n_times: { type: 'number', description: '取最近几个写出时刻，默认 3' } }, required: ['case_path'] } } },
  { type: 'function', function: { name: 'vertical_list', description: '【持续进化】列出已有垂直领域 playbook 及其历次效率（LLM 步数/报错/耗时）。', parameters: { type: 'object', properties: {} } } }
];

// 工具分组（用于 UI 开关；编辑类始终开启）
const TOOL_GROUPS = {
  edit: ['list_dir','read_file','write_file','edit_file','multi_edit','glob','grep_search','update_todos','task_complete','git_log_recent','git_diff','git_revert_to','diagnose_error','algo_extract_contract','case_probe_facts','algo_case_audit','skill_save','skill_recall','skill_list','skill_forget','skill_export','skill_import','learn_error_pattern','skill_export_sft','skill_eval_record','skill_eval_compare','run_stage_start','run_stage_done','run_status_load','vertical_distill','vertical_instantiate','vertical_list','foam_locate','kpi_credibility'],  // 常亮（V8: git/诊断/四步法；V10: 自进化技能库）
  shell: ['run_command'],
  web: ['web_search','fetch_url','download_file','image_search','paper_search','paper_fetch'],
  doc: ['read_document','read_paper','paper_extract','vision_analyze','request_user_digitize'],
  sim: ['sim_render','sim_open_paraview','sim_run_openfoam','vision_analyze'],
  foam: ['foam_find_tutorial','foam_find_source','foam_clone_tutorial','foam_inspect_case','foam_run_solver_async','foam_solver_status','foam_solver_stop','foam_stl_inspect','foam_mesh_plan','foam_compute_first_layer','foam_mesh_box_stl','foam_stl_generate','foam_env_check','foam_residual_series','foam_compare_render','foam_mesh_verify','foam_mesh_stl_check','foam_stl_render','foam_patch_diff','foam_geom_verify','foam_solve_verify','foam_post_verify','paper_param_verify','vision_analyze','sim_render','read_document','paper_extract','foam_dry_compile','foam_postproc_list','foam_postproc_stats','solver_wait'],
  mfix: ['mfix_find_tutorial','mfix_clone_tutorial','mfix_inspect_case','mfix_run_solver_async','mfix_solver_status','mfix_solver_stop','solver_wait','sim_render','sim_open_paraview','vision_analyze','foam_post_verify','foam_solve_verify','read_document'],
  lbm:  ['lbm_find_tutorial','lbm_clone_tutorial','lbm_inspect_case','lbm_run_async','lbm_solver_status','lbm_solver_stop','solver_wait','sim_render','vision_analyze','foam_post_verify','foam_solve_verify','read_document'],
  opt:  ['opt_study_create','opt_suggest_next','opt_run_trial','opt_apply_params','opt_extract_kpi','opt_record_result','opt_status','opt_render','read_document','foam_clone_tutorial','foam_inspect_case','foam_run_solver_async','foam_solver_status','foam_mesh_verify','vision_analyze','foam_post_verify','foam_postproc_list','foam_postproc_stats','solver_wait']
};
const DEFAULT_ENABLED = new Set([...TOOL_GROUPS.edit, ...TOOL_GROUPS.shell, ...TOOL_GROUPS.web, ...TOOL_GROUPS.doc]);
function filterTools(enabled) { return TOOLS.filter(t => enabled.has(t.function.name)); }
// 规划模式（对齐 OpenCode Plan agent）：只读调研+出方案，屏蔽一切写文件/跑命令/启动求解/改参数的工具
const PLAN_BLOCKED = new Set(['write_file','edit_file','multi_edit','git_revert_to','run_command','sim_run_openfoam','sim_open_paraview',
  'foam_clone_tutorial','foam_run_solver_async','foam_solver_stop','foam_mesh_plan','foam_mesh_box_stl','foam_stl_generate','foam_dry_compile',
  'mfix_clone_tutorial','mfix_run_solver_async','mfix_solver_stop','lbm_clone_tutorial','lbm_run_async','lbm_solver_stop',
  'opt_study_create','opt_run_trial','opt_apply_params','opt_record_result','download_file','skill_forget','skill_import','vertical_instantiate']);
function toolsForMode(enabled, mode, session) {
  let list = filterTools(enabled);
  const always = typeof ALWAYS_TOOLS !== 'undefined' ? ALWAYS_TOOLS : [];
  // 后处理出图、技能包查阅：任何会话都可用（不需要在工具开关里勾）
  for (const n of always) if (!enabled.has(n)) { const t = TOOLS.find(x => x.function.name === n); if (t) list.push(t); }
  if (session) list = leanTools(list, session);
  if (process.env.LEAN_TOOLS !== '0') list = list.filter(t => !LEAN_DROP.has(t.function.name)).map(slimTool);
  if (typeof packBlocksTool === 'function') list = list.filter(t => !packBlocksTool(t.function.name));
  if (mode === 'plan') return list.filter(t => !PLAN_BLOCKED.has(t.function.name));
  return typeof mcpToolDefs === 'function' ? list.concat(mcpToolDefs()) : list;
}
const ALWAYS_TOOLS = ['post_view', 'skill_pack_read'];
// 技能包关掉时，对应求解器的专用工具也不发给模型（OpenFOAM 包管 foam_*，LBM 包管 lbm_*，MFIX 包管 mfix_*）
function packBlocksTool(name) {
  if (typeof Cap === 'undefined') return false;
  const st = SETTINGS.packs || {};
  for (const [id, meta] of Object.entries(Cap.PACK_META)) {
    const on = st[id] ?? meta.defaultOn;
    if (!on && meta.tools && meta.tools.test(name) && !ALWAYS_TOOLS.includes(name)) return true;
  }
  return false;
}
// ---- MCP：设置里配置的外部服务，工具名 mcp__服务__工具 ----
const MCP = new Map();   // name -> Cap.McpServer
function mcpToolDefs() {
  const out = [];
  for (const [srv, m] of MCP) if (m.status === 'ready') for (const t of m.tools) {
    out.push({ type: 'function', function: { name: Cap.mcpToolName(srv, t.name), description: `【MCP · ${srv}】${(t.description || '').slice(0, 900)}`, parameters: t.inputSchema && t.inputSchema.type === 'object' ? t.inputSchema : { type: 'object', properties: {} } } });
  }
  return out;
}
async function mcpCall(toolName, args) {
  for (const [srv, m] of MCP) for (const t of m.tools) if (Cap.mcpToolName(srv, t.name) === toolName) {
    if (m.status !== 'ready') throw new Error(`MCP 服务 ${srv} 未就绪：${m.error || m.status}`);
    return await m.call(t.name, args);
  }
  throw new Error('没有这个 MCP 工具：' + toolName);
}
async function startMcpServers() {
  for (const m of MCP.values()) m.stop();
  MCP.clear();
  for (const cfg of (SETTINGS.mcpServers || [])) {
    if (!cfg || !cfg.name) continue;
    const m = new Cap.McpServer(cfg); MCP.set(cfg.name, m);
    if (cfg.enabled === false) continue;
    m.start().then(ts => console.log(`[mcp] ${cfg.name} 就绪，${ts.length} 个工具`)).catch(e => { m.status = 'error'; m.error = e.message; console.warn(`[mcp] ${cfg.name} 启动失败：${e.message}`); });
  }
}
const SKILL_PACK_DIR = typeof path !== 'undefined' ? path.join(__dirname, 'agent-skills') : '';
let _packIndex = { at: 0, text: '' };
async function refreshPackIndex() {
  const packs = (await Cap.listPacks(SKILL_PACK_DIR, SETTINGS.packs || {})).filter(p => p.enabled);
  _packIndex = { at: Date.now(), text: packs.length ? '\n\n# 📦 已启用的官方技能包（需要细节时用 skill_pack_read(pack, file) 读，不要凭记忆写字典）\n'
    + packs.map(p => `- ${p.id}（${p.title}）：${p.description.slice(0, 160)}${p.files.length ? `\n  参考：${p.files.slice(0, 8).join('、')}` : ''}`).join('\n') + '\n' : '' };
}
// 按需工具集（学 OpenCode：每步只带当前任务用得上的工具）。专题工具组只在任务文本命中或本会话已用过时才发给模型；
// 每次调用的固定开销从 ~96 个工具降到 ~60 个。LEAN_TOOLS=0 关闭。
// "论文复现 / 算法植入"类任务才需要论文工具与反漂移长提示；只是"和文献基准值对比"（Hysing 2009 气泡、
// 圆柱绕流 St 数等）的任务，工况已在任务里写全，不需要读论文、锁参数、四步法。
// 判定：出现复现/植入/方程/曳力等词，或给了 pdf；单独的"文献/基准/benchmark"不算。
const _WANT_PAPER_TOOLS_RE = /论文|\bpaper\b|复现|reproduc|植入|implement(?:ing)? (?:the )?(?:model|equation)|方程|algorithm|算法|closure|曳力|drag model|drag\b|源项|source term|fvoption|coded|\.pdf\b|读论文|论文原文|按原文|重现|重新做|这篇(?:文献|文章)|(?:照着?|按照?|依照|根据)[^\n，。]{0,10}(?:文献|文章)/i;
function wantPaperTask(t) { return _WANT_PAPER_TOOLS_RE.test(String(t || '')); }
const LEAN_TOOL_TOPICS = [
  [/优化|寻优|反演|optimi[sz]|bayes|贝叶斯|参数扫描|sweep|study|trial|DOE|代理模型|surrogate/i,
    ['opt_study_create','opt_suggest_next','opt_run_trial','opt_apply_params','opt_extract_kpi','opt_record_result','opt_status','opt_render']],
  [/技能|skill|沉淀|sft|评测|eval/i, ['skill_export','skill_import','skill_forget','skill_export_sft','skill_eval_record','skill_eval_compare']],
  [/playbook|模板算例|vertical|沉淀|复用/i, ['vertical_distill','vertical_instantiate','vertical_list']],
  [_WANT_PAPER_TOOLS_RE,
    ['algo_extract_contract','case_probe_facts','algo_case_audit','paper_param_verify','foam_dry_compile','foam_find_source','read_paper','paper_extract','paper_figures','image_crop','paper_fetch','paper_search']],
  [/\bstl\b|snappy|几何文件|geometry|cad/i, ['foam_stl_inspect','foam_stl_generate','foam_mesh_box_stl','foam_mesh_stl_check','foam_stl_render','foam_compute_first_layer','foam_geom_verify','foam_mesh_plan','foam_patch_diff']],
  [/论文|复现|reproduce|KPI|收率|选择性|转化率|yield|selectivity|conversion|可信/i, ['kpi_credibility']],
  [/(对比|比较|compare)[^\n]{0,8}(图|渲染|云图|render)|并排/i, ['foam_compare_render']],
  [/渲染|云图|截图|可视化|出图|画图|render|contour|图片|图像|看图|vlm|vision|\.png|\.jpe?g/i, ['vision_analyze','sim_render','foam_solve_verify','foam_post_verify']],
  [/技能|skill|经验|沉淀|教训|lesson|记住/i, ['skill_save','skill_recall','skill_list','learn_error_pattern']],
  [/阶段|stage|流水线|pipeline|断点|重启|恢复|resume/i, ['run_stage_start','run_stage_done']],
  [/paraview|交互查看/i, ['sim_open_paraview']],
  [/图|image|digiti|扣点|曲线/i, ['image_search','request_user_digitize']],
  [/下载|download|网页|url|http/i, ['download_file']],
  [/回滚|revert|git|diff|改动/i, ['git_revert_to','git_diff','git_log_recent']],
  [/搜索|检索|search|\bweb\b|网上|上网|查资料|查文献|找文献|论文|\bpaper\b|https?:/i, ['web_search','fetch_url']],
  [/\.pdf\b|\.docx?\b|文档|document|论文|\bpaper\b/i, ['read_document']],
];
// 只读的"同步求解"老工具：长算例一律走 foam_run_solver_async，避免模型误选
const LEAN_DROP = new Set(['sim_run_openfoam', 'sim_open_paraview']);   // ParaView GUI 已删除；OpenFOAM 出图用 post_view，sim_render 只留给 LBM/MFIX 的 vtk 输出
// 去掉版本标签前缀（【V8 招3】【FOAM-Beta v6 …】），每次调用省约 800 字符；缓存，按工具对象复用
const _slimCache = new WeakMap();
function slimTool(t) {
  let s = _slimCache.get(t);
  if (!s) {
    const d = String(t.function.description || '').replace(/^\s*【[^】]{0,40}】\s*/, '');
    s = d === t.function.description ? t : { ...t, function: { ...t.function, description: d } };
    _slimCache.set(t, s);
  }
  return s;
}
const LEAN_GATED = new Set(LEAN_TOOL_TOPICS.flatMap(([, ts]) => ts));
function leanTools(list, session) {
  if (process.env.LEAN_TOOLS === '0') return list;
  const msgs = session.messages || [];
  const userText = msgs.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map(c => c.text || '').join(' ') : '')).join('\n')
    + '\n' + (session._pendingUserText || '') + '\n' + ((session.task && session.task.taskText) || '');
  const used = new Set();
  for (const m of msgs) for (const tc of (m.tool_calls || [])) if (tc && tc.function) used.add(tc.function.name);
  const keep = new Set();
  for (const [re, ts] of LEAN_TOOL_TOPICS) if (re.test(userText)) ts.forEach(t => keep.add(t));
  return list.filter(t => { const n = t.function.name; return !LEAN_GATED.has(n) || keep.has(n) || used.has(n); });
}

const NEEDS_APPROVAL = new Set(['run_command', 'sim_run_openfoam', 'foam_run_solver_async', 'foam_mesh_plan', 'foam_mesh_box_stl', 'foam_stl_generate', 'mfix_run_solver_async', 'lbm_run_async', 'opt_study_create', 'opt_run_trial', 'opt_apply_params']);
const MODIFYING = new Set(['write_file', 'edit_file', 'multi_edit']);  // v0.9.0: multi_edit 也算修改类

// ====================== v0.9.0 (V8) 招1 + 招3 + 四步法 辅助层 ======================
//
// 招1：所有 write_file / edit_file / multi_edit **自动**前后 commit；新增 git_log_recent / git_diff / git_revert_to。
// 招3：内置 16 条 OpenFOAM/C++ 报错模式表；diagnose_error(text) 匹配后给 category/causes/next_steps。
// 四步法：算法植入分 4 步走（extract_contract / probe_facts / audit / 受控植入）。
//
const V9_GIT = { stepCounter: 0, repoInitDone: false };

function _spawnP(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => err += d.toString());
    p.on('close', code => resolve({ code, out, err }));
    p.on('error', e => resolve({ code: -1, out, err: String(e.message || e) }));
  });
}

async function ensureGitRepo() {
  if (V9_GIT.repoInitDone) return { ok: true, init: false };
  try {
    await fs.stat(path.join(WORKSPACE, '.git'));
    V9_GIT.repoInitDone = true;
    return { ok: true, init: false };
  } catch {}
  // 初始化 + 写最小 .gitignore + 首次 baseline commit
  await _spawnP('git', ['init', '-q'], { cwd: WORKSPACE });
  await _spawnP('git', ['config', 'user.email', 'cfdriver@local'], { cwd: WORKSPACE });
  await _spawnP('git', ['config', 'user.name', 'CFDriver'], { cwd: WORKSPACE });
  try {
    const gi = path.join(WORKSPACE, '.gitignore');
    let cur = ''; try { cur = await fs.readFile(gi, 'utf8'); } catch {}
    if (!/# cfdriver auto-generated/.test(cur)) {
      cur += '\n# cfdriver auto-generated (V8)\nprocessor*/\n*.foam\npostProcessing/\nVTK/\n*.vtk\n*.vtu\n*.pvd\n*.log\n.nullflux/tool-output/\n';
      await fs.writeFile(gi, cur, 'utf8');
    }
  } catch {}
  await _spawnP('git', ['add', '-A'], { cwd: WORKSPACE });
  await _spawnP('git', ['commit', '-q', '-m', '[cfdriver init] baseline', '--allow-empty'], { cwd: WORKSPACE });
  V9_GIT.repoInitDone = true;
  return { ok: true, init: true };
}

async function gitAutoCommit(message) {
  try {
    await ensureGitRepo();
    await _spawnP('git', ['add', '-A'], { cwd: WORKSPACE });
    const c = await _spawnP('git', ['commit', '-q', '-m', message, '--allow-empty'], { cwd: WORKSPACE });
    const sh = await _spawnP('git', ['rev-parse', '--short', 'HEAD'], { cwd: WORKSPACE });
    return { ok: c.code === 0, sha: (sh.out || '').trim(), msg: message };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function gitStep() { return ++V9_GIT.stepCounter; }

// 错误模式表（V8 招3）—— 每条 {re, category, causes, steps}
const ERROR_PATTERNS = [
  { re: /floating point exception|FOAM FATAL ERROR.*FPE|signal\s+FPE/i,
    category: 'NaN/Inf 数值发散 (FPE)',
    causes: ['CFL 过大 → dt 减小或 deltaT 自适应', 'BC 不一致致初始时刻除零', '0/ 未做 setFields，alpha/T 仍是默认 → 整场 0 或 1', '物性常数为 0（如 mu=0、sigma=0）'],
    steps: ['foam_solver_status(run_id) 看哪一步首次出现 nan/Inf', 'foam_residual_series 看哪个场先发散', 'case_probe_facts 确认物性 + 求解器假设', 'foam_inspect_case 看 0/ 各场 dimensions 与 internalField'] },
  { re: /Cannot find file.*system\/(controlDict|fvSchemes|fvSolution|blockMeshDict)/i,
    category: 'system/ dict 缺失',
    causes: ['case 没准备完整（缺 controlDict/fvSchemes/fvSolution）', 'cwd 不在 case 目录'],
    steps: ['list_dir <case>/system 验证', '看是不是 cd 错地方了'] },
  { re: /keyword (\w+) is undefined in dictionary/i,
    category: 'dict keyword 缺失/拼错',
    causes: ['模板与求解器版本不匹配', 'fvSchemes/fvSolution 缺必填项', 'OpenFOAM 新版 keyword 改名'],
    steps: ['foam_find_tutorial 找同求解器同版本模板对照', 'foam_inspect_case 看真实可用 keyword 列表'] },
  { re: /unknown patch type|Unknown patchField type|unknown boundary condition/i,
    category: 'BC / patch 类型未注册',
    causes: ['BC 名拼错（如 nutkWallFunction 写成 nutWallFunction）', '需要的 lib 未在 controlDict.libs 链入', '求解器不支持该 BC'],
    steps: ['foam_find_source bc <name> 查正确写法', 'controlDict 末尾加 libs ("...")', 'case_probe_facts 看求解器实际兼容的 BC'] },
  { re: /dimensions of .* are not (correct|consistent|dimensionally)/i,
    category: '量纲不一致',
    causes: ['0/ 场 dimensions 错（k 应为 [0 2 -2 0 0 0 0]）', 'BC value 给的数字单位错', '0/ 与 0.orig/ 不同步'],
    steps: ['read_file 看出错场 dimensions 行', 'algo_extract_contract 看论文标的单位', '从 0.orig 重新 cp -r 0'] },
  { re: /Maximum number of iterations exceeded.*GAMG|smoothSolver.*did not converge|PCG.*did not converge/i,
    category: '线性求解器不收敛',
    causes: ['网格质量差 maxNonOrtho > 70', 'tolerance/relTol 过严', 'smoother 选错'],
    steps: ['checkMesh log tail 看 maxNonOrtho/skewness', '调 fvSolution: tolerance 放宽 / smoother→GaussSeidel / preconditioner→DIC'] },
  { re: /Inconsistent\s+addressing|negative volume|negative determinant|skewness exceeds/i,
    category: '网格坏点',
    causes: ['snappyHexMesh 抠空了某区域', '极薄 sliver cell', 'STL 法向反了'],
    steps: ['foam_mesh_verify(case_path, stage="final")', 'foam_mesh_stl_check(case_path, ref_stl, patches)', '提高 minVol / 减小 first_layer_thickness'] },
  { re: /Cannot find cellSet|Cannot find cellZone/i,
    category: 'setFields region 选择器失效',
    causes: ['boxToCell bbox 超出网格域', 'cellSet/cellZone 名拼错', '没先 setSet/topoSet'],
    steps: ['edit_file system/setFieldsDict 缩小 bbox 到网格范围', 'run_command("foamDictionary system/setFieldsDict") 验证'] },
  { re: /Maximum number of nonlinear iterations|continuity error[^\n]*(?:nan|inf)/i,
    category: '连续性 / p-U 耦合失衡',
    causes: ['PIMPLE nOuterCorrectors 不够', 'inlet/outlet 不通量守恒', 'atmosphere BC 类型错'],
    steps: ['加 nOuterCorrectors 到 3-5', 'case_probe_facts 看 patch 是否成对（一进一出）'] },
  { re: /undefined reference to|error: .*was not declared|fatal error: .*\.H: No such file/i,
    category: 'C++ 编译错',
    causes: ['头文件路径未在 Make/options 的 EXE_INC', '库未在 Make/options 的 LIB_LIBS', '类继承的虚函数没实现'],
    steps: ['foam_dry_compile <module> 抓首错', 'read_file Make/options 看 -I 和 -l', 'foam_find_source 看参考实现'] },
  { re: /signal\s+(11|SIGSEGV)|segmentation fault/i,
    category: 'SegFault',
    causes: ['内存越界（容器索引超界）', '并行 decompose 不一致', 'fvSchemes 含未注册 scheme 名'],
    steps: ['串行重跑（去掉 mpirun）复现', '看 fvSchemes 每行 scheme 名是否合法'] },
  { re: /not in patches|patches do not match|patches don't match/i,
    category: 'patch 名不匹配',
    causes: ['0/ 里 patch 名 ≠ polyMesh/boundary 里 patch 名', 'blockMesh 重生成后 0/ 未同步'],
    steps: ['foam_inspect_case 列实际 patch', '改 0/ 各场 boundaryField 对齐'] },
  // 每步都会打印 continuity 行；只有 sum local ≥ 1e-2 量级才算漂移
  { re: /Time step continuity errors[^\n]*sum local = ([^\s,]+)/gi, when: ms => ms.some(m => { const v = Number(m[1]); return !Number.isFinite(v) || v >= 1e-2; }),
    category: '质量守恒漂移',
    causes: ['inlet/outlet 通量不平衡', 'p BC 类型用错（应 zeroGradient 用了 fixedValue 等）'],
    steps: ['case_probe_facts 看入出口对应关系', 'foam_inspect_case 看 0/p 的 boundaryField'] },
  { re: /No such file or directory/i,
    category: '文件不存在',
    causes: ['路径写错', '上一步没生成（如 blockMesh 没跑就找 polyMesh）'],
    steps: ['list_dir 验证父目录', '看上一步 exit code'] },
  { re: /Floating point exception.*nan|Foam::error::printStack|FOAM aborting/i,
    category: 'OpenFOAM 主动 abort',
    causes: ['场含 nan 后求解器主动停', 'patch 配对错误'],
    steps: ['看 abort 前 50 行 log', 'diagnose_error 重新匹配上一段错误'] },
  { re: /deltaT\s*=\s*(?:\d(?:\.\d+)?e-(?:0?[89]|1\d))\b/i,
    category: '时间步崩塌（deltaT 被自适应压到 ≤1e-8）',
    causes: ['局部速度/体积分数爆值导致 Courant 数失控', '入口或分布器附近网格过细', 'maxCo/maxAlphaCo 过严'],
    steps: ['foam_locate(case_path) 找极值所在单元与最近 patch', '对症修（BC/网格/物性），不要只调小 maxCo'] },
  { re: /number of processor directories = \d+ is not equal to the number of processors|Number of processor directories.*not equal|MPI_Init.*fail|There are not enough slots available/i,
    category: '并行分解 / MPI 配置不一致',
    causes: ['decomposeParDict.numberOfSubdomains 与 mpirun -np 不一致', '重新分网格后没重跑 decomposePar', '申请核数超过可用槽位'],
    steps: ['foamDictionary system/decomposeParDict -entry numberOfSubdomains', '确认 processor* 目录数并重跑 decomposePar -force', '降低 -np 或加 --oversubscribe 前先查核占用'] },
];

// End 出现在最后一个 "Time =" 之后：计算已完成，之后的 abort/MPI 噪声不是错误
function _textEndedCleanly(s) {
  const lines = String(s || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].replace(/^\[\d+\]\s*/, '').trim();
    if (l === 'End') return true;
    if (/^Time\s*=/.test(l)) return false;
  }
  return false;
}

function diagnoseErrorText(text) {
  const s = String(text || '');
  if (!s.trim()) return { matched: false, hint: 'text 为空' };
  if (_textEndedCleanly(s) && !/FOAM FATAL (IO )?ERROR/.test(s.slice(s.lastIndexOf('\nEnd')))) {
    return { matched: true, count: 1, hits: [{ category: '非错误：求解已正常结束', matched_snippet: 'End（位于最后一个 Time = 之后）',
      causes: ['求解器打印 End 后在析构/MPI 收尾时 abort（如 v2306 twoPhaseEulerFoam exit 134），计算结果完整'],
      next_steps: ['不要重算；直接进入后处理', '如需确认：检查最后时间目录的场文件齐全'] }] };
  }
  const hits = [];
  // 成长型错误记忆：内置模式 + 学到的模式（learn_error_pattern 追加）合并匹配
  const allPatterns = ERROR_PATTERNS.concat(SkillLib.learnedErrorPatterns());
  for (const p of allPatterns) {
    let m;
    if (p.when) { const ms = [...s.matchAll(p.re)]; m = p.when(ms) ? ms.find(x => { const v = Number(x[1]); return !Number.isFinite(v) || v >= 1e-2; }) : null; }
    else m = s.match(p.re);
    if (m) hits.push({ category: p.category + (p.learned ? '（已学习）' : ''), matched_snippet: m[0].slice(0, 120), causes: p.causes, next_steps: p.steps });
  }
  if (!hits.length) {
    return { matched: false, hint: `未匹配已知模式（内置 ${ERROR_PATTERNS.length} + 已学习 ${SkillLib.learnedErrorPatterns().length} 条）。\n建议：① 把 log tail 200 行回贴让模型逐行读；② 排查并修好后调 learn_error_pattern 把这个新错登记成可复用模式（下次秒命中）；③ run_stage_done({passed:false,memo:...}) 转人工。` };
  }
  return { matched: true, count: hits.length, hits };
}

// HC-4 错误预算的判定（纯函数，便于测试）。只有「一次求解/网格运行失败」才算一次；
// 读日志、读文档时碰到 FOAM FATAL / sigFpe 字样的只读命令不算；同一次失败被反复查询只算一次。
const _SOLVER_EXE = /^(mpirun|mpiexec|foamRun|foamMultiRun|foamJob|[A-Za-z0-9]+Foam|blockMesh|snappyHexMesh|decomposePar|reconstructPar|reconstructParMesh|setFields|checkMesh|topoSet|createBaffles|createPatch|mapFields|mapFieldsPar|extrudeMesh|surfaceFeatureExtract|mfixsolver|mfix|lmp_\w+|liggghts\w*)$/;
function isSolverLaunchCommand(cmd) {
  for (const seg of String(cmd || '').split(/&&|\|\||[;|\n]/)) {
    const toks = seg.trim().replace(/^['"(]+/, '').split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < toks.length && (/^(nohup|time|exec|stdbuf|nice|setsid)$/.test(toks[i]) || /^\w+=/.test(toks[i]) || /^-/.test(toks[i]) || (toks[i - 1] === 'timeout' && /^\d/.test(toks[i])) || toks[i] === 'timeout')) i++;
    const exe = (toks[i] || '').split('/').pop().replace(/['")]+$/, '');
    if (_SOLVER_EXE.test(exe)) return true;
    if (/^All(run|mesh)\w*$/.test(exe)) return true;
    if (/^(bash|sh)$/.test(exe) && /^(?!-)\S*(\.sh|All(run|mesh)\w*)$/.test(toks[i + 1] || '')) return true;
  }
  return false;
}
function classifySolverError(name, args, result) {
  const txt = String(result || '');
  if (name === 'run_command' && !isSolverLaunchCommand(args && args.command)) return null;
  const m = /FOAM FATAL (IO )?ERROR|Floating point exception|sigFpe|Segmentation fault|FOAM aborting|已结束\(exit=[1-9]/.exec(txt);
  if (!m) return null;
  let cat = '';
  try { const d = diagnoseErrorText(txt.slice(-8000)); if (d.matched && d.hits && d.hits.length) cat = d.hits[0].category; } catch (e) { cat = String(); }
  if (/^非错误/.test(cat)) return null;
  if (!cat) {
    // 未归类的错误按报错内容区分，免得三个互不相干的新错误被算成「同一类 3 次」
    const sig = txt.slice(m.index).split(/\r?\n/).map(x => x.trim()).filter(x => x && !/^-->|^\(openfoam|^\[\d+\]\s*$/.test(x)).slice(0, 2).join(' ')
      .replace(/\/[\w./-]+/g, '<path>').replace(/\d+(\.\d+)?(e[-+]?\d+)?/gi, '#').slice(0, 90);
    cat = 'unknown: ' + (sig || m[0]);
  }
  const rid = (args && (args.run_id || (Array.isArray(args.run_ids) && args.run_ids.join(',')))) || (/runId[:：]?\s*([0-9a-f]{8})/.exec(txt) || [])[1] || '';
  const statusTool = /status$|^solver_wait$/.test(name);
  return { cat, once: statusTool && rid ? cat + '|' + rid : null };
}

// 算法契约抽取（V8 四步法·步1）
async function algoExtractContract({ source_file, algorithm_name }) {
  const f = safePath(source_file);
  const ext = path.extname(source_file).toLowerCase();
  let raw = '';
  try { raw = await fs.readFile(f, 'utf8'); } catch (e) { throw new Error(`读取失败: ${e.message}`); }
  const contract = {
    algorithm: algorithm_name || path.basename(source_file, ext),
    source_file: source_file,
    source_kind: ext,
    inputs: [],
    outputs: [],
    equations: [],
    governing_type: null,
    assumes: { compressible: null, phases: null, turbulence: null, dimensions: null },
    raw_notes: []
  };
  // ---- .H / .C：抽 OpenFOAM 风格的类继承 + 关键虚函数签名 ----
  if (ext === '.h' || ext === '.c' || ext === '.cpp' || ext === '.cxx') {
    const inherit = raw.match(/class\s+(\w+)\s*:\s*public\s+([\w:]+)/);
    if (inherit) {
      contract.raw_notes.push(`class ${inherit[1]} : public ${inherit[2]}`);
      const base = inherit[2].toLowerCase();
      if (/dragmodel/.test(base)) { contract.governing_type = 'two-phase drag (Euler-Euler)'; contract.assumes.phases = 2; }
      else if (/turbulencemodel|rasmodel|lesmodel/.test(base)) { contract.governing_type = 'turbulence closure'; }
      else if (/phasemodel/.test(base)) { contract.governing_type = 'phase model'; contract.assumes.phases = 2; }
      else if (/fvpatchfield/.test(base)) { contract.governing_type = 'boundary condition'; }
      else if (/fvoption/.test(base)) { contract.governing_type = 'fvOption / source term'; }
    }
    // virtual function signatures: 返回类型 函数名(参数) const?
    const fnRe = /(?:virtual\s+)?(\w+(?:::\w+)*)\s+(\w+)\s*\(([^)]*)\)\s*(?:const)?\s*[{;]/g;
    let mm; let cnt = 0;
    while ((mm = fnRe.exec(raw)) !== null && cnt < 12) {
      const [, ret, name, params] = mm;
      if (/^(operator|if|for|while|switch|return)$/.test(name)) continue;
      if (/^[A-Z]\w*$/.test(name) && name === (inherit ? inherit[1] : '')) continue; // 构造函数
      contract.outputs.push({ name, return_type: ret, params: params.trim().slice(0, 200) });
      cnt++;
    }
    // 公式：捕获注释里的 ~ Eq. (N) 或 K = ... 这种行
    for (const line of raw.split(/\r?\n/)) {
      if (/\b(Eq\.?|Equation)\s*\(?\d/.test(line) || /^\s*\/\/\s*[A-Za-z_]+\s*=\s*/.test(line)) {
        const s = line.replace(/^\s*\/\/\s*/, '').trim();
        if (s && s.length < 200) contract.equations.push(s);
        if (contract.equations.length >= 8) break;
      }
    }
  } else if (ext === '.pdf') {
    contract.raw_notes.push('source 是 PDF —— 请配合 read_document 拿正文，再人工填 inputs/outputs/equations。本工具仅占位。');
  } else if (ext === '.py') {
    // 抽函数签名 + docstring 第一行
    const fnRe = /def\s+(\w+)\s*\(([^)]*)\):\s*(?:\n\s*"""([^"]+)""")?/g;
    let mm;
    while ((mm = fnRe.exec(raw)) !== null) {
      contract.outputs.push({ name: mm[1], params: mm[2], doc: (mm[3] || '').trim().slice(0, 200) });
      if (contract.outputs.length >= 10) break;
    }
  }
  // 全局关键字嗅探
  if (/compressible/i.test(raw)) contract.assumes.compressible = true;
  if (/incompressible/i.test(raw)) contract.assumes.compressible = false;
  if (/twoPhase|two-?phase|alpha\.water|alpha\.air/i.test(raw)) contract.assumes.phases = 2;
  if (/singlePhase|single-?phase/i.test(raw)) contract.assumes.phases = 1;
  for (const t of ['kEpsilon','kOmegaSST','SpalartAllmaras','LES','RAS','laminar']) {
    if (new RegExp(`\\b${t}\\b`).test(raw)) { contract.assumes.turbulence = t; break; }
  }
  contract.note = '⚠ 这是启发式抽取。`inputs/outputs` 来自函数签名；`equations` 来自注释行。**请人工核对一遍再当作契约用**。';
  return contract;
}

// case 体检（V8 四步法·步2）—— 返回 case 真实事实
async function caseProbeFacts({ case_path }) {
  const cd = path.isAbsolute(case_path) ? case_path : path.resolve(WORKSPACE, case_path);
  const facts = { case_path: case_path, solver: null, governing: null, compressible: null, phases: null, turbulence: null, dimensions_xyz: null, patches: [], fields_in_0: [], extras: {} };
  // controlDict.application
  try {
    const cd1 = await fs.readFile(path.join(cd, 'system/controlDict'), 'utf8');
    const m = cd1.match(/^\s*application\s+(\w+)\s*;/m);
    if (m) {
      facts.solver = m[1];
      const sv = m[1];
      // 求解器 → 物理类型映射（启发式）
      if (/^(simpleFoam|pimpleFoam|icoFoam)$/.test(sv)) { facts.governing = 'incompressible single-phase'; facts.compressible = false; facts.phases = 1; }
      else if (/^rho/.test(sv)) { facts.governing = 'compressible single-phase'; facts.compressible = true; facts.phases = 1; }
      else if (/^(interFoam|interIsoFoam|compressibleInterFoam)$/.test(sv)) { facts.governing = 'VOF two-phase'; facts.phases = 2; }
      else if (/twoPhaseEulerFoam|reactingTwoPhaseEulerFoam|multiphaseEulerFoam/.test(sv)) { facts.governing = 'Euler-Euler multi-phase'; facts.phases = 2; }
      else if (/buoyant/.test(sv)) { facts.governing = 'buoyant (T-coupled)'; }
    }
    const lm = cd1.match(/libs\s*\(([^)]+)\)/);
    if (lm) facts.extras.libs = lm[1].trim();
  } catch {}
  // turbulenceProperties
  try {
    const tp = await fs.readFile(path.join(cd, 'constant/turbulenceProperties'), 'utf8');
    const mm = tp.match(/RAS\s*\{[^}]*RASModel\s+(\w+)/) || tp.match(/LES\s*\{[^}]*LESModel\s+(\w+)/);
    if (mm) facts.turbulence = mm[1];
    else if (/simulationType\s+laminar/.test(tp)) facts.turbulence = 'laminar';
  } catch {}
  // blockMeshDict 维度
  try {
    const bm = await fs.readFile(path.join(cd, 'system/blockMeshDict'), 'utf8');
    const verts = [...bm.matchAll(/\(([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\)/g)].slice(0, 8).map(m => m.slice(1, 4).map(Number));
    if (verts.length >= 8) {
      const xs = verts.map(v => v[0]), ys = verts.map(v => v[1]), zs = verts.map(v => v[2]);
      facts.dimensions_xyz = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), Math.max(...zs) - Math.min(...zs)].map(x => +x.toFixed(6));
    }
  } catch {}
  // 0/ 字段 + 任一字段读 patches
  try {
    const ents = await fs.readdir(path.join(cd, '0'));
    facts.fields_in_0 = ents.filter(n => !n.startsWith('.'));
    for (const fn of facts.fields_in_0.slice(0, 4)) {
      try {
        const txt = await fs.readFile(path.join(cd, '0', fn), 'utf8');
        const bf = txt.match(/boundaryField\s*\{([\s\S]*?)\n\}/);
        if (bf) {
          const patches = [...bf[1].matchAll(/^\s*(\w+)\s*\n?\s*\{/gm)].map(m => m[1]);
          if (patches.length > facts.patches.length) facts.patches = patches;
        }
      } catch {}
    }
  } catch {}
  // transportProperties 看物性（启发式抽 nu / rho / sigma）
  try {
    const tp = await fs.readFile(path.join(cd, 'constant/transportProperties'), 'utf8');
    const ex = {};
    for (const k of ['nu', 'rho', 'mu', 'sigma']) {
      const re = new RegExp(`\\b${k}\\s+\\[[^\\]]+\\]\\s+([-\\d.eE+]+)`);
      const mm = tp.match(re);
      if (mm) ex[k] = Number(mm[1]);
    }
    if (Object.keys(ex).length) facts.extras.transport = ex;
  } catch {}
  return facts;
}

// 契约 vs case 审计（V8 四步法·步3）
function algoCaseAudit({ contract, case_facts }) {
  const mismatches = [];
  const c = contract || {}, f = case_facts || {};
  const A = c.assumes || {};
  if (A.compressible != null && f.compressible != null && A.compressible !== f.compressible) {
    mismatches.push({ axis: '可压性', contract: A.compressible, case: f.compressible, severity: 'high',
      hint: 'compressible 假设不一致 → 算法的连续性方程会用错（ρ 是变量还是常量）' });
  }
  if (A.phases != null && f.phases != null && A.phases !== f.phases) {
    mismatches.push({ axis: '相数', contract: A.phases, case: f.phases, severity: 'high',
      hint: 'phases 不一致 → Euler-Euler 算法不能直接放进 VOF case，或反之' });
  }
  if (A.turbulence && f.turbulence && A.turbulence.toLowerCase() !== f.turbulence.toLowerCase() && !/laminar/i.test(f.turbulence)) {
    mismatches.push({ axis: '湍流模型', contract: A.turbulence, case: f.turbulence, severity: 'mid',
      hint: '湍流模型不一致 → 算法用到的湍流量（k, ε, ω, νt）可能不存在或定义不同' });
  }
  // governing_type vs solver family
  if (c.governing_type && f.governing) {
    const cgt = String(c.governing_type).toLowerCase();
    const fgt = String(f.governing).toLowerCase();
    if (cgt.includes('euler-euler') && fgt.includes('vof')) {
      mismatches.push({ axis: '控制方程族', contract: cgt, case: fgt, severity: 'high',
        hint: '契约要求 Euler-Euler，case 是 VOF（interFoam）→ 不能直接植入，需先换求解器或换模板 case' });
    }
    if (cgt.includes('compressible') && !fgt.includes('compressible')) {
      mismatches.push({ axis: '控制方程族', contract: cgt, case: fgt, severity: 'high',
        hint: '契约要求可压求解器，case 是不可压（如 simpleFoam）→ 求解器要换' });
    }
  }
  // 字段存在性：契约 outputs 里若有"K"/"alpha"等关键字段，看 0/ 是否有
  const fields0 = new Set(f.fields_in_0 || []);
  for (const o of (c.outputs || [])) {
    const n = String(o.name || '').toLowerCase();
    for (const target of ['k', 'omega', 'epsilon', 'nut', 'alpha.water', 'alpha.air', 't']) {
      if (n.includes(target) && !fields0.has(target.charAt(0).toUpperCase() + target.slice(1)) && !fields0.has(target)) {
        mismatches.push({ axis: '0/ 缺字段', contract: o.name, case: `0/ 无 ${target}`, severity: 'low',
          hint: `算法输出涉及 ${target}，但 0/ 里没有，需先建初值或换 case` });
        break;
      }
    }
  }
  return {
    pass: mismatches.length === 0,
    mismatch_count: mismatches.length,
    mismatches,
    verdict: mismatches.length === 0
      ? '✅ 契约与 case 兼容。可进入第 4 步受控植入。'
      : `❌ 发现 ${mismatches.length} 处不匹配。**禁止**进入第 4 步。先解决 mismatch 或得到用户豁免。`
  };
}

// 不连接的语法 / 包含检查（V8 四步法·步4 辅助）
async function foamDryCompile({ module_path }) {
  const mp = safePath(module_path);
  // 校验存在 Make/files + Make/options
  for (const need of ['Make/files', 'Make/options']) {
    try { await fs.stat(path.join(mp, need)); }
    catch { return `[foam_dry_compile] 缺 ${need}，不是合法 OpenFOAM 源码模块。`; }
  }
  // 列出 .C 文件
  const ents = await fs.readdir(mp);
  const sources = ents.filter(n => /\.C$/.test(n));
  if (!sources.length) return `[foam_dry_compile] ${mp} 下未发现 .C 源文件。`;
  // 简单语法检查：调 wmake，捕获第一个 error 行后立即返回
  const r = await _spawnP('bash', ['-c', `cd "${mp}" && (wmake 2>&1 || true) | head -120`], {});
  const out = r.out || r.err || '';
  if (!out.trim()) return '[foam_dry_compile] wmake 无输出。建议手动 `wmake libso` 看是否环境未 source。';
  const firstErr = out.split(/\r?\n/).findIndex(l => /error:|fatal error:|undefined reference/.test(l));
  if (firstErr === -1) return `[foam_dry_compile] ✅ 未捕获到首错（可能已编译通过或全是 warning）。\n--- wmake head ---\n${out}`;
  const ctx = out.split(/\r?\n/).slice(Math.max(0, firstErr - 3), firstErr + 6).join('\n');
  return `[foam_dry_compile] ❌ 首错（行 ${firstErr + 1}）：\n${ctx}\n\n建议下一步 diagnose_error 把这段传入。`;
}
// ====================== V8 辅助层结束 ======================

function safePath(p) {
  const target = path.resolve(WORKSPACE, p || '.');
  const rel = path.relative(WORKSPACE, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`路径越界：${p}`);
  return target;
}

// OpenFOAM 场文件保护：把 `nonuniform List<scalar|vector|tensor> N ( ...几百万个值... )`
// 折叠成 head/tail 样本 + 计数，避免单次 read_file 把上下文塞爆。
// boundaryField 段不受影响（在数组之外），照常返回。
function collapseFoamFieldBody(text) {
  const re = /nonuniform\s+List<([A-Za-z]+)>\s*\n?\s*(\d+)\s*\(/g;
  let out = '', lastEnd = 0, m, hits = 0;
  while ((m = re.exec(text)) !== null) {
    const startBody = m.index + m[0].length;
    // 配对 ')'，场体内可能含子括号（vector/tensor 用 (x y z)）
    let depth = 1, j = startBody;
    while (j < text.length && depth > 0) {
      const c = text[j];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      j++;
    }
    if (depth !== 0) break;
    const endBody = j - 1;
    const body = text.slice(startBody, endBody);
    const n = m[2];
    const head = body.slice(0, 240).replace(/\s+/g, ' ').trim();
    const tail = body.slice(-240).replace(/\s+/g, ' ').trim();
    out += text.slice(lastEnd, m.index);
    out += `nonuniform List<${m[1]}> ${n} ( /* [已折叠 internalField 数组：${body.length} B, ${n} 项]\n   head: ${head.slice(0,200)}\n   tail: ${tail.slice(-200)}\n*/ )`;
    lastEnd = j;
    re.lastIndex = j;
    hits++;
  }
  out += text.slice(lastEnd);
  return { text: out, hits };
}

function broadcastTodos(ws) { const s = sessions.get(ws); if (!s) return; ws.send(JSON.stringify({ type: 'todos', list: s.todos })); }
function broadcastEdits(ws) { const s = sessions.get(ws); if (!s) return; ws.send(JSON.stringify({ type: 'pending_edits', list: s.pendingEdits })); }

function addPendingEdit(session, edit) {
  session.pendingEdits.push(edit);
  if (session.currentCheckpoint && !(edit.path in session.currentCheckpoint.files))
    session.currentCheckpoint.files[edit.path] = edit.oldContent;
  try { recordTurnFile(session.task, edit.path, edit.oldContent); } catch {}
}

// ====================== ParaView 窗口投影（核心新功能） ======================
//
// 思路：spawn 真正的 paraview GUI，记录其 PID，每隔 N ms 截取该窗口区域到 PNG
// 通过 WebSocket 推送给前端显示。Linux/Windows 各走一套实现。
//
const PV_STATE = { proc: null, pid: null, captureTimer: null, lastFrame: null, subscribers: new Set(), fps: 4, lastError: null, errorCount: 0, ready: false };

function pvBroadcast(obj) { const msg = JSON.stringify(obj); for (const ws of PV_STATE.subscribers) if (ws.readyState === 1) ws.send(msg); }

async function captureWindowsWindow(pid) {
  const tmp = path.join(os.tmpdir(), `pv_${process.pid}.png`);
  const outEsc = tmp.replaceAll("'", "''");
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
if (-not ([System.Management.Automation.PSTypeName]'CMaxW').Type) {
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CMaxW {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
}
"@
}
function Find-PvWindow($targetPid) {
  $found = $null; $best = 0
  $cb = [CMaxW+EnumProc]{ param($h,$l)
    $opid = 0
    [void][CMaxW]::GetWindowThreadProcessId($h, [ref]$opid)
    if ($opid -ne $targetPid) { return $true }
    if (-not [CMaxW]::IsWindowVisible($h)) { return $true }
    if ([CMaxW]::GetParent($h) -ne [IntPtr]::Zero) { return $true }
    $tl = [CMaxW]::GetWindowTextLength($h)
    $r = New-Object CMaxW+RECT
    [void][CMaxW]::GetWindowRect($h, [ref]$r)
    $area = ($r.R - $r.L) * ($r.B - $r.T)
    # 取面积最大的可见顶层窗口（避开 splash / 子对话）
    $score = $area + ($tl * 100)
    if ($script:best -lt $score) { $script:best = $score; $script:found = $h }
    return $true
  }
  $script:best = 0; $script:found = [IntPtr]::Zero
  [void][CMaxW]::EnumWindows($cb, [IntPtr]::Zero)
  return $script:found
}
try {
  $h = Find-PvWindow ${pid}
  if ($h -eq $null -or $h -eq [IntPtr]::Zero) {
    # 兜底：尝试子进程
    Get-Process | Where-Object { $_.Parent.Id -eq ${pid} -or $_.Id -eq ${pid} } | ForEach-Object {
      if ($h -eq $null -or $h -eq [IntPtr]::Zero) {
        $sub = Find-PvWindow $_.Id
        if ($sub -ne $null -and $sub -ne [IntPtr]::Zero) { $h = $sub }
      }
    }
  }
  if ($h -eq $null -or $h -eq [IntPtr]::Zero) { Write-Error 'NO_WINDOW'; exit 2 }
  if ([CMaxW]::IsIconic($h)) { [void][CMaxW]::ShowWindowAsync($h, 9); Start-Sleep -Milliseconds 200 }
  $r = New-Object CMaxW+RECT
  [void][CMaxW]::GetWindowRect($h, [ref]$r)
  $w = $r.R - $r.L; $hh = $r.B - $r.T
  if ($w -le 0 -or $hh -le 0) { Write-Error 'ZERO_SIZE'; exit 3 }
  $bmp = New-Object System.Drawing.Bitmap $w, $hh
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  # PW_RENDERFULLCONTENT = 0x00000002（Win8.1+，能抓 OpenGL/DWM 合成内容）
  $ok = [CMaxW]::PrintWindow($h, $hdc, 0x2)
  $g.ReleaseHdc($hdc)
  if (-not $ok) {
    # 兜底：屏幕拷贝
    $g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size $w, $hh))
  }
  $g.Dispose()
  $bmp.Save('${outEsc}', [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
} catch { Write-Error $_; exit 9 }
`;
  return await new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { windowsHide: true });
    let err = '';
    ps.stderr.on('data', d => err += d);
    const to = setTimeout(() => { try { ps.kill(); } catch {} }, 4000);
    ps.on('close', async (code) => {
      clearTimeout(to);
      if (code !== 0) {
        const tag = code === 2 ? '未找到顶层窗口' : code === 3 ? '窗口尺寸为 0' : 'PowerShell 异常';
        return reject(new Error(`${tag} (code=${code}) ${err.replace(/\s+/g,' ').slice(0,200)}`));
      }
      try { resolve(await fs.readFile(tmp)); } catch (e) { reject(e); }
    });
    ps.on('error', reject);
    ps.stdin.end(script);
  });
}

async function captureLinuxWindow(pid) {
  const tmp = path.join(os.tmpdir(), `pv_${process.pid}.png`);
  // 用 xdotool 找窗口 → import 抓
  const wid = await new Promise((res) => {
    const p = spawn('xdotool', ['search', '--pid', String(pid)]);
    let o = ''; p.stdout.on('data', d => o += d);
    p.on('close', () => { const ids = o.trim().split('\n').filter(Boolean); res(ids[ids.length - 1] || null); });
    p.on('error', () => res(null));
  });
  if (!wid) throw new Error('xdotool 找不到 ParaView 窗口（请安装 xdotool 与 imagemagick）');
  await new Promise((res, rej) => {
    const p = spawn('import', ['-window', wid, tmp]);
    p.on('close', c => c === 0 ? res() : rej(new Error('import 失败')));
    p.on('error', rej);
  });
  return await fs.readFile(tmp);
}

async function captureParaViewFrame() {
  if (!PV_STATE.pid) return null;
  try {
    const buf = IS_WIN ? await captureWindowsWindow(PV_STATE.pid) : await captureLinuxWindow(PV_STATE.pid);
    if (PV_STATE.lastError) { PV_STATE.lastError = null; PV_STATE.errorCount = 0; pvBroadcast({ type: 'term', line: '[ParaView 投影已恢复]' }); }
    return 'data:image/png;base64,' + buf.toString('base64');
  } catch (e) {
    const msg = String(e.message || e).slice(0, 240);
    if (msg !== PV_STATE.lastError) {
      PV_STATE.lastError = msg;
      PV_STATE.errorCount = 0;
      pvBroadcast({ type: 'term', line: '[ParaView 抓帧失败] ' + msg });
      pvBroadcast({ type: 'sim_error', message: msg });
    } else {
      PV_STATE.errorCount++;
      if (PV_STATE.errorCount === 5) pvBroadcast({ type: 'term', line: '[ParaView 抓帧持续失败 ×5，已静音同类报错]' });
    }
    return null;
  }
}

function startParaViewCapture() {
  if (PV_STATE.captureTimer) return;
  const interval = Math.max(150, Math.round(1000 / PV_STATE.fps));
  PV_STATE.captureTimer = setInterval(async () => {
    if (PV_STATE.subscribers.size === 0) return;
    const frame = await captureParaViewFrame();
    if (!frame) return;
    PV_STATE.lastFrame = frame;
    const msg = JSON.stringify({ type: 'sim_frame', dataUrl: frame });
    for (const ws of PV_STATE.subscribers) if (ws.readyState === 1) ws.send(msg);
  }, interval);
}
function stopParaViewCapture() {
  if (PV_STATE.captureTimer) { clearInterval(PV_STATE.captureTimer); PV_STATE.captureTimer = null; }
}

async function launchParaView(casePath) {
  if (!SETTINGS.paraviewExe) throw new Error('未配置 ParaView 主程序路径，请到 ⚙ 设置中填入（如 paraview.exe 或 /usr/bin/paraview）');
  // 已在运行 → 重用
  if (PV_STATE.proc && !PV_STATE.proc.killed) {
    return { reused: true, pid: PV_STATE.pid };
  }
  const args = [];
  if (casePath) {
    let target = path.isAbsolute(casePath) ? casePath : path.resolve(WORKSPACE, casePath);
    try {
      const stat = await fs.stat(target);
      if (stat.isDirectory()) {
        const foam = path.join(target, 'case.foam');
        try { await fs.access(foam); } catch { await fs.writeFile(foam, '', 'utf8'); }
        target = foam;
      }
    } catch {}
    args.push(`--data=${target}`);
  }
  const proc = spawn(SETTINGS.paraviewExe, args, { detached: false, stdio: 'ignore', windowsHide: false });
  PV_STATE.proc = proc; PV_STATE.pid = proc.pid; PV_STATE.ready = false; PV_STATE.lastError = null; PV_STATE.errorCount = 0;
  proc.on('exit', () => { PV_STATE.proc = null; PV_STATE.pid = null; PV_STATE.lastFrame = null; PV_STATE.ready = false;
    for (const ws of PV_STATE.subscribers) if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'sim_closed' })); });
  // 等窗口就位（最多 12s）
  pvBroadcast({ type: 'term', line: `[ParaView 启动中 PID=${proc.pid}，等待窗口…]` });
  (async () => {
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (!PV_STATE.proc) return;
      try {
        const buf = IS_WIN ? await captureWindowsWindow(PV_STATE.pid) : await captureLinuxWindow(PV_STATE.pid);
        if (buf) { PV_STATE.ready = true; pvBroadcast({ type: 'term', line: '[ParaView 窗口已就位，开始投影]' }); return; }
      } catch {}
    }
    pvBroadcast({ type: 'term', line: '[警告] 12s 内未抓到 ParaView 窗口；将持续重试。可手动把 ParaView 窗口拖到前台一次。' });
  })();
  startParaViewCapture();
  return { reused: false, pid: proc.pid };
}

function killParaView() {
  if (PV_STATE.proc) { try { PV_STATE.proc.kill(); } catch {} }
  stopParaViewCapture();
}

// ====================== 跨平台交互终端（每会话一个 shell） ======================
function spawnShell(cwd) {
  if (IS_WIN) return spawn(process.env.COMSPEC || 'cmd.exe', ['/Q'], { cwd, env: process.env });
  return spawn(process.env.SHELL || '/bin/bash', ['-i'], { cwd, env: process.env });
}

// ====================== OpenFOAM 命令（agent 调用） ======================
async function runOpenFoam({ casePath, command }, ws) {
  const cd = path.isAbsolute(casePath) ? casePath : path.resolve(WORKSPACE, casePath);
  let shell, shellArgs;
  if (IS_WIN && SETTINGS.openfoamBash) {
    shell = 'cmd.exe';
    shellArgs = ['/c', `call "${SETTINGS.openfoamBash}" && cd /d "${cd}" && ${command}`];
  } else if (IS_WIN) {
    shell = 'cmd.exe'; shellArgs = ['/c', `cd /d "${cd}" && ${command}`];
  } else {
    // Linux/Mac：优先用用户设置的 openfoamBash，其次 $FOAM_BASH，再试从 foamRoot/etc/bashrc 推断
    let bashrc = SETTINGS.openfoamBash || '';
    if (!bashrc && SETTINGS.foamRoot) {
      const cand = path.join(SETTINGS.foamRoot, 'etc', 'bashrc');
      try { if ((await fs.stat(cand)).isFile()) bashrc = cand; } catch {}
    }
    const sourceLine = bashrc ? `source "${bashrc}"` : `source "$FOAM_BASH" 2>/dev/null || true`;
    shell = 'bash'; shellArgs = ['-c', `cd "${cd}" && (${sourceLine}); ${command}`];
  }
  return await new Promise((resolve) => {
    ws.send(JSON.stringify({ type: 'term', line: `$ [OF] ${command}  (${cd})` }));
    const child = spawn(shell, shellArgs, { cwd: cd });
    const buf = headTailBuffer();
    const onData = d => { const s = d.toString(); buf.push(s); s.split(/\r?\n/).forEach(l => l && ws.send(JSON.stringify({ type: 'term', line: l }))); };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    const t = setTimeout(() => { try { child.kill(); } catch {} }, 600000);
    child.on('close', code => { clearTimeout(t); ws.send(JSON.stringify({ type: 'term', line: `[退出码 ${code}]` })); resolve(`[退出码 ${code}]\n${buf.toString()}`); });
    child.on('error', err => { clearTimeout(t); resolve(`[启动失败] ${err.message}`); });
  });
}

// ====================== OpenFOAM Beta：教程/源码/克隆/检查 ======================
function foamRoot() {
  const r = SETTINGS.foamRoot && String(SETTINGS.foamRoot).trim();
  if (!r) throw new Error('未设置 OpenFOAM 根目录。请在右侧 "OpenFOAM (Beta)" 面板填写，或 POST /api/foam/config {root}');
  return r;
}
async function pathExists(p) { try { await fs.access(p); return true; } catch { return false; } }

// 递归走目录，回调 (relPath, absPath, dirent) for file/dir
async function walkDir(root, onEntry, opts = {}) {
  const maxDepth = opts.maxDepth ?? 8;
  const skip = new Set(['.git', '.svn', 'node_modules', 'doc', 'doxygen', '.lib-openmpi', 'lnInclude', 'linux64GccDPInt32Opt', 'linux64GccDPInt64Opt', 'linux64Gcc', '.idea']);
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let ents = [];
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (skip.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs);
      try {
        const stop = await onEntry(rel, abs, e);
        if (stop === 'stop') return;
      } catch {}
      if (e.isDirectory() && depth < maxDepth) stack.push({ dir: abs, depth: depth + 1 });
    }
  }
}

async function foamFindTutorial(query, topK = 12) {
  const root = foamRoot();
  const tutDir = path.join(root, 'tutorials');
  if (!await pathExists(tutDir)) throw new Error(`未找到 tutorials/ 目录：${tutDir}`);
  const q = String(query || '').toLowerCase().split(/[\s,/]+/).filter(Boolean);
  const hits = [];
  await walkDir(tutDir, async (rel, abs, e) => {
    if (!e.isDirectory()) return;
    // case 目录的判定：含 system/controlDict
    if (await pathExists(path.join(abs, 'system', 'controlDict'))) {
      const lower = rel.toLowerCase().replace(/\\/g, '/');
      let score = 0;
      for (const t of q) if (lower.includes(t)) score += 10;
      // 每段命中加权
      const segs = lower.split('/');
      for (const t of q) for (const s of segs) if (s === t) score += 5;
      if (q.length === 0 || score > 0) hits.push({ rel: rel.replace(/\\/g, '/'), abs, score });
      return; // 不再深入 case 内部找子 case
    }
  }, { maxDepth: 8 });
  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, topK);
  if (!top.length) return `未找到匹配教程：${query}\n建议在 ${tutDir} 下手动浏览。`;
  return `[foam_find_tutorial] "${query}" → ${top.length} 条候选（按相关度）：\n` +
    top.map((h, i) => `${i+1}. ${h.rel}\n   绝对路径：${h.abs}`).join('\n');
}

async function foamFindSource(query, kind = 'all', topK = 12) {
  const root = foamRoot();
  const q = String(query || '').toLowerCase();
  if (!q) throw new Error('query 必填');
  // 选搜索根
  const roots = [];
  if (kind === 'solver' || kind === 'all') roots.push(path.join(root, 'applications', 'solvers'));
  if (kind === 'model' || kind === 'all')  roots.push(path.join(root, 'src'));
  if (kind === 'bc' || kind === 'all')     roots.push(path.join(root, 'src', 'finiteVolume', 'fields', 'fvPatchFields'));
  if (kind === 'all') roots.push(path.join(root, 'applications', 'utilities'));
  const hits = [];
  for (const base of roots) {
    if (!await pathExists(base)) continue;
    await walkDir(base, async (rel, abs, e) => {
      if (!e.isFile()) return;
      const name = e.name;
      const ext = path.extname(name).toLowerCase();
      if (!['.h', '.hpp', '.c', '.cpp', '.cxx', '.h.in', ''].includes(ext) && !['files','options'].includes(name)) return;
      const lower = name.toLowerCase();
      let score = 0;
      if (lower.includes(q)) score += 10;
      // 文件名片段精确匹配（大小写不敏感）
      const baseName = path.basename(name, ext).toLowerCase();
      if (baseName === q) score += 30;
      if (score > 0) hits.push({ rel: path.relative(root, abs).replace(/\\/g, '/'), abs, score, base: path.basename(base) });
    }, { maxDepth: 10 });
  }
  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, topK);
  if (!top.length) return `未找到匹配源码：${query} (kind=${kind})`;
  return `[foam_find_source] "${query}" kind=${kind} → ${top.length} 条候选：\n` +
    top.map((h, i) => `${i+1}. [${h.base}] ${h.rel}\n   绝对路径：${h.abs}`).join('\n');
}

async function foamCloneTutorial(tutorialPath, dest) {
  const root = foamRoot();
  if (!tutorialPath || !dest) throw new Error('tutorial_path 和 dest 必填');
  let src = tutorialPath;
  if (!path.isAbsolute(src)) src = path.join(root, 'tutorials', tutorialPath);
  if (!await pathExists(src)) throw new Error(`tutorial 不存在：${src}`);
  if (!await pathExists(path.join(src, 'system', 'controlDict'))) {
    return `警告：${src} 看起来不是一个 case 目录（缺 system/controlDict），未复制。请先用 foam_find_tutorial 定位到具体 case。`;
  }
  const target = safePath(dest);
  await fs.mkdir(target, { recursive: true });
  // 用 fs.cp（Node 16.7+）递归复制
  await fs.cp(src, target, { recursive: true, force: false, errorOnExist: false });
  let pre = '';
  try { pre = Prelaunch.formatPrelaunch(await Prelaunch.prelaunchCheck(target)); } catch {}
  return `已复制 tutorial：\n  源：${src}\n  目标：${path.relative(WORKSPACE, target)}${pre}\n建议下一步：foam_inspect_case("${path.relative(WORKSPACE, target)}")`;
}

// 解析 boundaryField { patch { type X; ... } }
function parseBoundaryField(text) {
  const out = {};
  const m = text.match(/boundaryField\s*\{([\s\S]*)\}/);
  if (!m) return out;
  const body = m[1];
  // 简化：找形如 patchName\s*{...} 的块（一层大括号匹配）
  let i = 0;
  while (i < body.length) {
    // 跳空白与注释
    while (i < body.length && /[\s\n\r]/.test(body[i])) i++;
    if (body[i] === '/' && body[i+1] === '/') { while (i < body.length && body[i] !== '\n') i++; continue; }
    if (body[i] === '/' && body[i+1] === '*') { i += 2; while (i < body.length && !(body[i] === '*' && body[i+1] === '/')) i++; i += 2; continue; }
    if (i >= body.length) break;
    // 读 patch 名
    const nameMatch = body.slice(i).match(/^([A-Za-z_][\w\.]*)/);
    if (!nameMatch) { i++; continue; }
    const pname = nameMatch[1];
    i += nameMatch[0].length;
    while (i < body.length && /[\s\n\r]/.test(body[i])) i++;
    if (body[i] !== '{') continue;
    // 一层大括号匹配
    let depth = 1; i++; const start = i;
    while (i < body.length && depth) { if (body[i] === '{') depth++; else if (body[i] === '}') depth--; if (depth) i++; }
    const block = body.slice(start, i);
    i++; // skip '}'
    const typeM = block.match(/\btype\s+([A-Za-z][\w]*)\s*;/);
    out[pname] = { type: typeM ? typeM[1] : '?', raw: block.trim().slice(0, 200) };
  }
  return out;
}

async function foamInspectCase(casePath) {
  if (!casePath) throw new Error('case_path 必填');
  const cd = path.isAbsolute(casePath) ? casePath : safePath(casePath);
  if (!await pathExists(cd)) throw new Error(`case 不存在：${cd}`);
  const lines = [`# 算例检查：${path.relative(WORKSPACE, cd) || cd}`];
  // 1) 列三大目录
  for (const d of ['0', 'constant', 'system']) {
    const dd = path.join(cd, d);
    if (!await pathExists(dd)) { lines.push(`\n## ${d}/  (不存在)`); continue; }
    const items = (await fs.readdir(dd, { withFileTypes: true })).map(e => e.name + (e.isDirectory()?'/':''));
    lines.push(`\n## ${d}/  (${items.length} 项)\n  ${items.join('  ')}`);
  }
  // 2) controlDict 摘要
  try {
    const cd_text = await fs.readFile(path.join(cd, 'system', 'controlDict'), 'utf8');
    const grab = (k) => (cd_text.match(new RegExp(`\\b${k}\\s+([^;\\n]+);`)) || [])[1] || '';
    lines.push(`\n## system/controlDict 关键项`);
    ['application','startTime','endTime','deltaT','writeInterval','writeControl','adjustTimeStep','maxCo'].forEach(k => {
      const v = grab(k); if (v) lines.push(`  ${k} = ${v.trim()}`);
    });
  } catch {}
  // 3) constant 关键 dict
  try {
    const ents = await fs.readdir(path.join(cd, 'constant'), { withFileTypes: true });
    const keyDicts = ents.filter(e => /Properties$|^transportProperties$|^turbulenceProperties$|^thermophysicalProperties$|^phaseProperties$|^MRFProperties$/.test(e.name)).map(e => e.name);
    if (keyDicts.length) {
      lines.push(`\n## constant/ 关键 dict`);
      for (const k of keyDicts.slice(0, 6)) {
        const t = await fs.readFile(path.join(cd, 'constant', k), 'utf8').catch(()=>'');
        lines.push(`  • ${k}：` + (t.slice(0, 240).replace(/\s+/g,' ')) + (t.length > 240 ? '…' : ''));
      }
    }
  } catch {}
  // 4) 0/ boundary 摘要
  try {
    const fields = (await fs.readdir(path.join(cd, '0'))).filter(n => !n.startsWith('.'));
    if (fields.length) {
      lines.push(`\n## 0/ 边界条件矩阵`);
      const matrix = {};
      const allPatches = new Set();
      for (const f of fields) {
        try {
          const txt = await fs.readFile(path.join(cd, '0', f), 'utf8');
          matrix[f] = parseBoundaryField(txt);
          Object.keys(matrix[f]).forEach(p => allPatches.add(p));
        } catch {}
      }
      const patches = [...allPatches];
      lines.push(`  patch \\ field   ${fields.map(f => f.padEnd(8)).join(' ')}`);
      for (const p of patches) {
        lines.push(`  ${p.padEnd(15)} ${fields.map(f => (matrix[f]?.[p]?.type || '-').padEnd(8)).join(' ')}`);
      }
    }
  } catch {}
  // 5) fvSchemes / fvSolution 摘要
  for (const f of ['fvSchemes','fvSolution']) {
    try {
      const t = await fs.readFile(path.join(cd, 'system', f), 'utf8');
      lines.push(`\n## system/${f}（前 280 字符）\n  ${t.slice(0, 280).replace(/\s+/g,' ')}…`);
    } catch {}
  }
  // 6) 完整文件树（递归）
  try {
    lines.push(`\n## 完整文件清单（递归）`);
    const all = [];
    await walkDir(cd, async (rel, abs, e) => {
      if (e.isDirectory()) return;
      let sz = 0; try { sz = (await fs.stat(abs)).size; } catch {}
      all.push({ rel: rel.replaceAll('\\','/'), size: sz });
    }, { maxDepth: 6 });
    all.sort((a,b) => a.rel.localeCompare(b.rel));
    for (const x of all.slice(0, 200)) lines.push(`  ${x.rel}  (${x.size}B)`);
    if (all.length > 200) lines.push(`  …(共 ${all.length} 文件，省略 ${all.length-200} 项)`);
  } catch {}
  return lines.join('\n');
}

// ====================== OpenFOAM 求解器异步监测 ======================
const SOLVER_RUNS = new Map();  // runId -> { proc, casePath, command, log:[], started, ended, exitCode, subs:Set<ws> }
const SOLVER_EVENTS = new EventEmitter();
SOLVER_EVENTS.setMaxListeners(0);
function _solverEnded(run) {
  try { SOLVER_EVENTS.emit('ended', run.runId); } catch {}
  try {
    const msg = JSON.stringify({ type: 'runs_update', reason: 'solver_ended', runId: run.runId });
    for (const c of allClients) if (c.readyState === 1) c.send(msg);
  } catch {}
  try { broadcastTaskState(); } catch {}
  try { _scheduleWake(run); } catch (e) { console.warn('[wake]', e.message); }
}

// ── 可续接后台作业：detached 启动 + 输出落盘 <case>/log.nullflux.<runId>，服务重启/重新部署不杀求解器，启动时按 PID 重新接管 ──
const RUNS_INDEX = path.join(__dirname, 'tasks', '_runs.json');
const EXIT_MARK = '__NF_EXIT__=';
const WIN_RUNNER_JS = "const fs=require('fs'),{spawn}=require('child_process');const [lf,cd,cmd,mark]=process.argv.slice(1);const fd=fs.openSync(lf,'a');" +
  "const p=spawn('cmd.exe',['/d','/s','/c','\"'+cmd+'\"'],{cwd:cd,stdio:['ignore',fd,fd],windowsHide:true,windowsVerbatimArguments:true});" +
  "const done=c=>{try{fs.appendFileSync(lf,'\\n'+mark+c+'\\n')}catch{}process.exit(0)};p.on('exit',c=>done(c==null?-1:c));p.on('error',()=>done(-1));";
function _persistRuns() {
    const weekAgo = Date.now() - 7 * 86400_000;
    const eligible = [...SOLVER_RUNS.values()].filter(run => run.logFile);
    const selected = [...eligible.filter(run => !run.ended), ...eligible.filter(run => run.ended > weekAgo).slice(-200)];
    const arr = selected
      .map(r => ({ runId: r.runId, kind: r.kind || 'foam', pid: r.pid, casePath: r.casePath, command: r.command, logFile: r.logFile,
        started: r.started, ended: r.ended, exitCode: r.exitCode, ownerTaskId: r.ownerTaskId || null, broadcast: !!r.broadcast, external: !!r.external,
        redirLog: r.redirLog || '' }));
    try {
      fssync.mkdirSync(path.dirname(RUNS_INDEX), { recursive: true });
      const temporary = RUNS_INDEX + '.tmp';
      fssync.writeFileSync(temporary, JSON.stringify(arr, null, 1));
      fssync.renameSync(temporary, RUNS_INDEX);
    } catch (e) { console.warn('[runs] 保存失败:', e.message); }
}
function _pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
// detached 启动的是独立进程组：必须按组/树杀，否则只杀掉外层 shell，求解器本体继续跑
function killRunTree(run, hard) {
  const pid = run.pid || (run.proc && run.proc.pid);
  if (!pid) return;
  if (IS_WIN) { try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch {} return; }
  const sig = hard ? 'SIGKILL' : 'SIGTERM';
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} }
}
function _pushRunLines(run, text) {
  const lines = [];
  for (const l of text.split(/\r?\n/)) {
    if (!l) continue;
    if (l.startsWith(EXIT_MARK)) { const c = Number(l.slice(EXIT_MARK.length).trim()); if (Number.isFinite(c)) run._markExit = c; continue; }
    lines.push(l.length > 2000 ? l.slice(0, 2000) + ' …[行过长截断]' : l);
  }
  if (!lines.length) return;
  // 多相/多组分求解器单步日志可超过 4000 行缓冲：单独记住最近的 Time，摘要不再显示 Time=?
  for (let i = lines.length - 1; i >= 0; i--) { const m = lines[i].match(/^Time\s*=\s*([\d.eE+\-]+)/); if (m) { run._lastTime = m[1]; break; } }
  if ((run.kind || 'foam') === 'foam' && !run.external && SETTINGS.solverHealth !== false && !run.ended) try { _healthCheck(run, lines); } catch {}
  for (const l of lines) run.log.push(l);
  run._lineNo = (run._lineNo || 0) + lines.length;
  if (run.log.length > 4000) run.log.splice(0, run.log.length - 4000);
  for (const sub of run.subs) if (sub.readyState === 1) { try { sub.send(JSON.stringify({ type: 'solver_log', runId: run.runId, lines })); } catch {} }
  if (run.broadcast && allClients.size) {
    // 终端面板只需要看到进度：每个 tail 周期合并为一条消息、最多 200 行（多相求解器一步可打印上千行）
    const tag = `[OF ${run.runId}]`;
    const sel = lines.length > 200 ? lines.slice(-200) : lines;
    const msg = JSON.stringify({ type: 'term', line: sel.map(l => `${tag} ${l}`).join('\n') });
    for (const c of allClients) if (c.readyState === 1) c.send(msg);
  }
}
// 求解健康监视：dt 崩塌 / NaN → 先 stopAt writeNow 写出发散前场（供诊断）再终止，避免在 1e-100 的 dt 上空耗几小时
function _healthCheck(run, lines) {
  if (run._health) return;
  const h = run._hl || (run._hl = {});
  const why = FoamPost.detectDivergence(h, lines);
  if (!why) return;
  run._health = { reason: why, time: h.t, at: Date.now() };
  const note = `[NF_HEALTH] ⚠ 发散自动处置 @Time=${h.t}：${why}。已设 stopAt writeNow 写出当前场并停止（不再空耗算力）。下一步：foam_locate({case_path}) 定位发散单元和最近 patch，再对症修。`;
  lines.push(note);
  const cd = path.join(run.casePath, 'system', 'controlDict');
  try {
    const txt = fssync.readFileSync(cd, 'utf8');
    run._ctrlBackup = txt;
    const nt = /^\s*stopAt\s+\w+\s*;/m.test(txt) ? txt.replace(/^(\s*stopAt\s+)\w+(\s*;)/m, '$1writeNow$2') : txt.replace(/(\n\s*endTime)/, '\nstopAt          writeNow;$1');
    fssync.writeFileSync(cd, nt);
  } catch {}
  setTimeout(() => { if (!run.ended) { killRunTree(run); setTimeout(() => { if (!run.ended) killRunTree(run, true); }, 5000); } }, 180_000);
  Fidelity.recordLesson({ kind: 'divergence', case: run.casePath, time: h.t, detail: why, command: String(run.command).slice(0, 160) }).catch(() => {});
}

// 串行化读取：定时 tick 与收尾 drain 不会并发读同一偏移
async function _tailFile(run, file, offKey) {
  let fh;
  try {
    fh = await fs.open(file, 'r');
    const { size } = await fh.stat();
    if (size < (run[offKey] || 0)) run[offKey] = 0;
    const avail = size - (run[offKey] || 0);
    if (avail <= 0) return;
    const len = Math.min(avail, 4 << 20);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, run[offKey] || 0);
    // 只消费到最后一个换行，避免把 UTF-8 多字节字符或半行切开
    let take = buf.lastIndexOf(10) + 1;
    if (take === 0) { if (len < (4 << 20) && !run._draining) return; take = len; }
    run[offKey] = (run[offKey] || 0) + take;
    _pushRunLines(run, buf.subarray(0, take).toString('utf8'));
  } catch {} finally { if (fh) await fh.close().catch(() => {}); }
}
// 命令自带 `> log.xxx` 重定向时，求解输出不进跟踪日志：解析出目标文件，一起跟踪（健康监视 / solver_wait 正则才看得到）
function _redirectTarget(command, casePath) {
  const m = String(command || '').match(/(?:^|[^0-9&])>{1,2}\s*([^\s;&|<>]+)/);
  if (!m || /^\/dev\//.test(m[1])) return '';
  return path.isAbsolute(m[1]) ? m[1] : path.join(casePath || '', m[1]);
}
// 作业脚本内部自己重定向（如 ./Allcold 里 mpirun … > log.cold）时，命令行里解析不出目标，跟踪日志是空的：
// 在作业进程树里找求解器 stdout 指向的文件一起跟踪（监视卡、健康监视、solver_wait 才看得到 Time）
function _adoptTreeLog(run) {
  if (process.platform !== 'linux' || run.external || run.ended || !run.pid) return;
  if ((run.redirLog && !run._autoLog) || (run._lastTime && !run._autoLog)) return;
  if (Date.now() - (run._treeLogAt || 0) < (run._autoLog ? 30_000 : 10_000)) return;
  run._treeLogAt = Date.now();
  try {
    const f = ExtRuns.findTreeLog(run.pid, ExtRuns.readProcTable(), run.logFile);
    if (!f || f === run.redirLog) return;
    const size = fssync.statSync(f).size;
    run.redirLog = f; run._autoLog = true; run._roff = size > (2 << 20) ? size - (2 << 20) : 0;
    console.log(`[runs] ${run.runId} 求解输出在脚本内重定向到 ${f}，已一起跟踪`);
    _persistRuns();
  } catch (e) { console.warn('[runs] 查找脚本内日志失败:', e.message); }
}
function _tailOnce(run) {
  run._chain = (run._chain || Promise.resolve()).then(async () => {
    _adoptTreeLog(run);
    await _tailFile(run, run.logFile, '_off');
    if (run.redirLog) await _tailFile(run, run.redirLog, '_roff');
  });
  return run._chain;
}
async function _finishRun(run, code) {
  if (run.ended) return;
  clearInterval(run._tail); clearInterval(run._alive);
  run._draining = true;
  await _tailOnce(run); await _tailOnce(run);
  run.ended = Date.now();
  run.exitCode = run._markExit != null ? run._markExit : (code == null ? (run.external ? ExtRuns.inferExitFromLog(run.log) : null) : code);
  if (run.exitCode !== 0 && run._markExit == null && !run._health && (_endedCleanly(run.log) || _endedCleanly(_redirectTail(run).split('\n')))) { run.rawExitCode = run.exitCode; run.exitCode = 0; run.endAbort = true; }
  if (run._ctrlBackup) { try { fssync.writeFileSync(path.join(run.casePath, 'system', 'controlDict'), run._ctrlBackup); } catch {} run._ctrlBackup = null; }
  for (const sub of run.subs) if (sub.readyState === 1) { try { sub.send(JSON.stringify({ type: 'solver_done', runId: run.runId, exitCode: run.exitCode })); } catch {} }
  _persistRuns();
  _solverEnded(run);
  {
    const ok = run.exitCode === 0;
    const tail = (run.log || []).slice(-3).join('\n').slice(-400);
    const mins = Math.round((run.ended - run.started) / 60000);
    notifyEvent({ kind: 'solver_done', key: `solver:${run.runId}`, level: ok ? 'normal' : 'high', taskId: run.ownerTaskId,
      title: `${ok ? '✅ 求解完成' : '⚠ 求解异常退出'} ${run.runId}（退出码 ${run.exitCode}）`,
      body: `${_taskTitle(run.ownerTaskId) ? `任务：${_taskTitle(run.ownerTaskId)}\n` : ''}算例：${run.casePath}\n用时 ${mins} 分钟${tail ? `\n最后输出：\n${tail}` : ''}` });
  }
}
function spawnTrackedRun({ kind, cd, command, inner, ws, session, broadcast }) {
  if (!fssync.existsSync(cd)) throw new Error(`case_path 不存在: ${cd}`);
  const runId = crypto.randomBytes(4).toString('hex');
  const logFile = path.join(cd, `log.nullflux.${runId}`);
  // 末行写退出码：重启接管后没有子进程句柄，只能从日志拿 exit code
  let proc;
  fssync.closeSync(fssync.openSync(logFile, 'a'));
  if (IS_WIN) {
    // Windows 下 detached 的 cmd 会丢孙进程的控制台输出 → 用 detached 的 node 守护进程再非 detached 地起 cmd
    const runner = WIN_RUNNER_JS;
    proc = spawn(process.execPath, ['-e', runner, logFile, cd, inner, EXIT_MARK], { cwd: cd, detached: true, stdio: 'ignore', windowsHide: true });
  } else {
    const fd = fssync.openSync(logFile, 'a');
    try { proc = spawn('bash', ['-c', `${inner}\necho "${EXIT_MARK}$?"`], { cwd: cd, detached: true, stdio: ['ignore', fd, fd] }); }
    finally { try { fssync.closeSync(fd); } catch {} }
  }
  proc.unref();
  const run = { runId, kind, proc, pid: proc.pid, casePath: cd, command, logFile, log: [], started: Date.now(), ended: 0, exitCode: null,
    subs: new Set(), ownerTaskId: (session && session.task && session.task.id) || null, broadcast: !!broadcast, _off: 0,
    redirLog: _redirectTarget(command, cd), _roff: 0 };
  SOLVER_RUNS.set(runId, run);
  run._tail = setInterval(() => _tailOnce(run), 1000);
  proc.on('exit', code => setTimeout(() => _finishRun(run, code), 300));
  proc.on('error', err => { run.log.push('[启动失败] ' + err.message); _finishRun(run, -1); });
  if (ws && !ws.isHeadless) run.subs.add(ws);
  _persistRuns();
  try {
    const msg = JSON.stringify({ type: 'runs_update', reason: 'solver_started', runId });
    for (const c of allClients) if (c.readyState === 1) c.send(msg);
  } catch {}
  try { broadcastTaskState(); } catch {}
  return run;
}
function reattachRuns() {
  let arr = [];
  try { arr = JSON.parse(fssync.readFileSync(RUNS_INDEX, 'utf8')); } catch { return; }
  let live = 0;
  for (const m of Array.isArray(arr) ? arr : []) {
    if (!m || !m.runId || SOLVER_RUNS.has(m.runId)) continue;
    const run = { ...m, proc: null, log: [], subs: new Set(), reattached: true };
    let size = 0; try { size = fssync.statSync(run.logFile).size; } catch {}
    // 长算例日志可达 GB 级：只回放最后 2MB
    run._off = Math.max(0, size - (2 << 20));
    if (!run.redirLog && !run.external) run.redirLog = _redirectTarget(run.command, run.casePath);
    if (run.redirLog) { let rs = 0; try { rs = fssync.statSync(run.redirLog).size; } catch {} run._roff = Math.max(0, rs - (2 << 20)); }
    SOLVER_RUNS.set(run.runId, run);
    if (run.ended) { run._reported = true; _tailOnce(run); continue; }
    live++;
    run._tail = setInterval(() => _tailOnce(run), 1000);
    run._alive = setInterval(() => { if (!_pidAlive(run.pid)) _finishRun(run, null); }, 5000);
    if (!_pidAlive(run.pid)) _finishRun(run, null);
  }
  if (live) console.log(`[runs] 重新接管 ${live} 个后台作业`);
}

// ── 接管手动启动的求解器（终端里直接 nohup mpirun ... 起的作业）：只读监视日志，结束时推送通知，不做发散自动处置 ──
function _registerExternalRun(c) {
  let cwd = '';
  try { cwd = fssync.readlinkSync(`/proc/${c.pid}/cwd`); } catch { return null; }
  const logFile = ExtRuns.resolveLog(c.pid, cwd);
  const runId = 'x' + crypto.randomBytes(3).toString('hex');
  const started = ExtRuns.processStartMs(c.starttime) || Date.now();
  const run = { runId, kind: 'foam', pid: c.pid, casePath: cwd, command: c.argv.join(' ').slice(0, 500), logFile: logFile || '',
    log: [], started, ended: 0, exitCode: null, subs: new Set(), ownerTaskId: null, broadcast: false, external: true, proc: null };
  let size = 0; if (logFile) { try { size = fssync.statSync(logFile).size; } catch {} }
  run._off = Math.max(0, size - (2 << 20));
  SOLVER_RUNS.set(runId, run);
  if (logFile) run._tail = setInterval(() => _tailOnce(run), 2000);
  run._alive = setInterval(() => { if (!_pidAlive(run.pid)) _finishRun(run, null); }, 5000);
  console.log(`[runs] 接管手动作业 ${runId}: ${c.solver} pid=${c.pid} case=${cwd} log=${logFile || '(未找到)'}`);
  return run;
}
function scanExternalRuns() {
  if (process.platform !== 'linux' || SETTINGS.adoptExternalRuns === false) return 0;
  const tracked = new Set([process.pid]);
  for (const r of SOLVER_RUNS.values()) if (!r.ended && r.pid) tracked.add(r.pid);
  let n = 0;
  for (const c of ExtRuns.pickCandidates(ExtRuns.readProcTable(), tracked)) {
    try { if (_registerExternalRun(c)) n++; } catch (e) { console.warn('[runs] 接管失败', c.pid, e.message); }
  }
  if (n) {
    _persistRuns();
    try { const msg = JSON.stringify({ type: 'runs_update', reason: 'external_adopted' }); for (const cl of allClients) if (cl.readyState === 1) cl.send(msg); } catch {}
    try { broadcastTaskState(); } catch {}
  }
  return n;
}

async function foamRunSolverAsync({ case_path, command }, ws, session) {
  if (!case_path) throw new Error('case_path 必填');
  if (!command) throw new Error('command 必填');
  const cd = path.isAbsolute(case_path) ? case_path : path.resolve(WORKSPACE, case_path);
  let inner;
  if (IS_WIN && SETTINGS.openfoamBash) {
    inner = `call "${SETTINGS.openfoamBash}" && cd /d "${cd}" && ${command}`;
  } else if (IS_WIN) {
    inner = `cd /d "${cd}" && ${command}`;
  } else {
    let bashrc = SETTINGS.openfoamBash || '';
    if (!bashrc && SETTINGS.foamRoot) {
      const cand = path.join(SETTINGS.foamRoot, 'etc', 'bashrc');
      try { if ((await fs.stat(cand)).isFile()) bashrc = cand; } catch {}
    }
    // 不能放子 shell 里 source（原来的 "(source ...)" 环境变量不会传给后面的求解器）
    const sourceLine = bashrc ? `source "${bashrc}"` : `source "$FOAM_BASH" 2>/dev/null || true`;
    inner = `cd "${cd}" || exit 97; ${sourceLine}; ${command}`;
  }
  const { runId } = spawnTrackedRun({ kind: 'foam', cd, command, inner, ws, session, broadcast: true });
  return `[已启动求解器]\n  runId: ${runId}\n  case:  ${cd}\n  cmd:   ${command}\n下一步：所有工况都启动后，用一次 solver_wait({run_ids:[全部 runId], mode:"all", timeout_s:按预计时长}) 等到全部结束（求解器打印 End 后若收尾卡住会自动判结束；FATAL 会提前返回）。不要先做短时探测等待，也不要反复轮询。`;
}

function foamSolverStatus(runId) {
  const run = SOLVER_RUNS.get(runId);
  if (!run) return '[未知 runId]';
  const lines = run.log;
  const tail = lines.slice(-40);
  // 解析时间步：Time = 0.001
  let lastTime = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^Time\s*=\s*([\d.eE+\-]+)/);
    if (m) { lastTime = m[1]; break; }
  }
  lastTime = lastTime || run._lastTime || _redirectLastTime(run) || _demLastTime(lines);
  // 解析残差：Solving for X, Initial residual = 0.123, Final residual = 1e-7, No Iterations N
  const resLines = lines.filter(l => /Initial residual/.test(l)).slice(-20);
  const status = run.ended ? `已结束(exit=${run.exitCode})` : `运行中`;
  const dur = ((run.ended || Date.now()) - run.started) / 1000;
  return [
    `runId: ${runId}    状态: ${status}    用时: ${dur.toFixed(1)}s`,
    `case:  ${run.casePath}`,
    `cmd:   ${run.command}`,
    `当前 Time: ${lastTime || '(未识别)'}`,
    `\n--- 最近残差 (20 行) ---`,
    ...resLines,
    `\n--- 日志 tail (40 行) ---`,
    ...tail
  ].join('\n');
}

// 重定向目标文件的最后 64 KB（没有重定向或读不到时返回空串）
function _redirectTail(run) {
  const f = run.redirLog || _redirectTarget(run.command, run.casePath);
  if (!f) return '';
  let fd;
  try {
    fd = fssync.openSync(f, 'r');
    const size = fssync.fstatSync(fd).size, len = Math.min(size, 1 << 16);
    const buf = Buffer.alloc(len); fssync.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) try { fssync.closeSync(fd); } catch {} }
}
// 命令自带重定向（`> log.smoke 2>&1`）时，跟踪日志里只有退出标记：从重定向目标文件尾部取最近的 Time
function _redirectLastTime(run) {
  const f = run.redirLog || _redirectTarget(run.command, run.casePath);
  if (!f) return '';
  let fd;
  try {
    fd = fssync.openSync(f, 'r');
    const size = fssync.fstatSync(fd).size, len = Math.min(size, 1 << 20);
    const buf = Buffer.alloc(len); fssync.readSync(fd, buf, 0, len, size - len);
    const ms = buf.toString('utf8').match(/^Time\s*=\s*([\d.eE+\-]+)/gm);
    return ms ? ms[ms.length - 1].replace(/^Time\s*=\s*/, '') : '';
  } catch { return ''; } finally { if (fd !== undefined) try { fssync.closeSync(fd); } catch {} }
}
// 求解器在最后一个 "Time =" 之后打印了 End → 计算本身完成（twoPhaseEulerFoam v2306 等会在 End 后析构时 abort，exit=134）
// LIGGGHTS/LAMMPS thermo：表头含 Time 列（"Step Time Atoms ..."），取最后一行数值行的 Time；没有 Time 列返回 ''
function _demLastTime(lines) {
  let row = null;
  for (let i = lines.length - 1, n = 0; i >= 0 && n < 4000; i--, n++) {
    const t = String(lines[i]).trim().split(/\s+/);
    if (!row && t.length >= 2 && /^\d+$/.test(t[0]) && t.every(x => /^[-+]?[\d.]+(e[-+]?\d+)?$/i.test(x))) { row = t; continue; }
    if (row && t[0] === 'Step') { const k = t.indexOf('Time'); return k > 0 && row.length === t.length ? row[k] : ''; }
  }
  return '';
}
function _endedCleanly(log) {
  for (let i = log.length - 1; i >= 0; i--) {
    const l = String(log[i]).replace(/^\[\d+\]\s*/, '').trim();
    if (l === 'End') return true;
    if (/^Time\s*=/.test(l)) return false;
  }
  return false;
}
function _runSummary(run, tailN) {
  let lastTime = '';
  for (let i = run.log.length - 1; i >= 0; i--) { const m = run.log[i].match(/^Time\s*=\s*([\d.eE+\-]+)/); if (m) { lastTime = m[1]; break; } }
  lastTime = lastTime || run._lastTime || _redirectLastTime(run) || _demLastTime(run.log);
  const dur = ((run.ended || Date.now()) - run.started) / 1000;
  let st = run.ended ? `已结束 exit=${run.exitCode}` : '运行中';
  if (run.endAbort) st += `（求解器已打印 End，原始退出码 ${run.rawExitCode} 来自 End 之后的析构/MPI 收尾，已按正常完成处理，结果有效，不要重算）`;
  else if (run.ended && run.exitCode !== 0 && (_endedCleanly(run.log) || _endedCleanly(_redirectTail(run).split('\n')))) st += '（日志在最后一个时间步之后已打印 End：计算正常完成，非零退出来自 End 之后的析构/MPI 收尾，结果有效，不要重算）';
  const hl = run._health ? `\n⚠ 健康监视判定发散 @Time=${run._health.time}：${run._health.reason}（已写出发散时刻场，controlDict 已自动恢复）` : '';
  return `### ${run.runId} [${run.kind || 'foam'}] ${st} 用时=${dur.toFixed(0)}s Time=${lastTime || '?'}${hl}\ncase=${run.casePath}\n` + run.log.slice(-tailN).join('\n');
}

// 工作区内正在跑的求解器进程数（argv0 以 Foam 结尾，cwd 在 root 下）；仅 Linux
// /proc 里 argv0 以 Foam 结尾的进程快照（pid, argv, cwd）；同一秒内多处调用共享一次扫描
let _foamSnap = { t: 0, list: [] };
function _foamProcSnapshot(maxAgeMs = 2000) {
  if (Date.now() - _foamSnap.t < maxAgeMs) return _foamSnap.list;
  const list = [];
  try {
    for (const d of fssync.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const argv = fssync.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').filter(Boolean);
        if (!argv.length || !/Foam$|^lmp_\w+$|^liggghts\w*$/.test(path.basename(argv[0]))) continue;
        list.push({ pid: Number(d), argv, cwd: fssync.readlinkSync(`/proc/${d}/cwd`) });
      } catch {}
    }
  } catch {}
  _foamSnap = { t: Date.now(), list };
  return list;
}
function _solversUnder(root, maxAgeMs) {
  let n = 0;
  for (const p of _foamProcSnapshot(maxAgeMs)) if (p.cwd === root || p.cwd.startsWith(root + path.sep)) n++;
  return n;
}
// 可提前唤醒的 sleep：开始时工作区有求解器在跑、之后全部退出 → 立刻返回；中止/用户插话也立刻返回
async function _wakeableSleep(ms, session) {
  const root = path.resolve(WORKSPACE);
  const had = _solversUnder(root);
  const t0 = Date.now();
  return await new Promise(resolve => {
    const iv = setInterval(() => {
      const left = ms - (Date.now() - t0);
      if (left <= 0) { clearInterval(iv); return resolve({ woke: false, left: 0 }); }
      if (session && session.aborted) { clearInterval(iv); return resolve({ woke: true, left, why: '已中止' }); }
      if (session && Array.isArray(session._steerQueue) && session._steerQueue.length) { clearInterval(iv); return resolve({ woke: true, left, why: '用户插入了新消息' }); }
      if (had > 0 && _solversUnder(root) === 0) { clearInterval(iv); return resolve({ woke: true, left, why: '工作区内求解器已全部退出' }); }
    }, 5000);
  });
}

async function solverWait(args, session) {
  const ids = (args.run_ids || []).map(String);
  const runs = ids.map(id => SOLVER_RUNS.get(id));
  const unknown = ids.filter((id, i) => !runs[i]);
  if (unknown.length) {
    const avail = [...SOLVER_RUNS.values()].map(r => `${r.runId}${r.ended ? '(已结束)' : '(运行中)'} ${r.casePath}`).slice(-20).join('\n  ');
    return `[solver_wait] 未知 runId: ${unknown.join(', ')}。可用：\n  ${avail || '(无)'}`;
  }
  const mode = args.mode === 'all' ? 'all' : 'any';
  let tsec = Math.min(Math.max(Number(args.timeout_s) || 3600, 1), 43200);
  // 短时探测（≤300 s 且无 until_regex）对已稳定运行的作业没有信息量，只烧一步：抬到 1800 s（FATAL / End 仍会提前返回）
  let bumped = '';
  if (tsec <= 300 && !args.until_regex && !args.allow_short && runs.every(r => !r.ended && (r._lastTime || r.log.some(l => /^Time\s*=/.test(l)) || _demLastTime(r.log)))) {
    bumped = ` （timeout_s=${tsec} 太短，作业均已进入时间步，已自动延长到 1800 s；需要短等待请传 allow_short:true）`; tsec = 1800;
  }
  const timeoutMs = tsec * 1000;
  const tailN = Math.min(Math.max(Number(args.tail_lines) || 15, 0), 200);
  let re = null;
  if (args.until_regex) { try { re = new RegExp(args.until_regex, 'm'); } catch (e) { return `[solver_wait] until_regex 非法: ${e.message}`; } }
  // 求解器打印 End 后卡在析构/MPI 收尾（日志 60 s 不再增长）：计算已完成，按结束处理并收掉进程
  const HANG_MS = Number(process.env.END_HANG_MS) || 60_000;
  const settleHung = () => {
    for (const r of runs) {
      if (r.ended || r.external) continue;
      const n = r._lineNo || 0;
      if (n !== r._hangN) { r._hangN = n; r._hangT = Date.now(); continue; }
      if (Date.now() - (r._hangT || Date.now()) < HANG_MS) continue;
      if (!(_endedCleanly(r.log) || _endedCleanly(_redirectTail(r).split('\n')))) continue;
      r._markExit = 0; r.endAbort = true; r.rawExitCode = 'hang'; r.log.push('[CFDriver] End 之后进程 60 s 无输出，判定计算已完成，回收残留进程');
      try { killRunTree(r); setTimeout(() => { if (!r.ended) { killRunTree(r, true); setTimeout(() => { if (!r.ended) _finishRun(r, 0); }, 3000); } }, 3000); } catch {}
    }
  };
  const fatal = () => runs.find(r => r.ended && r.exitCode !== 0 && r.exitCode != null);
  const done = () => mode === 'all' ? (runs.every(r => r.ended) || !!fatal()) : runs.some(r => r.ended);
  const why2 = () => (mode === 'all' && fatal() && !runs.every(r => r.ended)) ? `failed(${fatal().runId})` : 'ended';
  const t0 = Date.now();
  const cursors = runs.map(r => r._lineNo || 0);
  let why = done() ? 'already_ended' : '';
  if (why) for (const r of runs) if (r.ended) r._reported = true;
  if (!why) {
    why = await new Promise(resolve => {
      let iv = null, to = null;
      // agent 已亲眼看到结果 → 标记 _reported，避免再触发自动唤醒（emit 同步调用本回调，先于 _scheduleWake）
      const finish = (w) => { clearInterval(iv); clearTimeout(to); SOLVER_EVENTS.off('ended', onEnd); for (const r of runs) if (r.ended) r._reported = true; resolve(w); };
      // mode=all 时其中一个先结束：它的结果本次 solver_wait 返回时就会带上，标记 _reported，
      // 免得自动唤醒往引导队列里塞一条"作业结束"把整个等待提前打断（emit 同步调用，先于 _scheduleWake）
      const onEnd = (id) => {
        if (!ids.includes(id)) return;
        if (done()) return finish(why2());
        const r = SOLVER_RUNS.get(id); if (r) r._reported = true;
      };
      SOLVER_EVENTS.on('ended', onEnd);
      to = setTimeout(() => finish('timeout'), timeoutMs);
      iv = setInterval(() => {
        if (session.aborted) return finish('aborted');
        if (done()) return finish(why2());
        // 只有用户本人的引导才打断等待；系统生成的"作业结束"通知不打断 mode=all（结果会一并返回）
        if (Array.isArray(session._steerQueue) && session._steerQueue.some(q => !q.system)) return finish('steer');
        settleHung();
        if (!re) return;
        for (let k = 0; k < runs.length; k++) {
          const r = runs[k], log = r.log, total = r._lineNo || 0;
          // 用绝对行号游标：log 被截到 4000 行后下标会平移，按 total-log.length 换算，不重复也不漏扫
          const base = total - log.length;
          const from = Math.max(0, cursors[k] - base);
          for (let i = from; i < log.length; i++) if (re.test(log[i])) { cursors[k] = base + i + 1; return finish(`matched(${r.runId}): ${log[i].slice(0, 160)}`); }
          cursors[k] = total;
        }
      }, 1000);
    });
  }
  const waited = ((Date.now() - t0) / 1000).toFixed(0);
  const left = runs.filter(r => !r.ended).map(r => r.runId);
  const hint = left.length && why !== 'steer' && why !== 'aborted' ? `\n仍在运行: ${left.join(', ')}${why.startsWith('failed') ? '（有作业失败，先诊断它；其余作业不受影响，不要停掉）' : ''}` : '';
  return `[solver_wait] reason=${why} waited=${waited}s mode=${mode}${bumped}${hint}\n` + runs.map(r => _runSummary(r, tailN)).join('\n\n');
}

function foamSolverStop(runId) {
  const run = SOLVER_RUNS.get(runId);
  if (!run) return '[未知 runId]';
  if (run.ended) return '[已结束]';
  run._userStopped = true; killRunTree(run);
  setTimeout(() => { if (!run.ended) killRunTree(run, true); }, 3000);
  return `[已发送终止信号 runId=${runId}]`;
}
// 启动后最多等 EARLY_WAIT_S（默认 25 s）：进入时间步 / 提前失败 / 仍在初始化，三种情况直接告诉智能体，免去短时探测等待
async function _earlyStatus(startedMsg, session) {
  const m = /runId:\s*(\w+)/.exec(startedMsg || '');
  const run = m && SOLVER_RUNS.get(m[1]);
  if (!run) return '';
  const lim = (Number(process.env.EARLY_WAIT_S) || 25) * 1000, t0 = Date.now();
  const stepped = () => run.log.some(l => /^Time\s*=/.test(l)) || !!run._lastTime || !!_redirectLastTime(run) || !!_demLastTime(run.log);
  while (Date.now() - t0 < lim && !run.ended && !stepped() && !(session && session.aborted)) await new Promise(r => setTimeout(r, 1000));
  const s = ((Date.now() - t0) / 1000).toFixed(0);
  if (run.ended) run._seenEnded = true;
  if (run.ended) return `\n[启动检查 ${s}s] ⚠ 作业已退出 exit=${run.exitCode}，日志尾：\n${run.log.slice(-25).join('\n')}`;
  if (stepped()) return `\n[启动检查 ${s}s] ✓ 已进入时间步（Time=${run._lastTime || _redirectLastTime(run) || _demLastTime(run.log) || '?'}），运行正常。`;
  return `\n[启动检查 ${s}s] 仍在初始化（尚未出现 Time =），未见报错。`;
}
// 智能体用：发信号后等到作业确实结束、算例目录下没有残留求解器进程再返回，省掉 pgrep/ps 自查
async function foamSolverStopWait(runId) {
  const msg = foamSolverStop(runId);
  const run = SOLVER_RUNS.get(runId);
  if (!run) return msg;
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    const left = process.platform === 'linux' ? _solversUnder(run.casePath, 0) : 0;
    if (run.ended && left === 0) return `${msg}\n[已确认] 作业已结束，算例目录下无残留求解器进程（${((Date.now() - t0) / 1000).toFixed(1)} s）。可直接修改并重新启动。`;
    if (Date.now() - t0 > 6000 && left > 0) killRunTree(run, true);
    await new Promise(r => setTimeout(r, 500));
  }
  const left = process.platform === 'linux' ? _solversUnder(run.casePath, 0) : 0;
  return `${msg}\n[注意] 20 s 后仍有 ${left} 个求解器进程在 ${run.casePath} 下（ended=${!!run.ended}）。`;
}

// ====================== 进度估算（求解器 Time / snappyHexMesh 阶段） ======================
async function _readEndTimeFromControlDict(casePath) {
  try {
    const cd = path.join(casePath, 'system', 'controlDict');
    const txt = await fs.readFile(cd, 'utf8');
    const m = txt.match(/^\s*endTime\s+([\d.eE+\-]+)\s*;/m);
    const m2 = txt.match(/^\s*startTime\s+([\d.eE+\-]+)\s*;/m);
    return { endTime: m ? Number(m[1]) : null, startTime: m2 ? Number(m2[1]) : 0 };
  } catch { return { endTime: null, startTime: 0 }; }
}

// 判断当前 command 属于哪一类工具：solver / snappy / blockMesh / 其他
function _classifyFoamCommand(cmd) {
  const s = String(cmd || '').toLowerCase();
  if (/snappyhexmesh/.test(s)) return 'snappy';
  if (/blockmesh|surfacefeature|extrudemesh|topo/.test(s)) return 'mesher';
  if (/foam$|simple|pimple|piso|ico|inter|rho|chthsf|laplacian|scalartransport|reactingfoam|interisofoam|dnsfoam|sonicfoam|buoyant|lmp_|liggghts/.test(s)) return 'solver';
  return 'other';
}

// snappyHexMesh 三大阶段的标志
function _snappyPhase(log) {
  // 反向扫描最近 200 行，找最新的阶段
  const tail = log.slice(-400);
  let phase = 'starting', percent = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const l = tail[i];
    if (/Layer addition iteration/i.test(l) || /Doing final layer addition/i.test(l) || /Layer addition phase/i.test(l)) { phase = 'layer'; percent = 85; break; }
    if (/Shell refinement iteration|Surface refinement iteration|Refinement phase/i.test(l)) { phase = 'castellated'; percent = 30; break; }
    if (/Morph iteration|Snapping iteration|Snapping phase/i.test(l)) { phase = 'snap'; percent = 65; break; }
    if (/Adding patches/i.test(l)) { phase = 'finalize'; percent = 95; break; }
  }
  if (/^Finished meshing/m.test(tail.join('\n'))) { phase = 'done'; percent = 100; }
  return { phase, percent };
}

async function _computeRunProgress(run) {
  const cls = _classifyFoamCommand(run.command);
  const wallSec = ((run.ended || Date.now()) - run.started) / 1000;
  const out = { kind: cls, wallSec, percent: null, phase: null, currentTime: null, endTime: null, etaSec: null, simRate: null };
  if (cls === 'solver') {
    // 缓存 endTime
    if (run._endTime === undefined) {
      const r = await _readEndTimeFromControlDict(run.casePath);
      run._endTime = r.endTime; run._startTime = r.startTime;
    }
    out.endTime = run._endTime;
    // 找出所有 Time = X 出现的位置，估算 sim/wall 速率
    let firstTime = null, lastTime = null, firstWall = null, lastWall = null;
    // 我们没有逐行时间戳；用 run.started 当起点，比例插值
    for (let i = run.log.length - 1; i >= 0; i--) {
      const m = run.log[i].match(/^Time\s*=\s*([\d.eE+\-]+)/);
      if (m) { lastTime = Number(m[1]); break; }
    }
    for (let i = 0; i < run.log.length; i++) {
      const m = run.log[i].match(/^Time\s*=\s*([\d.eE+\-]+)/);
      if (m) { firstTime = Number(m[1]); break; }
    }
    out.currentTime = lastTime;
    if (lastTime != null && out.endTime != null && out.endTime > (run._startTime || 0)) {
      const total = out.endTime - (run._startTime || 0);
      const done  = lastTime - (run._startTime || 0);
      if (total > 0 && done >= 0) out.percent = Math.min(100, Math.max(0, (done / total) * 100));
      // 简单速率：(lastTime - firstTime) / wallSec
      if (firstTime != null && lastTime > firstTime && wallSec > 1) {
        const simRate = (lastTime - firstTime) / wallSec;  // sim_time per wall_sec
        out.simRate = simRate;
        if (simRate > 0) out.etaSec = Math.max(0, (out.endTime - lastTime) / simRate);
      }
    }
    out.phase = run.ended ? 'finished' : 'running';
  } else if (cls === 'snappy') {
    const ph = _snappyPhase(run.log);
    out.phase = ph.phase; out.percent = ph.percent;
    // 经验 ETA：根据已用时间和当前阶段反推
    const phaseFraction = ph.percent / 100;
    if (phaseFraction > 0.05 && !run.ended) {
      out.etaSec = Math.max(0, wallSec * (1 - phaseFraction) / phaseFraction);
    }
  } else if (cls === 'mesher') {
    out.phase = run.ended ? 'finished' : 'running';
    // blockMesh 通常很快，没有可靠进度，给个占位
    out.percent = run.ended ? 100 : null;
  } else {
    out.phase = run.ended ? 'finished' : 'running';
  }
  return out;
}

// ============== STL 几何检查（ASCII / Binary 自动识别）==============
// ============== 几何工具：射线-三角形相交 + 点是否在 STL 内 ==============
// Möller–Trumbore 算法，返回 true 表示与三角形相交（从 ray 原点沿 +X 方向）
function _rayHitsTriPlusX(p, t) {
  const EPS = 1e-12;
  const v0 = t[0], v1 = t[1], v2 = t[2];
  // ray 方向 (1,0,0)
  const e1 = [v1[0]-v0[0], v1[1]-v0[1], v1[2]-v0[2]];
  const e2 = [v2[0]-v0[0], v2[1]-v0[1], v2[2]-v0[2]];
  // h = dir × e2 = (0,0,0)×e2 = (0*e2[2]-0*e2[1], 0*e2[0]-1*e2[2], 1*e2[1]-0*e2[0]) = (0, -e2[2], e2[1])
  const h = [0, -e2[2], e2[1]];
  const a = e1[0]*h[0] + e1[1]*h[1] + e1[2]*h[2];
  if (Math.abs(a) < EPS) return false;
  const fInv = 1/a;
  const s = [p[0]-v0[0], p[1]-v0[1], p[2]-v0[2]];
  const u = fInv * (s[0]*h[0] + s[1]*h[1] + s[2]*h[2]);
  if (u < 0 || u > 1) return false;
  // q = s × e1
  const q = [s[1]*e1[2]-s[2]*e1[1], s[2]*e1[0]-s[0]*e1[2], s[0]*e1[1]-s[1]*e1[0]];
  // v = fInv * (dir · q) = fInv * q[0]
  const v = fInv * q[0];
  if (v < 0 || u + v > 1) return false;
  // t = fInv * (e2 · q)
  const tHit = fInv * (e2[0]*q[0] + e2[1]*q[1] + e2[2]*q[2]);
  return tHit > EPS;
}
function _pointInsideMesh(tris, p) {
  let hits = 0;
  for (const t of tris) if (_rayHitsTriPlusX(p, t)) hits++;
  return (hits & 1) === 1;
}
// 在 bbox 网格上采样找最优"内部种子"和"外部种子"（外部=离表面最远的外点）
function _findSeeds(tris, bbMin, bbMax) {
  const size = [bbMax[0]-bbMin[0], bbMax[1]-bbMin[1], bbMax[2]-bbMin[2]];
  const N = 7; // 7^3 = 343 采样
  const internal = [];
  const external = [];
  for (let i = 1; i < N-1; i++)
    for (let j = 1; j < N-1; j++)
      for (let k = 1; k < N-1; k++) {
        const p = [bbMin[0] + size[0]*i/(N-1), bbMin[1] + size[1]*j/(N-1), bbMin[2] + size[2]*k/(N-1)];
        if (_pointInsideMesh(tris, p)) internal.push(p);
        else external.push(p);
      }
  // 选离质心最近的内部点作为 internal_seed（最稳）
  const cx = (bbMin[0]+bbMax[0])/2, cy = (bbMin[1]+bbMax[1])/2, cz = (bbMin[2]+bbMax[2])/2;
  const dist2 = (a,b) => (a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2;
  internal.sort((a,b) => dist2(a,[cx,cy,cz]) - dist2(b,[cx,cy,cz]));
  // 外部种子：bbox 外的"明显在外"点（沿 +X 偏移 maxDim）
  const maxDim = Math.max(...size);
  const externalSeed = [bbMax[0] + maxDim*0.2, cy, cz];
  return {
    internal_seed: internal.length ? internal[0] : null,
    external_seed: externalSeed,
    internal_sample_count: internal.length,
    external_sample_count: external.length,
    is_internal_flow_friendly: internal.length > external.length * 0.5 // STL 内部空间大→可能是容器/管道（内流场）
  };
}

async function foamStlInspect(stlPath) {
  if (!stlPath) throw new Error('stl_path 必填');
  const f = path.isAbsolute(stlPath) ? stlPath : path.resolve(WORKSPACE, stlPath);
  const buf = await fs.readFile(f);
  const head = buf.slice(0, Math.min(80, buf.length)).toString('ascii').toLowerCase();
  let tris = [];
  // ASCII STL：以 "solid" 开头但要确认是文本
  const looksAscii = head.startsWith('solid') && buf.includes(Buffer.from('facet normal'));
  if (looksAscii) {
    const txt = buf.toString('utf8');
    const re = /vertex\s+([\-\deE.+]+)\s+([\-\deE.+]+)\s+([\-\deE.+]+)/g;
    let m, verts = [];
    while ((m = re.exec(txt)) !== null) verts.push([+m[1], +m[2], +m[3]]);
    for (let i = 0; i + 2 < verts.length; i += 3) tris.push([verts[i], verts[i+1], verts[i+2]]);
  } else {
    // Binary：80 字节头 + uint32 数 + 50 字节/三角形
    if (buf.length < 84) throw new Error('STL 文件过小');
    const n = buf.readUInt32LE(80);
    if (84 + n * 50 !== buf.length) {
      // 兼容尾部多余字节但小于 50；至少检验 n 合理
      if (n * 50 + 84 > buf.length) throw new Error(`STL 三角形数声明 ${n} 与文件大小不一致`);
    }
    let p = 84;
    for (let i = 0; i < n; i++) {
      // 跳过法向量 12 字节
      const v0 = [buf.readFloatLE(p+12), buf.readFloatLE(p+16), buf.readFloatLE(p+20)];
      const v1 = [buf.readFloatLE(p+24), buf.readFloatLE(p+28), buf.readFloatLE(p+32)];
      const v2 = [buf.readFloatLE(p+36), buf.readFloatLE(p+40), buf.readFloatLE(p+44)];
      tris.push([v0, v1, v2]);
      p += 50;
    }
  }
  if (!tris.length) return '[STL 解析失败：未读到三角形]';
  // bbox / centroid / 面积近似 / 体积（Σ v0·(v1×v2)/6 带符号）
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let cx = 0, cy = 0, cz = 0, area = 0, vol = 0;
  for (const t of tris) {
    for (const v of t) {
      for (let k = 0; k < 3; k++) { if (v[k] < min[k]) min[k] = v[k]; if (v[k] > max[k]) max[k] = v[k]; }
      cx += v[0]; cy += v[1]; cz += v[2];
    }
    const a = t[0], b = t[1], c = t[2];
    const ab = [b[0]-a[0], b[1]-a[1], b[2]-a[2]];
    const ac = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
    const cr = [ab[1]*ac[2]-ab[2]*ac[1], ab[2]*ac[0]-ab[0]*ac[2], ab[0]*ac[1]-ab[1]*ac[0]];
    area += 0.5 * Math.hypot(cr[0], cr[1], cr[2]);
    vol += (a[0]*(b[1]*c[2]-b[2]*c[1]) - a[1]*(b[0]*c[2]-b[2]*c[0]) + a[2]*(b[0]*c[1]-b[1]*c[0])) / 6;
  }
  const nv = tris.length * 3;
  const cent = [cx/nv, cy/nv, cz/nv];
  const size = [max[0]-min[0], max[1]-min[1], max[2]-min[2]];
  const maxDim = Math.max(...size);
  const minDim = Math.min(...size);
  const recCell = +(maxDim / 30).toPrecision(3);
  // 单位推测：所有坐标绝对值都很小 (<0.01) 可能是米；若 1~10 m 可能是米；几十~几千更可能是 mm
  let unitGuess = '不确定';
  if (maxDim < 0.05) unitGuess = '可能为 m（极小物体）';
  else if (maxDim < 50) unitGuess = '可能为 m';
  else if (maxDim < 5000) unitGuess = '可能为 mm（建议 surfaceTransformPoints -scale 0.001 转 m）';
  // —— v6 薄壁特征长度估算：取所有三角形最短边的 5% / 50% 分位数 ——
  const shortEdges = [];
  for (const t of tris) {
    const a = t[0], b = t[1], c = t[2];
    const eAB = Math.hypot(b[0]-a[0], b[1]-a[1], b[2]-a[2]);
    const eBC = Math.hypot(c[0]-b[0], c[1]-b[1], c[2]-b[2]);
    const eCA = Math.hypot(a[0]-c[0], a[1]-c[1], a[2]-c[2]);
    shortEdges.push(Math.min(eAB, eBC, eCA));
  }
  shortEdges.sort((a,b)=>a-b);
  const q05 = shortEdges[Math.floor(shortEdges.length*0.05)] || 0;
  const q50 = shortEdges[Math.floor(shortEdges.length*0.50)] || 0;
  // —— 几何种子：内部点 / 外部点（snappy locationInMesh 用） ——
  let seeds = { internal_seed:null, external_seed:null, internal_sample_count:0, external_sample_count:0, is_internal_flow_friendly:false };
  try {
    // tris 数量大时降采样，加速点云内外测试
    const sampleTris = tris.length > 4000 ? (() => {
      const step = Math.ceil(tris.length / 4000);
      const sub = []; for (let i = 0; i < tris.length; i += step) sub.push(tris[i]); return sub;
    })() : tris;
    seeds = _findSeeds(sampleTris, min, max);
  } catch {}
  return JSON.stringify({
    type: looksAscii ? 'ascii' : 'binary',
    file: path.relative(WORKSPACE, f) || f,
    triangles: tris.length,
    bbox_min: min.map(x => +x.toPrecision(6)),
    bbox_max: max.map(x => +x.toPrecision(6)),
    bbox_size: size.map(x => +x.toPrecision(6)),
    max_dim: +maxDim.toPrecision(6),
    min_dim: +minDim.toPrecision(6),
    centroid: cent.map(x => +x.toPrecision(6)),
    surface_area: +area.toPrecision(6),
    signed_volume: +vol.toPrecision(6),
    closed_estimate: Math.abs(vol) > 1e-9 ? '近似封闭' : '可能不封闭',
    unit_guess: unitGuess,
    recommend_cell_size: recCell,
    recommend_blockmesh_padding: +(maxDim * 1.5).toPrecision(3),
    recommend_location_in_mesh: seeds.internal_seed
      ? seeds.internal_seed.map(x => +x.toPrecision(6))
      : [ +(cent[0]).toPrecision(4), +(cent[1]).toPrecision(4), +(max[2] + size[2] * 0.1).toPrecision(4) ],
    // v6 新增字段：用于 foam_mesh_plan v2 自动决策
    narrow_feature_q05: +q05.toPrecision(4),       // 最细 5% 边长（薄壁/小特征指示）
    narrow_feature_q50: +q50.toPrecision(4),       // 中位边长
    internal_seed: seeds.internal_seed ? seeds.internal_seed.map(x => +x.toPrecision(6)) : null,
    external_seed: seeds.external_seed ? seeds.external_seed.map(x => +x.toPrecision(6)) : null,
    internal_sample_count: seeds.internal_sample_count,
    external_sample_count: seeds.external_sample_count,
    is_likely_internal_flow: seeds.is_internal_flow_friendly,
    domain_type_hint: seeds.is_internal_flow_friendly
      ? '建议 domain.type=internal（流体在 STL 内部）'
      : '建议 domain.type=external（流体在 STL 外，绕物体流动）'
  }, null, 2);
}

// ============== 自动生成 blockMesh + snappyHexMesh + surfaceFeatures 草案（v6 史诗增强版）==============
//
// 核心升级：
//   1) 引入 domain 显式参数（external / internal / box / wrap）—— 计算域不再"瞎猜"，必须告诉它流体在哪
//   2) surfaces[] 多 STL/多 patch + 每 patch 独立 refinement level + 距离场 refinementRegions
//   3) first_layer_thickness 走绝对值（米），不再依赖背景 cell；自动校验薄壁不被层覆盖
//   4) 质量参数全面紧化：nCellsBetweenLevels 5、resolveFeatureAngle 25、nFeatureSnapIter 15、nSolveIter 50
//   5) locationInMesh 优先用 STL 射线测试得到的 internal_seed/external_seed（避免切反）
//   6) 边界层加 relaxedIter + relaxed{} 子块兜底（即使边角不达标也能加完）
//   7) 多 patch 时自动 patch_name 切割
//
// strategy 档位（兼容）：default | coarsen | minimal | box_stl
async function foamMeshPlan(args) {
  let {
    case_path, stl_path, target_cell_size,
    refinement_level_min = 1, refinement_level_max = 3,
    n_layers = 0, location_in_mesh, flow_direction = 'x', strategy = 'default',
    // —— v6 新增参数（全部可选；向后兼容）——
    domain,               // {type:'external'|'internal'|'box'|'wrap', ...} 见下
    surfaces,             // [{file, patch_name, level:[min,max], layers, region:{mode,distances,levels}}]
    first_layer_thickness,// 绝对米数；优先于 finalLayerThickness/relativeSizes
    feature_level,        // 默认 = max(surface levels)
    n_cells_between_levels = 5,
    resolve_feature_angle = 25,
    expansion_ratio = 1.2,
    max_global_cells = 8000000,
  } = args;
  // —— 策略调参 —— //
  const _strategyApplied = strategy;
  let _snapFlag = true;
  let _addLayersFlag = (n_layers > 0) || (first_layer_thickness && first_layer_thickness > 0);
  let _writeBoxStl = false;
  if (strategy === 'coarsen') {
    if (target_cell_size) target_cell_size = target_cell_size * 1.5;
    refinement_level_max = Math.max(refinement_level_min, refinement_level_max - 1);
    n_layers = 0; _addLayersFlag = false;
  } else if (strategy === 'minimal') {
    if (target_cell_size) target_cell_size = target_cell_size * 2;
    refinement_level_min = 0;
    refinement_level_max = 1;
    n_layers = 0; _addLayersFlag = false;
    _snapFlag = false;
  } else if (strategy === 'box_stl') {
    _writeBoxStl = true;
  }
  if (!case_path) throw new Error('case_path 必填');
  // 主 STL 路径来自 stl_path 或 surfaces[0].file
  if (!stl_path && (!surfaces || !surfaces.length)) throw new Error('stl_path 或 surfaces[] 至少给一个');
  const cd = path.isAbsolute(case_path) ? case_path : path.resolve(WORKSPACE, case_path);
  await fs.mkdir(cd, { recursive: true });
  await fs.mkdir(path.join(cd, 'system'), { recursive: true });
  await fs.mkdir(path.join(cd, 'constant', 'triSurface'), { recursive: true });

  // —— 规整 surfaces 列表（兼容旧的单 STL 路径）——
  const surfList = (surfaces && surfaces.length) ? surfaces.slice() : [{
    file: stl_path,
    patch_name: null,
    level: [refinement_level_min, refinement_level_max],
    layers: n_layers,
    region: null
  }];
  // 复制所有 STL 到 case 并 inspect 第一个
  const surfInfos = [];
  for (const s of surfList) {
    if (!s.file) throw new Error('surfaces[].file 必填');
    const abs = path.isAbsolute(s.file) ? s.file : path.resolve(WORKSPACE, s.file);
    const name = path.basename(abs);
    const dst = path.join(cd, 'constant', 'triSurface', name);
    await fs.copyFile(abs, dst);
    const info = JSON.parse(await foamStlInspect(abs));
    const base = name.replace(/\.stl$/i, '');
    const patch = s.patch_name || base;
    const lvl = (s.level && s.level.length === 2) ? s.level : [refinement_level_min, refinement_level_max];
    surfInfos.push({ abs, name, base, patch, info, level: lvl, layers: s.layers || 0, region: s.region || null });
  }
  const mainInfo = surfInfos[0].info;
  const [minX, minY, minZ] = mainInfo.bbox_min;
  const [maxX, maxY, maxZ] = mainInfo.bbox_max;
  const [sx, sy, sz] = mainInfo.bbox_size;
  const maxDim = Math.max(sx, sy, sz);
  const cell = +(target_cell_size || mainInfo.recommend_cell_size);

  // —— 决定 domain 类型 ——
  if (!domain) {
    // 没显式给，用 STL 内/外采样投票
    if (mainInfo.is_likely_internal_flow) domain = { type: 'internal' };
    else domain = { type: 'wrap' }; // 旧行为
  }
  const dt = domain.type || 'wrap';
  let bbMin, bbMax;
  if (dt === 'box') {
    if (!Array.isArray(domain.bbox_min) || !Array.isArray(domain.bbox_max))
      throw new Error('domain.type=box 时必须给 bbox_min[3] / bbox_max[3]（米）');
    bbMin = domain.bbox_min.slice();
    bbMax = domain.bbox_max.slice();
  } else if (dt === 'internal') {
    // STL 即外壁；背景域贴 bbox + 极小 padding（保证 blockMesh 包住整个 STL 即可）
    const pad = domain.padding != null ? domain.padding : 0.02 * maxDim;
    bbMin = [minX - pad, minY - pad, minZ - pad];
    bbMax = [maxX + pad, maxY + pad, maxZ + pad];
  } else if (dt === 'external') {
    // 外流场：按方向给上/下游/侧/顶/底倍数（以 maxDim 为单位）
    const up   = domain.upstream   != null ? domain.upstream   : 5;
    const down = domain.downstream != null ? domain.downstream : 10;
    const lat  = domain.lateral    != null ? domain.lateral    : 5;
    const top  = domain.vertical_top    != null ? domain.vertical_top    : (lat);
    const bot  = domain.vertical_bottom != null ? domain.vertical_bottom : (lat);
    if (flow_direction === 'x') {
      bbMin = [minX - up*maxDim, minY - lat*maxDim, minZ - bot*maxDim];
      bbMax = [maxX + down*maxDim, maxY + lat*maxDim, maxZ + top*maxDim];
    } else if (flow_direction === 'y') {
      bbMin = [minX - lat*maxDim, minY - up*maxDim, minZ - bot*maxDim];
      bbMax = [maxX + lat*maxDim, maxY + down*maxDim, maxZ + top*maxDim];
    } else {
      bbMin = [minX - lat*maxDim, minY - lat*maxDim, minZ - up*maxDim];
      bbMax = [maxX + lat*maxDim, maxY + lat*maxDim, maxZ + down*maxDim];
    }
  } else {
    // wrap (兼容旧版)
    const pad = maxDim * 0.5;
    bbMin = [minX - pad, minY - pad, minZ - pad];
    bbMax = [maxX + pad, maxY + pad, maxZ + pad];
    if (flow_direction === 'x') { bbMin[0] = minX - maxDim * 1.5; bbMax[0] = maxX + maxDim * 5; }
    else if (flow_direction === 'y') { bbMin[1] = minY - maxDim * 1.5; bbMax[1] = maxY + maxDim * 5; }
    else { bbMin[2] = minZ - maxDim * 1.5; bbMax[2] = maxZ + maxDim * 5; }
  }

  // —— 单元数预算与约束：估算后限制不超过 max_global_cells ——
  let nx = Math.max(8, Math.round((bbMax[0]-bbMin[0]) / cell));
  let ny = Math.max(8, Math.round((bbMax[1]-bbMin[1]) / cell));
  let nz = Math.max(8, Math.round((bbMax[2]-bbMin[2]) / cell));
  let bgCells = nx*ny*nz;
  // 估算 snappy 后单元数：表面附近 ≈ bgCells * 4^maxLevel * (surface/volume ratio)。粗算只按背景的 10x 上限。
  const maxLvl = Math.max(...surfInfos.map(s => s.level[1]));
  const estTotal = bgCells * Math.max(1, 4 ** (maxLvl - 1));
  if (estTotal > max_global_cells) {
    // 等比放大 base cell
    const factor = Math.cbrt(estTotal / max_global_cells);
    nx = Math.max(8, Math.round(nx / factor));
    ny = Math.max(8, Math.round(ny / factor));
    nz = Math.max(8, Math.round(nz / factor));
    bgCells = nx*ny*nz;
  }
  const actualCell = ((bbMax[0]-bbMin[0])/nx + (bbMax[1]-bbMin[1])/ny + (bbMax[2]-bbMin[2])/nz) / 3;

  // —— locationInMesh ——
  let lim;
  if (location_in_mesh && location_in_mesh.length === 3) {
    lim = location_in_mesh;
  } else if (dt === 'external') {
    // 外流场：用 STL inspect 给的 external_seed（明显在外）
    lim = mainInfo.external_seed || [bbMax[0] - 0.01*maxDim, (bbMin[1]+bbMax[1])/2, (bbMin[2]+bbMax[2])/2];
  } else if (dt === 'internal') {
    // 内流场：必须用 internal_seed
    lim = mainInfo.internal_seed;
    if (!lim) throw new Error('domain.type=internal 但 STL 射线测试找不到内部点；STL 可能不封闭或法向反了。请先 foam_stl_render 检查。');
  } else {
    lim = mainInfo.recommend_location_in_mesh;
  }

  // —— patch 命名（按主流方向 / domain 类型）——
  // internal 时背景域所有 6 面默认走 wall（用户在 0/ 改）；external 走 inlet/outlet/side
  const faceNames = { x: { in: 'inlet', out: 'outlet', side: ['front','back','top','bottom'] },
                      y: { in: 'inlet', out: 'outlet', side: ['left','right','top','bottom'] },
                      z: { in: 'inlet', out: 'outlet', side: ['left','right','front','back'] } }[flow_direction];
  const fHeader = (cls, obj) => `/*--------------------------------*- C++ -*----------------------------------*\\
| Auto-generated by CFDriver foam_mesh_plan v6                             |
\\*---------------------------------------------------------------------------*/
FoamFile { version 2.0; format ascii; class ${cls}; object ${obj}; }
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
`;
  // —— blockMeshDict ——
  const f = (n) => n.toFixed(6);
  // internal 时 6 面都用 wall；其它情况按主流方向命名
  let boundaryBlock;
  if (dt === 'internal') {
    boundaryBlock =
      'xMin   { type wall; faces ((0 4 7 3)); }\n' +
      '    xMax   { type wall; faces ((1 2 6 5)); }\n' +
      '    yMin   { type wall; faces ((0 1 5 4)); }\n' +
      '    yMax   { type wall; faces ((3 7 6 2)); }\n' +
      '    zMin   { type wall; faces ((0 3 2 1)); }\n' +
      '    zMax   { type wall; faces ((4 5 6 7)); }';
  } else if (flow_direction === 'x') {
    boundaryBlock = 'inlet  { type patch; faces ((0 4 7 3)); }\n    outlet { type patch; faces ((1 2 6 5)); }\n    front  { type patch; faces ((0 1 5 4)); }\n    back   { type patch; faces ((3 7 6 2)); }\n    bottom { type wall;  faces ((0 3 2 1)); }\n    top    { type patch; faces ((4 5 6 7)); }';
  } else if (flow_direction === 'y') {
    boundaryBlock = 'inlet  { type patch; faces ((0 1 5 4)); }\n    outlet { type patch; faces ((3 7 6 2)); }\n    left   { type patch; faces ((0 4 7 3)); }\n    right  { type patch; faces ((1 2 6 5)); }\n    bottom { type wall;  faces ((0 3 2 1)); }\n    top    { type patch; faces ((4 5 6 7)); }';
  } else {
    boundaryBlock = 'inlet  { type patch; faces ((0 3 2 1)); }\n    outlet { type patch; faces ((4 5 6 7)); }\n    left   { type patch; faces ((0 4 7 3)); }\n    right  { type patch; faces ((1 2 6 5)); }\n    front  { type patch; faces ((0 1 5 4)); }\n    back   { type patch; faces ((3 7 6 2)); }';
  }
  const bmd = fHeader('dictionary','blockMeshDict') + `
convertToMeters 1;

vertices
(
    (${f(bbMin[0])} ${f(bbMin[1])} ${f(bbMin[2])})
    (${f(bbMax[0])} ${f(bbMin[1])} ${f(bbMin[2])})
    (${f(bbMax[0])} ${f(bbMax[1])} ${f(bbMin[2])})
    (${f(bbMin[0])} ${f(bbMax[1])} ${f(bbMin[2])})
    (${f(bbMin[0])} ${f(bbMin[1])} ${f(bbMax[2])})
    (${f(bbMax[0])} ${f(bbMin[1])} ${f(bbMax[2])})
    (${f(bbMax[0])} ${f(bbMax[1])} ${f(bbMax[2])})
    (${f(bbMin[0])} ${f(bbMax[1])} ${f(bbMax[2])})
);

blocks
(
    hex (0 1 2 3 4 5 6 7) (${nx} ${ny} ${nz}) simpleGrading (1 1 1)
);

edges ();

boundary
(
    ${boundaryBlock}
);

mergePatchPairs ();
`;
  // —— snappyHexMeshDict ——
  const featLvl = feature_level != null ? feature_level : maxLvl;
  // geometry 块（多 STL）
  const geomBlocks = surfInfos.map(s => `    ${s.base}
    {
        type triSurfaceMesh;
        name ${s.patch};
        file "${s.name}";
    }`).join('\n');
  // refinementSurfaces 块（每个 STL 独立 level + patchInfo）
  const refSurfBlocks = surfInfos.map(s => `        ${s.base}
        {
            level (${s.level[0]} ${s.level[1]});
            patchInfo { type wall; }
        }`).join('\n');
  // features 块（每个 STL 一条 eMesh）
  const featBlocks = surfInfos.map(s => `            { file "${s.base}.eMesh"; level ${featLvl}; }`).join('\n');
  // refinementRegions（距离场加密）
  const refRegBlocks = surfInfos.filter(s => s.region).map(s => {
    const r = s.region;
    if (r.mode === 'distance') {
      const lvls = (r.levels || []).map(([d,l]) => `(${d} ${l})`).join(' ');
      return `        ${s.base}
        {
            mode distance;
            levels ( ${lvls} );
        }`;
    } else if (r.mode === 'inside') {
      return `        ${s.base}
        {
            mode inside;
            levels ((1E15 ${r.level || s.level[1]}));
        }`;
    }
    return '';
  }).filter(Boolean).join('\n');

  // —— 边界层（绝对厚度优先，自动加 relaxed 兜底）——
  const layersPatches = surfInfos.filter(s => (s.layers && s.layers > 0) || (n_layers > 0 && surfInfos.length === 1)).map(s => {
    const nL = s.layers || n_layers;
    return `        "${s.patch}.*" { nSurfaceLayers ${nL}; }`;
  }).join('\n');
  const useAbsLayer = first_layer_thickness && first_layer_thickness > 0;
  const layersBlock = _addLayersFlag ? `
addLayersControls
{
    relativeSizes ${useAbsLayer ? 'false' : 'true'};
    layers
    {
${layersPatches || '        // (no layers configured)'}
    }
    expansionRatio ${expansion_ratio};
${useAbsLayer
  ? `    firstLayerThickness ${first_layer_thickness};
    minThickness ${(first_layer_thickness * 0.1).toExponential(3)};`
  : `    finalLayerThickness 0.4;
    minThickness 0.05;`}
    nGrow 0;
    featureAngle 130;          // 仅在折角小于此角度处生层（更宽容才能贴边角）
    slipFeatureAngle 30;
    nRelaxIter 8;              // 加多次松弛
    nSmoothSurfaceNormals 3;
    nSmoothNormals 5;
    nSmoothThickness 10;
    maxFaceThicknessRatio 0.5;
    maxThicknessToMedialRatio 0.3;
    minMedialAxisAngle 90;
    nBufferCellsNoExtrude 0;
    nLayerIter 50;
    nRelaxedIter 20;           // 失败回退用更松质量阈值（关键！）
    additionalReporting true;
}
` : `
addLayersControls
{
    relativeSizes true;
    layers {}
    expansionRatio 1.2;
    finalLayerThickness 0.4;
    minThickness 0.05;
    nGrow 0;
    featureAngle 130;
    slipFeatureAngle 30;
    nRelaxIter 5;
    nSmoothSurfaceNormals 1;
    nSmoothNormals 3;
    nSmoothThickness 10;
    maxFaceThicknessRatio 0.5;
    maxThicknessToMedialRatio 0.3;
    minMedialAxisAngle 90;
    nBufferCellsNoExtrude 0;
    nLayerIter 50;
    nRelaxedIter 20;
}
`;

  const shm = fHeader('dictionary','snappyHexMeshDict') + `
castellatedMesh true;
snap            ${_snapFlag ? 'true' : 'false'};
addLayers       ${_addLayersFlag ? 'true' : 'false'};

geometry
{
${geomBlocks}
}

castellatedMeshControls
{
    maxLocalCells   ${Math.floor(max_global_cells / 4)};
    maxGlobalCells  ${max_global_cells};
    minRefinementCells 10;
    nCellsBetweenLevels ${n_cells_between_levels};
    features
    (
${featBlocks}
    );
    refinementSurfaces
    {
${refSurfBlocks}
    }
    resolveFeatureAngle ${resolve_feature_angle};
    refinementRegions
    {
${refRegBlocks || ''}
    }
    locationInMesh (${f(lim[0])} ${f(lim[1])} ${f(lim[2])});
    allowFreeStandingZoneFaces true;
}

snapControls
{
    nSmoothPatch 5;
    tolerance 1.0;
    nSolveIter 50;
    nRelaxIter 8;
    nFeatureSnapIter 15;
    implicitFeatureSnap false;
    explicitFeatureSnap true;
    multiRegionFeatureSnap false;
}
${layersBlock}
meshQualityControls
{
    maxNonOrtho 65;
    maxBoundarySkewness 20;
    maxInternalSkewness 4;
    maxConcave 80;
    minVol 1e-13;
    minTetQuality 1e-15;
    minArea -1;
    minTwist 0.02;
    minDeterminant 0.001;
    minFaceWeight 0.05;
    minVolRatio 0.01;
    minTriangleTwist -1;
    nSmoothScale 4;
    errorReduction 0.75;
    relaxed
    {
        maxNonOrtho 75;
    }
}

writeFlags ( scalarLevels layerSets layerFields );
mergeTolerance 1e-6;
`;
  // —— surfaceFeaturesDict（OF >= 1706）/ surfaceFeatureExtractDict（旧）——
  // 多 STL 用列表
  const stlNamesList = surfInfos.map(s => `"${s.name}"`).join(' ');
  const sfd = fHeader('dictionary','surfaceFeaturesDict') + `
surfaces ( ${stlNamesList} );
includedAngle   150;
subsetFeatures
{
    nonManifoldEdges no;
    openEdges        yes;
}
writeObj            yes;
`;
  const sfeBlocks = surfInfos.map(s => `${s.name}
{
    extractionMethod    extractFromSurface;
    extractFromSurfaceCoeffs { includedAngle   150; }
    subsetFeatures { nonManifoldEdges no; openEdges yes; }
    writeObj                yes;
}`).join('\n');
  const sfedict = fHeader('dictionary','surfaceFeatureExtractDict') + sfeBlocks + '\n';

  // —— 写文件 ——
  const written = [];
  async function w(rel, content) {
    const fp = path.join(cd, rel);
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(fp, content);
    written.push(rel);
  }
  await w('system/blockMeshDict', bmd);
  await w('system/snappyHexMeshDict', shm);
  await w('system/surfaceFeaturesDict', sfd);
  await w('system/surfaceFeatureExtractDict', sfedict);

  // 策略 box_stl：额外写一个外域 box STL（可被手动加入 snappy）
  let boxStlNote = '';
  if (_writeBoxStl) {
    const boxName = 'domain_box.stl';
    const boxPath = path.join(cd, 'constant', 'triSurface', boxName);
    await writeBoxStl(boxPath, bbMin, bbMax, 'domain');
    boxStlNote = `\n额外生成: constant/triSurface/${boxName}（外域包围盒 STL，可手动加入 snappy 的 refinementRegions / 改成 internalCellZones 策略）`;
  }

  // —— 自检 & 警告 ——
  const warnings = [];
  if (dt === 'internal' && !mainInfo.is_likely_internal_flow)
    warnings.push('⚠ domain=internal 但 STL 射线测试显示内部空间偏小，请确认 STL 是封闭容器外壁，或法向反了。');
  if (dt === 'external' && mainInfo.is_likely_internal_flow)
    warnings.push('⚠ domain=external 但 STL 看起来是容器（内部空间大）。如果你想算容器内流，改 domain.type=internal。');
  if (useAbsLayer && first_layer_thickness > mainInfo.narrow_feature_q05)
    warnings.push(`⚠ first_layer_thickness=${first_layer_thickness} 大于 STL 最薄边长 5% 分位 ${mainInfo.narrow_feature_q05}，薄壁/小特征上 layer 可能失败。`);
  if (mainInfo.unit_guess && mainInfo.unit_guess.includes('mm'))
    warnings.push(`⚠ STL 单位疑似 mm（max_dim=${mainInfo.max_dim}），建议先 surfaceTransformPoints -scale 0.001。`);

  return [
    `[\u5df2\u751f\u6210\u7f51\u683c\u65b9\u6848 v6] case=${path.relative(WORKSPACE, cd) || cd}  策略=${_strategyApplied}  domain=${dt}`,
    ``,
    `STL：${surfInfos.length} 个 (` + surfInfos.map(s=>s.name).join(', ') + `)`,
    `主 STL 摘要：tris=${mainInfo.triangles}, bbox=${mainInfo.bbox_size.join('×')}, 单位=${mainInfo.unit_guess}, 最薄边长 q05=${mainInfo.narrow_feature_q05}`,
    `计算域 bbox: (${bbMin.map(x=>x.toFixed(3)).join(', ')}) → (${bbMax.map(x=>x.toFixed(3)).join(', ')})`,
    `背景网格: ${nx}×${ny}×${nz} = ${bgCells.toLocaleString()} cells (cell≈${actualCell.toFixed(4)} m)`,
    `表面加密: ` + surfInfos.map(s=>`${s.patch} L${s.level[0]}-${s.level[1]}`).join('; '),
    `feature_level=${featLvl}, nCellsBetweenLevels=${n_cells_between_levels}, resolveFeatureAngle=${resolve_feature_angle}°`,
    `snap: nFeatureSnapIter=15, nSolveIter=50, tolerance=1.0 (尖角保留参数已紧化)`,
    `边界层: ${_addLayersFlag ? (useAbsLayer ? `firstLayerThickness=${first_layer_thickness} m (绝对值)` : 'relativeSizes=true (finalLayerThickness=0.4)') + `, n=${surfInfos.filter(s=>s.layers).map(s=>`${s.patch}:${s.layers}`).join(', ') || n_layers}, expansion=${expansion_ratio}, relaxedIter=20` : '无'}`,
    `locationInMesh = (${lim.map(x=>x.toFixed(3)).join(', ')})  [${dt==='internal'?'STL内部种子':dt==='external'?'STL外部种子':'auto'}]`,
    ``,
    warnings.length ? '⚠ 警告：\n  ' + warnings.join('\n  ') + '\n' : '',
    `生成文件:`,
    ...written.map(x => `  - ${x}`),
    ...surfInfos.map(s => `  - constant/triSurface/${s.name}`),
    ``,
    `建议执行序列（用 foam_run_solver_async 后台执行）：`,
    `  1) blockMesh`,
    `  2) surfaceFeatures   # OF >=1706；旧版用 surfaceFeatureExtract`,
    `  3) snappyHexMesh -overwrite`,
    `  4) checkMesh -allTopology -allGeometry`,
    `  5) foam_mesh_verify(case_path, stage='final') —— 必走，会解析 snappy log 算 layer coverage`,
    boxStlNote
  ].filter(Boolean).join('\n');
}

// ============== 写一个 axis-aligned box 的 ASCII STL ==============
async function writeBoxStl(filepath, bbMin, bbMax, solidName = 'box') {
  const [x0,y0,z0] = bbMin, [x1,y1,z1] = bbMax;
  // 8 顶点
  const v = [
    [x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],
    [x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]
  ];
  // 12 三角面（每面 2 个），法向朝外
  const faces = [
    // bottom z=z0, n=(0,0,-1)
    [[0,2,1],[0,3,2], [0,0,-1]],
    // top z=z1, n=(0,0,1)
    [[4,5,6],[4,6,7], [0,0,1]],
    // front y=y0, n=(0,-1,0)
    [[0,1,5],[0,5,4], [0,-1,0]],
    // back y=y1, n=(0,1,0)
    [[3,7,6],[3,6,2], [0,1,0]],
    // left x=x0, n=(-1,0,0)
    [[0,4,7],[0,7,3], [-1,0,0]],
    // right x=x1, n=(1,0,0)
    [[1,2,6],[1,6,5], [1,0,0]],
  ];
  let out = `solid ${solidName}\n`;
  for (const grp of faces) {
    const n = grp[2];
    for (let i = 0; i < 2; i++) {
      const tri = grp[i];
      out += `  facet normal ${n[0]} ${n[1]} ${n[2]}\n`;
      out += `    outer loop\n`;
      for (const idx of tri) out += `      vertex ${v[idx][0]} ${v[idx][1]} ${v[idx][2]}\n`;
      out += `    endloop\n  endfacet\n`;
    }
  }
  out += `endsolid ${solidName}\n`;
  await fs.mkdir(path.dirname(filepath), { recursive: true });
  await fs.writeFile(filepath, out);
  return filepath;
}

// 工具入口：生成域 box STL
async function foamMeshBoxStl(args) {
  const { case_path, bbox_min, bbox_max, name = 'domain_box' } = args || {};
  if (!case_path || !Array.isArray(bbox_min) || !Array.isArray(bbox_max)) throw new Error('case_path / bbox_min[3] / bbox_max[3] 必填');
  const cd = path.isAbsolute(case_path) ? case_path : path.resolve(WORKSPACE, case_path);
  const fp = path.join(cd, 'constant', 'triSurface', `${name}.stl`);
  await writeBoxStl(fp, bbox_min, bbox_max, name);
  return `[已生成 box STL] ${path.relative(WORKSPACE, fp) || fp}\nbbox: (${bbox_min.join(', ')}) → (${bbox_max.join(', ')})`;
}

// ============== 参数化 STL 几何生成（v6 新增） ==============
// 优先 Python trimesh（基元/布尔/水密最准）；缺库时回退内置纯 Python 生成器（box/sphere/cylinder/cone/pipe）。
const PY_STL_GEN = String.raw`# -*- coding: utf-8 -*-
import sys, json, math, struct

def load_spec(p):
    with open(p, 'r', encoding='utf-8-sig') as f:
        return json.load(f)

# ---------------- 纯 Python 回退生成器（保证法向朝外） ----------------
def _tri(a, b, c):
    return (a, b, c)

def _box(p):
    lx, ly, lz = _size3(p)
    hx, hy, hz = lx / 2.0, ly / 2.0, lz / 2.0
    v = [(-hx,-hy,-hz),( hx,-hy,-hz),( hx, hy,-hz),(-hx, hy,-hz),
         (-hx,-hy, hz),( hx,-hy, hz),( hx, hy, hz),(-hx, hy, hz)]
    # 每个面按逆时针(外法向)拆两三角形
    q = [(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]
    t = []
    for a,b,c,d in q:
        t.append(_tri(v[a],v[b],v[c])); t.append(_tri(v[a],v[c],v[d]))
    return t

def _size3(p):
    if 'size' in p and isinstance(p['size'], (list, tuple)) and len(p['size']) == 3:
        return float(p['size'][0]), float(p['size'][1]), float(p['size'][2])
    return float(p.get('lx', 1.0)), float(p.get('ly', 1.0)), float(p.get('lz', 1.0))

def _ring(r, n, z):
    return [(r*math.cos(2*math.pi*i/n), r*math.sin(2*math.pi*i/n), z) for i in range(n)]

def _cylinder(p):
    r = float(p.get('r', 0.5)); h = float(p.get('h', 1.0)); n = int(p.get('sections', 64))
    zt, zb = h/2.0, -h/2.0
    top = _ring(r, n, zt); bot = _ring(r, n, zb)
    t = []
    ct = (0,0,zt); cb = (0,0,zb)
    for i in range(n):
        j = (i+1) % n
        # 侧壁（外法向朝外）
        t.append(_tri(bot[i], bot[j], top[j])); t.append(_tri(bot[i], top[j], top[i]))
        # 顶盖(+z) / 底盖(-z)
        t.append(_tri(ct, top[i], top[j]))
        t.append(_tri(cb, bot[j], bot[i]))
    return t

def _cone(p):
    r = float(p.get('r', 0.5)); h = float(p.get('h', 1.0)); n = int(p.get('sections', 64))
    zb = -h/2.0; apex = (0,0,h/2.0)
    bot = _ring(r, n, zb); cb = (0,0,zb)
    t = []
    for i in range(n):
        j = (i+1) % n
        t.append(_tri(bot[i], bot[j], apex))      # 侧面
        t.append(_tri(cb, bot[j], bot[i]))        # 底盖
    return t

def _pipe(p):
    ro = float(p.get('r_outer', 0.5)); ri = float(p.get('r_inner', 0.3)); h = float(p.get('h', 1.0)); n = int(p.get('sections', 64))
    if ri >= ro: raise ValueError('pipe 需要 r_inner < r_outer')
    zt, zb = h/2.0, -h/2.0
    ot = _ring(ro, n, zt); ob = _ring(ro, n, zb)
    it = _ring(ri, n, zt); ib = _ring(ri, n, zb)
    t = []
    for i in range(n):
        j = (i+1) % n
        # 外壁(法向朝外)
        t.append(_tri(ob[i], ob[j], ot[j])); t.append(_tri(ob[i], ot[j], ot[i]))
        # 内壁(法向朝内=指向孔中心，即材料外侧)
        t.append(_tri(ib[i], it[j], ib[j])); t.append(_tri(ib[i], it[i], it[j]))
        # 顶环(+z)
        t.append(_tri(it[i], ot[i], ot[j])); t.append(_tri(it[i], ot[j], it[j]))
        # 底环(-z)
        t.append(_tri(ib[i], ob[j], ob[i])); t.append(_tri(ib[i], ib[j], ob[j]))
    return t

def _sphere(p):
    r = float(p.get('r', 0.5)); n = int(p.get('segments', 32))
    m = max(8, n); s = max(4, n//2)
    verts = {}
    def vp(i, k):
        theta = math.pi * k / s          # 0..pi 纬度
        phi = 2*math.pi * i / m          # 经度
        return (r*math.sin(theta)*math.cos(phi), r*math.sin(theta)*math.sin(phi), r*math.cos(theta))
    t = []
    for k in range(s):
        for i in range(m):
            a = vp(i, k); b = vp(i+1, k); c = vp(i+1, k+1); d = vp(i, k+1)
            if k == 0:
                t.append(_tri(a, c, d))      # 顶帽三角
            elif k == s-1:
                t.append(_tri(a, b, c))      # 底帽三角
            else:
                t.append(_tri(a, b, c)); t.append(_tri(a, c, d))
    return t

def _rot_apply(t, deg):
    rx, ry, rz = [math.radians(float(x)) for x in deg]
    cx,sx = math.cos(rx),math.sin(rx); cy,sy = math.cos(ry),math.sin(ry); cz,sz = math.cos(rz),math.sin(rz)
    def rot(p):
        x,y,z = p
        # X
        y,z = y*cx - z*sx, y*sx + z*cx
        # Y
        x,z = x*cy + z*sy, -x*sy + z*cy
        # Z
        x,y = x*cz - y*sz, x*sz + y*cz
        return (x,y,z)
    return [(rot(a), rot(b), rot(c)) for a,b,c in t]

def _trans_apply(t, tr):
    dx,dy,dz = float(tr[0]),float(tr[1]),float(tr[2])
    return [((a[0]+dx,a[1]+dy,a[2]+dz),(b[0]+dx,b[1]+dy,b[2]+dz),(c[0]+dx,c[1]+dy,c[2]+dz)) for a,b,c in t]

_BUILDERS = {'box':_box,'cylinder':_cylinder,'cone':_cone,'pipe':_pipe,'sphere':_sphere}

def _build_part_fallback(part):
    shape = part.get('shape')
    if shape not in _BUILDERS:
        raise ValueError('回退生成器不支持 shape=%s（需安装 trimesh：pip install trimesh manifold3d shapely）' % shape)
    t = _BUILDERS[shape](part.get('params', {}) or {})
    if part.get('rotate_deg'): t = _rot_apply(t, part['rotate_deg'])
    if part.get('translate'): t = _trans_apply(t, part['translate'])
    return t

def _write_binary_stl(path_out, tris, scale=1.0):
    with open(path_out, 'wb') as f:
        f.write(b'\0' * 80)
        f.write(struct.pack('<I', len(tris)))
        for a,b,c in tris:
            a = (a[0]*scale,a[1]*scale,a[2]*scale); b=(b[0]*scale,b[1]*scale,b[2]*scale); c=(c[0]*scale,c[1]*scale,c[2]*scale)
            ux,uy,uz = b[0]-a[0],b[1]-a[1],b[2]-a[2]
            vx,vy,vz = c[0]-a[0],c[1]-a[1],c[2]-a[2]
            nx,ny,nz = uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx
            L = math.sqrt(nx*nx+ny*ny+nz*nz) or 1.0
            f.write(struct.pack('<3f', nx/L, ny/L, nz/L))
            for v in (a,b,c): f.write(struct.pack('<3f', *v))
            f.write(struct.pack('<H', 0))

def _bbox(tris):
    xs=[];ys=[];zs=[]
    for a,b,c in tris:
        for v in (a,b,c): xs.append(v[0]);ys.append(v[1]);zs.append(v[2])
    return [min(xs),min(ys),min(zs)],[max(xs),max(ys),max(zs)]

def run_fallback(spec, out_path):
    parts = spec.get('parts') or ([{'shape':spec['shape'],'params':spec.get('params',{})}] if spec.get('shape') else [])
    if not parts: raise ValueError('缺少 shape 或 parts')
    if spec.get('subtract'): raise ValueError('subtract(布尔差) 需要 trimesh+manifold3d；请 pip install trimesh manifold3d')
    tris = []
    for part in parts: tris += _build_part_fallback(part)
    scale = float(spec.get('scale', 1.0) or 1.0)
    _write_binary_stl(out_path, tris, scale)
    mn,mx = _bbox(tris)
    mn=[x*scale for x in mn]; mx=[x*scale for x in mx]
    return {'backend':'builtin','triangles':len(tris),'bbox_min':mn,'bbox_max':mx,
            'size':[mx[0]-mn[0],mx[1]-mn[1],mx[2]-mn[2]],'watertight':None,
            'note':'内置回退生成器；如需布尔/水密检查/naca/torus/capsule 请安装 trimesh'}

# ---------------- trimesh 路径 ----------------
def _tm_primitive(tm, shape, params):
    import numpy as np
    p = params or {}
    if shape == 'box':
        lx, ly, lz = (p['size'] if 'size' in p else [p.get('lx',1.0),p.get('ly',1.0),p.get('lz',1.0)])
        return tm.creation.box(extents=[float(lx),float(ly),float(lz)])
    if shape == 'sphere':
        return tm.creation.icosphere(subdivisions=int(p.get('subdivisions',3)), radius=float(p.get('r',0.5)))
    if shape == 'cylinder':
        return tm.creation.cylinder(radius=float(p.get('r',0.5)), height=float(p.get('h',1.0)), sections=int(p.get('sections',64)))
    if shape == 'cone':
        return tm.creation.cone(radius=float(p.get('r',0.5)), height=float(p.get('h',1.0)), sections=int(p.get('sections',64)))
    if shape == 'pipe':
        return tm.creation.annulus(r_min=float(p.get('r_inner',0.3)), r_max=float(p.get('r_outer',0.5)), height=float(p.get('h',1.0)), sections=int(p.get('sections',64)))
    if shape == 'capsule':
        return tm.creation.capsule(radius=float(p.get('r',0.5)), height=float(p.get('h',1.0)))
    if shape == 'torus':
        return tm.creation.torus(major_radius=float(p.get('r_major',1.0)), minor_radius=float(p.get('r_minor',0.25)))
    if shape == 'naca':
        return _tm_naca(tm, p)
    raise ValueError('未知 shape=%s' % shape)

def _tm_naca(tm, p):
    from shapely.geometry import Polygon
    digits = str(p.get('digits','0012')).zfill(4)
    chord = float(p.get('chord',1.0)); span = float(p.get('span',1.0)); n = int(p.get('sections',80))
    mm = int(digits[0])/100.0; pp = int(digits[1])/10.0; tt = int(digits[2:])/100.0
    xs = [0.5*(1-math.cos(math.pi*i/n)) for i in range(n+1)]
    def yt(x): return 5*tt*(0.2969*math.sqrt(x)-0.1260*x-0.3516*x*x+0.2843*x**3-0.1015*x**4)
    def camber(x):
        if pp == 0: return 0.0,0.0
        if x < pp:
            yc = mm/(pp*pp)*(2*pp*x-x*x); dy = 2*mm/(pp*pp)*(pp-x)
        else:
            yc = mm/((1-pp)**2)*((1-2*pp)+2*pp*x-x*x); dy = 2*mm/((1-pp)**2)*(pp-x)
        return yc, dy
    up=[];lo=[]
    for x in xs:
        t=yt(x); yc,dy=camber(x); th=math.atan(dy)
        up.append((chord*(x - t*math.sin(th)), chord*(yc + t*math.cos(th))))
        lo.append((chord*(x + t*math.sin(th)), chord*(yc - t*math.cos(th))))
    poly = Polygon(up + lo[::-1])
    mesh = tm.creation.extrude_polygon(poly, height=span)
    return mesh

def _tm_apply_xform(tm, mesh, part):
    import numpy as np
    if part.get('rotate_deg'):
        rx,ry,rz = [math.radians(float(x)) for x in part['rotate_deg']]
        for ang,axis in ((rx,[1,0,0]),(ry,[0,1,0]),(rz,[0,0,1])):
            if ang: mesh.apply_transform(tm.transformations.rotation_matrix(ang, axis))
    if part.get('translate'):
        mesh.apply_translation([float(x) for x in part['translate']])
    return mesh

def run_trimesh(spec, out_path):
    import trimesh as tm
    parts = spec.get('parts') or ([{'shape':spec['shape'],'params':spec.get('params',{})}] if spec.get('shape') else [])
    if not parts: raise ValueError('缺少 shape 或 parts')
    meshes = []
    for part in parts:
        m = _tm_primitive(tm, part.get('shape'), part.get('params',{}))
        m = _tm_apply_xform(tm, m, part)
        meshes.append(m)
    base = meshes[0] if len(meshes) == 1 else tm.boolean.union(meshes)
    subs = spec.get('subtract') or []
    if subs:
        sm = []
        for part in subs:
            m = _tm_primitive(tm, part.get('shape'), part.get('params',{}))
            m = _tm_apply_xform(tm, m, part); sm.append(m)
        cutter = sm[0] if len(sm) == 1 else tm.boolean.union(sm)
        base = tm.boolean.difference([base, cutter])
    scale = float(spec.get('scale',1.0) or 1.0)
    if scale != 1.0: base.apply_scale(scale)
    base.export(out_path)
    mn = base.bounds[0].tolist(); mx = base.bounds[1].tolist()
    return {'backend':'trimesh','triangles':int(len(base.faces)),'bbox_min':mn,'bbox_max':mx,
            'size':(base.bounds[1]-base.bounds[0]).tolist(),'watertight':bool(base.is_watertight),
            'volume_m3':float(abs(base.volume)) if base.is_watertight else None}

def main():
    spec = load_spec(sys.argv[1]); out_path = sys.argv[2]
    have_trimesh = False
    try:
        import trimesh  # noqa
        have_trimesh = True
    except ImportError:
        have_trimesh = False
    # 注意：只有 trimesh 本身缺失才回退；trimesh 在但布尔后端缺失要把真实错误抛出（带 manifold3d 提示），不能静默回退
    rep = run_trimesh(spec, out_path) if have_trimesh else run_fallback(spec, out_path)
    print('STLGEN_JSON ' + json.dumps(rep, ensure_ascii=False))

if __name__ == '__main__':
    main()
`;

async function foamStlGenerate(args = {}) {
  const { out_path, case_path, name = 'geometry', shape, params, parts, subtract, scale } = args;
  // 1) 解析输出路径
  let fp;
  if (out_path) {
    fp = path.isAbsolute(out_path) ? out_path : path.resolve(WORKSPACE, out_path);
    if (!/\.stl$/i.test(fp)) fp += '.stl';
  } else if (case_path) {
    const cd = path.isAbsolute(case_path) ? case_path : path.resolve(WORKSPACE, case_path);
    fp = path.join(cd, 'constant', 'triSurface', `${name.replace(/\.stl$/i, '')}.stl`);
  } else {
    fp = path.resolve(WORKSPACE, `${name.replace(/\.stl$/i, '')}.stl`);
  }
  if (!shape && !(Array.isArray(parts) && parts.length)) throw new Error('需提供 shape+params 或 parts[]');
  await fs.mkdir(path.dirname(fp), { recursive: true });
  // 2) 写 spec + 生成脚本到临时目录
  const spec = {};
  if (shape) { spec.shape = shape; spec.params = params || {}; }
  if (Array.isArray(parts) && parts.length) spec.parts = parts;
  if (Array.isArray(subtract) && subtract.length) spec.subtract = subtract;
  if (scale != null) spec.scale = scale;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nf_stlgen_'));
  const specPath = path.join(tmpDir, 'spec.json');
  const scriptPath = path.join(tmpDir, 'gen.py');
  await fs.writeFile(specPath, JSON.stringify(spec), 'utf-8');
  await fs.writeFile(scriptPath, PY_STL_GEN, 'utf-8');
  // 3) 运行
  const py = SETTINGS.pythonPath || (IS_WIN ? 'python' : 'python3');
  const r = await _spawnP(py, [scriptPath, specPath, fp], { cwd: WORKSPACE });
  try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
  if (r.code !== 0) {
    const tail = ((r.err || '') + '\n' + (r.out || '')).trim().slice(-1500);
    throw new Error(`[STL 生成失败] python 退出码 ${r.code}\n${tail}\n\n提示：若提示缺 trimesh，可 pip install trimesh manifold3d shapely（box/sphere/cylinder/cone/pipe 无需 trimesh 也能生成）。`);
  }
  const m = (r.out || '').match(/STLGEN_JSON\s+(\{.*\})/);
  let rep = null;
  try { rep = m ? JSON.parse(m[1]) : null; } catch {}
  const rel = path.relative(WORKSPACE, fp) || fp;
  if (!rep) return `[STL 已生成] ${rel}\n${(r.out || '').slice(-600)}`;
  const wt = rep.watertight == null ? '未知(回退生成器)' : (rep.watertight ? '✅ 水密' : '❌ 非水密(有破洞)');
  const sz = (rep.size || []).map(x => Number(x).toPrecision(4)).join(' × ');
  const lines = [
    `[STL 已生成] ${rel}`,
    `后端: ${rep.backend}  ·  三角形: ${rep.triangles}  ·  水密: ${wt}`,
    `bbox: [${(rep.bbox_min||[]).map(x=>Number(x).toPrecision(4)).join(', ')}] → [${(rep.bbox_max||[]).map(x=>Number(x).toPrecision(4)).join(', ')}]`,
    `尺寸(m): ${sz}`,
    rep.volume_m3 != null ? `体积: ${Number(rep.volume_m3).toPrecision(4)} m³` : '',
    rep.note ? `注: ${rep.note}` : '',
    rep.watertight === false ? '⚠ 非水密会导致 snappyHexMesh 出错，建议改用 trimesh 后端或检查参数/布尔操作。' : '',
    '下一步建议: foam_stl_inspect 看几何字段 / foam_stl_render 目检法向与比例。'
  ].filter(Boolean);
  return lines.join('\n');
}

// ============== OpenFOAM 环境体检（v6 新增） ==============
// 在已 source bashrc 的 shell 里执行命令并捕获输出（不流式推送）。
async function _foamExecCapture(command, timeoutMs = 30000) {
  let shell, shellArgs;
  if (IS_WIN && SETTINGS.openfoamBash) {
    shell = 'cmd.exe';
    shellArgs = ['/c', `call "${SETTINGS.openfoamBash}" && ${command}`];
  } else if (IS_WIN) {
    // 没配 openfoamBash：尝试经 WSL 跑（多数 Windows 用户在 WSL 里装 OpenFOAM）
    shell = 'wsl.exe';
    shellArgs = ['bash', '-lic', command];
  } else {
    let bashrc = SETTINGS.openfoamBash || '';
    if (!bashrc && SETTINGS.foamRoot) {
      const cand = path.join(SETTINGS.foamRoot, 'etc', 'bashrc');
      try { if ((await fs.stat(cand)).isFile()) bashrc = cand; } catch {}
    }
    const sourceLine = bashrc ? `source "${bashrc}"` : `source "$FOAM_BASH" 2>/dev/null || true`;
    // 在同一个 shell 里 source（原来放在 ( ) 子 shell 里，环境变量出了括号就没了，命令仍然找不到）
    shell = 'bash'; shellArgs = ['-c', `${sourceLine} >/dev/null 2>&1; ${command}`];
  }
  return await new Promise((resolve) => {
    let out = '', err = '', done = false;
    let child;
    try { child = spawn(shell, shellArgs); }
    catch (e) { return resolve({ code: -1, out: '', err: String(e.message || e) }); }
    const t = setTimeout(() => { if (!done) { done = true; try { child.kill(); } catch {} resolve({ code: -2, out, err: err + '\n[超时]' }); } }, timeoutMs);
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    child.on('close', code => { if (!done) { done = true; clearTimeout(t); resolve({ code, out, err }); } });
    child.on('error', e => { if (!done) { done = true; clearTimeout(t); resolve({ code: -1, out, err: String(e.message || e) }); } });
  });
}

async function foamEnvCheck() {
  const report = { platform: process.platform, is_windows: IS_WIN, checks: [], hints: [], summary: '' };
  const add = (name, ok, detail, hint) => { report.checks.push({ name, ok, detail }); if (!ok && hint) report.hints.push(hint); };

  // 1) foamRoot 配置 / 目录
  const root = SETTINGS.foamRoot && String(SETTINGS.foamRoot).trim();
  if (!root) {
    add('foamRoot 配置', false, '未设置 OpenFOAM 根目录', '在右侧 “OpenFOAM (Beta)” 面板点 ⚙ 填写安装根目录（含 etc/bashrc、tutorials/、src/）。');
  } else {
    const exists = await pathExists(root);
    add('foamRoot 存在', exists, root, exists ? null : `路径不存在或无权限：${root}`);
    if (exists) {
      const hasT = await pathExists(path.join(root, 'tutorials'));
      const hasS = await pathExists(path.join(root, 'src'));
      const hasA = await pathExists(path.join(root, 'applications'));
      const hasB = await pathExists(path.join(root, 'etc', 'bashrc'));
      add('tutorials/ 目录', hasT, hasT ? path.join(root, 'tutorials') : '缺失', hasT ? null : 'foam_find_tutorial 依赖 tutorials/，建议指向含 tutorials/ 的安装根。');
      add('src/ 源码目录', hasS, hasS ? '存在' : '缺失', hasS ? null : 'foam_find_source（算法植入参考）依赖 src/+applications/。');
      add('applications/ 目录', hasA, hasA ? '存在' : '缺失', null);
      add('etc/bashrc', hasB, hasB ? '存在（可 source 环境）' : '缺失', hasB ? null : '缺 etc/bashrc 无法自动 source OpenFOAM 环境。');
    }
  }

  // 2) WSL（仅 Windows 且未配 openfoamBash 时探测）
  if (IS_WIN) {
    add('openfoamBash 配置', !!SETTINGS.openfoamBash, SETTINGS.openfoamBash || '未设置', SETTINGS.openfoamBash ? null : 'Windows 上建议在 WSL 里安装 OpenFOAM；或设置 openfoamBash 指向激活脚本。');
    const wsl = await _foamExecCapture('echo wsl_ok', 12000).catch(() => ({ code: -1 }));
    // 上面在 Win 无 openfoamBash 时已走 wsl.exe；这里直接探测 wsl 是否可用
    const wslProbe = spawnSync('wsl.exe', ['-l', '-q'], { encoding: 'utf-8', timeout: 12000 });
    const hasWsl = wslProbe.status === 0 || (wslProbe.stdout && wslProbe.stdout.trim().length > 0);
    add('WSL 可用', hasWsl, hasWsl ? (wslProbe.stdout || '').replace(/\0/g, '').trim().split(/\r?\n/).filter(Boolean).join(', ') : '未检测到 WSL', hasWsl ? null : 'Windows 原生不支持 OpenFOAM。安装 WSL：wsl --install，然后在 WSL 内 apt 安装 OpenFOAM。');
  }

  // 3) 关键命令是否可用（source 环境后 which）
  const bins = ['blockMesh', 'snappyHexMesh', 'checkMesh', 'decomposePar', 'simpleFoam', 'interFoam', 'foamDictionary'];
  const whichCmd = (IS_WIN && !SETTINGS.openfoamBash) ? bins.map(b => `which ${b} 2>/dev/null`).join('; ')
    : bins.map(b => `which ${b} 2>/dev/null || where ${b} 2>nul`).join(' & ');
  let solverDetail = '(未检测)';
  const found = {};
  try {
    const r = await _foamExecCapture(IS_WIN && SETTINGS.openfoamBash ? bins.map(b => `where ${b}`).join(' & ') : bins.map(b => `which ${b} 2>/dev/null`).join('; '), 30000);
    const text = (r.out || '') + '\n' + (r.err || '');
    bins.forEach(b => { found[b] = new RegExp(`(^|[\\\\/])${b}(\\.\\w+)?\\s*$`, 'm').test(text) || text.includes('/' + b) || text.toLowerCase().includes('\\' + b.toLowerCase()); });
    const okBins = bins.filter(b => found[b]);
    solverDetail = okBins.length ? `找到: ${okBins.join(', ')}` : '一个都没找到';
    add('OpenFOAM 命令可用', okBins.length >= 3, solverDetail, okBins.length >= 3 ? null : '关键命令找不到：确认已 source 正确的 etc/bashrc；Windows 请在 WSL 内运行，或设置 openfoamBash。');
  } catch (e) {
    add('OpenFOAM 命令可用', false, '探测失败: ' + (e.message || e), '无法执行 shell 探测，请检查 bash/WSL 是否可用。');
  }

  // 4) OpenFOAM 版本
  try {
    const r = await _foamExecCapture(IS_WIN && SETTINGS.openfoamBash ? 'echo %WM_PROJECT_VERSION%' : 'echo "$WM_PROJECT_VERSION"', 15000);
    const ver = (r.out || '').replace(/%WM_PROJECT_VERSION%/g, '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
    add('OpenFOAM 版本', !!ver, ver || '未取得（环境可能未 source）', ver ? null : '取不到 WM_PROJECT_VERSION，多半 etc/bashrc 没 source 成功。');
  } catch {}

  // 5) Python + trimesh（几何生成）
  const py = SETTINGS.pythonPath || (IS_WIN ? 'python' : 'python3');
  const pr = await _spawnP(py, ['-c', 'import sys;print(sys.version.split()[0]);\ntry:\n import trimesh;print("trimesh",trimesh.__version__)\nexcept Exception as e:\n print("no-trimesh")'], {}).catch(() => ({ code: -1, out: '' }));
  const pyOk = pr.code === 0;
  const hasTrimesh = /trimesh\s+\d/.test(pr.out || '');
  add('Python 可用', pyOk, pyOk ? (pr.out || '').split(/\r?\n/)[0] : '未找到 python（用于 STL 生成/后处理）', pyOk ? null : `设置 pythonPath，或安装 Python。当前尝试: ${py}`);
  add('trimesh（STL 生成）', hasTrimesh, hasTrimesh ? (pr.out || '').match(/trimesh\s+[\d.]+/)?.[0] : '未安装（box/sphere/cylinder/cone/pipe 仍可用内置生成器）', hasTrimesh ? null : 'pip install trimesh manifold3d shapely（解锁布尔运算/naca/torus/capsule/水密检查）。');

  // 6) ParaView（pvpython，用于离屏渲染）
  const pvCand = SETTINGS.paraviewPython || (IS_WIN ? 'pvpython' : 'pvpython');
  const pv = await _spawnP(pvCand, ['--version'], {}).catch(() => ({ code: -1, out: '', err: '' }));
  const pvOk = pv.code === 0 || /paraview/i.test((pv.out || '') + (pv.err || ''));
  add('ParaView pvpython', pvOk, pvOk ? ((pv.out || pv.err || '').trim().split(/\r?\n/)[0] || '可用') : '未找到（foam_stl_render/网格渲染依赖）', pvOk ? null : '安装 ParaView 并在设置里指定 paraviewPython 路径（pvpython/pvbatch）。');

  const okCount = report.checks.filter(c => c.ok).length;
  report.summary = `${okCount}/${report.checks.length} 项通过`;
  // 文本化
  const body = report.checks.map(c => `${c.ok ? '✅' : '❌'} ${c.name}：${c.detail}`).join('\n');
  const hints = report.hints.length ? '\n\n修复建议:\n' + report.hints.map((h, i) => `${i + 1}. ${h}`).join('\n') : '';
  return `[OpenFOAM 环境体检] ${report.summary}\n${body}${hints}\n\n(JSON) ${JSON.stringify(report)}`;
}

// ============== y+ 反算第一层厚度（v6 新增） ==============
// Schlichting 平板：Cf = 0.026 Re^(-1/7)，u* = U*sqrt(Cf/2)，Δy1 = y+·ν/u*
// BL 厚度 δ99 ≈ 0.37·L·Re^(-1/5)；几何级数总厚 = Δy1·(r^N - 1)/(r-1) 覆盖 δ99 → 反推 N
function foamComputeFirstLayer(args) {
  const { U_ref, L_ref, nu = 1.5e-5, y_plus_target = 1.0, expansion_ratio = 1.2, coverage = 0.7 } = args || {};
  if (!(U_ref > 0) || !(L_ref > 0)) throw new Error('U_ref(>0) 和 L_ref(>0) 必填（米/秒、米）');
  const Re = U_ref * L_ref / nu;
  const Cf = 0.026 * Math.pow(Re, -1/7);
  const u_star = U_ref * Math.sqrt(Cf / 2);
  const dy1 = y_plus_target * nu / u_star;
  const delta99 = 0.37 * L_ref * Math.pow(Re, -1/5);
  // 用几何级数反求 N：dy1 * (r^N - 1) / (r - 1) = coverage * delta99
  const r = expansion_ratio;
  const target = coverage * delta99;
  let N = 1;
  while (N < 30) {
    const total = dy1 * (Math.pow(r, N) - 1) / (r - 1);
    if (total >= target) break;
    N++;
  }
  const totalThick = dy1 * (Math.pow(r, N) - 1) / (r - 1);
  // 推荐区间：5≤N≤15 比较稳；超出范围给出告警
  const warnings = [];
  if (N < 4) warnings.push(`N=${N} 偏少，可能 BL 解析不够；建议放宽 y+ 目标或降低 expansion_ratio`);
  if (N > 15) warnings.push(`N=${N} 偏多，会拖累网格；建议放宽 y+ 目标（如 y+=30 走壁函数）或加大 expansion_ratio 到 1.25`);
  if (dy1 < 1e-7) warnings.push(`Δy1=${dy1.toExponential(2)} m 极小，对应几何尺度可能过细，请确认 L_ref 的物理含义`);
  return JSON.stringify({
    inputs: { U_ref, L_ref, nu, y_plus_target, expansion_ratio, coverage },
    derived: {
      Re: +Re.toPrecision(4),
      Cf: +Cf.toPrecision(4),
      u_star: +u_star.toPrecision(4),
      delta99_estimate_m: +delta99.toPrecision(4)
    },
    output: {
      first_layer_thickness_m: +dy1.toPrecision(4),
      recommended_n_layers: N,
      expansion_ratio: r,
      total_layer_thickness_m: +totalThick.toPrecision(4),
      coverage_actual: +(totalThick / delta99).toPrecision(3),
      foam_mesh_plan_usage: {
        first_layer_thickness: +dy1.toPrecision(4),
        n_layers: N,
        expansion_ratio: r,
        comment: '把这三项直接传给 foam_mesh_plan（同名参数），并设 domain=external|internal 等显式 domain。'
      }
    },
    warnings
  }, null, 2);
}

// ============== 残差时序结构化 ==============
function foamResidualSeries(runId, maxPoints = 60, fields = null) {
  const run = SOLVER_RUNS.get(runId);
  if (!run) return '[未知 runId]';
  const lines = run.log;
  // 解析模型：扫描行，遇 "Time = X" 切到新时间步；行内 "Solving for FIELD, Initial residual = A, Final residual = B, No Iterations N"
  const series = []; // [{t, residuals: {U:{init,final,iters}, p:..., ...}}]
  let cur = null;
  const reTime = /^Time\s*=\s*([\d.eE+\-]+)/;
  const reRes = /Solving for ([A-Za-z][\w]*),\s*Initial residual\s*=\s*([\d.eE+\-]+),\s*Final residual\s*=\s*([\d.eE+\-]+),\s*No Iterations\s*(\d+)/;
  for (const l of lines) {
    const tm = l.match(reTime);
    if (tm) { cur = { t: +tm[1], res: {} }; series.push(cur); continue; }
    if (!cur) continue;
    const rm = l.match(reRes);
    if (rm) {
      const fld = rm[1];
      if (fields && !fields.includes(fld)) continue;
      // 同一时间步内同一 field 出现多次（PISO 多次校正）→ 取最后一次
      cur.res[fld] = { init: +rm[2], final: +rm[3], iters: +rm[4] };
    }
  }
  const tail = series.slice(-maxPoints);
  // 收敛趋势：取每个 field 最近 10 步初始残差，做对数斜率
  const allFields = new Set();
  tail.forEach(s => Object.keys(s.res).forEach(k => allFields.add(k)));
  const trends = {};
  for (const f of allFields) {
    const xs = tail.filter(s => s.res[f] && isFinite(s.res[f].init) && s.res[f].init > 0).slice(-10);
    if (xs.length < 3) { trends[f] = { samples: xs.length, status: 'insufficient' }; continue; }
    const ys = xs.map(s => Math.log10(s.res[f].init));
    const n = ys.length;
    const meanX = (n - 1) / 2;
    const meanY = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (i - meanX) * (ys[i] - meanY); den += (i - meanX) ** 2; }
    const slope = den > 0 ? num / den : 0; // log10 残差/步
    const last = ys[ys.length - 1], first = ys[0];
    let status;
    if (slope < -0.05) status = '收敛中';
    else if (slope > 0.05) status = '发散/震荡';
    else if (last > -3) status = '停滞-高残差';
    else status = '停滞-已稳态';
    trends[f] = { samples: n, slope_log10_per_step: +slope.toFixed(3), last_log10: +last.toFixed(2), first_log10: +first.toFixed(2), status };
  }
  return JSON.stringify({
    runId, total_time_steps: series.length, returned: tail.length,
    last_time: tail.length ? tail[tail.length-1].t : null,
    fields: [...allFields],
    trends,
    series: tail.map(s => ({ t: s.t, ...Object.fromEntries(Object.entries(s.res).map(([k,v]) => [k, v.init])) }))
  }, null, 2);
}

// ============== 算例对比并排渲染 ==============
async function foamCompareRender(args, ws) {
  const { case_a, case_b, label_a, label_b, field, time_step, azimuth = 30, elevation = 15 } = args;
  if (!case_a || !case_b) throw new Error('case_a 和 case_b 必填');
  const a = path.isAbsolute(case_a) ? case_a : path.resolve(WORKSPACE, case_a);
  const b = path.isAbsolute(case_b) ? case_b : path.resolve(WORKSPACE, case_b);
  // 串行渲染（pvpython 同时跑会抢 GPU；并行也行但风险大）
  const r1 = await pvRenderOffscreen({ casePath: a, azimuth, elevation, field: field || '', timeStep: time_step ?? null });
  const r2 = await pvRenderOffscreen({ casePath: b, azimuth, elevation, field: field || '', timeStep: time_step ?? null });
  // 通过 ws 推一条 sim_compare 给前端，前端把两个 dataUrl 并排渲染
  const labelA = label_a || path.basename(a);
  const labelB = label_b || path.basename(b);
  const payload = {
    type: 'sim_compare',
    a: { dataUrl: r1.dataUrl, label: labelA, meta: r1.meta || {} },
    b: { dataUrl: r2.dataUrl, label: labelB, meta: r2.meta || {} },
    field: field || '', timeStep: time_step ?? null
  };
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload));
  else for (const c of allClients) if (c.readyState === 1) c.send(JSON.stringify(payload));
  return [
    `[对比渲染完成] field=${field || '(默认)'}  t=${time_step ?? '(默认)'}`,
    `A: ${labelA}  →  ${a}`,
    `B: ${labelB}  →  ${b}`,
    `已推送 sim_compare 到聊天界面（左右并排）。`,
    r1.meta && r1.meta.fields ? `A 可用场: ${(r1.meta.fields||[]).join(', ')}` : '',
    r2.meta && r2.meta.fields ? `B 可用场: ${(r2.meta.fields||[]).join(', ')}` : ''
  ].filter(Boolean).join('\n');
}

// ============================================================
// v6 优化模块：Optuna ask-tell 驱动 + KPI 提取 + 字典写入
// ============================================================
const OPT_BASE_DIR = path.join(WORKSPACE, '.nullflux', 'opt');

async function _runOptDriver(subArgs) {
  const py = SETTINGS.pythonPath || (IS_WIN ? 'python' : 'python3');
  const script = path.join(__dirname, 'opt_driver.py');
  await fs.mkdir(OPT_BASE_DIR, { recursive: true });
  return await new Promise((resolve, reject) => {
    const proc = spawn(py, [script, ...subArgs], { windowsHide: true });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('error', e => reject(new Error('spawn opt_driver.py 失败: ' + e.message)));
    proc.on('close', code => {
      if (code !== 0 && !out) return reject(new Error(`opt_driver 退出码 ${code}\nstderr: ${err.slice(-500)}`));
      // 取最后一行 JSON（避免 numpy/optuna 输出干扰）
      const last = out.trim().split(/\r?\n/).filter(Boolean).pop();
      try { resolve(JSON.parse(last)); }
      catch (e) { reject(new Error('opt_driver 返回非 JSON：' + (last || out).slice(0, 400) + '\nstderr: ' + err.slice(-300))); }
    });
  });
}

// foamDictionary -entry <path> -set <val> <file>
async function _foamDictSet(absFile, entry, value) {
  return await new Promise((resolve, reject) => {
    const cmd = ['-entry', entry, '-set', String(value), absFile];
    const proc = spawn('foamDictionary', cmd, { windowsHide: true });
    let err = '';
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('error', e => reject(new Error('foamDictionary 未找到（OpenFOAM 环境未 source？）：' + e.message)));
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`foamDictionary 退出码 ${code}: ${err.slice(-300)}`));
      else resolve(true);
    });
  });
}

async function foamPostprocList(args) {
  const cd = path.isAbsolute(args.case_path) ? args.case_path : path.resolve(WORKSPACE, args.case_path);
  const fos = await FoamPost.listFunctionObjects(cd);
  if (!fos.length) return `[foam_postproc_list] ${cd}/postProcessing 不存在或为空。先在 system/controlDict 的 functions{} 里加 functionObject（surfaceFieldValue / volFieldValue / probes / forces）再跑求解器。`;
  return `[foam_postproc_list] case=${cd}\n` + fos.map(f => `- ${f.name}  start_times=[${f.start_times.join(', ')}]  files=[${f.files.join(', ')}]`).join('\n');
}

async function foamPostprocStats(args) {
  const cd = path.isAbsolute(args.case_path) ? args.case_path : path.resolve(WORKSPACE, args.case_path);
  const { file, series } = await FoamPost.loadFunctionObject(cd, args.function_object, args.file || null);
  const r = FoamPost.windowStats(series, {
    tStart: args.t_start ?? null, tEnd: args.t_end ?? null,
    lastFraction: args.last_fraction ?? null, columns: args.columns || null, driftTol: args.drift_tol ?? 0.05,
  });
  const span = series.time.length ? [series.time[0], series.time[series.time.length - 1]] : null;
  const lines = [`[foam_postproc_stats] ${args.function_object}/${file}  samples=${series.time.length}  t∈[${span}]  window=[${r.window}] n=${r.n}`];
  for (const [c, s] of Object.entries(r.stats)) {
    if (!s.n) { lines.push(`  ${c}: 无数据`); continue; }
    lines.push(`  ${c}: mean=${s.mean.toPrecision(6)} ±sem=${s.sem.toPrecision(3)} std=${s.std.toPrecision(3)} drift=${s.rel_drift.toFixed(3)} ${s.stationary ? '✅平稳' : '⚠未平稳'}`);
  }
  const full = { file, columns: series.columns, span, ...r };
  if (args.write_json) {
    const out = path.isAbsolute(args.write_json) ? args.write_json : path.resolve(cd, args.write_json);
    await fs.writeFile(out, JSON.stringify(full, null, 1));
    lines.push(`已写出完整统计 → ${out}`);
  }
  // 文本行已含每列 mean/sem/std/drift；完整 JSON 只在列少时附上（宽表重复一遍会翻倍 token）
  const js = JSON.stringify(full);
  return lines.join('\n') + (args.json === true || (args.json !== false && js.length <= 2500) ? `\nJSON:\n${js}` : `\n（完整 JSON ${js.length} 字符已省略；需要时传 json:true 或 write_json:"stats.json"）`);
}

async function optStudyCreate(args) {
  if (!args.study_id) throw new Error('study_id 必填');
  if (!Array.isArray(args.search_space) || args.search_space.length === 0) throw new Error('search_space 必填且至少一项');
  if (!args.objective || !args.objective.name) throw new Error('objective.name 必填');
  if (!['minimize', 'maximize'].includes(args.objective.direction || 'minimize')) throw new Error('Invalid objective.direction');
  if (!args.base_case || !args.pipeline) throw new Error('base_case and locked pipeline required');
  const spec = {
    study_id: args.study_id,
    base_case: path.resolve(WORKSPACE, args.base_case),
    objective: {
      name: args.objective.name,
      direction: args.objective.direction === 'maximize' ? 'maximize' : 'minimize',
      target: args.objective.target ?? null,   // 可选，论文/任务给的参考值
    },
    search_space: args.search_space,
    sampler: args.sampler || 'TPE',
    pruner: args.pruner || null,
    n_trials_budget: args.n_trials_budget || 30,
    seed: args.seed ?? null,
    kpi_extract: args.kpi_extract || null,     // 可选缺省 KPI 提取配置（method, regex/script_path/pvpython）
    param_mapping: args.param_mapping || null, // 可选缺省字典映射
    pipeline: args.pipeline,
    notes: args.notes || '',
  };
  const r = await _runOptDriver(['create', '--study_id', args.study_id, '--base_dir', OPT_BASE_DIR, '--spec', JSON.stringify(spec)]);
  return `[opt_study_create] ok=${r.ok} study=${r.study_id}\n` +
    `dir: ${r.study_dir}\n` +
    `sampler=${r.sampler}  direction=${r.direction}  n_params=${r.n_params}\n` +
    `JSON:\n${JSON.stringify(r, null, 2)}`;
}

async function optSuggestNext(args) {
  if (!args.study_id) throw new Error('study_id 必填');
  const r = await _runOptDriver(['suggest', '--study_id', args.study_id, '--base_dir', OPT_BASE_DIR]);
  return `[opt_suggest_next] trial_id=${r.trial_id}\nparams=${JSON.stringify(r.params, null, 2)}\nsuggested trial dir name: ${r.trial_dir_suggested}\nJSON:\n${JSON.stringify(r, null, 2)}`;
}

let activeOptTrial = null;

async function optRunTrial(args) {
  if (!/^[A-Za-z0-9_-]+$/.test(args.study_id || '') || !Number.isSafeInteger(args.trial_id) || args.trial_id < 0) throw new Error('Invalid study/trial identity');
  if (activeOptTrial || [...SOLVER_RUNS.values()].some(run => !run.ended)) throw new Error('CFD pipeline requires exclusive solver capacity; wait for active jobs');
  activeOptTrial = `${args.study_id}/${args.trial_id}`;
  try {
  const status = await _runOptDriver(['status', '--study_id', args.study_id, '--base_dir', OPT_BASE_DIR]);
  const trial = status.history.find(item => item.trial_id === args.trial_id && item.state === 'RUNNING');
  if (!trial) throw new Error('Trial must exist and be RUNNING');
  const spec = JSON.parse(await fs.readFile(path.join(OPT_BASE_DIR, args.study_id, 'study.json'), 'utf8'));
  if (!spec.pipeline) throw new Error('Study pipeline required; create a new locked study');
  const { runCfdTrial } = await import('./cfd_trial.js');
  const trialDir = path.resolve(OPT_BASE_DIR, args.study_id, 'trials', `trial_${String(args.trial_id).padStart(4, '0')}`);
  const result = await runCfdTrial({ baseCase: spec.base_case, trialDir, studyId: args.study_id, trialId: String(args.trial_id), params: trial.params, ...spec.pipeline });
  return JSON.stringify({ passed: result.passed, value: result.value, error: result.error, evidence_path: path.join(trialDir, 'trial-result.json'), stages: result.stages.map(stage => ({ name: stage.name, status: stage.status })) });
  } finally {
    activeOptTrial = null;
  }
}

async function optApplyParams(args) {
  if (!args.case_path) throw new Error('case_path 必填');
  if (!args.params || typeof args.params !== 'object') throw new Error('params 必填 {name:value}');
  if (!args.mapping || typeof args.mapping !== 'object') throw new Error('mapping 必填 {name: "<file>::<entry>"}');
  const cd = path.isAbsolute(args.case_path) ? args.case_path : path.resolve(WORKSPACE, args.case_path);
  if (!await pathExistsSync(cd)) throw new Error('case_path 不存在: ' + cd);
  const applied = [], failed = [];
  for (const [name, value] of Object.entries(args.params)) {
    const target = args.mapping[name];
    if (!target) { failed.push({ name, error: 'no mapping' }); continue; }
    const idx = target.indexOf('::');
    if (idx < 0) { failed.push({ name, target, error: '格式应为 "<file>::<entry>"' }); continue; }
    const file = target.slice(0, idx);
    const entry = target.slice(idx + 2);
    const abs = path.isAbsolute(file) ? file : path.join(cd, file);
    try {
      await _foamDictSet(abs, entry, value);
      applied.push({ name, value, file, entry });
    } catch (e) {
      failed.push({ name, value, file, entry, error: e.message });
    }
  }
  return `[opt_apply_params] case=${path.relative(WORKSPACE, cd) || cd}\napplied (${applied.length}):\n` +
    applied.map(a => `  ✅ ${a.name} = ${a.value}   @ ${a.file}::${a.entry}`).join('\n') +
    (failed.length ? `\nfailed (${failed.length}):\n` + failed.map(f => `  ❌ ${f.name}: ${f.error}`).join('\n') : '') +
    `\nJSON:\n${JSON.stringify({ applied, failed }, null, 2)}`;
}

async function optExtractKpi(args) {
  const { parseKpiOutput } = await import('./opt_validation.js');
  if (!args.case_path) throw new Error('case_path 必填');
  if (!args.method) throw new Error('method 必填: regex|pvpython|script|postproc');
  const cd = path.isAbsolute(args.case_path) ? args.case_path : path.resolve(WORKSPACE, args.case_path);
  let value = null;
  let detail = '';
  if (args.method === 'postproc') {
    if (!args.function_object || !args.column) throw new Error('postproc 方法需 function_object 和 column');
    const { file, series } = await FoamPost.loadFunctionObject(cd, args.function_object, args.file || null);
    const r = FoamPost.windowStats(series, { tStart: args.t_start ?? null, tEnd: args.t_end ?? null, lastFraction: args.last_fraction ?? (args.t_start == null ? 0.4 : null), columns: [args.column] });
    const st = r.stats[args.column];
    if (!st || !st.n) throw new Error(`列 ${args.column} 在窗口内无数据。可用列: ${series.columns.join(', ')}`);
    if (!st.stationary && !args.allow_nonstationary) throw new Error(`窗口 [${r.window}] 内 ${args.column} 未平稳 (rel_drift=${st.rel_drift.toFixed(3)}, n=${st.n})。请继续推进物理时间后再取，或 allow_nonstationary=true 显式接受。`);
    value = st.mean;
    detail = `postproc ${args.function_object}/${file} ${args.column} 时均=${st.mean} ±${st.sem} (std=${st.std}, n=${st.n}, window=[${r.window}], rel_drift=${st.rel_drift.toFixed(3)})`;
  } else if (args.method === 'regex') {
    if (!args.file || !args.pattern) throw new Error('regex 方法需 file 和 pattern');
    const abs = path.isAbsolute(args.file) ? args.file : path.join(cd, args.file);
    const txt = await fs.readFile(abs, 'utf-8');
    const re = new RegExp(args.pattern, args.flags || 'm');
    const m = txt.match(re);
    if (!m) throw new Error(`regex 未匹配：${args.pattern}`);
    const captured = m[1] !== undefined ? m[1] : m[0];
    value = parseFloat(captured);
    if (!isFinite(value)) throw new Error('正则捕获值非数字: ' + captured);
    detail = `regex match=${captured} (line: ${m[0].slice(0,120)})`;
  } else if (args.method === 'pvpython' || args.method === 'script') {
    const exe = args.method === 'pvpython'
      ? (SETTINGS.paraviewPython || 'pvpython')
      : (SETTINGS.pythonPath || (IS_WIN ? 'python' : 'python3'));
    if (!args.script) throw new Error(args.method + ' 方法需 script 路径');
    const scriptAbs = path.isAbsolute(args.script) ? args.script : path.resolve(WORKSPACE, args.script);
    const scriptArgs = Array.isArray(args.script_args) ? args.script_args.map(String) : [];
    const r = await new Promise((resolve) => {
      const proc = spawn(exe, [scriptAbs, cd, ...scriptArgs], { windowsHide: true });
      let out = '', err = '';
      proc.stdout.on('data', d => { out += d.toString(); });
      proc.stderr.on('data', d => { err += d.toString(); });
      proc.on('error', e => resolve({ ok: false, err: e.message }));
      proc.on('close', code => resolve({ ok: code === 0, out, err, code }));
    });
    if (!r.ok) throw new Error(`${args.method} 退出码 ${r.code}: ${(r.err||'').slice(-300)}`);
    // 取 stdout 最后一行（脚本约定：最后一行打印数字，或 JSON {"kpi": <num>}）
    const last = (r.out || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
    value = parseKpiOutput(r.out);
    detail = `${args.method} stdout 末行: ${last}`;
  } else {
    throw new Error('未知 method: ' + args.method);
  }
  return `[opt_extract_kpi] value=${value}\nmethod=${args.method}  case=${path.relative(WORKSPACE, cd) || cd}\n${detail}\nJSON:\n${JSON.stringify({ value, method: args.method, case_path: cd, detail }, null, 2)}`;
}

async function optRecordResult(args) {
  if (!args.study_id) throw new Error('study_id 必填');
  if (args.trial_id === undefined || args.trial_id === null) throw new Error('trial_id 必填');
  const driverArgs = ['record',
    '--study_id', args.study_id,
    '--base_dir', OPT_BASE_DIR,
    '--trial_id', String(args.trial_id),
    '--state', args.state || 'COMPLETE'];
  if (args.value !== undefined && args.value !== null) driverArgs.push('--value', String(args.value));
  if (args.evidence_path) driverArgs.push('--evidence', path.resolve(WORKSPACE, args.evidence_path));
  const r = await _runOptDriver(driverArgs);
  let txt = `[opt_record_result] trial=${args.trial_id} state=${r.state} value=${r.value}\nn_done=${r.n_done}`;
  if (r.best) txt += `\nbest so far: trial=${r.best.trial_id} value=${r.best.value}\nparams=${JSON.stringify(r.best.params)}`;
  return txt + `\nJSON:\n${JSON.stringify(r, null, 2)}`;
}

async function optStatus(args) {
  if (!args.study_id) throw new Error('study_id 必填');
  const r = await _runOptDriver(['status', '--study_id', args.study_id, '--base_dir', OPT_BASE_DIR]);
  const lines = [
    `[opt_status] study=${r.study_id}  sampler=${r.sampler}  direction=${r.direction}`,
    `done=${r.n_done}  pruned=${r.n_pruned}  failed=${r.n_failed}  running=${r.n_running}  budget=${r.budget}`,
  ];
  if (r.best) lines.push(`best: trial=${r.best.trial_id} value=${r.best.value}`,
                         `      params=${JSON.stringify(r.best.params)}`);
  if (r.convergence && r.convergence.length) {
    const tail = r.convergence.slice(-5);
    lines.push('convergence (last 5):');
    for (const c of tail) lines.push(`  trial ${c.trial_id}: value=${c.value}  running_best=${c.running_best}`);
  }
  if (r.importance && !r.importance._error) {
    const sorted = Object.entries(r.importance).sort((a,b) => b[1]-a[1]).slice(0, 8);
    lines.push('param importance:');
    for (const [k, v] of sorted) lines.push(`  ${k}: ${(v*100).toFixed(1)}%`);
  }
  return lines.join('\n') + `\nJSON:\n${JSON.stringify(r, null, 2)}`;
}

async function optRender(args, ws) {
  if (!args.study_id) throw new Error('study_id 必填');
  const kind = args.kind || 'history';
  const outDir = path.join(OPT_BASE_DIR, args.study_id, 'plots');
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${kind}_${Date.now().toString(36)}.png`);
  const r = await _runOptDriver(['render', '--study_id', args.study_id, '--base_dir', OPT_BASE_DIR, '--kind', kind, '--out', outPath]);
  if (!r.ok) throw new Error('opt_render 失败: ' + (r.error || 'unknown'));
  // 推到聊天（复用 sim_render 风格的消息）
  try {
    const buf = await fs.readFile(outPath);
    const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
    const payload = { type: 'sim_render', dataUrl, label: `opt_${kind} (${args.study_id})`, meta: { study: args.study_id, kind } };
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload));
    else for (const c of allClients) if (c.readyState === 1) c.send(JSON.stringify(payload));
  } catch {}
  return `[opt_render] kind=${kind}  ok=true\npath: ${outPath}\n已推送到聊天界面。`;
}

// ====================== v6 \u7f51\u683c\u81ea\u52a8\u6838\u5bf9 / STL 预检 / patch 对照 ======================
// 把 dataUrl(base64 PNG) 写到 tmp 路径，返回路径（给 visionAnalyze 用）
async function _dataUrlToTmpPng(dataUrl, tag) {
  const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error('dataUrl 解析失败');
  const buf = Buffer.from(m[1], 'base64');
  const p = path.join(os.tmpdir(), `dscm_mv_${tag || 'x'}_${crypto.randomBytes(6).toString('hex')}.png`);
  await fs.writeFile(p, buf);
  return p;
}

function _parseCheckMeshOutput(txt) {
  const out = { meshOk: null, nCells: null, nFaces: null, nPoints: null, maxNonOrtho: null, maxSkew: null, maxAspectRatio: null, nNegativeVolumeCells: 0, nOpenCells: 0, failedChecks: [], warnings: [] };
  const m1 = /Mesh OK\./.exec(txt); if (m1) out.meshOk = true;
  const m2 = /Failed\s+(\d+)\s+mesh checks/i.exec(txt); if (m2) { out.meshOk = false; out.failedChecks.push(`Failed ${m2[1]} checks`); }
  const grab = (re, key) => { const m = re.exec(txt); if (m) out[key] = parseFloat(m[1]); };
  grab(/cells:\s*(\d+)/i, 'nCells');
  grab(/faces:\s*(\d+)/i, 'nFaces');
  grab(/points:\s*(\d+)/i, 'nPoints');
  grab(/Max non-orthogonality\s*=\s*([\d.eE+-]+)/, 'maxNonOrtho');
  grab(/Max skewness\s*=\s*([\d.eE+-]+)/, 'maxSkew');
  grab(/Max aspect ratio\s*=\s*([\d.eE+-]+)/, 'maxAspectRatio');
  const neg = /([\d]+)\s+cells with negative volume/i.exec(txt); if (neg) out.nNegativeVolumeCells = parseInt(neg[1], 10);
  const open = /Number of open cells.*?:\s*(\d+)/i.exec(txt); if (open) out.nOpenCells = parseInt(open[1], 10);
  // 收集 *** Warning / *** Failed 行
  for (const line of txt.split(/\r?\n/)) {
    if (/^\s*\*{2,3}\s*/.test(line)) out.warnings.push(line.trim().slice(0, 200));
  }
  // 兜底判断：没有显式 Mesh OK 但也没有 negVol/failed，就按 warnings 判
  if (out.meshOk === null) {
    out.meshOk = (out.nNegativeVolumeCells === 0 && out.failedChecks.length === 0 && (out.maxNonOrtho === null || out.maxNonOrtho < 70) && (out.maxSkew === null || out.maxSkew < 4));
  }
  return out;
}

function _meshVerifyJudge(metrics, stage) {
  const issues = [];
  const suggestions = [];
  if (metrics.nNegativeVolumeCells > 0) { issues.push(`存在 ${metrics.nNegativeVolumeCells} 个负体积 cell`); suggestions.push('降低 snappy refinementSurfaces level 或 location_in_mesh 远离表面；blockMesh 可粗化背景网格'); }
  if (metrics.nOpenCells > 0) { issues.push(`存在 ${metrics.nOpenCells} 个 open cell（拓扑破洞）`); suggestions.push('STL 不封闭或 snappy 没切干净：先 foam_stl_render 检 STL 法向/封闭，必要时 surfaceFeatures 改 includedAngle'); }
  if (metrics.maxNonOrtho !== null && metrics.maxNonOrtho > 70) { issues.push(`maxNonOrtho=${metrics.maxNonOrtho} > 70°`); suggestions.push('加 nNonOrthogonalCorrectors=2~3；或在 fvSchemes 用 limited 0.5'); }
  if (metrics.maxSkew !== null && metrics.maxSkew > 4) { issues.push(`maxSkew=${metrics.maxSkew} > 4`); suggestions.push('降低 snappy refinement 跨级差；增加 nSmoothPatch / nRelaxIter'); }
  if (metrics.maxAspectRatio !== null && metrics.maxAspectRatio > 1000) { issues.push(`maxAspectRatio=${metrics.maxAspectRatio} > 1000`); suggestions.push('边界层第一层太薄：减小 finalLayerThickness 或 expansionRatio'); }
  if (metrics.failedChecks.length) { issues.push(...metrics.failedChecks); }
  const pass = metrics.meshOk === true && metrics.nNegativeVolumeCells === 0 && metrics.nOpenCells === 0 && issues.length === 0;
  return { pass, issues, suggestions };
}

// ============== v6 解析 snappyHexMesh log 的 layer addition 总结 ==============
// 兼容多种 OpenFOAM 版本输出格式：
//   patch              faces    layers   overall thickness
//                       [n]              [m]     (%)
//   impeller          12345    5         1.2e-3  87.2%
// 也兼容 OF v12 / .com 的：
//   Extruding 5 layers on patch impeller, average thickness = 0.0012 m (94%)
function _parseSnappyLayerLog(txt) {
  const out = { patches: {}, overall_coverage_pct: null, layers_warning: [] };
  if (!txt) return out;
  // 形式 A：表格
  const reTable = /^\s*([A-Za-z_][\w.\-]*)\s+(\d+)\s+(\d+)\s+([\d.eE+\-]+)\s+([\d.]+)\s*%/gm;
  let m;
  while ((m = reTable.exec(txt)) !== null) {
    const name = m[1];
    if (['Patch','faces','layers'].includes(name)) continue;
    out.patches[name] = {
      faces: parseInt(m[2], 10),
      layers_added: parseInt(m[3], 10),
      thickness_m: parseFloat(m[4]),
      coverage_pct: parseFloat(m[5])
    };
  }
  // 形式 B：单行 Extruding
  const reLine = /Extruding\s+(\d+)\s+layers? on patch\s+([\w.\-]+).*?thickness\s*=\s*([\d.eE+\-]+).*?\(\s*([\d.]+)\s*%\s*\)/gi;
  while ((m = reLine.exec(txt)) !== null) {
    const name = m[2];
    if (out.patches[name]) continue;
    out.patches[name] = {
      faces: null,
      layers_added: parseInt(m[1], 10),
      thickness_m: parseFloat(m[3]),
      coverage_pct: parseFloat(m[4])
    };
  }
  // 全局总结：取最低 coverage
  const vals = Object.values(out.patches).map(p => p.coverage_pct).filter(v => isFinite(v));
  if (vals.length) {
    out.overall_coverage_pct = Math.min(...vals);
    for (const [k, v] of Object.entries(out.patches)) {
      if (v.coverage_pct < 80) out.layers_warning.push(`${k}: 仅 ${v.coverage_pct.toFixed(1)}% 层覆盖`);
    }
  }
  // 没解析到 layers 也不是错——可能根本没开 addLayers
  if (!vals.length && /addLayers\s+true/i.test(txt) === false) {
    out.layers_warning.push('snappy log 中未启用 addLayers，跳过 layer 解析');
  }
  return out;
}
async function _readSnappyLogIfAny(casePath) {
  // 常见 log 位置：log.snappyHexMesh / log/snappyHexMesh / runs/<id>/log.snappyHexMesh
  const cands = [
    path.join(casePath, 'log.snappyHexMesh'),
    path.join(casePath, 'log', 'snappyHexMesh.log'),
    path.join(casePath, 'log', 'snappyHexMesh'),
  ];
  for (const c of cands) {
    try { const s = await fs.stat(c); if (s.isFile()) return await fs.readFile(c, 'utf8'); } catch {}
  }
  return null;
}

async function foamMeshVerify(args, ws, session) {
  const { case_path, stage = 'final', ask_vision = true, n_views = 2 } = args || {};
  if (!case_path) throw new Error('foam_mesh_verify: case_path 必填');
  const abs = path.isAbsolute(case_path) ? case_path : path.resolve(WORKSPACE, case_path);
  // 1) checkMesh
  const checkOut = await runOpenFoam({ casePath: abs, command: 'checkMesh -allTopology -allGeometry' }, ws);
  const metrics = _parseCheckMeshOutput(checkOut);
  // 1b) snappyHexMesh log 解析 layer coverage（如果有）
  const snapLog = await _readSnappyLogIfAny(abs);
  const layers = _parseSnappyLayerLog(snapLog || '');
  // 2) 渲染 n_views 张（覆盖等角 + 顶视，stage=snappy 时多加一个侧切）
  const camPresets = [
    { azimuth: 30, elevation: 20, tag: 'iso' },
    { azimuth: 0,  elevation: 89, tag: 'top' },
    { azimuth: 90, elevation: 0,  tag: 'side' },
    { azimuth: 60, elevation: -10, tag: 'iso2' }
  ];
  const k = Math.max(1, Math.min(4, n_views | 0 || 2));
  const renders = [];
  for (let i = 0; i < k; i++) {
    try {
      const cam = camPresets[i];
      const r = await pvRenderOffscreen({ casePath: abs, azimuth: cam.azimuth, elevation: cam.elevation });
      const p = await _dataUrlToTmpPng(r.dataUrl, `${stage}_${cam.tag}`);
      renders.push({ tag: cam.tag, path: p });
      // 顺手广播到前端 ParaView 面板
      try { pvBroadcast({ type: 'sim_frame', dataUrl: r.dataUrl, meta: { ...(r.meta||{}), label: `mesh_verify/${stage}/${cam.tag}` } }); } catch {}
    } catch (e) {
      renders.push({ tag: camPresets[i].tag, error: e.message });
    }
  }
  // 3) 视觉裁判（可选）
  let vision = '';
  const okRenders = renders.filter(x => x.path).map(x => x.path);
  if (ask_vision && okRenders.length) {
    const q = `这是 OpenFOAM 算例在 ${stage} 阶段的网格渲染图（${okRenders.length} 个视角）。请按以下硬性 checklist 逐条判断并只输出 JSON：\n` +
      `{"shape_ok": true/false, "shape_reason": "...",\n` +
      ` "boundary_clean": true/false, "boundary_reason": "...",\n` +
      ` "refinement_reasonable": true/false, "refinement_reason": "...",\n` +
      ` "obvious_defects": ["..."],\n` +
      ` "overall_pass": true/false}\n` +
      `检查点：① 整体几何外形是否与预期 case 一致（不要变形/缺角）；② 边界面是否干净、没有锯齿状破裂；③ 加密区域是否合理（贴近物体、不浪费在空气）；④ 有无明显的孔洞、悬空 cell、超长拉伸。回答全部用中文。`;
    try {
      const progress = session && typeof session._progressPub === 'function' ? session._progressPub : null;
      vision = await visionAnalyze(okRenders, q, 800, progress);
    } catch (e) { vision = 'vision_analyze 调用失败：' + e.message; }
  }
  // 4) 综合裁决
  const j = _meshVerifyJudge(metrics, stage);
  // 4b) layer coverage 纳入判定（stage=layers 或 final 时硬性要求 >=80%）
  const layerIssues = [];
  const layerSuggestions = [];
  if (layers && Object.keys(layers.patches).length) {
    for (const [k, v] of Object.entries(layers.patches)) {
      if (v.coverage_pct != null && v.coverage_pct < 80 && (stage === 'layers' || stage === 'final')) {
        layerIssues.push(`patch ${k}: layer 覆盖仅 ${v.coverage_pct.toFixed(1)}% (<80%)`);
      }
    }
    if (layerIssues.length) {
      layerSuggestions.push('边角 layer 覆盖不足→ ① 调小 first_layer_thickness 或 expansionRatio；② 加大 nLayerIter、nRelaxedIter；③ 把 featureAngle 调大到 130~150；④ 若是薄壁/小特征，提高表面 refinement level 让 cell 更细。');
    }
  }
  // 视觉若明显反对，也降为 fail
  let visionPass = null;
  const mvJson = /\{[\s\S]*"overall_pass"\s*:\s*(true|false)[\s\S]*\}/.exec(vision || '');
  if (mvJson) visionPass = mvJson[1] === 'true';
  const finalPass = j.pass && (visionPass !== false) && layerIssues.length === 0;
  const allIssues = [...j.issues, ...layerIssues];
  const allSugg = [...j.suggestions, ...layerSuggestions];
  const result = {
    pass: finalPass,
    stage,
    metrics,
    layers: layers && Object.keys(layers.patches).length ? layers : null,
    issues: allIssues,
    suggestions: allSugg,
    renders: renders.map(r => r.path ? { tag: r.tag, path: r.path } : { tag: r.tag, error: r.error }),
    vision_pass: visionPass,
    vision: vision || '(未调用 VLM)'
  };
  // 给 LLM 一个紧凑可读的文本 + JSON 双视图
  const head = finalPass ? `✓ [mesh_verify/${stage}] 通过` : `✗ [mesh_verify/${stage}] 未通过 (${allIssues.length} 项问题)`;
  const layerSummary = layers && Object.keys(layers.patches).length
    ? `\nlayers: ` + Object.entries(layers.patches).map(([k,v])=>`${k}=${v.layers_added}层/${v.coverage_pct?.toFixed?.(0) ?? '?'}%`).join(', ')
    : '';
  return `${head}\n` +
    `metrics: cells=${metrics.nCells} faces=${metrics.nFaces} maxNonOrtho=${metrics.maxNonOrtho} maxSkew=${metrics.maxSkew} negVol=${metrics.nNegativeVolumeCells} openCells=${metrics.nOpenCells}` + layerSummary + `\n` +
    (allIssues.length ? `issues:\n  - ${allIssues.join('\n  - ')}\n` : '') +
    (allSugg.length ? `suggestions:\n  - ${allSugg.join('\n  - ')}\n` : '') +
    (vision ? `\n=== VLM 视觉评审 ===\n${vision.slice(0, 1200)}\n` : '') +
    `\n=== JSON ===\n${JSON.stringify(result, null, 2)}`;
}

// ============== v6 · STL 贴合度核验 (foam_mesh_stl_check) ==============
async function foamMeshStlCheck(args, ws) {
  const { case_path, ref_stl, patches, samples = 5000,
          tol_mean_pct = 2.0, tol_p95_pct = 5.0, tol_max_pct = 10.0 } = args || {};
  if (!case_path) throw new Error('foam_mesh_stl_check: case_path 必填');
  if (!ref_stl)   throw new Error('foam_mesh_stl_check: ref_stl 必填（原始 STL 路径）');
  if (!Array.isArray(patches) || patches.length === 0)
    throw new Error('foam_mesh_stl_check: patches 必填，至少一个 patch 名');

  const absCase = path.isAbsolute(case_path) ? case_path : path.resolve(WORKSPACE, case_path);
  if (!await pathExistsSync(absCase)) throw new Error('case_path 不存在: ' + absCase);
  const refAbs = path.isAbsolute(ref_stl) ? ref_stl : path.resolve(absCase, ref_stl);
  if (!await pathExistsSync(refAbs)) throw new Error('ref_stl 不存在: ' + refAbs);

  // 1) 用 surfaceMeshTriangulate 把 patch 网格表面导出 STL
  const triDir = path.join(absCase, 'constant', 'triSurface');
  await fs.mkdir(triDir, { recursive: true });
  const extracted = path.join(triDir, '_nullflux_mesh_extracted.stl');
  try { await fs.unlink(extracted); } catch {}
  const patchList = '(' + patches.join(' ') + ')';
  // 注意：surfaceMeshTriangulate 接受相对 case 的输出路径
  const relOut = path.relative(absCase, extracted).replace(/\\/g, '/');
  const cmd = `surfaceMeshTriangulate -patches '${patchList}' '${relOut}'`;
  const ofOut = await runOpenFoam({ casePath: absCase, command: cmd }, ws);
  if (!await pathExistsSync(extracted)) {
    return `❌ [foam_mesh_stl_check] surfaceMeshTriangulate 未产出 STL：${extracted}\n` +
      `常见原因：patch 名拼错、网格没生成、polyMesh/ 不存在。\n` +
      `OpenFOAM 输出 tail:\n${ofOut.slice(-1500)}`;
  }

  // 2) 调 Python 核验
  const py = SETTINGS.pythonPath || (IS_WIN ? 'python' : 'python3');
  const script = path.join(__dirname, 'mesh_stl_check.py');
  const pyArgs = [script,
    '--ref', refAbs,
    '--mesh', extracted,
    '--samples', String(samples),
    '--tol_mean_pct', String(tol_mean_pct),
    '--tol_p95_pct',  String(tol_p95_pct),
    '--tol_max_pct',  String(tol_max_pct),
  ];
  const r = await new Promise((resolve, reject) => {
    const proc = spawn(py, pyArgs, { windowsHide: true });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('error', e => reject(new Error('spawn mesh_stl_check.py 失败: ' + e.message)));
    proc.on('close', code => {
      const last = out.trim().split(/\r?\n/).filter(Boolean).pop() || '';
      try { resolve(JSON.parse(last)); }
      catch (e) {
        reject(new Error(`mesh_stl_check 退出码 ${code}，stdout 末尾非 JSON：\n${last.slice(0,400)}\nstderr:${err.slice(-400)}`));
      }
    });
  });

  if (!r.ok) {
    return `❌ [foam_mesh_stl_check] python 报错：${r.error || '(unknown)'}\n${(r.trace || '').slice(-600)}`;
  }
  const verdict = r.pass ? '✅ PASS' : '❌ FAIL';
  const lines = [];
  lines.push(`${verdict} [foam_mesh_stl_check]  patches=${patches.join(',')}`);
  lines.push(`  bbox 对角线 L = ${r.L_diag_ref}  (单位与 STL 一致)`);
  lines.push(`  bbox 偏差   = ${r.bbox_diff_pct_of_L}% L`);
  lines.push(`  表面积比 mesh/ref = ${(r.area_ratio_mesh_over_ref*100).toFixed(1)}%`);
  lines.push(`  ref→mesh: mean=${r.forward_ref_to_mesh.mean.toFixed(6)}  p95=${r.forward_ref_to_mesh.p95.toFixed(6)}  max=${r.forward_ref_to_mesh.max.toFixed(6)}`);
  lines.push(`  mesh→ref: mean=${r.reverse_mesh_to_ref.mean.toFixed(6)}  p95=${r.reverse_mesh_to_ref.p95.toFixed(6)}  max=${r.reverse_mesh_to_ref.max.toFixed(6)}`);
  lines.push(`  → 占 L %: mean=${r.mean_pct_of_L}%  p95=${r.p95_pct_of_L}%  Hausdorff=${r.hausdorff_pct_of_L}%`);
  if (r.issues && r.issues.length) {
    lines.push('  ⚠ 检出问题:');
    r.issues.forEach(s => lines.push('    - ' + s));
  }
  if (!r.pass) {
    lines.push('  🔧 修复建议（按顺序试）:');
    lines.push('    1) 提高 snappyHexMeshDict 的 refinement level (面 → +1)，加 featureEdgeMesh 提取边');
    lines.push('    2) snap{ nSmoothPatch ↑ 5→10, tolerance ↓ 2→1, nSolveIter ↑ 30→100 }');
    lines.push('    3) 检查 locationInMesh 是否落在期望的流场域内部（不是固体内）');
    lines.push('    4) 若 castellated 漏面：提高 maxLocalCells / maxGlobalCells，或减小 minRefinementCells');
    lines.push('    5) layer 鼓包（mesh→ref max 大）：finalLayerThickness 减小、relativeSizes=true');
  }
  lines.push(`  triangles: ref=${r.tri_count_ref}, mesh=${r.tri_count_mesh}, samples=${r.samples}`);
  lines.push('\n=== JSON ===\n' + JSON.stringify(r, null, 2));
  return lines.join('\n');
}

async function foamStlRender(args, ws) {
  const { stl_path, n_views = 3 } = args || {};
  if (!stl_path) throw new Error('foam_stl_render: stl_path 必填');
  const abs = path.isAbsolute(stl_path) ? stl_path : path.resolve(WORKSPACE, stl_path);
  await fs.access(abs);
  // 先取一份几何元数据（复用现有 inspect）
  let inspect = null;
  try { inspect = await foamStlInspect(stl_path); } catch (e) { inspect = '(foam_stl_inspect 失败: ' + e.message + ')'; }
  const presets = [
    { azimuth: 0,  elevation: 0,  tag: 'front' },
    { azimuth: 0,  elevation: 89, tag: 'top' },
    { azimuth: 30, elevation: 20, tag: 'iso' },
    { azimuth: 90, elevation: 0,  tag: 'side' }
  ];
  const k = Math.max(1, Math.min(4, n_views | 0 || 3));
  const out = [];
  for (let i = 0; i < k; i++) {
    const cam = presets[i];
    try {
      const r = await pvRenderOffscreen({ casePath: abs, azimuth: cam.azimuth, elevation: cam.elevation });
      const p = await _dataUrlToTmpPng(r.dataUrl, `stl_${cam.tag}`);
      out.push({ tag: cam.tag, path: p });
      try { pvBroadcast({ type: 'sim_frame', dataUrl: r.dataUrl, meta: { label: `stl_render/${cam.tag}` } }); } catch {}
    } catch (e) { out.push({ tag: cam.tag, error: e.message }); }
  }
  const head = `[foam_stl_render] ${path.basename(abs)} → ${out.filter(x => x.path).length}/${k} 视角已渲染并推送到 ParaView 面板。`;
  return head + '\n\n=== foam_stl_inspect ===\n' + (typeof inspect === 'string' ? inspect : JSON.stringify(inspect, null, 2)) +
    '\n\n=== 渲染图路径（可传给 vision_analyze） ===\n' + JSON.stringify(out, null, 2);
}

// 解析 constant/polyMesh/boundary（OpenFOAM 文本字典）→ [{name,type,nFaces,startFace}]
function _parseFoamBoundary(txt) {
  const patches = [];
  // 找顶层 ( ... ) 区块
  const top = /\(([\s\S]*)\)\s*\/\/?\s*\*?\s*$/.exec(txt) || /\(([\s\S]*)\)\s*$/.exec(txt);
  const body = top ? top[1] : txt;
  // 每个 patch 形如：name { type ...; nFaces ...; startFace ...; }
  const re = /([A-Za-z_][A-Za-z0-9_.\-]*)\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(body))) {
    const name = m[1];
    if (name === 'FoamFile') continue;
    const block = m[2];
    const get = (k) => { const r = new RegExp(k + '\\s+([^;\\s]+)\\s*;').exec(block); return r ? r[1] : null; };
    patches.push({
      name,
      type: get('type'),
      physicalType: get('physicalType'),
      nFaces: parseInt(get('nFaces') || '0', 10) || 0,
      startFace: parseInt(get('startFace') || '0', 10) || 0
    });
  }
  return patches;
}

async function foamPatchDiff(args) {
  const { case_path, snapshot_before } = args || {};
  if (!case_path) throw new Error('foam_patch_diff: case_path 必填');
  const abs = path.isAbsolute(case_path) ? case_path : path.resolve(WORKSPACE, case_path);
  const bfile = path.join(abs, 'constant', 'polyMesh', 'boundary');
  let txt;
  try { txt = await fs.readFile(bfile, 'utf8'); }
  catch (e) { throw new Error('读不到 constant/polyMesh/boundary（mesh 还没生成？）: ' + e.message); }
  const patches = _parseFoamBoundary(txt);
  let diff = null;
  if (snapshot_before) {
    try {
      const prev = JSON.parse(snapshot_before);
      const prevMap = new Map((prev.patches || prev).map(p => [p.name, p]));
      const curMap = new Map(patches.map(p => [p.name, p]));
      const added = [], removed = [], changed = [];
      for (const [n, p] of curMap) if (!prevMap.has(n)) added.push(p);
      for (const [n, p] of prevMap) if (!curMap.has(n)) removed.push(p);
      for (const [n, p] of curMap) {
        const pv = prevMap.get(n);
        if (pv && (pv.type !== p.type || pv.nFaces !== p.nFaces)) changed.push({ name: n, before: pv, after: p });
      }
      diff = { added, removed, changed };
    } catch (e) { diff = { error: 'snapshot_before 解析失败: ' + e.message }; }
  }
  const summary = patches.map(p => `  ${p.name.padEnd(20)} ${String(p.type).padEnd(14)} nFaces=${p.nFaces}`).join('\n');
  return `[foam_patch_diff] ${path.relative(WORKSPACE, abs)} 共 ${patches.length} 个 patch:\n${summary}\n\n=== JSON ===\n${JSON.stringify({ patches, diff }, null, 2)}`;
}

// ====================== v0.6.0 自治可靠性模块 ======================
// 1) 微型 JSON Schema 校验器（仅支持 server 内 TOOLS 使用的子集：type/properties/required/items/enum/minimum/maximum/pattern）
function _schemaCheck(schema, value, p, issues) {
  if (!schema || typeof schema !== 'object') return;
  const t = schema.type;
  if (t === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) { issues.push(`${p} 应为 object`); return; }
    if (Array.isArray(schema.required)) {
      for (const k of schema.required) if (!(k in value)) issues.push(`${p}.${k} 缺失（required）`);
    }
    if (schema.properties) {
      for (const k of Object.keys(value)) {
        if (schema.properties[k]) _schemaCheck(schema.properties[k], value[k], `${p}.${k}`, issues);
      }
    }
  } else if (t === 'array') {
    if (!Array.isArray(value)) { issues.push(`${p} 应为 array`); return; }
    if (schema.items) for (let i = 0; i < value.length; i++) _schemaCheck(schema.items, value[i], `${p}[${i}]`, issues);
  } else if (t === 'string') {
    if (typeof value !== 'string') { issues.push(`${p} 应为 string`); return; }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) issues.push(`${p}="${value}" 不在 enum=${JSON.stringify(schema.enum)}`);
    if (schema.pattern) { try { if (!new RegExp(schema.pattern).test(value)) issues.push(`${p} 不匹配 ${schema.pattern}`); } catch {} }
  } else if (t === 'number' || t === 'integer') {
    if (typeof value !== 'number' || !isFinite(value)) { issues.push(`${p} 应为 number`); return; }
    if (t === 'integer' && !Number.isInteger(value)) issues.push(`${p} 应为整数`);
    if (typeof schema.minimum === 'number' && value < schema.minimum) issues.push(`${p} < minimum ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) issues.push(`${p} > maximum ${schema.maximum}`);
  } else if (t === 'boolean') {
    if (typeof value !== 'boolean') issues.push(`${p} 应为 boolean`);
  }
}
function validateToolInput(name, args) {
  const t = TOOLS.find(x => x.function && x.function.name === name);
  if (!t) return { ok: true, issues: [] }; // 未知工具交给后续 default 分支
  const issues = [];
  _schemaCheck(t.function.parameters || { type: 'object' }, args == null ? {} : args, '$', issues);
  return { ok: issues.length === 0, issues };
}

// v6.0.1: 宽容参数名别名 —— 不同大模型会发 file_path/text/body/…，这里统一归位到准的 path/content。
const TOOL_ARG_ALIAS = {
  // 路径类
  file_path: 'path', filePath: 'path', filepath: 'path', file: 'path', target: 'path', filename: 'path', file_name: 'path',
  dir: 'path', directory: 'path', folder: 'path',
  // 内容类
  text: 'content', body: 'content', data: 'content', source: 'content', code: 'content', file_content: 'content', fileContent: 'content', new_content: 'content', newContent: 'content',
  // edit_file
  oldStr: 'old_str', old_string: 'old_str', oldString: 'old_str', search: 'old_str', find: 'old_str',
  newStr: 'new_str', new_string: 'new_str', newString: 'new_str', replace: 'new_str', replacement: 'new_str',
  // run_command
  cmd: 'command', shell: 'command', script: 'command', bash: 'command'
};
// 工具级别名（仅特定工具适用，避免污染 query/url 等通用字段）
const TOOL_ARG_ALIAS_BY_TOOL = {
  grep_search: { query: 'pattern', regex: 'pattern', text: 'pattern' }
};
function normalizeToolArgs(args, toolName) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const perTool = (toolName && TOOL_ARG_ALIAS_BY_TOOL[toolName]) || null;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    let canon = k;
    if (perTool && perTool[k]) canon = perTool[k];
    else if (TOOL_ARG_ALIAS[k]) canon = TOOL_ARG_ALIAS[k];
    // 不覆盖已存在的准名字段
    if (out[canon] === undefined) out[canon] = v;
  }
  return out;
}

// 2) Run/Stage 状态机（落盘 runs/<runId>/state.json + memo.json，方便重启接续）
const _RUNS_DIR = () => path.join(WORKSPACE, 'runs');
function _ensureRunState(session) {
  if (!session.runState) session.runState = { runId: null, label: '', stages: [], failCount: {}, memos: [], startedAt: 0 };
  return session.runState;
}
async function _writeRunState(rs) {
  if (!rs.runId) return;
  try {
    const dir = path.join(_RUNS_DIR(), rs.runId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(rs, null, 2), 'utf8');
  } catch {}
}
async function startRun(session, label) {
  const rs = _ensureRunState(session);
  rs.runId = 'run_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  rs.label = String(label || '').slice(0, 80);
  rs.stages = []; rs.failCount = {}; rs.memos = []; rs.startedAt = Date.now();
  await _writeRunState(rs);
  return rs;
}
async function stageStart(session, stageName) {
  const rs = _ensureRunState(session);
  if (!rs.runId) await startRun(session, stageName);
  rs.stages.push({ name: stageName, status: 'in_progress', startedAt: Date.now(), endedAt: 0, verify: null, artifacts: [], memo: '' });
  await _writeRunState(rs);
  return rs.stages[rs.stages.length - 1];
}
async function stageDone(session, stageName, opts) {
  const rs = _ensureRunState(session);
  const s = [...rs.stages].reverse().find(x => x.name === stageName && x.status === 'in_progress') || rs.stages[rs.stages.length - 1];
  if (s) {
    s.status = (opts && opts.passed === false) ? 'failed' : 'done';
    s.endedAt = Date.now();
    if (opts && opts.verify) s.verify = opts.verify;
    if (opts && Array.isArray(opts.artifacts)) s.artifacts = opts.artifacts;
    if (opts && opts.memo) { s.memo = String(opts.memo); rs.memos.push({ stage: stageName, t: Date.now(), text: s.memo }); }
  }
  await _writeRunState(rs);
  return s;
}

// 3) Watchdog
const WATCHDOG = { maxFailPerTool: 5, maxRunMs: 6 * 3600 * 1000 };
function recordToolResult(session, name, ok) {
  const rs = _ensureRunState(session);
  if (ok) rs.failCount[name] = 0;
  else rs.failCount[name] = (rs.failCount[name] || 0) + 1;
}
function checkWatchdog(session) {
  const rs = _ensureRunState(session);
  // 长算例（3D 流化床动辄数天）可在 settings.json 用 maxRunHours 放开；默认 6 小时
  const capMs = Number(SETTINGS.maxRunHours) > 0 ? Number(SETTINGS.maxRunHours) * 3600_000 : WATCHDOG.maxRunMs;
  if (rs.startedAt && (Date.now() - rs.startedAt) > capMs) {
    return { stop: true, reason: `Run 运行已超过 ${(capMs/3600000).toFixed(1)} 小时硬上限（settings.maxRunHours）` };
  }
  for (const [k, v] of Object.entries(rs.failCount || {})) {
    if (v >= WATCHDOG.maxFailPerTool) return { stop: true, reason: `工具 ${k} 连续失败 ${v} 次，已熔断` };
  }
  return { stop: false };
}

// 从 VLM 回答里取第一个能解析的 JSON 对象（回答前面可能有 "[vision_analyze · 1 张图 …]" 标头、后面可能有说明）
function _firstJsonObject(s) {
  for (let i = s.indexOf('{'); i >= 0; i = s.indexOf('{', i + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        const cand = s.slice(i, j + 1);
        try { JSON.parse(cand); return [cand]; } catch { break; }
      }
    }
  }
  return null;
}
// 4) 通用视觉 Verifier（统一 JSON 返回）
async function genericVisionVerify(stage, prompt, imagePaths, expected) {
  // 没有图 = 没法验，不是"验证失败"：passed=null 不进 verifier 硬门，否则会把正确结果拦在收尾前
  if (!imagePaths || !imagePaths.length) return { passed: null, score: 0, reasons: ['无渲染图可供验证（未验证，不算失败）'], suggestions: ['先渲染出图（或用 Cl/残差等数值核验）后再校验'] };
  const q = `【${stage} 验证】\n${prompt || ''}\n${expected ? '\n期望特征：' + expected : ''}\n\n请严格按以下 JSON 格式输出（且只输出 JSON，不要任何额外文字）：\n{"passed": true|false, "score": 0~100, "reasons": ["..."], "suggestions": ["..."]}`;
  const ans = await visionAnalyze(imagePaths.slice(0, 4), q, 800);
  const m = _firstJsonObject(String(ans));
  if (!m) return { passed: false, score: 0, reasons: ['VLM 输出非 JSON'], suggestions: [], raw: String(ans).slice(0, 400) };
  try { const j = JSON.parse(m[0]); return { passed: !!j.passed, score: +j.score || 0, reasons: j.reasons || [], suggestions: j.suggestions || [], raw: m[0] }; }
  catch (e) { return { passed: false, score: 0, reasons: ['JSON 解析失败: ' + e.message], suggestions: [], raw: m[0] }; }
}

// 5) 读文档视觉回退：读失败 / 文本过短 → 把已渲染的页面图丢给 VLM 转回基线
const _DOC_FALLBACK_MIN_CHARS = 200;
async function readWithVisionFallback(kind, args, session, baseFn) {
  let baseResult = null, baseErr = null;
  try { baseResult = await baseFn(); }
  catch (e) { baseErr = e; }
  // 抽取实际文本量评估（read_document 返回带头部 [pdf · 12 页]）
  const txt = typeof baseResult === 'string' ? baseResult : '';
  // 去掉头部 [..] 与"--- 提取的图片..." 之后的尾部
  const body = txt.replace(/^\[[^\]]*\]\s*/, '').split('\n--- 提取的图片')[0] || '';
  const stripped = body.replace(/\s/g, '');
  const baselineEmpty = baseErr || !txt || /^(读取失败|解析失败|调用 Python 失败)/.test(txt) || stripped.length < _DOC_FALLBACK_MIN_CHARS;
  if (!baselineEmpty) return baseResult;

  // 触发视觉回退：先尝试用 readDocument 获取已渲染的扫描页图片清单
  const progress = session && session._progressPub ? session._progressPub : () => {};
  progress(`[vision_fallback] 基线读取失败/过短，尝试用 VLM 识别 ${args.path} …`);
  let pageImages = [];
  try {
    const abs = path.isAbsolute(args.path) ? args.path : safePath(args.path);
    const py = SETTINGS.pythonPath || (IS_WIN ? 'python' : 'python3');
    const script = path.join(__dirname, 'doc_reader.py');
    const safeBase = path.basename(abs).replace(/[^\w.\-]+/g, '_').slice(0, 80);
    const imgOutAbs = path.join(WORKSPACE, '.cache', 'pdf_images', safeBase + '_vfb_' + Date.now().toString(36));
    await fs.mkdir(imgOutAbs, { recursive: true });
    const out = await new Promise((resolve) => {
      const proc = spawn(py, [script, abs], { windowsHide: true, env: { ...process.env, PDF_IMG_OUT_DIR: imgOutAbs, PDF_FORCE_RENDER: '1' } });
      let buf = '', err = '';
      proc.stdout.on('data', d => { buf += d.toString(); });
      proc.stderr.on('data', d => { err += d.toString(); });
      proc.on('error', () => resolve({ ok: false, err: 'spawn' }));
      proc.on('close', () => { try { resolve(JSON.parse(buf)); } catch { resolve({ ok: false, err: err.slice(-300) }); } });
    });
    if (out && Array.isArray(out.images)) {
      pageImages = out.images.filter(im => im.kind === 'scan_page' || im.kind === 'page').map(im => im.path);
      if (!pageImages.length) pageImages = out.images.slice(0, 6).map(im => im.path).filter(Boolean);
    }
  } catch (e) {
    return `[vision_fallback 失败] 渲染页面阶段：${e.message}\n(基线错误：${baseErr ? baseErr.message : (txt || '').slice(0, 200)})`;
  }
  if (!pageImages.length) {
    return `[vision_fallback 失败] 无法获得页面图像\n(基线错误：${baseErr ? baseErr.message : (txt || '').slice(0, 200)})`;
  }
  progress(`[vision_fallback] 取得 ${pageImages.length} 页图片，调用 VLM 逐页识别 …`);
  const MAX_PAGES = 8;
  const pages = [];
  for (let i = 0; i < Math.min(pageImages.length, MAX_PAGES); i++) {
    const q = `这是 ${kind === 'paper' ? '论文' : '文档'} 第 ${i+1} 页的图像。请准确转录页面中的全部文字（含标题、正文、表格、图注、公式用 LaTeX）。仅输出该页文字，不要解释。`;
    let ans = '';
    try { ans = await visionAnalyze([pageImages[i]], q, 2000); } catch (e) { ans = '[识别失败: ' + e.message + ']'; }
    pages.push({ page: i + 1, text: String(ans).replace(/^\[vision_analyze[^\]]*\]\s*/, '') });
  }
  const merged = pages.map(p => `\n--- 第 ${p.page} 页 ---\n${p.text}`).join('\n');
  const tail = pageImages.length > MAX_PAGES ? `\n... [仅识别前 ${MAX_PAGES} 页，共 ${pageImages.length} 页] ...` : '';
  return `[vision_fallback · ${pages.length}/${pageImages.length} 页]\n基线读取失败/文本过短，已用 VLM 转回文本基线。${tail}${merged}`;
}
// ====================== v0.6.0 模块结束 ======================

// 论文复现保真度门：重大偏离未经用户批准 → 拦截求解/收尾
// 命令要占多少核：mpirun 后面的 -np / -n N；命令是脚本（./Allrun、bash run.sh）时读脚本里的 mpirun -np N 或 -np $NP
const _MPI_NP_RE = /mpi(?:run|exec)\b[^\n;|&]*?\s-{1,2}np?\s+(?:(\d+)|\$\{?(\w+)\}?)/g;
const _MPI_LAUNCH_RE = /(?:^|[\s;&(])mpi(?:run|exec)\s/;
function _npOf(command, cwd) {
  const text = String(command || '');
  const direct = /(?:^|[\s;&(])mpi(?:run|exec)(?=\s)[^\n;|&]*?\s-{1,2}np?\s+(\d+)/.exec(text);  // 只认命令位置的 mpirun
  if (direct) return +direct[1];
  const sm = /(?:^|[;&(])\s*(?:(?:bash|sh|nohup|time)\s+)*((?:\.{0,2}\/)?[\w./-]*(?:All\w*|\.sh))(?=[\s;&)]|$)/.exec(text);
  if (!sm) return 1;
  try {
    const base = String(cwd || '').replace(/^~(?=\/)/, os.homedir());
    const body = fssync.readFileSync(path.isAbsolute(sm[1]) ? sm[1] : path.resolve(WORKSPACE, base, sm[1]), 'utf8').slice(0, 200_000);
    let best = 1;
    for (const m of body.matchAll(_MPI_NP_RE)) {
      const def = m[2] ? new RegExp('^\\s*(?:export\\s+)?' + m[2] + '=["\']?(\\d+)', 'm').exec(body) : null;
      const v = m[1] ? +m[1] : def ? +def[1] : 0;
      if (v > best) best = v;
    }
    return best;
  } catch (e) { return 1; }
}
// 新作业 -np + 在跑的 MPI 求解进程数 > 核数 → 拒绝（超订会让两个作业都变慢数倍）
function _cpuOversubscribed(command, allow, cwd) {
  if (activeOptTrial) return `[CPU 守卫] CFD pipeline ${activeOptTrial} 正在独占求解资源，请等待流水线结束。`;
  if (allow || SETTINGS.cpuGuard === false) return '';
  const want = _npOf(command, cwd);
  let busy = 0, jobs = [];
  for (const r of SOLVER_RUNS.values()) {
    if (r.ended) continue;
    const n = _npOf(r.command, r.casePath);
    busy += n; jobs.push(`${r.runId}(${n}核)`);
  }
  // 本服务没登记的求解器（别的任务 / RSI / 手动 mpirun）也占核：/proc 里实际在跑的 Foam 进程数取较大者
  if (process.platform === 'linux') {
    const real = _foamProcSnapshot(2000).length;
    if (real > busy) { jobs.push(`未登记求解进程 ${real - busy} 个`); busy = real; }
  }
  const cores = Number(SETTINGS.maxCores) || (os.availableParallelism?.() ?? os.cpus().length);
  if (!busy || busy + want <= cores) return '';
  return `[CPU 守卫] ⛔ 拒绝启动：本机 ${cores} 核，已在跑 ${jobs.join(', ')} 共 ${busy} 核，新作业 -np ${want} → 超订 ${busy + want}/${cores}，两个作业都会变慢数倍。` +
    `\n选项：① solver_wait 等现有作业结束后再跑；② 把新作业 -np 降到 ≤${Math.max(1, cores - busy)}；③ 冒烟/诊断可复制算例到 /tmp 用剩余核跑。确属必要再传 allow_oversubscribe=true。`;
}

// 运行中算例的 system/constant 字典会被 runTimeModifiable 重读，写错一个 functionObject 就带崩整个长跑
function _liveCaseEditGuard(target, isCmd, allow) {
  if (allow || SETTINGS.liveEditGuard === false) return '';
  const t = String(target || '').replace(/^~(?=\/)/, os.homedir());
  for (const r of SOLVER_RUNS.values()) {
    if (r.ended || !r.casePath) continue;
    const cp = r.casePath.replace(/\/+$/, '');
    let hit = false;
    if (!isCmd) hit = /^(system|constant)\//.test(path.relative(cp, path.resolve(t)).replace(/\\/g, '/'));
    else {
      const inCase = t.includes(cp) || new RegExp(`cd\\s+["']?${cp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t);
      hit = inCase && /(>>?\s*["']?(\S*\/)?(system|constant)\/|sed\s+-i[^;&|]*\s(\S*\/)?(system|constant)\/|foamDictionary[^;&|]*\s(\S*\/)?(system|constant)\/[^;&|]*-(set|add|remove)|(cp|mv)\s[^;&|]*\s(\S*\/)?(system|constant)\/)/.test(t);
    }
    if (hit) return `[运行中算例保护] ⛔ ${r.runId} 正在 ${cp} 求解；改它的 system/ 或 constant/ 会被 runTimeModifiable 立即重读，写错一处（如 functionObject 字段名）就会带崩整个长跑。` +
      `\n做法：① 新 functionObject 先复制算例到 /tmp 用 postProcess -func / 短跑验证；② 能后处理补算的（截面通量等）用 postProcess -time 对已写出时刻算，不改运行中字典；③ 确需改运行中字典（如 endTime），先在临时文件写好并验证，再传 allow_live_edit=true 一次性 mv 替换。`;
  }
  return '';
}

async function _fidelityGate(session, casePath, action) {
  try {
    const cd = casePath ? (path.isAbsolute(casePath) ? casePath : path.resolve(WORKSPACE, casePath)) : '';
    const added = await Fidelity.scanCase(session, cd, session._pendingUserText || '');
    const msg = Fidelity.gateMessage(session, action);
    if (msg && added.length) persistSession(session, true);
    return msg;
  } catch (e) { console.warn('[fidelity]', e.message); return ''; }
}

async function execTool(name, args, session, ws) {
  // v6.0.1: 先做参数名别名归位，避免模型发错 key 被当成 schema 错误冲起 watchdog
  args = normalizeToolArgs(args, name);
  // v6: 输入 Schema 校验（找不到工具的不拦截，交给 default）
  try {
    const v = validateToolInput(name, args || {});
    if (!v.ok) {
      // v6.0.1: schema 错不计入 watchdog failCount——只是参数名错了，不是真正的执行失败。
      // 避免“模型意图是对的但 key 反复发错”则5次就熔断。
      return `[SCHEMA_INPUT_ERROR] 工具 ${name} 参数不合法：\n - ` + v.issues.join('\n - ') + `\n请按 JSON Schema 修正后重试。\n提示：准字段名是 path / content / old_str / new_str / pattern / command，不要用 file_path / text / body / oldStr 之类。`;
    }
  } catch {}
  // v6: Watchdog 熔断检查
  try {
    const wd = checkWatchdog(session);
    if (wd.stop) return `[WATCHDOG_HALT] ${wd.reason}\n建议：告知用户、调 run_stage_done({passed:false,memo:...}) 后停止本轮。`;
  } catch {}
  switch (name) {
    case 'list_dir': {
      const dir = safePath(args.path || '.');
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.map(e => e.isDirectory() ? e.name + '/' : e.name).sort().join('\n');
    }
    case 'read_file': {
      const f = safePath(args.path);
      let c = await fs.readFile(f, 'utf8');
      // OpenFOAM 场文件保护：路径形如 0/U、0.5/alpha.water、processor0/0/p、constant/<region>/<field>
      // 或文件头里出现 vol*Field / surface*Field / pointScalarField 等类型 → 自动折叠 internalField 巨数组体
      const relPath = String(args.path || '').replace(/\\/g, '/');
      const looksLikeTimeStepField = /(^|\/)\d+(\.\d+)?\/[A-Za-z][\w.]*$/.test(relPath);
      const headSniff = c.slice(0, 800);
      const looksLikeFoamField = /class\s+(vol|surface|point)\w*Field/.test(headSniff);
      if ((looksLikeTimeStepField || looksLikeFoamField) && c.length > 8192) {
        const { text: collapsed, hits } = collapseFoamFieldBody(c);
        if (hits > 0 && collapsed.length < c.length) {
          c = `[CFDriver 已自动折叠 ${hits} 处 OpenFOAM internalField 数组体（原 ${c.length} B → ${collapsed.length} B）。\n 头部 / dimensions / boundaryField 完整保留；数组体替换为 head/tail 样本 + 计数。\n 若需查看具体场值统计：用 foam_inspect_case 或 run_command('foamDictionary <file> -keyword internalField | head -5')。\n 严禁强行整文件读：场文件正常情况下就是几百万行数字，读了也只是把上下文撑爆。]\n\n` + collapsed;
        }
      }
      const sl = args.start_line, el = args.end_line;
      if (sl || el) {
        const lines = c.split('\n');
        const a = Math.max(1, sl || 1) - 1;
        const b = Math.min(lines.length, el || lines.length);
        const slice = lines.slice(a, b).map((line, i) => `${a + i + 1}\t${line}`).join('\n');
        return `${args.path} (行 ${a+1}-${b}, 共 ${lines.length} 行)\n${slice}`;
      }
      return c.length > 100_000 ? c.slice(0, 100_000) + `\n...[已截断，原文 ${c.length} B，请用 start_line/end_line]` : c;
    }
    case 'write_file': {
      const f = safePath(args.path);
      // 新建文件不会被求解器读到（未被 include），只拦覆盖已有字典
      if (fssync.existsSync(f)) { const g = _liveCaseEditGuard(f, false, args.allow_live_edit); if (g) return g; }
      let oldContent = null; try { oldContent = await fs.readFile(f, 'utf8'); } catch {}
      // V8 招1：写之前 snapshot
      const stepN = gitStep();
      const pre = await gitAutoCommit(`[step ${stepN}] before write_file ${args.path}`);
      await fs.mkdir(path.dirname(f), { recursive: true });
      await fs.writeFile(f, args.content, 'utf8');
      addPendingEdit(session, { id: crypto.randomBytes(4).toString('hex'), path: args.path, action: oldContent === null ? 'create' : 'write', oldContent, newContent: args.content, timestamp: Date.now() });
      broadcastEdits(ws); broadcastTree();
      const post = await gitAutoCommit(`[step ${stepN}] after write_file ${args.path}`);
      return `已写入 ${args.path}（${args.content.length} 字符）\n[V8 git] pre=${pre.sha || '?'}  post=${post.sha || '?'}`;
    }
    case 'edit_file': {
      const f = safePath(args.path);
      { const g = _liveCaseEditGuard(f, false, args.allow_live_edit); if (g) return g; }
      const orig = await fs.readFile(f, 'utf8');
      const ed = applyEdit(orig, args.old_str, args.new_str, args.replace_all === true);
      if (!ed.ok) return `错误：${ed.error}`;
      const updated = ed.content;
      const edNote = `（第 ${ed.line} 行${ed.count > 1 ? '起共 ' + ed.count + ' 处' : ''}${ed.how === 'exact' ? '' : '，' + ed.how}）`;
      // V8 招1：写之前 snapshot
      const stepN = gitStep();
      const pre = await gitAutoCommit(`[step ${stepN}] before edit_file ${args.path}`);
      await fs.writeFile(f, updated, 'utf8');
      addPendingEdit(session, { id: crypto.randomBytes(4).toString('hex'), path: args.path, action: 'edit', oldContent: orig, newContent: updated, timestamp: Date.now() });
      broadcastEdits(ws); broadcastTree();
      const post = await gitAutoCommit(`[step ${stepN}] after edit_file ${args.path}`);
      return `已编辑 ${args.path}${edNote}\n[V8 git] pre=${pre.sha || '?'}  post=${post.sha || '?'}`;
    }
    case 'multi_edit': {
      const f = safePath(args.path);
      { const g = _liveCaseEditGuard(f, false, args.allow_live_edit); if (g) return g; }
      const orig = await fs.readFile(f, 'utf8');
      let cur = orig;
      const edits = Array.isArray(args.edits) ? args.edits : [];
      if (edits.length === 0) return '错误：edits 为空';
      for (let i = 0; i < edits.length; i++) {
        const e = edits[i];
        const ed = applyEdit(cur, e.old_str, e.new_str, e.replace_all === true);
        if (!ed.ok) return `错误：第 ${i+1} 个 edit：${ed.error}（整批未写入）`;
        cur = ed.content;
      }
      // V8 招1：写之前 snapshot
      const stepN = gitStep();
      const pre = await gitAutoCommit(`[step ${stepN}] before multi_edit ${args.path} (${edits.length} 处)`);
      await fs.writeFile(f, cur, 'utf8');
      addPendingEdit(session, { id: crypto.randomBytes(4).toString('hex'), path: args.path, action: 'edit', oldContent: orig, newContent: cur, timestamp: Date.now() });
      broadcastEdits(ws); broadcastTree();
      const post = await gitAutoCommit(`[step ${stepN}] after multi_edit ${args.path}`);
      return `已应用 ${edits.length} 处编辑到 ${args.path}\n[V8 git] pre=${pre.sha || '?'}  post=${post.sha || '?'}`;
    }
    case 'glob': {
      const root = safePath(args.path || '.');
      const pat = args.pattern || '**/*';
      const re = globToRegExp(pat);
      const out = []; const max = 200;
      async function walkG(dir) {
        if (out.length >= max) return;
        let entries = []; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (out.length >= max) return;
          if (IGNORE.has(e.name)) continue;
          const full = path.join(dir, e.name);
          const rel = path.relative(WORKSPACE, full).replace(/\\/g, '/');
          if (e.isDirectory()) await walkG(full);
          else if (re.test(rel)) out.push(rel);
        }
      }
      await walkG(root);
      return out.length ? out.join('\n') + (out.length === max ? `\n...[已截断@${max}]` : '') : '（无匹配）';
    }
    case 'grep_search': {
      const re = new RegExp(args.pattern, 'gm');
      const root = safePath(args.path || '.');
      const results = [];
      async function walk(dir) {
        if (results.length >= 50) return;
        let entries = []; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (results.length >= 50) return;
          if (IGNORE.has(e.name)) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) await walk(full);
          else if (e.isFile()) {
            try { const c = await fs.readFile(full, 'utf8');
              c.split('\n').forEach((line, i) => { if (results.length >= 50) return; if (re.test(line)) results.push(`${path.relative(WORKSPACE, full)}:${i+1}: ${line.trim().slice(0,200)}`); re.lastIndex = 0; });
            } catch {}
          }
        }
      }
      await walk(root);
      return results.length ? results.join('\n') : '（无匹配）';
    }
    case 'run_command': {
      const cmd = String(args.command || '');
      { const g = _liveCaseEditGuard(cmd, true, args.allow_live_edit); if (g) return g; }
      if (/(mpirun|\bAllrun\b|\b[a-zA-Z]+Foam\b)/.test(cmd) && !/-postProcess|foamDictionary|foamList|foamListTimes|foamToVTK/.test(cmd)) {
        const m = /cd\s+([^\s;&|]+)/.exec(cmd);
        const gate = await _fidelityGate(session, m ? m[1].replace(/^~(?=\/)/, os.homedir()) : (session.workMem && session.workMem.casePath) || '', '运行求解器命令');
        if (gate) return gate;
        if (_MPI_LAUNCH_RE.test(cmd) || _npOf(cmd, m ? m[1] : '') > 1) { const over = _cpuOversubscribed(cmd, args.allow_oversubscribe, m ? m[1] : ''); if (over) return over; }
      }
      // 事件驱动等待：模型常写 "sleep 600; tail log" 盯求解器。开头的 sleep 改成可提前唤醒——
      // 工作目录下的求解器全部退出就立刻结束 sleep、执行后半句，不再白等到点
      {
        const sm = /^\s*sleep\s+(\d+)\s*(?:;|&&)\s*([\s\S]*)$/.exec(cmd);
        if (sm && Number(sm[1]) >= 20 && process.platform === 'linux') {
          const r = await _wakeableSleep(Number(sm[1]) * 1000, session);
          const rest = sm[2].trim();
          const note = r.woke ? `[CFDriver] sleep ${sm[1]} 提前 ${Math.round(r.left / 1000)} s 结束：${r.why}\n` : '';
          if (!rest) return note + '[退出码 0]';
          return note + await runShell(rest, args.timeout_ms || 120000, session, ws);
        }
      }
      return await runShell(args.command, args.timeout_ms || 120000, session, ws);
    }
    case 'update_todos': {
      session.todos = (args.items || []).map(it => ({ text: String(it.text || ''), done: !!it.done }));
      broadcastTodos(ws);
      const total = session.todos.length, done = session.todos.filter(t => t.done).length;
      return `已更新待办：${done}/${total} 完成`;
    }
    case 'task_complete': {
      {
        const gate = await _fidelityGate(session, (session.workMem && session.workMem.casePath) || '', 'task_complete');
        if (gate) return gate;
        const ft = ((session.task || session).fidelity || {}).taskText || '';
        const kc = (session.task || session).kpiCred;
        if (!args.force && Fidelity.isRepro(ft) && /(KPI|收率|选择性|转化率|yield|selectivity|conversion)/i.test(ft) && !(kc && kc.passed)) {
          return `[task_complete] ⛔ 论文复现收尾前必须通过 kpi_credibility（统计窗已过 n·τ 准稳态、窗长≥τ、至少一个非初值主导的 KPI）。当前：${kc ? '最近一次未通过' : '未运行'}。若计算未达准稳态，请继续算而不是收尾。`;
        }
      }
      // 持续进化：多阶段已验证流程收尾前必须沉淀一次 playbook（只提醒一次）
      {
        const e = Evolve.evo(session);
        if (!args.force && Evolve.isEvolvable(session) && !e.distilled && !e.distillNudged) {
          e.distillNudged = true;
          return `[task_complete] ⏸ 收尾前先沉淀：本任务有 ${e.stages.filter(s => s.passed).length} 个阶段已验证通过。请调 vertical_distill({id, title, triggers, case_path:<最终已验证算例>, extra_paths:[自定义库/前处理/后处理脚本目录], kpis, benchmarks, pitfalls, notes}) 把整套流程存成垂直 playbook，下次同类任务直接实例化。若本任务确实不可复用，可直接再调 task_complete。`;
        }
      }
      // verifier 硬门：任何 verifier 最近一次是 FAIL 且未重验通过 → 拦截收尾（有界重试：修复后重验直至 pass）
      const vs = session.verifyState || {};
      const failing = Object.entries(vs).filter(([, v]) => v === 'fail').map(([k]) => k);
      if (failing.length && !args.force) {
        session._verifyGateHits = (session._verifyGateHits || 0) + 1;
        return `[task_complete] ⛔ 拦截收尾：以下 verifier 最近一次结果是 FAIL 且未重验通过：${failing.join(', ')}。\n按「verifier 闭环」铁律，未通过验证前禁止 task_complete。请：\n  1) 用 diagnose_error 分析失败原因 → 2) 修复 case/参数 → 3) 重新调用上述 verifier 直到 passed=true → 4) 再 task_complete。\n（已第 ${session._verifyGateHits} 次拦截。若确属 verifier 误报且你已人工核验无误，可加 force=true 强制收尾。）`;
      }
      // 软提醒：foam/mfix/lbm 模式下整轮一个 verifier 都没跑（不硬拦，仅警示）
      // 收尾摘要里已有数值核验证据（FFT/过零点/理论值/相对偏差/End 等）就不再多拦一轮
      const numericEvidence = /FFT|过零|zero.?cross|理论值|理论|相对偏差|偏差\s*[-+]?\d|交叉(校验|检查|验证)|cross.?check|\bEnd\b|日志有 End/i.test(String(args.summary || ''));
      if (!args.force && !numericEvidence && (session.foamMode || session.mfixMode || session.lbmMode) && Object.keys(vs).length === 0) {
        session._noVerifyWarned = (session._noVerifyWarned || 0) + 1;
        if (session._noVerifyWarned <= 1) {
          return `[task_complete] ⚠ 本轮处于 CFD 模式但未运行任何 verifier（foam_mesh/geom/solve/post_verify 等）。\n收尾前强烈建议至少跑一个 verifier 确认结果可信；确实无需验证（如纯查询/讲解）可立即再调一次 task_complete 收尾。`;
        }
      }
      session.taskComplete = true;
      if (session.task && session.task.goal && session.task.goal.status === 'active') {
        session.task.goal.status = 'done'; session.task.goal.doneAt = Date.now(); session.task.goal.evidence = String(args.summary || '').slice(0, 1500);
        try { broadcastTaskState(); } catch {}
      }
      recoveryManager.cancel(session.task, 'task_complete');
      ws.send(JSON.stringify({ type: 'task_complete', summary: args.summary || '' }));
      notifyEvent({ kind: 'task_complete', key: `done:${session.task?.id}`, taskId: session.task?.id,
        title: `🎯 任务完成：${session.task?.title || ''}`, body: String(args.summary || '').slice(0, 800) });
      return `任务标记完成：${args.summary || ''}`;
    }

    // ====================== V8 招1：Git 自动版本 ======================
    case 'git_log_recent': {
      await ensureGitRepo();
      const n = Math.min(Math.max(args.n || 10, 1), 50);
      const r = await _spawnP('git', ['log', `-n`, String(n), '--pretty=format:%h|%ad|%s', '--date=format:%H:%M:%S', '--shortstat'], { cwd: WORKSPACE });
      if (r.code !== 0) return `[git_log_recent] git log 失败：${r.err || r.out}`;
      const out = (r.out || '').trim();
      if (!out) return '[git_log_recent] 仓库无 commit。';
      return `[git_log_recent] 最近 ${n} 个 commit（最新在上）：\n${out}\n\n用法：找到"上一个能跑的 SHA"后调 git_revert_to(sha) 回滚。`;
    }
    case 'git_diff': {
      await ensureGitRepo();
      const from = args.from || 'HEAD~1';
      const to = args.to || 'HEAD';
      const argv = ['diff', '--stat', `${from}..${to}`];
      if (args.path_glob) argv.push('--', args.path_glob);
      const r = await _spawnP('git', argv, { cwd: WORKSPACE });
      if (r.code !== 0) return `[git_diff] 失败：${r.err || r.out}`;
      const stat = (r.out || '').trim() || '(no changes)';
      // 再取完整 diff 头 200 行
      const argv2 = ['diff', `${from}..${to}`];
      if (args.path_glob) argv2.push('--', args.path_glob);
      const r2 = await _spawnP('git', argv2, { cwd: WORKSPACE });
      const body = (r2.out || '').split(/\r?\n/).slice(0, 200).join('\n');
      return `[git_diff ${from}..${to}]\n--- stat ---\n${stat}\n\n--- diff (head 200) ---\n${body}`;
    }
    case 'git_revert_to': {
      if (!args.sha) return '[git_revert_to] sha 必填';
      await ensureGitRepo();
      // 用 `git checkout <sha> -- .` 把工作区文件还原到该 SHA，再 commit 一次新提交（不丢历史）
      const co = await _spawnP('git', ['checkout', args.sha, '--', '.'], { cwd: WORKSPACE });
      if (co.code !== 0) return `[git_revert_to] 还原工作区失败：${co.err || co.out}`;
      const note = args.note ? ` (${args.note})` : '';
      const stepN = gitStep();
      const c = await gitAutoCommit(`[step ${stepN}] revert workspace to ${args.sha}${note}`);
      // 通知前端刷新文件树（因为大量文件被回滚）
      try { broadcastTree(); } catch {}
      return `[git_revert_to] ✅ 工作区已回滚到 ${args.sha}。\n新 commit: ${c.sha}\n${note}\n\n下一步：重新规划（**不要**立刻按"老路"再改一遍，先 case_probe_facts + algo_extract_contract 看为什么会跑偏）。`;
    }

    // ====================== V8 招3：错误诊断 ======================
    case 'vertical_distill': {
      const summarize = (stages) => llmOneShot('你把 CFD 智能体各阶段的实际轨迹压成可复用配方。输出 JSON 数组，与输入阶段一一对应：[{"recipe":"≤150字的具体做法(文件/命令/关键参数)","pitfall":"≤80字踩过的坑及修法,没有写\"\""}]。只写轨迹里出现过的事实。只输出 JSON。', JSON.stringify(stages).slice(0, 12000), { maxTokens: 2500 });
      const abs = (p) => { const x = Evolve.expandHome(p); return path.isAbsolute(x) ? x : path.resolve(WORKSPACE, x); };
      const r = await Evolve.distill(session, { ...args, case_path: abs(args.case_path), extra_paths: (args.extra_paths || []).map(abs) }, summarize);
      if (!r.ok) return `[vertical_distill] 失败：${r.error}`;
      Evolve.evo(session).distilled = r.id;
      await Fidelity.recordLesson({ kind: 'playbook', detail: `${r.id} v${r.version}`, metrics: r.run });
      return `[vertical_distill] ✅ playbook ${r.id} v${r.version} 已保存（模板 ${r.files} 个文件）→ ${r.dir}
本次效率：LLM ${r.run.llmSteps} 步 / 工具 ${r.run.toolCalls} 次 / 报错 ${r.run.errors} 次 / ${r.run.wallMin} min。下次命中触发词会自动注入并提示 vertical_instantiate。`;
    }
    case 'vertical_instantiate': {
      const dest = path.isAbsolute(Evolve.expandHome(args.dest)) ? Evolve.expandHome(args.dest) : path.resolve(WORKSPACE, args.dest);
      const r = await Evolve.instantiate(args.id, dest, args.version || null);
      if (!r.ok) return `[vertical_instantiate] 失败：${r.error}`;
      const st = (r.pb.stages || []).map((s, i) => `  ${i + 1}) ${s.name}: ${s.recipe || s.memo || ''}${s.pitfall ? ' ⚠' + s.pitfall : ''}`).join('\n');
      return `[vertical_instantiate] ✅ ${r.pb.title} v${r.version} → ${r.dest}（${r.files} 个文件${r.extras.length ? '；附带 ' + r.extras.join(', ') : ''}）
已验证阶段配方：\n${st}
基准：${JSON.stringify(r.pb.benchmarks || {})}
注意事项：${r.pb.notes || '无'}
下一步：只改与本任务不同的参数 → 重建网格（模板不含 polyMesh）→ 按阶段验证 → 求解。自定义库需重新 wmake。`;
    }
    case 'kpi_credibility': {
      const r = Fidelity.kpiCredibility(args);
      (session.task || session).kpiCred = { passed: r.passed, ts: Date.now() };
      return `[kpi_credibility] passed=${r.passed}\n${r.issues.map(s => '⛔ ' + s).join('\n')}${r.issues.length ? '\n' : ''}${r.notes.map(s => '· ' + s).join('\n')}\n可作复现证据的 KPI：${r.evidence.join(', ') || '(无)'}`;
    }
    case 'foam_locate': {
      const cd = path.isAbsolute(Evolve.expandHome(args.case_path)) ? Evolve.expandHome(args.case_path) : path.resolve(WORKSPACE, args.case_path);
      const py = SETTINGS.pythonPath || (IS_WIN ? 'python' : 'python3');
      let bashrc = SETTINGS.openfoamBash || (SETTINGS.foamRoot ? path.join(SETTINGS.foamRoot, 'etc', 'bashrc') : '');
      const script = path.join(__dirname, 'foam_locate.py');
      const cmd = IS_WIN ? `"${py}" "${script}" "${cd}" ${Number(args.n_times) || 3}`
        : `${bashrc ? `source "${bashrc}" >/dev/null 2>&1; ` : ''}"${py}" "${script}" "${cd}" ${Number(args.n_times) || 3}`;
      const r = await _spawnP(IS_WIN ? 'cmd.exe' : 'bash', IS_WIN ? ['/d', '/s', '/c', cmd] : ['-c', cmd], { cwd: cd });
      const last = String(r.out || '').trim().split('\n').pop();
      let j; try { j = JSON.parse(last); } catch { return `[foam_locate] 解析失败 code=${r.code}\n${String(r.out || '').slice(-800)}\n${String(r.err || '').slice(-800)}`; }
      if (!j.ok) return `[foam_locate] ${j.error}`;
      const L = [`[foam_locate] 时刻 ${j.times.join(', ')}`];
      for (const s of j.summary) {
        L.push(`- ${s.field}: max 序列 ${s.max_series.map(([t, v]) => `${t}→${v}`).join(', ')}（增长×${s.growth ?? '?'}${s.pinned_same_cell ? '，钉在同一单元' : ''}） @ (${s.loc.map(x => x.toFixed(4)).join(', ')})`);
        if (s.nearest_patches) L.push(`    最近 patch: ${s.nearest_patches.map(p => `${p.patch}(${p.dist_m} m)`).join(', ')}`);
      }
      L.push('判读：增长倍数大 + 钉在同一单元 + 贴近某 patch → 该 patch 的边界条件/局部网格是发散源，优先检查它的 BC 类型（出口倒流、速度/压力配对、相分数边界）。');
      return L.join('\n');
    }
    case 'vertical_list': {
      const l = Evolve.listPlaybooks();
      if (!l.length) return '[vertical_list] 还没有垂直 playbook。';
      return '[vertical_list]\n' + l.map(pb => `- ${pb.id} v${pb.current} | ${pb.title} | 触发:${(pb.triggers || []).slice(0, 8).join('/')} | 历次:${(pb.runs || []).map(r => `${r.llmSteps}步/${r.errors}错/${r.wallMin}min`).join(' → ')}`).join('\n');
    }
    case 'diagnose_error': {
      const r = diagnoseErrorText(args.text || '');
      if (!r.matched) {
        // 在途自进化：记下“内置模式没覆盖的新报错”，任务成功后提示登记成长型模式
        (session._novelErrors = session._novelErrors || []).push(String(args.text || '').slice(0, 300));
        if (session._novelErrors.length > 5) session._novelErrors.shift();
        return `[diagnose_error] ${r.hint}`;
      }
      const out = [`[diagnose_error] 匹配 ${r.count} 条模式：`];
      for (const h of r.hits) {
        out.push(`\n■ ${h.category}`);
        out.push(`  命中片段: ${h.matched_snippet}`);
        out.push(`  可能原因：`);
        for (const c of h.causes) out.push(`    - ${c}`);
        out.push(`  排查步骤（按顺序）：`);
        h.next_steps.forEach((s, i) => out.push(`    ${i+1}) ${s}`));
      }
      return out.join('\n');
    }

    // ====================== 自进化：技能库 + 成长型错误记忆 ======================
    case 'skill_save': {
      const a = SkillLib.analyzeTrajectory(session.messages);
      if (!a.verified && !args.force) {
        return '[skill_save] ⛔ 本轮没检测到任何 *_verify / run_stage_done 通过，按“只沉淀已验证经验”原则拒绝保存。若确属可复用且你已人工核验，可加 force=true。';
      }
      const prov = { case_path: a.casePath, run_id: a.runId, verified_by: a.verifiers, ts: Date.now() };
      // V10：用会话工作记忆回填模型没给全的 solver / key_params / pitfalls（让自动沉淀更丰富）
      const fill = workMemToSkillFill(session);
      const merged = {
        ...args,
        solver: args.solver || fill.solver || '',
        key_params: (args.key_params && Object.keys(args.key_params).length) ? args.key_params : fill.key_params,
        pitfalls: (Array.isArray(args.pitfalls) && args.pitfalls.length) ? args.pitfalls : fill.pitfalls,
        provenance: prov,
      };
      const r = await SkillLib.saveSkill(merged);
      try { ws.send(JSON.stringify({ type: 'skill_saved', id: r.id, title: args.title || '', deduped: r.deduped })); } catch {}
      return `[skill_save] ✅ 已沉淀技能「${args.title || r.id}」→ ${r.deduped ? '命中同配方，合并复用次数' : '新建独立技能文件'}\n  路径: ${r.path}\n  verifier: ${a.verifiers.join(', ') || '(force)'}`;
    }
    case 'skill_recall': {
      const inj = SkillLib.injectionFor(args.query || '', { foam: session.foamMode, mfix: session.mfixMode, lbm: session.lbmMode }, args.top_k || 3);
      return inj ? `[skill_recall] 命中：${inj}` : '[skill_recall] 技能库里没有匹配该任务的已验证配方。';
    }
    case 'skill_list': {
      const l = SkillLib.listSkills({ domain: args.domain });
      return l.length ? `[skill_list] 共 ${l.length} 条：\n` + l.map(s => `- ${s.id} | ${s.domain} | ${s.title} | 命中${s.hits} | 触发:${(s.triggers || []).join('/')}`).join('\n') : '[skill_list] 技能库为空。';
    }
    case 'skill_forget': {
      const r = await SkillLib.removeSkill(args.id);
      return r.ok ? `[skill_forget] 已删除技能 ${r.id}。` : `[skill_forget] ${r.error}`;
    }
    case 'skill_export': {
      const r = await SkillLib.exportBundle(args.out_path || `bundle-${Date.now()}.json`, args.ids);
      return `[skill_export] ✅ 导出 ${r.count} 条技能 → ${r.path}（独立 bundle，可分享/导入/将来当微调语料）。`;
    }
    case 'skill_import': {
      try { const r = await SkillLib.importBundle(args.in_path); return `[skill_import] ✅ 导入 ${r.imported} 条技能 + ${r.errorPatterns} 条错误模式。`; }
      catch (e) { return `[skill_import] 失败：${e.message}`; }
    }
    case 'learn_error_pattern': {
      const r = await SkillLib.addErrorPattern({ pattern: args.pattern, flags: args.flags, category: args.category, causes: args.causes, steps: args.steps });
      return r.ok ? `[learn_error_pattern] ✅ ${r.deduped ? '已存在，命中数+1' : '新增一条成长型错误模式'}（共 ${r.total} 条${r.pruned ? `，已淘汰 ${r.pruned} 条低分旧模式` : ''}）。下次同类报错 diagnose_error 会秒命中。` : `[learn_error_pattern] 失败：${r.error}`;
    }
    case 'skill_export_sft': {
      const domain = args.domain || (session.foamMode ? 'foam' : session.mfixMode ? 'mfix' : session.lbmMode ? 'lbm' : 'general');
      const sample = SkillLib.buildSftSample(session.messages, { domain, label: args.label || '' });
      if (!sample) return '[skill_export_sft] ⛔ 本轮没有任何 verifier 盖章通过的轨迹，按"零幻觉只导出已验证轨迹"原则拒绝导出。请先跑 *_verify 并通过。';
      const r = await SkillLib.appendSft(sample, args.out_path || null);
      return `[skill_export_sft] ✅ 已把本轮已验证轨迹追加为 1 条 SFT 语料 → ${r.path}（累计 ${r.total} 条）。\n  verifier: ${sample.verified_by.join(', ')}\n  这些 jsonl 将来可直接喂给本地模型做监督微调（带 provenance、零幻觉）。`;
    }
    case 'skill_eval_record': {
      const m = SkillLib.evalMetrics(session.messages);
      let skillsInjected = false, injected = '';
      try { injected = SkillLib.injectionFor(args.task || session._pendingUserText || '', { foam: session.foamMode, mfix: session.mfixMode, lbm: session.lbmMode }) || ''; skillsInjected = !!injected; } catch {}
      const rec = {
        label: String(args.label), task: args.task || session._pendingUserText || '', folder: args.folder || '',
        note: args.note || '', metrics: m, skillsInjected,
        runId: (session.runState && session.runState.runId) || '',
      };
      const r = await SkillLib.recordEval(rec);
      return `[skill_eval_record] ✅ 已记录臂「${rec.label}」（共 ${r.total} 条评测记录）。\n  task: ${rec.task.slice(0, 80)}\n  指标: verifier 通过 ${m.verifyPass}/${m.verifyPass + m.verifyFail}（通过率 ${m.verifyPassRate ?? 'n/a'}）, 错误迭代 ${m.errorIters} 次, diagnose ${m.diagnoses} 次\n  本臂技能注入: ${skillsInjected ? '有' : '无'}\n  跑完另一臂后调 skill_eval_compare 看技能是否真有帮助。`;
    }
    case 'skill_eval_compare': {
      const all = await SkillLib.loadEvals();
      if (all.length < 2) return '[skill_eval_compare] 评测记录不足 2 条，无法对比。请先用 skill_eval_record 记录两臂（如 baseline_无技能 / withskill_有技能）。';
      let pool = all;
      if (args.task) pool = all.filter(e => (e.task || '').includes(args.task) || (args.task || '').includes(e.task || ''));
      const pick = (lbl) => lbl ? [...pool].reverse().find(e => (e.label || '').includes(lbl)) : null;
      let a = pick(args.label_a), b = pick(args.label_b);
      if (!a || !b) { const last2 = pool.slice(-2); a = a || last2[0]; b = b || last2[1]; }
      if (!a || !b || a === b) return '[skill_eval_compare] 找不到可对比的两臂。请确认两条记录的 task 一致、label 不同。';
      const fmt = (e) => `「${e.label}」技能注入=${e.skillsInjected ? '有' : '无'} | verifier 通过率=${e.metrics.verifyPassRate ?? 'n/a'}(${e.metrics.verifyPass}/${e.metrics.verifyPass + e.metrics.verifyFail}) | 错误迭代=${e.metrics.errorIters} | diagnose=${e.metrics.diagnoses}`;
      const dRate = (b.metrics.verifyPassRate ?? 0) - (a.metrics.verifyPassRate ?? 0);
      const dErr = a.metrics.errorIters - b.metrics.errorIters;
      const helped = (dRate > 0) || (dRate === 0 && dErr > 0);
      const verdict = helped
        ? `✅ 技能有帮助：通过率 ${dRate >= 0 ? '+' : ''}${dRate.toFixed(3)}，错误迭代少了 ${dErr} 次。建议保留/继续沉淀该技能。`
        : (dRate === 0 && dErr === 0 ? `➖ 两臂指标持平，本案例区分度不够，建议换更难的固定案例再测。` : `⚠ 技能未体现优势（通过率 ${dRate.toFixed(3)}，错误迭代差 ${dErr}）。建议复盘该技能的 recipe/pitfalls 是否贴合本案例。`);
      return `[skill_eval_compare] 同案例 A/B 对比：\n  A: ${fmt(a)}\n  B: ${fmt(b)}\n\n结论: ${verdict}`;
    }

    // ====================== V8 算法植入四步法 ======================
    case 'algo_extract_contract': {
      try {
        const c = await algoExtractContract({ source_file: args.source_file, algorithm_name: args.algorithm_name });
        return `[algo_extract_contract] 步1 完成 — 契约（启发式抽取，请人工核对）：\n${JSON.stringify(c, null, 2)}\n\n下一步：case_probe_facts(case_path)`;
      } catch (e) { return `[algo_extract_contract] 失败：${e.message}`; }
    }
    case 'case_probe_facts': {
      try {
        const f = await caseProbeFacts({ case_path: args.case_path });
        return `[case_probe_facts] 步2 完成 — case 事实：\n${JSON.stringify(f, null, 2)}\n\n下一步：algo_case_audit(contract, case_facts)`;
      } catch (e) { return `[case_probe_facts] 失败：${e.message}`; }
    }
    case 'algo_case_audit': {
      try {
        const r = algoCaseAudit({ contract: args.contract, case_facts: args.case_facts });
        return `[algo_case_audit] 步3 完成 — ${r.verdict}\nmismatches (${r.mismatch_count}):\n${JSON.stringify(r.mismatches, null, 2)}`;
      } catch (e) { return `[algo_case_audit] 失败：${e.message}`; }
    }
    case 'foam_dry_compile': {
      try { return await foamDryCompile({ module_path: args.module_path }); }
      catch (e) { return `[foam_dry_compile] 失败：${e.message}`; }
    }
    case 'sim_open_paraview': {
      try {
        const r = await launchParaView(args.case_path);
        ws.send(JSON.stringify({ type: 'sim_started', pid: r.pid, casePath: args.case_path || '' }));
        return r.reused ? `ParaView 已在运行（PID ${r.pid}），已切换到投影` : `已启动 ParaView（PID ${r.pid}），开始投影窗口`;
      } catch (e) { return `启动失败：${e.message}`; }
    }
    case 'sim_run_openfoam': return await runOpenFoam(args, ws);
    case 'foam_find_tutorial': return await foamFindTutorial(args.query, args.top_k || 12);
    case 'foam_find_source':   return await foamFindSource(args.query, args.kind || 'all', args.top_k || 12);
    case 'foam_clone_tutorial':return await foamCloneTutorial(args.tutorial_path, args.dest);
    case 'foam_inspect_case':  return await foamInspectCase(args.case_path);
    case 'foam_run_solver_async': {
      const gate = await _fidelityGate(session, args.case_path, '启动求解器');
      if (gate) return gate;
      const over = _cpuOversubscribed(args.command, args.allow_oversubscribe, args.case_path);
      if (over) return over;
      let pre = null;
      if (_classifyFoamCommand(args.command) === 'solver' || /Foam\b/.test(String(args.command))) {
        try { pre = await Prelaunch.prelaunchCheck(path.isAbsolute(args.case_path) ? args.case_path : path.resolve(WORKSPACE, args.case_path)); } catch {}
        if (pre && pre.issues.length && !args.skip_prelaunch) return `[未启动] 启动前体检发现问题，修正后再启动（确认无碍可传 skip_prelaunch:true）：${Prelaunch.formatPrelaunch({ issues: pre.issues, facts: {} })}`;
      }
      const started = await foamRunSolverAsync({ case_path: args.case_path, command: args.command }, ws, session);
      const early = await _earlyStatus(started, session);
      return started + early + (pre ? Prelaunch.formatPrelaunch({ issues: [], facts: pre.facts }) : '');
    }
    case 'foam_solver_status': return foamSolverStatus(args.run_id);
    case 'foam_solver_stop':   return await foamSolverStopWait(args.run_id);
    case 'foam_stl_inspect':   return await foamStlInspect(args.stl_path);
    case 'foam_mesh_plan':     return await foamMeshPlan(args);
    case 'foam_compute_first_layer': return foamComputeFirstLayer(args);
    case 'foam_mesh_box_stl':  return await foamMeshBoxStl(args);
    case 'foam_stl_generate':  return await foamStlGenerate(args);
    case 'foam_env_check':     return await foamEnvCheck();
    case 'opt_study_create':   return await optStudyCreate(args);
    case 'opt_suggest_next':   return await optSuggestNext(args);
    case 'opt_run_trial':      return await optRunTrial(args);
    case 'opt_apply_params':   return await optApplyParams(args);
    case 'opt_extract_kpi':    return await optExtractKpi(args);
    case 'opt_record_result':  return await optRecordResult(args);
    case 'opt_status':         return await optStatus(args);
    case 'opt_render':         return await optRender(args, ws);
    case 'solver_wait':         return await solverWait(args, session);
    case 'foam_postproc_list':  return await foamPostprocList(args);
    case 'foam_postproc_stats': return await foamPostprocStats(args);
    case 'foam_residual_series': return foamResidualSeries(args.run_id, args.max_points || 60, args.fields || null);
    case 'foam_compare_render':  return await foamCompareRender(args, ws);
    case 'foam_mesh_verify':     return await foamMeshVerify(args, ws, session);
    case 'foam_mesh_stl_check':  return await foamMeshStlCheck(args, ws);
    case 'foam_stl_render':      return await foamStlRender(args, ws);
    case 'foam_patch_diff':      return await foamPatchDiff(args);

    // ---------- v0.6.0 自治可靠性 ----------
    case 'run_status_load': {
      const rs = _ensureRunState(session);
      // 同时列出所有在跑的后台求解作业（含服务接管的手动作业，runId 以 x 开头），免得 agent 去翻文件找 runId
      const live = [...SOLVER_RUNS.values()].filter(r => !r.ended).map(r => {
        let t = ''; for (let i = r.log.length - 1; i >= 0; i--) { const m = r.log[i].match(/^Time\s*=\s*([\d.eE+\-]+)/); if (m) { t = m[1]; break; } }
        return { runId: r.runId, external: !!r.external, case: r.casePath, time: t || null, minutes: Math.round((Date.now() - r.started) / 60000) };
      });
      return `[run_status] ${JSON.stringify({ runId: rs.runId, label: rs.label, stages: rs.stages.map(s => ({ name: s.name, status: s.status, passed: s.verify ? s.verify.passed : null })), failCount: rs.failCount, memos: rs.memos.slice(-10), liveSolverJobs: live }, null, 2)}`;
    }
    case 'run_stage_start': {
      const rs = _ensureRunState(session);
      if (!rs.runId) await startRun(session, args.label || args.stage);
      const s = await stageStart(session, String(args.stage));
      return `[stage_start] runId=${rs.runId} stage=${s.name} 已记录。`;
    }
    case 'run_stage_done': {
      const s = await stageDone(session, String(args.stage), { passed: args.passed !== false, memo: args.memo || '', artifacts: args.artifacts || [] });
      const rs = _ensureRunState(session);
      // 阶段对账：拿当前 todos 与已完成阶段比对，提示剩余 + 是否跳过了验证关卡
      let recon = '';
      try {
        const todos = session.todos || [];
        if (todos.length) {
          const left = todos.filter(t => !t.done);
          recon = `\n[计划对账] 待办 ${todos.length - left.length}/${todos.length} 完成`;
          if (left.length) recon += `；未完成：${left.slice(0, 6).map(t => t.text).join(' / ')}${left.length > 6 ? ' …' : ''}`;
          const gateLeft = left.filter(t => /verify|验证|✅|核对|对照/i.test(t.text));
          if (gateLeft.length) recon += `\n  ⚠ 仍有验证关卡未过：${gateLeft.map(t => t.text).join(' / ')} —— 收尾前必须跑对应 verifier。`;
        } else {
          recon = `\n[计划对账] 本任务还没建计划，建议 update_todos 把后续阶段+验证关卡列出来。`;
        }
        if (args.passed === false) recon += `\n  ↳ 该阶段标记 FAILED，请 diagnose_error → 修复 → 重新 run_stage_start 重验，勿跳过。`;
      } catch {}
      return `[stage_done] runId=${rs.runId} stage=${args.stage} status=${s ? s.status : 'n/a'}\nmemo: ${(args.memo || '').slice(0, 200)}${recon}`;
    }
    case 'foam_geom_verify': {
      const r = await genericVisionVerify('几何', '检查 STL/几何渲染：法向是否朝外、模型是否封闭、长宽高比例与单位是否合理。', args.images || [], args.expected || '');
      return `[foam_geom_verify] passed=${r.passed} score=${r.score}\nreasons:\n - ${(r.reasons||[]).join('\n - ')}\nsuggestions:\n - ${(r.suggestions||[]).join('\n - ')}\n\nJSON:\n${JSON.stringify(r, null, 2)}`;
    }
    case 'foam_solve_verify': {
      let resTxt = '';
      try { resTxt = foamResidualSeries(args.run_id, 30, null); } catch (e) { resTxt = '[residual: ' + e.message + ']'; }
      const r = await genericVisionVerify('求解收敛', '结合下方残差时序与终态渲染图，判断求解是否收敛、是否有数值发散/震荡，物理是否合理：\n' + String(resTxt).slice(0, 2000), args.images || [], args.expected || '');
      return `[foam_solve_verify] passed=${r.passed} score=${r.score}\nreasons:\n - ${(r.reasons||[]).join('\n - ')}\nsuggestions:\n - ${(r.suggestions||[]).join('\n - ')}\n\nJSON:\n${JSON.stringify(r, null, 2)}`;
    }
    case 'foam_post_verify': {
      const r = await genericVisionVerify('后处理', '检查云图/切片/曲线：是否数值发散、对称破缺、量级异常、单位标注是否合理。', args.images || [], args.expected || '');
      return `[foam_post_verify] passed=${r.passed} score=${r.score}\nreasons:\n - ${(r.reasons||[]).join('\n - ')}\nsuggestions:\n - ${(r.suggestions||[]).join('\n - ')}\n\nJSON:\n${JSON.stringify(r, null, 2)}`;
    }
    case 'paper_param_verify': {
      const issues = [];
      const params = args.params || {};
      const units = args.expected_units || {};
      for (const [k, u] of Object.entries(units)) if (!(k in params)) issues.push(`缺失参数 ${k}（期望单位 ${u}）`);
      for (const [k, v] of Object.entries(params)) if (typeof v === 'number' && !isFinite(v)) issues.push(`参数 ${k} 非有限数`);
      let visionPart = null;
      if (args.images && args.images.length) {
        visionPart = await genericVisionVerify('论文参数', `请对照页图核对这些抽取的参数是否与原文一致：\n${JSON.stringify(params, null, 2)}`, args.images, '');
      }
      const passed = issues.length === 0 && (!visionPart || visionPart.passed);
      return `[paper_param_verify] passed=${passed}\nissues:\n - ${issues.join('\n - ') || '(无)'}\n${visionPart ? 'vision:\n' + JSON.stringify(visionPart, null, 2) : ''}`;
    }
    // ---------- MFIX-Beta dispatch ----------
    case 'mfix_find_tutorial':    return await mfixFindTutorial(args.query, args.top_k || 12);
    case 'mfix_clone_tutorial':   return await mfixCloneTutorial(args.tutorial_path, args.dest);
    case 'mfix_inspect_case':     return await mfixInspectCase(args.case_path);
    case 'mfix_run_solver_async': return await mfixRunSolverAsync({ case_path: args.case_path, command: args.command }, ws, session);
    case 'mfix_solver_status':    return mfixSolverStatus(args.run_id);
    case 'mfix_solver_stop':      return mfixSolverStop(args.run_id);
    // ---------- LBM-Beta dispatch ----------
    case 'lbm_find_tutorial':  return await lbmFindTutorial(args.query, args.top_k || 12);
    case 'lbm_clone_tutorial': return await lbmCloneTutorial(args.tutorial_path, args.dest);
    case 'lbm_inspect_case':   return await lbmInspectCase(args.case_path, args.algorithm || '');
    case 'lbm_run_async':      return await lbmRunAsync({ case_path: args.case_path, command: args.command }, ws, session);
    case 'lbm_solver_status':  return lbmSolverStatus(args.run_id);
    case 'lbm_solver_stop':    return lbmSolverStop(args.run_id);
    case 'web_search': return await webSearch(args.query, args.top_k || 6, { topic: args.topic, time_range: args.time_range, include_answer: args.include_answer, progress: session?._progressPub });
    case 'image_search': {
      try {
        const imgs = await imageSearch(args.query, Math.min(30, args.top_k || 12));
        // 把图片广播到所有客户端的图片库
        broadcastImages(imgs, args.query);
        if (!imgs.length) return '未找到图片（可能被反爬，可尝试改换关键词或开代理）';
        return `[image_search] "${args.query}" → ${imgs.length} 张图片，已发到右侧"图片库"面板。\n` +
          imgs.slice(0, 8).map((x, i) => `${i+1}. ${x.title || ''}\n   图片: ${x.image}\n   来源: ${x.source || ''}`).join('\n');
      } catch (e) { return '搜图失败：' + e.message; }
    }
    case 'fetch_url': return await fetchUrlText(args.url, args.max_chars || 6000, args.with_images !== false, session?._progressPub);
    case 'read_document': return await readWithVisionFallback('doc', args, session, () => readDocument(args.path, session?._progressPub));
    case 'request_user_digitize': return await requestUserDigitize(args || {}, ws, session);
    case 'read_paper': return await readWithVisionFallback('paper', args, session, () => readPaper(args.path, args.focus || '', session?._progressPub));
    case 'paper_extract': return await paperExtract(args.path, args.focus || '', !!args.render_pages, session?._progressPub);
    case 'paper_figures': return await paperFigures(args);
    case 'post_view': return await postViewTool(args, ws, session);
    case 'skill_pack_read': return await Cap.readPackFile(SKILL_PACK_DIR, String(args.pack || ''), args.file ? String(args.file) : '');
    case 'image_crop': return await imageCrop(args);
    case 'paper_search': return await paperSearch(args.query, { topK: args.top_k || 8, year: args.year, openAccessOnly: !!args.open_access_only, fieldsOfStudy: args.fields_of_study, progress: session?._progressPub });
    case 'paper_fetch': return await paperFetch(args.id, { download: !!args.download, maxRefs: args.max_refs || 30, progress: session?._progressPub });
    case 'vision_analyze': return await visionAnalyze(args.images || [], args.question || '', args.max_tokens || 1500, session?._progressPub);
    case 'download_file': return await downloadFile(args.url, args.save_as);
    case 'sim_render': {
      try {
        const r = await pvRenderOffscreen({ casePath: args.case_path, azimuth: args.azimuth, elevation: args.elevation, zoom: args.zoom, field: args.field, timeStep: args.time_step });
        pvBroadcast({ type: 'sim_frame', dataUrl: r.dataUrl, meta: r.meta });
        ws.send(JSON.stringify({ type: 'sim_started', pid: 0, casePath: args.case_path }));
        // 落盘一份 PNG 到 .nullflux/renders/，便于后续 vision_analyze / foam_post_verify 引用
        let savedPath = '';
        try {
          const tag = `${path.basename(String(args.case_path || 'case'))}_${args.field || 'default'}_${args.time_step || 'latest'}`.replace(/[^\w\-.]+/g, '_');
          const absPng = await _dataUrlToTmpPng(r.dataUrl, tag);
          savedPath = path.relative(WORKSPACE, absPng).replace(/\\/g, '/');
        } catch {}
        return `已渲染 ${args.case_path}（${r.width}x${r.height}，${r.bytes} bytes）。画面已发到右侧面板。` +
          (savedPath ? `\n📁 已落盘: ${savedPath}` : '') +
          (r.meta ? `\n可用场：${r.meta.fields.join(', ') || '(无)'}\n时间步数：${r.meta.times.length}` : '') +
          `\n\n⚠️ 下一步必须做：调 \`vision_analyze(images=['${savedPath || '<上面那个路径>'}'], question='...')\` 让 VLM 检查这张图——别只凭"渲染成功"就下结论。建议问：① 流场结构是否物理合理（对称/无突变/无 NaN 块）② 量级是否符合预期 ③ 颜色梯度是否平滑 ④ 与论文图（如有）是否定性一致。`;
      } catch (e) { return `渲染失败：${e.message}`; }
    }
    default:
      if (name.startsWith('mcp__')) return await mcpCall(name, args);
      return `未知工具：${name}`;
  }
}

// 杀进程树：POSIX 先 SIGTERM 整个进程组，3 s 后 SIGKILL；Windows 用 taskkill /T /F。tree:false 只终止 shell 本身
function _killProcTree(child, { tree = true } = {}) {
  const pid = child && child.pid;
  if (!pid) return;
  if (!tree) { try { child.kill(); } catch (e) { return; } return; }
  if (IS_WIN) { try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch (e) { return; } return; }
  const sig = g => { try { process.kill(-pid, g); } catch (e) { try { process.kill(pid, g); } catch (e2) { return; } } };
  sig('SIGTERM');
  setTimeout(() => sig('SIGKILL'), 3000).unref();
}
async function runShell(command, timeout, session, ws) {
  return await new Promise((resolve) => {
    const shell = IS_WIN ? (process.env.COMSPEC || 'cmd.exe') : 'bash';
    let cmd = command;
    if (SETTINGS.pythonPath) {
      const py = `"${SETTINGS.pythonPath}"`;
      const dir = path.dirname(SETTINGS.pythonPath);
      const pip = IS_WIN ? `"${path.join(dir, 'Scripts', 'pip.exe')}"` : `"${path.join(dir, 'pip')}"`;
      const tokenPy = /(^|\s|&&\s*|\|\|\s*|;\s*|\(\s*)(python(?:3)?(?:\.exe)?|py(?:\s+-3)?)\b/g;
      const tokenPip = /(^|\s|&&\s*|\|\|\s*|;\s*|\(\s*)(pip(?:3)?(?:\.exe)?)\b/g;
      const tokenJp = /(^|\s|&&\s*|\|\|\s*|;\s*|\(\s*)(jupyter(?:\.exe)?)\b/g;
      cmd = cmd.replace(tokenPy, (_,p) => p + py);
      cmd = cmd.replace(tokenPip, (_,p) => p + py + ' -m pip');
      cmd = cmd.replace(tokenJp, (_,p) => p + py + ' -m jupyter');
    }
    const shellArgs = IS_WIN ? ['/c', cmd] : ['-c', cmd];
    ws.send(JSON.stringify({ type: 'term', line: `$ ${cmd}` }));
    const env = { ...process.env };
    if (SETTINGS.pythonPath) {
      const dir = path.dirname(SETTINGS.pythonPath);
      env.PATH = dir + path.delimiter + (env.PATH || env.Path || '');
      env.VIRTUAL_ENV = dir.replace(/[\\/](Scripts|bin)$/i, '');
      env.PYTHONIOENCODING = 'utf-8';
    }
    // POSIX 下独立进程组：超时/停止时能连同子进程一起杀（否则只杀到 bash，python 等留成孤儿）
    const child = spawn(shell, shellArgs, { cwd: WORKSPACE, env, detached: !IS_WIN, windowsHide: true });
    session.currentProc = child;
    const buf = headTailBuffer();

    // —— 如果命令里含 OpenFOAM 求解器/网格工具，自动登记到 SOLVER_RUNS，
    //    让"求解器监测"面板能选到这次 run_command 起的进程
    let foamRun = null;
    try {
      const _foamRegex = /\b(blockMesh|snappyHexMesh|surfaceFeature(?:Extract|s)?|extrudeMesh|topoSet|refineMesh|checkMesh|renumberMesh|decomposePar|reconstructPar(?:Mesh)?|foamToVTK|setFields|mapFields|potentialFoam|simpleFoam|pimpleFoam|pisoFoam|icoFoam|interFoam|interIsoFoam|rhoSimpleFoam|rhoPimpleFoam|sonicFoam|chtMultiRegionFoam|buoyantSimpleFoam|buoyantPimpleFoam|reactingFoam|reactingTwoPhaseEulerFoam|multiphaseEulerFoam|driftFluxFoam|laplacianFoam|scalarTransportFoam|dnsFoam|foamRun|lmp_\w+|liggghts\w*)\b/i;
      if (_foamRegex.test(command)) {
        // 从命令里抽 case 路径
        let foamCase = '';
        const mWin = command.match(/\bcd\s+\/d\s+["']?([^"'&|;]+?)["']?(?=\s*(?:&&|;|\|\||$))/i);
        const mNix = command.match(/\bcd\s+["']?([^"'&|;]+?)["']?(?=\s*(?:&&|;|\|\||$))/i);
        foamCase = (mWin && mWin[1]) || (mNix && mNix[1]) || WORKSPACE;
        foamCase = foamCase.trim();
        const runId = crypto.randomBytes(4).toString('hex');
        foamRun = {
          runId, proc: child, casePath: foamCase, command, log: [],
          started: Date.now(), ended: 0, exitCode: null, subs: new Set()
        };
        // 单行截断保护
        const _MAX = 2000;
        const _push = foamRun.log.push.bind(foamRun.log);
        foamRun.log.push = function(line) { return _push(line.length > _MAX ? line.slice(0, _MAX) + ' …[行过长截断]' : line); };
        SOLVER_RUNS.set(runId, foamRun);
        // 广播运行列表变更，让前端"求解器监测"面板自动刷新下拉
        try {
          const msg = JSON.stringify({ type: 'runs_update', reason: 'run_command_detected', runId });
          for (const c of allClients) if (c.readyState === 1) c.send(msg);
        } catch {}
        // 立即提示用户：哪个 runId 可以监测
        try { ws.send(JSON.stringify({ type: 'term', line: `[CFDriver] 检测到 OpenFOAM 命令 → 已登记 runId=${runId}（监测面板可选）  case=${foamCase}` })); } catch {}
      }
    } catch {}

    const onData = d => {
      const s = d.toString();
      buf.push(s);
      const lines = s.split(/\r?\n/);
      lines.forEach(l => l && ws.send(JSON.stringify({ type: 'term', line: l })));
      // 同步落到 SOLVER_RUNS
      if (foamRun) {
        lines.forEach(l => { if (l) { foamRun.log.push(l); foamRun._lineNo = (foamRun._lineNo || 0) + 1; } });
        if (foamRun.log.length > 4000) foamRun.log.splice(0, foamRun.log.length - 4000);
        for (const sub of foamRun.subs) if (sub.readyState === 1) {
          sub.send(JSON.stringify({ type: 'solver_log', runId: foamRun.runId, lines: lines.filter(Boolean) }));
        }
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    // 求解器/网格命令、带后台作业（& / nohup）的命令保持原行为：只终止 shell，后台进程照常运行；其余命令超时杀整棵进程树
    child._isSolver = !!foamRun || isSolverLaunchCommand(command) || /\b(nohup|setsid|disown)\b|(?<![&>|])&(?![&>])/.test(command);
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; _killProcTree(child, { tree: !child._isSolver }); ws.send(JSON.stringify({ type: 'term', line: '[超时已终止]' })); }, timeout);
    // 命令里用 & 放到后台的进程（nohup mpirun ... &）会继承输出管道，'close' 要等它退出才触发，
    // 智能体因此卡到超时。shell 本身退出后 2 s 仍未 close → 断开管道直接收尾，后台进程照常运行
    let detached = false;
    child.on('exit', () => setTimeout(() => {
      const open = (child.stdout && !child.stdout.destroyed) || (child.stderr && !child.stderr.destroyed);
      if (!open) return;
      detached = true;
      try { child.stdout && child.stdout.destroy(); } catch {}
      try { child.stderr && child.stderr.destroy(); } catch {}
    }, 2000));
    child.on('close', code => { clearTimeout(t); session.currentProc = null;
      ws.send(JSON.stringify({ type: 'term', line: `[退出码 ${code}]` })); broadcastTree();
      if (foamRun && detached && process.platform === 'linux') {
        // 后台求解器还在跑：等工作区里的求解器全部退出再记结束，solver_wait / 自动唤醒照常可用
        buf.push('\n[CFDriver] 命令已返回，后台进程仍在运行；可用 solver_wait 等它结束（runId=' + foamRun.runId + '）');
        const root = path.resolve(WORKSPACE);
        const tStart = Date.now(); let seen = false;
        const iv = setInterval(() => {
          if (_solversUnder(root) > 0) { seen = true; return; }
          if (!seen && Date.now() - tStart < 120_000) return;   // mpirun 拉起求解器需要时间
          clearInterval(iv);
          foamRun.ended = Date.now(); foamRun.exitCode = 0;
          for (const sub of foamRun.subs) if (sub.readyState === 1) sub.send(JSON.stringify({ type: 'solver_done', runId: foamRun.runId, exitCode: 0 }));
          _solverEnded(foamRun);
        }, 10_000);
      } else if (foamRun) {
        foamRun.ended = Date.now(); foamRun.exitCode = code;
        if (code !== 0 && _endedCleanly(foamRun.log)) { foamRun.rawExitCode = code; foamRun.exitCode = 0; foamRun.endAbort = true; }
        for (const sub of foamRun.subs) if (sub.readyState === 1) sub.send(JSON.stringify({ type: 'solver_done', runId: foamRun.runId, exitCode: foamRun.exitCode }));
        _solverEnded(foamRun);
      }
      const note = foamRun && foamRun.endAbort ? `\n[CFDriver] 求解器在最后一个时间步之后已打印 End：退出码 ${code} 来自 End 之后的析构/MPI 收尾，计算正常完成，结果有效，不要重算。` : '';
      const tnote = timedOut && !child._isSolver ? `[命令超时：${Math.round(timeout / 1000)} s 后命令及其子进程已被终止。确实需要更久就带更大的 timeout_ms 重跑；长时间计算用 foam_run_solver_async + solver_wait。]\n` : '';
      resolve(`${tnote}[退出码 ${code}]${note}\n${buf.toString()}`); });
    child.on('error', err => { clearTimeout(t); session.currentProc = null; resolve(`[启动失败] ${err.message}`); });
  });
}

async function undoEdit(session, editId) {
  const idx = session.pendingEdits.findIndex(e => e.id === editId);
  if (idx === -1) throw new Error('编辑记录不存在');
  const edit = session.pendingEdits[idx];
  const f = safePath(edit.path);
  if (edit.oldContent === null) { try { await fs.unlink(f); } catch {} } else await fs.writeFile(f, edit.oldContent, 'utf8');
  session.pendingEdits.splice(idx, 1); return edit;
}
function keepEdit(session, editId) { const idx = session.pendingEdits.findIndex(e => e.id === editId); if (idx === -1) throw new Error('编辑记录不存在'); return session.pendingEdits.splice(idx, 1)[0]; }
function newCheckpoint(session, label) { const cp = { id: crypto.randomBytes(4).toString('hex'), label: label || '新任务', timestamp: Date.now(), files: {} }; session.checkpoints.push(cp); session.currentCheckpoint = cp; return cp; }
async function restoreCheckpoint(session, id) {
  const idx = session.checkpoints.findIndex(c => c.id === id);
  if (idx === -1) throw new Error('检查点不存在');
  const earliest = {};
  for (let i = idx; i < session.checkpoints.length; i++)
    for (const [p, oc] of Object.entries(session.checkpoints[i].files)) if (!(p in earliest)) earliest[p] = oc;
  let restored = 0;
  for (const [rel, oc] of Object.entries(earliest)) {
    const f = safePath(rel);
    if (oc === null) { try { await fs.unlink(f); } catch {} }
    else { await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, oc, 'utf8'); }
    restored++;
  }
  session.checkpoints.splice(idx); session.currentCheckpoint = null;
  session.pendingEdits = session.pendingEdits.filter(e => !(e.path in earliest));
  return restored;
}

async function buildTree(dir = WORKSPACE, depth = 0) {
  const name = path.basename(dir); const children = [];
  if (depth <= 6) {
    let entries = []; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return { name, path: '.', type: 'dir', children }; }
    entries.sort((a, b) => (b.isDirectory() ? 1 : 0) - (a.isDirectory() ? 1 : 0) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (IGNORE.has(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) children.push(await buildTree(full, depth + 1));
      else children.push({ name: e.name, path: path.relative(WORKSPACE, full).replaceAll('\\', '/'), type: 'file' });
    }
  }
  return { name, path: path.relative(WORKSPACE, dir).replaceAll('\\', '/') || '.', type: 'dir', children };
}

const allClients = new Set();
let treeBT = null;
function broadcastTree() {
  if (treeBT) return;
  treeBT = setTimeout(async () => { treeBT = null;
    try { const tree = await buildTree(); const msg = JSON.stringify({ type: 'tree', tree });
      for (const ws of allClients) if (ws.readyState === 1) ws.send(msg); } catch {}
  }, 200);
}

async function flatList() {
  const out = [];
  async function walk(dir) {
    let entries = []; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (IGNORE.has(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      // processor*/dynamicCode 下是成千上万个分解场文件，会把 2000 条上限占满
      if (e.isDirectory()) { if (!/^(processor\d+|dynamicCode)$/.test(e.name)) await walk(full); }
      else out.push(path.relative(WORKSPACE, full).replaceAll('\\', '/'));
      if (out.length > 2000) return;
    }
  }
  await walk(WORKSPACE); return out;
}

async function buildUserContent(text, attachments) {
  let textPart = text || '';
  // 附件上限：防止把大 PDF / 二进制文件当 utf8 塞进 prompt导致 LLM 400 token 超限
  const ATT_MAX_CHARS = parseInt(process.env.ATT_MAX_CHARS || '80000', 10);
  const BIN_EXT = new Set(['pdf','docx','pptx','xlsx','doc','ppt','xls','png','jpg','jpeg','gif','webp','bmp','tiff','tif','zip','tar','gz','7z','exe','dll','so','bin','stl','vtu','vtk','mp3','mp4','wav','avi','mov']);
  for (const a of (attachments || [])) {
    if (a.type === 'context_file' && a.path) {
      try {
        const abs = safePath(a.path);
        const st = await fs.stat(abs);
        const ext = (path.extname(a.path) || '').slice(1).toLowerCase();
        // 按扩展名直接判定为二进制类附件 → 不读文本，让 agent 自己调 read_document
        if (BIN_EXT.has(ext)) {
          textPart += `\n\n--- 附件 ${a.path} (.${ext} · ${st.size} 字节) 为二进制文档；请调用 read_document("${a.path}") 提取文本与图片 ---`;
          continue;
        }
        if (st.size > 8 * 1024 * 1024) {
          textPart += `\n\n--- 附件 ${a.path} 过大（${(st.size/1024/1024).toFixed(1)} MB）已跳过；请调 read_document("${a.path}") 提取文本 ---`;
          continue;
        }
        // 二进制探测：前 4KB 调 NUL
        const fh = await fs.open(abs, 'r'); const buf = Buffer.alloc(Math.min(4096, st.size));
        await fh.read(buf, 0, buf.length, 0); await fh.close();
        let nul = 0; for (let i = 0; i < buf.length; i++) if (buf[i] === 0) { nul++; if (nul > 2) break; }
        if (nul > 2) {
          textPart += `\n\n--- 附件 ${a.path} 为二进制/PDF（${st.size} 字节），不能当文本读；请调 read_document("${a.path}") ---`;
          continue;
        }
        let c = await fs.readFile(abs, 'utf8');
        let banner = '';
        if (c.length > ATT_MAX_CHARS) {
          banner = `\n... [附件共 ${c.length} 字符，仅截取前 ${ATT_MAX_CHARS}；需全文调 read_file/read_document] ...`;
          c = c.slice(0, ATT_MAX_CHARS);
        }
        textPart += `\n\n--- 附件文件 ${a.path} (${st.size} 字节) ---\n${c}${banner}\n--- 文件结束 ---`;
      } catch (e) {
        textPart += `\n\n[附件 ${a.path} 读取失败：${e.message}]`;
      }
    }
  }
  const imgs = (attachments || []).filter(a => a.type === 'image');
  if (imgs.length === 0) return textPart;
  const content = [{ type: 'text', text: textPart }];
  for (const im of imgs) content.push({ type: 'image_url', image_url: { url: im.dataUrl, detail: 'high' } });
  return content;
}

// 本地推理端点（ollama / llama.cpp / vLLM / LM Studio 等）通常免 key、且 baseUrl 可能已自带 /v1
function _isLocalEndpoint(u) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[^/]*\.local)(:\d+)?/i.test(String(u || ''));
}
// 防御：把历史里任何「参数不是合法 JSON」的 tool_call 修正掉。
// 根因：模型输出被截断（finish_reason=length / 流中断）时，某个 tool_call 的 arguments
// 字符串会是残缺 JSON（如末尾字符串没闭合）。本地执行时我们 try/catch 回退成 {} 还能跑，
// 但这条 assistant 消息会被原样塞回历史；下一轮请求时上游(SiliconFlow)对每个
// tool_call.arguments 做 json.loads 校验 → 残缺 JSON 直接整条请求 400
// （code 20015 "Expecting ',' delimiter"）。这里在发请求前把残缺参数统一规整为 {}，
// 与本地执行时的回退一致（该工具实际就是用 {} 跑的，文件并未写入），既保证一致性又不再 400。
function sanitizeToolCallArgs(messages) {
  let fixed = 0;
  const arr = messages || [];
  for (let i = 0; i < arr.length; i++) {
    const m = arr[i];
    if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    // 1) 去掉稀疏洞/非对象项：流截断时 index 跳号会留洞，JSON.stringify 把洞序列化成 null → 上游 400
    const before = m.tool_calls.length;
    m.tool_calls = m.tool_calls.filter(tc => tc && typeof tc === 'object');
    if (m.tool_calls.length !== before) fixed += before - m.tool_calls.length;
    for (const tc of m.tool_calls) {
      // 2) 截断可能让 function/name/id 缺失：补占位，保证上游 schema 校验通过
      if (!tc.function || typeof tc.function !== 'object') { tc.function = { name: 'unknown_tool', arguments: '{}' }; fixed++; }
      if (!tc.function.name) { tc.function.name = 'unknown_tool'; fixed++; }
      if (!tc.id) {
        const nid = 'call_fix_' + Math.random().toString(36).slice(2, 10);
        // 同步修正紧随其后、指向空 id 的 tool 响应，保持配对不破
        for (let j = i + 1; j < arr.length && arr[j] && arr[j].role === 'tool'; j++) {
          if (!arr[j].tool_call_id) { arr[j].tool_call_id = nid; break; }
        }
        tc.id = nid; fixed++;
      }
      // 3) 参数必须是合法 JSON 字符串
      const a = tc.function.arguments;
      // 空参数（无参工具）规整为 {} —— 正常情况，不计入 fixed
      if (a === undefined || a === null || (typeof a === 'string' && a.trim() === '')) { tc.function.arguments = '{}'; continue; }
      if (typeof a !== 'string') { tc.function.arguments = '{}'; fixed++; continue; }
      try { JSON.parse(a); } catch { tc.function.arguments = '{}'; fixed++; }
    }
    // 全被清空则整个字段删掉（部分端点拒绝空 tool_calls 数组）
    if (m.tool_calls.length === 0) delete m.tool_calls;
  }
  return fixed;
}
// 任务可以单独指定模型（task.modelRef = { provider, model }）；没指定就用设置里的主模型
function _taskSettings(ws) {
  try { const t = sessions.get(ws)?.task; return settingsForRef(SETTINGS, t && t.modelRef); } catch { return SETTINGS; }
}
function modelLabel(ref) {
  const st = settingsForRef(SETTINGS, ref);
  if (st.provider === 'copilot') return 'Copilot · ' + (SETTINGS.copilotModel || 'gpt-4.1');
  const p = ref && ref.provider && ref.provider !== 'main' ? (SETTINGS.providers || []).find(x => x.id === ref.provider) : null;
  return (st.model || '未配置') + (p ? ` · ${p.name}` : '');
}
async function callLLM(messages, ws, abortSignal, toolsForCall) {
  const ST = typeof _taskSettings === 'function' ? _taskSettings(ws) : SETTINGS;
  if (ST.provider === 'copilot') return callCopilot(messages, ws, abortSignal, toolsForCall);
  const config = resolveChatConfig(ST);
  const TOOLS_FOR_CALL = toolsForCall || TOOLS;
  // 发请求前先清洗：修掉任何残缺 JSON 的 tool_call 参数，防止上游 400（见 sanitizeToolCallArgs 注释）
  try { const nFix = sanitizeToolCallArgs(messages); if (nFix && ws) ws.send(JSON.stringify({ type: 'term', line: `[修复] 检测到 ${nFix} 处被截断的工具调用参数（残缺 JSON）→ 已规整为 {} 避免请求 400` })); } catch {}
  const url = config.url;
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey || 'local'}` };
  const reqBody = { model: config.model, messages, tools: TOOLS_FOR_CALL, tool_choice: 'auto', stream: true, stream_options: { include_usage: true }, temperature: 0.2 };
  // 推理模型思考预算：限制每一轮的 reasoning 长度，避免"一步把所有事想完"式的超长空转思考。
  // 仅对"推理型"模型（Qwen3 / GLM / DeepSeek-R 系 / 带 think/reason 字样）下发该字段，
  // 避免非推理模型端点因不认识 thinking_budget 而 400。Copilot 走另一条代码路径。
  const tb = Number(SETTINGS.thinkingBudget);
  const mdl = String(config.model || '').toLowerCase();
  const isReasoningModel = /qwen3|glm-?[45]|deepseek-?r|[-/]r1\b|reasoner|think/.test(mdl);
  if (Number.isFinite(tb) && tb > 0 && isReasoningModel && (SETTINGS.provider || 'sf') !== 'copilot') {
    reqBody.thinking_budget = tb;
  }
  const body = JSON.stringify(reqBody);
  // 对照 OpenCode：429 / 408 / 409 / 5xx / 网络错误按 min(2s·2^(n-1), 10s)·抖动 退避重试，遵守 retry-after（上限 15 min）；
  // 401 / 402 / 403 / 其余 4xx 不重试；上下文超长单独标记，交给 runAgent 压缩后重发；超时类最多重试 3 次。
  // 首 token 超时由 consumeOpenAIStream 的 IDLE 看门狗保障。
  const LLM_RETRY_MAX = Number.isInteger(SETTINGS.llmRetryMax) && SETTINGS.llmRetryMax >= 0 ? SETTINGS.llmRetryMax : 6;
  const _say = (line, detail) => {
    if (!ws) return;
    try { ws.send(JSON.stringify({ type: 'term', line })); ws.send(JSON.stringify({ type: 'agent_phase', phase: 'llm_retry', detail })); } catch (e) { return; }
  };
  const _wait = ms => new Promise((res, rej) => {
    if (abortSignal && abortSignal.aborted) return rej(new Error('aborted'));
    const onAbort = () => { clearTimeout(tm); rej(new Error('aborted')); };
    const tm = setTimeout(() => { if (abortSignal) abortSignal.removeEventListener('abort', onAbort); res(); }, ms);
    if (abortSignal) abortSignal.addEventListener('abort', onAbort, { once: true });
  });
  let lastErr = null, timeoutRetries = 0;
  for (let attempt = 1; attempt <= LLM_RETRY_MAX + 1; attempt++) {
    const connectCtrl = new AbortController();
    // 只等响应头；正常 3–40 s
    const connectTimer = setTimeout(() => { try { connectCtrl.abort(new Error(`connect_timeout_${LLM_CONNECT_TIMEOUT_MS / 1000}s`)); } catch (e) { return; } }, LLM_CONNECT_TIMEOUT_MS);
    const signal = _combineSignals(abortSignal, connectCtrl.signal);
    let delay = 0, why = '';
    try {
      const resp = await fetch(url, { method: 'POST', headers, body, signal });
      clearTimeout(connectTimer);
      if (resp.ok) return await consumeOpenAIStream(resp, ws);
      const txt = await resp.text();
      const getH = k => (resp.headers && typeof resp.headers.get === 'function' ? resp.headers.get(k) : null);
      const kind = classifyLlmHttp(resp.status, txt, getH('x-should-retry'));
      const hint = resp.status === 404 ? '（请检查通用 API 的 Base URL 和模型 ID 是否与服务端一致）' : '';
      lastErr = new Error(`API ${resp.status} ${hint}: ${txt.slice(0, 400)}`);
      lastErr.status = resp.status;
      if (kind === 'overflow') lastErr.contextOverflow = true;
      if (kind !== 'retry') lastErr.noRetry = true;
      else {
        const ra = parseRetryAfter(getH);
        delay = llmRetryDelay(attempt, ra == null ? null : Math.min(ra, 15 * 60_000));
        why = `HTTP ${resp.status}` + (ra != null ? '（服务端要求等待）' : '');
      }
    } catch (e) {
      clearTimeout(connectTimer);
      if (abortSignal && abortSignal.aborted) throw e;   // 用户主动停止不重试
      if (e && e.partialOutput) throw e;          // 已经开始输出后断流：交上层恢复，不在这里整轮重发
      const msg = String(e && e.message || e);
      const isTimeout = isTimeoutError(msg) || (e && e.name === 'AbortError' && connectCtrl.signal.aborted);
      lastErr = e;
      if (isTimeout ? timeoutRetries >= 3 : !isNetworkError(msg)) throw e;
      if (isTimeout) timeoutRetries++;
      delay = llmRetryDelay(attempt);
      why = msg.slice(0, 160);
    }
    if (lastErr.noRetry || attempt > LLM_RETRY_MAX) throw lastErr;
    _say(`[LLM 重试 ${attempt}/${LLM_RETRY_MAX}] ${why}，${(delay / 1000).toFixed(1)} s 后重发`, `${why.slice(0, 60)} · ${Math.round(delay / 1000)} s 后第 ${attempt} 次重试`);
    await _wait(delay);
  }
  throw lastErr || new Error('callLLM exhausted retries');
}

// v0.8.0 合并多个 AbortSignal：任一触发则 abort
function _combineSignals(...signals) {
  signals = signals.filter(Boolean);
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    try { return AbortSignal.any(signals); } catch {}
  }
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) { try { ctrl.abort(s.reason); } catch { ctrl.abort(); } break; }
    s.addEventListener('abort', () => { try { ctrl.abort(s.reason); } catch { ctrl.abort(); } }, { once: true });
  }
  return ctrl.signal;
}

async function consumeOpenAIStream(resp, ws) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let assistantMsg = { role: 'assistant', content: '', tool_calls: [] };
  let usage = null;
  let finishReason = null;   // 'stop' | 'length' | 'tool_calls' ...：=length 说明本轮输出被截断，tool_call 参数可能残缺
  let sawDone = false;         // 收到过 [DONE]：流是正常收尾的
  // 流空闲看门狗：超过 IDLE_MS 没收到任何 chunk 就主动断开，避免 LLM/代理静默卡住把整个 agent 卡死
  const IDLE_MS = parseInt(process.env.LLM_IDLE_TIMEOUT_MS || '120000', 10);
  let idleTimer = null;
  let idleAborted = false;
  function armIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleAborted = true;
      try { reader.cancel('idle-timeout'); } catch {}
    }, IDLE_MS);
  }
  armIdle();
  // 阶段心跳：在首个 token 到达前每 2s 向前端推一次 phase ，之后转入 streaming
  let firstChunk = true;
  let reasoningStarted = false;   // 推理模型（如 GLM-5.1/DeepSeek-R1）会先吐 reasoning_content 思考，再吐 content
  let waitStart = Date.now();
  let phaseTimer = setInterval(() => {
    if (firstChunk) {
      const sec = ((Date.now() - waitStart) / 1000).toFixed(1);
      try { ws.send(JSON.stringify({ type: 'agent_phase', phase: 'llm_thinking', detail: `等 LLM 首个 token ${sec}s`, elapsed_ms: Date.now() - waitStart })); } catch {}
    }
  }, 2000);
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      armIdle();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim(); if (data === '[DONE]') { sawDone = true; continue; }
        try {
          const j = JSON.parse(data);
          if (j.usage) usage = j.usage;
          if (j.choices?.[0]?.finish_reason) finishReason = j.choices[0].finish_reason;
          const delta = j.choices?.[0]?.delta; if (!delta) continue;
          // 推理模型的思考流：收到就停掉「等首 token」心跳，显示思考中并把思考内容推给前端（不并入 content，避免污染历史/工具解析）
          if (delta.reasoning_content) { firstChunk = false; if (!reasoningStarted) { reasoningStarted = true; try { ws.send(JSON.stringify({ type: 'agent_phase', phase: 'reasoning', detail: '模型思考中（推理模型）' })); } catch {} } try { ws.send(JSON.stringify({ type: 'reasoning', text: delta.reasoning_content })); } catch {} }
          if (delta.content) { assistantMsg.content += delta.content; if (firstChunk) { firstChunk = false; try { ws.send(JSON.stringify({ type: 'agent_phase', phase: 'streaming', detail: 'LLM 输出中' })); } catch {} } ws.send(JSON.stringify({ type: 'delta', text: delta.content })); }
          if (delta.tool_calls) {
            if (firstChunk) { firstChunk = false; try { ws.send(JSON.stringify({ type: 'agent_phase', phase: 'streaming', detail: 'LLM 决定调用工具' })); } catch {} }
            for (const tc of delta.tool_calls) {
              // 部分端点（本地 llama.cpp/vLLM 等）流式 tool_call 不带 index：带 id 视为新调用，否则续写最后一个
              const idx = (typeof tc.index === 'number') ? tc.index : (tc.id ? assistantMsg.tool_calls.length : Math.max(0, assistantMsg.tool_calls.length - 1));
              if (!assistantMsg.tool_calls[idx]) assistantMsg.tool_calls[idx] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
              const slot = assistantMsg.tool_calls[idx];
              if (tc.id) slot.id = tc.id;
              if (tc.function?.name) slot.function.name += tc.function.name;
              if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
            }
          }
        } catch {}
      }
    }
    // 处理流结束后残留的最后一段（部分上游不会以 \n 结尾），避免漏掉最后一个 tool_call/usage
    if (buffer && buffer.startsWith('data:')) {
      const data = buffer.slice(5).trim();
      if (data && data !== '[DONE]') {
        try {
          const j = JSON.parse(data);
          if (j.usage) usage = j.usage;
          if (j.choices?.[0]?.finish_reason) finishReason = j.choices[0].finish_reason;
          const delta = j.choices?.[0]?.delta;
          if (delta) {
            if (delta.reasoning_content) { firstChunk = false; if (!reasoningStarted) { reasoningStarted = true; try { ws.send(JSON.stringify({ type: 'agent_phase', phase: 'reasoning', detail: '模型思考中（推理模型）' })); } catch {} } try { ws.send(JSON.stringify({ type: 'reasoning', text: delta.reasoning_content })); } catch {} }
            if (delta.content) { assistantMsg.content += delta.content; if (firstChunk) { firstChunk = false; try { ws.send(JSON.stringify({ type: 'agent_phase', phase: 'streaming', detail: 'LLM 输出中' })); } catch {} } ws.send(JSON.stringify({ type: 'delta', text: delta.content })); }
            if (delta.tool_calls) {
              if (firstChunk) { firstChunk = false; try { ws.send(JSON.stringify({ type: 'agent_phase', phase: 'streaming', detail: 'LLM 决定调用工具' })); } catch {} }
              for (const tc of delta.tool_calls) {
                // 同上：无 index 时按「带 id=新调用，否则续写最后一个」回退
                const idx = (typeof tc.index === 'number') ? tc.index : (tc.id ? assistantMsg.tool_calls.length : Math.max(0, assistantMsg.tool_calls.length - 1));
                if (!assistantMsg.tool_calls[idx]) assistantMsg.tool_calls[idx] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
                const slot = assistantMsg.tool_calls[idx];
                if (tc.id) slot.id = tc.id;
                if (tc.function?.name) slot.function.name += tc.function.name;
                if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
              }
            }
          }
        } catch {}
      }
    }
  } catch (e) {
    // 读流途中出错：没有输出 → 抛给 callLLM 重试；只有正文 → 保留正文（下面按 interrupted 处理，模型接着写）；带工具调用 → 抛出，参数可能残缺
    if (e && typeof e === 'object') e.partialOutput = !!(assistantMsg.content || assistantMsg.tool_calls.length);
    if (!assistantMsg.content || assistantMsg.tool_calls.length) throw e;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (phaseTimer) clearInterval(phaseTimer);
  }
  const _hadOutput = !!(assistantMsg.content || assistantMsg.tool_calls.length);
  if (idleAborted) { const e = new Error(`LLM 流空闲超时 ${IDLE_MS/1000}s（已自动中止，可重试）`); e.partialOutput = _hadOutput; throw e; }
  if (buffer && buffer.includes('[DONE]')) sawDone = true;
  // 既没有 finish_reason 也没有 [DONE]：上游断流。没有任何内容 → 按网络错误重试；有内容 → 标记 interrupted，由 runAgent 让模型接着写
  const _cutOff = !finishReason && !sawDone;
  if (_cutOff && !_hadOutput) throw new Error('incomplete stream (network error)：上游没有返回任何内容就结束了');
  Object.defineProperty(assistantMsg, '_finish', { value: finishReason || (_cutOff ? 'interrupted' : null), enumerable: false });
  // 流结束后立刻规整本轮 tool_call 参数：若被截断成残缺 JSON，就地修成 {}，
  // 保证不把残缺 JSON 塞进历史（否则下一轮请求会被上游 json.loads 校验打回 400）。
  if (assistantMsg.tool_calls.length) {
    try {
      const nFix = sanitizeToolCallArgs([assistantMsg]);
      if (finishReason === 'length') { try { ws.send(JSON.stringify({ type: 'term', line: `[警告] 本轮输出被截断（finish_reason=length，达长度上限）${nFix ? `，${nFix} 处工具参数残缺已规整为 {}` : ''}。如频繁出现可调大输出上限或缩短上下文。` })); } catch {} }
    } catch {}
  }
  // 注意 sanitize 可能已把空 tool_calls 字段整个删掉，需先判存在再取 length
  if (Array.isArray(assistantMsg.tool_calls) && assistantMsg.tool_calls.length === 0) delete assistantMsg.tool_calls;
  if (usage) {
    ws.send(JSON.stringify({ type: 'usage', usage }));
    _accumUsage(ws, usage);
  }
  return assistantMsg;
}
// 每个任务累计 LLM 用量（调用数、输入/缓存/输出 token），存在 task.usageTotals，便于调优与 A/B 对账
function _accumUsage(ws, usage) {
  try {
    const s = sessions.get(ws); const t = s && s.task; if (!t) return;
    const u = t.usageTotals || (t.usageTotals = { calls: 0, prompt: 0, cached: 0, completion: 0, maxPrompt: 0 });
    const p = Number(usage.prompt_tokens || usage.input_tokens) || 0;
    const c = Number((usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || usage.cache_read_input_tokens) || 0;
    u.calls++; u.prompt += p; u.cached += c; u.completion += Number(usage.completion_tokens || usage.output_tokens) || 0;
    if (p > u.maxPrompt) u.maxPrompt = p;
  } catch {}
}

// ============ GitHub Copilot Provider ============
const COPILOT = {
  clientId: 'Iv1.b507a08c87ecfe98',         // VSCode 的 GitHub OAuth client_id
  ghToken: '',                               // gho_... (long-lived OAuth)
  apiToken: '',                              // 短期 Copilot token
  apiTokenExpires: 0,                        // unix seconds
  modelsCache: null, modelsCacheTs: 0,
};
const COPILOT_FILE = path.join(__dirname, 'copilot.json');

async function loadCopilotState() {
  try {
    const j = JSON.parse(await fs.readFile(COPILOT_FILE, 'utf8'));
    COPILOT.ghToken = j.ghToken || '';
  } catch {}
}
async function saveCopilotState() {
  await fs.writeFile(COPILOT_FILE, JSON.stringify({ ghToken: COPILOT.ghToken }, null, 2), 'utf8');
}

async function copilotDeviceStart() {
  const r = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'GithubCopilot/1.155.0' },
    body: JSON.stringify({ client_id: COPILOT.clientId, scope: 'read:user' })
  });
  if (!r.ok) throw new Error('GitHub device 接口失败：' + r.status);
  return await r.json();    // {device_code, user_code, verification_uri, interval, expires_in}
}
async function copilotDevicePoll(deviceCode) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'GithubCopilot/1.155.0' },
        body: JSON.stringify({ client_id: COPILOT.clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
      });
      return await r.json();
    } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 800 * (i + 1))); }
  }
  throw lastErr;
}
async function copilotRefreshApiToken() {
  if (!COPILOT.ghToken) throw new Error('未登录 GitHub Copilot，请先点 🔑 登录');
  const now = Math.floor(Date.now() / 1000);
  if (COPILOT.apiToken && COPILOT.apiTokenExpires - now > 120) return COPILOT.apiToken;
  const r = await fetch('https://api.github.com/copilot_internal/v2/token', {
    headers: { 'Authorization': `token ${COPILOT.ghToken}`, 'Accept': 'application/json', 'User-Agent': 'GithubCopilot/1.155.0', 'Editor-Version': 'vscode/1.95.0', 'Editor-Plugin-Version': 'copilot-chat/0.20.0' }
  });
  if (!r.ok) {
    const t = await r.text();
    if (r.status === 401 || r.status === 403) { COPILOT.ghToken = ''; await saveCopilotState(); throw new Error('GitHub 凭据失效，请重新登录：' + t.slice(0, 200)); }
    throw new Error('Copilot token 失败 ' + r.status + ': ' + t.slice(0, 200));
  }
  const j = await r.json();
  COPILOT.apiToken = j.token; COPILOT.apiTokenExpires = j.expires_at || (now + 1500);
  return COPILOT.apiToken;
}
function copilotHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Editor-Version': 'vscode/1.95.0',
    'Editor-Plugin-Version': 'copilot-chat/0.20.0',
    'Copilot-Integration-Id': 'vscode-chat',
    'User-Agent': 'GitHubCopilotChat/0.20.0',
    'Openai-Intent': 'conversation-panel',
    'X-Github-Api-Version': '2025-04-01'
  };
}
async function copilotListModels() {
  const now = Date.now();
  if (COPILOT.modelsCache && now - COPILOT.modelsCacheTs < 5 * 60 * 1000) return COPILOT.modelsCache;
  const tok = await copilotRefreshApiToken();
  const r = await fetch('https://api.githubcopilot.com/models', { headers: copilotHeaders(tok) });
  if (!r.ok) throw new Error('列出模型失败 ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  // 兼容多种返回结构：{data:[]} 或直接 []
  const raw = Array.isArray(j) ? j : (j.data || j.models || []);
  // 只保留 chat 类（排除 embedding）；如果 capabilities 缺失则一律保留
  const list = raw.filter(m => {
    const t = m?.capabilities?.type;
    return !t || t === 'chat' || t === 'completion';
  }).map(m => ({
    id: m.id,
    name: m.name || m.id,
    vendor: m.vendor || (m.id || '').split('-')[0] || '',
    tool: !!(m?.capabilities?.supports?.tool_calls),
    streaming: !!(m?.capabilities?.supports?.streaming),
    picker: m.model_picker_enabled !== false,
  }));
  COPILOT.modelsCache = list; COPILOT.modelsCacheTs = now;
  return list;
}
async function callCopilot(messages, ws, abortSignal, toolsForCall) {
  const tok = await copilotRefreshApiToken();
  const TOOLS_FOR_CALL = toolsForCall || TOOLS;
  const body = { model: SETTINGS.copilotModel || 'gpt-4.1', messages, stream: true, stream_options: { include_usage: true }, temperature: 0.2 };
  // 非所有 Copilot 模型都支持 tools；先尝试带，失败时去掉重试
  body.tools = TOOLS_FOR_CALL; body.tool_choice = 'auto';
  let resp = await fetch('https://api.githubcopilot.com/chat/completions', { method: 'POST', headers: copilotHeaders(tok), body: JSON.stringify(body), signal: abortSignal });
  if (!resp.ok) {
    const txt = await resp.text();
    if (resp.status === 400 && /tool|function/i.test(txt)) {
      delete body.tools; delete body.tool_choice;
      resp = await fetch('https://api.githubcopilot.com/chat/completions', { method: 'POST', headers: copilotHeaders(tok), body: JSON.stringify(body), signal: abortSignal });
      if (!resp.ok) throw new Error('Copilot ' + resp.status + ': ' + (await resp.text()).slice(0, 300));
      ws.send(JSON.stringify({ type: 'term', line: `[Copilot] 模型 ${body.model} 不支持 tools，已降级为纯对话` }));
    } else if (resp.status === 401) {
      COPILOT.apiToken = ''; throw new Error('Copilot 401：' + txt.slice(0, 200));
    } else {
      throw new Error('Copilot ' + resp.status + ': ' + txt.slice(0, 300));
    }
  }
  return await consumeOpenAIStream(resp, ws);
}



const SYSTEM_PROMPT_BASE = (ws) => `你是 CFDriver —— 面向反应器复现、评估与优化的 CFD 智能体（作者 LZF），运行在用户本机（${process.platform}）。

# 工作目录
${ws}

# Python 解释器（用户在顶部 🐍 按钮选择的）
${SETTINGS.pythonPath ? SETTINGS.pythonPath : '（未选择，将使用 PATH 上默认 python）'}
> 你只需照常写 "python xxx.py" / "pip install xxx"，后端会自动替换为上面这个解释器。

# 重要：运行代码的规则
- 用户说"运行 xxx.py" / "执行 xxx" / "跑一下" → **立即调 run_command**，不要先咨询。
- 输出会实时出现在本地终端面板。
- 缺依赖先 \`pip install xxx\` 也用 run_command（会自动装到选中的环境）。
- .ipynb 执行：run_command("jupyter nbconvert --to notebook --execute --inplace xxx.ipynb")。

# ⚡ 核心工作守则（弱基模也照此执行 · 最高优先级 · 先看这段）
你是**多轮 agent**，每一轮只做一件具体的事。下面 5 条是铁律：
1. **动手，不空谈**：要建/改文件就**直接调 \`write_file\`/\`edit_file\`**，要跑就调 \`run_command\`——只有调用工具才真的发生。**禁止**在聊天里粘大段代码，或只说"让我开始写""我先创建目录"却不调工具。**每一轮至少调用一个工具**，否则等于零进展。
2. **小步走，不一次想完**：每轮只想清楚"**下一个动作是什么**"就立刻调对应工具，拿到真实结果（文件内容/报错）再想下一步。**不要**用超长思考把整个任务从头预演到尾——既慢又易错。
3. **不确定就查，别猜**：路径/参数/库是否存在 → 直接 \`list_dir\`/\`read_file\`/\`run_command\` 查证，别在脑里反复假设。
4. **歧义先问，明确就做**：需求有多种解释或缺关键信息（求解器？工况？目标量？）→ 给 2–3 个选项让用户选，别默默挑一种就闷头跑（跑错全废）。目标一旦清晰，立刻动手，不再追问。
5. **改动克制 + 验证收尾**：用解决问题的**最小代码**，只动与任务直接相关的行；不重构没坏的、不删没看懂的、不顺手美化无关内容（可疑死代码提一句给用户，别擅自删）。完成后跑 \`*_verify\` 核验通过，再调 \`task_complete\`（别用一句"我完成了"代替工具调用）。

规划时：先用 \`update_todos\` 一次列 5–20 项，然后**立刻 \`write_file\` 落地第一项**，之后每轮只挑一项做。
✅ 对：update_todos 列计划 → write_file 写 controlDict → run_command 跑 blockMesh → 看报错 → edit_file 修
❌ 错：输出"让我先创建算例目录，再编写 controlDict……"却一个工具没调／一轮把多个文件正文全贴进聊天

# 联网工具（如启用）
- web_search(query, top_k?, topic?, time_range?)：通用联网搜索；优先 Tavily/Serper/Brave/SearXNG，无 Key 时回落 HTML 爬取。**找新闻 / 教程 / 文档** 用这个。
- paper_search(query, top_k?, year?, open_access_only?)：**学术论文检索**（Semantic Scholar + arXiv 合并），按引用 + 新鲜度排序。找算法原文、综述、SOTA → 优先用它，不要用 web_search。
- paper_fetch(id, download?, max_refs?)：按 DOI/ARXIV/S2-ID 拿摘要 + TLDR + references；download=true 可把 OA PDF 存到 downloads/papers/。
- fetch_url(url, max_chars?, with_images?)：拉网页正文；with_images=true 同时列出页内图片链接。
- read_paper(path, focus?)：**比 read_document 更强**，自动切 Abstract/Methods/Results/References 并统计公式与图表数；focus="..." 高亮命中段落。读论文优先用它。
- vision_analyze(images[], question)：**高清细看图片**（detail=high + 专用 VLM 提示）。需要读曲线数值 / 公式 / 表格 / 流程图就用它，比把图片当附件粘进对话更可靠。
- image_search(query)：图片搜索。

# 🔴 图像分析铁律（任何时候出现"图"都适用，违反 = 给用户假结论）

**你自己**是**看不见**图片像素的——所有图片必须显式调 \`vision_analyze\`（或对应的 *_verify）让多模态 VLM 看，才能下"图里画了什么 / 数值多少 / 是否合理"的结论。

**强制触发场景**：
1. **\`sim_render\` 一旦返回 "📁 已落盘: <path>"** → 立刻 \`vision_analyze(images=[path], question='...')\` 检查物理合理性。**绝对禁止**只看返回的"已渲染 800x600"就总结"流场看起来对"。
2. **用户上传 / 附件里出现 PNG/JPG/SVG/PDF 截图** → 默认调 \`vision_analyze\`（或 PDF 走 \`read_document\` 自动 OCR + VLM 转录）。除非用户明确说"不用看图"。
3. **论文里的图、表、公式** → \`read_paper\` 抽完文本后，凡是涉及数值的图（参数表 / 验证曲线 / 流程图）必须 \`vision_analyze\`。
4. **opt_render 出的收敛曲线 / 重要性图 / Pareto 图** → 调 \`vision_analyze\` 提"best-so-far 收敛了吗 / 哪个参数斜率最陡"再回报用户。
5. **网格 / 几何核验** → 用 \`foam_geom_verify\` / \`foam_mesh_verify\`（已内置 VLM 闭环）。
6. **CFD 终态后处理** → 用 \`foam_post_verify\`（VLM 体检云图）+ \`foam_solve_verify\`（VLM + 残差时序联合判定）。

**vision_analyze 怎么问才有用**（别问"这张图怎么样"这种废话）：
- ✅ "这是 alpha.water 切片，请判断：① 液面位置 y 坐标大约多少？② 界面是否锐利还是被数值扩散涂抹？③ 有无气穴 / 反向流斑块？" 
- ✅ "残差 log 图，请读出最后 5 个数量级，并判断收敛 / 震荡 / 发散。"
- ✅ "论文 Fig.5 是 Cd vs Re 曲线，请提取 5 个数据点的 (Re, Cd) 坐标对，单位无量纲。"
- ❌ "看看这张图"  ❌ "图片合理吗"

**vision_analyze 用完必须做什么**：
- 把 VLM 的结论结构化贴出来（"VLM 判定：…；置信度…；可疑点…"）；
- 与你之前的预期 / 论文值对比；
- **如果 VLM 检出问题** → 立刻 \`task_complete\` 之前先报警，不要藏着继续走。

**保留原则**：若图片来源不可靠（如截图被裁、分辨率 <300px），可以让 \`vision_analyze\` 返回"无法判断"并提示用户重发高清版，绝不要硬猜。

# 🔴 公式书写铁律（前端已挂 KaTeX，你必须用 LaTeX 写公式）

前端聊天气泡已经接入 **marked + KaTeX**，会自动渲染 \`$...$\`（行内）和 \`$$...$$\`（独立块）。**你写的每一个公式都必须用 LaTeX 语法包在 \`$\` 里**，这样用户看到的才是斜体 ρ、∂/∂t、∇²u 这种论文里的样子，而不是一坨 ASCII 折行。

**强制规则**：
1. **任何带变量的数学表达式都要用 \`$...$\`**（包括行内提的"Re = ρUL/μ"这种）。**禁止**写裸文本公式如 \`rho*U*dU/dx = -dp/dx + mu*d2U/dx2\`，必须写成：
   \`\`\`
   $$\\rho u \\frac{\\partial u}{\\partial x} = -\\frac{\\partial p}{\\partial x} + \\mu \\nabla^2 u$$
   \`\`\`
2. **希腊字母用反斜杠命令**：\`\\rho\` \`\\mu\` \`\\nu\` \`\\alpha\` \`\\beta\` \`\\theta\` \`\\phi\` \`\\omega\` \`\\Delta\` \`\\nabla\` —— **不要**写中文"密度"或裸 ASCII "rho"当公式符号。
3. **常用算子**：偏导 \`\\frac{\\partial u}{\\partial x}\`、全导 \`\\frac{du}{dt}\`、梯度 \`\\nabla\`、散度 \`\\nabla \\cdot\`、拉普拉斯 \`\\nabla^2\` 或 \`\\Delta\`、积分 \`\\int_0^L\`、求和 \`\\sum_{i=1}^{N}\`、点乘 \`\\cdot\`、叉乘 \`\\times\`。
4. **下标 / 上标**：\`U_\\infty\` \`u_i\` \`y^+\` \`Re_L\` \`C_d\`；多字符要花括号 \`u_{max}\` \`k_{\\text{eff}}\`。
5. **矢量 / 张量**：粗体用 \`\\mathbf{u}\` 或 \`\\vec{u}\`，张量 \`\\boldsymbol{\\tau}\`，单位张量 \`\\mathbf{I}\`。
6. **方程组用 \`aligned\`**：
   \`\`\`
   $$\\begin{aligned}
   \\nabla \\cdot \\mathbf{u} &= 0 \\\\
   \\frac{\\partial \\mathbf{u}}{\\partial t} + (\\mathbf{u}\\cdot\\nabla)\\mathbf{u} &= -\\frac{1}{\\rho}\\nabla p + \\nu \\nabla^2 \\mathbf{u}
   \\end{aligned}$$
   \`\`\`
7. **单位 / 文本变量**用 \`\\mathrm\` 或 \`\\text\`：\`U_{\\mathrm{in}} = 1.5\\,\\mathrm{m/s}\`，\`Re = \\rho U L / \\mu\`。
8. **数值列表里**也要数学化：写 \`$\\rho = 998\\,\\mathrm{kg/m^3}$\`，不要写 \`rho=998 kg/m3\`。
9. **代码块（\`\`\`）和 OpenFOAM 字典里**保持 ASCII（fvSchemes / 0/U 里就该写 \`rho\` \`nu\`），公式与代码语境**严格区分**。

**自检**：每次写完含公式的回答，回头扫一眼有没有漏 \`$\`、有没有把 \\rho 当成"rho"裸写、aligned 是否对齐。漏了 → 渲染出来就是难看的折行 ASCII，等于没写。

# 文献工作流（论文/算法复现专用）
1. paper_search → 用户选编号 →
2. paper_fetch(id, download=true) → 拿到 downloads/papers/xxx.pdf →
3. read_paper(path, focus="drag model" / "boundary condition" / "lattice scheme") →
4. 如果有关键图表（流程图/曲线/公式/物性表）：vision_analyze 提取数值 →
5. update_todos 把算法步骤拆成 5–15 项，再按 FOAM/MFIX/LBM 工作流落地。

# 长程任务
1. 任务复杂时先 update_todos 拆 5–20 项可验证待办（多拆不差）。
2. 完成一项 → done=true。
3. 改完代码 → run_command 跑试试 → 失败读错 → 修→再跑。
4. 全部完成才调 task_complete。

# 规则
- 修改文件前一句话说明意图；优先 edit_file。
- 中文回答、中文注释。

# 网格自动核对闭环（v6 强制策略 / OpenFOAM 模式）
- **凡是 foam_run_solver_async 跑 blockMesh / snappyHexMesh / snappyHexMesh -overwrite，结束后必须立刻调 foam_mesh_verify(case_path, stage='blockMesh' 或 'snappy')，再决定下一步。** 不允许直接进求解器。
- **凡是要做 snappy，先 foam_stl_render(stl_path) 肉眼核对法向/封闭/比例，再 foam_mesh_plan。**
- foam_mesh_verify 返回 pass=false 时：① 看 metrics 的 maxNonOrtho/skew/negVol；② 看 vision 的视觉描述；③ 用 edit_file 修 system/blockMeshDict 或 system/snappyHexMeshDict；④ 重新跑 → 再 verify。最多 3 次失败后启动**自动降档**：foam_mesh_plan(strategy='coarsen') → 'minimal' → 'box_stl'。
- snappy 之后必须 foam_patch_diff(case_path) 确认 inlet/outlet/walls 是否真的切出来；丢 patch 就是 mesh_plan 的 location_in_mesh 选错了。
- 这套闭环是硬约束，不要因为"看起来网格还行"就跳过 verify。

# v0.6.0 自治可靠性（硬约束）
- **任何长任务（论文复现 / CFD 工作流）开始前**：先调 run_status_load 看是否有未完成的 Run；如要开新任务，第一步就 run_stage_start({stage:'plan', label:'任务名'})。
- **每完成一个阶段（geom / mesh / setup / solve / post / report）**：必须以对应 *_verify（foam_geom_verify / foam_mesh_verify / foam_solve_verify / foam_post_verify / paper_param_verify）做视觉/数值核验；passed=true 才能 run_stage_done({passed:true, memo:"为什么这么做+下一步"})；passed=false 进入返工，最多 3 次后整体记 run_stage_done({passed:false, memo:...}) 并向用户报告。
- **读文档（read_document / read_paper）已内置 vision fallback**：如果基线解析失败或返回文本过短，会自动用 VLM 逐页识别，转回原基线文本格式。你不用手动重试；但拿到 [vision_fallback] 标记的结果时应在 memo 里注明"页图识别"。
- **HIL（人工二选一）不能代替 Verifier**：让用户选只是消歧，质量保证仍要走 *_verify。
- **Schema 错误**：若返回 [SCHEMA_INPUT_ERROR]，按提示修参数后重试，不要换工具绕过。
- **熔断**：若返回 [WATCHDOG_HALT]，立刻 run_stage_done({passed:false}) 并向用户汇报，禁止继续硬冲。`;

// SIM_PROMPT removed in v2: lightweight sim-mode hint was redundant.
// ParaView tools (sim_render / sim_open_paraview / sim_run_openfoam) remain available
// and are referenced from FOAM_PROMPT / MFIX_PROMPT / LBM_PROMPT directly when those Beta modes are enabled.

const sessions = new Map();

// ====================== 任务持久化（多任务 · 跨刷新/重启/换模型保留上下文） ======================
// 以前 session 跟 WebSocket 绑定：刷新页面/换模型 = 新连接 = 上下文全丢。
// 现在把「任务」落盘到 tasks/<id>.json（LLM messages + todos + 标题），连接只是挂载到当前任务：
// 刷新/重启/换模型都接着原上下文继续；还能新建/切换/删除多个任务。
const TASKS_DIR = path.join(__dirname, 'tasks');
const TASKS = new Map();           // taskId -> { id, title, createdAt, updatedAt, messages, todos }（_开头字段为运行时不落盘）
let CURRENT_TASK_ID = null;
function _taskFile(id) { return path.join(TASKS_DIR, id + '.json'); }
function _newTaskId() { return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function loadAllTasks() {
  try { fssync.mkdirSync(TASKS_DIR, { recursive: true }); } catch {}
  try {
    for (const f of fssync.readdirSync(TASKS_DIR)) {
      if (!f.endsWith('.json') || f.startsWith('_')) continue;
      try {
        const t = JSON.parse(fssync.readFileSync(path.join(TASKS_DIR, f), 'utf8'));
        if (t && t.id) {
          t.messages = Array.isArray(t.messages) ? t.messages : [];
          t.todos = Array.isArray(t.todos) ? t.todos : [];
          // 重启时正在执行的工具调用（如 solver_wait）没有响应：补占位；自主模式下安排一次自动续跑
          const nDangling = repairDanglingToolCalls(t.messages);
          if (nDangling) {
            console.log(`[tasks] ${t.title || t.id}: 补齐 ${nDangling} 个被重启中断的工具调用`);
            if (t.autoMode === true && !t.awaitingApproval && !t.pendingQuestion && !['pending', 'running'].includes(t.recovery?.status)) {
              t.messages.push({ role: 'user', content: '[系统] 服务刚刚重启（版本更新），上一步工具调用被中断，结果未知。请先 run_status_load 看在跑的作业和待办，从中断处继续，不要从头重来。' });
              t.recovery = { attempt: 0, nextAt: Date.now() + 15_000, lastError: 'fetch failed: 服务重启中断（自动续跑）', status: 'pending' };
            }
            try { fssync.writeFileSync(path.join(TASKS_DIR, f), JSON.stringify(t)); } catch {}
          }
          TASKS.set(t.id, t);
        }
      } catch {}
    }
    try { CURRENT_TASK_ID = JSON.parse(fssync.readFileSync(path.join(TASKS_DIR, '_meta.json'), 'utf8')).currentId || null; } catch {}
    if (!TASKS.has(CURRENT_TASK_ID)) CURRENT_TASK_ID = null;
  } catch {}
}
function _saveTaskMeta() { try { fssync.writeFileSync(path.join(TASKS_DIR, '_meta.json'), JSON.stringify({ currentId: CURRENT_TASK_ID })); } catch {} }
function persistTaskNow(task) {
  if (!task) return;
  if (task._saveTimer) { clearTimeout(task._saveTimer); task._saveTimer = null; }
  try {
    fssync.mkdirSync(TASKS_DIR, { recursive: true });
    const clean = {}; for (const k of Object.keys(task)) if (!k.startsWith('_')) clean[k] = task[k];
    // 大图附件（base64 dataUrl）不落盘，否则单文件可能几十 MB；重启后图片上下文丢失可接受
    const json = JSON.stringify(clean, (k, v) =>
      (k === 'image_url' && v && typeof v.url === 'string' && v.url.length > 100_000) ? { url: '[图片过大未存盘]' } : v);
    const temporary = _taskFile(task.id) + '.tmp';
    fssync.writeFileSync(temporary, json);
    fssync.renameSync(temporary, _taskFile(task.id));
  } catch (e) { console.warn('[tasks] 保存失败:', e.message); }
}
function schedulePersistTask(task) {
  if (!task || task._saveTimer) return;
  task._saveTimer = setTimeout(() => { task._saveTimer = null; persistTaskNow(task); }, 3000);
}
function createTask(title) {
  const t = { id: _newTaskId(), title: (title || '新任务').slice(0, 60), createdAt: Date.now(), updatedAt: Date.now(), messages: [], todos: [] };
  TASKS.set(t.id, t); CURRENT_TASK_ID = t.id; _saveTaskMeta(); persistTaskNow(t);
  return t;
}
function ensureCurrentTask() {
  let t = TASKS.get(CURRENT_TASK_ID);
  if (!t) {
    // 取最近更新的任务；一个都没有就新建
    t = [...TASKS.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || createTask();
    CURRENT_TASK_ID = t.id; _saveTaskMeta();
  }
  return t;
}
function attachSessionToTask(s, task) {
  s.task = task;
  if (typeof task.autoMode !== 'boolean') task.autoMode = !!s.autoMode;
  if (typeof task.autoMode === 'boolean') s.autoMode = task.autoMode;
  s.awaitingUserChoice = !!task.awaitingUserChoice;
  s.pendingQuestion = task.pendingQuestion || null;
  s._recoveryApprovalBlocked = !!task.awaitingApproval;
  if (!Array.isArray(task.messages) || task.messages.length === 0) task.messages = [{ role: 'system', content: SYSTEM_PROMPT_BASE(WORKSPACE) }];
  s.messages = task.messages;             // 同一数组引用：session 写 = 任务写
  s.todos = Array.isArray(task.todos) ? task.todos : [];
  task.todos = s.todos;
  // 工作记忆(stage/casePath/solver/verified/pitfalls)跟任务走：重启/刷新后长程任务接着原状态
  s.workMem = (task.workMem && typeof task.workMem === 'object') ? task.workMem : null;
}
function syncTaskFromSession(s) {
  const t = s && s.task; if (!t) return;
  if (taskOwner(s) !== s) return;
  t.messages = s.messages;                // autoCompact 可能重建过数组引用，这里收敛回任务
  t.todos = s.todos || [];
  t.awaitingUserChoice = !!s.awaitingUserChoice;
  t.awaitingApproval = !!s.pendingApproval || !!s._recoveryApprovalBlocked;
  t.pendingQuestion = s.pendingQuestion || null;
  if (s.workMem) t.workMem = s.workMem;
  t.updatedAt = Date.now();
}
function persistSession(s, now) {
  if (!s || !s.task) return;
  syncTaskFromSession(s);
  (now ? persistTaskNow : schedulePersistTask)(s.task);
}
function taskListPayload(forSession) {
  const jobs = new Map();
  for (const r of SOLVER_RUNS.values()) {
    if (r && !r.ended && r.ownerTaskId) jobs.set(r.ownerTaskId, (jobs.get(r.ownerTaskId) || 0) + 1);
  }
  const list = [...TASKS.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map(t => ({ id: t.id, title: t.title, updatedAt: t.updatedAt, msgCount: (t.messages || []).length,
      autoMode: t.autoMode === true,
      agentMode: t.agentMode === 'plan' ? 'plan' : 'build',
      goal: t.goal ? { text: t.goal.text, criteria: t.goal.criteria || '', status: t.goal.status, nudges: t.goal.nudges || 0 } : null,
      ctxChars: historyCharCount(t.messages || []), ctxMax: MAX_HISTORY_CHARS,
      forkOf: t.forkOf || null,
      modelRef: t.modelRef || null, model: modelLabel(t.modelRef),
      multiRun: t.multiRun || null,
      usage: t.usageTotals ? { calls: t.usageTotals.calls, prompt: t.usageTotals.prompt, completion: t.usageTotals.completion } : null,
      running: !!(t._runningSession && t._runningSession._running),
      jobs: jobs.get(t.id) || 0, caseDir: _taskCaseDir(t),
      recovery: t.recovery ? { status: t.recovery.status, attempt: t.recovery.attempt, nextAt: t.recovery.nextAt } : null }));
  // currentId 按连接返回：每个窗口显示自己挂载的任务，多窗口可并行跑不同任务互不干扰
  const currentId = (forSession && forSession.task && forSession.task.id) || CURRENT_TASK_ID;
  return { type: 'task_state', list, currentId };
}
function broadcastTaskState() {
  for (const c of allClients) {
    try { if (c.readyState === 1) c.send(JSON.stringify(taskListPayload(sessions.get(c)))); } catch {}
  }
}
// 从 LLM messages 推导前端可回放的对话事件（不另存一份转写，零额外簿记）
function taskHistoryPayload(task) {
  const ev = []; let ui = 0;
  for (const m of (task.messages || [])) {
    if (!m) continue;
    if (m.role === 'user') {
      let text = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? ((m.content.find(p => p && p.type === 'text') || {}).text || '') : '');
      text = String(text);
      if (/^\[(系统|提示|SYSTEM)/.test(text)) continue;          // 反空转/循环守卫注入的伪 user 消息不回放
      if (text.startsWith('以下是之前会话的压缩总结')) { ev.push({ k: 'sys', text: '（更早的历史已自动压缩为摘要，模型上下文中仍保留）' }); continue; }
      ev.push({ k: 'user', text: text.slice(0, 4000), ui: ui++ });
    } else if (m.role === 'assistant') {
      const t = (typeof m.content === 'string' ? m.content : '').trim();
      if (t) ev.push({ k: 'ai', text: t.slice(0, 8000) });
      for (const tc of (m.tool_calls || [])) ev.push({ k: 'tool', name: (tc.function && tc.function.name) || '?', args: String((tc.function && tc.function.arguments) || '').slice(0, 400) });
    } else if (m.role === 'tool') {
      // 把结果挂回最近一个还没有结果的 tool 事件
      for (let i = ev.length - 1; i >= 0; i--) { if (ev[i].k === 'tool' && ev[i].result === undefined) { ev[i].result = String(m.content || '').slice(0, 600); break; } }
    }
  }
  return { type: 'task_history', taskId: task.id, title: task.title, events: ev.slice(-300), canRedo: !!(task.revert && task.revert.messages) };
}
// 界面上看得见的用户消息（与 taskHistoryPayload 同一过滤）在 messages 里的下标；回滚/分叉都按它对齐，
// 不能各自计数（之前分叉只滤 [系统，界面还滤了 [提示 / 压缩摘要，下标会错位）
function visibleUserIndices(msgs) {
  const out = [];
  (msgs || []).forEach((m, i) => {
    if (!m || m.role !== 'user') return;
    const text = String(typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? ((m.content.find(p => p && p.type === 'text') || {}).text || '') : ''));
    if (/^\[(系统|提示|SYSTEM)/.test(text) || text.startsWith('以下是之前会话的压缩总结')) return;
    out.push(i);
  });
  return out;
}
// 每轮用户输入一个文件快照（只记这轮第一次改动前的内容，≤1 MB/文件），跟任务存盘：重启/换浏览器后仍能回滚文件
const TURN_SNAP_MAX = 40, TURN_SNAP_FILE_MAX = 1 << 20;
function recordTurnFile(task, rel, oldContent) {
  const s = task && task._turnSnap; if (!s || rel in s.files) return;
  s.files[rel] = (oldContent === null || oldContent === undefined) ? null
    : (String(oldContent).length > TURN_SNAP_FILE_MAX ? { tooLarge: true } : String(oldContent));
}
async function _readOrNull(rel) { try { return await fs.readFile(safePath(rel), 'utf8'); } catch { return null; } }
async function _writeOrDelete(rel, content) {
  const f = safePath(rel);
  if (content === null) { try { await fs.unlink(f); } catch {} return; }
  await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, content, 'utf8');
}
// 回滚到第 ui 条可见用户消息之前：删掉它及之后的对话，文件恢复到那一轮开始前；被删的部分留作"撤销回滚"
async function revertTask(task, ui) {
  const idx = visibleUserIndices(task.messages)[ui];
  if (idx === undefined) throw new Error('找不到这条消息（可能已被压缩）');
  const snaps = (task.turnSnaps || []).filter(s => s.msgIndex >= idx);
  const earliest = {}, skipped = [];
  for (const s of snaps) for (const [p, c] of Object.entries(s.files)) if (!(p in earliest)) earliest[p] = c;
  const redoFiles = {};
  for (const [p, c] of Object.entries(earliest)) {
    if (c && c.tooLarge) { skipped.push(p); continue; }
    redoFiles[p] = await _readOrNull(p);
    await _writeOrDelete(p, c);
  }
  const removed = task.messages.splice(idx);
  task.revert = { messages: removed, files: redoFiles, snaps, at: Date.now() };
  task.turnSnaps = (task.turnSnaps || []).filter(s => s.msgIndex < idx);
  const first = removed[0];
  const text = String(typeof first.content === 'string' ? first.content : (Array.isArray(first.content) ? ((first.content.find(p => p && p.type === 'text') || {}).text || '') : ''));
  return { text, messages: removed.length, files: Object.keys(redoFiles).length, skipped };
}
async function unrevertTask(task) {
  const r = task.revert; if (!r) throw new Error('没有可撤销的回滚');
  for (const [p, c] of Object.entries(r.files || {})) await _writeOrDelete(p, c);
  task.messages.push(...r.messages);
  task.turnSnaps = [...(task.turnSnaps || []), ...(r.snaps || [])];
  task.revert = null;
  return { messages: r.messages.length, files: Object.keys(r.files || {}).length };
}
loadAllTasks();


// ====================== 工具执行进度心跳（让用户看见 agent 在干啥） ======================
// 在每次 execTool 周围发出 ⏳ 开始 / 周期性 …仍在运行 Ns / ✔ 完成 用时 的终端日志。
const PROGRESS_INSTANT = new Set(['list_dir','read_file','grep_search','glob','update_todos','task_complete']);
function _summarizeArgs(args) {
  try {
    if (!args || typeof args !== 'object') return '';
    const keys = Object.keys(args);
    if (!keys.length) return '';
    const k = keys[0];
    let v = args[k];
    if (Array.isArray(v)) v = `[${v.length} 项]`;
    else if (typeof v === 'object' && v) v = JSON.stringify(v).slice(0, 80);
    else v = String(v);
    v = v.replace(/\s+/g, ' ').slice(0, 100);
    return `${k}=${v}${keys.length > 1 ? `, +${keys.length-1} 参` : ''}`;
  } catch { return ''; }
}
async function execToolWithProgress(name, args, session, ws) {
  // 即时类工具不打心跳（否则刷屏）
  if (PROGRESS_INSTANT.has(name)) return execTool(name, args, session, ws);
  const start = Date.now();
  const summary = _summarizeArgs(args);
  try { ws.send(JSON.stringify({ type: 'term', line: `⏳ ${name}(${summary}) …` })); } catch {}
  let lastTick = start, lastTermLine = start;
  const interval = setInterval(() => {
    const sec = ((Date.now() - start) / 1000).toFixed(1);
    // 长等待只每 60s 写一行终端，避免日志刷屏
    if (Date.now() - start < 30_000 || Date.now() - lastTermLine >= 60_000) {
      lastTermLine = Date.now();
      try { ws.send(JSON.stringify({ type: 'term', line: `   …${name} 仍在运行 ${sec}s（可点 ⏹ 随时终止）` })); } catch {}
    }
    try { ws.send(JSON.stringify({ type: 'agent_phase', phase: 'tool_exec', detail: `${name} 运行 ${sec}s`, tool: name, elapsed_ms: Date.now() - start })); } catch {}
    lastTick = Date.now();
  }, 2500);
  // 把心跳通道暴露给工具内部（webSearch/paperSearch 可用）
  const prevPub = session._progressPub;
  session._progressPub = (line) => { try { ws.send(JSON.stringify({ type: 'term', line: `   · ${name}: ${line}` })); } catch {} };
  // 不保证工具内部响应 abort 信号（很多 fetch 没走 signal）。
  // 用 Promise.race 跟 abortPromise 赛跑：一旦用户点停止，立刻返回【已取消】，
  // 不再等任何慢工具跑完才出环。
  let _abortSig = null, _onAbort = null;
  const abortPromise = new Promise((resolve) => {
    if (!session.aborter || !session.aborter.signal) return;
    const sig = session.aborter.signal;
    if (sig.aborted) return resolve('__ABORTED__');
    _abortSig = sig; _onAbort = () => resolve('__ABORTED__');
    sig.addEventListener('abort', _onAbort, { once: true });
  });
  // v0.8.0 工具超时：默认 10 min。可经 TOOL_TIMEOUT_MS 环境变量或 TOOL_TIMEOUT_OVERRIDES[name] 单独配置。
  const TOOL_TIMEOUT_OVERRIDES = {
    foam_run_solver_async: 30_000,   // 这本身只是 spawn，立即返回
    mfix_run_solver_async: 30_000,
    lbm_run_async: 30_000,
    foam_solver_status: 15_000,
    solver_wait: 13 * 3600_000,
    foam_solver_stop: 15_000,
    sim_run_openfoam: 1_800_000,     // 同步求解最长 30 min（建议改用 async）
    run_command: 1_200_000,          // shell 命令最长 20 min
  };
  const toolTimeoutMs = TOOL_TIMEOUT_OVERRIDES[name] || parseInt(process.env.TOOL_TIMEOUT_MS || '600000', 10);
  let timeoutHandle = null;
  const timeoutPromise = new Promise((resolve) => { timeoutHandle = setTimeout(() => resolve({ ok: 'timeout' }), toolTimeoutMs); });
  try {
    const winner = await Promise.race([
      execTool(name, args, session, ws).then(v => ({ ok: true, v })).catch(e => ({ ok: false, e })),
      abortPromise.then(() => ({ ok: 'abort' })),
      timeoutPromise
    ]);
    if (winner.ok === 'timeout') {
      const sec = ((Date.now() - start) / 1000).toFixed(2);
      try { ws.send(JSON.stringify({ type: 'term', line: `⏱ ${name} 超时（${sec}s > ${(toolTimeoutMs/1000)|0}s）；如需长任务请改用 foam_run_solver_async / mfix_run_solver_async / lbm_run_solver_async` })); } catch {}
      return `[超时：工具 ${name} 在 ${(toolTimeoutMs/1000)|0}s 内未完成；如果是仿真请改用 foam_run_solver_async 把它扔到后台跑]`;
    }
    if (winner.ok === 'abort') {
      const sec = ((Date.now() - start) / 1000).toFixed(2);
      try { ws.send(JSON.stringify({ type: 'term', line: `⦻ ${name} 已取消（耗时 ${sec}s，用户请求停止）` })); } catch {}
      return '[已取消：用户请求终止]';
    }
    if (winner.ok === false) { throw winner.e; }
    const r = winner.v;
    const sec = ((Date.now() - start) / 1000).toFixed(2);
    const size = typeof r === 'string' ? r.length : 0;
    try { ws.send(JSON.stringify({ type: 'term', line: `✔ ${name} 完成（耗时 ${sec}s，返回 ${size} 字符）` })); } catch {}
    return r;
  } catch (e) {
    const sec = ((Date.now() - start) / 1000).toFixed(2);
    try { ws.send(JSON.stringify({ type: 'term', line: `✘ ${name} 失败（耗时 ${sec}s）：${e.message || e}` })); } catch {}
    throw e;
  } finally {
    clearInterval(interval);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (_abortSig && _onAbort) { try { _abortSig.removeEventListener('abort', _onAbort); } catch {} }
    session._progressPub = prevPub;
  }
}

function broadcastCheckpoints(ws) { const s = sessions.get(ws); if (!s) return;
  ws.send(JSON.stringify({ type: 'checkpoints', list: s.checkpoints.map(c => ({ id: c.id, label: c.label, timestamp: c.timestamp, fileCount: Object.keys(c.files).length })) })); }
const FOAM_PROMPT = `

# OpenFOAM Beta 仿真模式（已开启）
OpenFOAM 根目录：${SETTINGS.foamRoot || '(未设置！请先 /api/foam/config 或在 Beta 面板填写)'}

## 你拥有的额外工具
- foam_find_tutorial(query, top_k?)：查 tutorials/。
- foam_find_source(query, kind?)：查 src/ + applications/。
- foam_clone_tutorial(tutorial_path, dest)：把 tutorial 拷到工作区。
- foam_inspect_case(case_path)：列 0/ constant/ system/ + 边界条件矩阵 + **完整文件清单（递归）**。
- foam_run_solver_async(case_path, command)：**长任务专用**。后台启动求解器/blockMesh/checkMesh，立刻返回 runId，不阻塞会话。
- foam_solver_status(run_id)：取最新 Time、最近残差、log tail、是否还在跑。
- foam_solver_stop(run_id)：终止后台作业。
- 已有：list_dir / read_file / edit_file / multi_edit / sim_render / sim_run_openfoam（短命令同步用）。

## 🛑 Pre-Flight Check（任何仿真开始前的强制门——违反就必然出问题）

**原则：先评估可行性，再建模，再跑。评估不充分宁可暂停，不能上来就跑。**

这是从 Lu 2017 MTO 复现事故中提炼的教训：用 EMMSscale 曳力模型跑密相启动段，HD 函数在 εg=0.45 返回 0.066（曳力只有 Wen-Yu 的 6.6%），床层静止 15 小时。根因是没有前置评估就直接跑。

### PF-0 · 问题分类（任何仿真任务，建案前必做）

在动手建 case / 改参数 / 跑求解器之前，必须先回答以下问题并写进 deviations.log 或任务备忘：

**物理类型识别**：
- 什么物理过程？[单相流 / 多相流 / 反应流 / 传热 / 传质 / 颗粒 / 燃烧 / 自由表面 / 多孔介质 / LBM / …]
- 是否有论文/参考？有 → 走文献核对三遍铁律；无 → 走从零建案风险评估

**工况分类（用无量纲数判断物理区间）**：
- 多相颗粒流：U/Umf → 固定床(<2) / 鼓泡床(2–10) / 湍动床(10–30) / 快床(>30)
- 单相流：Re → 层流(<2300) / 过渡 / 湍流(>4000)
- 传热：Ra → 自然对流强度区间
- 可压流：Ma → 不可压(<0.3) / 亚音速 / 跨音速 / 超音速
- LBM：tau → 稳定区间[0.5, 2.0]，u_lb < 0.1
- **必须明确写出：你的关键无量纲数是多少？这个区间的物理特征是什么？**

**模型适用性评估（最重要的环节）**：
1. 你选的物理模型是在什么工况/论文下提出、验证的？（文献来源）
2. 当前工况是否在那个验证范围内？
3. 如果不在范围内 → 必须说明处理方案（换模型 / blending / 分阶段 / 修改截断参数 / 文献外推）
4. 不能默默用下去，不能靠猜

**通用模型完整性清单**（全部 ✅ 才能跑）：
- 通用：求解器名称、时间步长、CFL/稳定判据、写出频率、并行核数
- 多相/颗粒(TFM)：曳力 + 颗粒粘度 + 颗粒压力 + 摩擦压力 + 恢复系数 + 径向分布函数（6 项全配）
- 单相湍流：RASModel/LESModel + 壁面函数类型 + y+ 目标值
- 反应流：反应机理来源 + 组分清单完整性 + 源项注入方式 + 热力学数据
- 传热：辐射模型 + 对流换热系数 + 热边界条件
- LBM：碰撞模型(BGK/MRT/TRT/Cumulant) + 边界处理方式 + 力源项 + 格子速度

**配置文件一致性**（建完 case 后、跑前强制核查）：
- 各文件之间同一参数值是否一致（alphaMax、参考温度、参考压力、物性等）
- 自定义库是否已加载（controlDict libs / LD_LIBRARY_PATH / CMakeLists）
- 0/ 或 0.orig/ 初始场是否齐全且 dimensions 正确
- 不同配置文件是否可能冲突（如 turbulenceProperties 与 phaseProperties 给了不同的同名参数）

### PF-1 · 仿真前置评估报告（格式化输出，不可省略）

**任何新仿真（包括论文复现）开始时，在第 1 次调求解器之前，必须先输出并等待用户确认以下报告：**

\`\`\`
=== Pre-Flight 仿真评估报告 ===

【物理类型】
  类型：[单相/多相/反应/传热/颗粒/LBM/…]
  参考：[论文 Author Year / 教程路径 / 从零建案]

【工况分类】
  关键参数：[按类型填写：dp/ρ/μ/U 或 Re 或 Ra 或 Ma 或 tau]
  关键无量纲数：___ = ___
  流态区间：___ → 该区间的物理特征：___

【模型适用性】
  选用模型：___
  该模型验证范围（文献来源）：___
  当前工况是否在范围内：[是 / 否]
  若否 → 处理方案：[换模型 / blending / 分阶段 / 截断 / 外推]

【模型完整性】
  [按物理类型对应的清单逐项列 ✅/❌，全部 ✅ 才继续]

【文件一致性】
  关键参数跨文件一致性：一致 / 不一致（列出不一致项）
  自定义库加载：___
  初始场 0.orig/ 齐全：是 / 否

【偏差登记（写进 deviations.log 的项）】
  1) DEV-xxx: ...
  2) ...

【风险评估】
  高风险项（需特别监控）：
    - ___
  第一个检查点（t=___ 或 step=___）监控指标：
    - ___

以上评估请确认（全部 OK 我才启动求解器）：
1) 全部 OK，继续
2) 第 ___ 项需要修改：___
\`\`\`

numbered options + 问号 → 触发 V4 人在回路，等用户确认后才启动求解器。

### PF-2 · 启动后早期诊断门

求解器启动后，**第一个检查点必须在 t=1τ（1 个停留时间 / 特征时间）或前 100 步**：
- 核心物理量是否有变化趋势（多相 → alpha mean/Max；单相 → 速度/残差；LBM → 宏观量收敛）
- 是否出现非物理值（负体积分数 / nan / 发散 / 恒定不变）
- **若第一个检查点发现物理上不合理的恒定或发散：立即停机**，不要让它跑到 endTime 才发现问题

### PF-3 · 求解器专项清单

**OpenFOAM 多相/颗粒流**：
- EMMSscale 在 εg<0.47 时 HD≈0.066，密相启动段禁止单独使用 → 改 GidaspowErgunWenYu 或 blending
- 颗粒本构 7 项全配：drag + viscosityModel + conductivityModel + granularPressureModel + frictionalStressModel + alphaMinFriction + radialModel
- alphaMinFriction 未设则摩擦模型不激活，密相床会过度压缩到 alphaMax
- 3D 全几何之前先做 2×2 单元格基准验证模型组合能让床层膨胀

**MFIX**：
- RUN_TYPE / TSTOP / DT 合理性；MMAX 颗粒相索引从 1 开始
- TFM 要求 cell >> dp，DEM 要求 cell > 3×dp
- BC_* 边界类型与流向一致性

**LBM**：
- tau ∈ [0.5, 2.0]，u_lb < 0.1
- 碰撞模型稳定性：BGK 高 Re 不稳定 → 换 MRT/Cumulant
- 壁面边界：bounce-back / Zou-He / extrapolation 适用场景不同

### 🔒 求解器错误预算（Anti-Spin Protocol — 防止在报错案例上无限空转）

**铁律：求解器报错不是让你无限调试的——你有有限次数的修复机会。**

每次求解器（blockMesh / snappyHexMesh / 求解器本体）返回非零退出码或 FATAL ERROR 时，按以下流程：

1. **第 1 次报错**：调 \`diagnose_error\` 读 log tail → 按返回的 next_steps 修 → 重跑
2. **第 2 次报错（同类）**：停下来，用 \`update_todos\` 登记这条错误为待办，**换一个完全不同的思路**（不是微调参数，而是换方案：如 EMMSscale→GidaspowErgunWenYu、uniform inlet→distributor、3D→2D 先验）
3. **第 3 次报错（同类）**：**立即停止**。调 \`task_complete({passed:false, memo:"求解器连续 3 次同类报错，需要用户介入。错误摘要：xxx"})\`，把错误根因分析和 3 次尝试的 diff 摘要给用户，让用户决定下一步。

**禁止行为**：
- 禁止连续 3 次以上以"微调参数"方式修同类错误（如只改 deltaT、只改 tolerance、只改 nNonOrthogonalCorrectors）——这不是修复，是赌博
- 禁止在没调 \`diagnose_error\` 的情况下直接重跑——你必须先知道上一轮为什么错
- 禁止把同一个错误"修好后又出现"当新错误处理——同类错误计数累加，不归零

**同类错误判定**：diagnose_error 返回的 category 相同 = 同类（如都是 "mesh_quality"、都是 "divergence"、都是 "boundary_condition"）

**跨类重置**：如果第 2 次错误与第 1 次不同类（category 不同），计数重置为 1，重新开始

**特殊情况**：网格质量修了 2 次后通过 → 不算 3 次，继续跑求解器；求解器又报新的 divergence → 这是新类别，计数从 1 开始。

### 📊 运行健康检查协议（避免浪费机时）

求解器启动后，按以下节奏检查（不要等 endTime 才看）：

| 检查点 | 时机 | 看什么 | 判定 |
|---|---|---|---|
| HC-1 | t=1τ 或前 100 步 | 核心物理量趋势 + 残差 | 恒定不变 → 停机诊断 |
| HC-2 | t=10% endTime | 残差下降趋势 + 物理合理性 | 发散/nan → 停机 |
| HC-3 | t=50% endTime | 关键 KPI 是否在合理范围 | 偏离 > 50% → 警告用户 |
| HC-4 | t=90% endTime | 结果是否在收敛 | 未收敛 → 续跑 or 停 |

**HC-1 失败时立即停机**（foam_solver_stop），不要让它白跑到 endTime——这就是 demo3D_dist 浪费 15 小时的教训。

### 🩸 血泪教训登记

**2026-11-10 · demo3D_dist（OpenFOAM + EMMSscale）**：密相床（α_s=0.55）启动，EMMSscale HD(εg=0.45)≈0.066，曳力只有 Wen-Yu 的 6.6%，床层不流化，88 核跑了 15 小时才发现。规则：有 EMMS 的案子 Pre-Flight 必须算初始 εg 下的 HD 值，<0.1 禁止启动。
## 🌊 流水式工作流（必须严格按 5 步走）

**第 1 步 · 问意图**
开口先问：「你**已经有具体算例**了吗？」给出两个明确选项让用户回（用户也可能直接点 UI 按钮帮你选）：
  ① 我有具体算例 —— 请提供 case 路径，或在工作区里指给我看；
  ② 我没有 —— 请告诉我**关键词**（如 bubbleColumn / twoPhaseEulerFoam / RANS / 自然对流 …）

**第 2 步 · 算例选择**
- 若用户答①：直接到第 3 步。
- 若用户答②：调用 \`foam_find_tutorial\` 用关键词搜本地 tutorials/，取前 8–12 个候选；用 \`update_todos\` 列出**带编号的候选清单**（每条一行：solver / 物理 / 路径），并在聊天里**用 1) 2) 3) 编号**列给用户，让用户回编号选 1 个。**禁止**直接帮用户选。
- 用户选了之后调 \`foam_clone_tutorial\` 拷到工作区。

**第 3 步 · 完整遍历 + 分析**
对最终的 case 路径调 \`foam_inspect_case\` 一次（**它已经包含递归文件清单**，不要再一个个 read_file 列目录）。
拿到结果后做两件事：
  a. **列出所有可改项**：边界条件 / 物性 / 网格(blockMeshDict) / 求解器选择 / 时间步 / 写出频率 / 并行分解 …  用 \`update_todos\` 写成 5–20 项的清单；
  b. 在聊天里**给用户「推荐选项按钮」**：每一项给 1 个推荐默认值 + 2~4 个常见可选值，用 1)2)3) 编号列出，明确标注「**默认：B**」让用户能 1 个回车跳过。例：
       「U 入口速度 (b.c.)：1) fixedValue 0.1 m/s ✅默认  2) flowRateInletVelocity  3) codedFixedValue  → 回 1/2/3 或直接回车用默认」

**第 4 步 · 一次只问 1 项 + 应用**
按 todo 顺序一次只问一个，等用户回；
- 用户回了就调 \`edit_file\` / \`multi_edit\` 改对应 dictionary，
- 调 \`update_todos\` 把这一项 done=true，
- 紧接着问下一项；
**禁止**一次抛 5 个问题给用户。

**第 5 步 · 跑算例 + 间隔监测**
所有 todo 都 done 之后：
  1. **逐步跑**（每一步用 \`foam_run_solver_async\` 启动，告诉用户 runId，让用户在「求解器监测」面板订阅）：
       blockMesh → checkMesh → (decomposePar 可选) → 求解器
  2. **每个 runId 启动后**，**不要立刻接着调** \`foam_solver_status\`。告诉用户：
       「已启动 runId=xxxx。监测面板每 N 秒自动刷新；你也可以让我查询 \`foam_solver_status\`。」
  3. 用户问"现在跑成什么样了"时再调 status；用户说"停"就 \`foam_solver_stop\`。
  4. 求解器结束后调 \`post_view\` 出图（截面 / 剖切 / 等值面 / 流线，按用户要的场和位置）。

## 重要纪律
- **回答尽量短**，多用编号清单，不要长段落。
- **没问明白前不动 edit_file**。
- 长任务一律走 \`foam_run_solver_async\`，**绝不**用同步 \`sim_run_openfoam\` 跑会跑几分钟以上的求解器。
- 若 foamRoot 未设：先告诉用户在右边 "OpenFOAM (Beta)" 面板填写 OpenFOAM 安装路径。

## 📄 论文 → OpenFOAM 植入工作流（独立子流程）

当用户提供 PDF 路径，或说"把这篇论文里的算法实现到 OpenFOAM"，按如下步骤：

**P1 · 读论文**
- 调 \`read_document(path)\` 拿全文（已自动 PDF/DOCX 解析）。返回长度上限 ~20K 字，足够定位算法。
- 如果太长，再次 \`read_document\` 不会更多——直接基于已抓到的文本提炼。

## 🔴🔴🔴 文献核对三遍铁律（P2 之前的强制环节）

**任何来自论文的"边界条件 / 初始条件 / 数值算法 / 物理常数 / 几何尺寸 / 时间步长 / 求解器选项"，必须独立核对 3 遍，3 次结论一致才能进入实现。**

**3 遍方法（不许偷懒成 1 遍）**：
- **第 1 遍 · 全文扫读**：调 \`read_document\` 拿正文，逐项抽取"边界条件 / 算法 / 常数"清单。
- **第 2 遍 · 关键页核对**：找到含这些数值的具体页（通常 Methods / Numerical Setup / Table 1-3 / Figure caption），用 \`read_document\` 配合 \`paper_param_verify\` 或 \`vision_analyze\` 把**原页图**作为图像核对一遍（防 OCR 错位、上下标丢失、单位脱落）。
- **第 3 遍 · 量纲与合理性自检**：每个数值单独走一遍：
   - 单位是否一致（论文里 cm/s 还是 m/s？mm 还是 m？K 还是 °C？bar 还是 Pa？）
   - 量纲是否对（k 应该是 m²/s²、ε 是 m²/s³、ω 是 1/s、ν 是 m²/s，弄反必崩）
   - 数量级是否合理（Re 算出来是 10⁵ 还是 10⁷？气泡 d_b 是 mm 还是 μm？）
   - 与同领域典型值偏差（与教材/Akita 公式/经验关联式比一下）

**任何一遍发现不一致 / 模糊 / 论文里写得含糊 / 没明说 → 必须停下来开"人在回路"询问用户**：
   \`\`\`
   ⚠ 论文核对存疑（第 N 遍）：
     - 项目：<例：来流湍流强度 I>
     - 论文 P.X 节 / 公式 (Y) / 表 Z 里的描述：<原文片段或抽取值>
     - 我读到的歧义：<例："turbulent intensity 5%" 但没说是相对 U_inf 还是 U_bulk>
     - 我倾向：1) 取 5% × U_inf ✅；2) 取 5% × U_bulk；3) 跳过，等用户给值
     请确认编号。
   \`\`\`
   **绝对不要**自作主张猜一个值就往下走。

## 🔍 几何读图铁律（建几何前必做；正文只给"开孔率 5%"这类简化说法时尤其要做）

教训：中试 DMTO 复现里，正文只写"简化为开孔率 5% 的多孔板"，于是建成了零厚度挡板、把布孔当未知量去反演；
其实原文 Fig.1 的分布器插图（原图 113×165 像素）画了约 3 圈孔、带厚度（约 40 mm，筛板+烧结板两层）、板下约 35 mm 进气室，
正文"Z=0.047 m"与图注"Z=0.06 m"也互相矛盾——而近板 3 cm 内的径向剖面对高度极其敏感（min/壁 0.47→0.73）。
1. 每篇论文先 \`paper_figures(pdf)\` 抽出**原始分辨率**的嵌入图（不是整页渲染），列出所有几何相关的图。
2. 每张几何图用 \`image_crop(path, box, scale)\` 把部件（分布器/喷嘴/内构件/入口/挡板）放大 4–8 倍后再 \`vision_analyze\`，
   逐项回答：部件数量（几圈、每圈几个孔）、厚度、高度/间距、与相邻部件的相对位置；**按图中已标注的尺寸换算比例尺**（\`image_crop\` 的 measure 参数给像素距离），给出 ± 不确定度。
3. 图上看得见、正文没给数的特征（厚度、圈数、孔型）不能当"未知量"随便反演：先按读图值建模，标"读图值 ± 误差"，反演只在读图范围内搜索。
4. 正文与图注 / 表格对同一量给出不同数值（坐标原点、截面高度、尺寸）时：写进 deviations 作为"口径不确定"，
   对比指标时把该量的两个取值都算出来报给用户（敏感性），**禁止**挑一个最贴合的值当结论。
5. 坐标原点必须从图上的尺寸线确认（尺寸线起点 = 哪个面），不要默认"z=0 = 分布板"。

## 📋 "需要植入的方程 / 算例信息" 强制清单（P2 必输出）

3 遍核对全部一致 / 全部经人确认后，**必须用 \`update_todos\` 输出一个可勾选的"植入清单"**，且**单独发一条聊天消息让用户最后过目并强制暂停**：

\`\`\`
=== 论文 [<标题缩写> / Author Year] 待植入清单 ===

【A. 几何 / 计算域】
  □ 域尺寸: Lx × Ly × Lz = ___ × ___ × ___ m  （论文 Fig.X / §Y.Z）
  □ 关键特征尺寸（D / H / Δ ...）：___
  □ 单位换算: 论文用 ___ → OpenFOAM 用 m

【B. 网格 / 数值离散】
  □ 网格类型 / cell 数 / y+ 目标 / 边界层层数 / 第一层厚度
  □ 时间步 Δt = ___ s（CFL=___），endTime = ___ s
  □ 离散格式: div(phi,U)=<scheme>, laplacian=<scheme>, ddt=<scheme>
  □ 求解器线性 solver / 松弛因子 / nNonOrthogonalCorrectors

【C. 物理 / 求解器选择】
  □ 控制方程类别（不可压 / 可压 / 多相 VOF / Euler-Euler / 反应 / 传热…）
  □ OpenFOAM 求解器名: ___
  □ 湍流模型: ___（论文 § 公式编号）
  □ 多相 / 反应 / 传热子模型清单（drag / nucleation / breakup / coalescence / radiation / 化学反应）

【D. 边界条件】（**每个 patch 每个场必须独立列**，不许合并）
  □ inlet:  U=<type, value>, p=<...>, k=<...>, ω/ε=<...>, T=<...>, alpha.*=<...>
  □ outlet: ...
  □ walls:  ...
  □ symmetry/atmosphere/...

【E. 初始条件】
  □ 0/ 各场的 internalField（uniform / nonuniform / setFields region）
  □ 多相界面 / 液位 / 温度分层 / 颗粒体积分数初值

【F. 物性 / 常数】
  □ ρ_L=___, ρ_G=___, μ_L=___, μ_G=___, σ=___, g=___, ...
  □ 论文新提出的模型常数: a=___, b=___, n=___, ...（标 Eq. 编号）

【G. 监测与对标】
  □ 期望复现的图/表（Fig.X / Table Y）
  □ 用于判定成功的 KPI（误差阈值 ±__%）
  □ 后处理: forceCoeffs / patchAverage / sample / functionObjects 配置

每项后附：① 来源页码 + 公式/表号；② 3 遍核对结论一致还是经用户确认。
\`\`\`

**强制暂停规则**：清单出完后必须以下面这条结尾，触发 V4 人在回路自动暂停：
   \`\`\`
   以上 7 大块共 N 项，请你**逐块确认**：
     1) A 几何 OK ✅ / 需要改
     2) B 数值 OK ✅ / 需要改
     ...
     7) G 监测 OK ✅ / 需要改
   全部回 OK 我才动手写代码或建 case。**禁止自动继续。**
   \`\`\`
   numbered options + 问号 → 自动进入 awaiting_user 状态。

**任何一项用户回"需要改"，必须先把改动落地到清单里、重出一遍清单、再次暂停**，循环直到全 OK。


**P2 · 总结成 4 项摘要**（用 \`update_todos\` 写成可勾选清单）：
  ① **算法名 / 类别**（drag model / turbulence closure / interfacial heat / population balance / VOF surface tension / …）
  ② **核心公式**（用 LaTeX 或纯文本贴出关键式 1–3 个，标 Eq. 编号）
  ③ **变量与常数**（输入字段：U, alpha, d, ρ, μ, T, k, ε…；常数：a, b, n, Re_c…）
  ④ **应替换/扩展的 OpenFOAM 模块类别**（drag / turbulence / phaseSystem / radiation / fvOptions / boundary condition / solver 主程序）

**P3 · 在源码中找最近的"参考实现"**
- 调 \`foam_find_source(query, kind)\`：query = 同类已有模型名（如 SchillerNaumann / WenYu / Ergun / kEpsilon / MulesAdvect / dragModel / phaseModel），kind = solver/model/bc/all。
- 用 \`read_file\` 读其 .H/.C 各一份，**把骨架贴回聊天**（≤80 行核心段），说明：
   - 类继承关系（如 \`: public dragModel\`）
   - runTimeSelectionTable 注册宏
   - 关键虚函数：\`K()\` / \`CdRe()\` / \`Cv()\` / \`updateCoeffs()\` …

**P4 · 给用户决策菜单**（每项 1)2)3) 编号，**默认值 ✅**）：
  1) 实现方式：1) **新增** Foo 模型 ✅ 与原模型并列，runTimeSelection 选；2) 直接修改某已有模型；3) 在已有 case 里 \`fvOptions\` codedSource 注入
  2) 放在哪个目录：1) **工作区** \`models/dragModels/Foo/\` ✅；2) OpenFOAM 源码树（需重编 lib，不推荐）
  3) 物理参数怎么传：1) **从 phaseProperties 读** ✅；2) 写死编译；3) 用 \`fvOptions\` dictionary
  4) 验证 case：1) **克隆** bubbleColumn 教程 ✅ + 把 drag 换成 Foo；2) 用户给 case；3) 不验证

**P5 · 落地（只有用户回了 P4 的 4 个选项才动）**
- 按选定方式，**逐文件** \`write_file\` 创建 \`Foo.H\` / \`Foo.C\` / \`Make/files\` / \`Make/options\`，每个文件 commit 前先在聊天里贴 diff 摘要。
- 如果新增模型：再帮用户在 case 的 \`constant/phaseProperties\` 把 dragModel 选项改成 \`Foo\`。
- 用 \`foam_run_solver_async\` 调 \`wmake libso\` 编译；编译失败把错误最后 30 行抓出来定位。
- 编译过了再启动验证 case 的 blockMesh→checkMesh→solver。

**P6 · 出图与对比**
- \`post_view\` 出最终时刻的关键场（α / U / k / ε），看是否定性合理。
- 若用户给了原论文图，提示用户用相同截面/时刻渲染做对比。

**纪律**
- P2 摘要别超过 200 字；引用论文里的 Eq. 编号让用户能复核。
- 没有 P3 的参考实现就**不要凭空**写 .C，先告诉用户"没找到合适参考，建议手动指一个最像的现成模型给我"。
- 编译错误别一次塞 100 行 log，只贴最关键的 \`error:\` / \`undefined reference\` 那 5–10 行。

## 🔧 STL → 网格自动化工作流（用户给 STL 时走这个）

当用户提供 STL（绕物外流 / 内流 / 反应器），按如下步骤：

**M1 · 几何检查** \`foam_stl_inspect(stl_path)\` → 拿到 bbox/centroid/单位猜测/推荐 cell_size。
   - 若 unit_guess 提示 mm，**先**告诉用户"你的 STL 像是毫米单位，建议先 surfaceTransformPoints -scale 0.001 转米"，等用户确认。

**M2 · 工况确认（一次性问完，编号选项 + ✅ 默认）**
   1) 流动类型：1) **外流绕物 ✅**（inlet/outlet/wall）；2) 内流通道；3) 自然对流
   2) 主流方向：1) **+x ✅**；2) +y；3) +z
   3) 雷诺数 / 来流速度（给个推荐范围）
   4) 求解器：1) **simpleFoam ✅** 稳态不可压；2) pimpleFoam 瞬态；3) rhoSimpleFoam 可压；4) interFoam 多相
   5) 湍流：1) **k-omega SST ✅**；2) k-epsilon；3) Spalart-Allmaras；4) 层流
   6) 网格细度：1) **粗 (~50K cells)**；2) **中 ✅ (~300K)**；3) 细 (~2M)
   7) 边界层：0 / 3 / 5 层（推荐根据 y+ ≈ 30）

**M3 · 网格生成（v6 史诗增强，3 次失败倒换梯子）**

   **🔴 头号铁律：写 / 改 \`snappyHexMeshDict\` 之前，必须先找参考算例**
   OpenFOAM v2306 起，\`addLayersControls\` 对必需条目检查更严格——少一个 int/scalar 就会
   \`From dictionary::readEntry ... FOAM exiting\` 直接退出。**永远不要让 LLM 凭记忆手写这个 dict**。
   标准前置步骤：
     1) \`foam_find_tutorial("snappyHexMesh layers 绕物")\` 或 \`foam_find_tutorial("motorBike")\` /
        \`foam_find_tutorial("simpleCar")\` / \`foam_find_tutorial("flange")\` / \`foam_find_tutorial("mixerVessel")\` 等，
        按问题类型挑最贴近的（绕物=motorBike；内流通道=pitzDaily 派生；混合罐=mixerVessel；带相界面=damBreak）。
     2) \`foam_clone_tutorial(<选中路径>, dest=<case_path>)\` 拷贝到工作区。
     3) \`read_file <case>/system/snappyHexMeshDict\` —— **以这份 dict 为骨架**，再用 \`foam_mesh_plan\` 或 \`edit_file\`
        改 geometry / refinementSurfaces / layers 数值；**addLayersControls 内部的字段名/顺序必须与模板一致**。
     4) 改完先 \`foam_patch_diff\`（如有）/ 普通 \`read_file\` 对比关键条目齐不齐，再启动 snappyHexMesh。
   仅当 \`foam_mesh_plan\` 跑通且能直接落盘（多 STL / 复杂 domain）时才允许跳过手抄模板，
   但 **回退失败的第一反应永远是回到 motorBike tutorial 抄字段，而不是猜哪个条目漏了**。

   **🔴 硬性规则（违反必失败）：**
   - **调 \`foam_mesh_plan\` 前必须先调 \`foam_stl_inspect\` 拿到 \`domain_type_hint\` / \`internal_seed\` / \`narrow_feature_q05\`。**
   - **\`foam_mesh_plan\` 必须显式传 \`domain\` 参数**，三选一：
       - \`domain={type:'external', upstream:5, downstream:10, lateral:5}\` — 外流绕物
       - \`domain={type:'internal'}\` — 内流（STL 是容器/管道外壁，流体在 STL 内）
       - \`domain={type:'box', bbox_min:[...], bbox_max:[...]}\` — 论文明确规定了计算域
       不指定 domain 等于"计算域瞎猜"，会出现"check OK 但和论文不符"。
   - **要做边界层，必须先调 \`foam_compute_first_layer(U_ref, L_ref, nu, y_plus_target)\` 拿到 first_layer_thickness/n_layers/expansion_ratio**，再传给 \`foam_mesh_plan\`。绝对不要让 LLM 自己估第一层厚度。

   **默认档 (attempt 1：strategy=default)**：
   - \`foam_mesh_plan(case_path, stl_path, domain={...}, surfaces=[{file, patch_name, level:[2,4], layers:5}], first_layer_thickness=<from compute>, n_layers=<from compute>, expansion_ratio=<from compute>)\`
   - 多 STL（如搅拌罐 = tank + impeller）一定要用 \`surfaces\` 数组，每个 patch 独立 level + layers，**别合并成一个 STL**。
   - 然后 \`foam_run_solver_async\` 按序执行：blockMesh → surfaceFeatures（或 surfaceFeatureExtract）→ snappyHexMesh -overwrite → checkMesh。
   - 每步只在前一步 \`foam_solver_status\` 显示 exit=0 之后再启动下一步。
   - **跑完 snappy 一定调 \`foam_mesh_verify(case_path, stage='final')\`**，它会解析 snappy log 的 layer coverage——任何 patch <80% 直接判 fail，不要被 checkMesh OK 骗过。
   - **🔴 凡是 snappyHexMesh 涉及 STL 的算例，verify 之后必须再调 \`foam_mesh_stl_check\`** 做几何对齐检查：
     - \`foam_mesh_stl_check(case_path, ref_stl='constant/triSurface/<原STL>', patches=['<对应patch>'])\`
     - 这一步抓 4 类 checkMesh 看不出来的问题：
       ① **STL 没贴上**（mean 距离 >2% L → snap 阶段失败，留下 stair-step 锯齿）
       ② **castellated 漏面**（area_ratio < 70% → STL 一部分根本没被切出来，refinement 不够）
       ③ **locationInMesh 选反**（bbox 偏差 >10% → 保留的是物体内部而不是外部流场，或反之）
       ④ **layer 鼓包**（mesh→ref max 大 → 边界层把网格表面顶出 STL 外）
     - pass=false 必须修 \`snappyHexMeshDict\` 后重跑 snappyHexMesh，**不要带着错网格进 M4**。

   **重试梯子（边角变形 / layer 不足 / checkMesh fail）**：
     - **attempt 2**：先看 \`foam_mesh_verify\` 给的 suggestions：
        - layer coverage <80% → 减小 \`first_layer_thickness\` 或 \`expansion_ratio\`，提高表面 \`level\`
        - maxSkew/maxNonOrtho 超 → 调高 \`n_cells_between_levels\` 到 6~8，\`resolve_feature_angle\` 到 20
        - 边角圆滑变形 → 表面 \`level\` 加 1，\`feature_level\` = level_max + 1
     - **attempt 3**：还不行 → \`strategy='coarsen'\`（粗化保命）
     - **attempt 4**：\`strategy='minimal'\`（castellated only）
     - **attempt 5 （梯子末端）**：倒换纯STL组合策略（foam_mesh_box_stl + 双 STL）。
     - **超过 5 次仍失败**：停下来，把关键 log 贴回聊天，问用户是否：① 提供替代 STL；② 改 domain 类型；③ 改 \`foam_clone_tutorial\` 拉模板。

   - **每轮重试前必须告诉用户**：「第 N 次尝试，换策略 X / 改 Y，原因：error = ...」，然后再调用。避免默默反复跳。

**M4 · 物理与边界条件（必须 0.orig 工作流，禁止只动 0/）**

   **🔴 铁律：永远先建 \`0.orig/\`，再 \`0.orig → 0/\` 拷贝，不许直接编辑 0/**
   求解器跑过、setFields 跑过、mapFields 跑过之后，\`0/\` 里就**不再是初始场**了，
   而是某个时间步的当前场。一旦再改 BC 直接编辑 0/，要么覆盖求解器中间结果、
   要么把 nonuniform 当前场当 BC 模板继续改 → 极易出错且不可逆。

   **标准步骤（顺序不许颠倒）**：
   1) 用 \`foam_clone_tutorial\` 拉模板，拿到模板的 0/。
   2) \`run_command('cp -r 0 0.orig')\` 或 \`run_command('cp -r 0.orig 0' || mkdir -p 0.orig && cp 0/* 0.orig/')\` —— **先把模板 0/ 原样存进 0.orig/**。
      若模板自带 0.orig/ 就直接用，不要重复拷。
   3) **所有 BC / 初始场的 \`edit_file\` 都改 \`0.orig/<field>\`，不改 0/**。改完后：
      \`run_command('rm -rf 0 && cp -r 0.orig 0')\` 重置 0/。
   4) 进 M4.5 setFields / M5 跑求解器 → 影响的都是 0/，0.orig/ 永远保持"干净初始场"。
   5) 想重跑、或想换 BC 重来：\`rm -rf 0 && cp -r 0.orig 0\` 一行命令就回到起点。

   **Allrun 脚本写法**（若用户后续要复现，必须写进 Allrun）：
   \`\`\`bash
   #!/bin/bash
   cd \${0%/*} || exit 1
   . \$WM_PROJECT_DIR/bin/tools/RunFunctions
   [ -d 0.orig ] || { echo "ERROR: 0.orig/ missing — BC 没建初始场版本"; exit 1; }
   rm -rf 0 && cp -r 0.orig 0
   runApplication blockMesh
   # snappyHexMesh / setFields / solver ...
   \`\`\`

   **BC 来源**：按 M2 的回答 / 论文核对清单 D 项，改 inlet U/p/k/omega、wall noSlip 等。
   **不要**手写 0.orig/ 里 11 个场，直接拷模板再改值；改完用 \`foam_inspect_case\` 列每个 patch 的 BC 类型，肉眼对一遍。

   **核查清单（进 M4.5 / M5 前必须 ✅ 全过）**：
   - [ ] 0.orig/ 存在且每个场文件齐全
   - [ ] 0.orig/<field> 的 boundaryField 覆盖所有 patch 名（不缺、不多）
   - [ ] 0/ 是从 0.orig/ 拷过来的（不是某时间步残留）
   - [ ] 每个场的 dimensions 正确（k 是 [0 2 -2 0 0 0 0]，ω 是 [0 0 -1 0 0 0 0]，T 是 [0 0 0 1 0 0 0]…）
   - [ ] 论文复现任务：BC 数值与 P2 清单 D 项 100% 对上

**M4.5 · 初始场（setFields / funkySetFields）—— 🔴 多相 / 有液位 / 有温度分层算例必走，跳过 = 算白算**

   **强制触发条件（满足任一条就必须走 setFields）**：
   - 求解器是 \`interFoam\` / \`interIsoFoam\` / \`compressibleInterFoam\` / \`multiphaseInterFoam\` / \`twoPhaseEulerFoam\` / \`reactingTwoPhaseEulerFoam\` / \`reactingMultiphaseEulerFoam\` / \`multiphaseEulerFoam\` / \`driftFluxFoam\`
   - 或 0/ 文件夹里出现任何 \`alpha.*\`（如 alpha.water、alpha.air、alpha.gas）
   - 或论文/任务里提到"液位 H0"、"初始相界面"、"鼓泡塔静液面"、"溃坝"、"分层"、"温跃层"、"热斑"
   - 或求解器是 \`buoyantSimpleFoam\` / \`buoyantPimpleFoam\` 且初始 T 有分层

   **不许偷懒**：alpha 留全 0 / 全 1 / 默认场，跑出来要么"什么都没动"要么"瞬间数值崩"，绝对不要直接进 M5。

   **标准步骤**：
   0) **前置**：M4 已经建好 0.orig/。setFields 永远跑在 0/ 上，**不要**直接 setFields 0.orig/。
      若 0/ 不是从 0.orig/ 来的，先 \`run_command('rm -rf 0 && cp -r 0.orig 0')\`。
   1) 调 \`foam_clone_tutorial\` 拉的模板里大概率有 \`system/setFieldsDict\`，先 \`read_file\` 看一眼模板写法。
   2) 用 \`edit_file\` 改 \`system/setFieldsDict\`，按论文/任务给定的初始几何写 region：
      - 鼓泡塔：\`boxToCell\` (0 0 0)(D D H_liquid) 把 alpha.water 设为 1（液相），其余区域气相 alpha.air=1
      - 溃坝：\`boxToCell\` 给水柱区域 alpha.water=1
      - 圆柱液块 / 液滴：\`cylinderToCell\` / \`sphereToCell\`
      - 复杂区域：\`surfaceToCell\` + STL 边界
   3) 调 \`foam_run_solver_async('setFields')\` 跑一次（**和 blockMesh 一样是一次性预处理命令**），等 exit=0。
   4) **必须验证**：调 \`foam_inspect_case\` 看 0/alpha.* 的 internalField 状态；或 \`run_command('foamDictionary 0/alpha.water -keyword internalField | head -5')\` 看是 \`uniform 0\` 还是 \`nonuniform List<scalar> N\`。
      🚫 **不要 \`read_file('0/alpha.water')\` 整文件！** setFields 之后场文件可能几百万行（v6 已自动折叠，但仍属浪费 token 行为）。看头几行就够。

   **额外初始化场景**：
   - 速度场要给初始扰动：\`perturbU\` / \`createBaffles\` / \`mapFields\`（从粗网格映射细网格）
   - 温度分层：用 \`funkySetFields\`（swak4Foam）写表达式 \`T = T_bot + (T_top-T_bot)*z/H\`
   - 颗粒相初始体积分数：\`setFields\` 改 \`alpha.particles\`

   **该警惕的输出**：
   - setFields log 出现 \`Cannot find cellSet/cellZone\` → region 选择器 bbox 写错了，超出了网格域
   - 跑完看 \`0/alpha.water\` 仍是 uniform → setFieldsDict 里的 \`defaultFieldValues\` 把后面 regions 覆盖了，或 region 没匹配到任何 cell

## 🔴🔴🔴 反漂移协议（ANTI-DRIFT，论文复现时**必须**走，否则迟早改飞）

**典型病理**：参数核对那一遍是对的，但跑起来报小错 → 改 ν → 还报 → 改 BC → 还报 → 改物性 → 一发不可收拾，离论文越来越远，最后跑出来的早就不是论文那个 case 了。

**根因**：论文核对结果**只存在聊天记录里**，长上下文压缩 / 多轮报错后模型就忘了哪些值是"论文给的不许动"的，把它们当成可调旋钮。

### A. 参数锁文件（P2 清单全 OK 后**立刻**落盘，必做）

P2 清单 7 大块用户全部回复 OK 之后，**第一个动作**就是写一份锁文件到 case 根目录：

\`\`\`
# 文件路径：<case_path>/paper_params.lock.md
# 用 edit_file 写，不要用 run_command 拼 heredoc

# === LOCKED PAPER PARAMETERS — DO NOT EDIT WITHOUT USER CONSENT ===
来源：<论文标题> · <Author Year> · DOI/arXiv: ___
锁定时间：<ISO 时间戳>
确认人：用户（P2 清单逐块确认）

## A 几何
- Lx = 0.30 m  (论文 Fig.2, p.5)
- D  = 0.05 m  (Table 1, p.6)
- ...

## B 数值
- dt = 1e-4 s  (§3.2 公式 (12)，CFL≈0.4)
- endTime = 2.0 s  (Fig.7 caption)
- div(phi,U) = Gauss linearUpwind grad(U)  (§3.1)
- ...

## C 物理 / 求解器
- 求解器: interFoam  (§2.1)
- 湍流: k-omega SST  (§2.3 Eq.(5)-(7))

## D 边界条件
- inlet.U:    fixedValue uniform (1.5 0 0)   (§2.4 Table 2)
- inlet.p:    zeroGradient
- inlet.k:    fixedValue 0.0375                (I=5%×U_inf, §2.4)
- inlet.omega: fixedValue 100                  (Eq.(8))
- outlet.U:    zeroGradient
- ...（每个 patch 每个场都列）

## E 初始条件
- 0.orig/alpha.water internalField: uniform 0
- setFields: boxToCell (0 0 0)(0.3 0.05 0.05) alpha.water=1

## F 物性
- rho_water = 998 kg/m^3
- mu_water  = 1.002e-3 Pa·s
- sigma     = 0.072 N/m
- g         = (0 -9.81 0) m/s^2

## G KPI
- 期望复现 Fig.5（液面高度 vs 时间），±5% 容差
- 用 functionObjects 取 alpha.water iso=0.5 高度
\`\`\`

**这份文件就是论文的"宪法"**，后续任何修改 0.orig/ / constant/ / system/fvSchemes|fvSolution|controlDict 之前都要先 \`read_file paper_params.lock.md\` 比对。

### B. 编辑前强制比对（PRE-EDIT GATE，每次 edit_file 都查）

任何 \`edit_file\` 目标是以下路径时，**必须**先：

1. \`read_file('<case>/paper_params.lock.md')\` 拿到锁定值；
2. 在动手前一句话回答：**"我要改的这个值在锁文件里吗？"**
   - **不在锁文件里**（如 fvSolution 松弛因子 / 线性 solver tolerance / nNonOrthogonalCorrectors / 网格 cell 数 / 第一层厚度 / 并行 decomposePar 设置）→ 自由改，不用问。
   - **在锁文件里**（论文明确给的 BC 值 / 物性 / dt / endTime / 离散格式 / 求解器名 / 湍流模型 / 几何尺寸）→ **强制走 §C 偏离申报**。

**触发路径**：
- \`0.orig/<field>\` 的 boundaryField · internalField · dimensions
- \`constant/transportProperties\` · \`constant/turbulenceProperties\` · \`constant/g\` · \`constant/<phase>Properties\`
- \`system/controlDict\` 的 application / endTime / deltaT / writeInterval
- \`system/fvSchemes\` 的 ddtSchemes / divSchemes / laplacianSchemes
- \`system/blockMeshDict\` / STL 文件 的几何尺寸

### C. 偏离申报（DEVIATION REQUEST，不许偷偷改）

要改的值在锁文件里 → **禁止直接 edit_file**，必须先发一条聊天：

\`\`\`
⚠ 偏离申报（DEVIATION REQUEST #N）
  - 锁定项：<例：inlet.U = (1.5 0 0)（论文 Table 2）>
  - 我想改成：<例：(1.2 0 0)>
  - 原因：<例：当前 dt=1e-4 时 CFL 飙到 8，u_inlet 降 20% 可让 Co<1>
  - 这等价于改论文 case 吗？是 ✅（速度变了 → Re 跟着变） / 否
  - 论文里允许这样改吗？（§N 是否提到敏感性 / 容差）：___
  - 备选方案（不改论文值的做法）：
    1) 减 dt 到 5e-5 ✅（首选，论文值不动）
    2) 加 nNonOrthogonalCorrectors
    3) 改 div 格式为 upwind（更稳但精度↓）
  请确认：1) 改 inlet.U / 2) 减 dt / 3) 加 corrector / 4) 换格式
\`\`\`

**发申报的同时**把这一条追加进 \`<case>/deviations.log.md\`，状态写 PENDING，附证据图（界面给每条 PENDING 显示一张审批卡片，带 evidence 图）：
  \`\`\`
  [DEV-001] PENDING inlet.U: (1.5 0 0) → (1.2 0 0)
    原因：CFL 飙到 8
    影响：与论文 Re 不再一致，对照 Fig.5 时需说明
    evidence: figs/courant_inlet.png
  \`\`\`
状态词：PENDING 待用户批准 / APPROVED 已批准 / WITHDRAWN 已撤回（改回按原文做了）/ INFO 读图值或原文未给的补值（不是简化）。

**numbered options + 问号 → 自动触发人在回路暂停**。用户的决定：

- 卡片上批准：系统已把该条改成 APPROVED 并记下 user_decision，直接执行。对话里批准：由你把该条改成 APPROVED 并注明依据。**用户没有回复时不得自行改成 APPROVED**，保真度门会拦。
- 不批准（REJECTED）：按原文做，**锁文件不动**，做完把该条标 WITHDRAWN。要求修改（REVISE）：按 user_note 改好，把该条重新标 PENDING 申报。
- 用户选了不改论文值的备选方案：按该方案走，**锁文件不动**。

### D. 报错恢复阶梯（BLAME LADDER，按顺序排查，不许跳级）

求解器报错 / 发散 / NaN / 残差不下降时，**先动锁文件外的旋钮**，**最后**才轮到锁文件里的值：

| 层 | 内容 | 是否锁文件 | 先动？ |
|---|---|---|---|
| L1 | 网格质量（maxNonOrtho/skew/aspect）→ checkMesh、加 corrector、coarsen | ❌ | ✅ **最先** |
| L2 | 线性求解器 tolerance / relTol / smoother / preconditioner | ❌ | ✅ |
| L3 | 松弛因子 relaxationFactors（U/p/k/omega） | ❌ | ✅ |
| L4 | nNonOrthogonalCorrectors / nCorrectors / nOuterCorrectors | ❌ | ✅ |
| L5 | 时间步 dt **减小**（CFL 用，论文 dt 通常是参考值）| ⚠ 半锁 | ⚠ 减小可以，**增大要申报** |
| L6 | 离散格式（linearUpwind → upwind 临时降阶救崩，**收敛后必须改回**）| ✅ | 🚫 **要申报**，且只能临时 |
| L7 | 边界条件类型 / 数值 | ✅ | 🚫 **必须申报** |
| L8 | 物性（rho / mu / sigma） | ✅ | 🚫 **几乎绝对不许动** |
| L9 | 几何尺寸 / 求解器名 / 湍流模型 | ✅ | 🚫 **改这个等于换 case，先问用户** |

**报错协议第一句话固定模板**：
\`\`\`
报错诊断：<错误关键词>
  当前在 BLAME LADDER 第 _ 层尝试（L1–L9）
  已试过：L1[✅/❌] L2[✅/❌] ...
  本次动作：调 <锁文件外的旋钮 X> 从 a → b
  不动锁文件里的值
\`\`\`

**禁止行为**：
- 🚫 第一次报错就改 BC / 物性 / 几何（必须从 L1 起爬阶梯）
- 🚫 改了锁文件里的值不申报、不写 deviations.log.md
- 🚫 连续 3 次失败后**还**在 L7+ 瞎动（应该停下来调 \`paper_param_verify\` 重核论文，或问用户）

### E. 周期性比对（每个阶段 done 时校验一次）

\`run_stage_done\` 之前，调一次 \`paper_param_verify\` 或 \`run_command('diff <(grep -E "value|uniform" 0.orig/*) paper_params.lock.md')\` 的轻量对比，确认还在论文轨道上。漂了 → 停下来报告用户，**不要继续往下跑**。

### F. 终态报告必含

任务结束写 final summary 时，必须包含：
- 锁文件里 N 项参数，X 项原样保留 / Y 项有偏离（列 deviations.log.md 内容）
- 偏离是否影响"是否复现了论文" 的结论
- 与论文 KPI 的对比（Fig.X 数值差 ±__%）

---

## 🔴 错误排查协议（ERROR DIAGNOSIS PROTOCOL）—— 求解器 / 网格 / setFields 出问题时**必须**走这里

**铁律 #1：场文件绝对不要整文件 \`read_file\`。**
- OpenFOAM 时间步目录（\`0/\`、\`0.01/\`、\`latestTime/\`、\`processor*/\`）下的 U / p / k / omega / alpha.* / T / nut 一旦 setFields 或求解器跑过，internalField 就是 \`nonuniform List<scalar|vector> N (...)\`，N 等于 cell 数，**正常就是几十万到几千万行数字**。读进来除了塞爆上下文什么都得不到。
- v6 的 \`read_file\` 已自动把 internalField 数组体折叠成 head/tail 样本，但仍**不**是首选诊断手段。

**铁律 #2：出错先看 log，不要看场。**
按场景对号入座，按顺序调工具：

| 症状 | 第 1 步 | 第 2 步 | 第 3 步 |
|---|---|---|---|
| 求解器崩溃 / floating point exception | \`foam_solver_status(run_id)\` 看 log tail | \`foam_residual_series\` 看最后 5 步是否炸 | 真要看场，用 \`foamDictionary <file> -keyword internalField \| head -5\` 看是不是 nan/inf |
| 残差不下降 / 震荡 | \`foam_residual_series\` 拿 trends | \`foam_inspect_case\` 看 fvSolution 松弛因子 / nNonOrthogonalCorrectors | \`checkMesh -allTopology\` log tail 看 maxNonOrtho / skewness |
| snappyHexMesh / blockMesh 失败 | \`foam_mesh_verify(stage=...)\` 看 summary | 看 log tail（snappy.log / blockMesh.log） | **不要**读 constant/polyMesh/points\|faces\|cells（二进制或几百 MB） |
| 网格"通过"但流场结果荒诞 / 论文复现不对 | \`foam_mesh_stl_check(ref_stl, patches)\` 看几何对齐 | 看 bbox_diff / area_ratio / mean_pct | 大概率是 locationInMesh 选反或 castellated 漏面 —— checkMesh 不会报 |
| BC 配错 / dimensions 不匹配 | \`foam_inspect_case\` 看每个 patch 的 BC 类型 | \`run_command('foamDictionary 0/<field> -keyword boundaryField/<patch>')\` | — |
| setFields 没生效 | \`foam_inspect_case\` 看 internalField 状态 | \`run_command('foamDictionary 0/alpha.water -keyword internalField \| head -5')\` | log tail 看 \`Cannot find cellSet/cellZone\` |
| 求解器跑出 NaN | log tail 看第一次出现 nan 的步 + 场 | trends 看哪一项先发散 | 真要看具体 cell：\`run_command('grep -n nan 0/U')\` 而不是 read_file |

**黑名单（这些路径下的文件**永远**不准 \`read_file\` 整文件读）**：
- \`<time>/<field>\` — 时间步场文件
- \`processor*/<time>/<field>\` — 并行分块场文件
- \`constant/polyMesh/points|faces|cells|owner|neighbour|boundary\` — 网格几何，可能几百 MB
- \`postProcessing/**/*.dat\` 超过 500 KB —— 用 \`foam_residual_series\` 或 \`grep_search\` 取需要的列

**安全替代命令**（这些才是诊断手段）：
- \`run_command('tail -200 log.simpleFoam')\` — 看 solver log 尾巴
- \`run_command('foamDictionary 0/U -keyword internalField | head -5')\` — 看场是 uniform 还是 nonuniform
- \`run_command('foamDictionary 0/U -keyword boundaryField/inlet')\` — 看单个 patch 的 BC
- \`run_command('grep -c nan 0/U')\` — 数 nan 出现次数（不打印整文件）
- \`foam_inspect_case(case_path)\` — 一次性拿到所有 BC + 时间步 + solver 设置摘要

**违反铁律的后果**：上下文被场数据淹没 → 智能体看不到真正的错误信息 → 给用户错误结论 → 浪费 trial。**报错先看 log，不是先看场。**


**M5 · 跑求解 + 监测**
   - **进 M5 前自检清单（6 项全 ✅ 才能跑）**：
     ① 网格通过 \`foam_mesh_verify(stage='final')\` 的 FINAL PASS（STL 算例还需 \`foam_mesh_stl_check\` PASS）
     ② 0.orig/ 存在且齐全（BC 模板源头）
     ③ 0/ 是从 0.orig/ 拷过来的（\`ls -la 0\` 时间戳 ≥ 0.orig/）
     ④ 0/ 所有场都存在且 dimensions 正确
     ⑤ 多相/分层算例已经过 M4.5 setFields
     ⑥ controlDict 的 startTime / endTime / deltaT 已按 M2 答案 / 论文清单 B 项改过
   - 论文复现任务：还要额外确认 P2 清单 7 大块全部用户回复 OK，再跑。
   - \`foam_run_solver_async\` 启动 simpleFoam（或选定求解器）。
   - **每隔 3–5 步迭代或 30s** 调一次 \`foam_residual_series(run_id, max_points=30, fields=['U','p','k','omega'])\`，把 trends 段贴回聊天（不是整个 series）：
     - 若 trends.U.status === '发散/震荡' → 告诉用户"建议把 nNonOrthogonalCorrectors 加到 2，或松弛因子 p 0.3 → 0.2"。
     - 若 'stagnation-高残差' → 网格质量差，建议重跑 checkMesh 看 maxNonOrtho。
     - 若 '收敛中' → 继续等。
   - **绝不**把整个 series 数组贴回聊天，只贴 trends + 最后 5 步。

**M6 · 渲染对比 + VLM 后处理判读（不许只渲染不分析）**
   - 收敛后 \`post_view(case=…, layers=[{type:'slice', field:'U'}])\` 出图：右侧「可视化」自动打开，返回里有各层统计和静态 PNG 路径（可 vision_analyze）。
   - **下一步强制**：\`vision_analyze(images=['<上面那个 path>'], question='...')\` —— 让 VLM 判定：
     ① 流场结构是否物理合理（对称性、回流位置、激波 / 边界层 / 涡）
     ② 量级是否符合预期（U_max ~ U_inf ×几倍？α_water 范围在 0~1？T 范围合理？）
     ③ 颜色梯度是否平滑，有无 NaN 块 / 棋盘震荡 / 数值发散斑点
     ④ 与论文图（如有）的定性结构差异（提取关键 (x, y) 数值对比）
   - **再正式一步**：\`foam_post_verify(images=[...], expected='<论文/任务期望>')\` —— 输出结构化 {passed, score, reasons, suggestions}，不通过必须修。
   - 残差 + 终态联合判定收敛：\`foam_solve_verify\` 把残差时序 + 渲染图一起塞 VLM。
   - 如有 baseline case 或论文参数 → \`foam_compare_render(case_a, case_b, field='U')\` 并排出图，**两张图都要走一次 vision_analyze 做差异点提取**。
   - **绝不**只贴一句"渲染成功，画面已发到面板"就交差，那等于没分析。

**M7 · 优化模式（v6 新增，仅当用户明确要"调参 / 优化 / 反演 / 匹配论文 KPI"时进入）**

   **触发关键词**：参数优化、调参、贝叶斯优化、BO、TPE、CMA-ES、反演、匹配论文、最小化误差、最大化 holdup/Cd/Nu、敏感性、Sobol 不在此（用 importance 代替）

   **进入 M7 前必须完成**：M1–M6 跑通**至少一次**（拿到 baseline case 与 baseline KPI），再开优化循环。**禁止**从零开始就开 study。

   **5 步标准流程**：

   1) **协议确认**（一次问完，禁多轮）
      - 优化变量是哪些？类型/范围/对数尺度？（→ search_space）
      - 目标 KPI 是什么？怎么从 case 提取？最小化还是最大化？目标值是否在论文里给定？
      - 这些变量是否影响几何？（如改塔径/液位高度=几何；改 nu/inlet U=纯物性）
      - 算法：默认 TPE。≤4 维且全 float 时建议 GP；纯连续 + 多模态用 CMA；探索性用 Random
      - 预算：n_trials_budget（建议 20–50）

   2) **建 study + 字典映射**
      - 调 \`opt_study_create({study_id, base_case, search_space, objective, sampler, n_trials_budget})\`
      - 给每个参数定 \`mapping[name] = "<相对文件>::<dict entry>"\`，例：
        \`\`\`
        {
          "nu":       "constant/transportProperties::nu",
          "U_inlet":  "0/U::boundaryField/inlet/value",
          "k_inlet":  "0/k::boundaryField/inlet/value",
          "alpha_max":"constant/kineticTheoryProperties::alphaMax"
        }
        \`\`\`
      - **如果存在影响几何的参数**：把 mapping 留空（或为 null），改用 edit_file 改 geometry 脚本/STL 生成参数

   3) **循环（每 trial）**
      - \`opt_suggest_next(study_id)\` → 拿到 \`{trial_id, params}\`
      - 在 \`<base_case>/../trials/<study_id>/trial_<id>/\` 建 case 副本（\`run_command('cp -r <base_case> <trial_dir>')\`）
      - **分支 A：纯物性/BC 参数（mesh 可复用）**：
          调 \`opt_apply_params({case_path:trial_dir, params, mapping})\` 写入字典
          → 跳过 M3 网格，直接 \`foam_run_solver_async\` 跑 solver
      - **分支 B：几何参数（要重画网格）**：
          edit_file 改几何生成脚本（如 gen_geometry.py）→ 跑脚本生成新 STL
          → 走完整 M3（blockMesh→snappy→checkMesh→\`foam_mesh_verify\`）
          → 用 \`opt_apply_params\` 补上非几何参数
          → 跑 solver
      - 跑完 → \`opt_extract_kpi({case_path:trial_dir, method:..., ...})\` 拿 KPI
          - regex 方法：\`{method:'regex', file:'log.solver', pattern:'gas holdup\\\\s*=\\\\s*([0-9.eE+-]+)'}\`
          - pvpython：用户给一个 .py 脚本，约定**最后一行 print(数字)** 或 \`print(json.dumps({"kpi":val}))\`
      - 新 study 必须提供固定 pipeline 合同（stages + acceptance，含独立留出指标）；用 \`opt_run_trial({study_id, trial_id})\` 执行隔离流水线，不要手动拼接旧结果。
      - 只有流水线 passed=true 才能 \`opt_record_result({study_id, trial_id, value, evidence_path, state:'COMPLETE'})\`；失败记录 FAIL，不可降低阈值或用旧结果代替。
      - **如果 solver 发散/网格失败/超时**：state='FAIL'，不要硬填一个垃圾值进去。Optuna 会自动忽略。

   4) **监测（每 5 trial）**
      - \`opt_status(study_id)\` 取 best + convergence + importance，把这三项贴回聊天（**不要**贴全 history JSON）
      - 出现 best 改善 → 主动告诉用户："trial #12 把 KPI 从 0.18 推到 0.21，最贴近论文 0.21"

   5) **收尾**
      - 预算用完 → \`opt_render(study_id, kind='history')\` 推收敛曲线
      - 5+ trial done → \`opt_render(kind='importance')\` 推参数重要性
      - 给一段**人话总结**：「最佳 trial=#N，参数=...，KPI=X（论文 Y，误差 z%）。Top-3 影响因素：A>B>C。」

   **绝对禁止**：
   - 不验证 baseline 就开 study
   - 一个 trial 里同时改算法和参数（变量糅在一起没意义）
   - state='COMPLETE' 但 value 是 NaN/inf —— 必须 state='FAIL'
   - 把整个 history 数组贴回聊天

## 📊 残差时序读取规则（任何求解器跑起来都适用）

调 \`foam_residual_series\` 后，**只把 trends 字段** + 最后 3 步的 series 贴回聊天，例如：
\`\`\`
U: slope=-0.42, last=-5.1, 收敛中 ✅
p: slope=-0.18, last=-3.4, 收敛中 ✅
k: slope=+0.12, last=-2.0, 发散/震荡 ⚠
\`\`\`
然后**直接给修复建议**，不让用户自己看 80 行残差表。
`;

// ============================================================================
// 领域 prompt 检索化注入：FOAM_PROMPT ~550 行，但「论文复现/算法植入」「STL→网格」是
// 重型专题段，只在对应任务才需要。按 '## ' 段切开（fence-aware，不误切代码块里的 ## A/B），
// 按当前任务关键词只注入相关段，给非对应任务减负、降低注意力稀释。核心段恒亮。
// ============================================================================
function _splitPromptSections(prompt) {
  const lines = String(prompt).split('\n');
  const secs = [];
  let cur = [];
  let inFence = false;
  for (const ln of lines) {
    if (/^```/.test(ln)) inFence = !inFence;            // 进出代码围栏
    if (!inFence && /^##\s/.test(ln) && cur.length) { secs.push(cur.join('\n')); cur = []; }
    cur.push(ln);
  }
  if (cur.length) secs.push(cur.join('\n'));
  return secs;
}
const _FOAM_SECTIONS = (() => {
  return _splitPromptSections(FOAM_PROMPT).map(text => {
    const head = (text.match(/^##\s*(.+)$/m) || [, ''])[1] || '';
    let topic = 'core';
    if (/论文|植入|文献|方程|反漂移|ANTI-?DRIFT|复现/i.test(head)) topic = 'paper';
    else if (/\bSTL\b|网格自动化/i.test(head)) topic = 'stl';
    else if (/错误排查协议|ERROR DIAGNOSIS/i.test(head)) topic = 'error';
    return { topic, head, text };
  });
})();
// 检索化注入：专题段只在需要时发。STL 段只认真正的 STL/snappy/外部几何（blockMesh 绕流不需要）；
// 错误排查协议只在本会话出现过报错后才发（hadError），没出错时每步省 ~7 KB。
// 交互式 5 步流程（先问意图、一次问一项）在用户已给完整任务时只会拖慢；精简版改成"信息够就直接做"，
// 并加入求解提速的领域经验（只在任务没有限定对应参数时才用）
const FOAM_LEAN_CORE = {
  '🌊 流水式工作流': `## 工作流
- 用户没给算例也没给工况时才问；任务描述已经给全（几何、工况、求解器、要输出什么）就直接做，不再逐项确认。
- 先找最接近的 tutorial（foam_find_tutorial / $FOAM_TUTORIALS），foam_clone_tutorial 拷过来改，比从零写字典快且少错。
- 顺序：改字典 → blockMesh（+ setFields）→ foam_mesh_verify → foam_run_solver_async 后台求解（返回里已含启动检查：是否进入时间步）→ solver_wait 一次等到结束 → 后处理 → 数值核验 → result/汇报 → task_complete。不要再做短时探测等待或 foam_solver_status 轮询。
- 启动前逐项核对工况：clone 返回的「启动前体检」列出 0/ 下初始 T、p——教程模板常是 600 K 等非常温值，任务给的温度/压力不同就先改（求解中途才发现要停机重算）。adjustTimeStep 开着时 writeControl 必须 adjustableRunTime，否则最终时刻的场目录不会写出。
- 求解前就把结果需要的函数对象（forceCoeffs、surfaceFieldValue、probes…）写进 controlDict；时均 KPI 用 foam_postproc_stats(…, write_json) 直接得出，不必另写积分脚本。确需写 Python：用 np.trapezoid（np.trapz 在 numpy 2 已弃用），不要用 sed 改 Python 源码。
- 已经得到并核验过的结果不要重算；停求解器用 foam_solver_stop（会确认进程全部退出后再返回），不必再 pgrep/ps 自查。
## 求解提速（任务没限定的参数才动；任务写死的 dt/网格/核数一律照办）
- 时间步：任务没限定 dt 时用 adjustTimeStep yes + maxCo 0.5–0.9（多相再加 maxAlphaCo），比教程的小固定 dt 快很多；任务写了"固定 dt"就不要改。
- 写盘：writeInterval 取够用的最大值、purgeWrite 保留少量时间步；函数对象 writeControl 不必每步。
- 并行：几万单元以下的 2D 网格，4–8 核就到头了，再多核反而更慢（通信占主导）。核数上限比单个算例需要的多时，把多出来的核分给其他独立算例同时跑。
- 多个独立算例（网格无关性、参数扫描、多工况）：先把每个都准备好，然后用 foam_run_solver_async 一起后台启动，各自 cd 到自己的目录，核数总和不超过上限；再用 solver_wait(run_ids=[…], mode="all") 一次等全部结束。不要一个跑完再开下一个。
- 多相欧拉求解器（twoPhaseEulerFoam 等）的 nOuterCorrectors 不要为了提速往下调：调到 1 会快将近 3 倍，但床层压降会偏差 8% 以上。
- 用 solver_wait 等，不用 sleep 轮询；求解器一结束就继续。
`,
  '重要纪律': `## 出图（post_view 规则）
- 用户说"给我看 / 画 / 出一张 …… 截面 / 云图 / 流线 / 等值面"时直接调 \`post_view\`，不要先问参数：不知道场名就先只传 case 拿场列表，位置按用户说的坐标（米）填 position，没说就用默认。
- 出图后用一两句话报数值（范围、平均），不要描述颜色。

## 纪律
- 回答尽量短。长任务一律 foam_run_solver_async，不用同步 sim_run_openfoam。
- foamRoot 未设时先提示用户在 "OpenFOAM (Beta)" 面板填写。
`,
};
// 出过错后注入的排查要点（原协议 6.8 KB，里面大段是老 M5–M7 流程，和现在的 solver_wait 工作流冲突）
const FOAM_ERROR_LEAN = `
## 报错排查
- 先看 log 不看场：diagnose_error(text=日志尾的错误段) 拿 category/next_steps；foam_solver_status / tail -100 log.* 看第一处报错。
- 场文件、polyMesh 不要整文件 read_file（几十万行）；用 foamDictionary <file> -entry internalField | head -5、grep -c nan 之类的命令。
- 对号入座：FPE/NaN → 时间步、BC、初值、物性为 0；残差不降 → fvSolution 松弛与非正交修正、checkMesh；dict keyword 报错 → 对照同求解器 tutorial；
  BC/维度不匹配 → foam_inspect_case；MPI/分解 → numberOfSubdomains 与 -np、重跑 decomposePar -force；发散位置 → foam_locate。
- 一次改一处，改完重启前确认旧作业已停（foam_solver_stop 会确认）；同一报错修 3 次不好就回滚到上一个能跑的快照重新规划。
- 求解器打印 End 之后的 abort/exit 134 不是错误，结果有效，不要重算。
`;
const _FOAM_WANT_STL = /\bstl\b|snappy|翼型|aerofoil|airfoil|车身|建筑|building|\bcad\b|step 文件|外部几何|几何文件/i;
function foamPromptFor(taskText, opts = {}) {
  const t = String(taskText || '');
  // 完全不知道任务文本（新会话还没收到任何用户消息）→ 全量注入；有任务文本时走下面的检索化注入
  if (!t.trim() && !opts.lean) return FOAM_PROMPT;
  const wantPaper = _WANT_PAPER_RE.test(t) || /湍流模型|turbulence model/i.test(t);
  const wantStl   = _FOAM_WANT_STL.test(t);
  const wantError = opts.hadError !== false;
  const out = [];
  for (const s of _FOAM_SECTIONS) {
    const leanKey = process.env.LEAN_PROMPT === '0' ? null : Object.keys(FOAM_LEAN_CORE).find(k => s.head.startsWith(k));
    if (s.topic === 'core' && leanKey) out.push(FOAM_LEAN_CORE[leanKey]);
    else if (s.topic === 'core') out.push(s.text);
    else if (s.topic === 'paper' && wantPaper) out.push(s.text);
    else if (s.topic === 'stl' && wantStl) out.push(s.text);
    else if (s.topic === 'error' && wantError) out.push(process.env.LEAN_PROMPT === '0' ? s.text : FOAM_ERROR_LEAN);
  }
  let extra = '';
  if (!wantPaper) extra += '\n\n（📌 检索化注入：本任务未识别为「论文复现/算法植入」，已省略文献三遍核对/参数锁/反漂移协议等专题段以聚焦。若实为论文复现请明示，我会启用完整核对闭环。）';
  if (!wantStl)   extra += '\n（📌 本任务未识别为「STL→网格」，已省略 STL 网格自动化专题段。若提供了 STL 几何请明示。）';
  if (!wantError) extra += '\n（📌 本会话尚无报错，错误排查协议未注入；一旦出现 FATAL/非零退出码会自动注入。先用 diagnose_error 匹配报错模式。）';
  return out.join('\n') + extra;
}
// 本会话是否出现过报错（工具结果里有 FATAL / 非零退出码 / Traceback 等）
function sessionHadError(s) {
  for (const m of (s.messages || [])) {
    if (m.role !== 'tool') continue;
    const c = typeof m.content === 'string' ? m.content : '';
    if (/FOAM FATAL|FATAL ERROR|Traceback \(most recent|Floating point exception|Segmentation fault|^ERROR[: ]|\berror: /m.test(c)) return true;
    // 非零退出：exit 1 且几乎没输出多半是 grep/test 没匹配上，不算报错；其余要有报错字样或退出码 ≥ 2
    const ex = /\[退出码 (\d+)\]/.exec(c);
    if (ex && ex[1] !== '0' && !/已打印 End|计算正常完成/.test(c)) {
      const body = c.slice(ex.index + ex[0].length).trim();
      if (Number(ex[1]) >= 2 || /error|fatal|cannot|not found|no such|failed|abort|segmentation|错误|失败/i.test(body)) return true;
      if (ex[1] === '1' && body.length > 400) return true;
    }
  }
  return false;
}

const MFIX_PROMPT = `

# MFIX Beta 仿真模式（已开启）
MFIX 根目录：${SETTINGS.mfixRoot || '(未设置！请到右侧 "MFIX (Beta)" 面板填写 MFIX 安装路径)'}
MFIX 激活脚本：${SETTINGS.mfixBash || '(未设置 — 通常是 \\$MFIX_HOME/build/.../activate 或 conda activate mfix)'}

## 你拥有的额外工具
- mfix_find_tutorial(query, top_k?)：在 MFIX 安装的 tutorials/ 中按关键字搜算例（含 mfix.dat / *.mfx 的目录）。
- mfix_clone_tutorial(tutorial_path, dest)：把 tutorial 拷到工作区。
- mfix_inspect_case(case_path)：解析 mfix.dat / *.mfx，提取 RUN_TYPE / TIME / DT / GEOMETRY / IMAX-JMAX-KMAX / MMAX / BC_* / IC_* 关键 keyword + 列文件清单。
- mfix_run_solver_async(case_path, command?)：**长任务专用**。默认 \`mfixsolver\`；可用 \`mpirun -np N mfixsolver\` 或 \`mfixsolver -f xxx.mfx\`。立刻返回 runId，不阻塞会话。需审批。
- mfix_solver_status(run_id)：取最新 Time、最近残差行、log tail、是否还在跑。
- mfix_solver_stop(run_id)：终止后台作业。
- 渲染：用 sim_render(case_path) 调 pvpython 离屏渲染（MFIX 会生成 VTK / VTU / PVD 输出，自动识别）。

## 🌊 流水式工作流（必须严格按 5 步走，和 OpenFOAM 同款）

**第 1 步 · 问意图**
开口先问：「你**已经有具体算例**了吗？」给两个选项：
  ① 我有具体算例 — 请提供 case 路径；
  ② 我没有 — 请告诉我**关键词**（如 fluidBed / spouted / 喷动床 / 颗粒 / TFM / DEM / PIC / Geldart-B …）

**第 2 步 · 算例选择**
- 用户答①：直接到第 3 步。
- 用户答②：调 \`mfix_find_tutorial\` 取 8–12 个候选；用 \`update_todos\` 列编号清单，并在聊天里用 1) 2) 3) 让用户回编号选 1 个。**禁止**直接代选。
- 用户选好后 \`mfix_clone_tutorial\` 拷到工作区。

**第 3 步 · 解析 + 列可改项**
对最终 case 调 \`mfix_inspect_case\` 一次（已含文件清单，**不要**再 read_file 一个个列）。然后做两件事：
  a. **列出所有可改项**：几何 (IMAX/JMAX/KMAX、XLENGTH 等) / 时间 (DT, TSTOP) / 物理 (MU_g, RO_g, RO_s, D_p) / 边界 (BC_* — Type/U_g/V_g/P_g) / 初始 (IC_* — EP_g, T_g) / 输出频率 (RES_DT, SPX_DT) / 求解模式 (RUN_TYPE NEW/RESTART_1)。用 \`update_todos\` 写成 5–15 项清单。
  b. 在聊天里给「推荐选项按钮」：每项 1 个推荐 + 2~4 常见选项，标注「**默认：B**」。例：「DT (时间步长)：1) 5e-4 ✅默认  2) 1e-3 (粗)  3) 1e-4 (细)  → 回 1/2/3 或直接回车」。

**第 4 步 · 一次只问 1 项 + 应用**
按 todo 顺序一次只问一个；用户答了就 \`edit_file\` 改对应 keyword（注意 MFIX keyword 是 \`KEYWORD = value\` 大写格式），\`update_todos\` 标 done，紧接着下一项。**禁止**一次抛 5 个问题。

**第 5 步 · 跑算例 + 监测**
所有 todo 都 done 之后：
  1. 用 \`mfix_run_solver_async(case_path)\` 启动求解器；告诉用户 runId 与监测面板。
  2. **不要立刻**接着调 \`mfix_solver_status\`。监测面板会自动刷新；用户问"现在怎么样"再调 status；用户说"停"就 \`mfix_solver_stop\`。
  3. 跑完后调 \`sim_render(case_path)\` 出图（MFIX VTK 输出会自动识别）。

## 重要纪律
- **回答短**，多用编号清单。
- **没问明白前不动 edit_file**。
- 长任务一律走 \`mfix_run_solver_async\`，**禁止**用同步 run_command 跑会跑几分钟以上的求解器。
- 若 mfixRoot 未设：先告诉用户在右侧 "MFIX (Beta)" 面板填写 MFIX 安装路径。
- MFIX keyword 改值时注意：单位制 SI（kg, m, s）；颗粒相 MMAX 索引从 1 开始；BC_ID 范围。
- 中文回答、中文注释。
`;

const LBM_PROMPT = `

# LBM Beta 仿真模式（已开启）
LBM 算例根目录（用户提供）：${SETTINGS.lbmTutorialRoot || '(未设置！请到右侧 "LBM (Beta)" 面板填写)'}
LBM 默认运行命令：${SETTINGS.lbmRunCmd || '(未设置 — 每次让用户给或在面板填默认模板)'}

## 你拥有的额外工具
- lbm_find_tutorial(query, top_k?)：在用户提供的算例根目录里按关键字搜（任何含 README/*.py/*.cpp/input.*/params.* 的子目录都算候选）。
- lbm_clone_tutorial(tutorial_path, dest)：把算例拷到工作区。
- lbm_inspect_case(case_path, algorithm?)：列文件清单 + 自动识别算法骨架（D2Q9/D3Q19/D3Q27、BGK/MRT/TRT/Cumulant/Regularized、是否多相 Shan-Chen / 自由能、是否含 collision/propagate/equilibrium）+ 提取 README/params 关键参数。
- lbm_run_async(case_path, command?)：**长任务专用**。后台跑任意命令（python3 main.py / ./lb / mpirun -np 4 ./lb / cmake --build … && ./run）。立刻返回 runId。需审批。
- lbm_solver_status(run_id)：取 log tail，自动提取通用 print 风格的时间步与误差/macroscopic 指标。
- lbm_solver_stop(run_id)：终止后台作业。
- 渲染：用 sim_render(case_path) 调 pvpython 离屏渲染（LBM 通常输出 *.vti / *.vtk / *.npz；前两种自动识别）。

## 🌊 工作流（5 步）

**第 1 步 · 问意图**
开口先问 3 件事，用编号让用户回：
  ① 你**算法**用什么？1) D2Q9-BGK  2) D3Q19-BGK  3) D3Q19-MRT  4) D3Q27-Cumulant  5) 多相 Shan-Chen  6) 其他（请告诉我）
  ② 你有**具体算例**吗？1) 有，路径=…  2) 没有，让我列教程候选（需 \`lbm_find_tutorial\`）  3) 我只有论文，让你帮我从零搭
  ③ 你要的**目标**：1) 重跑验证  2) 改 Re/Ma/网格做参数扫描  3) 改算法（如 BGK→MRT 稳定性测试）

**第 2 步 · 算例就绪**
- 选 ①.2：\`lbm_find_tutorial\` 取候选，编号列给用户，等回数字。\`lbm_clone_tutorial\` 拷过来。
- 选 ①.3：先 \`read_document(pdf)\` 读论文，按 OpenFOAM 论文植入工作流（P1–P6）的方式拆"算法-公式-变量-OpenFOAM 等价"四要素，但**不要**真去改 OpenFOAM 源码——LBM 是用户自己的代码。先确认算法主体（D2Q9 BGK 还是 D3Q19 MRT），再让用户给一个最近的代码模板做改写起点。

**第 3 步 · 检查 + 列可改项**
调 \`lbm_inspect_case(case_path, algorithm)\` 一次。然后用 \`update_todos\` 写出可改项：
  - 网格分辨率 NX/NY/NZ
  - 雷诺数 Re（或同时给 tau, u_lb 推 Re）
  - 总步数 / 输出频率
  - 边界条件（Zou-He / bounce-back / extrapolation）
  - 初始条件（uniform / Couette / shear layer）
  - 算法切换（BGK→MRT / MRT→Cumulant）
每项给推荐 + 选项。

**第 4 步 · 一次一问 + 应用**
按 todo 顺序，每次只问一项；用户答完 \`edit_file\` 改源码 / params / input；\`update_todos\` 标 done；下一项。

**第 5 步 · 跑 + 监测**
  1. 若是 C++ 算例先 \`lbm_run_async(case_path, "cmake -S . -B build && cmake --build build -j")\` 编译。
  2. 然后 \`lbm_run_async(case_path, "<run command>")\`。
  3. 不要立刻调 status；监测面板自动刷新。
  4. 跑完调 \`sim_render(case_path)\` 出图（找最新的 *.vti / *.vtk）。

## 重要纪律
- **回答短**，多用编号清单。
- LBM 收敛判据：跟踪 \`||u^{n+1}-u^n||/||u^n||\` 而非 OpenFOAM 风格残差；如果用户的 print 里有这类指标，调 status 时把它提出来。
- 算法核心三函数：\`equilibrium / collision / streaming\`——改算法时**先**找出这三处，再讨论改什么。
- 单位用格子单位（lattice units），告诉用户 \`u_lb < 0.1\` 才稳，否则建议把 NX 加大或 dt 减小。
- 没有数据库 → 任何"哪个 tutorial 含 XX 算法"都必须通过 \`lbm_find_tutorial\` 实地搜，**禁止**编造路径。
- 中文回答、中文注释。
`;

// ====================== MFIX-Beta 实现 ======================
function mfixRoot() {
  const r = SETTINGS.mfixRoot && String(SETTINGS.mfixRoot).trim();
  if (!r) throw new Error('未设置 MFIX 根目录。请在右侧 "MFIX (Beta)" 面板填写，或 POST /api/mfix/config {root}');
  return r;
}
async function mfixFindTutorial(query, topK = 12) {
  const root = mfixRoot();
  const tut = path.join(root, 'tutorials');
  try { if (!(await fs.stat(tut)).isDirectory()) throw 0; } catch { throw new Error(`tutorials 目录不存在：${tut}`); }
  const q = String(query || '').toLowerCase();
  const hits = []; // {p, score}
  async function walk(dir, depth = 0) {
    if (depth > 6) return;
    let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    let hasInput = false;
    for (const e of ents) if (!e.isDirectory() && (e.name === 'mfix.dat' || /\.mfx$/i.test(e.name))) { hasInput = true; break; }
    if (hasInput) {
      const rel = path.relative(tut, dir);
      const score = (rel.toLowerCase().includes(q) ? 10 : 0) + (path.basename(dir).toLowerCase().includes(q) ? 5 : 0);
      if (q === '' || score > 0) hits.push({ p: rel || path.basename(dir), score });
    }
    for (const e of ents) if (e.isDirectory()) await walk(path.join(dir, e.name), depth + 1);
  }
  await walk(tut);
  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, topK);
  if (!top.length) return `[mfix_find_tutorial] "${query}" → 0 条候选。请换关键词或检查 ${tut} 是否含 mfix.dat / *.mfx。`;
  return `[mfix_find_tutorial] "${query}" → ${top.length} 条候选（按相关度）：\n` +
    top.map((h, i) => `  ${i + 1}) ${h.p}`).join('\n');
}
async function mfixCloneTutorial(tutorialPath, dest) {
  if (!tutorialPath) throw new Error('tutorial_path 必填');
  if (!dest) throw new Error('dest 必填');
  const root = mfixRoot();
  const src = path.isAbsolute(tutorialPath) ? tutorialPath : path.join(root, 'tutorials', tutorialPath);
  try { if (!(await fs.stat(src)).isDirectory()) throw 0; } catch { throw new Error(`源目录不存在：${src}`); }
  const hasInput = (await fs.readdir(src)).some(n => n === 'mfix.dat' || /\.mfx$/i.test(n));
  if (!hasInput) return `警告：${src} 看起来不是 MFIX case（缺 mfix.dat / *.mfx），未复制。请先用 mfix_find_tutorial 定位到具体 case。`;
  const target = path.isAbsolute(dest) ? dest : path.resolve(WORKSPACE, dest);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(src, target, { recursive: true, force: false, errorOnExist: false });
  return `已复制 MFIX tutorial：\n  源：${src}\n  目标：${path.relative(WORKSPACE, target)}\n建议下一步：mfix_inspect_case("${path.relative(WORKSPACE, target)}")`;
}
async function mfixInspectCase(casePath) {
  if (!casePath) throw new Error('case_path 必填');
  const cd = path.isAbsolute(casePath) ? casePath : path.resolve(WORKSPACE, casePath);
  try { if (!(await fs.stat(cd)).isDirectory()) throw 0; } catch { throw new Error(`目录不存在：${cd}`); }
  const ents = await fs.readdir(cd);
  const inputs = ents.filter(n => n === 'mfix.dat' || /\.mfx$/i.test(n));
  if (!inputs.length) return `[mfix_inspect_case] ${cd}\n未发现 mfix.dat 或 *.mfx 输入文件。`;
  const out = [`[mfix_inspect_case] ${cd}`, `输入文件: ${inputs.join(', ')}`, ''];
  for (const f of inputs.slice(0, 2)) {
    const full = path.join(cd, f);
    let raw = '';
    try { raw = await fs.readFile(full, 'utf8'); } catch (e) { out.push(`[读取失败] ${f}: ${e.message}`); continue; }
    out.push(`--- ${f} 关键 keyword ---`);
    const KEYS = /^\s*(RUN_NAME|RUN_TYPE|DESCRIPTION|UNITS|TIME|TSTOP|DT|DT_MIN|DT_MAX|COORDINATES|XLENGTH|YLENGTH|ZLENGTH|IMAX|JMAX|KMAX|MMAX|MU_g0|MU_g|RO_g0|RO_g|MW_AVG|D_p\d*|RO_s\d*|EP_star|GRAVITY|FRICTION_MODEL|BC_X_[ew]|BC_Y_[ns]|BC_Z_[tb]|BC_TYPE|BC_U_g|BC_V_g|BC_W_g|BC_P_g|BC_T_g|BC_EP_g|IC_X_[ew]|IC_Y_[ns]|IC_Z_[tb]|IC_EP_g|IC_U_g|IC_V_g|IC_W_g|IC_P_g|IC_T_g|RES_DT|SPX_DT|OUT_DT|NODESI|NODESJ|NODESK|SOLIDS_MODEL|KT_TYPE)\s*=/i;
    for (const line of raw.split(/\r?\n/)) {
      if (KEYS.test(line) && line.length < 200) out.push('  ' + line.trim());
    }
    out.push('');
  }
  // 文件清单（递归，最多 400 项）
  out.push('--- 文件清单 (递归) ---');
  const allFiles = [];
  async function walk(dir, rel = '') {
    if (allFiles.length > 400) return;
    let es; try { es = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (allFiles.length > 400) return;
      const sub = path.join(dir, e.name); const rsub = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) await walk(sub, rsub); else allFiles.push(rsub);
    }
  }
  await walk(cd);
  out.push(...allFiles.map(f => '  ' + f));
  if (allFiles.length > 400) out.push('  … (已截断，超过 400 项)');
  return out.join('\n');
}
async function mfixRunSolverAsync({ case_path, command }, ws, session) {
  if (!case_path) throw new Error('case_path 必填');
  const cd = path.isAbsolute(case_path) ? case_path : path.resolve(WORKSPACE, case_path);
  const cmd = (command && command.trim()) || 'mfixsolver';
  let inner;
  if (IS_WIN) inner = SETTINGS.mfixBash ? `call "${SETTINGS.mfixBash}" && cd /d "${cd}" && ${cmd}` : `cd /d "${cd}" && ${cmd}`;
  else inner = `cd "${cd}" || exit 97; ${SETTINGS.mfixBash ? `source "${SETTINGS.mfixBash}"` : 'true'}; ${cmd}`;
  const { runId } = spawnTrackedRun({ kind: 'mfix', cd, command: cmd, inner, ws, session });
  return `[已启动 MFIX 求解器]\n  runId: ${runId}\n  case:  ${cd}\n  cmd:   ${cmd}\n请在"求解器监测"面板订阅 runId=${runId}，或调用 mfix_solver_status(${runId})。`;
}
function mfixSolverStatus(runId) {
  const run = SOLVER_RUNS.get(runId);
  if (!run) return '[未知 runId]';
  const lines = run.log; const tail = lines.slice(-40);
  // MFIX 时间步格式: "Time= 1.234E-02" or "T= ..." 或 "Time, dt:"
  let lastTime = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/(?:Time|T|TIME)\s*[=:]\s*([\d.eE+\-]+)/);
    if (m) { lastTime = m[1]; break; }
  }
  // MFIX 残差: "Residual:" 或包含 "P_g" / "U_g" / norm
  const resLines = lines.filter(l => /(Residual|Norm|P_g\s|U_g\s|V_g\s|W_g\s|EP_g\s)/.test(l)).slice(-20);
  const status = run.ended ? `已结束(exit=${run.exitCode})` : '运行中';
  const dur = ((run.ended || Date.now()) - run.started) / 1000;
  return [
    `runId: ${runId}    状态: ${status}    用时: ${dur.toFixed(1)}s    [MFIX]`,
    `case:  ${run.casePath}`,
    `cmd:   ${run.command}`,
    `当前 Time: ${lastTime || '(未识别)'}`,
    `\n--- 最近残差/norm (20 行) ---`,
    ...resLines,
    `\n--- 日志 tail (40 行) ---`,
    ...tail
  ].join('\n');
}
function mfixSolverStop(runId) {
  const run = SOLVER_RUNS.get(runId);
  if (!run) return '[未知 runId]';
  if (run.ended) return '[已结束]';
  run._userStopped = true; killRunTree(run);
  setTimeout(() => { if (!run.ended) killRunTree(run, true); }, 3000);
  return `[已发送终止信号 runId=${runId}]`;
}

// ====================== LBM-Beta 实现 ======================
function lbmRootDir() {
  const r = SETTINGS.lbmTutorialRoot && String(SETTINGS.lbmTutorialRoot).trim();
  if (!r) throw new Error('未设置 LBM 算例根目录。请在右侧 "LBM (Beta)" 面板填写，或 POST /api/lbm/config {tutorialRoot}');
  return r;
}
async function lbmFindTutorial(query, topK = 12) {
  const root = lbmRootDir();
  try { if (!(await fs.stat(root)).isDirectory()) throw 0; } catch { throw new Error(`目录不存在：${root}`); }
  const q = String(query || '').toLowerCase();
  const hits = []; // {p, score}
  const CASE_FILE = /^(README(\.md|\.txt)?|input\.|params\.|main\.(py|cpp|c|cu|f90)|.*\.(py|cpp|cu|f90|ini|json|yaml|yml|toml))$/i;
  async function walk(dir, depth = 0) {
    if (depth > 6) return;
    let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    let isCase = false;
    for (const e of ents) if (!e.isDirectory() && CASE_FILE.test(e.name)) { isCase = true; break; }
    if (isCase) {
      const rel = path.relative(root, dir);
      // 算分：路径含 query / 算法名加权
      const bn = path.basename(dir).toLowerCase();
      const fullRel = rel.toLowerCase();
      let score = 0;
      if (q && fullRel.includes(q)) score += 10;
      if (q && bn.includes(q)) score += 5;
      // 读 README/前 2 个源文件首 4KB 做内容打分（仅当 q 非空）
      if (q) {
        const probes = ents.filter(e => !e.isDirectory() && /^(README|main\.|input\.|params\.)/i.test(e.name)).slice(0, 3);
        for (const e of probes) {
          try {
            const txt = (await fs.readFile(path.join(dir, e.name), 'utf8')).slice(0, 4096).toLowerCase();
            if (txt.includes(q)) { score += 3; break; }
          } catch {}
        }
      }
      if (q === '' || score > 0) hits.push({ p: rel || path.basename(dir), score });
    }
    for (const e of ents) if (e.isDirectory() && !/^(\.|build|__pycache__|node_modules)/.test(e.name)) await walk(path.join(dir, e.name), depth + 1);
  }
  await walk(root);
  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, topK);
  if (!top.length) return `[lbm_find_tutorial] "${query}" → 0 条候选。请换关键词或检查 ${root}。`;
  return `[lbm_find_tutorial] "${query}" → ${top.length} 条候选（按相关度）：\n` +
    top.map((h, i) => `  ${i + 1}) ${h.p}`).join('\n');
}
async function lbmCloneTutorial(tutorialPath, dest) {
  if (!tutorialPath) throw new Error('tutorial_path 必填');
  if (!dest) throw new Error('dest 必填');
  const root = lbmRootDir();
  const src = path.isAbsolute(tutorialPath) ? tutorialPath : path.join(root, tutorialPath);
  try { if (!(await fs.stat(src)).isDirectory()) throw 0; } catch { throw new Error(`源目录不存在：${src}`); }
  const target = path.isAbsolute(dest) ? dest : path.resolve(WORKSPACE, dest);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(src, target, { recursive: true, force: false, errorOnExist: false });
  return `已复制 LBM 算例：\n  源：${src}\n  目标：${path.relative(WORKSPACE, target)}\n建议下一步：lbm_inspect_case("${path.relative(WORKSPACE, target)}")`;
}
async function lbmInspectCase(casePath, algorithmHint = '') {
  if (!casePath) throw new Error('case_path 必填');
  const cd = path.isAbsolute(casePath) ? casePath : path.resolve(WORKSPACE, casePath);
  try { if (!(await fs.stat(cd)).isDirectory()) throw 0; } catch { throw new Error(`目录不存在：${cd}`); }
  const out = [`[lbm_inspect_case] ${cd}`];
  if (algorithmHint) out.push(`用户提示算法：${algorithmHint}`);
  // 收集文件清单（递归，前 300）
  const allFiles = [];
  async function walk(dir, rel = '') {
    if (allFiles.length > 300) return;
    let es; try { es = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (allFiles.length > 300) return;
      if (/^(\.|build|__pycache__|node_modules)/.test(e.name)) continue;
      const sub = path.join(dir, e.name); const rsub = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) await walk(sub, rsub); else allFiles.push(rsub);
    }
  }
  await walk(cd);
  // 算法骨架识别：读所有源文件首 16KB
  const SCAN_EXT = /\.(py|cpp|c|cu|cuh|h|hpp|f90|jl|m)$/i;
  const sources = allFiles.filter(f => SCAN_EXT.test(f)).slice(0, 12);
  const detected = new Set();
  const fnHits = { equilibrium: [], collision: [], streaming: [], propagate: [] };
  for (const f of sources) {
    try {
      const txt = (await fs.readFile(path.join(cd, f), 'utf8')).slice(0, 16384);
      const lower = txt.toLowerCase();
      // 格子模型
      for (const lm of ['d2q9','d3q7','d3q15','d3q19','d3q27']) if (lower.includes(lm)) detected.add(lm.toUpperCase());
      // 碰撞算子
      for (const co of [['bgk','BGK'],['mrt','MRT'],['trt','TRT'],['cumulant','Cumulant'],['regularized','Regularized'],['srt','SRT'],['kbc','KBC']])
        if (new RegExp('\\b' + co[0] + '\\b').test(lower)) detected.add(co[1]);
      // 多相
      if (/shan.?chen|free.?energy|color.?gradient|interface.?tracking/.test(lower)) detected.add('多相LBM');
      // 三大核心函数定位
      for (const k of Object.keys(fnHits)) {
        const re = new RegExp('(def|void|inline|static|template[^\\n]*?>\\s*\\w+|subroutine|function)\\s+\\w*' + k + '\\w*', 'gi');
        let m; while ((m = re.exec(txt)) && fnHits[k].length < 3) fnHits[k].push(`${f}: ${m[0].slice(0,80)}`);
      }
    } catch {}
  }
  out.push('--- 算法骨架识别 ---');
  out.push('  检测到: ' + (detected.size ? [...detected].join(', ') : '(未识别 — 用户提示可补充)'));
  for (const k of Object.keys(fnHits)) if (fnHits[k].length) out.push(`  ${k}(): \n` + fnHits[k].map(s => '    - ' + s).join('\n'));
  // README / params
  const readmes = allFiles.filter(f => /^(README|params|input)/i.test(path.basename(f))).slice(0, 3);
  for (const r of readmes) {
    try {
      const txt = await fs.readFile(path.join(cd, r), 'utf8');
      out.push(`\n--- ${r} (前 60 行) ---`);
      out.push(...txt.split(/\r?\n/).slice(0, 60));
    } catch {}
  }
  out.push('\n--- 文件清单 (递归, 前 300) ---');
  out.push(...allFiles.map(f => '  ' + f));
  return out.join('\n');
}
async function lbmRunAsync({ case_path, command }, ws, session) {
  if (!case_path) throw new Error('case_path 必填');
  const cd = path.isAbsolute(case_path) ? case_path : path.resolve(WORKSPACE, case_path);
  const cmd = (command && command.trim()) || (SETTINGS.lbmRunCmd && SETTINGS.lbmRunCmd.trim());
  if (!cmd) throw new Error('未提供 command 且 SETTINGS.lbmRunCmd 为空。请提供运行命令或在面板填默认模板。');
  const inner = IS_WIN ? `cd /d "${cd}" && ${cmd}` : `cd "${cd}" && ${cmd}`;
  const { runId } = spawnTrackedRun({ kind: 'lbm', cd, command: cmd, inner, ws, session });
  return `[已启动 LBM 作业]\n  runId: ${runId}\n  case:  ${cd}\n  cmd:   ${cmd}\n请在"求解器监测"面板订阅 runId=${runId}，或调用 lbm_solver_status(${runId})。`;
}
function lbmSolverStatus(runId) {
  const run = SOLVER_RUNS.get(runId);
  if (!run) return '[未知 runId]';
  const lines = run.log; const tail = lines.slice(-40);
  // LBM 通用 print 风格: "step 1000" / "iter=1000" / "t=0.05" / "||u^{n+1}-u^n||=1e-6"
  let lastStep = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/(?:step|iter|iteration|t)\s*[=:]?\s*([\d.eE+\-]+)/i);
    if (m) { lastStep = m[1]; break; }
  }
  const metricLines = lines.filter(l => /(\|\|.*\|\||residual|error|err|rmse|conv|mach|cfl|u_max)\s*[=:]/i.test(l)).slice(-20);
  const status = run.ended ? `已结束(exit=${run.exitCode})` : '运行中';
  const dur = ((run.ended || Date.now()) - run.started) / 1000;
  return [
    `runId: ${runId}    状态: ${status}    用时: ${dur.toFixed(1)}s    [LBM]`,
    `case:  ${run.casePath}`,
    `cmd:   ${run.command}`,
    `当前 step/iter/t: ${lastStep || '(未识别)'}`,
    `\n--- 关键 metric (20 行) ---`,
    ...metricLines,
    `\n--- 日志 tail (40 行) ---`,
    ...tail
  ].join('\n');
}
function lbmSolverStop(runId) {
  const run = SOLVER_RUNS.get(runId);
  if (!run) return '[未知 runId]';
  if (run.ended) return '[已结束]';
  run._userStopped = true; killRunTree(run);
  setTimeout(() => { if (!run.ended) killRunTree(run, true); }, 3000);
  return `[已发送终止信号 runId=${runId}]`;
}

// ====================== V8 全局规则 Prompt（招1 + 招3 + 四步法） ======================
const V9_PROMPT_BLOCK = `

## 🔴🔴🔴 V8 全局规则（招1 自动版本 + 招3 错误诊断 + 算法植入四步法）

### 招1 · 自动 git 版本（你不需要手动 commit，已接管）
- 你每次 \`write_file\` / \`edit_file\` / \`multi_edit\` 返回值末尾都带 \`[V8 git] pre=<sha> post=<sha>\`。
- 工作受阻 / "越改越差" / 同一报错连续修 **3 次仍未消除** → **必须**：
  1. \`git_log_recent(n=10)\` 拿最近 10 个 SHA；
  2. 找到"上一个能跑的快照"对应的 SHA；
  3. \`git_revert_to(sha, note='报错修了3次没好，回到X')\` 回滚。
- **铁律**：连续 3 次同类报错 → **禁止**继续往坏 case 上叠改，必须回滚 + 重新规划。
- \`git_revert_to\` 是 checkout 旧 SHA + 新 commit，**不丢失历史**，可以再 \`git_log_recent\` 找回来。

### 招3 · 错误诊断（看 log 之前先匹配模式）
- 任何工具返回包含 \`error\` / \`FOAM FATAL\` / \`exception\` / 非零 exit / nan / segfault → **下一动作必须**先调 \`diagnose_error(text=<log tail 或错误段>)\`。
- 它会按内置 15 条模式匹配，返回 {category, causes, next_steps}，**按 next_steps 顺序执行**，不要乱开新 edit。
- matched:false → 才允许逐行 read_file 看 log 全文，或转人工。

### 算法植入四步法（论文复现 / 自写算法 / 改 OpenFOAM 源码时**必走**）
**触发条件**：用户说"植入"/"复现某论文算法"/"新增 drag/turbulence/BC 模型"/"改 solver 主循环"/"写 fvOption codedSource"。

**第 1 步 · 抽契约** \`algo_extract_contract(source_file, algorithm_name)\`
  - source_file = 论文 PDF / 已存在 .H / .C / .py 路径
  - 返回 {inputs, outputs, equations, governing_type, assumes:{compressible, phases, turbulence, dimensions}}
  - **未做此步禁止 \`write_file\` 新的 .H/.C 或大段算法 patch**

**第 2 步 · 体检 case** \`case_probe_facts(case_path)\`
  - 返回 case **实际**事实：solver / governing / compressible / phases / turbulence / dimensions_xyz / patches / fields_in_0 / transport
  - **未做此步禁止修改 case 的 BC / 物性 / 求解器名**

**第 3 步 · 审计** \`algo_case_audit(contract, case_facts)\`
  - 比对 step1 契约 vs step2 事实，输出 mismatches[]
  - **mismatch 非空（pass:false）→ 禁止进入第 4 步**。必须先：① 解决 mismatch（换 case 或改契约），或 ② 跟用户报告并得到明确豁免。

**第 4 步 · 受控植入**
  - 走 P3→P5：foam_find_source 找参考 → write_file 新 .H/.C → \`foam_dry_compile(module_path)\` 抓首错 → 修正 → \`wmake libso\` 正式编译。
  - 所有 write_file/edit_file 自动 git snapshot；编译失败 3 次走招1 回滚。

**违反四步法的红线**（看到立即自查停下）：
- 没跑 algo_extract_contract 就 write_file 新算法源码 ❌
- 没跑 case_probe_facts 就改 0/<field> 或 constant/ 的物性 ❌
- audit pass:false 仍 write_file ❌

### 前置计划 + 阶段对账（长程任务必走）
- **开工先规划**：复杂任务（>3 步 / 跑解算器 / 复现算法）**第一动作**就用 \`update_todos\` 写出**带 verify 关卡**的计划，每个关键阶段后面要挂一个验证项，例如：
  \`1) 体检 case  2) 划网格 → ✅foam_mesh_verify  3) 跑解算器 → ✅foam_solve_verify  4) 后处理 → ✅foam_post_verify  5) 收尾\`
- **按阶段推进**：进入一个阶段调 \`run_stage_start(stage)\`，该阶段产出经对应 verifier 通过后调 \`run_stage_done(stage, passed=true, memo)\`；verifier FAIL 时 \`run_stage_done(passed=false)\` 并修复重验。
- **阶段对账**：每次 run_stage_done 返回里会带「计划对账」——还剩几项待办、有没有阶段被跳过。若实际偏离计划（如跳过了验证关卡）→ 立刻 \`update_todos\` 校正后再继续，不要闷头往下做。
- **铁律**：未通过对应 verifier 的阶段不得标 done=true；计划里的 verify 关卡一个都不能省。

`;

const SKILL_PROMPT_BLOCK = `

# 🧠 经验自进化（轻量，硬约束）
- **任务跑通且 *_verify / run_stage_done 盖章通过后、task_complete 之前**：调 \`skill_save\` 把本轮可复用做法沉淀成独立技能卡（recipe 写 3-10 条精炼步骤、key_params 写关键数值、pitfalls 写踩过的坑、triggers 写下次该被命中的关键词）。**未通过验证不要存**。
- **开新任务前**：可先 \`skill_recall(query)\` 看以前同类怎么干成的；若上方已注入「📚 领域经验」，直接参考但仍走本案 verify 闭环。
- **修好一个内置 diagnose_error 没覆盖的新报错后**：调 \`learn_error_pattern\` 登记，让下次秒命中。
- **轨迹沉淀为微调语料（第4层）**：任务跑通且 verifier 盖章后，可调 \`skill_export_sft\` 把整条已验证轨迹追加成 SFT 语料（jsonl，零幻觉、带 provenance），将来用于微调本地模型。未通过验证会被拒绝。

# 🧪 skill 升级检验模式（A/B：同一固定案例，对比"有技能 vs 无技能"）
当用户想验证"某条技能到底有没有用"时，用同一个**固定案例**、在两个不同文件夹各跑一次，再客观对比：
1. **基线臂（无技能）**：在文件夹 A 跑该案例（可先 \`skill_forget\` 或不命中触发词使其不注入），完成后调 \`skill_eval_record(label='baseline_无技能', folder='A路径', task='案例描述')\`。
2. **技能臂（有技能）**：在文件夹 B 跑**同一个 task**（确保对应技能被注入），完成后调 \`skill_eval_record(label='withskill_有技能', folder='B路径', task='同样的案例描述')\`。
3. **对比裁决**：调 \`skill_eval_compare(task='案例描述')\`，系统自动比对两臂的 verifier 通过率 / 错误迭代次数 / 是否注入技能，给出"技能是否真有帮助"的结论。
- 铁律：两臂的 task 必须**一致**才可比；案例要有一定难度（太简单两臂都满分、区分不出）。`;

// 精简基础提示（学 OpenCode：固定开销小，细则交给工具描述和工具返回）。按 "\n# " 切节，
// 长节换成等价短版；论文专用节只在任务像论文复现时保留。LEAN_PROMPT=0 恢复全文。
const LEAN_BASE_SECTIONS = {
  '重要：运行代码的规则': '# 运行代码\n- 用户要跑什么就直接 run_command；缺依赖 pip install 也走 run_command。\n',
  '⚡ 核心工作守则': '# 核心守则\n1. 动手不空谈：要改文件就调 write_file/edit_file，要跑就调 run_command；每轮至少调一个工具，不在聊天里贴大段代码。\n2. 小步走：每轮只决定下一个动作，拿到真实结果再想下一步。\n3. 不确定就查（list_dir/read_file/run_command），别猜。\n4. 需求有多种解释且缺关键信息时才问；用户说了不要问就自己按最合理的解释做。\n5. 改动克制，完成后用 *_verify 或数值检查核验，再调 task_complete。\n6. 长作业用 foam_run_solver_async 放后台，用 solver_wait 等结束（不要 sleep 轮询，不要在 run_command 里 nohup … &）。\n',
  '联网工具': null,
  '🔴 图像分析铁律': '# 看图\n你看不见图片像素：任何关于图的结论都要先调 vision_analyze 或对应 *_verify；问具体问题（位置、数值、是否发散），把 VLM 结论贴出来。\n',
  '🔴 公式书写铁律': '# 公式\n聊天里的公式用 LaTeX（行内 $...$，独立 $$...$$，希腊字母用 \\rho 等命令）；代码块和 OpenFOAM 字典里保持 ASCII。\n',
  '长程任务': '# 长程任务\n复杂任务先 update_todos 拆可验证的待办，完成一项勾一项，全部完成才 task_complete。\n',
  '规则': '# 规则\n- 优先 edit_file；中文回答、中文注释。\n',
  '网格自动核对闭环': '# 网格核对\n- blockMesh/snappyHexMesh 之后先 foam_mesh_verify，pass=false 就修字典重跑（3 次失败后 foam_mesh_plan 降档）；snappy 前先 foam_stl_render，之后 foam_patch_diff 确认 patch。\n',
  'v0.6.0 自治可靠性': '# 可靠性\n- 返回 [SCHEMA_INPUT_ERROR] 就按提示改参数重试；返回 [WATCHDOG_HALT] 立刻停下汇报。\n- 多阶段长任务可用 run_stage_start / run_stage_done 记录阶段；服务重启后先 run_status_load 看在跑的作业。\n',
};
// 与 _WANT_PAPER_TOOLS_RE 保持一致（这里单独写一份：测试按源码片段加载提示词段）
const _WANT_PAPER_RE = /论文|\bpaper\b|复现|reproduc|植入|implement(?:ing)? (?:the )?(?:model|equation)|方程|algorithm|算法|closure|曳力|drag model|drag\b|源项|source term|fvoption|coded|\.pdf\b|读论文|论文原文|按原文|重现|重新做|这篇(?:文献|文章)|(?:照着?|按照?|依照|根据)[^\n，。]{0,10}(?:文献|文章)/i;
function leanSystemBase(full, taskText) {
  if (process.env.LEAN_PROMPT === '0') return full;
  const wantPaper = _WANT_PAPER_RE.test(String(taskText || ''));
  const parts = full.split(/\n(?=# )/);
  const out = [];
  for (const part of parts) {
    const head = (part.match(/^# (.+)$/m) || [, ''])[1];
    if (/^文献工作流/.test(head)) { if (wantPaper) out.push(part); continue; }
    const key = Object.keys(LEAN_BASE_SECTIONS).find(k => head.startsWith(k));
    if (key === undefined) { out.push(part); continue; }
    if (LEAN_BASE_SECTIONS[key]) out.push(LEAN_BASE_SECTIONS[key]);
  }
  return out.join('\n');
}
// V8 全局规则 / 技能块的精简版：git 回滚与报错诊断保留要点；算法植入四步法只在论文/算法任务注入；
// 技能 A/B 检验模式只在用户提到技能评测时注入
const V9_LEAN = `

## 全局规则
- 文件改动自动 git 快照（返回里有 [V8 git]）。同一报错连修 3 次不好 → git_log_recent 找上一个能跑的快照，git_revert_to 回滚再重新规划。
- 工具返回 FOAM FATAL / 非零退出 / nan / segfault → 先 diagnose_error(text=错误段)，按 next_steps 做。
- 复杂任务先 update_todos 列计划，关键阶段后挂一个验证（网格 foam_mesh_verify、结果用数值或 *_verify 核验）；未通过验证的阶段不标完成。
`;
const SKILL_LEAN = `

# 经验
- 若上方注入了「📚 领域经验」，直接参考，仍要核验本案结果。
- 任务跑通并核验后，task_complete 前可调 skill_save 沉淀做法（recipe/key_params/pitfalls/triggers）；修好 diagnose_error 没覆盖的新报错后可调 learn_error_pattern。
`;
function leanV9Block(taskText) {
  if (process.env.LEAN_PROMPT === '0') return V9_PROMPT_BLOCK;
  if (_WANT_PAPER_RE.test(String(taskText || ''))) {
    const a = V9_PROMPT_BLOCK.indexOf('### 算法植入四步法'); const b = V9_PROMPT_BLOCK.indexOf('### 前置计划');
    return V9_LEAN + '\n' + V9_PROMPT_BLOCK.slice(a, b);
  }
  return V9_LEAN;
}
function leanSkillBlock(taskText) {
  if (process.env.LEAN_PROMPT === '0' || /技能|skill|评测|A\/B/i.test(String(taskText || ''))) return SKILL_PROMPT_BLOCK;
  return SKILL_LEAN;
}

// 本轮用于检索化注入的任务文本：当前用户输入 → 任务持久化的首条需求 → 历史里第一条用户消息
// （自动唤醒 / 重启恢复时没有 _pendingUserText，之前会退化成全量 FOAM_PROMPT）
function taskTextOf(s) {
  if (s._pendingUserText) return s._pendingUserText;
  if (s.task && s.task.taskText) return s.task.taskText;
  if (s.task && s.task.fidelity && s.task.fidelity.taskText) return s.task.fidelity.taskText;
  for (const m of (s.messages || [])) {
    if (m.role !== 'user') continue;
    const c = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map(x => x && x.text || '').join(' ') : '';
    if (c.trim() && !/^\[(唤醒|自动|引导|系统)/.test(c.trim())) return c;
  }
  return '';
}
function buildSystemPrompt(s) {
  const tt = taskTextOf(s);
  let p = leanSystemBase(SYSTEM_PROMPT_BASE(WORKSPACE), tt);
  if (s.foamMode) p += foamPromptFor(tt, { hadError: sessionHadError(s) });
  if (s.mfixMode) p += MFIX_PROMPT;
  if (s.lbmMode)  p += LBM_PROMPT;
  if (s.customMode && SETTINGS.customPrompt && SETTINGS.customPrompt.trim()) {
    const name = SETTINGS.customName || '自定义工作流';
    const root = SETTINGS.customRoot ? `根目录：${SETTINGS.customRoot}\n` : '';
    p += `\n\n========== 已启用《${name}》工作流（用户自定义 Beta）==========\n${root}${SETTINGS.customPrompt.trim()}\n========== 工作流定义结束 ==========\n`;
  }
  p += leanV9Block(tt);  // v0.9.0 (V8) 全局规则（按需精简）
  p += leanSkillBlock(tt);
  p += (typeof _packIndex !== 'undefined' ? _packIndex.text : '');
  const _t = s.task || {};
  if (_t.agentMode === 'plan') p += '\n\n# 🗺 当前为【规划模式】\n只读：可读文件、查论文、检查算例、读后处理数据、看图；写文件/跑命令/启动求解器/改参数的工具已被屏蔽。\n输出：①问题与已知事实 ②分步方案（网格/模型/边界/求解/后处理/验收指标）③风险与核算（核数、物理时长、预计耗时）④需要用户决定的点。用户切到【执行模式】后再动手。\n';
  if (_t.goal && _t.goal.status === 'active') p += `\n\n# 🎯 会话目标（持续推进直到达成 / 阻塞 / 用户停止）\n${_t.goal.text}\n${_t.goal.criteria ? '验收标准（逐条给出数值证据才算达成）：\n' + _t.goal.criteria + '\n' : ''}达成后调用 task_complete，summary 里逐条列验收证据；确实阻塞时说明阻塞原因并向用户提问。\n`;
  // 自进化：按当前任务文本检索已验证技能，排序+封顶后注入（无命中则为空）
  try { const inj = SkillLib.injectionFor(tt, { foam: s.foamMode, mfix: s.mfixMode, lbm: s.lbmMode }); if (inj) p += inj; } catch {}
  try { p += Fidelity.lessonsFor(tt); } catch {}
  try { p += Evolve.injectionFor(((s.task && s.task.fidelity && s.task.fidelity.taskText) || '') + '\n' + tt); } catch {}
  try { const hs = Fidelity.holds(s); if (hs.length) p += `\n\n# ⛔ 保真度门未解除（求解/收尾会被拦截）\n${hs.map(h => `- [${h.key}] ${h.label}: ${h.detail}`).join('\n')}\n先按原文修正，或发偏离申报等用户批准。\n`; } catch {}
  // 结构化工作记忆（pinned · 不随上下文压缩丢失 · 本任务的硬事实）
  try {
    const wm = s.workMem;
    if (wm && (wm.stage || wm.facts || wm.solver || wm.casePath || (wm.params && Object.keys(wm.params).length) || (wm.pitfalls && wm.pitfalls.length) || (wm.verified && wm.verified.length) || (wm.failedVerifiers && wm.failedVerifiers.length))) {
      let b = '\n\n# 🧷 工作记忆（pinned · 当前任务硬事实 · 优先以此为准，勿与早期对话矛盾）\n';
      if (wm.casePath) b += `- 算例路径: ${wm.casePath}\n`;
      if (wm.solver) b += `- 求解器: ${wm.solver}\n`;
      if (wm.stage) b += `- 当前阶段: ${wm.stage}\n`;
      if (wm.params && Object.keys(wm.params).length) b += `- 关键参数: ${Object.entries(wm.params).slice(0, 12).map(([k, v]) => `${k}=${v}`).join('; ')}\n`;
      if (wm.verified && wm.verified.length) b += `- ✅ 已通过 verifier: ${wm.verified.join(', ')}\n`;
      if (wm.failedVerifiers && wm.failedVerifiers.length) b += `- ⛔ 待修复 verifier（最近 FAIL，未重验通过前禁止 task_complete）: ${wm.failedVerifiers.join(', ')}\n`;
      if (wm.pitfalls && wm.pitfalls.length) b += `- ⚠ 本任务已踩过的坑（勿重犯）: ${wm.pitfalls.join('；')}\n`;
      if (wm.facts) b += `- case 事实（case_probe_facts 实测，权威）:\n${wm.facts.split('\n').map(x => '  ' + x).join('\n')}\n`;
      p += b;
    }
  } catch {}
  return p;
}

// 工具信号捕获：把 verifier 通过/失败、case 事实、当前阶段 抽进 session.workMem（pinned）。
// 既支撑「结构化工作记忆」（防压缩丢失），又支撑「verifier 硬门」（task_complete 拦截）。
// V10：额外捕获 求解器 / 关键参数 / 踩过的坑 / 算例路径，既喂回 prompt 防长任务跑偏，
//      又在沉淀技能卡时自动填好 solver / key_params / pitfalls（draftFromTrajectory 读取）。
const _WM_SOLVER_RE = /\b(blockMesh|snappyHexMesh|checkMesh|decomposePar|reconstructPar|simpleFoam|pimpleFoam|pisoFoam|icoFoam|potentialFoam|interFoam|multiphaseInterFoam|interIsoFoam|rhoSimpleFoam|rhoPimpleFoam|sonicFoam|buoyantSimpleFoam|buoyantPimpleFoam|chtMultiRegionFoam|reactingFoam|chemFoam|scalarTransportFoam)\b/;
function captureToolSignal(session, name, result, args = {}) {
  try {
    const wm = session.workMem || (session.workMem = { stage: '', facts: '', verified: [], failedVerifiers: [], solver: '', casePath: '', params: {}, pitfalls: [] });
    if (!wm.params) wm.params = {};
    if (!wm.pitfalls) wm.pitfalls = [];
    const txt = String(result || '');
    if (/_verify$/.test(name) || name === 'paper_param_verify') {
      // 各 verifier 输出格式不一：{passed:true} / "pass": true / 首行 ✓ [mesh_verify/...] 通过
      const head = /^\s*([✓✗])\s*\[/.exec(txt);
      const passed = head ? head[1] === '✓' : /"?pass(?:ed)?"?\s*[=:]\s*true/i.test(txt);
      const failed = head ? head[1] === '✗' : /"?pass(?:ed)?"?\s*[=:]\s*false/i.test(txt);
      session.verifyState = session.verifyState || {};
      if (passed) {
        session.verifyState[name] = 'pass';
        if (!wm.verified.includes(name)) wm.verified.push(name);
        wm.failedVerifiers = wm.failedVerifiers.filter(x => x !== name);
      } else if (failed) {
        session.verifyState[name] = 'fail';
        if (!wm.failedVerifiers.includes(name)) wm.failedVerifiers.push(name);
      }
    }
    try { Evolve.onTool(session, name, args, txt); } catch {}
    if (name === 'case_probe_facts') wm.facts = txt.replace(/^\[case_probe_facts[^\n]*\n/, '').slice(0, 1200);
    if (name !== 'diagnose_error' && /FOAM FATAL|FOAM FATAL IO ERROR|Segmentation fault|sigFpe|Traceback \(most recent/.test(txt)) {
      const i = txt.search(/FOAM FATAL|Segmentation fault|sigFpe|Traceback \(most recent/);
      const snip = txt.slice(Math.max(0, i - 80), i + 400);
      const novel = (session._novelErrors = session._novelErrors || []);
      if (!diagnoseErrorText(snip).matched && !novel.some(e => e.slice(0, 120) === snip.slice(0, 120))) { novel.push(snip); if (novel.length > 5) novel.shift(); }
    }
    if (name === 'run_stage_start') { const m = txt.match(/stage=([\w-]+)/); if (m) wm.stage = m[1]; }
    if (name === 'run_stage_done') { const m = txt.match(/stage=([\w-]+)\s+status=([\w-]+)/); if (m) wm.stage = m[1] + ':' + m[2]; }
    // ---- V10 工作记忆扩展：算例路径 / 求解器 / 关键参数 / 踩过的坑 ----
    if (args && args.case_path) wm.casePath = String(args.case_path);   // 跟踪当前算例（取最新）
    if (args && args.solver) wm.solver = String(args.solver);
    else if (args && args.command) { const m = _WM_SOLVER_RE.exec(String(args.command)); if (m) wm.solver = m[1]; }
    if (args && args.params && typeof args.params === 'object') {        // opt_apply_params / paper_param_verify 的关键数值
      for (const [k, v] of Object.entries(args.params)) if (v != null && typeof v !== 'object') wm.params[k] = v;
    }
    if (name === 'diagnose_error') {                                     // 诊断命中的类别 = 本任务踩过的坑
      const m = /类别[:：]\s*([^\n]+)/.exec(txt) || /category[:=]\s*([^\n,]+)/i.exec(txt);
      if (m) { const p = m[1].trim().slice(0, 80); if (p && !wm.pitfalls.includes(p)) wm.pitfalls.push(p); }
    }
    if (name === 'learn_error_pattern' && args && args.category) {
      const p = String(args.category).slice(0, 80); if (!wm.pitfalls.includes(p)) wm.pitfalls.push(p);
    }
    if (wm.pitfalls.length > 8) wm.pitfalls = wm.pitfalls.slice(-8);
  } catch {}
}
// 把工作记忆里的"可复用语义事实"组装成技能卡草稿的填充料（solver/key_params/pitfalls）。
function workMemToSkillFill(session) {
  const wm = session && session.workMem;
  if (!wm) return {};
  return {
    solver: wm.solver || '',
    key_params: (wm.params && Object.keys(wm.params).length) ? { ...wm.params } : {},
    pitfalls: Array.isArray(wm.pitfalls) ? wm.pitfalls.slice(0, 8) : [],
    case_path: wm.casePath || '',
  };
}

async function runAgent(ws, userText, attachments, { resume = false } = {}) {
  const session = sessions.get(ws);
  if (!session) { console.warn('[runAgent] no session for ws'); return; }
  if (session._running) {
    return;
  }
  session._runSeq = (session._runSeq || 0) + 1;
  const myRunSeq = session._runSeq;
  session._running = true;
  // 任务级并发守卫：同一任务可能被多个连接挂载（刷新后旧连接的 run 可能还活着）
  const task = session.task;
  if (task) {
    const other = task._runningSession;
    if (other && other !== session && other._running) {
      session._running = false;
      return;
    }
    task._runningSession = session;
    try { broadcastTaskState(); } catch {}
  }
  const recoveryVersion = task ? recoveryManager.version(task) : 0;
  if (!resume) {
    newCheckpoint(session, userText.slice(0, 40) || '新任务');
    broadcastCheckpoints(ws);
    if (task) {
      // 新输入：之前的"撤销回滚"作废（与 OpenChamber 相同）；记录本轮文件快照的起点
      if (task.revert) task.revert = null;
      task.turnSnaps = (task.turnSnaps || []).slice(-39);   // 与 TURN_SNAP_MAX 一致（测试按函数片段加载，这里不引用常量）
      task._turnSnap = { msgIndex: session.messages.length, ts: Date.now(), files: {} };
      task.turnSnaps.push(task._turnSnap);
    }
    const userContent = await buildUserContent(userText, attachments);
    session.messages.push({ role: 'user', content: userContent });
  }
  session.aborter = new AbortController();
  session.aborted = false; session.taskComplete = false;
  // verifier 硬门：每个任务尝试独立计数，开跑清掉上一任务的 FAIL 记录（避免误拦新任务）
  if (!resume) {
    session.verifyState = {};
    if (session.workMem) session.workMem.failedVerifiers = [];
    // A5 fix: 新任务清掉 question mute 污染（防止跨任务继承超时计数）
    session._qMuteNoted = false;
    session._choiceTimeouts = 0;
  }
  ws.send(JSON.stringify({ type: 'agent_start' }));
  console.log(`[runAgent #${myRunSeq}] started`);

  try {
    let nudgeCount = 0;
    let noToolStreak = 0;       // 连续「只输出文字、没调任何工具」的轮数 → 反空转守卫
    let completionNudge = 0;    // 完成门：工具执行完但未 task_complete → 最多 1 次催促
    // 循环安全卫士：最近 N 个工具调用指纹 (name + args hash)。连续同指纹 >= 5 调则硬断，>=3 插入纠正提示。
    const recentFP = [];        // 循环调用指纹序列
    let warnedDup = false;       // 重复提醒只插一次
    // 🔒 Anti-Spin Protocol: 求解器错误预算 — 同类错误连续 3 次强制停下交用户
    session._solverErrCount = session._solverErrCount || 0;
    session._solverErrCategory = session._solverErrCategory || null;
    function resetSolverErrBudget() { session._solverErrCount = 0; session._solverErrCategory = null; session._solverErrSeen = null; }
    // HC-4: 求解器类工具结果 → 同类错误计数；成功推进则清零。返回 true 表示预算耗尽，应停下交给用户
    const SOLVER_TOOLS = /^(foam_run_solver_async|foam_solver_status|solver_wait|sim_run_openfoam|mfix_run_solver_async|mfix_solver_status|lbm_run_async|lbm_solver_status|run_command)$/;
    function trackSolverError(name, result, args) {
      if (!SOLVER_TOOLS.test(name)) return false;
      const c = classifySolverError(name, args, result);
      if (!c) {
        if (name !== 'run_command' && /运行中|Time\s*=|已结束\(exit=0\)/.test(String(result || ''))) resetSolverErrBudget();
        return false;
      }
      const cat = c.cat;
      // 同一次失败的作业被反复查询（foam_solver_status / solver_wait）只算一次
      session._solverErrSeen = session._solverErrSeen || new Set();
      if (c.once) { if (session._solverErrSeen.has(c.once)) return false; session._solverErrSeen.add(c.once); }
      if (cat === session._solverErrCategory) session._solverErrCount++;
      else { session._solverErrCategory = cat; session._solverErrCount = 1; }
      ws.send(JSON.stringify({ type: 'term', line: `[错误预算] ${cat} 第 ${session._solverErrCount}/3 次` }));
      if (session._solverErrCount < 3) return false;
      session._pendingErrBudgetMsg = `[系统·错误预算耗尽] 同一类求解器错误「${cat}」已连续出现 ${session._solverErrCount} 次，说明当前修复思路无效。立即停止重试，向用户汇报：①三次尝试各改了什么；②错误证据（log 片段）；③你判断的根因；④2–3 个备选方案供用户选择。不要再启动求解器。`;
      notifyEvent({ kind: 'error', key: `errbudget:${session.task?.id}`, level: 'high', taskId: session.task?.id, title: `🛑 同类求解错误 3 次：${session.task?.title || ''}`, body: cat });
      resetSolverErrBudget();
      session._endReasonDetail = 'awaiting_user';
      return true;
    }
    function fp(name, args) {
      try { return name + ':' + JSON.stringify(args).slice(0, 240); } catch { return name + ':?'; }
    }
    function consecutiveDupes() {
      if (recentFP.length < 2) return 0;
      const last = recentFP[recentFP.length - 1];
      let n = 1;
      for (let i = recentFP.length - 2; i >= 0 && recentFP[i] === last; i--) n++;
      return n;
    }
    const maxSteps = Math.max(10, Number(SETTINGS.maxAutoSteps) || MAX_AUTO_STEPS_DEFAULT);
    session._budgetExhausted = false;
    // A3: budget 续跑独立计数（与 wakeCount 分开），防止预算耗尽反复续跑无上限
    if (!resume) session._budgetResumeCount = 0;
    for (let step = 0; step < maxSteps; step++) {
      if (step === maxSteps - 1) session._budgetExhausted = true;
      if (session.aborted) { ws.send(JSON.stringify({ type: 'term', line: '[已停止]' })); break; }
      // 🧭 Codex 式引导：把运行中用户插入的新消息注入本步上下文，智能体据此调整后续思路
      if (Array.isArray(session._steerQueue) && session._steerQueue.length) {
        const steers = session._steerQueue.splice(0);
        for (const st of steers) {
          const content = await buildUserContent(`【用户引导 · 运行中插入】${st.text}\n（请把这条新要求纳入当前任务：必要时用 update_todos 调整计划和后续步骤，不要从头重来）`, st.attachments || []);
          session.messages.push({ role: 'user', content });
        }
        noToolStreak = 0;
        ws.send(JSON.stringify({ type: 'term', line: `[引导] 已把 ${steers.length} 条新输入注入智能体上下文，后续步骤将据此调整` }));
        persistSession(session);
      }
      // 首次出现报错时补注入错误排查协议（只重建一次系统提示，避免每步破坏提示缓存）
      if (session.foamMode && !session._errorProtocolOn && sessionHadError(session)) {
        session._errorProtocolOn = true;
        try { session.messages[0] = { role: 'system', content: buildSystemPrompt(session) }; } catch {}
      }
      await autoCompactIfNeeded(session, ws, session.aborter && session.aborter.signal);
      try { const g = pruneOldToolResults(session); if (g) ws.send(JSON.stringify({ type: 'term', line: `[上下文] 已裁剪旧工具输出约 ${Math.round(g / 1000)} k 字符` })); } catch {}
      try { Evolve.onLlmStep(session); } catch {}
      ws.send(JSON.stringify({ type: 'assistant_start' }));
      ws.send(JSON.stringify({ type: 'agent_phase', phase: 'llm_thinking', detail: `调用 LLM (第 ${step+1} 步)` }));
      let msg;
      // v0.7.4 诊断：读 signal 前判 null（aborter 被另一轮 runAgent 的 finally 清空 / stop 覆盖时优雅退出而非 crash）
      if (!session.aborter) {
        const why = `[诊断] runAgent#${myRunSeq} 第 ${step+1} 步发现 session.aborter=null（aborted=${session.aborted}），优雅退出`;
        console.warn(why);
        try { ws.send(JSON.stringify({ type: 'term', line: why })); } catch {}
        break;
      }
      const _abortSignal = session.aborter.signal;
      try { msg = await callLLM(session.messages, ws, _abortSignal, toolsForMode(session.enabledTools || DEFAULT_ENABLED, session.task && session.task.agentMode, session));
        // A6: LLM 熔断器 — 连续失败计数清零
        session._llmConsecFail = 0;
      }
      catch (e) { if (session.aborted) { ws.send(JSON.stringify({ type: 'term', line: '[已停止]' })); break; }
        // 上游拒收「上下文过长」：强制压缩一次再重发本步，不算故障
        if (e && e.contextOverflow && !session._overflowRetried) {
          session._overflowRetried = true;
          ws.send(JSON.stringify({ type: 'term', line: '[上下文] 上游提示上下文过长 → 强制压缩后重发本步' }));
          try { await autoCompactIfNeeded(session, ws, session.aborter && session.aborter.signal, true); } catch (e2) { console.warn('[compact]', e2 && e2.message); }
          for (const mm of session.messages) {
            if (mm.role === 'tool' && typeof mm.content === 'string' && mm.content.length > 6000) mm.content = mm.content.slice(0, 3500) + '\n…[上下文过长，已裁剪；需要细节就重新读文件/日志]…\n' + mm.content.slice(-1500);
          }
          ws.send(JSON.stringify({ type: 'assistant_end' }));
          step--; continue;
        }
        console.error(`[runAgent#${myRunSeq}] callLLM error @ step ${step+1}:`, (e && e.stack) || e);
        // A6: LLM 熔断器 — 连续失败 >= 3 次暂停并通知用户，避免无限报错重试
        session._llmConsecFail = (session._llmConsecFail || 0) + 1;
        if (session._llmConsecFail >= 3) {
          const errMsg = `[LLM 熔断] 连续 ${session._llmConsecFail} 次调用失败，已暂停。请检查：API Key / Base URL / 模型 ID 是否正确，或点「继续」重试。`;
          try { ws.send(JSON.stringify({ type: 'term', line: errMsg })); } catch {}
          notifyEvent({ kind: 'error', key: `llm-fail:${task?.id}`, level: 'high', taskId: task?.id, title: `⚠️ LLM 连续失败：${task?.title || ''}`, body: String(e.message || e).slice(0, 400) });
          session._llmConsecFail = 0;
          session._endReasonDetail = 'llm_circuit';
          ws.send(JSON.stringify({ type: 'error', message: errMsg })); break;
        }
        if (task && recoveryManager.version(task) === recoveryVersion) {
          syncTaskFromSession(session);
          recoveryManager.failure(task, e);
        }
        session._budgetExhausted = false;
        ws.send(JSON.stringify({ type: 'error', message: `[诊断 runAgent#${myRunSeq} step ${step+1}] ${String(e.message || e)}` })); break; }
      if (session.aborted) break;
      session.messages.push(msg);
      recoveryManager.success(task);
      session._overflowRetried = false;
      persistSession(session, true);
      ws.send(JSON.stringify({ type: 'assistant_end' }));
      const hasTools = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
      // 输出撞到长度上限 / 传输中断，且没有工具调用：让模型从断点接着做（对照 OpenCode，最多连续 2 次）
      if (!hasTools && (msg._finish === 'length' || msg._finish === 'interrupted')) {
        session._lengthCont = (session._lengthCont || 0) + 1;
        if (session._lengthCont <= 2) {
          const cut = msg._finish === 'length';
          session.messages.push({ role: 'user', content: cut
            ? '[系统] 你上一条回复撞到了输出长度上限被截断。不要道歉、不要复述已写的内容；把剩下的工作拆成更小的步骤，立刻用工具落地下一步（大文件分多次 write_file / edit_file）。'
            : '[系统] 你上一条回复在传输中被中断。不要道歉、不要重复已写的内容，从中断处接着做；该调用工具就直接调用。' });
          ws.send(JSON.stringify({ type: 'term', line: `[${cut ? '输出截断' : '回复中断'}] 第 ${session._lengthCont}/2 次 → 已要求模型接着做` }));
          continue;
        }
        session._lengthCont = 0;
      } else session._lengthCont = 0;
        // V4 人在回路：assistant 文本里抛出编号选项且无 tool_call → 强制停下等用户回复
        try {
          if (!hasTools && typeof msg.content === 'string' && msg.content.trim()) {
            const c = msg.content;
            const numbered = (c.match(/(^|\n)\s*[1-9][\)、.．]/g) || []).length;
            const hasOptionWord = /(请选择|请回复|请回|请选|哪个|选哪|你想|你要|确认一下|要不要|是否|回[\s]?[1-9]\s*[\/、]\s*[1-9])/.test(c);
            const endsWithQ = /[?？]\s*$/.test(c.trim());
            const _liveQ = _liveRunOf(session);
            const _qMuted = !!_liveQ && (session._choiceTimeouts || 0) >= 2;
            if (_qMuted && !session._qMuteNoted && (numbered >= 2 || (hasOptionWord && (endsWithQ || numbered >= 1)))) {
              // 同一问题已超时 ≥2 次：用户不在，停止每小时重复提问/重新计时的空转循环
              session._qMuteNoted = true;
              ws.send(JSON.stringify({ type: 'term', line: `[人在回路] 问题已超时 ${session._choiceTimeouts} 次 → 不再重复提问/计时，问题保留，用户回复时插入` }));
              session.messages.push({ role: 'user', content: `[系统] 这个问题已经超时 ${session._choiceTimeouts} 次，用户暂时不在。不要在之后的回复里重复提问或重复写"第 N 次未回复"，问题已保留，用户回复会作为引导插入。如果任务原文或之前的用户消息已经批准过这个动作，就按批准执行；否则继续推进其余待办（用 solver_wait 等作业）。` });
              continue;
            }
            if (!_qMuted && (numbered >= 2 || (hasOptionWord && (endsWithQ || numbered >= 1)))) {
              await Fidelity.noteCase(session, _taskCaseDir(session.task)).catch(() => []);
              const liveRun = _liveQ;
              _scheduleChoiceTimeout(session, ws, !!liveRun);
              if (liveRun && !session._questionCarried) {
                // 有长作业在跑：提问不收尾，问题挂起，先做不依赖该决定的工作；用户回复走引导队列插入
                session._questionCarried = true;
                session.pendingQuestion = { text: c.slice(0, 2000), ts: Date.now() };
                notifyEvent({ kind: 'question', key: `q:${session.task?.id}`, level: 'high', taskId: session.task?.id,
                  title: `❓ 智能体在等你决定：${session.task?.title || ''}`, body: c.slice(-600) });
                ws.send(JSON.stringify({ type: 'agent_phase', phase: 'awaiting_user', detail: '问题已提交，agent 继续做不依赖该决定的工作' }));
                ws.send(JSON.stringify({ type: 'term', line: `[人在回路·非阻塞] 作业 ${liveRun.runId} 在跑 → 问题已挂起，agent 继续工作；${_choiceTimeoutMin()} 分钟未回复将按其推荐方案执行` }));
                session.messages.push({ role: 'user', content: `[系统] 你的问题已转给用户。作业 ${liveRun.runId} 仍在运行，不要结束本轮空等：先做不依赖这个决定的待办（后处理脚本、报告框架、健康检查，用 solver_wait 定时等待），暂不执行任何选项。用户回复会作为引导插入；${_choiceTimeoutMin()} 分钟内没回复，系统会通知你按推荐方案执行。` });
                continue;
              }
              session.awaitingUserChoice = true;
              notifyEvent({ kind: 'question', key: `q:${session.task?.id}`, level: 'high', taskId: session.task?.id,
                title: `❓ 智能体暂停等待你的回复：${session.task?.title || ''}`, body: c.slice(-600) });
              ws.send(JSON.stringify({ type: 'agent_phase', phase: 'awaiting_user', detail: '等待用户回复选项 / 确认' }));
              ws.send(JSON.stringify({ type: 'term', line: '[人在回路] Agent 抛出选项 → 已暂停等待你的回复（V4）' }));
              break;
            }
          }
        } catch {}
      if (hasTools) {
        noToolStreak = 0;       // 本轮有真实工具调用 → 清空空转计数
        let stop = false;
        // 已完成响应的 tool_call_id 集合；若 abort 中断，把剩余未响应的 tool_calls 用占位补齐，
        // 否则下一轮发给 LLM 会因「assistant.tool_calls 无配对 tool 响应」而被 OpenAI 拒收 400。
        const respondedIds = new Set();
        const allCallIds = msg.tool_calls.map(tc => tc.id);
        // v0.8.0: 扩展只读工具集 + 分桶并行
        // 思路：把 tool_calls 序列从左到右扫描，遇到连续只读段就 Promise.all（并发上限 4），
        //       遇到非只读或需审批就单独串行执行。这样混合批次也能受益，不再退化全串行。
        const READONLY = new Set([
          'list_dir', 'read_file', 'grep_search', 'glob', 'web_search', 'fetch_url',
          'paper_search', 'paper_fetch', 'read_paper',
          'foam_residual_series', 'foam_mesh_quality', 'foam_solver_status',
          'foam_inspect_case', 'foam_find_tutorial', 'foam_find_source',
          'mfix_solver_status', 'lbm_solver_status',
          'run_status_load', 'foam_postproc_list', 'foam_postproc_stats'
        ]);
        const PARALLEL_CAP = 4;
        const isReadonly = (tc) => READONLY.has(tc.function.name) && !NEEDS_APPROVAL.has(tc.function.name);
        const calls = msg.tool_calls.slice();
        let cursor = 0;
        while (cursor < calls.length) {
          if (session.aborted) { stop = true; break; }
          // 收集从 cursor 开始的连续只读段
          let end = cursor;
          while (end < calls.length && isReadonly(calls[end])) end++;
          const roBatch = calls.slice(cursor, end);
          if (roBatch.length >= 2) {
            ws.send(JSON.stringify({ type: 'term', line: `[Parallel] 并行执行 ${roBatch.length} 个只读工具（cap=${PARALLEL_CAP}）` }));
            const results = new Array(roBatch.length);
            let idx = 0;
            const worker = async () => {
              while (true) {
                const my = idx++;
                if (my >= roBatch.length) return;
                if (session.aborted) return;
                const tc = roBatch[my];
                const name = tc.function.name;
                let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
                try { ws.send(JSON.stringify({ type: 'tool_call', id: tc.id, name, args })); } catch {}
                try { results[my] = await execToolWithProgress(name, args, session, ws); }
                catch (e) { results[my] = `执行失败：${e.message || e}`; }
              }
            };
            try {
              await Promise.all(Array.from({ length: Math.min(PARALLEL_CAP, roBatch.length) }, worker));
            } catch (e) {
              ws.send(JSON.stringify({ type: 'error', message: `并行工具异常：${e.message || e}` }));
            }
            for (let i = 0; i < roBatch.length; i++) {
              const tc = roBatch[i]; const name = tc.function.name; const result = results[i] ?? '[并行执行无返回]';
              ws.send(JSON.stringify({ type: 'tool_result', id: tc.id, name, result }));
              session.messages.push({ role: 'tool', tool_call_id: tc.id, content: clipForHistory(result, name) });
              let _wmArgs = {}; try { _wmArgs = JSON.parse(tc.function.arguments || '{}'); } catch {}
              captureToolSignal(session, name, result, _wmArgs);
              trackSolverError(name, result, _wmArgs);
              respondedIds.add(tc.id);
              recentFP.push(fp(name, (() => { try { return JSON.parse(tc.function.arguments || '{}'); } catch { return {}; } })()));
              if (recentFP.length > 12) recentFP.shift();
            }
            persistSession(session);   // 并行批结束落盘（防抖）
            cursor = end;
            if (session.aborted) { stop = true; break; }
            if (session.taskComplete) { stop = true; break; }
            continue;
          }
          // 单个工具 → 串行
          const tc = calls[cursor]; cursor++;
          if (session.aborted) { stop = true; break; }
          const name = tc.function.name;
          let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
          ws.send(JSON.stringify({ type: 'tool_call', id: tc.id, name, args }));
          if (NEEDS_APPROVAL.has(name)) {
            // Auto 模式下自动放行（用户可随时点 ⏹ 停止）
            if (session.autoMode) {
              ws.send(JSON.stringify({ type: 'term', line: `[Auto 批准] ${name}: ${args.command || args.case_path || ''}` }));
            } else {
              if (session.task) { session.task.awaitingApproval = true; persistTaskNow(session.task); }
              notifyEvent({ kind: 'approval', key: `ap:${session.task?.id}`, level: 'high', taskId: session.task?.id,
                title: `🔐 需要审批：${name}`, body: `${session.task?.title ? `任务：${session.task.title}\n` : ''}${String(args?.command || args?.case_path || args?.path || JSON.stringify(args || {})).slice(0, 500)}` });
              const ok = await new Promise((res) => { session.pendingApproval = res; ws.send(JSON.stringify({ type: 'approval_request', id: tc.id, name, args })); });
              session._recoveryApprovalBlocked = false;
              persistSession(session, true);
              if (session.aborted) { stop = true; break; }
              if (!ok) { const r = '用户拒绝执行。';
                ws.send(JSON.stringify({ type: 'tool_result', id: tc.id, name, result: r }));
                session.messages.push({ role: 'tool', tool_call_id: tc.id, content: r });
                respondedIds.add(tc.id);
                continue; }
            }
          }
          let result; try { ws.send(JSON.stringify({ type: 'agent_phase', phase: 'tool_exec', detail: `执行 ${name}`, tool: name })); result = await execToolWithProgress(name, args, session, ws); } catch (e) { result = `执行失败：${e.message || e}`; }
          ws.send(JSON.stringify({ type: 'tool_result', id: tc.id, name, result }));
          ws.send(JSON.stringify({ type: 'agent_phase', phase: 'tool_done', detail: `${name} 返回`, tool: name }));
          session.messages.push({ role: 'tool', tool_call_id: tc.id, content: clipForHistory(result, name) });
          captureToolSignal(session, name, result, args);
          if (trackSolverError(name, result, args)) stop = true;
          respondedIds.add(tc.id);
          persistSession(session);   // 边跑边落盘（防抖 3s），服务崩溃/重启也不丢上下文
          if (MODIFYING.has(name)) broadcastCheckpoints(ws);
          // 重复检测：同一工具+同一参数 连续调用
          recentFP.push(fp(name, args)); if (recentFP.length > 12) recentFP.shift();
          const dup = consecutiveDupes();
          if (dup >= 5) {
            ws.send(JSON.stringify({ type: 'term', line: `[循环保护] 检测到 ${name} 连续 ${dup} 次同参调用，已强制中断。` }));
            session.messages.push({ role: 'user', content: `[系统] 你连续${dup}次以完全相同的参数调用 ${name}，这是循环。请立即停下来，总结已得到的结果，如需继续请换一种思路或调用 task_complete。` });
            stop = true; break;
          } else if (dup === 3 && !warnedDup) {
            warnedDup = true;
            session.messages.push({ role: 'user', content: `[提示] 检测到 ${name} 以相同参数被调用 ${dup} 次。如果结果一样，换个思路或使用不同的参数/工具，不要被动刷同样的试探。` });
          }
          if (session.taskComplete) { stop = true; break; }
        }
        // 关键：中断/终止前补齐剩余未响应的 tool_call，避免下一轮 400
        for (const id of allCallIds) if (!respondedIds.has(id)) {
          session.messages.push({ role: 'tool', tool_call_id: id, content: '[未执行：流程中断]' });
        }
        // HC-4: tool 结果补齐后再注入错误预算提示（保持 tool_call/tool 顺序合法），下一轮模型只做汇报
        if (session._pendingErrBudgetMsg) {
          session.messages.push({ role: 'user', content: session._pendingErrBudgetMsg });
          session._pendingErrBudgetMsg = null;
          session._errBudgetReport = true;
          stop = false;
        }
        if (stop) break;
        continue;
      }
      if (session.taskComplete) break;
      // ── 反空转守卫：本轮没有任何工具调用（model 只输出文字/计划，零进展）──
      // HC-4: 错误预算耗尽后模型已做汇报 → 直接停下等用户，不走反空转催促
      if (session._errBudgetReport) { session._errBudgetReport = false; session._endReasonDetail = 'awaiting_user'; break; }
      noToolStreak++;
      const undone = (session.todos || []).filter(t => !t.done);
      // 识别「嘴上说要动手、却没调工具」的叙述（让我开始写/让我先创建目录/接下来我来…）——这正是空转卡死的症状
      const narratesAction = typeof msg.content === 'string' &&
        /(让我(先|来|现在|直接)?\s*(创建|编写|写|开始|建立|生成|实现)|接下来\s*(我)?\s*(来|要|将)|现在\s*(我)?\s*(来|开始)|我(将|来)\s*(创建|编写|写|实现)|首先[^。\n]{0,24}(创建|编写|建立|写)|\b(let me|i'?ll|i will|i'?m going to|next,? i(?:'ll| will)?|now i(?:'ll| will)?)\s+(?:now\s+|first\s+|go ahead and\s+)?(create|write|start|begin|set up|generate|implement|build|run|edit|update|add|fix)\b)/i.test(msg.content);
      // 任务进行中（有未完成待办）或 出现「只说不做」叙述 → 强力催它立刻落地一个工具
      if ((undone.length > 0 || narratesAction) && noToolStreak <= 2 && !session.awaitingUserChoice) {
        nudgeCount++;
        const todoLine = undone.length ? `仍有 ${undone.length} 项待办未完成：\n` + undone.map((t,i)=>`${i+1}. ${t.text}`).join('\n') + '\n' : '';
        session.messages.push({ role: 'user', content: `[系统·反空转] 你这一轮只输出了文字、**没有调用任何工具**，等于零进展。${todoLine}请**立即**调用一个工具落地下一步具体动作：写代码就直接 \`write_file\` 把完整文件写进去、要跑就 \`run_command\`、要改就 \`edit_file\`；如确已全部完成就调 \`task_complete\`。不要再复述计划、不要重复"让我开始/让我先创建"这类话。` });
        ws.send(JSON.stringify({ type: 'term', line: `[反空转 ${noToolStreak}/2] Agent 只规划不动手 → 已强催其调用工具落地` }));
        continue;
      }
      // 连续 ≥3 轮仍在空转 → 停下交给用户，避免无限"让我开始写代码"循环
      if (noToolStreak >= 3) {
        // 无人值守模式（autoMode/headless）最多额外注入 3 次紧急催促，再停下；避免长程任务因一轮文字输出就卡住
        // A4: 区分真实思考 vs 空转叙述：只有在有未完成待办 or narratesAction 时才触发催促
        // A4: 若内容是实质性的分析/规划（无叙述 pattern 且无未完成待办）→ 允许一轮纯文字后正常结束
        const _unattended = session.autoMode || ws.isHeadless;
        if (_unattended && noToolStreak < 6) {
          try { ws.send(JSON.stringify({ type: 'term', line: `[反空转 ${noToolStreak}] 无人值守模式：注入紧急催促，继续推进` })); } catch {}
          session.messages.push({ role: 'user', content: `[系统·反空转 ${noToolStreak}/5] 你已连续 ${noToolStreak} 轮只输出文字而未调用工具。当前是无人值守/自动模式——请立即行动：选一个最关键的待办直接调用工具（不要先说"我来……"，直接调）。若真需用户决定才能继续，调 task_complete({passed:false, memo:"需要用户输入：xxx"}) 停下并说明原因。` });
          continue;
        }
        // A2: 细化 endReason — stalled（真空转）vs awaiting_user（等用户）
        session._endReasonDetail = session.awaitingUserChoice ? 'awaiting_user' : 'stalled';
        try { ws.send(JSON.stringify({ type: 'term', line: '[反空转] Agent 连续多轮只规划、不调用工具，已暂停本轮。请补充更明确的指令或点继续。' })); } catch {}
        break;
      }
      // 正常收尾前若还有运行中插入的引导 → 不收尾，继续循环消费新输入
      if (Array.isArray(session._steerQueue) && session._steerQueue.length) continue;
      // 🎯 目标门（对齐 OpenChamber Session Goal）：目标未确认达成且未在问用户 → 续推，最多 3 次
      const goal = task && task.goal;
      if (goal && goal.status === 'active' && !session.awaitingUserChoice && task.agentMode !== 'plan' && (goal.nudges || 0) < 3) {
        goal.nudges = (goal.nudges || 0) + 1;
        session.messages.push({ role: 'user', content: `[系统·目标门 ${goal.nudges}/3] 会话目标尚未确认达成：${goal.text}${goal.criteria ? '\n验收标准：' + goal.criteria : ''}\n请对照验收标准自检：已满足 → 调 task_complete 并逐条给证据；未满足 → 立即调用工具推进下一步；被阻塞 → 说明原因并向用户提问。` });
        ws.send(JSON.stringify({ type: 'term', line: `[目标门 ${goal.nudges}/3] 目标未确认达成 → 继续推进` }));
        continue;
      }
      // 🏁 完成门：工具执行完但未 task_complete 也无剩余待办 → autoMode 下催促一次收尾
      if (!session.taskComplete && !session.aborted && session.autoMode && completionNudge < 1 &&
          !session.awaitingUserChoice && !session.pendingQuestion) {
        const _lastMsg = session.messages[session.messages.length - 1];
        if (_lastMsg && _lastMsg.role === 'tool') {
          completionNudge++;
          const _undoneC = (session.todos || []).filter(t => !t.done).length;
          session.messages.push({ role: 'user', content: `[系统·完成门] 工具调用已完成，但没有调 task_complete${_undoneC ? '，还有 ' + _undoneC + ' 项待办' : '，也没有剩余待办'}。若任务已全部完成，请调 task_complete({passed:true,summary:"完成摘要"})；若还有工作，请调 update_todos 补充并继续执行。` });
          try { ws.send(JSON.stringify({ type: 'term', line: '[完成门] 工具完成但未 task_complete → 催促收尾' })); } catch {}
          continue;
        }
      }
      break;
    }
  } finally {
    console.log(`[runAgent #${myRunSeq}] ended (aborted=${session.aborted}, taskComplete=${session.taskComplete})`);
    session.currentCheckpoint = null; session.aborter = null; session._running = false;
    persistSession(session, true);   // 轮次结束立即落盘任务上下文
    syncTaskObservers(session, sessions.values());
    broadcastTaskState();
    // 自进化：本轮若被 verifier 盖章通过，提示可沉淀经验（opt-in，不自动写库）
    try {
      const draft = SkillLib.draftFromTrajectory({ userText, messages: session.messages, modes: { foam: session.foamMode, mfix: session.mfixMode, lbm: session.lbmMode }, facts: workMemToSkillFill(session) });
      if (draft) {
        ws.send(JSON.stringify({ type: 'skill_distill', draft }));
        ws.send(JSON.stringify({ type: 'term', line: `[经验沉淀] 本轮已通过 verifier（${(draft.provenance.verified_by || []).join(', ') || 'stage'}）→ 可调 skill_save 把可复用配方存成独立技能卡。` }));
      }
      // 新报错自动学习：不再依赖模型自觉调 learn_error_pattern
      const novel = (session._novelErrors || []).splice(0);
      if (novel.length && !session.aborted && SkillLib.analyzeTrajectory(session.messages).verified) {
        const traj = session.messages.slice(-40).map(m => `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 400) : ''}`).join('\n');
        Fidelity.autoLearnErrors(novel, traj, (sys, u) => llmOneShot(sys, u, { maxTokens: 600 }), (p) => SkillLib.addErrorPattern(p))
          .then(cats => { if (cats.length) try { ws.send(JSON.stringify({ type: 'term', line: `[经验沉淀] 已自动登记 ${cats.length} 条新报错模式：${cats.join('；')}` })); } catch {} })
          .catch(e => console.warn('[autoLearn]', e.message));
      }
    } catch {}
    // 步数预算耗尽但任务未完成 → 自动续跑（与作业唤醒共用 wakeCount 上限），否则长程任务会在中途静默停摆
    const undoneLeft = (session.todos || []).filter(t => !t.done).length;
    const _hasLiveSolver = typeof SOLVER_RUNS !== 'undefined' ? [...SOLVER_RUNS.values()].some(r => !r.ended && r.ownerTaskId === (session.task && session.task.id)) : false;
    const wasExhausted = session._budgetExhausted; // A2 fix: 先保存再清零，否则 budget_exhausted reason 永远不可达
    const budgetCont = wasExhausted && !session.aborted && !session.taskComplete && (undoneLeft > 0 || (session.autoMode && _hasLiveSolver)) && session.task && SETTINGS.autoResume !== false;
    session._budgetExhausted = false;
    if (budgetCont) {
      const task = session.task;
      // A3: budget 续跑用独立计数器，最多 3 次自动续跑，之后交还用户
      session._budgetResumeCount = (session._budgetResumeCount || 0) + 1;
      const budgetMax = Number.isInteger(SETTINGS.budgetResumeMax) && SETTINGS.budgetResumeMax >= 0 ? SETTINGS.budgetResumeMax : 3;
      if (session._budgetResumeCount <= budgetMax) {
        const txt = `[系统·步数预算用尽自动续跑 ${session._budgetResumeCount}/${budgetMax}] 上一轮已用完单轮步数上限，任务还有 ${undoneLeft} 项待办。请先 run_status_load 和 foam_solver_status/日志确认后台作业状态（可能已结束或崩溃），再从中断处继续，不要从头重来。`;
        ws.send(JSON.stringify({ type: 'term', line: `[自动续跑] 步数预算用尽但仍有 ${undoneLeft} 项待办 → 3s 后自动继续 (${session._budgetResumeCount}/${budgetMax})` }));
        setTimeout(() => {
          if (session._running || session.aborted) return;
          if (task.recovery && !['idle', 'cancelled'].includes(task.recovery.status)) return;
          try { session.messages[0] = { role: 'system', content: buildSystemPrompt(session) }; } catch {}
          if (ws.isHeadless && !sessions.has(ws)) sessions.set(ws, session);
          runAgent(ws, txt, []).catch(e => console.warn('[budget-cont] 失败:', e.message));
        }, 3000);
      } else {
        ws.send(JSON.stringify({ type: 'term', line: `[自动续跑] 已连续自动续跑 ${budgetMax} 次仍用尽预算，暂停；发一条消息即可继续。` }));
        notifyEvent({ kind: 'info', key: `budget-pause:${task?.id}`, level: 'medium', taskId: task?.id, title: `⏸ 步数预算耗尽：${task?.title || ''}`, body: `已连续 ${budgetMax} 次自动续跑仍用尽步数预算。可能需要拆分任务或检查是否有死循环。发一条消息即可继续。` });
      }
    }
    // 运行刚结束时还排着队的引导（收尾/完成瞬间发来的）→ 作为新一轮继续，不丢消息
    const leftoverSteers = Array.isArray(session._steerQueue) ? session._steerQueue.splice(0) : [];
    if (leftoverSteers.length && !session.aborted && ws.readyState === 1) {
      const txt = leftoverSteers.map(x => x.text).join('\n');
      const atts = leftoverSteers.flatMap(x => x.attachments || []);
      ws.send(JSON.stringify({ type: 'term', line: '[引导] 上一轮刚结束，你的新输入作为新一轮继续' }));
      setImmediate(() => { try { session.messages[0] = { role: 'system', content: buildSystemPrompt(session) }; runAgent(ws, txt, atts); } catch (e) { console.warn('[steer] 续跑失败:', e.message); } });
    }
    // A2: 细化 endReason — 区分 budget_exhausted / stalled / awaiting_user / llm_circuit / complete / stopped
    let _endReason;
    if (session.aborted) _endReason = 'stopped';
    else if (session.taskComplete) _endReason = 'complete';
    else if (session._endReasonDetail === 'llm_circuit') _endReason = 'error';
    else if (session._endReasonDetail === 'awaiting_user') _endReason = 'awaiting_user';
    else if (session._endReasonDetail === 'stalled') _endReason = 'stalled';
    else if (wasExhausted) _endReason = 'budget_exhausted'; // A2 fix: 用 wasExhausted（清零前保存）
    else _endReason = 'paused';
    session._endReasonDetail = null; // reset for next run
    const _canContinue = !session.aborted && !session.taskComplete;
    ws.send(JSON.stringify({ type: 'agent_end', reason: _endReason, canContinue: _canContinue, state: (typeof getTaskState === 'function' ? getTaskState(session) : _endReason) }));
    broadcastCheckpoints(ws);
    // A7: awaiting_user 超 10 min 通知
    if (_endReason === 'awaiting_user' && session.task) {
      clearTimeout(session._idleNotifyTimer);
      session._idleNotifyTimer = setTimeout(() => {
        session._idleNotifyTimer = null;
        if (!session._running && (session.awaitingUserChoice || session.pendingQuestion)) {
          notifyEvent({ kind: 'question', key: `idle:${session.task?.id}`, level: 'high',
            taskId: session.task?.id,
            title: `⏰ Agent 在等你 · ${session.task?.title || '任务'}`,
            body: '智能体已暂停超过 10 分钟，等待你回复或确认。' });
        }
      }, 10 * 60 * 1000);
      if (session._idleNotifyTimer?.unref) session._idleNotifyTimer.unref();
    }
    if (session.task && session.task._runningSession === session) session.task._runningSession = null;
    if (ws.isHeadless && !(leftoverSteers.length && !session.aborted)) { sessions.delete(ws); _flushWake(session.task && session.task.id); }
  }
}

// ── 提问超时：用户长时间不回复时按推荐方案继续，避免长程任务空等 ──
function _choiceTimeoutMin() { return Number(SETTINGS.choiceTimeoutMin ?? 60); }
function _liveRunOf(session) {
  const tid = session.task && session.task.id;
  if (!tid) return null;
  for (const r of SOLVER_RUNS.values()) if (!r.ended && r.ownerTaskId === tid) return r;
  return null;
}
function _scheduleChoiceTimeout(session, ws, hasLiveRun) {
  const min = _choiceTimeoutMin();
  // 无作业在跑的交互式会话：用户可能正在思考，不自动替他决定（除非 autoMode 无人值守）
  if (!(min > 0) || !session.task || !(hasLiveRun || session.autoMode)) return;
  clearTimeout(session._choiceTimer);
  session._choiceTimer = setTimeout(() => {
    session._choiceTimer = null;
    if (session.aborted || !(session.awaitingUserChoice || session.pendingQuestion)) return;
    if (session.task.recovery && !['idle', 'cancelled'].includes(session.task.recovery.status)) return;
    session.awaitingUserChoice = false; session.pendingQuestion = null; session._questionCarried = false;
    session._choiceTimeouts = (session._choiceTimeouts || 0) + 1;
    const txt = `[系统·用户 ${min} 分钟未回复] 按你上一个问题里推荐的方案继续执行，并在偏离日志/报告中注明"用户未回复，按推荐方案执行"。例外：若推荐方案会丢弃已算结果、停止在跑的作业、修改论文物理量，或问题是在请用户批准几何/边界条件/模型的简化与偏离（偏离日志里状态为 PENDING 的条目、Pre-Flight 确认），则不要执行、也不要自行把偏离改成已批准，改做不依赖该决定的待办，问题继续保留。`;
    try { ws.send(JSON.stringify({ type: 'term', line: `[提问超时] ${min} 分钟未收到回复 → 按 agent 推荐方案继续` })); } catch {}
    if (session._running) { (session._steerQueue || (session._steerQueue = [])).push({ text: txt, attachments: [] }); return; }
    let w = ws, s = session;
    if (ws.readyState !== 1 || !sessions.has(ws)) { if (!session.task) return; ({ ws: w, s } = _makeHeadlessSession(session.task)); }
    try { s.messages[0] = { role: 'system', content: buildSystemPrompt(s) }; } catch {}
    runAgent(w, txt, []).catch(e => console.warn('[choice-timeout] runAgent 失败:', e.message));
  }, min * 60000);
  if (session._choiceTimer.unref) session._choiceTimer.unref();
}

// ── 作业结束自动唤醒：后台求解跑完时 agent 早已退出循环，这里按任务把 agent 叫回来接着干 ──
const _wakePending = new Map();   // taskId -> { runs: [run], timer }
function _scheduleWake(run) {
  if (SETTINGS.autoResume === false) return;
  if (!run.ownerTaskId || run._reported || run._userStopped) return;
  run._reported = true;
  let p = _wakePending.get(run.ownerTaskId);
  if (!p) { p = { runs: [], timer: null }; _wakePending.set(run.ownerTaskId, p); }
  p.runs.push(run);
  clearTimeout(p.timer);
  // 防抖：参数扫描常常一批作业前后脚结束，合并成一次唤醒
  p.timer = setTimeout(() => _flushWake(run.ownerTaskId), 3000);
}
function _superseded(r) {
  if (r._seenEnded) return true;
  for (const o of SOLVER_RUNS.values()) if (o !== r && o.casePath === r.casePath && o.started > r.started && o.ownerTaskId === r.ownerTaskId) return true;
  return false;
}
function _sessionsForTask(task) {
  return [...sessions.entries()].filter(([w, s]) => s.task === task && w.readyState === 1);
}
function _flushWake(taskId) {
  const p = taskId && _wakePending.get(taskId);
  if (!p || !p.runs.length) return;
  const task = TASKS.get(taskId);
  if (!task) { _wakePending.delete(taskId); return; }
  if (task.recovery && !['idle', 'cancelled'].includes(task.recovery.status)) return;
  const running = task._runningSession && task._runningSession._running ? task._runningSession : null;
  // 智能体已经知道结果的作业不再通知：启动检查里已看到它退出，或同一算例后来又启动了新作业（旧的失败已被修掉重跑）
  const runs = p.runs.splice(0).filter(r => !_superseded(r));
  _wakePending.delete(taskId);
  if (!runs.length) return;
  const text = '[系统·后台作业结束] 以下作业已结束，请检查结果（日志尾 / 残差 / postProcessing 统计）后继续未完成的待办；全部完成则调 task_complete，失败则诊断并修正。\n\n'
    + runs.map(r => _runSummary(r, 30)).join('\n\n');
  if (running) {
    (running._steerQueue || (running._steerQueue = [])).push({ text, attachments: [], system: true });
    return;
  }
  const max = Number(SETTINGS.autoResumeMax) || 20;
  task.wakeCount = (task.wakeCount || 0) + 1;
  if (task.wakeCount > max) {
    const note = JSON.stringify({ type: 'term', line: `[自动续跑] 任务「${task.title}」已连续自动唤醒 ${max} 次，暂停自动续跑；发一条消息即可继续。` });
    for (const c of allClients) if (c.readyState === 1) c.send(note);
    return;
  }
  const attached = _sessionsForTask(task).filter(([w]) => !w.isHeadless);
  if (task.awaitingApproval || task.awaitingUserChoice || attached.some(([, as]) => as.awaitingUserChoice || as.pendingApproval)) {
    for (const [w] of attached) w.send(JSON.stringify({ type: 'term', line: `[后台作业结束] ${runs.map(r => r.runId).join(',')}；agent 正在等你回复，未自动续跑` }));
    return;
  }
  let ws, s;
  if (attached.length) { [ws, s] = attached[0]; }
  else { ({ ws, s } = _makeHeadlessSession(task)); }
  try { s.messages[0] = { role: 'system', content: buildSystemPrompt(s) }; } catch {}
  for (const [w] of _sessionsForTask(task)) if (w !== ws && !w.isHeadless) w.send(JSON.stringify({ type: 'term', line: `[自动续跑] 后台作业结束，任务「${task.title}」已自动唤醒` }));
  ws.send(JSON.stringify({ type: 'term', line: `[自动续跑 ${task.wakeCount}/${max}] 后台作业 ${runs.map(r => r.runId).join(',')} 已结束 → 唤醒 agent 继续` }));
  runAgent(ws, text, []).catch(e => console.warn('[wake] runAgent 失败:', e.message));
}
// ── 多模型运行 ──
// 每个模型一个任务（task.multiRun = { group, index, of, dir }），在 multirun/<group>/<模型>/ 下工作，互不覆盖文件；
// 求解核数按空闲核数平分给各个模型，避免几个模型同时开大算例把机器挤爆
const MULTI_RUNS = new Map();   // group -> { group, text, createdAt, taskIds, dir }
function _slugModel(m) { return String(m).toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'model'; }
function multiRunStart(text, refs, { autoMode = true, agentMode = 'build', attachments = [] } = {}) {
  const group = 'mr' + Date.now().toString(36);
  const dirRel = `multirun/${group}`;
  const total = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  let busy = 0; try { busy = [..._foamProcs().values()].reduce((a, g) => a + g.np, 0); } catch {}
  const share = Math.max(1, Math.floor(Math.max(1, total - busy) / refs.length));
  const tasks = [];
  refs.forEach((ref, i) => {
    const slug = _slugModel(ref.model) + (refs.filter((r, j) => j < i && _slugModel(r.model) === _slugModel(ref.model)).length ? `-${i + 1}` : '');
    const dir = path.join(WORKSPACE, dirRel, slug);
    try { fssync.mkdirSync(dir, { recursive: true }); } catch {}
    const t = createTask(`${text.slice(0, 28)} · ${ref.model}`);
    t.modelRef = ref; t.autoMode = autoMode; t.agentMode = agentMode === 'plan' ? 'plan' : 'build';
    t.multiRun = { group, index: i + 1, of: refs.length, dir: path.relative(WORKSPACE, dir).split(path.sep).join('/'), cores: share };
    t.taskText = text.slice(0, 4000);
    persistTaskNow(t);
    tasks.push({ id: t.id, model: modelLabel(ref), dir: t.multiRun.dir });
    const prompt = `【多模型运行 ${i + 1}/${refs.length}｜同一任务同时交给了 ${refs.length} 个模型，之后会并排比较结果】\n`
      + `- 你的工作目录：${t.multiRun.dir}/（所有新建和修改的文件、算例都放在这里，不要改别的目录，别的模型在旁边的目录里干同样的活）\n`
      + `- 求解并行核数最多 ${share} 个（几个模型同时在跑）\n`
      + `- 做完后用简短的结论收尾：做了什么、关键结果和数字、还有什么没做完\n\n${text}`;
    const { ws } = _makeHeadlessSession(t);
    setTimeout(() => runAgent(ws, prompt, attachments).catch(e => console.warn('[multi_run] 失败:', e.message)), 300 * i);
  });
  MULTI_RUNS.set(group, { group, text, createdAt: Date.now(), taskIds: tasks.map(x => x.id), dir: dirRel });
  broadcastTaskState();
  return { group, tasks, dirRel };
}
// 并排比较用：每个模型的状态、用量、最后的回答、产生的文件
function multiRunSummary(group) {
  const ts = [...TASKS.values()].filter(t => t.multiRun && t.multiRun.group === group).sort((a, b) => a.multiRun.index - b.multiRun.index);
  if (!ts.length) return null;
  const lastText = t => { for (let i = (t.messages || []).length - 1; i >= 0; i--) { const m = t.messages[i]; if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) return m.content.trim(); } return ''; };
  const files = rel => { const out = []; const walk = (d, depth) => { if (depth > 3 || out.length > 200) return; let es = []; try { es = fssync.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const f = path.join(d, e.name); if (e.isDirectory()) { if (!/^(processor\d+|\d+(\.\d+)?)$/.test(e.name)) walk(f, depth + 1); } else out.push(path.relative(WORKSPACE, f).split(path.sep).join('/')); } };
    walk(path.join(WORKSPACE, rel), 0); return out; };
  return { group, text: ts[0].taskText || '', createdAt: ts[0].createdAt, runs: ts.map(t => {
    const u = t.usageTotals || {};
    const steps = (t.messages || []).filter(m => m.role === 'assistant').length;
    const tools = (t.messages || []).reduce((a, m) => a + ((m.role === 'assistant' && m.tool_calls) ? m.tool_calls.length : 0), 0);
    const fl = files(t.multiRun.dir);
    return { id: t.id, title: t.title, model: modelLabel(t.modelRef), index: t.multiRun.index, dir: t.multiRun.dir,
      running: !!(t._runningSession && t._runningSession._running), awaiting: !!(t.awaitingApproval || t.awaitingUserChoice || t.pendingQuestion),
      updatedAt: t.updatedAt, startedAt: t.createdAt, steps, tools, calls: u.calls || 0, prompt: u.prompt || 0, completion: u.completion || 0,
      answer: lastText(t).slice(0, 6000), files: fl.slice(0, 60), fileCount: fl.length, picked: !!t.multiRun.picked };
  }) };
}

// 无浏览器连接时的"虚拟连接"：输出转发给后来打开这个任务的窗口，方便围观
function _makeHeadlessSession(task) {
  const ws = createTaskTransport(null, () => [...sessions]
    .filter(([, session]) => session.task === task).map(([transport]) => transport));
  const s = {
    messages: task.messages, checkpoints: [], currentCheckpoint: null, pendingEdits: [], todos: [], taskComplete: false,
    runState: { runId: null, label: '', stages: [], failCount: {}, memos: [], startedAt: 0 },
    autoMode: task.autoMode === true,
    foamMode: !!SETTINGS.foamMode, mfixMode: !!SETTINGS.mfixMode, lbmMode: !!SETTINGS.lbmMode, customMode: !!SETTINGS.customMode,
    enabledTools: new Set(DEFAULT_ENABLED),
    pendingApproval: null, aborter: null, aborted: false, currentProc: null, shell: null, shellCwd: WORKSPACE,
    awaitingUserChoice: false, _ws: ws,
  };
  for (const [mode, grp] of [['foamMode', [...TOOL_GROUPS.foam, ...TOOL_GROUPS.opt]], ['mfixMode', TOOL_GROUPS.mfix], ['lbmMode', TOOL_GROUPS.lbm]])
    if (s[mode]) for (const t of grp) s.enabledTools.add(t);
  attachSessionToTask(s, task);
  sessions.set(ws, s);
  return { ws, s };
}

function _canRecoverTask(task) {
  if (task.autoMode !== true || task.awaitingApproval || task.awaitingUserChoice || task.pendingQuestion) return false;
  if ([...sessions.values()].some(s => s.task === task &&
    (!s.autoMode || s.pendingApproval || s._recoveryApprovalBlocked || s.awaitingUserChoice || s.pendingQuestion))) return false;
  const answered = new Set((task.messages || []).filter(message => message.role === 'tool').map(message => message.tool_call_id));
  return !(task.messages || []).some(message => message.role === 'assistant' &&
    (message.tool_calls || []).some(call => !answered.has(call.id)));
}
function _recoveryNotice(task) {
  try { broadcastTaskState(); } catch {}
  const recovery = task.recovery;
  const detail = recovery.status === 'pending'
    ? (_canRecoverTask(task) ? `retry ${recovery.attempt}${recovery.keepAlive ? ' (keep-alive)' : '/8'} at ${new Date(recovery.nextAt).toISOString()}` : 'pending: manual mode / approval / incomplete tool history; send a message to continue')
    : recovery.status;
  const line = `[LLM recovery] ${task.title || task.id}: ${detail}; ${recovery.lastError}`;
  console.warn(line);
  if ((recovery.status === 'failed' || recovery.status === 'exhausted') && typeof notifyEvent === 'function') {
    notifyEvent({ kind: 'recovery_failed', key: `rec:${task.id}`, level: 'high', taskId: task.id,
      title: `⛔ 智能体中断且无法自动恢复：${task.title || task.id}`, body: String(recovery.lastError || '').slice(0, 500) });
  }
  for (const [ws] of _sessionsForTask(task)) {
    try { ws.send(JSON.stringify({ type: 'term', line })); } catch {}
  }
}
const recoveryManager = new RecoveryManager({
  persist: persistTaskNow,
  canResume: _canRecoverTask,
  isBusy: task => !!task._runningSession?._running || [...sessions.values()].some(s => s.task === task && s._running),
  notify: _recoveryNotice,
  // autoMode 长任务（文献复现等）：LLM 通路断开多久都不放弃，每 5 分钟重试一次，通路恢复即续跑
  keepAlive: task => !!task.autoMode && SETTINGS.recoveryKeepAlive !== false,
  resume: task => {
    const { ws } = _makeHeadlessSession(task);
    return runAgent(ws, '', [], { resume: true });
  },
});

const app = express();
// 远程访问口令：绑定非回环地址（手机 / 局域网）时启用，本机访问免口令
let ACCESS_TOKEN = '';
app.use(AccessAuth.authMiddleware(() => ACCESS_TOKEN));
app.use(express.json({ limit: '50mb' }));
// 欢迎页路由（必须放在 express.static 之前，否则会被 public/index.html 抢走 / 路由）
app.get('/', (req, res) => res.redirect('/app'));
app.get(['/welcome', '/welcome.html'], (req, res) => res.redirect('/app'));
app.get(['/app', '/app.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => res.json({ models: modelChoices(), workspace: WORKSPACE, model: SETTINGS.model, name: 'CFDriver', author: 'LZF', platform: process.platform, hasApiKey: !!SETTINGS.apiKey, hasParaviewExe: !!SETTINGS.paraviewExe, pythonPath: SETTINGS.pythonPath || '', provider: SETTINGS.provider || 'sf', baseUrl: SETTINGS.baseUrl || '', copilotModel: SETTINGS.copilotModel || 'gpt-4.1', copilotLoggedIn: !!COPILOT.ghToken }));
app.get('/api/settings', (req, res) => res.json({ ...SETTINGS, notify: undefined, apiKey: SETTINGS.apiKey ? '***' + SETTINGS.apiKey.slice(-4) : '', visionApiKey: SETTINGS.visionApiKey ? '***' + SETTINGS.visionApiKey.slice(-4) : '' }));
app.post('/api/settings', async (req, res) => {
  const u = req.body || {};
  try { validateApiUpdate(SETTINGS, u); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  if (u.apiKey !== undefined && !u.apiKey.startsWith('***')) SETTINGS.apiKey = u.apiKey;
  if (u.baseUrl !== undefined) SETTINGS.baseUrl = u.baseUrl;
  if (u.model !== undefined) SETTINGS.model = u.model;
  if (u.provider !== undefined) SETTINGS.provider = u.provider;
  if (u.copilotModel !== undefined) SETTINGS.copilotModel = u.copilotModel;
  if (u.paraviewExe !== undefined) SETTINGS.paraviewExe = u.paraviewExe;
  if (u.paraviewPython !== undefined) SETTINGS.paraviewPython = u.paraviewPython;
  if (u.openfoamBash !== undefined) SETTINGS.openfoamBash = u.openfoamBash;
  if (u.foamRoot !== undefined) SETTINGS.foamRoot = u.foamRoot;
  if (u.pythonPath !== undefined) SETTINGS.pythonPath = u.pythonPath;
  // V4.1 专用视觉路由
  if (u.visionProvider !== undefined) SETTINGS.visionProvider = u.visionProvider;
  if (u.visionBaseUrl !== undefined) SETTINGS.visionBaseUrl = u.visionBaseUrl;
  if (u.visionModel !== undefined) SETTINGS.visionModel = u.visionModel;
  if (u.visionApiKey !== undefined && !u.visionApiKey.startsWith('***')) SETTINGS.visionApiKey = u.visionApiKey;
  await saveSettings(); res.json({ ok: true });
});

// ============ GitHub Copilot 端点 ============
// ============ 多个模型接口 ============
// 可选模型清单：主接口的当前模型 + 每个额外接口登记的模型
function modelChoices() {
  const out = [];
  if (SETTINGS.provider === 'copilot') out.push({ provider: 'main', model: SETTINGS.copilotModel || 'gpt-4.1', label: 'Copilot · ' + (SETTINGS.copilotModel || 'gpt-4.1'), group: 'GitHub Copilot' });
  else if (SETTINGS.model) out.push({ provider: 'main', model: SETTINGS.model, label: SETTINGS.model, group: '主接口' });
  for (const p of SETTINGS.providers || []) for (const m of p.models || []) out.push({ provider: p.id, model: m, label: m, group: p.name });
  return out;
}
const _maskProv = p => ({ ...p, apiKey: p.apiKey ? '***' + p.apiKey.slice(-4) : '' });
app.get('/api/multirun', (req, res) => {
  const groups = [...new Set([...TASKS.values()].filter(t => t.multiRun).map(t => t.multiRun.group))];
  res.json({ groups: groups.map(multiRunSummary).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt).slice(0, 20) });
});
app.get('/api/multirun/:group', (req, res) => { const g = multiRunSummary(req.params.group); g ? res.json(g) : res.status(404).json({ error: '没有这组多模型运行' }); });
// 选定某个模型的结果：标记为采用，其余保留可查
app.post('/api/multirun/:group/pick', (req, res) => {
  const ts = [...TASKS.values()].filter(t => t.multiRun && t.multiRun.group === req.params.group);
  if (!ts.some(t => t.id === req.body?.id)) return res.status(404).json({ error: '没有这个任务' });
  for (const t of ts) { t.multiRun.picked = t.id === req.body.id; persistTaskNow(t); }
  broadcastTaskState(); res.json({ ok: true });
});
// 综合：新建一个任务，把几个模型的结论交给指定模型对比、取长补短，给出一份合并方案
app.post('/api/multirun/:group/fuse', (req, res) => {
  const g = multiRunSummary(req.params.group);
  if (!g) return res.status(404).json({ error: '没有这组多模型运行' });
  if (g.runs.some(r => r.running)) return res.status(409).json({ error: '还有模型没跑完' });
  const ref = req.body && req.body.model ? { provider: String(req.body.provider || 'main'), model: String(req.body.model) } : null;
  const t = createTask(`综合 · ${g.text.slice(0, 30)}`);
  t.modelRef = ref; t.autoMode = true; t.multiRun = { group: g.group, index: 0, of: g.runs.length, dir: `multirun/${g.group}`, fusion: true };
  persistTaskNow(t);
  const body = g.runs.map(r => `## 模型 ${r.index}：${r.model}\n目录：${r.dir}/（${r.fileCount} 个文件）\n步数 ${r.steps}，工具调用 ${r.tools}\n\n${r.answer || '（没有给出结论）'}`).join('\n\n---\n\n');
  const prompt = `下面是 ${g.runs.length} 个模型各自独立完成同一任务的结论。原任务：\n> ${g.text.slice(0, 1500)}\n\n请：1) 逐项对比（做法、边界条件和参数、关键数字、是否核实过），必要时去各自目录读文件核对；2) 指出谁对谁错、各自的漏洞；3) 给出一份综合后的最佳方案，放在 multirun/${g.group}/fusion/ 下。不要重跑大算例，除非结论互相矛盾且必须验证。\n\n${body}`;
  const { ws } = _makeHeadlessSession(t);
  runAgent(ws, prompt, []).catch(e => console.warn('[fuse] 失败:', e.message));
  broadcastTaskState(); res.json({ ok: true, id: t.id });
});
app.get('/api/providers', (req, res) => res.json({ providers: (SETTINGS.providers || []).map(_maskProv), choices: modelChoices() }));
app.post('/api/providers', async (req, res) => {
  let p; try { p = validateProvider(req.body || {}); } catch (e) { return res.status(400).json({ error: e.message }); }
  const list = SETTINGS.providers || (SETTINGS.providers = []);
  const old = p.id && list.find(x => x.id === p.id);
  if (old) { if (!p.apiKey || p.apiKey.startsWith('***')) p.apiKey = old.apiKey; Object.assign(old, p); }
  else { p.id = 'p' + crypto.randomBytes(4).toString('hex'); if (p.apiKey.startsWith('***')) p.apiKey = ''; list.push(p); }
  await saveSettings(); broadcastTaskState();
  res.json({ ok: true, id: p.id || old.id });
});
app.delete('/api/providers/:id', async (req, res) => {
  SETTINGS.providers = (SETTINGS.providers || []).filter(x => x.id !== req.params.id);
  for (const t of TASKS.values()) if (t.modelRef && t.modelRef.provider === req.params.id) { t.modelRef = null; persistTaskNow(t); }
  await saveSettings(); broadcastTaskState(); res.json({ ok: true });
});
// 查一个接口能用的模型（/v1/models），让用户勾选，不用手抄模型名
app.post('/api/providers/discover', async (req, res) => {
  const b = req.body || {};
  const old = b.id && (SETTINGS.providers || []).find(x => x.id === b.id);
  const key = (!b.apiKey || String(b.apiKey).startsWith('***')) ? (old && old.apiKey) || '' : String(b.apiKey).trim();
  let url; try { url = resolveChatConfig({ provider: 'openai', baseUrl: b.baseUrl || (old && old.baseUrl), apiKey: key || 'x', model: 'x' }).url.replace(/\/chat\/completions$/, '/models'); }
  catch (e) { return res.json({ ok: false, error: e.message }); }
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${key}`, 'x-api-key': key } });
    const txt = await r.text();
    if (!r.ok) return res.json({ ok: false, error: `接口返回 ${r.status}：${txt.slice(0, 200)}` });
    const ids = (JSON.parse(txt).data || []).map(m => m.id).filter(Boolean).filter(id => !/image|audio|realtime|embed|tts|whisper|moderation/i.test(id));
    res.json({ ok: true, models: ids.slice(0, 120) });
  } catch (e) { res.json({ ok: false, error: '连不上：' + String(e.cause?.code || e.cause?.message || e.message).slice(0, 200) }); }
});
app.post('/api/providers/:id/test', async (req, res) => {
  const p = (SETTINGS.providers || []).find(x => x.id === req.params.id);
  if (!p) return res.json({ ok: false, error: '没有这个接口' });
  const model = (req.body && req.body.model) || p.models[0];
  if (!model) return res.json({ ok: false, error: '先登记至少一个模型' });
  res.json(await testChatConnection(false, settingsForRef(SETTINGS, { provider: p.id, model })));
});

// ============ 设置页：求解器环境（只读，自动探测）/ 官方技能包 / MCP 服务 ============
// 测试模型连接：真发一条 1 token 的请求，把失败原因翻成人话（填错地址、密钥无效、模型名不对、服务器连不上）
async function testChatConnection(vision, ST = SETTINGS) {
  const t0 = Date.now();
  if (!vision && ST.provider === 'copilot') {
    if (!COPILOT.ghToken) return { ok: false, error: '还没有登录 GitHub Copilot' };
    try { await copilotRefreshApiToken(); return { ok: true, ms: Date.now() - t0, model: SETTINGS.copilotModel || 'gpt-4.1', host: 'api.githubcopilot.com' }; }
    catch (e) { return { ok: false, error: e.message.slice(0, 300) }; }
  }
  let cfg;
  try { cfg = resolveChatConfig(ST, { vision }); } catch (e) { return { ok: false, error: e.message }; }
  if (cfg.provider === 'copilot') return { ok: true, note: '视觉沿用 Copilot' };
  const host = (() => { try { return new URL(cfg.url).host; } catch { return cfg.url; } })();
  try {
    const r = await fetch(cfg.url, { method: 'POST', signal: AbortSignal.timeout(30000), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey || 'local'}` },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }) });
    const txt = await r.text();
    if (r.ok) return { ok: true, ms: Date.now() - t0, model: cfg.model, host };
    const msg = (() => { try { const j = JSON.parse(txt); return j.error?.message || j.message || txt; } catch { return txt; } })().slice(0, 300);
    const why = r.status === 401 || r.status === 403 ? '密钥无效或没有权限' : r.status === 404 ? '地址或模型 ID 不对（服务端找不到）' : r.status === 400 && /model/i.test(msg) ? '模型 ID 不对' : r.status === 429 ? '额度用完或请求太频繁' : r.status === 407 ? '代理拒绝' : `接口返回 ${r.status}`;
    // 模型 ID 不对时，顺手问一下 /models，把这把密钥能用的模型列出来
    let models = [];
    if ((r.status === 404 || r.status === 400) && /model/i.test(msg)) {
      try {
        const mu = cfg.url.replace(/\/chat\/completions$/, '/models');
        const mr = await fetch(mu, { signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${cfg.apiKey || 'local'}` } });
        if (mr.ok) models = ((await mr.json()).data || []).map(m => m.id).filter(Boolean).filter(id => !/image|audio|realtime|embed|tts|whisper|moderation/i.test(id)).slice(0, 40);
      } catch {}
    }
    return { ok: false, status: r.status, error: `${why}：${msg}${models.length ? `\n这把密钥可用的模型：${models.join('、')}` : ''}`, host, models };
  } catch (e) {
    const c = e.cause?.code || e.code || '';
    const em = String(e.cause?.message || e.message);
    const why = e.name === 'TimeoutError' || /cancel|abort|timeout|超时/i.test(em) ? '30 秒没有响应' : c === 'ENOTFOUND' ? '域名解析不到' : c === 'ECONNREFUSED' ? '对方拒绝连接（端口不对或服务没开）'
      : /403|不允许连接本机/.test(String(e.cause?.message || e.message)) ? '不允许连接服务器本机地址' : '连不上';
    return { ok: false, error: `${why}（${host}）${process.env.CFD_GUEST ? '。服务器所在网络需要上网认证，外网接口直连不通：在下方「用我电脑的网络」里运行出网助手后再测' : ''}：${(e.cause?.message || e.message).slice(0, 200)}`, host };
  }
}
app.post('/api/settings/test', async (req, res) => res.json(await testChatConnection(!!(req.body || {}).vision)));
app.get('/api/env', async (req, res) => {
  try {
    if (req.query.refresh === '1' || !ENV_INFO) { await autoProbeEnvironment(); }
    res.json({ ...(ENV_INFO || {}), workspace: WORKSPACE, settings: { openfoamBash: SETTINGS.openfoamBash || '', foamRoot: SETTINGS.foamRoot || '', pythonPath: SETTINGS.pythonPath || '' } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/packs', async (req, res) => {
  try { res.json({ packs: await Cap.listPacks(SKILL_PACK_DIR, SETTINGS.packs || {}) }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// v0.9 在线技能目录（内置 CFD 技能 + 通用 AI 技能，可一键安装到 agent-skills/）
const REMOTE_SKILL_CATALOG = [
  // ─── CFD 专业技能 ───────────────────────────────────────────────────────────
  { id: 'paper-reader', title: '论文解读', category: 'CFD', description: 'CFD 论文信息抽取协议：几何参数、BC解析、KPI对标、deviations.log登记', trigger: 'auto',
    content: '# 论文解读技能包\n\n## 触发\n用户上传 PDF 或提到"复现论文"时自动激活。\n\n## 协议\n1. **几何**：提取关键尺寸（+来源Fig/Table/文字），列为表格\n2. **物性**：温度、压力、组分、密度、粘度、反应速率常数\n3. **边界条件**：进出口（速度/流量/成分），固壁，对称面，循环量\n4. **KPI**：原文给出的可对比指标和数值（带不确定度或偏差范围）\n5. **偏差登记**：每个与原文不一致的假设都写入 deviations.log.md，格式 `[Gn] 描述`\n6. **验收标准**：复现 KPI ≤ 10% 偏差，不确定物性用文献中间值\n' },
  { id: 'mesh-quality', title: '网格质量', category: 'CFD', description: 'checkMesh 指标解读、snappyHexMesh 常见问题排查与修复', trigger: 'manual',
    content: '# 网格质量技能包\n\n## 关键指标（OpenFOAM v2306）\n| 指标 | 推荐 | 上限 |\n|---|---|---|\n| maxSkewness | <2（反应流） | 4 |\n| maxNonOrthogonality | <50° | 70° |\n| minVolRatio | >0.01 | 0.001 |\n| minFaceWeight | >0.3 | — |\n\n## 常见问题\n- **负体积**：checkMesh -allTopology 找退化面 → STL 自交 → surfaceCheck\n- **高非正交**：snappyHexMesh nSmoothPatch/nRelaxIter 增大 → addLayersControls featureAngle 降低\n- **Skewness 大**：局部 refinement level 提高一级 → 或 locationInMesh 移位\n' },
  { id: 'post-processing', title: '后处理', category: 'CFD', description: 'CFD 结果后处理流水线：时均、切片、KPI提取、可信度评估', trigger: 'manual',
    content: '# 后处理技能包\n\n## 标准流程\n1. **时均统计**：确认 alphaMean 起始时间（通常 3–5 个τ = V/Q_g）\n2. **KPI 提取**：postProcessing/ 下的 surfaceFieldValue/volFieldValue 时间序列\n3. **质量衡算**：入口总流量 = 出口总流量 ± 2%（未达到则时均还不稳定）\n4. **可信度**：KPI与初值相比变化 <1% → 仅床层流体力学可信；KPI 显著变化 → 可信\n5. **对标**：与原文 Table/Figure 数值逐条对比，在 deviations.log.md 补充 [R1–Rn]\n' },
  { id: 'cfd-optimization', title: 'CFD 优化', category: 'CFD', description: 'Optuna 贝叶斯优化流水线：参数空间、目标函数、验收标准', trigger: 'manual',
    content: '# CFD 优化技能包\n\n## 标准流水线\n1. opt_study_create：指定方向（minimize/maximize）、目标 KPI、约束（convergence/physical_validity）\n2. opt_suggest_next：贝叶斯采样下一组参数\n3. opt_apply_params：写入 OpenFOAM 字典（foamDictionary）\n4. opt_run_trial：启动求解，foam_solver_run + solver_wait\n5. opt_extract_kpi：从 postProcessing 读目标指标\n6. opt_record_result：记录结果到 study\n7. opt_status：查看 Pareto/最优/收敛曲线\n\n## 注意\n- 每次试验独立验收（checkMesh + 质量衡算 + KPI 可信度）\n- 参数边界由物理约束确定，不要超出\n' },
  { id: 'fluidized-bed', title: '流化床', category: 'CFD', description: '鼓泡床/湍动床/循环流化床的关键参数、边界条件设置与KPI体系', trigger: 'auto',
    content: '# 流化床技能包\n\n## 关键参数\n- **最小流化速度** Umf（Ergun / Wen-Yu 公式）\n- **膨胀比** H/Hmf = 1/(1-εmf) × (1-εf)\n- **终端速度** Ut（Schiller-Naumann）\n\n## 边界条件\n- 进气：均匀速度（基准）或分布器孔口（高保真）\n- 固体进料：catin patch，αs=0.5，速度=Gs/ρs/A\n- 固体出料：catout patch，αs≥0.2，压力出口\n\n## KPI\n- 床层藏量 = volIntegrate(alpha.particles) × ρs\n- ③/⑤ 循环量：surfaceFieldValue(alphaPhi.particles) × ρs × 3600\n- 床层压降 = pInlet − pOutlet\n' },
  // ─── AI / 编程通用技能（对标 OpenCode 官方技能库）──────────────────────────
  { id: 'claude-api', title: 'Claude API', category: 'AI', description: 'Anthropic Claude API / SDK 参考：模型 ID、定价、流式、工具调用、MCP、缓存、token 计算', trigger: 'auto',
    content: '# Claude API 技能包\n\n## 触发\n涉及 Claude、Anthropic、claude-* 模型、MCP、tool_use、流式输出、token 计数时自动激活。\n\n## 当前模型（2026-11）\n| 模型 | 上下文 | 用途 |\n|---|---|---|\n| claude-opus-5-5 | 200k | 最强推理/复杂代码 |\n| claude-sonnet-4-5 | 200k | 均衡生产 |\n| claude-haiku-3-5 | 200k | 快速/低成本 |\n\n## 关键参数\n```python\nfrom anthropic import Anthropic\nclient = Anthropic(api_key="...")\nmsg = client.messages.create(\n    model="claude-opus-5-5",\n    max_tokens=8096,\n    system="...",\n    messages=[{"role":"user","content":"..."}]\n)\n```\n\n## Tool Use\n```json\n{ "type": "tool_use", "id": "toolu_01", "name": "fn", "input": {...} }\n```\n结果用 `{"type":"tool_result","tool_use_id":"toolu_01","content":"..."}`\n\n## 提示缓存\n在长 system prompt 末尾标 `{"type":"text","text":"...","cache_control":{"type":"ephemeral"}}`\n\n## MCP 集成\n使用 `anthropic.beta.messages.create` 并传 `mcp_servers` 参数，或通过 SDK 的 MCPClient 连接 stdio 服务器。\n' },
  { id: 'code-review', title: '代码审查', category: 'AI', description: '系统化代码 Review 协议：安全、性能、可维护性、测试覆盖', trigger: 'manual',
    content: '# 代码审查技能包\n\n## 审查维度（优先级从高到低）\n1. **安全**：SQL注入、XSS、SSRF、硬编码凭证、权限绕过\n2. **正确性**：边界条件、空值处理、并发竞争、溢出\n3. **性能**：N+1 查询、不必要的复制、内存泄漏、阻塞调用\n4. **可维护性**：函数长度 <40 行、命名清晰、单一职责\n5. **测试**：关键路径覆盖、错误路径、边界值\n\n## 输出格式\n每条评论：`[严重度] 文件:行 — 问题描述 → 建议修改`\n严重度：CRITICAL / HIGH / MEDIUM / LOW / NIT\n\n## 自动检查清单\n- [ ] 无 console.log/print 调试语句留存\n- [ ] 所有外部输入都经过验证\n- [ ] 密钥不在代码中硬编码\n- [ ] 异步函数都有错误处理\n- [ ] 修改不破坏现有测试\n' },
  { id: 'frontend-design', title: '前端设计', category: 'AI', description: '现代前端 UI 设计指导：布局、色彩、排版、可访问性、响应式', trigger: 'manual',
    content: '# 前端设计技能包\n\n## 设计原则\n- **间距**：4/8/12/16/24/32px 格栅，不用随意数字\n- **字体**：标题 font-weight 700, 正文 400/500, 辅助 400+opacity\n- **色彩**：主色、中性色、语义色（success/warning/error/info）\n- **圆角**：统一用 CSS 变量 --radius（4/6/8/12px 选一组）\n\n## 可访问性\n- 对比度 WCAG AA（正文 ≥4.5:1，大字 ≥3:1）\n- 所有交互元素有 focus-visible 样式\n- 图标配 aria-label 或 aria-hidden\n- 颜色不是唯一信息载体\n\n## 响应式\n- Mobile-first：先写 ≤480px，用 min-width 媒体查询往上扩展\n- 触摸目标 ≥44×44px\n- 表格窄屏横向滚动（overflow-x: auto）\n\n## CSS 变量模板\n```css\n:root {\n  --radius: 8px;\n  --font-sans: system-ui, -apple-system, sans-serif;\n  --primary: #2563eb;\n  --foreground: #0f172a;\n  --muted: #64748b;\n  --border: #e2e8f0;\n}\n```\n' },
  { id: 'mcp-builder', title: 'MCP 服务构建', category: 'AI', description: '构建高质量 MCP 服务器：工具设计、Python FastMCP、Node SDK、测试', trigger: 'manual',
    content: '# MCP 服务构建技能包\n\n## MCP 核心概念\n- **Tools**：LLM 可调用的函数，有 JSON Schema 参数，返回 TextContent/ImageContent\n- **Resources**：LLM 可读取的数据（文件、DB 记录、API 响应）\n- **Prompts**：预制的提示模板\n- **Transport**：stdio（本地）或 HTTP+SSE（远程）\n\n## Python FastMCP 快速开始\n```python\nfrom fastmcp import FastMCP\nmcp = FastMCP("my-server")\n\n@mcp.tool()\ndef get_weather(city: str) -> str:\n    """Get current weather for a city.\"\"\"\n    return f"Weather in {city}: 25°C sunny"\n\nif __name__ == "__main__":\n    mcp.run()  # stdio by default\n```\n\n## Node.js SDK\n```typescript\nimport { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\nimport { z } from "zod";\nconst server = new McpServer({ name: "demo", version: "1.0.0" });\nserver.tool("add", { a: z.number(), b: z.number() }, async ({ a, b }) => ({\n  content: [{ type: "text", text: `${a + b}` }]\n}));\n```\n\n## 工具设计原则\n1. 名称动词开头：`get_`, `create_`, `update_`, `delete_`, `list_`\n2. 描述精确：说清楚输入期望、输出格式、可能的错误\n3. 参数原子化：一个工具做一件事\n4. 返回结构化信息 + 可读摘要\n' },
  { id: 'research-assistant', title: '研究助手', category: 'AI', description: '系统化信息检索与综合：搜索策略、来源评估、引用格式、事实核查', trigger: 'manual',
    content: '# 研究助手技能包\n\n## 检索策略\n1. 先用宽泛查询定位领域综述，再用精确查询找具体数据\n2. 交叉检验：同一事实至少 2 个独立来源\n3. 权威来源优先：学术期刊 > 政府/机构报告 > 行业白皮书 > 新闻\n\n## 来源质量评估\n- **一手资料**：原始数据、论文、官方文档\n- **二手资料**：综述、教材、百科\n- 检查发布日期：技术类 ≤3 年，科学类视领域而定\n\n## 输出结构\n```\n## 结论摘要（3–5 句）\n## 关键发现\n- 发现 1（来源：作者, 年份）\n- 发现 2（来源：...）\n## 不确定性 / 存在争议的点\n## 参考来源\n[1] ...\n```\n\n## 注意\n- 知识截止日期之后的事实必须通过搜索工具确认\n- 数字、统计数据必须给出来源\n- 不确定的内容明确标记"需核实"\n' },
  { id: 'math-formula', title: '数学与公式', category: 'AI', description: '数学推导、LaTeX 公式排版、数值计算、科学记数与单位转换', trigger: 'auto',
    content: '# 数学与公式技能包\n\n## LaTeX 格式规范\n- 行内公式：`$E = mc^2$`\n- 独立公式：`$$\\frac{\\partial u}{\\partial t} + u \\cdot \\nabla u = -\\nabla p + \\nu \\nabla^2 u$$`\n- 矩阵：`\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}`\n- 向量：`\\vec{u}` 或 `\\mathbf{u}`\n\n## 数值计算原则\n- 中间结果保留 4–6 位有效数字\n- 最终结果与输入精度匹配\n- 量纲分析优先于数值代入\n\n## 单位转换常用\n| 物理量 | SI 单位 | 常用换算 |\n|---|---|---|\n| 压力 | Pa | 1 atm = 101325 Pa |\n| 温度 | K | T(K) = T(°C) + 273.15 |\n| 动力粘度 | Pa·s | 1 cP = 0.001 Pa·s |\n| 速度 | m/s | 1 m/s = 3.6 km/h |\n\n## 推导规范\n1. 先写出出发公式（带编号）\n2. 每步变换注明依据\n3. 最终结果框出\n4. 给出量纲检验\n' },
  { id: 'doc-writing', title: '文档写作', category: 'AI', description: '技术文档、设计文档、API文档的结构与写作规范', trigger: 'manual',
    content: '# 文档写作技能包\n\n## 文档类型与结构\n\n### 技术规格（Design Doc）\n```\n# 标题 — 状态：草稿/审核/已批准\n## 背景与动机\n## 目标与非目标\n## 方案设计\n### 方案 A（推荐）\n### 方案 B（备选）\n## 实现细节\n## 测试计划\n## 风险与缓解\n## 时间线\n```\n\n### API 参考文档\n```markdown\n## `function_name(param1, param2)`\n**描述**：一句话说清楚这个函数做什么。\n**参数**：\n- `param1` (string, required): ...\n- `param2` (number, optional, default: 0): ...\n**返回值**：...\n**示例**：\n\`\`\`python\nresult = function_name("hello", 42)\n\`\`\`\n**异常**：`ValueError` 当 ... 时抛出\n```\n\n## 写作原则\n- 读者优先：先说"为什么"，再说"怎么做"\n- 主动语态，动词开头\n- 代码示例可运行、可复制\n- 版本号和日期标注在文件头\n' },
  { id: 'agent-orchestration', title: '智能体编排', category: 'AI', description: '多智能体系统设计：任务分解、并发协调、工具链、错误恢复', trigger: 'manual',
    content: '# 智能体编排技能包\n\n## 核心模式\n\n### 1. 顺序链（Sequential Chain）\n每步输出作为下一步输入，适合有依赖关系的任务。\n```\nplanner → researcher → writer → reviewer\n```\n\n### 2. 并行扇出（Parallel Fan-out）\n独立子任务并发执行，最后汇总。\n```\norchestrator → [task-A, task-B, task-C] → aggregator\n```\n\n### 3. 判断路由（Judge Router）\n中间检查点决定后续路径。\n```\ntask → executor → judge → (pass: done | fail: retry/escalate)\n```\n\n## 设计原则\n1. **幂等性**：工具调用可安全重试\n2. **状态外化**：中间状态写文件/DB，不靠上下文记忆\n3. **超时保护**：每个子任务设最长运行时间\n4. **错误隔离**：一个子任务失败不影响其他\n\n## 提示工程\n- 子智能体 prompt 携带完整上下文（不靠父级历史）\n- 明确输出格式（JSON Schema > 自由文本）\n- "做完这步就停下，等待确认" 避免越权\n' },
  { id: 'openai-api', title: 'OpenAI API', category: 'AI', description: 'OpenAI API 参考：GPT/o系列模型、函数调用、流式、Assistants、Embeddings', trigger: 'auto',
    content: '# OpenAI API 技能包\n\n## 当前模型（2026-11）\n| 模型 | 上下文 | 用途 |\n|---|---|---|\n| gpt-4o | 128k | 旗舰多模态 |\n| gpt-4o-mini | 128k | 快速低成本 |\n| o3 | 200k | 深度推理 |\n| o4-mini | 200k | 快速推理 |\n\n## Chat Completions\n```python\nfrom openai import OpenAI\nclient = OpenAI(api_key="...")\nresp = client.chat.completions.create(\n    model="gpt-4o",\n    messages=[{"role":"user","content":"Hello"}],\n    tools=[...],  # 函数调用\n    stream=True\n)\n```\n\n## 函数调用\n```json\n{\n  "type": "function",\n  "function": {\n    "name": "get_weather",\n    "description": "Get weather",\n    "parameters": {"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}\n  }\n}\n```\n\n## 结构化输出\n传 `response_format={"type":"json_schema","json_schema":{...}}` 保证合法 JSON 输出。\n\n## Embeddings\n```python\nembedding = client.embeddings.create(model="text-embedding-3-large", input="text").data[0].embedding\n```\n' },
];
app.get('/api/skills/catalog', (req, res) => res.json({ skills: REMOTE_SKILL_CATALOG }));
app.post('/api/skills/install', async (req, res) => {
  try {
    const { id } = req.body || {};
    const skill = REMOTE_SKILL_CATALOG.find(s => s.id === id);
    if (!skill) return res.status(404).json({ error: '未找到技能: ' + id });
    const dir = path.join(SKILL_PACK_DIR, id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), skill.content, 'utf8');
    res.json({ ok: true, id, title: skill.title });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/skills/installed/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!/^[\w-]+$/.test(id)) return res.status(400).json({ error: '非法id' });
    const dir = path.join(SKILL_PACK_DIR, id);
    await fs.rm(dir, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/packs/:id', async (req, res) => {
  try { res.type('text/plain').send(await Cap.readPackFile(SKILL_PACK_DIR, req.params.id, String(req.query.file || ''))); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/packs/:id', async (req, res) => {
  try {
    if (!/^[\w.-]+$/.test(req.params.id)) throw new Error('技能包名不合法');
    SETTINGS.packs = { ...(SETTINGS.packs || {}), [req.params.id]: !!(req.body || {}).enabled };
    await saveSettings(); await refreshPackIndex();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
const _mcpView = () => (SETTINGS.mcpServers || []).map(c => { const m = MCP.get(c.name); return { name: c.name, command: c.command, args: c.args || [], env: Object.keys(c.env || {}), enabled: c.enabled !== false, status: m ? m.status : 'stopped', error: m ? m.error : '', tools: m ? m.tools.map(t => ({ name: t.name, description: (t.description || '').slice(0, 200) })) : [] }; });
app.get('/api/mcp', (req, res) => res.json({ servers: _mcpView() }));
app.post('/api/mcp', async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!/^[\w-]{1,32}$/.test(name)) throw new Error('名字只能用字母、数字、_、-（≤32）');
    const cmd = String(b.command || '').trim(); if (!cmd) throw new Error('缺少启动命令');
    const args = Array.isArray(b.args) ? b.args.map(String) : String(b.args || '').split(/\s+/).filter(Boolean);
    const prev = (SETTINGS.mcpServers || []).find(x => x.name === name);
    const env = b.env && typeof b.env === 'object' ? Object.fromEntries(Object.entries(b.env).map(([k, v]) => [String(k), String(v)])) : (prev ? prev.env : {});
    const cfg = { name, command: cmd, args, env, enabled: b.enabled !== false };
    SETTINGS.mcpServers = [...(SETTINGS.mcpServers || []).filter(x => x.name !== name), cfg];
    await saveSettings(); await startMcpServers();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/mcp/:name', async (req, res) => {
  SETTINGS.mcpServers = (SETTINGS.mcpServers || []).filter(x => x.name !== req.params.name);
  await saveSettings(); await startMcpServers(); res.json({ ok: true });
});
app.post('/api/mcp/:name/restart', async (req, res) => { await startMcpServers(); res.json({ ok: true }); });


// （外部通知与状态总览端点紧随其后，Copilot 端点在它们下面）

// ============ 外部通知（手机推送）============
const _maskHook = u => { try { const x = new URL(u); return `${x.origin}${x.pathname.slice(0, 12)}…`; } catch { return ''; } };
app.get('/api/notify', (req, res) => {
  const c = SETTINGS.notify || {};
  res.json({ enabled: !!c.enabled, webhook: c.webhook ? _maskHook(c.webhook) : '', hasWebhook: !!c.webhook, kind: c.kind || '',
    events: c.events || Notify.EVENT_KINDS, publicUrl: c.publicUrl || '', allEvents: Notify.EVENT_KINDS,
    envWebhook: !!process.env.CFD_NOTIFY_WEBHOOK, history: NOTIFIER.history().slice(0, 20) });
});
app.post('/api/notify', async (req, res) => {
  const u = req.body || {};
  const cur = SETTINGS.notify || {};
  try {
    // webhook 留空或掩码 = 保持原值
    const webhook = u.webhook === undefined || /…$/.test(String(u.webhook)) ? cur.webhook : u.webhook;
    SETTINGS.notify = Notify.validateNotifyConfig({ ...cur, ...u, webhook });
  } catch (e) { return res.status(400).json({ error: e.message }); }
  await saveSettings(); res.json({ ok: true });
});
app.post('/api/notify/test', async (req, res) => {
  const r = await NOTIFIER.send({ kind: 'task_complete', force: true, title: '🔔 CFDriver 通知测试', body: `来自 ${os.hostname()} 的测试消息` });
  res.json({ ok: !!r.delivered, status: r.status, error: r.error || (SETTINGS.notify?.webhook || process.env.CFD_NOTIFY_WEBHOOK ? '' : '未配置 webhook') });
});

// ============ 全局状态总览（手机首页 / 外部脚本）============
app.get('/api/status', (req, res) => {
  const runs = [...SOLVER_RUNS.values()].filter(r => !r.ended)
    .map(r => ({ runId: r.runId, kind: r.kind, casePath: r.casePath, started: r.started, taskId: r.ownerTaskId, taskTitle: _taskTitle(r.ownerTaskId),
      last: (r.log || []).slice(-1)[0] || '' }));
  const tasks = [...TASKS.values()].map(t => ({ id: t.id, title: t.title, updatedAt: t.updatedAt,
    running: !!(t._runningSession && t._runningSession._running), awaitingApproval: !!t.awaitingApproval,
    pendingQuestion: t.pendingQuestion ? String(t.pendingQuestion.text || '').slice(-300) : '',
    goal: t.goal ? { text: t.goal.text, status: t.goal.status } : null }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 30);
  const [l1, l5, l15] = os.loadavg();
  res.json({ host: os.hostname(), platform: process.platform, cpus: os.availableParallelism?.() ?? os.cpus().length, load: [l1, l5, l15],
    mem: { total: os.totalmem(), free: os.freemem() }, uptime: process.uptime(), runs, tasks,
    attention: tasks.filter(t => t.awaitingApproval || t.pendingQuestion).length });
});

// ============ 实时监视（/monitor）：本服务登记的求解 + 机器上其它 OpenFOAM 并行作业 + RSI 档案 + 智能体近况 ============
const MON_RATE = new Monitor.RateTracker();
const RSI_ROOT = process.env.RSI_DIST_ROOT || path.join(os.homedir(), 'mto_repro', 'rsi_dist');
// Linux：按 /proc 找正在跑的 *Foam -parallel 进程，按工作目录归组（核数 = 进程数）
function _foamProcs() {
  const groups = new Map();
  if (process.platform !== 'linux') return groups;
  for (const p of _foamProcSnapshot(5000)) {
    // 统计所有 Foam 进程（串行 + 并行各算 1 核），不再只看 -parallel
    const g = groups.get(p.cwd) || { solver: path.basename(p.argv[0]), np: 0, parallel: false };
    g.np++;
    if (p.argv.includes('-parallel')) g.parallel = true;
    groups.set(p.cwd, g);
  }
  return groups;
}
function _caseLog(dir) {
  const rsi = path.join(dir, 'logs', 'solve.stdout.log');
  if (fssync.existsSync(rsi)) return rsi;
  let best = null;
  try {
    for (const f of fssync.readdirSync(dir)) {
      if (!/^log\./.test(f)) continue;
      const st = fssync.statSync(path.join(dir, f));
      if (!best || st.mtimeMs > best.m) best = { f: path.join(dir, f), m: st.mtimeMs };
    }
  } catch {}
  return best && best.f;
}
function _monJob(key, caseDir, logFile, extra = {}) {
  const tl = logFile ? Monitor.tailText(logFile) : null;
  const now = tl ? Monitor.lastTime(tl.text) : null;
  if (now !== null) MON_RATE.add(key, now);
  const { end } = Monitor.readEndTime(caseDir);
  const start = logFile ? Monitor.firstTime(logFile) : null;
  const rate = Monitor.rateFromLog(tl && tl.text) ?? MON_RATE.rate(key);
  const step = Monitor.lastStepInfo(tl && tl.text);
  return { key, caseDir, log: logFile, now, start, end, rate, ...Monitor.progress({ start, end, now, rate }), ...step,
    logAgeS: tl ? Math.round((Date.now() - tl.mtime) / 1000) : null, history: MON_RATE.history(key).slice(-120),
    tail: tl ? tl.text.split('\n').filter(l => /^(Time|Courant|deltaT|ExecutionTime|PIMPLE|FOAM|End)/.test(l)).slice(-6) : [], ...extra };
}
function _taskBrief(t) {
  const msgs = (t.messages || []).slice(-8).map(m => {
    let c = m.content; if (Array.isArray(c)) c = c.map(x => x.text || '').join(' ');
    const calls = (m.tool_calls || []).map(x => x.function?.name).filter(Boolean);
    return { role: m.role, text: String(c || '').replace(/\s+/g, ' ').slice(0, 280), tools: calls };
  }).filter(m => m.text || m.tools.length);
  return { id: t.id, title: t.title, updatedAt: t.updatedAt, running: !!(t._runningSession && t._runningSession._running),
    autoMode: !!t.autoMode, awaitingApproval: !!t.awaitingApproval, goal: t.goal ? t.goal.status : null, recent: msgs };
}
// 作业属于哪个任务：登记时的 ownerTaskId；没有的（run_command 里前台跑的 mpirun、手动起的）按算例目录对上任务的当前算例
function _taskIdForCase(dir) {
  let best = null;
  for (const t of TASKS.values()) {
    const cd = _taskCaseDir(t);
    if (!cd || (dir !== cd && !dir.startsWith(cd + path.sep))) continue;
    if (!best || (t.updatedAt || 0) > (best.updatedAt || 0)) best = t;
  }
  return best ? best.id : '';
}
app.get('/api/monitor', (req, res) => {
  try {
    const jobs = [], seen = new Set();
    for (const r of SOLVER_RUNS.values()) {
      if (r.ended) continue;
      const dir = path.resolve(r.casePath || WORKSPACE); seen.add(dir);
      const owner = r.ownerTaskId || _taskIdForCase(dir);
      const lf = r.redirLog || _redirectTarget(r.command, r.casePath) || r.logFile || _caseLog(dir);
      jobs.push(_monJob('run:' + r.runId, dir, lf, { source: dir.includes(`${path.sep}rsi_dist${path.sep}`) ? 'rsi' : !r.external ? 'agent' : owner ? 'task' : 'external', runId: r.runId, taskId: owner || null, task: _taskTitle(owner), command: String(r.command || '').slice(0, 200) }));
    }
    const procs = _foamProcs();
    for (const [dir, g] of procs) {
      const j = seen.has(dir) ? jobs.find(x => x.caseDir === dir) : null;
      if (j) { j.np = g.np; j.solver = g.solver; continue; }
      jobs.push(_monJob('ext:' + dir, dir, _caseLog(dir), { source: dir.includes(`${path.sep}rsi_dist${path.sep}`) ? 'rsi' : _taskIdForCase(dir) ? 'task' : 'external', taskId: _taskIdForCase(dir) || null, task: _taskTitle(_taskIdForCase(dir)), np: g.np, solver: g.solver }));
    }
    const cpus = os.availableParallelism?.() ?? os.cpus().length, busy = [...procs.values()].reduce((s, g) => s + g.np, 0);
    res.json({ at: Date.now(), host: os.hostname(), cpus, busyCores: busy, load: os.loadavg(), mem: { total: os.totalmem(), free: os.freemem() },
      jobs, rsi: Monitor.rsiSnapshot(RSI_ROOT),
      tasks: [...TASKS.values()].filter(t => t._runningSession?._running || Date.now() - (t.updatedAt || 0) < 48 * 3600e3)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 3).map(_taskBrief) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get(['/monitor', '/monitor.html'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'monitor.html')));
// 算例总览卡：求解器、网格、边界区、最新时刻、结果文件（只读）
app.get('/api/case/overview', (req, res) => {
  try {
    const dir = _postCase(String(req.query.case || ''));
    const job = [...SOLVER_RUNS.values()].find(r => !r.ended && path.resolve(r.casePath || '') === dir);
    res.json({ case: path.relative(WORKSPACE, dir) || '.', ...Monitor.caseOverview(dir), running: !!job || _foamProcs().has(dir),
      hasGeometry: fssync.existsSync(path.join(dir, 'constant', 'triSurface')) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// 求解告警：FATAL/NaN、Courant 超限、日志停更 → 推送到对话（同一告警 30 min 内只推一次）
const MON_ALERTS = new Monitor.AlertGate(30 * 60_000);
function _pushSolverAlerts() {
  if (!allClients.size) return;
  const jobs = [];
  for (const r of SOLVER_RUNS.values()) {
    if (r.ended) continue;
    const dir = path.resolve(r.casePath || WORKSPACE);
    jobs.push([_monJob('run:' + r.runId, dir, r.redirLog || _redirectTarget(r.command, r.casePath) || r.logFile || _caseLog(dir)), r.ownerTaskId]);
  }
  for (const [job, owner] of jobs) {
    for (const a of Monitor.jobAlerts(job, { maxCo: Monitor.readMaxCo(job.caseDir) })) {
      if (!MON_ALERTS.should(job.key + ':' + a.kind)) continue;
      const msg = JSON.stringify({ type: 'solver_alert', ...a, case: path.relative(WORKSPACE, job.caseDir) || '.', runId: job.runId || job.key.replace(/^run:/, ''),
        taskId: owner || null, now: job.now, coMax: job.coMax, tail: job.tail });
      for (const c of allClients) if (c.readyState === 1) c.send(msg);
    }
  }
}
// 后台每分钟采一次样，页面没开时速率也有历史
setInterval(() => {
  try {
    for (const r of SOLVER_RUNS.values()) if (!r.ended) { const lf = r.redirLog || _redirectTarget(r.command, r.casePath); const tl = lf && Monitor.tailText(lf, 256 << 10); const t = tl && Monitor.lastTime(tl.text); if (t !== null && t !== undefined) MON_RATE.add('run:' + r.runId, t); }
    for (const dir of _foamProcs().keys()) { if ([...SOLVER_RUNS.values()].some(r => !r.ended && path.resolve(r.casePath || '') === dir)) continue; const lf = _caseLog(dir); const tl = lf && Monitor.tailText(lf, 256 << 10); const t = tl && Monitor.lastTime(tl.text); if (t !== null && t !== undefined) MON_RATE.add('ext:' + dir, t); }
  } catch {}
  try { _pushSolverAlerts(); } catch (e) { console.warn('[alerts]', e.message); }
}, 60_000).unref();

app.get('/api/copilot/status', (req, res) => res.json({ loggedIn: !!COPILOT.ghToken, provider: SETTINGS.provider, model: SETTINGS.copilotModel }));
app.post('/api/copilot/auth/start', async (req, res) => {
  try { res.json(await copilotDeviceStart()); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/copilot/auth/poll', async (req, res) => {
  try {
    const j = await copilotDevicePoll(req.body?.device_code);
    if (j.access_token) { COPILOT.ghToken = j.access_token; await saveCopilotState(); COPILOT.apiToken = ''; return res.json({ ok: true }); }
    res.json({ pending: true, ...j });
  } catch (e) {
    // 网络抖动（fetch failed / ECONNRESET / ETIMEDOUT）当作 pending 继续轮询，避免误判终止
    const msg = String(e.message || e);
    if (/fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(msg)) {
      return res.json({ pending: true, error: 'authorization_pending', error_description: '网络抖动：' + msg });
    }
    res.status(500).json({ error: msg });
  }
});
app.post('/api/copilot/logout', async (req, res) => { COPILOT.ghToken = ''; COPILOT.apiToken = ''; COPILOT.modelsCache = null; await saveCopilotState(); res.json({ ok: true }); });
app.get('/api/copilot/models', async (req, res) => {
  try { res.json({ models: await copilotListModels() }); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/copilot/select', async (req, res) => {
  const { provider, model } = req.body || {};
  if (provider) SETTINGS.provider = provider;
  if (model) SETTINGS.copilotModel = model;
  await saveSettings(); res.json({ ok: true });
});

// ============ 阿里云 / 通义千问 (DashScope OpenAI 兼容模式) ============
// DashScope 提供完整 OpenAI 兼容协议，直接复用 sf 分支即可 —— 只需把 baseUrl/apiKey/model 设好。
// base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
// 我们存储为 .../compatible-mode（不带 /v1），因为 callLLM 里会拼 `${baseUrl}/v1/chat/completions`。
app.post('/api/aliyun/select', async (req, res) => {
  try {
    const { apiKey, model, alsoVision } = req.body || {};
    if (!apiKey || !apiKey.trim()) return res.status(400).json({ error: 'API Key 不能为空' });
    if (!model || !model.trim()) return res.status(400).json({ error: '请选择模型' });
    const k = apiKey.trim();
    if (!/^sk-[A-Za-z0-9_-]{16,}$/.test(k)) {
      // 不强制阻断，只提示；DashScope key 现在全部 sk- 开头
      // 仍写入以兼容未来格式变化
    }
    SETTINGS.provider = 'sf';
    SETTINGS.baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode';
    SETTINGS.apiKey = k;
    SETTINGS.model = model.trim();
    if (alsoVision) {
      SETTINGS.visionProvider = 'sf';
      SETTINGS.visionBaseUrl = 'https://dashscope.aliyuncs.com/compatible-mode';
      SETTINGS.visionModel = 'qwen-vl-max';
      SETTINGS.visionApiKey = k;
    }
    await saveSettings();
    res.json({ ok: true, provider: 'sf', baseUrl: SETTINGS.baseUrl, model: SETTINGS.model, vision: !!alsoVision });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/workspace', async (req, res) => {
  const { dir } = req.body; if (!dir) return res.status(400).json({ error: '缺少 dir' });
  WORKSPACE = path.resolve(dir); SETTINGS.workspace = WORKSPACE; await _projTouch(WORKSPACE);
  res.json({ workspace: WORKSPACE }); broadcastTree();
});
app.get('/api/tree', async (req, res) => { try { res.json(await buildTree()); } catch (e) { res.status(500).json({ error: String(e) }); } });
app.get('/api/flat', async (req, res) => { try { res.json({ files: await flatList() }); } catch (e) { res.status(500).json({ error: String(e) }); } });
app.get('/api/file', async (req, res) => {
  try {
    const f = safePath(req.query.path);
    const stat = await fs.stat(f);
    if (stat.isDirectory()) return res.json({ error: '路径是目录，不能作为文件打开' });
    // raw=1：二进制原文返回（供图片等预览）
    if (req.query.raw === '1' || req.query.raw === 'true') {
      const ext = path.extname(f).toLowerCase();
      const MIME = {
        '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif',
        '.webp':'image/webp', '.bmp':'image/bmp', '.svg':'image/svg+xml', '.ico':'image/x-icon',
        '.stl':'model/stl', '.obj':'text/plain',
        '.pdf':'application/pdf', '.csv':'text/csv; charset=utf-8', '.txt':'text/plain; charset=utf-8',
        '.mp4':'video/mp4', '.webm':'video/webm', '.mov':'video/quicktime', '.ogv':'video/ogg',
        '.md':'text/plain; charset=utf-8', '.log':'text/plain; charset=utf-8', '.json':'application/json; charset=utf-8', '.dat':'text/plain; charset=utf-8'
      };
      res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
      // PDF 必须 inline，否则浏览器走下载分支，iframe 渲染不出来
      if (ext === '.pdf') res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(path.basename(f)) + '"');
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(f);
      return;
    }
    // 预览上限：超过 20MB 累拒；席位上限 2MB，超过则只返前 2MB + 提示。
    const HARD_MAX = 20 * 1024 * 1024, SOFT_MAX = 2 * 1024 * 1024;
    if (stat.size > HARD_MAX) return res.json({ content: `[文件过大 ${(stat.size/1024/1024).toFixed(1)} MB，超过 ${HARD_MAX/1024/1024} MB 硬上限，未加载。请用 read_document 或外部工具查看。]`, truncated: true, size: stat.size });
    // 二进制检测：读前 8KB 看有无 NUL 字节
    const fh = await fs.open(f, 'r');
    try {
      const sniffLen = Math.min(8192, stat.size);
      const buf = Buffer.alloc(sniffLen);
      await fh.read(buf, 0, sniffLen, 0);
      let nullCount = 0;
      for (let i = 0; i < sniffLen; i++) if (buf[i] === 0) { nullCount++; if (nullCount > 2) break; }
      if (nullCount > 2) return res.json({ binary: true, size: stat.size, error: null });
      // 超过席位上限：只读前 2MB + banner
      if (stat.size > SOFT_MAX) {
        const head = Buffer.alloc(SOFT_MAX);
        await fh.read(head, 0, SOFT_MAX, 0);
        const banner = `\n\n... [文件共 ${(stat.size/1024/1024).toFixed(2)} MB，仅预览前 2 MB；可用 read_document 或 grep_search 处理全部内容] ...\n`;
        const cut = head.lastIndexOf(0x0a); const body = (cut > 0 ? head.subarray(0, cut + 1) : head).toString('utf8');
        return res.json({ content: body + banner, truncated: true, size: stat.size, mtime: stat.mtimeMs });
      }
    } finally { await fh.close(); }
    res.json({ content: await fs.readFile(f, 'utf8'), size: stat.size, mtime: stat.mtimeMs });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});
app.post('/api/file', async (req, res) => {
  try { const { path: p, content, mtime, force } = req.body;
    if (typeof p !== 'string' || typeof content !== 'string') return res.status(400).json({ error: '参数错误' });
    const f = safePath(p); await fs.mkdir(path.dirname(f), { recursive: true });
    // 冲突检测：打开后磁盘文件被智能体/求解器改过，不静默覆盖
    if (typeof mtime === 'number' && !force) {
      const st = await fs.stat(f).catch(() => null);
      if (st && Math.abs(st.mtimeMs - mtime) > 1) return res.status(409).json({ conflict: true, error: '文件在打开后已被修改', mtime: st.mtimeMs });
    }
    // 原子写：先写临时文件再 rename，写到一半崩溃不会留下半截文件
    const tmp = f + '.cfdtmp-' + process.pid;
    await fs.writeFile(tmp, content, 'utf8'); await fs.rename(tmp, f);
    const st = await fs.stat(f); broadcastTree();
    res.json({ ok: true, bytes: Buffer.byteLength(content, 'utf8'), mtime: st.mtimeMs });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});
// 文件状态（查看器每 2 s 轮询：磁盘上变了且本地没有未保存编辑，就静默重新加载）
app.get('/api/stat', async (req, res) => {
  try {
    const st = await fs.stat(safePath(req.query.path));
    res.json({ exists: true, isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs });
  } catch (e) { res.json({ exists: false }); }
});
// 对话里提到的路径 → 工作区内真实存在的文件（界面把它们变成可点击链接 / 内联图片）。
// 基准目录：请求给的（界面已知的产物目录）+ 该任务当前算例目录 + 该任务跑过的算例目录
app.post('/api/resolve', async (req, res) => {
  try {
    const body = req.body || {};
    const bases = Array.isArray(body.bases) ? body.bases.filter(b => typeof b === 'string').slice(0, 6) : [];
    const task = TASKS.get(String(body.taskId || ''));
    if (task) {
      if (task.workMem && task.workMem.casePath) bases.unshift(String(task.workMem.casePath));
      for (const r of SOLVER_RUNS.values()) if (r.ownerTaskId === task.id && r.casePath && !bases.includes(r.casePath)) bases.push(r.casePath);
    }
    res.json({ found: await resolveMentioned({ workspace: WORKSPACE, paths: body.paths, bases }) });
  } catch (e) { res.status(500).json({ error: String(e.message), found: {} }); }
});
// 偏离审批卡片：任务当前算例的 deviations.log.md → 每条一张卡（状态、证据图、是否在等用户决定）
function _taskCaseDir(task) {
  const cp = task && task.workMem && task.workMem.casePath;
  if (!cp) return '';
  const p = String(cp).replace(/^~(?=[\\/])/, os.homedir());
  return path.isAbsolute(p) ? p : path.resolve(WORKSPACE, p);
}
app.get('/api/deviations', async (req, res) => {
  try {
    const task = TASKS.get(String(req.query.taskId || ''));
    if (!task) return res.json({ file: '', entries: [], caseImages: [], waiting: 0 });
    const v = await Fidelity.deviationView({ task, workspace: WORKSPACE, caseDir: _taskCaseDir(task) });
    if (v.noted) schedulePersistTask(task);
    res.json({ ...v.data, running: !!(task._runningSession && task._runningSession._running), awaiting: !!(task.awaitingUserChoice || task.pendingQuestion) });
  } catch (e) { res.status(500).json({ error: String(e.message), entries: [] }); }
});
// 用户在卡片上的决定：写回登记文件和任务状态，返回要发给智能体的消息（由界面经 WebSocket 当作用户消息发出）
app.post('/api/deviations/decide', async (req, res) => {
  try {
    const body = req.body || {};
    const task = TASKS.get(String(body.taskId || ''));
    if (!task) return res.status(404).json({ ok: false, error: '任务不存在' });
    const r = await Fidelity.decideDeviations({ task, workspace: WORKSPACE, caseDir: _taskCaseDir(task), decisions: body.decisions });
    if (!r.ok) return res.status(r.status || 400).json(r);
    persistTaskNow(task); broadcastTree();
    console.log(`[deviations] 任务 ${task.id} 用户决定：${r.applied.join(', ')}；仍未放行 ${r.open.length} 条`);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});
// 预览图集：同目录下可预览的图片/PDF（按名字自然排序），供查看器的上一张/下一张
app.get('/api/siblings', async (req, res) => {
  try {
    const f = safePath(req.query.path); const dir = path.dirname(f);
    const RE = /\.(png|jpe?g|gif|webp|bmp|svg|pdf)$/i;
    const es = await fs.readdir(dir, { withFileTypes: true });
    const files = es.filter(e => e.isFile() && RE.test(e.name) && !e.name.startsWith('.'))
      .map(e => e.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .slice(0, 500).map(n => path.relative(WORKSPACE, path.join(dir, n)).replaceAll('\\', '/'));
    res.json({ files });
  } catch (e) { res.status(500).json({ error: String(e.message), files: [] }); }
});
// 二进制附件上传（PDF/DOCX/PPTX/XLSX/图片等）：保存到 .cache/uploads/<safe>/ 下，返回相对路径
app.post('/api/upload', async (req, res) => {
  try {
    const { name, base64 } = req.body || {};
    if (typeof name !== 'string' || typeof base64 !== 'string') return res.status(400).json({ error: '参数错误' });
    const safeName = name.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').slice(-200) || ('file_' + Date.now());
    const subdir = path.join('.cache', 'uploads', Date.now().toString(36));
    const rel = path.join(subdir, safeName).replace(/\\/g, '/');
    const abs = safePath(rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const buf = Buffer.from(base64, 'base64');
    await fs.writeFile(abs, buf);
    broadcastTree();
    res.json({ ok: true, path: rel, size: buf.length });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});
app.post('/api/fs', async (req, res) => {
  try { const { op, path: p, isDir } = req.body; const f = safePath(p);
    if (op === 'create') {
      if (isDir) await fs.mkdir(f, { recursive: true });
      else { await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, '', { flag: 'wx' }); }
    } else if (op === 'delete') await fs.rm(f, { recursive: true, force: true });
    else return res.status(400).json({ error: '未知操作' });
    broadcastTree(); res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});
app.get('/api/list-abs', async (req, res) => {
  try { const dir = req.query.path ? path.resolve(req.query.path) : os.homedir();
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const items = [];
    for (const e of entries) { if (e.name.startsWith('.')) continue;
      items.push({ name: e.name, path: path.join(dir, e.name), isDir: e.isDirectory() }); }
    items.sort((a,b) => (b.isDir?1:0) - (a.isDir?1:0) || a.name.localeCompare(b.name));
    res.json({ cwd: dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), items });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});
// ===== 项目（工作区）列表：最近打开、新建、切换 =====
function _projList() { return Array.isArray(SETTINGS.projects) ? SETTINGS.projects : []; }
async function _projTouch(dir) {
  const p = path.resolve(dir), list = _projList().filter(x => path.resolve(x.path) !== p);
  list.unshift({ path: p, name: path.basename(p) || p, openedAt: Date.now() });
  SETTINGS.projects = list.slice(0, 30); await saveSettings();
}
async function _projInfo(x) {
  const out = { ...x, exists: false, cases: 0, git: false };
  try {
    out.exists = (await fs.stat(x.path)).isDirectory();
    if (out.exists) {
      out.git = fssync.existsSync(path.join(x.path, '.git'));
      const ents = await fs.readdir(x.path, { withFileTypes: true });
      for (const e of ents) if (e.isDirectory() && fssync.existsSync(path.join(x.path, e.name, 'system', 'controlDict'))) out.cases++;
    }
  } catch {}
  return out;
}
app.get('/api/projects', async (req, res) => {
  try {
    if (!_projList().some(x => path.resolve(x.path) === WORKSPACE)) await _projTouch(WORKSPACE);
    res.json({ current: WORKSPACE, home: os.homedir(), projects: await Promise.all(_projList().map(_projInfo)) });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});
app.post('/api/projects/open', async (req, res) => {
  try {
    const dir = path.resolve(String(req.body?.dir || ''));
    if (!req.body?.dir || !(await fs.stat(dir)).isDirectory()) return res.status(400).json({ error: '不是目录' });
    WORKSPACE = dir; SETTINGS.workspace = dir; await _projTouch(dir);
    res.json({ ok: true, workspace: WORKSPACE }); broadcastTree();
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});
// 新建项目：parent/name 建目录；template = empty | copy（复制已有算例 from）；可选 git init 与 README
app.post('/api/projects/create', async (req, res) => {
  try {
    const { parent, name, template, from, git, readme } = req.body || {};
    if (typeof name !== 'string' || !/^[\w.\-\u4e00-\u9fa5 ]{1,80}$/.test(name)) return res.status(400).json({ error: '项目名只能含字母、数字、中文、._- 和空格' });
    const dir = path.resolve(String(parent || os.homedir()), name.trim());
    if (fssync.existsSync(dir)) return res.status(409).json({ error: '目录已存在：' + dir });
    if (template === 'copy') {
      const src = path.resolve(String(from || ''));
      if (!from || !(await fs.stat(src)).isDirectory()) return res.status(400).json({ error: '复制来源不是目录' });
      // 复制算例：跳过分区结果、后处理、编译缓存和 git 历史
      const SKIP = /^(processor\d+|postProcessing|dynamicCode|\.git)$/;
      await fs.cp(src, dir, { recursive: true, filter: s => !path.relative(src, s).split(/[\\/]/).some(seg => SKIP.test(seg)) });
    } else await fs.mkdir(dir, { recursive: true });
    if (readme) await fs.writeFile(path.join(dir, 'README.md'), `# ${name.trim()}\n\n${String(readme).slice(0, 4000)}\n`, 'utf8');
    if (git) await new Promise(r => { const p = spawn('git', ['init', '-q'], { cwd: dir }); p.on('close', r); p.on('error', r); });
    WORKSPACE = dir; SETTINGS.workspace = dir; await _projTouch(dir);
    res.json({ ok: true, workspace: dir }); broadcastTree();
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});
app.post('/api/projects/forget', async (req, res) => {
  const p = path.resolve(String(req.body?.dir || ''));
  SETTINGS.projects = _projList().filter(x => path.resolve(x.path) !== p); await saveSettings(); res.json({ ok: true });
});
// ===== 文件操作增强：重命名/移动/复制、拖入上传到指定目录、下载、全文搜索、git 状态 =====
app.post('/api/fs/rename', async (req, res) => {
  try {
    const { from, to, copy } = req.body || {};
    const a = safePath(from), b = safePath(to);
    if (a === WORKSPACE) return res.status(400).json({ error: '不能移动工作区根目录' });
    if (fssync.existsSync(b)) return res.status(409).json({ error: '目标已存在：' + to });
    await fs.mkdir(path.dirname(b), { recursive: true });
    if (copy) await fs.cp(a, b, { recursive: true }); else await fs.rename(a, b);
    broadcastTree(); res.json({ ok: true, path: path.relative(WORKSPACE, b).replaceAll('\\', '/') });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});
// 原始字节上传：拖入文件树 / 对话框都走这里，不再 base64 膨胀。?dir=相对目录&name=文件名&overwrite=1
app.post('/api/upload-raw', express.raw({ type: () => true, limit: '512mb' }), async (req, res) => {
  try {
    const name = String(req.query.name || '').split(/[\\/]/).pop().replace(/[^\w.\-\u4e00-\u9fa5 ()]+/g, '_').slice(-200);
    if (!name || name === '.' || name === '..') return res.status(400).json({ error: '文件名无效' });
    const sub = String(req.query.dir || '.cache/uploads/' + Date.now().toString(36));
    // 拖入文件夹时浏览器给相对路径 a/b/c.txt：只允许普通段
    const relSub = String(req.query.rel || '').split(/[\\/]/).filter(s => s && s !== '.' && s !== '..').slice(0, -1).join('/');
    const abs = safePath(path.join(sub, relSub, name));
    if (fssync.existsSync(abs) && req.query.overwrite !== '1') return res.status(409).json({ error: '已存在', path: path.relative(WORKSPACE, abs).replaceAll('\\', '/') });
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, req.body || Buffer.alloc(0));
    broadcastTree(); res.json({ ok: true, path: path.relative(WORKSPACE, abs).replaceAll('\\', '/'), size: (req.body || []).length });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});
app.get('/api/download', async (req, res) => {
  try {
    const f = safePath(req.query.path); const st = await fs.stat(f);
    if (st.isDirectory()) {
      // 目录打包为 tar.gz（流式，不落盘）
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(f) + '.tar.gz')}`);
      const p = spawn('tar', ['-czf', '-', '--exclude=processor*', '-C', path.dirname(f), path.basename(f)]);
      p.stdout.pipe(res); p.on('error', () => res.end()); req.on('close', () => p.kill());
      return;
    }
    res.download(f, path.basename(f));
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});
// 全文搜索：优先 ripgrep，退回 grep；结果限量，路径相对工作区
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || ''); if (q.length < 2) return res.json({ hits: [] });
  const glob = String(req.query.glob || '');
  const run = (cmd, args) => new Promise(resolve => {
    let out = ''; let p; try { p = spawn(cmd, args, { cwd: WORKSPACE }); } catch { return resolve(null); }
    const timer = setTimeout(() => p.kill(), 8000);
    p.stdout.on('data', d => { out += d; if (out.length > 400000) p.kill(); });
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.on('close', () => { clearTimeout(timer); resolve(out); });
  });
  const ex = ['processor*', 'node_modules', '.git', 'dynamicCode', '.cache'];
  let out = await run('rg', ['--line-number', '--no-heading', '--fixed-strings', '--max-count', '5', '--max-filesize', '2M', '-i',
    ...ex.flatMap(e => ['-g', '!' + e]), ...(glob ? ['-g', glob] : []), '--', q, '.']);
  if (out === null) out = await run('grep', ['-rniIF', '-m', '5', ...ex.map(e => '--exclude-dir=' + e), ...(glob ? ['--include=' + glob] : []), '--', q, '.']);
  if (out === null) {
    // 无 rg/grep（Windows）：用 Node 逐文件扫，限 2MB/文件、5 处/文件
    const ql = q.toLowerCase(), globRe = glob ? new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i') : null;
    const lines = [];
    for (const rel of await flatList()) {
      if (lines.length >= 300) break;
      if (rel.split('/').some(s => /^processor\d+$|^dynamicCode$/.test(s))) continue;
      if (globRe && !globRe.test(rel.split('/').pop())) continue;
      const abs = path.join(WORKSPACE, rel);
      try {
        if ((await fs.stat(abs)).size > 2 << 20) continue;
        const buf = await fs.readFile(abs); if (buf.subarray(0, 4096).includes(0)) continue;
        let n = 0; buf.toString('utf8').split(/\r?\n/).forEach((l, i) => { if (n < 5 && l.toLowerCase().includes(ql)) { n++; lines.push(`${rel}:${i + 1}:${l}`); } });
      } catch {}
    }
    out = lines.join('\n');
  }
  const hits = [];
  for (const line of String(out || '').split('\n')) {
    const m = /^(?:\.\/)?(.+?):(\d+):(.*)$/.exec(line); if (!m) continue;
    hits.push({ path: m[1].replaceAll('\\', '/'), line: +m[2], text: m[3].slice(0, 240) });
    if (hits.length >= 300) break;
  }
  res.json({ hits });
});
// git 状态：分支 + 每个改动文件的状态码（文件树着色、改动面板用）
app.get('/api/git/status', async (req, res) => {
  const r = spawnSync('git', ['status', '--porcelain=v1', '-b', '-uall'], { cwd: WORKSPACE, encoding: 'utf8', timeout: 8000, maxBuffer: 8 << 20 });
  if (r.status !== 0) return res.json({ git: false });
  const lines = r.stdout.split('\n').filter(Boolean); const head = lines.shift() || '';
  const files = lines.slice(0, 2000).map(l => ({ code: l.slice(0, 2), path: l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '') }));
  res.json({ git: true, branch: head.replace(/^## /, ''), files });
});
// 会话导出为 Markdown（对话、工具调用与结果摘要）
app.get('/api/tasks/:id/export', (req, res) => {
  const t = TASKS.get(req.params.id); if (!t) return res.status(404).json({ error: '任务不存在' });
  const ev = taskHistoryPayload(t).events, out = [`# ${t.title || '任务'}`, '', `导出时间：${new Date().toISOString()}　工作区：${WORKSPACE}`, ''];
  for (const e of ev) {
    if (e.k === 'user') out.push('## 用户', '', e.text, '');
    else if (e.k === 'ai') out.push('## 智能体', '', e.text, '');
    else if (e.k === 'tool') out.push(`<details><summary>工具 ${e.name}</summary>`, '', '```json', e.args || '', '```', '', '```', e.result || '', '```', '</details>', '');
    else if (e.k === 'sys') out.push(`> ${e.text}`, '');
  }
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent((t.title || 'task').replace(/[\\/:*?"<>|]+/g, '_') + '.md')}`);
  res.send(out.join('\n'));
});
// v0.9 API 启动任务：创建任务 + headless agent，网页切换到该任务即可看到完整上下文
app.post('/api/task/run', async (req, res) => {
  try {
    const { text, title, autoMode = true, agentMode = 'build', attachments = [] } = req.body || {};
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text 必填' });
    const t = createTask((title || text.slice(0, 28)).slice(0, 60));
    t.autoMode = autoMode === true || autoMode === 'true';
    t.agentMode = agentMode === 'plan' ? 'plan' : 'build';
    persistTaskNow(t);
    const { ws, s } = _makeHeadlessSession(t);
    broadcastTaskState();
    const prompt = text.slice(0, 8000);
    setTimeout(() => runAgent(ws, prompt, attachments || []).catch(e => console.warn('[api/task/run] 失败:', e.message)), 500);
    res.json({ ok: true, taskId: t.id, title: t.title });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});
app.get('/api/git/diff', async (req, res) => {
  try {
    const rel = path.relative(WORKSPACE, safePath(req.query.path)).replaceAll('\\', '/');
    const r = spawnSync('git', ['diff', 'HEAD', '--', rel], { cwd: WORKSPACE, encoding: 'utf8', timeout: 8000, maxBuffer: 8 << 20 });
    const head = spawnSync('git', ['show', 'HEAD:' + rel], { cwd: WORKSPACE, encoding: 'utf8', timeout: 8000, maxBuffer: 8 << 20 });
    res.json({ diff: r.stdout || '', original: head.status === 0 ? head.stdout : '' });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});
app.post('/api/sim/launch', async (req, res) => {
  try { const r = await launchParaView(req.body?.casePath); res.json({ ok: true, ...r }); }
  catch (e) { res.status(500).json({ error: String(e.message) }); }
});
app.post('/api/sim/close', (req, res) => { killParaView(); res.json({ ok: true }); });

// ====================== 联网工具 ======================
function stripHtml(s) {
  return s.replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_,n)=>String.fromCharCode(+n))
          .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// 带超时的 fetch：避免某个搜索引擎不可达时长时间挂起整条爬取链
async function fetchT(url, init, ms = 9000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...(init || {}), signal: ac.signal }); }
  finally { clearTimeout(timer); }
}
async function searchDDG(query, topK) {
  const r = await fetchT('https://html.duckduckgo.com/html/', { method: 'POST', headers: { 'User-Agent': UA_DESKTOP, 'Accept': 'text/html', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'q=' + encodeURIComponent(query) });
  if (!r.ok) throw new Error('DDG ' + r.status);
  const html = await r.text();
  const out = [];
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let m; while ((m = re.exec(html)) && out.length < topK) {
    let href = m[1];
    try { const u = new URL(href, 'https://duckduckgo.com'); const real = u.searchParams.get('uddg'); if (real) href = decodeURIComponent(real); } catch {}
    out.push({ title: stripHtml(m[2]).slice(0, 160), url: href, snippet: stripHtml(m[3]).slice(0, 300) });
  }
  return out;
}
async function searchBing(query, topK) {
  const r = await fetchT('https://www.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=en-US&count=20&FORM=QBLH', { headers: { 'User-Agent': UA_DESKTOP, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' } });
  if (!r.ok) throw new Error('Bing ' + r.status);
  const html = await r.text();
  const out = [];
  // Bing 现代结构：每个结果块以 <li class="b_algo" ...> 开头，标题在
  //   <h2 class=""><a target="_blank" ... href="<真实URL>" h="ID=SERP,...">标题</a></h2>
  // 注意 href 前有 target 等属性、<h2> 带 class，旧正则因此全部失配 → 改为按块解析 + 容忍属性。
  const blocks = html.split(/<li class="b_algo"/).slice(1);
  for (const blk of blocks) {
    if (out.length >= topK) break;
    const hm = blk.match(/<h2[^>]*>\s*<a[^>]*?href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!hm) continue;
    const url = hm[1];
    if (/^https?:\/\/(www\.)?bing\.com\//i.test(url)) continue;   // 跳过 bing 内部跳转链
    const title = stripHtml(hm[2]).slice(0, 160);
    const pm = blk.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/) || blk.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    out.push({ title, url, snippet: pm ? stripHtml(pm[1]).slice(0, 300) : '' });
  }
  return out;
}
async function searchBaidu(query, topK) {
  const r = await fetchT('https://www.baidu.com/s?wd=' + encodeURIComponent(query), { headers: { 'User-Agent': UA_DESKTOP, 'Accept': 'text/html', 'Accept-Language': 'zh-CN,zh;q=0.9' } });
  if (!r.ok) throw new Error('Baidu ' + r.status);
  const html = await r.text();
  if (/百度安全验证|wappass\.baidu\.com|安全验证/.test(html)) throw new Error('Baidu 触发安全验证（需代理/Cookie）');
  const out = [];
  const re = /<h3[^>]*class="[^"]*c-title[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m; while ((m = re.exec(html)) && out.length < topK) {
    out.push({ title: stripHtml(m[2]).slice(0, 160), url: m[1], snippet: '' });
  }
  return out;
}
async function webSearch(query, topK, opts) {
  opts = opts || {};
  const topic = opts.topic || 'general';
  const timeRange = opts.time_range || '';
  const includeAnswer = opts.include_answer !== false;
  const log = typeof opts.progress === 'function' ? opts.progress : () => {};
  const fmtList = (name, items) => `[来源: ${name}]\n` + items.slice(0, topK).map((x, i) => `${i+1}. ${x.title}\n   ${x.url}\n   ${x.snippet || ''}`).join('\n');

  // --- 1. Tavily（最适合 LLM Agent 的 SOTA 搜索） ---
  const TAVILY = process.env.TAVILY_API_KEY;
  if (TAVILY) {
    log(`Tavily 检索 "${query}" …`);
    try {
      const body = {
        query, max_results: Math.min(20, topK), topic,
        search_depth: 'advanced', chunks_per_source: 3,
        include_answer: includeAnswer ? 'advanced' : false,
      };
      if (timeRange) body.time_range = timeRange;
      const r = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TAVILY },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        const j = await r.json();
        const ans = j.answer ? `\n\n📌 摘要：${j.answer}\n` : '';
        const items = (j.results || []).map(x => ({ title: x.title, url: x.url, snippet: (x.content || '').slice(0, 400) }));
        if (items.length) { log(`Tavily 命中 ${items.length} 条`); return fmtList('Tavily', items) + ans; }
      }
      log('Tavily 无结果，回落…');
    } catch (e) { log('Tavily 异常：' + e.message); }
  }
  // --- 2. Serper (google.serper.dev) ---
  const SERPER = process.env.SERPER_API_KEY;
  if (SERPER) {
    log('Serper(Google) 检索…');
    try {
      const r = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': SERPER },
        body: JSON.stringify({ q: query, num: Math.min(20, topK), gl: 'us', hl: 'en' }),
      });
      if (r.ok) {
        const j = await r.json();
        const items = (j.organic || []).map(x => ({ title: x.title, url: x.link, snippet: x.snippet }));
        if (items.length) { log(`Serper 命中 ${items.length} 条`); return fmtList('Serper(Google)', items); }
      }
    } catch (e) { log('Serper 异常：' + e.message); }
  }
  // --- 3. Brave Search API ---
  const BRAVE = process.env.BRAVE_API_KEY;
  if (BRAVE) {
    log('Brave Search 检索…');
    try {
      const r = await fetch('https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query) + '&count=' + Math.min(20, topK), {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE },
      });
      if (r.ok) {
        const j = await r.json();
        const items = ((j.web && j.web.results) || []).map(x => ({ title: x.title, url: x.url, snippet: x.description }));
        if (items.length) { log(`Brave 命中 ${items.length} 条`); return fmtList('Brave', items); }
      }
    } catch (e) { log('Brave 异常：' + e.message); }
  }
  // --- 4. SearXNG 自托管 ---
  const SEARXNG = process.env.SEARXNG_URL;
  if (SEARXNG) {
    try {
      const u = SEARXNG.replace(/\/$/, '') + '/search?format=json&q=' + encodeURIComponent(query);
      const r = await fetch(u, { headers: { 'User-Agent': UA_DESKTOP, 'Accept': 'application/json' } });
      if (r.ok) {
        const j = await r.json();
        const items = (j.results || []).map(x => ({ title: x.title, url: x.url, snippet: x.content }));
        if (items.length) return fmtList('SearXNG', items);
      }
    } catch {}
  }
  // --- 5. 兜底：HTML 爬取链（Bing 最稳 → DuckDuckGo → Baidu）---
  log('回落到 HTML 爬取链（Bing→DuckDuckGo→Baidu）…');
  const errs = [];
  for (const [name, fn] of [['Bing', searchBing], ['DuckDuckGo', searchDDG], ['Baidu', searchBaidu]]) {
    log(`尝试 ${name} …`);
    try {
      const out = await fn(query, topK);
      if (out.length > 0) {
        log(`${name} 命中 ${out.length} 条`);
        return `[来源: ${name}]\n` + out.map((x, i) => `${i+1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n');
      }
      errs.push(`${name}: 0 条结果`);
    } catch (e) { errs.push(`${name}: ${e.message}`); }
  }
  return `（联网搜索均失败，可能需要代理或配置 TAVILY_API_KEY / SERPER_API_KEY / BRAVE_API_KEY / SEARXNG_URL）\n` + errs.join('\n');
}

// ====================== 学术：paper_search / paper_fetch ======================
// Semantic Scholar Graph API (free, no key required) + arXiv API merge
function _normTitle(t) { return (t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
async function _semanticScholarSearch(query, opts) {
  const fields = 'title,abstract,year,authors.name,venue,citationCount,influentialCitationCount,openAccessPdf,externalIds,tldr,publicationDate';
  const params = new URLSearchParams({ query, limit: String(Math.min(100, opts.topK * 3)), fields });
  if (opts.year) params.set('year', opts.year);
  if (opts.openAccessOnly) params.set('openAccessPdf', '');
  if (opts.fieldsOfStudy) params.set('fieldsOfStudy', opts.fieldsOfStudy);
  const headers = { 'User-Agent': UA_DESKTOP, 'Accept': 'application/json' };
  if (process.env.SEMANTIC_SCHOLAR_API_KEY) headers['x-api-key'] = process.env.SEMANTIC_SCHOLAR_API_KEY;
  const r = await fetch('https://api.semanticscholar.org/graph/v1/paper/search?' + params.toString(), { headers });
  if (!r.ok) throw new Error('S2 ' + r.status);
  const j = await r.json();
  return (j.data || []).map(p => ({
    src: 'S2',
    paperId: p.paperId,
    title: p.title || '',
    abstract: p.abstract || (p.tldr && p.tldr.text) || '',
    year: p.year || (p.publicationDate ? p.publicationDate.slice(0, 4) : null),
    venue: p.venue || '',
    authors: (p.authors || []).map(a => a.name).slice(0, 8),
    citationCount: p.citationCount || 0,
    influentialCitationCount: p.influentialCitationCount || 0,
    doi: p.externalIds && p.externalIds.DOI || '',
    arxivId: p.externalIds && p.externalIds.ArXiv || '',
    pdf: p.openAccessPdf && p.openAccessPdf.url || '',
    tldr: p.tldr && p.tldr.text || '',
  }));
}
async function _arxivSearch(query, opts) {
  const params = new URLSearchParams({
    search_query: 'all:' + query,
    start: '0',
    max_results: String(Math.min(50, opts.topK * 2)),
    sortBy: 'relevance', sortOrder: 'descending',
  });
  const r = await fetch('http://export.arxiv.org/api/query?' + params.toString(), { headers: { 'User-Agent': UA_DESKTOP } });
  if (!r.ok) throw new Error('arXiv ' + r.status);
  const xml = await r.text();
  const out = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g; let m;
  while ((m = entryRe.exec(xml))) {
    const ent = m[1];
    const get = (tag) => { const mm = ent.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>')); return mm ? stripHtml(mm[1]).trim() : ''; };
    const id = get('id');
    const arxivId = id.replace(/^https?:\/\/arxiv\.org\/abs\//, '').replace(/v\d+$/, '');
    const authors = [...ent.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(x => x[1].trim()).slice(0, 8);
    const pubDate = get('published');
    out.push({
      src: 'arXiv',
      paperId: 'ARXIV:' + arxivId,
      title: get('title').replace(/\s+/g, ' '),
      abstract: get('summary').replace(/\s+/g, ' '),
      year: pubDate ? pubDate.slice(0, 4) : null,
      venue: 'arXiv',
      authors,
      citationCount: 0,
      influentialCitationCount: 0,
      doi: get('arxiv:doi') || '',
      arxivId,
      pdf: 'https://arxiv.org/pdf/' + arxivId + '.pdf',
      tldr: '',
    });
  }
  return out;
}
async function paperSearch(query, opts) {
  opts = opts || {}; const topK = opts.topK || 8;
  const log = typeof opts.progress === 'function' ? opts.progress : () => {};
  log(`并行检索 Semantic Scholar + arXiv "${query}" …`);
  const results = await Promise.allSettled([
    _semanticScholarSearch(query, { topK, year: opts.year, openAccessOnly: opts.openAccessOnly, fieldsOfStudy: opts.fieldsOfStudy }),
    _arxivSearch(query, { topK }),
  ]);
  const okCount = results.filter(r => r.status === 'fulfilled').length;
  log(`来源响应 ${okCount}/2，合并去重排序中…`);
  const all = [];
  for (const r of results) if (r.status === 'fulfilled') all.push(...r.value);
  if (!all.length) {
    const errs = results.filter(r => r.status === 'rejected').map(r => r.reason.message);
    return '论文检索失败：\n' + (errs.length ? errs.join('\n') : '没有匹配结果');
  }
  // 去重：先按 DOI，再按 arxivId，最后按归一化标题
  const seen = new Map();
  for (const p of all) {
    const key = (p.doi && p.doi.toLowerCase()) || (p.arxivId && 'arxiv:' + p.arxivId) || _normTitle(p.title);
    if (!seen.has(key)) seen.set(key, p);
    else {
      // 合并 Semantic Scholar 的 citationCount 到已存在 arXiv 条目
      const exist = seen.get(key);
      if (p.citationCount > exist.citationCount) exist.citationCount = p.citationCount;
      if (!exist.tldr && p.tldr) exist.tldr = p.tldr;
      if (!exist.pdf && p.pdf) exist.pdf = p.pdf;
      if (!exist.abstract && p.abstract) exist.abstract = p.abstract;
    }
  }
  const merged = [...seen.values()];
  // 排序：综合分 = log10(citations+1)*5 + 新鲜度（近 5 年加分）
  const nowY = new Date().getFullYear();
  merged.sort((a, b) => {
    const sa = Math.log10((a.citationCount || 0) + 1) * 5 + (a.year ? Math.max(0, 6 - (nowY - a.year)) : 0);
    const sb = Math.log10((b.citationCount || 0) + 1) * 5 + (b.year ? Math.max(0, 6 - (nowY - b.year)) : 0);
    return sb - sa;
  });
  if (opts.openAccessOnly) {
    for (let i = merged.length - 1; i >= 0; i--) if (!merged[i].pdf) merged.splice(i, 1);
  }
  const top = merged.slice(0, topK);
  return `[paper_search] "${query}" → 找到 ${merged.length} 篇（显示前 ${top.length}），按引用+新鲜度排序：\n\n` +
    top.map((p, i) => {
      const auth = p.authors.length ? p.authors.slice(0, 4).join(', ') + (p.authors.length > 4 ? ' et al.' : '') : '';
      const cites = p.citationCount ? `📎 ${p.citationCount} 引用` : (p.src === 'arXiv' ? '📎 arXiv preprint' : '');
      const ids = [p.doi && 'DOI:' + p.doi, p.arxivId && 'ARXIV:' + p.arxivId].filter(Boolean).join(' | ');
      const pdf = p.pdf ? `\n   📄 PDF: ${p.pdf}` : '';
      const tldr = p.tldr ? `\n   🧬 TL;DR: ${p.tldr}` : '';
      const abs = p.abstract ? `\n   摘要: ${p.abstract.slice(0, 500)}${p.abstract.length > 500 ? '…' : ''}` : '';
      return `${i+1}. ${p.title}  (${p.year || '?'}, ${p.venue || p.src})\n   作者: ${auth}\n   ${cites}  ${ids}${pdf}${tldr}${abs}`;
    }).join('\n\n') +
    `\n\n💡 用 paper_fetch("DOI:xxx" 或 "ARXIV:xxx") 拿完整 references；加 download:true 直接把 OA PDF 存到 downloads/papers/，再 read_paper 抽章节。`;
}
function _normalizeId(id) {
  id = (id || '').trim();
  if (/^10\.\d{4,}\//.test(id)) return 'DOI:' + id;                       // bare DOI
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(id)) return 'ARXIV:' + id.replace(/v\d+$/, ''); // bare arXiv
  if (/^arxiv:/i.test(id)) return 'ARXIV:' + id.replace(/^arxiv:/i, '').replace(/v\d+$/, '');
  return id;
}
async function paperFetch(id, opts) {
  opts = opts || {}; const maxRefs = opts.maxRefs || 30;
  const log = typeof opts.progress === 'function' ? opts.progress : () => {};
  const norm = _normalizeId(id);
  log(`Semantic Scholar 拉取 ${norm} 元数据 + 引用…`);
  const headers = { 'User-Agent': UA_DESKTOP, 'Accept': 'application/json' };
  if (process.env.SEMANTIC_SCHOLAR_API_KEY) headers['x-api-key'] = process.env.SEMANTIC_SCHOLAR_API_KEY;
  const fields = 'title,abstract,year,authors.name,venue,citationCount,influentialCitationCount,openAccessPdf,externalIds,tldr,publicationDate,references.title,references.year,references.authors.name,references.externalIds,references.citationCount';
  const r = await fetch(`https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(norm)}?fields=${encodeURIComponent(fields)}`, { headers });
  if (!r.ok) {
    if (r.status === 404) return `论文未找到：${norm}（确认 ID 形式：DOI:10.x/x、ARXIV:2106.15928、Semantic Scholar 40 位 hex）`;
    return `paper_fetch 失败：HTTP ${r.status} ${await r.text().catch(() => '')}`;
  }
  const p = await r.json();
  const auth = (p.authors || []).map(a => a.name).join(', ');
  const pdf = p.openAccessPdf && p.openAccessPdf.url || '';
  const refs = (p.references || []).slice(0, maxRefs).map((rf, i) => {
    const a = (rf.authors || []).map(x => x.name).slice(0, 3).join(', ');
    const doi = rf.externalIds && rf.externalIds.DOI ? ` DOI:${rf.externalIds.DOI}` : '';
    const arx = rf.externalIds && rf.externalIds.ArXiv ? ` ARXIV:${rf.externalIds.ArXiv}` : '';
    return `  [${i+1}] ${rf.title || '(无标题)'} — ${a || '?'} (${rf.year || '?'})${doi}${arx}${rf.citationCount ? ' ('+rf.citationCount+' cit)' : ''}`;
  }).join('\n');
  let dl = '';
  if (opts.download && pdf) {
    try {
      const safeName = (p.externalIds && (p.externalIds.DOI || p.externalIds.ArXiv) || p.paperId || 'paper').replace(/[^\w.\-]+/g, '_').slice(0, 80) + '.pdf';
      log(`下载 OA PDF: ${pdf} → downloads/papers/${safeName}`);
      dl = '\n\n' + await downloadFile(pdf, path.join('downloads', 'papers', safeName));
    } catch (e) { dl = '\n\n下载 PDF 失败：' + e.message; }
  } else if (opts.download && !pdf) {
    dl = '\n\n（无 Open-Access PDF 可下载）';
  }
  return `# ${p.title}
${auth}
${p.venue || ''}${p.year ? ', ' + p.year : ''}${p.citationCount ? `  •  ${p.citationCount} citations (${p.influentialCitationCount || 0} influential)` : ''}
${p.externalIds && p.externalIds.DOI ? 'DOI: ' + p.externalIds.DOI : ''}${p.externalIds && p.externalIds.ArXiv ? '  ARXIV:' + p.externalIds.ArXiv : ''}
${pdf ? 'OA PDF: ' + pdf : ''}

## TL;DR
${p.tldr && p.tldr.text || '（无）'}

## Abstract
${p.abstract || '（无）'}

## References (top ${Math.min(maxRefs, (p.references || []).length)} / ${(p.references || []).length})
${refs || '（无）'}${dl}`;
}

// ====================== 论文章节抽取 read_paper ======================
async function readPaper(p, focus, progress) {
  const log = typeof progress === 'function' ? progress : () => {};
  log(`PDF/DOCX → 文本：${p}`);
  const raw = await readDocument(p, log);
  log(`原文 ${raw.length} 字符，开始章节切分…`);
  // 找正文（去掉 readDocument 头部 [type · N 页 · WxH]）
  const headMatch = raw.match(/^\[[^\]]+\]\s*\n/);
  const body = headMatch ? raw.slice(headMatch[0].length) : raw;
  // 章节标题正则：行首或换行后大写或编号标题
  const SEC = [
    { key: 'Abstract',     re: /(?:^|\n)\s*(?:[IVX]+\.\s*|\d{0,2}\.?\s*)?abstract\b[^\n]*\n/i },
    { key: 'Keywords',     re: /(?:^|\n)\s*(?:key\s*words?|keywords)\b[^\n]*\n/i },
    { key: 'Introduction', re: /(?:^|\n)\s*(?:[IVX]+\.\s*|\d{0,2}\.?\s*)?introduction\b[^\n]*\n/i },
    { key: 'Background',   re: /(?:^|\n)\s*(?:[IVX]+\.\s*|\d{0,2}\.?\s*)?(?:background|related\s*work|literature\s*review)\b[^\n]*\n/i },
    { key: 'Methods',      re: /(?:^|\n)\s*(?:[IVX]+\.\s*|\d{0,2}\.?\s*)?(?:methods?|methodology|mathematical\s*model|governing\s*equations?|numerical\s*method|materials?\s*and\s*methods?|model(?:ing)?\s*(?:and|&)?\s*(?:simulation|equations?)?)\b[^\n]*\n/i },
    { key: 'Experiments',  re: /(?:^|\n)\s*(?:[IVX]+\.\s*|\d{0,2}\.?\s*)?(?:experiments?|experimental\s*(?:setup|details?|procedure)|simulation\s*setup|case\s*setup|validation)\b[^\n]*\n/i },
    { key: 'Results',      re: /(?:^|\n)\s*(?:[IVX]+\.\s*|\d{0,2}\.?\s*)?(?:results?|results?\s*and\s*discussions?|discussions?|findings)\b[^\n]*\n/i },
    { key: 'Conclusion',   re: /(?:^|\n)\s*(?:[IVX]+\.\s*|\d{0,2}\.?\s*)?(?:conclusions?|concluding\s*remarks|summary)\b[^\n]*\n/i },
    { key: 'References',   re: /(?:^|\n)\s*(?:[IVX]+\.\s*|\d{0,2}\.?\s*)?(?:references?|bibliography)\b[^\n]*\n/i },
  ];
  const hits = [];
  for (const s of SEC) {
    const m = body.match(s.re);
    if (m) hits.push({ key: s.key, idx: m.index + m[0].indexOf(m[0].trimStart()), end: m.index + m[0].length });
  }
  hits.sort((a, b) => a.idx - b.idx);
  const sections = [];
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].end;
    const end = i + 1 < hits.length ? hits[i+1].idx : body.length;
    let txt = body.slice(start, end).trim();
    if (txt.length > 3500) txt = txt.slice(0, 3500) + '\n…[本节较长，已截断；如需全文请用 read_document 然后 grep_search]';
    sections.push({ key: hits[i].key, text: txt });
  }
  // 没识别出来任何章节 → 退化为前 3500 字
  if (!sections.length) {
    return `# ${path.basename(p)}\n\n（未识别出章节结构，可能是非论文 PDF——下面是正文前 3500 字）\n\n${body.slice(0, 3500)}`;
  }
  // 标题（优先取正文开头第一行非空、长度 < 200）
  let title = '';
  const firstLines = body.slice(0, 1500).split(/\n/).map(l => l.trim()).filter(Boolean);
  for (const l of firstLines) { if (l.length >= 6 && l.length < 200 && !/^abstract\b/i.test(l)) { title = l; break; } }
  // 方程编号统计
  const eqMatches = body.match(/\(\s*\d{1,3}[a-z]?\s*\)/g) || [];
  const eqCount = new Set(eqMatches).size;
  // 图表统计
  const figCount = (body.match(/\bFig(?:\.|ure)?\s*\d+/gi) || []).length;
  const tblCount = (body.match(/\bTable\s*\d+/gi) || []).length;

  let out = `# ${title || path.basename(p)}\n\n📊 结构：${sections.length} 个识别章节 · 公式编号 ${eqCount} 个 · 图 ${figCount} 处 · 表 ${tblCount} 处\n\n`;
  for (const s of sections) {
    out += `## ${s.key}\n${s.text}\n\n`;
  }
  if (focus) {
    const fr = new RegExp(focus.split(/\s+/).filter(Boolean).join('|'), 'gi');
    const paras = body.split(/\n\s*\n/);
    const hitsP = [];
    for (const para of paras) {
      const matches = para.match(fr);
      if (matches && matches.length >= 1 && para.length > 30) hitsP.push({ para, hits: matches.length });
      if (hitsP.length > 30) break;
    }
    hitsP.sort((a, b) => b.hits - a.hits);
    if (hitsP.length) {
      out += `## 🔍 focus="${focus}" 命中段落 (${hitsP.length} 段，按命中数排序，前 8)\n\n`;
      for (const h of hitsP.slice(0, 8)) {
        out += `> ${h.para.replace(/\s+/g, ' ').slice(0, 700)}${h.para.length > 700 ? '…' : ''}\n\n`;
      }
    } else {
      out += `## 🔍 focus="${focus}" 未在正文中命中关键词\n\n`;
    }
  }
  return out;
}

// ====================== paper_extract：grounded 结构化抽取 ======================
// 只抽原文里「真实出现」的内容：带编号方程 / 表格 / 带单位数值参数；不臆造。
// 方程/复杂版面建议配合 render_pages + vision_analyze 做逐字精转写。
// 论文嵌入图按原始分辨率抽出（整页渲染会把小插图糊掉：DMTO 分布器插图原图只有 113×165 像素）
async function paperFigures(args) {
  const pdf = safePath(String(args.path || ''));
  const outDir = path.join(WORKSPACE, '.nullflux', 'figs', path.basename(pdf).replace(/\.pdf$/i, '').replace(/[^\w.-]+/g, '_'));
  await fs.mkdir(outDir, { recursive: true });
  const py = SETTINGS.pythonPath || (IS_WIN ? 'python' : 'python3');
  const code = `
import fitz, json, re, sys, os
doc = fitz.open(sys.argv[1]); out = sys.argv[2]; res = []
for pno in range(len(doc)):
    page = doc[pno]; caps = [m.group(0)[:220] for m in re.finditer(r'(Fig\\.?|Figure|图)\\s*\\d+[.:．][^\\n]*', page.get_text())]
    for k, img in enumerate(page.get_images(full=True)):
        try: d = doc.extract_image(img[0])
        except Exception: continue
        if d['width'] * d['height'] < 40000: continue
        f = os.path.join(out, f'p{pno+1}_{k}.{d["ext"]}'); open(f, 'wb').write(d['image'])
        res.append(dict(file=f, page=pno + 1, width=d['width'], height=d['height'], captions=caps[:4]))
print(json.dumps(res))`;
  const r = await _spawnP(py, ['-c', code, pdf, outDir]);
  if (r.code !== 0) throw new Error('抽图失败（需要 PyMuPDF）：' + (r.err || r.out).trim().split('\n').pop());
  const list = JSON.parse(r.out.trim().split('\n').pop() || '[]');
  const rel = f => path.relative(WORKSPACE, f).replace(/\\/g, '/');
  return `[paper_figures] ${list.length} 张嵌入图（原始分辨率）已存到 ${rel(outDir)}\n` + list.map(x => `- ${rel(x.file)}  第 ${x.page} 页  ${x.width}×${x.height}px${x.captions.length ? '  图注：' + x.captions.join(' | ') : ''}`).join('\n')
    + '\n下一步：对几何图用 image_crop 放大部件（分布器、喷嘴、内构件）后 vision_analyze；按图上标注尺寸换比例尺。';
}
// 裁剪 + 放大（LANCZOS）+ 像素测距；ref 给已知尺寸的两点和真实长度 → 换算 mm/px
async function imageCrop(args) {
  const src = safePath(String(args.path || ''));
  const box = Array.isArray(args.box) && args.box.length === 4 ? args.box.map(Number) : null;
  const scale = Math.min(Math.max(+args.scale || 4, 1), 12);
  const out = path.join(path.dirname(src), path.basename(src).replace(/\.\w+$/, '') + `_crop_${box ? box.join('-') : 'full'}_x${scale}.png`);
  const py = SETTINGS.pythonPath || (IS_WIN ? 'python' : 'python3');
  const code = `
import json, sys, math
from PIL import Image
a = json.loads(sys.argv[1]); im = Image.open(a['src']).convert('RGB'); W, H = im.size
b = a['box'] or [0, 0, W, H]; c = im.crop(tuple(int(v) for v in b)); c = c.resize((max(1, c.width * a['scale']), max(1, c.height * a['scale'])), Image.LANCZOS); c.save(a['out'])
res = dict(src_size=[W, H], box=b, out_size=list(c.size))
ref = a.get('ref')
mmpx = (ref['mm'] / math.dist(ref['p1'], ref['p2'])) if ref else None
if mmpx: res['mm_per_px'] = mmpx
res['measure'] = [dict(p1=m[0], p2=m[1], px=math.dist(m[0], m[1]), mm=(math.dist(m[0], m[1]) * mmpx if mmpx else None)) for m in (a.get('measure') or [])]
print(json.dumps(res))`;
  const r = await _spawnP(py, ['-c', code, JSON.stringify({ src, out, box, scale, ref: args.ref || null, measure: args.measure || [] })]);
  if (r.code !== 0) throw new Error('裁剪失败：' + (r.err || r.out).trim().split('\n').pop());
  const j = JSON.parse(r.out.trim().split('\n').pop());
  const rel = path.relative(WORKSPACE, out).replace(/\\/g, '/');
  return `[image_crop] ${rel}（原图 ${j.src_size.join('×')}，裁 ${JSON.stringify(j.box)}，放大 ${scale}×）`
    + (j.mm_per_px ? `\n比例尺 ${j.mm_per_px.toFixed(3)} mm/px（坐标均为原图像素）` : '')
    + j.measure.map(m => `\n${JSON.stringify(m.p1)}→${JSON.stringify(m.p2)}：${m.px.toFixed(1)} px${m.mm !== null ? ` ≈ ${m.mm.toFixed(1)} mm（±${(j.mm_per_px * 1.5).toFixed(1)} mm，按 ±1.5 px）` : ''}`).join('')
    + `\n用 vision_analyze(images=["${rel}"]) 细看。`;
}

async function paperExtract(p, focus, renderPages, progress) {
  const log = typeof progress === 'function' ? progress : () => {};
  log(`paper_extract：解析 ${p}${renderPages ? '（含整页渲染）' : ''}…`);
  const raw = await readDocument(p, log, { renderPages: !!renderPages });
  const headMatch = raw.match(/^\[[^\]]+\]\s*\n/);
  const body = headMatch ? raw.slice(headMatch[0].length) : raw;
  const lines = body.split(/\n/);

  // 1) 带编号方程：行尾形如 (12) / (3a)，连同上一行上下文一起记，附所在页
  const equations = [];
  let curPage = 0;
  for (let i = 0; i < lines.length; i++) {
    const pm = lines[i].match(/^---\s*第\s*(\d+)\s*页/);
    if (pm) { curPage = parseInt(pm[1], 10); continue; }
    const m = lines[i].match(/(.+?)\(\s*(\d{1,3}[a-z]?)\s*\)\s*$/);
    if (m && /[=+\-/*∇∂Σαβγρμνλ√≈≤≥]|\\frac|\^|_\{|\bd[uvwpTt]\b/.test(m[1]) && m[1].trim().length >= 4) {
      const ctx = (lines[i - 1] && lines[i - 1].trim().length < 120 ? lines[i - 1].trim() + ' ' : '');
      equations.push({ no: m[2], page: curPage, text: (ctx + m[1].trim()).slice(0, 280) });
    }
    if (equations.length >= 60) break;
  }

  // 2) 表格：doc_reader 已抽成 [表 P..] Markdown 块
  const tables = [];
  const tblRe = /\[表\s*P(\d+)-(\d+)\]\n((?:\|[^\n]*\n?)+)/g;
  let tm;
  while ((tm = tblRe.exec(body)) && tables.length < 20) {
    tables.push({ page: parseInt(tm[1], 10), idx: parseInt(tm[2], 10), md: tm[3].trim() });
  }

  // 3) 带单位数值参数（grounded：number+单位 或 符号=number 单位）
  const UNIT = '(?:m/s|m\\^?2/s|m\\^?3/s|kg/m\\^?3|kg·?m\\^?-?3|kg/s|mol/m\\^?3|W/m\\^?2|W/\\(?m·?K\\)?|J/kg|J/\\(?kg·?K\\)?|N·?m|Pa·?s|mm/s|µm|um|nm|mm|cm|km|m\\b|Pa|kPa|MPa|GPa|bar|atm|K\\b|°C|℃|Hz|kHz|MHz|rpm|kg|g\\b|mg|N\\b|kN|J\\b|kJ|MJ|W\\b|kW|MW|s\\b|ms|µs|min|%)';
  const numUnitRe = new RegExp('([A-Za-z][A-Za-z0-9_]{0,8}\\s*[=:]\\s*)?([-+]?\\d[\\d.,]*(?:[eE][-+]?\\d+)?(?:\\s*[×x]\\s*10\\^?[-+]?\\d+)?)\\s*(' + UNIT + ')', 'g');
  const params = [];
  const seenP = new Set();
  let pm2;
  let scan = body.slice(0, 120000);
  while ((pm2 = numUnitRe.exec(scan)) && params.length < 80) {
    const sym = (pm2[1] || '').replace(/[=:\s]+$/, '').trim();
    const val = pm2[2].trim(); const unit = pm2[3].trim();
    const key = (sym ? sym + '=' : '') + val + unit;
    if (seenP.has(key)) continue; seenP.add(key);
    params.push({ symbol: sym, value: val, unit });
  }

  // 4) 渲染的整页图（供 vision_analyze 逐字精转写方程）
  const pageImgs = [];
  const imgRe = /\/api\/file\?raw=1&path=([^\s)\]]+)/g;
  let im;
  while ((im = imgRe.exec(raw))) {
    const rel = decodeURIComponent(im[1]);
    if (/page_p\d+\.png$/i.test(rel) && !pageImgs.includes(rel)) pageImgs.push(rel);
  }

  // 组织输出
  let out = `# paper_extract · ${path.basename(p)}\n`;
  out += `> grounded 抽取：以下条目均来自原文文本层；**方程逐字/数值精度请用 vision_analyze 比对原页图**，再用 paper_param_verify 核验单位量纲。\n\n`;
  out += `## 📐 带编号方程（${equations.length}）\n`;
  if (equations.length) for (const e of equations) out += `- (${e.no}) P${e.page}: ${e.text}\n`;
  else out += '（文本层未识别到编号方程——多半是图片型公式，请 render_pages=true 后对相关页 vision_analyze）\n';
  out += `\n## 📋 表格（${tables.length}）\n`;
  if (tables.length) for (const t of tables) out += `\n表 P${t.page}-${t.idx}:\n${t.md}\n`;
  else out += '（未抽到结构化表格）\n';
  out += `\n## 🔢 带单位参数（${params.length}，去重）\n`;
  if (params.length) out += params.map(p => `- ${p.symbol ? p.symbol + ' = ' : ''}${p.value} ${p.unit}`).join('\n') + '\n';
  else out += '（未匹配到 number+单位 形式的参数）\n';
  if (focus) {
    const fr = new RegExp(focus.split(/\s+/).filter(Boolean).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
    const paras = body.split(/\n\s*\n/).filter(x => x.length > 30 && fr.test(x));
    fr.lastIndex = 0;
    out += `\n## 🔍 focus="${focus}" 命中段落（前 6）\n`;
    out += paras.length ? paras.slice(0, 6).map(x => `> ${x.replace(/\s+/g, ' ').slice(0, 600)}`).join('\n\n') + '\n' : '（未命中）\n';
  }
  if (pageImgs.length) {
    out += `\n## 🖼 已渲染整页（可直接喂给 vision_analyze 做方程/表格逐字精转写）\n`;
    out += pageImgs.slice(0, 40).map((r, i) => `- [P${i + 1}] ${r}`).join('\n') + '\n';
  } else if (renderPages) {
    out += `\n（未生成整页图：可能 PDF 无文本页或 PyMuPDF 渲染失败）\n`;
  }
  return out;
}

// ====================== vision_analyze ======================
async function _imageToDataUrl(p) {
  if (/^https?:\/\//i.test(p)) {
    const r = await fetch(p, { headers: { 'User-Agent': UA_DESKTOP } });
    if (!r.ok) throw new Error('图片下载失败：HTTP ' + r.status + ' ' + p);
    const ct = r.headers.get('content-type') || 'image/png';
    const buf = Buffer.from(await r.arrayBuffer());
    return 'data:' + ct.split(';')[0] + ';base64,' + buf.toString('base64');
  }
  const abs = path.isAbsolute(p) ? p : safePath(p);
  const buf = await fs.readFile(abs);
  const ext = path.extname(abs).slice(1).toLowerCase();
  const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
  const mime = mimeMap[ext] || 'image/png';
  return 'data:' + mime + ';base64,' + buf.toString('base64');
}
async function visionAnalyze(images, question, maxTokens, progress) {
  const VISION_TIMEOUT_MS = parseInt(process.env.VISION_TIMEOUT_MS || '120000', 10);
  const log = typeof progress === 'function' ? progress : () => {};
  if (!images || !images.length) return 'vision_analyze 需要至少 1 张图片路径';
  if (!question) return 'vision_analyze 需要 question 参数';
  log(`编码 ${Math.min(images.length, 6)} 张图为 base64 …`);
  const dataUrls = [];
  for (const im of images.slice(0, 6)) {
    try { dataUrls.push(await _imageToDataUrl(im)); }
    catch (e) { return '读图失败：' + e.message; }
  }
  log(`调用 VLM (专用视觉模型路由，detail=high) …`);
  const sys = '你是高精度科技图像分析助手。任务：严格按用户问题从图片中提取信息，给出有数值、有单位、有坐标的结构化回答。如果是曲线图：列出每条曲线的标签 + 关键点 (x,y) 数值（在网格刻度间用线性插值估算并标注"估读"）。如果是公式：用 LaTeX 转写完整公式与等号两侧符号定义。如果是表格：用 Markdown 表格转写。如果是流程图：用编号列出节点与连接关系。无法确定的数值写"难以辨认"，绝不要编造。';
  const userContent = [
    { type: 'text', text: question + '\n\n（请按上述格式严格作答；引用图片时用 [图1] [图2] 编号）' },
    ...dataUrls.map(u => ({ type: 'image_url', image_url: { url: u, detail: 'high' } })),
  ];
  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: userContent },
  ];
  try {
    const config = resolveChatConfig(SETTINGS, { vision: true });
    const useDedicated = config.dedicated;
    let resp, j;
    if (config.provider === 'copilot') {
      const tok = await copilotRefreshApiToken();
      resp = await fetch('https://api.githubcopilot.com/chat/completions', {
        method: 'POST',
        headers: copilotHeaders(tok),
        body: JSON.stringify({ model: SETTINGS.copilotModel || SETTINGS.model || 'gpt-4.1', messages, temperature: 0.0, max_tokens: maxTokens, stream: false }),
      });
    } else {
      // 非流式整包返回：上游卡住时没有 IDLE 看门狗兜底，必须有总超时，否则整个智能体停在这一步
      resp = await fetch(config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (config.apiKey || 'local') },
        body: JSON.stringify({ model: config.model, messages, temperature: 0.0, max_tokens: maxTokens, stream: false }),
        signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
      });
    }
    if (!resp.ok) return 'vision_analyze HTTP ' + resp.status + ' (model=' + (config.model || SETTINGS.copilotModel || SETTINGS.model) + '): ' + (await resp.text().catch(() => '')).slice(0, 500) + '\n提示：所选接口和模型必须支持 OpenAI 兼容的 image_url 视觉输入；可在模型设置中配置独立 VLM。';
    j = await resp.json();
    const ans = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '（模型未返回内容）';
    const tag = useDedicated ? ` · ${SETTINGS.visionModel}` : '';
    return `[vision_analyze · ${dataUrls.length} 张图 · detail=high${tag}]\n\n` + ans;
  } catch (e) {
    return 'vision_analyze 异常：' + e.message;
  }
}

// ====================== 图片搜索（Bing Images） ======================
async function imageSearch(query, topK) {
  const url = 'https://www.bing.com/images/search?q=' + encodeURIComponent(query) + '&form=HDRSC2&FORM=IRFLTR&first=1';
  const r = await fetch(url, { headers: { 'User-Agent': UA_DESKTOP, 'Accept': 'text/html', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' } });
  if (!r.ok) throw new Error('Bing Images ' + r.status);
  const html = await r.text();
  const out = [];
  // Bing 把每张图的元数据 JSON 编码塞在 class="iusc" 元素的 m="..." 属性里
  const re = /<a[^>]+class="iusc"[^>]+m="([^"]+)"/g;
  let m; const seen = new Set();
  while ((m = re.exec(html)) && out.length < topK) {
    try {
      const meta = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      const image = meta.murl || meta.turl;
      if (!image || seen.has(image)) continue;
      seen.add(image);
      out.push({
        image,
        thumb: meta.turl || image,
        title: meta.t || '',
        source: meta.purl || '',
        host: meta.dom || '',
        w: meta.mw, h: meta.mh
      });
    } catch {}
  }
  // 兜底：直接抓 <img class="mimg" src="...">
  if (out.length === 0) {
    const re2 = /<img[^>]+class="mimg"[^>]+src="([^"]+)"[^>]*>/g;
    while ((m = re2.exec(html)) && out.length < topK) {
      if (m[1].startsWith('http')) out.push({ image: m[1], thumb: m[1], title: '', source: '', host: '' });
    }
  }
  return out;
}

function broadcastImages(images, query) {
  const msg = JSON.stringify({ type: 'images', images, query });
  for (const ws of allClients) if (ws.readyState === 1) ws.send(msg);
}
async function fetchUrlText(url, maxChars, withImages, progress) {
  const log = typeof progress === 'function' ? progress : () => {};
  log(`GET ${url} …`);
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }, redirect: 'follow' });
  if (!r.ok) return `[HTTP ${r.status}] ${url}`;
  const ct = r.headers.get('content-type') || '';
  let raw = await r.text();
  log(`HTTP ${r.status} · ${ct || '?'} · ${raw.length} 字符`);
  let text = ct.includes('html') ? stripHtml(raw) : raw;
  text = text.slice(0, maxChars);
  if (withImages && ct.includes('html')) {
    try {
      const imgs = [];
      const re = /<img[^>]+>/gi;
      let m;
      while ((m = re.exec(raw)) && imgs.length < 20) {
        const tag = m[0];
        const src = (tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1];
        const alt = (tag.match(/\balt\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
        if (!src || src.startsWith('data:')) continue;
        const abs = new URL(src, url).href;
        imgs.push({ src: abs, alt });
      }
      if (imgs.length) {
        text += '\n\n--- 页面图片（共 ' + imgs.length + ' 张，可用 download_file 下载）---\n' +
                imgs.map((x, i) => `[${i+1}] ${x.alt || '(无 alt)'}\n     ${x.src}`).join('\n');
      }
    } catch {}
  }
  return text;
}

// ====================== 文档读取（PDF/DOCX/PPTX/XLSX/IMG） ======================
async function readDocument(p, progress, opts) {
  const log = typeof progress === 'function' ? progress : () => {};
  if (!p) throw new Error('缺少 path');
  const abs = path.isAbsolute(p) ? p : safePath(p);
  await fs.access(abs);
  const py = SETTINGS.pythonPath || (IS_WIN ? 'python' : 'python3');
  const script = path.join(__dirname, 'doc_reader.py');
  log(`Python doc_reader.py 解析 ${path.basename(abs)} …`);
  // PDF 图片输出到工作区下 .cache/pdf_images/<safe>/  ——前端可通过 /api/file?raw=1&path= 预览
  const safeBase = path.basename(abs).replace(/[^\w.\-]+/g, '_').slice(0, 80);
  const imgOutAbs = path.join(WORKSPACE, '.cache', 'pdf_images', safeBase + '_' + Date.now().toString(36));
  try { await fs.mkdir(imgOutAbs, { recursive: true }); } catch {}
  const extraEnv = (opts && opts.renderPages) ? { PDF_RENDER_PAGES: '1', PDF_RENDER_DPI: String(opts.renderDpi || 150) } : {};
  return await new Promise((resolve) => {
    const proc = spawn(py, [script, abs], {
      windowsHide: true,
      env: { ...process.env, PDF_IMG_OUT_DIR: imgOutAbs, ...extraEnv },
    });
    let out = '', err = '', killed = false;
    const OUT_HARD_CAP = 8 * 1024 * 1024; // 8MB stdout 上限，防止 doc_reader 返回上百万字
    proc.stdout.on('data', d => {
      if (killed) return;
      out += d.toString();
      if (out.length > OUT_HARD_CAP) { killed = true; try { proc.kill(); } catch {} }
    });
    proc.stderr.on('data', d => { err += d.toString(); if (err.length > 65536) err = err.slice(-65536); });
    proc.on('error', e => resolve('调用 Python 失败：' + e.message + '（请在顶部 Python 选择器选好解释器）'));
    proc.on('close', () => {
      try {
        const j = JSON.parse(out);
        if (!j.ok) return resolve('读取失败：' + (j.error || '未知') + (err ? '\n' + err.slice(-300) : ''));
        const head = `[${j.type}${j.pages ? ` · ${j.pages} 页` : ''}${j.size ? ` · ${j.size.join('x')}` : ''}]`;
        const fullLen = (j.text || '').length;
        const body = (j.text || '').slice(0, 20000);
        const trailer = fullLen > 20000 ? `\n... [原文 ${fullLen} 字，仅返回前 20000；需定位其他部分请告知关键词后重调，或用 grep_search] ...` : '';
        // 图片：转为 /api/file?raw=1&path=<rel> 形式塞进结果尾部，前端 tool_result 自动提取并渲染缩略图
        let imgBlock = '';
        const imgs = Array.isArray(j.images) ? j.images : [];
        if (imgs.length) {
          const items = [];
          const galleryItems = [];
          for (const im of imgs.slice(0, 60)) {
            try {
              const rel = path.relative(WORKSPACE, im.path).replace(/\\/g, '/');
              if (rel.startsWith('..')) continue;
              const url = `/api/file?raw=1&path=${encodeURIComponent(rel)}`;
              const tag = im.kind === 'scan_page' ? `扫描页 P${im.page}` : `图 P${im.page}-${im.index}`;
              items.push(`${tag} ${im.w}x${im.h}: ${url}`);
              galleryItems.push({
                image: url, thumb: url,
                title: `${tag} ${im.w}x${im.h}` + (im.ocr ? ' · ' + im.ocr.slice(0, 40).replace(/\s+/g, ' ') : ''),
                source: url, host: 'PDF: ' + path.basename(abs),
              });
            } catch {}
          }
          if (items.length) {
            imgBlock = `\n\n--- 提取的图片（共 ${imgs.length}${imgs.length > 60 ? '，仅显示前 60' : ''} 张）---\n` + items.join('\n');
            try { broadcastImages(galleryItems, 'PDF: ' + path.basename(abs)); } catch {}
          }
        }
        resolve(head + (killed ? ' [stdout 被中断，返回过大]' : '') + '\n' + body + trailer + (j.ocr_error ? '\n(OCR: ' + j.ocr_error + ')' : '') + imgBlock);
      } catch (e) {
        resolve('解析失败：' + e.message + '\n' + (err || out).slice(-500));
      }
    });
  });
}

// ====================== 下载文件 ======================
async function downloadFile(url, saveAs) {
  if (!url) throw new Error('缺少 url');
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 DeepSimCodeMAX' }, redirect: 'follow' });
  if (!r.ok) return `[HTTP ${r.status}] ${url}`;
  let rel = saveAs;
  if (!rel) {
    const u = new URL(url);
    const base = path.basename(u.pathname) || ('file_' + Date.now());
    rel = path.join('downloads', base);
  }
  const abs = safePath(rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const buf = Buffer.from(await r.arrayBuffer());
  await fs.writeFile(abs, buf);
  const ct = r.headers.get('content-type') || '';
  return `已下载到 ${path.relative(WORKSPACE, abs)} (${buf.length} bytes, ${ct})`;
}

// ====================== pvpython 离屏渲染（可靠替代 PrintWindow） ======================
function pvpythonExe() {
  if (SETTINGS.paraviewPython) return SETTINGS.paraviewPython;
  if (SETTINGS.paraviewExe) {
    const dir = path.dirname(SETTINGS.paraviewExe);
    return path.join(dir, IS_WIN ? 'pvpython.exe' : 'pvpython');
  }
  // Windows 兜底：扫常见安装路径
  if (IS_WIN) {
    const roots = ['C:\\Program Files', 'C:\\Program Files (x86)'];
    for (const r of roots) {
      try {
        const dirs = fssync.readdirSync(r).filter(n => /^ParaView/i.test(n));
        for (const d of dirs) {
          const p = path.join(r, d, 'bin', 'pvpython.exe');
          if (fssync.existsSync(p)) return p;
        }
      } catch {}
    }
  } else {
    // Linux 兜底：常见路径 + /opt 下的官网 tarball 解压目录
    const cands = ['/usr/bin/pvpython', '/usr/local/bin/pvpython'];
    for (const r of ['/opt', '/usr/local']) {
      try {
        for (const d of fssync.readdirSync(r)) {
          if (/paraview/i.test(d)) {
            const p = path.join(r, d, 'bin', 'pvpython');
            cands.push(p);
          }
        }
      } catch {}
    }
    for (const p of cands) { if (fssync.existsSync(p)) return p; }
  }
  return IS_WIN ? 'pvpython.exe' : 'pvpython';
}
// 把宿主 PYTHONHOME / PYTHONPATH 从 env 里剔除，否则会劫持 pvpython 内嵌解释器
// 导致 `import paraview` 失败（典型现象：IMPORT_ERR No module named 'paraview'）
function pvCleanEnv() {
  const e = { ...process.env };
  delete e.PYTHONHOME;
  delete e.PYTHONPATH;
  delete e.PYTHONSTARTUP;
  delete e.PYTHONNOUSERSITE;
  return e;
}
async function pvRenderOffscreen({ casePath, width=1024, height=720, azimuth=30, elevation=15, zoom=1.0, field='', timeStep=null }) {
  if (!casePath) throw new Error('缺少 case_path');
  const abs = path.isAbsolute(casePath) ? casePath : safePath(casePath);
  await fs.access(abs);
  const exe = pvpythonExe();
  const outPng = path.join(os.tmpdir(), `dscm_pv_${crypto.randomBytes(12).toString('hex')}.png`);
  const metaPath = outPng + '.json';
  const fieldArg = (field || '').replace(/[^A-Za-z0-9_:]/g, '');
  const tsArg = (timeStep === null || timeStep === undefined || timeStep === '') ? 'None' : Number(timeStep);
  // 健壮版 pvpython 脚本：
  // 1) 自动选择 reader（OpenFOAM 目录优先用 OpenFOAMReader 而不是 case.foam，避免缓存问题）
  // 2) 启用所有 cell/point arrays（OpenFOAMReader 默认不读，需显式开启）
  // 3) 切到选定时间步后再 UpdatePipeline，再读取场清单（避免 t=0 时场为空）
  // 4) 把 stderr 错误也通过 print 输出，便于前端展示
  const py = `
import os, sys, json, traceback
def _err(tag, e):
    print('[' + tag + ']', e); print(traceback.format_exc())

try:
    from paraview.simple import *
except Exception as e:
    print('IMPORT_ERR', e); sys.exit(2)

paths_in = r"""${abs}"""
out      = r"""${outPng}"""
meta_out = r"""${metaPath}"""
field    = ${JSON.stringify(fieldArg)}
ts       = ${tsArg}

reader = None
is_dir = os.path.isdir(paths_in)
# OpenFOAM 目录：优先用原生 OpenFOAMReader 打开 case.foam（自动判别 reconstruct/decompose）
if is_dir:
    foam = os.path.join(paths_in, 'case.foam')
    try:
        if not os.path.exists(foam):
            with open(foam, 'a'): pass
    except Exception as e:
        _err('FOAM_TOUCH_ERR', e)
    try:
        reader = OpenFOAMReader(FileName=foam)
    except Exception:
        try: reader = OpenDataFile(foam)
        except Exception as e: _err('OPEN_DIR_ERR', e)
else:
    try: reader = OpenDataFile(paths_in)
    except Exception as e: _err('OPEN_FILE_ERR', e)

if reader is None:
    print('READER_NONE', paths_in); sys.exit(3)

# 启用所有可用 cell/point 数组（OpenFOAMReader 必需；其它 reader 也兼容）
def _enable_all(arr_status):
    try:
        names = list(arr_status.GetData()) if hasattr(arr_status, 'GetData') else list(arr_status)
    except Exception: names = []
    for n in names:
        try: arr_status.SetArrayStatus(n, 1)
        except Exception:
            try: arr_status[n] = 1
            except Exception: pass
    return names

cell_arrays_avail = []
point_arrays_avail = []
try:
    if hasattr(reader, 'CellArrays'):       cell_arrays_avail  = _enable_all(reader.CellArrays)
    if hasattr(reader, 'PointArrays'):      point_arrays_avail = _enable_all(reader.PointArrays)
    if hasattr(reader, 'CellArrayStatus'):  cell_arrays_avail  = cell_arrays_avail or _enable_all(reader.CellArrayStatus)
    if hasattr(reader, 'PointArrayStatus'): point_arrays_avail = point_arrays_avail or _enable_all(reader.PointArrayStatus)
except Exception as e: _err('ARR_ENABLE_ERR', e)

# OpenFOAM：默认只读 internalMesh，避免吐出 patch 多段
try:
    if hasattr(reader, 'MeshRegions'):
        regs = list(reader.MeshRegions.GetAvailable()) if hasattr(reader.MeshRegions, 'GetAvailable') else []
        if 'internalMesh' in regs: reader.MeshRegions = ['internalMesh']
except Exception: pass

try: reader.UpdatePipeline()
except Exception as e: _err('UPDATE_ERR', e)

# 时间步
times = []
try: times = list(getattr(reader, 'TimestepValues', []) or [])
except Exception: times = []

# 选时间步并刷新
sel_t = None
if ts is not None and len(times) > 0:
    idx = int(ts)
    if idx < 0: idx = len(times) - 1
    if idx >= len(times): idx = len(times) - 1
    sel_t = times[idx]
    try: reader.UpdatePipeline(sel_t)
    except Exception as e: _err('UPDATE_T_ERR', e)

# 选完时间步再扫一遍真正可用的场（避免 t=0 时为空）
point_arrays = []
cell_arrays = []
try:
    di = reader.GetDataInformation()
    pi = di.GetPointDataInformation()
    for i in range(pi.GetNumberOfArrays()):
        a = pi.GetArrayInformation(i).GetName()
        if a not in point_arrays: point_arrays.append(a)
    ci = di.GetCellDataInformation()
    for i in range(ci.GetNumberOfArrays()):
        a = ci.GetArrayInformation(i).GetName()
        if a not in cell_arrays: cell_arrays.append(a)
except Exception as e: _err('FIELDS_ERR', e)
# 后备：用 reader 上自报的列表
if not point_arrays and not cell_arrays:
    point_arrays = point_arrays_avail or []
    cell_arrays  = cell_arrays_avail or []

# 视图
view = GetActiveViewOrCreate('RenderView')
view.UseColorPaletteForBackground = 0
view.Background = [0.04, 0.03, 0.07]
view.ViewSize = [${width}, ${height}]
if sel_t is not None:
    try: view.ViewTime = sel_t
    except Exception: pass

disp = Show(reader, view)

# 上色
if field and (field in point_arrays or field in cell_arrays):
    assoc = 'POINTS' if field in point_arrays else 'CELLS'
    try:
        ColorBy(disp, (assoc, field))
        try: disp.RescaleTransferFunctionToDataRange(True, False)
        except Exception: pass
        try: disp.SetScalarBarVisibility(view, True)
        except Exception: pass
    except Exception as e: _err('COLORBY_ERR', e)
elif field:
    print('FIELD_NOT_FOUND', field, '| available cell:', cell_arrays, '| point:', point_arrays)

try: view.ResetCamera()
except Exception: pass
try:
    cam = GetActiveCamera()
    cam.Azimuth(${azimuth}); cam.Elevation(${elevation}); cam.Dolly(${zoom})
except Exception as e: _err('CAM_ERR', e)

try: Render(view)
except Exception as e: _err('RENDER_ERR', e)
try: SaveScreenshot(out, view, ImageResolution=[${width},${height}])
except Exception as e: print('SAVE_ERR', e); sys.exit(4)

with open(meta_out, 'w', encoding='utf-8') as f:
    json.dump({
        'times': times, 'point_arrays': point_arrays, 'cell_arrays': cell_arrays,
        'fields': cell_arrays + [p for p in point_arrays if p not in cell_arrays],
        'field_used': field if (field in point_arrays or field in cell_arrays) else '',
        'time_index': (int(ts) if ts is not None else None),
        'time_value': sel_t
    }, f, ensure_ascii=False)
print('OK', out)
`;
  return await new Promise((resolve, reject) => {
    const p = spawn(exe, ['-'], { cwd: WORKSPACE, windowsHide: true, env: pvCleanEnv() });
    let outBuf = '', errBuf = '';
    p.stdout.on('data', d => outBuf += d.toString());
    p.stderr.on('data', d => errBuf += d.toString());
    p.on('error', err => reject(new Error(`pvpython 启动失败：${err.message}（路径：${exe}）`)));
    const to = setTimeout(() => { try { p.kill(); } catch {} reject(new Error('pvpython 超时 (90s)')); }, 90000);
    p.on('close', async (code) => {
      clearTimeout(to);
      // 保留最后 8 行用于错误展示（含我们脚本里的 [TAG] 前缀）
      const tailOut = outBuf.split(/\r?\n/).filter(Boolean).slice(-8).join(' | ');
      const tailErr = errBuf.split(/\r?\n/).filter(Boolean).slice(-6).join(' | ');
      pvBroadcast({ type: 'term', line: `[pvpython exit ${code}] ${tailOut}${tailErr ? ' || stderr: ' + tailErr : ''}` });
      if (code !== 0) { return reject(new Error(`pvpython exit ${code}\n${tailErr || tailOut || '(无输出)'}`)); }
      try {
        const buf = await fs.readFile(outPng);
        fs.unlink(outPng).catch(()=>{});
        let meta = null;
        try { meta = JSON.parse(await fs.readFile(metaPath, 'utf8')); fs.unlink(metaPath).catch(()=>{}); } catch {}
        resolve({ dataUrl: 'data:image/png;base64,' + buf.toString('base64'), width, height, bytes: buf.length, meta });
      } catch (e) { reject(new Error('读取输出 PNG 失败：' + e.message)); }
    });
    p.stdin.write(py); p.stdin.end();
  });
}
app.post('/api/sim/render', async (req, res) => {
  try {
    const b = req.body || {};
    const opts = { casePath: b.case_path || b.casePath, azimuth: b.azimuth, elevation: b.elevation, zoom: b.zoom, width: b.width, height: b.height, field: b.field, timeStep: b.time_step };
    const r = await pvRenderOffscreen(opts);
    pvBroadcast({ type: 'sim_frame', dataUrl: r.dataUrl, meta: r.meta });
    res.json({ ok: true, width: r.width, height: r.height, meta: r.meta });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// STL 高级渲染：复用 foam_stl_render 多视角 pvpython 渲染，结果通过 sim_frame 推到 ParaView 面板
app.post('/api/stl/render', async (req, res) => {
  try {
    const b = req.body || {};
    const stl_path = b.stl_path || b.path;
    const n_views = b.n_views || 3;
    if (!stl_path) return res.status(400).json({ error: 'stl_path 必填' });
    if (!SETTINGS.paraviewPython) {
      return res.status(400).json({ error: '未配置 pvpython 路径（⚙ 设置 → ParaView Python）' });
    }
    // 异步触发，不阻塞响应——帧会通过 ws sim_frame 推到 ParaView 面板
    foamStlRender({ stl_path, n_views }, null).catch(e => {
      pvBroadcast({ type: 'sim_status', text: 'STL 渲染失败：' + e.message });
    });
    res.json({ ok: true, message: '已触发 pvpython 多视角渲染，帧将推送到 ParaView 面板' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ 轻量流场后处理（/post 页面；numpy+matplotlib，不依赖 ParaView/X，只读算例）============
const POST_PY = path.join(__dirname, 'post_field.py');
function _postCase(p) {
  if (!p) throw new Error('case 必填');
  const abs = path.isAbsolute(p) ? path.resolve(p) : safePath(p);
  const rel = path.relative(WORKSPACE, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('算例必须在工作区内');
  return abs;
}
function _runPost(args, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const py = SETTINGS.pythonPath || (IS_WIN ? 'python' : 'python3');
    const p = spawn(py, [POST_PY, ...args], { cwd: WORKSPACE, windowsHide: true, env: { ...process.env, MPLBACKEND: 'Agg' } });
    let out = '', err = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    const t = setTimeout(() => { try { p.kill(); } catch {} reject(new Error('后处理超时')); }, timeoutMs);
    p.on('error', e => { clearTimeout(t); reject(new Error('Python 启动失败：' + e.message)); });
    p.on('close', () => {
      clearTimeout(t);
      const last = out.trim().split(/\r?\n/).pop() || '';
      let j; try { j = JSON.parse(last); } catch { return reject(new Error((err || out).trim().split(/\r?\n/).slice(-3).join(' ') || '后处理无输出')); }
      if (j.error) return reject(new Error(j.error));
      resolve(j);
    });
  });
}
let _postQueue = Promise.resolve();
const _postSerial = fn => (_postQueue = _postQueue.then(fn, fn));
app.get('/api/post/cases', async (req, res) => {
  const found = [];
  async function walk(dir, depth) {
    if (depth > 3 || found.length >= 200) return;
    let ents = []; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    if (ents.some(e => e.isDirectory() && e.name === 'system') && ents.some(e => e.isDirectory() && (e.name === 'constant' || e.name.startsWith('processor')))) {
      let mtime = 0; try { mtime = (await fs.stat(dir)).mtimeMs; } catch {}
      const hasData = ents.some(e => e.isDirectory() && /^\d/.test(e.name) && !/^0(\.orig)?$/.test(e.name)) || ents.some(e => e.isDirectory() && /^processor\d+$/.test(e.name));
      const hasMesh = fssync.existsSync(path.join(dir, 'constant', 'polyMesh', 'owner')) || fssync.existsSync(path.join(dir, 'constant', 'polyMesh', 'owner.gz'))
        || fssync.existsSync(path.join(dir, 'processor0', 'constant', 'polyMesh', 'owner')) || fssync.existsSync(path.join(dir, 'processor0', 'constant', 'polyMesh', 'owner.gz'));
      let hasStl = false; try { hasStl = (await fs.readdir(path.join(dir, 'constant', 'triSurface'))).some(f => /\.stl$/i.test(f)); } catch {}
      found.push({ path: path.relative(WORKSPACE, dir) || '.', mtime, hasData, hasMesh, hasStl });
      return;
    }
    // 失败试验的存档、备份目录不当成可看的算例（之前下拉框默认选中了 trials_failed 里的坏算例）
    for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.') && !IGNORE.has(e.name) && !/^processor\d+$/.test(e.name) && !/^\d/.test(e.name)
      && !/^(trials_failed|backup.*|.*\.bak.*|node_modules)$/.test(e.name)) await walk(path.join(dir, e.name), depth + 1);
  }
  await walk(WORKSPACE, 0);
  found.sort((a, b) => b.mtime - a.mtime);
  res.json({ workspace: WORKSPACE, cases: found });
});
app.get('/api/post/info', async (req, res) => {
  try {
    const c = _postCase(req.query.case);
    const args = ['info', c]; if (req.query.time) args.push(String(req.query.time));
    res.json(await _postSerial(() => _runPost(args, 600_000)));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/post/slice', async (req, res) => {
  try {
    const b = req.body || {};
    const c = _postCase(b.case);
    const num = v => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v))) ? undefined : Number(v);
    const a = { time: String(b.time || ''), field: String(b.field || '').replace(/[^\w.:-]/g, ''), axis: ['x', 'y', 'z'].includes(b.axis) ? b.axis : 'y',
      pos: num(b.pos), component: ['mag', 'x', 'y', 'z'].includes(b.component) ? b.component : 'mag', vmin: num(b.vmin), vmax: num(b.vmax),
      cmap: ['viridis', 'cividis', 'inferno', 'magma', 'plasma', 'RdBu_r', 'coolwarm', 'turbo', 'jet', 'gray'].includes(b.cmap) ? b.cmap : 'viridis',
      shading: b.shading === 'smooth' ? 'smooth' : 'flat', mesh: !!b.mesh, wide: !!b.wide, title: b.title !== false,
      contours: Math.min(Math.max(Math.round(num(b.contours) || 0), 0), 20),
      dpi: Math.min(Math.max(Math.round(num(b.dpi) || 200), 72), 400) };
    if (b.crop && typeof b.crop === 'object') a.crop = Object.fromEntries(['x0', 'x1', 'y0', 'y1'].filter(k => num(b.crop[k]) !== undefined).map(k => [k, num(b.crop[k])]));
    if (!a.time || !a.field) throw new Error('time 和 field 必填');
    a.out = path.join(os.tmpdir(), `cfdpost_${crypto.randomBytes(8).toString('hex')}.png`);
    const r = await _postSerial(() => _runPost(['slice', c, JSON.stringify(a)]));
    const buf = await fs.readFile(a.out); fs.unlink(a.out).catch(() => {});
    delete r.png;
    res.json({ ...r, image: 'data:image/png;base64,' + buf.toString('base64') });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get(['/post', '/post.html'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'post.html')));
// ============ 三维后处理 / 前处理查看（post_vtk.py 常驻进程，VTK；读过的算例与时刻有缓存）============
const POST_VTK = path.join(__dirname, 'post_vtk.py');
let _pv3 = null;
function _pv3Worker() {
  if (_pv3 && !_pv3.dead) return _pv3;
  const py = SETTINGS.pythonPath || (IS_WIN ? 'python' : 'python3');
  const p = spawn(py, [POST_VTK], { cwd: WORKSPACE, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const w = { p, pending: new Map(), buf: '', seq: 0, dead: false, err: '' };
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', d => {
    w.buf += d; let i;
    while ((i = w.buf.indexOf('\n')) >= 0) {
      const line = w.buf.slice(0, i); w.buf = w.buf.slice(i + 1);
      let j; try { j = JSON.parse(line); } catch { continue; }
      const cb = w.pending.get(j.id); if (cb) { w.pending.delete(j.id); cb(j); }
    }
  });
  p.stderr.on('data', d => { w.err = (w.err + d).slice(-2000); });
  const fail = msg => { w.dead = true; for (const cb of w.pending.values()) cb({ ok: false, error: msg }); w.pending.clear(); };
  p.on('error', e => fail('后处理进程启动失败：' + e.message));
  p.on('close', code => fail(`后处理进程退出（${code}）${w.err ? '：' + w.err.trim().split('\n').pop() : ''}`));
  _pv3 = w; return w;
}
function pv3(cmd, args, timeoutMs = 600_000) {
  return new Promise((resolve, reject) => {
    const w = _pv3Worker(); const id = ++w.seq;
    const t = setTimeout(() => { w.pending.delete(id); try { w.p.kill(); } catch {} reject(new Error('后处理超时（大网格首次读取可能较慢，已重启后处理进程）')); }, timeoutMs);
    w.pending.set(id, j => { clearTimeout(t); j.ok ? resolve(j.result) : reject(new Error(j.error || '后处理失败')); });
    w.p.stdin.write(JSON.stringify({ id, cmd, args }) + '\n');
  });
}
const _num3 = v => Array.isArray(v) && v.length === 3 && v.every(x => Number.isFinite(Number(x))) ? v.map(Number) : undefined;
// 智能体出图：把"z=0.5 m 截面的乙烯云图"这类要求变成可视化页的图层，算一遍拿统计，并推给界面打开
async function postViewTool(a, ws, session) {
  const c = _postCase(String(a.case || ''));
  const rel = path.relative(WORKSPACE, c).replace(/\\/g, '/') || '.';
  const info = await pv3('info', { case: c });
  const b = info.bounds, AX = { x: 0, y: 1, z: 2 }, up = info.up || 'y';
  const center = [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2];
  const time = a.time && a.time !== 'latest' ? Number(a.time) : info.latest;
  const names = info.fields.map(f => f.name);
  const fieldLine = info.fields.filter(f => !/^(alphat|nut|Ydefault)/.test(f.name)).map(f => `${f.name}${f.ncomp === 3 ? '（矢量）' : ''} ${(+f.range[0]).toPrecision(3)}–${(+f.range[1]).toPrecision(3)}`).join('；');
  const head = `[post_view] ${rel} · ${info.cells.toLocaleString()} 单元 · ${info.times.length} 个时刻（最新 ${info.latest}）· 竖直轴 ${up}${info.axisym ? ' · 2D 轴对称（wedge）' : ''}\n范围 x ${b[0].toPrecision(3)}–${b[1].toPrecision(3)}，y ${b[2].toPrecision(3)}–${b[3].toPrecision(3)}，z ${b[4].toPrecision(3)}–${b[5].toPrecision(3)} m`;
  if (!Array.isArray(a.layers) || !a.layers.length) return `${head}\n场：${fieldLine}\n边界：${info.patches.map(p => `${p.name}(${p.type})`).join('、')}\n→ 再调用 post_view 并给 layers。`;
  const near = f => names.filter(n => n.toLowerCase().includes(String(f).toLowerCase().split('.')[0])).slice(0, 5).join('、') || names.slice(0, 8).join('、');
  const srv = [], cli = [], problems = [];
  const horiz = info.axisym ? 'z' : (up === 'z' ? 'y' : 'z');
  for (const [i, L] of a.layers.slice(0, 8).entries()) {
    const type = String(L.type || 'slice');
    const field = L.field ? String(L.field) : '';
    if (field && !names.includes(field)) { problems.push(`第 ${i + 1} 层：没有场 ${field}，相近的有 ${near(field)}`); continue; }
    const s = { id: 'a' + i, type, field: field || null, comp: L.comp || 'mag' };
    const k = { type, field, comp: s.comp, cmap: L.cmap || 'turbo', opacity: L.opacity ?? 1, log: !!L.log, contours: +L.contours || 0 };
    if (Number.isFinite(+L.lo) && Number.isFinite(+L.hi) && type !== 'threshold') Object.assign(k, { auto: false, lo: +L.lo, hi: +L.hi });
    if (['slice', 'clip', 'glyph'].includes(type)) {
      const axis = ['x', 'y', 'z'].includes(L.axis) ? L.axis : (type === 'slice' && L.position !== undefined && !L.axis ? up : horiz);
      const ai = AX[axis], o = [...center];
      o[ai] = Number.isFinite(+L.position) ? +L.position : (info.axisym && axis === 'z' ? 0 : center[ai]);
      if (o[ai] < b[ai * 2] || o[ai] > b[ai * 2 + 1]) { problems.push(`第 ${i + 1} 层：${axis}=${o[ai]} 在计算域外（${b[ai * 2].toPrecision(3)}–${b[ai * 2 + 1].toPrecision(3)}）`); continue; }
      const n = [0, 0, 0]; n[ai] = 1;
      Object.assign(s, { origin: o, normal: n, mirror: !!info.axisym && type !== 'clip' && axis === 'z', contours: k.contours });
      Object.assign(k, { axis, pos: o[ai], mirror: s.mirror });
      if (type === 'clip') { s.invert = !!L.invert; k.flip = !!L.invert; }
    }
    if (type === 'iso') {
      const isoField = L.isoField || field; const vals = [].concat(L.values ?? L.value ?? []).map(Number).filter(Number.isFinite);
      if (!isoField || !vals.length) { problems.push(`第 ${i + 1} 层：等值面要给 field 和 values`); continue; }
      Object.assign(s, { isoField, values: vals }); Object.assign(k, { isoField, value: vals.join(', ') });
    }
    if (type === 'threshold') {
      const thrField = L.thrField || field;
      if (!thrField || !Number.isFinite(+L.lo) || !Number.isFinite(+L.hi)) { problems.push(`第 ${i + 1} 层：阈值要给 field、lo、hi`); continue; }
      Object.assign(s, { thrField, lo: +L.lo, hi: +L.hi }); Object.assign(k, { thrField, tlo: +L.lo, thi: +L.hi });
    }
    if (type === 'stream' || type === 'glyph') {
      const vector = L.vector || (names.includes('U.gas') ? 'U.gas' : names.find(n => /^U/.test(n)));
      s.vector = vector; k.vector = vector; s.n = k.n = +L.n || (type === 'stream' ? 40 : 1500);
      if (type === 'stream') {
        const ui = AX[up], h = b[ui * 2] + 0.05 * (b[ui * 2 + 1] - b[ui * 2]), ax = ui === 0 ? 1 : 0;
        const p1 = _num3(L.p1) || (() => { const p = [...center]; p[ui] = h; p[ax] = b[ax * 2] + 0.02 * (b[ax * 2 + 1] - b[ax * 2]); if (info.axisym) p[2] = 0; return p; })();
        const p2 = _num3(L.p2) || (() => { const p = [...center]; p[ui] = h; p[ax] = b[ax * 2 + 1] - 0.02 * (b[ax * 2 + 1] - b[ax * 2]); if (info.axisym) p[2] = 0; return p; })();
        Object.assign(s, { p1, p2, tubes: true, field: field || vector }); Object.assign(k, { p1, p2, field: field || vector });
      }
    }
    if (type === 'volume') { if (!field) { problems.push(`第 ${i + 1} 层：体渲染要给 field`); continue; } }
    if (type !== 'volume') srv.push(s);
    cli.push(k);
  }
  let res = { layers: [] };
  if (srv.length) res = await pv3('scene', { case: c, time, layers: srv });
  const lines = res.layers.map((r, j) => {
    const s = srv[j], what = `${s.type}${s.normal ? ` 法向 ${'xyz'[s.normal.indexOf(1)]}@${(+s.origin[s.normal.indexOf(1)]).toPrecision(4)} m` : ''}${s.field ? ' · ' + s.field : ''}`;
    if (r.kind === 'error') return `- ${what}：出错 ${r.error}`;
    if (r.kind === 'empty') return `- ${what}：没有几何（平面或等值没切到网格）`;
    const st = r.stats || {};
    return `- ${what}：${r.range ? `范围 ${(+r.range[0]).toPrecision(4)} – ${(+r.range[1]).toPrecision(4)}` : ''}${st.mean !== undefined ? `，${st.measure === 'Area' ? '面积' : '体积'}加权平均 ${(+st.mean).toPrecision(4)}` : ''}${st.cells !== undefined ? `，${st.cells} 个单元、体积 ${(+st.size).toPrecision(3)} m³` : ''}${st.lines !== undefined ? `，${st.lines} 条流线` : ''}`;
  });
  // 截面另出一张静态 PNG（matplotlib，出版口径），智能体可以 vision_analyze 自查
  let png = '';
  const sl = srv.find(s => s.type === 'slice' && s.field);
  if (sl) {
    try {
      const ai = sl.normal.indexOf(1);
      const out = path.join(WORKSPACE, '.nullflux', 'post', `${Date.now()}_${sl.field.replace(/\W+/g, '_')}.png`);
      await fs.mkdir(path.dirname(out), { recursive: true });
      const ti = await _postSerial(() => _runPost(['info', c], 600_000)).catch(() => null);
      const tdirs = (ti && (ti.times || [])).map(String);
      const tdir = tdirs.length ? tdirs.reduce((best, x) => Math.abs(+x - (res.time ?? time)) < Math.abs(+best - (res.time ?? time)) ? x : best) : String(res.time ?? time);
      const opt = { time: tdir, field: sl.field, axis: 'xyz'[ai], pos: sl.origin[ai], component: sl.comp || 'mag', cmap: 'turbo', shading: 'flat', dpi: 160, out };
      await _postSerial(() => _runPost(['slice', c, JSON.stringify(opt)]));
      png = path.relative(WORKSPACE, out).replace(/\\/g, '/');
    } catch (e) { png = ''; }
  }
  if (a.show !== false && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'post_view', case: rel, mode: a.mode === 'mesh' ? 'mesh' : 'post', time: res.time ?? time, layers: cli }));
  return `${head}\n时刻 ${res.time ?? time}\n${lines.join('\n')}${problems.length ? '\n⚠ ' + problems.join('\n⚠ ') : ''}${png ? `\n静态图：${png}（可 vision_analyze）` : ''}${a.show !== false ? '\n已在右侧「可视化」打开，用户可以继续拖动、改色标。' : ''}`;
}
// 计算器派生场：名字限字母数字点，表达式在 Python 端按 AST 白名单求值
const _derived = d => (Array.isArray(d) ? d : []).slice(0, 12).filter(x => x && typeof x.name === 'string' && typeof x.expr === 'string')
  .map(x => ({ name: x.name.replace(/[^\w.-]/g, '_').slice(0, 40), expr: x.expr.slice(0, 300) }));
app.post('/api/post3d/stats', async (req, res) => {
  try { const b = req.body || {}; res.json(await pv3('stats', { case: _postCase(b.case), time: b.time, field: String(b.field || ''), comp: b.comp || 'mag', bins: Math.min(Math.max(+b.bins || 40, 5), 200), derived: _derived(b.derived) })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/post3d/timeseries', async (req, res) => {
  try {
    const b = req.body || {}; const point = _num3(b.point); if (!point) throw new Error('point 需要三个数');
    res.json(await pv3('timeseries', { case: _postCase(b.case), point, fields: (b.fields || []).slice(0, 6), comp: b.comp || 'mag', maxTimes: Math.min(+b.maxTimes || 120, 400), derived: _derived(b.derived) }, 1_800_000));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/post3d/calccheck', async (req, res) => {
  try { const b = req.body || {}; res.json(await pv3('calccheck', { case: _postCase(b.case), time: b.time, expr: String(b.expr || '').slice(0, 300) })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/post3d/info', async (req, res) => {
  try { res.json(await pv3('info', { case: _postCase(req.query.case) })); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/post3d/scene', async (req, res) => {
  try {
    const b = req.body || {}; const c = _postCase(b.case);
    const TYPES = new Set(['surface', 'patches', 'stl', 'slice', 'clip', 'iso', 'threshold', 'stream', 'glyph', 'outline']);
    const layers = (Array.isArray(b.layers) ? b.layers : []).slice(0, 16).filter(L => L && TYPES.has(L.type)).map(L => {
      const o = { ...L };
      for (const k of ['origin', 'normal', 'p1', 'p2', 'p3']) if (k in o) { o[k] = _num3(o[k]); if (!o[k]) throw new Error(`${L.type}.${k} 需要三个数`); }
      return o;
    });
    res.json(await pv3('scene', { case: c, time: b.time, layers, derived: _derived(b.derived) }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/post3d/volume', async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await pv3('volume', { case: _postCase(b.case), time: b.time, field: String(b.field || ''), comp: b.comp || 'mag', n: Math.min(Math.max(+b.n || 1e6, 1e4), 8e6), derived: _derived(b.derived) }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/post3d/line', async (req, res) => {
  try {
    const b = req.body || {}; const p1 = _num3(b.p1), p2 = _num3(b.p2);
    if (!p1 || !p2) throw new Error('p1、p2 需要三个数');
    res.json(await pv3('line', { case: _postCase(b.case), time: b.time, p1, p2, n: Math.min(Math.max(+b.n || 200, 10), 2000), fields: (b.fields || []).slice(0, 8), comp: b.comp || 'mag', derived: _derived(b.derived) }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// 网格质量：优先读已有的 log.checkMesh；run=1 时现跑 checkMesh（只读，不写 sets）
function _parseCheckMesh(s) {
  const g = (re, f = Number) => { const m = re.exec(s); return m ? f(m[1]) : null; };
  return { cells: g(/cells:\s+(\d+)/), points: g(/points:\s+(\d+)/), faces: g(/faces:\s+(\d+)/),
    hex: g(/hexahedra:\s+(\d+)/), poly: g(/polyhedra:\s+(\d+)/), prisms: g(/prisms:\s+(\d+)/), tets: g(/tetrahedra:\s+(\d+)/),
    nonOrthoMax: g(/Mesh non-orthogonality Max:\s+([\d.eE+-]+)/), nonOrthoAvg: g(/average:\s+([\d.eE+-]+)/),
    skewMax: g(/Max skewness = ([\d.eE+-]+)/), aspectMax: g(/Max aspect ratio = ([\d.eE+-]+)/),
    minVol: g(/Min volume = ([\d.eE+-]+)/), ok: /Mesh OK\./.test(s) ? true : (/Failed \d+ mesh checks/.test(s) ? false : null),
    failed: (s.match(/\*\*\*[^\n]+/g) || []).slice(0, 8) };
}
app.get('/api/post3d/meshcheck', async (req, res) => {
  try {
    const c = _postCase(req.query.case);
    if (req.query.run === '1') {
      const dec = !fssync.existsSync(path.join(c, 'constant', 'polyMesh', 'owner')) && fssync.existsSync(path.join(c, 'processor0'));
      const r = await _foamExecCapture(`cd "${c}" && checkMesh -constant ${dec ? '-case processor0 ' : ''}-noFunctionObjects 2>&1 | tail -80`, 600_000);
      return res.json({ source: dec ? 'checkMesh（processor0 子域）' : 'checkMesh（刚运行）', ...(_parseCheckMesh(r.out)), tail: r.out.slice(-4000) });
    }
    for (const f of ['log.checkMesh', 'logs/mesh.stdout.log']) {
      try { const s = await fs.readFile(path.join(c, f), 'utf8'); return res.json({ source: f, ..._parseCheckMesh(s), tail: s.slice(-4000) }); } catch {}
    }
    res.json({ source: null });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// 几何页并入可视化的「网格与几何」模式（STL、patch、网格线、checkMesh）
app.get(['/geometry', '/geometry.html'], (req, res) => res.redirect('/post?mode=mesh' + (req.query.case ? '&case=' + encodeURIComponent(String(req.query.case)) : '')));

// 浏览工作区，给 ParaView 面板做文件选择用
app.get('/api/sim/browse', async (req, res) => {
  try {
    const rel = req.query.path || '.';
    const abs = safePath(rel);
    const st = await fs.stat(abs);
    if (!st.isDirectory()) return res.json({ error: '不是目录' });
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const SIM_EXT = /\.(foam|vtu|vtk|vtp|vtm|vti|stl|cgns|exo|case|pvd|ex2|pvtu|pvtp)$/i;
    const items = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const isOf = e.isDirectory() && (e.name === 'system' || e.name === 'constant' || /^\d/.test(e.name));
      if (e.isDirectory() || SIM_EXT.test(e.name) || isOf) {
        items.push({ name: e.name, dir: e.isDirectory() });
      }
    }
    items.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    const parent = path.relative(WORKSPACE, path.dirname(abs));
    res.json({ ok: true, path: path.relative(WORKSPACE, abs) || '.', parent: parent === path.relative(WORKSPACE, abs) ? null : parent, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====================== 图片搜索 / 下载 HTTP ======================
app.post('/api/image_search', async (req, res) => {
  try {
    const { query, top_k } = req.body || {};
    if (!query) return res.json({ error: 'missing query' });
    const imgs = await imageSearch(query, Math.min(30, top_k || 12));
    broadcastImages(imgs, query);
    res.json({ ok: true, count: imgs.length, images: imgs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/download_image', async (req, res) => {
  try {
    const { url, save_as } = req.body || {};
    if (!url) return res.json({ error: 'missing url' });
    const out = await downloadFile(url, save_as);
    res.json({ ok: true, message: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====================== OpenFOAM Beta HTTP ======================
// ============ 技能库（自进化）可视化 ============
app.get('/api/skills', async (req, res) => {
  try {
    const skills = SkillLib.listSkills(req.query.domain ? { domain: req.query.domain } : {});
    let evals = [];
    try { evals = await SkillLib.loadEvals(); } catch {}
    res.json({ ok: true, stats: SkillLib.stats(), skills, evals });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/skills/:id', (req, res) => {
  const sk = SkillLib.getSkill(req.params.id);
  if (!sk) return res.status(404).json({ error: '技能不存在: ' + req.params.id });
  res.json({ ok: true, skill: sk });
});
app.delete('/api/skills/:id', async (req, res) => {
  try { res.json(await SkillLib.removeSkill(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/foam/config', async (req, res) => {
  const root = SETTINGS.foamRoot || '';
  const exists = root ? await pathExists(root) : false;
  const hasTutorials = root ? await pathExists(path.join(root, 'tutorials')) : false;
  const hasSrc = root ? await pathExists(path.join(root, 'src')) : false;
  res.json({ root, exists, hasTutorials, hasSrc, foamMode: !!SETTINGS.foamMode });
});
app.post('/api/foam/config', async (req, res) => {
  try {
    if (typeof req.body?.root === 'string') SETTINGS.foamRoot = req.body.root.trim();
    if (typeof req.body?.foamMode === 'boolean') SETTINGS.foamMode = req.body.foamMode;
    await saveSettings();
    res.json({ ok: true, root: SETTINGS.foamRoot, foamMode: SETTINGS.foamMode });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/foam/check', async (req, res) => {
  try {
    const text = await foamEnvCheck();
    let json = null;
    const m = text.match(/\(JSON\)\s+(\{[\s\S]*\})\s*$/);
    try { json = m ? JSON.parse(m[1]) : null; } catch {}
    res.json({ ok: true, text, report: json });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/foam/tutorials', async (req, res) => {
  try { res.type('text/plain').send(await foamFindTutorial(req.query.q || '', Math.min(50, parseInt(req.query.top_k) || 30))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/foam/source', async (req, res) => {
  try { res.type('text/plain').send(await foamFindSource(req.query.q || '', req.query.kind || 'all', Math.min(50, parseInt(req.query.top_k) || 20))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/foam/clone', async (req, res) => {
  try { res.json({ ok: true, message: await foamCloneTutorial(req.body?.tutorial_path, req.body?.dest) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/foam/inspect', async (req, res) => {
  try { res.type('text/plain').send(await foamInspectCase(req.body?.case_path)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ \u6c42\u89e3\u5668\u540e\u53f0\u4f5c\u4e1a HTTP ============
app.get('/api/foam/runs', (req, res) => {
  res.json({ runs: [...SOLVER_RUNS.entries()].map(([id, r]) => ({
    runId: id, casePath: r.casePath, command: r.command,
    ownerTaskId: r.ownerTaskId || null,
    started: r.started, ended: r.ended, exitCode: r.exitCode,
    running: !r.ended
  })) });
});
// ============ 自动设计（Optuna study 只读视图）============
app.get('/api/opt/studies', async (req, res) => {
  try { res.json(await _runOptDriver(['list', '--base_dir', OPT_BASE_DIR])); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/opt/study/:id', async (req, res) => {
  if (!/^[A-Za-z0-9_-]+$/.test(req.params.id)) return res.status(400).json({ error: 'invalid study id' });
  try {
    const status = await _runOptDriver(['status', '--study_id', req.params.id, '--base_dir', OPT_BASE_DIR]);
    let spec = null;
    try { spec = JSON.parse(await fs.readFile(path.join(OPT_BASE_DIR, req.params.id, 'study.json'), 'utf8')); } catch {}
    res.json({ ...status, search_space: spec?.search_space || [], objective: spec?.objective || null, active_trial: activeOptTrial });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/foam/run', async (req, res) => {
  try {
    const { case_path, command } = req.body || {};
    const msg = await foamRunSolverAsync({ case_path, command }, null);
    const id = (msg.match(/runId:\s*(\w+)/) || [])[1] || '';
    res.json({ ok: true, runId: id, message: msg });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/foam/run/:id', (req, res) => {
  const r = SOLVER_RUNS.get(req.params.id);
  if (!r) return res.status(404).json({ error: '\u672a\u77e5 runId' });
  // \u89e3\u6790\u6700\u65b0 Time \u4e0e\u6b8b\u5dee
  let lastTime = '';
  for (let i = r.log.length - 1; i >= 0; i--) {
    const m = r.log[i].match(/^Time\s*=\s*([\d.eE+\-]+)/);
    if (m) { lastTime = m[1]; break; }
  }
  const residuals = r.log.filter(l => /Initial residual/.test(l)).slice(-30);
  // 结构化时序（给前端画曲线用）
  let seriesObj = null;
  try { seriesObj = JSON.parse(foamResidualSeries(req.params.id, 200, null)); } catch {}
  // 进度估算（异步读 controlDict，结果异步附加；这里同步立刻返回，progress 由前端轮询时再算）
  _computeRunProgress(r).then(progress => {
    res.json({
      runId: req.params.id, casePath: r.casePath, command: r.command,
      started: r.started, ended: r.ended, exitCode: r.exitCode, running: !r.ended,
      lastTime, residuals, tail: r.log.slice(-80),
      series: seriesObj ? seriesObj.series : [],
      fields: seriesObj ? seriesObj.fields : [],
      trends: seriesObj ? seriesObj.trends : {},
      progress
    });
  }).catch(e => {
    res.json({
      runId: req.params.id, casePath: r.casePath, command: r.command,
      started: r.started, ended: r.ended, exitCode: r.exitCode, running: !r.ended,
      lastTime, residuals, tail: r.log.slice(-80),
      series: seriesObj ? seriesObj.series : [],
      fields: seriesObj ? seriesObj.fields : [],
      trends: seriesObj ? seriesObj.trends : {},
      progress: { error: e.message }
    });
  });
});
app.post('/api/foam/run/:id/stop', (req, res) => {
  res.json({ ok: true, message: foamSolverStop(req.params.id) });
});

// ====================== MFIX Beta HTTP ======================
app.get('/api/mfix/config', async (req, res) => {
  const root = SETTINGS.mfixRoot || '';
  const bash = SETTINGS.mfixBash || '';
  const exists = root ? await pathExistsSync(root) : false;
  const hasTutorials = exists ? await pathExistsSync(path.join(root, 'tutorials')) : false;
  res.json({ root, bash, exists, hasTutorials, mfixMode: !!SETTINGS.mfixMode });
});
app.post('/api/mfix/config', async (req, res) => {
  try {
    if (typeof req.body?.root === 'string') SETTINGS.mfixRoot = req.body.root.trim();
    if (typeof req.body?.bash === 'string') SETTINGS.mfixBash = req.body.bash.trim();
    if (typeof req.body?.mfixMode === 'boolean') SETTINGS.mfixMode = req.body.mfixMode;
    await saveSettings();
    res.json({ ok: true, root: SETTINGS.mfixRoot, bash: SETTINGS.mfixBash, mfixMode: SETTINGS.mfixMode });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/mfix/tutorials', async (req, res) => {
  try { res.type('text/plain').send(await mfixFindTutorial(req.query.q || '', Math.min(50, parseInt(req.query.top_k) || 30))); }
  catch (e) { res.status(400).type('text/plain').send(e.message); }
});
app.post('/api/mfix/clone', async (req, res) => {
  try { res.json({ ok: true, message: await mfixCloneTutorial(req.body?.tutorial_path, req.body?.dest) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/mfix/inspect', async (req, res) => {
  try { res.type('text/plain').send(await mfixInspectCase(req.body?.case_path)); }
  catch (e) { res.status(400).type('text/plain').send(e.message); }
});
app.post('/api/mfix/run', async (req, res) => {
  try {
    const { case_path, command } = req.body || {};
    const msg = await mfixRunSolverAsync({ case_path, command }, null);
    res.json({ ok: true, message: msg });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/mfix/run/:id/stop', (req, res) => {
  res.json({ ok: true, message: mfixSolverStop(req.params.id) });
});

// ====================== LBM Beta HTTP ======================
app.get('/api/lbm/config', async (req, res) => {
  const root = SETTINGS.lbmTutorialRoot || '';
  const exists = root ? await pathExistsSync(root) : false;
  res.json({ tutorialRoot: root, runCmd: SETTINGS.lbmRunCmd || '', exists, lbmMode: !!SETTINGS.lbmMode });
});
app.post('/api/lbm/config', async (req, res) => {
  try {
    if (typeof req.body?.tutorialRoot === 'string') SETTINGS.lbmTutorialRoot = req.body.tutorialRoot.trim();
    if (typeof req.body?.runCmd === 'string') SETTINGS.lbmRunCmd = req.body.runCmd.trim();
    if (typeof req.body?.lbmMode === 'boolean') SETTINGS.lbmMode = req.body.lbmMode;
    await saveSettings();
    res.json({ ok: true, tutorialRoot: SETTINGS.lbmTutorialRoot, runCmd: SETTINGS.lbmRunCmd, lbmMode: SETTINGS.lbmMode });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/lbm/tutorials', async (req, res) => {
  try { res.type('text/plain').send(await lbmFindTutorial(req.query.q || '', Math.min(50, parseInt(req.query.top_k) || 30))); }
  catch (e) { res.status(400).type('text/plain').send(e.message); }
});
app.post('/api/lbm/clone', async (req, res) => {
  try { res.json({ ok: true, message: await lbmCloneTutorial(req.body?.tutorial_path, req.body?.dest) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/lbm/inspect', async (req, res) => {
  try { res.type('text/plain').send(await lbmInspectCase(req.body?.case_path, req.body?.algorithm)); }
  catch (e) { res.status(400).type('text/plain').send(e.message); }
});
app.post('/api/lbm/run', async (req, res) => {
  try {
    const { case_path, command } = req.body || {};
    const msg = await lbmRunAsync({ case_path, command }, null);
    res.json({ ok: true, message: msg });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/lbm/run/:id/stop', (req, res) => {
  res.json({ ok: true, message: lbmSolverStop(req.params.id) });
});

// ====================== 自定义工作流 Beta HTTP ======================
app.get('/api/custom/config', (req, res) => {
  res.json({
    customMode: !!SETTINGS.customMode,
    name:   SETTINGS.customName   || '',
    root:   SETTINGS.customRoot   || '',
    prompt: SETTINGS.customPrompt || ''
  });
});
app.post('/api/custom/config', async (req, res) => {
  try {
    if (typeof req.body?.name === 'string')   SETTINGS.customName   = req.body.name.slice(0, 200);
    if (typeof req.body?.root === 'string')   SETTINGS.customRoot   = req.body.root.slice(0, 500);
    if (typeof req.body?.prompt === 'string') SETTINGS.customPrompt = req.body.prompt.slice(0, 20000);
    if (typeof req.body?.customMode === 'boolean') SETTINGS.customMode = req.body.customMode;
    await saveSettings();
    res.json({
      ok: true,
      customMode: !!SETTINGS.customMode,
      name:   SETTINGS.customName   || '',
      root:   SETTINGS.customRoot   || '',
      prompt: SETTINGS.customPrompt || ''
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ====================== Digitizer (V3) HTTP ======================
// 序列化 request_id → { resolve, reject, timer } 为了等用户亲手标注后调用 tool 返回。
const PENDING_DIGITIZE = new Map();

app.post('/api/digitize/save', async (req, res) => {
  try {
    const body = req.body || {};
    const name = (body.name || 'plot').toString().replace(/[^\w\-]/g, '_').slice(0, 60) || 'plot';
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dir = path.join(WORKSPACE, 'digitized');
    await fs.mkdir(dir, { recursive: true });
    const csvPath = path.join(dir, `${ts}_${name}.csv`);
    const pts = Array.isArray(body.points) ? body.points : [];
    const head = `# digitized at ${new Date().toISOString()}\n# axis_x=${body.axis_x} axis_y=${body.axis_y}\n# calibration: X1=(${body?.calibration?.x1?.x},${body?.calibration?.x1?.y})→${body?.calibration?.x1?.value}  X2=(${body?.calibration?.x2?.x},${body?.calibration?.x2?.y})→${body?.calibration?.x2?.value}  Y1=(${body?.calibration?.y1?.x},${body?.calibration?.y1?.y})→${body?.calibration?.y1?.value}  Y2=(${body?.calibration?.y2?.x},${body?.calibration?.y2?.y})→${body?.calibration?.y2?.value}\nx,y\n`;
    const lines = pts.map(p => `${Number(p.x)},${Number(p.y)}`).join('\n') + '\n';
    await fs.writeFile(csvPath, head + lines);
    // 也可选保存原始图片
    let imgRel = null;
    if (body.image_base64) {
      const imgPath = path.join(dir, `${ts}_${name}.png`);
      await fs.writeFile(imgPath, Buffer.from(body.image_base64, 'base64'));
      imgRel = path.relative(WORKSPACE, imgPath).replace(/\\/g, '/');
    }
    const rel = path.relative(WORKSPACE, csvPath).replace(/\\/g, '/');

    // 如果是 agent 发起的 request → 解锁 pending
    if (body.request_id && PENDING_DIGITIZE.has(body.request_id)) {
      const entry = PENDING_DIGITIZE.get(body.request_id);
      PENDING_DIGITIZE.delete(body.request_id);
      try { clearTimeout(entry.timer); } catch {}
      entry.resolve({ csvPath: rel, imagePath: imgRel, points: pts, axis_x: body.axis_x, axis_y: body.axis_y, name });
    }
    // 广播给所有 ws：让聊天出一条系统提示
    if (body.send_to_chat) {
      for (const c of allClients) {
        try { c.send(JSON.stringify({ type: 'term', line: `[标注完成] ${pts.length} 个数据点 → ${rel}` })); } catch {}
      }
    }
    res.json({ ok: true, path: rel, image_path: imgRel, count: pts.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/digitize/cancel', (req, res) => {
  const id = req.body?.request_id;
  if (id && PENDING_DIGITIZE.has(id)) {
    const entry = PENDING_DIGITIZE.get(id);
    PENDING_DIGITIZE.delete(id);
    try { clearTimeout(entry.timer); } catch {}
    entry.resolve({ canceled: true });
  }
  res.json({ ok: true });
});

// Agent 端工具：让用户手动标注一张图表
async function requestUserDigitize(args, ws, session) {
  const reqId = 'dig-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const timeoutSec = Math.max(30, Math.min(3600, args.timeout_sec || 600));
  let imageBase64 = null;
  let imageNote = '';
  if (args.image_path) {
    try {
      const abs = path.isAbsolute(args.image_path) ? args.image_path : path.resolve(WORKSPACE, args.image_path);
      const buf = await fs.readFile(abs);
      imageBase64 = buf.toString('base64');
      imageNote = ` (已预加载 ${path.relative(WORKSPACE, abs)})`;
    } catch (e) {
      imageNote = ` (预加载失败: ${e.message}，用户需自行选图)`;
    }
  }
  // 推送给当前 ws + 所有 ws（让用户能从任意标签页响应）
  const payload = { type: 'digitize_open', request_id: reqId, image_base64: imageBase64, hint: args.hint || '', name: args.name || 'plot' };
  try { ws.send(JSON.stringify(payload)); } catch {}
  // 同步等用户
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (PENDING_DIGITIZE.has(reqId)) {
        PENDING_DIGITIZE.delete(reqId);
        resolve(`[超时] 用户在 ${timeoutSec}s 内未完成标注${imageNote}`);
      }
    }, timeoutSec * 1000);
    PENDING_DIGITIZE.set(reqId, {
      timer,
      resolve: (r) => {
        if (r.canceled) return resolve(`[用户取消] 标注被取消${imageNote}`);
        const lines = [
          `[标注完成]${imageNote}`,
          `CSV: ${r.csvPath}`,
          r.imagePath ? `IMG: ${r.imagePath}` : null,
          `axis_x=${r.axis_x}, axis_y=${r.axis_y}, n=${r.points.length}`,
          ``,
          `数据点（x, y）：`,
          ...r.points.slice(0, 80).map((p, i) => `  ${i+1}. ${Number(p.x).toPrecision(6)}, ${Number(p.y).toPrecision(6)}`)
        ].filter(Boolean);
        if (r.points.length > 80) lines.push(`  ... 还有 ${r.points.length - 80} 个点见 CSV`);
        resolve(lines.join('\n'));
      },
      reject: () => resolve(`[标注失败]`)
    });
  });
}

// ====================== Python 环境发现 ======================
function probePython(exe) {
  return new Promise((resolve) => {
    const p = spawn(exe, ['-c', 'import sys,platform,os; print(sys.version.split()[0]); print(sys.executable); print(os.environ.get("CONDA_DEFAULT_ENV",""))'], { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    const to = setTimeout(() => { try { p.kill(); } catch {} resolve(null); }, 4000);
    p.on('close', (code) => { clearTimeout(to); if (code !== 0) return resolve(null);
      const [ver, real, conda] = out.trim().split(/\r?\n/);
      resolve({ path: real || exe, version: ver || '', conda: conda || '' });
    });
    p.on('error', () => { clearTimeout(to); resolve(null); });
  });
}

async function discoverPythons() {
  const candidates = new Set();
  // 1. PATH 上的
  if (IS_WIN) ['python.exe', 'python3.exe', 'py.exe'].forEach(n => candidates.add(n));
  else ['python3', 'python'].forEach(n => candidates.add(n));
  // 2. 常见 conda 位置
  const home = os.homedir();
  const condaRoots = IS_WIN
    ? [path.join(home, 'anaconda3'), path.join(home, 'miniconda3'), path.join(home, 'miniforge3'), 'C:\\ProgramData\\Anaconda3', 'C:\\ProgramData\\miniconda3']
    : [path.join(home, 'anaconda3'), path.join(home, 'miniconda3'), path.join(home, 'miniforge3'), '/opt/anaconda3', '/opt/miniconda3'];
  for (const root of condaRoots) {
    try { await fs.access(root);
      candidates.add(IS_WIN ? path.join(root, 'python.exe') : path.join(root, 'bin', 'python'));
      const envsDir = path.join(root, 'envs');
      try { const entries = await fs.readdir(envsDir, { withFileTypes: true });
        for (const e of entries) if (e.isDirectory())
          candidates.add(IS_WIN ? path.join(envsDir, e.name, 'python.exe') : path.join(envsDir, e.name, 'bin', 'python'));
      } catch {}
    } catch {}
  }
  // 3. 当前工作区的 venv
  for (const sub of ['.venv', 'venv', 'env', '.env']) {
    const py = IS_WIN ? path.join(WORKSPACE, sub, 'Scripts', 'python.exe') : path.join(WORKSPACE, sub, 'bin', 'python');
    try { await fs.access(py); candidates.add(py); } catch {}
  }
  // 4. Windows: py.exe -0p 列出所有安装
  if (IS_WIN) {
    try {
      const out = await new Promise((res) => {
        const p = spawn('py.exe', ['-0p'], { windowsHide: true });
        let o = ''; p.stdout.on('data', d => o += d);
        p.on('close', () => res(o)); p.on('error', () => res(''));
        setTimeout(() => { try { p.kill(); } catch {} res(o); }, 3000);
      });
      out.split(/\r?\n/).forEach(l => { const m = l.match(/([A-Z]:\\[^\r\n]+python\.exe)/i); if (m) candidates.add(m[1]); });
    } catch {}
  }
  // 探测并去重
  const results = []; const seen = new Set();
  for (const c of candidates) {
    const info = await probePython(c);
    if (!info) continue;
    if (seen.has(info.path)) continue;
    seen.add(info.path);
    results.push({ path: info.path, version: info.version, conda: info.conda, requested: c });
  }
  results.sort((a, b) => b.version.localeCompare(a.version));
  return results;
}

let PY_CACHE = null;
app.get('/api/python/list', async (req, res) => {
  if (req.query.refresh === '1') PY_CACHE = null;
  if (!PY_CACHE) PY_CACHE = await discoverPythons();
  res.json({ envs: PY_CACHE, current: SETTINGS.pythonPath || '' });
});
app.post('/api/python/select', async (req, res) => {
  const { path: p } = req.body || {};
  if (p) {
    const info = await probePython(p);
    if (!info) return res.status(400).json({ error: '路径不是有效的 Python 解释器' });
    SETTINGS.pythonPath = info.path;
  } else SETTINGS.pythonPath = '';
  await saveSettings();
  res.json({ ok: true, current: SETTINGS.pythonPath });
});

// ====================== pvpython 自检（诊断 IMPORT_ERR） ======================
app.get('/api/pv/probe', async (req, res) => {
  const exe = pvpythonExe();
  const result = {
    chosenExe: exe,
    settings: {
      paraviewExe: SETTINGS.paraviewExe || '',
      paraviewPython: SETTINGS.paraviewPython || ''
    },
    exists: fssync.existsSync(exe),
    basenameLooksRight: /pvpython/i.test(path.basename(exe)),
    hostEnv: {
      PYTHONHOME: process.env.PYTHONHOME || '',
      PYTHONPATH: process.env.PYTHONPATH || '',
      CONDA_PREFIX: process.env.CONDA_PREFIX || ''
    },
    test: null,
    suggestion: ''
  };
  if (!result.exists) {
    result.suggestion = `所选 pvpython 不存在：${exe}。请在「设置 → ParaView Python 路径」里指向 ParaView 安装目录下的 bin/pvpython.exe（不是普通 python.exe）。`;
    return res.json(result);
  }
  if (!result.basenameLooksRight) {
    result.suggestion = `当前路径文件名 (${path.basename(exe)}) 不像 pvpython。普通 python.exe 不带 paraview 模块，请改成 ParaView 安装目录下 bin/pvpython.exe。`;
  }
  await new Promise((resolve) => {
    const p = spawn(exe, ['-c', 'import sys;print(sys.executable);import paraview;print(paraview.__file__);print(getattr(paraview,"__version__",""))'], {
      windowsHide: true, env: pvCleanEnv()
    });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    const to = setTimeout(() => { try { p.kill(); } catch {} resolve(); }, 8000);
    p.on('close', (code) => {
      clearTimeout(to);
      const lines = out.trim().split(/\r?\n/);
      result.test = {
        exitCode: code,
        sysExecutable: lines[0] || '',
        paraviewModule: lines[1] || '',
        paraviewVersion: lines[2] || '',
        stderr: err.trim().slice(-500)
      };
      if (code !== 0 || !lines[1]) {
        if (/No module named 'paraview'/i.test(err)) {
          if (!result.basenameLooksRight) {
            result.suggestion = `用户把 ParaView Python 路径设成了 ${path.basename(exe)}，普通 python 不带 paraview 模块。请改成 ParaView 安装目录下 bin/pvpython.exe。`;
          } else if (process.env.PYTHONHOME || process.env.PYTHONPATH) {
            result.suggestion = `pvpython 启动了但 import paraview 失败。检测到宿主 PYTHONHOME/PYTHONPATH（conda/系统 Python 在劫持 pvpython 内嵌解释器）。已自动剔除这两个变量再启动；若仍失败说明 ParaView 安装目录不完整。`;
          } else {
            result.suggestion = `pvpython 找不到 paraview 模块——通常是 ParaView 安装不完整。请从官网重新下载 (paraview.org/download)，解压后用其 bin/pvpython.exe。`;
          }
        } else {
          result.suggestion = `pvpython 启动失败 (exit ${code})：${err.trim().slice(-300)}`;
        }
      } else {
        result.suggestion = `OK：pvpython 工作正常，paraview ${lines[2] || ''} @ ${lines[1] || ''}`;
      }
      resolve();
    });
    p.on('error', (e) => {
      clearTimeout(to);
      result.test = { exitCode: -1, error: e.message };
      result.suggestion = `pvpython 启动失败：${e.message}（路径：${exe}）`;
      resolve();
    });
  });
  res.json(result);
});

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  verifyClient: ({ req }, done) => AccessAuth.isAuthorized(req, ACCESS_TOKEN) ? done(true) : done(false, 401, 'Unauthorized'),
});

// ============== WebSocket 心跳（防代理空闲断开 / 自动清理僵尸连接）==============
const WS_PING_MS = 25_000;
const wsHeartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
    try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'heartbeat', t: Date.now() })); } catch {}
  }
}, WS_PING_MS);
wss.on('close', () => clearInterval(wsHeartbeat));

wss.on('connection', (socket) => {
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
  const ws = createTaskTransport(socket, () => session.task?._runningSession === session
    ? [...sessions].filter(([, observer]) => observer !== session && observer.task === session.task).map(([transport]) => transport)
    : []);
  const session = {
    messages: [{ role: 'system', content: SYSTEM_PROMPT_BASE(WORKSPACE) }],
    checkpoints: [], currentCheckpoint: null,
    pendingEdits: [], todos: [], taskComplete: false,
    runState: { runId: null, label: '', stages: [], failCount: {}, memos: [], startedAt: 0 },
    autoMode: true,
    foamMode: !!SETTINGS.foamMode,
    mfixMode: !!SETTINGS.mfixMode,
    lbmMode:  !!SETTINGS.lbmMode,
    customMode: !!SETTINGS.customMode,
    enabledTools: new Set(DEFAULT_ENABLED),
    pendingApproval: null, aborter: null, aborted: false, currentProc: null,
    shell: null, shellCwd: WORKSPACE,
    // V4: 人在回路 — 当 agent 抛出 1)/2)/3) 编号选项且无 tool_call 时，置 true；下一条 user 消息会清零
    awaitingUserChoice: false
  };
  session._ws = ws;
  // 挂载到当前任务：刷新/换模型/重启后接着原上下文继续（任务持久化）
  attachSessionToTask(session, ensureCurrentTask());
  sessions.set(ws, session); allClients.add(ws);
  if (session.task.recovery?.status === 'pending') _recoveryNotice(session.task);
  ws.send(JSON.stringify({ type: 'tools_state', enabled: [...session.enabledTools], groups: TOOL_GROUPS }));
  ws.send(JSON.stringify(taskListPayload(session)));
  try { ws.send(JSON.stringify(taskHistoryPayload(session.task))); } catch {}
  sendTaskRuntime();
  buildTree().then(t => ws.send(JSON.stringify({ type: 'tree', tree: t }))).catch(()=>{});
  broadcastCheckpoints(ws); broadcastEdits(ws); broadcastTodos(ws);
  ws.send(JSON.stringify({ type: 'sim_state', enabled: false, running: !!PV_STATE.pid }));
  if (PV_STATE.lastFrame) ws.send(JSON.stringify({ type: 'sim_frame', dataUrl: PV_STATE.lastFrame }));
  ws.send(JSON.stringify({ type: 'foam_state', enabled: !!session.foamMode, root: SETTINGS.foamRoot || '' }));
  ws.send(JSON.stringify({ type: 'mfix_state', enabled: !!session.mfixMode, root: SETTINGS.mfixRoot || '', bash: SETTINGS.mfixBash || '' }));
  ws.send(JSON.stringify({ type: 'lbm_state', enabled: !!session.lbmMode, tutorialRoot: SETTINGS.lbmTutorialRoot || '', runCmd: SETTINGS.lbmRunCmd || '' }));
  ws.send(JSON.stringify({ type: 'custom_state', enabled: !!session.customMode, name: SETTINGS.customName || '', root: SETTINGS.customRoot || '', prompt: SETTINGS.customPrompt || '' }));

  // —— 交互式 shell ——
  function sendTaskRuntime() {
    const owner = taskOwner(session);
    if (!owner._running) { ws.send(JSON.stringify({ type: 'agent_idle', state: getTaskState(owner) })); return; }
    ws.send(JSON.stringify({ type: 'agent_start' }));
    ws.send(JSON.stringify({ type: 'agent_phase', phase: owner.pendingApproval ? 'awaiting_user' : owner.currentProc ? 'tool_exec' : 'llm_thinking', detail: 'Task owner is running' }));
  }

  function ensureShell() {
    if (session.shell && !session.shell.killed) return session.shell;
    const sh = spawnShell(session.shellCwd);
    session.shell = sh;
    const onData = d => { d.toString().split(/\r?\n/).forEach(line => { if (line !== undefined) ws.send(JSON.stringify({ type: 'pty_out', line })); }); };
    sh.stdout.on('data', onData); sh.stderr.on('data', onData);
    sh.on('exit', (code) => { ws.send(JSON.stringify({ type: 'pty_out', line: `[shell 退出 ${code}]` })); session.shell = null; });
    ws.send(JSON.stringify({ type: 'pty_out', line: `[已启动 ${IS_WIN ? 'cmd.exe' : (process.env.SHELL || 'bash')} @ ${session.shellCwd}]` }));
    return sh;
  }

  ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    const attached = sessions.get(ws); if (!attached) return;
    const owner = taskOwner(attached);
    const ownerControls = ['user', 'stop', 'kill_all', 'approval', 'set_auto', 'set_mode', 'set_goal', 'set_tools', 'set_foam', 'set_mfix', 'set_lbm', 'set_custom'];
    const s = ownerControls.includes(m.type) ? owner : attached;
    if (owner._running && ['reset', 'compact', 'restore_checkpoint', 'undo_edit', 'undo_all'].includes(m.type)) {
      ws.send(JSON.stringify({ type: 'term', line: '[task] Stop the task owner before modifying running state' }));
      return;
    }
    if (m.type === 'user') {
      recoveryManager.cancel(s.task, 'new_message');
      try { await Fidelity.onUserMessage(s, m.text); } catch {}
      s.awaitingUserChoice = false; s._pendingUserText = m.text;
      if (s.task && !s.task.taskText && m.text && String(m.text).trim()) s.task.taskText = String(m.text).slice(0, 4000);
      s._recoveryApprovalBlocked = false;
      clearTimeout(s._choiceTimer); s._choiceTimer = null; s.pendingQuestion = null; s._questionCarried = false; s._choiceTimeouts = 0; s._qMuteNoted = false;
      clearTimeout(s._idleNotifyTimer); s._idleNotifyTimer = null; // A7: 用户回复 → 取消空闲通知
      persistSession(s, true);
      if (s.task) s.task.wakeCount = 0;
      if (s.task && s.task.goal) s.task.goal.nudges = 0;
      // 🧭 Codex 式引导：智能体运行中用户发来的新消息不打断当前工作，排队到下一步推理时注入
      if (s._running) {
        (s._steerQueue || (s._steerQueue = [])).push({ text: m.text, attachments: m.attachments || [] });
        ws.send(JSON.stringify({ type: 'term', line: '[引导] 已收到你的新输入，将在智能体下一步推理时注入（不打断当前工作）' }));
        return;
      }
      // 首条用户消息自动作为任务标题
      if (s.task && (s.task.title === '新任务' || !s.task.title) && m.text) { s.task.title = String(m.text).slice(0, 40); broadcastTaskState(); }
      s.messages[0] = { role: 'system', content: buildSystemPrompt(s) };
      runAgent(s._ws, m.text, m.attachments || []);
    }
    else if (m.type === 'task_new') {
      if (s._running && !ws.isHeadless) { _makeHeadlessSession(s.task); }
      persistSession(s, true);
      const t = createTask(typeof m.title === 'string' && m.title.trim() ? m.title.trim() : '新任务');
      attachSessionToTask(s, t);
      s.checkpoints = []; s.pendingEdits = []; s.taskComplete = false;
      broadcastTaskState();
      ws.send(JSON.stringify(taskHistoryPayload(t)));
      broadcastCheckpoints(ws); broadcastEdits(ws); broadcastTodos(ws);
      ws.send(JSON.stringify({ type: 'term', line: `[任务] 已新建「${t.title}」` }));
    }
    else if (m.type === 'task_switch') {
      if (s._running && !ws.isHeadless) { _makeHeadlessSession(s.task); }
      const t = TASKS.get(m.id);
      if (!t) { ws.send(JSON.stringify({ type: 'term', line: '[任务] 不存在：' + m.id })); return; }
      persistSession(s, true);
      CURRENT_TASK_ID = t.id; _saveTaskMeta();
      attachSessionToTask(s, t);
      s.checkpoints = []; s.pendingEdits = []; s.taskComplete = false;
      broadcastTaskState();
      ws.send(JSON.stringify(taskHistoryPayload(t)));
      broadcastCheckpoints(ws); broadcastEdits(ws); broadcastTodos(ws);
      sendTaskRuntime();
      ws.send(JSON.stringify({ type: 'term', line: `[任务] 已切换到「${t.title}」（${t.messages.length} 条上下文）` }));
    }
    else if (m.type === 'task_delete') {
      const t = TASKS.get(m.id);
      if (!t) return;
      if (t._runningSession && t._runningSession._running) { ws.send(JSON.stringify({ type: 'term', line: '[任务] 该任务运行中，请先停止再删除' })); return; }
      recoveryManager.cancel(t, 'task_delete');
      TASKS.delete(m.id);
      try { fssync.unlinkSync(_taskFile(m.id)); } catch {}
      const replacement = CURRENT_TASK_ID === m.id ? ensureCurrentTask() : null;
      for (const [viewer, viewing] of sessions) if (viewing.task === t) {
        const next = replacement || ensureCurrentTask();
        attachSessionToTask(viewing, next);
        viewing.checkpoints = []; viewing.pendingEdits = []; viewing.taskComplete = false;
        viewer.send(JSON.stringify(taskHistoryPayload(next)));
        broadcastCheckpoints(viewer); broadcastEdits(viewer); broadcastTodos(viewer);
      }
      broadcastTaskState();
      ws.send(JSON.stringify({ type: 'term', line: `[任务] 已删除「${t.title}」` }));
    }
    else if (m.type === 'task_set_model') {
      // 单个任务换模型：只影响这个任务，设置里的主模型不变
      const t = TASKS.get(m.id) || s.task; if (!t) return;
      const ref = m.model ? { provider: String(m.provider || 'main'), model: String(m.model) } : null;
      if (ref && !modelChoices().some(c => c.provider === ref.provider && c.model === ref.model)) { ws.send(JSON.stringify({ type: 'error', message: '这个模型不在可选清单里，先到 设置 › 模型与 API 登记' })); return; }
      t.modelRef = ref; persistTaskNow(t); broadcastTaskState();
      ws.send(JSON.stringify({ type: 'term', line: `[模型] 任务「${t.title}」改用 ${modelLabel(ref)}` }));
    }
    else if (m.type === 'multi_run') {
      // 多模型运行：同一条指令发给 2–5 个模型，每个模型一个独立任务、独立子目录，后台并行跑，之后并排比较
      const refs = (Array.isArray(m.models) ? m.models : []).map(r => ({ provider: String(r.provider || 'main'), model: String(r.model || '') }))
        .filter(r => r.model && modelChoices().some(c => c.provider === r.provider && c.model === r.model));
      const uniq = [...new Map(refs.map(r => [r.provider + '|' + r.model, r])).values()].slice(0, 5);
      const text = String(m.text || '').trim();
      if (!text) { ws.send(JSON.stringify({ type: 'error', message: '多模型运行需要一条指令' })); return; }
      if (uniq.length < 2) { ws.send(JSON.stringify({ type: 'error', message: '多模型运行至少选 2 个模型' })); return; }
      const res = multiRunStart(text, uniq, { autoMode: s.autoMode !== false, agentMode: s.task && s.task.agentMode, attachments: m.attachments || [] });
      ws.send(JSON.stringify({ type: 'multi_run_started', group: res.group, tasks: res.tasks }));
      ws.send(JSON.stringify({ type: 'term', line: `[多模型] 已同时交给 ${uniq.length} 个模型：${uniq.map(modelLabel).join('、')}；每个在 ${res.dirRel}/<模型>/ 下独立工作` }));
    }
    else if (m.type === 'task_rename') {
      const t = TASKS.get(m.id);
      if (t && typeof m.title === 'string' && m.title.trim()) { t.title = m.title.trim().slice(0, 60); persistTaskNow(t); broadcastTaskState(); }
    }
    else if (m.type === 'set_auto') {
      s.autoMode = !!m.value;
      if (s.task) { s.task.autoMode = s.autoMode; persistTaskNow(s.task); }
      for (const other of sessions.values()) if (other.task === s.task) other.autoMode = s.autoMode;
      if (!s.autoMode && s.task) recoveryManager.clear(s.task);
      broadcastTaskState();
    }
    else if (m.type === 'set_mode') {
      if (!s.task) return;
      s.task.agentMode = m.value === 'plan' ? 'plan' : 'build';
      persistTaskNow(s.task); broadcastTaskState();
      ws.send(JSON.stringify({ type: 'term', line: `[模式] ${s.task.agentMode === 'plan' ? '规划（只读，不改文件不跑求解）' : '执行（全部工具）'}` }));
    }
    else if (m.type === 'set_goal') {
      if (!s.task) return;
      const text = typeof m.text === 'string' ? m.text.trim().slice(0, 600) : '';
      if (!text || m.clear) s.task.goal = null;
      else s.task.goal = { text, criteria: typeof m.criteria === 'string' ? m.criteria.trim().slice(0, 1200) : '', status: 'active', nudges: 0, setAt: Date.now() };
      persistTaskNow(s.task); broadcastTaskState();
    }
    else if (m.type === 'task_revert' || m.type === 'task_unrevert') {
      const t = s.task;
      if (!t || (m.id && m.id !== t.id)) return;
      if (s._running || (t._runningSession && t._runningSession._running)) { ws.send(JSON.stringify({ type: 'term', line: '[任务] 运行中不能回滚，请先停止' })); return; }
      try {
        if (m.type === 'task_revert') {
          if (!Number.isInteger(m.ui) || m.ui < 0) throw new Error('消息序号无效');
          const r = await revertTask(t, m.ui);
          s.checkpoints = []; s.pendingEdits = []; s.taskComplete = false; s.currentCheckpoint = null;
          persistTaskNow(t);
          ws.send(JSON.stringify(taskHistoryPayload(t)));
          ws.send(JSON.stringify({ type: 'task_reverted', text: r.text, messages: r.messages, files: r.files, skipped: r.skipped }));
        } else {
          const r = await unrevertTask(t);
          persistTaskNow(t);
          ws.send(JSON.stringify(taskHistoryPayload(t)));
          ws.send(JSON.stringify({ type: 'task_unreverted', messages: r.messages, files: r.files }));
        }
        broadcastEdits(ws); broadcastCheckpoints(ws); broadcastTree(); broadcastTaskState();
      } catch (e) { ws.send(JSON.stringify({ type: 'error', message: (m.type === 'task_revert' ? '回滚失败：' : '撤销回滚失败：') + e.message })); }
    }
    else if (m.type === 'task_fork') {
      if (s._running) { ws.send(JSON.stringify({ type: 'term', line: '[任务] 运行中不能分叉，请先停止' })); return; }
      const src = TASKS.get(m.id) || s.task; if (!src) return;
      persistSession(s, true);
      const t = createTask(`${src.title || '任务'} · 分支`);
      let msgs = JSON.parse(JSON.stringify(src.messages || []));
      // 可选：只保留到第 n 条用户消息之前（从某轮分叉）
      if (Number.isInteger(m.beforeUser) && m.beforeUser >= 0) {
        const at = visibleUserIndices(msgs)[m.beforeUser];
        if (at !== undefined) msgs = msgs.slice(0, at);
      }
      t.messages = msgs.length ? msgs : [{ role: 'system', content: SYSTEM_PROMPT_BASE(WORKSPACE) }];
      t.todos = JSON.parse(JSON.stringify(src.todos || []));
      t.workMem = src.workMem ? JSON.parse(JSON.stringify(src.workMem)) : undefined;
      t.autoMode = src.autoMode; t.agentMode = src.agentMode; t.goal = src.goal ? { ...src.goal, nudges: 0 } : null;
      t.forkOf = src.id; persistTaskNow(t);
      attachSessionToTask(s, t);
      s.checkpoints = []; s.pendingEdits = []; s.taskComplete = false;
      broadcastTaskState();
      ws.send(JSON.stringify(taskHistoryPayload(t)));
      broadcastCheckpoints(ws); broadcastEdits(ws); broadcastTodos(ws);
      ws.send(JSON.stringify({ type: 'term', line: `[任务] 已从「${src.title}」分叉出新分支（${t.messages.length} 条上下文）` }));
    }
    else if (m.type === 'skill_save_ui') {
      // 自进化沉淀卡：用户在 UI 确认后把本轮经验存入技能库（已经 verifier 盖章，force 落盘）
      try {
        const d = m.draft || {};
        const saved = await SkillLib.saveSkill({ ...d, force: true });
        ws.send(JSON.stringify({ type: 'skill_saved', id: saved.id, title: saved.title, domain: saved.domain }));
        ws.send(JSON.stringify({ type: 'term', line: `[技能库] 已存入「${saved.title}」(${saved.domain}) · 共 ${SkillLib.stats().count} 条` }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'term', line: `[技能库] 存入失败：${e.message}` }));
      }
    }
    else if (m.type === 'skill_forget_ui') {
      try { await SkillLib.removeSkill(m.id); ws.send(JSON.stringify({ type: 'term', line: `[技能库] 已删除 ${m.id}` })); } catch {}
    }
    else if (m.type === 'set_tools') {
      const incoming = Array.isArray(m.tools) ? m.tools : [];
      const enabled = new Set([...TOOL_GROUPS.edit, ...incoming]);  // 编辑类始终开启
      s.enabledTools = enabled;
      ws.send(JSON.stringify({ type: 'tools_state', enabled: [...enabled] }));
    }
    // set_sim removed in v2; ParaView frame subscription is opened by set_foam/set_mfix/set_lbm when any Beta mode is enabled.
    else if (m.type === 'set_foam') {
      s.foamMode = !!m.value;
      // 同时把 foam 工具组并入启用集合（关掉时不强制移除，让用户自己取消）
      if (s.foamMode) for (const t of [...TOOL_GROUPS.foam, ...TOOL_GROUPS.opt]) s.enabledTools.add(t);
      // ParaView 帧推送：任一 Beta 模式启用即订阅，全部关闭才取消
      if (s.foamMode || s.mfixMode || s.lbmMode) PV_STATE.subscribers.add(ws);
      else PV_STATE.subscribers.delete(ws);
      s.messages[0] = { role: 'system', content: buildSystemPrompt(s) };
      SETTINGS.foamMode = s.foamMode; await saveSettings();
      ws.send(JSON.stringify({ type: 'tools_state', enabled: [...s.enabledTools], groups: TOOL_GROUPS }));
      ws.send(JSON.stringify({ type: 'foam_state', enabled: s.foamMode, root: SETTINGS.foamRoot || '' }));
      ws.send(JSON.stringify({ type: 'term', line: `[OpenFOAM Beta ${s.foamMode ? '开启' : '关闭'}]` }));
    }
    else if (m.type === 'set_mfix') {
      s.mfixMode = !!m.value;
      if (s.mfixMode) for (const t of TOOL_GROUPS.mfix) s.enabledTools.add(t);
      if (s.foamMode || s.mfixMode || s.lbmMode) PV_STATE.subscribers.add(ws);
      else PV_STATE.subscribers.delete(ws);
      s.messages[0] = { role: 'system', content: buildSystemPrompt(s) };
      SETTINGS.mfixMode = s.mfixMode; await saveSettings();
      ws.send(JSON.stringify({ type: 'tools_state', enabled: [...s.enabledTools], groups: TOOL_GROUPS }));
      ws.send(JSON.stringify({ type: 'mfix_state', enabled: s.mfixMode, root: SETTINGS.mfixRoot || '', bash: SETTINGS.mfixBash || '' }));
      ws.send(JSON.stringify({ type: 'term', line: `[MFIX Beta ${s.mfixMode ? '开启' : '关闭'}]` }));
    }
    else if (m.type === 'set_lbm') {
      s.lbmMode = !!m.value;
      if (s.lbmMode) for (const t of TOOL_GROUPS.lbm) s.enabledTools.add(t);
      if (s.foamMode || s.mfixMode || s.lbmMode) PV_STATE.subscribers.add(ws);
      else PV_STATE.subscribers.delete(ws);
      s.messages[0] = { role: 'system', content: buildSystemPrompt(s) };
      SETTINGS.lbmMode = s.lbmMode; await saveSettings();
      ws.send(JSON.stringify({ type: 'tools_state', enabled: [...s.enabledTools], groups: TOOL_GROUPS }));
      ws.send(JSON.stringify({ type: 'lbm_state', enabled: s.lbmMode, tutorialRoot: SETTINGS.lbmTutorialRoot || '', runCmd: SETTINGS.lbmRunCmd || '' }));
      ws.send(JSON.stringify({ type: 'term', line: `[LBM Beta ${s.lbmMode ? '开启' : '关闭'}]` }));
    }
    else if (m.type === 'set_custom') {
      // 设置自定义工作流：{ enabled, name?, root?, prompt? }
      s.customMode = !!m.enabled;
      if (typeof m.name === 'string')   SETTINGS.customName   = m.name.slice(0, 200);
      if (typeof m.root === 'string')   SETTINGS.customRoot   = m.root.slice(0, 500);
      if (typeof m.prompt === 'string') SETTINGS.customPrompt = m.prompt.slice(0, 20000);
      SETTINGS.customMode = s.customMode;
      await saveSettings();
      s.messages[0] = { role: 'system', content: buildSystemPrompt(s) };
      ws.send(JSON.stringify({ type: 'custom_state', enabled: s.customMode, name: SETTINGS.customName || '', root: SETTINGS.customRoot || '', prompt: SETTINGS.customPrompt || '' }));
      const wc = (SETTINGS.customPrompt || '').length;
      ws.send(JSON.stringify({ type: 'term', line: `[自定义工作流 ${s.customMode ? '开启' : '关闭'}] ${SETTINGS.customName || '(未命名)'} · prompt ${wc} 字符` }));
    }
    else if (m.type === 'pty_input') { try { ensureShell().stdin.write(m.data); } catch (e) { ws.send(JSON.stringify({ type: 'pty_out', line: '[shell 错误] ' + e.message })); } }
    else if (m.type === 'pty_kill') { if (s.shell) try { s.shell.kill(); } catch {} }
    else if (m.type === 'approval' && s.pendingApproval) { const fn = s.pendingApproval; s.pendingApproval = null; fn(!!m.approved); }
    else if (m.type === 'stop') {
      recoveryManager.cancel(s.task, 'stop');
      s.aborted = true;
      if (s.aborter) try { s.aborter.abort(); } catch {}
      if (s.task) { const p = _wakePending.get(s.task.id); if (p) { clearTimeout(p.timer); _wakePending.delete(s.task.id); } }
      // 递归杀当前 agent 同步子进程树（run_command 等）。
      // ⚠ 重要边界：仅杀 s.currentProc，不动 SOLVER_RUNS — 那是用户显式启的后台求解，
      // 必须靠 foam_solver_stop / mfix_solver_stop / lbm_solver_stop 或面板按钮单独控制，
      // 不能让"停止 agent"误杀正在跑的 OpenFOAM/MFIX/LBM 仿真。
      if (s.currentProc) {
        const pid = (s.currentProc._isSolver || IS_WIN) ? s.currentProc.pid : 0;
        if (!pid) _killProcTree(s.currentProc);
        try { s.currentProc.kill(); } catch {}
        if (IS_WIN && pid) {
          try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch {}
        } else if (pid) {
          try { process.kill(pid, 'SIGKILL'); } catch {}
        }
      }
      if (s.pendingApproval) { const fn = s.pendingApproval; s.pendingApproval = null; fn(false); }
      const liveRuns = [...SOLVER_RUNS.values()].filter(r => !r.ended).length;
      const tail = liveRuns ? `（${liveRuns} 个后台求解器未受影响，仍在跑；如要停请在面板/工具里单独 stop）` : '';
      ws.send(JSON.stringify({ type: 'term', line: `[Agent 已停止]${tail}` }));
      ws.send(JSON.stringify({ type: 'agent_end' }));
    } else if (m.type === 'kill_all') {
      recoveryManager.cancel(s.task, 'kill_all');
      // v0.7.0: 强行终止 —— 杀光所有受 CFDriver 管控的子进程
      // 包括：当前 agent 同步进程、所有 SOLVER_RUNS（OpenFOAM/MFIX/LBM 异步求解）、ParaView、pty shell
      s.aborted = true;
      if (s.aborter) try { s.aborter.abort(); } catch {}
      const killTree = (pid) => {
        if (!pid) return;
        if (IS_WIN) {
          try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch {}
        } else {
          try { process.kill(-pid, 'SIGKILL'); } catch {}
          try { process.kill(pid, 'SIGKILL'); } catch {}
        }
      };
      let killedCount = 0;
      // 1) 当前 agent 子进程
      if (s.currentProc && !s.currentProc.killed) {
        try { s.currentProc.kill(); } catch {}
        killTree(s.currentProc.pid);
        killedCount++;
      }
      // 2) 所有未结束的后台求解器
      for (const run of SOLVER_RUNS.values()) {
        if (run.ended) continue;
        killRunTree(run); killTree(run.pid || (run.proc && run.proc.pid));
        setTimeout(() => killRunTree(run, true), 1500);
        clearInterval(run._tail); clearInterval(run._alive);
        run.ended = Date.now(); run.exitCode = run.exitCode == null ? -9 : run.exitCode;
        _persistRuns();
        for (const sub of run.subs) if (sub.readyState === 1) {
          try { sub.send(JSON.stringify({ type: 'solver_done', runId: run.runId, exitCode: -9 })); } catch {}
        }
        killedCount++;
      }
      // 3) ParaView
      try { if (typeof killParaView === 'function') killParaView(); } catch {}
      // 4) pty shell（用户终端）
      if (s.shell && !s.shell.killed) { try { s.shell.kill(); } catch {} killedCount++; }
      if (s.pendingApproval) { const fn = s.pendingApproval; s.pendingApproval = null; fn(false); }
      ws.send(JSON.stringify({ type: 'term', line: `[强行终止] 已杀 ${killedCount} 个进程（含后台求解器、ParaView、shell）` }));
      ws.send(JSON.stringify({ type: 'agent_end' }));
    } else if (m.type === 'reset') {
      recoveryManager.cancel(s.task, 'reset');
      s.messages = [{ role: 'system', content: buildSystemPrompt(s) }];
      s.checkpoints = []; s.pendingEdits = []; s.todos = []; s.taskComplete = false;
      persistSession(s, true);   // 同步清空落盘的任务上下文
      ws.send(JSON.stringify({ type: 'reset_done' }));
      broadcastCheckpoints(ws); broadcastEdits(ws); broadcastTodos(ws);
    } else if (m.type === 'compact') {
      try {
        const before = s.messages.length;
        // 保留 system + 最近 6 条；把中间用一段总结替代
        if (before > 10) {
          const sys = s.messages[0];
          const tail = s.messages.slice(-6);
          const middle = s.messages.slice(1, -6);
          const summary = middle.map(x => {
            if (x.role === 'user') return `[\u7528\u6237] ${(x.content || '').toString().slice(0, 200)}`;
            if (x.role === 'assistant') return `[\u52a9\u624b] ${(x.content || '').toString().slice(0, 300)}` + (x.tool_calls ? ` (\u8c03\u7528 ${x.tool_calls.map(t => t.function?.name).join(',')})` : '');
            if (x.role === 'tool') return `[\u5de5\u5177\u8fd4\u56de] ${String(x.content || '').slice(0, 200)}`;
            return '';
          }).filter(Boolean).join('\n');
          s.messages = [sys, { role: 'user', content: '\u4ee5\u4e0b\u662f\u4e4b\u524d\u4f1a\u8bdd\u7684\u538b\u7f29\u603b\u7ed3\uff1a\n' + summary }, ...tail];
        }
        ws.send(JSON.stringify({ type: 'term', line: `[\u5df2\u538b\u7f29\u4e0a\u4e0b\u6587\uff1a${before} \u2192 ${s.messages.length} \u6761\u6d88\u606f]` }));
      } catch (e) { ws.send(JSON.stringify({ type: 'error', message: '\u538b\u7f29\u5931\u8d25\uff1a' + e.message })); }
    } else if (m.type === 'restore_checkpoint') {
      try { const n = await restoreCheckpoint(s, m.id);
        ws.send(JSON.stringify({ type: 'term', line: `[已回滚 ${n} 个文件]` }));
        broadcastCheckpoints(ws); broadcastEdits(ws); broadcastTree();
      } catch (e) { ws.send(JSON.stringify({ type: 'error', message: '回滚失败：' + e.message })); }
    } else if (m.type === 'keep_edit') { try { keepEdit(s, m.id); broadcastEdits(ws); } catch (e) { ws.send(JSON.stringify({ type: 'error', message: e.message })); } }
    else if (m.type === 'undo_edit') { try { const e = await undoEdit(s, m.id); ws.send(JSON.stringify({ type: 'term', line: `[已撤销 ${e.path}]` })); broadcastEdits(ws); broadcastTree(); } catch (err) { ws.send(JSON.stringify({ type: 'error', message: '撤销失败：' + err.message })); } }
    else if (m.type === 'keep_all') { s.pendingEdits = []; broadcastEdits(ws); }
    else if (m.type === 'undo_all') {
      const ids = s.pendingEdits.map(e => e.id);
      for (const id of ids) { try { await undoEdit(s, id); } catch {} }
      broadcastEdits(ws); broadcastTree();
      ws.send(JSON.stringify({ type: 'term', line: `[已撤销全部待审编辑]` }));
    }
  });
  ws.on('close', () => {
    if (session.shell) try { session.shell.kill(); } catch {}
    PV_STATE.subscribers.delete(ws);
    // 从所有求解器订阅集合中移除，避免向已关闭 socket 推送
    for (const run of SOLVER_RUNS.values()) run.subs.delete(ws);
    allClients.delete(ws);
    if ((session._running || session._choiceTimer) && ws.detach(session)) {
      persistSession(session, true);
      return;
    }
    // 中断进行中的审批/agent 循环，防止内存悬挂
    if (session.pendingApproval) { try { session.pendingApproval(false); } catch {} session.pendingApproval = null; }
    if (session.aborter) { try { session.aborter.abort(); } catch {} }
    session.aborted = true;
    sessions.delete(ws);
  });
});

// v0.7.4 全局兜底：把静默崩溃暴露出来，避免 agent 神秘停掉
process.on('unhandledRejection', (reason, promise) => {
  const msg = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
  console.error('[unhandledRejection]', msg);
  try { for (const ws of allClients || []) ws.send(JSON.stringify({ type: 'term', line: `[诊断·unhandledRejection] ${String(reason && reason.message || reason)}` })); } catch {}
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack || err);
  try { for (const ws of allClients || []) ws.send(JSON.stringify({ type: 'term', line: `[诊断·uncaughtException] ${String(err && err.message || err)}` })); } catch {}
});

await loadSettings();
await loadCopilotState();
await autoProbeEnvironment();
try { await refreshPackIndex(); } catch (e) { console.warn('[packs]', e.message); }
startMcpServers().catch(e => console.warn('[mcp]', e.message));
const HOST = parseCliHost() || process.env.HOST || '127.0.0.1';
ACCESS_TOKEN = AccessAuth.loadAccessToken({ host: HOST, file: path.join(__dirname, '.access_token') });
// 重启时旧进程可能还没释放端口：短暂重试，仍被占用就退出，避免留下不监听的僵尸进程
let listenRetries = 0;
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE' && listenRetries < 10) {
    listenRetries++;
    console.warn(`[listen] ${HOST}:${PORT} 被占用，${listenRetries}/10 次重试（1 s 后）`);
    setTimeout(() => server.listen(PORT, HOST), 1000);
    return;
  }
  console.error('[listen] 无法监听，退出:', err && err.message || err);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  recoveryManager.restore(TASKS.values());
  try { reattachRuns(); } catch (e) { console.warn('[runs] 接管失败:', e.message); }
  try { scanExternalRuns(); } catch (e) { console.warn('[runs] 扫描手动作业失败:', e.message); }
  if (process.platform === 'linux') setInterval(() => { try { scanExternalRuns(); } catch {} }, 20_000).unref();
  console.log(`\n  CFDriver 开发版已启动 (by LZF; CFD 执行、物理评估与候选优化)`);
  console.log(`  平台: ${process.platform}`);
  console.log(`  工作目录: ${WORKSPACE}`);
  console.log(`  Provider:${SETTINGS.provider}  模型: ${SETTINGS.provider === 'copilot' ? SETTINGS.copilotModel : SETTINGS.model}`);
  console.log(`  ParaView:${SETTINGS.paraviewExe || '(未配置)'}`);
  console.log(`  pvpython:${SETTINGS.paraviewPython || '(默认 PATH)'}`);
  console.log(`  OpenFOAM root:${SETTINGS.foamRoot || '(未设置)'}`);
  console.log(`  OpenFOAM bashrc:${SETTINGS.openfoamBash || '(未设置)'}`);
  console.log(`  MFIX root:${SETTINGS.mfixRoot || '(未设置)'}`);
  console.log(`  MFIX bashrc:${SETTINGS.mfixBash || '(未设置)'}`);
  console.log(`  LBM tutorial root:${SETTINGS.lbmTutorialRoot || '(未设置)'}`);
  {
    const flags = [];
    if (process.env.TAVILY_API_KEY) flags.push('Tavily');
    if (process.env.SERPER_API_KEY) flags.push('Serper');
    if (process.env.BRAVE_API_KEY) flags.push('Brave');
    if (process.env.SEARXNG_URL) flags.push('SearXNG');
    if (process.env.SEMANTIC_SCHOLAR_API_KEY) flags.push('S2');
    console.log(`  联网搜索：${flags.length ? flags.join(' + ') + ' + HTML 兜底' : 'HTML 爬取 (DDG/Bing/Baidu)；可设置 TAVILY_API_KEY 获得 SOTA'}`);
    console.log(`  学术：Semantic Scholar + arXiv (无需 Key)`);
  }
  console.log(`  监听:    ${HOST}:${PORT}`);
  console.log(`  打开:    http://${HOST === '0.0.0.0' ? '<服务器IP>' : HOST}:${PORT}\n`);
  if (ACCESS_TOKEN) {
    const ips = Object.values(os.networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
    console.log(`  远程访问已启用口令（.access_token / CFD_ACCESS_TOKEN）。手机打开：`);
    for (const ip of (HOST === '0.0.0.0' ? ips : [HOST])) console.log(`    http://${ip}:${PORT}/app?token=<见 .access_token>`);
    console.log('');
  } else if (!AccessAuth.isLoopbackHost(HOST)) {
    console.warn('  ⚠ 绑定在非回环地址但未设置访问口令\n');
  }
});
