"""rsi / adv / end scenes"""
from promo_base import *
from promo_scenes1 import logo

ASSETS = os.environ.get('PROMO_ASSETS', '.')


def holes(n):
    return json.load(open(os.path.join(ASSETS, 'mto', n), encoding='utf-8'))['holes']


def plate(im, cx, cy, R, hs, a, col):
    d = ImageDraw.Draw(im); s = R / 0.13
    d.ellipse([cx - R, cy - R, cx + R, cy + R], fill=mix(PAPER, a), outline=mix(INK2, a), width=2)
    n = int(len(hs) * clamp(a * 1.3))
    for x, y, dm in hs[:n]:
        q = max(2, dm / 1000 * s / 2)
        px, py = cx + x * s, cy - y * s
        d.ellipse([px - q, py - q, px + q, py + q], fill=col)


def sc_rsi(im, d, p):
    T(d, (120, 60), TX['rs_t'], F('serif', 54))
    T(d, (120, 140), TX['rs_s'], F('sans', 25), MUTE)
    for i in range(5):
        a = ease((p - i * 0.05) / 0.12); x0 = 120 + i * 340
        if a > 0: chip(d, x0, 210, TX['rs_f%d' % (i + 1)], F('sans', 24), mix(CLAY_D, a), mix(CLAY_L, a * 0.6))
    A = holes('holes_ctl.json'); B = holes(os.path.join('rounds', 'b1b90c2751.json'))
    for j, (hs, key, col, t0) in enumerate(((A, 'rs_l1', MUTE, 0.18), (B, 'rs_l2', CLAY, 0.32))):
        a = ease((p - t0) / 0.18); cx = 380 + j * 500
        if a <= 0: continue
        plate(im, cx, 560, 200, hs, a, mix(col, a, PAPER))
        T(ImageDraw.Draw(im), (cx, 800), TX[key], F('sans', 26), mix(INK2, a), 'mm')
    d = ImageDraw.Draw(im); a = ease((p - 0.5) / 0.2)
    gx, gy, gw = 1200, 440, 600
    X = lambda v: gx + gw * (1.0 - v) / 0.6
    T(d, (gx, gy - 150), TX['rs_m'], F('sans', 24), mix(MUTE, a))
    d.line([(gx, gy), (gx + gw, gy)], fill=mix(LINE, a), width=6)
    for v, s, col, t0 in ((0.939, '0.939', MUTE, 0.5), (0.487, TX['rs_paper'], INK, 0.55)):
        b = ease((p - t0) / 0.15); px = X(v)
        d.line([(px, gy - 18), (px, gy + 18)], fill=mix(col, b), width=3)
        T(d, (px, gy + 50), s, F('sans', 22), mix(col, b), 'mm')
    v = 0.939 - (0.939 - 0.730) * ein((p - 0.62) / 0.25)
    b = ease((p - 0.62) / 0.1)
    if b > 0:
        px = X(v); d.ellipse([px - 16, gy - 16, px + 16, gy + 16], fill=mix(CLAY, b))
        T(d, (px, gy - 50), '%.3f' % v, F('serif', 56), mix(CLAY_D, b), 'mm')
    c = ease((p - 0.82) / 0.15)
    T(d, (gx, 580), TX['rs_gain'], F('serif', 36), mix(INK, c))
    T(d, (gx, 640), TX['rs_gain2'], F('sans', 24), mix(INK2, c))
    T(d, (gx, 690), TX['rs_note'], F('sans', 20), mix(MUTE, c))


def sc_adv(im, d, p):
    T(d, (120, 70), TX['ad_t'], F('serif', 54))
    for i in range(4):
        k = 'ad_%d' % (i + 1); a = ease((p - i * 0.12) / 0.2)
        if a <= 0: continue
        x0 = 120 + i * 430; y0 = 260 + int((1 - a) * 40)
        card(im, (x0, y0, x0 + 400, y0 + 560), a=a); d = ImageDraw.Draw(im)
        T(d, (x0 + 40, y0 + 60), TX[k + 'k'], F('sans', 28, 700), mix(CLAY_D, a, CARD))
        T(d, (x0 + 40, y0 + 130), TX[k + 'v'], F('serif', 88), mix(INK, a, CARD))
        for j, ln in enumerate(wrap(d, TX[k + 'd'], F('sans', 23), 320)):
            T(d, (x0 + 40, y0 + 300 + j * 38), ln, F('sans', 23), mix(MUTE, a, CARD))
    c = ease((p - 0.6) / 0.2)
    T(d, (W // 2, 930), TX['ad_foot'], F('sans', 22), mix(MUTE, c), 'mm')


def wrap(d, s, f, w):
    out, cur = [], ''
    for ch in s:
        if d.textlength(cur + ch, font=f) > w and ch not in '，。、）% ': out.append(cur); cur = ''
        cur += ch
    return out + [cur]


def sc_end(im, d, p):
    a = ease(p / 0.3)
    logo(d, W // 2 - 400, 470, 52 * a + 1)
    fade_text(d, (W // 2 + 60, 470), 'CFDriver4MTO', F('serif', 92), INK, p / 0.3, anchor='mm')
    fade_text(d, (W // 2, 610), TX['en_s'], F('serif', 40), INK2, (p - 0.2) / 0.3, anchor='mm')
    fade_text(d, (W // 2, 700), TX['en_tags'], F('sans', 26), MUTE, (p - 0.35) / 0.3, anchor='mm')
