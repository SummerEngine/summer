import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildPlacementScript } from "./placement-script.js";

const binary = process.env.SUMMER_BIN;

it.skipIf(!binary)("measures sparse scenes and never promotes an incomplete scan to a placement result", () => {
  const project = mkdtempSync(join(tmpdir(), "summer-placement-budget-"));
  try {
    writeFileSync(join(project, "project.godot"), 'config_version=5\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
    writeFileSync(join(project, "probe.gd"), buildPlacementScript({}));
    writeFileSync(join(project, "check.gd"), `extends SceneTree

func _initialize():
	call_deferred("check")

func box(parent, mesh, label, x):
	var node = MeshInstance3D.new()
	node.name = label
	node.mesh = mesh
	node.position.x = x
	parent.add_child(node)
	return node

func check():
	var probe = load("res://probe.gd").new()
	var mesh = BoxMesh.new()
	mesh.size = Vector3(2, 2, 2)
	var scene = Node3D.new()
	var far = box(scene, mesh, "Far", 90)
	var branch = Node.new()
	scene.add_child(branch)
	for i in 20000:
		branch.add_child(Node.new())
	var near_box = box(scene, mesh, "Near", 0)
	var args = {"nodes": [{"path": "."}]}
	var ray = {"origin": [110, 0, 0], "direction": [-1, 0, 0], "max_distance": 150, "evidence": "visual_aabb"}
	var actual = (near_box.transform * near_box.get_aabb()).merge(far.transform * far.get_aabb())
	var results = {"actual": [actual.position.x, actual.end.x]}
	results["bounds"] = probe._cmd_bounds(scene, false, args).nodes[0].intervals[0]
	results["ray"] = probe._cmd_raycast(scene, false, ray).visual
	branch.free()
	for i in 19998:
		var obj = MeshInstance3D.new()
		obj.mesh = mesh
		scene.add_child(obj)
	results["limit_count"] = probe._geoms(scene, scene, []).size()
	box(scene, mesh, "Extra", 0)
	results["dense"] = probe._cmd_bounds(scene, false, args)
	results["dense_ray"] = probe._cmd_raycast(scene, false, ray)
	results["dense_blockers"] = probe._cmd_blockers(scene, false, {"path": ".", "direction": [1, 0, 0]})
	ray.surface = "Far"
	results["scoped"] = probe._cmd_raycast(scene, false, ray)
	ray.exclude = ["."]
	results["excluded"] = probe._cmd_raycast(scene, false, ray)
	ray.erase("surface")
	ray.erase("exclude")

	# A physics hit remains authoritative when the visual comparison is incomplete.
	root.add_child(scene)
	var body = StaticBody3D.new()
	body.name = "Wall"
	body.position.x = 90
	scene.add_child(body)
	var collider = CollisionShape3D.new()
	collider.shape = BoxShape3D.new()
	body.add_child(collider)
	await physics_frame
	await physics_frame
	ray.evidence = "auto"
	results["physics"] = probe._cmd_raycast(scene, true, ray)
	ray.origin = [110, 50, 0]
	results["miss"] = probe._cmd_raycast(scene, true, ray)
	ray.evidence = "physics"
	results["physics_only_miss"] = probe._cmd_raycast(scene, true, ray)
	scene.free()
	var output = FileAccess.open("res://result.json", FileAccess.WRITE)
	output.store_string(JSON.stringify(results))
	output.close()
	quit()
`);
    execFileSync(binary!, ["--headless", "--path", project, "--summer-no-api", "--summer-no-publish", "--script", "res://check.gd"], {
      timeout: 45_000,
      env: { ...process.env, HOME: project },
    });
    const result = JSON.parse(readFileSync(join(project, "result.json"), "utf8"));
    expect(result.actual).toEqual([-1, 91]);
    expect(result.bounds).toEqual(result.actual);
    expect(result.ray).toMatchObject({ path: "Far", distance: 19 });
    expect(result.limit_count).toBe(20000);
    for (const key of ["dense", "dense_ray", "dense_blockers", "miss"]) {
      expect(result[key]).toMatchObject({ ok: false, failure_reason: "geometry_scan_limit" });
    }
    expect(result.scoped).toMatchObject({ ok: true, visual: { path: "Far", distance: 19 } });
    expect(result.excluded).toMatchObject({ ok: true });
    expect(result.excluded).not.toHaveProperty("visual");
    expect(result.physics).toMatchObject({ ok: true, physics: { path: "Wall" }, visual_truncated: true });
    expect(result.physics).not.toHaveProperty("visual");
    expect(result.physics_only_miss).toMatchObject({ ok: true, physics_available: true });
    expect(result.physics_only_miss).not.toHaveProperty("physics");
    expect(result.physics_only_miss).not.toHaveProperty("visual_truncated");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 50_000);
