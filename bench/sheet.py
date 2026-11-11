import os, sys
from PIL import Image
d = os.path.join(os.environ['TEMP'], 'opencode', 'vid')
names = sys.argv[1].split(',')
q = sys.argv[2]
sh = Image.new('RGB', (1920, 270 * ((len(names) + 1) // 2)), 'white')
for i, n in enumerate(names):
    im = Image.open(os.path.join(d, 'promo_%s_%s.png' % (n, q))).resize((960, 540))
    im = im.resize((960, 540))
    sh.paste(im.resize((960, 540)).resize((960, 540)), ((i % 2) * 960, (i // 2) * 540)) if False else None
sh = Image.new('RGB', (1920, 540 * ((len(names) + 1) // 2)), 'white')
for i, n in enumerate(names):
    im = Image.open(os.path.join(d, 'promo_%s_%s.png' % (n, q))).resize((960, 540))
    sh.paste(im, ((i % 2) * 960, (i // 2) * 540))
sh.save(os.path.join(d, 'sheet_%s.png' % q))
print('ok')
