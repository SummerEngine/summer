extends SceneTree

# SCENE_SPACE_HELPERS

func _initialize():
	check.call_deferred()

func check():
	var errors := []
	var count := 0
	for units in [1.0, 0.00005]:
		for mirrored in [false, true]:
			for inherit_rotation in [false, true]:
				var rig := Node3D.new()
				root.add_child(rig)
				rig.position = Vector3(15, -4, 3)
				rig.rotation = Vector3(0.39, -0.71, 0.22)
				rig.scale = units * Vector3(-2.5 if mirrored else 2.5, 0.55, 1.4)
				var parent := Node3D.new()
				rig.add_child(parent)
				parent.position = Vector3(0.2, -0.8, 0.11)
				if inherit_rotation:
					parent.rotation = Vector3(-0.42, 0.26, 0.35)
				var child := Node3D.new()
				parent.add_child(child)
				child.position = Vector3(1.3, -0.4, 2.25)
				child.scale = Vector3.ONE / units
				for delta in [Vector3(1.8, -2.15, 0.37), Vector3(0, 0.32, 0), Vector3(-0.4, 0.31, 2.48)]:
					var target = child.global_position + delta
					var planned = _translated_position_literal(_parent_xf(child, rig), child.position, delta)
					var original = child.position
					if planned != null:
						child.position = str_to_var(planned)
					if planned == null or not child.global_position.is_equal_approx(target):
						errors.append([units, mirrored, inherit_rotation, str(delta)])
					child.position = original
					count += 1
				rig.free()
	var lossy := Basis(Vector3.ONE, Vector3(1.00004, 1, 1.00007), Vector3(0.65, 1.25, -0.84))
	for basis in [Basis(Vector3.RIGHT, Vector3.UP, Vector3.RIGHT), lossy]:
		var parent := Transform3D(basis, Vector3(100, -2.25, 1.75))
		if _translated_position_literal(parent, Vector3(0.75, -0.4, 1.2), Vector3(-92.1455, 1.975, -2.394)) != null:
			errors.append("accepted an unrepresentable requested movement")
		count += 1
	FileAccess.open("res://result.json", FileAccess.WRITE).store_string(JSON.stringify({"count": count, "errors": errors}))
	quit()
