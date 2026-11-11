#!/usr/bin/env python3
"""T4/T4b 网格无关性 A/B 展示视频（1920×1080，30 fps，约 75 s）。
数字全部来自录制与判定：meta.json、samples.jsonl（30 s 采样）、events.jsonl、judge.json、agent_wall.py 的统一口径。
6 对全部入片（T4 三对 + T4b 三对），不挑选。
分镜：标题 → 任务 → 6 对同步回放（各自从开跑计时）→ 网格无关性曲线 → 关键指标 → 逐对明细 → 总结。
用法: make_t4_showcase.py RUNS_DIR OUT.mp4"""
import json, math, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont
import imageio.v2 as imageio

W, H, FPS = 1920, 1080, 30
BG0, BG1 = (8, 10, 16), (16, 21, 34)
FG, MUT, DIM, LINE = (238, 241, 246), (150, 158, 175), (84, 92, 110), (40, 46, 60)
CFD, CFD_D = (45, 212, 191), (19, 84, 80)
OC, OC_D = (165, 175, 195), (60, 66, 82)
GOLD, BAD, GOOD, TRACK = (250, 204, 21), (248, 113, 113), (74, 222, 128), (24, 28, 40)
MESHES = ['30x100', '60x200', '120x400']
REF = {'30x100': 5276, '60x200': 5291, '120x400': 5269}   # 开跑前的校准算例（T4_PROTOCOL.md）
BAND = (5134, 5674)                                        # 判定带
# agent_wall.py 统一口径（智能体从收到任务到交结果的墙钟秒数、总 token）
AGENT = {
    'T4-cfd-1': (2636, 1194495), 'T4-cfd-2': (2046, 591458), 'T4-cfd-3': (2821, 1204738),
    'T4-oc-1': (2283, 173459), 'T4-oc-2': (3314, 383905), 'T4-oc-3': (10832, 783456),
    'T4b-cfd-1': (3610, 967237), 'T4b-cfd-2': (3903, 604971), 'T4b-cfd-3': (3061, 1030309),
    'T4b-oc-1': (5014, 338633), 'T4b-oc-2': (9811, 565982), 'T4b-oc-3': (4406, 776681),
}
OVERALL = dict(cfd=(12, 12), oc=(9, 12))   # T2、T3b、T4、T4b 四轮各 3 对（各协议文件里的判定）
FAIL_NOTE = {'T4-oc-1': 'pgrep 等待死循环，未交结果', 'T4-oc-2': '照搬 RAS 教程，Δp 低于判定带'}

_fc = {}


def F(sz, b=False):
    if (sz, b) not in _fc:
        names = (['C:/Windows/Fonts/msyhbd.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'] if b else
                 ['C:/Windows/Fonts/msyh.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'])
        _fc[(sz, b)] = next((ImageFont.truetype(f, sz) for f in names if os.path.exists(f)), ImageFont.load_default())
    return _fc[(sz, b)]


def clamp(x, a=0.0, b=1.0): return max(a, min(b, x))
def ease(x): x = clamp(x); return 1 - (1 - x) ** 3
def mix(c, a, base=BG0): a = clamp(a); return tuple(int(base[i] * (1 - a) + c[i] * a) for i in range(3))
def hms(s): s = int(s); return f'{s // 3600:d}:{s % 3600 // 60:02d}:{s % 60:02d}'
def mins(s): return f'{s / 60:.0f} 分钟'
def T(d, xy, s, sz, fill=FG, b=False, anchor='la'): d.text(xy, s, font=F(sz, b), fill=fill, anchor=anchor)


def mark(d, x, y, ok, sz, col):
    """雅黑没有 ✓✗ 字形：直接画。(x, y) 为左边中点，返回占用宽度"""
    s = sz * 0.36; w = max(3, sz // 8); cx = x + s
    if ok: d.line([(cx - s, y), (cx - s * 0.3, y + s * 0.7), (cx + s, y - s * 0.75)], fill=col, width=w, joint='curve')
    else:
        d.line([(cx - s * 0.75, y - s * 0.75), (cx + s * 0.75, y + s * 0.75)], fill=col, width=w)
        d.line([(cx - s * 0.75, y + s * 0.75), (cx + s * 0.75, y - s * 0.75)], fill=col, width=w)
    return int(2 * s + sz * 0.3)


def TM(d, x, y, ok, s, sz, col, b=True):
    """前面带 ✓/✗ 的文字，y 为竖直中线"""
    T(d, (x + mark(d, x, y, ok, sz, col), y), s, sz, col, b, 'lm')


def make_bg():
    y = np.linspace(0, 1, H)[:, None]; x = np.linspace(0, 1, W)[None, :]
    t = np.clip(0.65 * y + 0.35 * x, 0, 1)[..., None]
    a = np.array(BG0) * (1 - t) + np.array(BG1) * t
    g = np.exp(-(((x - 0.12) / 0.4) ** 2 + ((y - 0.05) / 0.4) ** 2))[..., None]
    a = a + g * np.array([6, 30, 28])
    return Image.fromarray(np.clip(a, 0, 255).astype('uint8'))


BG = make_bg()
def jl(p):
    out = []
    if os.path.exists(p):
        for line in open(p, encoding='utf-8', errors='replace'):
            try: out.append(json.loads(line))
            except ValueError: pass
    return out


def load(root):
    pairs = []
    for rnd in ('T4', 'T4b'):
        for i in (1, 2, 3):
            pair = {}
            for side in ('cfd', 'oc'):
                name = f'{rnd}-{side}-{i}'; d = os.path.join(root, name)
                meta = json.load(open(os.path.join(d, 'meta.json')))
                judge = json.load(open(os.path.join(d, 'judge.json')))
                sm = [(s['t'] - meta['t0'], s.get('procs') or 0) for s in jl(os.path.join(d, 'samples.jsonl'))]
                dp = {m: (judge.get('cases') or {}).get(m, {}).get('dp_Pa') for m in MESHES}
                wall, tok = AGENT[name]
                dev = [abs(dp[m] - REF[m]) / REF[m] * 100 for m in MESHES if dp[m]]
                pair[side] = dict(name=name, passed=bool(judge.get('passed')), dp=dp, wall=wall, tok=tok, samples=sm,
                                  dev=max(dev) if dev else None, note=FAIL_NOTE.get(name, ''))
            pairs.append(pair)
    return pairs


def procs_at(r, t):
    v = 0
    for ts, p in r['samples']:
        if ts > t: break
        v = p
    return v if t <= r['wall'] else 0


# ---------------- 场景 ----------------

def sc_title(d, p):
    a = ease(p / 0.25)
    T(d, (W // 2, 330), '同一个模型  ·  同一道题  ·  同样 24 核', 34, mix(MUT, a), anchor='mm')
    T(d, (W // 2, 450), 'CFDriver4MTO', 110, mix(CFD, a), True, 'mm')
    T(d, (W // 2, 560), '长程多工况 CFD：更稳、更快、更准', 52, mix(FG, ease((p - 0.15) / 0.3)), True, 'mm')
    b = ease((p - 0.35) / 0.3)
    T(d, (W // 2, 700), '真实运行录制  ·  判定脚本自动打分  ·  6 对全部入片，不挑选', 28, mix(MUT, b), anchor='mm')
    T(d, (W // 2, 750), '对照：OpenCode v2.2.5，同一 Claude 模型，同一网关', 24, mix(DIM, b), anchor='mm')


def sc_task(d, p):
    a = ease(p / 0.2)
    T(d, (160, 150), '任务 T4  ·  鼓泡流化床网格无关性研究', 56, mix(FG, a), True)
    T(d, (160, 230), '一次交给智能体，全程不干预，做完为止', 30, mix(MUT, a))
    steps = [('3 套网格', '30×100  ·  60×200  ·  120×400', '1.2 万 → 19 万单元'),
             ('双流体模型', 'twoPhaseEulerFoam 算到 6 s', '每套都要真的跑完、日志有 End'),
             ('交结果', '三套网格的床层压降 Δp', '自报值与数据差 ≤ 2 %'),
             ('独立判定', '脚本重新读场算 Δp', '必须落在 [5134, 5674] Pa')]
    for i, (h, l1, l2) in enumerate(steps):
        b = ease((p - 0.12 - i * 0.12) / 0.2); x = 160 + i * 410
        d.rounded_rectangle([x, 340 + (1 - b) * 40, x + 370, 640 + (1 - b) * 40], 22, fill=mix((26, 32, 48), b))
        T(d, (x + 30, 370 + (1 - b) * 40), f'0{i + 1}', 30, mix(CFD, b), True)
        T(d, (x + 30, 430 + (1 - b) * 40), h, 40, mix(FG, b), True)
        T(d, (x + 30, 510 + (1 - b) * 40), l1, 22, mix(FG, b))
        T(d, (x + 30, 555 + (1 - b) * 40), l2, 23, mix(MUT, b))
    c = ease((p - 0.6) / 0.25)
    T(d, (160, 730), '难点：长时间、多算例并行、核数有上限，中途卡住或设置走偏都会前功尽弃。', 30, mix(GOLD, c))
    T(d, (160, 790), '所有数字来自录制日志和判定脚本，不采用任何一方的自述。', 26, mix(MUT, c))
def sc_race(d, p, pairs, tmax):
    t = tmax * clamp(p / 0.9)
    T(d, (120, 70), '6 对同步回放  ·  各自从收到任务开始计时', 44, FG, True)
    s = f'延时 {tmax / (0.9 * RACE_S):.0f}×   ·   亮色 = 求解器正在算   ·   '
    T(d, (120, 130), s, 24, MUT); lx = 120 + d.textlength(s, font=F(24))
    TM(d, lx, 146, True, '判定通过', 24, GOOD, False); TM(d, lx + 150, 146, False, '未通过', 24, BAD, False)
    T(d, (1800, 80), hms(t), 64, GOLD, True, 'ra')
    x0, x1 = 330, 1640; sx = lambda s: x0 + (x1 - x0) * s / tmax
    for k in range(0, int(tmax / 3600) + 1):
        xx = sx(k * 3600); d.line([xx, 190, xx, 1020], fill=LINE, width=1)
        T(d, (xx, 1032), f'{k} h', 20, DIM, anchor='ma')
    for i, pr in enumerate(pairs):
        y = 205 + i * 137
        T(d, (60, y + 48), ('T4' if i < 3 else 'T4b') + f'-{i % 3 + 1}', 26, MUT, True, 'lm')
        for j, side in enumerate(('cfd', 'oc')):
            r = pr[side]; yy = y + j * 56; col, dcol = (CFD, CFD_D) if side == 'cfd' else (OC, OC_D)
            d.rounded_rectangle([x0, yy, x1, yy + 40], 10, fill=TRACK)
            te = min(t, r['wall']); step = tmax / 400
            s = 0.0
            while s < te:
                e = min(te, s + step); c = col if procs_at(r, s) > 0 else dcol
                d.rectangle([sx(s), yy + 4, max(sx(s) + 1, sx(e)), yy + 36], fill=c); s = e
            T(d, (x0 - 14, yy + 20), 'CFDriver' if side == 'cfd' else 'OpenCode', 21, col, True, 'rm')
            if t >= r['wall']:
                ok = r['passed']; xe = sx(r['wall'])
                TM(d, xe + 14, yy + 20, ok, mins(r['wall']), 24, GOOD if ok else BAD)


def sc_curve(d, p, pairs):
    T(d, (120, 70), '精度：三套网格的床层压降 Δp（判定脚本独立计算）', 44, FG, True)
    T(d, (120, 130), '灰带 = 判定通过区间   ·   金线 = 开跑前的校准算例   ·   网格加密后曲线越平越好', 24, MUT)
    X0, X1, Y0, Y1 = 260, 1660, 220, 960; lo, hi = 4990, 5360
    sy = lambda v: Y1 - (Y1 - Y0) * (v - lo) / (hi - lo); sx = lambda k: X0 + 120 + k * (X1 - X0 - 240) / 2
    d.rectangle([X0, sy(min(BAND[1], hi)), X1, sy(BAND[0])], fill=(24, 34, 44))
    for v in range(5000, 5361, 50):
        d.line([X0, sy(v), X1, sy(v)], fill=LINE, width=1); T(d, (X0 - 16, sy(v)), str(v), 20, DIM, anchor='rm')
    T(d, (X0 - 16, Y0 - 40), 'Δp (Pa)', 22, MUT, anchor='ra')
    T(d, (X1, sy(BAND[0]) + 10), '判定下限 5134', 20, BAD, anchor='ra')
    for k, m in enumerate(MESHES): T(d, (sx(k), Y1 + 24), m.replace('x', '×'), 26, MUT, anchor='ma')
    a = ease(p / 0.5); b = ease((p - 0.3) / 0.5)
    for side, col, al in (('oc', OC, a), ('cfd', CFD, b)):
        for pr in pairs:
            r = pr[side]; pts = [(sx(k), sy(r['dp'][m])) for k, m in enumerate(MESHES) if r['dp'][m]]
            c = mix(BAD if not r['passed'] and side == 'oc' else col, al * (0.55 if side == 'oc' else 1), (22, 28, 40))
            d.line(pts, fill=c, width=5 if side == 'cfd' else 2)
            rr = 8 if side == 'cfd' else 5
            for x, y in pts: d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=c)
    d.line([(sx(k), sy(REF[m])) for k, m in enumerate(MESHES)], fill=GOLD, width=3)
    T(d, (1700, 300), 'CFDriver ×6', 28, mix(CFD, b), True); T(d, (1700, 345), '全部在带内', 22, mix(MUT, b))
    T(d, (1700, 420), 'OpenCode ×6', 28, mix(OC, a), True); T(d, (1700, 465), '红色 = 未通过', 22, mix(BAD, a))
    c = ease((p - 0.6) / 0.3)
    cd = max(pr['cfd']['dev'] for pr in pairs); od = max(pr['oc']['dev'] for pr in pairs)
    T(d, (1700, 560), '最大偏离校准值（6 次）', 22, mix(MUT, c))
    T(d, (1700, 595), f'{cd:.1f} %', 44, mix(CFD, c), True); T(d, (1700, 655), f'OpenCode {od:.1f} %', 24, mix(OC, c))
def stats(pairs, side):
    rs = [pr[side] for pr in pairs]; w = sorted(r['wall'] for r in rs)
    spread = [max(r['dp'].values()) - min(r['dp'].values()) for r in rs if all(r['dp'].values())]
    return dict(npass=sum(r['passed'] for r in rs), n=len(rs), med=(w[2] + w[3]) / 2, worst=w[-1],
                spread=float(np.median(spread)))


def kpi_card(d, x, y, a, title, cv, ov, sub, frac_cfd, frac_oc):
    d.rounded_rectangle([x, y, x + 800, y + 330], 26, fill=mix((24, 30, 46), a))
    T(d, (x + 40, y + 30), title, 30, mix(MUT, a), True)
    T(d, (x + 40, y + 80), cv, 76, mix(CFD, a), True)
    T(d, (x + 760, y + 112), 'OpenCode  ' + ov, 30, mix(OC, a), anchor='ra')
    for k, (f, col, lab) in enumerate(((frac_cfd, CFD, 'CFDriver'), (frac_oc, OC, 'OpenCode'))):
        yy = y + 205 + k * 40
        d.rounded_rectangle([x + 150, yy, x + 760, yy + 22], 11, fill=mix(TRACK, a))
        d.rounded_rectangle([x + 150, yy, x + 150 + max(22, 610 * clamp(f) * a), yy + 22], 11, fill=mix(col, a))
        T(d, (x + 40, yy + 11), lab, 20, mix(col, a), anchor='lm')
    T(d, (x + 40, y + 292), sub, 22, mix(DIM, a))


def sc_kpi(d, p, pairs):
    c, o = stats(pairs, 'cfd'), stats(pairs, 'oc')
    T(d, (120, 70), '结果：同模型 6 对（T4 + T4b）', 44, FG, True)
    T(d, (120, 130), '墙钟 = 智能体收到任务到交出结果；判定脚本统一口径', 24, MUT)
    cards = [
        ('一次做成（判定通过）', f"{c['npass']} / {c['n']}", f"{o['npass']} / {o['n']}", '不干预、不重跑，交出来就对',
         c['npass'] / c['n'], o['npass'] / o['n']),
        ('中位耗时', mins(c['med']), mins(o['med']), f"快 {(1 - c['med'] / o['med']) * 100:.0f} %",
         c['med'] / o['med'], 1.0),
        ('最慢一次', mins(c['worst']), f"{o['worst'] / 3600:.1f} 小时", f"长尾缩短到 1/{o['worst'] / c['worst']:.1f}",
         c['worst'] / o['worst'], 1.0),
        ('三套网格 Δp 极差（中位）', f"{c['spread']:.0f} Pa", f"{o['spread']:.0f} Pa", '网格无关性更好，结果更稳',
         c['spread'] / max(c['spread'], o['spread']), o['spread'] / max(c['spread'], o['spread'])),
    ]
    for i, cd in enumerate(cards):
        kpi_card(d, 120 + (i % 2) * 860, 200 + (i // 2) * 380, ease((p - i * 0.12) / 0.3), *cd)


def sc_table(d, p, pairs):
    T(d, (120, 70), '逐对明细（全部 6 对，含未通过的）', 44, FG, True)
    cols = [120, 300, 500, 920, 1110, 1290]
    hdr = ['', '智能体', 'Δp 30 / 60 / 120 (Pa)', '判定', '墙钟', 'token']
    for x, h in zip(cols, hdr): T(d, (x, 170), h, 24, MUT, True)
    y = 220
    for i, pr in enumerate(pairs):
        a = ease((p - i * 0.07) / 0.25)
        T(d, (cols[0], y + 32), ('T4' if i < 3 else 'T4b') + f'-{i % 3 + 1}', 26, mix(FG, a), True, 'lm')
        for j, side in enumerate(('cfd', 'oc')):
            r = pr[side]; yy = y + j * 50 + 12; col = CFD if side == 'cfd' else OC
            T(d, (cols[1], yy), 'CFDriver' if side == 'cfd' else 'OpenCode', 24, mix(col, a), True)
            T(d, (cols[2], yy), ' / '.join(f'{r["dp"][m]:.0f}' for m in MESHES), 24, mix(FG, a))
            TM(d, cols[3], yy + 16, r['passed'], '通过' if r['passed'] else '未通过', 24, mix(GOOD if r['passed'] else BAD, a))
            T(d, (cols[4], yy), mins(r['wall']), 24, mix(FG, a))
            T(d, (cols[5], yy), f"{r['tok'] / 1e6:.2f} M", 24, mix(MUT, a))
            if r['note']: T(d, (1430, yy + 3), r['note'], 21, mix(BAD, a))
        y += 128
        d.line([120, y - 12, 1800, y - 12], fill=LINE, width=1)


def sc_end(d, p):
    a = ease(p / 0.3); b = ease((p - 0.25) / 0.3)
    T(d, (W // 2, 300), 'CFDriver4MTO', 96, mix(CFD, a), True, 'mm')
    lines = ['长程任务不卡死：等求解器用 solver_wait，不靠 pgrep 轮询',
             '多算例并行调度：核数上限内分配，独立工况同时跑',
             '领域经验内置：知道哪些"提速"会把结果算偏',
             '结果可核对：自报值必须和数据一致，判定脚本独立复算']
    for i, s in enumerate(lines):
        c = ease((p - 0.2 - i * 0.08) / 0.25)
        d.ellipse([560, 452 + i * 70, 576, 468 + i * 70], fill=mix(CFD, c))
        T(d, (600, 460 + i * 70), s, 32, mix(FG, c), anchor='lm')
    o = OVERALL
    T(d, (W // 2, 820), f"四轮同模型 A/B 总通过率   CFDriver {o['cfd'][0]}/{o['cfd'][1]}   ·   OpenCode {o['oc'][0]}/{o['oc'][1]}",
      34, mix(GOLD, b), True, 'mm')
    T(d, (W // 2, 880), '同一 Claude 模型 · 同一网关 · 每轮协议开跑前写定 · 所有运行均入统计', 24, mix(MUT, b), anchor='mm')
RACE_S = 22
SCENES = [('title', 6), ('task', 9), ('race', RACE_S), ('curve', 11), ('kpi', 11), ('table', 10), ('end', 9)]


def main():
    root, out = sys.argv[1], sys.argv[2]
    only = sys.argv[3] if len(sys.argv) > 3 else None    # 调试：只渲染某一场景的中间帧为 PNG
    pairs = load(root)
    tmax = max(max(pr['cfd']['wall'], pr['oc']['wall']) for pr in pairs) * 1.04
    draw = dict(title=sc_title, task=sc_task, race=lambda d, p: sc_race(d, p, pairs, tmax),
                curve=lambda d, p: sc_curve(d, p, pairs), kpi=lambda d, p: sc_kpi(d, p, pairs),
                table=lambda d, p: sc_table(d, p, pairs), end=sc_end)
    if only:
        for name, _ in SCENES:
            if name in only.split(','):
                im = BG.copy(); draw[name](ImageDraw.Draw(im), 0.95); im.save(os.path.join(os.path.dirname(out), f'frame_{name}.png'))
        return
    wr = imageio.get_writer(out, fps=FPS, codec='libx264', quality=9, macro_block_size=8,
                            ffmpeg_params=['-pix_fmt', 'yuv420p', '-preset', 'slow', '-movflags', '+faststart'])
    black = np.zeros((H, W, 3), 'uint8')
    for name, sec in SCENES:
        n = int(sec * FPS)
        for i in range(n):
            p = i / (n - 1); im = BG.copy(); draw[name](ImageDraw.Draw(im), p)
            # 场景尾部与下一场景首部各 0.4 s 渐隐渐显
            f = min(1.0, i / (0.4 * FPS), (n - 1 - i) / (0.4 * FPS))
            arr = np.asarray(im)
            wr.append_data(arr if f >= 1 else (arr * f + black * (1 - f)).astype('uint8'))
    wr.close(); print(out, sum(s for _, s in SCENES), 's')


if __name__ == '__main__':
    main()
