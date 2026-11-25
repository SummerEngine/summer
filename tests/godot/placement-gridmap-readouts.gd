extends SceneTree


func _initialize():
	check.call_deferred()


func check():
	var probe = preload("res://probe.gd").new()
	var scene := Node3D.new()
	root.add_child(scene)
	var rig := Node3D.new()
	rig.name = "Rig"
	scene.add_child(rig)
	rig.transform = Transform3D(Basis(Vector3.UP, 0.42), Vector3(7, 3, 2))
	var grid := GridMap.new()
	grid.name = "Tiles"
	grid.cell_size = Vector3(4, 3, 2)
	grid.cell_scale = 0.75
	rig.add_child(grid)
	var box := BoxMesh.new()
	box.size = Vector3(2, 0.5, 2)
	var library := MeshLibrary.new()
	library.create_item(7)
	library.set_item_mesh(7, box)
	library.set_item_mesh_transform(7, Transform3D(Basis(Vector3.UP, 0.21), Vector3(0, 1, 0)))
	grid.mesh_library = library
	grid.set_cell_item(Vector3i(-1, 0, 2), 7, grid.get_orthogonal_index_from_basis(Basis(Vector3.UP, PI / 2)))
	grid.set_cell_item(Vector3i(9, 0, 2), 7)
	var pairs := grid.get_meshes()
	var first: Transform3D = grid.global_transform * pairs[0]
	var second: Transform3D = grid.global_transform * pairs[2]
	var world_box: AABB = first * box.get_aabb()
	var origin := first.origin + Vector3.UP * 10
	var ray = {"origin": [origin.x, origin.y, origin.z], "direction": [0, -1, 0], "evidence": "visual_aabb", "include_grids": true}
	var hit = probe._cmd_raycast(scene, true, ray)
	assert(hit.visual.path == "Rig/Tiles" and is_equal_approx(hit.visual.point[1], world_box.end.y))
	var bounds = {"nodes": [{"path": "Rig"}], "include_grids": true}
	var read = probe._cmd_bounds(scene, true, bounds).nodes[0]
	assert(read.geometry_count == 2 and is_equal_approx(read.intervals[1][1], world_box.end.y))
	var gap: Vector3 = (first.origin + second.origin) / 2 + Vector3.UP * 10
	ray.origin = [gap.x, gap.y, gap.z]
	assert(not probe._cmd_raycast(scene, true, ray).has("visual"))
	# The mutating placement commands retain their GeometryInstance3D scope.
	assert(probe._cmd_bounds(scene, true, {"nodes": [{"path": "Rig"}]}).nodes[0].geometry_count == 0)
	grid.make_baked_meshes(false)
	var stored = grid.get("baked_meshes").duplicate()
	assert(stored.size() == 2)
	grid.clear_baked_meshes()
	grid.clear()
	grid.set_cell_item(Vector3i(100, 0, -100), 7)
	grid.set("baked_meshes", stored)
	var baked_box: AABB = grid.global_transform * stored[0].get_aabb()
	for mesh in stored:
		baked_box = baked_box.merge(grid.global_transform * mesh.get_aabb())
	read = probe._cmd_bounds(scene, true, bounds).nodes[0]
	assert(read.geometry_count == 2 and is_equal_approx(read.intervals[1][1], baked_box.end.y))
	assert(not probe._cmd_raycast(scene, true, ray).has("visual"))
	grid.clear_baked_meshes()
	library.set_item_mesh_cast_shadow(7, RenderingServer.SHADOW_CASTING_SETTING_SHADOWS_ONLY)
	assert(probe._cmd_bounds(scene, true, bounds).nodes[0].geometry_count == 0)
	var ordinary := MeshInstance3D.new()
	ordinary.mesh = box
	grid.add_child(ordinary)
	assert(probe._cmd_bounds(scene, true, bounds).nodes[0].geometry_count == 1)
	scene.free()

	var physics_scene := Node3D.new()
	root.add_child(physics_scene)
	var physics_grid := GridMap.new()
	physics_grid.name = "GridCollider"
	var physics_library := MeshLibrary.new()
	physics_library.create_item(0)
	physics_library.set_item_mesh(0, BoxMesh.new())
	var shape := BoxShape3D.new()
	shape.size = Vector3(1, 0.3, 1)
	physics_library.set_item_shapes(0, [shape, Transform3D.IDENTITY])
	physics_grid.mesh_library = physics_library
	physics_grid.set_cell_item(Vector3i.ZERO, 0)
	physics_scene.add_child(physics_grid)
	for tick in 3:
		await physics_frame
	var center := physics_grid.map_to_local(Vector3i.ZERO)
	var physics_ray = {"origin": [center.x, center.y + 4, center.z], "direction": [0, -1, 0], "evidence": "auto", "include_grids": true}
	var actual = probe._cmd_raycast(physics_scene, true, physics_ray)
	assert(actual.physics.path == "GridCollider" and not actual.has("visual"))
	assert(is_equal_approx(actual.physics.point[1], center.y + 0.15))
	physics_scene.free()
	print("PLACEMENT_FIXTURE_OK")
	quit()
