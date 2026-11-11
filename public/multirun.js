// 模型选择 + 多模型运行（对齐 OpenChamber Multi-run）
// 输入框旁的模型按钮 → 弹出：给当前任务换模型 / 勾选几个模型把同一条指令同时发给它们 / 查看并排比较
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const say = m => (typeof toast === 'function' ? toast(m) : alert(m));
  const key = c => `${c.provider}|${c.model}`;
  let CHOICES = [], picked = new Set(JSON.parse(localStorage.getItem('cfd.mr.picked') || '[]'));

  async function loadChoices() {
    try { CHOICES = (await (await fetch('/api/providers')).json()).choices || []; } catch { CHOICES = []; }
    return CHOICES;
  }
  const curTask = () => (typeof TASKS_UI !== 'undefined' ? TASKS_UI.list.find(t => t.id === TASKS_UI.currentId) : null);

  // ---- 模型按钮的文字：当前任务用的模型 ----
  function label() {
    const lab = $('model-label'); if (!lab) return;
    const t = curTask();
    if (t && t.model) { lab.textContent = t.model; lab.title = t.modelRef ? '这个任务单独指定的模型（点击切换）' : '设置里的主模型（点击切换）'; }
    else if (typeof updateModelLabel === 'function') updateModelLabel();
  }

  // ---- 弹出层 ----
  const pop = document.createElement('div');
  pop.id = 'mr-pop'; pop.className = 'mr-pop'; pop.hidden = true; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', '选择模型');
  document.body.appendChild(pop);
  function place() {
    const b = $('model-picker').getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(b.left, innerWidth - pop.offsetWidth - 8)) + 'px';
    pop.style.bottom = (innerHeight - b.top + 6) + 'px';
  }
  async function openPop() {
    await loadChoices();
    render(); pop.hidden = false; place();
    pop.querySelector('input,button')?.focus();
  }
  function closePop() { pop.hidden = true; }
  function render() {
    const t = curTask();
    const cur = t && t.modelRef ? key(t.modelRef) : (CHOICES.find(c => c.provider === 'main') ? key(CHOICES.find(c => c.provider === 'main')) : '');
    const groups = [...new Set(CHOICES.map(c => c.group))];
    const list = groups.map(g => `<div class="mr-group">${esc(g)}</div>` + CHOICES.filter(c => c.group === g).map(c => {
      const k = key(c);
      return `<div class="mr-item${k === cur ? ' cur' : ''}"><button type="button" class="mr-use" data-k="${esc(k)}" title="这个任务改用 ${esc(c.label)}">${esc(c.label)}${k === cur ? '<span class="mr-tag">当前</span>' : ''}</button>`
 + `<label class="mr-chk" title="勾选后可同时发给多个模型"><input type="checkbox" data-k="${esc(k)}"${picked.has(k) ? ' checked' : ''} aria-label="多模型运行：${esc(c.label)}"></label></div>`;
    }).join('')).join('');
    const n = [...picked].filter(k => CHOICES.some(c => key(c) === k)).length;
    pop.innerHTML = `<div class="mr-head"><span>模型</span><span class="mr-sub">点名字：这个任务换模型　勾选：多模型运行</span></div>`
      + `<div class="mr-list">${list || '<div class="mr-empty">还没有可选模型</div>'}</div>`
      + `<div class="mr-foot">`
      + `<button type="button" class="mr-btn primary" id="mr-go" ${n >= 2 ? '' : 'disabled'} title="把输入框里的指令同时交给勾选的模型，各在自己的目录里独立做">同时交给 ${n} 个模型</button>`
      + `<button type="button" class="mr-btn" id="mr-cmp">比较结果</button>`
      + `<button type="button" class="mr-btn" id="mr-set">管理接口…</button></div>`
      + `<div class="mr-hint">${n >= 2 ? '会新建 ' + n + ' 个任务，后台并行；核数平分；做完在「比较结果」里并排看，可选用一份或让一个模型综合。' : '勾选 2–5 个模型启用多模型运行。'}</div>`;
    pop.querySelectorAll('.mr-use').forEach(b => b.onclick = () => {
      const c = CHOICES.find(x => key(x) === b.dataset.k); const tk = curTask();
      if (!c || !tk) return;
      const isMain = c.provider === 'main';
      ws.send(JSON.stringify({ type: 'task_set_model', id: tk.id, provider: isMain ? '' : c.provider, model: isMain ? '' : c.model }));
      closePop();
    });
    pop.querySelectorAll('input[type=checkbox]').forEach(i => i.onchange = () => {
      if (i.checked && picked.size >= 5) { i.checked = false; say('最多同时 5 个模型'); return; }
      i.checked ? picked.add(i.dataset.k) : picked.delete(i.dataset.k);
      localStorage.setItem('cfd.mr.picked', JSON.stringify([...picked])); render();
    });
    $('mr-go').onclick = launch;
    $('mr-cmp').onclick = () => { closePop(); openCompare(); };
    $('mr-set').onclick = () => { closePop(); window.CFDSettings?.open('models'); };
  }
  function launch() {
    const text = $('input').value.trim();
    if (!text) { say('先在输入框写好要做的事，再点「同时交给」'); $('input').focus(); return; }
    if (text.startsWith('/')) { say('斜杠命令不能多模型运行'); return; }
    const models = [...picked].map(k => CHOICES.find(c => key(c) === k)).filter(Boolean).map(c => ({ provider: c.provider, model: c.model }));
    if (models.length < 2) return;
    ws.send(JSON.stringify({ type: 'multi_run', text, models }));
    $('input').value = ''; closePop();
  }
  document.addEventListener('mousedown', e => { if (!pop.hidden && !pop.contains(e.target) && !$('model-picker').contains(e.target)) closePop(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !pop.hidden) { closePop(); $('model-picker').focus(); } });
  addEventListener('resize', () => { if (!pop.hidden) place(); });

  // ---- 并排比较 ----
  const dlg = document.createElement('div');
  dlg.id = 'mr-modal'; dlg.className = 'modal'; dlg.style.display = 'none';
  dlg.innerHTML = `<div class="modal-box mr-box" role="dialog" aria-modal="true" aria-labelledby="mr-title"><div class="modal-head"><span id="mr-title">多模型运行 · 比较结果</span><button class="mini" id="mr-close" aria-label="关闭">×</button></div><div id="mr-body" class="mr-body"></div></div>`;
  document.body.appendChild(dlg);
  $('mr-close').onclick = () => { dlg.style.display = 'none'; clearInterval(dlg._t); };
  dlg.addEventListener('click', e => { if (e.target === dlg) $('mr-close').click(); });
  let curGroup = null;
  const md = s => (typeof marked !== 'undefined' && marked.parse ? marked.parse(s) : esc(s).replace(/\n/g, '<br>'));
  const kfmt = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n || 0);
  const ago = ms => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? '刚刚' : m < 60 ? m + ' 分钟前' : Math.round(m / 60) + ' 小时前'; };
  async function openCompare(group) {
    dlg.style.display = 'flex'; curGroup = group || curGroup;
    await drawCompare();
    clearInterval(dlg._t); dlg._t = setInterval(() => { if (dlg.style.display !== 'none') drawCompare(); }, 8000);
  }
  async function drawCompare() {
    const box = $('mr-body');
    let groups = [];
    try { groups = (await (await fetch('/api/multirun')).json()).groups || []; } catch (e) { /* 离线 */ }
    if (!groups.length) { box.innerHTML = '<p class="mr-empty">还没有多模型运行。点输入框旁的模型按钮，勾选 2–5 个模型，再点「同时交给」。</p>'; return; }
    if (!curGroup || !groups.some(g => g.group === curGroup)) curGroup = groups[0].group;
    const g = groups.find(x => x.group === curGroup);
    const allDone = g.runs.every(r => !r.running);
    const sel = `<select id="mr-group" class="py-input" aria-label="选择一组">${groups.map(x => `<option value="${x.group}"${x.group === curGroup ? ' selected' : ''}>${esc(x.text.slice(0, 40))} · ${x.runs.length} 个模型 · ${ago(x.createdAt)}</option>`).join('')}</select>`;
    const cols = g.runs.map(r => {
      const st = r.running ? '<span class="mr-st run">运行中</span>' : r.awaiting ? '<span class="mr-st wait">等你回复</span>' : '<span class="mr-st done">完成</span>';
      return `<section class="mr-col${r.picked ? ' picked' : ''}"><header><b>${esc(r.model)}</b>${st}${r.picked ? '<span class="mr-st pick">已采用</span>' : ''}</header>`
        + `<div class="mr-kv"><span>${r.steps} 步 · ${r.tools} 次工具</span><span>${kfmt(r.prompt)}↑ ${kfmt(r.completion)}↓</span><span>${r.fileCount} 个文件</span><span>更新 ${ago(r.updatedAt)}</span></div>`
        + `<div class="mr-ans">${r.answer ? md(r.answer) : '<span class="mr-empty">还没有结论</span>'}</div>`
        + (r.files.length ? `<details class="mr-files"><summary>文件（${r.dir}/）</summary>${r.files.slice(0, 40).map(f => `<a href="#" data-f="${esc(f)}">${esc(f.slice(r.dir.length + 1))}</a>`).join('')}</details>` : '')
        + `<footer><button type="button" class="mr-btn" data-open="${r.id}">打开任务</button><button type="button" class="mr-btn${r.picked ? '' : ' primary'}" data-pick="${r.id}" ${r.running ? 'disabled' : ''}>${r.picked ? '已采用' : '采用这份'}</button></footer></section>`;
    }).join('');
    const fuseOpts = CHOICES.map(c => `<option value="${esc(key(c))}">${esc(c.label)}${c.group !== '主接口' ? ' · ' + esc(c.group) : ''}</option>`).join('');
    box.innerHTML = `<div class="mr-bar">${sel}<span class="grow"></span><label class="mr-fuse">综合用 <select id="mr-fuse-m" class="py-input">${fuseOpts}</select></label>`
      + `<button type="button" class="mr-btn primary" id="mr-fuse" ${allDone ? '' : 'disabled title="等所有模型跑完"'}>让它综合各家结论</button></div>`
      + `<p class="mr-q">${esc(g.text.slice(0, 300))}</p><div class="mr-cols" style="--n:${g.runs.length}">${cols}</div>`;
    $('mr-group').onchange = e => { curGroup = e.target.value; drawCompare(); };
    box.querySelectorAll('[data-open]').forEach(b => b.onclick = () => { $('mr-close').click(); if (typeof switchTask === 'function') switchTask(b.dataset.open); });
    box.querySelectorAll('[data-pick]').forEach(b => b.onclick = async () => { await fetch(`/api/multirun/${curGroup}/pick`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: b.dataset.pick }) }); drawCompare(); });
    box.querySelectorAll('[data-f]').forEach(a => a.onclick = e => { e.preventDefault(); $('mr-close').click(); if (typeof openArtifact === 'function') openArtifact(a.dataset.f); });
    $('mr-fuse').onclick = async () => {
      const c = CHOICES.find(x => key(x) === $('mr-fuse-m').value);
      const r = await fetch(`/api/multirun/${curGroup}/fuse`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c && c.provider !== 'main' ? { provider: c.provider, model: c.model } : {}) });
      const j = await r.json();
      if (!r.ok) { say(j.error || '综合失败'); return; }
      say('已新建「综合」任务，在左侧任务列表里'); $('mr-close').click();
    };
  }

  // ---- 接进 app.js ----
  $('model-picker').onclick = e => { e.preventDefault(); pop.hidden ? openPop() : closePop(); };
  window.MR = { onTasks: label, openCompare, reload: loadChoices, onStarted(m) { say(`已同时交给 ${m.tasks.length} 个模型，后台并行；做完点模型按钮 › 比较结果`); curGroup = m.group; } };
  loadChoices();
})();
