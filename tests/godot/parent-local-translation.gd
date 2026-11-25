extends SceneTree

# SCENE_SPACE_HELPERS

class SceneContext:
	var scene: Node3D

	func get_scene_root():
		return scene

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
	var remote := Transform3D(Basis.IDENTITY, Vector3(0, 1e8, 0))
	for delta in [Vector3(0, -5, 0), Vector3(0, 999995, 0)]:
		if _translated_position_literal(remote, Vector3(0, -99999992, 0), delta) != null:
			errors.append("accepted a write missing its target by three metres")
		count += 1
	# These are the unrounded scalar components sent in the public request.
	for sample in [
		[-10000.0, 10001.0043, true], [10000.0, -10001.0043, true],
		[0.0, 4097.0252, false], [0.0, 65537.003, false],
		[0.0, 65537.03125, true], [0.0, 8193.0313, true],
	]:
		var local := Vector3(sample[0], 0, 0)
		var literal = _translated_position_literal(Transform3D.IDENTITY, local, [sample[1], 0.0, 0.0])
		if (literal != null) != sample[2]:
			errors.append(["unexpected decision", sample])
		elif literal != null:
			var stored: Vector3 = str_to_var(literal)
			if absf((stored.x - local.x) - sample[1]) > 0.0001:
				errors.append(["lost requested precision", sample])
		count += 1
	# Exercise the real JSON adapter that carries a toolkit request into Godot.
	var ctx = SceneContext.new()
	ctx.scene = Node3D.new()
	root.add_child(ctx.scene)
	var piece := Node3D.new()
	piece.name = "Piece"
	ctx.scene.add_child(piece)
	piece.position.x = -10000
	var planned = load("res://long-read.gd").new().run(ctx)
	if not planned.get("ok") or absf(str_to_var(planned["translated_position"]).x - 1.0043) > 0.0001:
		errors.append("the scene read rounded the incoming scalar request")
	piece.position.x = 0
	if load("res://far-read.gd").new().run(ctx).get("failure_reason") != "translation_not_representable":
		errors.append("the scene read accepted an unrepresentable original request")
	ctx.scene.free()
	count += 2
	FileAccess.open("res://result.json", FileAccess.WRITE).store_string(JSON.stringify({"count": count, "errors": errors}))
	quit()
