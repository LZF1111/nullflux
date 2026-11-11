"""auto + mto scenes"""
from promo_base import *

ASSETS = os.environ.get('PROMO_ASSETS', '.')
_C = {}


def asset(name):
    if name not in _C:
        p = os.path.join(ASSETS, name)
        _C[name] = np.load(p) if name.endswith('.npy') else Image.open(p).convert('RGB')
    return _C[name]


def bed_image(prog, w, h):
    A = asset('promo_alpha.npy')
    k = min(len(A) - 1, int(clamp(prog) * (len(A) - 1)))
    return Image.fromarray(colorize(A[k][::-1] / 0.63)).resize((w, h), Image.BICUBIC)


def sc_auto(im, d, p):
    T(d, (120, 60), TX['au_t'], F('serif', 54))
    T(d, (120, 140), TX['au_s'], F('sans', 25), MUTE)
    x, y, w, h = 120, 220, 1680, 800
    card(im, (x, y, x + w, y + h)); d = ImageDraw.Draw(im)
    cur = max([c[3] for c in CALLS if c[0] <= p] or [0])
    for k in range(3):
        sx = x + 50 + k * 340; on = k <= cur
        d.rounded_rectangle([sx, y + 40, sx + 310, y + 100], 30, fill=CLAY if on else PAPER)
        T(d, (sx + 155, y + 70), TX['au_p%d' % (k + 1)], F('sans', 26, 700), CARD if on else MUTE, 'mm')
    for i, (t0, name, arg, ph) in enumerate(CALLS):
        a = ease((p - t0) / 0.06)
        if a <= 0: continue
        yy = y + 140 + i * 66 + (1 - a) * 16
        dot = SAGE if name == 'done' else CLAY
        d.ellipse([x + 60, yy + 12, x + 74, yy + 26], fill=mix(dot, a, CARD))
        T(d, (x + 96, yy), name, F('sans', 26, 700), mix(INK, a, CARD))
        T(d, (x + 400, yy + 2), arg, F('sans', 24), mix(MUTE, a, CARD))
    bx, by, bw, bh = x + w - 300, y + 140, 180, 600
    m = ease((p - 0.14) / 0.12)
    d.rectangle([bx, by, bx + bw, by + bh], outline=LINE, width=2)
    for k in range(1, 12):
        gy = by + bh * k / 12
        d.line([(bx, gy), (bx + bw * m, gy)], fill=mix(LINE, m, CARD))
    s = ease((p - 0.32) / 0.08)
    if s > 0:
        bed = bed_image((p - 0.32) / 0.6, bw, bh)
        im.paste(Image.blend(Image.new('RGB', bed.size, CARD), bed, s), (bx, by))
        d = ImageDraw.Draw(im)
        d.rectangle([bx, by, bx + bw, by + bh], outline=INK2, width=2)
    T(d, (bx + bw / 2, by + bh + 30), '0.3 m × 1 m · 60×200', F('sans', 20), MUTE, 'mm')
    e = ease((p - 0.9) / 0.08)
    if e > 0: T(d, (x + 1100, y + 52), TX['au_done'], F('serif', 32), mix(CLAY_D, e, CARD))


def sc_mto(im, d, p):
    T(d, (120, 60), TX['mt_t'], F('serif', 54))
    T(d, (120, 140), TX['mt_s'], F('sans', 25), MUTE)
    pics = [('mto/mesh_fine.png', 'mt_i1'), ('mto/fig_fields.png', 'mt_i2'), ('mto/compare_paper.png', 'mt_i3')]
    for i, (fn, key) in enumerate(pics):
        a = ease((p - i * 0.14) / 0.18)
        if a <= 0: continue
        x0 = 120 + i * 570; y0 = 220 + int((1 - a) * 40)
        card(im, (x0, y0, x0 + 540, y0 + 540), a=a)
        paste_fit(im, asset(fn), (x0 + 16, y0 + 16, x0 + 524, y0 + 476), a)
        d = ImageDraw.Draw(im)
        T(d, (x0 + 270, y0 + 508), TX[key], F('sans', 24), mix(INK2, a, CARD), 'mm')
    kp = [('1.205', 'mt_k1'), ('80.71 %', 'mt_k2'), ('99.99 %', 'mt_k3')]
    for i, (v, key) in enumerate(kp):
        a = ease((p - 0.5 - i * 0.08) / 0.15)
        if a <= 0: continue
        x0 = 120 + i * 380
        T(d, (x0, 800), v, F('serif', 72), mix(INK, a))
        T(d, (x0, 900), TX[key], F('sans', 24), mix(MUTE, a))
    a = ease((p - 0.78) / 0.15)
    T(d, (1300, 815), TX['mt_k4'], F('sans', 22), mix(MUTE, a))
    T(d, (1300, 860), TX['mt_k5'], F('serif', 32), mix(CLAY_D, a))
