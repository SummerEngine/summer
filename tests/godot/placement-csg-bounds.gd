extends SceneTree


func _initialize():
	check.call_deferred()


func check():
	var probe = preload("res://probe.gd").new()
	var scene := Node3D.new()
	var solid := CSGBox3D.new()
	solid.name = "Solid"
	solid.size = Vector3(4, 2, 2)
	scene.add_child(solid)
	var cutter := CSGBox3D.new()
	cutter.name = "Cutter"
	cutter.operation = CSGShape3D.OPERATION_SUBTRACTION
	cutter.size = Vector3(8, 3, 3)
	cutter.position.x = 5
	solid.add_child(cutter)
	var decoration := MeshInstance3D.new()
	decoration.name = "Decoration"
	decoration.mesh = BoxMesh.new()
	decoration.position = Vector3(-5, 4, 0)
	cutter.add_child(decoration)
	var marker := MeshInstance3D.new()
	marker.name = "Marker"
	marker.mesh = BoxMesh.new()
	marker.position = Vector3(6, 0, 0)
	scene.add_child(marker)

	var bounds_args = {"nodes": [{"path": "Solid"}]}
	var ray_args = {"origin": [6, 0, 8], "direction": [0, 0, -1], "surface": "Solid", "evidence": "visual_aabb"}
	var blockers_args = {"path": "Marker", "direction": [0, 0, -1]}
	# A newly instanced tree has never evaluated its brush. Its child mesh is
	# still measurable in isolation and other scans must disclose the missing solid.
	assert(solid.bake_static_mesh() == null)
	for result in [probe._cmd_bounds(scene, false, bounds_args), probe._cmd_raycast(scene, false, ray_args), probe._cmd_blockers(scene, false, blockers_args)]:
		assert(result.failure_reason == "csg_visual_mesh_unavailable")
	assert(probe._cmd_bounds(scene, false, {"nodes": [{"path": "Solid/Cutter/Decoration"}]}).nodes[0].geometry_count == 1)

	root.add_child(scene)
	await process_frame
	await process_frame
	var evaluated := solid.bake_static_mesh()
	assert(evaluated != null)
	var vertices := evaluated.get_faces()
	var expected := AABB(vertices[0], Vector3.ZERO)
	for vertex in vertices:
		expected = expected.expand(vertex)
	for live in [true, false]:
		if not live:
			root.remove_child(scene)
		var measured = probe._cmd_bounds(scene, live, bounds_args).nodes[0]
		assert(measured.geometry_count == 2)
		assert(measured.intervals[0] == [expected.position.x, expected.end.x])
		assert(measured.intervals[0] == [-2.0, 1.0])
		var empty_ray = probe._cmd_raycast(scene, live, ray_args)
		assert(empty_ray.ok and not empty_ray.has("visual"))
		var blockers = probe._cmd_blockers(scene, live, blockers_args)
		assert(blockers.ok and blockers.overlaps.is_empty() and blockers.first_contact == null)
		var decoration_ray = ray_args.duplicate()
		decoration_ray.origin = [0, 4, 8]
		assert(probe._cmd_raycast(scene, live, decoration_ray).visual.path == "Solid/Cutter/Decoration")
	scene.free()
	print("PLACEMENT_FIXTURE_OK")
	quit()
