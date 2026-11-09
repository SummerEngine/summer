"""Alignment check: red edges of the blockout render over the paint-over. Roof lines, wall corners and props must
sit on the red lines; reject a painting that moved, added or zoomed anything. Needs Python with Pillow and numpy.
usage: python3 overlay.py <blockout.png> <painting.png> <out.png>"""
import sys

import numpy as np
from PIL import Image, ImageFilter

block, paint, out = sys.argv[1:4]
p = Image.open(paint).convert("RGB")
b = Image.open(block).convert("RGB").resize(p.size, Image.NEAREST)
a = np.asarray(b).astype(int)
e = (np.abs(np.diff(a, axis=0, prepend=a[:1])).sum(2) > 40) | (np.abs(np.diff(a, axis=1, prepend=a[:, :1])).sum(2) > 40)
e = np.asarray(Image.fromarray((e * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(3))) > 0
o = np.asarray(p).copy()
o[e] = [255, 0, 0]
Image.fromarray(o).save(out)
