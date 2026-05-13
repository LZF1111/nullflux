// ============================================================
// NullFlux Digitizer — manual data extraction from plot images
// 类 WebPlotDigitizer 的本地实现（axis-aligned 2D 坐标图）
// 公开 API:
//   window.NFDigitizer.open({ imageUrl?, imageBase64?, name?, hint?, onDone(result) })
//   result = { points: [{x,y}], axisX:{type,p1,p2,v1,v2}, axisY:..., name, savedPath? }
// ============================================================
(function () {
  const $ = (id) => document.getElementById(id);
  let state = null;

  function ensureModal() {
    if ($('digitize-modal')) return;
    const html = `
<div id="digitize-modal" class="dig-modal" style="display:none;">
  <div class="dig-shell">
    <div class="dig-head">
      <div class="dig-title">📍 图表数据手动标注 <span id="dig-hint" class="muted small"></span></div>
      <div class="dig-tools">
        <label class="dig-btn">📁 选图<input type="file" id="dig-file" accept="image/*" style="display:none;" /></label>
        <button class="dig-btn" id="dig-paste" title="从剪贴板粘贴 (Ctrl+V)">📋 粘贴</button>
        <span class="dig-sep"></span>
        <span class="dig-grp">
          X 轴:
          <select id="dig-axis-x"><option value="linear">线性</option><option value="log">对数</option></select>
          Y 轴:
          <select id="dig-axis-y"><option value="linear">线性</option><option value="log">对数</option></select>
        </span>
        <span class="dig-sep"></span>
        <span class="dig-grp" id="dig-mode-group">
          <button class="dig-btn mode" data-mode="cal-x1">①点 X1</button>
          <button class="dig-btn mode" data-mode="cal-x2">②点 X2</button>
          <button class="dig-btn mode" data-mode="cal-y1">③点 Y1</button>
          <button class="dig-btn mode" data-mode="cal-y2">④点 Y2</button>
          <button class="dig-btn mode primary" data-mode="data">⑤ 添加数据点</button>
        </span>
        <span class="dig-sep"></span>
        <button class="dig-btn" id="dig-undo" title="撤销上一个点">↶ 撤销</button>
        <button class="dig-btn" id="dig-clear-data" title="清空所有数据点">🗑 清空数据</button>
        <button class="dig-btn" id="dig-reset" title="清空全部（含校准）">⟲ 重置</button>
        <span class="dig-grow"></span>
        <button class="dig-btn" id="dig-close">✕ 取消</button>
      </div>
    </div>
    <div class="dig-body">
      <div class="dig-canvas-wrap" id="dig-canvas-wrap">
        <canvas id="dig-canvas"></canvas>
        <div id="dig-empty" class="dig-empty">
          <div>拖入图片 / 选图 / Ctrl+V 粘贴<br/>支持 PNG / JPG / 截图</div>
        </div>
      </div>
      <div class="dig-side">
        <div class="dig-section">
          <div class="dig-section-h">校准</div>
          <div class="dig-cal-row"><span class="tag x">X1</span><input id="dig-x1-val" type="number" placeholder="X1 真实值" step="any" /><span id="dig-x1-px" class="px muted">—</span></div>
          <div class="dig-cal-row"><span class="tag x">X2</span><input id="dig-x2-val" type="number" placeholder="X2 真实值" step="any" /><span id="dig-x2-px" class="px muted">—</span></div>
          <div class="dig-cal-row"><span class="tag y">Y1</span><input id="dig-y1-val" type="number" placeholder="Y1 真实值" step="any" /><span id="dig-y1-px" class="px muted">—</span></div>
          <div class="dig-cal-row"><span class="tag y">Y2</span><input id="dig-y2-val" type="number" placeholder="Y2 真实值" step="any" /><span id="dig-y2-px" class="px muted">—</span></div>
          <div class="muted small">先在图上点 4 个已知坐标点（X 轴 2 个 + Y 轴 2 个），再填写它们的真实值。</div>
        </div>
        <div class="dig-section">
          <div class="dig-section-h">数据点 <span id="dig-count" class="muted">(0)</span></div>
          <div id="dig-points" class="dig-points"></div>
        </div>
        <div class="dig-section">
          <div class="dig-section-h">保存</div>
          <input id="dig-name" type="text" placeholder="数据集名称 (默认 plot)" value="plot" />
          <button class="dig-btn primary big" id="dig-save">💾 保存 CSV 并发送到聊天</button>
          <button class="dig-btn" id="dig-save-only">仅保存 CSV</button>
          <div id="dig-status" class="muted small"></div>
        </div>
      </div>
    </div>
  </div>
</div>`;
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    document.body.appendChild(wrap.firstElementChild);
    bind();
  }

  function bind() {
    $('dig-close').onclick = close;
    $('dig-reset').onclick = () => { resetAll(); render(); };
    $('dig-clear-data').onclick = () => { state.data = []; render(); };
    $('dig-undo').onclick = undo;
    $('dig-file').onchange = (e) => { const f = e.target.files[0]; if (f) loadFile(f); };
    $('dig-paste').onclick = pasteFromClipboard;
    $('dig-save').onclick = () => save(true);
    $('dig-save-only').onclick = () => save(false);
    $('dig-axis-x').onchange = (e) => { state.axisXType = e.target.value; };
    $('dig-axis-y').onchange = (e) => { state.axisYType = e.target.value; };
    document.querySelectorAll('#dig-mode-group .mode').forEach(b => {
      b.onclick = () => setMode(b.dataset.mode);
    });
    const canvas = $('dig-canvas');
    canvas.addEventListener('click', onCanvasClick);
    canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); undo(); });
    const wrap = $('dig-canvas-wrap');
    wrap.addEventListener('dragover', (e) => { e.preventDefault(); wrap.classList.add('dragover'); });
    wrap.addEventListener('dragleave', () => wrap.classList.remove('dragover'));
    wrap.addEventListener('drop', (e) => {
      e.preventDefault(); wrap.classList.remove('dragover');
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f && f.type.startsWith('image/')) loadFile(f);
    });
    document.addEventListener('paste', onPaste, true);
    document.addEventListener('keydown', onKey, true);
  }

  function onKey(e) {
    if (!isOpen()) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { undo(); e.preventDefault(); }
  }

  function isOpen() { return $('digitize-modal') && $('digitize-modal').style.display !== 'none'; }

  function open(opts = {}) {
    ensureModal();
    resetAll();
    state.name = opts.name || 'plot';
    $('dig-name').value = state.name;
    $('dig-hint').textContent = opts.hint ? '· ' + opts.hint : '';
    state.onDone = opts.onDone || null;
    state.requestId = opts.requestId || null;
    $('digitize-modal').style.display = 'flex';
    if (opts.imageBase64) loadFromDataUrl('data:image/png;base64,' + opts.imageBase64);
    else if (opts.imageUrl) loadFromUrl(opts.imageUrl);
    render();
  }

  function close() {
    $('digitize-modal').style.display = 'none';
    if (state && state.onDone && state.requestId) {
      // 用户取消时也通知后端，免得 tool call 永远挂着
      try { fetch('/api/digitize/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request_id: state.requestId }) }); } catch {}
    }
  }

  function resetAll() {
    state = {
      img: null, imgUrl: null,
      cal: { x1: null, x2: null, y1: null, y2: null },
      data: [],
      mode: 'cal-x1',
      axisXType: 'linear', axisYType: 'linear',
      name: 'plot', onDone: null, requestId: null
    };
    if ($('dig-axis-x')) $('dig-axis-x').value = 'linear';
    if ($('dig-axis-y')) $('dig-axis-y').value = 'linear';
    ['dig-x1-val','dig-x2-val','dig-y1-val','dig-y2-val'].forEach(id => { if ($(id)) $(id).value = ''; });
  }

  function setMode(m) {
    state.mode = m;
    document.querySelectorAll('#dig-mode-group .mode').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === m);
    });
  }

  function pasteFromClipboard() {
    navigator.clipboard.read().then(items => {
      for (const it of items) {
        for (const type of it.types) {
          if (type.startsWith('image/')) {
            it.getType(type).then(blob => loadFile(blob));
            return;
          }
        }
      }
    }).catch(() => alert('剪贴板读不到图片，请用文件按钮或拖拽。'));
  }

  function onPaste(e) {
    if (!isOpen()) return;
    const items = (e.clipboardData || {}).items;
    if (!items) return;
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) { loadFile(f); e.preventDefault(); return; }
      }
    }
  }

  function loadFile(file) {
    const r = new FileReader();
    r.onload = () => loadFromDataUrl(r.result);
    r.readAsDataURL(file);
  }

  function loadFromUrl(url) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { state.img = img; state.imgUrl = url; render(); };
    img.onerror = () => alert('图片加载失败: ' + url);
    img.src = url;
  }

  function loadFromDataUrl(dataUrl) {
    const img = new Image();
    img.onload = () => { state.img = img; state.imgUrl = dataUrl; render(); };
    img.src = dataUrl;
  }

  function canvasCoords(e) {
    const canvas = $('dig-canvas');
    const r = canvas.getBoundingClientRect();
    const sx = canvas.width / r.width, sy = canvas.height / r.height;
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  }

  function onCanvasClick(e) {
    if (!state.img) return;
    const p = canvasCoords(e);
    if (state.mode === 'cal-x1') { state.cal.x1 = p; setMode('cal-x2'); }
    else if (state.mode === 'cal-x2') { state.cal.x2 = p; setMode('cal-y1'); }
    else if (state.mode === 'cal-y1') { state.cal.y1 = p; setMode('cal-y2'); }
    else if (state.mode === 'cal-y2') { state.cal.y2 = p; setMode('data'); }
    else if (state.mode === 'data') { state.data.push(p); }
    render();
  }

  function undo() {
    if (state.mode === 'data' && state.data.length) { state.data.pop(); }
    else {
      if (state.cal.y2) { state.cal.y2 = null; setMode('cal-y2'); }
      else if (state.cal.y1) { state.cal.y1 = null; setMode('cal-y1'); }
      else if (state.cal.x2) { state.cal.x2 = null; setMode('cal-x2'); }
      else if (state.cal.x1) { state.cal.x1 = null; setMode('cal-x1'); }
    }
    render();
  }

  function pxToData() {
    const { x1, x2, y1, y2 } = state.cal;
    const xv1 = parseFloat($('dig-x1-val').value), xv2 = parseFloat($('dig-x2-val').value);
    const yv1 = parseFloat($('dig-y1-val').value), yv2 = parseFloat($('dig-y2-val').value);
    if (!x1 || !x2 || !y1 || !y2) return null;
    if (!isFinite(xv1) || !isFinite(xv2) || !isFinite(yv1) || !isFinite(yv2)) return null;
    const logX = state.axisXType === 'log';
    const logY = state.axisYType === 'log';
    if (logX && (xv1 <= 0 || xv2 <= 0)) return null;
    if (logY && (yv1 <= 0 || yv2 <= 0)) return null;
    const fwdX = logX ? Math.log10 : (v) => v;
    const fwdY = logY ? Math.log10 : (v) => v;
    const invX = logX ? (v) => Math.pow(10, v) : (v) => v;
    const invY = logY ? (v) => Math.pow(10, v) : (v) => v;
    const ax = (fwdX(xv2) - fwdX(xv1)) / (x2.x - x1.x);
    const ay = (fwdY(yv2) - fwdY(yv1)) / (y2.y - y1.y);
    return (px) => ({
      x: invX(fwdX(xv1) + (px.x - x1.x) * ax),
      y: invY(fwdY(yv1) + (px.y - y1.y) * ay)
    });
  }

  function render() {
    const canvas = $('dig-canvas');
    const empty = $('dig-empty');
    if (!state.img) {
      canvas.width = 600; canvas.height = 400;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      empty.style.display = 'flex';
    } else {
      empty.style.display = 'none';
      canvas.width = state.img.naturalWidth;
      canvas.height = state.img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(state.img, 0, 0);
      const mark = (p, color, label) => {
        if (!p) return;
        ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI * 2); ctx.fill();
        ctx.font = 'bold 14px sans-serif';
        ctx.fillStyle = '#000'; ctx.fillText(label, p.x + 11, p.y + 5);
        ctx.fillStyle = color; ctx.fillText(label, p.x + 10, p.y + 4);
      };
      mark(state.cal.x1, '#ff5b5b', 'X1');
      mark(state.cal.x2, '#ff5b5b', 'X2');
      mark(state.cal.y1, '#3bd4ff', 'Y1');
      mark(state.cal.y2, '#3bd4ff', 'Y2');
      ctx.strokeStyle = '#ffd700'; ctx.fillStyle = '#ffd700';
      state.data.forEach((p, i) => {
        ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
        ctx.strokeStyle = '#ffd700';
        ctx.font = '11px sans-serif'; ctx.fillStyle = '#000';
        ctx.fillText(String(i + 1), p.x + 7, p.y - 5);
        ctx.fillStyle = '#ffd700';
        ctx.fillText(String(i + 1), p.x + 6, p.y - 6);
      });
    }
    $('dig-x1-px').textContent = state.cal.x1 ? `(${state.cal.x1.x.toFixed(0)}, ${state.cal.x1.y.toFixed(0)})` : '—';
    $('dig-x2-px').textContent = state.cal.x2 ? `(${state.cal.x2.x.toFixed(0)}, ${state.cal.x2.y.toFixed(0)})` : '—';
    $('dig-y1-px').textContent = state.cal.y1 ? `(${state.cal.y1.x.toFixed(0)}, ${state.cal.y1.y.toFixed(0)})` : '—';
    $('dig-y2-px').textContent = state.cal.y2 ? `(${state.cal.y2.x.toFixed(0)}, ${state.cal.y2.y.toFixed(0)})` : '—';
    const xf = pxToData();
    const cont = $('dig-points');
    cont.innerHTML = '';
    $('dig-count').textContent = `(${state.data.length})`;
    state.data.forEach((p, i) => {
      const div = document.createElement('div');
      div.className = 'dig-point-row';
      if (xf) {
        const r = xf(p);
        div.innerHTML = `<span class="idx">${i+1}.</span> x=<b>${fmt(r.x)}</b>, y=<b>${fmt(r.y)}</b> <span class="muted small">(${p.x.toFixed(0)},${p.y.toFixed(0)})</span>`;
      } else {
        div.innerHTML = `<span class="idx">${i+1}.</span> <span class="muted">(${p.x.toFixed(0)},${p.y.toFixed(0)}) — 校准未完成</span>`;
      }
      cont.appendChild(div);
    });
  }

  function fmt(v) {
    if (!isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a === 0) return '0';
    if (a < 1e-3 || a >= 1e5) return v.toExponential(3);
    return Number(v.toPrecision(5)).toString();
  }

  async function save(sendToChat) {
    const xf = pxToData();
    if (!xf) { alert('校准未完成（需要 4 个校准点 + 4 个真实值）'); return; }
    if (!state.data.length) { alert('还没有数据点'); return; }
    const points = state.data.map(p => { const r = xf(p); return { x: r.x, y: r.y, px: p.x, py: p.y }; });
    const payload = {
      name: $('dig-name').value || 'plot',
      axis_x: state.axisXType,
      axis_y: state.axisYType,
      calibration: {
        x1: { ...state.cal.x1, value: parseFloat($('dig-x1-val').value) },
        x2: { ...state.cal.x2, value: parseFloat($('dig-x2-val').value) },
        y1: { ...state.cal.y1, value: parseFloat($('dig-y1-val').value) },
        y2: { ...state.cal.y2, value: parseFloat($('dig-y2-val').value) }
      },
      points,
      send_to_chat: !!sendToChat,
      request_id: state.requestId || null,
      image_base64: state.imgUrl && state.imgUrl.startsWith('data:') ? state.imgUrl.split(',')[1] : null
    };
    $('dig-status').textContent = '保存中...';
    try {
      const r = await fetch('/api/digitize/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || '保存失败');
      $('dig-status').innerHTML = `✅ 已保存: <code>${j.path}</code>`;
      if (state.onDone) state.onDone({ ...payload, savedPath: j.path });
      setTimeout(() => close(), 500);
    } catch (e) {
      $('dig-status').textContent = '❌ ' + e.message;
    }
  }

  window.NFDigitizer = { open, close };
})();
