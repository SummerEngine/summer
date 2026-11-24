import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildWrapperScene, loadKernelSource } from "./probe.js";

const binary = process.env.SUMMER_EDITOR_BIN;

it.runIf(Boolean(binary))("scores the full depth between Godot's clip planes, including off-axis geometry", () => {
  const project = mkdtempSync(join(tmpdir(), "summer-seeing-clip-"));
  try {
    writeFileSync(join(project, "project.godot"), "config_version=5\n");
    const pose = { position: [0, 0, 0], look_at: [0, 0, -1], fov: 90 };
    const cases = [];
    for (const depth of [1, 800, 1000]) {
      const scene = `res://wall${depth}.tscn`;
      writeFileSync(join(project, `wall${depth}.tscn`), `[gd_scene format=3]
[sub_resource type="BoxMesh" id="Wall"]
size = Vector3(2500, 2500, 0.1)
[node name="Wall" type="MeshInstance3D"]
position = Vector3(0, 0, -${depth})
mesh = SubResource("Wall")
`);
      for (const mode of ["analyze", "render"]) {
        const name = mode + depth;
        cases.push(name);
        const dir = join(project, name);
        mkdirSync(dir);
        writeFileSync(join(dir, "wrapper.tscn"), buildWrapperScene(scene, loadKernelSource()));
        const config = mode === "analyze" ? {
          tasks: ["measure"], measure: { grid_cols: 9, grid_rows: 9, aspect: 1 },
          candidates: [{ ...pose, adjust: false, samples: [] }], image_check: { size: [36, 36] },
        } : { canvas: [72, 36], tiles: [
          { kind: "shot", rect: [0, 0, 36, 36], pose },
          { kind: "shot", rect: [36, 0, 36, 36], pose: { ...pose, look_at: [0, 0, -1400] } },
        ] };
        writeFileSync(join(dir, "config.json"), JSON.stringify({ mode, scene_path: scene, ...config }));
      }
    }
    writeFileSync(join(project, "cases.json"), JSON.stringify(cases));
    writeFileSync(join(project, "check.gd"), `extends SceneTree
func _initialize(): run.call_deferred()
func run():
	var results = {}
	for name in JSON.parse_string(FileAccess.get_file_as_string("res://cases.json")):
		var vp := SubViewport.new()
		vp.size = Vector2i(36, 36)
		vp.own_world_3d = true
		root.add_child(vp)
		var wrapper = load("res://" + name + "/wrapper.tscn").instantiate()
		vp.add_child(wrapper)
		var native := Camera3D.new()
		native.near = 2
		native.far = 900
		native.fov = 90
		vp.add_child(native)
		native.make_current()
		await process_frame
		await process_frame
		var tiles: Array = wrapper.find_children("*", "SubViewport", true, false)
		var generated: Camera3D = tiles[0].get_camera_3d()
		var result := {"near":generated.near, "far":generated.far}
		if tiles.size() == 2:
			result.long_far = tiles[1].get_camera_3d().far
		if name.begins_with("analyze"):
			var measurement = JSON.parse_string(FileAccess.get_file_as_string("res://" + name + "/result.json")).measurements[0]
			result.grid = measurement.get("grid", measurement.get("rejected", "missing"))
			var expected := ""
			var depth := float(name.trim_prefix("analyze"))
			for y in 9:
				for x in 9:
					var point := native.project_position(Vector2(x * 4 + 2, y * 4 + 2), depth)
					expected += "H" if native.is_position_in_frustum(point) else "."
			result.expected = expected
		results[name] = result
		vp.free()
	FileAccess.open("res://observed.json", FileAccess.WRITE).store_string(JSON.stringify(results))
	quit()
`);
    execFileSync(binary!, ["--headless", "--path", project, "--summer-no-api", "--summer-no-publish", "--audio-driver", "Dummy", "--script", "res://check.gd"], {
      cwd: project, env: { ...process.env, HOME: project, SUMMER_NO_TELEMETRY: "1" }, timeout: 15000, stdio: "pipe",
    });
    const results = JSON.parse(readFileSync(join(project, "observed.json"), "utf8"));
    for (const name of cases) {
      expect(results[name], name).toMatchObject({ near: 2, far: 900 });
      if (name.startsWith("render")) expect(results[name].long_far, name).toBe(14000);
      if (name.startsWith("analyze")) {
        expect(results[name].expected, name).toBe((name === "analyze800" ? "H" : ".").repeat(81));
        expect(results[name].grid, name).toBe(results[name].expected);
      }
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 20000);
