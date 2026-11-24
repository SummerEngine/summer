import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const editor = process.env.SUMMER_EDITOR_BIN;

it.runIf(Boolean(editor))("preserves the direction of short aims and rejects coincident renderer coordinates", () => {
  const project = mkdtempSync(join(tmpdir(), "summer-camera-aim-"));
  try {
    copyFileSync(new URL("../../../../assets/seeing/seeing_probe.gd", import.meta.url), join(project, "probe.gd"));
    writeFileSync(join(project, "project.godot"), "config_version=5\n");
    writeFileSync(join(project, "check.gd"), `extends SceneTree
func _initialize() -> void:
	var probe = preload("res://probe.gd").new()
	var directions: Array = []
	for distance in [8.0, 0.0000005, 1.0e-25]:
		var basis: Basis = probe._look_basis(Vector3.ZERO, Vector3(distance, 0, 0))
		directions.append((-basis.z).is_equal_approx(Vector3.RIGHT))
	var eye := Vector3(65536, 0, 0)
	var aim := Vector3(65536.0001, 0, 0)
	var distinct: bool = eye != aim
	var forward: Vector3 = probe._camera_direction(eye, aim)
	var out := FileAccess.open("res://check.json", FileAccess.WRITE)
	out.store_string(JSON.stringify({"directions": directions, "distinct": distinct, "right": forward == Vector3.RIGHT, "zero": forward == Vector3.ZERO}))
	out.close()
	probe.free()
	quit()
`);
    const home = join(project, "home");
    mkdirSync(home);
    execFileSync(resolve(editor!), ["--headless", "--path", project, "--audio-driver", "Dummy", "--summer-no-api", "--summer-no-publish", "--script", "res://check.gd"], {
      env: { ...process.env, HOME: home, XDG_DATA_HOME: home, SUMMER_NO_TELEMETRY: "1" }, timeout: 30000,
    });
    const result = JSON.parse(readFileSync(join(project, "check.json"), "utf8"));
    expect(result.directions).toEqual([true, true, true]);
    expect(result.right).toBe(result.distinct);
    expect(result.zero).toBe(!result.distinct);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 35_000);
