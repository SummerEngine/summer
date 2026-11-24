import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildPlacementScript } from "./placement-script.js";

const binary = process.env.SUMMER_BIN;

it.skipIf(!binary)("keeps physics and visual rays in the same Godot world across viewport boundaries", () => {
  const project = mkdtempSync(join(tmpdir(), "summer-ray-worlds-"));
  try {
    writeFileSync(join(project, "project.godot"), 'config_version=5\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
    writeFileSync(join(project, "probe.gd"), buildPlacementScript({}));
    writeFileSync(join(project, "check.gd"), `extends SceneTree

func viewport(parent, name_, own):
	var view = SubViewport.new()
	view.name = name_
	view.own_world_3d = own
	parent.add_child(view)
	return view

func box(parent, z, solid):
	var body = StaticBody3D.new()
	body.name = "Box"
	body.position.z = z
	parent.add_child(body)
	var mesh = MeshInstance3D.new()
	mesh.name = "Mesh"
	mesh.mesh = BoxMesh.new()
	body.add_child(mesh)
	if solid:
		var shape = CollisionShape3D.new()
		shape.shape = BoxShape3D.new()
		body.add_child(shape)

func _initialize():
	call_deferred("check")

func check():
	var scene = Node.new()
	box(scene, -8, true)
	var shared = viewport(scene, "Shared", false)
	box(shared, -5, false)
	var own = viewport(scene, "Own", true)
	box(own, -3, true)
	var subject = Node3D.new()
	subject.name = "Subject"
	own.add_child(subject)
	var p = load("res://probe.gd").new()
	var rows = []
	for live in [false, true]:
		if live:
			root.add_child(scene)
			await physics_frame
			await physics_frame
		var ray = {"direction": [0, 0, -1]}
		var ordinary = p._cmd_raycast(scene, live, ray)
		var viewport_root = p._cmd_raycast(own, live, ray)
		var attached = p._cmd_raycast(scene, live, {"from_subject": "Own/Subject", "direction": [0, 0, -1]})
		var aimed = p._cmd_raycast(scene, live, {"from_subject": "Own/Subject", "surface": "Own/Box"})
		var foreign = p._cmd_raycast(scene, live, {"from_subject": "Own/Subject", "surface": "Box"})
		rows.append([ordinary.visual.path, viewport_root.visual.path, attached.visual.path, aimed.visual.path,
				foreign.failure_reason, ordinary.get("physics", {}).get("path"), attached.get("physics", {}).get("path")])
	var file = FileAccess.open("res://result.json", FileAccess.WRITE)
	file.store_string(JSON.stringify(rows))
	file.close()
	scene.free()
	quit()
`);
    execFileSync(binary!, ["--headless", "--path", project, "--summer-no-api", "--summer-no-publish", "--script", "res://check.gd"], {
      cwd: project,
      env: { HOME: project, XDG_CONFIG_HOME: project, XDG_DATA_HOME: project, APPDATA: project, PATH: process.env.PATH },
      timeout: 30_000,
    });
    const visual = ["Shared/Box/Mesh", "Box/Mesh", "Own/Box/Mesh", "Own/Box/Mesh", "surface_has_no_visual_bounds"];
    expect(JSON.parse(readFileSync(join(project, "result.json"), "utf8"))).toEqual([
      [...visual, null, null],
      [...visual, "Box", "Own/Box"],
    ]);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 35_000);
