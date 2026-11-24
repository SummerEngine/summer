extends SceneTree

func add_mesh(parent: Node3D, label: String, mesh: Mesh, x: float) -> MeshInstance3D:
	var node := MeshInstance3D.new()
	node.name = label
	node.mesh = mesh
	node.position.x = x
	parent.add_child(node)
	node.owner = parent
	return node

func _initialize():
	var probe = preload("res://probe.gd").new()
	var asset := Node3D.new()
	var tube := CylinderMesh.new()
	tube.cap_top = false
	tube.cap_bottom = false
	tube.radial_segments = 8
	tube.rings = 0
	add_mesh(asset, "LeftPipe", tube, -3.0)
	add_mesh(asset, "RightPipe", tube, 4.0)
	var hidden: MeshInstance3D
	for label: String in ["", "AHidden", "MiddleHidden", "ZHidden"]:
		if not label.is_empty():
			if hidden == null:
				hidden = add_mesh(asset, label, BoxMesh.new(), 0.0)
				hidden.visible = false
			hidden.name = label
		var path := "res://example" + label + ".tscn"
		var packed := PackedScene.new()
		assert(packed.pack(asset) == OK)
		assert(ResourceSaver.save(packed, path) == OK)
		var parsed: Dictionary = probe._cmd_inspect_asset({"path": path})
		assert(parsed.ok and parsed.open_loops.size() == 4)
		assert(parsed.mesh_count == (2 if hidden == null else 3))
		assert(parsed.analysis.triangles_analyzed == 32 and not parsed.analysis.truncated)
		var live: Dictionary = probe._resolve_port(asset, asset, 0, 60000, false)
		assert(live.kind == "open_loops" and live.loops.size() == 4)
		for loops in [parsed.open_loops, live.loops]:
			for loop in loops:
				var owner_row: Dictionary = parsed.meshes[loop.mesh]
				assert(not owner_row.get("hidden", false))
				assert(owner_row.path == ("LeftPipe" if loop.center[0] < 0 else "RightPipe"))
	asset.free()
	print("PLACEMENT_FIXTURE_OK")
	quit()
