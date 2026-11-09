"""Paint camera math without the engine: concept pixels <-> world positions.
Matches a Godot PaintCamera with rotation_degrees (-ELEV, AZIM, 0), orthographic, KEEP_WIDTH, centred on C.
Settings (environment): PAINT_W frame width in metres (40), PAINT_ELEV degrees down (30), PAINT_AZIM (45),
PAINT_C frame centre "x,y,z" (0,0,0), PAINT_IMG image size "2048,1152".
usage: python3 cam.py <height_m> <px,py> [<px,py> ...]   world point on the plane y = height under each pixel
       (bottom corners of walls at height 0 give a footprint; read a ridge at the eave height to place a roof)"""
import math
import os

W = float(os.environ.get("PAINT_W", "40"))
IMG = tuple(int(v) for v in os.environ.get("PAINT_IMG", "2048,1152").split(","))
H = W * IMG[1] / IMG[0]
C = tuple(float(v) for v in os.environ.get("PAINT_C", "0,0,0").split(","))
PITCH = math.radians(-float(os.environ.get("PAINT_ELEV", "30")))
YAW = math.radians(float(os.environ.get("PAINT_AZIM", "45")))


def ry(v, a):
    x, y, z = v
    return (x * math.cos(a) + z * math.sin(a), y, -x * math.sin(a) + z * math.cos(a))


def rx(v, a):
    x, y, z = v
    return (x, y * math.cos(a) - z * math.sin(a), y * math.sin(a) + z * math.cos(a))


RIGHT = ry(rx((1, 0, 0), PITCH), YAW)
UP = ry(rx((0, 1, 0), PITCH), YAW)
FWD = ry(rx((0, 0, -1), PITCH), YAW)


def dot(a, b):
    return sum(i * j for i, j in zip(a, b))


def to_px(w):
    """World point -> pixel in the painting."""
    d = tuple(w[i] - C[i] for i in range(3))
    return ((dot(d, RIGHT) / W + 0.5) * IMG[0], (0.5 - dot(d, UP) / H) * IMG[1])


def to_ground(px, py, h=0.0):
    """Pixel -> the world point on the plane y = h that the pixel shows."""
    a = (px / IMG[0] - 0.5) * W
    b = (0.5 - py / IMG[1]) * H
    p0 = tuple(C[i] + a * RIGHT[i] + b * UP[i] for i in range(3))
    t = (h - p0[1]) / FWD[1]
    return tuple(round(p0[i] + t * FWD[i], 2) for i in range(3))


if __name__ == "__main__":
    import sys
    h = float(sys.argv[1])
    for s in sys.argv[2:]:
        x, y = map(float, s.split(","))
        print(s, "->", to_ground(x, y, h))
