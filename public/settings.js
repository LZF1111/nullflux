// CFDriver 设置页：左侧分区 + 右侧内容（对齐 OpenChamber）。
// 复用 app.js 已有的模型连接 / Python / 工具开关控件（整块搬进来，事件处理不变），其余分区用新接口：
//   /api/env（求解器环境，自动探测，只读）· /api/packs（官方技能包）· /api/mcp（MCP 服务）
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = async (url, opt) => {
    const r = await fetch(url, opt && { method: opt.method || 'POST', headers: { 'Content-Type': 'application/json' }, body: opt.body ? JSON.stringify(opt.body) : undefined });
    const ct = r.headers.get('content-type') || '';
    const j = ct.includes('json') ? await r.json() : { text: await r.text() };
    if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  };
  const say = m => (typeof toast === 'function' ? toast(m) : (typeof addSystem === 'function' ? addSystem(m) : alert(m)));
  const modal = $('settings-modal'), body = $('st-body');
  const TITLES = { general: '通用', appearance: '外观', keybinds: '快捷键', models: '模型与 API', agent: '智能体', skills: '技能包', mcp: 'MCP 服务', env: '求解器环境', about: '关于' };

  // ---- 把旧弹窗里的控件整块搬进来（只搬一次；元素和事件都还是 app.js 的）----
  const moved = {};
  function adopt() {
    if (adopt.done) return; adopt.done = true;
    const mm = $('model-modal');
    if (mm) { moved.models = document.createElement('div'); moved.models.className = 'st-adopt'; const b = mm.querySelector('.py-body'), d = mm.querySelector('details'); if (b) moved.models.append(b); if (d) { d.classList.add('st-vlm'); moved.models.append(d); } }
    const pm = $('py-modal'); if (pm) { moved.py = pm.querySelector('.py-body'); }
    const tm = $('tools-modal'); if (tm) { moved.tools = tm.querySelector('.py-body'); }
  }
  const origModelPicker = $('model-picker') && $('model-picker').onclick;

  // ---- 开关 ----
  let last = 'general';
  async function open(section) {
    adopt();
    modal.style.display = 'flex';
    await show(section || last);
    setTimeout(() => modal.querySelector(`[data-st="${last}"]`)?.focus(), 0);
  }
  function close() { modal.style.display = 'none'; if (typeof MODEL_STATE !== 'undefined' && MODEL_STATE.devicePoll) { clearInterval(MODEL_STATE.devicePoll); MODEL_STATE.devicePoll = null; } }
  async function show(section) {
    last = TITLES[section] ? section : 'general';
    modal.querySelectorAll('[data-st]').forEach(b => b.toggleAttribute('aria-current', b.dataset.st === last));
    $('st-section-title').textContent = TITLES[last];
    body.innerHTML = '';
    try { await RENDER[last](); } catch (e) { body.innerHTML = `<p class="st-err">加载失败：${esc(e.message)}</p>`; }
  }
  modal.querySelectorAll('[data-st]').forEach(b => b.onclick = () => show(b.dataset.st));
  // D4: 设置面板搜索 — 按关键词过滤左侧导航项
  const SECTION_KEYWORDS = {
    general:    '通用 工作区 python 路径 自动 超时 记忆 工具 choicetimeout 推理 网关',
    appearance: '外观 主题 颜色 字体 侧栏 dark light 宽度 检查器 布局',
    keybinds:   '快捷键 键盘 绑定 ctrl alt shift 录制 组合键',
    models:     '模型 api 密钥 key token 接口 openai claude provider 中转 provider 余额',
    agent:      '智能体 自动 工具 审批 步数 预算 python 解释器 mfix foam beta 自动续跑',
    skills:     '技能 skill 技能包 领域 foam lbm mfix general ai 经验',
    mcp:        'mcp 服务 工具 stdio 插件 协议 外部 server',
    env:        '求解器 环境 openfoam mfix lbm 路径 探测 bash wm 安装',
    about:      '关于 版本 信息 作者 cfdriver changelog',
  };
  const stSearch = $('st-search');
  if (stSearch) {
    stSearch.addEventListener('input', () => {
      const q = stSearch.value.toLowerCase().trim();
      const btns = [...modal.querySelectorAll('[data-st]')];
      if (!q) { btns.forEach(b => { b.style.display = ''; b.removeAttribute('data-sq'); }); return; }
      let firstMatch = null;
      btns.forEach(b => {
        const kw = (SECTION_KEYWORDS[b.dataset.st] || b.textContent || '').toLowerCase();
        const hit = kw.includes(q);
        b.style.display = hit ? '' : 'none';
        b.dataset.sq = hit ? '1' : '';
        if (hit && !firstMatch) firstMatch = b;
      });
      // 唯一命中时自动切换
      const hits = btns.filter(b => b.dataset.sq === '1');
      if (hits.length === 1) show(hits[0].dataset.st);
    });
    stSearch.addEventListener('keydown', e => {
      if (e.key === 'Escape') { stSearch.value = ''; stSearch.dispatchEvent(new Event('input')); }
      if (e.key === 'Enter') {
        const hits = [...modal.querySelectorAll('[data-st][data-sq="1"]')];
        if (hits.length) show(hits[0].dataset.st);
      }
    });
  }
  $('settings-close').onclick = close;
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal.style.display !== 'none') { e.stopPropagation(); close(); } }, true);
  $('settings-btn').onclick = () => open('general');
  if ($('model-picker')) $('model-picker').onclick = () => open('models');
  if ($('py-picker')) $('py-picker').onclick = () => open('agent');
  if ($('tools-btn')) $('tools-btn').onclick = () => open('agent');
  window.FX = window.FX || {}; window.FX.prefs = () => open('general'); window.FX.settings = open;
  window.CFDSettings = { open, close };

  const card = (title, inner, extra = '') => `<section class="st-card"${extra}><h3>${title}</h3>${inner}</section>`;
  const row = (label, ctl, hint = '') => `<div class="st-row"><div><div class="st-label">${label}</div>${hint ? `<div class="st-hint">${hint}</div>` : ''}</div><div class="st-ctl">${ctl}</div></div>`;
  const sw = (id, on, label) => `<label class="st-switch"><input type="checkbox" id="${id}"${on ? ' checked' : ''} role="switch" aria-label="${esc(label)}"><span></span></label>`;
  const badge = (ok, yes = '已就绪', no = '未找到') => `<span class="st-badge ${ok ? 'ok' : 'bad'}">${ok ? yes : no}</span>`;

  // ---- 其他模型接口：可以同时登记几家（比如一个 OpenAI 兼容、一个 Claude 中转），任务里随时切换、多模型运行时并排比较 ----
  async function drawProviders() {
    const host = document.createElement('div'); host.id = 'st-provs';
    const old = $('st-provs'); if (old) old.replaceWith(host); else body.appendChild(host);
    let data = { providers: [] };
    try { data = await api('/api/providers'); } catch (e) { /* 离线 */ }
    const items = data.providers.map(p => `<div class="st-prov" data-id="${esc(p.id)}"><div class="st-prov-head"><b>${esc(p.name)}</b><span class="st-hint"><code>${esc(p.baseUrl)}</code> · 密钥 ${p.apiKey ? esc(p.apiKey) : '未填'}</span><span class="grow" style="flex:1"></span>`
      + `<button class="st-btn" data-act="test">测试</button><button class="st-btn" data-act="edit">编辑</button><button class="st-btn" data-act="del">删除</button></div>`
      + `<div class="st-chips">${p.models.map(m => `<span class="st-badge">${esc(m)}</span>`).join('') || '<span class="st-hint">还没登记模型：点「编辑」→「查可用模型」勾选</span>'}</div><div class="st-hint" data-out></div></div>`).join('');
    host.innerHTML = card('其他接口',
      `<p class="st-hint">主接口之外还可以登记几家（例如 Claude 中转、各家云）。登记过的模型会出现在输入框旁的模型按钮里：可以给单个任务换模型，也可以勾选几个模型把同一条指令同时交给它们，做完并排比较。</p>`
      + items + `<div class="st-actions" style="justify-content:flex-start"><button class="st-btn" id="st-prov-add">添加接口</button></div><div id="st-prov-form"></div>`);
    $('st-prov-add').onclick = () => provForm({});
    host.querySelectorAll('.st-prov').forEach(el => {
      const p = data.providers.find(x => x.id === el.dataset.id);
      el.querySelector('[data-act=edit]').onclick = () => provForm(p);
      el.querySelector('[data-act=del]').onclick = async () => { if (!confirm(`删除接口「${p.name}」？用它的任务会改回主模型。`)) return; await fetch('/api/providers/' + p.id, { method: 'DELETE' }); window.MR?.reload(); drawProviders(); };
      el.querySelector('[data-act=test]').onclick = async () => {
        const out = el.querySelector('[data-out]'); out.className = 'st-hint'; out.textContent = '正在发送一条测试请求…';
        try {
   const j = await api(`/api/providers/${p.id}/test`, { body: {} });
          out.className = j.ok ? 'st-ok' : 'st-err';
   out.textContent = j.ok ? `✓ 可用 · ${j.model} · ${j.ms} ms` : `✗ ${j.error}`;
        }
        catch (e) { out.className = 'st-err'; out.textContent = '✗ ' + e.message; }
      };
    });
  }
  function provForm(p) {
    const f = $('st-prov-form');
    f.innerHTML = `<div class="st-prov"><div class="st-prov-head"><b>${p.id ? '编辑' : '添加'}接口</b></div><div class="st-form">`
      + `<label for="pv-name">名字</label><input id="pv-name" class="py-input" placeholder="例如 Claude 中转" value="${esc(p.name || '')}">`
      + `<label for="pv-url">接口地址</label><input id="pv-url" class="py-input" placeholder="https://api.example.com（OpenAI 兼容）" value="${esc(p.baseUrl || '')}">`
      + `<label for="pv-key">API 密钥</label><input id="pv-key" class="py-input" type="password" autocomplete="off" placeholder="${p.apiKey ? '留空不改（' + esc(p.apiKey) + '）' : 'sk-...'}">`
      + `<label>模型</label><div><button class="st-btn" id="pv-disc" type="button">查可用模型</button> <span class="st-hint" id="pv-disc-out"></span><div class="st-chips" id="pv-models"></div>`
      + `<input id="pv-extra" class="py-input" style="margin-top:6px" placeholder="也可以直接填模型名，逗号分隔" value=""></div>`
      + `</div><div class="st-actions"><button class="st-btn" id="pv-cancel">取消</button><button class="st-btn primary" id="pv-save">保存并测试</button></div><div class="st-hint" id="pv-out"></div></div>`;
    const chosen = new Set(p.models || []);
    const drawChips = all => { $('pv-models').innerHTML = [...new Set([...all, ...chosen])].map(m => `<label><input type="checkbox" value="${esc(m)}"${chosen.has(m) ? ' checked' : ''}>${esc(m)}</label>`).join('');
      $('pv-models').querySelectorAll('input').forEach(i => i.onchange = () => i.checked ? chosen.add(i.value) : chosen.delete(i.value)); };
    drawChips([]);
    $('pv-disc').onclick = async () => {
      const o = $('pv-disc-out'); o.textContent = '查询中…';
      try { const j = await api('/api/providers/discover', { body: { id: p.id, baseUrl: $('pv-url').value.trim(), apiKey: $('pv-key').value.trim() } });
        if (!j.ok) { o.textContent = '✗ ' + j.error; return; }
        o.textContent = `找到 ${j.models.length} 个，勾选要用的`; drawChips(j.models);
      } catch (e) { o.textContent = '✗ ' + e.message; }
    };
    $('pv-cancel').onclick = () => { f.innerHTML = ''; };
    $('pv-save').onclick = async () => {
      const extra = $('pv-extra').value.split(/[\s,，、]+/).filter(Boolean);
      const bodyP = { id: p.id, name: $('pv-name').value.trim(), baseUrl: $('pv-url').value.trim(), models: [...chosen, ...extra] };
      const k = $('pv-key').value.trim(); if (k) bodyP.apiKey = k;
      const out = $('pv-out');
      try {
        const j = await api('/api/providers', { body: bodyP });
        out.className = 'st-hint'; out.textContent = '已保存，正在测试…';
 const t = await api(`/api/providers/${j.id}/test`, { body: {} });
 window.MR?.reload();
        if (t.ok) { f.innerHTML = ''; await drawProviders(); say(`接口可用 · ${t.model}`); }
        else { out.className = 'st-err'; out.textContent = '已保存，但测试失败：' + t.error; }
      } catch (e) { out.className = 'st-err'; out.textContent = '✗ ' + e.message; }
    };
    $('pv-name').focus();
  }

  const RENDER = {
    // ---------------- 通用 ----------------
    async general() {
      const p = (typeof prefs !== 'undefined') ? prefs : { theme: 'dark', font: 15, notify: false };
      body.innerHTML =
        card('通知',
          row('桌面通知', sw('st-notify', p.notify, '桌面通知'), '任务完成、求解结束、需要审批时，浏览器在后台会弹系统通知'))
        + card('快捷操作',
          `<p class="st-hint">对话框里输入 <code>/help</code> 看全部命令；<code>Ctrl K</code> 搜索任务；<code>Ctrl Shift P</code> 命令面板；<code>Ctrl+N</code> 新建任务；<code>Ctrl+B</code> 侧栏；<code>Ctrl+I</code> 检查器。</p>`)
        + card('行为',
          row('会话目标续推', sw('st-autoresume', p.autoResume !== false, '步数预算用尽自动续跑'), '智能体用完步数预算后，有未完成待办或运行中求解器时自动继续（建议开启）')
          + row('提问超时', `<input type="number" id="st-choicetimeout" min="5" max="240" value="${p.choiceTimeoutMin ?? 60}" style="width:60px" /> 分钟`, '无人值守时用户长时间不回复，自动按推荐方案继续'));
      $('st-notify').onchange = async e => {
        if (e.target.checked && 'Notification' in window && Notification.permission !== 'granted') {
          const r = await Notification.requestPermission(); if (r !== 'granted') { e.target.checked = false; say('浏览器没有授权通知'); return; }
        }
        p.notify = e.target.checked; savePrefs?.();
      };
      $('st-autoresume').onchange = e => { p.autoResume = e.target.checked; savePrefs?.(); say('自动续跑已' + (e.target.checked ? '开启' : '关闭')); };
      $('st-choicetimeout').onchange = e => { p.choiceTimeoutMin = +e.target.value; savePrefs?.(); say('提问超时已设为 ' + e.target.value + ' 分钟'); };
    },
    // ---------------- 外观 ----------------
    async appearance() {
      const p = (typeof prefs !== 'undefined') ? prefs : { theme: 'dark', font: 15 };
      const inspW = (typeof shellState !== 'undefined' && shellState.inspectorW) || 460;
      body.innerHTML = card('主题',
        row('配色', `<div class="st-seg" role="radiogroup">${[['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']].map(([v, t]) => `<button type="button" role="radio" data-theme="${v}" aria-checked="${p.theme === v}">${t}</button>`).join('')}</div>`, '切换界面配色，立即生效')
        + row('字号', `<input type="range" min="13" max="18" step="1" value="${p.font}" id="st-font" aria-label="字号"><span class="st-hint" id="st-font-v">${p.font}px</span>`, '调整全局字体大小'))
        + card('面板',
          row('检查器宽度', `<div style="display:flex;align-items:center;gap:8px"><input type="range" id="st-insp-w" min="320" max="700" value="${inspW}" style="width:120px" /><span class="st-hint" id="st-insp-w-val" style="min-width:42px">${inspW}px</span></div>`, '检查器面板默认宽度，拖动实时预览'));
      body.querySelectorAll('[data-theme]').forEach(b => b.onclick = () => { p.theme = b.dataset.theme; savePrefs?.(); applyPrefs?.(); body.querySelectorAll('[data-theme]').forEach(x => x.setAttribute('aria-checked', String(x === b))); if (typeof applyTheme === 'function') applyTheme(); });
      const f = $('st-font'); f.oninput = () => { p.font = +f.value; $('st-font-v').textContent = f.value + 'px'; document.documentElement.style.fontSize = f.value + 'px'; savePrefs?.(); };
      const iw = $('st-insp-w'); iw.oninput = () => { $('st-insp-w-val').textContent = iw.value + 'px'; document.documentElement.style.setProperty('--inspector-w', iw.value + 'px'); };
      iw.onchange = () => { if (typeof shellState !== 'undefined') { shellState.inspectorW = +iw.value; if (typeof saveShell === 'function') saveShell(); } };
    },
    // ---------------- 快捷键 ----------------
    keybinds() {
      const defaults = typeof DEFAULT_KEYBINDS !== 'undefined' ? DEFAULT_KEYBINDS : {};
      const custom   = typeof customKeybinds   !== 'undefined' ? customKeybinds   : {};
      const save     = typeof KEYBINDS_KEY     !== 'undefined' ? KEYBINDS_KEY     : 'cfdriver4mto.keybinds';
      function fmtKey(str) {
        return str.split('+').map(s => `<kbd>${esc(s.trim())}</kbd>`).join('<span style="font-size:10px;padding:0 2px;color:var(--faint)">+</span>');
      }
      body.innerHTML = card('快捷键',
        `<p class="st-hint">点击快捷键区域录制新绑定。自定义绑定保存在浏览器本地；重置可还原默认。</p>
        <table class="kb-table">
          <thead><tr><th>动作</th><th>说明</th><th>快捷键</th><th></th></tr></thead>
          <tbody id="kb-tbody"></tbody>
        </table>
        <div style="margin-top:12px"><button class="mini" id="kb-reset-all">全部还原默认</button></div>`);

      const tbody = $('kb-tbody');
      let recording = null; // { id, el }

      function renderRows() {
        tbody.innerHTML = '';
        for (const [id, def] of Object.entries(defaults)) {
          const cur = custom[id] || def.keys;
          const isCustom = !!custom[id] && custom[id] !== def.keys;
          const tr = document.createElement('tr');
          tr.className = 'kb-row';
          tr.innerHTML = `
            <td class="kb-action">${esc(def.label)}${isCustom ? ' <span class="kb-custom-badge">自定义</span>' : ''}</td>
            <td class="kb-desc">${esc(def.desc)}</td>
            <td class="kb-keys" data-id="${esc(id)}">
              <span class="kb-binding">${fmtKey(cur)}</span>
              <span class="kb-recording-hint" style="display:none">按下快捷键…</span>
            </td>
            <td class="kb-acts">
              ${isCustom ? `<button type="button" class="mini kb-restore" data-id="${esc(id)}" title="还原默认">↺</button>` : ''}
            </td>`;
          const keysCell = tr.querySelector('.kb-keys');
          keysCell.onclick = () => startRecording(id, keysCell);
          if (isCustom) {
            tr.querySelector('.kb-restore').onclick = (e) => {
              e.stopPropagation();
              delete custom[id]; persistCustom();
              renderRows();
            };
          }
          tbody.appendChild(tr);
        }
      }

      function startRecording(id, cell) {
        if (recording) stopRecording(false);
        recording = { id, cell };
        cell.classList.add('recording');
        cell.querySelector('.kb-binding').style.display = 'none';
        cell.querySelector('.kb-recording-hint').style.display = '';
        const onKey = (e) => {
          e.preventDefault(); e.stopPropagation();
          if (e.key === 'Escape') { stopRecording(false); return; }
          if (['Control','Shift','Alt','Meta'].includes(e.key)) return;
          const parts = [];
          if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
          if (e.shiftKey) parts.push('Shift');
          if (e.altKey) parts.push('Alt');
          const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
          parts.push(key);
          const str = parts.join('+');
          custom[id] = str; persistCustom();
          stopRecording(true);
        };
        document.addEventListener('keydown', onKey, { capture: true, once: true });
        recording._cleanup = () => document.removeEventListener('keydown', onKey, { capture: true });
      }

      function stopRecording(commit) {
        if (!recording) return;
        const { cell } = recording;
        if (recording._cleanup) recording._cleanup();
        cell.classList.remove('recording');
        cell.querySelector('.kb-recording-hint').style.display = 'none';
        cell.querySelector('.kb-binding').style.display = '';
        recording = null;
        if (commit) renderRows();
      }

      function persistCustom() {
        try { localStorage.setItem(save, JSON.stringify(custom)); } catch {}
        // 同步回 app.js 的 customKeybinds（如果存在）
        if (typeof customKeybinds !== 'undefined') {
          for (const k of Object.keys(customKeybinds)) delete customKeybinds[k];
          Object.assign(customKeybinds, custom);
        }
        say('快捷键已保存');
      }

      $('kb-reset-all').onclick = () => {
        if (!confirm('还原全部快捷键为默认？')) return;
        for (const k of Object.keys(custom)) delete custom[k];
        persistCustom(); renderRows(); say('快捷键已全部还原');
      };

      // 点击外部停止录制
      body.addEventListener('click', (e) => {
        if (recording && !e.target.closest('.kb-keys')) stopRecording(false);
      }, { capture: true });

      renderRows();
    },
    // ---------------- 模型与 API ----------------
    async models() {
      body.innerHTML = `<div id="st-model-status"></div>` + card('连接', '<div id="st-model-host"></div>')
        + `<p class="st-hint">通用 API 兼容 OpenAI 格式（官方、各家云、本地 vLLM / Ollama 都行）；密钥只存在服务器的 settings.json，界面只显示后 4 位。视觉模型不填就沿用主模型。</p>`;
      if (moved.models) $('st-model-host').appendChild(moved.models);
      if (origModelPicker) { await origModelPicker(); $('model-modal').style.display = 'none'; }
      const cfg = await api('/api/config');
      const prov = cfg.provider === 'copilot' ? `GitHub Copilot · ${esc(cfg.copilotModel)}` : (cfg.model ? `${esc(cfg.model)} <span class="st-hint">${esc(cfg.baseUrl)}</span>` : '未配置');
      $('st-model-status').innerHTML = card('当前模型', `<div class="st-now">${prov} ${badge(cfg.provider === 'copilot' ? cfg.copilotLoggedIn : (cfg.hasApiKey || /localhost|127\.0\.0\.1/.test(cfg.baseUrl || '')), '已配置', '缺密钥')}</div>`
        + `<div class="st-actions" style="justify-content:flex-start"><button class="st-btn" id="st-test">测试连接</button><button class="st-btn" id="st-test-v">测试视觉模型</button></div><div id="st-test-out" class="st-hint" aria-live="polite"></div>`);
      const test = async vision => {
        const out = $('st-test-out'); out.className = 'st-hint'; out.textContent = '正在发送一条测试请求…';
        try {
          const j = await api('/api/settings/test', { body: { vision } });
          out.className = j.ok ? 'st-ok' : 'st-err';
          out.textContent = j.ok ? `✓ ${vision ? '视觉模型' : '模型'}可用${j.model ? ' · ' + j.model : ''}${j.ms ? ` · ${j.ms} ms` : ''}${j.note ? ' · ' + j.note : ''}` : `✗ ${j.error}`;
        } catch (e) { out.className = 'st-err'; out.textContent = '✗ ' + e.message; }
      };
      $('st-test').onclick = () => test(false); $('st-test-v').onclick = () => test(true);
      // 多用户网关里：显示「出网助手」状态（服务器所在网络要上网认证，访客可用自己电脑的网络）
      const me = await fetch('/gw/me').then(r => r.ok ? r.json() : null).catch(() => null);
      if (me && me.user) {
        const box = document.createElement('div');
        box.innerHTML = card(`用我电脑的网络 ${me.relay ? badge(true, '助手在线') : '<span class="st-badge">未运行</span>'}`,
          `<p class="st-hint">服务器所在网络需要上网认证，模型接口如果是外网地址可能连不上。在你自己的电脑上运行「出网助手」，服务器上你的 CFDriver 就会通过你电脑的网络访问模型；关掉助手即恢复直连。只替你的账号转发，不会连你电脑上的本机或内网服务。</p>`
   + (me.relay ? row('来自', `<code>${esc(me.relay.host)}</code>`, `已连接 ${Math.round((Date.now() - me.relay.since) / 60000)} 分钟`) : '')
          + `<ol class="st-steps"><li>装 <a href="https://nodejs.org" target="_blank" rel="noopener">Node.js 22+</a>（装过就跳过）</li><li><a class="st-btn" href="/gw/relay.mjs" download>下载出网助手</a>（里面带你的账号凭证，别发给别人）</li><li>在下载目录打开终端：<code>node cfdriver-net-helper.mjs</code>，看到"已连上"后回来点「测试连接」</li></ol>`);
 $('st-model-status').after(box.firstChild);
      }
      // 保存连接后自动测一次，用户马上知道填得对不对
      const save = $('sf-apply');
      if (save && !save.dataset.stTest) { save.dataset.stTest = '1'; save.addEventListener('click', () => setTimeout(async () => { if (last === 'models') { await show('models'); $('st-test')?.click(); } }, 900)); }
      await drawProviders();
    },
    // ---------------- 智能体 ----------------
    async agent() {
      body.innerHTML = card('Python 环境', '<p class="st-hint">后处理、网格检查、优化研究都用这个解释器。一般自动选好，不用改。</p><div id="st-py-host"></div>')
        + card('工具', '<p class="st-hint">勾选的工具会发给模型。读写文件、终端、可视化（post_view）、技能包查阅始终开启；技能包关掉时，对应求解器的工具也一并关掉。</p><div id="st-tools-host"></div>')
        + card('其它', row('图表取点', '<button class="st-btn" id="st-digitize">打开</button>', '从论文图片里手动取数据点，结果交给智能体对比'));
      if (moved.py) $('st-py-host').appendChild(moved.py);
      if (moved.tools) $('st-tools-host').appendChild(moved.tools);
      try { if (typeof loadPyList === 'function') loadPyList(false); } catch {}
      try { if (typeof renderToolsList === 'function') renderToolsList(); } catch {}
      $('st-digitize').onclick = () => { close(); $('digitize-btn')?.click(); };
    },
    // ---------------- 技能包 v0.9 (对标 OpenChamber 技能面板) ----------------
    async skills() {
      const [{ packs }, learned, catalogResp] = await Promise.all([
        api('/api/packs'),
        api('/api/skills').catch(() => ({})),
        api('/api/skills/catalog').catch(() => ({ skills: [] })),
      ]);
      const nLearned = (learned.skills || learned.list || []).length || learned.count || 0;
      const catalog = catalogResp.skills || [];
      const installedIds = new Set(packs.map(p => p.id));
      const modeLabel = m => m === 'auto' ? '自动' : m === 'manual' ? '调用时' : '关闭';

      body.innerHTML = `
<div class="skills-layout">
  <div class="skills-list" id="sk-list">
    <div class="sk-section-label">已安装技能包</div>
    ${packs.map(p => `
      <div class="sk-item${p.enabled ? ' enabled' : ''}" data-id="${esc(p.id)}" data-type="local">
        <span class="sk-dot" data-state="${p.enabled ? 'on' : 'off'}"></span>
        <span class="sk-name">${esc(p.title || p.id)}</span>
      </div>`).join('')}
    <div class="sk-section-label" style="margin-top:10px">在线技能目录</div>
    ${(() => {
      const groups = {};
      for (const c of catalog) {
        const g = c.category || '通用';
        if (!groups[g]) groups[g] = [];
        groups[g].push(c);
      }
      return Object.entries(groups).map(([grp, items]) => `
        <div class="sk-group-label">${esc(grp)}</div>
        ${items.map(c => `
          <div class="sk-item${installedIds.has(c.id) ? ' installed' : ''}" data-id="${esc(c.id)}" data-type="catalog">
            <span class="sk-dot" data-state="${installedIds.has(c.id) ? 'on' : 'off'}"></span>
            <span class="sk-name">${esc(c.title)}</span>
            ${installedIds.has(c.id) ? '<span class="sk-badge installed">已装</span>' : '<span class="sk-badge avail">+</span>'}
          </div>`).join('')}`).join('');
    })()}
    <div class="sk-section-label" style="margin-top:10px">经验沉淀</div>
    <div class="sk-item" data-type="learned">
      <span class="sk-dot" data-state="on"></span>
      <span class="sk-name">${nLearned} 条经验</span>
    </div>
  </div>
  <div class="skills-detail" id="sk-detail">
    <div class="sk-empty muted">← 选择技能查看详情</div>
  </div>
</div>`;

      async function showDetail(item) {
        const det = document.getElementById('sk-detail'); if (!det) return;
        const id = item.dataset.id, type = item.dataset.type;

        if (type === 'learned') {
          det.innerHTML = `<div class="sk-detail-head"><b>经验技能库</b></div>
            <p class="sk-detail-desc" style="color:var(--muted,#888);font-size:12px;line-height:1.6">
              任务跑通、verifier 通过后智能体自动沉淀的做法；同类任务会被检索注入提示词。已沉淀 <b>${nLearned}</b> 条。
            </p>
            <div class="sk-detail-acts"><button class="st-btn" id="sk-open-lib">打开技能库面板</button></div>`;
          document.getElementById('sk-open-lib').onclick = () => { close(); try { setPanelVisible('skills', true); } catch {} };
          return;
        }

        if (type === 'local') {
          const pk = packs.find(p => p.id === id); if (!pk) return;
          const cur = pk.enabled ? (pk.trigger || 'auto') : 'off';
          det.innerHTML = `
<div class="sk-detail-head"><b>${esc(pk.title || pk.id)}</b><span class="sk-badge">官方</span></div>
<div class="sk-detail-section">基础信息</div>
<div class="sk-field"><label>描述</label><p>${esc(pk.description)}</p></div>
<div class="sk-field"><label>智能体使用方式</label>
  <div class="sk-mode-seg" id="sk-mode-${esc(id)}">
    <button type="button" class="${cur==='auto'?'active':''}" data-mode="auto">自动</button>
    <button type="button" class="${cur==='manual'?'active':''}" data-mode="manual">调用时</button>
    <button type="button" class="${cur==='off'?'active':''}" data-mode="off">关闭</button>
  </div>
</div>
<div class="sk-detail-section">说明</div>
<div class="sk-chips">${pk.files.slice(0,10).map(f => `<button type="button" class="st-chip" data-pack="${esc(pk.id)}" data-file="${esc(f)}">${esc(f.replace(/^(reference|templates)\//, ''))}</button>`).join('')}
  <button type="button" class="st-chip" data-pack="${esc(pk.id)}" data-file="">SKILL.md</button>
</div>
<pre class="st-pre" id="sk-file-view" style="margin-top:8px;max-height:220px;overflow:auto" hidden></pre>`;

          document.getElementById('sk-mode-' + id).querySelectorAll('button').forEach(btn => {
            btn.onclick = async () => {
              const mode = btn.dataset.mode;
              const enabled = mode !== 'off';
              try {
                await api('/api/packs/' + encodeURIComponent(id), { body: { enabled, trigger: mode } });
                pk.enabled = enabled; pk.trigger = mode;
                document.getElementById('sk-mode-' + id).querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
                const li = document.getElementById('sk-list').querySelector('[data-id="' + id + '"]');
                if (li) { li.classList.toggle('enabled', enabled); li.querySelector('.sk-dot').dataset.state = enabled ? 'on' : 'off'; }
                say(pk.title + ' 触发模式设为「' + modeLabel(mode) + '」，下一轮对话生效');
              } catch (err) { say('保存失败：' + err.message); }
            };
          });
          det.querySelectorAll('[data-pack]').forEach(b => b.onclick = async () => {
            const v = document.getElementById('sk-file-view');
            try {
              const j = await api('/api/packs/' + encodeURIComponent(b.dataset.pack) + '?file=' + encodeURIComponent(b.dataset.file));
              v.textContent = j.text; v.hidden = false;
            } catch (e) { say(e.message); }
          });
          return;
        }

        if (type === 'catalog') {
          const c = catalog.find(c => c.id === id); if (!c) return;
          const isIn = installedIds.has(id);
          det.innerHTML = `
<div class="sk-detail-head"><b>${esc(c.title)}</b>
  ${isIn ? '<span class="sk-badge installed">已安装</span>' : '<span class="sk-badge avail">在线</span>'}
</div>
<div class="sk-detail-section">基础信息</div>
<div class="sk-field"><label>描述</label><p>${esc(c.description)}</p></div>
<div class="sk-field"><label>默认触发</label><span style="font-size:12px">${modeLabel(c.trigger || 'manual')}</span></div>
<div class="sk-detail-section">说明预览</div>
<pre class="st-pre" style="max-height:200px;overflow:auto;font-size:11px">${esc((c.content || '').slice(0, 2000))}</pre>
<div class="sk-detail-acts" style="margin-top:12px">
  ${isIn
    ? '<button class="st-btn danger" id="sk-uninstall">卸载</button>'
    : '<button class="st-btn primary" id="sk-install">安装</button>'}
</div>`;
          if (isIn) {
            document.getElementById('sk-uninstall').onclick = async () => {
              if (!confirm('卸载技能「' + c.title + '」？')) return;
              try { await api('/api/skills/installed/' + encodeURIComponent(id), { method: 'DELETE' }); say('已卸载：' + c.title); RENDER.skills(); }
              catch (e) { say('卸载失败：' + e.message); }
            };
          } else {
            document.getElementById('sk-install').onclick = async () => {
              const btn = document.getElementById('sk-install'); btn.disabled = true; btn.textContent = '安装中…';
              try { await api('/api/skills/install', { body: { id } }); say('已安装：' + c.title + '，重启后生效'); RENDER.skills(); }
              catch (e) { say('安装失败：' + e.message); btn.disabled = false; btn.textContent = '安装'; }
            };
          }
          return;
        }
      }

      document.getElementById('sk-list').querySelectorAll('.sk-item').forEach(item => {
        item.onclick = () => {
          document.getElementById('sk-list').querySelectorAll('.sk-item').forEach(i => i.classList.remove('active'));
          item.classList.add('active');
          showDetail(item);
        };
      });
      const first = document.getElementById('sk-list').querySelector('.sk-item');
      if (first) { first.classList.add('active'); showDetail(first); }
    },
    // ---------------- MCP ----------------
    async mcp() {
      const { servers } = await api('/api/mcp');
      body.innerHTML = card('已配置的服务', servers.length ? servers.map(s => `<div class="st-mcp">
          <div class="st-mcp-main"><div class="st-pack-title">${esc(s.name)} ${s.enabled ? badge(s.status === 'ready', `就绪 · ${s.tools.length} 个工具`, s.status === 'starting' ? '启动中' : '未就绪') : '<span class="st-badge">已停用</span>'}</div>
          <code class="st-cmd">${esc(s.command)} ${esc(s.args.join(' '))}</code>${s.error ? `<div class="st-err">${esc(s.error)}</div>` : ''}
          ${s.tools.length ? `<details><summary>工具</summary><ul class="st-tools">${s.tools.map(t => `<li><code>${esc(t.name)}</code> ${esc(t.description)}</li>`).join('')}</ul></details>` : ''}</div>
          <div class="st-mcp-acts">${sw('mcp-on-' + s.name, s.enabled, s.name)}<button class="st-btn" data-restart="${esc(s.name)}">重启</button><button class="st-btn danger" data-del="${esc(s.name)}">删除</button></div></div>`).join('')
          : '<p class="st-hint">还没有。MCP 服务的工具会以 <code>mcp__服务名__工具名</code> 的形式交给智能体使用。</p>')
        + card('添加服务（stdio）', `<div class="st-form">
          <label>名字<input id="mcp-name" placeholder="filesystem" autocomplete="off"></label>
          <label>启动命令<input id="mcp-cmd" placeholder="npx" autocomplete="off"></label>
          <label class="wide">参数（空格分隔）<input id="mcp-args" placeholder="-y @modelcontextprotocol/server-filesystem /path" autocomplete="off"></label>
          <label class="wide">环境变量（每行 KEY=VALUE，可空）<textarea id="mcp-env" rows="2" placeholder="API_TOKEN=..."></textarea></label>
          </div><div class="st-actions"><button class="st-btn" id="mcp-example">填入示例：工作区文件服务</button><button class="st-btn primary" id="mcp-add">添加并启动</button></div>`);
      body.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { if (!confirm(`删除 MCP 服务「${b.dataset.del}」？`)) return; await api('/api/mcp/' + encodeURIComponent(b.dataset.del), { method: 'DELETE' }); show('mcp'); });
      body.querySelectorAll('[data-restart]').forEach(b => b.onclick = async () => { b.disabled = true; await api(`/api/mcp/${encodeURIComponent(b.dataset.restart)}/restart`, {}); setTimeout(() => show('mcp'), 2500); });
      for (const s of servers) $('mcp-on-' + s.name).onchange = async e => { await api('/api/mcp', { body: { name: s.name, command: s.command, args: s.args, enabled: e.target.checked } }); setTimeout(() => show('mcp'), 1500); };
      $('mcp-example').onclick = async () => { const ws = (await api('/api/config')).workspace; $('mcp-name').value = 'files'; $('mcp-cmd').value = 'npx'; $('mcp-args').value = `-y @modelcontextprotocol/server-filesystem ${ws}`; };
      $('mcp-add').onclick = async () => {
        const env = Object.fromEntries($('mcp-env').value.split(/\r?\n/).map(l => l.trim()).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
        try { await api('/api/mcp', { body: { name: $('mcp-name').value.trim(), command: $('mcp-cmd').value.trim(), args: $('mcp-args').value.trim(), env } }); say('已添加，正在启动'); setTimeout(() => show('mcp'), 2500); }
        catch (e) { say('添加失败：' + e.message); }
      };
    },
    // ---------------- 求解器环境（只读） ----------------
    async env(refresh) {
      body.innerHTML = '<p class="st-hint">正在探测…</p>';
      const e = await api('/api/env' + (refresh ? '?refresh=1' : ''));
      const f = e.openfoam || {}, py = e.python || {};
      body.innerHTML = `<p class="st-hint">这些都是启动时自动找到的，不需要填写。装了新版本或换了机器，点「重新探测」。</p>`
        + card(`OpenFOAM ${badge(f.found, f.version ? (/^v/.test(f.version) ? f.version : 'v' + f.version) : '已找到')}`, f.found
          ? row('环境脚本', `<code>${esc(f.bashrc)}</code>`) + row('安装目录', `<code>${esc(f.root)}</code>`) + (f.tutorials ? row('教程', `<code>${esc(f.tutorials)}</code>`) : '')
            + row('求解器', (f.solvers || []).map(s => `<span class="st-chip static">${esc(s)}</span>`).join('') || '—') + (f.mpi ? row('MPI', esc(f.mpi)) : '')
            + (f.candidates && f.candidates.length > 1 ? row('其它版本', f.candidates.slice(1).map(c => `<code>${esc(c)}</code>`).join('<br>'), '默认用版本最新的') : '')
          : `<p class="st-hint">没有找到 OpenFOAM。查过：已 source 的环境变量、~/OpenFOAM/OpenFOAM-*、/opt/openfoam*、/usr/lib/openfoam${e.platform === 'win32' ? '（Windows 下在 WSL 里找）' : ''}。安装后点「重新探测」，或直接让智能体帮你装。</p>`)
        + card(`Python ${badge(!!py.version, py.version || '')}`, py.version ? row('解释器', `<code>${esc(py.cmd)}</code>`) + row('已装模块', (py.modules || []).map(m => `<span class="st-chip static">${esc(m)}</span>`).join('')) : '<p class="st-hint">没找到 Python 3。</p>')
        + card('其它求解器', row(`LBM ${badge(e.lbm?.found, '可用', '缺 numpy')}`, '', esc(e.lbm?.note || '')) + row(`MFIX ${badge(e.mfix?.found, '已安装', '未安装')}`, e.mfix?.path ? `<code>${esc(e.mfix.path)}</code>` : '', '没装也不影响 OpenFOAM / LBM'))
        + card('机器', row('平台', esc(e.platform)) + row('CPU 核', esc(e.cores)) + row('内存', esc(e.memGB) + ' GB') + row('工作区', `<code>${esc(e.workspace)}</code>`))
        + `<div class="st-actions"><button class="st-btn primary" id="env-refresh">重新探测</button></div>`;
      $('env-refresh').onclick = () => RENDER.env(true);
    },
    // ---------------- 关于 ----------------
    async about() {
      const cfg = await api('/api/config');
      const me = await fetch('/gw/me').then(r => r.ok ? r.json() : null).catch(() => null);
      body.innerHTML = (me && me.user ? card('账号', row('当前登录', `<b>${esc(me.user)}</b>`, '你的模型 API、算例和对话只有你自己能看到') + row('', '<a class="st-btn" href="/gw/logout">退出登录</a>')) : '')
        + card('CFDriver', row('定位', '面向反应器的 CFD 智能体：前处理、求解、后处理、复现与优化') + row('作者', esc(cfg.author || 'LZF')) + row('平台', esc(cfg.platform)) + row('工作区', `<code>${esc(cfg.workspace)}</code>`))
        + card('相关页面', row('可视化', '<a href="/post" target="_blank" rel="noopener">/post</a>', '结果 + 网格与几何') + row('实时监视', '<a href="/monitor" target="_blank" rel="noopener">/monitor</a>', '求解进度、机器负载、RSI'));
    },
  };
})();
