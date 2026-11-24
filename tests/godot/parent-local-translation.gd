extends SceneTree

func triple(v: Vector3) -> Array:
	return [v.x, v.y, v.z]

func _initialize():
	inspect.call_deferred()

func inspect():
	var results := []
	for mirrored in [false, true]:
		for inherit_rotation in [false, true]:
			var rig := Node3D.new()
			root.add_child(rig)
			rig.position = Vector3(15, -4, 3)
			rig.rotation = Vector3(0.39, -0.71, 0.22)
			rig.scale = Vector3(-2.5 if mirrored else 2.5, 0.55, 1.4)
			var parent := Node3D.new()
			rig.add_child(parent)
			parent.position = Vector3(0.2, -0.8, 0.11)
			if inherit_rotation:
				parent.rotation = Vector3(-0.42, 0.26, 0.35)
			var child := Node3D.new()
			parent.add_child(child)
			child.position = Vector3(1.3, -0.4, 2.25)
			var t := parent.global_transform
			var wire := triple(t.basis.x) + triple(t.basis.y) + triple(t.basis.z) + triple(t.origin)
			for delta in [Vector3(1.8, -2.15, 0.37), Vector3(0, 0.32, 0), Vector3(-0.4, 0.31, 2.48)]:
				var expected := parent.to_local(child.global_position + delta)
				results.append({"literal":var_to_str(t), "wire":wire, "original":triple(child.position), "delta":triple(delta), "expected":triple(expected), "det":t.basis.determinant()})
			rig.free()
	FileAccess.open("res://expected.json", FileAccess.WRITE).store_string(JSON.stringify(results))
	quit()
