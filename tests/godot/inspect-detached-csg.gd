extends SceneTree

func inspect(node: Node, asset_name: String) -> Dictionary:
	var path := "res://" + asset_name + ".tscn"
	var packed := PackedScene.new()
	assert(packed.pack(node) == OK)
	assert(ResourceSaver.save(packed, path) == OK)
	return preload("res://probe.gd").new()._cmd_inspect_asset({"path": path})

func _initialize():
	call_deferred("check")

func check():
	var model := Node3D.new()
	var block := CSGBox3D.new()
	block.name = "CarvedBlock"
	block.size = Vector3(4, 2, 3)
	model.add_child(block)
	block.owner = model
	var cutter := CSGBox3D.new()
	cutter.size = Vector3(3, 3, 4)
	cutter.position.x = 2
	cutter.operation = CSGShape3D.OPERATION_SUBTRACTION
	block.add_child(cutter)
	cutter.owner = model
	root.add_child(model)
	await process_frame
	await process_frame
	var blocked := inspect(model, "procedural")
	assert(not blocked.ok and blocked.failure_reason == "csg_visual_mesh_unavailable")
	assert(blocked.error.contains("CarvedBlock") and blocked.error.contains("MeshInstance3D"))
	var standalone := CSGBox3D.new()
	var root_shape := inspect(standalone, "csg_root")
	standalone.free()
	assert(not root_shape.ok and root_shape.failure_reason == "csg_visual_mesh_unavailable")
	var baked := MeshInstance3D.new()
	baked.mesh = block.bake_static_mesh()
	assert(baked.mesh != null)
	var resolved := inspect(baked, "baked")
	assert(resolved.ok and resolved.triangles == baked.mesh.get_faces().size() / 3)
	assert(resolved.triangles > 0)
	var size = resolved.aabb["size"]
	assert(Vector3(size[0], size[1], size[2]).is_equal_approx(baked.mesh.get_aabb().size))
	var empty := Node3D.new()
	var actual_empty := inspect(empty, "empty")
	assert(actual_empty.ok and actual_empty.triangles == 0 and actual_empty.aabb == null)
	empty.free()
	baked.free()
	model.free()
	print("PLACEMENT_FIXTURE_OK")
	quit()
