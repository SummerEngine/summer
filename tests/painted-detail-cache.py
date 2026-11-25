"""Run with python3 tests/painted-detail-cache.py (Pillow is used by the product's image checks)."""
import concurrent.futures
import importlib.util
import shutil
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    from PIL import Image
except ImportError:
    Image = None

path = Path(__file__).resolve().parents[1] / "library/skills/painted-25d-world/_building-blocks/tools/detail4k.py"
spec = importlib.util.spec_from_file_location("detail4k", path)
detail = importlib.util.module_from_spec(spec)
spec.loader.exec_module(detail)


class DetailCacheTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cache = self.root / ".detail4k"
        self.cache.mkdir()
        self.source = self.root / "tile_0.png"

    def test_failed_upload_and_concurrent_writers(self):
        with patch.object(detail, "upload", side_effect=RuntimeError("upload failed")):
            with self.assertRaisesRegex(RuntimeError, "upload failed"):
                detail.reference_url(self.cache, "crop", self.source)

        barrier = threading.Barrier(2)
        def upload(path):
            barrier.wait(timeout=5)
            return str(path)

        with patch.object(detail, "upload", side_effect=upload), concurrent.futures.ThreadPoolExecutor(2) as pool:
            urls = list(pool.map(lambda path: detail.reference_url(self.cache, "crop", path), ["first", "second"]))
        self.assertIn(urls[0], ["first", "second"])
        self.assertEqual(urls[0], urls[1])
        self.assertEqual(detail.reference_url(self.cache, "crop", self.source), urls[0])

    @unittest.skipUnless(Image, "the helper's Pillow dependency is required for image decoding")
    def test_unknown_outcome_retries_the_identical_hosted_request(self):
        Image.new("RGB", (8, 6), "green").save(self.source)
        attempts = []
        def generate(args, body):
            staged = Path(body["out"])
            attempts.append((args, {k: v for k, v in body.items() if k != "out"}, staged))
            if len(attempts) == 1:
                staged.write_bytes(b"unfinished local download")
                return {"ok": False, "error": {"code": "outcome_unknown"}}
            self.assertFalse(staged.exists())
            shutil.copyfile(self.source, staged)
            return {"ok": True, "status": "done", "result": {}}

        with patch.object(detail, "upload", return_value="green-url"), patch.object(detail, "run", side_effect=generate), patch.object(detail.time, "sleep"):
            out = detail.tile((0, self.source), self.cache, "ink", "room")
        self.assertEqual(attempts[0][:2], attempts[1][:2])
        self.assertNotEqual(attempts[0][2], attempts[1][2])
        self.assertEqual(out.read_bytes(), self.source.read_bytes())

    @unittest.skipUnless(Image, "the helper's Pillow dependency is required for image decoding")
    def test_tile_inputs_retries_and_previous_results(self):
        def source(colour):
            Image.new("RGB", (8, 6), colour).save(self.source)

        def generate(args, body):
            self.assertEqual(args[:3], ["assets", "generate-image", "--idempotency-key"])
            self.assertNotIn("idempotencyKey", body)
            calls.append((args[3], body["referenceImageUrl"]))
            if fail[0]:
                Path(body["out"]).write_bytes(b"unfinished image")
                return {"ok": False, "error": {"code": "fixture_stop"}}
            shutil.copyfile(self.source, body["out"])
            return {"ok": True, "status": "done", "result": {}}

        def tile(style="ink", run="room"):
            return detail.tile((0, self.source), self.cache, style, run)

        calls, fail = [], [False]
        legacy = self.root / "tile_0_paint.png"
        legacy.write_bytes(b"previous work")
        source("red")
        with patch.object(detail, "upload", side_effect=["red-url", "blue-url"]) as uploads, patch.object(detail, "run", side_effect=generate):
            red = tile()
            self.assertEqual(tile(), red)
            self.assertEqual(len(calls), 1)
            source("blue")
            blue, new_style, new_id = tile(), tile(style="chalk"), tile(run="room-two")
            self.assertEqual(len({red, blue, new_style, new_id}), 4)
            self.assertEqual(len({key for key, _ in calls}), 4)
            self.assertEqual([url for _, url in calls], ["red-url", "blue-url", "blue-url", "blue-url"])
            fail[0] = True
            with self.assertRaisesRegex(RuntimeError, "fixture_stop"):
                tile(style="unfinished")
            fail[0] = False
            finished = tile(style="unfinished")
            self.assertEqual(calls[-2], calls[-1])
            with Image.open(finished) as image:
                self.assertEqual(image.getpixel((0, 0)), (0, 0, 255))
            source("red")
            self.assertEqual(tile(), red)
            self.assertEqual(len(calls), 6)
            self.assertEqual(uploads.call_count, 2)
        self.assertEqual(legacy.read_bytes(), b"previous work")


if __name__ == "__main__":
    unittest.main()
