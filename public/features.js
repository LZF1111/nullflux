// CFDriver 工作台增强：项目、拖入/粘贴、文件树右键与 git 状态、快速打开、全文搜索、
// 命令面板、Markdown/CSV 预览、OpenFOAM 字典高亮、消息操作、导出、主题、系统通知、快捷键表。
// 依赖 app.js 的全局：$, ws, attachments, renderAttachments, openFile, addSystem, toast, send, SLASH_COMMANDS 等。
(() => {
'use strict';
const api = async (url, opt) => { const r = await fetch(url, opt); const j = await r.json().catch(() => ({})); if (!r.ok && !j.error) j.error = 'HTTP ' + r.status; return j; };
const post = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const say = msg => (typeof toast === 'function' ? toast(msg) : addSystem(msg));
const fmtSize = n => n < 1024 ? n + ' B' : n < 1 << 20 ? (n / 1024).toFixed(1) + ' KB' : n < 1 << 30 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB';
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };

// ---------- 通用浮层 ----------
function overlay(title, cls = '') {
  const back = el('div', 'fx-back'), box = el('div', 'fx-dialog ' + cls);
  box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', title);
  box.innerHTML = `<div class="fx-head"><b>${esc(title)}</b><span class="grow"></span><button type="button" class="icon-btn fx-x" aria-label="关闭"><svg class="ico"><use href="#i-x"/></svg></button></div><div class="fx-body"></div>`;
  back.appendChild(box); document.body.appendChild(back);
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  box.querySelector('.fx-x').onclick = close;
  return { back, box, body: box.querySelector('.fx-body'), close };
}

// ---------- 列表型选择器（命令面板 / 快速打开 / 项目 / 搜索共用） ----------
function picker({ title, placeholder, source, render, onPick, hint, debounce = 0, cls = '' }) {
  const o = overlay(title, 'fx-picker ' + cls);
  o.body.innerHTML = `<input class="fx-q" type="search" autocomplete="off" spellcheck="false" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}"><div class="fx-list" role="listbox"></div>${hint ? `<div class="fx-hint">${hint}</div>` : ''}`;
  const q = o.body.querySelector('.fx-q'), list = o.body.querySelector('.fx-list');
  let items = [], sel = 0, seq = 0, timer = 0;
  const paint = () => {
    list.innerHTML = '';
    if (!items.length) { list.appendChild(el('div', 'fx-empty', q.value ? '没有匹配项' : '输入以搜索')); return; }
    items.forEach((it, i) => {
      const row = el('div', 'fx-item' + (i === sel ? ' sel' : ''), render(it, q.value));
      row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(i === sel));
      row.onmousemove = () => { if (sel !== i) { sel = i; paint(); } };
      row.onclick = () => { o.close(); onPick(it, q.value); };
      list.appendChild(row);
    });
    list.children[sel]?.scrollIntoView({ block: 'nearest' });
  };
  const refresh = async () => { const my = ++seq; const r = await source(q.value.trim()); if (my !== seq) return; items = r || []; sel = 0; paint(); };
  q.oninput = () => { clearTimeout(timer); timer = setTimeout(refresh, debounce); };
  q.onkeydown = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); paint(); }
    else if (e.key === 'Enter' && items[sel]) { e.preventDefault(); o.close(); onPick(items[sel], q.value); }
  };
  refresh(); setTimeout(() => q.focus(), 0);
  return o;
}
// 子序列模糊匹配：返回分数（越小越好）与高亮
function fuzzy(text, q) {
  if (!q) return { score: text.length, html: esc(text) };
  const t = text.toLowerCase(), s = q.toLowerCase(); let ti = 0, last = -1, gaps = 0; const hit = [];
  for (const ch of s) { const k = t.indexOf(ch, ti); if (k < 0) return null; if (last >= 0) gaps += k - last - 1; hit.push(k); last = k; ti = k + 1; }
  const base = t.lastIndexOf('/') + 1, inName = hit[0] >= base ? 0 : 50;
  let html = '', j = 0; for (let i = 0; i < text.length; i++) { if (hit[j] === i) { html += '<mark>' + esc(text[i]) + '</mark>'; j++; } else html += esc(text[i]); }
  return { score: gaps + inName + text.length / 100, html };
}
// ====================== 1. 项目：最近项目、新建、打开 ======================
const FX = window.FX = {};
async function switchWorkspace(dir) {
  const j = await post('/api/projects/open', { dir });
  if (j.error) return say('打开项目失败：' + j.error);
  $('ws-display').textContent = j.workspace; updateWsName(j.workspace); refreshFlat(); gitRefresh();
  addSystem('已切换到项目：' + j.workspace);
}
function updateWsName(p) { const n = $('ws-name'); if (n && p) { n.textContent = p.split(/[\\/]/).filter(Boolean).pop() || p; n.parentElement.title = p; } }
FX.projects = async () => {
  const j = await api('/api/projects'); if (j.error) return say(j.error);
  picker({
    title: '项目', placeholder: '搜索最近的项目…', cls: 'fx-projects',
    hint: '<kbd>Enter</kbd> 打开　·　底部可新建项目或打开其他文件夹',
    source: async q => {
      const list = j.projects.map(p => ({ ...p, f: fuzzy(p.name + '  ' + p.path, q) })).filter(p => p.f);
      return [...list, { act: 'new' }, { act: 'open' }];
    },
    render: p => p.act === 'new' ? '<span class="fx-ic">＋</span><b>新建项目…</b><span class="muted small">空目录或复制已有算例，可选 git init</span>'
      : p.act === 'open' ? '<span class="fx-ic">▸</span><b>打开文件夹…</b><span class="muted small">浏览服务器目录</span>'
      : `<span class="fx-ic">${p.path === j.current ? '●' : '○'}</span><b>${esc(p.name)}</b><span class="muted small fx-path">${esc(p.path)}</span>`
        + `<span class="fx-tags">${p.exists ? '' : '<span class="fx-tag warn">不存在</span>'}${p.git ? '<span class="fx-tag">git</span>' : ''}${p.cases ? `<span class="fx-tag">${p.cases} 算例</span>` : ''}${p.openedAt ? `<span class="muted small">${relTime(p.openedAt)}</span>` : ''}</span>`,
    onPick: p => p.act === 'new' ? FX.newProject(j) : p.act === 'open' ? $('open-folder').click() : switchWorkspace(p.path),
  });
};
FX.newProject = async (info) => {
  info = info?.home ? info : await api('/api/projects');
  const parentGuess = (info.current || info.home || '').replace(/[\\/][^\\/]+[\\/]?$/, '') || info.home;
  const o = overlay('新建项目', 'fx-form');
  o.body.innerHTML = `
    <label class="fx-field">项目名<input class="fx-in" name="name" required placeholder="例：reactor_sim_2026" autocomplete="off"></label>
    <label class="fx-field">位置（父目录）<input class="fx-in" name="parent" value="${esc(parentGuess)}"></label>
    <div class="fx-field">起点
      <div class="fx-seg" role="radiogroup">
        <label><input type="radio" name="tpl" value="empty" checked> 空项目</label>
        <label><input type="radio" name="tpl" value="copy"> 复制已有算例 / 项目</label>
      </div></div>
    <label class="fx-field fx-from" hidden>复制来源（不复制 processor*、postProcessing、dynamicCode）<input class="fx-in" name="from" placeholder="${esc(info.current || '')}/cases/baseCase"></label>
    <label class="fx-field">项目说明（写进 README.md，智能体会读）<textarea class="fx-in" name="readme" rows="3" placeholder="目标、论文、工况……"></textarea></label>
    <label class="fx-check"><input type="checkbox" name="git" checked> 初始化 git 仓库（改动可追踪、可回退）</label>
    <div class="fx-path-preview muted small"></div>
    <div class="fx-actions"><button type="button" class="fx-btn" data-act="cancel">取消</button><button type="button" class="fx-btn primary" data-act="ok">创建并打开</button></div>`;
  const f = n => o.body.querySelector(`[name="${n}"]`);
  const prev = () => { o.body.querySelector('.fx-path-preview').textContent = '将创建：' + (f('parent').value.replace(/[\\/]+$/, '') + '/' + (f('name').value || '…')); };
  o.body.querySelectorAll('[name="tpl"]').forEach(r => r.onchange = () => { o.body.querySelector('.fx-from').hidden = !o.body.querySelector('[name="tpl"][value="copy"]').checked; });
  f('name').oninput = prev; f('parent').oninput = prev; prev(); setTimeout(() => f('name').focus(), 0);
  o.body.querySelector('[data-act="cancel"]').onclick = o.close;
  o.body.querySelector('[data-act="ok"]').onclick = async () => {
    const copy = o.body.querySelector('[name="tpl"][value="copy"]').checked;
    const j = await post('/api/projects/create', { name: f('name').value.trim(), parent: f('parent').value.trim(), template: copy ? 'copy' : 'empty', from: f('from').value.trim(), git: f('git').checked, readme: f('readme').value.trim() });
    if (j.error) return say('创建失败：' + j.error);
    o.close(); $('ws-display').textContent = j.workspace; updateWsName(j.workspace); refreshFlat(); gitRefresh();
    addSystem('已创建并打开项目：' + j.workspace);
  };
};
// 侧栏底部菜单加入口
(() => {
  const items = document.querySelector('.file-menu-items'); if (!items) return;
  const mk = (id, text, fn) => { const b = el('button', '', text); b.type = 'button'; b.id = id; b.onclick = fn; return b; };
  items.prepend(mk('fx-new-project', '新建项目…', () => FX.newProject()), mk('fx-projects', '最近项目…　Ctrl+Alt+O', FX.projects));
  const sum = document.querySelector('.file-menu summary'); if (sum) sum.title = '项目：切换、新建、打开（Ctrl+Alt+O）';
  items.addEventListener('click', e => { if (e.target.closest('button')) items.closest('details')?.removeAttribute('open'); });
})();
// ====================== 2. 上传（带进度）、拖入、粘贴 ======================
const TEXT_EXT = /\.(txt|md|csv|dat|xy|json|ya?ml|py|js|ts|sh|c|cpp|h|hpp|f90|m|tex|log|ini|cfg|toml|xml|html|css)$/i;
const FOAM_NAME = /^(controlDict|fvSchemes|fvSolution|blockMeshDict|snappyHexMeshDict|decomposeParDict|setFieldsDict|phaseProperties|thermophysicalProperties.*|momentumTransport.*|turbulenceProperties.*|reactions.*|g|U.*|p.*|T.*|alpha.*|k|epsilon|omega|nut|Theta.*)$/;
function uploadRaw(file, dir, rel, onProgress, overwrite) {
  return new Promise(resolve => {
    const x = new XMLHttpRequest();
    const qs = new URLSearchParams({ name: file.name, ...(dir ? { dir } : {}), ...(rel ? { rel } : {}), ...(overwrite ? { overwrite: '1' } : {}) });
    x.open('POST', '/api/upload-raw?' + qs);
    x.upload.onprogress = e => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch {} if (x.status === 409) j.conflict = true; resolve(j); };
    x.onerror = () => resolve({ error: '网络错误' });
    x.send(file);
  });
}
// 上传队列浮窗：多文件进度条
const upHost = el('div', 'fx-uploads'); upHost.setAttribute('aria-live', 'polite'); document.body.appendChild(upHost);
async function uploadMany(files, dir, { asAttachment = false } = {}) {
  const out = [];
  for (const { file, rel } of files) {
    const row = el('div', 'fx-up', `<span class="fx-up-name"></span><span class="fx-up-size muted small">${fmtSize(file.size)}</span><span class="fx-up-bar"><span></span></span>`);
    row.querySelector('.fx-up-name').textContent = rel || file.name; upHost.appendChild(row);
    const bar = row.querySelector('.fx-up-bar > span');
    let j = await uploadRaw(file, dir, rel, p => { bar.style.width = (p * 100).toFixed(1) + '%'; });
    if (j.conflict && confirm(`${j.path} 已存在，覆盖？`)) j = await uploadRaw(file, dir, rel, p => { bar.style.width = (p * 100).toFixed(1) + '%'; }, true);
    row.classList.add(j.ok ? 'done' : 'fail'); bar.style.width = '100%';
    if (!j.ok) row.querySelector('.fx-up-size').textContent = j.conflict ? '已跳过' : (j.error || '失败');
    setTimeout(() => row.remove(), j.ok ? 2500 : 8000);
    if (j.ok) out.push({ file, path: j.path });
  }
  if (asAttachment) {
    for (const { file, path } of out) attachments.push({ type: 'context_file', name: file.name, path, size: file.size, _binary: !TEXT_EXT.test(file.name) });
    renderAttachments();
  }
  if (out.length && !asAttachment) say(`已上传 ${out.length} 个文件到 ${dir || '工作区'}`);
  return out;
}
// 把 DataTransfer 展开成 [{file, rel}]，支持拖入整个文件夹
async function collectFiles(dt) {
  const res = [], entries = [...(dt.items || [])].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...(dt.files || [])].map(file => ({ file, rel: '' }));
  const walk = async (ent, prefix) => {
    if (ent.isFile) await new Promise(r => ent.file(f => { res.push({ file: f, rel: prefix ? prefix + f.name : '' }); r(); }, r));
    else if (ent.isDirectory) {
      const rd = ent.createReader(); let batch;
      do { batch = await new Promise(r => rd.readEntries(r, () => r([]))); for (const c of batch) await walk(c, prefix + ent.name + '/'); } while (batch.length);
    }
  };
  for (const e of entries) await walk(e, '');
  return res;
}
// 图片 → 内联给视觉模型；小文本 → 内联；其他 → 上传到 .cache/uploads 作为上下文文件
async function attachLocalFiles(list) {
  const rest = [];
  for (const it of list) {
    const f = it.file;
    if (/^image\//.test(f.type) && f.size < 15 << 20 && !it.rel) {
      const d = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); });
      attachments.push({ type: 'image', name: f.name || 'pasted.png', dataUrl: d, size: f.size });
    } else if ((TEXT_EXT.test(f.name) || FOAM_NAME.test(f.name)) && f.size < 256 << 10 && !it.rel) {
      attachments.push({ type: 'file', name: f.name, inlineContent: await f.text(), size: f.size });
    } else rest.push(it);
  }
  renderAttachments();
  if (rest.length) await uploadMany(rest, '', { asAttachment: true });
}
// 整个页面都是拖放区：落在文件树 → 上传到对应目录；落在其他位置 → 作为对话附件
const dropMask = el('div', 'fx-drop', '<div class="fx-drop-card"><svg class="ico lg"><use href="#i-plus"/></svg><b>松开以添加</b><span class="fx-drop-sub">图片和小文本直接进入对话；其他文件上传到工作区作为上下文</span></div>');
document.body.appendChild(dropMask);
let dragDepth = 0;
const isFileDrag = e => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', e => { if (!isFileDrag(e)) return; dragDepth++; dropMask.classList.add('on'); });
window.addEventListener('dragleave', e => { if (!isFileDrag(e)) return; if (--dragDepth <= 0) { dragDepth = 0; dropMask.classList.remove('on'); } });
window.addEventListener('dragover', e => {
  if (!isFileDrag(e)) return; e.preventDefault();
  const t = treeTargetAt(e); document.querySelectorAll('.tree-node.fx-drop-into').forEach(n => n.classList.remove('fx-drop-into'));
  if (t) t.node?.classList.add('fx-drop-into');
  dropMask.classList.toggle('tree', !!t);
  dropMask.querySelector('b').textContent = t ? `上传到 ${t.dir || '工作区根目录'}` : '松开以添加到对话';
});
window.addEventListener('drop', async e => {
  if (!isFileDrag(e)) return; e.preventDefault(); dragDepth = 0; dropMask.classList.remove('on');
  document.querySelectorAll('.fx-drop-into').forEach(n => n.classList.remove('fx-drop-into'));
  const t = treeTargetAt(e); const files = await collectFiles(e.dataTransfer); if (!files.length) return;
  if (t) await uploadMany(files, t.dir || '.');
  else { await attachLocalFiles(files); $('input').focus(); }
});
function treeTargetAt(e) {
  const hit = document.elementFromPoint(e.clientX, e.clientY); if (!hit) return null;
  const tree = hit.closest('#tree'); if (!tree) return null;
  const node = hit.closest('.tree-node');
  if (!node) return { dir: '', node: null };
  const p = node.dataset.path || ''; const isDir = node.classList.contains('dir');
  return { dir: isDir ? p : p.replace(/\/?[^/]*$/, ''), node: isDir ? node : null };
}
// 粘贴：剪贴板里的图片 / 文件进入附件；长文本照常粘贴
$('input').addEventListener('paste', async e => {
  const files = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
  if (!files.length) {
    // 超长文本（如整段日志）转成附件，避免撑爆输入框
    const t = e.clipboardData?.getData('text/plain') || '';
    if (t.length > 6000) { e.preventDefault(); attachments.push({ type: 'file', name: `粘贴文本_${t.length}字.txt`, inlineContent: t, size: t.length }); renderAttachments(); say(`长文本（${t.length} 字）已作为附件`); }
    return;
  }
  e.preventDefault();
  await attachLocalFiles(files.map((f, i) => ({ file: f.name && f.name !== 'image.png' ? f : new File([f], `pasted_${Date.now().toString(36)}_${i}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type }), rel: '' })));
  say(`已从剪贴板添加 ${files.length} 个附件`);
});
// 原有「附件」按钮也改走原始字节上传（不再 base64 膨胀，支持更大文件）
$('file-picker').onchange = async e => { await attachLocalFiles([...e.target.files].map(file => ({ file, rel: '' }))); $('file-picker').value = ''; };
// ====================== 3. 文件树：git 标记、右键菜单、行内重命名、拖动移动 ======================
let GIT = { git: false, branch: '', map: new Map() };
async function gitRefresh() {
  const j = await api('/api/git/status').catch(() => ({}));
  GIT = { git: !!j.git, branch: j.branch || '', map: new Map((j.files || []).map(f => [f.path, f.code])) };
  paintGit();
}
FX.gitRefresh = gitRefresh;
const gitLabel = c => c === '??' ? ['U', '未跟踪'] : /D/.test(c) ? ['D', '已删除'] : /A/.test(c) ? ['A', '新增'] : /R/.test(c) ? ['R', '重命名'] : ['M', '已修改'];
function paintGit() {
  const tree = $('tree'); if (!tree) return;
  const dirs = new Set();
  for (const p of GIT.map.keys()) { const s = p.split('/'); for (let i = 1; i < s.length; i++) dirs.add(s.slice(0, i).join('/')); }
  tree.querySelectorAll('.tree-node').forEach(n => {
    n.querySelector('.fx-git')?.remove(); n.classList.remove('git-M', 'git-U', 'git-A', 'git-D', 'git-R', 'git-dir');
    const p = n.dataset.path; if (!p) return;
    const c = GIT.map.get(p);
    if (c) { const [k, t] = gitLabel(c); const b = el('span', 'fx-git', k); b.title = t; n.appendChild(b); n.classList.add('git-' + k); }
    else if (dirs.has(p)) n.classList.add('git-dir');
  });
  let br = $('fx-branch');
  if (GIT.git) {
    if (!br) { br = el('button', 'fx-branch'); br.id = 'fx-branch'; br.type = 'button'; br.title = '查看改动'; br.onclick = () => FX.changes();
      const host = document.querySelector('[data-pid="files"] .panel-head .pacts') || document.querySelector('[data-pid="files"] .panel-head'); host?.prepend(br); }
    br.textContent = '⎇ ' + GIT.branch.replace(/\.\.\..*/, '').replace(/^No commits yet on /, '') + (GIT.map.size ? ` · ${GIT.map.size}` : '');
  } else br?.remove();
}
new MutationObserver(() => { clearTimeout(paintGit._t); paintGit._t = setTimeout(paintGit, 80); }).observe($('tree'), { childList: true, subtree: true });
setInterval(() => { if (!document.hidden) gitRefresh(); }, 30000); gitRefresh();

// 右键菜单
const menu = el('div', 'fx-menu'); menu.setAttribute('role', 'menu'); menu.hidden = true; document.body.appendChild(menu);
const hideMenu = () => { menu.hidden = true; };
document.addEventListener('mousedown', e => { if (!menu.contains(e.target)) hideMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) hideMenu(); });
window.addEventListener('blur', hideMenu);
function showMenu(x, y, items) {
  menu.innerHTML = '';
  for (const it of items) {
    if (it === '-') { menu.appendChild(el('div', 'fx-sep')); continue; }
    const b = el('button', 'fx-mi' + (it.danger ? ' danger' : ''), `<span>${esc(it.label)}</span>${it.key ? `<kbd>${esc(it.key)}</kbd>` : ''}`);
    b.type = 'button'; b.setAttribute('role', 'menuitem'); b.onclick = () => { hideMenu(); it.run(); }; menu.appendChild(b);
  }
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 8)) + 'px'; menu.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 8)) + 'px';
  menu.querySelector('button')?.focus();
}
menu.addEventListener('keydown', e => {
  const bs = [...menu.querySelectorAll('button')], i = bs.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); bs[(i + 1) % bs.length]?.focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length]?.focus(); }
});
FX.showMenu = showMenu;
const fsOp = (op, p, isDir) => post('/api/fs', { op, path: p, isDir });
async function newIn(dir, isDir) {
  const n = prompt(isDir ? '新文件夹名' : '新文件名（可含子路径）', isDir ? 'new_folder' : 'untitled.txt'); if (!n) return;
  const p = (dir ? dir + '/' : '') + n.replace(/^[\\/]+/, '');
  const j = await fsOp('create', p, isDir); if (j.error) return say('新建失败：' + j.error);
  if (!isDir) setTimeout(() => openFile(p), 300);
}
function inlineRename(node, p) {
  const name = node.querySelector('.tree-name'); if (!name) return;
  const old = p.split('/').pop(); const inp = el('input', 'fx-rename'); inp.value = old; inp.setAttribute('aria-label', '新名称');
  name.replaceWith(inp); inp.focus(); const dot = old.lastIndexOf('.'); inp.setSelectionRange(0, dot > 0 ? dot : old.length);
  inp.onclick = e => e.stopPropagation();
  let done = false;
  const finish = async ok => {
    if (done) return; done = true; const v = inp.value.trim(); inp.replaceWith(name);
    if (!ok || !v || v === old) return;
    const j = await post('/api/fs/rename', { from: p, to: p.replace(/[^/]*$/, '') + v });
    if (j.error) say('重命名失败：' + j.error); else { say('已重命名为 ' + v); retab(p, j.path); }
  };
  inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
  inp.onblur = () => finish(true);
}
function retab(from, to) { try { if (tabs.has(from)) { closeTab(from); openFile(to); } } catch {} }
function copyText(t, what) { (navigator.clipboard?.writeText(t) || Promise.reject()).then(() => say('已复制' + what), () => prompt('复制：', t)); }
function mention(p) { const i = $('input'); i.value += (i.value && !/\s$/.test(i.value) ? ' ' : '') + '@' + p + ' '; i.focus(); }
const isCaseDir = p => p && allFiles.includes(p + '/system/controlDict');
function ask(text) { $('input').value = text; $('input').focus(); }
function treeMenu(node, x, y) {
  const p = node?.dataset.path || ''; const isDir = !node || node.classList.contains('dir');
  const dir = isDir ? p : p.replace(/\/?[^/]*$/, '');
  const abs = ($('ws-display').textContent || '').replace(/[\\/]+$/, '') + (p ? '/' + p : '');
  const it = [];
  if (node && !isDir) it.push({ label: '打开', run: () => openFile(p) }, { label: '在对话中引用', key: '@', run: () => mention(p) });
  if (node && !isDir && GIT.map.has(p) && GIT.map.get(p) !== '??') it.push({ label: '查看改动（对比 HEAD）', run: () => FX.gitDiff(p) });
  if (isCaseDir(p)) it.push('-', { label: '算例总览', run: () => { $('input').value = '/case ' + p; send(); } },
    { label: '可视化', run: () => { $('input').value = '/slice ' + p; send(); } },
    { label: '几何预览', run: () => { $('input').value = '/geometry ' + p; send(); } },
    { label: '让智能体检查这个算例…', run: () => ask(`只读检查算例 ${p}：边界条件、数值格式、时间步与并行设置是否合理，列出风险，不要修改文件。`) });
  if (node && isDir && !isCaseDir(p)) it.push({ label: '在对话中引用目录', run: () => mention(p + '/') });
  it.push('-', { label: '新建文件…', run: () => newIn(dir, false) }, { label: '新建文件夹…', run: () => newIn(dir, true) },
    { label: '上传到这里…', run: () => pickUpload(dir) });
  if (node) it.push('-', { label: '重命名', key: 'F2', run: () => inlineRename(node, p) },
    { label: '复制一份', run: async () => { const to = prompt('复制到（相对路径）', p.replace(/(\.[^./]+)?$/, '_copy$1')); if (!to) return; const j = await post('/api/fs/rename', { from: p, to, copy: true }); if (j.error) say('复制失败：' + j.error); } },
    { label: isDir ? '下载（tar.gz，不含 processor*）' : '下载', run: () => { const a = el('a'); a.href = '/api/download?path=' + encodeURIComponent(p); a.download = ''; document.body.appendChild(a); a.click(); a.remove(); } },
    { label: '复制相对路径', run: () => copyText(p, '相对路径') }, { label: '复制绝对路径', run: () => copyText(abs, '绝对路径') },
    '-', { label: '删除…', danger: true, key: 'Del', run: () => delPath(p, isDir) });
  showMenu(x, y, it);
}
async function delPath(p, isDir) {
  if (!confirm(`删除${isDir ? '文件夹' : '文件'} ${p}${isDir ? ' 及其全部内容' : ''}？此操作不可撤销。`)) return;
  const j = await fsOp('delete', p, isDir); if (j.error) say('删除失败：' + j.error); else { say('已删除 ' + p); try { if (tabs.has(p)) closeTab(p); } catch {} }
}
function pickUpload(dir) {
  const inp = el('input'); inp.type = 'file'; inp.multiple = true;
  inp.onchange = () => uploadMany([...inp.files].map(file => ({ file, rel: '' })), dir || '.'); inp.click();
}
$('tree').addEventListener('contextmenu', e => { e.preventDefault(); treeMenu(e.target.closest('.tree-node'), e.clientX, e.clientY); });
// 键盘：选中节点上 F2 重命名、Delete 删除、Shift+F10 / 菜单键弹菜单
$('tree').addEventListener('keydown', e => {
  const node = e.target.closest?.('.tree-node') || $('tree').querySelector('.tree-node.active'); if (!node) return;
  const p = node.dataset.path;
  if (e.key === 'F2') { e.preventDefault(); inlineRename(node, p); }
  else if (e.key === 'Delete') { e.preventDefault(); delPath(p, node.classList.contains('dir')); }
  else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); const r = node.getBoundingClientRect(); treeMenu(node, r.left + 24, r.bottom); }
});
// 在树内拖动节点 → 移动到目标目录
$('tree').addEventListener('dragstart', e => {
  const n = e.target.closest?.('.tree-node'); if (!n?.dataset.path) return;
  e.dataTransfer.setData('application/x-cfd-path', n.dataset.path); e.dataTransfer.effectAllowed = 'move';
});
$('tree').addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('application/x-cfd-path')) { e.preventDefault(); const t = treeTargetAt(e); document.querySelectorAll('.fx-drop-into').forEach(x => x.classList.remove('fx-drop-into')); t?.node?.classList.add('fx-drop-into'); } });
$('tree').addEventListener('drop', async e => {
  const from = e.dataTransfer.getData('application/x-cfd-path'); if (!from) return;
  e.preventDefault(); e.stopPropagation(); document.querySelectorAll('.fx-drop-into').forEach(x => x.classList.remove('fx-drop-into'));
  const t = treeTargetAt(e); const dir = t ? t.dir : '';
  const to = (dir ? dir + '/' : '') + from.split('/').pop();
  if (to === from || to.startsWith(from + '/')) return;
  if (!confirm(`移动 ${from} → ${to}？`)) return;
  const j = await post('/api/fs/rename', { from, to }); if (j.error) say('移动失败：' + j.error); else retab(from, j.path);
});
// 让节点可拖动、可聚焦（renderNode 由 app.js 生成，这里补属性）
new MutationObserver(() => $('tree').querySelectorAll('.tree-node:not([draggable])').forEach(n => { n.draggable = true; n.tabIndex = -1; })).observe($('tree'), { childList: true, subtree: true });
// 空白处的新建/上传按钮
(() => {
  const head = document.querySelector('[data-pid="files"] .panel-head .pacts'); if (!head) return;
  const b = el('button', 'mini', '上传'); b.type = 'button'; b.title = '上传文件到工作区根目录（也可以直接把文件或文件夹拖进文件树）'; b.onclick = () => pickUpload('.');
  head.appendChild(b);
})();

// ====================== 4. 快速打开（Ctrl+P）与全文搜索（Ctrl+Shift+F） ======================
const RECENT_KEY = 'cfd.recentFiles';
const recent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } };
const _openFile = window.openFile;
if (typeof _openFile === 'function') {
  window.openFile = openFile = async function (p, ...rest) {
    try { const r = recent().filter(x => x !== p); r.unshift(p); localStorage.setItem(RECENT_KEY, JSON.stringify(r.slice(0, 40))); } catch {}
    return _openFile.call(this, p, ...rest);
  };
}
const fileIcon = p => /\.(png|jpe?g|gif|webp|svg)$/i.test(p) ? '▣' : /\.pdf$/i.test(p) ? '▤' : /\.(stl|obj|vtu|vtp|vtk)$/i.test(p) ? '◆' : /\.(csv|dat|xy)$/i.test(p) ? '▦' : /\/(system|constant)\//.test(p) ? '⚙' : '▢';
FX.quickOpen = () => picker({
  title: '快速打开', placeholder: '按文件名搜索（模糊匹配，如 cdict → controlDict）', cls: 'fx-quick',
  hint: '<kbd>↑↓</kbd> 选择　<kbd>Enter</kbd> 打开　前缀 <kbd>#</kbd> 全文搜索　<kbd>&gt;</kbd> 命令',
  source: async q => {
    if (q.startsWith('>')) { setTimeout(() => FX.palette(q.slice(1))); return []; }
    if (q.startsWith('#')) { setTimeout(() => FX.search(q.slice(1))); return []; }
    if (!q) { const r = recent().filter(p => allFiles.includes(p)); return (r.length ? r : allFiles.slice(0, 30)).slice(0, 30).map(p => ({ p, html: esc(p), recent: r.includes(p) })); }
    const out = []; for (const p of allFiles) { const f = fuzzy(p, q); if (f) out.push({ p, ...f }); }
    out.sort((a, b) => a.score - b.score); return out.slice(0, 60);
  },
  render: it => `<span class="fx-ic">${fileIcon(it.p)}</span><span class="fx-file">${it.html}</span>${it.recent ? '<span class="muted small">最近</span>' : ''}${GIT.map.has(it.p) ? `<span class="fx-git">${gitLabel(GIT.map.get(it.p))[0]}</span>` : ''}`,
  onPick: it => openFile(it.p),
});
FX.search = (initial = '') => {
  const o = picker({
    title: '在工作区中搜索', placeholder: '搜索文件内容（≥2 字，不区分大小写；可写 glob:*.py 限定文件）', debounce: 250, cls: 'fx-search',
    hint: '跳过 processor*、dynamicCode、.git、.cache；每个文件最多 5 处',
    source: async q => {
      if (q.length < 2) return [];
      const m = /\s*glob:(\S+)\s*/.exec(q); const glob = m?.[1] || ''; const qq = q.replace(m?.[0] || '', '').trim();
      if (qq.length < 2) return [];
      const j = await api('/api/search?' + new URLSearchParams({ q: qq, glob }));
      const re = new RegExp(qq.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
      return (j.hits || []).map(h => ({ ...h, html: esc(h.text.trim()).replace(re, s => '<mark>' + s + '</mark>') }));
    },
    render: h => `<span class="fx-file">${esc(h.path)}<span class="muted small">:${h.line}</span></span><span class="fx-snip">${h.html}</span>`,
    onPick: async h => { await openFile(h.path); setTimeout(() => { try { editor.revealLineInCenter(h.line); editor.setPosition({ lineNumber: h.line, column: 1 }); editor.focus(); } catch {} }, 400); },
  });
  if (initial) { const q = o.body.querySelector('.fx-q'); q.value = initial; q.dispatchEvent(new Event('input')); }
};
// ====================== 5. git 改动列表与差异 ======================
FX.gitDiff = async p => {
  const j = await api('/api/git/diff?path=' + encodeURIComponent(p)); if (j.error) return say(j.error);
  const o = overlay('改动 · ' + p, 'fx-wide');
  const lines = String(j.diff || '（与 HEAD 无差异）').split('\n').map(s => `<span class="${s.startsWith('+') && !s.startsWith('+++') ? 'add' : s.startsWith('-') && !s.startsWith('---') ? 'del' : s.startsWith('@@') ? 'hunk' : ''}">${esc(s) || ' '}</span>`);
  o.body.innerHTML = `<pre class="fx-diff">${lines.join('\n')}</pre><div class="fx-actions"><button type="button" class="fx-btn" data-a="open">打开文件</button></div>`;
  o.body.querySelector('[data-a="open"]').onclick = () => { o.close(); openFile(p); };
};
FX.changes = async () => {
  await gitRefresh(); if (!GIT.git) return say('当前项目不是 git 仓库（新建项目时可勾选 git init）');
  picker({
    title: `改动 · ⎇ ${GIT.branch.replace(/\.\.\..*/, '')}`, placeholder: '筛选改动文件…', cls: 'fx-changes',
    hint: '<kbd>Enter</kbd> 查看差异（未跟踪文件直接打开）',
    source: async q => [...GIT.map].map(([p, c]) => ({ p, c, f: fuzzy(p, q) })).filter(x => x.f).sort((a, b) => a.f.score - b.f.score),
    render: x => { const [k, t] = gitLabel(x.c); return `<span class="fx-git git-${k}" title="${t}">${k}</span><span class="fx-file">${x.f.html}</span>`; },
    onPick: x => x.c === '??' ? openFile(x.p) : FX.gitDiff(x.p),
  });
};

// ====================== 6. 预览：Markdown 渲染、CSV 表格 + 曲线 ======================
const edHost = $('editor-host');
const pvBar = el('div', 'fx-pvbar'); pvBar.hidden = true;
const pvHost = el('div', 'fx-preview'); pvHost.hidden = true;
edHost?.parentElement?.insertBefore(pvBar, edHost); edHost?.parentElement?.insertBefore(pvHost, edHost.nextSibling);
let pvMode = 'preview', pvPath = '';
const pvKind = p => /\.(md|markdown)$/i.test(p) ? 'md' : /\.(csv|tsv)$/i.test(p) ? 'csv' : /(^|\/)(postProcessing\/.*\.(dat|xy)|.*\.dat)$/i.test(p) ? 'csv' : '';
function pvOff() { pvBar.hidden = true; pvHost.hidden = true; pvPath = ''; if (edHost) edHost.style.visibility = ''; }
function pvOn(p) {
  const kind = pvKind(p); if (!kind) return pvOff();
  if (pvPath !== p) pvMode = 'preview';
  pvPath = p; pvBar.hidden = false;
  pvBar.innerHTML = `<div class="fx-seg2" role="group" aria-label="视图"><button type="button" data-m="preview">${kind === 'csv' ? '表格 · 曲线' : '预览'}</button><button type="button" data-m="source">源码</button></div><span class="grow"></span><span class="muted small"></span>`;
  pvBar.querySelector('.muted').textContent = p;
  pvBar.querySelectorAll('button').forEach(b => b.onclick = () => { pvMode = b.dataset.m; pvRender(kind); });
  pvRender(kind);
}
async function pvRender(kind) {
  pvBar.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.m === pvMode)));
  if (pvMode === 'source') { pvHost.hidden = true; edHost.style.visibility = ''; try { editor.layout(); } catch {} return; }
  let src = ''; try { src = editor.getModel().getValue(); } catch {}
  pvHost.hidden = false; edHost.style.visibility = 'hidden'; pvHost.innerHTML = '';
  if (kind === 'md') {
    const wrap = el('div', 'fx-md msg assistant'), b = el('div', 'bubble'); wrap.appendChild(b); pvHost.appendChild(wrap);
    await renderMarkdownInto(b, src);
    const base = pvPath.replace(/[^/]*$/, '');
    b.querySelectorAll('img[src]').forEach(img => { const s = img.getAttribute('src'); if (s && !/^(https?:|data:|\/)/.test(s)) img.src = '/api/file?raw=1&path=' + encodeURIComponent(base + s); });
    b.querySelectorAll('a[href]').forEach(a => { const h = a.getAttribute('href'); if (h && !/^(https?:|mailto:|#)/.test(h)) a.onclick = e => { e.preventDefault(); openFile(base + h); }; else a.target = '_blank'; });
    return;
  }
  pvHost.appendChild(csvView(src));
}
// 解析 CSV / 空白分隔 / OpenFOAM postProcessing .dat（# 注释行作表头，括号向量拆分）
function parseTable(src) {
  const lines = src.split(/\r?\n/); let header = null; const rows = [];
  const sep = /\t/.test(lines.find(l => l && !l.startsWith('#')) || '') ? '\t' : /,/.test(lines.find(l => l && !l.startsWith('#')) || '') ? ',' : null;
  for (const raw of lines) {
    const l = raw.trim(); if (!l) continue;
    if (l.startsWith('#')) { const h = l.replace(/^#\s*/, '').split(/\s{1,}|\t/).filter(Boolean); if (h.length > 1) header = h; continue; }
    const cells = (sep ? l.split(sep) : l.replace(/[()]/g, ' ').trim().split(/\s+/)).map(s => s.trim().replace(/^"|"$/g, ''));
    rows.push(cells);
  }
  if (!header && rows.length && rows[0].some(c => isNaN(parseFloat(c)))) header = rows.shift();
  const n = Math.max(0, ...rows.map(r => r.length));
  header = (header || []).slice(0, n); while (header.length < n) header.push('c' + header.length);
  return { header, rows };
}
// CSV 视图：选 x / y 列画曲线（SVG，多条 y），下面是可排序的表格（大文件只显示前 2000 行）
function csvView(src) {
  const { header, rows } = parseTable(src);
  const wrap = el('div', 'fx-csv');
  if (!rows.length) { wrap.innerHTML = '<div class="muted">没有可解析的数据行</div>'; return wrap; }
  const numCols = header.map((_, i) => rows.slice(0, 200).every(r => r[i] === undefined || r[i] === '' || !isNaN(parseFloat(r[i]))));
  const firstNum = numCols.indexOf(true);
  let xCol = firstNum >= 0 ? firstNum : 0, yCols = numCols.map((v, i) => v && i !== xCol ? i : -1).filter(i => i >= 0).slice(0, 3);
  const ctl = el('div', 'fx-csv-ctl'), plot = el('div', 'fx-plot'), tbl = el('div', 'fx-table');
  wrap.append(ctl, plot, tbl);
  const opts = sel => header.map((h, i) => `<option value="${i}"${sel(i) ? ' selected' : ''}>${esc(h)}</option>`).join('');
  const draw = () => {
    ctl.innerHTML = `<label>x <select class="fx-in sm" data-x>${opts(i => i === xCol)}</select></label>
      <span class="fx-ychk">y ${header.map((h, i) => i === xCol || !numCols[i] ? '' : `<label><input type="checkbox" data-y="${i}"${yCols.includes(i) ? ' checked' : ''}>${esc(h)}</label>`).join('')}</span>
      <span class="muted small">${rows.length.toLocaleString()} 行 × ${header.length} 列</span>`;
    ctl.querySelector('[data-x]').onchange = e => { xCol = +e.target.value; yCols = yCols.filter(i => i !== xCol); draw(); };
    ctl.querySelectorAll('[data-y]').forEach(c => c.onchange = () => { yCols = [...ctl.querySelectorAll('[data-y]:checked')].map(o => +o.dataset.y).slice(0, 6); draw(); });
    plot.innerHTML = svgPlot(rows, xCol, yCols, header);
  };
  draw();
  let sortCol = -1, asc = true;
  const drawTable = () => {
    let rs = rows.slice();
    if (sortCol >= 0) rs.sort((a, b) => { const x = parseFloat(a[sortCol]), y = parseFloat(b[sortCol]); const d = !isNaN(x) && !isNaN(y) ? x - y : String(a[sortCol]).localeCompare(String(b[sortCol])); return asc ? d : -d; });
    const shown = rs.slice(0, 2000);
    tbl.innerHTML = `<table><thead><tr>${header.map((h, i) => `<th data-i="${i}" class="${numCols[i] ? 'num' : ''}">${esc(h)}${i === sortCol ? (asc ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead><tbody>${shown.map(r => `<tr>${header.map((_, i) => `<td class="${numCols[i] ? 'num' : ''}">${esc(r[i] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>${rs.length > 2000 ? `<div class="muted small">只显示前 2000 行，共 ${rs.length.toLocaleString()} 行</div>` : ''}`;
    tbl.querySelectorAll('th').forEach(th => th.onclick = () => { const i = +th.dataset.i; asc = sortCol === i ? !asc : true; sortCol = i; drawTable(); });
  };
  drawTable(); return wrap;
}
function svgPlot(rows, xc, ycs, header) {
  if (!ycs.length) return '<div class="muted small">选一个数值列作为 y</div>';
  const W = 480, H = 220, L = 52, R = 10, T = 10, B = 26;
  const pts = ycs.map(yc => rows.map(r => [parseFloat(r[xc]), parseFloat(r[yc])]).filter(([a, b]) => isFinite(a) && isFinite(b)));
  const all = pts.flat(); if (!all.length) return '<div class="muted small">没有数值</div>';
  let [x0, x1] = [Math.min(...all.map(p => p[0])), Math.max(...all.map(p => p[0]))], [y0, y1] = [Math.min(...all.map(p => p[1])), Math.max(...all.map(p => p[1]))];
  if (x0 === x1) x1 = x0 + 1; if (y0 === y1) { y1 += Math.abs(y1) * 0.05 || 1; y0 -= Math.abs(y0) * 0.05 || 1; }
  const sx = x => L + (x - x0) / (x1 - x0) * (W - L - R), sy = y => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B);
  const fmt = v => Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-2 && v !== 0) ? v.toExponential(1) : +v.toPrecision(4);
  const ticks = (a, b) => [0, 0.25, 0.5, 0.75, 1].map(k => a + (b - a) * k);
  const cols = ['var(--fx-c1)', 'var(--fx-c2)', 'var(--fx-c3)', 'var(--fx-c4)', 'var(--fx-c5)', 'var(--fx-c6)'];
  // 点太多时等间隔抽稀，曲线形状不变
  const thin = p => p.length > 3000 ? p.filter((_, i) => i % Math.ceil(p.length / 3000) === 0) : p;
  return `<svg viewBox="0 0 ${W} ${H}" class="fx-svg" role="img" aria-label="曲线图">
    ${ticks(y0, y1).map(v => `<line x1="${L}" x2="${W - R}" y1="${sy(v)}" y2="${sy(v)}" class="g"/><text x="${L - 6}" y="${sy(v) + 4}" text-anchor="end">${fmt(v)}</text>`).join('')}
    ${ticks(x0, x1).map(v => `<text x="${sx(v)}" y="${H - 10}" text-anchor="middle">${fmt(v)}</text>`).join('')}
    ${pts.map((p, k) => `<polyline fill="none" stroke="${cols[k % 6]}" stroke-width="1.6" points="${thin(p).map(([a, b]) => sx(a).toFixed(1) + ',' + sy(b).toFixed(1)).join(' ')}"/>`).join('')}
  </svg><div class="fx-legend">${ycs.map((c, k) => `<span><i style="background:${cols[k % 6]}"></i>${esc(header[c])}</span>`).join('')}<span class="muted">x：${esc(header[xc])}</span></div>`;
}
// 文件内容从磁盘更新后，重画当前的预览（Markdown / 表格曲线）
FX.pvRefresh = () => { if (pvPath && pvMode === 'preview' && !pvBar.hidden) pvRender(pvKind(pvPath)); };
// 挂到 openFile：文本文件打开后，按扩展名显示预览条
const _of2 = window.openFile;
window.openFile = openFile = async function (p, ...rest) { const r = await _of2.call(this, p, ...rest); try { if (activeTab === p) pvOn(p); else pvOff(); } catch {} return r; };
// 切标签时同步
new MutationObserver(() => { try { activeTab && pvKind(activeTab) ? (activeTab !== pvPath && pvOn(activeTab)) : pvOff(); } catch {} }).observe($('tabs'), { childList: true, subtree: true, attributes: true });
// ====================== 7. 消息操作：复制、编辑重发、从此处分叉、时间戳 ======================
function decorateMsg(m) {
  if (m.dataset.fx) return; m.dataset.fx = '1';
  const isUser = m.classList.contains('user'), isAI = m.classList.contains('assistant');
  if (!isUser && !isAI) return;
  const bar = el('div', 'fx-msgbar');
  const ts = m.dataset.ts ? new Date(+m.dataset.ts) : new Date();
  bar.innerHTML = `<span class="muted small fx-ts" title="${ts.toLocaleString()}">${ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>`;
  const btn = (label, ico, fn) => { const b = el('button', 'fx-mbtn', `<svg class="ico sm"><use href="#i-${ico}"/></svg>`); b.type = 'button'; b.title = label; b.setAttribute('aria-label', label); b.onclick = fn; bar.appendChild(b); };
  const text = () => (m.querySelector('.bubble')?.innerText || m.innerText || '').trim();
  btn('复制', 'copy', () => copyText(m.dataset.raw || text(), '消息'));
  if (isUser) {
    // 对标 OpenChamber：回到这条消息之前（删掉它和之后的对话，文件恢复到那一轮开始前），原文放回输入框；可撤销
    btn('回滚到这里', 'undo', () => {
      if (!TASKS_UI.currentId || m.dataset.ui === undefined) return;
      if (!$('stop').disabled) { say('运行中不能回滚，请先停止'); return; }
      if (!confirm('回滚到这条消息之前？\n这条消息和之后的对话会移除，智能体改过的文件恢复到当时的内容。\n回滚后可以「撤销回滚」，直到你发送新消息。')) return;
      ws.send(JSON.stringify({ type: 'task_revert', id: TASKS_UI.currentId, ui: +m.dataset.ui }));
    });
    btn('从这条之前分叉为新任务', 'fork', () => {
      if (!TASKS_UI.currentId || m.dataset.ui === undefined) return;
      if (!$('stop').disabled) { say('运行中不能分叉，请先停止'); return; }
      ws.send(JSON.stringify({ type: 'task_fork', id: TASKS_UI.currentId, beforeUser: +m.dataset.ui }));
      $('input').value = m.dataset.raw || text(); $('input').dispatchEvent(new Event('input'));
      say('已分叉为新任务，原任务不变；这条消息已放回输入框');
    });
  }
  m.appendChild(bar);
}
function redoBanner(text) {
  document.getElementById('fx-redo')?.remove();
  const b = el('div', 'fx-redo'); b.id = 'fx-redo';
  b.innerHTML = `<span>${esc(text || '已回滚到之前的状态')}</span><button type="button" class="fx-mbtn wide">撤销回滚</button><button type="button" class="fx-mbtn" aria-label="关闭">✕</button>`;
  const [undo, close] = b.querySelectorAll('button');
  undo.onclick = () => ws.send(JSON.stringify({ type: 'task_unrevert', id: TASKS_UI.currentId }));
  close.onclick = () => b.remove();
  $('chat').appendChild(b); b.scrollIntoView({ block: 'end' });
}
FX.showRedo = () => redoBanner('上次回滚的内容还可以恢复');
FX.onReverted = r => {
  $('input').value = r.text || ''; $('input').dispatchEvent(new Event('input')); $('input').focus();
  let msg = `已回滚：移除 ${r.messages} 条对话记录，恢复 ${r.files} 个文件`;
  if (r.skipped && r.skipped.length) msg += `（${r.skipped.length} 个大文件超过 1 MB 未快照，未恢复）`;
  redoBanner(msg + '。原消息已放回输入框。');
};
FX.onUnreverted = r => { document.getElementById('fx-redo')?.remove(); say(`已撤销回滚：恢复 ${r.messages} 条对话、${r.files} 个文件`); };
new MutationObserver(muts => { for (const mu of muts) for (const n of mu.addedNodes) if (n.nodeType === 1 && n.classList?.contains('msg')) decorateMsg(n); }).observe($('chat'), { childList: true });
$('chat').querySelectorAll('.msg').forEach(decorateMsg);

// ====================== 8. 设置：主题（浅/深/跟随系统）、字号、系统通知 ======================
const PREF_KEY = 'cfd.prefs';
const prefs = Object.assign({ theme: 'dark', font: 15, notify: false }, (() => { try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch { return {}; } })());
const savePrefs = () => localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
function applyPrefs() {
  const dark = prefs.theme !== 'light' && (prefs.theme !== 'system' || darkMQ.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.setProperty('--fx-font', prefs.font + 'px');
  try { if (window.monaco) monaco.editor.setTheme(dark ? 'vs-dark' : 'vs'); } catch {}
}
darkMQ.addEventListener?.('change', applyPrefs); applyPrefs();
monacoReady?.then(() => applyPrefs());
FX.cycleTheme = () => { prefs.theme = { light: 'dark', dark: 'system', system: 'light' }[prefs.theme] || 'light'; savePrefs(); applyPrefs(); say('主题：' + { light: '浅色', dark: '深色', system: '跟随系统' }[prefs.theme]); };
FX.prefs = () => {
  const o = overlay('界面偏好', 'fx-form');
  o.body.innerHTML = `
    <div class="fx-field">主题<div class="fx-seg">${[['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']].map(([v, t]) => `<label><input type="radio" name="th" value="${v}"${prefs.theme === v ? ' checked' : ''}> ${t}</label>`).join('')}</div></div>
    <label class="fx-field">字号 <span class="muted small" data-fv>${prefs.font}px</span><input type="range" min="13" max="18" step="1" value="${prefs.font}" name="font"></label>
    <label class="fx-check"><input type="checkbox" name="notify"${prefs.notify ? ' checked' : ''}> 任务完成、求解结束或需要审批时发送系统通知（浏览器在后台时）</label>
    <p class="muted small">这些设置只保存在当前浏览器。模型、API 和求解器设置在「设置」里。</p>`;
  o.body.querySelectorAll('[name="th"]').forEach(r => r.onchange = () => { prefs.theme = r.value; savePrefs(); applyPrefs(); });
  const fr = o.body.querySelector('[name="font"]'); fr.oninput = () => { prefs.font = +fr.value; o.body.querySelector('[data-fv]').textContent = fr.value + 'px'; savePrefs(); applyPrefs(); };
  o.body.querySelector('[name="notify"]').onchange = async e => {
    if (e.target.checked && 'Notification' in window && Notification.permission !== 'granted') {
      const p = await Notification.requestPermission();
      if (p !== 'granted') { e.target.checked = false; say('浏览器拒绝了通知权限（需要 https 或 localhost）'); return; }
    }
    prefs.notify = e.target.checked; savePrefs();
  };
};
function sysNotify(title, body) {
  if (!prefs.notify || !('Notification' in window) || Notification.permission !== 'granted' || document.hasFocus()) return;
  try { const n = new Notification(title, { body: String(body || '').slice(0, 180), tag: 'cfd-' + title }); n.onclick = () => { window.focus(); n.close(); }; } catch {}
}
// 包一层 handleMessage：完成 / 审批 / 求解器告警 → 系统通知
if (typeof handleMessage === 'function') {
  const _hm = handleMessage;
  window.handleMessage = handleMessage = function (m) {
    try {
      if (m.type === 'task_complete') sysNotify('任务完成', m.summary);
      else if (m.type === 'approval_request') sysNotify('需要审批', `${m.name}: ${m.args?.command || ''}`);
      else if (m.type === 'agent_end' && !document.hasFocus()) sysNotify('智能体已停下', '回到 CFDriver 查看结果');
    } catch {}
    return _hm.apply(this, arguments);
  };
}
// ====================== 9. 命令面板（Ctrl+Shift+P）与快捷键 ======================
const click = id => () => $(id)?.click();
const view = (v, sub) => () => { try { revealInspector(); selectContext(v); if (sub) setTimeout(() => document.querySelector(`#ctx-sub [data-sub="${sub}"]`)?.click() || [...document.querySelectorAll('#ctx-sub button')].find(b => b.textContent.trim() === sub)?.click(), 30); } catch {} };
const COMMANDS = [
  ['项目', '切换项目…', 'Ctrl+Alt+O', () => FX.projects()],
  ['项目', '新建项目…', '', () => FX.newProject()],
  ['项目', '打开文件夹…', '', click('open-folder')],
  ['文件', '快速打开文件…', 'Ctrl+P', () => FX.quickOpen()],
  ['文件', '在文件中搜索…', 'Ctrl+Shift+F', () => FX.search()],
  ['文件', '新建文件…', '', () => newIn('', false)],
  ['文件', '上传文件到工作区…', '', () => pickUpload('.')],
  ['文件', '查看 git 改动', '', () => FX.changes()],
  ['任务', '新任务', '', click('new-task')],
  ['任务', '搜索任务', 'Ctrl+K', () => $('task-search')?.focus()],
  ['任务', '分叉当前任务', '', () => { if (TASKS_UI.currentId) ws.send(JSON.stringify({ type: 'task_fork', id: TASKS_UI.currentId })); }],
  ['任务', '导出当前任务为 Markdown', '', () => FX.exportTask()],
  ['任务', '设置目标与验收标准', '', click('goal-btn')],
  ['任务', '停止当前回合', 'Esc', click('stop')],
  ['视图', '显示/隐藏侧栏', 'Ctrl+B', () => toggleSidebar()],
  ['视图', '显示/隐藏检查器', 'Ctrl+I', () => toggleInspector()],
  ['视图', '运行 › 作业', '', view('status', '作业')],
  ['视图', '运行 › 计划', '', view('status', '计划')],
  ['视图', '运行 › 终端', '', view('status', '终端')],
  ['视图', '结果 › 可视化', '', view('results', '切片')],
  ['视图', '结果 › 几何预览', '', view('results', '几何')],
  ['视图', '文件', '', view('files')],
  ['视图', '实时监视（新窗口）', '', () => window.open('/monitor', '_blank', 'noopener')],
  ['模式', '规划模式（只读）', 'Tab', () => setAgentMode('plan')],
  ['模式', '执行模式', 'Tab', () => setAgentMode('build')],
  ['设置', '设置（模型、API）', '', click('settings-btn')],
  ['设置', '外观与通知', '', () => FX.prefs()],
  ['设置', '主题：浅色', '', () => { prefs.theme = 'light'; savePrefs(); applyPrefs(); }],
  ['设置', '主题：深色', '', () => { prefs.theme = 'dark'; savePrefs(); applyPrefs(); }],
  ['帮助', '键盘快捷键', 'Ctrl+/', () => FX.keys()],
];
FX.palette = (initial = '') => {
  const o = picker({
    title: '命令', placeholder: '输入命令…（如 新建项目、切片、深色）', cls: 'fx-palette',
    hint: '<kbd>Ctrl+P</kbd> 文件　<kbd>Ctrl+Shift+F</kbd> 全文　<kbd>Ctrl+/</kbd> 快捷键',
    source: async q => COMMANDS.map(([g, t, k, run]) => ({ g, t, k, run, f: fuzzy(g + ' ' + t, q) })).filter(x => x.f).sort((a, b) => q ? a.f.score - b.f.score : 0),
    render: x => `<span class="fx-tag">${esc(x.g)}</span><span class="fx-file">${esc(x.t)}</span>${x.k ? `<kbd class="fx-k">${esc(x.k)}</kbd>` : ''}`,
    onPick: x => x.run(),
  });
  if (initial) { const q = o.body.querySelector('.fx-q'); q.value = initial; q.dispatchEvent(new Event('input')); }
};
FX.exportTask = () => {
  if (!TASKS_UI.currentId) return say('没有当前任务');
  const a = el('a'); a.href = `/api/tasks/${encodeURIComponent(TASKS_UI.currentId)}/export`; a.download = ''; document.body.appendChild(a); a.click(); a.remove();
};
const KEYS = [
  ['Ctrl+Shift+P', '命令面板'], ['Ctrl+P', '快速打开文件'], ['Ctrl+Shift+F', '在文件中搜索'], ['Ctrl+Alt+O', '切换项目'],
  ['Ctrl+K', '搜索任务'], ['Ctrl+B', '侧栏'], ['Ctrl+I', '检查器'], ['Ctrl+S', '保存文件'], ['Ctrl+/', '本页'],
  ['Enter / Shift+Enter', '发送 / 换行'], ['↑（空输入框）', '上一条输入'], ['Tab（空输入框）', '切换规划/执行'], ['@', '引用文件'], ['/', '命令'],
  ['Esc', '停止 / 关闭弹窗'], ['F2 / Delete', '文件树：重命名 / 删除'], ['Shift+F10', '文件树：右键菜单'],
];
FX.keys = () => { const o = overlay('键盘快捷键', 'fx-keys'); o.body.innerHTML = `<table class="fx-kt">${KEYS.map(([k, d]) => `<tr><td>${k.split(' / ').map(x => `<kbd>${esc(x)}</kbd>`).join(' / ')}</td><td>${esc(d)}</td></tr>`).join('')}</table>`; };
document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey; if (!mod || e.altKey && e.key.toLowerCase() !== 'o') return;
  const k = e.key.toLowerCase(), inMonaco = e.target.closest?.('.monaco-editor');
  if (e.shiftKey && k === 'p') { e.preventDefault(); FX.palette(); }
  else if (e.shiftKey && k === 'f') { e.preventDefault(); FX.search(); }
  else if (!e.shiftKey && k === 'p' && !inMonaco) { e.preventDefault(); FX.quickOpen(); }
  else if (e.altKey && k === 'o') { e.preventDefault(); FX.projects(); }
  else if (!e.shiftKey && (k === '/' || e.code === 'Slash')) { e.preventDefault(); FX.keys(); }
}, true);
// 输入框里的上箭头：调出上一条发送过的输入（空输入框时）
const HIST_KEY = 'cfd.inputHistory'; let histIdx = -1;
const hist = () => { try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch { return []; } };
$('input').addEventListener('keydown', e => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') { histIdx = -1; return; }
  if ($('mention-pop')?.style.display && $('mention-pop').style.display !== 'none') return;
  const h = hist(); if (!h.length) return;
  if (e.key === 'ArrowUp' && ($('input').value === '' || histIdx >= 0) && $('input').selectionStart === 0) {
    e.preventDefault(); histIdx = Math.min(h.length - 1, histIdx + 1); $('input').value = h[histIdx];
  } else if (e.key === 'ArrowDown' && histIdx >= 0) {
    e.preventDefault(); histIdx--; $('input').value = histIdx >= 0 ? h[histIdx] : '';
  }
}, true);
$('send')?.addEventListener('click', () => { const v = $('input').value.trim(); if (v) { const h = hist().filter(x => x !== v); h.unshift(v); localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(0, 100))); } }, true);
$('input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { const v = $('input').value.trim(); if (v && !v.startsWith('/')) { const h = hist().filter(x => x !== v); h.unshift(v); localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(0, 100))); } } }, true);
// 斜杠命令补充
try { SLASH_COMMANDS.push(['project', '切换项目'], ['new-project', '新建项目'], ['open', '快速打开文件'], ['search', '在文件中搜索'], ['export', '导出任务为 Markdown'], ['keys', '键盘快捷键'], ['theme', '主题（light/dark/system）']); } catch {}
const _send = send;
window.send = send = function () {
  const v = $('input').value.trim(), m = /^\/(project|new-project|open|search|export|keys|theme)\b\s*(.*)$/.exec(v);
  if (!m) return _send.apply(this, arguments);
  $('input').value = '';
  const arg = m[2].trim();
  ({ project: () => FX.projects(), 'new-project': () => FX.newProject(), open: () => FX.quickOpen(), search: () => FX.search(arg), export: () => FX.exportTask(), keys: () => FX.keys(),
     theme: () => { prefs.theme = ['light', 'dark', 'system'].includes(arg) ? arg : (document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); savePrefs(); applyPrefs(); } })[m[1]]();
};
// 线程头加一个「命令」按钮，侧栏底部显示当前项目名并可点击切换
(() => {
  const acts = document.querySelector('.thread-head .thread-acts') || $('goal-btn')?.parentElement;
  if (acts) { const b = el('button', 'icon-btn', '<svg class="ico"><use href="#i-keyboard"/></svg>'); b.type = 'button'; b.title = '命令面板（Ctrl+Shift+P）'; b.setAttribute('aria-label', '命令面板'); b.onclick = () => FX.palette(); acts.insertBefore(b, acts.firstChild); }
})();
// ====================== 10. OpenFOAM 字典语法高亮（Monaco 语言 + 按文件名自动识别） ======================
const FOAM_KW = ['FoamFile', 'version', 'format', 'class', 'object', 'location', 'dimensions', 'internalField', 'boundaryField', 'type', 'value', 'uniform', 'nonuniform',
  'application', 'startFrom', 'startTime', 'stopAt', 'endTime', 'deltaT', 'writeControl', 'writeInterval', 'purgeWrite', 'writeFormat', 'adjustTimeStep', 'maxCo', 'maxDeltaT', 'functions', 'libs',
  'ddtSchemes', 'gradSchemes', 'divSchemes', 'laplacianSchemes', 'interpolationSchemes', 'snGradSchemes', 'solvers', 'PIMPLE', 'PISO', 'SIMPLE', 'relaxationFactors',
  'numberOfSubdomains', 'method', 'patch', 'wall', 'empty', 'symmetryPlane', 'cyclic', 'fixedValue', 'zeroGradient', 'inletOutlet', 'noSlip', 'slip', 'calculated'];
monacoReady?.then(() => {
  try {
    monaco.languages.register({ id: 'openfoam' });
    monaco.languages.setMonarchTokensProvider('openfoam', {
      keywords: FOAM_KW,
      tokenizer: {
        root: [
          [/\/\/.*$/, 'comment'], [/\/\*/, 'comment', '@cmt'],
          [/#(include|includeEtc|includeFunc|calc|codeStream|inputMode|remove)\b/, 'keyword.directive'],
          [/\$[A-Za-z_][\w.:/]*/, 'variable'],
          [/"[^"]*"/, 'string'],
          [/[A-Za-z_][\w.:<>()-]*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
          [/-?\d+(\.\d+)?([eE][-+]?\d+)?/, 'number'],
          [/[{}()[\]]/, '@brackets'], [/;/, 'delimiter'],
        ],
        cmt: [[/\*\//, 'comment', '@pop'], [/./, 'comment']],
      },
    });
    monaco.languages.setLanguageConfiguration('openfoam', { comments: { lineComment: '//', blockComment: ['/*', '*/'] }, brackets: [['{', '}'], ['(', ')'], ['[', ']']],
      autoClosingPairs: [{ open: '{', close: '}' }, { open: '(', close: ')' }, { open: '"', close: '"' }] });
    // 打开文件时按路径判断：system/ constant/ 0/ 下的无扩展名文件，或常见字典名
    const isFoam = p => { const n = p.split('/').pop(); return !/\.[A-Za-z0-9]{1,5}$/.test(n) && (/\/(system|constant|0(\.orig)?|[0-9.]+)\/[^/]+$/.test(p) || FOAM_NAME.test(n)); };
    // app.js 建模型时不带 URI，所以按标签路径在 openFile 之后设置语言
    const apply = p => { try { const t = tabs.get(p); if (t && isFoam('/' + p) && t.model.getLanguageId() === 'plaintext') monaco.editor.setModelLanguage(t.model, 'openfoam'); } catch {} };
    for (const p of tabs.keys()) apply(p);
    const _of3 = window.openFile;
    window.openFile = openFile = async function (p, ...rest) { const r = await _of3.call(this, p, ...rest); apply(p); return r; };
  } catch (e) { console.warn('openfoam language', e); }
});
// ====================== 11. 快捷键表 ======================
FX.keys = () => {
  const o = overlay('键盘快捷键', 'fx-keys');
  const rows = [
    ['通用', [['命令面板', 'Ctrl+Shift+P'], ['快速打开文件', 'Ctrl+P'], ['在文件中搜索', 'Ctrl+Shift+F'], ['切换项目', 'Ctrl+Alt+O'], ['搜索任务', 'Ctrl+K'], ['快捷键表', 'Ctrl+/']]],
    ['视图', [['侧栏', 'Ctrl+B'], ['检查器', 'Ctrl+I']]],
    ['输入框', [['发送', 'Enter'], ['换行', 'Shift+Enter'], ['上一条 / 下一条历史', '↑ / ↓（输入框为空时）'], ['切换规划 / 执行', 'Tab（输入框为空时）'], ['引用文件', '@'], ['命令', '/'], ['粘贴截图或文件', 'Ctrl+V'], ['停止', 'Esc']]],
    ['文件树', [['重命名', 'F2'], ['删除', 'Delete'], ['右键菜单', 'Shift+F10'], ['移动', '拖到文件夹'], ['上传', '从桌面拖入']]],
    ['编辑器', [['保存', 'Ctrl+S']]],
  ];
  o.body.innerHTML = rows.map(([g, list]) => `<div class="fx-kgroup"><div class="fx-kg">${g}</div>${list.map(([a, k]) => `<div class="fx-krow"><span>${a}</span>${k.split(' / ').map(x => x.split('+').map(s => `<kbd>${esc(s)}</kbd>`).join('+')).join(' / ')}</div>`).join('')}</div>`).join('');
};
api('/api/projects').then(j => j.current && updateWsName(j.current)).catch(() => {});
gitRefresh();
})();
