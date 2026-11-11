// NullFlux frontend — 浮动面板 + 三维可视化 + 跨平台交互终端
const $ = (id) => document.getElementById(id);

// ====================== 本地存储 ======================
function readUIStorage(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
}
function writeUIStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
document.body.classList.add('workspace-layout');
// 浮层（技能库）：右上角关闭按钮，点击置前
let zCounter = 200;
function bringFront(panel) { zCounter++; panel.style.zIndex = zCounter; }
for (const panel of document.querySelectorAll('.panel[data-pid="skills"], .panel[data-pid="fileview"]')) {
  const closeButton = document.createElement('button');
  closeButton.className = 'mini panel-close'; closeButton.textContent = '×'; closeButton.title = '关闭';
  closeButton.setAttribute('aria-label', '关闭' + (panel.querySelector('.ptitle')?.textContent.trim() || ''));
  closeButton.onclick = () => setPanelVisible(panel.dataset.pid, false);
  panel.querySelector('.panel-head').append(closeButton);
  panel.addEventListener('mousedown', () => bringFront(panel));
}

// ====================== 检查器：对话 / 运行 / 结果 / 文件，运行与结果下分子视图 ======================
const PANELS_KEY = 'nullflux.inspector.v3';
// pid → { label, ctx }：ctx 是所属标签；没有 ctx 的是浮层（技能库）
const PANEL_META = {
  chat:            { label: '对话' },
  live:            { label: '作业',       ctx: 'status' },
  todos:           { label: '计划',       ctx: 'status' },
  'solver-monitor':{ label: '求解器',     ctx: 'status' },
  design:          { label: '设计',       ctx: 'optimize' },
  terminal:        { label: '终端',       ctx: 'terminal' },
  editor:          { label: '产物',       ctx: 'results' },
  fileview:        { label: '文件查看器' },                  // B1: 独立浮动文件查看器
  slice:           { label: '切片',       ctx: 'post' },
  geometry:        { label: '几何',       ctx: 'post' },
  files:           { label: '文件',       ctx: 'files' },
  skills:          { label: '技能库' },
};
const CONTEXT_OWNER = Object.fromEntries(Object.entries(PANEL_META).filter(([, m]) => m.ctx).map(([pid, m]) => [pid, m.ctx]));
const CONTEXT_PANELS = {};
for (const [pid, ctx] of Object.entries(CONTEXT_OWNER)) (CONTEXT_PANELS[ctx] ||= []).push(pid);
const DEFAULT_SUB = { status: 'live', results: 'editor', files: 'files', terminal: 'terminal', optimize: 'design', post: 'slice' };
const uiState = Object.assign({ context: 'status' }, readUIStorage(PANELS_KEY, {}));
uiState.sub = Object.assign({}, DEFAULT_SUB, uiState.sub || {});
let contextView = CONTEXT_PANELS[uiState.context] ? uiState.context : 'status';
const panelVis = {};                 // 浮层开关，不持久化
const SUB_BADGE = new Set();         // 有新内容但没看过的子视图
const SUBVIEW_HOOKS = {};            // pid → 子视图露出时调用（懒加载 iframe、刷新作业）
const panelEl = pid => document.querySelector(`.panel[data-pid="${pid}"]`);
function currentSub(view) {
  const pids = CONTEXT_PANELS[view] || [];
  return pids.includes(uiState.sub[view]) ? uiState.sub[view] : pids[0];
}
function selectContext(view) {
  if (!CONTEXT_PANELS[view]) return;
  contextView = view; uiState.context = view; writeUIStorage(PANELS_KEY, uiState);
  $('desktop').dataset.context = view;
  document.querySelectorAll('[data-context-view]').forEach(button => {
    const selected = button.dataset.contextView === view;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected) button.removeAttribute('data-badge');
  });
  const sub = currentSub(view);
  SUB_BADGE.delete(sub);
  for (const [pid, owner] of Object.entries(CONTEXT_OWNER)) panelEl(pid)?.classList.toggle('context-inactive', owner !== view || pid !== sub);
  renderSubnav();
  try { SUBVIEW_HOOKS[sub]?.(); } catch (e) { console.warn(e); }
  window.dispatchEvent(new Event('resize'));
}
function selectSub(pid) {
  const ctx = CONTEXT_OWNER[pid]; if (!ctx) return;
  uiState.sub[ctx] = pid; selectContext(ctx);
}
function renderSubnav() {
  const nav = $('ctx-sub'); if (!nav) return;
  const pids = CONTEXT_PANELS[contextView] || [];
  nav.hidden = pids.length < 2;
  nav.innerHTML = '';
  const sub = currentSub(contextView);
  for (const pid of pids) {
    const b = document.createElement('button'); b.type = 'button'; b.dataset.sub = pid;
    b.textContent = PANEL_META[pid].label; b.setAttribute('aria-pressed', String(pid === sub));
    if (SUB_BADGE.has(pid)) b.dataset.badge = '';
    b.onclick = () => selectSub(pid);
    nav.appendChild(b);
  }
}
// 子视图有新内容：标签和子视图按钮上打点
function markSubActivity(pid) {
  if (isPanelVisible(pid) && typeof shellState !== 'undefined' && shellState.inspector) return;
  SUB_BADGE.add(pid);
  if (typeof markContextActivity === 'function') markContextActivity(CONTEXT_OWNER[pid]);
  if (CONTEXT_OWNER[pid] === contextView) renderSubnav();
}
document.querySelectorAll('[data-context-view]').forEach(button => {
  button.onclick = () => {
    const view = button.dataset.contextView;
    // 手机底部标签栏：「对话」收起检查器，其他标签展开对应检查器页
    if (view === 'chat') { toggleInspector(false); return; }
    if (matchMedia('(max-width: 760px)').matches) toggleInspector(true);
    selectContext(view);
  };
  button.onkeydown = event => {
    const buttons = [...document.querySelectorAll('[data-context-view]')].filter(b => b.offsetParent !== null);
    const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!offset) return;
    event.preventDefault();
    const next = buttons[(buttons.indexOf(button) + offset + buttons.length) % buttons.length];
    next.click(); next.focus();
  };
});

function isPanelVisible(pid) {
  if (CONTEXT_OWNER[pid]) return contextView === CONTEXT_OWNER[pid] && currentSub(contextView) === pid;
  return pid === 'chat' || !!panelVis[pid];
}
function setPanelVisible(pid, on) {
  const el = panelEl(pid);
  if (CONTEXT_OWNER[pid]) {
    if (on) { selectSub(pid); if (typeof revealInspector === 'function') revealInspector(); }
  } else if (pid !== 'chat') {
    panelVis[pid] = !!on;
    if (el) { el.style.display = on ? '' : 'none'; if (on) bringFront(el); }
  }
  if (on && pid === 'editor' && editor) setTimeout(() => editor.layout(), 50);
}
for (const [pid] of Object.entries(PANEL_META)) {
  const el = panelEl(pid); if (!el) continue;
  el.classList.toggle('insp-panel', !!CONTEXT_OWNER[pid]);
  el.style.display = (CONTEXT_OWNER[pid] || pid === 'chat') ? '' : 'none';
}
selectContext(contextView);

document.querySelector('.file-menu').addEventListener('click', event => {
  if (event.target.closest('button')) document.querySelector('.file-menu').open = false;
});
document.addEventListener('click', event => {
  if (!event.target.closest('.file-menu')) document.querySelector('.file-menu').open = false;
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const fileMenu = document.querySelector('.file-menu');
  if (fileMenu.open) { fileMenu.open = false; fileMenu.querySelector('summary').focus(); }
});

// ====================== Monaco 编辑器 ======================
let editor = null, diffEditor = null, monacoReady;
const tabs = new Map();
let activeTab = null;

monacoReady = new Promise((resolve) => {
  require.config({ paths: { 'vs': 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' } });
  require(['vs/editor/editor.main'], () => { ensureEditor(); resolve(); });
});
function ensureEditor() {
  if (editor) return;
  const el = document.getElementById('editor-host');
  editor = monaco.editor.create(el, { value: '', language: 'plaintext', theme: 'vs', automaticLayout: true, fontSize: 13, minimap: { enabled: false }, wordWrap: 'on', scrollBeyondLastLine: false });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveActive());
  editor.onDidChangeModelContent(() => {
    if (!activeTab) return;
    const t = tabs.get(activeTab); if (!t) return;
    const cur = t.model.getValue();
    const dirty = cur !== t.originalContent;
    if (t.dirty !== dirty) { t.dirty = dirty; renderTabs(); $('save-file').disabled = !dirty; }
    // 防抖保存草稿到 localStorage
    clearTimeout(t._draftTimer);
    t._draftTimer = setTimeout(() => saveDraft(activeTab, cur, t.originalContent), 400);
  });
}
function showView(which) {
  if (which !== 'empty') setPanelVisible('fileview', true); // B1: 独立文件查看器浮动面板
  // which: 'editor' | 'image' | 'stl' | 'vtu' | 'pdf' | 'slice' | 'geometry' | 'empty'
  document.getElementById('editor-host').style.display = which === 'editor' ? '' : 'none';
  const imgHost = document.getElementById('img-host'); if (imgHost) imgHost.style.display = which === 'image' ? '' : 'none';
  const stlHost = document.getElementById('stl-host'); if (stlHost) stlHost.style.display = which === 'stl' ? '' : 'none';
  const vtuHost = document.getElementById('vtu-host'); if (vtuHost) vtuHost.style.display = which === 'vtu' ? '' : 'none';
  const pdfHost = document.getElementById('pdf-host'); if (pdfHost) pdfHost.style.display = which === 'pdf' ? '' : 'none';
  document.getElementById('editor-empty').style.display = which === 'empty' ? '' : 'none';
  if (which === 'editor' && editor) setTimeout(() => editor.layout(), 0);
  if (which === 'stl' && window.__stlResize) window.__stlResize();
  if (which === 'vtu' && window.__vtuResize) window.__vtuResize();
}
function setEditorEmpty() { showView('empty'); }
setEditorEmpty();

const detectLang = p => ({ js:'javascript', ts:'typescript', jsx:'javascript', tsx:'typescript', py:'python', json:'json', md:'markdown', html:'html', css:'css', java:'java', c:'c', cpp:'cpp', h:'cpp', cs:'csharp', go:'go', rs:'rust', sh:'shell', yml:'yaml', yaml:'yaml', xml:'xml', sql:'sql' }[p.split('.').pop().toLowerCase()] || 'plaintext');

async function openFile(p) {
  // 图片预览
  if (p && /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i.test(p)) return openImage(p);
  // STL 三维预览
  if (p && /\.stl$/i.test(p)) return openSTL(p);
  // VTK / VTU / VTP / VTI 科学可视化（vtk.js）
  if (p && /\.(vtu|vtp|vti|vtk|pvd)$/i.test(p)) return openVTU(p);
  // PDF 预览（浏览器原生）
  if (p && /\.pdf$/i.test(p)) return openPDF(p);
  await monacoReady; ensureEditor();
  // 切走前保存当前 tab 的 viewState
  if (activeTab && tabs.has(activeTab) && editor.getModel() === tabs.get(activeTab).model) {
    tabs.get(activeTab).viewState = editor.saveViewState();
  }
  let tab = tabs.get(p);
  if (!tab) {
    let r, j;
    try { r = await fetch('/api/file?path=' + encodeURIComponent(p)); j = await r.json(); }
    catch (e) { addSystem('打开失败（网络）：' + e.message); return; }
    if (j.error) { addSystem('打开失败：' + j.error); return; }
    if (j.binary) { addSystem(`二进制文件不能预览：${p}（${j.size} 字节）`); return; }
    const diskContent = j.content || '';
    // 检查 localStorage 中是否有未保存草稿
    const draft = loadDraft(p);
    let content = diskContent, dirty = false;
    if (draft && draft.diskContent === diskContent && draft.value !== diskContent) {
      // 磁盘未变，且草稿不同 → 恢复草稿
      content = draft.value; dirty = true;
      addTerm(`[草稿] 恢复 ${p} 未保存编辑`, 'sys');
    }
    tab = { model: monaco.editor.createModel(content, detectLang(p)), originalContent: diskContent, dirty, viewState: null, mtime: j.mtime, truncated: !!j.truncated };
    tabs.set(p, tab);
    if (j.truncated) addTerm(`[只读] ${p} 超过 2 MB，仅预览前段，不能保存（避免截断原文件）`, 'sys');
  }
  activeTab = p; editor.setModel(tab.model);
  editor.updateOptions({ readOnly: !!tab.truncated });
  if (tab.viewState) editor.restoreViewState(tab.viewState);
  editor.focus();
  $('save-file').disabled = !tab.dirty;
  showView('editor');
  renderTabs(); updateActiveFileChip();
  document.querySelectorAll('.tree-node.selected').forEach(n => n.classList.remove('selected'));
  const n = document.querySelector(`.tree-node[data-path="${CSS.escape(p)}"]`); if (n) n.classList.add('selected');
}

// ===================== 图片 / PDF 预览（对标 OpenChamber：上一张/下一张、←/→ 键、序号） =====================
const GALLERY = { list: [], dir: null, cur: null };
const PREVIEW_RE = /\.(png|jpe?g|gif|webp|bmp|svg|pdf)$/i;
const rawUrl = p => '/api/file?path=' + encodeURIComponent(p) + '&raw=1&_t=' + Date.now();
async function galleryFor(p) {
  const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
  if (GALLERY.dir !== dir || !GALLERY.list.includes(p)) {
    try { const j = await (await fetch('/api/siblings?path=' + encodeURIComponent(p))).json(); GALLERY.list = j.files || []; }
    catch { GALLERY.list = []; }
    if (!GALLERY.list.includes(p)) GALLERY.list.push(p);
    GALLERY.dir = dir;
  }
  GALLERY.cur = p;
  return GALLERY.list;
}
function galleryStep(d) {
  const L = GALLERY.list, i = L.indexOf(GALLERY.cur);
  if (L.length < 2 || i < 0) return;
  const next = L[(i + d + L.length) % L.length];
  const prev = GALLERY.cur;
  // 图集浏览不堆标签：上一张的占位 tab 换成这一张
  const t = tabs.get(prev); if (t && !t.model && !t.dirty && t.galleryTab) tabs.delete(prev);
  openFile(next);
}
function previewToolbar(p, extra) {
  const bar = document.createElement('div'); bar.className = 'viewer-toolbar static img-meta';
  bar.innerHTML = '<span class="viewer-title"></span><span class="img-dims muted small"></span><span style="flex:1;"></span>' + extra;
  const title = bar.querySelector('.viewer-title'); title.textContent = p.split('/').pop(); title.title = p;
  return bar;
}
function attachGalleryNav(host, p) {
  const L = GALLERY.list, i = L.indexOf(p);
  if (L.length < 2) return;
  const name = q => q.split('/').pop();
  const mk = (cls, d, label) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'gal-nav ' + cls;
    const q = L[(i + d + L.length) % L.length];
    b.title = label + '：' + name(q); b.setAttribute('aria-label', b.title);
    b.innerHTML = d < 0 ? '&#8249;' : '&#8250;';
    b.onclick = e => { e.stopPropagation(); galleryStep(d); };
    return b;
  };
  host.append(mk('prev', -1, '上一张'), mk('next', 1, '下一张'));
  const cnt = host.querySelector('.img-dims');
  const idx = document.createElement('span'); idx.className = 'gal-count muted small'; idx.textContent = (i + 1) + ' / ' + L.length;
  cnt?.before(idx);
}
function markPreviewTab(p, kind) {
  activeTab = p;
  if (!tabs.has(p)) tabs.set(p, { [kind]: true, model: null, dirty: false, originalContent: '', galleryTab: true });
  renderTabs(); updateActiveFileChip();
  document.querySelectorAll('.tree-node.selected').forEach(n => n.classList.remove('selected'));
  const tn = document.querySelector('.tree-node[data-path="' + CSS.escape(p) + '"]'); if (tn) tn.classList.add('selected');
}
const askInput = text => { const inp = $('input'); inp.value = (inp.value ? inp.value + '\n' : '') + text; inp.focus(); };

async function openImage(p) {
  const host = document.getElementById('img-host');
  if (!host) return;
  await galleryFor(p);
  host.innerHTML = '';
  host.classList.remove('zoomed');
  const url = rawUrl(p);
  const img = document.createElement('img');
  img.src = url; img.alt = p;
  img.title = '点击在适应窗口 / 原始尺寸之间切换';
  img.onclick = () => host.classList.toggle('zoomed');
  img.onerror = () => { wrap.innerHTML = ''; const d = document.createElement('div'); d.className = 'muted small'; d.style.padding = '24px'; d.textContent = '无法加载图片：' + p; wrap.appendChild(d); };
  img.onload = () => { const m = host.querySelector('.img-dims'); if (m) m.textContent = img.naturalWidth + ' × ' + img.naturalHeight; };
  const wrap = document.createElement('div'); wrap.className = 'img-wrap';
  const meta = previewToolbar(p, '<button class="mini" type="button" data-act="ask">让智能体看图</button><button class="mini" type="button" data-act="open">新标签打开</button>');
  meta.querySelector('[data-act="open"]').onclick = () => window.open(url, '_blank', 'noopener');
  meta.querySelector('[data-act="ask"]').onclick = () => askInput('请用 vision_analyze 看 ' + p + '，指出关键结论和异常。');
  wrap.appendChild(img);
  host.append(meta, wrap);
  attachGalleryNav(host, p);
  showView('image');
  markPreviewTab(p, 'image');
}

async function openPDF(p) {
  const host = document.getElementById('pdf-host');
  if (!host) return;
  await galleryFor(p);
  host.innerHTML = '';
  const url = rawUrl(p);
  const bar = previewToolbar(p, '<button class="mini" type="button" data-act="open">新标签打开</button><button class="mini" type="button" data-act="read">让智能体阅读</button>');
  const iframe = document.createElement('iframe');
  iframe.src = url; iframe.className = 'pdf-frame'; iframe.title = p;
  const wrap = document.createElement('div'); wrap.className = 'pdf-wrap';
  wrap.append(bar, iframe);
  host.appendChild(wrap);
  // iframe 不触发 onerror：先 HEAD 探测，失败时给出可读提示
  fetch(url, { method: 'HEAD' }).then(r => { if (!r.ok) iframe.replaceWith(Object.assign(document.createElement('div'), { className: 'muted small', style: 'padding:24px', textContent: '无法加载 PDF（HTTP ' + r.status + '）：' + p })); }).catch(() => {});
  bar.querySelector('[data-act="open"]').onclick = () => window.open(url, '_blank', 'noopener');
  bar.querySelector('[data-act="read"]').onclick = () => askInput('请调用 read_document("' + p + '") 提取这份 PDF 的文本与图片。');
  attachGalleryNav(host, p);
  showView('pdf');
  markPreviewTab(p, 'pdf');
}
// ←/→ 在图集里翻页（焦点不在输入框/编辑器时）
document.addEventListener('keydown', e => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (!panelVis?.fileview || !GALLERY.cur || activeTab !== GALLERY.cur) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable="true"], .monaco-editor, [role="tablist"], [data-context-view]')) return;
  const imgOn = $('img-host')?.style.display !== 'none', pdfOn = $('pdf-host')?.style.display !== 'none';
  if (!imgOn && !pdfOn) return;
  e.preventDefault(); galleryStep(e.key === 'ArrowLeft' ? -1 : 1);
});

// ===================== STL 三维预览（懒加载 three.js） =====================
const STL_VIEW = { renderer: null, scene: null, camera: null, mesh: null, raf: 0, controls: null };
// 把 STLLoader / OrbitControls 里的 `from 'three'` / `from 'three/...'` 改写成完整 URL，避免依赖 importmap
async function _importThreeAddon(url, threeUrl) {
  const src = await (await fetch(url)).text();
  const patched = src
    .replace(/from\s+['"]three['"]/g, `from '${threeUrl}'`)
    .replace(/from\s+['"]three\/([^'"]+)['"]/g, (_, p) => `from 'https://cdn.jsdelivr.net/npm/three@0.160.0/${p}'`);
  const blob = new Blob([patched], { type: 'text/javascript' });
  const blobUrl = URL.createObjectURL(blob);
  try { return await import(blobUrl); }
  finally { setTimeout(() => URL.revokeObjectURL(blobUrl), 30000); }
}
async function ensureThree() {
  if (window.THREE && window.THREE.STLLoader) return window.THREE;
  // 优先本地 vendored 副本（离线可用），失败再回退 jsdelivr CDN；blob 模块里只能解析绝对 URL
  const local = p => new URL(p, location.href).href;
  const SOURCES = [
    { three: local('/vendor/three/three.module.js'), stl: local('/vendor/three/loaders/STLLoader.js'), ctrl: local('/vendor/three/controls/OrbitControls.js'), tag: '本地 vendor' },
    { three: 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js', stl: 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/STLLoader.js', ctrl: 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js', tag: 'jsdelivr CDN' },
  ];
  let lastErr;
  for (const src of SOURCES) {
    try {
      const mod = await import(src.three);
      const stlMod = await _importThreeAddon(src.stl, src.three);
      const ctrlMod = await _importThreeAddon(src.ctrl, src.three);
      // ESM namespace 对象是 frozen 的，不能直接挂属性，先拷成普通对象
      const THREE = { ...mod };
      THREE.STLLoader = stlMod.STLLoader;
      THREE.OrbitControls = ctrlMod.OrbitControls;
      console.log('[STL] three.js 从', src.tag, '加载成功 · keys =', Object.keys(THREE).length, 'STLLoader =', typeof THREE.STLLoader, 'OrbitControls =', typeof THREE.OrbitControls);
      window.THREE = THREE;
      return THREE;
    } catch (e) { lastErr = e; console.warn('[STL] 从', src.tag, '加载失败:', e.message); }
  }
  throw new Error('three.js 加载失败（本地 vendor 与 CDN 均不可用）：' + (lastErr && lastErr.message || ''));
}
async function openSTL(p) {
  const host = document.getElementById('stl-host');
  if (!host) return;
  host.innerHTML = '<div class="muted small" style="padding:18px;">加载 STL 中…</div>';
  showView('stl');
  activeTab = p;
  if (!tabs.has(p)) tabs.set(p, { stl: true, model: null, dirty: false, originalContent: '' });
  renderTabs(); updateActiveFileChip();
  document.querySelectorAll('.tree-node.selected').forEach(n => n.classList.remove('selected'));
  const tn = document.querySelector(`.tree-node[data-path="${CSS.escape(p)}"]`); if (tn) tn.classList.add('selected');
  let THREE;
  try { THREE = await ensureThree(); } catch (e) { host.innerHTML = `<div class="muted small" style="padding:18px;color:#f88;">three.js 加载失败：${e.message}</div>`; return; }
  let buf;
  try {
    const r = await fetch('/api/file?path=' + encodeURIComponent(p) + '&raw=1');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    buf = await r.arrayBuffer();
  } catch (e) { host.innerHTML = `<div class="muted small" style="padding:18px;color:#f88;">读取失败：${e.message}</div>`; return; }
  console.log('[STL] buf bytes =', buf && buf.byteLength);
  try {
  // 清空旧场景
  if (STL_VIEW.raf) cancelAnimationFrame(STL_VIEW.raf);
  if (STL_VIEW.renderer) { STL_VIEW.renderer.dispose(); }
  host.innerHTML = '';
  const w = host.clientWidth || 600, h = host.clientHeight || 400;
  console.log('[STL] host size', w, h);
  const scene = new THREE.Scene(); const _dk = document.documentElement.dataset.theme === 'dark'; scene.background = new THREE.Color(_dk ? 0x16171b : 0xf4f4f5);
  const camera = new THREE.PerspectiveCamera(45, w/h, 0.01, 100000);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(w, h);
  host.appendChild(renderer.domElement);
  // 模型
  const geom = new THREE.STLLoader().parse(buf);
  console.log('[STL] parsed triangles =', (geom.attributes.position.count/3)|0);
  geom.computeBoundingBox(); geom.computeVertexNormals();
  const bb = geom.boundingBox; const c = new THREE.Vector3(); bb.getCenter(c);
  geom.translate(-c.x, -c.y, -c.z);
  const sz = new THREE.Vector3(); bb.getSize(sz);
  const maxD = Math.max(sz.x, sz.y, sz.z) || 1;
  const mat = new THREE.MeshPhongMaterial({ color: 0xb8bcc4, specular: 0x333333, shininess: 40, flatShading: false });
  const mesh = new THREE.Mesh(geom, mat); scene.add(mesh);
  // 网格线（线框，极淡）
  const wire = new THREE.LineSegments(new THREE.WireframeGeometry(geom), new THREE.LineBasicMaterial({ color: 0x111111, transparent:true, opacity:0.07 }));
  scene.add(wire);
  // 灯光
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const dl = new THREE.DirectionalLight(0xffffff, 0.9); dl.position.set(1,1,1).multiplyScalar(maxD*3); scene.add(dl);
  const dl2 = new THREE.DirectionalLight(0xffffff, 0.4); dl2.position.set(-1,-0.5,-1).multiplyScalar(maxD*3); scene.add(dl2);
  // 坐标轴 + 网格
  scene.add(new THREE.AxesHelper(maxD * 0.7));
  const grid = new THREE.GridHelper(maxD * 4, 20, _dk ? 0x3a3d46 : 0xc8c8cc, _dk ? 0x25272e : 0xe2e2e6); grid.position.y = -sz.y/2 - maxD*0.02; scene.add(grid);
  // 相机
  camera.position.set(maxD*1.6, maxD*1.6, maxD*1.6);
  camera.lookAt(0,0,0);
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  STL_VIEW.scene = scene; STL_VIEW.camera = camera; STL_VIEW.renderer = renderer; STL_VIEW.mesh = mesh; STL_VIEW.controls = controls;
  function loop() { STL_VIEW.raf = requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); }
  loop();
  // 信息条
  const info = document.createElement('div');
  info.className = 'viewer-info';
  const tris = (geom.index ? geom.index.count : geom.attributes.position.count) / 3;
  info.textContent = `${p.split('/').pop()}  ·  ${Math.round(tris).toLocaleString()} 三角形  ·  ${sz.x.toPrecision(3)} × ${sz.y.toPrecision(3)} × ${sz.z.toPrecision(3)}  ·  拖拽旋转，滚轮缩放`;
  info.title = p;
  host.appendChild(info);
  window.__stlResize = () => {
    const nw = host.clientWidth, nh = host.clientHeight;
    if (nw && nh) { renderer.setSize(nw, nh); camera.aspect = nw/nh; camera.updateProjectionMatrix(); }
  };
  } catch (e) {
    console.error('[STL] render error', e);
    host.innerHTML = `<div class="muted small" style="padding:18px;color:#f88;white-space:pre-wrap;">STL 渲染错误：${e.message}\n${e.stack || ''}</div>`;
  }
}
window.addEventListener('resize', () => { if (window.__stlResize) window.__stlResize(); });

// ===================== VTU / VTP / VTI 科学可视化（懒加载 vtk.js） =====================
// 支持 .vtu / .vtp / .vti / .vtk / .pvd（pvd 只读第一个 timestep）
const VTU_VIEW = { fullScreenRenderer: null, renderer: null, renderWindow: null, actor: null, mapper: null, reader: null, lut: null, currentField: '', source: null, currentRep: 'Surface', currentSlice: null };
async function ensureVtkJs() {
  if (window.vtk) return window.vtk;
  // 用 ESM 直接 import vtk.js（注意：vtk.js 在浏览器里依赖 macroFactory + ESM 入口）
  const mod = await import('https://cdn.jsdelivr.net/npm/@kitware/vtk.js@30.7.0/+esm');
  window.vtk = mod.default || mod;
  return window.vtk;
}
async function openVTU(p) {
  const host = document.getElementById('vtu-host');
  if (!host) return;
  host.innerHTML = '<div class="muted small" style="padding:18px;">加载 vtk.js 中…（首次需要从 CDN 下 ~1MB）</div>';
  showView('vtu');
  activeTab = p;
  if (!tabs.has(p)) tabs.set(p, { vtu: true, model: null, dirty: false, originalContent: '' });
  renderTabs(); updateActiveFileChip();
  document.querySelectorAll('.tree-node.selected').forEach(n => n.classList.remove('selected'));
  const tn = document.querySelector(`.tree-node[data-path="${CSS.escape(p)}"]`); if (tn) tn.classList.add('selected');
  let vtkNs;
  try { vtkNs = await ensureVtkJs(); }
  catch (e) { host.innerHTML = `<div class="muted small" style="padding:18px;color:#f88;">vtk.js 加载失败：${e.message}<br/>如离线环境请联网或换 CDN。</div>`; return; }
  // 解析 .pvd → 找第一个 timestep 的 dataset 文件
  let dataPath = p;
  if (/\.pvd$/i.test(p)) {
    try {
      const r = await fetch('/api/file?path=' + encodeURIComponent(p));
      const j = await r.json(); const txt = j.content || '';
      const m = txt.match(/file=["']([^"']+)["']/);
      if (m) {
        const baseDir = p.split('/').slice(0, -1).join('/');
        dataPath = baseDir ? baseDir + '/' + m[1] : m[1];
        addSystem(`pvd → 首个 timestep: ${dataPath}`);
      }
    } catch (e) { /* ignore */ }
  }
  // 拉取二进制
  let buf;
  try {
    const r = await fetch('/api/file?path=' + encodeURIComponent(dataPath) + '&raw=1');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    buf = await r.arrayBuffer();
  } catch (e) { host.innerHTML = `<div class="muted small" style="padding:18px;color:#f88;">读取失败：${e.message}</div>`; return; }
  // 选 reader
  const ext = (dataPath.split('.').pop() || '').toLowerCase();
  let Reader, defaultRep = 'Surface';
  try {
    if (ext === 'vtu') Reader = (await import('https://cdn.jsdelivr.net/npm/@kitware/vtk.js@30.7.0/IO/XML/XMLUnstructuredGridReader/+esm')).default;
    else if (ext === 'vtp') Reader = (await import('https://cdn.jsdelivr.net/npm/@kitware/vtk.js@30.7.0/IO/XML/XMLPolyDataReader/+esm')).default;
    else if (ext === 'vti') Reader = (await import('https://cdn.jsdelivr.net/npm/@kitware/vtk.js@30.7.0/IO/XML/XMLImageDataReader/+esm')).default;
    else if (ext === 'vtk') Reader = (await import('https://cdn.jsdelivr.net/npm/@kitware/vtk.js@30.7.0/IO/Legacy/LegacyAsciiReader/+esm')).default;
    else throw new Error('不支持的扩展名：.' + ext);
  } catch (e) {
    host.innerHTML = `<div class="muted small" style="padding:18px;color:#f88;">加载 reader 失败：${e.message}</div>`; return;
  }
  const FullScreenRenderWindow = (await import('https://cdn.jsdelivr.net/npm/@kitware/vtk.js@30.7.0/Rendering/Misc/FullScreenRenderWindow/+esm')).default;
  const Mapper = (await import('https://cdn.jsdelivr.net/npm/@kitware/vtk.js@30.7.0/Rendering/Core/Mapper/+esm')).default;
  const Actor = (await import('https://cdn.jsdelivr.net/npm/@kitware/vtk.js@30.7.0/Rendering/Core/Actor/+esm')).default;
  const ColorTransferFunction = (await import('https://cdn.jsdelivr.net/npm/@kitware/vtk.js@30.7.0/Rendering/Core/ColorTransferFunction/+esm')).default;
  const ColorMaps = (await import('https://cdn.jsdelivr.net/npm/@kitware/vtk.js@30.7.0/Rendering/Core/ColorTransferFunction/ColorMaps/+esm')).default;

  // 清空旧实例
  if (VTU_VIEW.fullScreenRenderer) { try { VTU_VIEW.fullScreenRenderer.delete(); } catch {} }
  host.innerHTML = '';
  // 上方控件条
  const toolbar = document.createElement('div');
  toolbar.className = 'viewer-toolbar';
  toolbar.innerHTML = `
    <span class="viewer-title" title="${escapeHtml(dataPath)}">${escapeHtml(dataPath.split('/').pop())}</span>
    <span style="flex:1;"></span>
    <label>场 <select id="vtu-field"></select></label>
    <label>色图 <select id="vtu-cmap">
      <option value="Cool to Warm">CoolWarm</option>
      <option value="Rainbow Desaturated">Rainbow</option>
      <option value="Viridis (matplotlib)">Viridis</option>
      <option value="Plasma (matplotlib)">Plasma</option>
      <option value="Black-Body Radiation">BlackBody</option>
      <option value="Grayscale">Grayscale</option>
    </select></label>
    <label>表现 <select id="vtu-rep">
      <option value="Surface">Surface</option>
      <option value="Surface with edges">Surface+Edges</option>
      <option value="Wireframe">Wireframe</option>
      <option value="Points">Points</option>
    </select></label>
    <button class="mini" id="vtu-reset" title="重置视图">重置</button>
    <button class="mini" id="vtu-parallel" title="合并所有 processor*/VTK 分块（并行结果）" style="display:none;">合并并行</button>
  `;
  host.appendChild(toolbar);

  // 渲染窗
  const fsrw = FullScreenRenderWindow.newInstance({ rootContainer: host, background: [0.957, 0.957, 0.961] });
  const renderer = fsrw.getRenderer();
  const renderWindow = fsrw.getRenderWindow();
  const reader = Reader.newInstance();
  try { reader.parseAsArrayBuffer(buf); } catch (e) {
    // legacy reader 用 text
    try { const txt = new TextDecoder().decode(buf); reader.parseAsText(txt); } catch (e2) {
      host.innerHTML = `<div class="muted small" style="padding:18px;color:#f88;">解析失败：${e.message}</div>`; return;
    }
  }
  const source = reader.getOutputData(0);
  const mapper = Mapper.newInstance({ interpolateScalarsBeforeMapping: true });
  mapper.setInputData(source);
  const actor = Actor.newInstance(); actor.setMapper(mapper);
  // 调色板
  const lut = ColorTransferFunction.newInstance();
  const applyColormap = (name) => {
    const preset = ColorMaps.getPresetByName(name) || ColorMaps.getPresetByName('Cool to Warm');
    lut.removeAllPoints(); lut.applyColorMap(preset);
    mapper.setLookupTable(lut);
  };
  applyColormap('Cool to Warm');
  mapper.setScalarVisibility(true);
  renderer.addActor(actor);

  // 收集可用场（point/cell data）
  const fields = [];
  try {
    const pd = source.getPointData(); const cd = source.getCellData();
    for (let i = 0; i < pd.getNumberOfArrays(); i++) fields.push({ name: pd.getArrayByIndex(i).getName(), loc: 'point' });
    for (let i = 0; i < cd.getNumberOfArrays(); i++) fields.push({ name: cd.getArrayByIndex(i).getName(), loc: 'cell' });
  } catch {}
  const sel = toolbar.querySelector('#vtu-field');
  sel.innerHTML = '<option value="">(单色)</option>' + fields.map(f => `<option value="${f.loc}::${f.name}">${f.name} (${f.loc})</option>`).join('');
  const applyField = (val) => {
    if (!val) { mapper.setScalarVisibility(false); renderWindow.render(); return; }
    const [loc, name] = val.split('::');
    try {
      const arr = (loc === 'point' ? source.getPointData() : source.getCellData()).getArrayByName(name);
      if (!arr) return;
      const [lo, hi] = arr.getRange();
      lut.setMappingRange(lo, hi); lut.updateRange();
      mapper.setScalarModeToUsePointFieldData ? null : null;
      if (loc === 'point') { source.getPointData().setActiveScalars(name); mapper.setScalarModeToUsePointFieldData(); }
      else { source.getCellData().setActiveScalars(name); mapper.setScalarModeToUseCellFieldData(); }
      mapper.setColorByArrayName(name);
      mapper.setScalarVisibility(true);
      renderWindow.render();
    } catch (e) { addSystem('场切换失败：' + e.message); }
  };
  sel.onchange = () => applyField(sel.value);
  // 默认选第一个 vector / scalar
  if (fields.length) { sel.value = `${fields[0].loc}::${fields[0].name}`; applyField(sel.value); }

  toolbar.querySelector('#vtu-cmap').onchange = (e) => { applyColormap(e.target.value); renderWindow.render(); };
  toolbar.querySelector('#vtu-rep').onchange = (e) => {
    const v = e.target.value;
    const prop = actor.getProperty();
    if (v === 'Surface') { prop.setRepresentation(2); prop.setEdgeVisibility(false); }
    else if (v === 'Surface with edges') { prop.setRepresentation(2); prop.setEdgeVisibility(true); prop.setEdgeColor(0.4, 0.3, 0.7); }
    else if (v === 'Wireframe') { prop.setRepresentation(1); prop.setEdgeVisibility(false); }
    else if (v === 'Points') { prop.setRepresentation(0); prop.setPointSize(2); }
    renderWindow.render();
  };
  toolbar.querySelector('#vtu-reset').onclick = () => { renderer.resetCamera(); renderWindow.render(); };

  // —— 并行（processorN/VTK/…） 合并按钮 ——
  const parallelBtn = toolbar.querySelector('#vtu-parallel');
  const procMatch = dataPath.match(/^(.*?)\/processor(\d+)\/VTK\/(.+?)_(\d+)\.vtu$/i);
  if (procMatch && parallelBtn) {
    parallelBtn.style.display = '';
    parallelBtn.onclick = async () => {
      try {
        parallelBtn.textContent = '加载分块中…';
        parallelBtn.disabled = true;
        const [, caseDir, , base, tsIdx] = procMatch;
        const flat = await (await fetch('/api/flat')).json();
        const pat = new RegExp(`^${caseDir.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&')}/processor\\d+/VTK/${base.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&')}_${tsIdx}\\.vtu$`);
        const parts = (flat.files || []).map(f => f.path || f).filter(p => pat.test(p));
        if (!parts.length) { addSystem('未找到并行分块'); parallelBtn.textContent = '合并并行'; parallelBtn.disabled = false; return; }
        addSystem(`合并 ${parts.length} 个 processor 分块…`);
        // 拉所有分块，给每个建独立 actor，共享 lut + colorByArrayName
        const ReaderU = (await import('https://cdn.jsdelivr.net/npm/@kitware/vtk.js@30.7.0/IO/XML/XMLUnstructuredGridReader/+esm')).default;
        // 先移除原 actor
        renderer.removeActor(actor);
        const partActors = [];
        for (const pp of parts) {
          const r2 = await fetch('/api/file?raw=1&path=' + encodeURIComponent(pp));
          if (!r2.ok) continue;
          const b2 = await r2.arrayBuffer();
          const rd = ReaderU.newInstance();
          rd.parseAsArrayBuffer(b2);
          const src2 = rd.getOutputData(0);
          const map2 = Mapper.newInstance({ interpolateScalarsBeforeMapping: true });
          map2.setInputData(src2);
          map2.setLookupTable(lut);
          map2.setScalarVisibility(mapper.getScalarVisibility());
          const sa = mapper.getColorByArrayName ? mapper.getColorByArrayName() : null;
          if (sa) { map2.setColorByArrayName(sa); map2.setScalarModeToUsePointFieldData(); }
          const ac = Actor.newInstance(); ac.setMapper(map2);
          renderer.addActor(ac);
          partActors.push({ ac, map2, src2 });
        }
        renderer.resetCamera();
        renderWindow.render();
        addSystem(`并行合并完成：${partActors.length} 块`);
        parallelBtn.textContent = `已合并 ${partActors.length} 块`;
        // 重写场切换：作用到所有 actor
        const oldOnChange = sel.onchange;
        sel.onchange = () => {
          const v = sel.value;
          if (!v) { partActors.forEach(p => p.map2.setScalarVisibility(false)); renderWindow.render(); return; }
          const [loc, name] = v.split('::');
          partActors.forEach(p => {
            try {
              const arr = (loc === 'point' ? p.src2.getPointData() : p.src2.getCellData()).getArrayByName(name);
              if (!arr) return;
              if (loc === 'point') { p.src2.getPointData().setActiveScalars(name); p.map2.setScalarModeToUsePointFieldData(); }
              else { p.src2.getCellData().setActiveScalars(name); p.map2.setScalarModeToUseCellFieldData(); }
              p.map2.setColorByArrayName(name);
              p.map2.setScalarVisibility(true);
            } catch {}
          });
          // 用第一块的范围设 LUT
          try {
            const arr0 = (loc === 'point' ? partActors[0].src2.getPointData() : partActors[0].src2.getCellData()).getArrayByName(name);
            if (arr0) { const [lo, hi] = arr0.getRange(); lut.setMappingRange(lo, hi); lut.updateRange(); }
          } catch {}
          renderWindow.render();
        };
        if (sel.value) sel.onchange();
      } catch (e) {
        addSystem('并行合并失败：' + e.message);
        parallelBtn.disabled = false; parallelBtn.textContent = '合并并行';
      }
    };
  }

  renderer.resetCamera();
  renderWindow.render();

  // 信息条
  const info = document.createElement('div');
  info.className = 'viewer-info bottom';
  let nPts = 0, nCells = 0;
  try { nPts = source.getNumberOfPoints(); nCells = source.getNumberOfCells(); } catch {}
  info.textContent = `点 ${nPts.toLocaleString()} · 单元 ${nCells.toLocaleString()} · 场 ${fields.length} · 鼠标拖拽旋转 / 滚轮缩放 / 右键平移`;
  host.appendChild(info);

  VTU_VIEW.fullScreenRenderer = fsrw;
  VTU_VIEW.renderer = renderer; VTU_VIEW.renderWindow = renderWindow;
  VTU_VIEW.mapper = mapper; VTU_VIEW.actor = actor; VTU_VIEW.lut = lut; VTU_VIEW.reader = reader; VTU_VIEW.source = source;

  window.__vtuResize = () => {
    try { fsrw.resize(); } catch {}
  };
}
window.addEventListener('resize', () => { if (window.__vtuResize) window.__vtuResize(); });

function reloadOpenFile(p) {
  const t = tabs.get(p); if (!t) return;
  if (t.dirty) return; // 脉守未保存草稿
  fetch('/api/file?path=' + encodeURIComponent(p)).then(r => r.json()).then(j => {
    if (typeof j.content !== 'string') return;
    if (j.content === t.originalContent) return;
    t.model.setValue(j.content); t.originalContent = j.content; t.dirty = false;
    if (activeTab === p) $('save-file').disabled = true; renderTabs();
  }).catch(()=>{});
}

// 草稿持久化 (localStorage)
const DRAFT_KEY = 'codemax.drafts.v1';
function loadAllDrafts() { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}'); } catch { return {}; } }
function loadDraft(p) { return loadAllDrafts()[p] || null; }
function saveDraft(p, value, diskContent) {
  const all = loadAllDrafts();
  if (value === diskContent) delete all[p];
  else all[p] = { value, diskContent, ts: Date.now() };
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(all)); } catch {}
}
function clearDraft(p) { const all = loadAllDrafts(); delete all[p]; try { localStorage.setItem(DRAFT_KEY, JSON.stringify(all)); } catch {} }
function closeTab(p) {
  const t = tabs.get(p); if (!t) return;
  if (t.dirty && !confirm(`${p} 未保存，关闭？（草稿将保留在本地缓存）`)) return;
  t.model?.dispose?.(); tabs.delete(p);
  if (activeTab === p) {
    const r = [...tabs.keys()];
    if (r.length) openFile(r[r.length-1]);
    else { activeTab = null; setEditorEmpty(); $('save-file').disabled = true; renderTabs(); updateActiveFileChip(); }
  } else renderTabs();
}
function renderTabs() {
  const tabsEl = $('tabs'); tabsEl.innerHTML = '';
  for (const [p, t] of tabs) {
    const div = document.createElement('div');
    div.className = 'tab' + (p === activeTab ? ' active' : '') + (t.dirty ? ' dirty' : '');
    div.innerHTML = `<span class="name"></span><span class="x">×</span>`;
    div.querySelector('.name').textContent = p.split('/').pop();
    div.title = p;
    div.onclick = (e) => { if (e.target.classList.contains('x')) return closeTab(p); openFile(p); };
    div.querySelector('.x').onclick = (e) => { e.stopPropagation(); closeTab(p); };
    tabsEl.appendChild(div);
  }
}
async function saveActive(force) {
  if (!activeTab) return; const t = tabs.get(activeTab); if (!t || !t.dirty || !t.model) return;
  if (t.truncated) { addSystem('这个文件只加载了前 2 MB，保存会截断原文件，已拒绝。'); return; }
  const p = activeTab, content = t.model.getValue();
  let r, j;
  try {
    r = await fetch('/api/file', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: p, content, mtime: t.mtime, force: !!force }) });
    j = await r.json();
  } catch (e) { addSystem('保存失败（网络）：' + e.message + '；编辑内容已保留在本地草稿'); saveDraft(p, content, t.originalContent); return; }
  if (j.conflict) {
    if (confirm(`${p} 在你打开后已被修改（可能是智能体或求解器写的）。\n确定：用你的版本覆盖\n取消：保留磁盘版本，你的编辑留在草稿里`)) return saveActive(true);
    saveDraft(p, content, t.originalContent); return;
  }
  if (j.ok) { t.originalContent = content; t.dirty = false; t.mtime = j.mtime; $('save-file').disabled = true; renderTabs(); clearDraft(p); addTerm(`[已保存 ${p}（${j.bytes}B）]`, 'sys'); }
  else addSystem('保存失败：' + (j.error || '未知错误'));
}
$('save-file').onclick = () => saveActive();

function updateActiveFileChip() {
  if (activeTab) { $('active-file-chip').style.display = ''; $('active-file-name').textContent = activeTab; }
  else { $('active-file-chip').style.display = 'none'; $('active-file-toggle').checked = false; }
}

// ====================== WS 与状态 ======================
let ws, currentAssistantBubble = null, currentReasoningBubble = null;
const toolEls = new Map();
let attachments = [];
let allFiles = [];
let platform = 'win32';

// v0.9 连接状态指示 + 指数退避重连
function connect() {
  // 重试计数存在函数自身上，跨调用保持状态，同时在测试harness截取 connect 段时也能自给自足
  if (typeof connect._retry !== 'number') connect._retry = 0;
  function _setConnStatus(st) {
    try {
      const dot = document.getElementById('conn-dot');
      if (!dot) return;
      dot.dataset.state = st;
      dot.title = { ok: '已连接', reconnecting: '重连中…', offline: '未连接' }[st] || st;
    } catch {}
  }
  _setConnStatus('reconnecting');
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onmessage = (e) => { noteServerActivity(); handleMessage(JSON.parse(e.data)); };
  ws.onclose = () => {
    _setConnStatus('offline');
    connect._resync = true;
    try { clearStuckWatchdog(); } catch (e) { /* 测试沙箱里没有看门狗 */ }
    const delay = Math.min(30000, 1000 * Math.pow(2, connect._retry));
    connect._retry++;
    try { $('auto-mode').disabled = true; } catch {}
    addSystem(`连接断开，${Math.round(delay / 1000)}s 后重连…`);
    setTimeout(connect, delay);
  };
  ws.onopen = () => {
    const wasRetry = connect._retry > 0;
    connect._retry = 0;
    _setConnStatus('ok');
    try { $('auto-mode').disabled = true; } catch {}
    if (wasRetry) addSystem('[已重连 NullFlux]'); else addTerm('[已连接 NullFlux]', 'sys');
  };
  ws.onerror = () => { _setConnStatus('reconnecting'); };
}
connect();

fetch('/api/config').then(r => r.json()).then(c => {
  $('ws-display').textContent = c.workspace;
  // 顶部不再重复显示模型名（按钮里已有）
  document.title = 'NullFlux';
  platform = c.platform;
  $('shell-name').textContent = '· ' + (platform === 'win32' ? 'cmd.exe' : 'bash');
  $('term-prompt').textContent = platform === 'win32' ? '>' : '$';
  updatePyLabel(c.pythonPath || '');
});

// ====================== Python 解释器选择器 ======================
let pyCurrent = '';
function updatePyLabel(p) {
  pyCurrent = p || '';
  const el = $('py-label'); if (!el) return;
  if (!p) { el.textContent = '未选择'; return; }
  const name = p.split(/[\\/]/).pop();
  const parent = p.split(/[\\/]/).slice(-2, -1)[0] || '';
  el.textContent = parent ? `${parent}/${name}` : name;
}
function renderPyList(envs, current) {
  const list = $('py-list');
  if (!envs.length) { list.innerHTML = '<div class="muted small" style="padding:20px;text-align:center;">未发现 Python（请用「手动选择」）</div>'; return; }
  list.innerHTML = '';
  for (const e of envs) {
    const div = document.createElement('div');
    div.className = 'py-item' + (e.path === current ? ' current' : '');
    const conda = e.conda ? `<span class="py-conda">conda: ${e.conda}</span>` : '';
    div.innerHTML = `<div><span class="py-ver">Python ${e.version || '?'}</span>${conda}</div><div class="py-path">${e.path}</div>`;
    div.onclick = async () => {
      const r = await fetch('/api/python/select', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: e.path }) });
      const j = await r.json();
      if (j.ok) { updatePyLabel(j.current); $('py-modal').style.display='none'; addTerm(`[Python] 已切换为 ${j.current}`, 'ok'); }
      else addTerm(`[Python] ${j.error || '切换失败'}`, 'err');
    };
    list.appendChild(div);
  }
}
async function loadPyList(refresh) {
  $('py-list').innerHTML = '<div class="muted small" style="padding:20px;text-align:center;">扫描中…</div>';
  const r = await fetch('/api/python/list' + (refresh ? '?refresh=1' : ''));
  const j = await r.json();
  renderPyList(j.envs || [], j.current || '');
}
$('py-picker').onclick = () => { $('py-modal').style.display = 'flex'; loadPyList(false); };
$('py-close').onclick = $('py-cancel').onclick = () => $('py-modal').style.display = 'none';
$('py-refresh').onclick = () => loadPyList(true);
$('py-clear').onclick = async () => {
  await fetch('/api/python/select', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: '' }) });
  updatePyLabel(''); loadPyList(false); addTerm('[Python] 已清除选择', 'sys');
};
$('py-browse').onclick = async () => {
  const p = prompt('输入 Python 解释器完整路径（如 C:\\Python311\\python.exe）：', pyCurrent);
  if (!p) return;
  const r = await fetch('/api/python/select', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: p }) });
  const j = await r.json();
  if (j.ok) { updatePyLabel(j.current); addTerm(`[Python] 已切换为 ${j.current}`, 'ok'); loadPyList(false); }
  else addTerm(`[Python] ${j.error || '路径无效'}`, 'err');
};
function refreshFlat() { fetch('/api/flat').then(r => r.json()).then(j => { allFiles = j.files || []; }).catch(()=>{}); }
refreshFlat();

// ====================== 头部按钮 ======================
$('stop').onclick = () => {
  ws.send(JSON.stringify({ type: 'stop' }));
  addTerm('[请求停止...]', 'sys');
  // 安全网：服务端如果没能及时发 agent_end（网络卡/总结生成中），2.5s 后强制释放输入框
  setTimeout(() => { setRunning(false); $('input').focus(); }, 2500);
};
if ($('kill-all')) $('kill-all').onclick = () => {
  if (!confirm('强行终止会杀死所有后台进程：\n· 当前 Agent 以及 run_command 进程\n· 所有后台求解器 (OpenFOAM/MFIX/LBM)\n· 用户终端 shell\n\n未保存的计算结果会丢失。确定？')) return;
  ws.send(JSON.stringify({ type: 'kill_all' }));
  addTerm('[强行终止] 已发送...', 'sys');
  setTimeout(() => { setRunning(false); $('input').focus(); }, 1500);
};
$('send').onclick = send;
$('input').addEventListener('keydown', onInputKey);
$('input').addEventListener('input', onInputChange);
$('auto-mode').onchange = () => ws.send(JSON.stringify({ type: 'set_auto', value: $('auto-mode').checked }));
$('clear-term').onclick = () => { $('terminal').innerHTML = ''; };
$('kill-shell').onclick = () => { ws.send(JSON.stringify({ type: 'pty_kill' })); addTerm('[shell 已重启]', 'sys'); };

// ====================== 发送 ======================
function send() {
  const text = $('input').value.trim();
  if (!text && attachments.length === 0 && !$('active-file-toggle').checked) return;
  if (ws.readyState !== WebSocket.OPEN) return;
  // 斜杠命令（不发给模型）
  if (text.startsWith('/')) {
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(' ');
    if (cmd === 'clear' || cmd === 'reset') { ws.send(JSON.stringify({ type: 'reset' })); $('chat').innerHTML=''; toolEls.clear(); clearChatHistory(); $('input').value=''; USAGE.input=0; USAGE.output=0; USAGE.calls=0; updateModelLabel(); addSystem('对话已清空'); return; }
    if (cmd === 'compact') { ws.send(JSON.stringify({ type: 'compact' })); $('input').value=''; addSystem('正在压缩上下文…'); return; }
    if (cmd === 'model') { $('input').value=''; $('model-picker').click(); return; }
    if (cmd === 'multi' || cmd === 'compare-models') { $('input').value=''; window.MR?.openCompare(); return; }
    if (cmd === 'tools') { $('input').value=''; $('tools-btn').click(); return; }
    if (cmd === 'py' || cmd === 'python') { $('input').value=''; $('py-picker').click(); return; }
    if (cmd === 'plan' || cmd === 'build') { $('input').value=''; setAgentMode(cmd); return; }
    if (cmd === 'fork') { $('input').value=''; forkTask(); return; }
    if (cmd === 'goal') { $('input').value=''; if (arg === 'clear') ws.send(JSON.stringify({ type: 'set_goal', clear: true })); else openGoalDialog(arg); return; }
    if (cmd === 'compare') { $('input').value=''; setPanelVisible('design', true); return; }
    if (cmd === 'digitize') { $('input').value=''; openDigitizer({ name: arg || 'plot', hint: '从论文截图 / 本地 PNG 手动标注数据点' }); return; }
    if (cmd === 'jobs' || cmd === 'monitor') { $('input').value=''; setPanelVisible('live', true); return; }
    if (cmd === 'slice') { $('input').value=''; openSliceView(arg || LIVE.ovCase); return; }
    if (cmd === 'geometry' || cmd === 'geo') { $('input').value=''; openGeometryView(arg || LIVE.ovCase); return; }
    if (cmd === 'case') { $('input').value=''; setOverviewCase(arg); setPanelVisible('live', true); return; }
    if (cmd === 'skills') { $('input').value=''; setPanelVisible('skills', true); return; }
    if (cmd === 'help') { $('input').value=''; addSystem('可用命令：/plan 规划模式（只读）· /build 执行模式 · /goal [文本|clear] 会话目标 · /fork 分叉任务 · /jobs 作业 · /case <算例> 算例总览 · /slice [算例] 切片 · /geometry [算例] 几何 · /compare 设计 · /digitize 图表取点 · /skills 技能库 · /clear 清空 · /compact 压缩 · /model 模型 · /tools 工具 · /py Python。空输入框按 Tab 切换规划/执行'); return; }
    addSystem('未知命令：/' + cmd + '（输入 /help 查看）'); return;
  }
  const finalAtts = [...attachments];
  if ($('active-file-toggle').checked && activeTab) finalAtts.push({ type: 'context_file', path: activeTab, name: activeTab });
  let textOut = text;
  for (const a of attachments) if (a.type === 'file' && a.inlineContent !== undefined) textOut += `\n\n--- 附件 ${a.name} ---\n${a.inlineContent}\n--- 结束 ---`;
  addUser(text, finalAtts);
  const steering = !$('stop').disabled;   // 智能体运行中 → 本条作为引导注入，不打断
  ws.send(JSON.stringify({ type: 'user', text: textOut, attachments: finalAtts.filter(a => a.type === 'image' || a.type === 'context_file').map(a => a.type === 'image' ? { type:'image', dataUrl:a.dataUrl, name:a.name } : { type:'context_file', path:a.path }) }));
  $('input').value = ''; attachments = []; renderAttachments();
  if (steering) addSystem('🧭 引导已发送：智能体会在下一步推理时考虑你的新输入（不打断当前工作）');
  else setRunning(true);
}
function setRunning(r) {
  $('stop').disabled = !r;
  // 运行中不再禁用发送：可继续输入新想法作为引导（Codex 式 steering）
  $('send').disabled = false;
  $('send').dataset.mode = r ? 'steer' : 'send';
  $('send').title = r ? '引导：发送新想法/修正，智能体在下一步考虑（不打断）' : '发送（Enter）';
  $('send').setAttribute('aria-label', r ? '发送引导' : '发送');
  $('input').placeholder = r ? '运行中：输入新想法/修正，智能体会在下一步考虑（不打断）' : '描述目标，或添加论文、算例与数据…';
  if (r) { armStuckWatchdog(); showPhase('llm_thinking', '启动中…'); _phaseStart = Date.now(); startPhaseTick(); }
  else { clearStuckWatchdog(); stopPhaseTick(); hidePhase(); }
}

// ====================== Composer auto-resize + slash hints (v0.9.2) ======================
(function() {
  const ta = $('input'); if (!ta) return;
  function autoResize() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'; }
  ta.addEventListener('input', autoResize);
  setTimeout(autoResize, 100);

  const SLASH_CMDS = [
    { cmd: '/plan', desc: '规划模式（只读）' }, { cmd: '/build', desc: '执行模式' },
    { cmd: '/goal', desc: '会话目标' }, { cmd: '/fork', desc: '分叉任务' },
    { cmd: '/jobs', desc: '运行作业' }, { cmd: '/case', desc: '算例总览' },
    { cmd: '/slice', desc: '切片可视化' }, { cmd: '/geometry', desc: '几何预览' },
    { cmd: '/compare', desc: '多模型对比' }, { cmd: '/digitize', desc: '图表取点' },
    { cmd: '/skills', desc: '技能库' }, { cmd: '/compact', desc: '压缩上下文' },
    { cmd: '/model', desc: '切换模型' }, { cmd: '/tools', desc: '工具开关' },
    { cmd: '/py', desc: 'Python 环境' }, { cmd: '/clear', desc: '清空对话' },
    { cmd: '/help', desc: '所有命令' },
  ];
  let pop = null;
  ta.addEventListener('input', () => {
    const v = ta.value;
    if (v.startsWith('/') && !v.includes(' ')) {
      const q = v.slice(1).toLowerCase();
      const matches = SLASH_CMDS.filter(c => c.cmd.slice(1).startsWith(q));
      if (matches.length) {
        if (!pop) { pop = document.createElement('div'); pop.className = 'slash-pop'; ta.parentElement.appendChild(pop); }
        pop.innerHTML = matches.map(c => '<button type="button" data-cmd="' + c.cmd + '"><b>' + c.cmd + '</b><span>' + c.desc + '</span></button>').join('');
        pop.querySelectorAll('button').forEach(b => { b.onclick = () => { ta.value = b.dataset.cmd + ' '; pop.style.display = 'none'; autoResize(); ta.focus(); }; });
        pop.style.display = 'block';
      } else { if (pop) pop.style.display = 'none'; }
    } else { if (pop) pop.style.display = 'none'; }
  });
  ta.addEventListener('blur', () => { setTimeout(() => { if (pop) pop.style.display = 'none'; }, 200); });
})();

// ====================== Apply theme (v0.9.2) ======================
function applyTheme() {
  try {
    const prefs = JSON.parse(localStorage.getItem('cfd.prefs') || '{}');
    const t = prefs.theme || 'dark';
    if (t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.dataset.theme = 'dark';
    } else {
      delete document.documentElement.dataset.theme;
    }
  } catch {}
}

// ============== Agent 状态带（V3.1 可见反馈） ==============
let _phaseState = { phase: 'idle', detail: '', tool: '', startedAt: 0, lastEventAt: 0 };
let _phaseStart = 0;
let _phaseTick = 0;
function ensurePhaseBar() {
  let bar = document.getElementById('agent-phase-bar');
  if (bar) return bar;
  bar = document.createElement('div');
  bar.id = 'agent-phase-bar';
  bar.className = 'agent-phase-bar';
  bar.innerHTML = `<span class="ph-spin"></span><span class="ph-icon" id="ph-icon"></span><span class="ph-text" id="ph-text">启动中…</span><span class="ph-elapsed" id="ph-elapsed"></span>`;
  bar.querySelector('.ph-text').setAttribute('role', 'status');
  $('chat').parentNode.insertBefore(bar, $('chat').nextSibling);
  return bar;
}
const PHASE_LABEL = { llm_thinking: '思考中', reasoning: '推理中', streaming: '撰写中', tool_exec: '执行中', tool_done: '整理结果', awaiting_user: '等待你确认', llm_retry: '重试中', compacting: '压缩上下文' };
function showPhase(phase, detail, tool) {
  const bar = ensurePhaseBar();
  bar.style.display = 'flex';
  _phaseState.phase = phase; _phaseState.detail = detail || ''; _phaseState.tool = tool || '';
  _phaseState.lastEventAt = Date.now();
  document.getElementById('ph-icon').textContent = PHASE_LABEL[phase] || '工作中';
  document.getElementById('ph-text').textContent = detail || '';
  bar.dataset.phase = phase;
  bar.classList.toggle('streaming', phase === 'streaming');
  bar.classList.toggle('tool', phase === 'tool_exec');
  bar.classList.toggle('thinking', phase === 'llm_thinking' || phase === 'reasoning');
}
function hidePhase() {
  const bar = document.getElementById('agent-phase-bar');
  if (bar) bar.style.display = 'none';
}
function startPhaseTick() {
  stopPhaseTick();
  _phaseTick = setInterval(() => {
    const el = document.getElementById('ph-elapsed'); if (!el) return;
    const totalSec = Math.floor((Date.now() - _phaseStart) / 1000);
    const sinceEvent = Math.floor((Date.now() - _phaseState.lastEventAt) / 1000);
    let warn = '';
    if (_phaseState.phase === 'llm_thinking' && sinceEvent > 20) warn = ' · 模型响应偏慢';
    else if (_phaseState.phase === 'tool_exec' && sinceEvent > 30) warn = ' · 工具耗时较长';
    el.textContent = `${fmtDuration(totalSec, true)}${warn}`;
  }, 500);
}
function stopPhaseTick() { if (_phaseTick) { clearInterval(_phaseTick); _phaseTick = 0; } }

// ============== 卡死自愈：超过 STUCK_MS 没收到任何服务端消息时给"恢复"按钮 ==============
const STUCK_MS = 60_000; // V3.1: 1 分钟无响应就提示（以前 2.5 min 太长）
let _stuckTimer = 0;
let _lastServerMsgAt = Date.now();
function noteServerActivity() { _lastServerMsgAt = Date.now(); if (!$('stop').disabled) armStuckWatchdog(); }
function armStuckWatchdog() {
  clearStuckWatchdog();
  _stuckTimer = setTimeout(() => {
    const idle = Date.now() - _lastServerMsgAt;
    if (idle >= STUCK_MS && $('stop').disabled === false && ws && ws.readyState === 1) {
      addSystem(`⚠ 已 ${Math.round(idle/1000)}s 无响应，可能卡住了。点 ⏹ 停止可强制恢复（不会丢失对话）。`);
    } else { armStuckWatchdog(); }
  }, STUCK_MS);
}
function clearStuckWatchdog() { if (_stuckTimer) { clearTimeout(_stuckTimer); _stuckTimer = 0; } }

// ====================== @mention ======================
let mentionState = null;
// 斜杠命令菜单（OpenCode 式）：输入框以 / 开头、还没打空格时弹出
const SLASH_COMMANDS = [
  ['plan', '规划模式（只读）'], ['build', '执行模式'], ['goal', '会话目标与验收标准'], ['fork', '分叉当前任务'],
  ['jobs', '运行 › 作业：实时进度'], ['case', '算例总览（/case 算例路径）'], ['slice', '结果 › 可视化：切片、剖切、流线、体渲染'], ['geometry', '结果 › 几何预览'],
  ['compare', '运行 › 设计'], ['digitize', '图表取点'], ['skills', '技能库'], ['compact', '压缩上下文'], ['clear', '清空对话'],
  ['model', '模型连接'], ['tools', '工具开关'], ['py', 'Python 解释器'], ['help', '全部命令'],
];
function slashItems(v) {
  const m = /^\/(\S*)$/.exec(v); if (!m) return null;
  const q = m[1].toLowerCase();
  // 英文按命令名前缀；中文按说明文字
  if (/^[\x00-\x7f]*$/.test(q)) return SLASH_COMMANDS.filter(([c]) => c.startsWith(q));
  return SLASH_COMMANDS.filter(([, d]) => d.includes(q));
}
function onInputChange() {
  const v = $('input').value, cur = $('input').selectionStart;
  const slash = slashItems(v);
  if (slash && slash.length) { mentionState = { kind: 'slash', start: 0, items: slash, selected: Math.min(mentionState?.kind === 'slash' ? mentionState.selected : 0, slash.length - 1) }; return renderMentions(); }
  let i = cur - 1;
  while (i >= 0 && !/\s/.test(v[i])) {
    if (v[i] === '@') { const q = v.slice(i+1, cur).toLowerCase(); const it = allFiles.filter(f => f.toLowerCase().includes(q)).slice(0,30);
      if (it.length) { mentionState = { start:i, query:q, items:it, selected:0 }; return renderMentions(); } break; }
    i--;
  }
  hideMentions();
}
function onInputKey(e) {
  if (mentionState && $('mention-pop').style.display !== 'none') {
    if (e.key === 'ArrowDown') { e.preventDefault(); mentionState.selected = (mentionState.selected+1) % mentionState.items.length; return renderMentions(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); mentionState.selected = (mentionState.selected-1+mentionState.items.length) % mentionState.items.length; return renderMentions(); }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) { e.preventDefault(); return pickMention(mentionState.items[mentionState.selected]); }
    if (e.key === 'Escape') return hideMentions();
  }
  // OpenCode 式：输入框为空时 Tab 切换 规划/执行（有内容时 Tab 保持默认焦点移动）
  if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !$('input').value) { e.preventDefault(); setAgentMode(AGENT_UI.mode === 'plan' ? 'build' : 'plan'); return; }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
}
function renderMentions() {
  const pop = $('mention-pop'); pop.innerHTML = '';
  const slash = mentionState.kind === 'slash';
  pop.setAttribute('role', 'listbox'); pop.setAttribute('aria-label', slash ? '命令' : '文件');
  mentionState.items.forEach((f, i) => {
    const d = document.createElement('div'); d.className = 'mention-item' + (slash ? ' slash-item' : '') + (i === mentionState.selected ? ' selected' : '');
    d.setAttribute('role', 'option'); d.setAttribute('aria-selected', String(i === mentionState.selected));
    if (slash) { d.innerHTML = '<b></b><span></span>'; d.querySelector('b').textContent = '/' + f[0]; d.querySelector('span').textContent = f[1]; }
    else d.textContent = f;
    d.onmousedown = (e) => { e.preventDefault(); pickMention(f); }; pop.appendChild(d);
  });
  pop.style.display = '';
  pop.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
}
function hideMentions() { $('mention-pop').style.display = 'none'; mentionState = null; }
// 带参数的命令补全后留空格等输入，其余直接执行
const SLASH_TAKES_ARG = new Set(['goal', 'case', 'slice', 'geometry', 'digitize']);
function pickMention(f) {
  if (!mentionState) return;
  if (mentionState.kind === 'slash') {
    hideMentions();
    $('input').value = '/' + f[0] + (SLASH_TAKES_ARG.has(f[0]) ? ' ' : '');
    $('input').focus();
    if (!SLASH_TAKES_ARG.has(f[0])) send();
    return;
  }
  const v = $('input').value, before = v.slice(0, mentionState.start), after = v.slice($('input').selectionStart);
  $('input').value = before + '@' + f + ' ' + after;
  const c = before.length + f.length + 2; $('input').setSelectionRange(c, c); $('input').focus(); hideMentions();
}

// ====================== 附件 ======================
$('attach-file').onclick = () => $('file-picker').click();
$('attach-image').onclick = () => $('image-picker').click();
$('file-picker').onchange = async (e) => {
  for (const f of e.target.files) {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    const BIN_EXT = new Set(['pdf','docx','pptx','xlsx','doc','ppt','xls','png','jpg','jpeg','gif','webp','bmp','tiff','tif','zip','tar','gz','7z','exe','dll','so','bin','stl','vtu','vtk']);
    const isBin = BIN_EXT.has(ext) || f.size > 2 * 1024 * 1024; // >2MB 也走上传，避免 utf8 串爆 prompt
    if (isBin) {
      try {
        const buf = await f.arrayBuffer();
        // base64 编码（分块避免 call stack 溢出）
        let bin = ''; const u8 = new Uint8Array(buf); const CH = 0x8000;
        for (let i = 0; i < u8.length; i += CH) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
        const b64 = btoa(bin);
        const r = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: f.name, base64: b64 }) });
        const j = await r.json();
        if (j.ok) {
          attachments.push({ type: 'context_file', name: f.name, path: j.path, size: f.size, _binary: true });
          addTerm(`[附件] ${f.name} → ${j.path} (${(f.size/1024).toFixed(1)} KB) — 已保存到工作区，agent 可调 read_document 读取`, 'sys');
        } else {
          addSystem('附件上传失败：' + (j.error || '未知'));
        }
      } catch (err) {
        addSystem('附件上传失败：' + err.message);
      }
    } else {
      const t = await f.text().catch(() => '');
      attachments.push({ type:'file', name:f.name, inlineContent:t, size:f.size });
    }
  }
  renderAttachments(); $('file-picker').value = '';
};
$('image-picker').onchange = async (e) => {
  for (const f of e.target.files) { const d = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); }); attachments.push({ type:'image', name:f.name, dataUrl:d, size:f.size }); }
  renderAttachments(); $('image-picker').value = '';
};
function renderAttachments() {
  const el = $('attachments'); el.innerHTML = '';
  attachments.forEach((a, i) => {
    const d = document.createElement('span'); d.className = 'chip ' + (a.type === 'image' ? 'image' : '');
    if (a.type === 'image') d.innerHTML = `<img src="${a.dataUrl}"/><span class="name"></span><span class="x">×</span>`;
    else d.innerHTML = `<span class="name"></span><span class="x">×</span>`;
    d.querySelector('.name').textContent = a.name;
    d.querySelector('.x').onclick = () => { attachments.splice(i, 1); renderAttachments(); };
    el.appendChild(d);
  });
}
// ====================== 拖放文件 ======================
(function setupDragDrop() {
  const zone = $('main') || document.body;
  let cnt = 0;
  zone.addEventListener('dragenter', e => {
    if (!e.dataTransfer.types.includes('Files')) return;
    cnt++; if (cnt === 1) zone.classList.add('drag-over');
    e.preventDefault();
  }, false);
  zone.addEventListener('dragleave', () => { if (--cnt <= 0) { cnt = 0; zone.classList.remove('drag-over'); } }, false);
  zone.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }, false);
  zone.addEventListener('drop', async e => {
    cnt = 0; zone.classList.remove('drag-over');
    e.preventDefault();
    const files = [...(e.dataTransfer.files || [])];
    if (!files.length) return;
    // 复用 file-picker 的同一套上传逻辑
    const fakeEv = { target: { files } };
    await $('file-picker').onchange(fakeEv);
    $('input').focus();
  }, false);
})();


// ====================== 新建/打开 ======================
$('refresh-tree') && ($('refresh-tree').onclick = async () => {
  try { const r = await fetch('/api/tree'); const j = await r.json(); renderTree(j); addSystem('资源管理器已刷新'); }
  catch (e) { addSystem('刷新失败：' + e.message); }
});
$('new-file').onclick = async () => { const n = prompt('新文件相对路径', 'untitled.txt'); if (!n) return;
  const r = await fetch('/api/fs', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({op:'create', path:n, isDir:false})});
  const j = await r.json(); if (j.ok) setTimeout(() => openFile(n), 300); else addSystem('新建失败：' + j.error); };
$('new-folder').onclick = async () => { const n = prompt('新目录', 'newfolder'); if (!n) return;
  const r = await fetch('/api/fs', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({op:'create', path:n, isDir:true})});
  const j = await r.json(); if (!j.ok) addSystem('新建失败：' + j.error); };

const pickerModal = $('picker-modal'), pickerList = $('picker-list'), pickerCwd = $('picker-cwd'), pickerTitle = $('picker-title');
let pickerMode = 'folder', pickerCb = null, pickerCurrent = '';
async function openPicker(mode, cb, start) {
  pickerMode = mode; pickerCb = cb;
  pickerTitle.textContent = mode === 'folder' ? '选择文件夹' : '选择文件';
  pickerModal.style.display = ''; await loadPickerDir(start || '');
}
async function loadPickerDir(p) {
  const r = await fetch('/api/list-abs' + (p ? '?path=' + encodeURIComponent(p) : '')); const j = await r.json();
  if (j.error) { addSystem(j.error); return; }
  pickerCurrent = j.cwd; pickerCwd.value = j.cwd; pickerList.innerHTML = '';
  if (j.parent) { const u = document.createElement('div'); u.className = 'picker-item dir'; u.textContent = '⬆ ..'; u.onclick = () => loadPickerDir(j.parent); pickerList.appendChild(u); }
  for (const it of j.items) {
    if (pickerMode === 'folder' && !it.isDir) continue;
    const d = document.createElement('div'); d.className = 'picker-item ' + (it.isDir ? 'dir' : 'file');
    d.textContent = (it.isDir ? '📁 ' : '📄 ') + it.name;
    d.ondblclick = () => { if (it.isDir) loadPickerDir(it.path); else if (pickerMode !== 'folder') { pickerCb && pickerCb(it.path); pickerModal.style.display='none'; } };
    d.onclick = () => { if (it.isDir) loadPickerDir(it.path); };
    pickerList.appendChild(d);
  }
}
$('picker-up').onclick = () => { const p = pickerCurrent.replace(/[/\\][^/\\]+[/\\]?$/, ''); if (p) loadPickerDir(p); };
$('picker-go').onclick = () => loadPickerDir(pickerCwd.value);
pickerCwd.onkeydown = (e) => { if (e.key === 'Enter') loadPickerDir(pickerCwd.value); };
$('picker-pick').onclick = () => { if (pickerCb) pickerCb(pickerCurrent); pickerModal.style.display = 'none'; };
$('picker-cancel').onclick = $('picker-close').onclick = () => { pickerModal.style.display = 'none'; };

$('open-folder').onclick = () => openPicker('folder', async (p) => {
  const r = await fetch('/api/workspace', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({dir:p})});
  const j = await r.json(); if (j.workspace) { $('ws-display').textContent = j.workspace; addSystem('已切换工作目录：' + j.workspace); refreshFlat(); }
});
$('open-file').onclick = () => openPicker('file', async (p) => {
  const ws = $('ws-display').textContent;
  if (p.toLowerCase().startsWith(ws.toLowerCase())) {
    openFile(p.slice(ws.length).replace(/^[\\\/]+/, '').replaceAll('\\','/'));
  } else if (confirm('文件不在当前工作目录内。切换工作目录？')) {
    const dir = p.replace(/[/\\][^/\\]+$/, '');
    await fetch('/api/workspace', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({dir})});
    $('ws-display').textContent = dir; refreshFlat();
    setTimeout(() => openFile(p.slice(dir.length).replace(/^[\\\/]+/, '').replaceAll('\\','/')), 300);
  }
});

// ====================== 技能库（自进化）面板 ======================
async function renderSkills() {
  const body = $('skill-body'); if (!body) return;
  const domain = $('skill-domain-filter')?.value || '';
  let j;
  try { j = await (await fetch('/api/skills' + (domain ? '?domain=' + encodeURIComponent(domain) : ''))).json(); }
  catch (e) { body.innerHTML = `<div class="muted small" style="padding:14px;color:#fca5a5;">加载失败：${e.message}</div>`; return; }
  const skills = j.skills || [], evals = j.evals || [];
  $('skill-count').textContent = skills.length;
  const domColor = { foam:'#67e8f9', mfix:'#fcd34d', lbm:'#c4b5fd', general:'#a3e635' };
  if (!skills.length) {
    body.innerHTML = '<div class="muted small" style="text-align:center;padding:16px;">技能库为空。任务被 verifier 盖章通过后会弹「技能沉淀卡」，点「存入技能库」后，技能会出现在这里。</div>';
  } else {
    body.innerHTML = skills.map(s => {
      const c = domColor[s.domain] || '#94a3b8';
      const vb = (s.verified_by || []).join(' / ');
      const trig = (s.triggers || []).slice(0, 8).map(t => `<span style="background:rgba(148,163,184,.12);border-radius:3px;padding:1px 5px;margin:1px;display:inline-block;">${escapeHtml(t)}</span>`).join('');
      return `<div class="skill-card" data-id="${escapeHtml(s.id)}" style="border:1px solid var(--line2);border-left:3px solid ${c};border-radius:5px;padding:7px 8px;margin-bottom:7px;background:#0a0612;">
        <div style="display:flex;align-items:center;gap:6px;">
          <span style="font-size:9px;color:${c};border:1px solid ${c};border-radius:3px;padding:0 4px;">${escapeHtml(s.domain)}</span>
          <b style="flex:1;font-size:11px;">${escapeHtml(s.title || s.id)}</b>
          <span class="small muted" title="命中次数">↺${s.hits || 0}</span>
        </div>
        ${s.solver ? `<div class="muted small" style="margin-top:2px;">求解器：${escapeHtml(s.solver)}</div>` : ''}
        ${vb ? `<div class="small" style="margin-top:2px;color:#86efac;">✅ verifier：${escapeHtml(vb)}</div>` : ''}
        ${trig ? `<div style="margin-top:3px;font-size:9px;">${trig}</div>` : ''}
        <div style="margin-top:5px;display:flex;gap:5px;">
          <button class="mini sk-detail" data-id="${escapeHtml(s.id)}">详情</button>
          <button class="mini sk-del" data-id="${escapeHtml(s.id)}" style="color:#fca5a5;">删除</button>
        </div>
        <div class="sk-detail-box" style="display:none;margin-top:6px;border-top:1px dashed var(--line2);padding-top:6px;"></div>
      </div>`;
    }).join('');
  }
  if (evals.length) {
    const recent = evals.slice(-8).reverse();
    const rows = recent.map(e => {
      const m = e.metrics || {};
      const rate = m.verifyPassRate == null ? '—' : (m.verifyPassRate * 100).toFixed(0) + '%';
      return `<div style="display:flex;gap:6px;font-size:10px;padding:2px 0;border-bottom:1px dashed var(--line2);">
        <span style="min-width:64px;color:#c4b5fd;">${escapeHtml(e.label || '-')}</span>
        <span style="flex:1;color:#cbd5e1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml((e.task || '').slice(0, 30))}</span>
        <span title="verifier 通过率" style="color:#86efac;">${rate}</span>
        <span title="出错迭代次数" class="muted">err${m.errorIters ?? '-'}</span>
        <span title="注入技能数" class="muted">注${e.skillsInjected ?? 0}</span>
      </div>`;
    }).join('');
    body.innerHTML += `<div style="margin-top:8px;"><div style="font-weight:600;color:#f0abfc;font-size:11px;margin-bottom:3px;">📈 进化评测（最近 ${recent.length} 次 A/B）</div>${rows}</div>`;
  }
}
$('skill-body')?.addEventListener('click', async (e) => {
  const dBtn = e.target.closest('.sk-detail'), xBtn = e.target.closest('.sk-del');
  if (dBtn) {
    const card = dBtn.closest('.skill-card'), box = card.querySelector('.sk-detail-box');
    if (box.style.display === 'block') { box.style.display = 'none'; return; }
    box.style.display = 'block'; box.innerHTML = '<span class="muted small">加载中…</span>';
    try {
      const sk = (await (await fetch('/api/skills/' + encodeURIComponent(dBtn.dataset.id))).json()).skill || {};
      const steps = (sk.recipe?.steps || sk.steps || []).map(x => `<li>${escapeHtml(typeof x === 'string' ? x : JSON.stringify(x))}</li>`).join('');
      const pits = (sk.pitfalls || []).map(x => `<li style="color:#fca5a5;">${escapeHtml(typeof x === 'string' ? x : JSON.stringify(x))}</li>`).join('');
      const params = sk.key_params ? escapeHtml(JSON.stringify(sk.key_params)) : '';
      box.innerHTML = `${sk.summary ? `<div style="margin-bottom:4px;">${escapeHtml(sk.summary)}</div>` : ''}${params ? `<div class="small muted" style="margin-bottom:4px;">关键参数：${params}</div>` : ''}${steps ? `<div style="font-size:10px;"><b>步骤</b><ol style="margin:2px 0 4px;padding-left:16px;">${steps}</ol></div>` : ''}${pits ? `<div style="font-size:10px;"><b>踩过的坑</b><ul style="margin:2px 0;padding-left:16px;">${pits}</ul></div>` : ''}` || '<span class="muted small">（无更多细节）</span>';
    } catch (err) { box.innerHTML = `<span class="muted small" style="color:#fca5a5;">详情加载失败：${err.message}</span>`; }
  } else if (xBtn) {
    if (!confirm('确定从技能库删除该技能？此操作不可撤销。')) return;
    try { await fetch('/api/skills/' + encodeURIComponent(xBtn.dataset.id), { method: 'DELETE' }); addSystem('🧠 已从技能库删除一条技能'); renderSkills(); }
    catch (err) { addSystem('删除失败：' + err.message); }
  }
});
$('skill-refresh').onclick = () => renderSkills();
$('skill-domain-filter').onchange = () => renderSkills();
renderSkills();

// ====================== 交互终端 ======================
$('term-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const cmd = e.target.value;
    addTerm((platform === 'win32' ? '> ' : '$ ') + cmd, 'user');
    ws.send(JSON.stringify({ type: 'pty_input', data: cmd + '\n' }));
    e.target.value = '';
  }
});

// ====================== 消息处理 ======================
function handleMessage(m) {
  switch (m.type) {
    case 'agent_start': setRunning(true); onAgentRunState(true); break;
    case 'agent_idle': if (!$('stop').disabled) { setRunning(false); onAgentRunState(false); } break;
    case 'agent_end': {
      setRunning(false); onAgentRunState(false);
      // A2: 细化暂停原因提示
      if (m.canContinue) {
        const _pn = document.createElement('div'); _pn.className = 'agent-pause-notice';
        const _reasonLabel = {
          paused: '智能体已暂停',
          stalled: '智能体卡住（连续轮次无工具调用）',
          awaiting_user: '智能体在等待你的决定',
          budget_exhausted: '步数预算已用尽',
          error: '智能体因错误暂停',
        }[m.reason] || '智能体已暂停';
        _pn.dataset.reason = m.reason || 'paused';
        _pn.innerHTML = `<span>${_escHtmlBasic(_reasonLabel)}</span><button type="button">继续</button>`;
        _pn.querySelector('button').onclick = () => {
          _pn.remove();
          if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'user', text: '继续推进未完成的工作', attachments: [] }));
        };
        const _ch = $('chat'); if (_ch) { _ch.appendChild(_pn); try { scrollChat(); } catch {} }
      }
      $('input').focus(); break;
    }
    case 'assistant_start': currentReasoningBubble = null; currentAssistantBubble = addAssistantBubble(); break;
    case 'delta': if (currentAssistantBubble) {
        currentAssistantBubble._raw = (currentAssistantBubble._raw || '') + m.text;
        // 节流：流式阶段每 300ms 渲染一次 Markdown+KaTeX；最后由 assistant_end 做完整渲染
        if (!currentAssistantBubble._raf) {
          currentAssistantBubble._raf = setTimeout(() => {
            currentAssistantBubble._raf = null;
            if (currentAssistantBubble._raw) renderMarkdownInto(currentAssistantBubble, currentAssistantBubble._raw);
          }, 300);
        }
        scrollChat();
      } break;
    case 'reasoning': appendReasoning(m.text); break;
    case 'assistant_end': collapseReasoning(); if (currentAssistantBubble) { renderMarkdownInto(currentAssistantBubble, currentAssistantBubble._raw || currentAssistantBubble.textContent); } currentAssistantBubble = null; break;
    case 'tool_call': { const el = renderTool(m.id, m.name, m.args); toolEls.set(m.id, el); addTerm(`▶ [agent] ${m.name}(${shortArgs(m.args)})`, 'agent'); break; }
    case 'approval_request': renderApproval(m); addTerm(`⚠ [需审批] ${m.name}: ${m.args.command || m.args.case_path || ''}`, 'err'); break;
    case 'tool_result': { const el = toolEls.get(m.id);
      const isErr = isToolError(m.result);
      addTerm(`◀ [agent] ${m.name} → ` + String(m.result).split('\n')[0].slice(0,140), isErr ? 'err' : 'ok');
      if (el) finishTool(el, m.name, m.result, isErr);
      break; }
    case 'term': if (String(m.line).includes('\n')) String(m.line).split('\n').forEach(l => l && addTerm(l)); else addTerm(m.line); if (/^\[任务\].*(请先|不存在|已删除)/.test(m.line || '')) toast(String(m.line).replace(/^\[任务\]\s*/, '')); break;
    case 'task_state': TASKS_UI.list = m.list || []; TASKS_UI.currentId = m.currentId; renderTaskBar(); renderTaskList(); openTaskFromHash(); window.MR?.onTasks(); liveOnTasks(); break;
    case 'multi_run_started': window.MR?.onStarted(m); break;
    case 'task_history': replayTaskHistory(m); break;
    case 'task_reverted': window.FX?.onReverted?.(m); break;
    case 'post_view': openPostState(m); break;
    case 'task_unreverted': window.FX?.onUnreverted?.(m); break;
    case 'pty_out': addTerm(m.line); break;
    case 'tree': renderTree(m.tree); break;
    case 'checkpoints': renderCheckpoints(m.list); break;
    case 'pending_edits': renderPending(m.list); break;
    case 'todos': renderTodos(m.list); markContextActivity('status'); break;
    case 'usage': showUsage(m.usage); break;
    case 'task_complete': addSystem('任务完成：' + (m.summary || '')); break;
    case 'sim_state': case 'sim_started': case 'sim_closed': case 'sim_frame': case 'sim_error': break;   // ParaView 面板已删除
    case 'sim_compare': addCompareFrame(m); break;
    case 'runs_update': {
      markContextActivity('status');
      // 后台有新的 OpenFOAM 进程被登记或结束 → 刷新求解器监测面板下拉
      try {
        if (typeof smRefreshRuns === 'function') {
          smRefreshRuns().then(() => {
            // 若用户当前没选 runId 且来的是新启动事件，自动选中
            if (m.reason && /started|run_command_detected/.test(m.reason) && m.runId) {
              const sel = $('sm-run');
              if (sel && (!SM.runId || !sel.value)) {
                sel.value = m.runId; SM.runId = m.runId;
                SM.snaps = []; SM.lastResidSig = '';
                if (typeof smRenderSnapStrip === 'function') smRenderSnapStrip();
                if (typeof smPoll === 'function') smPoll();
                if (typeof smRestartTimer === 'function') smRestartTimer();
                addSystem(`已接入新的求解作业 ${m.runId}，可在「运行」中查看残差与日志`);
              }
            }
          });
        }
      } catch {}
      break;
    }
    case 'heartbeat': /* 仅作活跃信号 */ break;
    case 'solver_alert': renderSolverAlert(m); markContextActivity('status'); break;
    case 'agent_phase': {
      _phaseStart = Date.now(); // fix: 每次新 phase 重置计时，不再累加到会话总时长
      showPhase(m.phase, m.detail, m.tool);
      break;
    }
    case 'digitize_open': {
      // 后端请求用户打开标注界面（可能携带图片 base64 / hint / request_id）
      openDigitizer({
        imageBase64: m.image_base64 || null,
        imageUrl: m.image_url || null,
        hint: m.hint || '',
        name: m.name || 'plot',
        requestId: m.request_id || null
      });
      addSystem('📍 智能体请你亲手标注一张图表的数据点。完成后点「保存 CSV 并发送到聊天」。' + (m.hint ? ' 提示：' + m.hint : ''));
      break;
    }
    case 'error': addSystem('错误：' + m.message); addTerm('[错误] ' + m.message, 'err'); setRunning(false); break;
    case 'skill_distill': try { renderSkillDistill(m.draft); } catch (e) { addSystem('技能沉淀卡渲染失败：' + e.message); } break;
    case 'skill_saved': addSystem(`🧠 已存入技能库：「${m.title}」(${m.domain})`); addTerm(`[技能库] 保存 ${m.title}`, 'ok'); try { renderSkills(); } catch {} break;
    case 'reset_done': {
      const chat = $('chat'); if (chat) chat.innerHTML = '';
      clearChatHistory();
      const td = $('todos'); if (td) td.innerHTML = '<div class="muted small">尚无任务</div>';
      const pl = $('pending-list'); if (pl) pl.innerHTML = '';
      const pb = $('pending-bar'); if (pb) pb.style.display = 'none';
      addSystem('对话已清空');
      break;
    }
  }
  window.dispatchEvent(new CustomEvent('dscm-msg', { detail: m }));
}

function shortArgs(a) {
  if (!a) return '';
  if (a.command) return a.command.slice(0, 60);
  if (a.case_path) return a.case_path + (a.command ? ' ' + a.command : '');
  if (a.path) return a.path; if (a.pattern) return a.pattern;
  if (a.items) return `${a.items.length} 项`;
  return '';
}
function addUser(text, atts) {
  $('chat').querySelector('.welcome')?.remove();
  const div = document.createElement('div'); div.className = 'msg user';
  div.innerHTML = `<div class="role">你</div><div class="bubble"></div>`;
  const b = div.querySelector('.bubble'); b.textContent = text;
  for (const a of (atts || [])) {
    if (a.type === 'image') { const im = document.createElement('img'); im.src = a.dataUrl; im.alt = a.name || '图片'; b.appendChild(im); }
    else { const p = document.createElement('div'); p.className = 'msg-att'; p.textContent = a.path || a.name; b.appendChild(p); }
  }
  $('chat').appendChild(div); scrollChat();
  const prev = [...$('chat').querySelectorAll('.msg.user')].filter(x => x !== div).pop();
  div.dataset.ui = String(prev && prev.dataset.ui !== undefined ? +prev.dataset.ui + 1 : 0); div.dataset.raw = text;
  return div;
}
function addAssistantBubble() {
  const div = document.createElement('div'); div.className = 'msg assistant';
  div.innerHTML = `<div class="role">NullFlux</div><div class="bubble"></div>`;
  $('chat').appendChild(div); scrollChat();
  return div.querySelector('.bubble');
}
// 推理模型的思考流：Codex 式折叠行「思考中… / 已思考 Ns」，点击展开全文
function appendReasoning(text) {
  if (!currentReasoningBubble) {
    const div = document.createElement('div'); div.className = 'reasoning-msg open live';
    div.innerHTML = `<button type="button" class="reasoning-head" aria-expanded="true"><svg class="ico sm chev"><use href="#i-chevron"/></svg><span class="reasoning-label">思考中…</span></button><div class="reasoning-body"></div>`;
    const head = div.querySelector('.reasoning-head'); const body = div.querySelector('.reasoning-body');
    head.onclick = () => { const open = div.classList.toggle('open'); head.setAttribute('aria-expanded', String(open)); };
    // 推理先于答案：若本轮回答气泡已创建但尚无正文，把思考行插在它之前
    const anchor = currentAssistantBubble && !currentAssistantBubble._raw ? currentAssistantBubble.closest('.msg') : null;
    if (anchor) $('chat').insertBefore(div, anchor); else $('chat').appendChild(div);
    scrollChat();
    currentReasoningBubble = { div, head, body, t0: Date.now() };
  }
  currentReasoningBubble.body.textContent += text;
  currentReasoningBubble.body.scrollTop = currentReasoningBubble.body.scrollHeight;
  scrollChat();
}
function collapseReasoning() {
  if (!currentReasoningBubble) return;
  const { div, head, t0 } = currentReasoningBubble;
  div.querySelector('.reasoning-label').textContent = `已思考 ${fmtDuration(Math.max(1, Math.round((Date.now() - t0) / 1000)))}`;
  div.classList.remove('open', 'live'); head.setAttribute('aria-expanded', 'false');
  currentReasoningBubble = null;
}
function addSystem(text) { const div = document.createElement('div'); div.className = 'msg system'; div.innerHTML = `<div class="bubble"></div>`; div.querySelector('.bubble').textContent = text; $('chat').appendChild(div); scrollChat(); }

// ====================== 自进化沉淀卡（任务被 verifier 盖章通过后弹出，用户确认才入库）======================
function renderSkillDistill(draft) {
  if (!draft) return;
  const div = document.createElement('div');
  div.className = 'msg system';
  const vb = (draft.provenance && draft.provenance.verified_by || []).join(', ') || 'stage';
  const recipe = (draft.recipe || []).join(' → ') || '（无）';
  div.innerHTML = `
    <div class="bubble" style="border:1px solid #a855f7;background:rgba(168,85,247,.06);border-radius:8px;padding:10px;">
      <div style="font-weight:600;color:#f0abfc;margin-bottom:6px;">🧠 本轮已被 verifier 盖章通过（${vb}）—— 要把它沉淀为可复用技能吗？</div>
      <div style="display:flex;flex-direction:column;gap:6px;font-size:12px;">
        <label>标题<input class="py-input sd-title" style="width:100%;" value="${(draft.title||'').replace(/"/g,'&quot;')}"></label>
        <label>领域
          <select class="py-input sd-domain" style="width:100%;">
            ${['foam','mfix','lbm','general'].map(d=>`<option value="${d}" ${d===draft.domain?'selected':''}>${d}</option>`).join('')}
          </select>
        </label>
        <label>触发词（逗号分隔，命中即注入）<input class="py-input sd-trig" style="width:100%;" value="${(draft.triggers||[]).join(', ')}"></label>
        <label>求解器<input class="py-input sd-solver" style="width:100%;" value="${(draft.solver||'').replace(/"/g,'&quot;')}" placeholder="如 simpleFoam"></label>
        <label>配方（每行一步，可编辑）<textarea class="py-input sd-recipe" rows="3" style="width:100%;font-family:monospace;">${(draft.recipe||[]).join('\n')}</textarea></label>
        <label>⚠ 坑（每行一条，强烈建议补上本轮踩的坑）<textarea class="py-input sd-pit" rows="2" style="width:100%;" placeholder="例：location_in_mesh 必须落在流体域内"></textarea></label>
        <div class="muted" style="font-size:11px;">配方/坑只是占位，越具体下次注入越有用。来源：${draft.provenance&&draft.provenance.case_path||'—'}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px;">
          <button class="mini sd-skip">忽略</button>
          <button class="mini ok sd-save">存入技能库</button>
        </div>
      </div>
    </div>`;
  $('chat').appendChild(div); scrollChat();
  div.querySelector('.sd-skip').onclick = () => { div.remove(); };
  div.querySelector('.sd-save').onclick = () => {
    const out = {
      title: div.querySelector('.sd-title').value.trim() || draft.title,
      domain: div.querySelector('.sd-domain').value,
      triggers: div.querySelector('.sd-trig').value.split(',').map(s=>s.trim()).filter(Boolean),
      solver: div.querySelector('.sd-solver').value.trim(),
      physics: draft.physics || '',
      recipe: div.querySelector('.sd-recipe').value.split('\n').map(s=>s.trim()).filter(Boolean),
      key_params: draft.key_params || {},
      verify_seq: draft.verify_seq || [],
      pitfalls: div.querySelector('.sd-pit').value.split('\n').map(s=>s.trim()).filter(Boolean),
      provenance: draft.provenance || {},
    };
    ws.send(JSON.stringify({ type: 'skill_save_ui', draft: out }));
    div.querySelector('.bubble').innerHTML = `<div style="color:#86efac;">✓ 已提交存入技能库：「${out.title}」(${out.domain})</div>`;
  };
}

// ====================== Markdown + KaTeX (lazy CDN) ======================
let _mdReady = null;
async function ensureMD() {
  if (_mdReady) return _mdReady;
  _mdReady = (async () => {
    const out = {};
    try {
      const m = await import('/vendor/marked.esm.js');
      out.marked = m.marked || m.default || m;
    } catch (e) { out.marked = null; }
    try {
      const k = await import('/vendor/katex.mjs');
      out.katex = k.default || k;
    } catch (e) { out.katex = null; }
    return out;
  })();
  return _mdReady;
}
function _escHtmlBasic(s) { return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
async function renderMarkdownInto(bubble, raw) {
  if (!bubble) return;
  const text = String(raw || '');
  if (!text.trim()) { bubble.textContent = text; return; }
  try {
    const { marked, katex } = await ensureMD();
    if (!marked) { bubble.textContent = text; return; }
    // 抽出公式占位
    const blocks = []; let t = text;
    t = t.replace(/\$\$([\s\S]+?)\$\$/g, (_, e) => { blocks.push({ d: true, e }); return `\u0000KTX${blocks.length-1}\u0000`; });
    t = t.replace(/(^|[^\\$])\$([^\n$]{1,500}?)\$(?!\d)/g, (_m, pre, e) => { blocks.push({ d: false, e }); return `${pre}\u0000KTX${blocks.length-1}\u0000`; });
    let html;
    try { html = marked.parse(t, { breaks: true, gfm: true }); } catch { html = '<pre>' + _escHtmlBasic(text) + '</pre>'; }
    html = html.replace(/\u0000KTX(\d+)\u0000/g, (_m, i) => {
      const b = blocks[+i]; if (!b) return '';
      if (!katex) return `<code>${_escHtmlBasic(b.e)}</code>`;
      try { return katex.renderToString(b.e, { displayMode: b.d, throwOnError: false, output: 'html' }); }
      catch { return `<code>${_escHtmlBasic(b.e)}</code>`; }
    });
    // 仅对气泡内的渲染，外部消息保持安全：用 textContent 注入 HTML 是必要的
    bubble.innerHTML = html;
    // 代码块右上角加复制按钮
    bubble.querySelectorAll('pre > code').forEach(code => {
      const pre = code.parentElement;
      pre.style.position = 'relative';
      const btn = document.createElement('button');
      btn.textContent = '复制'; btn.className = 'mini';
      btn.style.cssText = 'position:absolute;top:4px;right:4px;font-size:9px;padding:1px 6px;opacity:.7;';
      btn.onclick = () => { navigator.clipboard.writeText(code.textContent || ''); btn.textContent = '✓'; setTimeout(() => btn.textContent = '复制', 1200); };
      pre.appendChild(btn);
    });
    // v0.9.2: 消息级复制按钮 + D3: 引用按钮
    const _msgDiv = bubble.closest('.msg');
    if (_msgDiv && !_msgDiv.querySelector('.msg-copy-btn')) {
      const _cp = document.createElement('button');
      _cp.className = 'msg-copy-btn'; _cp.textContent = '复制'; _cp.title = '复制回复';
      _cp.onclick = () => { navigator.clipboard.writeText(bubble.textContent || ''); _cp.textContent = '✓'; setTimeout(() => _cp.textContent = '复制', 1200); };
      _msgDiv.appendChild(_cp);
      // D3: 消息引用 Quote — 把截断后的消息以 blockquote 形式插入 composer
      const _qt = document.createElement('button');
      _qt.className = 'msg-quote-btn'; _qt.textContent = '引用'; _qt.title = '引用此消息（插入输入框）';
      _qt.onclick = () => {
        const raw = (bubble._raw || bubble.textContent || '').trim();
        const truncated = raw.length > 600 ? raw.slice(0, 600) + '…' : raw;
        const quoted = truncated.split('\n').slice(0, 15).map(l => '> ' + l).join('\n');
        const ta = document.getElementById('input');
        if (!ta) return;
        ta.value = (ta.value ? ta.value + '\n\n' : '') + quoted + '\n\n';
        ta.focus();
        ta.dispatchEvent(new Event('input')); // 触发 autoResize
      };
      _msgDiv.appendChild(_qt);
    }
    scrollChat();
  } catch (e) {
    bubble.textContent = text;
  }
}
// ====================== 活动行（Codex 式：一行动词 + 摘要 + 耗时，点击展开参数/输出） ======================
const TOOL_VERBS = {
  run_command: ['运行命令', 'terminal'], sim_run_openfoam: ['运行 OpenFOAM', 'terminal'],
  read_file: ['读取', 'file'], write_file: ['写入', 'edit'], edit_file: ['编辑', 'edit'], multi_edit: ['编辑', 'edit'],
  list_dir: ['浏览目录', 'folder'], glob: ['查找文件', 'search'], grep_search: ['搜索代码', 'search'],
  update_todos: ['更新计划', 'list'], task_complete: ['完成任务', 'flag'],
  web_search: ['联网搜索', 'globe'], fetch_url: ['读取网页', 'globe'], image_search: ['搜索图片', 'image'], download_file: ['下载', 'globe'],
  read_document: ['阅读文档', 'book'], paper_search: ['检索论文', 'book'], paper_fetch: ['获取论文', 'book'], read_paper: ['精读论文', 'book'], paper_extract: ['抽取论文要素', 'book'],
  vision_analyze: ['看图分析', 'eye'], request_user_digitize: ['请你标注图表', 'chart'],
  sim_render: ['渲染场', 'cube'], sim_open_paraview: ['打开 ParaView', 'cube'], foam_stl_render: ['渲染几何', 'cube'], foam_compare_render: ['对比渲染', 'cube'],
  foam_run_solver_async: ['启动求解', 'wind'], mfix_run_solver_async: ['启动求解', 'wind'], lbm_run_async: ['启动求解', 'wind'],
  foam_solver_status: ['查看求解', 'activity'], mfix_solver_status: ['查看求解', 'activity'], lbm_solver_status: ['查看求解', 'activity'],
  foam_solver_stop: ['停止求解', 'x'], mfix_solver_stop: ['停止求解', 'x'], lbm_solver_stop: ['停止求解', 'x'],
  solver_wait: ['等待求解', 'activity'], foam_residual_series: ['读取残差', 'chart'], foam_locate: ['定位发散', 'search'],
  foam_inspect_case: ['检查算例', 'eye'], case_probe_facts: ['检查算例', 'eye'], foam_env_check: ['检查环境', 'eye'],
  foam_mesh_plan: ['规划网格', 'cube'], foam_mesh_verify: ['核验网格', 'check'], foam_mesh_stl_check: ['核验贴体', 'check'], foam_patch_diff: ['核对边界', 'check'],
  foam_stl_generate: ['生成几何', 'cube'], foam_stl_inspect: ['检查几何', 'cube'], foam_compute_first_layer: ['计算首层厚度', 'chart'],
  foam_postproc_list: ['列出后处理', 'chart'], foam_postproc_stats: ['统计时均', 'chart'], kpi_credibility: ['KPI 可信度', 'chart'],
  foam_geom_verify: ['核验几何', 'check'], foam_solve_verify: ['核验求解', 'check'], foam_post_verify: ['核验后处理', 'check'], paper_param_verify: ['核验参数', 'check'],
  run_status_load: ['读取运行状态', 'activity'], run_stage_start: ['进入阶段', 'flag'], run_stage_done: ['完成阶段', 'flag'],
  opt_study_create: ['创建优化', 'chart'], opt_suggest_next: ['建议参数', 'chart'], opt_run_trial: ['运行试验', 'wind'], opt_record_result: ['记录结果', 'chart'],
  opt_status: ['优化进度', 'chart'], opt_render: ['优化图表', 'chart'], opt_apply_params: ['写入参数', 'edit'], opt_extract_kpi: ['提取 KPI', 'chart'],
  diagnose_error: ['诊断报错', 'search'], skill_recall: ['召回技能', 'book'], skill_save: ['沉淀技能', 'book'],
  git_log_recent: ['查看历史', 'list'], git_diff: ['查看差异', 'file'], git_revert_to: ['回滚', 'refresh'],
};
function toolMeta(name) {
  if (TOOL_VERBS[name]) return TOOL_VERBS[name];
  if (/^opt_/.test(name)) return ['优化 · ' + name.slice(4).replace(/_/g, ' '), 'chart'];
  if (/^skill_|^vertical_|^learn_/.test(name)) return [name.replace(/_/g, ' '), 'book'];
  if (/^(foam|mfix|lbm)_/.test(name)) return [name.replace(/_/g, ' '), 'wind'];
  return [name.replace(/_/g, ' '), 'dot'];
}
function toolSummary(name, a) {
  if (!a || typeof a !== 'object') return '';
  if (name === 'update_todos' && Array.isArray(a.items)) return `${a.items.filter(i => i.done).length}/${a.items.length} 项`;
  const v = a.command || a.path || a.case_path || a.stl_path || a.query || a.pattern || a.url || a.run_id || a.study_id || a.stage || a.id || a.summary
    || (Array.isArray(a.images) ? a.images.join(', ') : '') || (Array.isArray(a.run_ids) ? a.run_ids.join(', ') : '');
  return String(v || '').replace(/\s+/g, ' ').slice(0, 160);
}
function isToolError(result) {
  const s = String(result || '');
  return /^(执行失败|启动失败|错误|Error|\[error\])/i.test(s) || /FOAM FATAL|Traceback \(most recent call last\)/.test(s) || /exit(?:Code)?[=:]\s*[1-9]/.test(s.slice(0, 400));
}
function renderTool(id, name, args) {
  const [label, ico] = toolMeta(name);
  const div = document.createElement('div'); div.className = 'tool'; div.dataset.tool = name;
  div.innerHTML = `<button type="button" class="tool-head" aria-expanded="false"><svg class="ico tool-ico"><use href="#i-${ico}"/></svg><span class="tool-verb"></span><span class="tool-sum"></span><span class="tool-time"></span><span class="status run">运行中</span><svg class="ico sm chev"><use href="#i-chevron"/></svg></button><div class="tool-body"><div class="tool-args"></div><div class="tool-result"></div></div><div class="tool-artifacts" hidden></div>`;
  div.querySelector('.tool-verb').textContent = label;
  div.querySelector('.tool-sum').textContent = toolSummary(name, args);
  div.querySelector('.tool-head').title = name;
  div.querySelector('.tool-args').textContent = JSON.stringify(args, null, 2);
  div._t0 = Date.now();
  const head = div.querySelector('.tool-head');
  head.onclick = () => { const open = div.classList.toggle('open'); head.setAttribute('aria-expanded', String(open)); };
  if (['write_file', 'edit_file', 'multi_edit'].includes(name) && args && args.path) addToolArtifacts(div, [args.path], true);
  // 连续重复的同一调用（如反复 solver_wait 同一作业）合并成一行，计数 ×N
  const prev = $('chat').lastElementChild, sig = name + '\u0000' + div.querySelector('.tool-sum').textContent;
  div.dataset.sig = sig;
  if (prev && prev.classList.contains('tool') && prev.dataset.sig === sig && !prev.classList.contains('failed') && prev.querySelector('.status.ok')) {
    const n = Number(prev.dataset.repeat || 1) + 1;
    div.dataset.repeat = String(n);
    const badge = document.createElement('span'); badge.className = 'tool-repeat'; badge.textContent = '×' + n; badge.title = `连续 ${n} 次相同调用`;
    div.querySelector('.tool-sum').after(badge);
    prev.remove();
  }
  $('chat').appendChild(div); scrollChat(); return div;
}
// 结果里可在检查器中打开的产物（图片 / 几何 / 场 / PDF / 报告）
const ARTIFACT_RE = /(?:^|[\s'"`(\[=:,，])((?:[A-Za-z]:[\\/]|\/|\.{0,2}\/)?(?:[\w.\-~+@\u4e00-\u9fa5]+[\\/])*[\w.\-+@\u4e00-\u9fa5]+\.(?:png|jpe?g|gif|webp|svg|stl|obj|vtu|vtp|vti|vtk|vtm|pvd|pdf|md))(?=$|[\s'"`)\],;:，。、）])/gi;
function extractArtifactPaths(text) {
  const out = []; const s = String(text || '');
  for (const m of s.matchAll(ARTIFACT_RE)) {
    let p = m[1];
    if (/^\/\//.test(p) || /^\/api\//.test(p) || /:\/\//.test(s.slice(Math.max(0, m.index - 8), m.index + 2))) continue;
    if (/^(?:\.\/)/.test(p)) p = p.slice(2);
    if (!out.includes(p)) out.push(p);
    if (out.length >= 12) break;
  }
  return out;
}
function relToWorkspace(p) {
  const root = ($('ws-display')?.textContent || '').replace(/[\\/]+$/, '');
  const norm = String(p).replace(/\\/g, '/');
  if (root && norm.toLowerCase().startsWith(root.replace(/\\/g, '/').toLowerCase() + '/')) return norm.slice(root.length + 1);
  return norm;
}
function artifactKind(p) {
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(p)) return 'image';
  if (/\.(stl|obj)$/i.test(p)) return 'geometry';
  if (/\.(vtu|vtp|vti|vtk|vtm|pvd)$/i.test(p)) return 'field';
  if (/\.pdf$/i.test(p)) return 'pdf';
  return 'doc';
}
const ARTIFACT_ICON = { image: 'image', geometry: 'cube', field: 'cube', pdf: 'book', doc: 'file' };
// 只读/检索类工具的输出里出现的路径是“提到”而非“产出”，不列为结果
const NO_ARTIFACT_TOOLS = new Set(['list_dir', 'glob', 'grep_search', 'read_file', 'foam_inspect_case', 'case_probe_facts', 'mfix_inspect_case', 'lbm_inspect_case',
  'web_search', 'fetch_url', 'image_search', 'paper_search', 'paper_fetch', 'read_document', 'read_paper', 'skill_recall', 'skill_list', 'vertical_list',
  'foam_find_tutorial', 'foam_find_source', 'mfix_find_tutorial', 'lbm_find_tutorial', 'git_log_recent', 'git_diff', 'foam_postproc_list', 'run_status_load']);
function addToolArtifacts(toolEl, paths, quiet) {
  const host = toolEl.querySelector('.tool-artifacts'); if (!host || !paths.length) return;
  for (const raw of paths) {
    const p = relToWorkspace(raw);
    if (host.querySelector(`[data-path="${CSS.escape(p)}"]`)) continue;
    const kind = artifactKind(p);
    const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'artifact-chip ' + kind; chip.dataset.path = p; chip.title = '在检查器中打开 ' + p;
    chip.innerHTML = kind === 'image'
      ? `<img alt="" loading="lazy" /><span></span>`
      : `<svg class="ico"><use href="#i-${ARTIFACT_ICON[kind]}"/></svg><span></span>`;
    chip.querySelector('span').textContent = p.split('/').pop();
    if (kind === 'image') { const im = chip.querySelector('img'); im.src = '/api/file?path=' + encodeURIComponent(p) + '&raw=1'; im.onerror = () => chip.classList.add('missing'); }
    chip.onclick = () => openArtifact(p);
    host.appendChild(chip);
    registerArtifact(p, quiet);
  }
  host.hidden = !host.children.length;
}
function finishTool(el, name, result, isErr, quiet) {
  const tr = el.querySelector('.tool-result');
  tr.textContent = result;
  const st = el.querySelector('.status');
  st.textContent = isErr ? '失败' : '完成'; st.className = 'status ' + (isErr ? 'err' : 'ok');
  el.classList.toggle('failed', !!isErr);
  // v0.9.3: 智能折叠 — 错误自动展开，短结果(≤3行)自动展开，长结果保持折叠但显示行数
  if (isErr && !quiet) {
    el.classList.add('open'); el.querySelector('.tool-head').setAttribute('aria-expanded', 'true');
  } else if (!isErr && !quiet) {
    const lineCount = String(result || '').split('\n').length;
    if (lineCount <= 3) {
      // 短结果自动展开，让用户一眼看到
      el.classList.add('open', 'auto-open'); el.querySelector('.tool-head').setAttribute('aria-expanded', 'true');
    } else {
      // 长结果保持折叠，在摘要后加行数提示
      const sumEl = el.querySelector('.tool-sum');
      if (sumEl && !sumEl.dataset.linesAdded) {
        const hint = document.createElement('span');
        hint.className = 'tool-lines-hint'; hint.textContent = lineCount + ' 行';
        sumEl.after(hint);
        sumEl.dataset.linesAdded = '1';
      }
    }
  }
  if (el._t0 && !quiet) el.querySelector('.tool-time').textContent = fmtDuration(Math.max(0, Math.round((Date.now() - el._t0) / 1000)), true);
  try {
    // 网络图片（image_search / fetch_url）→ 缩略图，点击新标签打开
    const urls = (String(result).match(/https?:\/\/[^\s<>"'`]+\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?[^\s<>"'`]*)?/gi) || []);
    if (urls.length) {
      const gal = document.createElement('div'); gal.className = 'tool-images';
      urls.slice(0, 8).forEach(u => {
        const a = document.createElement('a'); a.href = u; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = u;
        const img = document.createElement('img'); img.src = u; img.referrerPolicy = 'no-referrer'; img.loading = 'lazy'; img.alt = '';
        img.onerror = () => a.remove();
        a.appendChild(img); gal.appendChild(a);
      });
      tr.appendChild(gal);
    }
    if (!isErr && !NO_ARTIFACT_TOOLS.has(name)) addToolArtifacts(el, extractArtifactPaths(result), quiet);
  } catch {}
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function addCompareFrame(m) {
  const div = document.createElement('div'); div.className = 'msg system';
  const fld = m.field || '(默认)';
  const ts = (m.timeStep === null || m.timeStep === undefined || m.timeStep === '') ? '(默认时间步)' : ('t-idx ' + m.timeStep);
  div.innerHTML = `<div class="bubble" style="max-width:96%;">
    <div class="muted small" style="margin-bottom:4px;">📊 算例对比 · 场: ${escapeHtml(fld)} · ${escapeHtml(ts)}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;">
      <div style="flex:1;min-width:280px;">
        <div class="small" style="text-align:center;color:#a78bfa;margin-bottom:2px;">A · ${escapeHtml(m.a.label || '')}</div>
        <img src="${m.a.dataUrl}" style="width:100%;border:1px solid #6b21a8;border-radius:4px;cursor:zoom-in;" onclick="window.open(this.src,'_blank')" />
      </div>
      <div style="flex:1;min-width:280px;">
        <div class="small" style="text-align:center;color:#22d3ee;margin-bottom:2px;">B · ${escapeHtml(m.b.label || '')}</div>
        <img src="${m.b.dataUrl}" style="width:100%;border:1px solid #0e7490;border-radius:4px;cursor:zoom-in;" onclick="window.open(this.src,'_blank')" />
      </div>
    </div>
  </div>`;
  $('chat').appendChild(div); scrollChat();
}
function renderApproval(m) {
  const div = document.createElement('div'); div.className = 'approval';
  const cmd = m.args.command || `${m.args.case_path || ''} → ${m.args.command || ''}`;
  div.innerHTML = `<p>⚠ 智能体请求：<b></b></p><button class="ok">允许</button><button class="no">拒绝</button>`;
  div.querySelector('b').textContent = `${m.name}: ${cmd}`;
  div.querySelector('.ok').onclick = () => { ws.send(JSON.stringify({ type:'approval', approved:true })); div.remove(); };
  div.querySelector('.no').onclick = () => { ws.send(JSON.stringify({ type:'approval', approved:false })); div.remove(); };
  $('chat').appendChild(div); scrollChat();
}
function addTerm(line, cls) {
  const div = document.createElement('div');
  div.className = 'term-line' + (cls ? ' ' + cls : '');
  if (line.startsWith('$ ') || line.startsWith('> ')) div.classList.add('cmd');
  if (line.startsWith('[')) div.classList.add('sys');
  div.textContent = line; $('terminal').appendChild(div);
  while ($('terminal').childElementCount > 800) $('terminal').firstChild.remove();
  $('terminal').scrollTop = $('terminal').scrollHeight;
}

function renderTree(tree) { $('tree').innerHTML = ''; if (!tree?.children) return; $('tree').appendChild(renderNode(tree, true, 0)); refreshFlat(); }
function treeIcon(name) {
  const lower = (name || '').toLowerCase();
  if (/\.pdf$/.test(lower)) return 'book';
  if (/\.(png|jpe?g|gif|webp|bmp|svg|ico)$/.test(lower)) return 'image';
  if (/\.(stl|obj|vtu|vtp|vti|vtk|vtm|pvd)$/.test(lower)) return 'cube';
  if (/\.(csv|dat|xy)$/.test(lower)) return 'chart';
  if (/\.(py|js|ts|jsx|tsx|cpp|c|h|hpp|f90|f|cu|rs|go|java|sh)$/.test(lower)) return 'terminal';
  return 'file';
}
function setTreeLabel(el, icon, name, chevron) {
  el.innerHTML = `${chevron === undefined ? '<span class="tree-chev-pad"></span>' : `<svg class="ico sm tree-chev${chevron ? ' open' : ''}"><use href="#i-chevron"/></svg>`}<svg class="ico sm tree-ico"><use href="#i-${icon}"/></svg><span class="tree-name"></span>`;
  el.querySelector('.tree-name').textContent = name;
  el.title = name;
}
function renderNode(node, isRoot, depth) {
  depth = depth || 0;
  const wrap = document.createElement('div');
  if (!isRoot) {
    const el = document.createElement('div'); el.className = 'tree-node ' + node.type;
    el.dataset.path = node.path;
    el.style.paddingLeft = (8 + depth * 14) + 'px';
    if (node.type === 'file') {
      setTreeLabel(el, treeIcon(node.name), node.name);
      el.onclick = () => openFile(node.path);
    }
    if (node.type === 'dir') {
      // 默认折叠，顶层（depth=0）展开
      let exp = (depth === 0);
      const ch = document.createElement('div'); ch.className = 'tree-children';
      ch.style.display = exp ? '' : 'none';
      setTreeLabel(el, 'folder', node.name, exp);
      let loaded = false;
      const loadChildren = () => { if (loaded) return; loaded = true;
        (node.children || []).forEach(c => ch.appendChild(renderNode(c, false, depth + 1)));
      };
      if (exp) loadChildren();
      el.onclick = () => {
        exp = !exp;
        if (exp) loadChildren();
        ch.style.display = exp ? '' : 'none';
        el.querySelector('.tree-chev')?.classList.toggle('open', exp);
      };
      wrap.appendChild(el); wrap.appendChild(ch); return wrap;
    }
    wrap.appendChild(el); return wrap;
  }
  (node.children || []).forEach(c => wrap.appendChild(renderNode(c, false, 0)));
  return wrap;
}
function renderPending(list) {
  if (!list.length) { $('pending-bar').style.display = 'none'; $('pending-list').innerHTML = ''; return; }
  $('pending-bar').style.display = ''; $('pending-count').textContent = list.length; $('pending-list').innerHTML = '';
  [...list].reverse().forEach(e => {
    const d = document.createElement('div'); d.className = 'pending-item';
    const badge = e.action === 'create' ? 'create' : 'edit';
    const lbl = e.action === 'create' ? '新建' : (e.action === 'edit' ? '编辑' : '写入');
    d.innerHTML = `<div class="row1"><span class="badge ${badge}">${lbl}</span><span class="pname"></span></div>
      <div class="row2"><button class="mini" data-act="diff">差异</button><button class="mini" data-act="open">打开</button><button class="mini ok" data-act="keep">保留</button><button class="mini no" data-act="undo">撤销</button></div>`;
    d.querySelector('.pname').textContent = e.path;
    d.querySelector('[data-act="keep"]').onclick = () => ws.send(JSON.stringify({type:'keep_edit', id:e.id}));
    d.querySelector('[data-act="undo"]').onclick = () => { ws.send(JSON.stringify({type:'undo_edit', id:e.id})); reloadOpenFile(e.path); };
    d.querySelector('[data-act="open"]').onclick = () => openFile(e.path);
    d.querySelector('[data-act="diff"]').onclick = () => showDiff(e);
    $('pending-list').appendChild(d);
  });
  list.forEach(e => reloadOpenFile(e.path));
}
function renderTodos(list) {
  const sum = $('todo-summary');
  // D2: TodoPill — composer 上方实时显示活动待办数
  const pill = $('todo-pill');
  if (!list?.length) {
    $('todos').innerHTML = '<div class="muted small empty-line">智能体制定计划后会显示在这里</div>';
    if (sum) sum.textContent = '';
    if (pill) pill.style.display = 'none';
    return;
  }
  const done = list.filter(t => t.done).length;
  const undone = list.length - done;
  if (sum) sum.textContent = `${done}/${list.length}`;
  // TodoPill: 有未完成待办时显示
  if (pill) {
    if (undone > 0) {
      pill.style.display = 'flex';
      pill.innerHTML = `<svg class="ico sm" aria-hidden="true"><use href="#i-list"/></svg><span>${undone} 项进行中</span><span class="tp-progress">${done}/${list.length}</span>`;
      pill.onclick = () => { setPanelVisible('todos', true); };
    } else {
      pill.style.display = 'none';
    }
  }
  $('todos').innerHTML = `<div class="todo-progress"><span style="width:${(done / list.length * 100).toFixed(1)}%"></span></div>`;
  const current = list.findIndex(t => !t.done);
  list.forEach((t, i) => { const d = document.createElement('div'); d.className = 'todo-item' + (t.done ? ' done' : '') + (i === current ? ' current' : '');
    d.innerHTML = `<span class="todo-check">${t.done ? '<svg class="ico sm"><use href="#i-check"/></svg>' : ''}</span><span class="text"></span>`;
    d.querySelector('.text').textContent = t.text; $('todos').appendChild(d); });
}
$('keep-all').onclick = () => ws.send(JSON.stringify({type:'keep_all'}));
$('undo-all').onclick = () => { if (confirm('撤销全部？')) ws.send(JSON.stringify({type:'undo_all'})); };

// ─── Checkpoints 渲染（P0 bug 修复：case 'checkpoints' 之前直接 break）───
function renderCheckpoints(list) {
  const sec = document.getElementById('live-checkpoints'); if (!sec) return;
  if (!list?.length) { sec.hidden = true; return; }
  sec.hidden = false;
  sec.innerHTML = `<div class="live-cp-head"><b>检查点</b><span class="small muted">${list.length} 个</span></div>`;
  const cp = document.createElement('div'); cp.className = 'checkpoints';
  list.slice().reverse().forEach(c => {
    const d = document.createElement('div'); d.className = 'cp-item';
    const ago = Math.floor((Date.now() - c.timestamp) / 60000);
    const agoStr = ago < 1 ? '刚才' : ago < 60 ? `${ago} 分钟前` : `${Math.floor(ago/60)} 小时前`;
    d.innerHTML = `<div class="label"></div><div class="meta-row"><span>${agoStr} · ${c.fileCount} 文件</span><button type="button" data-id="${_escHtmlBasic(c.id)}">回滚</button></div>`;
    d.querySelector('.label').textContent = c.label;
    d.querySelector('button').onclick = () => {
      if (!confirm(`回滚到「${c.label}」？这会恢复该检查点之后修改的所有文件。`)) return;
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'restore_checkpoint', id: c.id }));
    };
    cp.appendChild(d);
  });
  sec.appendChild(cp);
}

let currentDiffEdit = null;
async function showDiff(edit) {
  await monacoReady; currentDiffEdit = edit;
  $('diff-title').textContent = `${edit.action === 'create' ? '新建' : '修改'} · ${edit.path}`;
  $('diff-modal').style.display = '';
  if (!diffEditor) diffEditor = monaco.editor.createDiffEditor($('diff-editor'), { theme: 'vs-dark', automaticLayout: true, readOnly: true, renderSideBySide: true, fontSize: 12 });
  const lang = detectLang(edit.path);
  diffEditor.setModel({ original: monaco.editor.createModel(edit.oldContent || '', lang), modified: monaco.editor.createModel(edit.newContent || '', lang) });
}
$('diff-close').onclick = () => { $('diff-modal').style.display = 'none'; currentDiffEdit = null; };
$('diff-keep').onclick = () => { if (currentDiffEdit) ws.send(JSON.stringify({type:'keep_edit', id:currentDiffEdit.id})); $('diff-modal').style.display='none'; currentDiffEdit=null; };
$('diff-undo').onclick = () => { if (currentDiffEdit) { ws.send(JSON.stringify({type:'undo_edit', id:currentDiffEdit.id})); reloadOpenFile(currentDiffEdit.path); } $('diff-modal').style.display='none'; currentDiffEdit=null; };

function scrollChat() { $('chat').scrollTop = $('chat').scrollHeight; saveChatHistory(); }

// ====================== 聊天历史本地持久化（刷新页面恢复） ======================
const CHAT_HISTORY_KEY = 'codemax.chatHistory.v1';
const CHAT_HISTORY_MAX = 800_000; // ~800 KB innerHTML 上限
let _chatSaveTimer = 0;
function saveChatHistory() {
  if (_chatSaveTimer) return;
  _chatSaveTimer = setTimeout(() => {
    _chatSaveTimer = 0;
    try {
      const chat = $('chat'); if (!chat) return;
      let html = chat.innerHTML || '';
      if (html.length > CHAT_HISTORY_MAX) html = html.slice(html.length - CHAT_HISTORY_MAX);
      localStorage.setItem(CHAT_HISTORY_KEY, html);
    } catch {}
  }, 600);
}
function clearChatHistory() { try { localStorage.removeItem(CHAT_HISTORY_KEY); } catch {} }
function restoreChatHistory() {
  // v10.1: 对话历史改为服务端任务持久化（task_history 事件回放，模型上下文一并恢复），
  // 不再用 localStorage 的 HTML 快照（只有视觉没有上下文，还会和服务端回放双重渲染）。
  try { localStorage.removeItem(CHAT_HISTORY_KEY); } catch {}
}
restoreChatHistory();

// ====================== 任务管理（服务端持久化，跨刷新/换模型/重启） ======================
const TASKS_UI = { list: [], currentId: null, lastHistoryTask: null };
function renderTaskBar() {
  const sel = $('task-select'); if (!sel) return;
  sel.innerHTML = TASKS_UI.list.map(t => {
    const d = new Date(t.updatedAt || 0);
    const tm = `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    const recoveryLabels = { pending: '等待恢复', running: '恢复中', failed: '需人工处理', exhausted: '重试已用尽' };
    const recoveryLabel = recoveryLabels[t.recovery?.status];
    const state = recoveryLabel ? ` · ${recoveryLabel}${t.recovery.nextAt ? ' ' + new Date(t.recovery.nextAt).toLocaleTimeString() : ''}` : '';
    return `<option value="${escapeHtml(String(t.id))}"${t.id === TASKS_UI.currentId ? ' selected' : ''}>${escapeHtml(t.title || '新任务')} · ${tm}${escapeHtml(state)}</option>`;
  }).join('');
  const task = TASKS_UI.list.find(item => item.id === TASKS_UI.currentId);
  $('auto-mode').disabled = typeof task?.autoMode !== 'boolean';
  $('auto-mode').checked = task?.autoMode === true;
  try { renderAgentChrome(task); } catch {}
}
function replayTaskHistory(m) {
  // 运行中且同一任务 → 不重建（避免抹掉正在流式输出的气泡）；stop 按钮可用 = 正在运行
  const isRunning = !$('stop').disabled;
  if (isRunning && TASKS_UI.lastHistoryTask === m.taskId && !connect._resync) return;
  TASKS_UI.lastHistoryTask = m.taskId;
  connect._resync = false;
  const chat = $('chat'); chat.innerHTML = ''; toolEls.clear();
  currentAssistantBubble = null; currentReasoningBubble = null;
  resetArtifacts();
  for (const e of (m.events || [])) {
    if (e.k === 'user') { const d = addUser(e.text, []); if (Number.isInteger(e.ui)) d.dataset.ui = String(e.ui); }
    else if (e.k === 'ai') { const b = addAssistantBubble(); b._raw = e.text; renderMarkdownInto(b, e.text); }
    else if (e.k === 'tool') {
      let args = {}; try { args = JSON.parse(e.args || '{}'); } catch { args = { _raw: (e.args || '').slice(0, 200) }; }
      const el = renderTool('h_' + Math.random().toString(36).slice(2), e.name, args);
      if (e.result !== undefined) finishTool(el, e.name, e.result, isToolError(e.result), true);
    } else if (e.k === 'sys') addSystem(e.text);
  }
  if ((m.events || []).length) { const d = document.createElement('div'); d.className = 'history-divider'; d.textContent = '以上为已保存的历史，模型上下文已恢复'; chat.appendChild(d); }
  else chat.appendChild(buildWelcome());
  if (m.canRedo) window.FX?.showRedo?.();
  chat.scrollTop = chat.scrollHeight;
}
if ($('task-select')) {
  $('task-select').onchange = () => { const id = $('task-select').value; if (id && id !== TASKS_UI.currentId) ws.send(JSON.stringify({ type: 'task_switch', id })); };
  $('task-new').onclick = () => {
    ws.send(JSON.stringify({ type: 'task_new', title: '' }));
    setTimeout(() => $('input').focus(), 50);
  };
}

// ====================== 求解器监测面板 ======================
const SM = { runId: '', timer: null, snapTimer: 0, snaps: [], lastSnapTime: -1, lastResidSig: '' };
const SM_TONE = { '#a3e635': 'var(--ok)', '#fca5a5': 'var(--danger)', '#fbbf24': 'var(--warn)' };
function smSetStatus(s, color) { const el = $('sm-status'); if (!el) return; el.textContent = s; el.style.color = SM_TONE[color] || color || ''; }
function smPreferredRun(runs, taskId, current) {
  if (current && runs.some(run => run.runId === current)) return current;
  const owned = taskId ? runs.filter(run => run.ownerTaskId === taskId) : [];
  const active = owned.filter(run => run.running);
  return active.length === 1 ? active[0].runId : owned.length === 1 ? owned[0].runId : '';
}
async function smRefreshRuns() {
  try {
    const r = await fetch('/api/foam/runs'); const j = await r.json();
    const sel = $('sm-run'); if (!sel) return;
    const cur = sel.value;
    const runs = j.runs || [];
    sel.innerHTML = '<option value="">选择作业</option>' +
      runs.map(x => `<option value="${escapeHtml(String(x.runId))}">${escapeHtml(String(x.command || '').slice(0,30))} · ${x.running?'运行中':'已结束'}</option>`).join('');
    const preferred = smPreferredRun(runs, TASKS_UI.currentId, cur);
    sel.value = preferred;
    if (preferred !== SM.runId) sel.dispatchEvent(new Event('change'));
  } catch (e) { /* 忽略 */ }
}
// 残差曲线绘制（log10 自动缩放，多场叠加）
const RESID_COLORS = ['#111111','#2563eb','#d97706','#059669','#dc2626','#7c3aed','#0891b2','#db2777','#65a30d','#6b7280'];
function smDrawResidChart(series, fields) {
  const cv = $('sm-resid-canvas'); const lg = $('sm-resid-legend');
  if (!cv || !lg) return;
  if (!series || series.length < 2 || !fields || !fields.length) {
    cv.style.display = 'none'; lg.style.display = 'none'; return;
  }
  cv.style.display = ''; lg.style.display = 'flex';
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 360, h = cv.clientHeight || 120;
  if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,w,h);
  // 选最多 6 个场（按方差大的优先）；过滤无效值
  const fldList = fields.slice(0, 6);
  // y 轴：log10(initial residual)
  let ymin = Infinity, ymax = -Infinity;
  const xs = series.map(s => s.t);
  const xmin = xs[0], xmax = xs[xs.length-1] || (xmin+1);
  const lines = fldList.map(f => {
    const pts = [];
    for (const s of series) { const v = s[f]; if (typeof v === 'number' && isFinite(v) && v > 0) pts.push([s.t, Math.log10(v)]); }
    pts.forEach(p => { if (p[1] < ymin) ymin = p[1]; if (p[1] > ymax) ymax = p[1]; });
    return { f, pts };
  });
  if (!isFinite(ymin) || !isFinite(ymax)) { cv.style.display = 'none'; lg.style.display = 'none'; return; }
  if (ymin === ymax) { ymin -= 1; ymax += 1; }
  const pad = { l: 40, r: 10, t: 10, b: 20 };
  const W = w - pad.l - pad.r, H = h - pad.t - pad.b;
  const sx = t => pad.l + (xmax > xmin ? (t - xmin) / (xmax - xmin) * W : W/2);
  const sy = y => pad.t + (1 - (y - ymin) / (ymax - ymin)) * H;
  // 网格 + log 标签
  ctx.strokeStyle = '#ececec'; ctx.lineWidth = 1; ctx.font = '11px ui-monospace, Consolas, monospace'; ctx.fillStyle = '#8a8a8a';
  for (let yv = Math.ceil(ymin); yv <= Math.floor(ymax); yv++) {
    const py = sy(yv);
    ctx.beginPath(); ctx.moveTo(pad.l, py); ctx.lineTo(pad.l + W, py); ctx.stroke();
    ctx.fillText(`1e${yv}`, 4, py + 4);
  }
  // x 轴
  ctx.fillText(`t=${xmin.toPrecision(4)}`, pad.l, h - 5);
  const xl = `t=${xmax.toPrecision(4)}`;
  ctx.fillText(xl, pad.l + W - ctx.measureText(xl).width, h - 5);
  // 各场曲线
  lg.innerHTML = '';
  lines.forEach((ln, i) => {
    const c = RESID_COLORS[i % RESID_COLORS.length];
    if (ln.pts.length < 2) return;
    ctx.strokeStyle = c; ctx.lineWidth = 1.6; ctx.beginPath();
    ln.pts.forEach((p, k) => { const x = sx(p[0]), y = sy(p[1]); if (k === 0) ctx.moveTo(x,y); else ctx.lineTo(x,y); });
    ctx.stroke();
    const span = document.createElement('span');
    span.className = 'resid-key';
    span.innerHTML = `<i style="background:${c}"></i>${escapeHtml(ln.f)}`;
    lg.appendChild(span);
  });
}

async function smPoll() {
  if (!SM.runId) { $('sm-tail').textContent = '(未选择作业)'; $('sm-summary').textContent = '未选择作业。'; smSetStatus('空闲'); smDrawResidChart(null, null); return; }
  try {
    const r = await fetch('/api/foam/run/' + encodeURIComponent(SM.runId));
    if (!r.ok) { smSetStatus('未知 runId', '#fca5a5'); return; }
    const j = await r.json();
    const dur = ((j.ended || Date.now()) - j.started) / 1000;
    smSetStatus(j.running ? '运行中' : `已结束(exit=${j.exitCode})`, j.running ? '#a3e635' : (j.exitCode === 0 ? '#a3e635' : '#fca5a5'));
    // trends 摘要拼到 summary 行
    const trendStr = j.trends ? Object.entries(j.trends).slice(0,4).map(([k,v]) => `${k}:${v.status||'?'}`).join('  ') : '';
    $('sm-summary').textContent = `cmd: ${j.command} · 用时 ${dur.toFixed(1)}s · Time=${j.lastTime || '?'} · ${trendStr}`;
    // 进度条 + ETA
    try {
      const pg = j.progress || null;
      const wrap = $('sm-progress-wrap');
      if (wrap) {
        if (pg && (pg.percent != null || pg.phase)) {
          wrap.style.display = 'flex';
          const pct = pg.percent != null ? Math.max(0, Math.min(100, pg.percent)) : 0;
          $('sm-progress-bar').style.width = pct.toFixed(1) + '%';
          const phaseTxt = pg.phase ? ` · 阶段 ${pg.phase}` : '';
          const curT = pg.currentTime != null ? ` · t=${Number(pg.currentTime).toFixed(4)}` : '';
          const endT = pg.endTime != null ? `/${pg.endTime}` : '';
          $('sm-progress-label').textContent = `进度 ${pct.toFixed(1)}%${phaseTxt}${curT}${endT}`;
          if (pg.etaSec != null && pg.etaSec >= 0) {
            const s = Math.round(pg.etaSec);
            const hh = Math.floor(s/3600), mm = Math.floor((s%3600)/60), ss = s%60;
            const txt = hh > 0 ? `${hh}h${mm}m${ss}s` : (mm > 0 ? `${mm}m${ss}s` : `${ss}s`);
            const rate = pg.simRate ? `  速率 ${pg.simRate.toExponential(2)} sim/s` : '';
            $('sm-progress-eta').textContent = `ETA ${txt}${rate}`;
          } else if (j.ended) {
            $('sm-progress-eta').textContent = '已完成';
          } else {
            $('sm-progress-eta').textContent = 'ETA - ';
          }
        } else {
          wrap.style.display = 'none';
        }
      }
    } catch {}
    smDrawResidChart(j.series || [], j.fields || []);
    const block = [
      '--- 最近残差 (' + (j.residuals?.length || 0) + ') ---',
      ...(j.residuals || []),
      '',
      '--- 日志 tail (' + (j.tail?.length || 0) + ') ---',
      ...(j.tail || [])
    ].join('\n');
    $('sm-tail').textContent = block;
    $('sm-tail').scrollTop = $('sm-tail').scrollHeight;
    // 自动快照逻辑
    if (j.running && $('sm-snap-auto') && $('sm-snap-auto').checked) {
      const sig = j.lastTime || '';
      // 仅当 lastTime 推进时才考虑抓帧（否则纯日志刷屏没意义）
      if (sig && sig !== SM.lastResidSig) { SM.lastResidSig = sig; }
    }
  } catch (e) { smSetStatus('网络错误', '#fca5a5'); }
}
function smRestartTimer() {
  if (SM.timer) { clearInterval(SM.timer); SM.timer = null; }
  if ($('sm-auto').checked && SM.runId) {
    const sec = Math.max(2, parseInt($('sm-interval').value, 10) || 5);
    SM.timer = setInterval(smPoll, sec * 1000);
  }
}

// ============== 快照演化轴 ==============
function smRenderSnapStrip() {
  const strip = $('sm-snap-strip'); if (!strip) return;
  if (!SM.snaps.length) {
    strip.innerHTML = '<div class="muted small" style="padding:8px;">求解过程中拍快照或开启自动快照，点缩略图放大对比。</div>';
    return;
  }
  strip.innerHTML = '';
  SM.snaps.forEach((s, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'snap-thumb';
    wrap.title = `t=${s.t}  field=${s.field}\n${s.casePath}`;
    wrap.innerHTML = `<img src="${s.dataUrl}" alt="" /><span>${escapeHtml(String(s.label))}</span>`;
    wrap.onclick = () => smShowSnapModal(idx);
    strip.appendChild(wrap);
  });
}
function smShowSnapModal(idx) {
  const s = SM.snaps[idx]; if (!s) return;
  // 简单大图查看 + 左右切换 + 与上一帧对比按钮
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.45);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;';
  const card = document.createElement('div');
  card.style.cssText = 'background:#fff;padding:14px;border-radius:14px;border:1px solid #e5e5e5;box-shadow:0 24px 80px rgba(0,0,0,.25);max-width:92vw;max-height:92vh;display:flex;flex-direction:column;gap:10px;';
  let cur = idx;
  function render() {
    const s = SM.snaps[cur];
    card.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;color:#141414;font-size:14px;font-weight:600;">
      <span>${cur+1}/${SM.snaps.length} · ${escapeHtml(String(s.label))} · ${escapeHtml(String(s.field))} · ${escapeHtml(String(s.casePath))}</span>
      <button id="snap-close" class="mini">关闭</button>
    </div>
    <img src="${s.dataUrl}" style="max-width:88vw;max-height:75vh;object-fit:contain;border:1px solid #ececec;border-radius:8px;" />
    <div style="display:flex;gap:6px;justify-content:center;">
      <button class="mini" id="snap-prev">上一帧</button>
      <button class="mini" id="snap-next">下一帧</button>
      <button class="mini" id="snap-cmp" ${cur===0?'disabled':''}>vs 上一帧</button>
      <button class="mini" id="snap-del" style="background:rgba(239,68,68,.2);border-color:#dc2626;color:#fca5a5;">删除</button>
    </div>`;
    card.querySelector('#snap-close').onclick = () => overlay.remove();
    card.querySelector('#snap-prev').onclick = () => { if (cur > 0) { cur--; render(); } };
    card.querySelector('#snap-next').onclick = () => { if (cur < SM.snaps.length-1) { cur++; render(); } };
    card.querySelector('#snap-cmp').onclick = () => {
      if (cur === 0) return;
      const prev = SM.snaps[cur-1], curS = SM.snaps[cur];
      addCompareFrame({ field: curS.field, timeStep: '', a: { dataUrl: prev.dataUrl, label: prev.label }, b: { dataUrl: curS.dataUrl, label: curS.label } });
      overlay.remove();
    };
    card.querySelector('#snap-del').onclick = () => {
      SM.snaps.splice(cur, 1); smRenderSnapStrip();
      if (!SM.snaps.length) overlay.remove();
      else { if (cur >= SM.snaps.length) cur = SM.snaps.length - 1; render(); }
    };
  }
  render();
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  overlay.appendChild(card); document.body.appendChild(overlay);
}
async function smCaptureSnapshot() {
  if (!SM.runId) { addSystem('请先选择 runId 才能抓快照'); return; }
  try {
    const rj = await (await fetch('/api/foam/run/' + encodeURIComponent(SM.runId))).json();
    const cd = rj.casePath; if (!cd) { addSystem('未拿到 case 路径'); return; }
    const field = ($('sm-snap-field').value || 'U').trim();
    const t = rj.lastTime || '';
    smSetStatus('抓快照中…', '#fbbf24');
    const r = await fetch('/api/sim/render', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ case_path: cd, field, time_step: -1, width: 480, height: 320 })
    });
    const j = await r.json();
    if (j.error) { addSystem('快照失败：' + j.error); smSetStatus('快照失败','#fca5a5'); return; }
    // sim_frame 已经被广播，但我们要拿到 dataUrl —— 直接复用 PV_STATE 不现实，重新拿一次原图
    // /api/sim/render 不返回 dataUrl，改用 sim_frame 监听
    // 简化：发起一个直接拿 dataUrl 的请求？此处利用 sim_frame 事件监听最新一帧
    smSetStatus('已抓帧（等帧广播）', '#a3e635');
  } catch (e) { addSystem('快照失败：' + e.message); smSetStatus('快照失败','#fca5a5'); }
}
// 监听 sim_frame：自动追加为快照（只在 sm-snap-auto 勾选 OR 用户主动点了 📸）
let _snapCaptureArmed = false;
function smArmCapture() { _snapCaptureArmed = true; setTimeout(() => _snapCaptureArmed = false, 8000); }
function smOnSimFrame(dataUrl, meta) {
  // 自动模式：每隔 N 秒抓一次（由定时器驱动）
  // 主动模式：smArmCapture 设置 _snapCaptureArmed=true 后下一帧入轴
  if (!_snapCaptureArmed && !($('sm-snap-auto') && $('sm-snap-auto').checked)) return;
  // 防抖：避免 PV 面板点几次刷新都被抓进来
  const last = SM.snaps[SM.snaps.length-1];
  if (last && Date.now() - last.captured < 1500) return;
  _snapCaptureArmed = false;
  const field = (meta && meta.field_used) || ($('sm-snap-field').value || 'U');
  const t = (meta && meta.time_value !== undefined && meta.time_value !== null) ? meta.time_value : '';
  const label = `t=${typeof t === 'number' ? t.toPrecision(4) : (t || '?')}`;
  SM.snaps.push({ dataUrl, field, t, label, casePath: (meta && meta.case_path) || '', captured: Date.now() });
  if (SM.snaps.length > 60) SM.snaps.shift();
  smRenderSnapStrip();
}

$('sm-refresh-runs') && ($('sm-refresh-runs').onclick = smRefreshRuns);
$('sm-run') && ($('sm-run').onchange = () => { SM.runId = $('sm-run').value; SM.snaps = []; SM.lastResidSig = ''; smRenderSnapStrip(); smPoll(); smRestartTimer(); });
$('sm-interval') && ($('sm-interval').addEventListener('input', () => { $('sm-interval-text').textContent = $('sm-interval').value + 's'; smRestartTimer(); }));
$('sm-auto') && ($('sm-auto').addEventListener('change', smRestartTimer));
$('sm-stop') && ($('sm-stop').onclick = async () => {
  if (!SM.runId) return;
  if (!confirm('终止 runId=' + SM.runId + ' ?')) return;
  await fetch('/api/foam/run/' + encodeURIComponent(SM.runId) + '/stop', { method: 'POST' });
  smPoll();
});
$('sm-snap-now') && ($('sm-snap-now').onclick = () => { smArmCapture(); smCaptureSnapshot(); });
$('sm-snap-clear') && ($('sm-snap-clear').onclick = () => { SM.snaps = []; smRenderSnapStrip(); });
// 自动快照定时器
function smRestartSnapTimer() {
  if (SM.snapTimer) { clearInterval(SM.snapTimer); SM.snapTimer = 0; }
  if ($('sm-snap-auto') && $('sm-snap-auto').checked) {
    const sec = Math.max(5, parseInt($('sm-snap-every').value, 10) || 30);
    SM.snapTimer = setInterval(() => { if (SM.runId) { smArmCapture(); smCaptureSnapshot(); } }, sec * 1000);
  }
}
$('sm-snap-auto') && ($('sm-snap-auto').addEventListener('change', smRestartSnapTimer));
$('sm-snap-every') && ($('sm-snap-every').addEventListener('change', smRestartSnapTimer));
// 启动时及每 8 秒拉一次作业列表
setTimeout(smRefreshRuns, 1500);
setInterval(smRefreshRuns, 8000);
smRenderSnapStrip();


// ====================== 工具开关 ======================
const TOOL_LABELS = {
  run_command: ['执行 shell / Python', 'shell'],
  web_search:  ['联网搜索（DDG→Bing→Baidu 级联）', 'web'],
  fetch_url:   ['抓取网页正文（含图片清单）', 'web'],
  image_search:['图片搜索（Bing Images，自动入图片库）', 'web'],
  download_file:['下载 URL 到 downloads/', 'web'],
  read_document:['读 PDF/DOCX/PPTX/XLSX/图片(OCR)', 'doc'],
  sim_run_openfoam:  ['OpenFOAM 命令', 'sim'],
  foam_find_tutorial: ['OpenFOAM 教程检索 (Beta)', 'foam'],
  foam_find_source:   ['OpenFOAM 源码检索 (Beta)', 'foam'],
  foam_clone_tutorial:['克隆 tutorial 到工作区 (Beta)', 'foam'],
  foam_inspect_case:  ['检查算例（BC/物性/递归文件清单）(Beta)', 'foam'],
  foam_run_solver_async: ['后台启动求解器 (Beta)', 'foam'],
  foam_solver_status:    ['查询求解器状态 (Beta)', 'foam'],
  foam_solver_stop:      ['中止求解器作业 (Beta)', 'foam']
};
let TOOL_STATE = { enabled: new Set(['run_command','web_search','fetch_url']) };
function renderToolsList() {
  const list = $('tools-list'); list.innerHTML = '';
  Object.entries(TOOL_LABELS).forEach(([name, [label, group]]) => {
    const id = 'tool-' + name;
    const wrap = document.createElement('label');
    wrap.className = 'tool-row';
    wrap.innerHTML = `<input type="checkbox" id="${id}" ${TOOL_STATE.enabled.has(name)?'checked':''}/> <span>${label}</span> <span class="tool-grp">${group}</span>`;
    wrap.querySelector('input').onchange = (e) => {
      if (e.target.checked) TOOL_STATE.enabled.add(name); else TOOL_STATE.enabled.delete(name);
      ws.send(JSON.stringify({ type: 'set_tools', tools: [...TOOL_STATE.enabled] }));
    };
    list.appendChild(wrap);
  });
}
$('tools-btn').onclick = () => { renderToolsList(); $('tools-modal').style.display = 'flex'; };
$('tools-close').onclick = $('tools-cancel').onclick = () => $('tools-modal').style.display = 'none';
// 初次连接后服务端会推 tools_state，由 onmessage 处理

// ====================== 图表取点器：用到时才加载 digitizer.js ======================
let _digitizerLoading = null;
function loadDigitizer() {
  if (window.NFDigitizer) return Promise.resolve(window.NFDigitizer);
  return _digitizerLoading ||= new Promise((resolve, reject) => {
    const sc = document.createElement('script'); sc.src = '/digitizer.js';
    sc.onload = () => resolve(window.NFDigitizer); sc.onerror = () => { _digitizerLoading = null; reject(new Error('digitizer.js 加载失败')); };
    document.head.appendChild(sc);
  });
}
async function openDigitizer(opts) {
  try { (await loadDigitizer()).open(opts); } catch (e) { addSystem('取点器打不开：' + e.message); }
}

// ====================== 模型选择 / GitHub Copilot / 阿里云 ======================
const MODEL_STATE = { provider: 'openai', sfModel: '', baseUrl: '', copilotModel: 'gpt-4.1', copilotLoggedIn: false, devicePoll: null };

function validApiBaseUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}
async function saveModelConfig(body) {
  try {
    const response = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok || !result.ok) { addSystem('配置保存失败，请检查 Base URL 和模型 ID'); return false; }
    return true;
  } catch { addSystem('配置保存失败，请检查连接后重试'); return false; }
}
function updateModelLabel() {
  const lab = $('model-label'); if (!lab) return;
  if (MODEL_STATE.provider === 'copilot') lab.textContent = 'Copilot:' + (MODEL_STATE.copilotModel || '?');
  else lab.textContent = MODEL_STATE.sfModel || '未配置';
}
const USAGE = { input: 0, output: 0, calls: 0, taskId: null };
function _resetUsageIfNewTask() {
  const cur = TASKS_UI?.currentId;
  if (cur && cur !== USAGE.taskId) { USAGE.input = 0; USAGE.output = 0; USAGE.calls = 0; USAGE.taskId = cur; }
}
function _updateChipTokens() {
  const lab = $('model-label'); if (!lab) return;
  const curT = TASKS_UI?.list?.find(t => t.id === TASKS_UI.currentId);
  const base = curT?.model || (MODEL_STATE.provider === 'copilot' ? 'Copilot:' + (MODEL_STATE.copilotModel || '?') : (MODEL_STATE.sfModel || '未配置'));
  // 紧凑格式：模型名 + 累计token
  const totalK = ((USAGE.input + USAGE.output) / 1000);
  if (totalK > 0) {
    lab.innerHTML = `${_escHtmlBasic(base)}<span class="chip-tokens"><span class="tok-up">${(USAGE.input/1000).toFixed(1)}k↑</span><span class="tok-sep"> · </span><span class="tok-down">${(USAGE.output/1000).toFixed(1)}k↓</span></span>`;
  } else {
    lab.textContent = base;
  }
  lab.parentElement.title = `模型：${base}\n本任务累计：输入 ${USAGE.input.toLocaleString()} tokens · 输出 ${USAGE.output.toLocaleString()} tokens · ${USAGE.calls} 次调用\n点击切换模型或配置 API Key`;
}
// 更新 Chip 上的上下文占比环（与 ctx-meter 联动）
function _updateChipRing(pct) {
  const fg = $('chip-ctx-fg'); if (!fg) return;
  // circumference for r=6: 2π×6 ≈ 37.7
  const circ = 37.7;
  const fill = (Math.min(pct, 100) / 100 * circ).toFixed(1);
  fg.setAttribute('stroke-dasharray', `${fill} ${circ}`);
  const ring = fg.closest('.chip-ctx-ring');
  if (ring) { ring.classList.toggle('warn', pct >= 60 && pct < 85); ring.classList.toggle('danger', pct >= 85); }
}
function showUsage(u) {
  if (!u) return;
  _resetUsageIfNewTask();
  USAGE.input += (u.prompt_tokens || u.input_tokens || 0);
  USAGE.output += (u.completion_tokens || u.output_tokens || 0);
  USAGE.calls += 1;
  _updateChipTokens();
}
async function refreshModelStatus() {
  try {
    const cfg = await (await fetch('/api/config')).json();
    MODEL_STATE.provider = cfg.provider || 'openai';
    MODEL_STATE.copilotModel = cfg.copilotModel || 'gpt-4.1';
    MODEL_STATE.copilotLoggedIn = !!cfg.copilotLoggedIn;
    MODEL_STATE.sfModel = cfg.model || '';
    MODEL_STATE.baseUrl = cfg.baseUrl || '';
    updateModelLabel();
  } catch {}
}
function selectModelTab(prov) {
  // v0.9.5: tabs removed; copilot pane toggled via mp-copilot-toggle
  if (prov === 'copilot') { const f = $('mp-copilot-form'); if (f && f.style.display === 'block') refreshCopilotPane(); }
}
async function refreshCopilotPane() {
  await refreshModelStatus();
  if ($('cp-loggedout')) $('cp-loggedout').style.display = MODEL_STATE.copilotLoggedIn ? 'none' : 'block';
  if ($('cp-loggedin')) $('cp-loggedin').style.display = MODEL_STATE.copilotLoggedIn ? 'block' : 'none';
  if (MODEL_STATE.copilotLoggedIn) await loadCopilotModels();
}
async function loadCopilotModels() {
  const list = $('cp-models');
  list.innerHTML = '<div class="muted small" style="padding:20px;text-align:center;">加载中…</div>';
  try {
    const r = await fetch('/api/copilot/models'); const j = await r.json();
    if (j.error) { list.innerHTML = `<div class="small" style="color:#fca5a5;padding:10px;white-space:pre-wrap;">${j.error}</div>`; return; }
    const models = j.models || [];
    if (!models.length) { list.innerHTML = '<div class="muted small" style="padding:20px;">没有可用模型（订阅可能不含 chat 权限）</div>'; return; }
    list.innerHTML = '';
    models.forEach(m => {
      const div = document.createElement('div');
      div.className = 'py-item' + (m.id === MODEL_STATE.copilotModel && MODEL_STATE.provider === 'copilot' ? ' current' : '');
      const tools = m.tool ? '<span class="py-conda">tools</span>' : '';
      div.innerHTML = `<div><span class="py-ver">${m.name}</span>${tools}</div><div class="py-path">${m.id} · ${m.vendor}</div>`;
      div.onclick = async () => {
        try {
          const r = await fetch('/api/copilot/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'copilot', model: m.id }) });
          const jj = await r.json();
          if (jj.ok) {
            MODEL_STATE.provider = 'copilot'; MODEL_STATE.copilotModel = m.id;
            updateModelLabel(); addTerm(`[Model] 已切换到 GitHub Copilot · ${m.id}`, 'ok');
            _mpClose();
          } else addSystem('切换失败：' + (jj.error || '未知'));
        } catch (e) { addSystem('切换失败：' + e.message); }
      };
      list.appendChild(div);
    });
  } catch (e) { list.innerHTML = `<div class="small" style="color:#fca5a5;padding:10px;">${e.message}</div>`; }
}
// ─── v0.9.5 模型选择器（OpenChamber 风格） ─────────────────────────────────
const MP_FAV_KEY = 'nullflux.mp_favs';
const MP_KNOWN = [
  // id, provider-group, label, ctx (k), baseUrlHint
  { id: 'claude-opus-5-5',       grp: 'Anthropic',     label: 'Claude Opus 5.5',       ctx: 200 },
  { id: 'claude-sonnet-4-5',     grp: 'Anthropic',     label: 'Claude Sonnet 4.5',     ctx: 200 },
  { id: 'claude-haiku-3-5',      grp: 'Anthropic',     label: 'Claude Haiku 3.5',      ctx: 200 },
  { id: 'gpt-4o',                grp: 'OpenAI',        label: 'GPT-4o',                ctx: 128 },
  { id: 'gpt-4o-mini',           grp: 'OpenAI',        label: 'GPT-4o mini',           ctx: 128 },
  { id: 'o3',                    grp: 'OpenAI',        label: 'o3',                    ctx: 200 },
  { id: 'o4-mini',               grp: 'OpenAI',        label: 'o4-mini',               ctx: 200 },
  { id: 'gemini-2.5-pro',        grp: 'Google',        label: 'Gemini 2.5 Pro',        ctx: 1000 },
  { id: 'gemini-2.0-flash',      grp: 'Google',        label: 'Gemini 2.0 Flash',      ctx: 1000 },
  { id: 'deepseek-chat',         grp: 'DeepSeek',      label: 'DeepSeek V3',           ctx: 64 },
  { id: 'deepseek-reasoner',     grp: 'DeepSeek',      label: 'DeepSeek R2',           ctx: 64 },
  { id: 'qwen-max',              grp: 'Alibaba',       label: 'Qwen Max',              ctx: 32 },
  { id: 'qwen-turbo',            grp: 'Alibaba',       label: 'Qwen Turbo',            ctx: 32 },
];
let _mpFavs = readUIStorage(MP_FAV_KEY, []);

function _mpClose() {
  $('model-modal').style.display = 'none';
  $('mp-backdrop').style.display = 'none';
  if (MODEL_STATE.devicePoll) { clearInterval(MODEL_STATE.devicePoll); MODEL_STATE.devicePoll = null; }
}
function _mpRender(filter) {
  const list = $('mp-list'); if (!list) return;
  const q = (filter || '').toLowerCase();
  const activeId = MODEL_STATE.provider === 'copilot' ? MODEL_STATE.copilotModel : MODEL_STATE.sfModel;

  // Build combined model list: current custom model + known + (favs on top)
  const allModels = [...MP_KNOWN];
  if (MODEL_STATE.sfModel && !allModels.find(m => m.id === MODEL_STATE.sfModel)) {
    allModels.unshift({ id: MODEL_STATE.sfModel, grp: '当前连接', label: MODEL_STATE.sfModel, ctx: null });
  }

  // Filter
  const visible = q ? allModels.filter(m => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q) || m.grp.toLowerCase().includes(q)) : allModels;

  // Group
  const favIds = new Set(_mpFavs);
  const groups = {};
  const favGroup = [];
  for (const m of visible) {
    if (favIds.has(m.id)) favGroup.push(m);
    const g = m.grp || '其他';
    if (!groups[g]) groups[g] = [];
    groups[g].push(m);
  }

  let html = '';
  function renderItem(m) {
    const isActive = m.id === activeId;
    const isFav = favIds.has(m.id);
    const ctxStr = m.ctx ? (m.ctx >= 1000 ? m.ctx + 'k' : m.ctx + 'k') : '';
    return `<div class="mp-item${isActive ? ' mp-active' : ''}" role="option" aria-selected="${isActive}" data-id="${_escHtmlBasic(m.id)}">
      <span class="mp-item-active">${isActive ? '✓' : ''}</span>
      <span class="mp-item-label">${_escHtmlBasic(m.label)}<span class="mp-item-id">${_escHtmlBasic(m.id)}</span></span>
      ${ctxStr ? `<span class="mp-item-ctx">${ctxStr}</span>` : ''}
      <button type="button" class="mp-fav${isFav ? ' mp-fav-on' : ''}" data-fav="${_escHtmlBasic(m.id)}" aria-label="${isFav ? '取消收藏' : '收藏'}" title="${isFav ? '取消收藏' : '收藏'}">★</button>
    </div>`;
  }

  if (!q && favGroup.length) {
    html += `<div class="mp-group-label">收藏</div>`;
    html += favGroup.map(renderItem).join('');
  }
  for (const [grp, items] of Object.entries(groups)) {
    if (!items.length) continue;
    html += `<div class="mp-group-label">${_escHtmlBasic(grp)}</div>`;
    html += items.map(renderItem).join('');
  }
  if (!visible.length) html = `<div class="mp-empty muted">没有匹配的模型</div>`;

  list.innerHTML = html;
  if (!list.querySelectorAll) return; // test-VM guard: no DOM available

  list.querySelectorAll('.mp-item').forEach(el => {
    el.onclick = async (e) => {
      if (e.target.closest('.mp-fav')) return;
      const id = el.dataset.id;
      if (MODEL_STATE.provider !== 'copilot') {
        const body = { provider: 'openai', model: id, baseUrl: MODEL_STATE.baseUrl || $('sf-baseurl')?.value || '' };
        if (!await saveModelConfig(body)) return;
        MODEL_STATE.sfModel = id; updateModelLabel();
        addTerm(`[Model] 已切换到 ${id}`, 'ok');
        _resetUsageIfNewTask();
      }
      _mpClose();
    };
  });
  list.querySelectorAll('.mp-fav').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = btn.dataset.fav;
      if (favIds.has(id)) { _mpFavs = _mpFavs.filter(x => x !== id); favIds.delete(id); }
      else { _mpFavs.push(id); favIds.add(id); }
      try { localStorage.setItem(MP_FAV_KEY, JSON.stringify(_mpFavs)); } catch {}
      _mpRender($('mp-search')?.value || '');
    };
  });
}

$('model-picker').onclick = async () => {
  const btn = $('model-picker');
  const popup = $('model-modal');
  // Position popup above/below the chip
  const rect = btn.getBoundingClientRect();
  const popH = 480;
  const top = (rect.top - popH - 8 > 0) ? (rect.top - popH - 8) : (rect.bottom + 8);
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - 332));
  popup.style.top = top + 'px';
  popup.style.left = left + 'px';
  popup.style.display = 'block';
  $('mp-backdrop').style.display = 'block';
  await refreshModelStatus();
  // Fill form fields
  try {
    const s = await (await fetch('/api/settings')).json();
    if ($('sf-apikey'))  $('sf-apikey').value  = (s.apiKey && !s.apiKey.startsWith('***')) ? s.apiKey : '';
    if ($('sf-baseurl')) $('sf-baseurl').value = s.baseUrl || '';
    if ($('sf-model'))   $('sf-model').value   = s.model || MODEL_STATE.sfModel || '';
    if ($('vlm-baseurl')) $('vlm-baseurl').value = s.visionBaseUrl || '';
    if ($('vlm-model'))   $('vlm-model').value   = s.visionModel || '';
    if ($('vlm-apikey'))  $('vlm-apikey').value  = (s.visionApiKey && !s.visionApiKey.startsWith('***')) ? s.visionApiKey : '';
  } catch {}
  _mpRender('');
  $('mp-search').focus();
};
$('mp-backdrop').onclick = _mpClose;
$('model-close').onclick = _mpClose;
$('mp-search').addEventListener('input', e => _mpRender(e.target.value));
$('mp-search').addEventListener('keydown', e => { if (e.key === 'Escape') _mpClose(); });
$('mp-custom-toggle').onclick = () => {
  const f = $('mp-custom-form');
  f.style.display = f.style.display === 'none' ? 'block' : 'none';
  if ($('mp-copilot-form')) $('mp-copilot-form').style.display = 'none';
};
$('mp-copilot-toggle').onclick = async () => {
  const f = $('mp-copilot-form');
  f.style.display = f.style.display === 'none' ? 'block' : 'none';
  if ($('mp-custom-form')) $('mp-custom-form').style.display = 'none';
  if (f.style.display === 'block') await refreshCopilotPane();
};
$('sf-apply').onclick = async () => {
  const model = $('sf-model').value.trim();
  const apiKey = $('sf-apikey').value.trim();
  const baseUrl = $('sf-baseurl').value.trim();
  if (!model) { addSystem('请填写模型 ID'); return; }
  if (!validApiBaseUrl(baseUrl)) { addSystem('请填写有效的 http(s) 接口地址（不能含用户名或密码）'); return; }
  const body = { provider: 'openai', model, baseUrl };
  if (apiKey) body.apiKey = apiKey;
  if (!await saveModelConfig(body)) return;
  MODEL_STATE.provider = 'openai'; MODEL_STATE.sfModel = model; MODEL_STATE.baseUrl = baseUrl;
  updateModelLabel(); addTerm(`[Model] 已切换到 ${model}`, 'ok');
  _mpClose();
};
// VLM 视觉模型保存
if ($('vlm-apply')) {
  $('vlm-apply').onclick = async () => {
    const body = {
      visionBaseUrl: $('vlm-baseurl').value.trim(),
      visionModel: $('vlm-model').value.trim()
    };
    if (body.visionBaseUrl && !validApiBaseUrl(body.visionBaseUrl)) { addSystem('请填有效的 http(s) VLM Base URL'); return; }
    if (body.visionBaseUrl && !body.visionModel) { addSystem('请填独立视觉模型 ID，或清空两项以继承主配置'); return; }
    const vk = $('vlm-apikey').value.trim();
    if (vk) body.visionApiKey = vk;
    if (!await saveModelConfig(body)) return;
    addTerm(`[VLM] 已保存视觉模型配置 · ${body.visionModel || '(继承主接口和模型)'}`, 'ok');
  };
}
$('cp-login').onclick = async () => {
  $('cp-login').disabled = true;
  try {
    const r = await fetch('/api/copilot/auth/start', { method:'POST' });
    const j = await r.json(); if (j.error) throw new Error(j.error);
    $('cp-uri').textContent = j.verification_uri; $('cp-uri').href = j.verification_uri;
    $('cp-code').textContent = j.user_code;
    $('cp-device').style.display = 'block';
    $('cp-poll-status').textContent = '等待你在浏览器完成授权…';
    MODEL_STATE.deviceCode = j.device_code;
    try { window.open(j.verification_uri, '_blank'); } catch {}
    if (MODEL_STATE.devicePoll) clearInterval(MODEL_STATE.devicePoll);
    let interval = Math.max(5, j.interval || 5) * 1000;
    const expiresAt = Date.now() + (j.expires_in || 900) * 1000;
    let inflight = false;
    const tick = async () => {
      if (inflight) return false; inflight = true;
      try {
        if (Date.now() > expiresAt) { stopPoll(); $('cp-poll-status').textContent = '⏳ 设备码过期，请重试'; $('cp-login').disabled = false; return false; }
        const r2 = await fetch('/api/copilot/auth/poll', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ device_code: MODEL_STATE.deviceCode }) });
        const j2 = await r2.json();
        if (j2.ok) {
          stopPoll();
          $('cp-poll-status').textContent = '✅ 登录成功'; $('cp-login').disabled = false;
          $('cp-device').style.display = 'none';
          MODEL_STATE.copilotLoggedIn = true; addTerm('[Copilot] GitHub 登录成功', 'ok');
          await refreshCopilotPane();
          return true;
        }
        if (j2.error === 'slow_down') {
          // RFC 8628: 轮询过快，间隔 +5s 后重新计时
          interval += 5000;
          $('cp-poll-status').textContent = `⏳ GitHub 限流，已降速到每 ${interval/1000}s 检查一次…`;
          if (MODEL_STATE.devicePoll) clearInterval(MODEL_STATE.devicePoll);
          MODEL_STATE.devicePoll = setInterval(tick, interval);
        } else if (j2.error === 'authorization_pending') {
          $('cp-poll-status').textContent = `等待你在浏览器完成授权…（每 ${interval/1000}s 检查一次）`;
        } else if (j2.error_description) {
          $('cp-poll-status').textContent = '… ' + j2.error_description;
        } else if (j2.error) {
          $('cp-poll-status').textContent = '⚠ ' + j2.error;
        }
      } catch (e) {
        $('cp-poll-status').textContent = '⚠ 网络抖动：' + e.message + '（点 "立即检查" 重试）';
      } finally { inflight = false; }
      return false;
    };
    function stopPoll() { if (MODEL_STATE.devicePoll) clearInterval(MODEL_STATE.devicePoll); MODEL_STATE.devicePoll = null; }
    MODEL_STATE.devicePoll = setInterval(tick, interval);
    MODEL_STATE.deviceTick = tick;
    MODEL_STATE.stopPoll = stopPoll;
  } catch (e) { $('cp-poll-status').textContent = '❌ ' + e.message; $('cp-login').disabled = false; }
};
$('cp-recheck').onclick = async () => {
  if (!MODEL_STATE.deviceCode) { $('cp-poll-status').textContent = '请先点击登录获取设备码'; return; }
  $('cp-poll-status').textContent = '正在检查…';
  if (MODEL_STATE.deviceTick) await MODEL_STATE.deviceTick();
};
$('cp-cancel').onclick = () => {
  if (MODEL_STATE.stopPoll) MODEL_STATE.stopPoll();
  MODEL_STATE.deviceCode = null;
  $('cp-device').style.display = 'none';
  $('cp-login').disabled = false;
};
$('cp-copy').onclick = () => { try { navigator.clipboard.writeText($('cp-code').textContent); $('cp-copy').textContent = '已复制'; setTimeout(()=>$('cp-copy').textContent='复制', 1500); } catch {} };
$('cp-refresh').onclick = () => loadCopilotModels();
$('cp-logout').onclick = async () => { await fetch('/api/copilot/logout', { method:'POST' }); MODEL_STATE.copilotLoggedIn = false; refreshCopilotPane(); addTerm('[Copilot] 已退出登录', 'sys'); };
refreshModelStatus();


// ====================== Codex 式外壳：侧栏任务 / 线程头 / 检查器 / 产物 ======================
const SHELL_KEY = 'nullflux.shell.v1';
const shellState = Object.assign({ sidebar: true, inspector: true, inspectorW: 460, sidebarW: 272, max: false }, readUIStorage(SHELL_KEY, {}));
let mobileSidebarOpen = false;
const narrowMQ = matchMedia('(max-width: 900px)');
function clampSidebarW(w) { return Math.round(Math.min(Math.max(200, w), 480)); }
function saveShell() { writeUIStorage(SHELL_KEY, { sidebar: shellState.sidebar, inspector: shellState.inspector, inspectorW: shellState.inspectorW, sidebarW: shellState.sidebarW, max: shellState.max }); }
function clampInspectorW(w) { return Math.round(Math.min(Math.max(320, w), Math.max(360, ($('desktop').clientWidth || 1200) - 380))); }
function applyShell() {
  const narrow = narrowMQ.matches;
  const cl = document.body.classList;
  cl.toggle('sidebar-hidden', !narrow && !shellState.sidebar);
  cl.toggle('sidebar-open', narrow && mobileSidebarOpen);
  cl.toggle('inspector-hidden', !shellState.inspector);
  cl.toggle('inspector-max', shellState.inspector && shellState.max);
  if (!narrow) {
    document.documentElement.style.setProperty('--inspector-w', clampInspectorW(shellState.inspectorW) + 'px');
    document.documentElement.style.setProperty('--sidebar-w', clampSidebarW(shellState.sidebarW) + 'px');
  } else {
    document.documentElement.style.removeProperty('--inspector-w');
    document.documentElement.style.removeProperty('--sidebar-w');
  }
  $('sidebar-scrim').hidden = !(narrow && mobileSidebarOpen);
  $('sidebar-toggle').hidden = !narrow && shellState.sidebar;
  $('inspector-toggle').setAttribute('aria-pressed', String(shellState.inspector));
  if (shellState.inspector) $('inspector-toggle').removeAttribute('data-badge');
  const maxBtn = $('inspector-max');
  maxBtn.setAttribute('aria-pressed', String(shellState.max));
  maxBtn.title = shellState.max ? '还原检查器' : '最大化检查器';
  maxBtn.querySelector('use').setAttribute('href', shellState.max ? '#i-collapse' : '#i-expand');
  requestAnimationFrame(() => { window.dispatchEvent(new Event('resize')); if (editor) editor.layout(); });
}
function toggleSidebar(force) {
  if (narrowMQ.matches) mobileSidebarOpen = force ?? !mobileSidebarOpen;
  else { shellState.sidebar = force ?? !shellState.sidebar; saveShell(); }
  applyShell();
}
function toggleInspector(force) {
  shellState.inspector = force ?? !shellState.inspector;
  if (!shellState.inspector) shellState.max = false;
  saveShell(); applyShell();
}
function revealInspector() { if (!shellState.inspector) toggleInspector(true); }
narrowMQ.addEventListener('change', () => { mobileSidebarOpen = false; applyShell(); });
// 手机打开时先显示对话（不写入持久化的桌面布局）
if (matchMedia('(max-width: 760px)').matches && shellState.inspector) { shellState.inspector = false; applyShell(); }
$('sidebar-collapse').onclick = () => toggleSidebar(false);
$('sidebar-toggle').onclick = () => toggleSidebar(true);
$('sidebar-scrim').onclick = () => toggleSidebar(false);
$('inspector-toggle').onclick = () => toggleInspector();
$('inspector-close').onclick = () => toggleInspector(false);
$('inspector-max').onclick = () => { shellState.max = !shellState.max; saveShell(); applyShell(); };

// ====================== Sidebar Peek (v0.9.3 — OpenChamber 对标) ======================
// 当侧栏收起时，鼠标悬停左边缘浮起预览（不真正打开，移开即收）
(() => {
  const zone = $('sidebar-peek-zone'); if (!zone) return;
  let peekTimer = null, hideTimer = null, peeking = false;
  function showPeek() {
    if (peeking) return;
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    peekTimer = setTimeout(() => {
      if (shellState.sidebar && !narrowMQ.matches) return; // 已展开则不需要 peek
      document.body.classList.add('sidebar-peek');
      peeking = true;
    }, 250);
  }
  function hidePeek() {
    if (peekTimer) { clearTimeout(peekTimer); peekTimer = null; }
    if (!peeking) return;
    hideTimer = setTimeout(() => {
      document.body.classList.remove('sidebar-peek');
      peeking = false;
    }, 200);
  }
  zone.addEventListener('mouseenter', showPeek);
  zone.addEventListener('mouseleave', hidePeek);
  // peek 时侧栏内鼠标移动 → 保持
  const sidebar = $('sidebar'); if (sidebar) {
    sidebar.addEventListener('mouseenter', () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } });
    sidebar.addEventListener('mouseleave', hidePeek);
  }
  // 点击 peek 中的任务 → 切换后收起 peek
  sidebar?.addEventListener('click', (e) => {
    if (peeking && e.target.closest('.task-main')) {
      document.body.classList.remove('sidebar-peek');
      peeking = false;
    }
  });
})();

// ====================== Command Palette (Ctrl+Shift+P) ======================
(() => {
  const CMD_ITEMS = [
    { label: '新建任务', hint: 'Ctrl+N', icon: 'compose', run: () => { ws.send(JSON.stringify({ type: 'task_new', title: '' })); setTimeout(() => $('input').focus(), 50); } },
    { label: '搜索任务', hint: 'Ctrl+K', icon: 'search', run: () => { $('task-search').focus(); } },
    { label: '切换侧栏', hint: 'Ctrl+B', icon: 'sidebar', run: () => toggleSidebar() },
    { label: '切换检查器', hint: 'Ctrl+I', icon: 'panel', run: () => toggleInspector() },
    { label: '规划模式', hint: '/plan', icon: 'terminal', run: () => { $('input').value = '/plan'; send(); } },
    { label: '执行模式', hint: '/build', icon: 'terminal', run: () => { $('input').value = '/build'; send(); } },
    { label: '设置会话目标', hint: '/goal', icon: 'activity', run: () => { openGoalDialog(''); } },
    { label: '分叉任务', hint: '/fork', icon: 'fork', run: () => { forkTask(); } },
    { label: '运行作业', hint: '/jobs', icon: 'activity', run: () => { setPanelVisible('live', true); } },
    { label: '算例总览', hint: '/case', icon: 'cube', run: () => { $('input').value = '/case'; $('input').focus(); } },
    { label: '切片可视化', hint: '/slice', icon: 'eye', run: () => { setPanelVisible('slice', true); } },
    { label: '几何预览', hint: '/geometry', icon: 'cube', run: () => { setPanelVisible('geometry', true); } },
    { label: '多模型对比', hint: '/compare', icon: 'chart', run: () => { window.MR?.openCompare(); } },
    { label: '图表取点', hint: '/digitize', icon: 'chart', run: () => { openDigitizer({ name: 'plot', hint: '从论文截图标注数据点' }); } },
    { label: '技能库', hint: '/skills', icon: 'book', run: () => { setPanelVisible('skills', true); } },
    { label: '压缩上下文', hint: '/compact', icon: 'refresh', run: () => { ws.send(JSON.stringify({ type: 'compact' })); addSystem('正在压缩上下文…'); } },
    { label: '切换模型', hint: '/model', icon: 'spark', run: () => { $('model-picker').click(); } },
    { label: '工具开关', hint: '/tools', icon: 'plug', run: () => { renderToolsList(); $('tools-modal').style.display = 'flex'; } },
    { label: 'Python 环境', hint: '/py', icon: 'terminal', run: () => { $('py-picker').click(); } },
    { label: '清空对话', hint: '/clear', icon: 'trash', run: () => { ws.send(JSON.stringify({ type: 'reset' })); $('chat').innerHTML = ''; toolEls.clear(); } },
    { label: '设置', hint: '', icon: 'settings', run: () => { openSettings?.('general'); } },
    { label: '外观设置', hint: '', icon: 'layout', run: () => { openSettings?.('appearance'); } },
    { label: '显示所有命令', hint: '/help', icon: 'info', run: () => { $('input').value = '/help'; send(); } },
  ];

  const palette = $('cmd-palette'); if (!palette) return;
  const input = $('cmd-input');
  const list = $('cmd-list');
  const overlay = $('cmd-overlay');
  let filtered = CMD_ITEMS.slice();
  let selIdx = 0;

  function render() {
    list.innerHTML = '';
    filtered = CMD_ITEMS.filter(c => {
      const q = input.value.trim().toLowerCase();
      if (!q) return true;
      return c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q);
    });
    if (!filtered.length) { list.innerHTML = '<div class="cmd-empty muted">没有匹配的命令</div>'; return; }
    filtered.forEach((c, i) => {
      const item = document.createElement('button');
      item.type = 'button'; item.className = 'cmd-item' + (i === selIdx ? ' active' : '');
      item.setAttribute('role', 'option');
      item.innerHTML = `<svg class="ico"><use href="#i-${c.icon}"/></svg><span class="cmd-label">${c.label}</span><span class="cmd-hint">${c.hint}</span>`;
      item.onclick = () => { close(); c.run(); };
      item.onmouseenter = () => { selIdx = i; updateActive(); };
      list.appendChild(item);
    });
    updateActive();
  }
  function updateActive() {
    list.querySelectorAll('.cmd-item').forEach((el, i) => el.classList.toggle('active', i === selIdx));
    const active = list.querySelector('.cmd-item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }
  function open() {
    palette.style.display = 'flex'; input.value = ''; selIdx = 0;
    requestAnimationFrame(() => input.focus());
    render();
  }
  function close() { palette.style.display = 'none'; }

  input.addEventListener('input', () => { selIdx = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); selIdx = Math.min(selIdx + 1, filtered.length - 1); updateActive(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); selIdx = Math.max(selIdx - 1, 0); updateActive(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (filtered[selIdx]) { close(); filtered[selIdx].run(); } }
  });
  overlay.onclick = close;

  // 注册 Ctrl+Shift+P
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
      e.preventDefault(); open();
    }
  });
  // 在设置面板的「快捷操作」里也能打开
  window.openCmdPalette = open;
})();
(() => {
  const handle = $('inspector-resizer'); let drag = null, raf = 0;
  const setW = w => { shellState.inspectorW = clampInspectorW(w); document.documentElement.style.setProperty('--inspector-w', shellState.inspectorW + 'px');
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; window.dispatchEvent(new Event('resize')); }); };
  handle.addEventListener('pointerdown', e => { drag = { x: e.clientX, w: shellState.inspectorW }; handle.setPointerCapture(e.pointerId); document.body.classList.add('resizing'); e.preventDefault(); });
  handle.addEventListener('pointermove', e => { if (drag) setW(drag.w - (e.clientX - drag.x)); });
  const end = () => { if (!drag) return; drag = null; document.body.classList.remove('resizing'); saveShell(); if (editor) editor.layout(); };
  handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
  handle.addEventListener('dblclick', () => { setW(460); saveShell(); });
  handle.addEventListener('keydown', e => { const d = e.key === 'ArrowLeft' ? 32 : e.key === 'ArrowRight' ? -32 : 0; if (!d) return; e.preventDefault(); setW(shellState.inspectorW + d); saveShell(); });
})();

// D1: 侧栏宽度拖拽
(() => {
  const handle = $('sidebar-resizer'); if (!handle) return;
  let drag = null, raf = 0;
  const setSW = w => {
    shellState.sidebarW = clampSidebarW(w);
    document.documentElement.style.setProperty('--sidebar-w', shellState.sidebarW + 'px');
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; window.dispatchEvent(new Event('resize')); });
  };
  handle.addEventListener('pointerdown', e => { drag = { x: e.clientX, w: shellState.sidebarW }; handle.setPointerCapture(e.pointerId); document.body.classList.add('resizing'); e.preventDefault(); });
  handle.addEventListener('pointermove', e => { if (drag) setSW(drag.w + (e.clientX - drag.x)); });
  const end = () => { if (!drag) return; drag = null; document.body.classList.remove('resizing'); saveShell(); };
  handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
  handle.addEventListener('dblclick', () => { setSW(272); saveShell(); });
  handle.addEventListener('keydown', e => { const d = e.key === 'ArrowRight' ? 16 : e.key === 'ArrowLeft' ? -16 : 0; if (!d) return; e.preventDefault(); setSW(shellState.sidebarW + d); saveShell(); });
})();
function markContextActivity(view) {
  if (contextView === view && shellState.inspector) return;
  document.querySelector(`[data-context-view="${view}"]`)?.setAttribute('data-badge', '');
  if (!shellState.inspector) $('inspector-toggle').setAttribute('data-badge', '');
}

// 时间显示
function fmtDuration(sec, compact) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return compact ? `${sec}s` : `${sec} 秒`;
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return compact ? `${m}m${String(s).padStart(2, '0')}s` : `${m} 分 ${s} 秒`;
  const h = Math.floor(m / 60);
  return compact ? `${h}h${String(m % 60).padStart(2, '0')}m` : `${h} 小时 ${m % 60} 分`;
}
function relTime(ts) {
  if (!ts) return '';
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return '刚刚';
  if (d < 3600) return `${Math.floor(d / 60)} 分钟`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时`;
  if (d < 7 * 86400) return `${Math.floor(d / 86400)} 天`;
  const t = new Date(ts); return `${t.getMonth() + 1}/${t.getDate()}`;
}

// 任务列表（侧栏）+ 线程头
function taskStatus(t, isCurrent) {
  const rec = t?.recovery?.status;
  if (isCurrent && !$('stop').disabled) return ['running', '运行中'];
  if (t?.running && !isCurrent) return ['bg-running', '后台运行'];
  if (t?.running) return ['running', '运行中'];
  if (rec === 'running') return ['running', '恢复中'];
  if (t?.jobs) return ['solving', `求解中 · ${t.jobs}`];
  if (rec === 'pending') return ['pending', '等待恢复'];
  if (rec === 'failed' || rec === 'exhausted') return ['error', '需人工处理'];
  return ['idle', '空闲'];
}
function renameTaskInline(t, row) {
  const main = row.querySelector('.task-main');
  const input = document.createElement('input'); input.className = 'task-rename-input'; input.value = t.title || ''; input.setAttribute('aria-label', '任务名称');
  main.replaceWith(input); row.querySelector('.task-actions')?.remove();
  input.focus(); input.select();
  let done = false;
  const finish = commit => { if (done) return; done = true; const v = input.value.trim();
    if (commit && v && v !== t.title) ws.send(JSON.stringify({ type: 'task_rename', id: t.id, title: v }));
    renderTaskList(); };
  input.onkeydown = e => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
  input.onblur = () => finish(true);
}
function deleteTask(t) {
  if (!confirm(`删除任务「${t.title || '新任务'}」？对话历史与上下文将永久删除。`)) return;
  ws.send(JSON.stringify({ type: 'task_delete', id: t.id }));
}
// 通知里的链接 /app#task=<id>：打开后切到对应任务（只处理一次）
function openTaskFromHash() {
  const m = /(?:^#|&)task=([^&]+)/.exec(location.hash || '');
  if (!m) return;
  const id = decodeURIComponent(m[1]);
  history.replaceState(null, '', location.pathname + location.search);
  if (TASKS_UI.list.some(t => t.id === id) && id !== TASKS_UI.currentId) ws.send(JSON.stringify({ type: 'task_switch', id }));
}
window.addEventListener('hashchange', openTaskFromHash);
function switchTask(id) {
  if (id === TASKS_UI.currentId) return;
  // v0.9：允许运行中切换任务（当前任务 agent 继续在后台跑，切回来可继续）
  ws.send(JSON.stringify({ type: 'task_switch', id }));
  if (narrowMQ.matches) toggleSidebar(false);
}
function renderTaskList() {
  const host = $('task-list'); if (!host) return;
  const q = ($('task-search').value || '').trim().toLowerCase();
  const items = TASKS_UI.list.filter(t => !q || String(t.title || '').toLowerCase().includes(q));
  $('task-count').textContent = TASKS_UI.list.length ? String(TASKS_UI.list.length) : '';
  host.innerHTML = '';
  if (!items.length) { const e = document.createElement('div'); e.className = 'task-empty'; e.textContent = q ? '没有匹配的任务' : '还没有任务'; host.appendChild(e); }
  for (const t of items) {
    const cur = t.id === TASKS_UI.currentId;
    const [state, label] = taskStatus(t, cur);
    const row = document.createElement('div'); row.className = 'task-item' + (cur ? ' active' : ''); row.setAttribute('role', 'listitem');
    row.innerHTML = `<button type="button" class="task-main"><span class="task-dot" data-state="${state}"></span><span class="task-name"></span><span class="task-time"></span></button>`
      + `<span class="task-actions"><button type="button" class="icon-btn" data-act="rename" aria-label="重命名" title="重命名"><svg class="ico sm"><use href="#i-edit"/></svg></button>`
      + `<button type="button" class="icon-btn" data-act="delete" aria-label="删除" title="删除"><svg class="ico sm"><use href="#i-trash"/></svg></button></span>`;
    row.querySelector('.task-name').textContent = t.title || '新任务';
    if (t.multiRun) { const b = document.createElement('span'); b.className = 'task-mr'; b.textContent = t.multiRun.fusion ? '综合' : `${t.multiRun.index}/${t.multiRun.of}`; b.title = '多模型运行 · 点开比较'; b.onclick = e => { e.stopPropagation(); window.MR?.openCompare(t.multiRun.group); }; row.querySelector('.task-name').after(b); }
    row.querySelector('.task-time').textContent = state === 'idle' ? relTime(t.updatedAt) : label;
    row.querySelector('.task-main').title = `${t.title || '新任务'}\n${label} · ${t.msgCount || 0} 条上下文${t.autoMode ? ' · 自主执行' : ''}`;
    if (cur) row.querySelector('.task-main').setAttribute('aria-current', 'true');
    row.querySelector('.task-main').onclick = () => switchTask(t.id);
    row.querySelector('[data-act="rename"]').onclick = () => renameTaskInline(t, row);
    row.querySelector('[data-act="delete"]').onclick = () => deleteTask(t);
    host.appendChild(row);
  }
  updateThreadHead();
}
function updateThreadHead() {
  const cur = TASKS_UI.list.find(t => t.id === TASKS_UI.currentId);
  const title = $('thread-title');
  if (title.getAttribute('contenteditable') !== 'true') title.textContent = cur?.title || '新任务';
  const [state, label] = taskStatus(cur, true);
  const pill = $('thread-status'); pill.dataset.state = state; pill.textContent = label;
  document.title = (state === 'running' ? '● ' : '') + (cur?.title ? `${cur.title} · NullFlux` : 'NullFlux');
}
$('task-search').addEventListener('input', renderTaskList);
$('task-search').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.target.value = ''; renderTaskList(); e.target.blur(); }
  else if (e.key === 'Enter') { const first = $('task-list').querySelector('.task-main'); if (first) first.click(); }
});
function renameCurrentTask() {
  const cur = TASKS_UI.list.find(t => t.id === TASKS_UI.currentId); if (!cur) return;
  const title = $('thread-title');
  title.setAttribute('contenteditable', 'true'); title.focus();
  const range = document.createRange(); range.selectNodeContents(title); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  let done = false;
  const finish = commit => { if (done) return; done = true; title.removeAttribute('contenteditable');
    const v = title.textContent.trim();
    if (commit && v && v !== cur.title) ws.send(JSON.stringify({ type: 'task_rename', id: cur.id, title: v }));
    updateThreadHead(); };
  title.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); } };
  title.onblur = () => finish(true);
}
$('thread-title').ondblclick = renameCurrentTask;
setInterval(() => { if (TASKS_UI.list.length && !$('task-list').querySelector('.task-rename-input')) renderTaskList(); }, 60_000);

// 产物：结果条 + 自动预览
const ARTIFACTS = [];
let turnArtifacts = [];
function resetArtifacts() { ARTIFACTS.length = 0; turnArtifacts = []; renderArtifactStrip(); }
function registerArtifact(p, quiet) {
  const i = ARTIFACTS.indexOf(p); if (i >= 0) ARTIFACTS.splice(i, 1);
  ARTIFACTS.unshift(p); if (ARTIFACTS.length > 60) ARTIFACTS.length = 60;
  if (!quiet) { turnArtifacts.push(p); markContextActivity('results'); }
  renderArtifactStrip();
}
function renderArtifactStrip() {
  const strip = $('artifact-strip'); if (!strip) return;
  strip.hidden = !ARTIFACTS.length;
  // B1: 产物面板空状态管理
  const resultsEmpty = $('results-empty');
  if (resultsEmpty) resultsEmpty.style.display = ARTIFACTS.length ? 'none' : '';
  strip.innerHTML = '';
  for (const p of ARTIFACTS.slice(0, 40)) {
    const kind = artifactKind(p);
    const b = document.createElement('button'); b.type = 'button'; b.className = 'artifact-tile ' + kind + (p === activeTab ? ' active' : ''); b.title = p;
    b.innerHTML = (kind === 'image' ? '<img alt="" loading="lazy" />' : `<svg class="ico"><use href="#i-${ARTIFACT_ICON[kind]}"/></svg>`) + '<span></span>';
    b.querySelector('span').textContent = p.split('/').pop();
    if (kind === 'image') { const im = b.querySelector('img'); im.src = '/api/file?path=' + encodeURIComponent(p) + '&raw=1'; im.onerror = () => b.classList.add('missing'); }
    b.onclick = () => openArtifact(p);
    strip.appendChild(b);
  }
}
async function openArtifact(p) {
  revealInspector();
  await openFile(p);
  renderArtifactStrip();
}
function onAgentRunState(running) {
  if (running) turnArtifacts = [];
  else if (turnArtifacts.length) {
    const dirty = [...tabs.values()].some(t => t.dirty);
    const rank = { image: 0, field: 1, geometry: 2, pdf: 3, doc: 4 };
    const pick = [...turnArtifacts].reverse().sort((a, b) => rank[artifactKind(a)] - rank[artifactKind(b)])[0];
    if (pick && !dirty && shellState.inspector && ['status', 'results'].includes(contextView)) openArtifact(pick).catch(e => console.warn('[openArtifact]', e));
    turnArtifacts = [];
  }
  renderTaskList();
}

// 新任务空状态
function buildWelcome() {
  const d = document.createElement('div'); d.className = 'welcome';
  d.innerHTML = '<div class="welcome-title">要模拟什么？</div><div class="welcome-sub">描述目标，附上论文、几何或算例。智能体会规划、建模、求解、核验并生成报告，过程中的图表、几何和场会出现在右侧检查器。</div><div class="welcome-grid"></div>';
  const items = [
    ['book', '复现论文', '读取论文，抽取几何、工况与 KPI，搭建算例并与原文逐项对比。', '请复现我附上的论文：先抽取几何、物性、边界条件和关键 KPI，列出计划，再搭建 OpenFOAM 算例。'],
    ['cube', '几何与网格', '从 STL 或参数生成几何，规划网格并完成质量与贴体核验。', '请检查工作区里的 STL 几何，规划 snappyHexMesh 网格，并完成 checkMesh 与贴体核验。'],
    ['activity', '求解与监控', '后台启动求解，跟踪残差与时均 KPI，发散时定位原因。', '请启动当前算例的求解，持续监控残差和关键 KPI，收敛后做时均统计并给出可信度。'],
    ['chart', '优化设计', '对几何或操作条件做贝叶斯优化，每个试验独立验收。', '请为当前算例建立优化 study：先确认设计变量、目标与约束，再逐个运行试验并汇报最优解。'],
  ];
  const grid = d.querySelector('.welcome-grid');
  for (const [ico, title, desc, prompt] of items) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'welcome-card';
    b.innerHTML = `<b><svg class="ico"><use href="#i-${ico}"/></svg><span></span></b><span></span>`;
    b.querySelector('b span').textContent = title; b.querySelector(':scope > span').textContent = desc;
    b.onclick = () => { const inp = $('input'); inp.value = prompt; inp.focus(); autosizeInput(); };
    grid.appendChild(b);
  }
  return d;
}
if (!$('chat').children.length) $('chat').appendChild(buildWelcome());

// 提示条
function toast(text, ms = 3200) {
  const host = $('toast-host'); if (!host || !text) return;
  const d = document.createElement('div'); d.className = 'toast'; d.textContent = text; host.appendChild(d);
  requestAnimationFrame(() => d.classList.add('show'));
  setTimeout(() => { d.classList.remove('show'); setTimeout(() => d.remove(), 250); }, ms);
}

// 输入框自适应高度
function autosizeInput() {
  const el = $('input'); el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight + 2, Math.round(window.innerHeight * 0.4)) + 'px';
}
$('input').addEventListener('input', autosizeInput);
$('input').addEventListener('keyup', e => { if (e.key === 'Enter') autosizeInput(); });
$('send').addEventListener('click', () => setTimeout(autosizeInput, 0));

// 工作区名称
function updateProjectLabel() {
  const full = $('ws-display').textContent || '';
  $('ws-name').textContent = full.split(/[\\/]/).filter(Boolean).pop() || '工作区';
  $('ws-name').closest('summary').title = full ? `工作区：${full}\n点击切换目录或打开文件` : '切换工作目录或打开文件';
}
new MutationObserver(updateProjectLabel).observe($('ws-display'), { childList: true, characterData: true, subtree: true });
updateProjectLabel();

// 快捷键：Ctrl+B 侧栏 · Ctrl+I 检查器 · Ctrl+K 搜索任务 · Esc 停止（输入框内、运行中）
// v0.9.4: 快捷键注册表 — 集中管理，支持自定义绑定
const KEYBINDS_KEY = 'nullflux.keybinds';
const DEFAULT_KEYBINDS = {
  'sidebar.toggle':    { keys: 'Ctrl+B',       label: '切换侧栏',     desc: '显示/隐藏左侧任务栏' },
  'inspector.toggle':  { keys: 'Ctrl+I',       label: '切换检查器',   desc: '显示/隐藏右侧检查器面板' },
  'task.search':       { keys: 'Ctrl+K',       label: '搜索任务',     desc: '聚焦侧栏任务搜索框' },
  'task.new':          { keys: 'Ctrl+N',        label: '新建任务',     desc: '创建新任务并聚焦输入框' },
  'cmd.palette':       { keys: 'Ctrl+Shift+P', label: '命令面板',     desc: '打开全局命令搜索面板' },
  'msg.send':          { keys: 'Ctrl+Enter',    label: '发送消息',     desc: '在输入框中发送当前内容' },
  'agent.mode':        { keys: 'Tab',           label: '切换模式',     desc: '输入框为空时按 Tab 切换规划/执行' },
  'agent.stop':        { keys: 'Esc',           label: '停止智能体',   desc: '输入框内按 Esc 停止运行中的智能体' },
  'file.save':         { keys: 'Ctrl+S',       label: '保存文件',     desc: '在编辑器中保存当前打开的文件' },
};
let customKeybinds = readUIStorage(KEYBINDS_KEY, {});
function getKeybind(id) { return customKeybinds[id] || DEFAULT_KEYBINDS[id]?.keys || ''; }
function parseKeybind(str) {
  // "Ctrl+Shift+P" → { ctrl: true, shift: true, key: 'p' }
  const parts = str.split('+').map(s => s.trim());
  const out = { ctrl: false, shift: false, alt: false, meta: false, key: '' };
  for (const p of parts) {
    const lo = p.toLowerCase();
    if (lo === 'ctrl' || lo === 'cmd' || lo === 'mod') out.ctrl = true;
    else if (lo === 'shift') out.shift = true;
    else if (lo === 'alt' || lo === 'option') out.alt = true;
    else if (lo === 'meta' || lo === 'win' || lo === 'super') out.meta = true;
    else out.key = lo;
  }
  return out;
}
function matchKeybind(e, id) {
  const str = getKeybind(id);
  if (!str) return false;
  const kb = parseKeybind(str);
  if (kb.ctrl  !== (e.ctrlKey  || e.metaKey)) return false;
  if (kb.shift !== e.shiftKey) return false;
  if (kb.alt   !== e.altKey)   return false;
  if (kb.key   !== e.key.toLowerCase()) return false;
  return true;
}
document.addEventListener('keydown', e => {
  // 全局快捷键（不在 Monaco 编辑器内）
  if (!e.target.closest?.('.monaco-editor')) {
    if (matchKeybind(e, 'sidebar.toggle'))   { e.preventDefault(); toggleSidebar(); return; }
    if (matchKeybind(e, 'inspector.toggle')) { e.preventDefault(); toggleInspector(); return; }
    if (matchKeybind(e, 'task.search'))      { e.preventDefault(); if (narrowMQ.matches) toggleSidebar(true); else if (!shellState.sidebar) toggleSidebar(true); $('task-search').focus(); return; }
    if (matchKeybind(e, 'task.new'))         { e.preventDefault(); ws.send(JSON.stringify({ type: 'task_new', title: '' })); setTimeout(() => $('input').focus(), 50); return; }
    if (matchKeybind(e, 'cmd.palette'))      { e.preventDefault(); window.openCmdPalette?.(); return; }
  }
  // 输入框内快捷键
  if (e.target === $('input')) {
    if (matchKeybind(e, 'msg.send'))   { e.preventDefault(); send(); return; }
    if (matchKeybind(e, 'agent.mode')) { if (!$('input').value) { e.preventDefault(); setAgentMode($('input').value ? 'plan' : 'build'); return; } }
    if (matchKeybind(e, 'agent.stop')) { if (!$('stop').disabled && $('mention-pop').style.display === 'none') { e.preventDefault(); $('stop').click(); return; } }
  }
  // Esc 关闭文件菜单 / 文件查看器
  if (e.key === 'Escape') {
    const fileMenu = document.querySelector('.file-menu');
    if (fileMenu?.open) { fileMenu.open = false; fileMenu.querySelector('summary')?.focus(); }
    else if (panelVis.fileview && !document.querySelector('dialog[open], .modal:not([style*="none"])') && !e.target.closest?.('.monaco-editor')) setPanelVisible('fileview', false);
  }
});

applyShell();
renderTaskList();

// ===== 自动设计面板：Optuna study 只读视图（试验表 / 收敛曲线 / 最优参数）=====
const DESIGN = { study: localStorage.getItem('nullflux.design.study') || '', timer: null };
async function designLoadStudies() {
  try {
    const r = await fetch('/api/opt/studies').then(x => x.json());
    const sel = $('design-study'); const list = r.studies || [];
    sel.innerHTML = list.length ? list.map(s => `<option value="${escapeHtml(s.study_id)}">${escapeHtml(s.study_id)}</option>`).join('') : '<option value="">（无研究）</option>';
    if (!list.some(s => s.study_id === DESIGN.study)) DESIGN.study = list.length ? list[list.length - 1].study_id : '';
    sel.value = DESIGN.study;
    if (DESIGN.study) await designRender(); else $('design-body').innerHTML = '<div class="muted small">尚无优化研究。让智能体用 opt_study_create 建立带固定流水线合同的研究。</div>';
  } catch (e) { $('design-body').innerHTML = `<div class="muted small">读取失败：${escapeHtml(e.message)}</div>`; }
}
function designFmt(v) { return typeof v === 'number' ? (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(3) : +v.toPrecision(5)) : escapeHtml(String(v ?? '—')); }
function designChart(curve, direction) {
  if (!curve.length) return '<div class="muted small design-empty">还没有完成的试验</div>';
  const W = 420, H = 140, P = 28;
  const vals = curve.flatMap(c => [c.value, c.running_best]);
  let lo = Math.min(...vals), hi = Math.max(...vals); if (hi === lo) { hi += 1; lo -= 1; }
  const x = i => P + (curve.length === 1 ? (W - 2 * P) / 2 : i * (W - 2 * P) / (curve.length - 1));
  const y = v => H - P + 6 - (v - lo) / (hi - lo) * (H - 2 * P);
  const dots = curve.map((c, i) => `<circle cx="${x(i)}" cy="${y(c.value)}" r="3"><title>trial ${c.trial_id}: ${c.value}</title></circle>`).join('');
  const line = curve.map((c, i) => `${i ? 'L' : 'M'}${x(i)},${y(c.running_best)}`).join('');
  return `<svg class="design-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="收敛曲线（${direction === 'maximize' ? '越大越好' : '越小越好'}）">
    <line x1="${P}" y1="${H - P + 6}" x2="${W - P}" y2="${H - P + 6}" class="axis"/>
    <text x="${P}" y="12" class="lbl">${designFmt(hi)}</text><text x="${P}" y="${H - 4}" class="lbl">${designFmt(lo)}</text>
    <path d="${line}" class="best"/>${dots}</svg>`;
}
async function designRender() {
  if (!DESIGN.study) return;
  const body = $('design-body');
  let r;
  try { r = await fetch('/api/opt/study/' + encodeURIComponent(DESIGN.study)).then(x => x.json()); }
  catch (e) { body.innerHTML = `<div class="muted small">读取失败：${escapeHtml(e.message)}</div>`; return; }
  if (r.error || r.ok === false) { body.innerHTML = `<div class="muted small">读取失败：${escapeHtml(r.error || 'unknown')}</div>`; return; }
  const obj = r.objective || {}; const names = (r.search_space || []).map(p => p.name);
  const budget = r.budget || 0, done = r.n_done || 0;
  const best = r.best ? `<div class="design-best"><div class="k">当前最优 · trial ${r.best.trial_id}</div><div class="v">${designFmt(r.best.value)}</div>
      <div class="params">${Object.entries(r.best.params || {}).map(([k, v]) => `<span><b>${escapeHtml(k)}</b> ${designFmt(v)}</span>`).join('')}</div></div>`
    : '<div class="design-best empty"><div class="k">当前最优</div><div class="v">—</div><div class="params muted small">尚无通过验收的试验</div></div>';
  const stateLabel = { COMPLETE: '通过', RUNNING: '运行', FAIL: '失败', PRUNED: '剪枝', WAITING: '等待' };
  const rows = (r.history || []).slice().reverse().map(t => `<tr data-state="${escapeHtml(t.state)}"><td>${t.trial_id}</td><td><span class="st">${stateLabel[t.state] || escapeHtml(t.state)}</span></td>
      ${names.map(n => `<td>${designFmt(t.params?.[n])}</td>`).join('')}<td class="num">${t.value == null ? '—' : designFmt(t.value)}</td></tr>`).join('');
  const imp = r.importance && !r.importance._error ? Object.entries(r.importance).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
      `<div class="imp"><span>${escapeHtml(k)}</span><i style="width:${(v * 100).toFixed(1)}%"></i><em>${(v * 100).toFixed(0)}%</em></div>`).join('') : '';
  body.innerHTML = `
    <div class="design-head">
      <div><div class="k">目标</div><div class="v">${escapeHtml(obj.name || '—')} <small>${obj.direction === 'maximize' ? '↑ 最大化' : '↓ 最小化'}</small></div></div>
      <div><div class="k">进度</div><div class="v">${done}${budget ? ' / ' + budget : ''} <small>失败 ${r.n_failed || 0} · 运行 ${r.n_running || 0}</small></div>
        ${budget ? `<div class="design-bar"><i style="width:${Math.min(100, 100 * done / budget)}%"></i></div>` : ''}</div>
      <div><div class="k">采样器</div><div class="v">${escapeHtml(r.sampler || 'TPE')}</div></div>
    </div>
    ${r.active_trial ? `<div class="design-active">正在执行 ${escapeHtml(r.active_trial)}</div>` : ''}
    <div class="design-grid">${best}<div class="design-curve"><div class="k">收敛（点=单次，线=累计最优）</div>${designChart(r.convergence || [], obj.direction)}</div></div>
    ${imp ? `<div class="design-imp"><div class="k">参数重要性</div>${imp}</div>` : ''}
    <div class="design-table-wrap"><table class="design-table"><thead><tr><th>#</th><th>状态</th>${names.map(n => `<th>${escapeHtml(n)}</th>`).join('')}<th class="num">${escapeHtml(obj.name || '目标')}</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="${names.length + 3}" class="muted small">尚无试验</td></tr>`}</tbody></table></div>
    <div class="muted small design-note">只有经独立验收（网格 OK、求解 End、统计窗指标、哈希复验）的试验才计为"通过"并参与最优。</div>`;
}
$('design-study').onchange = e => { DESIGN.study = e.target.value; localStorage.setItem('nullflux.design.study', DESIGN.study); designRender(); };
$('design-refresh').onclick = () => designLoadStudies();
SUBVIEW_HOOKS.design = () => designLoadStudies();
setInterval(() => { if (isPanelVisible('design') && !document.hidden && DESIGN.study) designRender(); }, 15000);

// ====================== 智能体外壳：规划/执行模式 · 会话目标 · 分叉 · 上下文用量（对齐 OpenCode / OpenChamber） ======================
const AGENT_UI = { mode: 'build', goal: null };
function setAgentMode(mode) {
  mode = mode === 'plan' ? 'plan' : 'build';
  AGENT_UI.mode = mode; paintMode();
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'set_mode', value: mode }));
  toast(mode === 'plan' ? '规划模式：只读调研、出方案，不改文件不跑求解' : '执行模式：可使用全部工具');
}
function paintMode() {
  document.querySelectorAll('.mode-seg [data-mode]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === AGENT_UI.mode)));
  document.body.dataset.agentMode = AGENT_UI.mode;
  const inp = $('input');
  if (inp && $('stop').disabled) inp.placeholder = AGENT_UI.mode === 'plan' ? '规划模式：描述目标，智能体只读调研并给出方案…' : '描述目标，或添加论文、算例与数据…';
}
function renderAgentChrome(task) {
  if (!task) return;
  AGENT_UI.mode = task.agentMode === 'plan' ? 'plan' : 'build'; paintMode();
  // 上下文用量环
  const pct = task.ctxMax ? Math.min(100, Math.round(100 * (task.ctxChars || 0) / task.ctxMax)) : 0;
  const fg = $('ctx-fg'), meter = $('ctx-meter');
  if (fg) fg.setAttribute('stroke-dasharray', `${(pct * 0.9425).toFixed(1)} 100`);
  if ($('ctx-pct')) $('ctx-pct').textContent = pct + '%';
  if (meter) {
    meter.setAttribute('aria-valuenow', String(pct));
    meter.dataset.level = pct >= 85 ? 'high' : pct >= 60 ? 'mid' : 'low';
    meter.title = `上下文 ${Math.round((task.ctxChars || 0) / 1000)}k / ${Math.round((task.ctxMax || 0) / 1000)}k 字符（约 ${Math.round((task.ctxChars || 0) / 3500)}k token）· 超限自动压缩，可 /compact 手动压缩`;
  }
  _updateChipRing(pct); // v0.9.4: 同步 Chip 上下文环
  // 目标条
  AGENT_UI.goal = task.goal || null;
  const bar = $('goal-bar'); if (!bar) return;
  if (!task.goal) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.dataset.state = task.goal.status;
  $('goal-state').textContent = task.goal.status === 'done' ? '已达成' : task.goal.nudges ? `推进中 · 续推 ${task.goal.nudges}/3` : '目标';
  $('goal-text').textContent = task.goal.text;
  $('goal-crit').textContent = (task.goal.criteria || '').split('\n').filter(Boolean).join(' · ');
}
function openGoalDialog(prefill) {
  const dlg = $('goal-dlg'); if (!dlg) return;
  $('goal-in').value = prefill || AGENT_UI.goal?.text || '';
  $('goal-crit-in').value = AGENT_UI.goal?.criteria || '';
  dlg.showModal(); setTimeout(() => $('goal-in').focus(), 0);
}
function forkTask() {
  if (!$('stop').disabled) { toast('运行中不能分叉，请先停止'); return; }
  ws.send(JSON.stringify({ type: 'task_fork', id: TASKS_UI.currentId }));
}
document.querySelectorAll('.mode-seg [data-mode]').forEach(b => b.onclick = () => setAgentMode(b.dataset.mode));
$('goal-btn').onclick = () => openGoalDialog();
$('goal-edit').onclick = () => openGoalDialog();
$('goal-clear').onclick = () => ws.send(JSON.stringify({ type: 'set_goal', clear: true }));
$('task-fork').onclick = forkTask;
$('goal-dlg').addEventListener('close', () => {
  if ($('goal-dlg').returnValue !== 'ok') return;
  const text = $('goal-in').value.trim();
  ws.send(JSON.stringify(text ? { type: 'set_goal', text, criteria: $('goal-crit-in').value.trim() } : { type: 'set_goal', clear: true }));
});


// ====================== 运行 › 作业：实时作业卡 + 算例总览；结果 › 切片 / 几何；求解告警 ======================
const LIVE = { timer: 0, last: 0, busy: false, cases: null, ovCase: readUIStorage('nullflux.ovcase', '') };
const fx = (v, d = 3) => v === null || v === undefined || !Number.isFinite(Number(v)) ? '–' : Number(v).toFixed(d);
const fhours = h => h === null || h === undefined ? '–' : h < 1 ? Math.round(h * 60) + ' min' : h < 48 ? h.toFixed(1) + ' h' : (h / 24).toFixed(1) + ' 天';
const shortCase = p => String(p || '').split(/[\\/]/).filter(Boolean).slice(-2).join('/');
function liveSpark(hist) {
  if (!hist || hist.length < 2) return '<div class="live-spark-empty small muted">速率采样中（每分钟一个点）</div>';
  const w0 = hist[0][0], w1 = hist[hist.length - 1][0], t0 = Math.min(...hist.map(p => p[1])), t1 = Math.max(...hist.map(p => p[1]));
  const X = w => 4 + 292 * (w - w0) / Math.max(w1 - w0, 1), Y = t => 38 - 34 * (t - t0) / Math.max(t1 - t0, 1e-12);
  const d = hist.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join(' ');
  return `<svg class="live-spark" viewBox="0 0 300 42" preserveAspectRatio="none" role="img" aria-label="模拟时间随墙钟推进"><path d="${d} L${X(w1).toFixed(1)} 40 L4 40 Z" class="area"/><path d="${d}" class="line"/></svg>`;
}
function liveJobCard(j) {
  const src = j.source === 'rsi' ? 'RSI 试验' : j.source === 'agent' ? '智能体' : j.source === 'task' ? '任务算例' : '外部';
  const tone = j.fatal ? 'error' : j.logAgeS > 900 ? 'warn' : 'ok';
  const state = j.fatal ? 'FATAL / NaN' : j.logAgeS > 900 ? `日志 ${Math.round(j.logAgeS / 60)} min 未更新` : '推进中';
  const pct = j.frac === null || j.frac === undefined ? null : 100 * j.frac;
  const rel = String(j.caseDir || '');
  const card = document.createElement('article'); card.className = 'live-job'; card.dataset.tone = tone;
  card.innerHTML = `<div class="live-job-top"><b title="${escapeHtml(rel)}">${escapeHtml(shortCase(rel))}</b>
      <span class="live-badge">${src}</span><span class="live-badge" data-tone="${tone}">${state}</span>
      <span class="grow"></span>${j.runId ? '<button type="button" class="mini danger" data-act="stop">停止</button>' : ''}</div>
    ${j.task ? `<div class="small muted">${escapeHtml(j.task)}</div>` : ''}
    <div class="live-bar" role="progressbar" aria-label="进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct === null ? 0 : pct.toFixed(0)}"><i style="width:${pct === null ? 0 : pct.toFixed(2)}%"></i></div>
    <dl class="live-grid">
      <div><dt>模拟时间</dt><dd>${fx(j.now, 4)} / ${fx(j.end, 2)}</dd></div>
      <div><dt>进度</dt><dd>${pct === null ? '–' : pct.toFixed(1) + ' %'}</dd></div>
      <div><dt>剩余</dt><dd>${fhours(j.etaH)}</dd></div>
      <div><dt>速率 s/h</dt><dd>${fx(j.rate, 3)}</dd></div>
      <div><dt>Co max</dt><dd>${fx(j.coMax, 2)}</dd></div>
      <div><dt>Δt</dt><dd>${j.deltaT ? Number(j.deltaT).toExponential(2) : '–'}</dd></div>
      <div><dt>核数</dt><dd>${j.np ?? '–'}</dd></div>
    </dl>
    ${liveSpark(j.history)}
    <details class="live-tail"><summary>日志尾部</summary><pre></pre></details>
    <div class="live-acts"><button type="button" class="mini" data-act="overview">总览</button><button type="button" class="mini" data-act="slice">切片</button><button type="button" class="mini" data-act="ask">让智能体检查</button></div>`;
  card.querySelector('pre').textContent = (j.tail || []).join('\n');
  const wsRel = liveRel(rel);
  card.querySelector('[data-act="overview"]').onclick = () => { setOverviewCase(wsRel); $('ov-body')?.scrollIntoView({ block: 'nearest' }); };
  card.querySelector('[data-act="slice"]').onclick = () => openSliceView(wsRel);
  card.querySelector('[data-act="ask"]').onclick = () => askAgent(`检查正在运行的算例 ${wsRel || rel}：当前 t=${fx(j.now, 4)}，Co max=${fx(j.coMax, 2)}，速率 ${fx(j.rate, 3)} s/h。读日志尾部，判断是否健康，给出下一步（只读，不要改 system/ 和 constant/）。`);
  const stop = card.querySelector('[data-act="stop"]');
  if (stop) stop.onclick = async () => {
    if (!confirm(`终止作业 ${shortCase(rel)}？正在写的时间步可能不完整。`)) return;
    stop.disabled = true;
    try { await fetch(`/api/foam/run/${encodeURIComponent(j.runId)}/stop`, { method: 'POST' }); toast('已请求停止'); } catch (e) { toast('停止失败：' + e.message); }
    liveTick();
  };
  return card;
}
// /api/monitor 给的是绝对路径；总览和切片接口要工作区相对路径
function liveRel(abs) {
  const norm = s => String(s || '').replace(/\\/g, '/');
  const ws = norm(LIVE.workspace).replace(/\/+$/, ''), a = norm(abs);
  if (ws && a.startsWith(ws + '/')) return a.slice(ws.length + 1);
  return abs;
}
function liveRsi(r) {
  const host = $('live-rsi'); if (!host) return;
  if (!r) { host.innerHTML = ''; return; }
  const running = r.trials.filter(t => /run|solv|queue/.test(t.state)).length;
  const ctl = r.control ? `${r.control.state}${r.control.diff !== null && r.control.diff !== undefined ? `（差 ${fx(r.control.diff, 3)}）` : ''}` : '未完成';
  host.innerHTML = `<b>分布器 RSI</b><span class="small muted">对照 ${escapeHtml(ctl)} · 冠军 ${escapeHtml(r.champion || '–')} · 试验 ${r.trials.length}（进行中 ${running}）· 格 ${Object.keys(r.cells || {}).length}</span><a class="mini" href="/monitor" target="_blank" rel="noopener">档案</a>`;
}
// 作业分组：当前任务的算例完整显示在最上面；其它任务 / 手动启动的作业收进折叠区，同一目录下的批量作业（≥4 个）合并成一行
function liveBulkRow(dir, list) {
  const fr = list.map(j => j.frac).filter(v => v !== null && v !== undefined);
  const avg = fr.length ? (100 * fr.reduce((a, b) => a + b, 0) / fr.length).toFixed(0) + ' %' : '–';
  const np = list.reduce((a, j) => a + (j.np || 1), 0), bad = list.filter(j => j.fatal).length;
  const row = document.createElement('details'); row.className = 'live-bulk';
  row.innerHTML = `<summary><b></b><span class="live-badge">批量 ${list.length} 个</span><span class="small muted">平均进度 ${avg} · ${np} 核${bad ? ` · ${bad} 个报错` : ''}</span></summary><div class="live-bulk-list"></div>`;
  row.querySelector('b').textContent = shortCase(dir); row.querySelector('b').title = dir;
  const host = row.querySelector('.live-bulk-list');
  for (const j of list) {
    const line = document.createElement('div'); line.className = 'small';
    const pct = j.frac === null || j.frac === undefined ? '' : ' · ' + (100 * j.frac).toFixed(0) + ' %';
    line.textContent = `${String(j.caseDir).split(/[\\/]/).pop()} · t=${fx(j.now, 3)} / ${fx(j.end, 2)}${pct}${j.fatal ? ' · FATAL' : ''}`;
    host.appendChild(line);
  }
  return row;
}
function liveRenderJobs(all) {
  const host = $('live-jobs'); host.innerHTML = '';
  const cur = TASKS_UI.currentId;
  const mine = all.filter(j => j.taskId && j.taskId === cur), rest = all.filter(j => !(j.taskId && j.taskId === cur));
  if (!mine.length) host.insertAdjacentHTML('beforeend', `<div class="empty-line small muted">${all.length ? '当前任务没有在跑的求解。' : '没有在跑的求解。让智能体启动一个算例，进度会出现在这里。'}</div>`);
  for (const j of mine) host.appendChild(liveJobCard(j));
  if (!rest.length) return;
  const box = document.createElement('details'); box.className = 'live-others';
  box.open = LIVE.othersOpen === undefined ? rest.length <= 2 : LIVE.othersOpen;
  const cores = rest.reduce((a, j) => a + (j.np || 1), 0);
  box.innerHTML = `<summary>其它作业 ${rest.length} 个 · ${cores} 核<span class="small muted">其它任务或手动启动，不属于当前任务</span></summary><div class="live-others-body"></div>`;
  box.querySelector('summary').onclick = () => { LIVE.othersOpen = !box.open; };
  const body = box.querySelector('.live-others-body'), groups = new Map();
  for (const j of rest) {
    const parent = String(j.caseDir || '').replace(/[\\/][^\\/]+$/, '');
    if (!groups.has(parent)) groups.set(parent, []);
    groups.get(parent).push(j);
  }
  for (const [parent, list] of groups) {
    if (list.length >= 4) body.appendChild(liveBulkRow(parent, list));
    else for (const j of list) body.appendChild(liveJobCard(j));
  }
  host.appendChild(box);
}
// 算例总览默认显示当前任务的算例：任务或它的算例变了才跟一次，之后用户手动选的不被覆盖
function liveFollowTask() {
  const t = TASKS_UI.list.find(x => x.id === TASKS_UI.currentId);
  const dir = t && t.caseDir && LIVE.workspace ? liveRel(t.caseDir) : '';
  const key = (t ? t.id : '') + '|' + dir;
  if (!dir || LIVE.followKey === key) return false;
  LIVE.followKey = key;
  if (LIVE.ovCase !== dir) setOverviewCase(dir);
  return true;
}
function liveOnTasks() {
  if (LIVE.taskSeen === TASKS_UI.currentId) return;
  LIVE.taskSeen = TASKS_UI.currentId;
  if (LIVE.timer) liveTick();
}
async function liveTick() {
  if (LIVE.busy) return; LIVE.busy = true;
  try {
    const r = await fetch('/api/monitor', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json(); LIVE.last = Date.now();
    if (!LIVE.workspace) { try { LIVE.workspace = (await (await fetch('/api/config')).json()).workspace || ''; } catch {} }
    const mem = d.mem ? (100 * (1 - d.mem.free / d.mem.total)).toFixed(0) + ' %' : '–';
    $('live-machine').innerHTML = [['求解占用核', `${d.busyCores} / ${d.cpus}`], ['负载', (d.load || []).map(x => x.toFixed(0)).join(' / ')], ['内存', mem], ['作业', d.jobs.length]]
      .map(([k, v]) => `<div><span>${k}</span><b>${escapeHtml(String(v))}</b></div>`).join('');
    liveRenderJobs(d.jobs);
    liveRsi(d.rsi);
    const n = d.jobs.filter(j => j.taskId && j.taskId === TASKS_UI.currentId).length, tab = document.querySelector('[data-context-view="status"] span');
    if (tab) tab.textContent = n ? `运行 ${n}` : '运行';
    if (!liveFollowTask() && !LIVE.ovCase && d.jobs[0]) setOverviewCase(liveRel(d.jobs[0].caseDir));
    liveStamp();
  } catch (e) { $('live-stamp').textContent = '刷新失败：' + e.message; }
  finally { LIVE.busy = false; }
}
function liveStamp() { if (LIVE.last) $('live-stamp').textContent = `${Math.round((Date.now() - LIVE.last) / 1000)} s 前`; }
function liveStart() {
  liveTick(); loadOverviewCases();
  if (!LIVE.timer) LIVE.timer = setInterval(() => { if (!document.hidden && isPanelVisible('live')) liveTick(); else liveStamp(); }, 15000);
}
$('live-refresh').onclick = () => { liveTick(); loadOverview(); };
SUBVIEW_HOOKS.live = liveStart;

// 算例总览卡
async function loadOverviewCases() {
  if (LIVE.cases) return;
  try {
    const j = await (await fetch('/api/post/cases')).json();
    LIVE.cases = (j.cases || []).sort((a, b) => (b.hasData - a.hasData) || (b.mtime - a.mtime));
    const sel = $('ov-case');
    sel.innerHTML = '<option value="">选择算例…</option>' + LIVE.cases.map(c => `<option value="${escapeHtml(c.path)}">${escapeHtml(c.path)}${c.hasData ? '' : '（无结果）'}</option>`).join('');
    if (LIVE.ovCase && !LIVE.cases.some(c => c.path === LIVE.ovCase)) sel.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(LIVE.ovCase)}">${escapeHtml(LIVE.ovCase)}</option>`);
    sel.value = LIVE.ovCase || '';
    if (LIVE.ovCase) loadOverview();
  } catch (e) { $('ov-body').textContent = '读取算例列表失败：' + e.message; }
}
$('ov-case').onchange = () => setOverviewCase($('ov-case').value);
function setOverviewCase(c) {
  LIVE.ovCase = c || ''; writeUIStorage('nullflux.ovcase', LIVE.ovCase);
  const sel = $('ov-case');
  if (c && sel && ![...sel.options].some(o => o.value === c)) sel.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`);
  if (sel) sel.value = LIVE.ovCase;
  loadOverview();
}
async function loadOverview() {
  const body = $('ov-body'); if (!body) return;
  if (!LIVE.ovCase) { body.innerHTML = '<div class="muted small">选择一个算例。</div>'; return; }
  body.innerHTML = '<div class="muted small">读取中…</div>';
  try {
    const r = await fetch('/api/case/overview?case=' + encodeURIComponent(LIVE.ovCase));
    const o = await r.json(); if (!r.ok || o.error) throw new Error(o.error || 'HTTP ' + r.status);
    const kv = [['求解器', o.application || '–'], ['状态', o.running ? '运行中' : '空闲'], ['网格', o.nCells ? o.nCells.toLocaleString() + ' 单元' : '–'],
      ['分区', o.nProcs || '已重构'], ['最新时刻', fx(o.latestTime, 4)], ['终点', fx(o.endTime, 2)], ['maxCo', fx(o.maxCo, 2)], ['时间目录', o.nTimes]];
    const walls = o.patches.filter(p => p.type === 'wall').length;
    body.innerHTML = `<dl class="live-grid">${kv.map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(String(v))}</dd></div>`).join('')}</dl>
      <details class="ov-patches"><summary>边界区 ${o.nPatches}（壁面 ${walls}）</summary><div class="ov-chips"></div></details>
      ${o.results.length ? '<div class="ov-results"><span class="small muted">结果文件</span><div class="ov-chips" data-k="res"></div></div>' : ''}
      <div class="live-acts"><button type="button" class="mini" data-act="slice">切片</button>${o.hasGeometry ? '<button type="button" class="mini" data-act="geom">几何</button>' : ''}<button type="button" class="mini" data-act="ask">让智能体对照论文</button></div>`;
    const chips = body.querySelector('.ov-patches .ov-chips');
    for (const p of o.patches) { const c = document.createElement('span'); c.className = 'ov-chip'; c.dataset.type = p.type; c.textContent = p.name; c.title = p.type; chips.appendChild(c); }
    const res = body.querySelector('[data-k="res"]');
    if (res) for (const f of o.results) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'ov-chip'; b.textContent = f;
      b.onclick = () => openArtifact((o.case === '.' ? '' : o.case + '/') + f); res.appendChild(b);
    }
    body.querySelector('[data-act="slice"]').onclick = () => openSliceView(o.case);
    body.querySelector('[data-act="geom"]')?.addEventListener('click', () => openGeometryView(o.case));
    body.querySelector('[data-act="ask"]').onclick = () => askAgent(`对算例 ${o.case}（${o.application || '?'}，最新时刻 ${fx(o.latestTime, 4)}）做一次与论文的比对：列出已有的结果文件，说明哪些指标已对上、哪些缺数据，给出下一步。只读，不要改 system/ 和 constant/。`);
  } catch (e) { body.innerHTML = `<div class="small" style="color:var(--red)">${escapeHtml(e.message)}</div>`; }
}

// 结果 › 切片 / 几何：同源 iframe，用到时才加载
function setEmbed(frameId, popId, base, caseRel, extra = '') {
  const url = base + '?embed=1' + extra + (caseRel ? '&case=' + encodeURIComponent(caseRel) : '');
  const fr = $(frameId);
  if (fr.dataset.src !== url) { fr.dataset.src = url; fr.src = url; }
  $(popId).href = base + '?' + extra.replace(/^&/, '') + (caseRel ? '&case=' + encodeURIComponent(caseRel) : '');
}
// 「几何」子视图 = 同一个三维工作台的网格/前处理模式（能看 blockMesh/snappy 网格，不只 STL）
SUBVIEW_HOOKS.slice = () => { if (!$('slice-frame').dataset.src) setEmbed('slice-frame', 'slice-pop', '/post', LIVE.ovCase); };
SUBVIEW_HOOKS.geometry = () => { if (!$('geom-frame').dataset.src) setEmbed('geom-frame', 'geom-pop', '/post', LIVE.ovCase, '&mode=mesh'); };
function openSliceView(c) { setEmbed('slice-frame', 'slice-pop', '/post', c); setPanelVisible('slice', true); }
// 智能体 post_view：把图层状态带进可视化页（base64url JSON），页面按它建图层而不是用默认视图
function openPostState(m) {
  const st = { mode: m.mode, time: m.time, layers: m.layers || [] };
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(st)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  setEmbed('slice-frame', 'slice-pop', '/post', m.case, '&state=' + b64 + '&r=' + Date.now().toString(36));
  setPanelVisible('slice', true);
  try { markSubActivity('slice'); } catch {}
}
function openGeometryView(c) { setEmbed('geom-frame', 'geom-pop', '/post', c, '&mode=mesh'); setPanelVisible('geometry', true); }

// 把一段话交给智能体（运行中则作为引导注入）
function askAgent(text) {
  const inp = $('input'); inp.value = text; inp.dispatchEvent(new Event('input'));
  if (narrowMQ.matches) toggleInspector(false);
  $('send').click();
}

// 求解告警卡片
const ALERT_LABEL = { fatal: '求解出错', courant: 'Courant 超限', stale: '日志停更' };
function renderSolverAlert(m) {
  if (m.taskId && TASKS_UI.currentId && m.taskId !== TASKS_UI.currentId) { toast(`${ALERT_LABEL[m.kind] || '求解告警'}：${m.case}（在其他任务里）`); return; }
  const div = document.createElement('div'); div.className = 'msg solver-alert'; div.dataset.level = m.level || 'warn';
  div.setAttribute('role', 'alert');
  div.innerHTML = `<div class="sa-head"><span class="live-badge" data-tone="${m.level === 'error' ? 'error' : 'warn'}"></span><b></b><span class="small muted sa-case"></span></div>
    <div class="sa-hint small"></div><details class="live-tail"><summary>日志尾部</summary><pre></pre></details>
    <div class="live-acts"><button type="button" class="mini primary" data-act="ask">交给智能体</button><button type="button" class="mini" data-act="view">查看作业</button><button type="button" class="mini" data-act="dismiss">忽略</button></div>`;
  div.querySelector('.live-badge').textContent = ALERT_LABEL[m.kind] || '告警';
  div.querySelector('b').textContent = m.text || '';
  div.querySelector('.sa-case').textContent = `${m.case || ''}${m.now !== null && m.now !== undefined ? ' · t=' + fx(m.now, 4) : ''}`;
  div.querySelector('.sa-hint').textContent = m.hint || '';
  div.querySelector('pre').textContent = (m.tail || []).join('\n');
  div.querySelector('[data-act="ask"]').onclick = () => askAgent(`求解告警（${ALERT_LABEL[m.kind] || m.kind}）：算例 ${m.case}，${m.text}。t=${fx(m.now, 4)}，Co max=${fx(m.coMax, 2)}。\n日志尾部：\n${(m.tail || []).join('\n')}\n请诊断原因并给出处理方案；动 system/ 或 constant/ 之前先停下来问我。`);
  div.querySelector('[data-act="view"]').onclick = () => setPanelVisible('live', true);
  div.querySelector('[data-act="dismiss"]').onclick = () => div.remove();
  $('chat').appendChild(div); scrollChat();
  if (m.level === 'error') toast(`${ALERT_LABEL[m.kind] || '求解告警'}：${m.case}`);
}

// 原「更多工具」里的按钮，现在放在设置里
$('digitize-btn').onclick = () => { $('settings-modal').style.display = 'none'; openDigitizer({ name: 'plot', hint: '从论文截图 / 本地 PNG 手动标注数据点' }); };
setInterval(liveStamp, 5000);
// 首次 selectContext 早于这些钩子注册：刷新后恢复到的子视图在这里补一次
try { SUBVIEW_HOOKS[currentSub(contextView)]?.(); } catch (e) { console.warn(e); }
