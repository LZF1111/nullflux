"""phys scene: jet penetration vs non-uniformity"""
from promo_base import *

# measured: (label, n_holes, d_eq mm, L_jet m, min/wall at Z=0.06, short-screen?)
# 全部为完整 3 s 计算（RSI 存档 metrics_visible），不用短算数
PTS = [('均布对照', 211, 3.9, 0.024, 0.939, False),
       ('71 孔', 71, 6.7, 0.042, 0.793, False),
       ('42 孔', 42, 8.7, 0.055, 0.768, False),
       ('24 孔', 24, 11.5, 0.074, 0.760, False),
       ('14 孔', 14, 15.1, 0.098, 0.730, False)]


def jets(im, d, p, x0, y0):
    base = y0 + 560; S = 560 / 0.08
    d.line([(x0, base), (x0 + 720, base)], fill=INK2, width=6)
    zy = base - 0.06 * S
    d.line([(x0, zy), (x0 + 720, zy)], fill=mix(CLAY, 0.5), width=2)
    T(d, (x0 + 724, zy - 14), 'Z = 0.06 m', F('sans', 20), CLAY_D)
    for i, (lb, n, dm, L, v, sh) in enumerate(PTS):
        a = ease((p - 0.1 - i * 0.08) / 0.2)
        if a <= 0: continue
        cx = x0 + 80 + i * 145; hw = dm * 2.4; top = base - L * S * a
        col = MUTE if i == 0 else CLAY
        d.polygon([(cx - hw, base), (cx + hw, base), (cx + hw * 0.35, top), (cx - hw * 0.35, top)], fill=mix(col, 0.35 * a + 0.1))
        d.ellipse([cx - 7, top - 7, cx + 7, top + 7], fill=mix(col, a))
        T(d, (cx + 18, top + 4), '%.3f m' % L, F('sans', 22), mix(INK2, a), 'lm')
        T(d, (cx, base + 34), lb, F('sans', 24, 700), mix(INK, a), 'mm')
        T(d, (cx, base + 70), '%d 孔 · %.1f mm' % (n, dm), F('sans', 20), mix(MUTE, a), 'mm')


def chart(im, d, p, x0, y0, w, h):
    X = lambda L: x0 + (L - 0.01) / 0.10 * w
    Y = lambda v: y0 + h - (v - 0.4) / 0.6 * h
    d.line([(x0, y0 + h), (x0 + w, y0 + h)], fill=INK2, width=2)
    d.line([(x0, y0), (x0, y0 + h)], fill=INK2, width=2)
    for v in (0.5, 0.7, 0.9):
        T(d, (x0 - 14, Y(v)), '%.1f' % v, F('sans', 20), MUTE, 'rm')
    for L in (0.02, 0.05, 0.08, 0.10):
        T(d, (X(L), y0 + h + 24), '%.2f' % L, F('sans', 20), MUTE, 'mm')
    T(d, (x0 + w, y0 + h + 60), TX['ph_x'], F('sans', 22), INK2, 'rm')
    T(d, (x0, y0 - 40), TX['ph_y'], F('sans', 22), INK2)
    ty = Y(0.487); a = ease((p - 0.05) / 0.2)
    for k in range(0, w, 24):
        d.line([(x0 + k, ty), (x0 + k + 12, ty)], fill=mix(INK, a), width=2)
    T(d, (x0 + w - 6, ty + 12), TX['ph_tg'], F('sans', 22), mix(INK, a), 'ra')
    prev = None
    for i, (lb, n, dm, L, v, sh) in enumerate(PTS):
        b = ease((p - 0.3 - i * 0.12) / 0.15)
        if b <= 0: continue
        px, py = X(L), Y(v); col = MUTE if i == 0 else CLAY
        r = 12 if not sh else 11
        d.ellipse([px - r, py - r, px + r, py + r], fill=mix(col, b), outline=mix(col, b), width=3)
        T(d, (px + 18, py + (6 if i % 2 else -36)), '%s  %.3f' % (lb, v), F('sans', 21), mix(INK2, b))


def sc_phys(im, d, p):
    T(d, (120, 60), TX['ph_t'], F('serif', 54))
    T(d, (120, 140), TX['ph_s'], F('sans', 25), MUTE)
    jets(im, d, p, 120, 230)
    chart(im, d, p, 1080, 290, 700, 440)
    for i in range(3):
        c = ease((p - 0.62 - i * 0.1) / 0.15)
        if c <= 0: continue
        y = 900 + i * 50
        d.ellipse([1080, y + 10, 1092, y + 22], fill=mix(CLAY, c))
        T(d, (1110, y), TX['ph_i%d' % (i + 1)], F('sans', 25), mix(INK, c))
    c = ease((p - 0.9) / 0.08)
    T(d, (120, 1010), TX['ph_note'], F('sans', 20), mix(MUTE, c))
