extends SceneTree

var failures: Array[String] = []

func _initialize():
	call_deferred("check_blockers")

func expect(ok: bool, message: String):
	if not ok:
		failures.append(message)

func add_shape(parent: Node3D, x: float) -> CollisionShape3D:
	var node := CollisionShape3D.new()
	node.shape = BoxShape3D.new()
	node.position.x = x
	parent.add_child(node)
	return node

func add_obstacle(scene: Node3D, x: float) -> String:
	var body := StaticBody3D.new()
	scene.add_child(body)
	add_shape(body, x)
	return str(scene.get_path_to(body))

func check_blockers():
	var scene := Node3D.new()
	root.add_child(scene)
	var subject := Node3D.new()
	scene.add_child(subject)
	var visible := MeshInstance3D.new()
	visible.mesh = BoxMesh.new()
	subject.add_child(visible)
	var orphan := add_shape(subject, -3.0)
	var decoy := add_obstacle(scene, -3.0)
	var legitimate := add_obstacle(scene, 4.0)

	var body := StaticBody3D.new()
	body.position.x = 1.0
	subject.add_child(body)
	var poly := CollisionPolygon3D.new()
	poly.position.x = 3.0
	poly.polygon = PackedVector2Array([Vector2(-0.3, -0.3), Vector2(0.3, -0.3), Vector2(0.3, 0.3), Vector2(-0.3, 0.3)])
	body.add_child(poly)
	await physics_frame
	await physics_frame

	var probe = preload("res://probe.gd").new()
	var args = {"path": str(scene.get_path_to(subject)), "direction": [0, 0, -1]}
	var physical = probe._cmd_blockers(scene, true, args)
	expect(physical.get("evidence") == "physics" and physical.get("overlaps") == [legitimate], "registered polygon should query exactly its physical obstacle")
	args.path = str(scene.get_path_to(orphan))
	expect(probe._cmd_blockers(scene, true, args).get("overlaps") == [decoy], "an explicitly selected shape can be swept alone")
	var selected := add_shape(body, 3.0)
	await physics_frame
	await physics_frame
	args.path = str(scene.get_path_to(selected))
	expect(probe._cmd_blockers(scene, true, args).get("overlaps") == [legitimate], "a selected shape should exclude its own parent body")
	args.path = str(scene.get_path_to(subject))
	root.remove_child(scene)
	var detached = probe._cmd_blockers(scene, false, args)
	expect(detached.get("evidence") == "visual_aabb" and detached.get("physics_unavailable_reason") == "scene_not_active", "inactive scene should use visual bounds")
	poly.disabled = true
	selected.disabled = true
	var disabled = probe._cmd_blockers(scene, false, args)
	expect(disabled.get("evidence") == "visual_aabb" and not disabled.has("physics_unavailable_reason"), "disabled owners and orphan descendants should not imply physics geometry")

	# One custom owner can have several slots without any CollisionShape3D nodes.
	var owner_id := body.create_shape_owner(body)
	body.shape_owner_set_transform(owner_id, Transform3D(Basis.IDENTITY, Vector3(-4.0, 0, 0)))
	body.shape_owner_add_shape(owner_id, BoxShape3D.new())
	var sphere := SphereShape3D.new()
	sphere.radius = 2.0
	body.shape_owner_add_shape(owner_id, sphere)
	var second := add_obstacle(scene, -5.25)
	root.add_child(scene)
	await physics_frame
	await physics_frame
	var registered = probe._cmd_blockers(scene, true, args).get("overlaps", [])
	expect(registered.size() == 2 and decoy in registered and second in registered, "every custom owner slot must use the registered transform")
	body.shape_owner_set_disabled(owner_id, true)
	expect(probe._cmd_blockers(scene, true, args).get("evidence") == "visual_aabb", "disabled custom owner should contribute no query shapes")
	body.shape_owner_set_disabled(owner_id, false)
	var shared := BoxShape3D.new()
	for i in 255:
		body.shape_owner_add_shape(owner_id, shared)
	expect(probe._cmd_blockers(scene, true, args).get("failure_reason") == "shape_scan_limit", "oversized owner must not return partial blocker evidence")

	scene.free()
	for message in failures:
		push_error(message)
	if failures.is_empty():
		print("PLACEMENT_FIXTURE_OK")
	quit(0 if failures.is_empty() else 1)
