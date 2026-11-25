"""SUMMER_EDITOR_BIN=/path/to/Summer python3 -m unittest discover -s tests/live/painted-capture"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from PIL import Image


HERE = Path(__file__).resolve().parent
BLOCKS = HERE.parents[2] / "library/skills/painted-25d-world/_building-blocks"
EDITOR = os.environ.get("SUMMER_EDITOR_BIN")
PNG_HELPERS = {
    "capture_paint_view": "PAINT_VIEW_SAVED",
    "paintcam_check": "PAINTCAM_SAVED",
}


@unittest.skipUnless(EDITOR, "set SUMMER_EDITOR_BIN to a rendering Summer editor")
class CaptureTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.project = Path(self.tmp.name)
        painted = self.project / "painted"
        painted.mkdir()
        for script in (*PNG_HELPERS, "painted_world", "painted_location"):
            shutil.copy(BLOCKS / (script + ".gd"), painted)
        shutil.copy(BLOCKS / "paint_projection.gdshader", painted)
        shutil.copy(HERE / "level.tscn", self.project)
        (self.project / "player.gd").write_text(
            "extends CharacterBody3D\nvar input_override := Vector2.ZERO\n"
        )
        (self.project / "project.godot").write_text(
            'config_version=5\n[application]\nconfig/name="PaintedCaptureTest"\n'
            '[display]\nwindow/size/viewport_width=96\nwindow/size/viewport_height=64\n'
            '[rendering]\nrenderer/rendering_method="gl_compatibility"\n'
        )

    def play(self, scene, *args):
        return subprocess.run(
            [EDITOR, "--summer-offscreen", "--summer-no-api", "--summer-no-publish",
             "--audio-driver", "Dummy", "--path", str(self.project), scene, "--", *args],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=25,
        )

    def png(self, script, target):
        scene = (
            '[gd_scene load_steps=3 format=3]\n'
            f'[ext_resource type="Script" path="res://painted/{script}.gd" id="1"]\n'
            '[ext_resource type="PackedScene" path="res://level.tscn" id="2"]\n'
            '[node name="Capture" type="Node"]\nscript = ExtResource("1")\n'
            'level = ExtResource("2")\nsize = Vector2i(96, 64)\n'
            f'out_path = {json.dumps(target)}\n'
        )
        (self.project / "capture.tscn").write_text(scene)
        return self.play("res://capture.tscn")

    def assert_frame(self, file, fmt):
        with Image.open(file) as image:
            self.assertEqual((image.format, image.size), (fmt, (96, 64)))
            red, green, blue = image.convert("RGB").getpixel((48, 32))
            self.assertGreater(green, 2 * max(red, blue))

    def test_png_receipts_match_the_file(self):
        for script, marker in PNG_HELPERS.items():
            with self.subTest(script=script):
                target = self.project / (script + ".png")
                ok = self.png(script, "res://" + target.name)
                self.assertEqual(ok.returncode, 0, ok.stdout)
                self.assertIn(marker, ok.stdout)
                self.assert_frame(target, "PNG")
                target.unlink()
                target.mkdir()
                failed = self.png(script, "res://" + target.name)
                self.assertNotEqual(failed.returncode, 0, failed.stdout)
                self.assertNotIn(marker, failed.stdout)
                self.assertIn(target.name, failed.stdout)
                self.assertTrue(target.is_dir())

    def test_shot_batch_stops_at_the_failed_file(self):
        shots = self.project / "shots"
        ok = self.play("res://level.tscn", "--shots=" + str(shots))
        self.assertEqual(ok.returncode, 0, ok.stdout)
        for name in ("first", "second", "third"):
            self.assert_frame(shots / (name + ".jpg"), "JPEG")
        (shots / "first.jpg").unlink()
        (shots / "second.jpg").unlink()
        (shots / "second.jpg").mkdir()
        (shots / "third.jpg").write_bytes(b"previous shot")
        failed = self.play("res://level.tscn", "--shots=" + str(shots))
        self.assertNotEqual(failed.returncode, 0, failed.stdout)
        self.assertIn("second.jpg", failed.stdout)
        self.assert_frame(shots / "first.jpg", "JPEG")
        self.assertEqual((shots / "third.jpg").read_bytes(), b"previous shot")

    def test_invalid_shot_directory(self):
        blocker = self.project / "file"
        blocker.write_bytes(b"existing file")
        directory = blocker / "shots"
        failed = self.play("res://level.tscn", "--shots=" + str(directory))
        self.assertNotEqual(failed.returncode, 0, failed.stdout)
        self.assertIn(str(directory), failed.stdout)
        self.assertFalse(directory.exists())
        self.assertEqual(blocker.read_bytes(), b"existing file")
