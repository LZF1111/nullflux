// NullFlux 文件查看器增强（对标 OpenChamber）：预览标签与标签菜单、图片缩放平移、视频预览、
// 磁盘变更自动重载、保存状态、对话里的可点击路径与内联图片。
// 依赖 app.js / features.js 的全局：tabs, activeTab, editor, monacoReady, openFile, openImage, renderTabs, saveActive,
// renderMarkdownInto, closeTab, openArtifact, previewToolbar, markPreviewTab, rawUrl, showView, panelVis, TASKS_UI, ARTIFACTS, FX。
(() => {
'use strict';
const TAB_CAP = 12;
const $id = id => document.getElementById(id);
const baseName = p => String(p).split('/').pop();
const clock = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const typing = e => !!(e.target && e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"], .monaco-editor'));
const VIDEO_RE = /\.(mp4|webm|ogv|mov)$/i;
const INLINE_IMG_RE = /\.(png|jpe?g|gif|webp)$/i;

// ====================== 1. 预览标签：单击打开的是预览（斜体），下一次打开会替换它；双击或编辑后固定 ======================
const pinRequests = new Set();
const inflight = new Map();
function dropTab(p) {
  const t = tabs.get(p);
  if (!t) return;
  if (t.model && t.model.dispose) t.model.dispose();
  tabs.delete(p);
}
function moveTab(p, index) {
  const entries = [...tabs.entries()];
  const i = entries.findIndex(e => e[0] === p);
  if (i < 0 || index < 0) return;
  const item = entries.splice(i, 1)[0];
  entries.splice(Math.min(index, entries.length), 0, item);
  tabs.clear();
  for (const e of entries) tabs.set(e[0], e[1]);
}
function pinTab(p) {
  const t = tabs.get(p);
  if (!t || !t.preview) return;
  t.preview = false; t.galleryTab = false;
  renderTabs();
}
function requestPin(p) {
  if (tabs.has(p)) return pinTab(p);
  pinRequests.add(p);
  setTimeout(() => pinRequests.delete(p), 5000);
}
function capTabs() {
  for (const e of [...tabs.entries()]) {
    if (tabs.size <= TAB_CAP) break;
    if (e[0] !== activeTab && !e[1].dirty) dropTab(e[0]);
  }
}
const _open = window.openFile;
async function openTracked(self, p, opt) {
  const had = tabs.has(p);
  const video = document.querySelector('#img-host video');
  if (video) video.pause();
  const r = VIDEO_RE.test(p) ? await openVideo(p) : await _open.call(self, p, opt);
  const t = tabs.get(p);
  if (!t || activeTab !== p) return r;
  if (!had) {
    t.preview = !(opt && opt.pin) && !pinRequests.has(p) && !t.dirty;
    if (t.preview) {
      const olds = [...tabs.entries()].filter(e => e[1].preview && e[0] !== p && !e[1].dirty).map(e => e[0]);
      const at = olds.length ? [...tabs.keys()].indexOf(olds[0]) : -1;
      olds.forEach(dropTab);
      if (at >= 0) moveTab(p, at);
    }
    capTabs();
  } else if ((opt && opt.pin) || pinRequests.has(p)) { t.preview = false; t.galleryTab = false; }
  renderTabs();
  return r;
}
window.openFile = openFile = function (p, opt) {
  if (!p) return _open.call(this, p, opt);
  // 同一个文件的重复点击（双击）共用一次加载
  if (inflight.has(p)) return inflight.get(p);
  const job = openTracked(this, p, opt).finally(() => inflight.delete(p));
  inflight.set(p, job);
  return job;
};
// 文件树双击 = 固定
const tree = $id('tree');
if (tree) tree.addEventListener('dblclick', e => {
  const n = e.target.closest('.tree-node.file');
  if (n && n.dataset.path) requestPin(n.dataset.path);
});
// 编辑即固定
if (typeof monacoReady !== 'undefined') monacoReady.then(() => editor.onDidChangeModelContent(() => {
  const t = activeTab && tabs.get(activeTab);
  if (t && t.preview && !t._reloading) { t.preview = false; renderTabs(); }
}));

// 标签：中键关闭、双击固定、右键菜单
function closeMany(list) {
  list.filter(p => p !== activeTab).forEach(p => closeTab(p));
  if (list.includes(activeTab)) closeTab(activeTab);
}
function copyPath(p) {
  const done = () => toast('已复制 ' + p);
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(p).then(done, () => prompt('复制：', p));
  else prompt('复制：', p);
}
function tabMenu(p, x, y) {
  const keys = [...tabs.keys()], i = keys.indexOf(p), t = tabs.get(p);
  const others = keys.filter(k => k !== p), right = keys.slice(i + 1), left = keys.slice(0, i);
  const items = [{ label: '关闭', key: '中键', run: () => closeTab(p) }];
  if (others.length) items.push({ label: '关闭其他', run: () => closeMany(others) });
  if (right.length) items.push({ label: '关闭右侧', run: () => closeMany(right) });
  if (left.length) items.push({ label: '关闭左侧', run: () => closeMany(left) });
  if (others.length) items.push({ label: '全部关闭', run: () => closeMany(keys) });
  items.push('-');
  if (t && t.preview) items.push({ label: '固定标签', key: '双击', run: () => pinTab(p) });
  items.push({ label: '复制相对路径', run: () => copyPath(p) });
  items.push({ label: '在对话中引用', key: '@', run: () => { const inp = $id('input'); inp.value += (inp.value && !/\s$/.test(inp.value) ? ' ' : '') + '@' + p + ' '; inp.focus(); } });
  if (window.FX && FX.showMenu) FX.showMenu(x, y, items);
}
const _renderTabs = window.renderTabs;
window.renderTabs = renderTabs = function () {
  _renderTabs();
  const keys = [...tabs.keys()];
  document.querySelectorAll('#tabs .tab').forEach((div, i) => {
    const p = keys[i], t = tabs.get(p);
    if (!t) return;
    div.dataset.path = p;
    div.classList.toggle('preview', !!t.preview);
    div.title = p + (t.preview ? '（预览：双击固定）' : '');
  });
  // 当前标签不是视频时，停掉还在后台播放的视频
  const video = document.querySelector('#img-host video');
  const cur = activeTab && tabs.get(activeTab);
  if (video && !(cur && cur.video)) video.pause();
  updateStatus();
};
const tabBar = $id('tabs');
const tabPath = e => { const d = e.target.closest('.tab'); return d && tabs.has(d.dataset.path) ? d.dataset.path : null; };
if (tabBar) {
  tabBar.addEventListener('dblclick', e => { const p = tabPath(e); if (p && !e.target.classList.contains('x')) pinTab(p); });
  tabBar.addEventListener('mousedown', e => { if (e.button === 1 && tabPath(e)) e.preventDefault(); });
  tabBar.addEventListener('auxclick', e => { const p = tabPath(e); if (p && e.button === 1) { e.preventDefault(); closeTab(p); } });
  tabBar.addEventListener('contextmenu', e => { const p = tabPath(e); if (p) { e.preventDefault(); tabMenu(p, e.clientX, e.clientY); } });
}

// ====================== 2. 图片：默认适应窗口，Ctrl+滚轮以指针为中心缩放，双击 100% / 适应，拖动平移 ======================
const ZOOM = new Map();   // 路径 → 上次的缩放与位置（只记非「适应」状态，同一张图重载后还原）
function makeZoomable(host, p) {
  const wrap = host.querySelector('.img-wrap');
  const img = wrap && wrap.querySelector('img');
  const bar = host.querySelector('.img-meta');
  if (!img || !bar) return;
  img.onclick = null; img.title = ''; img.draggable = false;
  host.classList.remove('zoomed'); host.classList.add('zoomable');
  const ctl = document.createElement('span'); ctl.className = 'zoom-ctl';
  ctl.innerHTML = '<button type="button" class="mini" data-z="out" title="缩小（-）" aria-label="缩小">−</button>'
    + '<button type="button" class="mini zoom-pct" data-z="one" title="在 100% 和适应窗口之间切换（0）">100%</button>'
    + '<button type="button" class="mini" data-z="in" title="放大（+）" aria-label="放大">+</button>'
    + '<button type="button" class="mini" data-z="fit" title="适应窗口">适应</button>';
  bar.insertBefore(ctl, bar.querySelector('button'));
  const pct = ctl.querySelector('.zoom-pct');
  const st = { s: 1, tx: 0, ty: 0, fit: true, nw: 0, nh: 0 };
  const fitScale = () => (wrap.clientWidth > 48 && wrap.clientHeight > 48 ? Math.min((wrap.clientWidth - 24) / st.nw, (wrap.clientHeight - 24) / st.nh, 1) : 1);
  const paint = () => {
    const W = wrap.clientWidth, H = wrap.clientHeight, w = st.nw * st.s, h = st.nh * st.s;
    st.tx = w <= W ? (W - w) / 2 : Math.min(0, Math.max(W - w, st.tx));
    st.ty = h <= H ? (H - h) / 2 : Math.min(0, Math.max(H - h, st.ty));
    img.style.transform = 'translate(' + st.tx + 'px, ' + st.ty + 'px) scale(' + st.s + ')';
    pct.textContent = Math.round(st.s * 100) + '%';
    wrap.classList.toggle('pannable', w > W + 1 || h > H + 1);
    if (st.fit) ZOOM.delete(p); else ZOOM.set(p, { s: st.s, tx: st.tx, ty: st.ty, nw: st.nw, nh: st.nh });
  };
  const toFit = () => { st.fit = true; st.s = fitScale(); paint(); };
  const zoomAt = (cx, cy, s) => {
    s = Math.max(Math.min(0.1, fitScale()), Math.min(16, s));
    st.tx = cx - (cx - st.tx) * s / st.s; st.ty = cy - (cy - st.ty) * s / st.s;
    st.s = s; st.fit = false; paint();
  };
  const toggle = (cx, cy) => (Math.abs(st.s - 1) < 0.01 ? toFit() : zoomAt(cx, cy, 1));
  const mid = () => [wrap.clientWidth / 2, wrap.clientHeight / 2];
  const local = e => { const r = wrap.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const init = () => {
    st.nw = img.naturalWidth || 800; st.nh = img.naturalHeight || 600;
    img.style.width = st.nw + 'px'; img.style.height = st.nh + 'px';
    const saved = ZOOM.get(p);
    if (saved && saved.nw === st.nw && saved.nh === st.nh) { st.s = saved.s; st.tx = saved.tx; st.ty = saved.ty; st.fit = false; paint(); }
    else toFit();
    img.classList.add('ready');
  };
  if (img.complete && img.naturalWidth) init(); else img.addEventListener('load', init);
  wrap.addEventListener('wheel', e => {
    if (!st.nw) return;
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); const c = local(e); zoomAt(c[0], c[1], st.s * Math.exp(-e.deltaY * 0.002)); }
    else if (wrap.classList.contains('pannable')) { e.preventDefault(); st.tx -= e.deltaX; st.ty -= e.deltaY; st.fit = false; paint(); }
  }, { passive: false });
  wrap.addEventListener('dblclick', e => { if (st.nw) { const c = local(e); toggle(c[0], c[1]); } });
  let drag = null;
  wrap.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !wrap.classList.contains('pannable')) return;
    drag = { x: e.clientX, y: e.clientY, tx: st.tx, ty: st.ty };
    wrap.setPointerCapture(e.pointerId); wrap.classList.add('dragging');
  });
  wrap.addEventListener('pointermove', e => {
    if (!drag) return;
    st.tx = drag.tx + e.clientX - drag.x; st.ty = drag.ty + e.clientY - drag.y; st.fit = false; paint();
  });
  const endDrag = () => { drag = null; wrap.classList.remove('dragging'); };
  wrap.addEventListener('pointerup', endDrag); wrap.addEventListener('pointercancel', endDrag);
  const step = f => { if (st.nw) { const c = mid(); zoomAt(c[0], c[1], st.s * f); } };
  ctl.onclick = e => {
    const b = e.target.closest('button');
    if (!b || !st.nw) return;
    const c = mid(), z = b.dataset.z;
    if (z === 'in') step(1.25); else if (z === 'out') step(0.8); else if (z === 'fit') toFit(); else toggle(c[0], c[1]);
  };
  // 下一帧再重算，避免在尺寸回调里改布局
  let resizeRaf = 0;
  new ResizeObserver(() => {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; if (st.nw && wrap.isConnected) { if (st.fit) toFit(); else paint(); } });
  }).observe(wrap);
  host._zoom = { step, toggle: () => { const c = mid(); toggle(c[0], c[1]); }, state: st };
}
const _openImage = window.openImage;
window.openImage = openImage = async function (p) {
  await _openImage(p);
  const host = $id('img-host');
  if (host && activeTab === p) makeZoomable(host, p);
};
document.addEventListener('keydown', e => {
  if (LB || e.ctrlKey || e.metaKey || e.altKey || typing(e)) return;
  const host = $id('img-host'), z = host && host._zoom;
  if (!z || host.style.display === 'none' || !panelVis.fileview || !host.classList.contains('zoomable')) return;
  if (e.key === '+' || e.key === '=') z.step(1.25); else if (e.key === '-') z.step(0.8); else if (e.key === '0') z.toggle(); else return;
  e.preventDefault();
});

// 视频预览
async function openVideo(p) {
  const host = $id('img-host');
  if (!host) return;
  host.innerHTML = ''; host.classList.remove('zoomed', 'zoomable'); host._zoom = null;
  const url = rawUrl(p);
  const bar = previewToolbar(p, '<button class="mini" type="button" data-act="open">新标签打开</button>');
  bar.querySelector('[data-act="open"]').onclick = () => window.open(url, '_blank', 'noopener');
  const wrap = document.createElement('div'); wrap.className = 'img-wrap video-wrap';
  const v = document.createElement('video'); v.controls = true; v.preload = 'metadata'; v.src = url;
  v.onloadedmetadata = () => { const m = host.querySelector('.img-dims'); if (m) m.textContent = v.videoWidth + ' × ' + v.videoHeight + ' · ' + Math.round(v.duration) + ' s'; };
  v.onerror = () => { wrap.textContent = '浏览器无法播放这个视频：' + p; wrap.classList.add('muted', 'small'); };
  wrap.appendChild(v); host.append(bar, wrap);
  showView('image'); markPreviewTab(p, 'video');
}

// ====================== 3. 保存状态 + 磁盘上变了就静默重新加载（本地没有未保存编辑时） ======================
const NOTE = new Map();   // 路径 → 状态文字
const statusEl = document.createElement('span');
statusEl.id = 'save-status'; statusEl.className = 'save-status'; statusEl.setAttribute('aria-live', 'polite');
const saveBtn = $id('save-file');
if (saveBtn) saveBtn.before(statusEl);
function updateStatus() {
  const t = activeTab && tabs.get(activeTab);
  let text = '', tone = '';
  if (t && t.dirty) { text = t._diskNewer ? '磁盘上有新版本，保存时会提示' : '未保存'; tone = t._diskNewer ? 'warn' : ''; }
  else if (t && t._gone) { text = '文件已不在磁盘上'; tone = 'warn'; }
  else if (t && NOTE.has(activeTab)) text = NOTE.get(activeTab);
  statusEl.textContent = text; statusEl.dataset.tone = tone;
}
const _save = window.saveActive;
window.saveActive = saveActive = async function (force) {
  const p = activeTab, t = p && tabs.get(p);
  if (!t || !t.dirty || !t.model) return _save(force);
  statusEl.textContent = '保存中…'; statusEl.dataset.tone = '';
  await _save(force);
  if (tabs.get(p) === t && !t.dirty) { t._diskNewer = false; NOTE.set(p, '已保存 ' + clock()); }
  updateStatus();
};
function applyDisk(p, t, j) {
  const content = j.content || '';
  t.mtime = j.mtime; t.truncated = !!j.truncated;
  if (content === t.originalContent) return;
  const shown = editor.getModel() === t.model;
  const ranges = shown ? editor.getVisibleRanges() : [];
  const atEnd = ranges.length > 0 && ranges[ranges.length - 1].endLineNumber >= t.model.getLineCount() - 1;
  const view = shown ? editor.saveViewState() : null;
  t.originalContent = content; t._reloading = true;
  try { t.model.setValue(content); } finally { t._reloading = false; }
  if (shown) {
    editor.updateOptions({ readOnly: !!t.truncated });
    // 正看着文件末尾（跟日志）就继续跟到末尾，否则留在原位置
    if (atEnd) editor.revealLine(t.model.getLineCount()); else if (view) editor.restoreViewState(view);
    if (window.FX && FX.pvRefresh) FX.pvRefresh();
  }
  NOTE.set(p, '已从磁盘更新 ' + clock());
  updateStatus();
}
let polling = false;
async function pollDisk() {
  if (polling || document.hidden || !panelVis.fileview || !activeTab || LB) return;
  const p = activeTab, t = tabs.get(p);
  if (!t || t.truncated || !(t.model || t.image)) return;
  const now = Date.now();
  if (now < (t._nextPoll || 0)) return;
  polling = true;
  try {
    const st = await (await fetch('/api/stat?path=' + encodeURIComponent(p))).json();
    if (activeTab !== p || tabs.get(p) !== t) return;
    t._nextPoll = now + (st.size > 1048576 ? 15000 : st.size > 262144 ? 6000 : 0);
    if (!st.exists) { if (!t._gone) { t._gone = true; updateStatus(); } return; }
    if (t._gone) { t._gone = false; updateStatus(); }
    if (typeof t.mtime !== 'number') { t.mtime = st.mtime; return; }
    if (Math.abs(st.mtime - t.mtime) <= 1) { t._seenM = null; return; }
    if (!t.model) {
      // 图片等它写完：连续两次轮询修改时间一致才重载，免得读到写了一半的文件
      if (t._seenM !== st.mtime) { t._seenM = st.mtime; return; }
      t._seenM = null;
      t.mtime = st.mtime;
      if (st.size > 0) { await openImage(p); NOTE.set(p, '已更新 ' + clock()); updateStatus(); }
      return;
    }
    if (t.dirty) { if (!t._diskNewer) { t._diskNewer = true; updateStatus(); } return; }
    const j = await (await fetch('/api/file?path=' + encodeURIComponent(p))).json();
    if (activeTab !== p || tabs.get(p) !== t || t.dirty || j.error || j.binary) return;
    applyDisk(p, t, j);
  } catch (e) {
    t._nextPoll = Date.now() + 10000;   // 服务暂时连不上：稍后再试
  } finally { polling = false; }
}
setInterval(pollDisk, 2000);

// ====================== 4. 对话里的路径：存在的文件变成链接（`:行号` 跳到该行），图片在消息下方内联显示 ======================
const EXT = 'png|jpe?g|gif|webp|svg|bmp|pdf|md|txt|log|csv|tsv|dat|xy|json|ya?ml|py|sh|m?js|ts|c|h|cpp|hpp|C|H|stl|obj|vtu|vtp|vtk|vtm|pvd|msh|mp4|webm|html|tex|bib|ipynb|cfg|ini|toml|orig';
let TEXT_RE = null;
try { TEXT_RE = new RegExp('(?<![\\w/\\\\.\\-~@])((?:~?/|\\.{1,2}/)?(?:[\\w.\\-+@]+/)*[\\w.\\-+@]+\\.(?:' + EXT + '))(?::(\\d+))?(?![\\w/])', 'g'); }
catch (e) { TEXT_RE = null; }
const CODE_RE = /^(?:[A-Za-z]:[\\/]|~?\/|\.{1,2}\/)?(?:[\w.\-+@\u4e00-\u9fa5]+[\\/])*[\w.\-+@\u4e00-\u9fa5]+$/;
function codeCandidate(text) {
  const s = String(text).trim();
  if (s.length < 3 || s.length > 200) return null;
  const m = /^(.+?)(?::(\d+))?$/.exec(s);
  const raw = m[1];
  if (!CODE_RE.test(raw) || /^[\d.eE+\-]+$/.test(raw)) return null;
  if (!/[\\/]/.test(raw) && !/\.[A-Za-z_]\w{0,9}$/.test(raw)) return null;
  return { raw, line: m[2] ? Number(m[2]) : 0 };
}
// 正文里像路径的片段（网址不算）
function textCandidates(text) {
  const out = [];
  if (!TEXT_RE) return out;
  for (const m of String(text).matchAll(TEXT_RE)) {
    if (/^www\./i.test(m[1])) continue;
    out.push({ raw: m[1], line: m[2] ? Number(m[2]) : 0, index: m.index, text: m[0] });
  }
  return out;
}
const RES = new Map();        // 任务 + 原始写法 → 解析结果（不存在记 null）
const waiting = new Set();    // 等解析结果的气泡
const queue = new Set();
let flushTimer = 0;
const keyOf = raw => (TASKS_UI.currentId || '') + '\n' + raw;
function lookup(raw) {
  const c = RES.get(keyOf(raw));
  if (!c) return undefined;
  if (Date.now() - c.at > (c.info ? 300000 : 20000)) { RES.delete(keyOf(raw)); return undefined; }
  return c.info;
}
function recentDirs() {
  const out = [];
  const dirOf = p => (p && p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const add = d => { if (d && !out.includes(d) && out.length < 6) out.push(d); };
  const list = [activeTab].concat(ARTIFACTS.slice(0, 12)).filter(Boolean);
  list.forEach(p => add(dirOf(p)));
  list.forEach(p => add(dirOf(dirOf(p))));
  return out;
}
async function flush() {
  flushTimer = 0;
  const paths = [...queue].slice(0, 80);
  if (!paths.length) return;
  paths.forEach(p => queue.delete(p));
  const taskId = TASKS_UI.currentId || '';
  let found = null;
  try {
    const r = await fetch('/api/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId, paths, bases: recentDirs() }) });
    found = (await r.json()).found || null;
  } catch (e) { found = null; }
  const at = Date.now();
  for (const raw of paths) RES.set(taskId + '\n' + raw, { info: (found && found[raw]) || null, at });
  if (queue.size) { flushTimer = setTimeout(flush, 50); return; }
  const list = [...waiting];
  waiting.clear();
  list.forEach(b => { try { linkify(b); } catch (e) { console.warn('[linkify]', e); } });
}
function makeLink(info, line) {
  const a = document.createElement('a');
  a.className = 'file-link'; a.href = '#';
  a.dataset.path = info.path; a.dataset.size = String(info.size || 0); a.dataset.m = String(Math.round(info.mtime || 0));
  if (line) a.dataset.line = String(line);
  a.title = '打开 ' + info.path + (line ? '（第 ' + line + ' 行）' : '');
  return a;
}
function linkify(bubble) {
  if (!bubble || !bubble.isConnected || bubble.closest('.fx-md') || !bubble.closest('.msg.assistant')) return;
  const unknown = [];
  const usable = raw => {
    const info = lookup(raw);
    if (info === undefined) { if (unknown.length < 60 && !unknown.includes(raw)) unknown.push(raw); return null; }
    return info && !info.isDir ? info : null;
  };
  bubble.querySelectorAll('code').forEach(code => {
    if (code.closest('pre, a')) return;
    const c = codeCandidate(code.textContent || '');
    const info = c && usable(c.raw);
    if (!info) return;
    const a = makeLink(info, c.line);
    code.replaceWith(a); a.appendChild(code);
  });
  if (TEXT_RE) {
    const skip = n => !n.parentElement || n.parentElement.closest('a, code, pre, button, .katex, .msg-images');
    const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue && n.nodeValue.length > 4 && !skip(n)) nodes.push(n);
    for (const node of nodes) {
      const text = node.nodeValue;
      const frag = document.createDocumentFragment();
      let pos = 0, any = false;
      for (const c of textCandidates(text)) {
        const info = usable(c.raw);
        if (!info) continue;
        const a = makeLink(info, c.line);
        a.textContent = c.text;
        frag.append(text.slice(pos, c.index), a);
        pos = c.index + c.text.length; any = true;
      }
      if (any) { frag.append(text.slice(pos)); node.replaceWith(frag); }
    }
  }
  inlineImages(bubble);
  if (unknown.length) {
    unknown.forEach(raw => queue.add(raw));
    waiting.add(bubble);
    if (!flushTimer) flushTimer = setTimeout(flush, 250);
  }
}
const imgUrl = x => '/api/file?path=' + encodeURIComponent(x.path) + '&raw=1&m=' + x.m;
function inlineImages(bubble) {
  const list = [];
  bubble.querySelectorAll('a.file-link').forEach(a => {
    const p = a.dataset.path;
    if (list.length < 12 && INLINE_IMG_RE.test(p) && Number(a.dataset.size) <= 10485760 && !list.some(x => x.path === p)) list.push({ path: p, m: a.dataset.m || '' });
  });
  let strip = bubble._imgStrip || null;
  if (!list.length) { if (strip) strip.remove(); bubble._imgStrip = null; return; }
  const sig = list.map(x => x.path + '@' + x.m).join('|');
  // 流式输出时气泡会反复重绘：同一组图片复用同一个节点，不重新加载
  if (strip && strip.dataset.sig === sig) { if (strip.parentNode !== bubble) bubble.appendChild(strip); return; }
  const chat = $id('chat');
  const nearBottom = chat && chat.scrollHeight - chat.scrollTop - chat.clientHeight < 240;
  if (strip) strip.remove();
  strip = document.createElement('div'); strip.className = 'msg-images'; strip.dataset.sig = sig;
  list.forEach((x, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'msg-img'; b.title = x.path;
    b.setAttribute('aria-label', '查看图片 ' + x.path);
    const img = document.createElement('img'); img.loading = 'lazy'; img.alt = baseName(x.path); img.src = imgUrl(x);
    img.onerror = () => b.remove();
    b.appendChild(img); b.onclick = () => lightbox(list, i);
    strip.appendChild(b);
  });
  bubble.appendChild(strip); bubble._imgStrip = strip;
  if (nearBottom) chat.scrollTop = chat.scrollHeight;
}
const _md = window.renderMarkdownInto;
window.renderMarkdownInto = renderMarkdownInto = async function (bubble, raw) {
  await _md(bubble, raw);
  try { linkify(bubble); } catch (e) { console.warn('[linkify]', e); }
};
async function openPath(p, line) {
  await openArtifact(p);
  const t = tabs.get(p);
  if (!line || activeTab !== p || !t || !t.model) return;
  setTimeout(() => { editor.revealLineInCenter(line); editor.setPosition({ lineNumber: line, column: 1 }); editor.focus(); }, 80);
}
document.addEventListener('click', e => {
  const a = e.target.closest && e.target.closest('a.file-link');
  if (!a) return;
  e.preventDefault();
  openPath(a.dataset.path, Number(a.dataset.line) || 0);
});

// 灯箱：Esc 关闭，←/→ 切换
let LB = null;
function closeLightbox() {
  if (!LB) return;
  const back = LB.back;
  LB.box.remove(); LB = null;
  if (back && back.isConnected && back.focus) back.focus();
}
function lightbox(list, index) {
  closeLightbox();
  const box = document.createElement('div');
  box.className = 'cfd-lightbox'; box.tabIndex = -1;
  box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', '图片查看');
  box.innerHTML = '<div class="lb-bar"><span class="lb-name"></span><span class="lb-count"></span><span class="lb-grow"></span>'
    + '<button type="button" class="mini" data-a="open">在检查器中打开</button><button type="button" class="mini" data-a="close">关闭</button></div>'
    + '<button type="button" class="gal-nav prev" data-a="prev" aria-label="上一张">&#8249;</button><img alt="" />'
    + '<button type="button" class="gal-nav next" data-a="next" aria-label="下一张">&#8250;</button>';
  const img = box.querySelector('img');
  const show = k => {
    LB.i = (k + list.length) % list.length;
    const x = list[LB.i];
    img.src = imgUrl(x); img.alt = baseName(x.path);
    box.querySelector('.lb-name').textContent = x.path;
    box.querySelector('.lb-count').textContent = list.length > 1 ? (LB.i + 1) + ' / ' + list.length : '';
  };
  LB = { box, i: index, show, back: document.activeElement };
  if (list.length < 2) box.querySelectorAll('.gal-nav').forEach(b => b.remove());
  box.onclick = e => {
    const hit = e.target.closest('[data-a]');
    const act = hit ? hit.dataset.a : (e.target === box ? 'close' : '');
    if (act === 'prev') show(LB.i - 1);
    else if (act === 'next') show(LB.i + 1);
    else if (act === 'close') closeLightbox();
    else if (act === 'open') { const p = list[LB.i].path; closeLightbox(); openArtifact(p); }
  };
  document.body.appendChild(box);
  show(index); box.focus();
}
window.addEventListener('keydown', e => {
  if (!LB) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') LB.show(LB.i - 1);
  else if (e.key === 'ArrowRight') LB.show(LB.i + 1);
  else return;
  e.preventDefault(); e.stopPropagation();
}, true);

window.CFDView = { pinTab, linkify, lightbox, codeCandidate, textCandidates, pollDisk };
})();
