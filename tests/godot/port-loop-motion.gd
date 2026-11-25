extends SceneTree

func _initialize():
	call_deferred("check")

func tube(parent: Node, label: String, mesh: Mesh, top: bool = false) -> MeshInstance3D:
	var instance := MeshInstance3D.new()
	instance.name = label
	instance.mesh = mesh
	instance.top_level = top
	parent.add_child(instance)
	return instance

func check():
	var scene := Node3D.new()
	var rig := Node3D.new()
	scene.add_child(rig)
	var piece := Node3D.new()
	rig.add_child(piece)
	var pipe := CylinderMesh.new()
	pipe.cap_top = false
	pipe.cap_bottom = false
	var inherited := tube(piece, "AInherited", pipe)
	var fixed := tube(piece, "BIndependent", pipe, true)
	var boundary := Node.new()
	boundary.name = "C"
	piece.add_child(boundary)
	tube(boundary, "Independent", pipe)
	tube(rig, "Dock", pipe)
	var probe = preload("res://probe.gd").new()
	for attached in [false, true]:
		if attached:
			root.add_child(scene)
			var inherited_start := inherited.global_position
			var fixed_start := fixed.global_position
			piece.position.x += 10
			assert(inherited.global_position.distance_to(inherited_start) > 9)
			assert(fixed.global_position.is_equal_approx(fixed_start))
		var subject: Dictionary = probe._resolve_port(scene, piece, 0, 60000, true, piece)
		assert(subject.loops.size() == 6)
		if not subject.has("unavailable_meshes"):
			push_error("The native probe offered meshes that stay fixed when Piece moves.")
			quit(1)
			return
		for mesh in range(3):
			assert(subject.unavailable_meshes.has(str(mesh)) == (mesh != 0))
			if mesh != 0:
				assert(subject.unavailable_meshes[str(mesh)].failure_reason == "independent_subject_port")
		var target: Dictionary = probe._resolve_port(scene, rig, 0, 60000, false, piece)
		assert(target.loops.size() == 8)
		assert(target.unavailable_meshes.size() == 1)
		assert(target.unavailable_meshes.values()[0].failure_reason == "target_port_moves_with_subject")
	scene.free()
	print("PLACEMENT_FIXTURE_OK")
	quit()
