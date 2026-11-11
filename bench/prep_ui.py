import sys
from PIL import Image, ImageDraw
src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGB'); d = ImageDraw.Draw(im)
# boxes (full 1920x1080): status badge, failed row, row with server path, model name
BOXES = [(440, 14, 545, 40), (460, 160, 1245, 190), (560, 580, 1235, 606), (775, 1020, 912, 1050), (30, 150, 300, 176)]
for x0, y0, x1, y1 in BOXES:
    d.rectangle([x0, y0, x1, y1], fill=im.getpixel((x1 + 3, y0 + 2)))
im.save(dst)
print('ok')
