import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { lookAtBasis, type Vec3 } from "./math.js";

const binary = process.env.SUMMER_EDITOR_BIN;

it.runIf(Boolean(binary))("projects the same right axis with the camera scorer and the shipped render kernel", () => {
  const project = mkdtempSync(join(tmpdir(), "summer-camera-pole-"));
  try {
    writeFileSync(join(project, "project.godot"), "config_version=5\n");
    copyFileSync(new URL("../../../../assets/seeing/seeing_probe.gd", import.meta.url), join(project, "probe.gd"));
    writeFileSync(join(project, "inspect.gd"), `extends SceneTree
func _initialize():
	var output := []
	var probe = load("res://probe.gd").new()
	for sign_y in [-1.0, 1.0]:
		for x in [0.0, 0.03, 0.044754, 0.044755, 0.055, 0.5]:
			var target := Vector3(x, sign_y, 0)
			var direction := target.normalized()
			var float_cutoff := PackedFloat32Array([0.999])[0]
			var up := Vector3.FORWARD if absf(direction.y) > float_cutoff else Vector3.UP
			var native := Transform3D.IDENTITY.looking_at(target, up).basis.x
			var render: Vector3 = probe._look_basis(Vector3.ZERO, target).x
			output.append({"target":[x, sign_y, 0], "native":[native.x, native.y, native.z], "render":[render.x, render.y, render.z]})
	probe.free()
	FileAccess.open("res://result.json", FileAccess.WRITE).store_string(JSON.stringify(output))
	quit()
`);
    execFileSync(binary!, ["--headless", "--path", project, "--script", "res://inspect.gd"], {
      env: { ...process.env, HOME: project, SUMMER_NO_TELEMETRY: "1", DO_NOT_TRACK: "1" }, timeout: 15_000,
    });
    const rows = JSON.parse(readFileSync(join(project, "result.json"), "utf8")) as { target: Vec3; native: Vec3; render: Vec3 }[];
    expect(rows).toHaveLength(12);
    for (const { target, native, render } of rows) {
      const scored = lookAtBasis([0, 0, 0], target).x;
      for (const axis of [0, 1, 2] as const) {
        expect(render[axis]).toBeCloseTo(native[axis], 5);
        expect(scored[axis]).toBeCloseTo(native[axis], 5);
      }
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 20_000);
