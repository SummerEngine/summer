extends SceneTree

func _initialize() -> void:
	call_deferred("measure")

func measure() -> void:
	var builder = load("res://builder.gd").new()
	builder.spec = "res://objects.json"
	root.add_child(builder)
	for frame in 5:
		await physics_frame
	var world := root.world_3d.direct_space_state
	var samples := []
	for object in JSON.parse_string(FileAccess.get_file_as_string(builder.spec)).objects:
		var holder = builder.get_node(object.name + "Body" if object.solid else object.name)
		var mesh: MeshInstance3D = holder.get_node(object.name) if object.solid else holder
		var faces := mesh.mesh.get_faces()
		for i in faces.size():
			faces[i] = mesh.to_global(faces[i])
		var base := Vector3(object.pos[0], object.pos[1], object.pos[2])
		for fraction in [0.1, 0.9]:
			var axis := base + Vector3.UP * float(object.height) * float(object.scale[1]) * float(fraction)
			for direction: Vector3 in [Vector3.RIGHT, Vector3.BACK]:
				var start := axis + direction * 3.0
				var hit := world.intersect_ray(PhysicsRayQueryParameters3D.create(start, axis))
				var visual = null
				for i in range(0, faces.size(), 3):
					var point = Geometry3D.ray_intersects_triangle(start, -direction, faces[i], faces[i + 1], faces[i + 2])
					if point != null:
						var radius: float = (point - axis).dot(direction)
						if visual == null or radius > visual:
							visual = radius
				samples.append({
					"name": object.name, "solid": object.solid,
					"expected": lerpf(object.r_bot, object.r_top, fraction) * (float(object.scale[0]) if direction == Vector3.RIGHT else float(object.scale[2])),
					"visual": visual, "collision": (hit.position - axis).dot(direction) if not hit.is_empty() else null,
				})
	FileAccess.open("res://results.json", FileAccess.WRITE).store_string(JSON.stringify(samples))
	quit()
