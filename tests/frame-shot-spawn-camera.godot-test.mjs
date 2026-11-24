// npm run build && node tests/frame-shot-spawn-camera.godot-test.mjs /path/to/Summer
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildWrapperScene, loadKernelSource } from "../dist/core/capabilities/seeing/probe.js";

const editor = process.argv[2];
assert(editor, "Pass a Godot or Summer editor executable");
const project = mkdtempSync(join(tmpdir(), "summer-spawn-eye-"));
try {
  const write = (path, data) => writeFileSync(join(project, path), data);
  const sources = [];
  const instances = [];
  const cases = [];
  for (const topLevel of [false, true]) {
    for (const offset of [0, 1]) {
      const name = `case_${Number(topLevel)}_${offset}`;
      const scene = `res://${name}/subject.tscn`;
      cases.push(name);
      mkdirSync(join(project, name));
      write(`${name}/subject.tscn`, `[gd_scene format=3]

[node name="Player" type="Node3D"]
[node name="Rig" type="Node3D" parent="."]
rotation = Vector3(0.17, 0.36, -0.06)
scale = Vector3(1.4, 1.1, 0.8)
[node name="Camera" type="Camera3D" parent="Rig"]
top_level = ${topLevel}
position = Vector3(0.15, 1.5, 3)
rotation = Vector3(0.03, -0.12, 0.15)
projection = ${Number(topLevel)}
h_offset = ${offset}
v_offset = ${0.2 * offset}
`);
      write(`${name}/wrapper.tscn`, buildWrapperScene(scene, loadKernelSource()));
      write(`${name}/config.json`, JSON.stringify({ mode: "analyze", scene_path: scene, spawn: "Rig", subjects: [], tasks: [] }));
      sources.push(`[ext_resource type="PackedScene" path="res://${name}/wrapper.tscn" id="${name}"]`);
      instances.push(`[node name="${name}" parent="." instance=ExtResource("${name}")]`);
    }
  }
  write("oracle.gd", `extends Node
func _ready():
	for wrapper in get_children():
		var camera: Camera3D = wrapper.get_node("Subject/Rig/Camera")
		var view := camera.get_camera_transform()
		var direction := -view.basis.z
		var expected := {"position": [view.origin.x, view.origin.y, view.origin.z], "forward": [direction.x, direction.y, direction.z]}
		FileAccess.open("res://%s/expected.json" % wrapper.name, FileAccess.WRITE).store_string(JSON.stringify(expected))
`);
  write("main.tscn", [
    "[gd_scene format=3]", '[ext_resource type="Script" path="res://oracle.gd" id="oracle"]',
    ...sources, '[node name="Cameras" type="Node3D"]', 'script = ExtResource("oracle")', ...instances, "",
  ].join("\n"));
  write("project.godot", 'config_version=5\n[application]\nrun/main_scene="res://main.tscn"\n');
  const home = join(project, "home");
  mkdirSync(home);
  execFileSync(resolve(editor), ["--headless", "--path", project, "--audio-driver", "Dummy", "--summer-no-api", "--summer-no-publish", "--quit-after", "8"], {
    env: { ...process.env, HOME: home, XDG_DATA_HOME: home, SUMMER_NO_TELEMETRY: "1" }, timeout: 30000,
  });
  for (const name of cases) {
    const read = (file) => JSON.parse(readFileSync(join(project, name, file), "utf8"));
    const analyzed = read("result.json");
    assert.equal(analyzed.ok, true);
    const expected = read("expected.json");
    for (const field of ["position", "forward"]) {
      assert.ok(expected[field].every((v, i) => Math.abs(v - analyzed.spawn.camera[field][i]) < 0.001), `${name} camera ${field}`);
    }
  }
  console.log("Four spawn-camera eyes and forward vectors agree with Godot.");
} finally {
  rmSync(project, { recursive: true, force: true });
}
