import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fakeEngine } from "../../../test-helpers/seeing-engine.js";
import { zoom } from "./seeing.js";

const binary = process.env.SUMMER_EDITOR_BIN;

it.runIf(Boolean(binary))("the production crop camera projects both ends of horizontal and vertical seams", async () => {
  const project = mkdtempSync(join(tmpdir(), "summer-zoom-seams-"));
  try {
    writeFileSync(join(project, "project.godot"), "config_version=5\n");
    writeFileSync(join(project, "board.tscn"), '[gd_scene format=3]\n[node name="Board" type="Node3D"]\n');
    const cases = [];
    for (const horizontal of [false, true]) {
      for (const thickness of [1, 4]) {
        const reference = horizontal ? [192, 320] : [320, 192];
        const region = horizontal ? [0.125, 0.625, 0.75, thickness / 320] : [0.625, 0.125, thickness / 320, 0.75];
        const tag = (horizontal ? "horizontal" : "vertical") + thickness;
        const client = fakeEngine({ projectRoot: project });
        await zoom(client, {
          scenePath: "res://board.tscn",
          camera_position: "Vector3(0,0,0)",
          camera_look_at: "Vector3(0,0,-1)",
          fov: 60, reference_size: reference, region, max_size: 144,
        });
        const dir = join(project, tag);
        mkdirSync(dir);
        writeFileSync(join(dir, "wrapper.tscn"), client.wrappers[0]!);
        writeFileSync(join(dir, "config.json"), JSON.stringify(client.configs[0]));
        cases.push({ tag, reference, region, horizontal });
      }
    }
    writeFileSync(join(project, "cases.json"), JSON.stringify(cases));
    writeFileSync(join(project, "inspect.gd"), `extends SceneTree
func _initialize(): check.call_deferred()
func check():
	var results := []
	for spec in JSON.parse_string(FileAccess.get_file_as_string("res://cases.json")):
		var wrapper = load("res://" + spec.tag + "/wrapper.tscn").instantiate()
		root.add_child(wrapper)
		var viewport: SubViewport = wrapper.find_children("*", "SubViewport", true, false)[0]
		var crop := viewport.get_camera_3d()
		var reference := SubViewport.new()
		reference.size = Vector2i(spec.reference[0], spec.reference[1])
		root.add_child(reference)
		var camera := Camera3D.new()
		camera.fov = 60
		reference.add_child(camera)
		var origin := Vector2(spec.region[0], spec.region[1])
		var span := Vector2(spec.region[2], spec.region[3])
		for fraction in [0.25, 0.5, 0.75]:
			var uv := Vector2(fraction, 0.5) if spec.horizontal else Vector2(0.5, fraction)
			var world := camera.project_position((origin + uv * span) * Vector2(reference.size), 5)
			var result := crop.unproject_position(world) / Vector2(viewport.size)
			results.append({"case":spec.tag, "projection_error":result.distance_to(uv)})
		wrapper.free()
		reference.free()
	FileAccess.open("res://result.json", FileAccess.WRITE).store_string(JSON.stringify(results))
	quit()
`);
    execFileSync(binary!, ["--headless", "--path", project, "--audio-driver", "Dummy", "--script", "res://inspect.gd"], {
      env: { ...process.env, HOME: project, SUMMER_NO_TELEMETRY: "1", DO_NOT_TRACK: "1" }, timeout: 15_000,
    });
    const results = JSON.parse(readFileSync(join(project, "result.json"), "utf8")) as Array<{ case: string; projection_error: number }>;
    expect(results).toHaveLength(cases.length * 3);
    for (const sample of results) expect(sample.projection_error, sample.case).toBeLessThan(0.0001);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 20_000);
