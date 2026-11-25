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
	example.set_cell_item(Vector3i(2, -1, 3), 1, example.get_orthogonal_index_from_basis(Basis(Vector3.UP, PI / 2)))
	example.set_cell_item(Vector3i(-2, 1, -3), 1)
	var control := Node3D.new()
	for cell in example.get_used_cells():
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
	baked_reference.free()
	example.free()
	control.free()
	print("PLACEMENT_FIXTURE_OK")
	quit()
