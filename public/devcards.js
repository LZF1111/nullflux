// NullFlux 偏离审批卡片：任务算例里 deviations.log.md 的每条偏离一张卡（证据图 + 批准 / 不批准 / 要求修改）。
// 决定攒齐后一次提交：服务器写回登记文件和任务状态，再作为一条用户消息发给智能体。
// 依赖 app.js 的全局：TASKS_UI, ws, addUser, addSystem, setRunning, toast, handleMessage；viewer.js 的 CFDView.lightbox。
(() => {
'use strict';
const $id = id => document.getElementById(id);
const STATUS = { pending: '待批准', approved: '已批准', rejected: '不批准', revise: '要求修改', withdrawn: '已撤回', info: '补值 / 读图', unmarked: '未标状态' };
const PICKS = [['approve', '批准'], ['reject', '不批准'], ['modify', '要求修改']];
const NOTE_HINT = { approve: '备注（可选）', reject: '原因或要求（可选），例如：按原文做', modify: '怎么改（必填）' };
const S = { taskId: '', data: null, sig: '', open: false, auto: new Set(), picks: new Map(), reopen: new Set(), expanded: new Set(), busy: false, extra: '', seq: 0 };

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
const anchor = $id('todo-pill');
if (!anchor) return;
const tray = el('section', 'dev-tray');
tray.hidden = true;
tray.setAttribute('aria-label', '偏离审批');
const pill = el('button', 'dev-pill');
pill.type = 'button';
const panel = el('div', 'dev-panel');
tray.append(pill, panel);
anchor.parentNode.insertBefore(tray, anchor);
pill.onclick = () => { S.open = !S.open; render(); };

const shown = e => e.needsUser || S.reopen.has(e.id);
const label = e => STATUS[e.status] || e.status;

function thumbs(list, caption) {
  const box = el('div', 'dev-ev');
  const items = list.map(x => ({ path: x.path, m: x.mtime }));
  items.forEach((x, i) => {
    const b = el('button', 'dev-thumb');
    b.type = 'button'; b.title = x.path;
    b.setAttribute('aria-label', '查看图片 ' + x.path);
    const img = el('img');
    img.loading = 'lazy'; img.alt = x.path.split('/').pop();
    img.src = '/api/file?path=' + encodeURIComponent(x.path) + '&raw=1&m=' + x.m;
    img.onerror = () => b.remove();
    b.appendChild(img);
    b.onclick = () => { if (window.CFDView) window.CFDView.lightbox(items, i); };
    box.appendChild(b);
  });
  if (caption) box.appendChild(el('span', 'dev-ev-cap', caption));
  return box;
}

function head(e) {
  const h = el('div', 'dev-head');
  h.append(el('span', 'dev-id', e.id), el('span', 'dev-badge', label(e)));
  e.majors.forEach(m => h.appendChild(el('span', 'dev-major', m)));
  return h;
}

function choose(e, key) {
  const cur = S.picks.get(e.id);
  if (cur && cur.decision === key) S.picks.delete(e.id);
  else S.picks.set(e.id, { decision: key, note: cur ? cur.note : '', sig: e.sig });
  render();
  if (key === 'approve' || !S.picks.has(e.id)) return;
  const ta = [...panel.querySelectorAll('textarea.dev-note')].find(t => t.dataset.id === e.id);
  if (ta) ta.focus();
}

function card(e, d) {
  const c = el('article', 'dev-card');
  const pick = S.picks.get(e.id);
  c.dataset.status = e.status;
  if (pick) c.dataset.pick = pick.decision;
  c.append(head(e), el('div', 'dev-title', e.title || '（没有标题）'));
  if (e.unbacked) c.appendChild(el('div', 'dev-warn', '登记里写的是「已批准」，但系统没有你批准这一条的记录。'));
  if (e.decided && e.decided.changed) c.appendChild(el('div', 'dev-warn', '这一条的内容在你上次决定之后被改过。'));
  if (e.detail) c.appendChild(el('div', 'dev-detail', e.detail));
  if (e.userNote) c.appendChild(el('div', 'dev-usernote', '你上次的备注：' + e.userNote));
  if (e.evidence.length) c.appendChild(thumbs(e.evidence, ''));
  else if (d.caseImages.length) c.appendChild(thumbs(d.caseImages, '这一条没有单独附证据图，以上是算例目录里的图'));
  const acts = el('div', 'dev-acts');
  PICKS.forEach(p => {
    const b = el('button', 'dev-act', p[1]);
    b.type = 'button'; b.dataset.k = p[0];
    b.setAttribute('aria-pressed', String(!!pick && pick.decision === p[0]));
    b.onclick = () => choose(e, p[0]);
    acts.appendChild(b);
  });
  c.appendChild(acts);
  if (!pick) return c;
  const ta = el('textarea', 'dev-note');
  ta.rows = 2; ta.value = pick.note; ta.placeholder = NOTE_HINT[pick.decision]; ta.dataset.id = e.id;
  ta.setAttribute('aria-label', e.id + ' 备注');
  ta.oninput = () => { pick.note = ta.value; ta.classList.remove('bad'); };
  c.appendChild(ta);
  return c;
}

function row(e) {
  const r = el('details', 'dev-row');
  r.dataset.status = e.status;
  r.open = S.expanded.has(e.id);
  r.ontoggle = () => { if (r.open) S.expanded.add(e.id); else S.expanded.delete(e.id); };
  const sum = el('summary');
  sum.append(el('span', 'dev-id', e.id), el('span', 'dev-badge', label(e)), el('span', 'dev-row-title', e.title));
  const body = el('div', 'dev-row-body');
  if (e.detail) body.appendChild(el('div', 'dev-detail', e.detail));
  if (e.userNote) body.appendChild(el('div', 'dev-usernote', '你的备注：' + e.userNote));
  if (e.evidence.length) body.appendChild(thumbs(e.evidence, ''));
  const again = el('button', 'dev-link', e.decided ? '重新决定' : '我要对这一条做决定');
  again.type = 'button';
  again.onclick = () => { S.reopen.add(e.id); render(); };
  body.appendChild(again);
  r.append(sum, body);
  return r;
}

function restSummary(rest) {
  const count = new Map();
  rest.forEach(e => count.set(label(e), (count.get(label(e)) || 0) + 1));
  return '其余 ' + rest.length + ' 条：' + [...count].map(x => x[0] + ' ' + x[1]).join(' · ');
}

function foot(cards) {
  const f = el('div', 'dev-foot');
  const picked = cards.filter(e => S.picks.has(e.id)).length;
  const extra = el('textarea', 'dev-extra');
  extra.rows = 1; extra.value = S.extra; extra.placeholder = '给智能体的补充说明（可选）';
  extra.setAttribute('aria-label', '给智能体的补充说明');
  extra.oninput = () => { S.extra = extra.value; };
  const left = cards.length - picked;
  const hint = el('span', 'dev-foot-hint', !picked ? '每条选一个决定，再一起提交' : left ? '还有 ' + left + ' 条没选，可以先提交已选的' : '提交后写入登记文件，并通知智能体');
  const go = el('button', 'dev-submit', S.busy ? '提交中…' : picked ? '提交 ' + picked + ' 项决定' : '提交决定');
  go.type = 'button'; go.disabled = S.busy || !picked;
  go.onclick = submit;
  const line = el('div', 'dev-foot-line');
  line.append(hint, go);
  f.append(extra, line);
  return f;
}

function render() {
  const d = S.data;
  const entries = d ? d.entries : [];
  tray.hidden = !entries.length;
  if (!entries.length) return;
  const waiting = entries.filter(e => e.needsUser).length;
  const agentSide = entries.filter(e => !e.needsUser && (e.status === 'rejected' || e.status === 'revise')).length;
  const caption = waiting ? '偏离审批 · ' + waiting + ' 项等你决定' : agentSide ? '偏离登记 · ' + agentSide + ' 条等智能体处理' : '偏离登记 · 共 ' + entries.length + ' 条';
  tray.dataset.waiting = waiting ? '1' : '0';
  tray.dataset.open = S.open ? '1' : '0';
  pill.setAttribute('aria-expanded', String(S.open));
  pill.replaceChildren(
    el('span', 'dev-pill-dot'),
    el('span', 'dev-pill-text', caption),
    el('span', 'dev-pill-file', d.file),
    el('span', 'dev-pill-chev', S.open ? '收起' : '展开'));
  panel.hidden = !S.open;
  if (!S.open) { panel.replaceChildren(); return; }
  // 重画时保住正在输入的框和滚动位置
  const act = document.activeElement;
  const keep = act && panel.contains(act) && act.tagName === 'TEXTAREA' ? { cls: act.className.split(' ')[0], id: act.dataset.id || '', at: act.selectionStart } : null;
  const top = panel.scrollTop;
  const cards = entries.filter(shown);
  const rest = entries.filter(e => !shown(e));
  const list = el('div', 'dev-list');
  cards.forEach(e => list.appendChild(card(e, d)));
  const kids = [];
  if (!d.gated && cards.length) kids.push(el('div', 'dev-warn', '这个任务没有按论文复现识别，保真度门不会因为这些条目拦截求解；决定仍会写入登记并通知智能体。'));
  if (cards.length) kids.push(list);
  if (rest.length) {
    const more = el('details', 'dev-rest');
    more.open = S.expanded.has('#rest') || !cards.length;
    more.ontoggle = () => { if (more.open) S.expanded.add('#rest'); else S.expanded.delete('#rest'); };
    more.appendChild(el('summary', '', restSummary(rest)));
    rest.forEach(e => more.appendChild(row(e)));
    kids.push(more);
  }
  if (cards.length) kids.push(foot(cards));
  panel.replaceChildren(...kids);
  panel.scrollTop = top;
  if (!keep) return;
  const back = [...panel.querySelectorAll('textarea.' + keep.cls)].find(t => (t.dataset.id || '') === keep.id);
  if (back) { back.focus(); back.setSelectionRange(keep.at, keep.at); }
}

async function refresh(force) {
  const taskId = TASKS_UI.currentId || '';
  if (taskId !== S.taskId) {
    S.taskId = taskId; S.data = null; S.sig = ''; S.open = false; S.extra = '';
    S.picks.clear(); S.reopen.clear(); S.expanded.clear();
    render();
  }
  if (!taskId || (!force && document.hidden) || S.busy) return;
  const seq = ++S.seq;
  let d = null;
  try { d = await (await fetch('/api/deviations?taskId=' + encodeURIComponent(taskId))).json(); } catch (e) { d = null; }
  if (seq !== S.seq || taskId !== (TASKS_UI.currentId || '') || !d || !Array.isArray(d.entries)) return;
  const sig = JSON.stringify([d.file, d.entries, d.caseImages, d.gated]);
  if (sig === S.sig) return;
  S.sig = sig; S.data = d;
  // 条目被改过或删掉：之前选的决定作废，按最新内容重新选
  [...S.picks].forEach(x => { const e = d.entries.find(k => k.id === x[0]); if (!e || e.sig !== x[1].sig) S.picks.delete(x[0]); });
  if (d.waiting > 0 && !S.auto.has(taskId)) { S.auto.add(taskId); S.open = true; }
  render();
}

async function submit() {
  const d = S.data;
  const taskId = S.taskId;
  if (S.busy || !d || !taskId) return;
  const list = [...S.picks].filter(x => d.entries.some(e => e.id === x[0] && shown(e)));
  if (!list.length) return;
  const bad = list.find(x => x[1].decision === 'modify' && !x[1].note.trim());
  if (bad) {
    const ta = [...panel.querySelectorAll('textarea.dev-note')].find(t => t.dataset.id === bad[0]);
    if (ta) { ta.classList.add('bad'); ta.focus(); }
    toast(bad[0] + '：「要求修改」需要写明怎么改');
    return;
  }
  if (!ws || ws.readyState !== 1) { toast('与服务器的连接已断开，稍后再提交'); return; }
  S.busy = true; render();
  let r = null;
  try {
    const body = JSON.stringify({ taskId, decisions: list.map(x => ({ id: x[0], decision: x[1].decision, note: x[1].note.trim(), sig: x[1].sig })) });
    r = await (await fetch('/api/deviations/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).json();
  } catch (e) { r = { ok: false, error: '提交失败：' + String((e && e.message) || e) }; }
  S.busy = false;
  if (!r || !r.ok) {
    toast((r && r.error) || '提交失败');
    S.sig = ''; render(); refresh(true);
    return;
  }
  const extra = S.extra.trim();
  const text = r.message + (extra ? '\n补充说明：' + extra : '');
  const left = d.entries.filter(e => e.needsUser && !list.some(x => x[0] === e.id)).length;
  S.picks.clear(); S.reopen.clear(); S.extra = ''; S.sig = '';
  if (!left) S.open = false;
  render(); refresh(true);
  // 决定已经写进登记；通知智能体走普通的用户消息通道
  if (taskId !== (TASKS_UI.currentId || '') || ws.readyState !== 1) { toast('决定已保存，但没能通知智能体：回到该任务后发一句「继续」', 6000); return; }
  const steering = !$id('stop').disabled;
  addUser(text, []);
  ws.send(JSON.stringify({ type: 'user', text, attachments: [] }));
  if (steering) addSystem('已发送：智能体会在下一步推理时看到你的决定（不打断当前工作）');
  else setRunning(true);
}

const _handle = window.handleMessage;
window.handleMessage = function (m) {
  _handle(m);
  if (m && (m.type === 'task_state' || m.type === 'task_history' || m.type === 'agent_end')) setTimeout(() => refresh(true), 150);
};
setInterval(() => refresh(false), 4000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });
refresh(true);

window.CFDDev = { refresh, state: S };
})();
