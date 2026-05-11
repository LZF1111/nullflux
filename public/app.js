// deep codeMax frontend — 浮动面板 + ParaView 投影 + 跨平台交互终端
const $ = (id) => document.getElementById(id);

// ====================== 浮动面板：拖拽 + 缩放 + 持久化 ======================
const LAYOUT_KEY = 'codemax.layout.v3';
function loadLayout() { try { return JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}'); } catch { return {}; } }
function saveLayout(l) { localStorage.setItem(LAYOUT_KEY, JSON.stringify(l)); }

let layout = loadLayout();
let zCounter = 10;

function applyPanelLayout(panel) {
  const pid = panel.dataset.pid;
  const def = panel.dataset.default.split(';').reduce((o, kv) => { const [k, v] = kv.split(':'); o[k] = parseInt(v, 10); return o; }, {});
  const saved = layout[pid] || {};
  panel.style.left = (saved.left ?? def.left) + 'px';
  panel.style.top = (saved.top ?? def.top) + 'px';
  panel.style.width = (saved.width ?? def.width) + 'px';
  panel.style.height = (saved.height ?? def.height) + 'px';
  if (saved.z) panel.style.zIndex = saved.z;
}

function makePanelMovableResizable(panel) {
  applyPanelLayout(panel);
  // 添加缩放手柄
  ['e', 's', 'se'].forEach(d => { const r = document.createElement('div'); r.className = 'resize-' + d; panel.appendChild(r); attachResize(panel, r, d); });
  const head = panel.querySelector('.panel-head');
  let dragStart = null;
  head.addEventListener('mousedown', (e) => {
    if (e.target.closest('button, input, .x, .tab')) return;
    bringFront(panel);
    dragStart = { mx: e.clientX, my: e.clientY, x: panel.offsetLeft, y: panel.offsetTop };
    panel.classList.add('dragging');
    e.preventDefault();
  });
  panel.addEventListener('mousedown', () => bringFront(panel));
  document.addEventListener('mousemove', (e) => {
    if (!dragStart) return;
    let nx = dragStart.x + (e.clientX - dragStart.mx);
    let ny = dragStart.y + (e.clientY - dragStart.my);
    const desk = $('desktop').getBoundingClientRect();
    nx = Math.max(0, Math.min(nx, desk.width - 80));
    ny = Math.max(0, Math.min(ny, desk.height - 28));
    panel.style.left = nx + 'px'; panel.style.top = ny + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragStart) return;
    dragStart = null; panel.classList.remove('dragging');
    persistPanel(panel);
  });
}

function attachResize(panel, handle, dir) {
  let s = null;
  handle.addEventListener('mousedown', (e) => {
    bringFront(panel);
    s = { mx: e.clientX, my: e.clientY, w: panel.offsetWidth, h: panel.offsetHeight };
    e.preventDefault(); e.stopPropagation();
  });
  document.addEventListener('mousemove', (e) => {
    if (!s) return;
    if (dir === 'e' || dir === 'se') panel.style.width = Math.max(200, s.w + (e.clientX - s.mx)) + 'px';
    if (dir === 's' || dir === 'se') panel.style.height = Math.max(100, s.h + (e.clientY - s.my)) + 'px';
    if (panel.dataset.pid === 'editor' && editor) editor.layout();
  });
  document.addEventListener('mouseup', () => { if (!s) return; s = null; persistPanel(panel); if (editor) editor.layout(); });
}

function bringFront(panel) {
  zCounter++; panel.style.zIndex = zCounter;
  document.querySelectorAll('.panel.active').forEach(p => p.classList.remove('active'));
  panel.classList.add('active');
  persistPanel(panel);
}
function persistPanel(panel) {
  const pid = panel.dataset.pid;
  layout[pid] = { left: panel.offsetLeft, top: panel.offsetTop, width: panel.offsetWidth, height: panel.offsetHeight, z: parseInt(panel.style.zIndex || '10', 10) };
  saveLayout(layout);
}

document.querySelectorAll('.panel').forEach(makePanelMovableResizable);

$('reset-layout').onclick = () => { layout = {}; saveLayout(layout); document.querySelectorAll('.panel').forEach(applyPanelLayout); if (editor) editor.layout(); };

// ====================== 面板可见性 + 视图菜单 ======================
const PANELS_KEY = 'codemax.panels.v1';
// pid → { label, group, defaultHidden }
const PANEL_META = {
  files:          { label: '资源管理器',  group: '工作区' },
  editor:         { label: '编辑器',      group: '工作区' },
  todos:          { label: '待办',        group: '工作区' },
  checkpoints:    { label: '检查点',      group: '工作区' },
  terminal:       { label: '终端',        group: '工作区' },
  chat:           { label: '聊天 / 智能体', group: '工作区' },
  paraview:       { label: 'ParaView 预览', group: '仿真',   defaultHidden: true },
  foam:           { label: 'OpenFOAM (Beta)', group: '仿真', defaultHidden: true },
  'solver-monitor':{label: '求解器监测',  group: '仿真',   defaultHidden: true },
  gallery:        { label: '图片库',      group: '其他',   defaultHidden: true },
};
function loadPanelVis() { try { return JSON.parse(localStorage.getItem(PANELS_KEY) || '{}'); } catch { return {}; } }
function savePanelVis(o) { localStorage.setItem(PANELS_KEY, JSON.stringify(o)); }
let panelVis = loadPanelVis();

function isPanelVisible(pid) {
  if (pid in panelVis) return panelVis[pid];
  return !PANEL_META[pid]?.defaultHidden;
}
function setPanelVisible(pid, on) {
  panelVis[pid] = !!on; savePanelVis(panelVis);
  const el = document.querySelector(`.panel[data-pid="${pid}"]`);
  if (el) el.style.display = on ? '' : 'none';
  if (on && pid === 'editor' && editor) setTimeout(() => editor.layout(), 50);
  // 同步勾选
  const cb = document.querySelector(`#view-menu input[data-pid="${pid}"]`);
  if (cb) cb.checked = !!on;
}
function applyAllPanelVis() {
  for (const pid of Object.keys(PANEL_META)) {
    const el = document.querySelector(`.panel[data-pid="${pid}"]`);
    if (!el) continue;
    el.style.display = isPanelVisible(pid) ? '' : 'none';
  }
}
applyAllPanelVis();

function buildViewMenu() {
  const menu = $('view-menu'); if (!menu) return;
  const groups = {};
  for (const [pid, meta] of Object.entries(PANEL_META)) {
    (groups[meta.group] = groups[meta.group] || []).push([pid, meta]);
  }
  let html = '';
  for (const [g, items] of Object.entries(groups)) {
    html += `<div class="vm-section">${g}</div>`;
    for (const [pid, meta] of items) {
      const on = isPanelVisible(pid);
      html += `<label><input type="checkbox" data-pid="${pid}" ${on?'checked':''}/> ${meta.label}</label>`;
    }
  }
  html += `<hr/><label style="opacity:.85"><span style="color:var(--purple2)">⊞</span> 重置面板位置 <button class="mini" id="vm-reset-pos" style="margin-left:auto">执行</button></label>`;
  menu.innerHTML = html;
  menu.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => setPanelVisible(cb.dataset.pid, cb.checked));
  });
  const rb = $('vm-reset-pos'); if (rb) rb.onclick = (e) => { e.stopPropagation(); $('reset-layout').click(); };
}
buildViewMenu();
$('view-btn').onclick = (e) => {
  e.stopPropagation();
  const m = $('view-menu');
  m.style.display = (m.style.display === 'none' ? 'block' : 'none');
};
document.addEventListener('click', (e) => {
  const m = $('view-menu'); if (!m || m.style.display === 'none') return;
  if (e.target.closest('#view-menu') || e.target.closest('#view-btn')) return;
  m.style.display = 'none';
});

// 压缩历史
$('compact-btn').onclick = () => {
  if (!confirm('把较早的对话折叠成摘要？\n用于长会话防止 Node 内存溢出（OOM）。\n最近 6 条原文会保留。')) return;
  ws && ws.readyState === 1 && ws.send(JSON.stringify({ type: 'compact' }));
};

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
  editor = monaco.editor.create(el, { value: '', language: 'plaintext', theme: 'vs-dark', automaticLayout: true, fontSize: 13, minimap: { enabled: false }, wordWrap: 'on', scrollBeyondLastLine: false });
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
  // which: 'editor' | 'nb' | 'image' | 'stl' | 'pdf' | 'empty'
  document.getElementById('editor-host').style.display = which === 'editor' ? '' : 'none';
  document.getElementById('nb-host').style.display = which === 'nb' ? '' : 'none';
  const imgHost = document.getElementById('img-host'); if (imgHost) imgHost.style.display = which === 'image' ? '' : 'none';
  const stlHost = document.getElementById('stl-host'); if (stlHost) stlHost.style.display = which === 'stl' ? '' : 'none';
  const pdfHost = document.getElementById('pdf-host'); if (pdfHost) pdfHost.style.display = which === 'pdf' ? '' : 'none';
  document.getElementById('editor-empty').style.display = which === 'empty' ? '' : 'none';
  if (which === 'editor' && editor) setTimeout(() => editor.layout(), 0);
  if (which === 'stl' && window.__stlResize) window.__stlResize();
}
function setEditorEmpty() { showView('empty'); }
setEditorEmpty();

const detectLang = p => ({ js:'javascript', ts:'typescript', jsx:'javascript', tsx:'typescript', py:'python', json:'json', md:'markdown', html:'html', css:'css', java:'java', c:'c', cpp:'cpp', h:'cpp', cs:'csharp', go:'go', rs:'rust', sh:'shell', yml:'yaml', yaml:'yaml', xml:'xml', sql:'sql' }[p.split('.').pop().toLowerCase()] || 'plaintext');

async function openFile(p) {
  if (p && p.endsWith && p.endsWith('.ipynb')) return openNotebook(p);
  // 图片预览
  if (p && /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i.test(p)) return openImage(p);
  // STL 三维预览
  if (p && /\.stl$/i.test(p)) return openSTL(p);
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
    tab = { model: monaco.editor.createModel(content, detectLang(p)), originalContent: diskContent, dirty, viewState: null };
    tabs.set(p, tab);
  }
  activeTab = p; editor.setModel(tab.model);
  if (tab.viewState) editor.restoreViewState(tab.viewState);
  editor.focus();
  $('save-file').disabled = !tab.dirty;
  showView('editor');
  renderTabs(); updateActiveFileChip();
  document.querySelectorAll('.tree-node.selected').forEach(n => n.classList.remove('selected'));
  const n = document.querySelector(`.tree-node[data-path="${CSS.escape(p)}"]`); if (n) n.classList.add('selected');
}

async function openImage(p) {
  // \u5728\u7f16\u8f91\u533a\u53f3\u8fb9\u5c55\u793a\u56fe\u7247
  const host = document.getElementById('img-host');
  if (!host) return;
  host.innerHTML = '';
  const img = document.createElement('img');
  img.src = '/api/file?path=' + encodeURIComponent(p) + '&raw=1&_t=' + Date.now();
  img.alt = p;
  img.onerror = () => { host.innerHTML = `<div class="muted small" style="padding:24px;">\u65e0\u6cd5\u52a0\u8f7d\u56fe\u7247\uff1a${p}</div>`; };
  const wrap = document.createElement('div'); wrap.className = 'img-wrap';
  const meta = document.createElement('div'); meta.className = 'muted small img-meta'; meta.textContent = p;
  wrap.appendChild(img);
  host.appendChild(meta);
  host.appendChild(wrap);
  activeTab = p;
  showView('image');
  renderTabs(); updateActiveFileChip();
  document.querySelectorAll('.tree-node.selected').forEach(n => n.classList.remove('selected'));
  const tn = document.querySelector(`.tree-node[data-path="${CSS.escape(p)}"]`); if (tn) tn.classList.add('selected');
  // 占个空 tab 描述项，让 closeTab 能关闭
  if (!tabs.has(p)) tabs.set(p, { image: true, model: null, dirty: false, originalContent: '' });
}

async function openPDF(p) {
  // 用 iframe 让浏览器自带 PDF.js 渲染
  const host = document.getElementById('pdf-host');
  if (!host) return;
  host.innerHTML = '';
  const url = '/api/file?path=' + encodeURIComponent(p) + '&raw=1&_t=' + Date.now();
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:8px;padding:6px 10px;border-bottom:1px solid var(--line2);font-size:11px;align-items:center;';
  bar.innerHTML = `<span class="muted" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📄 ${p}</span>
    <button class="mini" id="pdf-newtab">新标签打开</button>
    <button class="mini" id="pdf-readdoc">让 agent 读取(read_document)</button>`;
  const iframe = document.createElement('iframe');
  iframe.src = url;
  iframe.style.cssText = 'flex:1;width:100%;height:calc(100% - 36px);border:0;background:#fff;';
  iframe.onerror = () => { host.innerHTML = `<div class="muted small" style="padding:24px;">无法加载 PDF：${p}</div>`; };
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;width:100%;height:100%;';
  wrap.appendChild(bar);
  wrap.appendChild(iframe);
  host.appendChild(wrap);
  bar.querySelector('#pdf-newtab').onclick = () => window.open(url, '_blank');
  bar.querySelector('#pdf-readdoc').onclick = () => {
    const inp = $('input');
    inp.value = (inp.value ? inp.value + '\n' : '') + `请调用 read_document("${p}") 提取这份 PDF 的文本与图片。`;
    inp.focus();
  };
  activeTab = p;
  showView('pdf');
  renderTabs(); updateActiveFileChip();
  document.querySelectorAll('.tree-node.selected').forEach(n => n.classList.remove('selected'));
  const tn = document.querySelector(`.tree-node[data-path="${CSS.escape(p)}"]`); if (tn) tn.classList.add('selected');
  if (!tabs.has(p)) tabs.set(p, { pdf: true, model: null, dirty: false, originalContent: '' });
}

// ===================== STL 三维预览（懒加载 three.js） =====================
const STL_VIEW = { renderer: null, scene: null, camera: null, mesh: null, raf: 0, controls: null };
async function ensureThree() {
  if (window.THREE && window.THREE.STLLoader) return window.THREE;
  // 用 importmap 之外的简化方案：直接动态 import ESM
  const mod = await import('https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js');
  const stlMod = await import('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/STLLoader.js');
  const ctrlMod = await import('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js');
  window.THREE = mod;
  window.THREE.STLLoader = stlMod.STLLoader;
  window.THREE.OrbitControls = ctrlMod.OrbitControls;
  return window.THREE;
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
  // 清空旧场景
  if (STL_VIEW.raf) cancelAnimationFrame(STL_VIEW.raf);
  if (STL_VIEW.renderer) { STL_VIEW.renderer.dispose(); }
  host.innerHTML = '';
  const w = host.clientWidth || 600, h = host.clientHeight || 400;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x0a0612);
  const camera = new THREE.PerspectiveCamera(45, w/h, 0.01, 100000);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(w, h);
  host.appendChild(renderer.domElement);
  // 模型
  const geom = new THREE.STLLoader().parse(buf);
  geom.computeBoundingBox(); geom.computeVertexNormals();
  const bb = geom.boundingBox; const c = new THREE.Vector3(); bb.getCenter(c);
  geom.translate(-c.x, -c.y, -c.z);
  const sz = new THREE.Vector3(); bb.getSize(sz);
  const maxD = Math.max(sz.x, sz.y, sz.z) || 1;
  const mat = new THREE.MeshPhongMaterial({ color: 0xa78bfa, specular: 0x222244, shininess: 30, flatShading: false });
  const mesh = new THREE.Mesh(geom, mat); scene.add(mesh);
  // 网格线（线框，浅色）
  const wire = new THREE.LineSegments(new THREE.WireframeGeometry(geom), new THREE.LineBasicMaterial({ color: 0x6b21a8, transparent:true, opacity:0.15 }));
  scene.add(wire);
  // 灯光
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const dl = new THREE.DirectionalLight(0xffffff, 0.9); dl.position.set(1,1,1).multiplyScalar(maxD*3); scene.add(dl);
  const dl2 = new THREE.DirectionalLight(0xffffff, 0.4); dl2.position.set(-1,-0.5,-1).multiplyScalar(maxD*3); scene.add(dl2);
  // 坐标轴 + 网格
  scene.add(new THREE.AxesHelper(maxD * 0.7));
  const grid = new THREE.GridHelper(maxD * 4, 20, 0x444466, 0x222233); grid.position.y = -sz.y/2 - maxD*0.02; scene.add(grid);
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
  info.style.cssText = 'position:absolute;top:6px;left:8px;font-size:11px;color:#c4b5fd;background:rgba(20,10,40,.7);padding:4px 8px;border-radius:4px;pointer-events:none;';
  const tris = (geom.index ? geom.index.count : geom.attributes.position.count) / 3;
  info.textContent = `${p}  ·  三角形 ${tris.toLocaleString()}  ·  尺寸 ${sz.x.toFixed(2)}×${sz.y.toFixed(2)}×${sz.z.toFixed(2)}  ·  鼠标拖拽旋转 / 滚轮缩放`;
  host.appendChild(info);
  window.__stlResize = () => {
    const nw = host.clientWidth, nh = host.clientHeight;
    if (nw && nh) { renderer.setSize(nw, nh); camera.aspect = nw/nh; camera.updateProjectionMatrix(); }
  };
}
window.addEventListener('resize', () => { if (window.__stlResize) window.__stlResize(); });

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
  t.model.dispose(); tabs.delete(p);
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
async function saveActive() {
  if (!activeTab) return; const t = tabs.get(activeTab); if (!t || !t.dirty) return;
  const content = t.model.getValue();
  const r = await fetch('/api/file', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: activeTab, content }) });
  const j = await r.json();
  if (j.ok) { t.originalContent = content; t.dirty = false; $('save-file').disabled = true; renderTabs(); clearDraft(activeTab); addTerm(`[已保存 ${activeTab}（${j.bytes}B）]`, 'sys'); }
  else addSystem('保存失败：' + (j.error || '未知错误'));
}
$('save-file').onclick = saveActive;

function updateActiveFileChip() {
  if (activeTab) { $('active-file-chip').style.display = ''; $('active-file-name').textContent = activeTab; }
  else { $('active-file-chip').style.display = 'none'; $('active-file-toggle').checked = false; }
}

// ====================== WS 与状态 ======================
let ws, currentAssistantBubble = null;
const toolEls = new Map();
let attachments = [];
let allFiles = [];
let platform = 'win32';

function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onmessage = (e) => { noteServerActivity(); handleMessage(JSON.parse(e.data)); };
  ws.onclose = () => { addSystem('连接断开，重连中...'); setTimeout(connect, 1000); };
  ws.onopen = () => { addTerm('[已连接 NullFlux]', 'sys');
    ws.send(JSON.stringify({ type: 'set_auto', value: $('auto-mode').checked }));
    ws.send(JSON.stringify({ type: 'set_sim', value: $('sim-mode').checked })); };
}
connect();

fetch('/api/config').then(r => r.json()).then(c => {
  $('ws-display').textContent = c.workspace;
  // 顶部不再重复显示模型名（按钮里已有）
  document.title = c.name || 'NullFlux';
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
$('reset').onclick = () => { if (!confirm('清空对话和检查点？')) return; ws.send(JSON.stringify({ type: 'reset' })); $('chat').innerHTML=''; toolEls.clear(); clearChatHistory(); };
$('stop').onclick = () => {
  ws.send(JSON.stringify({ type: 'stop' }));
  addTerm('[请求停止...]', 'sys');
  // 安全网：服务端如果没能及时发 agent_end（网络卡/总结生成中），2.5s 后强制释放输入框
  setTimeout(() => { setRunning(false); $('input').focus(); }, 2500);
};
$('send').onclick = send;
$('input').addEventListener('keydown', onInputKey);
$('input').addEventListener('input', onInputChange);
$('auto-mode').onchange = () => ws.send(JSON.stringify({ type: 'set_auto', value: $('auto-mode').checked }));
$('sim-mode').onchange = () => { ws.send(JSON.stringify({ type: 'set_sim', value: $('sim-mode').checked })); applySimMode(); };
$('clear-term').onclick = () => { $('terminal').innerHTML = ''; };
$('kill-shell').onclick = () => { ws.send(JSON.stringify({ type: 'pty_kill' })); addTerm('[shell 已重启]', 'sys'); };

function applySimMode() {
  const on = $('sim-mode').checked;
  // 仅开启仿真时自动打开 ParaView 面板；是否隐藏编辑器交给用户（菜单里手动切）
  if (on) setPanelVisible('paraview', true);
  else    setPanelVisible('paraview', false);
}

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
    if (cmd === 'tools') { $('input').value=''; $('tools-btn').click(); return; }
    if (cmd === 'py' || cmd === 'python') { $('input').value=''; $('py-picker').click(); return; }
    if (cmd === 'help') { $('input').value=''; addSystem('可用命令：/clear 清空对话 · /compact 压缩历史 · /model 切换模型 · /tools 工具开关 · /py 切换 Python · /help'); return; }
    addSystem('未知命令：/' + cmd + '（输入 /help 查看）'); return;
  }
  const finalAtts = [...attachments];
  if ($('active-file-toggle').checked && activeTab) finalAtts.push({ type: 'context_file', path: activeTab, name: activeTab });
  let textOut = text;
  for (const a of attachments) if (a.type === 'file' && a.inlineContent !== undefined) textOut += `\n\n--- 附件 ${a.name} ---\n${a.inlineContent}\n--- 结束 ---`;
  addUser(text, finalAtts);
  ws.send(JSON.stringify({ type: 'user', text: textOut, attachments: finalAtts.filter(a => a.type === 'image' || a.type === 'context_file').map(a => a.type === 'image' ? { type:'image', dataUrl:a.dataUrl, name:a.name } : { type:'context_file', path:a.path }) }));
  $('input').value = ''; attachments = []; renderAttachments(); setRunning(true);
}
function setRunning(r) {
  $('send').disabled = r; $('stop').disabled = !r;
  if (r) armStuckWatchdog(); else clearStuckWatchdog();
}

// ============== 卡死自愈：超过 STUCK_MS 没收到任何服务端消息时给"恢复"按钮 ==============
const STUCK_MS = 150_000; // 2.5 分钟没动静就提示
let _stuckTimer = 0;
let _lastServerMsgAt = Date.now();
function noteServerActivity() { _lastServerMsgAt = Date.now(); if ($('send').disabled) armStuckWatchdog(); }
function armStuckWatchdog() {
  clearStuckWatchdog();
  _stuckTimer = setTimeout(() => {
    const idle = Date.now() - _lastServerMsgAt;
    if (idle >= STUCK_MS && $('stop').disabled === false) {
      addSystem(`⚠ 已 ${Math.round(idle/1000)}s 无响应，可能卡住了。点 ⏹ 停止可强制恢复（不会丢失对话）。`);
    } else { armStuckWatchdog(); }
  }, STUCK_MS);
}
function clearStuckWatchdog() { if (_stuckTimer) { clearTimeout(_stuckTimer); _stuckTimer = 0; } }

// ====================== @mention ======================
let mentionState = null;
function onInputChange() {
  const v = $('input').value, cur = $('input').selectionStart;
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
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
}
function renderMentions() {
  const pop = $('mention-pop'); pop.innerHTML = '';
  mentionState.items.forEach((f, i) => { const d = document.createElement('div'); d.className = 'mention-item' + (i === mentionState.selected ? ' selected' : ''); d.textContent = f;
    d.onmousedown = (e) => { e.preventDefault(); pickMention(f); }; pop.appendChild(d); });
  pop.style.display = '';
}
function hideMentions() { $('mention-pop').style.display = 'none'; mentionState = null; }
function pickMention(f) {
  if (!mentionState) return;
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
    else d.innerHTML = `📎 <span class="name"></span><span class="x">×</span>`;
    d.querySelector('.name').textContent = a.name;
    d.querySelector('.x').onclick = () => { attachments.splice(i, 1); renderAttachments(); };
    el.appendChild(d);
  });
}

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

// ====================== 设置 ======================
$('settings-btn').onclick = async () => {
  const j = await (await fetch('/api/settings')).json();
  $('set-apikey').value = j.apiKey || ''; $('set-baseurl').value = j.baseUrl || '';
  $('set-model').value = j.model || ''; $('set-paraview-exe').value = j.paraviewExe || '';
  $('set-paraview-py').value = j.paraviewPython || ''; $('set-openfoam').value = j.openfoamBash || '';
  $('settings-modal').style.display = '';
};
$('settings-close').onclick = $('settings-cancel').onclick = () => $('settings-modal').style.display = 'none';
$('settings-save').onclick = async () => {
  const body = { apiKey: $('set-apikey').value, baseUrl: $('set-baseurl').value, model: $('set-model').value,
    paraviewExe: $('set-paraview-exe').value, paraviewPython: $('set-paraview-py').value, openfoamBash: $('set-openfoam').value };
  if (body.apiKey.startsWith('***')) delete body.apiKey;
  const j = await (await fetch('/api/settings', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)})).json();
  if (j.ok) { addSystem('设置已保存'); $('settings-modal').style.display = 'none'; }
};

// ====================== 仿真投影 ======================
$('sim-launch').onclick = async () => {
  $('sim-status').textContent = '启动中…';
  const r = await fetch('/api/sim/launch', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({})});
  const j = await r.json();
  if (j.error) { $('sim-status').textContent = '失败'; addSystem('启动 ParaView 失败：' + j.error); }
  else { $('sim-status').textContent = `运行中 (PID ${j.pid})`; }
};
$('sim-close').onclick = async () => { await fetch('/api/sim/close', {method:'POST'}); $('sim-status').textContent = '已关闭'; };

function showSimFrame(dataUrl) {
  const v = $('sim-viewport');
  let img = v.querySelector('img');
  if (!img) { v.innerHTML = ''; img = document.createElement('img'); img.alt = 'ParaView'; v.appendChild(img); }
  img.src = dataUrl;
}

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
    case 'agent_start': setRunning(true); break;
    case 'agent_end': setRunning(false); $('input').focus(); break;
    case 'assistant_start': currentAssistantBubble = addAssistantBubble(); break;
    case 'delta': if (currentAssistantBubble) { currentAssistantBubble._raw = (currentAssistantBubble._raw || '') + m.text; currentAssistantBubble.textContent = currentAssistantBubble._raw; scrollChat(); } break;
    case 'assistant_end': if (currentAssistantBubble) { renderMarkdownInto(currentAssistantBubble, currentAssistantBubble._raw || currentAssistantBubble.textContent); } currentAssistantBubble = null; break;
    case 'tool_call': { const el = renderTool(m.id, m.name, m.args); toolEls.set(m.id, el); addTerm(`▶ [agent] ${m.name}(${shortArgs(m.args)})`, 'agent'); break; }
    case 'approval_request': renderApproval(m); addTerm(`⚠ [需审批] ${m.name}: ${m.args.command || m.args.case_path || ''}`, 'err'); break;
    case 'tool_result': { const el = toolEls.get(m.id);
      const isErr = String(m.result).includes('错误') || String(m.result).startsWith('执行失败') || String(m.result).startsWith('启动失败');
      addTerm(`◀ [agent] ${m.name} → ` + String(m.result).split('\n')[0].slice(0,140), isErr ? 'err' : 'ok');
      if (el) {
        const tr = el.querySelector('.tool-result');
        tr.textContent = m.result;
        // 提取结果里的 http(s) 或 本地 /api/file?raw=1 图片 URL，渲染缩略图
        try {
          const urls = (String(m.result).match(/(?:https?:\/\/[^\s<>"'`]+|\/api\/file\?[^\s<>"'`]+)\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?[^\s<>"'`]*)?/gi) || []);
          if (urls.length || m.name === 'download_file') {
            const gal = document.createElement('div'); gal.className = 'tool-images';
            gal.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;';
            urls.slice(0, 12).forEach(u => {
              const a = document.createElement('a'); a.href = u; a.target = '_blank';
              a.title = u + '  (点击新标签打开 · 右键另存)';
              a.style.cssText = 'display:inline-block;width:120px;height:90px;overflow:hidden;border:1px solid var(--line2);border-radius:4px;background:#0a0612;';
              const img = document.createElement('img'); img.src = u; img.referrerPolicy = 'no-referrer';
              img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
              img.onerror = () => { a.innerHTML = '<div style="font-size:9px;padding:4px;color:#fca5a5;">' + u.slice(-40) + ' 加载失败</div>'; };
              a.appendChild(img); gal.appendChild(a);
            });
            // 下载并保存按钮：让模型/用户一键收藏到 downloads/
            if (urls.length) {
              const bar = document.createElement('div');
              bar.style.cssText = 'margin-top:4px;font-size:10px;';
              bar.innerHTML = `<span class="muted">共 ${urls.length} 张图片，agent 可调用 download_file 下载</span>`;
              tr.appendChild(bar);
            }
            tr.appendChild(gal);
          }
        } catch {}
        const st = el.querySelector('.status');
        st.textContent = isErr ? '✗ 失败' : '✓ 完成'; st.className = 'status ' + (isErr ? 'err' : 'ok'); } break; }
    case 'term': addTerm(m.line); break;
    case 'pty_out': addTerm(m.line); break;
    case 'tree': renderTree(m.tree); break;
    case 'checkpoints': renderCheckpoints(m.list); break;
    case 'pending_edits': renderPending(m.list); break;
    case 'todos': renderTodos(m.list); break;
    case 'usage': showUsage(m.usage); break;
    case 'task_complete': addSystem('任务完成：' + (m.summary || '')); break;
    case 'sim_state': $('sim-status').textContent = m.running ? '运行中' : '未启动'; break;
    case 'sim_started': $('sim-status').textContent = `运行中 (PID ${m.pid})`; break;
    case 'sim_closed': $('sim-status').textContent = '已关闭'; $('sim-viewport').innerHTML = '<div class="sim-empty">ParaView 已关闭</div>'; break;
    case 'sim_frame': showSimFrame(m.dataUrl); $('sim-status').textContent = '已渲染'; if (m.meta) updateSimMeta(m.meta); try { smOnSimFrame(m.dataUrl, m.meta || {}); } catch {} break;
    case 'sim_error': $('sim-status').textContent = '抓帧异常'; break;
    case 'sim_compare': addCompareFrame(m); break;
    case 'heartbeat': /* 仅作活跃信号 */ break;
    case 'images': addToGallery(m.images, m.query); break;
    case 'foam_state': updateFoamState(m.enabled, m.root); break;
    case 'error': addSystem('错误：' + m.message); addTerm('[错误] ' + m.message, 'err'); setRunning(false); break;
    case 'reset_done': {
      const chat = $('chat'); if (chat) chat.innerHTML = '';
      clearChatHistory();
      const td = $('todos'); if (td) td.innerHTML = '<div class="muted small">尚无任务</div>';
      const cp = $('checkpoints'); if (cp) cp.innerHTML = '<div class="muted small">尚无检查点</div>';
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
  const div = document.createElement('div'); div.className = 'msg user';
  div.innerHTML = `<div class="role">你</div><div class="bubble"></div>`;
  const b = div.querySelector('.bubble'); b.textContent = text;
  for (const a of (atts || [])) {
    if (a.type === 'image') { const im = document.createElement('img'); im.src = a.dataUrl; b.appendChild(im); }
    else { const p = document.createElement('div'); p.style.fontSize='10px'; p.style.color='#aaccff'; p.textContent = (a.type === 'context_file' ? '📄 ' : '📎 ') + (a.path || a.name); b.appendChild(p); }
  }
  $('chat').appendChild(div); scrollChat();
}
function addAssistantBubble() { const div = document.createElement('div'); div.className = 'msg assistant'; div.innerHTML = `<div class="role">NullFlux</div><div class="bubble"></div>`; $('chat').appendChild(div); scrollChat(); return div.querySelector('.bubble'); }
function addSystem(text) { const div = document.createElement('div'); div.className = 'msg system'; div.innerHTML = `<div class="bubble"></div>`; div.querySelector('.bubble').textContent = text; $('chat').appendChild(div); scrollChat(); }

// ====================== Markdown + KaTeX (lazy CDN) ======================
let _mdReady = null;
async function ensureMD() {
  if (_mdReady) return _mdReady;
  _mdReady = (async () => {
    const out = {};
    try {
      const m = await import('https://cdn.jsdelivr.net/npm/marked@12.0.0/lib/marked.esm.js');
      out.marked = m.marked || m.default || m;
    } catch (e) { out.marked = null; }
    try {
      const k = await import('https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.mjs');
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
    scrollChat();
  } catch (e) {
    bubble.textContent = text;
  }
}function renderTool(id, name, args) {
  const div = document.createElement('div'); div.className = 'tool';
  div.innerHTML = `<div class="tool-head"><span>🔧 ${name}</span><span class="status">运行中…</span></div><div class="tool-args"></div><div class="tool-result"></div>`;
  div.querySelector('.tool-args').textContent = JSON.stringify(args, null, 2);
  $('chat').appendChild(div); scrollChat(); return div;
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
function renderNode(node, isRoot, depth) {
  depth = depth || 0;
  const wrap = document.createElement('div');
  if (!isRoot) {
    const el = document.createElement('div'); el.className = 'tree-node ' + node.type;
    el.dataset.path = node.path;
    el.style.paddingLeft = (8 + depth * 12) + 'px';
    if (node.type === 'file') {
      el.textContent = '📄 ' + node.name;
      el.onclick = () => openFile(node.path);
    }
    if (node.type === 'dir') {
      // 默认折叠，顶层（depth=0）展开
      let exp = (depth === 0);
      const ch = document.createElement('div'); ch.className = 'tree-children';
      ch.style.display = exp ? '' : 'none';
      const arrow = () => exp ? '▾' : '▸';
      const icon  = () => exp ? '📂' : '📁';
      el.textContent = `${arrow()} ${icon()} ${node.name}`;
      let loaded = false;
      const loadChildren = () => { if (loaded) return; loaded = true;
        (node.children || []).forEach(c => ch.appendChild(renderNode(c, false, depth + 1)));
      };
      if (exp) loadChildren();
      el.onclick = () => {
        exp = !exp;
        if (exp) loadChildren();
        ch.style.display = exp ? '' : 'none';
        el.textContent = `${arrow()} ${icon()} ${node.name}`;
      };
      wrap.appendChild(el); wrap.appendChild(ch); return wrap;
    }
    wrap.appendChild(el); return wrap;
  }
  (node.children || []).forEach(c => wrap.appendChild(renderNode(c, false, 0)));
  return wrap;
}
function renderCheckpoints(list) {
  if (!list.length) { $('checkpoints').innerHTML = '<div class="muted small">尚无检查点</div>'; return; }
  $('checkpoints').innerHTML = '';
  [...list].reverse().forEach(c => {
    const d = document.createElement('div'); d.className = 'cp-item';
    const tm = new Date(c.timestamp).toLocaleTimeString();
    d.innerHTML = `<div class="label"></div><div class="meta-row"><span>${tm} · ${c.fileCount} 文件</span><button>↶ 回滚</button></div>`;
    d.querySelector('.label').textContent = c.label;
    d.querySelector('button').onclick = () => {
      if (!confirm('回滚到此检查点？会丢弃之后的所有文件修改。')) return;
      ws.send(JSON.stringify({ type:'restore_checkpoint', id:c.id }));
      // 回滚后重载所有打开的 tab
      setTimeout(() => { for (const p of tabs.keys()) reloadOpenFile(p); }, 400);
    };
    $('checkpoints').appendChild(d);
  });
}
function renderPending(list) {
  if (!list.length) { $('pending-bar').style.display = 'none'; $('pending-list').innerHTML = ''; return; }
  $('pending-bar').style.display = ''; $('pending-count').textContent = list.length; $('pending-list').innerHTML = '';
  [...list].reverse().forEach(e => {
    const d = document.createElement('div'); d.className = 'pending-item';
    const badge = e.action === 'create' ? 'create' : 'edit';
    const lbl = e.action === 'create' ? '新建' : (e.action === 'edit' ? '编辑' : '写入');
    d.innerHTML = `<div class="row1"><span class="badge ${badge}">${lbl}</span><span class="pname"></span></div>
      <div class="row2"><button class="mini" data-act="diff">👁</button><button class="mini" data-act="open">📝</button><button class="mini ok" data-act="keep">✓ Keep</button><button class="mini no" data-act="undo">↶ Undo</button></div>`;
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
  if (!list?.length) { $('todos').innerHTML = '<div class="muted small">尚无任务</div>'; return; }
  const done = list.filter(t => t.done).length;
  $('todos').innerHTML = `<div class="todo-progress">进度 ${done}/${list.length}</div>`;
  list.forEach(t => { const d = document.createElement('div'); d.className = 'todo-item' + (t.done ? ' done' : '');
    d.innerHTML = `<span>${t.done ? '✅' : '⬜'}</span><span class="text"></span>`;
    d.querySelector('.text').textContent = t.text; $('todos').appendChild(d); });
}
$('keep-all').onclick = () => ws.send(JSON.stringify({type:'keep_all'}));
$('undo-all').onclick = () => { if (confirm('撤销全部？')) ws.send(JSON.stringify({type:'undo_all'})); };

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
  try {
    const html = localStorage.getItem(CHAT_HISTORY_KEY);
    const chat = $('chat'); if (!chat || !html) return;
    chat.innerHTML = html;
    // 恢复后追加一条系统提示
    const tip = document.createElement('div');
    tip.className = 'msg system';
    tip.innerHTML = '<div class="bubble" style="opacity:.7;font-size:12px;">— 上方为本地缓存历史（仅前端可见，新对话仍是新上下文；输入 /clear 可清空）—</div>';
    chat.appendChild(tip);
    chat.scrollTop = chat.scrollHeight;
  } catch {}
}
restoreChatHistory();

// ====================== ParaView 离屏渲染按钮 ======================
let pvView = { azimuth: 0, elevation: 0, zoom: 1.0 };
let pvMeta = { times: [], fields: [], field: '', timeIndex: null };
async function pvRender(extra) {
  const casePath = $('sim-case-input').value.trim();
  if (!casePath) { addSystem('请先在面板输入 case 路径'); return; }
  if (extra) Object.assign(pvView, extra);
  const field = $('sim-field').value || '';
  const ti = $('sim-time-slider').value;
  const time_step = (pvMeta.times.length && ti !== '') ? Number(ti) : null;
  $('sim-status').textContent = '渲染中…';
  try {
    const r = await fetch('/api/sim/render', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ case_path: casePath, ...pvView, field, time_step }) });
    const j = await r.json();
    if (j.error) { $('sim-status').textContent = '失败'; addSystem('pvpython 渲染失败：' + j.error); }
    else { $('sim-status').textContent = '已渲染'; if (j.meta) updateSimMeta(j.meta); }
  } catch (e) { $('sim-status').textContent = '失败'; addSystem(e.message); }
}
function updateSimMeta(meta) {
  pvMeta.times = meta.times || [];
  pvMeta.fields = (meta.fields && meta.fields.length) ? meta.fields : [...(meta.point_arrays||[]), ...(meta.cell_arrays||[])];
  // 填充场下拉
  const sel = $('sim-field'); const cur = meta.field_used || sel.value;
  sel.innerHTML = '<option value="">(无 / 单色)</option>' + pvMeta.fields.map(f => `<option value="${f}"${f===cur?' selected':''}>${f}</option>`).join('');
  // 时间步滑动条
  const sl = $('sim-time-slider'); const lab = $('sim-time-label');
  if (pvMeta.times.length > 0) {
    sl.min = 0; sl.max = pvMeta.times.length - 1;
    if (meta.time_index !== null && meta.time_index !== undefined) sl.value = meta.time_index;
    const idx = Number(sl.value);
    lab.textContent = `${idx+1}/${pvMeta.times.length} · t=${pvMeta.times[idx]?.toFixed?.(4) ?? pvMeta.times[idx]}`;
  } else {
    sl.min = 0; sl.max = 0; sl.value = 0; lab.textContent = '稳态 / 无时间步';
  }
}
$('sim-render').onclick = () => pvRender();
$('sim-rotL').onclick = () => pvRender({ azimuth: pvView.azimuth - 30 });
$('sim-rotR').onclick = () => pvRender({ azimuth: pvView.azimuth + 30 });
$('sim-zoomIn').onclick = () => pvRender({ zoom: pvView.zoom * 1.2 });
$('sim-zoomOut').onclick = () => pvRender({ zoom: pvView.zoom * 0.8 });
$('sim-field').onchange = () => pvRender();
$('sim-time-slider').oninput = () => {
  const idx = Number($('sim-time-slider').value);
  if (pvMeta.times.length > 0) $('sim-time-label').textContent = `${idx+1}/${pvMeta.times.length} · t=${pvMeta.times[idx]?.toFixed?.(4) ?? pvMeta.times[idx]}`;
};
$('sim-time-slider').onchange = () => pvRender();
$('sim-time-prev').onclick = () => { const sl = $('sim-time-slider'); sl.value = Math.max(0, Number(sl.value) - 1); pvRender(); };
$('sim-time-next').onclick = () => { const sl = $('sim-time-slider'); sl.value = Math.min(Number(sl.max), Number(sl.value) + 1); pvRender(); };
$('sim-inspect').onclick = () => pvRender();

// ParaView 文件浏览
async function simBrowse(p) {
  try {
    const r = await fetch('/api/sim/browse?path=' + encodeURIComponent(p || '.'));
    const j = await r.json(); if (j.error) { addSystem('浏览失败：' + j.error); return; }
    $('sim-browse-path').textContent = j.path;
    const list = $('sim-browse-list'); list.innerHTML = '';
    if (j.parent !== null) {
      const up = document.createElement('div'); up.className = 'py-item';
      up.innerHTML = `<div><span class="py-ver">📁 ..</span></div><div class="py-path">上一级</div>`;
      up.onclick = () => simBrowse(j.parent);
      list.appendChild(up);
    }
    j.items.forEach(it => {
      const div = document.createElement('div'); div.className = 'py-item';
      const icon = it.dir ? '📁' : '📄';
      div.innerHTML = `<div><span class="py-ver">${icon} ${it.name}</span></div><div class="py-path">${it.dir ? '目录（双击进入，单击选为 case）' : '文件'}</div>`;
      const full = j.path === '.' ? it.name : (j.path + '/' + it.name);
      let lastClick = 0;
      div.onclick = () => {
        const now = Date.now();
        if (it.dir && now - lastClick < 400) { simBrowse(full); return; }
        lastClick = now;
        $('sim-case-input').value = full;
        $('sim-browse-modal').style.display = 'none';
        pvRender();
      };
      list.appendChild(div);
    });
    $('sim-browse-modal').style.display = 'flex';
  } catch (e) { addSystem('浏览失败：' + e.message); }
}
$('sim-browse').onclick = () => simBrowse($('sim-case-input').value.trim() || '.');
$('sim-browse-close').onclick = $('sim-browse-cancel').onclick = () => $('sim-browse-modal').style.display = 'none';

// ====================== 图片库面板 ======================
const GALLERY = []; // {image, thumb, title, source, host, query}
function addToGallery(images, query) {
  if (!Array.isArray(images) || !images.length) return;
  for (const img of images) {
    if (!img || !img.image) continue;
    if (GALLERY.find(g => g.image === img.image)) continue;
    GALLERY.unshift({ ...img, query: query || '' });
  }
  if (GALLERY.length > 200) GALLERY.length = 200;
  renderGallery();
}
function renderGallery() {
  const grid = $('gallery-grid'); const empty = $('gallery-empty');
  $('gal-count').textContent = GALLERY.length;
  if (!GALLERY.length) { empty.style.display = 'block'; grid.innerHTML = ''; return; }
  empty.style.display = 'none';
  grid.innerHTML = '';
  GALLERY.forEach((g, i) => {
    const card = document.createElement('div');
    card.style.cssText = 'background:#0a0612;border:1px solid var(--line2);border-radius:5px;overflow:hidden;cursor:pointer;display:flex;flex-direction:column;';
    card.title = (g.title || '') + '\n' + g.image + (g.host ? '\n来源: ' + g.host : '');
    card.innerHTML = `
      <div style="width:100%;height:120px;background:#111;display:flex;align-items:center;justify-content:center;overflow:hidden;">
        <img src="${g.thumb || g.image}" referrerpolicy="no-referrer" style="max-width:100%;max-height:100%;object-fit:cover;" onerror="this.parentElement.innerHTML='<div style=&quot;font-size:9px;color:#fca5a5;padding:4px;&quot;>缩略图加载失败</div>'" />
      </div>
      <div style="padding:4px 6px;font-size:10px;line-height:1.3;color:#aaa;height:32px;overflow:hidden;">
        <div style="color:#ddd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${(g.title||'(无标题)').replace(/[<>]/g,'')}</div>
        <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${g.host || (g.query ? '搜:'+g.query : '')}</div>
      </div>
      <div style="display:flex;gap:2px;padding:0 4px 4px;">
        <button class="mini" data-act="view" style="flex:1;font-size:9px;">大图</button>
        <button class="mini" data-act="dl" style="flex:1;font-size:9px;">下载</button>
        <button class="mini" data-act="open" style="flex:1;font-size:9px;">原页</button>
      </div>`;
    card.querySelectorAll('button').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        const act = b.dataset.act;
        if (act === 'view') openLightbox(g);
        else if (act === 'dl') downloadGalleryImage(g);
        else if (act === 'open') window.open(g.source || g.image, '_blank');
      };
    });
    card.onclick = () => openLightbox(g);
    grid.appendChild(card);
  });
}
function openLightbox(g) {
  $('img-lightbox-img').src = g.image;
  $('img-lightbox-img').referrerPolicy = 'no-referrer';
  $('img-lightbox-open').href = g.image;
  $('img-lightbox-meta').textContent = (g.title || '') + '  ·  ' + g.image + (g.host ? '  ·  ' + g.host : '');
  $('img-lightbox-dl').onclick = () => downloadGalleryImage(g);
  $('img-lightbox').style.display = 'flex';
}
$('img-lightbox-close').onclick = () => $('img-lightbox').style.display = 'none';
$('img-lightbox').onclick = (e) => { if (e.target.id === 'img-lightbox') $('img-lightbox').style.display = 'none'; };
async function downloadGalleryImage(g) {
  try {
    const r = await fetch('/api/download_image', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url: g.image }) });
    const j = await r.json();
    if (j.error) addSystem('下载失败：' + j.error);
    else addSystem('已下载：' + j.message);
  } catch (e) { addSystem('下载失败：' + e.message); }
}
$('gal-search').onclick = async () => {
  const q = $('gal-prompt').value.trim(); if (!q) return;
  $('gal-search').disabled = true; $('gal-search').textContent = '搜索中…';
  try {
    const r = await fetch('/api/image_search', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ query: q, top_k: 16 }) });
    const j = await r.json();
    if (j.error) addSystem('搜图失败：' + j.error);
    else if (!j.count) addSystem('未找到图片（可能被反爬）');
  } catch (e) { addSystem('搜图失败：' + e.message); }
  finally { $('gal-search').disabled = false; $('gal-search').textContent = '搜索'; }
};
$('gal-prompt').addEventListener('keydown', e => { if (e.key === 'Enter') $('gal-search').click(); });
$('gal-clear').onclick = () => { GALLERY.length = 0; renderGallery(); };

// ====================== OpenFOAM Beta 面板 ======================
const FOAM_STATE = { enabled: false, root: '' };
function updateFoamState(enabled, root) {
  const wasEnabled = FOAM_STATE.enabled;
  FOAM_STATE.enabled = !!enabled; FOAM_STATE.root = root || '';
  $('foam-state').textContent = FOAM_STATE.enabled ? 'Beta 已启用' : '未启用';
  $('foam-state').style.color = FOAM_STATE.enabled ? '#a3e635' : '';
  $('foam-toggle').textContent = FOAM_STATE.enabled ? '关闭' : '启用';
  $('foam-root-text').textContent = FOAM_STATE.root || '(未设置 — 点 ⚙ 配置)';
  $('foam-cfg-root').value = FOAM_STATE.root || '';
  // 启用时自动打开 OpenFOAM 与求解器监测面板
  if (FOAM_STATE.enabled && !wasEnabled) {
    setPanelVisible('foam', true);
    setPanelVisible('solver-monitor', true);
  }
}
async function refreshFoamConfig() {
  try { const r = await fetch('/api/foam/config').then(r => r.json()); updateFoamState(r.foamMode, r.root); } catch {}
}
refreshFoamConfig();

$('foam-toggle').onclick = () => {
  if (!FOAM_STATE.enabled && !FOAM_STATE.root) { $('foam-config').click(); return; }
  ws.send(JSON.stringify({ type: 'set_foam', value: !FOAM_STATE.enabled }));
};
$('foam-config').onclick = () => { $('foam-cfg-root').value = FOAM_STATE.root || ''; $('foam-cfg-status').textContent = ''; $('foam-cfg-modal').style.display = 'flex'; $('foam-cfg-root').focus(); };
$('foam-cfg-cancel').onclick = () => $('foam-cfg-modal').style.display = 'none';
$('foam-cfg-save').onclick = async () => {
  const root = $('foam-cfg-root').value.trim();
  $('foam-cfg-status').textContent = '检查中…';
  try {
    await fetch('/api/foam/config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ root, foamMode: true }) });
    const r = await fetch('/api/foam/config').then(r => r.json());
    if (!r.exists) { $('foam-cfg-status').textContent = '⚠ 路径不存在或无权限：' + r.root; $('foam-cfg-status').style.color = '#fca5a5'; return; }
    if (!r.hasTutorials) { $('foam-cfg-status').textContent = '⚠ 路径下未发现 tutorials/ 子目录'; $('foam-cfg-status').style.color = '#fbbf24'; }
    else { $('foam-cfg-status').textContent = '✓ tutorials/ ' + (r.hasSrc ? '+ src/' : '') + ' 检测通过'; $('foam-cfg-status').style.color = '#a3e635'; }
    ws.send(JSON.stringify({ type: 'set_foam', value: true }));
    setTimeout(() => $('foam-cfg-modal').style.display = 'none', 700);
  } catch (e) { $('foam-cfg-status').textContent = '失败：' + e.message; $('foam-cfg-status').style.color = '#fca5a5'; }
};

function foamRenderResults(text, kind) {
  const el = $('foam-results');
  if (!text || /^未找到/.test(text)) { el.innerHTML = `<div class="muted small" style="padding:10px;">${text || '(空)'}</div>`; return; }
  // 解析每条 "1. <rel>\n   绝对路径：<abs>"
  const blocks = text.split(/\n(?=\d+\.\s)/).filter(b => /^\d+\./.test(b));
  if (!blocks.length) { el.textContent = text; return; }
  el.innerHTML = '';
  blocks.forEach(b => {
    const m1 = b.match(/^\d+\.\s+(?:\[([^\]]+)\]\s+)?(.+?)\n\s+绝对路径：(.+?)$/m);
    const tag = m1 ? (m1[1] || '') : '';
    const rel = m1 ? m1[2].trim() : b.split('\n')[0];
    const abs = m1 ? m1[3].trim() : '';
    const row = document.createElement('div');
    row.style.cssText = 'border-bottom:1px dashed var(--line2);padding:4px 0;display:flex;flex-direction:column;gap:3px;';
    row.innerHTML = `
      <div style="color:#ddd;word-break:break-all;">${tag ? `<span style="color:#a3e635;">[${tag}]</span> ` : ''}${rel}</div>
      <div class="muted" style="font-size:9px;word-break:break-all;">${abs}</div>
      <div style="display:flex;gap:4px;flex-wrap:wrap;">
        ${kind === 'tutorial' ? '<button class="mini" data-act="clone">克隆到工作区</button>' : ''}
        <button class="mini" data-act="ask">问 agent</button>
        ${kind !== 'tutorial' ? '<button class="mini" data-act="read">读源码片段</button>' : ''}
      </div>`;
    row.querySelectorAll('button').forEach(btn => {
      btn.onclick = () => {
        const act = btn.dataset.act;
        if (act === 'clone') foamCloneFromUI(rel);
        else if (act === 'ask') foamAskAgent(rel, abs, kind);
        else if (act === 'read') foamAskRead(rel, abs);
      };
    });
    el.appendChild(row);
  });
}

async function foamCloneFromUI(rel) {
  const dest = prompt('克隆到工作区的目标目录（相对路径）：', rel.split('/').pop());
  if (!dest) return;
  try {
    const r = await fetch('/api/foam/clone', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ tutorial_path: rel, dest }) }).then(r => r.json());
    if (r.error) { addSystem('克隆失败：' + r.error); return; }
    addSystem(r.message || '克隆完成');
    // 顺手让 agent 接手
    foamSendChat(`我刚把 OpenFOAM 教程 ${rel} 克隆到了 ${dest}。\n请按流水式工作流接手：\n1. 调 foam_inspect_case("${dest}") 摘要算例。\n2. 用 update_todos 列出所有需要我确认的边界条件 / 物性 / 网格 / 求解器 / 时间步项。\n3. 然后**一次只问我一项**（每项给默认值与可选范围），我答完你 edit_file 改 dictionary，再问下一项。\n4. 全部确认后跑 blockMesh→checkMesh→求解器，最后 sim_render 看结果。`);
  } catch (e) { addSystem('克隆失败：' + e.message); }
}
function foamAskAgent(rel, abs, kind) {
  if (kind === 'tutorial') {
    foamSendChat(`请基于 OpenFOAM 教程 ${rel}（绝对路径 ${abs}）按流水式工作流帮我建立算例：\n1. 先 foam_inspect_case 该教程；\n2. 问我目标工作区目录名（默认 ${rel.split('/').pop()}）；\n3. foam_clone_tutorial 到该目录；\n4. update_todos 列出所有边界条件/物性/网格/时间步需要确认的项（5–20 项）；\n5. 一次只问我一项，我答了就 edit_file 改 dictionary 并把这一项 todo 标 done；\n6. 全确认后跑 blockMesh→checkMesh→求解器→sim_render。`);
  } else {
    foamSendChat(`请把 OpenFOAM 源码 ${rel}（${abs}）作为参考帮我实现/修改模型：\n1. 先 read_file 这个文件，把关键类/函数贴给我；\n2. 问我是"原地用"还是"fork 到 user-libs/<MyModel>/ 改写后 wmake"；\n3. 按我的回答执行，包括写 Make/files 和 Make/options、wmake，并在我的算例 constant/ 中切到新模型名；\n4. 一步一确认，不要全自动跑完。`);
  }
}
function foamAskRead(rel, abs) {
  foamSendChat(`请 read_file ${abs}（OpenFOAM 路径 ${rel}）的前 200 行，并用 3–5 行中文概述这个类/函数干什么、关键参数有哪些。`);
}

function foamSendChat(text) {
  // 把 text 填进输入框并触发 send
  $('input').value = text;
  $('send').click();
}

$('foam-search').onclick = async () => {
  if (!FOAM_STATE.root) { addSystem('请先点 ⚙ 设置 OpenFOAM 根目录'); return; }
  const q = $('foam-q').value.trim();
  const kindSel = $('foam-kind').value;
  if (!q) { $('foam-results').innerHTML = '<div class="muted small" style="padding:10px;">请输入关键词</div>'; return; }
  $('foam-search').disabled = true; $('foam-search').textContent = '…';
  try {
    let url, isTutorial = (kindSel === 'tutorial');
    if (isTutorial) url = `/api/foam/tutorials?q=${encodeURIComponent(q)}&top_k=30`;
    else url = `/api/foam/source?q=${encodeURIComponent(q)}&kind=${encodeURIComponent(kindSel)}&top_k=20`;
    const r = await fetch(url);
    const t = await r.text();
    if (!r.ok) { $('foam-results').innerHTML = `<div class="small" style="color:#fca5a5;padding:10px;">${t}</div>`; }
    else foamRenderResults(t, isTutorial ? 'tutorial' : 'src');
  } catch (e) { $('foam-results').textContent = '失败：' + e.message; }
  finally { $('foam-search').disabled = false; $('foam-search').textContent = '搜索'; }
};
$('foam-q').addEventListener('keydown', e => { if (e.key === 'Enter') $('foam-search').click(); });

// 流水式工作流引导按钮
$('foam-flow-have') && ($('foam-flow-have').onclick = () => {
  if (!FOAM_STATE.enabled) { addSystem('请先启用 OpenFOAM Beta 模式'); return; }
  const p = prompt('告诉智能体你已经有的算例的相对路径或绝对路径：', '');
  if (!p) return;
  foamSendChat(`我已经有具体算例了，路径是 \`${p}\`。请严格按流水式工作流：\n1. 先调 foam_inspect_case("${p}") 一次性摘要并递归列出所有文件；\n2. 用 update_todos 列出 5–20 项可改项（边界条件/物性/网格/求解器/时间步/写出频率…）；\n3. 在聊天里给我**带编号的推荐选项**，每项标注默认值；\n4. **一次只问我一项**，我答了就改 dictionary 并继续；\n5. 全确认后用 foam_run_solver_async 后台跑 blockMesh→checkMesh→求解器，每个 runId 让我在监测面板看。`);
});
$('foam-flow-need') && ($('foam-flow-need').onclick = () => {
  if (!FOAM_STATE.enabled) { addSystem('请先启用 OpenFOAM Beta 模式'); return; }
  const kw = prompt('告诉智能体你的关键词（如 bubbleColumn / twoPhaseEulerFoam / RANS / 自然对流）：', '');
  if (!kw) return;
  foamSendChat(`我没有具体算例，关键词：${kw}。请：\n1. 调 foam_find_tutorial("${kw}", 12) 列本地 tutorials 候选；\n2. 用 update_todos 把候选写成清单；\n3. 在聊天里用 1) 2) 3) 编号列出（每行一个候选 + 一行说明），等我回编号；\n4. **不要替我做选择**。我选了之后再 foam_clone_tutorial，然后 foam_inspect_case，然后再按流水式工作流逐项问我。`);
});
$('foam-flow-paper') && ($('foam-flow-paper').onclick = () => {
  if (!FOAM_STATE.enabled) { addSystem('请先启用 OpenFOAM Beta 模式'); return; }
  const p = prompt('给我论文 PDF / DOCX 路径（绝对或相对工作区）：\n例: papers/wenyu2003_drag.pdf', '');
  if (!p) return;
  const hint = prompt('（可选）一句话提示这是关于什么的算法，例：\n  WenYu 曳力修正 / k-omega SST / VOF surface tension /\n  population balance / 翼型颤振气动力\n直接回车跳过：', '') || '';
  foamSendChat([
    `请按"📄 论文 → OpenFOAM 植入工作流"严格执行：`,
    ``,
    `**论文文件**：\`${p}\``,
    hint ? `**用户提示**：${hint}` : ``,
    ``,
    `开始：`,
    `P1. 调 read_document("${p}") 读全文。`,
    `P2. 用 update_todos 写 4 项摘要：①算法名/类别 ②核心公式（含 Eq. 编号）③变量与常数 ④应替换/扩展的 OpenFOAM 模块类别。`,
    `P3. 调 foam_find_source 找最近的"参考实现"（例如同类 drag/turbulence/bc），read_file 读其 .H/.C，把骨架贴回（≤80 行核心段）。`,
    `P4. **给我决策菜单**（4 个 1)2)3) 编号问题，每个标 ✅ 默认）：实现方式 / 落地目录 / 参数传入方式 / 验证 case。等我回完 4 个再继续。`,
    `P5. 我选完后逐文件 write_file 创建 .H/.C/Make/files/Make/options，每个文件 commit 前贴 diff 摘要；用 foam_run_solver_async 跑 wmake libso 编译。`,
    `P6. 编译过了再跑验证 case，最后 sim_render 出图。`,
    ``,
    `纪律：每步问之前先在聊天里讲清楚"我现在在第 P? 步"。**严禁** 跳过 P3/P4 直接写 .C 文件。`
  ].filter(Boolean).join('\n'));
});

$('foam-flow-stl') && ($('foam-flow-stl').onclick = () => {
  if (!FOAM_STATE.enabled) { addSystem('请先启用 OpenFOAM Beta 模式'); return; }
  const stl = prompt('STL 文件路径（绝对或相对工作区）：\n例: geom/sphere.stl', '');
  if (!stl) return;
  const cd = prompt('目标 case 目录（会自动创建；相对或绝对）：\n例: cases/sphere_extflow', '');
  if (!cd) return;
  foamSendChat([
    `请按"🔧 STL → 网格自动化工作流"严格执行：`,
    ``,
    `**STL**: \`${stl}\`     **case**: \`${cd}\``,
    ``,
    `M1. 调 foam_stl_inspect("${stl}") 取 bbox/单位猜测/推荐 cell_size 并贴回（≤8 行）。`,
    `M2. **一次性问完** 7 个工况选项（流动类型/主流方向/雷诺数或来流速度/求解器/湍流/网格细度/边界层），每项标 ✅ 默认值，等我回 7 个数字（用 1234567 格式或逐项回）。`,
    `M3. 我回完后再调 foam_mesh_plan("${cd}", "${stl}", target_cell_size=…, refinement_level_min=1, refinement_level_max=…, n_layers=…, flow_direction="…")。然后 foam_run_solver_async 顺序跑 blockMesh → surfaceFeatures → snappyHexMesh -overwrite → checkMesh，**每步 exit=0** 才走下一步。`,
    `M4. 用 foam_clone_tutorial 拉模板的 0/ + constant，按 M2 答案改边界条件。**绝不**手写 0/。`,
    `M5. foam_run_solver_async 启动求解器；每隔几次轮询调 foam_residual_series 只贴 trends 段。`,
    `M6. 收敛后 sim_render 出 U / p / k 图。`,
    ``,
    `纪律：每步开头先报"现在 M? 步"。**严禁**跳过 M2 直接 foam_mesh_plan。`
  ].join('\n'));
});

$('foam-flow-compare') && ($('foam-flow-compare').onclick = () => {
  if (!FOAM_STATE.enabled) { addSystem('请先启用 OpenFOAM Beta 模式'); return; }
  const a = prompt('case A 路径（相对或绝对）：', '');
  if (!a) return;
  const b = prompt('case B 路径（相对或绝对）：', '');
  if (!b) return;
  const field = prompt('要对比的场（U / p / alpha.water / T 等，空=默认）：', 'U') || '';
  const ts = prompt('时间步索引（空=最后一步，0=第一步，-1=最后一步）：', '') || '';
  foamSendChat(`请调 foam_compare_render({ case_a: "${a}", case_b: "${b}", label_a: "A", label_b: "B"${field ? `, field: "${field}"` : ''}${ts ? `, time_step: "${ts}"` : ''} }) 并排出图。出完图后**用 3-5 句话**比较两侧的定性差异（流场结构、再循环区、剪切层位置等），不要超过 5 句。`);
});

$('foam-flow-residual') && ($('foam-flow-residual').onclick = () => {
  if (!FOAM_STATE.enabled) { addSystem('请先启用 OpenFOAM Beta 模式'); return; }
  const sel = $('sm-run');
  let runId = sel && sel.value ? sel.value : '';
  if (!runId) runId = prompt('输入 runId（在求解器监测面板可看到）：', '') || '';
  if (!runId) return;
  foamSendChat(`请调 foam_residual_series({ run_id: "${runId}", max_points: 40, fields: ["U","Ux","Uy","Uz","p","k","omega","epsilon","T","alpha.water"] })，**只贴 trends 段** + 最后 3 个时间步的初始残差，然后**用 1-3 条具体可执行建议**告诉我下一步该改什么（松弛因子/校正次数/网格质量/时间步），别贴整张表。`);
});

// ====================== 求解器监测面板 ======================
const SM = { runId: '', timer: null, snapTimer: 0, snaps: [], lastSnapTime: -1, lastResidSig: '' };
function smSetStatus(s, color) { const el = $('sm-status'); if (!el) return; el.textContent = s; el.style.color = color || ''; }
async function smRefreshRuns() {
  try {
    const r = await fetch('/api/foam/runs'); const j = await r.json();
    const sel = $('sm-run'); if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">-- 选择 runId --</option>' +
      (j.runs || []).map(x => `<option value="${x.runId}">${x.runId} · ${x.command.slice(0,30)} · ${x.running?'运行中':'已结束'}</option>`).join('');
    if (cur && (j.runs || []).find(x => x.runId === cur)) sel.value = cur;
  } catch (e) { /* 忽略 */ }
}
// 残差曲线绘制（log10 自动缩放，多场叠加）
const RESID_COLORS = ['#a78bfa','#22d3ee','#bef264','#fb923c','#f472b6','#fde047','#34d399','#fca5a5','#7dd3fc','#c084fc'];
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
  ctx.fillStyle = '#0a0612'; ctx.fillRect(0,0,w,h);
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
  const pad = { l: 28, r: 8, t: 8, b: 16 };
  const W = w - pad.l - pad.r, H = h - pad.t - pad.b;
  const sx = t => pad.l + (xmax > xmin ? (t - xmin) / (xmax - xmin) * W : W/2);
  const sy = y => pad.t + (1 - (y - ymin) / (ymax - ymin)) * H;
  // 网格 + log 标签
  ctx.strokeStyle = '#1f1438'; ctx.lineWidth = 1; ctx.font = '9px monospace'; ctx.fillStyle = '#7c6f99';
  for (let yv = Math.ceil(ymin); yv <= Math.floor(ymax); yv++) {
    const py = sy(yv);
    ctx.beginPath(); ctx.moveTo(pad.l, py); ctx.lineTo(pad.l + W, py); ctx.stroke();
    ctx.fillText(`1e${yv}`, 2, py + 3);
  }
  // x 轴
  ctx.fillText(`t=${xmin.toFixed(3)}`, pad.l, h - 3);
  ctx.fillText(`t=${xmax.toFixed(3)}`, pad.l + W - 50, h - 3);
  // 各场曲线
  lg.innerHTML = '';
  lines.forEach((ln, i) => {
    const c = RESID_COLORS[i % RESID_COLORS.length];
    if (ln.pts.length < 2) return;
    ctx.strokeStyle = c; ctx.lineWidth = 1.4; ctx.beginPath();
    ln.pts.forEach((p, k) => { const x = sx(p[0]), y = sy(p[1]); if (k === 0) ctx.moveTo(x,y); else ctx.lineTo(x,y); });
    ctx.stroke();
    const span = document.createElement('span');
    span.style.cssText = `display:inline-flex;align-items:center;gap:3px;color:${c};`;
    span.innerHTML = `<span style="display:inline-block;width:8px;height:8px;background:${c};border-radius:1px;"></span>${ln.f}`;
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
    strip.innerHTML = '<div class="muted small" style="padding:8px;">📸 快照演化轴：跑求解器时点 📸 抓帧或勾选自动；点缩略图放大对比。</div>';
    return;
  }
  strip.innerHTML = '';
  SM.snaps.forEach((s, idx) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:2px;cursor:pointer;';
    wrap.title = `t=${s.t}  field=${s.field}\n${s.casePath}`;
    wrap.innerHTML = `<img src="${s.dataUrl}" style="width:60px;height:42px;object-fit:cover;border:1px solid #4c1d95;border-radius:3px;" /><span class="small" style="font-size:9px;color:#a78bfa;">${s.label}</span>`;
    wrap.onclick = () => smShowSnapModal(idx);
    strip.appendChild(wrap);
  });
}
function smShowSnapModal(idx) {
  const s = SM.snaps[idx]; if (!s) return;
  // 简单大图查看 + 左右切换 + 与上一帧对比按钮
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';
  const card = document.createElement('div');
  card.style.cssText = 'background:#0a0612;padding:12px;border-radius:8px;border:1px solid #4c1d95;max-width:92vw;max-height:92vh;display:flex;flex-direction:column;gap:8px;';
  let cur = idx;
  function render() {
    const s = SM.snaps[cur];
    card.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;color:#c4b5fd;font-size:12px;">
      <span>📸 ${cur+1}/${SM.snaps.length} · ${s.label} · field=${s.field} · ${s.casePath}</span>
      <button id="snap-close" class="mini">✕</button>
    </div>
    <img src="${s.dataUrl}" style="max-width:88vw;max-height:75vh;object-fit:contain;border:1px solid #4c1d95;border-radius:4px;" />
    <div style="display:flex;gap:6px;justify-content:center;">
      <button class="mini" id="snap-prev">◀</button>
      <button class="mini" id="snap-next">▶</button>
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
  sim_render:  ['pvpython 离屏渲染（场+时间步）', 'sim'],
  sim_open_paraview: ['启动 ParaView GUI（外部窗口）', 'sim'],
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

// ====================== 模型选择 / GitHub Copilot ======================
const MODEL_STATE = { provider: 'sf', sfModel: '', copilotModel: 'gpt-4.1', copilotLoggedIn: false, devicePoll: null };

function updateModelLabel() {
  const lab = $('model-label'); if (!lab) return;
  if (MODEL_STATE.provider === 'copilot') lab.textContent = 'Copilot:' + (MODEL_STATE.copilotModel || '?');
  else lab.textContent = MODEL_STATE.sfModel || 'DeepSeek';
}
const USAGE = { input: 0, output: 0, calls: 0 };
function showUsage(u) {
  if (!u) return;
  USAGE.input += (u.prompt_tokens || u.input_tokens || 0);
  USAGE.output += (u.completion_tokens || u.output_tokens || 0);
  USAGE.calls += 1;
  const lab = $('model-label'); if (!lab) return;
  const base = (MODEL_STATE.provider === 'copilot' ? 'Copilot:' + (MODEL_STATE.copilotModel || '?') : (MODEL_STATE.sfModel || 'DeepSeek'));
  lab.textContent = `${base} · ${(USAGE.input/1000).toFixed(1)}k↑ ${(USAGE.output/1000).toFixed(1)}k↓`;
  lab.title = `本会话累计：输入 ${USAGE.input} tokens · 输出 ${USAGE.output} tokens · ${USAGE.calls} 次调用`;
}
async function refreshModelStatus() {
  try {
    const cfg = await (await fetch('/api/config')).json();
    MODEL_STATE.provider = cfg.provider || 'sf';
    MODEL_STATE.copilotModel = cfg.copilotModel || 'gpt-4.1';
    MODEL_STATE.copilotLoggedIn = !!cfg.copilotLoggedIn;
    MODEL_STATE.sfModel = cfg.model || '';
    updateModelLabel();
  } catch {}
}
function selectModelTab(prov) {
  document.querySelectorAll('.mtab').forEach(t => t.classList.toggle('active', t.dataset.prov === prov));
  document.querySelectorAll('.mpane').forEach(p => p.style.display = (p.dataset.prov === prov) ? 'block' : 'none');
  if (prov === 'copilot') refreshCopilotPane();
}
async function refreshCopilotPane() {
  await refreshModelStatus();
  $('cp-loggedout').style.display = MODEL_STATE.copilotLoggedIn ? 'none' : 'block';
  $('cp-loggedin').style.display = MODEL_STATE.copilotLoggedIn ? 'block' : 'none';
  if (MODEL_STATE.copilotLoggedIn) loadCopilotModels(false);
}
async function loadCopilotModels(force) {
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
            $('model-modal').style.display = 'none';
          } else addSystem('切换失败：' + (jj.error || '未知'));
        } catch (e) { addSystem('切换失败：' + e.message); }
      };
      list.appendChild(div);
    });
  } catch (e) { list.innerHTML = `<div class="small" style="color:#fca5a5;padding:10px;">${e.message}</div>`; }
}
$('model-picker').onclick = async () => {
  $('model-modal').style.display = 'flex';
  await refreshModelStatus();
  $('sf-model').value = MODEL_STATE.sfModel || '';
  // 已登录 Copilot 默认进 Copilot 选项卡
  const tab = (MODEL_STATE.provider === 'copilot' || MODEL_STATE.copilotLoggedIn) ? 'copilot' : 'sf';
  selectModelTab(tab);
};
$('model-close').onclick = $('model-cancel').onclick = () => {
  $('model-modal').style.display = 'none';
  if (MODEL_STATE.devicePoll) { clearInterval(MODEL_STATE.devicePoll); MODEL_STATE.devicePoll = null; }
};
document.querySelectorAll('.mtab').forEach(t => t.onclick = () => selectModelTab(t.dataset.prov));
$('sf-apply').onclick = async () => {
  const m = $('sf-model').value.trim(); if (!m) return;
  await fetch('/api/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ provider: 'sf', model: m }) });
  MODEL_STATE.provider = 'sf'; MODEL_STATE.sfModel = m;
  updateModelLabel(); addTerm(`[Model] 已切换到 SiliconFlow · ${m}`, 'ok');
  $('model-modal').style.display = 'none';
};
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
$('cp-refresh').onclick = () => loadCopilotModels(true);
$('cp-logout').onclick = async () => { await fetch('/api/copilot/logout', { method:'POST' }); MODEL_STATE.copilotLoggedIn = false; refreshCopilotPane(); addTerm('[Copilot] 已退出登录', 'sys'); };
refreshModelStatus();


// ====================== .ipynb 笔记本（含 Jupyter kernel 客户端） ======================
const NB_STATE = new Map(); // path -> { nb, cells:Map<cell_id, {div, srcEl, outEl, monaco?, status, count}>, ready, kernelReady }

async function openNotebook(p) {
  await monacoReady; ensureEditor();
  const r = await fetch('/api/file?path=' + encodeURIComponent(p));
  const j = await r.json(); if (j.error) return addSystem('打开失败：' + j.error);
  let nb; try { nb = JSON.parse(j.content); } catch (e) { return addSystem('ipynb JSON 解析失败：' + e.message); }

  // 注入到固定 host，不要破坏 #editor-host
  const host = document.getElementById('nb-host');
  host.innerHTML = `
    <div class="nb-toolbar">
      <span class="nb-title"></span>
      <span id="nb-kernel-state" class="nb-state">⚪ 未连接</span>
      <button class="mini ok" id="nb-run-all">▶▶ 运行全部</button>
      <button class="mini" id="nb-add-cell">＋ 单元</button>
      <button class="mini" id="nb-save">保存</button>
      <button class="mini" id="nb-interrupt" title="中断 kernel">■</button>
      <button class="mini" id="nb-restart" title="重启 kernel">⟳</button>
      <button class="mini" id="nb-reload" title="重读磁盘">↻</button>
    </div>
    <div class="nb-cells"></div>`;
  host.querySelector('.nb-title').textContent = `${p} · ${(nb.cells||[]).length} cells`;

  const state = { path: p, nb, cells: new Map(), ready: false };
  NB_STATE.set(p, state);

  const cellsEl = host.querySelector('.nb-cells');
  cellsEl.innerHTML = '';
  for (const c of (nb.cells || [])) {
    if (!c.metadata) c.metadata = {};
    if (!c.metadata.dscm_id) c.metadata.dscm_id = 'c-' + Math.random().toString(36).slice(2,10);
    if (!c.cell_type) c.cell_type = 'code';
    if (!('source' in c)) c.source = '';
    if (c.cell_type === 'code' && !('outputs' in c)) c.outputs = [];
    if (c.cell_type === 'code' && !('execution_count' in c)) c.execution_count = null;
    renderCell(state, c, cellsEl);
  }

  activeTab = p; $('save-file').disabled = true;
  showView('nb');
  renderTabs(); updateActiveFileChip();
  document.querySelectorAll('.tree-node.selected').forEach(n => n.classList.remove('selected'));
  const tn = document.querySelector(`.tree-node[data-path="${CSS.escape(p)}"]`); if (tn) tn.classList.add('selected');

  host.querySelector('#nb-run-all').onclick = () => runAllCells(state);
  host.querySelector('#nb-add-cell').onclick = () => { const c = newCell(); state.nb.cells.push(c); renderCell(state, c, cellsEl); };
  host.querySelector('#nb-save').onclick = () => saveNotebook(state);
  host.querySelector('#nb-interrupt').onclick = () => ws.send(JSON.stringify({ type: 'nb_interrupt', path: p }));
  host.querySelector('#nb-restart').onclick = () => { setKernelState(p, '⏳ 重启中'); ws.send(JSON.stringify({ type: 'nb_restart', path: p })); };
  host.querySelector('#nb-reload').onclick = () => openNotebook(p);

  // 启动 / 复用 kernel
  setKernelState(p, '⏳ 启动中');
  ws.send(JSON.stringify({ type: 'nb_open', path: p }));
}

function newCell() { return { cell_type: 'code', source: '', outputs: [], execution_count: null, metadata: { dscm_id: 'c-' + Math.random().toString(36).slice(2,10) } }; }

function renderCell(state, cell, parentEl) {
  const id = cell.metadata.dscm_id;
  const div = document.createElement('div'); div.className = 'nb-cell ' + cell.cell_type; div.dataset.cid = id;
  const isCode = cell.cell_type === 'code';
  div.innerHTML = `
    <div class="nb-cell-head">
      <span class="nb-cnum">${isCode ? `In [<span class="cn">${cell.execution_count||' '}</span>]:` : '— Markdown —'}</span>
      <span class="nb-cell-actions">
        ${isCode ? '<button class="mini ok nb-run">▶ 运行</button>' : ''}
        <select class="mini nb-type"><option value="code"${isCode?' selected':''}>code</option><option value="markdown"${!isCode?' selected':''}>markdown</option></select>
        <button class="mini nb-up" title="上移">▲</button>
        <button class="mini nb-down" title="下移">▼</button>
        <button class="mini no nb-del" title="删除">×</button>
      </span>
    </div>
    <div class="nb-src-wrap"></div>
    <div class="nb-out"></div>`;
  parentEl.appendChild(div);
  const srcWrap = div.querySelector('.nb-src-wrap');
  const initial = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');
  const ed = monaco.editor.create(srcWrap, {
    value: initial, language: isCode ? 'python' : 'markdown', theme: 'vs-dark', automaticLayout: true,
    fontSize: 12, minimap: { enabled: false }, scrollBeyondLastLine: false, lineNumbers: isCode ? 'on' : 'off',
    wordWrap: 'on', renderLineHighlight: 'none'
  });
  const fitHeight = () => {
    const lines = ed.getModel().getLineCount();
    const h = Math.min(400, Math.max(38, lines * 19 + 12));
    srcWrap.style.height = h + 'px'; ed.layout();
  };
  fitHeight(); ed.onDidChangeModelContent(() => { cell.source = ed.getValue(); fitHeight(); markNbDirty(state); });
  ed.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => runCell(state, cell));

  const outEl = div.querySelector('.nb-out');
  // 渲染已存在的输出
  if (isCode) renderCellOutputs(outEl, cell.outputs || []);

  state.cells.set(id, { div, ed, outEl, cell });

  div.querySelector('.nb-run')?.addEventListener('click', () => runCell(state, cell));
  div.querySelector('.nb-type').onchange = (e) => {
    cell.cell_type = e.target.value;
    if (cell.cell_type === 'code') { cell.outputs = []; cell.execution_count = null; }
    rerenderCells(state); markNbDirty(state);
  };
  div.querySelector('.nb-up').onclick = () => moveCell(state, id, -1);
  div.querySelector('.nb-down').onclick = () => moveCell(state, id, 1);
  div.querySelector('.nb-del').onclick = () => {
    if (!confirm('删除该 cell？')) return;
    state.nb.cells = state.nb.cells.filter(c => c.metadata?.dscm_id !== id);
    rerenderCells(state); markNbDirty(state);
  };
}

function rerenderCells(state) {
  const host = document.getElementById('nb-host');
  const cellsEl = host.querySelector('.nb-cells'); cellsEl.innerHTML = '';
  // dispose old monacos
  for (const v of state.cells.values()) { try { v.ed.dispose(); } catch {} }
  state.cells.clear();
  for (const c of state.nb.cells) renderCell(state, c, cellsEl);
}
function moveCell(state, id, dir) {
  const arr = state.nb.cells; const i = arr.findIndex(c => c.metadata?.dscm_id === id);
  const j = i + dir; if (i < 0 || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]]; rerenderCells(state); markNbDirty(state);
}
function markNbDirty(state) { /* 自动保存或显示 dirty 角标，简单起见保留手动保存 */ }

function renderCellOutputs(outEl, outputs) {
  outEl.innerHTML = '';
  for (const o of (outputs || [])) appendOutput(outEl, o);
  outEl.style.display = (outputs && outputs.length) ? '' : 'none';
}
function appendOutput(outEl, o) {
  outEl.style.display = '';
  if (o.output_type === 'stream' || o.type === 'stream') {
    const pre = document.createElement('pre'); pre.className = 'nb-stream ' + (o.name||'stdout');
    pre.textContent = Array.isArray(o.text) ? o.text.join('') : (o.text || ''); outEl.appendChild(pre);
  } else if (o.output_type === 'error' || o.type === 'error') {
    const pre = document.createElement('pre'); pre.className = 'nb-stream stderr';
    const tb = (o.traceback || []).map(s => String(s).replace(/\x1b\[[0-9;]*m/g,'')).join('\n');
    pre.textContent = (o.ename||'') + ': ' + (o.evalue||'') + (tb ? '\n' + tb : ''); outEl.appendChild(pre);
  } else if (o.output_type === 'display_data' || o.output_type === 'execute_result') {
    const data = o.data || {};
    if (data['image/png']) { const img = document.createElement('img'); img.src = 'data:image/png;base64,' + data['image/png']; img.className = 'nb-img'; outEl.appendChild(img); }
    else if (data['text/html']) { const w = document.createElement('div'); w.className = 'nb-html'; w.innerHTML = Array.isArray(data['text/html'])?data['text/html'].join(''):data['text/html']; outEl.appendChild(w); }
    else if (data['text/plain']) { const pre = document.createElement('pre'); pre.className = 'nb-stream stdout'; pre.textContent = Array.isArray(data['text/plain'])?data['text/plain'].join(''):data['text/plain']; outEl.appendChild(pre); }
  } else if (o.type === 'display') {
    if (o.mime === 'image/png') { const img = document.createElement('img'); img.src = 'data:image/png;base64,' + o.data; img.className = 'nb-img'; outEl.appendChild(img); }
    else if (o.mime === 'text/html') { const w = document.createElement('div'); w.className = 'nb-html'; w.innerHTML = o.data; outEl.appendChild(w); }
    else { const pre = document.createElement('pre'); pre.className = 'nb-stream stdout'; pre.textContent = o.data; outEl.appendChild(pre); }
  }
}

function runCell(state, cell) {
  if (cell.cell_type !== 'code') return;
  const id = cell.metadata.dscm_id;
  const slot = state.cells.get(id); if (!slot) return;
  cell.outputs = []; renderCellOutputs(slot.outEl, []);
  slot.outEl.style.display = ''; slot.outEl.classList.add('running');
  slot.div.querySelector('.cn').textContent = '*';
  ws.send(JSON.stringify({ type: 'nb_execute', path: state.path, code: cell.source || '', cell_id: id }));
}
async function runAllCells(state) {
  for (const c of state.nb.cells) {
    if (c.cell_type !== 'code') continue;
    runCell(state, c);
    // 等待该 cell 的 done 消息（顺序运行）
    await new Promise((res) => {
      const id = c.metadata.dscm_id;
      const handler = (ev) => { const m = ev.detail; if (m.type === 'nb_msg' && m.path === state.path && m.msg.type === 'done' && m.msg.cell_id === id) { window.removeEventListener('dscm-msg', handler); res(); } };
      window.addEventListener('dscm-msg', handler);
    });
  }
}
function setKernelState(path, text) {
  if (activeTab !== path) return;
  const el = document.getElementById('nb-kernel-state'); if (el) el.textContent = text;
}
async function saveNotebook(state) {
  // 把 state.nb 标准化后保存
  const out = JSON.parse(JSON.stringify(state.nb));
  out.nbformat = out.nbformat || 4; out.nbformat_minor = out.nbformat_minor || 5;
  out.metadata = out.metadata || {};
  for (const c of out.cells) {
    c.source = (typeof c.source === 'string') ? c.source : (Array.isArray(c.source) ? c.source.join('') : '');
    if (c.cell_type === 'code') { if (!Array.isArray(c.outputs)) c.outputs = []; if (!('execution_count' in c)) c.execution_count = null; }
    else { delete c.outputs; delete c.execution_count; }
  }
  const r = await fetch('/api/notebook/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: state.path, json: out }) });
  const j = await r.json(); if (j.ok) addTerm(`[Notebook] 已保存 ${state.path}`, 'ok'); else addSystem('保存失败：' + (j.error || ''));
}

// 把 kernel 推过来的消息渲染到对应 cell
function handleNbMsg(path, msg) {
  const state = NB_STATE.get(path); if (!state) return;
  if (msg.type === 'ready') { state.kernelReady = true; setKernelState(path, '🟢 就绪'); return; }
  if (msg.type === 'starting') { setKernelState(path, '⏳ 启动中'); return; }
  if (msg.type === 'fatal') { setKernelState(path, '🔴 ' + (msg.message || '错误')); addSystem('Kernel: ' + msg.message); return; }
  if (msg.type === 'status') { setKernelState(path, msg.state === 'busy' ? '🟡 忙' : '🟢 就绪'); return; }
  const cellId = msg.cell_id; if (!cellId) return;
  const slot = state.cells.get(cellId); if (!slot) return;
  if (msg.type === 'exec_count') { slot.cell.execution_count = msg.n; slot.div.querySelector('.cn').textContent = msg.n; return; }
  if (msg.type === 'done') { slot.outEl.classList.remove('running'); return; }
  if (msg.type === 'stream') {
    appendOutput(slot.outEl, { type: 'stream', name: msg.name, text: msg.text });
    slot.cell.outputs = slot.cell.outputs || []; slot.cell.outputs.push({ output_type: 'stream', name: msg.name, text: msg.text });
  } else if (msg.type === 'display') {
    appendOutput(slot.outEl, { type: 'display', mime: msg.mime, data: msg.data });
    slot.cell.outputs = slot.cell.outputs || []; slot.cell.outputs.push({ output_type: 'display_data', data: { [msg.mime]: msg.data }, metadata: {} });
  } else if (msg.type === 'error') {
    appendOutput(slot.outEl, { type: 'error', ename: msg.ename, evalue: msg.evalue, traceback: msg.traceback });
    slot.cell.outputs = slot.cell.outputs || []; slot.cell.outputs.push({ output_type: 'error', ename: msg.ename, evalue: msg.evalue, traceback: msg.traceback });
    slot.outEl.classList.remove('running');
  }
}

window.addEventListener('dscm-msg', (ev) => {
  const m = ev.detail;
  if (m.type === 'tools_state') {
    TOOL_STATE.enabled = new Set(m.enabled.filter(n => TOOL_LABELS[n]));
    if ($('tools-modal').style.display === 'flex') renderToolsList();
  } else if (m.type === 'nb_msg') {
    handleNbMsg(m.path, m.msg);
  }
});

