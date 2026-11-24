extends SceneTree

func _initialize():
	call_deferred("check")

func check():
	var scene := Node3D.new()
	root.add_child(scene)
	var rig := Node3D.new()
	scene.add_child(rig)
	rig.position = Vector3(17, -2, 9)
	rig.rotation.y = -0.65
	var piece := Node3D.new()
	rig.add_child(piece)
	piece.position = Vector3(12, 1, 4)
	var pipe := CylinderMesh.new()
	pipe.cap_top = false
	pipe.cap_bottom = false
	var probe = preload("res://probe.gd").new()
	for mode in ["inherited", "top_level", "plain_parent"]:
		var holder: Node = Node.new() if mode == "plain_parent" else Node3D.new()
		piece.add_child(holder)
		var mesh := MeshInstance3D.new()
		holder.add_child(mesh)
		mesh.mesh = pipe
		mesh.top_level = mode == "top_level"
		mesh.position = Vector3(3, 2, 0)
		mesh.rotation.z = 0.4
		var expected := [mesh.to_global(Vector3.UP * pipe.height / 2), mesh.to_global(Vector3.DOWN * pipe.height / 2)]
		for entered in [true, false]:
			if not entered:
				root.remove_child(scene)
			var resolved: Dictionary = probe._resolve_port(scene, piece, 0, 60000, false)
			assert(resolved.loops.size() == 2)
			for loop in resolved.loops:
				var c: Array = loop.center
				var center: Vector3 = probe._xf(piece, scene) * Vector3(c[0], c[1], c[2])
				if not expected.any(func(e): return e.distance_to(center) < 0.0001):
					push_error("%s port center %s does not match Godot ring centers %s" % [mode, center, expected])
					quit(1)
					return
			if not entered:
				root.add_child(scene)
		holder.free()
	scene.free()
	print("PLACEMENT_FIXTURE_OK")
	quit()
