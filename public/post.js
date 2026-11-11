// CFDriver 可视化工作台：结果（截面 / 剖切 / 等值面 / 阈值 / 流线 / 矢量 / 体渲染 / 沿线取值）+ 网格与几何（patch、网格线、checkMesh）
// 几何由服务端 VTK 常驻进程计算（/api/post3d/*），这里只负责显示、交互和"聪明的默认值"。
import * as THREE from 'three';
import { OrbitControls } from '/vendor/three/controls/OrbitControls.js';

const $ = id => document.getElementById(id);
const QS = new URLSearchParams(location.search);
if (QS.has('embed')) document.body.classList.add('embed');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = v => !Number.isFinite(v) ? '–' : (v !== 0 && (Math.abs(v) >= 1e5 || Math.abs(v) < 1e-3)) ? v.toExponential(3) : +v.toPrecision(5) + '';
const uid = () => Math.random().toString(36).slice(2, 9);

// ---------------------------------------------------------------- 色图
const CMAPS = {
  viridis: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
  turbo: ['#30123b', '#4662d7', '#36aaf9', '#1ae4b6', '#72fe5e', '#c8ef34', '#faba39', '#f66b19', '#ca2a04', '#7a0403'],
  inferno: ['#000004', '#1b0c41', '#4a0c6b', '#781c6d', '#a52c60', '#cf4446', '#ed6925', '#fb9b06', '#f7d13d', '#fcffa4'],
  coolwarm: ['#3b4cc0', '#5977e3', '#7b9ff9', '#9ebeff', '#c0d4f5', '#dddcdc', '#f2cbb7', '#f7ac8e', '#ee8468', '#d65244', '#b40426'],
  plasma: ['#0d0887', '#46039f', '#7201a8', '#9c179e', '#bd3786', '#d8576b', '#ed7953', '#fb9f3a', '#fdca26', '#f0f921'],
  jet: ['#00007f', '#0000ff', '#007fff', '#00ffff', '#7fff7f', '#ffff00', '#ff7f00', '#ff0000', '#7f0000'],
  gray: ['#111111', '#f0f0f0'],
};
const CMAP_NAMES = { turbo: 'turbo（默认）', viridis: 'viridis', inferno: 'inferno', plasma: 'plasma', coolwarm: 'coolwarm（发散）', jet: 'jet', gray: '灰度' };
const LUTS = {};
function lut(name) {
  if (LUTS[name]) return LUTS[name];
  const stops = CMAPS[name] || CMAPS.turbo, n = stops.length - 1;
  const rgb = stops.map(h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255));
  const out = new Float32Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const x = i / 255 * n, k = Math.min(n - 1, Math.floor(x)), f = x - k;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = rgb[k][c] * (1 - f) + rgb[k + 1][c] * f;
  }
  return (LUTS[name] = out);
}
function lutTexture(name) {
  const L = lut(name), d = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) { d[i * 4] = L[i * 3] * 255; d[i * 4 + 1] = L[i * 3 + 1] * 255; d[i * 4 + 2] = L[i * 3 + 2] * 255; d[i * 4 + 3] = 255; }
  const t = new THREE.DataTexture(d, 256, 1, THREE.RGBAFormat); t.needsUpdate = true; t.magFilter = t.minFilter = THREE.LinearFilter; return t;
}

// ---------------------------------------------------------------- 场名 → 人话
const FIELD_LABEL = { 'alpha.particles': '颗粒体积分数 αs', 'alpha.gas': '气相体积分数 αg', 'U.gas': '气相速度 Ug', 'U.particles': '颗粒速度 Us', p: '压力 p', p_rgh: 'p_rgh', 'T.gas': '气相温度', 'T.particles': '颗粒温度',
  'Theta.particles': '颗粒温度 Θ', 'MeOH.gas': '甲醇质量分数', 'C2H4.gas': '乙烯质量分数', 'C3H6.gas': '丙烯质量分数', 'coke.particles': '积炭质量分数', U: '速度 U', k: '湍动能 k', 'alpha.water': '水相分数' };
const label = (f, comp) => (FIELD_LABEL[f] || FIELD_LABEL[f.replace(/Mean$/, '')] && FIELD_LABEL[f.replace(/Mean$/, '')] + '（时均）' || f) + (comp && comp !== 'mag' ? ` · ${comp} 分量` : '');
const PRIORITY = [/^alpha\.particles$/, /^alpha\./, /^U(\.|$)/, /^p$/, /^T/, /./];

// ---------------------------------------------------------------- 状态
const S = { info: null, case: '', time: null, mode: QS.get('mode') === 'mesh' ? 'mesh' : 'post', layers: [], sel: null, objs: new Map(), dark: false, ortho: false, playing: false, reqSeq: 0, line: null, derived: [] };
// 智能体 post_view 带来的视图状态（base64url JSON）：只在首次打开该算例时用一次
S.pending = (() => { try { const v = QS.get('state'); if (!v) return null; const j = JSON.parse(decodeURIComponent(escape(atob(v.replace(/-/g, '+').replace(/_/g, '/'))))); return j && Array.isArray(j.layers) ? j : null; } catch { return null; } })();
if (S.pending?.mode === 'mesh' || S.pending?.mode === 'post') S.mode = S.pending.mode;
const DKEY = c => 'cfdpost.derived:' + c;
const withD = o => ({ ...o, derived: S.derived });

// ---------------------------------------------------------------- three.js
const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const persp = new THREE.PerspectiveCamera(35, 1, 1e-4, 1e5), orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e5, 1e5);
let camera = persp;
const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.dampingFactor = 0.12;
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 1.1));
const dl = new THREE.DirectionalLight(0xffffff, 0.9); scene.add(dl);
const root = new THREE.Group(); scene.add(root);
function setBg() { renderer.setClearColor(S.dark ? 0x15161a : 0xf7f7f8); view.classList.toggle('dark', S.dark); }
setBg();
function resize() { const w = view.clientWidth, h = view.clientHeight; renderer.setSize(w, h, false); renderer.domElement.style.width = w + 'px'; renderer.domElement.style.height = h + 'px'; persp.aspect = w / h; persp.updateProjectionMatrix(); fitOrtho(); }
function fitOrtho() { const w = view.clientWidth, h = view.clientHeight, d = camera === orthoCam ? orthoCam.userData.half || 1 : 1; orthoCam.left = -d * w / h; orthoCam.right = d * w / h; orthoCam.top = d; orthoCam.bottom = -d; orthoCam.updateProjectionMatrix(); }
new ResizeObserver(resize).observe(view);
(function loop() { requestAnimationFrame(loop); controls.update(); dl.position.copy(camera.position); renderer.render(scene, camera); })();

function bounds() { return S.info ? S.info.bounds : [-1, 1, -1, 1, -1, 1]; }
function center() { const b = bounds(); return [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2]; }
function diag() { const b = bounds(); return Math.hypot(b[1] - b[0], b[3] - b[2], b[5] - b[4]) || 1; }
const AX = { x: 0, y: 1, z: 2 };
function upVec() { const u = [0, 0, 0]; u[AX[S.info?.up || 'y']] = 1; return new THREE.Vector3(...u); }
function setView(kind) {
  const c = new THREE.Vector3(...center()), d = diag(), up = upVec();
  let dir;
  if (kind === 'fit' || kind === 'iso') {
    // 默认视角：从"侧前上方"看，竖直轴朝上；2D 轴对称从正面看展开截面
    if (S.info?.axisym) dir = new THREE.Vector3(0, 0, 1);
    else { const side = up.y ? new THREE.Vector3(1, 0.55, 1.4) : up.z ? new THREE.Vector3(1.4, -1, 0.55) : new THREE.Vector3(0.55, 1, 1.4); dir = side.normalize(); }
  } else { dir = new THREE.Vector3(); dir[kind[1]] = kind[0] === '+' ? -1 : 1; dir.negate(); }
  const alt = up.y ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
  camera.up.copy(Math.abs(dir.dot(up)) > 0.99 ? alt : up);
  const dist = d / (2 * Math.tan(THREE.MathUtils.degToRad(persp.fov / 2))) * 1.05;
  camera.position.copy(c).addScaledVector(dir, dist);
  controls.target.copy(c); orthoCam.userData.half = d * 0.55; fitOrtho();
  persp.near = d / 1000; persp.far = d * 100; persp.updateProjectionMatrix(); controls.update();
}

function fitTo(id) {
  const o = S.objs.get(id); if (!o) return;
  const box = new THREE.Box3().setFromObject(o); if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3()), d = box.getSize(new THREE.Vector3()).length() || diag();
  const dir = camera.position.clone().sub(controls.target).normalize();
  camera.position.copy(c).addScaledVector(dir, d / (2 * Math.tan(THREE.MathUtils.degToRad(persp.fov / 2))) * 1.1);
  controls.target.copy(c); orthoCam.userData.half = d * 0.55; fitOrtho(); controls.update();
}
// ---------------------------------------------------------------- 网络
async function api(url, body) {
  const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const f32 = s => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return new Float32Array(u.buffer); };
const u32 = s => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return new Uint32Array(u.buffer); };
let busyN = 0;
function busy(on, text) { busyN += on ? 1 : -1; $('busy').hidden = busyN <= 0; if (text) $('busy-t').textContent = text; }
let toastT;
function toast(msg, err) { const t = $('toast'); t.textContent = msg; t.className = err ? 'err' : ''; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, err ? 7000 : 3200); }

// ---------------------------------------------------------------- 图层模型
const TYPES = {
  slice: { name: '截面', desc: '平面切开，按场着色', icon: '▭' },
  clip: { name: '剖切', desc: '切掉一半，看内部', icon: '◧' },
  surface: { name: '外表面', desc: '边界面着色', icon: '▢' },
  iso: { name: '等值面', desc: '场等于某个值的曲面', icon: '◎' },
  threshold: { name: '阈值区域', desc: '场落在区间内的单元', icon: '▦' },
  stream: { name: '流线', desc: '速度场的轨迹线', icon: '〰' },
  glyph: { name: '矢量箭头', desc: '截面上的速度箭头', icon: '➚' },
  volume: { name: '体渲染', desc: '半透明的整体分布', icon: '☁' },
  patches: { name: '边界 patch', desc: '按 patch 区分颜色', icon: '⬡' },
  stl: { name: 'STL 几何', desc: 'constant/triSurface 里的表面', icon: '△' },
  outline: { name: '包围盒', desc: '外框', icon: '□' },
};
function fieldList(vec) { return (S.info?.fields || []).filter(f => vec === undefined ? true : vec ? f.ncomp === 3 : true); }
function defaultField() {
  const names = (S.info?.fields || []).map(f => f.name).filter(n => !/Mean$|Prime2|^alphat|^nut|^Ydefault/.test(n));
  for (const re of PRIORITY) { const n = names.find(x => re.test(x)); if (n) return n; }
  return names[0] || '';
}
const vecField = () => { const v = fieldList(true).filter(f => f.ncomp === 3).map(f => f.name); return v.find(n => /^U\.gas$/.test(n)) || v.find(n => /^U/.test(n)) || v[0] || ''; };
function frange(field, comp) { const f = (S.info?.fields || []).find(x => x.name === field); if (!f) return [0, 1]; return comp && comp !== 'mag' && f.compRange ? f.compRange[comp] : f.range; }
function upAxis() { return S.info?.up || 'y'; }
function horizAxis() { return S.info?.axisym ? 'z' : (upAxis() === 'z' ? 'y' : 'z'); }
function newLayer(type, o = {}) {
  const field = o.field ?? (['patches', 'outline', 'stl'].includes(type) ? '' : (['stream', 'glyph'].includes(type) ? vecField() : defaultField()));
  const L = { id: uid(), type, visible: true, field, comp: 'mag', cmap: 'turbo', auto: true, lo: null, hi: null, opacity: 1, flat: true, ...o };
  const c = center(), b = bounds(), up = AX[upAxis()];
  if (['slice', 'clip', 'glyph'].includes(type)) {
    L.axis = L.axis || horizAxis(); L.frac = L.frac ?? (S.info?.axisym && L.axis === 'z' ? null : 0.5);
    if (S.info?.axisym && type !== 'clip') L.mirror = L.mirror ?? true;
  }
  if (type === 'iso') { L.isoField = L.isoField || field; const r = frange(L.isoField); L.value = L.value ?? +(r[0] + (r[1] - r[0]) * 0.5).toPrecision(4); }
  if (type === 'threshold') { L.thrField = L.thrField || field; const r = frange(L.thrField); L.tlo = L.tlo ?? +(r[0] + (r[1] - r[0]) * 0.5).toPrecision(4); L.thi = L.thi ?? r[1]; }
  if (type === 'stream') {
    L.vector = L.vector || vecField(); L.n = L.n || 40; L.tubes = L.tubes ?? true;
    // 默认种子线：底部 5 % 高度处，横跨整个截面（轴对称：从轴线到壁面）
    const h = b[up * 2] + 0.05 * (b[up * 2 + 1] - b[up * 2]); const a = up === 0 ? 1 : 0;
    const p1 = [...c], p2 = [...c]; p1[up] = p2[up] = h; p1[a] = b[a * 2] + 0.02 * (b[a * 2 + 1] - b[a * 2]); p2[a] = b[a * 2 + 1] - 0.02 * (b[a * 2 + 1] - b[a * 2]);
    if (S.info?.axisym) { p1[2] = p2[2] = 0; }
    L.p1 = L.p1 || p1.map(v => +v.toPrecision(5)); L.p2 = L.p2 || p2.map(v => +v.toPrecision(5));
  }
  if (type === 'glyph') { L.vector = L.vector || vecField(); L.n = L.n || 1500; L.scale = L.scale ?? 0.04; L.field = L.field || L.vector; }
  if (type === 'volume') { L.opacity = 1; L.density = L.density ?? 1; L.gamma = L.gamma ?? 1.2; L.vlo = L.vlo ?? 0.05; L.n = L.n || 1500000; }
  if (type === 'surface' || type === 'clip' || type === 'iso' || type === 'threshold' || type === 'stream') L.flat = false;
  return L;
}
function planeOf(L) {
  const b = bounds(), a = AX[L.axis]; const o = center();
  if (Number.isFinite(L.pos)) o[a] = L.pos;                      // 智能体给的绝对坐标（米）
  else if (L.frac === null || L.frac === undefined) o[a] = S.info?.axisym && L.axis === 'z' ? 0 : o[a];
  else o[a] = b[a * 2] + (b[a * 2 + 1] - b[a * 2]) * L.frac;
  const n = [0, 0, 0]; n[a] = L.flip ? -1 : 1;
  return { origin: o, normal: n };
}
function toServer(L) {
  const o = { id: L.id, type: L.type, field: L.field || null, comp: L.comp };
  if (['slice', 'clip', 'glyph'].includes(L.type)) Object.assign(o, planeOf(L));
  if (L.type === 'slice') { o.mirror = !!L.mirror; o.edges = !!L.edges; o.contours = +L.contours || 0; if (!L.auto && L.lo !== null && L.hi !== null) { o.lo = L.lo; o.hi = L.hi; } }
  if (L.type === 'clip') o.invert = !!L.flip;
  if (L.type === 'iso') { o.isoField = L.isoField; o.values = String(L.value).split(/[,，\s]+/).map(Number).filter(Number.isFinite).slice(0, 8); }
  if (L.type === 'threshold') { o.thrField = L.thrField; o.lo = Number(L.tlo); o.hi = Number(L.thi); }
  if (L.type === 'stream') Object.assign(o, { vector: L.vector, p1: L.p1, p2: L.p2, n: L.n, tubes: L.tubes, field: L.field || L.vector });
  if (L.type === 'glyph') Object.assign(o, { vector: L.vector, n: L.n, scale: L.scale });
  if (L.type === 'surface' || L.type === 'patches') o.patches = L.patches || null;
  return o;
}

// ---------------------------------------------------------------- 一键视图（按算例自动给参数）
function presets() {
  const has = re => (S.info?.fields || []).some(f => re.test(f.name)), vec = !!vecField(), axi = S.info?.axisym;
  const f = defaultField();
  const stl = (S.info?.stl || []).length;
  if (S.info?.nomesh) return [['STL 几何', `${stl} 个文件（还没有网格）`, () => [newLayer('stl'), newLayer('outline')]]];
  if (S.mode === 'mesh') return [
    ['网格外观', '边界 patch 着色', () => [newLayer('patches'), newLayer('outline')]],
    ...(stl ? [['STL 几何', `${stl} 个文件，和网格叠在一起看`, () => [newLayer('stl', { opacity: 0.5 }), newLayer('patches', { opacity: 0.35 })]]] : []),
    ['剖面网格线', '竖直中面 + 网格线', () => [newLayer('slice', { field: '', edges: true, axis: horizAxis() }), newLayer('outline')]],
    ['水平截面网格', '底部 10 % 高度', () => [newLayer('slice', { field: '', edges: true, axis: upAxis(), frac: 0.1, mirror: false }), newLayer('patches', { opacity: 0.25 })]],
    ['剖开看内部', 'patch 半透明 + 剖面', () => [newLayer('clip', { field: '' }), newLayer('outline')]],
  ];
  return [
    ['截面云图', label(f), () => [newLayer('slice'), newLayer('outline')], !f],
    [axi ? '轴对称展开' : '剖开看内部', axi ? '镜像成完整截面' : '剖掉一半 + 外框', () => axi ? [newLayer('slice', { mirror: true }), newLayer('outline')] : [newLayer('clip'), newLayer('outline')], !f],
    ['等值面', '场的一半最大值', () => [newLayer('iso'), newLayer('surface', { opacity: 0.18, field: '' })], !f],
    ['流线', vec ? label(vecField()) : '没有矢量场', () => [newLayer('stream'), newLayer('surface', { opacity: 0.15, field: '' })], !vec],
    ['矢量箭头', vec ? '截面速度' : '没有矢量场', () => [newLayer('slice', { opacity: 0.85 }), newLayer('glyph')], !vec],
    ['体渲染', '半透明整体分布', () => [newLayer('volume'), newLayer('outline')], !f],
    ['密相区', has(/^alpha\.particles$/) ? 'αs > 0.3 的区域' : '阈值区域', () => [newLayer('threshold', has(/^alpha\.particles$/) ? { thrField: 'alpha.particles', field: 'alpha.particles', tlo: 0.3, thi: 1 } : {}), newLayer('surface', { opacity: 0.15, field: '' })], !f],
    ['沿轴线取值', '中心线剖面曲线', () => { lineAlongAxis(); return null; }, !f],
  ];
}
function renderPresets() {
  $('presets').innerHTML = '';
  for (const [t, d, fn, dis] of presets()) {
    const b = document.createElement('button'); b.className = 'preset'; b.type = 'button'; b.disabled = !!dis || !S.info;
    b.innerHTML = `<b>${esc(t)}</b><span>${esc(d)}</span>`;
    b.onclick = () => { const ls = fn(); if (ls) { for (const id of [...S.objs.keys()]) dropObj(id); S.layers = ls; S.sel = ls[0].id; renderLayers(); refresh(); } };
    $('presets').appendChild(b);
  }
}

// ---------------------------------------------------------------- 图层列表与编辑器
function layerTitle(L) {
  const t = TYPES[L.type].name;
  if (L.type === 'slice' || L.type === 'clip' || L.type === 'glyph') return `${t} · 法向 ${L.axis.toUpperCase()}`;
  if (L.type === 'iso') return `${t} · ${L.isoField} = ${String(L.value).split(/[,，\s]+/).filter(Boolean).map(v => fmt(+v)).join(', ')}`;
  if (L.type === 'threshold') return `${t} · ${fmt(+L.tlo)}–${fmt(+L.thi)}`;
  return t;
}
function renderLayers(keepEditor) {
  const ol = $('layers'); ol.innerHTML = '';
  $('layers-empty').hidden = S.layers.length > 0;
  for (const L of S.layers) {
    const li = document.createElement('li'); li.className = L.id === S.sel ? 'sel' : '';
    const st = L._err ? `<span class="st err" title="${esc(L._err)}">出错</span>` : L._stat ? `<span class="st">${esc(L._stat)}</span>` : '';
    li.innerHTML = `<button title="${L.visible ? '隐藏' : '显示'}" aria-label="显示/隐藏">${L.visible ? '👁' : '◌'}</button>
      <span class="nm">${TYPES[L.type].icon} ${esc(layerTitle(L))}<br><small>${L.field ? esc(label(L.field, L.comp)) : '纯色'}</small></span>${st}
      <button title="复制这一层" aria-label="复制">⧉</button><button title="删除" aria-label="删除">✕</button>`;
    const [eye, dup, del] = li.querySelectorAll('button');
    eye.onclick = e => { e.stopPropagation(); L.visible = !L.visible; const o = S.objs.get(L.id); if (o) o.visible = L.visible; renderLayers(); renderLegends(); };
    dup.onclick = e => { e.stopPropagation(); const c = { ...structuredClone({ ...L, _err: undefined, _stat: undefined, _range: undefined }), id: uid() }; S.layers.push(c); S.sel = c.id; renderLayers(); refresh([c.id]); };
    del.onclick = e => { e.stopPropagation(); S.layers = S.layers.filter(x => x !== L); dropObj(L.id); if (S.sel === L.id) S.sel = S.layers[0]?.id; renderLayers(); renderLegends(); };
    li.onclick = () => { S.sel = L.id; renderLayers(); };
    li.ondblclick = () => fitTo(L.id);
    li.title = '双击：缩放到这一层';
    ol.appendChild(li);
  }
  if (keepEditor) {
    // 只刷新编辑器里的统计块，不重建输入框（正在拖的滑块不被打断）
    const L = S.layers.find(x => x.id === S.sel), ed = $('editor');
    if (L && !ed.hidden) { let kv = ed.querySelector('.kv.stats'); if (!kv && L._statsHtml) { kv = document.createElement('div'); kv.className = 'kv stats'; kv.style.marginTop = '8px'; ed.appendChild(kv); } if (kv) kv.innerHTML = L._statsHtml || ''; }
    return;
  }
  renderEditor();
}
function fieldOptions(sel, vecOnly) {
  const fs = fieldList().filter(f => !vecOnly || f.ncomp === 3);
  return (vecOnly ? '' : `<option value=""${!sel ? ' selected' : ''}>（纯色）</option>`) + fs.map(f => `<option value="${esc(f.name)}"${f.name === sel ? ' selected' : ''}>${esc(label(f.name))}${f.ncomp === 3 ? ' ⟶' : ''}</option>`).join('');
}
function renderEditor() {
  const L = S.layers.find(x => x.id === S.sel), ed = $('editor');
  if (!L) { ed.hidden = true; return; }
  ed.hidden = false;
  const isVec = L.field && fieldList().find(f => f.name === L.field)?.ncomp === 3;
  const rows = [];
  const R = (lab, html) => rows.push(`<div class="f"><label>${lab}</label><div>${html}</div></div>`);
  if (!['outline', 'patches'].includes(L.type)) {
    R(L.type === 'volume' ? '场' : '着色', `<select data-k="field">${fieldOptions(L.field, L.type === 'volume' ? false : false)}</select>`);
    if (isVec) R('分量', `<div class="seg">${['mag', 'x', 'y', 'z'].map(c => `<button type="button" data-comp="${c}" aria-pressed="${L.comp === c}">${c === 'mag' ? '模' : c}</button>`).join('')}</div>`);
    if (L.field || L.type === 'volume') {
      R('色图', `<select data-k="cmap">${Object.entries(CMAP_NAMES).map(([k, v]) => `<option value="${k}"${k === L.cmap ? ' selected' : ''}>${v}</option>`).join('')}</select>`);
      R('范围', `<div class="pair"><input type="number" step="any" data-k="lo" placeholder="自动" value="${L.auto ? '' : L.lo ?? ''}"><input type="number" step="any" data-k="hi" placeholder="自动" value="${L.auto ? '' : L.hi ?? ''}"></div><label class="hint"><input type="checkbox" data-k="log"${L.log ? ' checked' : ''}> 对数色标（跨数量级的场，如质量分数）</label>`);
      if (L.type !== 'volume') R('着色方式', `<div class="seg"><button type="button" data-flat="1" aria-pressed="${!!L.flat}">逐单元</button><button type="button" data-flat="0" aria-pressed="${!L.flat}">平滑</button></div>`);
    }
  }
  if (['slice', 'clip', 'glyph'].includes(L.type)) {
    R('法向', `<div class="seg">${['x', 'y', 'z'].map(a => `<button type="button" data-axis="${a}" aria-pressed="${L.axis === a}" title="${a === upAxis() ? '竖直方向' : ''}">${a.toUpperCase()}${a === upAxis() ? ' ↑' : ''}</button>`).join('')}</div>`);
    const b = bounds(), a = AX[L.axis], p = planeOf(L).origin[a];
    R('位置', `<input type="range" min="0" max="1" step="0.005" data-k="frac" value="${L.frac ?? (p - b[a * 2]) / ((b[a * 2 + 1] - b[a * 2]) || 1)}"><div class="hint">${L.axis} = ${fmt(p)} m</div>`);
    if (L.type === 'clip') R('保留', `<div class="seg"><button type="button" data-flip="0" aria-pressed="${!L.flip}">正侧</button><button type="button" data-flip="1" aria-pressed="${!!L.flip}">负侧</button></div>`);
    if (L.type === 'slice') {
      R('选项', `<label><input type="checkbox" data-k="edges"${L.edges ? ' checked' : ''}> 网格线</label>${S.info?.axisym ? ` <label><input type="checkbox" data-k="mirror"${L.mirror ? ' checked' : ''}> 轴对称展开</label>` : ''}`);
      if (L.field) R('等值线', `<select data-k="contours">${[0, 5, 8, 12, 20].map(n => `<option value="${n}"${+L.contours === n ? ' selected' : ''}>${n ? n + ' 条' : '不画'}</option>`).join('')}</select>`);
    }
  }
  if (L.type === 'iso') {
    const r = frange(L.isoField);
    R('等值场', `<select data-k="isoField">${fieldOptions(L.isoField).replace('<option value="">（纯色）</option>', '')}</select>`);
    R('值', `<input type="range" min="${r[0]}" max="${r[1]}" step="${(r[1] - r[0]) / 200 || 1e-6}" data-k="value" value="${Number.isFinite(+L.value) ? L.value : r[0]}"><input type="text" data-k="value" value="${esc(L.value)}" style="width:100%;margin-top:4px"><div class="hint">多个值用逗号分隔，如 0.1, 0.3, 0.5</div>`);
  }
  if (L.type === 'threshold') {
    const r = frange(L.thrField);
    R('阈值场', `<select data-k="thrField">${fieldOptions(L.thrField).replace('<option value="">（纯色）</option>', '')}</select>`);
    R('区间', `<div class="pair"><input type="number" step="any" data-k="tlo" value="${L.tlo}"><input type="number" step="any" data-k="thi" value="${L.thi}"></div><div class="hint">全场范围 ${fmt(r[0])} – ${fmt(r[1])}</div>`);
  }
  if (L.type === 'stream') {
    R('速度场', `<select data-k="vector">${fieldOptions(L.vector, true)}</select>`);
    R('种子起点', `<div class="tri">${[0, 1, 2].map(i => `<input type="number" step="any" data-p="p1" data-i="${i}" value="${L.p1[i]}">`).join('')}</div>`);
    R('种子终点', `<div class="tri">${[0, 1, 2].map(i => `<input type="number" step="any" data-p="p2" data-i="${i}" value="${L.p2[i]}">`).join('')}</div>`);
    R('条数', `<input type="range" min="5" max="200" step="1" data-k="n" value="${L.n}"><div class="hint">${L.n} 条</div>`);
    R('样式', `<label><input type="checkbox" data-k="tubes"${L.tubes ? ' checked' : ''}> 管状（更清楚，稍慢）</label>`);
  }
  if (L.type === 'glyph') {
    R('矢量场', `<select data-k="vector">${fieldOptions(L.vector, true)}</select>`);
    R('箭头数', `<input type="range" min="100" max="6000" step="100" data-k="n" value="${L.n}"><div class="hint">${L.n}</div>`);
    R('长度', `<input type="range" min="0.005" max="0.15" step="0.005" data-k="scale" value="${L.scale}">`);
  }
  if (L.type === 'volume') {
    R('透明下限', `<input type="range" min="0" max="0.9" step="0.01" data-k="vlo" value="${L.vlo}"><div class="hint">低于该比例的值完全透明</div>`);
    R('浓度', `<input type="range" min="0.1" max="6" step="0.1" data-k="density" value="${L.density}">`);
    R('对比', `<input type="range" min="0.3" max="4" step="0.1" data-k="gamma" value="${L.gamma}">`);
    R('分辨率', `<select data-k="n">${[[300000, '快（30 万体素）'], [1500000, '标准（150 万）'], [4000000, '精细（400 万，慢）']].map(([v, t]) => `<option value="${v}"${+L.n === v ? ' selected' : ''}>${t}</option>`).join('')}</select>`);
  }
  if (L.type === 'surface' || L.type === 'patches') {
    const ps = (S.info?.patches || []).filter(p => p.shown);
    R('patch', ps.map(p => `<label><input type="checkbox" data-patch="${esc(p.name)}"${!L.patches || L.patches.includes(p.name) ? ' checked' : ''}> ${esc(p.name)} <span class="muted small">${esc(p.type)}</span></label>`).join('<br>'));
  }
  if (L.type !== 'volume' && L.type !== 'outline') R('不透明度', `<input type="range" min="0.05" max="1" step="0.05" data-k="opacity" value="${L.opacity}">`);
  const st = L._statsHtml ? `<div class="kv stats" style="margin-top:8px">${L._statsHtml}</div>` : '';
  const acts = [];
  if (L.field && !['outline', 'patches'].includes(L.type)) acts.push('<button type="button" class="sm" data-act="stats">全场统计 / 直方图</button>');
  if (S.objs.get(L.id) && !['outline', 'volume'].includes(L.type)) acts.push('<button type="button" class="sm" data-act="csv">导出这一层 CSV</button>');
  const actHtml = acts.length ? `<div class="row" style="flex-wrap:wrap;margin-top:8px">${acts.join('')}</div>` : '';
  ed.innerHTML = `<h2>${TYPES[L.type].icon} ${esc(TYPES[L.type].name)}：${esc(TYPES[L.type].desc)}</h2>${rows.join('')}${st}${actHtml}`;
  ed.querySelector('[data-act=stats]') && (ed.querySelector('[data-act=stats]').onclick = () => fieldStats(L.field, L.comp));
  ed.querySelector('[data-act=csv]') && (ed.querySelector('[data-act=csv]').onclick = () => layerCsv(L));
  // 交互：几何参数变了要重算；颜色/透明度只改显示
  const REMOTE = new Set(['field', 'axis', 'frac', 'flip', 'edges', 'mirror', 'isoField', 'value', 'thrField', 'tlo', 'thi', 'vector', 'n', 'tubes', 'scale', 'comp', 'patches', 'contours']);
  let deb;
  const changed = (k, rebuildUI) => {
    if (REMOTE.has(k) || (L.type === 'volume' && k === 'field')) { clearTimeout(deb); deb = setTimeout(() => refresh([L.id]), k === 'frac' || k === 'value' ? 350 : 50); }
    else restyle(L);
    if (rebuildUI) renderLayers(); else { const li = [...$('layers').children][S.layers.indexOf(L)]; if (li) li.querySelector('.nm').innerHTML = `${TYPES[L.type].icon} ${esc(layerTitle(L))}<br><small>${L.field ? esc(label(L.field, L.comp)) : '纯色'}</small>`; }
  };
  ed.querySelectorAll('[data-k]').forEach(inp => {
    const k = inp.dataset.k, ev = inp.type === 'range' ? 'input' : 'change';
    inp.addEventListener(ev, () => {
      let v = inp.type === 'checkbox' ? inp.checked : inp.value;
      if (k === 'lo' || k === 'hi') { const lo = ed.querySelector('[data-k=lo]').value, hi = ed.querySelector('[data-k=hi]').value; L.auto = lo === '' && hi === ''; L.lo = lo === '' ? null : +lo; L.hi = hi === '' ? null : +hi; return changed(L.contours ? 'contours' : 'lo'); }
      if (['frac', 'opacity', 'n', 'scale', 'density', 'gamma', 'vlo', 'contours'].includes(k)) v = +v;
      L[k] = v;
      if (k === 'field' && L.type !== 'volume') { L.comp = 'mag'; L.auto = true; }
      if (k === 'isoField') { const r = frange(v); L.value = +(r[0] + (r[1] - r[0]) * 0.5).toPrecision(4); L.field = L.field || v; }
      if (k === 'thrField') { const r = frange(v); L.tlo = +(r[0] + (r[1] - r[0]) * 0.5).toPrecision(4); L.thi = r[1]; }
      if (k === 'value') ed.querySelectorAll('[data-k=value]').forEach(x => x !== inp && (x.value = v));
      if (inp.nextElementSibling?.classList.contains('hint') && k === 'n') inp.nextElementSibling.textContent = v + (L.type === 'stream' ? ' 条' : '');
      if (k === 'frac') { delete L.pos; const a = AX[L.axis]; inp.nextElementSibling.textContent = `${L.axis} = ${fmt(planeOf(L).origin[a])} m`; }
      changed(k, ['field', 'isoField', 'thrField'].includes(k));
    });
  });
  ed.querySelectorAll('[data-comp]').forEach(b => b.onclick = () => { L.comp = b.dataset.comp; L.auto = true; changed('comp', true); });
  ed.querySelectorAll('[data-flat]').forEach(b => b.onclick = () => { L.flat = b.dataset.flat === '1'; restyle(L); renderEditor(); });
  ed.querySelectorAll('[data-axis]').forEach(b => b.onclick = () => { L.axis = b.dataset.axis; L.frac = 0.5; delete L.pos; if (S.info?.axisym) L.mirror = L.axis === 'z'; changed('axis', true); });
  ed.querySelectorAll('[data-flip]').forEach(b => b.onclick = () => { L.flip = b.dataset.flip === '1'; changed('flip', true); });
  ed.querySelectorAll('[data-p]').forEach(inp => inp.onchange = () => { L[inp.dataset.p][+inp.dataset.i] = +inp.value; changed('n'); });
  ed.querySelectorAll('[data-patch]').forEach(inp => inp.onchange = () => { L.patches = [...ed.querySelectorAll('[data-patch]')].filter(x => x.checked).map(x => x.dataset.patch); changed('patches'); });
}
// 添加菜单
$('add-btn').onclick = e => { e.stopPropagation(); const m = $('add-menu'); m.hidden = !m.hidden; };
document.addEventListener('click', () => $('add-menu').hidden = true);
function renderAddMenu() {
  const keys = S.info?.nomesh ? ['stl', 'outline'] : S.mode === 'mesh' ? ['patches', ...((S.info?.stl || []).length ? ['stl'] : []), 'slice', 'clip', 'surface', 'outline'] : ['slice', 'clip', 'surface', 'iso', 'threshold', 'stream', 'glyph', 'volume', 'outline'];
  $('add-menu').innerHTML = keys.map(k => `<button type="button" role="menuitem" data-t="${k}">${TYPES[k].icon} ${TYPES[k].name}<small>${TYPES[k].desc}</small></button>`).join('')
    + (S.mode === 'post' ? `<button type="button" role="menuitem" data-t="line">📈 沿线取值<small>两点之间的场值曲线</small></button>` : '');
  $('add-menu').querySelectorAll('button').forEach(b => b.onclick = () => {
    if (b.dataset.t === 'line') return lineAlongAxis();
    const L = newLayer(b.dataset.t, S.mode === 'mesh' && b.dataset.t === 'slice' ? { field: '', edges: true } : {}); S.layers.push(L); S.sel = L.id; renderLayers(); refresh([L.id]);
  });
}

// ---------------------------------------------------------------- 渲染对象
function dropObj(id) { const o = S.objs.get(id); if (!o) return; root.remove(o); o.traverse(x => { x.geometry?.dispose(); if (x.material) [].concat(x.material).forEach(m => { m.map?.dispose(); m.uniforms?.uMap?.value?.dispose?.(); m.dispose(); }); }); S.objs.delete(id); }
function rangeOf(L) {
  const r = L._range || [0, 1];
  return [L.auto || L.lo === null ? r[0] : L.lo, L.auto || L.hi === null ? r[1] : L.hi];
}
function mapper(L) {
  // 线性或对数映射到 0..1；对数时下限取正数（≤0 的值压到最低色）
  let [lo, hi] = rangeOf(L);
  if (!L.log) { const d = hi - lo || 1; return v => (v - lo) / d; }
  if (!(hi > 0)) return () => 0;
  if (!(lo > 0)) lo = hi * 1e-6;
  const a = Math.log10(lo), d = Math.log10(hi) - a || 1;
  return v => v > 0 ? (Math.log10(v) - a) / d : 0;
}
function colorize(geom, L) {
  const s = L.flat && geom.userData.cell ? geom.userData.cellExp : geom.userData.scalars;
  if (!s || !L.field) { geom.deleteAttribute('color'); return false; }
  const T = lut(L.cmap), f = mapper(L);
  const col = new Float32Array(s.length * 3);
  for (let i = 0; i < s.length; i++) {
    const v = s[i]; if (!Number.isFinite(v)) { col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0.6; continue; }
    const k = Math.max(0, Math.min(255, Math.round(f(v) * 255))) * 3;
    col[i * 3] = T[k]; col[i * 3 + 1] = T[k + 1]; col[i * 3 + 2] = T[k + 2];
  }
  geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return true;
}
const PATCH_COLORS = [0x8ea2c6, 0x4caf50, 0xf59e0b, 0xe11d48, 0x8b5cf6, 0x06b6d4, 0x84cc16, 0xf97316, 0x64748b];
// 颜色跟着 patch 名走（按算例里的 patch 顺序），隐藏其中几个时其余不换色
const patchColor = name => { const all = (S.info?.patches || []).map(p => p.name); const i = all.indexOf(name); return PATCH_COLORS[(i < 0 ? all.length : i) % PATCH_COLORS.length]; };
function meshFrom(r, L, solid) {
  const pos = f32(r.positions), idx = u32(r.indices);
  let g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.userData.scalars = r.scalars ? f32(r.scalars) : null;
  if (r.cellScalars) {
    // 逐单元着色：展开成不共享顶点的三角形，每个三角形一种颜色
    const cs = f32(r.cellScalars); const ng = g.toNonIndexed(); const ex = new Float32Array(cs.length * 3);
    for (let i = 0; i < cs.length; i++) ex[i * 3] = ex[i * 3 + 1] = ex[i * 3 + 2] = cs[i];
    ng.userData = { scalars: g.userData.scalars ? (() => { const s = g.userData.scalars, o = new Float32Array(idx.length); for (let i = 0; i < idx.length; i++) o[i] = s[idx[i]]; return o; })() : null, cell: true, cellExp: ex };
    g.dispose(); g = ng;
  }
  g.computeVertexNormals();
  const lit = !['slice'].includes(L.type);
  const mat = lit ? new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, vertexColors: false, color: solid ?? 0xb8bcc6 })
    : new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, vertexColors: false, color: solid ?? 0xc9ccd3 });
  mat.polygonOffset = true; mat.polygonOffsetFactor = 1; mat.polygonOffsetUnits = 1;
  const m = new THREE.Mesh(g, mat); m.userData.layer = L.id; m.renderOrder = 1;
  return m;
}
function restyle(L) {
  const o = S.objs.get(L.id); if (!o) return;
  o.visible = L.visible;
  o.traverse(m => {
    if (m.userData.vol) { const u = m.userData.vol.uniforms; const [lo, hi] = rangeOf(L), r = L._range || [0, 1], d = (r[1] - r[0]) || 1;
      u.uLo.value = (lo - r[0]) / d; u.uHi.value = (hi - r[0]) / d; u.uDensity.value = L.density; u.uGamma.value = L.gamma; u.uCut.value = L.vlo; u.uCmap.value.dispose(); u.uCmap.value = lutTexture(L.cmap); return; }
    if (!m.isMesh && !m.isLineSegments) return;
    if (m.userData.edges) return;
    if (m.isMesh && m.geometry) { const c = colorize(m.geometry, L); m.material.vertexColors = c; if (c) m.material.color.set(0xffffff); m.material.needsUpdate = true; }
    if (m.isLineSegments && m.geometry && !m.userData.box) { const c = colorize(m.geometry, L); m.material.vertexColors = c; m.material.needsUpdate = true; }
    const op = L.opacity ?? 1; m.material.transparent = op < 1; m.material.opacity = op; m.material.depthWrite = op >= 1;
  });
  renderLegends();
}
function addResult(L, r) {
  dropObj(L.id); L._err = null; L._stat = null; L._statsHtml = '';
  if (!r || r.kind === 'empty') { L._stat = r?.note ? '空' : '空'; L._err = r?.note || null; return; }
  if (r.kind === 'error') { L._err = r.error; return; }
  const grp = new THREE.Group(); grp.userData.layer = L.id;
  if (r.kind === 'box') {
    const b = [...r.bounds]; if (S.info?.axisym && b[0] >= -1e-9) b[0] = -b[1];   // 轴对称展开后外框也对称
    const g = new THREE.BoxGeometry(b[1] - b[0], b[3] - b[2], b[5] - b[4]);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: S.dark ? 0x888888 : 0x555555 }));
    e.position.set((b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2); e.userData.box = true; grp.add(e); g.dispose();
  } else if (r.kind === 'parts') {
    r.parts.forEach((p, i) => { const m = meshFrom(p, L, L.type === 'stl' ? PATCH_COLORS[i % PATCH_COLORS.length] : patchColor(p.name)); m.userData.patch = p.name; grp.add(m); });
    L._statsHtml = r.parts.map((p, i) => `<span><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#${(L.type === 'stl' ? PATCH_COLORS[i % PATCH_COLORS.length] : patchColor(p.name)).toString(16).padStart(6, '0')}"></i> ${esc(p.name)}</span><b>${p.ntris} 三角面</b>`).join('');
  } else if (r.kind === 'mesh') {
    L._range = r.range || null;
    grp.add(meshFrom(r, L));
    if (r.edges) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(f32(r.edges.positions), 3)); g.setIndex(new THREE.BufferAttribute(u32(r.edges.indices), 1));
      const e = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.55 })); e.userData.edges = true; e.renderOrder = 2; grp.add(e);
    }
    if (r.clines) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(f32(r.clines.positions), 3)); g.setIndex(new THREE.BufferAttribute(u32(r.clines.indices), 1));
      const e = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x111111 })); e.userData.edges = true; e.renderOrder = 3; grp.add(e);
    }
  } else if (r.kind === 'lines') {
    L._range = r.range || null;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(f32(r.positions), 3)); g.setIndex(new THREE.BufferAttribute(u32(r.indices), 1));
    g.userData.scalars = r.scalars ? f32(r.scalars) : null;
    grp.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x334155 })));
  }
  const st = r.stats || {};
  if (st.mean !== undefined) L._stat = `均值 ${fmt(st.mean)}`;
  if (st.lines !== undefined) L._stat = `${st.lines} 条`;
  if (st.cells !== undefined) L._stat = `${st.cells} 单元`;
  const kv = [];
  if (L._range) kv.push(['最小', fmt(L._range[0])], ['最大', fmt(L._range[1])]);
  if (st.mean !== undefined) kv.push([st.measure === 'Area' ? '面积加权平均' : '体积加权平均', fmt(st.mean)], [st.measure === 'Area' ? '面积 m²' : '体积 m³', fmt(st.size)]);
  if (st.cells !== undefined) kv.push(['单元数', st.cells], ['体积 m³', fmt(st.size)]);
  if (st.lines !== undefined) kv.push(['流线条数', st.lines]);
  if (r.ntris) kv.push(['三角面', r.ntris.toLocaleString()]);
  if (r.ms !== undefined) kv.push(['计算耗时', r.ms + ' ms']);
  if (kv.length && r.kind !== 'parts') L._statsHtml = kv.map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join('');
  root.add(grp); S.objs.set(L.id, grp); restyle(L);
}

// ---------------------------------------------------------------- 体渲染（光线步进）
const VOL_VS = `out vec3 vOrigin; out vec3 vDir; uniform vec3 uCam;
void main(){ vOrigin = uCam; vDir = position - uCam; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const VOL_FS = `precision highp float; precision highp sampler3D;
in vec3 vOrigin; in vec3 vDir; out vec4 color;
uniform sampler3D uMap; uniform sampler2D uCmap; uniform float uLo, uHi, uDensity, uGamma, uCut, uSteps;
vec2 hit(vec3 o, vec3 d){ vec3 inv = 1.0 / d; vec3 t0 = (vec3(-0.5) - o) * inv, t1 = (vec3(0.5) - o) * inv; vec3 a = min(t0, t1), b = max(t0, t1); return vec2(max(max(a.x, a.y), a.z), min(min(b.x, b.y), b.z)); }
void main(){
  vec3 d = normalize(vDir); vec2 b = hit(vOrigin, d); if (b.x > b.y) discard; b.x = max(b.x, 0.0);
  float dt = (b.y - b.x) / uSteps; vec3 p = vOrigin + (b.x + 0.5 * dt) * d; vec4 acc = vec4(0.0);
  for (int i = 0; i < 768; i++) {
    if (float(i) >= uSteps) break;
    float raw = texture(uMap, p + 0.5).r;
    if (raw > 0.004) {
      float v = (raw * 255.0 - 1.0) / 254.0; float s = clamp((v - uLo) / max(uHi - uLo, 1e-6), 0.0, 1.0);
      if (s > uCut) { vec3 c = texture(uCmap, vec2(s, 0.5)).rgb; float a = 1.0 - exp(-uDensity * pow((s - uCut) / (1.0 - uCut + 1e-6), uGamma) * dt * 18.0);
        acc.rgb += (1.0 - acc.a) * a * c; acc.a += (1.0 - acc.a) * a; if (acc.a > 0.97) break; }
    }
    p += d * dt;
  }
  if (acc.a < 0.01) discard; color = acc;
}`;
async function buildVolume(L, seq) {
  busy(true, '体渲染：重采样到规则网格…');
  try {
    const r = await api('/api/post3d/volume', withD({ case: S.case, time: S.time, field: L.field, comp: L.comp, n: L.n }));
    if (seq !== S.reqSeq && seq !== undefined) return;
    const raw = f32(r.data), [n0, n1, n2] = r.dims, lo = r.range[0], d = (r.range[1] - r.range[0]) || 1;
    const u8 = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) u8[i] = Number.isFinite(raw[i]) ? 1 + Math.round(254 * Math.min(1, Math.max(0, (raw[i] - lo) / d))) : 0;
    const tex = new THREE.Data3DTexture(u8, n0, n1, n2); tex.format = THREE.RedFormat; tex.type = THREE.UnsignedByteType; tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.unpackAlignment = 1; tex.needsUpdate = true;
    const mat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VOL_VS, fragmentShader: VOL_FS, side: THREE.BackSide, transparent: true, depthWrite: false,
      uniforms: { uMap: { value: tex }, uCmap: { value: lutTexture(L.cmap) }, uLo: { value: 0 }, uHi: { value: 1 }, uDensity: { value: L.density }, uGamma: { value: L.gamma }, uCut: { value: L.vlo }, uSteps: { value: 384 }, uCam: { value: new THREE.Vector3() } } });
    const b = r.bounds, box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
    box.scale.set(b[1] - b[0], b[3] - b[2], b[5] - b[4]); box.position.set((b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2);
    box.userData.vol = mat; box.renderOrder = 10;
    dropObj(L.id); L._err = null; L._range = r.range; L._stat = `${n0}×${n1}×${n2}`;
    L._statsHtml = `<span>最小</span><b>${fmt(r.range[0])}</b><span>最大</span><b>${fmt(r.range[1])}</b><span>体素</span><b>${n0}×${n1}×${n2}</b>`;
    const grp = new THREE.Group(); grp.add(box); root.add(grp); S.objs.set(L.id, grp);
    box.updateMatrixWorld(); restyle(L);
  } catch (e) { L._err = e.message; toast('体渲染失败：' + e.message, true); }
  finally { busy(false); renderLayers(true); }
}
// 体渲染的相机位置要换到盒子的局部坐标（单位立方体）
const _loopVol = () => { for (const g of S.objs.values()) g.traverse(m => { if (m.userData.vol) { m.updateMatrixWorld(); m.userData.vol.uniforms.uCam.value.copy(m.worldToLocal(camera.position.clone())); } }); requestAnimationFrame(_loopVol); };
_loopVol();

// ---------------------------------------------------------------- 计算 / 刷新
async function refresh(ids) {
  if (!S.info) return;
  const todo = S.layers.filter(L => !ids || ids.includes(L.id));
  const seq = ++S.reqSeq;
  const vols = todo.filter(L => L.type === 'volume'), rest = todo.filter(L => L.type !== 'volume');
  if (rest.length) {
    const big = S.info.cells > 200000;
    busy(true, big && !S._warm ? `首次读取 ${S.info.cells.toLocaleString()} 个单元，约需 10–30 s…` : '计算中…');
    try {
      const r = await api('/api/post3d/scene', withD({ case: S.case, time: S.time, layers: rest.map(toServer) }));
      S._warm = true;
      if (seq !== S.reqSeq && ids === undefined) return;
      for (const res of r.layers) { const L = S.layers.find(x => x.id === res.id); if (L) addResult(L, res); }
      const errs = r.layers.filter(x => x.kind === 'error'); if (errs.length) toast('部分图层出错：' + errs[0].error, true);
    } catch (e) { toast(e.message, true); }
    finally { busy(false); renderLayers(!!ids); renderLegends(); }
  }
  for (const L of vols) await buildVolume(L);
  $('tlabel').textContent = S.mode === 'post' && S.info ? `t = ${S.time} s` + (S.info.times.length > 1 ? `  ·  ${S.info.times.indexOf(S.time) + 1} / ${S.info.times.length}` : '') : '';
  if (!S._fitted) { setView('fit'); S._fitted = true; }
}

// ---------------------------------------------------------------- 色标
function renderLegends() {
  const box = $('legends'); box.innerHTML = '';
  const seen = new Set();
  for (const L of S.layers) {
    if (!L.visible || !L.field || !L._range || L.type === 'outline') continue;
    const key = L.field + L.comp + L.cmap + (L.log ? 'log' : '') + rangeOf(L).join();
    if (seen.has(key)) continue; seen.add(key);
    let [lo, hi] = rangeOf(L); const T = lut(L.cmap);
    if (L.log && !(lo > 0)) lo = hi * 1e-6;
    const c = document.createElement('canvas'); const W = 22, H = 170; c.width = W * 2; c.height = H * 2; c.style.width = W + 'px'; c.style.height = H + 'px';
    const x = c.getContext('2d'); for (let i = 0; i < H * 2; i++) { const k = Math.round((1 - i / (H * 2 - 1)) * 255) * 3; x.fillStyle = `rgb(${T[k] * 255},${T[k + 1] * 255},${T[k + 2] * 255})`; x.fillRect(0, i, W * 2, 1); }
    const d = document.createElement('div'); d.className = 'legend';
    const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => fmt(L.log && lo > 0 && hi > 0 ? 10 ** (Math.log10(hi) - (Math.log10(hi) - Math.log10(lo)) * f) : hi - (hi - lo) * f));
    d.innerHTML = `<div style="font-weight:600;margin-bottom:4px;max-width:160px">${esc(label(L.field, L.comp))}${L.log ? ' <span style="font-weight:400">（对数）</span>' : ''}</div><div style="display:flex;gap:6px"><span class="cb"></span><div style="display:flex;flex-direction:column;justify-content:space-between;height:${H}px">${ticks.map(t => `<span>${t}</span>`).join('')}</div></div>`;
    d.querySelector('.cb').appendChild(c); box.appendChild(d);
    if (box.children.length >= 3) break;
  }
}

// ---------------------------------------------------------------- 拾取（单击显示该点的场值）
const ray = new THREE.Raycaster(); ray.params.Line.threshold = 0;
let downAt = null;
renderer.domElement.addEventListener('pointerdown', e => downAt = [e.clientX, e.clientY]);
renderer.domElement.addEventListener('pointerup', e => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), camera);
  const meshes = []; root.traverse(o => o.isMesh && o.visible && !o.userData.vol && meshes.push(o));
  const hit = ray.intersectObjects(meshes, false)[0];
  const pr = $('probe');
  if (!hit) { pr.hidden = true; return; }
  const L = S.layers.find(x => x.id === hit.object.userData.layer || x.id === hit.object.parent?.userData.layer);
  const g = hit.object.geometry, p = hit.point; let val = null;
  const s = g.userData.cell && L?.flat ? g.userData.cellExp : g.userData.scalars;
  if (s && hit.face) {
    const pos = g.attributes.position, a = new THREE.Vector3().fromBufferAttribute(pos, hit.face.a), b = new THREE.Vector3().fromBufferAttribute(pos, hit.face.b), c = new THREE.Vector3().fromBufferAttribute(pos, hit.face.c);
    const bc = new THREE.Triangle(a, b, c).getBarycoord(p, new THREE.Vector3());
    val = s[hit.face.a] * bc.x + s[hit.face.b] * bc.y + s[hit.face.c] * bc.z;
  }
  pr.hidden = false;
  pr.innerHTML = `${hit.object.userData.patch ? `<b>${esc(hit.object.userData.patch)}</b> · ` : ''}(${fmt(p.x)}, ${fmt(p.y)}, ${fmt(p.z)}) m${val !== null && L?.field ? `<br><b>${esc(label(L.field, L.comp))} = ${fmt(val)}</b>` : ''}`
    + (S.mode === 'post' && S.info.times.length > 1 ? `<br><button type="button" class="sm" id="probe-ts" style="margin-top:4px">看这一点随时间变化</button>` : '');
  const pts = [p.x, p.y, p.z];
  $('probe-ts') && ($('probe-ts').onclick = () => pointHistory(pts));
});
renderer.domElement.addEventListener('dblclick', () => setView('fit'));

// ---------------------------------------------------------------- 底部图表：沿线取值 / 时间曲线 / 直方图
async function lineAlongAxis(p1, p2) {
  if (!S.info) return;
  const b = bounds(), up = AX[upAxis()], c = center();
  if (!p1) { p1 = [...c]; p2 = [...c]; if (S.info.axisym) { p1[0] = p2[0] = Math.max(b[0], 1e-6) + (b[1] - b[0]) * 0.02; p1[2] = p2[2] = 0; } p1[up] = b[up * 2]; p2[up] = b[up * 2 + 1]; }
  const f = defaultField();
  const fields = [f, ...['p', 'C2H4.gas', 'MeOH.gas'].filter(x => x !== f && (S.info.fields || []).some(y => y.name === x))].slice(0, 4);
  busy(true, '沿线取值…');
  try {
    const r = await api('/api/post3d/line', withD({ case: S.case, time: S.time, p1, p2, n: 300, fields }));
    showChart({ kind: 'line', title: '沿线取值', x: r.s, xlabel: 'm', series: r.series,
      sub: `(${p1.map(fmt).join(', ')}) → (${p2.map(fmt).join(', ')})，${r.s.length} 点，时刻 ${S.time}`, file: `line_${S.time}` });
  } catch (e) { toast(e.message, true); } finally { busy(false); }
}
async function pointHistory(p) {
  const f = defaultField();
  const fields = [f, ...['p', 'C2H4.gas'].filter(x => x !== f && (S.info.fields || []).some(y => y.name === x))].slice(0, 3);
  busy(true, `逐个时刻读取（${S.info.times.length} 个），大算例需要一会儿…`);
  try {
    const r = await api('/api/post3d/timeseries', withD({ case: S.case, point: p, fields, maxTimes: 200 }));
    showChart({ kind: 'line', title: '这一点随时间变化', x: r.t, xlabel: 's', series: r.series, sub: `点 (${p.map(fmt).join(', ')}) m，${r.t.length} 个时刻`, file: 'probe_time' });
  } catch (e) { toast(e.message, true); } finally { busy(false); }
}
async function fieldStats(field, comp) {
  busy(true, '全场统计…');
  try {
    const r = await api('/api/post3d/stats', withD({ case: S.case, time: S.time, field, comp, bins: 40 }));
    const mid = r.edges.slice(0, -1).map((e, i) => (e + r.edges[i + 1]) / 2);
    showChart({ kind: 'hist', title: `${label(field, comp)} · 全场体积分布`, x: mid, xlabel: '', series: { '体积占比': r.hist }, file: `hist_${field}`,
      sub: `体积加权平均 ${fmt(r.mean_vol)} ± ${fmt(r.std_vol)}，范围 ${fmt(r.min)}–${fmt(r.max)}，体积分 ∫ = ${fmt(r.integral)}，总体积 ${fmt(r.volume)} m³${S.info.axisym ? '（2D 楔形 5°，整圈 ×72）' : ''}，${r.cells.toLocaleString()} 单元` });
  } catch (e) { toast(e.message, true); } finally { busy(false); }
}
function showChart(c) { S.chart = c; $('bottom').hidden = false; resize(); drawChart(); }
function drawChart() {
  const c = S.chart; if (!c) return;
  $('bottom-s').textContent = c.sub || '';
  const names = Object.keys(c.series); const el = $('chart'); const W = el.clientWidth || 600, H = el.clientHeight || 170;
  const pl = 58, pr = 12, pt = 8, pb = 22, cols = ['#2563eb', '#dc2626', '#16a34a', '#d97706'];
  const xs = c.x, x0 = Math.min(...xs), x1 = Math.max(...xs), sx = x => pl + (x - x0) / ((x1 - x0) || 1) * (W - pl - pr);
  const yPix = (y, lo, hi) => pt + (1 - (y - lo) / ((hi - lo) || 1)) * (H - pt - pb);
  // 多条曲线单位不同：各自归一化，左轴标第一条的真实值，图例里给每条的范围
  const parts = names.map((n, k) => { const v = c.series[n].map(y => y ?? NaN), fin = v.filter(Number.isFinite); const lo = c.kind === 'hist' ? 0 : Math.min(...fin), hi = Math.max(...fin);
    return { n, v, lo, hi, col: cols[k % 4] }; });
  const p0 = parts[0]; let body = '';
  // 直方图一根柱子占一半以上体积（如鼓泡床的稀相区 αs≈0）时纵轴改用对数，其余柱子才看得见
  const logY = c.kind === 'hist' && p0 && p0.hi > 0.5;
  if (logY) { const pos = p0.v.filter(v => v > 0); p0.lo = Math.log10(Math.min(...pos)); p0.hi = Math.log10(p0.hi); p0.v = p0.v.map(v => v > 0 ? Math.log10(v) : p0.lo); }
  if (c.kind === 'hist') {
    const bw = (W - pl - pr) / xs.length;
    body = p0.v.map((y, i) => `<rect x="${(pl + i * bw + 1).toFixed(1)}" y="${yPix(y, p0.lo, p0.hi).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${Math.max(0, H - pb - yPix(y, p0.lo, p0.hi)).toFixed(1)}" fill="${p0.col}" opacity=".8"><title>${fmt(xs[i])}：${((logY ? 10 ** y : y) * 100).toPrecision(3)} %</title></rect>`).join('');
  } else body = parts.map(p => `<polyline fill="none" stroke="${p.col}" stroke-width="1.8" points="${p.v.map((y, i) => Number.isFinite(y) ? `${sx(xs[i]).toFixed(1)},${yPix(y, p.lo, p.hi).toFixed(1)}` : '').filter(Boolean).join(' ')}"/>`).join('');
  const yl = v => c.kind === 'hist' ? ((logY ? 10 ** v : v) * 100).toPrecision(2) + '%' : fmt(v);
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}">${[0, 0.5, 1].map(f => `<line class="g" x1="${pl}" x2="${W - pr}" y1="${pt + f * (H - pt - pb)}" y2="${pt + f * (H - pt - pb)}"/><text x="${pl - 6}" y="${pt + f * (H - pt - pb) + 4}" text-anchor="end">${p0 ? yl(p0.hi - (p0.hi - p0.lo) * f) : ''}</text>`).join('')}
    ${[0, 0.25, 0.5, 0.75, 1].map(f => `<text x="${sx(x0 + (x1 - x0) * f)}" y="${H - 6}" text-anchor="middle">${fmt(x0 + (x1 - x0) * f)}${c.xlabel ? ' ' + c.xlabel : ''}</text>`).join('')}${body}</svg>`;
  $('bottom-t').innerHTML = esc(c.title) + (logY ? ' <span class="muted small">（纵轴对数）</span>' : '') + (c.kind === 'hist' ? '' : parts.map(p => `<span style="color:${p.col};font-weight:500;margin-left:8px">● ${esc(label(p.n))} <span class="muted small">${fmt(p.lo)}–${fmt(p.hi)}</span></span>`).join(''));
}
$('bottom-x').onclick = () => { $('bottom').hidden = true; resize(); };
const download = (name, text, type = 'text/csv') => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
$('csv').onclick = () => {
  const c = S.chart; if (!c) return; const names = Object.keys(c.series);
  download(`${c.file}_${S.case.replace(/\W+/g, '_')}.csv`, [['x' + (c.xlabel ? '_' + c.xlabel : ''), ...names].join(','), ...c.x.map((x, i) => [x, ...names.map(n => c.series[n][i] ?? '')].join(','))].join('\n'));
};
function layerCsv(L) {
  // 导出这一层显示的数据：每个顶点的坐标 + 着色场（逐单元着色时导出单元值）
  const o = S.objs.get(L.id); if (!o) return;
  const rows = [`x,y,z,${L.field ? label(L.field, L.comp).replace(/,/g, ' ') : 'patch'}`];
  o.traverse(m => {
    if (!(m.isMesh || m.isLineSegments) || m.userData.edges || m.userData.box) return;
    const pos = m.geometry.attributes.position, s = m.geometry.userData.cell && L.flat ? m.geometry.userData.cellExp : m.geometry.userData.scalars;
    for (let i = 0; i < pos.count; i++) rows.push(`${pos.getX(i)},${pos.getY(i)},${pos.getZ(i)},${s ? s[i] : (m.userData.patch || '')}`);
  });
  download(`${L.type}_${(L.field || 'geom').replace(/\W+/g, '_')}_${S.time}.csv`, rows.join('\n'));
  toast(`已导出 ${rows.length - 1} 个点`);
}

// ---------------------------------------------------------------- 计算器（派生场；按算例存在浏览器里）
function calcExamples() {
  const has = n => (S.info?.fields || []).some(f => f.name === n), up = upAxis(), ex = [];
  if (has('U.gas') && has('U.particles')) ex.push(['滑移速度', 'slip', 'mag(U.gas - U.particles)']);
  if (has('alpha.particles')) ex.push(['颗粒表观密度', 'rho_bulk', 'alpha.particles*1500']);
  if (has('alpha.particles') && has('U.particles')) ex.push(['颗粒竖直通量 kg/m²s', 'Gs_up', `alpha.particles*1500*${up}(U.particles)`]);
  if (has('C2H4.gas') && has('C3H6.gas')) ex.push(['乙烯/丙烯比', 'C2C3_ratio', 'C2H4.gas/max(C3H6.gas, 1e-9)']);
  if (has('U.gas') && has('alpha.gas')) ex.push(['气相表观速度', 'Ug_sup', `alpha.gas*${up}(U.gas)`]);
  return ex;
}
function renderCalc() {
  const box = $('calc'); box.hidden = S.mode !== 'post' || !S.info;
  if (box.hidden) return;
  box.innerHTML = `<h2>计算器（派生场）</h2>
    ${S.derived.map((d, i) => `<div class="row small" style="margin:3px 0"><b>${esc(d.name)}</b><span class="muted" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(d.expr)}">= ${esc(d.expr)}</span><button class="ib" data-del="${i}" aria-label="删除" style="width:22px;height:22px">✕</button></div>`).join('')}
    <div class="row" style="margin-top:4px"><input type="text" id="cname" placeholder="名字" style="width:32%"><input type="text" id="cexpr" placeholder="表达式，如 mag(U.gas - U.particles)" style="flex:1"></div>
    <div class="row" style="margin-top:4px;flex-wrap:wrap">${calcExamples().map(([t, n, e]) => `<button class="sm" data-ex="${esc(n)}|${esc(e)}" title="${esc(e)}">${esc(t)}</button>`).join('')}<span class="sp"></span><button class="sm primary" id="cadd">添加</button></div>
    <p class="hint">直接写场名；可用 + − × ÷ ^ 和 mag sqrt abs log log10 exp min max x y z dot clip。添加后在任何图层的「着色」里都能选。</p>`;
  box.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { const d = S.derived.splice(+b.dataset.del, 1)[0]; S.info.fields = S.info.fields.filter(f => f.name !== d.name); saveDerived(); renderCalc(); renderEditor(); });
  box.querySelectorAll('[data-ex]').forEach(b => b.onclick = () => { const [n, e] = b.dataset.ex.split('|'); $('cname').value = n; $('cexpr').value = e; });
  $('cadd').onclick = () => addDerived($('cname').value.trim(), $('cexpr').value.trim());
}
const saveDerived = () => localStorage.setItem(DKEY(S.case), JSON.stringify(S.derived));
async function addDerived(name, expr, quiet) {
  name = (name || '').replace(/[^\w.-]/g, '_').slice(0, 40);
  if (!name || !expr) return toast('名字和表达式都要填', true);
  if ((S.info.fields || []).some(f => f.name === name) && !S.derived.some(d => d.name === name)) return quiet ? undefined : toast(`「${name}」和已有的场重名`, true);
  try {
    const r = await api('/api/post3d/calccheck', { case: S.case, time: S.time, expr });
    S.derived = S.derived.filter(d => d.name !== name).concat([{ name, expr }]);
    S.info.fields = S.info.fields.filter(f => f.name !== name).concat([{ name, ncomp: r.ncomp, range: r.range, derived: true }]);
    if (!quiet) { saveDerived(); toast(`已添加「${name}」，范围 ${fmt(r.range[0])} – ${fmt(r.range[1])}${r.nan ? `，${r.nan} 个单元无效（除零等）` : ''}`); }
    renderCalc(); renderEditor();
  } catch (e) { if (!quiet) toast('表达式有误：' + e.message, true); else S.derived = S.derived.filter(d => d.name !== name); }
}

// ---------------------------------------------------------------- 网格质量卡（网格与几何模式）
async function meshCard(run) {
  const card = $('meshcard'); if (S.mode !== 'mesh') { card.hidden = true; return; }
  card.hidden = false;
  if (S.info?.nomesh) { card.innerHTML = `<h2>几何</h2><p class="hint">还没有网格。STL：${(S.info.stl || []).map(esc).join('、')}</p>`; return; }
  card.innerHTML = `<h2>网格质量</h2><p class="muted small">${run ? '正在运行 checkMesh…' : '读取中…'}</p>`;
  try {
    const r = await api('/api/post3d/meshcheck?case=' + encodeURIComponent(S.case) + (run ? '&run=1' : ''));
    const i = S.info || {};
    const kv = [['单元', (r.cells ?? i.cells)?.toLocaleString?.() ?? '–'], ['点', (r.points ?? i.points)?.toLocaleString?.() ?? '–']];
    if (r.hex !== null && r.hex !== undefined) kv.push(['六面体 / 多面体', `${r.hex ?? 0} / ${r.poly ?? 0}`]);
    const bad = (v, a, b) => v === null || v === undefined ? '' : v > b ? 'bad' : v > a ? 'mid' : 'ok';
    if (r.nonOrthoMax !== null && r.nonOrthoMax !== undefined) kv.push(['非正交 最大', `<span class="badge ${bad(r.nonOrthoMax, 65, 70)}">${fmt(r.nonOrthoMax)}°</span>`]);
    if (r.skewMax !== null && r.skewMax !== undefined) kv.push(['偏斜 最大', `<span class="badge ${bad(r.skewMax, 3, 4)}">${fmt(r.skewMax)}</span>`]);
    if (r.aspectMax !== null && r.aspectMax !== undefined) kv.push(['长宽比 最大', `<span class="badge ${bad(r.aspectMax, 100, 1000)}">${fmt(r.aspectMax)}</span>`]);
    const b = i.bounds || []; if (b.length) kv.push(['尺寸 m', `${fmt(b[1] - b[0])} × ${fmt(b[3] - b[2])} × ${fmt(b[5] - b[4])}`]);
    const verdict = r.ok === true ? '<span class="badge ok">Mesh OK</span>' : r.ok === false ? '<span class="badge bad">有检查未通过</span>' : '<span class="badge mid">未检查</span>';
    card.innerHTML = `<div class="row"><h2>网格质量</h2>${verdict}</div><div class="kv">${kv.map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join('')}</div>
      ${r.failed?.length ? `<div class="hint" style="color:var(--err)">${r.failed.map(esc).join('<br>')}</div>` : ''}
      <p class="hint">${r.source ? '来源：' + esc(r.source) : '这个算例还没有 checkMesh 日志。'}${i.axisym ? ' · 2D 轴对称（wedge）算例' : ''}</p>
      <div class="row"><button class="sm" id="run-cm">${r.source ? '重新运行 checkMesh' : '运行 checkMesh'}</button>${r.tail ? '<button class="sm" id="cm-log">看日志</button>' : ''}</div>
      <h2 style="margin-top:12px">边界</h2><div class="kv">${(i.patches || []).map(p => `<span>${esc(p.name)}</span><b class="muted">${esc(p.type)}${p.nFaces ? ' · ' + p.nFaces.toLocaleString() : ''}</b>`).join('')}</div>`;
    $('run-cm').onclick = () => meshCard(true);
    $('cm-log') && ($('cm-log').onclick = () => { const w = window.open('', '_blank'); w.document.write(`<pre style="font:12px monospace;white-space:pre-wrap">${esc(r.tail)}</pre>`); });
  } catch (e) { card.innerHTML = `<h2>网格质量</h2><p class="hint" style="color:var(--err)">${esc(e.message)}</p>`; }
}

// ---------------------------------------------------------------- 算例 / 时刻 / 模式
function defaultLayers() {
  if (S.info?.nomesh) return [newLayer('stl'), newLayer('outline')];
  if (S.mode === 'mesh') return [newLayer('patches'), newLayer('outline')];
  if (!defaultField()) return [newLayer('patches'), newLayer('outline')];
  return S.info.axisym ? [newLayer('slice', { mirror: true }), newLayer('outline')] : [newLayer('clip'), newLayer('outline')];
}
async function loadCase(c, keepLayers) {
  S.case = c; S.info = null; for (const id of [...S.objs.keys()]) dropObj(id);
  $('caseinfo').textContent = '读取算例…'; renderPresets();
  const url = new URL(location.href); url.searchParams.set('case', c); history.replaceState(null, '', url);
  busy(true, '读取算例（首次较慢，之后有缓存）…');
  try { S.info = await api('/api/post3d/info?case=' + encodeURIComponent(c)); }
  catch (e) { busy(false); $('caseinfo').textContent = ''; toast('读不了这个算例：' + e.message, true); return; }
  busy(false);
  const i = S.info;
  $('time').innerHTML = i.times.map(t => `<option value="${t}"${t === i.latest ? ' selected' : ''}>${t}${t === i.latest ? '（最新）' : ''}</option>`).join('');
  if (i.nomesh && S.mode !== 'mesh') { S.mode = 'mesh'; $('mode').querySelectorAll('button').forEach(x => x.setAttribute('aria-selected', String(x.dataset.m === 'mesh'))); }
  S.time = i.latest; $('timebar').hidden = S.mode === 'mesh' || i.times.length < 2;
  $('caseinfo').textContent = i.nomesh ? `还没有网格 · ${i.stl.length} 个 STL` : `${i.cells.toLocaleString()} 单元 · ${i.times.length} 个时刻${i.decomposed ? ' · 分解数据' : ''}${i.axisym ? ' · 2D 轴对称' : ''}`;
  if (S.mode === 'post' && i.times.length === 1 && i.times[0] === 0) toast('这个算例还没有写出结果（只有 0 时刻），显示的是初始场');
  if (S.pending) {
    // 智能体指定的视图：时刻取最接近的，图层按给的参数建（缺的项用聪明默认值）
    const pt = Number(S.pending.time); if (Number.isFinite(pt) && i.times.length) { S.time = i.times.reduce((a, b) => Math.abs(b - pt) < Math.abs(a - pt) ? b : a); $('time').value = String(S.time); }
    S.layers = S.pending.layers.map(o => newLayer(o.type, o)); S.sel = S.layers[0]?.id;
    const sl = S.pending.layers.find(o => o.type === 'slice' && o.axis); S.viewAfter = sl ? '+' + sl.axis : null; S.pending = null;
  } else if (!keepLayers) { S.layers = defaultLayers(); S.sel = S.layers[0]?.id; }
  S._fitted = false; S._warm = false;
  S.derived = [];
  let saved = []; try { saved = JSON.parse(localStorage.getItem(DKEY(c)) || '[]'); } catch {}
  for (const d of saved) await addDerived(d.name, d.expr, true);
  renderPresets(); renderAddMenu(); renderLayers(); renderCalc(); meshCard(false);
  await refresh();
  if (S.viewAfter) { setView(S.viewAfter); S.viewAfter = null; }   // 智能体要的截面：正对着看
}
async function loadCases() {
  const j = await api('/api/post/cases');
  const want = QS.get('case');
  // 默认：链接里指定的 → 最近有结果的 → 第一个有网格的
  const list = j.cases.filter(c => c.hasMesh || c.hasData || c.hasStl);
  const sel = want && list.find(c => c.path === want) ? want : (list.find(c => c.hasData) || list[0])?.path;
  $('case').innerHTML = list.map(c => `<option value="${esc(c.path)}"${c.path === sel ? ' selected' : ''}>${esc(c.path)}${c.hasData ? '' : c.hasMesh ? '（只有网格）' : '（只有 STL）'}</option>`).join('')
    || '<option value="">工作区里没有找到 OpenFOAM 算例</option>';
  if (sel) loadCase(sel);
}
$('case').onchange = () => loadCase($('case').value);
$('time').onchange = () => { S.time = +$('time').value; refresh(); };
const stepTime = k => { const ts = S.info?.times || [], i = ts.indexOf(S.time); const j = Math.max(0, Math.min(ts.length - 1, i + k)); if (j !== i) { S.time = ts[j]; $('time').value = String(ts[j]); return refresh(); } };
$('tprev').onclick = () => stepTime(-1); $('tnext').onclick = () => stepTime(1);
$('tplay').onclick = async () => {
  if (S.playing) { S.playing = false; return; }
  S.playing = true; $('tplay').textContent = '■'; $('tplay').setAttribute('aria-pressed', 'true');
  const ts = S.info?.times || [];
  if (ts.indexOf(S.time) >= ts.length - 1) { S.time = ts[0]; $('time').value = String(ts[0]); await refresh(); }
  while (S.playing && ts.indexOf(S.time) < ts.length - 1) await stepTime(1);
  S.playing = false; $('tplay').textContent = '▶'; $('tplay').setAttribute('aria-pressed', 'false');
};
$('mode').querySelectorAll('button').forEach(b => b.onclick = () => {
  if (S.info?.nomesh && b.dataset.m === 'post') { toast('这个算例还没有网格和结果，只能看几何'); return; }
  S.mode = b.dataset.m; $('mode').querySelectorAll('button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
  const url = new URL(location.href); url.searchParams.set('mode', S.mode); history.replaceState(null, '', url);
  if (!S.info) return;
  for (const id of [...S.objs.keys()]) dropObj(id);
  $('timebar').hidden = S.mode === 'mesh' || S.info.times.length < 2;
  S.layers = defaultLayers(); S.sel = S.layers[0]?.id; renderPresets(); renderAddMenu(); renderLayers(); renderCalc(); meshCard(false); refresh();
});
$('mode').querySelectorAll('button').forEach(x => x.setAttribute('aria-selected', String(x.dataset.m === S.mode)));
$('tools').querySelectorAll('[data-v]').forEach(b => b.onclick = () => setView(b.dataset.v));
$('proj').onclick = () => {
  S.ortho = !S.ortho; const from = camera, to = S.ortho ? orthoCam : persp;
  to.position.copy(from.position); to.up.copy(from.up); camera = to; controls.object = camera; fitOrtho(); controls.update();
  $('proj').setAttribute('aria-pressed', String(S.ortho)); $('proj').textContent = S.ortho ? 'O' : 'P';
};
$('bg').onclick = () => { S.dark = !S.dark; setBg(); };
$('shot').onclick = () => {
  // 截图把色标、算例和时刻一起画进去（论文/汇报直接可用）
  const src = renderer.domElement, k = src.width / src.clientWidth, cv = document.createElement('canvas'); cv.width = src.width; cv.height = src.height;
  const x = cv.getContext('2d'); x.drawImage(src, 0, 0);
  const fg = S.dark ? '#e5e5e5' : '#222', bg = S.dark ? 'rgba(28,29,33,.9)' : 'rgba(255,255,255,.92)';
  x.font = `${13 * k}px system-ui, "Microsoft YaHei", sans-serif`; x.fillStyle = fg; x.textBaseline = 'top';
  x.fillText(`${S.case}   t = ${S.time} s`, 14 * k, 12 * k);
  let ox = cv.width - 14 * k;
  const seen = new Set();
  for (const L of S.layers) {
    if (!L.visible || !L.field || !L._range || L.type === 'outline') continue;
    const key = L.field + L.comp + L.cmap + rangeOf(L).join(); if (seen.has(key)) continue; seen.add(key);
    let [lo, hi] = rangeOf(L); if (L.log && !(lo > 0)) lo = hi * 1e-6;
    const T = lut(L.cmap), bw = 20 * k, bh = 180 * k, w = 130 * k, y0 = 14 * k, x0 = ox - w;
    x.fillStyle = bg; x.fillRect(x0 - 8 * k, y0 - 6 * k, w + 12 * k, bh + 40 * k);
    x.fillStyle = fg; x.font = `600 ${12 * k}px system-ui, "Microsoft YaHei", sans-serif`; x.fillText(label(L.field, L.comp).slice(0, 14) + (L.log ? '（对数）' : ''), x0, y0);
    for (let i = 0; i < bh; i++) { const j = Math.round((1 - i / (bh - 1)) * 255) * 3; x.fillStyle = `rgb(${T[j] * 255},${T[j + 1] * 255},${T[j + 2] * 255})`; x.fillRect(x0, y0 + 20 * k + i, bw, 1); }
    x.font = `${11 * k}px system-ui, sans-serif`; x.fillStyle = fg;
    [0, 0.25, 0.5, 0.75, 1].forEach(f => { const v = L.log && lo > 0 ? 10 ** (Math.log10(hi) - (Math.log10(hi) - Math.log10(lo)) * f) : hi - (hi - lo) * f; x.fillText(fmt(v), x0 + bw + 6 * k, y0 + 20 * k + f * bh - 6 * k); });
    ox = x0 - 20 * k;
  }
  const a = document.createElement('a'); a.href = cv.toDataURL('image/png'); a.download = `${S.case.replace(/\W+/g, '_')}_${S.time}.png`; a.click(); toast('已保存截图（含色标、算例和时刻）');
};
$('fs').onclick = () => document.fullscreenElement ? document.exitFullscreen() : $('stage').requestFullscreen();
addEventListener('keydown', e => { if (e.target.closest('input,select,textarea')) return; if (e.key === 'f') setView('fit'); if (e.key === 'ArrowRight') stepTime(1); if (e.key === 'ArrowLeft') stepTime(-1); });
renderAddMenu(); renderPresets(); loadCases().catch(e => toast(e.message, true));
