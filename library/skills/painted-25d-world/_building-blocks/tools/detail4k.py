"""A 2K paint-over -> an aligned 4K painting. Upscale 2x, cut nine overlapping 2048x1152 tiles (1024x576 stride),
run a strict "redraw sharper, pixel-aligned" image-to-image pass on each tile with seedream-5-pro (the Summer image
model that returns 2048x1152), then blend the tiles back with tent weights. Nine image generations.
Uses the Summer CLI (`summer`, or set SUMMER_BIN); every call carries an idempotencyKey and numImages 1, and a
timed-out call is retried with the same key (a timeout can still charge). Needs Python with Pillow and numpy.
usage: python3 detail4k.py <painting_2k.png> <out_dir> "<style words>" [run_id]"""
import json, os, shlex, subprocess, sys, time, concurrent.futures as cf
import numpy as np
from PIL import Image
S = shlex.split(os.environ.get("SUMMER_BIN", "summer"))
src, outdir, style = sys.argv[1], sys.argv[2], sys.argv[3]
run_id = sys.argv[4] if len(sys.argv) > 4 else os.path.splitext(os.path.basename(src))[0]
os.makedirs(outdir, exist_ok=True)
PROMPT = ("This is a crop of a hand-painted game background, shown at low resolution. "
          f"Redraw it at full sharpness in its own style ({style}): crisp painterly brush strokes and fine texture detail. "
          "This is a texture paint-over: keep the image pixel-aligned. Every edge, silhouette, object, colour and light stays "
          "exactly where it is. Same framing, no zoom, no crop. Do not add, remove, move or resize anything. "
          "No characters, no text, no border.")

def run(args, inp=None):
    r = subprocess.run(S + args + ["--json"] + (["--input", json.dumps(inp)] if inp else []), capture_output=True, text=True)
    txt = r.stdout.strip() or r.stderr.strip()
    if "{" in txt:
        try:
            return json.JSONDecoder().raw_decode(txt[txt.find("{"):])[0]
        except Exception:
            pass
    sys.stderr.write("unparsed: " + txt[-300:] + r.stderr[-300:] + "\n")
    return {"ok": False, "error": {"code": "outcome_unknown"}}

def upload(path):
    b = run(["assets", "upload-begin"])["result"]
    f = b["fields"]
    cmd = ["curl", "-sS", b["uploadUrl"]] + sum([["-F", f"{k}={v}"] for k, v in f.items()], []) + ["-F", f"file=@{path}"]
    up = json.loads(subprocess.run(cmd, capture_output=True, text=True).stdout)
    c = run(["assets", "upload-complete"], {"publicId": up["public_id"], "version": up["version"], "uploadSignature": up["signature"], "format": "png", "title": os.path.basename(path)})
    return c["result"]["fileUrl"]

def tile(job):
    i, path = job
    out = os.path.join(outdir, f"tile_{i}_paint.png")
    if os.path.exists(out):
        return out
    cache = path + ".url"
    if not os.path.exists(cache):
        open(cache, "w").write(upload(path))
    url = open(cache).read().strip()
    for attempt in range(30):
        r = run(["assets", "generate-image"], {"prompt": PROMPT, "referenceImageUrl": url, "model": "seedream-5-pro", "aspectRatio": "16:9",
                                           "width": 2048, "height": 1152, "numImages": 1, "title": f"{run_id} 4k tile {i}",
                                           "idempotencyKey": f"{run_id}-4k-tile-{i}", "out": out})
        code = r.get("error", {}).get("code")
        if r.get("ok") or code not in ("outcome_unknown", "in_progress"):
            break
        time.sleep(15)
    if not r.get("ok"):
        raise RuntimeError(json.dumps(r)[:600])
    print("tile", i, r["result"].get("creditsCharged"), flush=True)
    return out

base = Image.open(src).convert("RGB").resize((4096, 2304), Image.LANCZOS)
base.save(os.path.join(outdir, "base4k.png"))
jobs = []
for ty in range(3):
    for tx in range(3):
        x, y = tx * 1024, ty * 576
        p = os.path.join(outdir, f"tile_{ty * 3 + tx}.png")
        base.crop((x, y, x + 2048, y + 1152)).save(p)
        jobs.append((ty * 3 + tx, p))
with cf.ThreadPoolExecutor(3) as ex:
    outs = list(ex.map(tile, jobs))
acc = np.zeros((2304, 4096, 3)); wsum = np.zeros((2304, 4096, 1))
wx = 1 - np.abs(np.linspace(-1, 1, 2048)); wy = 1 - np.abs(np.linspace(-1, 1, 1152))
w = (np.outer(wy, wx) + 1e-3)[..., None]
for (i, _), o in zip(jobs, outs):
    t = np.asarray(Image.open(o).convert("RGB").resize((2048, 1152), Image.LANCZOS)).astype(float)
    x, y = (i % 3) * 1024, (i // 3) * 576
    tw = w.copy()
    acc[y:y + 1152, x:x + 2048] += t * tw; wsum[y:y + 1152, x:x + 2048] += tw
Image.fromarray(np.clip(acc / wsum, 0, 255).astype(np.uint8)).save(os.path.join(outdir, "paint4k.png"))
print("done", os.path.join(outdir, "paint4k.png"))
