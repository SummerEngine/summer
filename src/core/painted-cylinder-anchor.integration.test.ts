import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const editor = process.env.SUMMER_EDITOR_BIN;

it.runIf(Boolean(editor))("builds cylinders from their authored base centre", () => {
  const project = mkdtempSync(join(tmpdir(), "painted-cylinder-"));
  try {
    copyFileSync(new URL("../../library/skills/painted-25d-world/_building-blocks/blockout_builder.gd", import.meta.url), join(project, "builder.gd"));
    writeFileSync(join(project, "project.godot"), "config_version=5\n");
    const objects = [false, true].flatMap((solid) => [0, 90].map((rot_z) => ({
      kind: "cyl", name: `Post${solid}${rot_z}`, color: "bark", solid,
      pos: [3, 5, -7], height: 4, r_bot: 0.6, r_top: 0.3,
      rot_z, scale: rot_z === 0 ? [1, 1, 1] : [0.75, 2, 1.5],
    })));
    writeFileSync(join(project, "spec.json"), JSON.stringify({ objects }));
    writeFileSync(join(project, "read.gd"), `extends SceneTree

func _initialize():
	call_deferred("measure")

func measure():
	var builder = preload("res://builder.gd").new()
	builder.spec = "res://spec.json"
	root.add_child(builder)
	var rims := {}
	for mesh: MeshInstance3D in builder.find_children("*", "MeshInstance3D", true, false):
		var points: PackedVector3Array = mesh.mesh.surface_get_arrays(0)[Mesh.ARRAY_VERTEX]
		var lo := Vector3(INF, INF, INF)
		var hi := Vector3(-INF, -INF, -INF)
		for point in points:
			if is_equal_approx(point.y, -mesh.mesh.height * 0.5):
				var p := mesh.to_global(point)
				lo = lo.min(p)
				hi = hi.max(p)
		var base := (lo + hi) * 0.5
		rims[mesh.name] = [base.x, base.y, base.z]
	FileAccess.open("res://result.json", FileAccess.WRITE).store_string(JSON.stringify(rims))
	quit()
`);
    execFileSync(editor!, ["--headless", "--path", project, "--audio-driver", "Dummy", "--summer-no-api", "--summer-no-publish", "--script", "res://read.gd"], {
      env: { ...process.env, HOME: project, SUMMER_NO_TELEMETRY: "1" }, timeout: 15_000,
    });
    const rims = JSON.parse(readFileSync(join(project, "result.json"), "utf8")) as Record<string, number[]>;
    for (const { name, pos } of objects) {
      for (let axis = 0; axis < 3; axis++) expect(rims[name]![axis], name).toBeCloseTo(pos[axis]!, 5);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
