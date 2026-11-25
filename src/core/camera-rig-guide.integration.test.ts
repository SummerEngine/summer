import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const editor = process.env.SUMMER_EDITOR_BIN;

it.runIf(Boolean(editor))("keeps the camera-rigs guide's board centered in the overhead and isometric views", () => {
  const guide = readFileSync(new URL("../../library/skills/camera-rigs/SKILL.md", import.meta.url), "utf8");
  const section = guide.split("## Orthographic top-down 3D")[1]!.split("\n## ")[0]!;
  const examples = [...section.matchAll(/ops=(\[[\s\S]*?\])\)/g)].map(match => JSON.parse(match[1]!));
  expect(examples).toHaveLength(2);
  const project = mkdtempSync(join(tmpdir(), "camera-rig-guide-"));
  try {
    writeFileSync(join(project, "project.godot"), "config_version=5\n");
    writeFileSync(join(project, "examples.json"), JSON.stringify(examples));
    writeFileSync(join(project, "verify.gd"), `extends SceneTree

func _initialize() -> void:
	call_deferred("measure")

func measure() -> void:
	var camera := Camera3D.new()
	root.add_child(camera)
	var distances := []
	for example in JSON.parse_string(FileAccess.get_file_as_string("res://examples.json")):
		for op in example:
			camera.set(op.key, str_to_var(op.value) if op.value is String else op.value)
		var centre := root.get_visible_rect().get_center()
		var ground = Plane(Vector3.UP).intersects_ray(camera.project_ray_origin(centre), camera.project_ray_normal(centre))
		distances.append(ground.length() if ground != null else -1.0)
	FileAccess.open("res://distances.json", FileAccess.WRITE).store_string(JSON.stringify(distances))
	quit()
`);
    execFileSync(editor!, ["--headless", "--path", project, "--summer-no-api", "--summer-no-publish", "--script", "res://verify.gd"], {
      env: { HOME: project, PATH: process.env.PATH, SUMMER_NO_TELEMETRY: "1" }, timeout: 15000,
    });
    const distances: number[] = JSON.parse(readFileSync(join(project, "distances.json"), "utf8"));
    expect(distances).toHaveLength(2);
    for (const distance of distances) {
      expect(distance).toBeGreaterThanOrEqual(0);
      expect(distance).toBeLessThan(0.001);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
