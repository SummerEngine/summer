extends SceneTree

func _initialize() -> void:
	call_deferred("measure")

func measure() -> void:
	var builder = load("res://builder.gd").new()
	builder.spec = "res://blockout.json"
	root.add_child(builder)
	for frame in 5:
		await physics_frame
	var space := root.world_3d.direct_space_state
	var rows := {}
	for object in JSON.parse_string(FileAccess.get_file_as_string(builder.spec)).objects:
		var holder = builder.get_node(object.name + "Body" if object.solid else object.name)
		var mesh: MeshInstance3D = holder.get_node(object.name) if object.solid else holder
		var center := mesh.global_position
		var extents := Vector3.ZERO
		for vertex in mesh.mesh.get_faces():
			extents = extents.max((mesh.global_transform * vertex - center).abs())
		var rays := []
		for axis in [Vector3.RIGHT, Vector3.UP, Vector3.BACK]:
			var ray := PhysicsRayQueryParameters3D.create(center + axis * 4, center)
			var hit := space.intersect_ray(ray)
			rays.append(null if hit.is_empty() else (hit.position - center).dot(axis))
		var shape: Shape3D = holder.get_child(0).shape if object.solid else null
		rows[object.name] = {"extents": [extents.x, extents.y, extents.z], "rays": rays, "shape": shape.get_class() if shape else null}
	var result := FileAccess.open("res://result.json", FileAccess.WRITE)
	result.store_string(JSON.stringify(rows))
	result.close()
	quit()
