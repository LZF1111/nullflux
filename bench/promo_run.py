from promo_base import *
from promo_scenes1 import sc_open, sc_ui, sc_prompt
from promo_scenes2 import sc_auto, sc_mto
from promo_scenes3 import sc_rsi, sc_adv, sc_end
from promo_scenes4 import sc_phys
from promo_scenes5 import sc_rounds, ROUNDS

SCENES = [('open', sc_open, 4.5), ('ui', sc_ui, 6), ('prompt', sc_prompt, 5), ('auto', sc_auto, 10),
          ('mto', sc_mto, 10), ('rsi', sc_rsi, 9), ('rounds', sc_rounds, 2.6 * len(ROUNDS)), ('phys', sc_phys, 9),
          ('adv', sc_adv, 8), ('end', sc_end, 5)]
X = 12


def frame(fn, p):
    im = Image.new('RGB', (W, H), IVORY)
    fn(im, ImageDraw.Draw(im), p)
    return im


def preview(names, outdir):
    for name, fn, _ in SCENES:
        if name not in names: continue
        for q in (0.5, 0.97):
            png = os.path.join(outdir, 'promo_' + name + '_' + str(int(q * 100)) + '.png')
            frame(fn, q).save(png)


def render(out):
    import imageio.v2 as iio
    wr = iio.get_writer(out, fps=FPS, codec='libx264', quality=9, macro_block_size=8)
    prev = None
    for name, fn, sec in SCENES:
        n = int(sec * FPS)
        for i in range(n):
            arr = np.asarray(frame(fn, i / (n - 1))).astype(np.float32)
            if prev is not None and i < X:
                f = ein(i / X)
                arr = prev * (1 - f) + arr * f
            wr.append_data(arr.astype(np.uint8))
        prev = arr
    wr.close()


def main():
    out = sys.argv[1]
    if len(sys.argv) > 2:
        preview(sys.argv[2].split(','), os.path.dirname(os.path.abspath(out)))
    else:
        render(out)
        print(out)