"""Run with python3 -B -m unittest discover -s tests/live/painted-blockout-preview."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from PIL import Image


PREVIEW = (Path(__file__).resolve().parents[3] / "library/skills/painted-25d-world"
           / "_building-blocks/tools/preview.py")
RED = (255, 30, 30)


class PreviewTest(unittest.TestCase):
    def draw(self, obj):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            concept = path / "concept.png"
            spec = path / "blockout.json"
            result = path / "wireframe.png"
            Image.new("RGB", (128, 128)).save(concept)
            spec.write_text(json.dumps({"objects": [obj]}))
            # A side view has +X right, +Y up, and eight pixels per metre.
            env = {**os.environ, "PAINT_W": "16", "PAINT_ELEV": "0", "PAINT_AZIM": "0",
                   "PAINT_IMG": "128,128", "PAINT_C": "0,0,0"}
            subprocess.run([sys.executable, "-B", PREVIEW, concept, spec, result], env=env, check=True)
            with Image.open(result) as image:
                return image.copy()

    def test_cone_rotates_and_scales_around_its_base(self):
        cone = {"kind": "cyl", "pos": [1, 0, 0], "height": 2, "r_top": 0, "r_bot": 0.75}
        self.assertEqual(self.draw(cone).getpixel((72, 48)), RED)
        tipped = self.draw({**cone, "rot_z": 90, "scale": [1, 1.5, 1]})
        self.assertEqual(tipped.getpixel((48, 64)), RED)
        self.assertNotEqual(tipped.getpixel((72, 48)), RED)

    def test_squashed_sphere_rotates_with_its_equator(self):
        sphere = {"kind": "sphere", "pos": [0, 0, 0], "radius": 2, "sy": 0.25}
        self.assertEqual(self.draw(sphere).getpixel((80, 64)), RED)
        tipped = self.draw({**sphere, "rot_z": 90, "scale": [1.5, 2, 1]})
        self.assertEqual(tipped.getpixel((64, 40)), RED)
        self.assertNotEqual(tipped.getpixel((80, 64)), RED)
