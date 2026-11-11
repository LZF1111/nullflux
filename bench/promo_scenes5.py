"""rounds scene: how the agent tunes the distributor geometry round by round (measured RSI archive)"""
from promo_base import *
from promo_scenes3 import plate

ASSETS = os.environ.get('PROMO_ASSETS', '.')
_R = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'promo_rounds.json'), encoding='utf-8'))
ROUNDS = _R['rounds']
_H = {}
BADGE = dict(control=('对照', MUTE), accepted=('接受 · 新冠军', SAGE), rejected=('拒绝', CLAY_D),
             pruned=('短算淘汰', CLAY_D), running=('完整计算中', INK2))


def wrap(d, s, f, w):
    """按字换行，但数字、英文单词不拆开；行首不放标点"""
    import re
    toks = re.findall(r'[A-Za-z0-9.+\-−/%=<>]+|\s|.', s)
    out, cur = [], ''
    for t in toks:
        if cur and d.textlength(cur + t, font=f) > w and t not in '，。、；）,':
            out.append(cur.rstrip()); cur = t.lstrip()
        else:
            cur += t
    return out + [cur]


def holes_of(h):
    if h not in _H:
        _H[h] = json.load(open(os.path.join(ASSETS, 'mto', 'rounds', h + '.json'), encoding='utf-8'))['holes']
    return _H[h]


def badge(d, x, y, s, col):
    f = F('sans', 24, 700); w = d.textlength(s, font=f) + 36
    d.rounded_rectangle([x, y, x + w, y + 46], 23, fill=mix(col, 0.14))
    d.text((x + 18, y + 9), s, font=f, fill=col)


def loss_chart(d, p, k, x0, y0, w, h):
    """每轮目标值（Fig.12b 拟合损失，越低越接近原文）+ 冠军阶梯线；只画到当前轮"""
    lo, hi = 0.08, 0.25
    X = lambda i: x0 + 30 + i * (w - 60) / (len(ROUNDS) - 1)
    Y = lambda v: y0 + h - (v - lo) / (hi - lo) * h
    T(d, (x0, y0 - 46), '每轮候选的拟合损失（越低越接近原文 Fig.12b）', F('sans', 22), INK2)
    for v in (0.10, 0.15, 0.20):
        d.line([(x0, Y(v)), (x0 + w, Y(v))], fill=LINE, width=1)
        T(d, (x0 - 12, Y(v)), '%.2f' % v, F('sans', 18), MUTE, 'rm')
    champ, pts = None, []
    for i, r in enumerate(ROUNDS[:k + 1]):
        if r['state'] in ('control', 'accepted'): champ = r['loss']
        pts.append((X(i), Y(champ)))
    for (xa, ya), (xb, yb) in zip(pts, pts[1:]):
        d.line([(xa, ya), (xb, ya), (xb, yb)], fill=SAGE, width=4)
    for i, r in enumerate(ROUNDS[:k + 1]):
        a = 1.0 if i < k else ease(p)
        col = dict(accepted=SAGE, control=MUTE).get(r['state'], CLAY)
        px, py = X(i), Y(r['loss']); q = 13 if i == k else 9
        if r['fid'] == 'short':
            d.ellipse([px - q, py - q, px + q, py + q], outline=mix(col, a), width=3)
        else:
            d.ellipse([px - q, py - q, px + q, py + q], fill=mix(col, a))
        T(d, (px, y0 + h + 26), '%d 孔' % r['n'], F('sans', 18), mix(MUTE, a), 'mm')
    T(d, (x0, y0 + h + 62), '实心 = 完整 3 s 计算   空心 = 1.5 s 短算   绿线 = 当前冠军', F('sans', 18), MUTE)


def sc_rounds(im, d, p):
    T(d, (120, 60), 'Agent 每一轮怎样调几何', F('serif', 54))
    T(d, (120, 140), '读上一轮结果 → 写出新的布孔代码 → 约束检查 → 短算筛选 → 完整计算 → 带噪声的接受判据', F('sans', 25), MUTE)
    n = len(ROUNDS); k = min(n - 1, int(p * n)); q = p * n - k
    r = ROUNDS[k]
    a = ease(q / 0.25)
    plate(im, 400, 560, 230, holes_of(r['hash']), a, mix(CLAY if r['state'] != 'control' else MUTE, a, PAPER))
    d = ImageDraw.Draw(im)
    T(d, (400, 830), '%s · %d 孔 · 孔径 %.1f mm' % (r['round'], r['n'], r['d']), F('sans', 26, 700), mix(INK, a), 'mm')
    T(d, (400, 872), '射流穿透 %.3f m（Merry 关联式）' % r['L'], F('sans', 22), mix(MUTE, a), 'mm')
    x0 = 760
    T(d, (x0, 270), '智能体的设计思路', F('sans', 22), mix(MUTE, a))
    for j, ln in enumerate(wrap(d, r['why'], F('serif', 32), 420)):
        T(d, (x0, 310 + j * 48), ln, F('serif', 32), mix(INK, a))
    b = ease((q - 0.35) / 0.25)
    if b > 0:
        T(d, (x0, 520), 'Z = 0.06 m 谷值 / 壁面值', F('sans', 22), mix(MUTE, b))
        T(d, (x0, 556), '%.3f' % r['min006'], F('serif', 64), mix(CLAY_D, b))
        T(d, (x0 + 200, 590), '原文 %.3f' % _R['paper_min006'], F('sans', 22), mix(INK2, b))
        lb, col = BADGE[r['state']]
        if b > 0.6: badge(d, x0, 660, lb, col)
        if r.get('verdict'):
            for j, ln in enumerate(wrap(d, r['verdict'], F('sans', 23), 420)):
                T(d, (x0, 730 + j * 36), ln, F('sans', 23), mix(INK2, b))
    loss_chart(d, q, k, 1270, 330, 520, 420)
    T(d, (120, 1010), '全部数据取自 RSI 存档的真实运行记录；每轮都保留，含被拒与被淘汰的候选', F('sans', 20), MUTE)
