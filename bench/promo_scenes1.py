"""open / ui / prompt scenes"""
from promo_base import *

ASSETS = os.environ.get('PROMO_ASSETS', '.')
_UI = []


def logo(d, cx, cy, r, col=CLAY):
    """own mark: ring + three rising bubbles"""
    w = max(3, int(r / 9))
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=col, width=w)
    for dx, dy, rr in ((-0.35, 0.3, 0.14), (0.08, -0.05, 0.2), (0.38, -0.42, 0.12)):
        x, y, q = cx + dx * r, cy + dy * r, rr * r
        d.ellipse([x - q, y - q, x + q, y + q], fill=col)


def sc_open(im, d, p):
    a = ease(p / 0.35)
    logo(d, W // 2, 380, 64 * a + 1)
    fade_text(d, (W // 2, 560), 'CFDriver4MTO', F('serif', 104), INK, (p - 0.15) / 0.35, anchor='mm')
    fade_text(d, (W // 2, 680), TX['op_s'], F('serif', 40), INK2, (p - 0.3) / 0.35, anchor='mm')
    fade_text(d, (W // 2, 750), TX['op_s2'], F('sans', 28), MUTE, (p - 0.42) / 0.35, anchor='mm')


def ui_img():
    if not _UI: _UI.append(Image.open(os.path.join(ASSETS, 'ui_clean.png')).convert('RGB'))
    return _UI[0]


def callout(im, cx, cy, s, b):
    if b <= 0: return
    d = ImageDraw.Draw(im); f = F('sans', 24); r = 10 + 6 * b
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=mix(CLAY, b), width=3)
    w = d.textlength(s, font=f) + 36
    x0 = min(cx + 26, 1880 - w); y0 = cy - 24
    d.rounded_rectangle([x0, y0, x0 + w, y0 + 48], 24, fill=mix(INK, b))
    d.text((x0 + 18, y0 + 10), s, font=f, fill=mix(IVORY, b, INK))


def sc_ui(im, d, p):
    T(d, (120, 60), TX['ui_t'], F('serif', 54))
    T(d, (120, 140), TX['ui_s'], F('sans', 25), MUTE)
    a = ease(p / 0.3)
    box = paste_fit(im, ui_img(), (120, 210 + int((1 - a) * 30), 1800, 1040), a)
    pts = ((0.07, 0.17, 'ui_c1'), (0.42, 0.55, 'ui_c2'), (0.80, 0.30, 'ui_c3'))
    for i, (fx, fy, key) in enumerate(pts):
        b = ease((p - 0.3 - i * 0.15) / 0.2)
        cx = box[0] + fx * (box[2] - box[0]); cy = box[1] + fy * (box[3] - box[1])
        callout(im, cx, cy, TX[key], b)


def sc_prompt(im, d, p):
    T(d, (120, 70), TX['pr_t'], F('serif', 54))
    x, y, w, h = 240, 330, 1440, 330
    card(im, (x, y, x + w, y + h)); d = ImageDraw.Draw(im)
    T(d, (x + 50, y + 40), TX['pr_lbl'], F('sans', 22), MUTE)
    s = TX['prompt']; n = int(len(s) * clamp(p / 0.6))
    cut = s.index('twoPhase'); part = s[:n]
    lines = [part[:cut], part[cut:]] if n > cut else [part]
    for k, ln in enumerate(lines):
        T(d, (x + 50, y + 100 + k * 50), ln, F('sans', 30))
    b = ease((p - 0.68) / 0.15)
    bx, by = x + w - 230, y + h - 100
    d.rounded_rectangle([bx, by, bx + 180, by + 60], 30, fill=mix(CLAY, b, CARD))
    T(d, (bx + 90, by + 30), TX['send'], F('sans', 26, 700), CARD, 'mm')
    c = ease((p - 0.8) / 0.18)
    T(d, (W // 2, 760), TX['pr_note'], F('serif', 32), mix(INK2, c), 'mm')