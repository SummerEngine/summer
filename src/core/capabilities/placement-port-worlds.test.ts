import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildPlacementScript } from "./placement-script.js";

const binary = process.env.SUMMER_BIN;

it.skipIf(!binary)("resolves live and detached ports against their effective World3D", () => {
  const project = mkdtempSync(join(tmpdir(), "summer-port-worlds-"));
  try {
    writeFileSync(join(project, "project.godot"), 'config_version=5\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
    writeFileSync(join(project, "probe.gd"), buildPlacementScript({}));
    writeFileSync(join(project, "check.gd"), `extends SceneTree

func piece(parent, name_):
	var node = Node3D.new()
	node.name = name_
	parent.add_child(node)
	var marker = Marker3D.new()
	marker.name = "Port"
	node.add_child(marker)
	return node

func viewport(parent, name_, own):
	var view = SubViewport.new()
	view.name = name_
	view.own_world_3d = own
	parent.add_child(view)
	return view

func inspect(p, scene, sub, target, port = "Port"):
	var answer = p._cmd_ports(scene, {"subject": sub, "target": target, "subject_port": port, "target_port": "Port"})
	return answer.get("failure_reason", "ok" if answer.ok else "unexpected error")

func _initialize():
	call_deferred("check")

func check():
	var scene = Node3D.new()
	var subject = piece(scene, "Subject")
	var shared = viewport(scene, "Shared", false)
	var target = piece(shared, "Target")
	target.get_node("Port").top_level = true
	piece(subject, "Carrier")
	var fixed_marker = piece(subject, "FixedMarker")
	fixed_marker.get_node("Port").top_level = true
	var fixed_carrier = piece(subject, "FixedCarrier")
	fixed_carrier.top_level = true
	var plain = Node.new()
	plain.name = "Plain"
	subject.add_child(plain)
	piece(plain, "Piece")
	var own = viewport(scene, "Own", true)
	piece(own, "Target")
	var inner = viewport(subject, "Inner", true)
	piece(inner, "Nested")
	var tube = CylinderMesh.new()
	tube.cap_top = false
	tube.cap_bottom = false
	var mesh = MeshInstance3D.new()
	mesh.mesh = tube
	inner.add_child(mesh)
	var flat_instances = MultiMesh.new()
	flat_instances.mesh = tube
	var flat = MultiMeshInstance3D.new()
	flat.multimesh = flat_instances
	inner.add_child(flat)
	var lib = MeshLibrary.new()
	lib.create_item(0)
	lib.set_item_mesh(0, tube)
	var grid = GridMap.new()
	grid.mesh_library = lib
	grid.set_cell_item(Vector3i.ZERO, 0)
	inner.add_child(grid)
	var named_world = World3D.new()
	for n in ["Left", "Right"]:
		var view = viewport(scene, n, false)
		view.world_3d = named_world
		piece(view, "Piece")
	var p = load("res://probe.gd").new()
	var observations = []
	for attached in [false, true]:
		if attached:
			root.add_child(scene)
			await process_frame
		observations.append([
			inspect(p, scene, "Subject", "Shared/Target"),
			inspect(p, scene, "Subject", "Shared/Target", "Carrier/Port"),
			inspect(p, scene, "Subject", "Shared/Target", "FixedMarker/Port"),
			inspect(p, scene, "Subject", "Shared/Target", "FixedCarrier/Port"),
			inspect(p, scene, "Subject", "Shared/Target", "Plain/Piece/Port"),
			inspect(p, scene, "Subject", "Own/Target"),
			inspect(p, scene, "Subject", "Shared/Target", "Inner/Nested/Port"),
			inspect(p, scene, "Left/Piece", "Right/Piece"),
			p._resolve_port(scene, subject, 0, 10000, false).loops.size(),
			p._resolve_port(scene, mesh, 0, 10000, false).loops.size(),
			p._resolve_port(scene, grid, 0, 10000, false).loops.size(),
			p._resolve_port(scene, flat, 0, 10000, false).fail.failure_reason,
			p._resolve_port(scene, subject, "Port", 10000, true).others_total
		])
	var output = FileAccess.open("res://result.json", FileAccess.WRITE)
	output.store_string(JSON.stringify(observations))
	output.close()
	scene.free()
	quit()
`);
    execFileSync(binary!, ["--headless", "--path", project, "--summer-no-api", "--summer-no-publish", "--script", "res://check.gd"], {
      cwd: project,
      env: { HOME: project, XDG_CONFIG_HOME: project, XDG_DATA_HOME: project, APPDATA: project, PATH: process.env.PATH },
      timeout: 30_000,
    });
    const detached = "independent_subject_port";
    const expected = ["ok", "ok", detached, detached, detached, "different_world_3d", "different_world_3d", "ok", 0, 2, 2, "unsupported_multimesh_format", 1];
    expect(JSON.parse(readFileSync(join(project, "result.json"), "utf8"))).toEqual([expected, expected]);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 35_000);
