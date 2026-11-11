// deviations.js —— 偏离登记（deviations.log.md）的解析、改写与证据图收集。
// 审批卡片（/api/deviations）和保真度门（fidelity.js）共用这一套解析：界面上看到的和门拦的是同一批条目。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveMentioned } from './path_resolve.js';

export const LOG_NAME = 'deviations.log.md';
// 条目编号：[DEV-R2-003] [DEV-001] [INFO-R2-008] [G1] [DEV-S01]。必须含数字，[TODO]、[x]、[链接](url) 不算条目
const HEAD_RE = /^\[([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)\](?!\()[ \t]*(.*)$/;
const STATUS_RE = /^(PENDING|APPROVED|REJECTED|REVISE|WITHDRAWN|INFO|待批准|已批准|已拒绝|不批准|需修改|已撤回)(?=$|[\s:：,，、(（])[\s:：]*/i;
const STATUS_OF = { pending: 'pending', approved: 'approved', rejected: 'rejected', revise: 'revise', withdrawn: 'withdrawn', info: 'info', 待批准: 'pending', 已批准: 'approved', 已拒绝: 'rejected', 不批准: 'rejected', 需修改: 'revise', 已撤回: 'withdrawn' };
const USER_APPROVED_RE = /user_approved\s*[:=]\s*(yes|true|是|已批准|no|false|否)/i;
const MACHINE_RE = /^\s*(user_decision|user_note|evidence|证据图?)\s*[:：]\s*(.*)$/i;
const IMG_RE = /[\w.\-~/\u4e00-\u9fa5]+\.(?:png|jpe?g|gif|webp)(?![\w.])/gi;
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;

// 用户的决定 → 写进登记的状态词
export const STATUS_WORD = { approve: 'APPROVED', reject: 'REJECTED', modify: 'REVISE' };
// 这三种状态的条目都还没有得到用户放行
export const OPEN_STATUS = new Set(['pending', 'rejected', 'revise']);

const oneLine = s => String(s || '').replace(/\s+/g, ' ').trim();
// 条目内容的指纹（标题 + 正文，不含状态词和系统写的 user_decision / user_note / evidence 行）：
// 用户提交决定时用它确认「批的就是看到的那一版」；批准后正文被改过，界面据此提示
export const sigOf = e => crypto.createHash('sha1').update(oneLine(e && e.title) + '\n' + oneLine(e && e.detail)).digest('hex').slice(0, 12);
// 批准绑定在条目标题上：标题在批准后被改写，批准不再算数（正文追加执行记录不影响）
export const titleKey = e => oneLine(e && e.title);

function dedent(rows) {
  const used = rows.filter(r => r.trim());
  const cut = used.length ? Math.min(...used.map(r => r.length - r.trimStart().length)) : 0;
  return rows.map(r => r.slice(cut).trimEnd()).join('\n').trim();
}

function finish(e, body) {
  const sm = STATUS_RE.exec(e.head);
  e.title = (sm ? e.head.slice(sm[0].length) : e.head).trim();
  e.body = body.join('\n');
  const text = e.head + '\n' + e.body;
  const ua = USER_APPROVED_RE.exec(text);
  if (sm) e.status = STATUS_OF[sm[1].toLowerCase()];
  else if (ua) e.status = /^(no|false|否)$/i.test(ua[1]) ? 'rejected' : 'approved';
  else e.status = /^(INFO|NOTE)\b/.test(e.id) ? 'info' : 'unmarked';
  const refs = [];
  const add = r => { if (r && !refs.includes(r)) refs.push(r); };
  e.decision = ''; e.userNote = '';
  const shown = [];
  for (const row of body) {
    const m = MACHINE_RE.exec(row);
    if (!m) { shown.push(row); continue; }
    const key = m[1].toLowerCase();
    if (key === 'user_decision') e.decision = m[2].trim();
    else if (key === 'user_note') e.userNote = m[2].trim();
    else m[2].split(/[,，;；\s]+/).forEach(add);
  }
  for (const m of text.matchAll(IMG_RE)) add(m[0]);
  e.detail = dedent(shown);
  e.refs = refs.slice(0, 12);
}

// 登记全文 → 条目列表。line / end 是条目在文件里的行号范围（0 起，end 不含）
export function parseLog(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let cur = null;
  const close = stop => {
    if (!cur) return;
    let last = stop;
    while (last > cur.line + 1 && !lines[last - 1].trim()) last--;
    cur.end = last;
    finish(cur, lines.slice(cur.line + 1, last));
    out.push(cur);
    cur = null;
  };
  lines.forEach((row, i) => {
    const m = HEAD_RE.exec(row);
    if (m && /\d/.test(m[1])) { close(i); cur = { id: m[1], line: i, end: i + 1, head: m[2] }; }
    else if (cur && row.startsWith('#')) close(i);
  });
  close(lines.length);
  return out;
}

// 2026-11-10T22:41+08:00（本地时间，带时区）
export function stamp(d = new Date()) {
  const p = n => String(Math.abs(n)).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes())
    + (off < 0 ? '-' : '+') + p(Math.floor(Math.abs(off) / 60)) + ':' + p(Math.abs(off) % 60);
}

// 把用户的决定写进登记：改条目标题行的状态词，并在条目末尾追加 user_decision / user_note 行（历次决定都留痕）
// list: [{ id, decision: 'approve' | 'reject' | 'modify', note }]
export function applyDecisions(text, list, opt) {
  const o = opt || Object.create(null);
  const src = String(text || '');
  const crlf = src.includes('\r\n');
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const entries = parseLog(src);
  const when = stamp(o.now || new Date());
  const via = oneLine(o.via || '审批卡片');
  const todo = new Map();
  const missing = [];
  for (const x of Array.isArray(list) ? list : []) {
    const word = x && STATUS_WORD[x.decision];
    const e = word ? entries.find(k => k.id === x.id) : null;
    if (e) todo.set(e.id, { e, word, note: oneLine(x.note).slice(0, 500) });
    else missing.push(String(x && x.id));
  }
  // 从后往前改，前面条目的行号不受影响
  const order = [...todo.values()].sort((a, b) => b.e.line - a.e.line);
  for (const t of order) {
    const add = ['  user_decision: ' + t.word + ' ' + when + ' ' + via];
    if (t.note) add.push('  user_note: ' + t.note);
    lines.splice(t.e.end, 0, ...add);
    lines[t.e.line] = '[' + t.e.id + '] ' + t.word + (t.e.title ? ' ' + t.e.title : '');
  }
  const joined = lines.join('\n');
  return { text: crlf ? joined.replace(/\n/g, '\r\n') : joined, applied: order.map(t => t.e.id).reverse(), missing };
}

// 审批结果发给智能体的那条消息。open：提交之后登记里仍未放行的条目
const VERB = { approve: '批准', reject: '不批准', modify: '要求修改' };
const OPEN_WORD = { pending: '尚未决定', rejected: '不批准', revise: '要求修改' };
export function decisionMessage(list, open, file) {
  const rows = list.map(x => '- ' + x.id + ' ' + VERB[x.decision] + (x.note ? '：' + x.note : ''));
  const tail = open.length
    ? '还没放行的条目：' + open.map(e => e.id + '（' + OPEN_WORD[e.status] + '）').join('、')
      + '。不批准的按原文做，做完把该条标 WITHDRAWN 并写明已按原文实现；要求修改的按备注改好后把该条重新标 PENDING 申报。这些条目处理完之前不要启动求解器，先做不依赖它们的工作。'
    : '登记里已经没有待批的偏离。没有其它需要我确认的事项的话，按你上一条消息里的方案继续。';
  return '偏离审批（审批卡片，已写入 ' + file + '）：\n' + rows.join('\n') + '\n' + tail;
}

// 登记文件在算例目录，或它的上一、二级目录
export async function findLog(caseDir) {
  if (!caseDir) return null;
  for (const dir of [caseDir, path.dirname(caseDir), path.dirname(path.dirname(caseDir))]) {
    const file = path.join(dir, LOG_NAME);
    let text = '';
    try { text = await fs.readFile(file, 'utf8'); } catch (e) { continue; }
    if (!text) continue;
    const st = await fs.stat(file).catch(() => null);
    return { file, text, mtime: st ? st.mtimeMs : Date.now(), size: st ? st.size : text.length };
  }
  return null;
}

// 原子写：先写临时文件再改名
export async function writeLog(file, text) {
  const tmp = file + '.cfdtmp-' + process.pid;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file);
}

// 每条偏离的证据图：条目里 evidence: 行写的、以及正文提到的图片（按算例目录解析，只认工作区内真实存在的文件）。
// caseImages：算例目录根下的图片（几何渲染、网格剖面一类），给没有单独证据图的条目兜底。
export async function collectEvidence({ workspace, caseDir, entries }) {
  const byId = new Map();
  const caseImages = [];
  if (!caseDir) return { byId, caseImages };
  const refs = [];
  for (const e of entries) for (const r of e.refs || []) if (!refs.includes(r)) refs.push(r);
  const found = refs.length ? await resolveMentioned({ workspace, paths: refs, bases: [caseDir] }) : Object.create(null);
  for (const e of entries) {
    const list = [];
    for (const r of e.refs || []) {
      const hit = found[r];
      if (hit && !hit.isDir && IMG_EXT_RE.test(hit.path) && !list.some(x => x.path === hit.path)) list.push({ path: hit.path, size: hit.size, mtime: Math.round(hit.mtime) });
    }
    if (list.length) byId.set(e.id, list.slice(0, 6));
  }
  const root = path.resolve(workspace);
  let names = [];
  try { names = (await fs.readdir(caseDir, { withFileTypes: true })).filter(d => d.isFile() && IMG_EXT_RE.test(d.name)).map(d => d.name); } catch (e) { names = []; }
  for (const name of names.slice(0, 40)) {
    const full = path.join(caseDir, name);
    const rel = path.relative(root, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const st = await fs.stat(full).catch(() => null);
    if (st) caseImages.push({ path: rel.split(path.sep).join('/'), size: st.size, mtime: Math.round(st.mtimeMs) });
  }
  caseImages.sort((a, b) => b.mtime - a.mtime);
  return { byId, caseImages: caseImages.slice(0, 4) };
}
