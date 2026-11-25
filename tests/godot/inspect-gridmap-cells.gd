extends SceneTree

func inspect(node: Node, asset_name: String) -> Dictionary:
	var path := "res://" + asset_name + ".tscn"
	var packed := PackedScene.new()
	assert(packed.pack(node) == OK)
	assert(ResourceSaver.save(packed, path) == OK)
	return preload("res://probe.gd").new()._cmd_inspect_asset({"path": path, "max_triangles": 200})

func _initialize():
	var example := GridMap.new()
	example.cell_size = Vector3(2, 3, 4)
	example.cell_scale = 0.75
	var library := MeshLibrary.new()
	var box := BoxMesh.new()
	box.size = Vector3(4, 0.8, 1.5)
	var material := StandardMaterial3D.new()
	material.cull_mode = BaseMaterial3D.CULL_DISABLED
	box.material = material
	library.create_item(1)
	library.set_item_mesh(1, box)
	library.set_item_mesh_transform(1, Transform3D(Basis(Vector3.UP, 0.16), Vector3(0.4, 0.2, -0.3)))
	example.mesh_library = library
	var empty := inspect(example, "empty")
	assert(empty.ok and empty.triangles == 0 and empty.aabb == null)
	library.create_item(20) # A meshless cell has no row in get_meshes().
	example.set_cell_item(Vector3i(-12, -9, -8), 20)
	example.set_cell_item(Vector3i(2, -1, 3), 1, example.get_orthogonal_index_from_basis(Basis(Vector3.UP, PI / 2)))
	example.set_cell_item(Vector3i(-2, 1, -3), 1)
	var control := Node3D.new()
	for cell in example.get_used_cells():
		if example.get_cell_item(cell) == 20: continue
		var item := MeshInstance3D.new()
		item.mesh = box
		var oriented := example.get_cell_item_basis(cell).scaled(Vector3.ONE * example.cell_scale)
		item.transform = Transform3D(oriented, example.map_to_local(cell)) * library.get_item_mesh_transform(1)
		control.add_child(item)
		item.owner = control
	var ordinary := inspect(control, "ordinary")
	var cells := inspect(example, "populated")
	assert(cells.ok and cells.mesh_count == 2 and cells.triangles == 24)
	assert(cells.aabb == ordinary.aabb and cells.origin == ordinary.origin)
	assert(cells.analysis.triangles_analyzed == 24 and not cells.analysis.truncated)
	assert(cells.meshes[0].grid_entry == 0 and cells.meshes[1].grid_entry == 1)
	for plane in cells.planes: assert(plane.cull_back == 0)
	example.visible = false
	var hidden := inspect(example, "hidden")
	assert(hidden.ok and hidden.triangles == 24 and hidden.analysis.triangles_analyzed == 0 and hidden.aabb == null)
	example.visible = true
	assert(example.get("baked_meshes").is_empty())
	library.create_item(2)
	library.set_item_mesh(2, box)
	library.set_item_mesh_transform(2, library.get_item_mesh_transform(1))
	library.set_item_mesh_cast_shadow(2, RenderingServer.SHADOW_CASTING_SETTING_SHADOWS_ONLY)
	example.set_cell_item(Vector3i(-18, 8, 4), 2)
	var with_caster := inspect(example, "with_caster")
	assert(with_caster.aabb == cells.aabb and with_caster.analysis.triangles_analyzed == 24)
	assert(with_caster.mesh_count == 3 and with_caster.triangles == 36)
	var casters = with_caster.meshes.filter(func(row): return row.get("shadows_only", false))
	assert(casters.size() == 1 and casters[0].min[0] < -30)
	example.make_baked_meshes(false)
	var baked_reference := Node3D.new()
	for saved_mesh in example.get("baked_meshes"):
		var part := MeshInstance3D.new()
		part.mesh = saved_mesh
		baked_reference.add_child(part)
		part.owner = baked_reference
	var drawn := inspect(baked_reference, "baked_reference")
	var baked := inspect(example, "baked")
	assert(baked.ok and baked.mesh_count > 0 and baked.triangles == drawn.triangles)
	for row in baked.meshes:
		assert(row.has("baked_mesh_index") and not row.has("grid_entry"))
	assert(baked.aabb == drawn.aabb and baked.planes == drawn.planes)
	# Two distinct library items reference the same mesh at exactly the same pose.
	var coincident := GridMap.new()
	coincident.cell_size = Vector3(2, 3, 4)
	coincident.cell_scale = 0.5
	var paired := MeshLibrary.new()
	for id in [1, 2]:
		paired.create_item(id)
		paired.set_item_mesh(id, box)
	paired.set_item_mesh_transform(2, Transform3D(Basis.IDENTITY, Vector3(-4, 0, 0)))
	paired.set_item_mesh_cast_shadow(2, RenderingServer.SHADOW_CASTING_SETTING_SHADOWS_ONLY)
	coincident.mesh_library = paired
	coincident.set_cell_item(Vector3i(-1, 0, 0), 1)
	coincident.set_cell_item(Vector3i(0, 0, 0), 2)
	var same_pose := inspect(coincident, "coincident")
	assert(same_pose.mesh_count == 2 and same_pose.analysis.triangles_analyzed == 12)
	assert(same_pose.meshes[0].min == same_pose.meshes[1].min)
	assert(same_pose.meshes.filter(func(row): return row.get("shadows_only", false)).size() == 1)
	coincident.free()
	baked_reference.free()
	example.free()
	control.free()
	print("PLACEMENT_FIXTURE_OK")
	quit()
