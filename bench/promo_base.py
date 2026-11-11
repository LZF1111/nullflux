"""Shared drawing helpers for the CFDriver4MTO promo (warm ivory, ink, clay accent)."""
import json, math, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H, FPS = 1920, 1080, 30
_HERE = os.path.dirname(os.path.abspath(__file__))
TX = json.load(open(os.path.join(_HERE, 'promo_text.json'), encoding='utf-8'))

IVORY = (250, 249, 245); PAPER = (240, 238, 230); CARD = (255, 255, 255)
INK = (25, 25, 23); INK2 = (61, 61, 58); MUTE = (115, 114, 108); LINE = (222, 219, 210)
CLAY = (217, 119, 87); CLAY_D = (189, 93, 58); CLAY_L = (240, 196, 176); SAGE = (120, 140, 93)
FONT = dict(serif='C:/Windows/Fonts/NotoSerifSC-VF.ttf', sans='C:/Windows/Fonts/msyh.ttc',
            sansb='C:/Windows/Fonts/msyhbd.ttc')
_fc = {}


def F(kind, sz, w=None):
    if w == 700 and kind == 'sans': kind = 'sansb'
    k = (kind, sz)
    if k not in _fc:
        f = ImageFont.truetype(FONT[kind], sz)
        if kind == 'serif':
            try: f.set_variation_by_axes([600])
            except Exception: pass
        _fc[k] = f
    return _fc[k]


def clamp(x, a=0.0, b=1.0): return max(a, min(b, x))
def ease(x): x = clamp(x); return 1 - (1 - x) ** 3
def ein(x): x = clamp(x); return x * x * (3 - 2 * x)
def mix(c, a, bg=IVORY): return tuple(int(bg[i] + (c[i] - bg[i]) * clamp(a)) for i in range(3))


def card(im, box, r=22, fill=CARD, a=1.0, shadow=True):
    x0, y0, x1, y1 = [int(v) for v in box]
    if shadow and a > 0:
        sh = Image.new('L', (W, H), 0)
        ImageDraw.Draw(sh).rounded_rectangle([x0, y0 + 10, x1, y1 + 14], r, fill=int(40 * a))
        sh = sh.filter(ImageFilter.GaussianBlur(18))
        im.paste(Image.new('RGB', (W, H), (60, 50, 40)), (0, 0), sh)
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([x0, y0, x1, y1], r, fill=mix(fill, a), outline=mix(LINE, a))


def T(d, xy, s, f, fill=INK, anchor='la'):
    d.text(xy, s, font=f, fill=fill, anchor=anchor)


def fade_text(d, xy, s, f, col, a, anchor='la', rise=24, bg=IVORY):
    a = ease(a)
    if a > 0:
        d.text((xy[0], xy[1] + (1 - a) * rise), s, font=f, fill=mix(col, a, bg), anchor=anchor)

def paste_fit(im, src, box, a=1.0, radius=14):
    x0, y0, x1, y1 = [int(v) for v in box]
    s = min((x1 - x0) / src.width, (y1 - y0) / src.height)
    sm = src.resize((int(src.width * s), int(src.height * s)), Image.LANCZOS)
    ox = x0 + (x1 - x0 - sm.width) // 2
    oy = y0 + (y1 - y0 - sm.height) // 2
    mk = Image.new('L', sm.size, 0)
    ImageDraw.Draw(mk).rounded_rectangle([0, 0, sm.width - 1, sm.height - 1], radius, fill=int(255 * clamp(a)))
    im.paste(sm, (ox, oy), mk)
    return (ox, oy, ox + sm.width, oy + sm.height)


def chip(d, x, y, s, f, col=CLAY, bg=None):
    w = d.textlength(s, font=f) + 30
    d.rounded_rectangle([x, y, x + w, y + f.size + 18], (f.size + 18) // 2, fill=bg or mix(col, 0.12))
    d.text((x + 15, y + 8), s, font=f, fill=col)
    return w


CALLS = [(0.00, 'foam_env_check', 'OpenFOAM v2306 · 96 cores', 0),
         (0.07, 'foam_clone_tutorial', 'twoPhaseEulerFoam/fluidisedBed', 0),
         (0.14, 'write_file', 'blockMeshDict × 3', 0),
         (0.21, 'run_command', 'blockMesh · setFields · decomposePar', 0),
         (0.30, 'solver_start × 3', '30×100 · 60×200 · 120×400 in parallel', 1),
         (0.40, 'solver_wait', 'mode=all · 3 cases', 1),
         (0.52, 'diagnose_error', 'exit 134 after End → result valid', 1),
         (0.64, 'run_command', 'postprocess.py · time-averaged Δp', 2),
         (0.76, 'write_file', 'result.json · Δp of 3 meshes', 2),
         (0.88, 'done', '5273 / 5277 / 5272 Pa · judge passed', 2)]

_CM = np.array([IVORY, (247, 228, 215), CLAY_L, (229, 160, 128), CLAY, CLAY_D, (150, 70, 44)], float)


def colorize(a):
    x = np.clip(a, 0, 1) * (len(_CM) - 1); i = np.minimum(x.astype(int), len(_CM) - 2); f = (x - i)[..., None]
    return (_CM[i] * (1 - f) + _CM[i + 1] * f).astype(np.uint8)