extends SceneTree

var failures: Array[String] = []

func expect(condition: bool, message: String):
	if not condition:
		failures.append(message)

func _initialize():
	call_deferred("check_rays")

func make_mesh(parent: Node3D, size: Vector3) -> MeshInstance3D:
	var visual := MeshInstance3D.new()
	visual.mesh = BoxMesh.new()
	visual.mesh.size = size
	parent.add_child(visual)
	return visual

func make_body(parent: Node3D, size: Vector3) -> StaticBody3D:
	var body := StaticBody3D.new()
	parent.add_child(body)
	var shape := CollisionShape3D.new()
	shape.shape = BoxShape3D.new()
	shape.shape.size = size
	body.add_child(shape)
	return body

func check_rays():
	var scene := Node3D.new()
	root.add_child(scene)
	var size := Vector3(4, 1, 0.4)
	var body := make_body(scene, size)
	var visual := make_mesh(body, size)
	body.rotation.y = PI / 4

	# Godot's mesh collision generator puts the body below the mesh instead.
	var reverse := make_mesh(scene, size)
	reverse.position.x = 8
	reverse.rotation.y = PI / 4
	var generated_body := make_body(reverse, size)
	await physics_frame
	await physics_frame

	var probe = preload("res://probe.gd").new()
	var args := {"direction": [0, 0, -1], "origin": [0, 0, 4]}
	for pair in [[0, body], [8, generated_body]]:
		args.origin = [pair[0], 0, 4]
		var hit = probe._cmd_raycast(scene, true, args)
		expect(hit.has("physics") and hit.physics.path == str(scene.get_path_to(pair[1])), "wrong physics collider")
		expect(is_equal_approx(hit.get("physics", {}).get("distance", -1.0), 4.0 - sqrt(0.08)), "wrong rotated face distance")
		expect(not hit.has("visual"), "a collider's own display was reported as a separate obstacle")

	# This independent display lies between the inflated box and its actual face.
	var other := make_mesh(scene, Vector3(0.5, 0.5, 0.2))
	other.position.z = 0.8
	args.origin = [0, 0, 4]
	var hit = probe._cmd_raycast(scene, true, args)
	expect(hit.get("visual", {}).get("path", "") == str(scene.get_path_to(other)), "independent visual omitted")
	expect(is_equal_approx(hit.get("visual", {}).get("distance", -1.0), 3.1), "wrong independent visual distance")

	# An explicit visual-only ray still reads the outer world AABB.
	args.evidence = "visual_aabb"
	var bounds = probe._cmd_raycast(scene, true, args)
	expect(bounds.get("visual", {}).get("path", "") == str(scene.get_path_to(visual)), "explicit visual ray lost display mesh")
	expect(is_equal_approx(bounds.get("visual", {}).get("distance", -1.0), 4.0 - 2.2 / sqrt(2.0)), "wrong world AABB distance")

	# A nested independent collider retains its own visual identity.
	var nested := make_body(body, Vector3.ONE)
	var nested_visual := make_mesh(nested, Vector3.ONE)
	expect(not probe._visual_of_hit_collider(nested_visual, body), "nested body hidden with its parent")
	expect(probe._visual_of_hit_collider(nested_visual, nested), "nested body display missed")
	scene.free()
	if not failures.is_empty():
		for message in failures:
			push_error(message)
		quit(1)
		return
	print("PLACEMENT_FIXTURE_OK")
	quit()
