"""A 2K paint-over -> an aligned 4K painting. Upscale 2x, cut nine overlapping 2048x1152 tiles (1024x576 stride),
run a strict "redraw sharper, pixel-aligned" image-to-image pass on each tile with seedream-5-pro (the Summer image
model that returns 2048x1152), then blend the tiles back with tent weights. A fresh run uses up to nine image generations.
Uses the Summer CLI (`summer`, or set SUMMER_BIN); every call carries an idempotencyKey and numImages 1, and a
timed-out call is retried with the same key (a timeout can still charge). Needs Python with Pillow and numpy.
usage: python3 detail4k.py <painting_2k.png> <out_dir> "<style words>" [run_id]"""
import concurrent.futures as cf
import hashlib
import json
import os
import shlex
import sqlite3
import subprocess
import sys
import tempfile
import time
from contextlib import closing
from pathlib import Path

S = shlex.split(os.environ.get("SUMMER_BIN", "summer"))
PROMPT = ("This is a crop of a hand-painted game background, shown at low resolution. "
          "Redraw it at full sharpness in its own style ({style}): crisp painterly brush strokes and fine texture detail. "
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

def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def reference_url(cache, source_hash, path):
    # Concurrent invocations can upload at the same time. Both must use the winning URL
    # so that the provider sees the identical request when the same generation is retried.
    with closing(sqlite3.connect(cache / "uploads.sqlite3", timeout=30)) as db:
        db.execute("CREATE TABLE IF NOT EXISTS uploads (hash TEXT PRIMARY KEY, url TEXT NOT NULL)")
        row = db.execute("SELECT url FROM uploads WHERE hash = ?", (source_hash,)).fetchone()
        if row:
            return row[0]
        url = upload(path)
        if not isinstance(url, str) or not url.strip():
            raise RuntimeError("The tile upload returned no reference image URL")
        with db:
            db.execute("INSERT OR IGNORE INTO uploads VALUES (?, ?)", (source_hash, url))
            return db.execute("SELECT url FROM uploads WHERE hash = ?", (source_hash,)).fetchone()[0]


def tile(job, cache, style, run_id):
    from PIL import Image

    i, path = job
    source_hash = hashlib.sha256(path.read_bytes()).hexdigest()
    request = {"prompt": PROMPT.format(style=style), "model": "seedream-5-pro", "aspectRatio": "16:9",
               "width": 2048, "height": 1152, "numImages": 1, "title": f"{run_id} 4k tile {i}"}
    out = cache / (fingerprint([source_hash, request]) + ".png")
    if out.is_file():
        return out
    request["referenceImageUrl"] = reference_url(cache, source_hash, path)
    key = "paint4k-" + fingerprint([source_hash, request])
    # The CLI keeps the output path local. Only promote a decoded image after a successful call.
    for attempt in range(30):
        staged = path.with_name(f"paint_{i}_{attempt}.png")
        result = run(["assets", "generate-image", "--idempotency-key", key], {**request, "out": str(staged)})
        if result.get("ok") or result.get("error", {}).get("code") not in ("outcome_unknown", "in_progress"):
            break
        time.sleep(15)
    if not result.get("ok") or result.get("status") != "done" or not staged.is_file():
        raise RuntimeError(f"Tile {i} was not saved: {json.dumps(result)[:600]}")
    with Image.open(staged) as image:
        image.load()
    staged.replace(out)
    print("tile", i, result["result"].get("creditsCharged"), flush=True)
    return out


def main(src, outdir, style, run_id):
    import numpy as np
    from PIL import Image

    outdir = Path(outdir)
    cache = outdir / ".detail4k"
    cache.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(dir=cache) as work:
        work = Path(work)
        with Image.open(src) as image:
            base = image.convert("RGB").resize((4096, 2304), Image.LANCZOS)
        jobs = []
        for ty in range(3):
            for tx in range(3):
                i = ty * 3 + tx
                x, y = tx * 1024, ty * 576
                path = work / f"tile_{i}.png"
                base.crop((x, y, x + 2048, y + 1152)).save(path)
                jobs.append((i, path))
        with cf.ThreadPoolExecutor(3) as ex:
            futures = [ex.submit(tile, job, cache, style, run_id) for job in jobs]
            outs = [future.result() for future in futures]
        acc = np.zeros((2304, 4096, 3)); wsum = np.zeros((2304, 4096, 1))
        wx = 1 - np.abs(np.linspace(-1, 1, 2048)); wy = 1 - np.abs(np.linspace(-1, 1, 1152))
        w = (np.outer(wy, wx) + 1e-3)[..., None]
        for i, o in enumerate(outs):
            t = np.asarray(Image.open(o).convert("RGB").resize((2048, 1152), Image.LANCZOS)).astype(float)
            x, y = (i % 3) * 1024, (i // 3) * 576
            tw = w.copy()
            acc[y:y + 1152, x:x + 2048] += t * tw; wsum[y:y + 1152, x:x + 2048] += tw
        Image.fromarray(np.clip(acc / wsum, 0, 255).astype(np.uint8)).save(work / "paint4k.png")
        base.save(work / "base4k.png")
        (work / "base4k.png").replace(outdir / "base4k.png")
        (work / "paint4k.png").replace(outdir / "paint4k.png")
    print("done", outdir / "paint4k.png")


if __name__ == "__main__":
    src, outdir, style = sys.argv[1:4]
    run_id = sys.argv[4] if len(sys.argv) > 4 else Path(src).stem
    main(src, outdir, style, run_id)
