"""Draw the blockout spec's wireframe (red) over the concept through the paint camera, no engine needed.
Fix block positions until the red lines sit on the concept's silhouettes, then build in the engine
(blockout_builder.gd reads the same spec). Camera settings: see cam.py. Needs Python with Pillow.
usage: python3 preview.py <concept.png> <blockout.json> <out.png>"""
import json, math, sys, os
sys.path.insert(0, os.path.dirname(__file__))
from cam import to_px, IMG
from PIL import Image, ImageDraw

def ry(v, deg):
    a = math.radians(deg); x, y, z = v
    return (x * math.cos(a) + z * math.sin(a), y, -x * math.sin(a) + z * math.cos(a))
def rx(v, deg):
    a = math.radians(deg); x, y, z = v
    return (x, y * math.cos(a) - z * math.sin(a), y * math.sin(a) + z * math.cos(a))

def rz(v, deg):
    a = math.radians(deg); x, y, z = v
    return (x * math.cos(a) - y * math.sin(a), x * math.sin(a) + y * math.cos(a), z)

def edges(o):
    k = o["kind"]; P = o.get("pos", [0, 0, 0]); yaw = o.get("yaw", 0); rxd = o.get("rot_x", 0); rzd = o.get("rot_z", 0)
    S = o.get("scale", [1, 1, 1])
    def w(v):
        v = (v[0] * S[0], v[1] * S[1], v[2] * S[2])
        v = ry(rx(rz(v, rzd), rxd), yaw)
        return (P[0] + v[0], P[1] + v[1], P[2] + v[2])
    if k == "box":
        sx, sy, sz = [s / 2 for s in o["size"]]
        c = [(x, y, z) for x in (-sx, sx) for y in (-sy, sy) for z in (-sz, sz)]
        E = [(a, b) for a in range(8) for b in range(a + 1, 8) if bin(a ^ b).count("1") == 1]
        return [(w(c[a]), w(c[b])) for a, b in E]
    if k == "prism":
        sx, sy, sz = [s / 2 for s in o["size"]]
        v = {"l0": (-sx, -sy, -sz), "r0": (sx, -sy, -sz), "a0": (0, sy, -sz), "l1": (-sx, -sy, sz), "r1": (sx, -sy, sz), "a1": (0, sy, sz)}
        E = [("l0", "r0"), ("r0", "a0"), ("a0", "l0"), ("l1", "r1"), ("r1", "a1"), ("a1", "l1"), ("l0", "l1"), ("r0", "r1"), ("a0", "a1")]
        return [(w(v[a]), w(v[b])) for a, b in E]
    if k in ("cyl", "sphere"):
        out = []
        if k == "cyl":
            rings = [(0, o["r_bot"]), (o["height"], o["r_top"])]
        else:
            r = o["radius"]; sy = o.get("sy", 1)
            rings = [(r * sy * math.sin(t), r * math.cos(t)) for t in (-0.9, -0.45, 0, 0.45, 0.9)]
        for (hy, r) in rings:
            pts = [(P[0] + r * math.cos(a * math.pi / 12), P[1] + hy, P[2] + r * math.sin(a * math.pi / 12)) for a in range(25)]
            out += list(zip(pts, pts[1:]))
        return out
    if k == "poly":
        pts = [(x, o["top"], z) for x, z in o["points"]]
        return list(zip(pts, pts[1:] + pts[:1]))
    return []

src, js, dst = sys.argv[1:4]
im = Image.open(src).convert("RGB").resize(IMG)
d = ImageDraw.Draw(im)
for o in json.load(open(js))["objects"]:
    for a, b in edges(o):
        d.line([to_px(a), to_px(b)], fill=(255, 30, 30), width=2)
im.save(dst)
