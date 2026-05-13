// V4.5: NullFlux 观测员 —— 黑色小恶魔 · 像素风
//   · 黑色 chibi 身躯 + 白色发光大眼 + 红小角 + 蝙蝠翅 + 箭尾
//   · 无鼠标交互；按 AI 状态/工具种类切换不同表情、道具与特效
//   · agent 运行时进入「心流模式」：打坐莲花座 + 头顶光环
(function () {
  'use strict';

  // ===== 工具种类映射 =====
  const TOOL_CATEGORY = [
    [/^read_|^grep|^search|scholar_|s2_|arxiv|semantic/i, 'research'],   // 戴眼镜看书
    [/^web_|fetch_url|browser/i,                          'web'],         // 放大镜环绕
    [/^image_|vision_|paraview|sim_render/i,              'vision'],      // 扫描 / 镜头
    [/^foam_|^mfix_|^lbm_|cfd/i,                          'fluid'],       // 流体气泡
    [/^run_command|exec|shell/i,                          'terminal'],    // 键盘敲打
    [/^edit_|write_|create_/i,                            'edit'],        // 羽毛笔
    [/^download/i,                                        'download'],
    [/^update_todos|task_complete/i,                      'check'],
    [/^list_dir|glob|^file/i,                             'files'],
  ];
  function toolCategory(tool) {
    if (!tool) return 'gear';
    for (const [re, cat] of TOOL_CATEGORY) if (re.test(tool)) return cat;
    return 'gear';
  }
  const CAT_EMOJI = {
    research: '📖', web: '🔍', vision: '📷', fluid: '💧', terminal: '⌨️',
    edit: '✒️', download: '⬇️', check: '✅', files: '📁', gear: '⚙️',
  };

  function describePhase(phase, detail, tool) {
    if (phase === 'awaiting_user') return detail || '请回复我（人在回路）';
    if (phase === 'llm_thinking')  return detail || '正在思考…';
    if (phase === 'streaming')     return detail || '正在打字回复…';
    if (phase === 'tool_exec')     {
      if (detail) return detail;
      const cat = toolCategory(tool);
      const map = { research:'查阅资料中…', web:'联网搜索中…', vision:'读图扫描中…',
        fluid:'流体计算中…', terminal:'命令执行中…', edit:'编辑文件中…',
        download:'下载中…', check:'核对清单…', files:'整理文件…' };
      return map[cat] || (tool ? '调用 ' + tool : '工具执行中…');
    }
    if (phase === 'tool_done')     return detail || '完成一个步骤 ✓';
    return detail || phase || '待机中';
  }

  // ===== 调色板 =====
  const COL = {
    OL:    '#000000',
    BODY:  '#0e0e16',     // 主体黑（略带蓝紫）
    BODY2: '#1c1c2c',     // 边缘高光
    BODY3: '#2c2c44',     // 反光
    PURP:  '#7a2bff',     // 紫色魔法发光
    HORN:  '#e83a3a', HORN_H:'#ff7a7a', HORN_D:'#7a1414',
    EYE_W: '#ffffff', EYE_G: '#d8f5ff',
    EYE_P: '#0a0a14',
    FANG:  '#ffffff',
    CHEEK: '#ff77aa',
    HALO:  '#fde68a',     // 心流光环金
  };

  const U = 4;
  const W = 56, H = 64;  // 整体画布

  // ===== 像素工具 =====
  function inEll(x, y, cx, cy, rx, ry) {
    const dx = (x - cx) / rx, dy = (y - cy) / ry;
    return dx * dx + dy * dy <= 1;
  }
  function ellR(x, y, cx, cy, rx, ry) {
    const dx = (x - cx) / rx, dy = (y - cy) / ry;
    return dx * dx + dy * dy;
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  // ========= 头部 32×26（圆胖 chibi 头） =========
  // opts: { eyeMode, mouthMode, glasses, blush }
  //   eyeMode: 'normal' | 'closed' | 'sparkle' | 'scan' | 'angry' | 'happy' | 'star' | 'oo'
  //   mouthMode: 'fang' | 'smile' | 'oh' | 'flat'
  function paintHead(x, y, opts) {
    if (x < 0 || x >= 32 || y < 0 || y >= 26) return null;
    const eye = opts.eyeMode || 'normal';
    const mouth = opts.mouthMode || 'fang';
    const glasses = !!opts.glasses;
    let c = null;
    const cx = 16, cy = 14;

    // 头部主体
    if (inEll(x, y, cx, cy, 12, 11)) {
      c = COL.BODY;
      const r = ellR(x, y, cx, cy, 12, 11);
      if (r > 0.86) c = COL.OL;          // 描边
      if (r < 0.18 && x < cx) c = COL.BODY2;
      // 紫色高光小点
      if (x === cx - 6 && y === cy - 4) c = COL.PURP;
    }

    // 红色小角（左、右）
    function drawHorn(baseX, tipY) {
      const lvl = y - tipY;
      if (lvl < 0 || lvl > 5) return;
      const w = Math.min(lvl, 2);
      if (Math.abs(x - baseX) > w) return;
      c = COL.HORN;
      if (x === baseX) c = COL.HORN_H;
      if (Math.abs(x - baseX) === w) c = COL.HORN_D;
      if (lvl === 5) c = COL.HORN_D;
    }
    drawHorn(8,  0);
    drawHorn(23, 0);

    // 耳朵（小尖耳）
    function drawEar(cxE) {
      if (y >= 8 && y <= 12 && Math.abs(x - cxE) <= (12 - y)) {
        c = COL.BODY;
        if (Math.abs(x - cxE) === (12 - y)) c = COL.OL;
      }
    }
    drawEar(3);
    drawEar(28);

    // 大眼睛（白色发光）
    function drawEye(ex1, ex2, ey1, ey2, isLeft) {
      // 闭眼 / sleepy 弧线
      if (eye === 'closed' || (eye === 'happy')) {
        if (y === ey1 + 1 && x >= ex1 && x <= ex2) c = COL.EYE_W;
        if (y === ey1     && (x === ex1 || x === ex2)) c = COL.EYE_W;
        return;
      }
      // 怒（斜线眯眼）
      if (eye === 'angry') {
        const slope = isLeft ? -1 : 1;
        const yy = ey1 + 1 + Math.round((x - (isLeft ? ex1 : ex2)) * slope * 0.5);
        if (yy === y && x >= ex1 && x <= ex2) c = COL.EYE_W;
        return;
      }
      // 正常 / 星星 / 扫描 / 闪烁 / oo
      if (x >= ex1 && x <= ex2 && y >= ey1 && y <= ey2) {
        c = COL.EYE_W;
        // 描边一圈
        if (x === ex1 || x === ex2 || y === ey1 || y === ey2) c = COL.OL;
        // 内白
        if (x > ex1 && x < ex2 && y > ey1 && y < ey2) c = COL.EYE_W;
        // 瞳孔（中央黑点）
        const px = ex1 + Math.floor((ex2 - ex1) / 2);
        const py = ey1 + Math.floor((ey2 - ey1) / 2);
        if (eye === 'normal') {
          if (x === px && y === py) c = COL.EYE_P;
        } else if (eye === 'star') {
          // 十字星
          if ((x === px && y >= py - 1 && y <= py + 1) ||
              (y === py && x >= px - 1 && x <= px + 1)) c = COL.HORN;
        } else if (eye === 'sparkle') {
          // 内边白 + 角落黑点
          if (x === ex1 + 1 && y === ey2 - 1) c = COL.EYE_P;
        } else if (eye === 'scan') {
          // 横向扫描线（由外部时间决定 yy）
          const yy = ey1 + 1 + ((opts.scanLine || 0) % (ey2 - ey1 - 1));
          if (y === yy && x > ex1 && x < ex2) c = COL.PURP;
        } else if (eye === 'oo') {
          // 大瞳
          if (x >= px - 1 && x <= px + 1 && y >= py - 1 && y <= py + 1) c = COL.EYE_P;
        }
        // 高光小点
        if (x === ex1 + 1 && y === ey1 + 1 && eye !== 'closed') c = COL.EYE_W;
      }
    }
    drawEye(9, 13, 11, 16, true);
    drawEye(18, 22, 11, 16, false);

    // 圆框眼镜（研究模式）
    if (glasses) {
      // 左圈
      function ring(cxE, cyE, r) {
        const d = Math.hypot(x - cxE, y - cyE);
        if (d >= r - 0.55 && d <= r + 0.55) c = COL.OL;
      }
      ring(11, 13, 3.6);
      ring(20, 13, 3.6);
      // 鼻梁
      if (y === 13 && (x === 15 || x === 16)) c = COL.OL;
      // 反光
      if ((x === 9 && y === 11) || (x === 18 && y === 11)) c = COL.EYE_G;
    }

    // 腮红
    if (opts.blush) {
      if ((y === 17 || y === 18) && (x === 7 || x === 8)) c = COL.CHEEK;
      if ((y === 17 || y === 18) && (x === 24 || x === 25)) c = COL.CHEEK;
    }

    // 嘴
    if (mouth === 'fang') {
      if (y === 19 && (x === 15 || x === 16)) c = COL.OL;
      if (y === 20 && x === 16) c = COL.FANG;       // 小尖牙
    } else if (mouth === 'smile') {
      if (y === 19 && x >= 14 && x <= 17) c = COL.OL;
      if (y === 20 && (x === 15 || x === 16)) c = COL.OL;
    } else if (mouth === 'oh') {
      if (y === 19 && (x === 15 || x === 16)) c = COL.OL;
      if (y === 20 && (x === 15 || x === 16)) c = COL.OL;
    } else if (mouth === 'flat') {
      if (y === 19 && x >= 14 && x <= 17) c = COL.OL;
    }

    return c;
  }

  // ========= 身体 22×16 圆胖小肚子 =========
  function paintBody(x, y) {
    if (x < 0 || x >= 22 || y < 0 || y >= 16) return null;
    let c = null;
    if (inEll(x, y, 11, 7, 10, 7.5)) {
      c = COL.BODY;
      const r = ellR(x, y, 11, 7, 10, 7.5);
      if (r > 0.86) c = COL.OL;
      // 小肚皮亮色（略灰）
      if (inEll(x, y, 11, 9, 5, 4.5)) c = COL.BODY3;
    }
    return c;
  }

  // ========= 手臂 6×10 =========
  function paintArm(x, y) {
    if (x < 0 || x >= 6 || y < 0 || y >= 10) return null;
    if (inEll(x, y, 3, 5, 2.5, 4.5)) {
      if (ellR(x, y, 3, 5, 2.5, 4.5) > 0.86) return COL.OL;
      return COL.BODY;
    }
    return null;
  }

  // ========= 腿/脚 6×8 =========
  function paintLeg(x, y) {
    if (x < 0 || x >= 6 || y < 0 || y >= 8) return null;
    if (inEll(x, y, 3, 4, 2.5, 3.5)) {
      if (ellR(x, y, 3, 4, 2.5, 3.5) > 0.86) return COL.OL;
      return COL.BODY;
    }
    return null;
  }

  // ========= 翅膀 14×12 蝙蝠翼 =========
  function paintWing(x, y, mirror) {
    if (x < 0 || x >= 14 || y < 0 || y >= 12) return null;
    const xx = mirror ? 13 - x : x;
    // 三层扇形：右侧靠近身体，左侧外缘
    let inside = false;
    if (y >= 0 && y <= 11) {
      const limit = 13 - Math.floor(y * 0.6);
      if (xx >= 13 - limit && xx <= 13) inside = true;
    }
    if (!inside) return null;
    let c = COL.BODY2;
    if (x === 0 || y === 11) c = COL.OL;
    // 翼骨缝隙 (3 段 V)
    if ((y === 4 && xx === 6) || (y === 7 && xx === 9) || (y === 10 && xx === 11)) c = COL.OL;
    return c;
  }

  // ========= 尾巴 8×20 (S 形 + 箭尖) =========
  function paintTail(x, y) {
    if (x < 0 || x >= 8 || y < 0 || y >= 20) return null;
    let c = null;
    // S 形路径中心：x = 4 + 3*sin(y/4)
    const cxRow = 4 + 3 * Math.sin(y / 3);
    if (Math.abs(x - cxRow) <= 1) c = COL.BODY;
    if (Math.abs(x - cxRow) === 1) c = COL.OL;
    // 箭头（最后 4 行）
    if (y >= 16) {
      const aw = 19 - y;
      const acx = 4 + 3 * Math.sin(16 / 3);
      if (Math.abs(x - acx) <= aw) c = COL.HORN;
      if (Math.abs(x - acx) === aw) c = COL.HORN_D;
    }
    return c;
  }

  // ========= 心流光环 32×8 =========
  function paintHalo(x, y) {
    if (x < 0 || x >= 32 || y < 0 || y >= 8) return null;
    // 椭圆环
    const r1 = ellR(x, y, 16, 4, 14, 3);
    if (r1 >= 0.85 && r1 <= 1.0) return COL.HALO;
    return null;
  }

  function gridSvg(w, h, paint) {
    let s = '';
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const c = paint(x, y);
      if (c) s += `<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${c}"/>`;
    }
    return s;
  }

  // 渲染整个 sprite —— 各部位独立 <g> 便于动画
  function renderSpriteSvg(opts) {
    const o = opts || {};
    const head = `<g class="lay-head" transform="translate(${(W-32)/2} 4)">${gridSvg(32, 26, (x,y)=>paintHead(x,y,o))}</g>`;
    const body = `<g class="lay-body" transform="translate(${(W-22)/2} 26)">${gridSvg(22, 16, paintBody)}</g>`;
    const armL = `<g class="lay-arm-l" transform="translate(${(W-22)/2 - 3} 28)" style="transform-origin:3px 1px;">${gridSvg(6, 10, paintArm)}</g>`;
    const armR = `<g class="lay-arm-r" transform="translate(${(W-22)/2 + 19} 28)" style="transform-origin:3px 1px;">${gridSvg(6, 10, paintArm)}</g>`;
    const legL = `<g class="lay-leg-l" transform="translate(${(W-22)/2 + 4} 40)" style="transform-origin:3px 1px;">${gridSvg(6, 8, paintLeg)}</g>`;
    const legR = `<g class="lay-leg-r" transform="translate(${(W-22)/2 + 12} 40)" style="transform-origin:3px 1px;">${gridSvg(6, 8, paintLeg)}</g>`;
    const wingL = `<g class="lay-wing-l" transform="translate(0 22)" style="transform-origin:13px 1px;">${gridSvg(14, 12, (x,y)=>paintWing(x,y,true))}</g>`;
    const wingR = `<g class="lay-wing-r" transform="translate(${W-14} 22)" style="transform-origin:1px 1px;">${gridSvg(14, 12, (x,y)=>paintWing(x,y,false))}</g>`;
    const tail = `<g class="lay-tail" transform="translate(${W-12} 36)" style="transform-origin:4px 0;">${gridSvg(8, 20, paintTail)}</g>`;
    const halo = `<g class="lay-halo" transform="translate(${(W-32)/2} -2)">${gridSvg(32, 8, paintHalo)}</g>`;
    return `<svg class="nf-sprite" xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 ${W} ${H}" width="${W*U}" height="${H*U}"
      preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges">
      ${halo}${wingL}${wingR}${tail}${legL}${legR}${body}${armL}${armR}${head}
    </svg>`;
  }

  // ======== 样式 ========
  const NF_STYLE = `
    .scholar-stage { position: relative; display:flex; align-items:center; justify-content:center; overflow:visible; }
    .scholar-stage::after { content:''; position:absolute; inset:0; pointer-events:none;
      background: repeating-linear-gradient(180deg, rgba(255,255,255,.04) 0 1px, transparent 1px 3px);
      mix-blend-mode: overlay; }
    .nf-sprite { image-rendering: pixelated; filter: drop-shadow(0 6px 14px rgba(122,43,255,.55));
      transition: filter .35s; }

    /* 基础呼吸 / 漂浮 */
    .nf-sprite { animation: nf-float 3.2s ease-in-out infinite; transform-origin:50% 90%; }
    @keyframes nf-float { 0%,100%{transform:translateY(0);} 50%{transform:translateY(-3px);} }

    /* 翅膀缓拍 */
    .lay-wing-l { animation: nf-wing-l 1.8s ease-in-out infinite; }
    .lay-wing-r { animation: nf-wing-r 1.8s ease-in-out infinite; }
    @keyframes nf-wing-l { 0%,100%{transform:translate(0,22px) rotate(0);} 50%{transform:translate(2px,22px) rotate(14deg);} }
    @keyframes nf-wing-r { 0%,100%{transform:translate(${W-14}px,22px) rotate(0);} 50%{transform:translate(${W-14-2}px,22px) rotate(-14deg);} }

    /* 尾巴左右扭 */
    .lay-tail { animation: nf-tail 3.8s ease-in-out infinite; }
    @keyframes nf-tail {
      0%,100%{transform:translate(${W-12}px,36px) rotate(-8deg);}
      50%    {transform:translate(${W-12}px,36px) rotate(10deg);}
    }

    /* 光环隐藏；心流模式开启 */
    .lay-halo { opacity:0; transform: translate(${(W-32)/2}px, -2px); }
    .scholar-wrap.flow .lay-halo { opacity:1; animation: nf-halo 6s linear infinite; }
    @keyframes nf-halo {
      0%   { transform: translate(${(W-32)/2}px, -2px) rotate(0deg); }
      100% { transform: translate(${(W-32)/2}px, -2px) rotate(360deg); }
    }
    .scholar-wrap.flow .nf-sprite { filter: drop-shadow(0 0 16px rgba(253,230,138,.55)) drop-shadow(0 6px 14px rgba(122,43,255,.45)); }

    /* 打坐：腿盘起 + 翅膀缓慢 + 身体上浮 */
    .scholar-wrap.lotus .lay-leg-l { transform: translate(${(W-22)/2 + 2}px, 38px) rotate(70deg) !important; animation:none !important; }
    .scholar-wrap.lotus .lay-leg-r { transform: translate(${(W-22)/2 + 14}px, 38px) rotate(-70deg) !important; animation:none !important; }
    .scholar-wrap.lotus .lay-arm-l { transform: translate(${(W-22)/2 - 1}px, 33px) rotate(35deg) !important; animation:none !important; }
    .scholar-wrap.lotus .lay-arm-r { transform: translate(${(W-22)/2 + 17}px, 33px) rotate(-35deg) !important; animation:none !important; }
    .scholar-wrap.lotus .lay-wing-l { animation: nf-wing-l 4.5s ease-in-out infinite !important; }
    .scholar-wrap.lotus .lay-wing-r { animation: nf-wing-r 4.5s ease-in-out infinite !important; }
    .scholar-wrap.lotus .nf-sprite  { animation: nf-float-deep 4.8s ease-in-out infinite !important; }
    @keyframes nf-float-deep { 0%,100%{transform:translateY(-2px);} 50%{transform:translateY(-8px);} }

    /* === 状态 === */
    .scholar-wrap.state-thinking .nf-sprite { filter: drop-shadow(0 4px 12px rgba(245,158,11,.75)); }
    .scholar-wrap.state-thinking .lay-head  { animation: nf-think-head 2.6s ease-in-out infinite; }
    @keyframes nf-think-head {
      0%,100%{ transform: translate(${(W-32)/2}px,4px) rotate(-7deg); }
      50%    { transform: translate(${(W-32)/2}px,3px) rotate(-4deg); }
    }

    .scholar-wrap.state-streaming .nf-sprite { filter: drop-shadow(0 4px 14px rgba(168,85,247,.8)); }
    .scholar-wrap.state-streaming .lay-arm-l { animation: nf-type-l .28s steps(2) infinite; }
    .scholar-wrap.state-streaming .lay-arm-r { animation: nf-type-r .28s steps(2) infinite; }
    @keyframes nf-type-l { 0%{transform:translate(${(W-22)/2 - 3}px,34px) rotate(78deg);} 100%{transform:translate(${(W-22)/2 - 3}px,35px) rotate(84deg);} }
    @keyframes nf-type-r { 0%{transform:translate(${(W-22)/2 + 19}px,34px) rotate(-78deg);} 100%{transform:translate(${(W-22)/2 + 19}px,35px) rotate(-84deg);} }

    .scholar-wrap.state-tool .nf-sprite { filter: drop-shadow(0 4px 14px rgba(20,184,166,.85)); }

    .scholar-wrap.state-await .nf-sprite { animation: nf-heart .85s ease-in-out infinite;
      filter: drop-shadow(0 0 18px rgba(239,68,68,.9)); }
    @keyframes nf-heart { 0%,100%{transform:scale(1);} 50%{transform:scale(1.08);} }
    .scholar-wrap.state-await .lay-arm-r { animation: nf-wave .5s ease-in-out infinite; }
    @keyframes nf-wave {
      0%,100%{ transform: translate(${(W-22)/2 + 19}px,18px) rotate(-160deg); }
      50%    { transform: translate(${(W-22)/2 + 19}px,18px) rotate(-200deg); }
    }

    .scholar-wrap.state-done .nf-sprite { animation: nf-hop .7s ease-out; }
    @keyframes nf-hop { 0%{transform:translateY(0) scale(1);} 40%{transform:translateY(-16px) scale(1.06,.94);} 100%{transform:translateY(0) scale(1);} }

    /* === 工具道具浮窗 === */
    .nf-prop {
      position: absolute; pointer-events:none;
      font-size: 22px; filter: drop-shadow(0 2px 4px rgba(0,0,0,.6));
    }
    .nf-prop.prop-research { right: 14%; top: 36%; animation: prop-bob 2.4s ease-in-out infinite; }
    .nf-prop.prop-web      { right: 8%;  top: 22%; animation: prop-orbit 2.4s linear infinite; }
    .nf-prop.prop-vision   { right: 12%; top: 28%; animation: prop-flash 1.2s ease-in-out infinite; }
    .nf-prop.prop-fluid    { right: 12%; top: 20%; animation: prop-drop 1.6s ease-in infinite; }
    .nf-prop.prop-terminal { right: 14%; top: 50%; animation: prop-bob .3s ease-in-out infinite; }
    .nf-prop.prop-edit     { right: 12%; top: 28%; animation: prop-scribble 1.3s ease-in-out infinite; }
    .nf-prop.prop-download { right: 14%; top: 18%; animation: prop-down 1.2s ease-in infinite; }
    .nf-prop.prop-check    { right: 14%; top: 30%; animation: prop-bob 1.4s ease-out; }
    .nf-prop.prop-files    { right: 12%; top: 38%; animation: prop-bob 2.2s ease-in-out infinite; }
    .nf-prop.prop-gear     { right: 12%; top: 30%; animation: prop-spin 1.8s linear infinite; }
    .nf-prop.prop-flow     { left: 50%; bottom: 24%; transform: translateX(-50%); animation: prop-bob 3s ease-in-out infinite; font-size: 26px; }
    .nf-prop.prop-think    { left: 64%; top: 6%; font-size: 16px; animation: prop-think 2.4s ease-in-out infinite; }
    .nf-prop.prop-await    { left: 60%; top: 4%; font-size: 20px; color:#ef4444; animation: prop-pulse .8s ease-in-out infinite; }
    .nf-prop.prop-done     { left: 50%; top: 8%; transform: translateX(-50%); font-size: 22px; animation: prop-pop .9s ease-out forwards; }

    @keyframes prop-bob { 0%,100%{transform:translateY(0);} 50%{transform:translateY(-5px);} }
    @keyframes prop-spin { 100%{transform:rotate(360deg);} }
    @keyframes prop-flash { 0%,100%{opacity:1; transform:scale(1);} 50%{opacity:.5; transform:scale(1.2);} }
    @keyframes prop-drop { 0%{transform:translateY(-10px); opacity:0;} 30%{opacity:1;} 100%{transform:translateY(28px); opacity:0;} }
    @keyframes prop-scribble { 0%,100%{transform:rotate(-12deg);} 50%{transform:rotate(12deg);} }
    @keyframes prop-down { 0%{transform:translateY(-14px); opacity:0;} 30%{opacity:1;} 100%{transform:translateY(20px); opacity:0;} }
    @keyframes prop-orbit { 0%{transform:translate(0,0) rotate(0);} 100%{transform:translate(0,0) rotate(360deg);} }
    @keyframes prop-think { 0%,100%{transform:translateY(0); opacity:.7;} 50%{transform:translateY(-6px); opacity:1;} }
    @keyframes prop-pulse { 0%,100%{transform:scale(1); opacity:1;} 50%{transform:scale(1.4); opacity:.6;} }
    @keyframes prop-pop { 0%{transform:translateX(-50%) scale(0);} 50%{transform:translateX(-50%) scale(1.3);} 100%{transform:translateX(-50%) scale(1); opacity:0;} }
  `;

  function injectStyle() {
    if (document.getElementById('nf-sprite-style')) return;
    const s = document.createElement('style');
    s.id = 'nf-sprite-style';
    s.textContent = NF_STYLE;
    document.head.appendChild(s);
  }

  // ===== 主对象 =====
  const NFScholar = {
    _state: 'idle',
    _tool: '',
    _agentBusy: false,
    _scanLine: 0,
    _flowTimer: 0,

    init() {
      const host = document.getElementById('scholar-body');
      if (!host) return;
      injectStyle();
      host.innerHTML = `
        <div class="scholar-wrap" id="scholar-wrap">
          <div class="scholar-stage" id="scholar-stage">
            <div class="scholar-tool-icon" id="scholar-icon" style="display:none;"></div>
            <div id="scholar-svg-host">${this._renderSvg()}</div>
            <div class="nf-prop-layer" id="nf-prop-layer"></div>
          </div>
          <div class="scholar-bubble" id="scholar-bubble">嘿嘿～小恶魔观测员就位。</div>
          <div class="scholar-meta" id="scholar-meta">phase: idle</div>
        </div>
      `;
      this.setState('idle', '待机中', '');
      // 扫描线动画驱动（vision 状态会用到）
      setInterval(() => {
        this._scanLine = (this._scanLine + 1) % 4;
        if (this._state === 'tool_exec' && toolCategory(this._tool) === 'vision') {
          this._redrawSvg();
        }
      }, 220);
    },

    _opts() {
      const cat = toolCategory(this._tool);
      const o = { eyeMode:'normal', mouthMode:'fang', glasses:false, blush:true, scanLine:this._scanLine };
      switch (this._state) {
        case 'llm_thinking': o.eyeMode='closed';   o.mouthMode='flat'; break;
        case 'streaming':    o.eyeMode='happy';    o.mouthMode='smile'; break;
        case 'tool_exec':
          if (cat === 'research') { o.eyeMode='normal'; o.glasses=true; o.mouthMode='flat'; }
          else if (cat === 'vision') { o.eyeMode='scan'; o.mouthMode='oh'; }
          else if (cat === 'web') { o.eyeMode='normal'; o.glasses=true; o.mouthMode='oh'; }
          else if (cat === 'fluid') { o.eyeMode='sparkle'; o.mouthMode='oh'; }
          else if (cat === 'terminal') { o.eyeMode='normal'; o.mouthMode='flat'; }
          else if (cat === 'edit') { o.eyeMode='normal'; o.mouthMode='smile'; }
          else if (cat === 'check') { o.eyeMode='happy'; o.mouthMode='smile'; }
          else { o.eyeMode='normal'; o.mouthMode='fang'; }
          break;
        case 'tool_done':    o.eyeMode='star';     o.mouthMode='smile'; break;
        case 'awaiting_user':o.eyeMode='oo';       o.mouthMode='oh'; break;
        default:             o.eyeMode='normal';   o.mouthMode='fang'; break;
      }
      return o;
    },

    _renderSvg() { return renderSpriteSvg(this._opts()); },
    _redrawSvg() {
      const host = document.getElementById('scholar-svg-host');
      if (host) host.innerHTML = this._renderSvg();
    },

    _renderProps() {
      const layer = document.getElementById('nf-prop-layer');
      if (!layer) return;
      let html = '';
      // 心流（agent 运行中）始终显示莲花座
      if (this._agentBusy) {
        html += `<div class="nf-prop prop-flow">🪷</div>`;
      }
      // 按状态/工具放道具
      if (this._state === 'llm_thinking') {
        html += `<div class="nf-prop prop-think">💭</div>`;
      } else if (this._state === 'awaiting_user') {
        html += `<div class="nf-prop prop-await">❗</div>`;
      } else if (this._state === 'tool_done') {
        html += `<div class="nf-prop prop-done">✨</div>`;
      } else if (this._state === 'tool_exec') {
        const cat = toolCategory(this._tool);
        const emo = CAT_EMOJI[cat] || '⚙️';
        html += `<div class="nf-prop prop-${cat}">${emo}</div>`;
        // 流体多滴
        if (cat === 'fluid') {
          html += `<div class="nf-prop prop-fluid" style="right:22%; animation-delay:.5s;">💧</div>`;
          html += `<div class="nf-prop prop-fluid" style="right:6%;  animation-delay:1s;">💧</div>`;
        }
      }
      layer.innerHTML = html;
    },

    _setFlow(on) {
      const wrap = document.getElementById('scholar-wrap');
      if (!wrap) return;
      if (on) wrap.classList.add('flow', 'lotus');
      else    wrap.classList.remove('flow', 'lotus');
    },

    setState(phase, detail, tool) {
      this._state = phase;
      this._tool = tool || '';
      const wrap = document.getElementById('scholar-wrap');
      if (!wrap) return;
      wrap.classList.remove('state-thinking','state-streaming','state-tool','state-await','state-idle','state-done');
      const cls = {
        llm_thinking: 'state-thinking',
        streaming:    'state-streaming',
        tool_exec:    'state-tool',
        tool_done:    'state-done',
        awaiting_user:'state-await',
        idle:         'state-idle',
      }[phase] || 'state-idle';
      wrap.classList.add(cls);

      this._redrawSvg();
      this._renderProps();

      const bubble = document.getElementById('scholar-bubble');
      if (bubble) bubble.textContent = describePhase(phase, detail, tool);
      const meta = document.getElementById('scholar-meta');
      if (meta) meta.textContent = `phase: ${phase}` + (tool ? ` · tool: ${tool}` : '');

      // 顶部小图标徽章保留
      const ico = document.getElementById('scholar-icon');
      if (ico) {
        if (phase === 'tool_exec' && tool) { ico.textContent = CAT_EMOJI[toolCategory(tool)] || '🔧'; ico.style.display='flex'; }
        else if (phase === 'awaiting_user') { ico.textContent = '✋'; ico.style.display='flex'; }
        else if (phase === 'llm_thinking')  { ico.textContent = '💭'; ico.style.display='flex'; }
        else if (phase === 'streaming')     { ico.textContent = '✍️'; ico.style.display='flex'; }
        else ico.style.display='none';
      }
    },
    onPhase(phase, detail, tool) { this.setState(phase, detail || '', tool || ''); },
    onAgentStart() {
      this._agentBusy = true;
      this._setFlow(true);
      this.setState('llm_thinking', '心流启动…', '');
    },
    onAgentEnd() {
      this._agentBusy = false;
      this._setFlow(false);
      this.setState('idle', '任务结束 · 待机中', '');
    },
  };

  window.NFScholar = NFScholar;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => NFScholar.init());
  } else {
    NFScholar.init();
  }
  window.addEventListener('dscm-msg', (ev) => {
    const m = ev.detail || {};
    if (m.type === 'agent_start') NFScholar.onAgentStart();
    else if (m.type === 'agent_end') NFScholar.onAgentEnd();
  });
})();
