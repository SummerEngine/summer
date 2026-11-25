extends SceneTree


func _initialize():
	check.call_deferred()


func box(parent: Node, label: String, x: float, y := 0.0) -> MeshInstance3D:
	var mesh := MeshInstance3D.new()
	mesh.name = label
	mesh.mesh = BoxMesh.new()
	mesh.position = Vector3(x, y, 0)
	parent.add_child(mesh)
	return mesh


func check():
	var probe = preload("res://probe.gd").new()
	var scene := Node3D.new()
	root.add_child(scene)
	var reference := Node3D.new()
	reference.name = "Reference"
	scene.add_child(reference)
	box(reference, "Center", 0)
	var caster := box(reference, "Caster", 5)
	box(caster, "Badge", -5, 3)
	var bounds = {"nodes": [{"path": "Reference"}]}
	var ray = {"origin": [5, 0, 8], "direction": [0, 0, -1], "evidence": "visual_aabb"}
	for live in [true, false]:
		if not live:
			root.remove_child(scene)
		for mode in [GeometryInstance3D.SHADOW_CASTING_SETTING_OFF, GeometryInstance3D.SHADOW_CASTING_SETTING_ON, GeometryInstance3D.SHADOW_CASTING_SETTING_DOUBLE_SIDED]:
			caster.cast_shadow = mode
			var measured = probe._cmd_bounds(scene, live, bounds).nodes[0]
			assert(measured.geometry_count == 3 and measured.intervals[0] == [-0.5, 5.5])
			assert(probe._cmd_raycast(scene, live, ray).visual.path == "Reference/Caster")
		caster.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_SHADOWS_ONLY
		var measured = probe._cmd_bounds(scene, live, bounds).nodes[0]
		assert(measured.geometry_count == 2 and measured.intervals[0] == [-0.5, 0.5])
		assert(not probe._cmd_raycast(scene, live, ray).has("visual"))
		var badge_ray = ray.duplicate()
		badge_ray.origin = [0, 3, 8]
		assert(probe._cmd_raycast(scene, live, badge_ray).visual.path == "Reference/Caster/Badge")
		var sheet := PlaneMesh.new()
		caster.mesh = sheet
		var badge = caster.get_node("Badge")
		badge.mesh = sheet
		var marker := Marker3D.new()
		marker.name = "Explicit"
		caster.add_child(marker)
		var result = probe._describe(reference, {})
		assert(result.mesh_count == 3 and result.triangles == 16 and result.anchor_count == 1)
		assert(result.analysis.triangles_analyzed == 14 and result.open_loop_count == 1)
		var row = result.open_loops[0].mesh
		assert(result.meshes[row].path == "Caster/Badge")
		assert(not result.meshes[0].has("hidden"))
		assert(result.aabb.max[0] == 1.0)
		var open_port = probe._resolve_port(scene, reference, 0, 100, false)
		assert(open_port.loops.size() == 1 and open_port.loops[0].mesh == row)
		var named = probe._resolve_port(scene, reference, "Caster/Explicit", 100, false)
		assert(named.kind == "marker" and named.position == Vector3(5, 0, 0))
		marker.free()
		caster.mesh = BoxMesh.new()
		badge.mesh = BoxMesh.new()
	scene.free()
	print("PLACEMENT_FIXTURE_OK")
	quit()
