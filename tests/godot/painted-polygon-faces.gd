extends SceneTree

const BUILDER := preload("res://blockout_builder.gd")

func _initialize() -> void:
	run.call_deferred()

func run() -> void:
	var builder := BUILDER.new()
	builder.spec = "res://footprints.json"
	root.add_child(builder)
	var results := {}
	for mesh_node: MeshInstance3D in builder.find_children("*", "MeshInstance3D", true, false):
		var mesh := mesh_node.mesh
		var arrays := mesh.surface_get_arrays(0)
		var vertices: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
		var normals: PackedVector3Array = arrays[Mesh.ARRAY_NORMAL]
		var indices = arrays[Mesh.ARRAY_INDEX]
		if indices == null:
			indices = range(vertices.size())
		var flat := true
		var outward := true
		var area := 0.0
		var walls := 0
		for i in range(0, indices.size(), 3):
			var corners := [indices[i], indices[i + 1], indices[i + 2]]
			var a := vertices[corners[0]]
			var b := vertices[corners[1]]
			var c := vertices[corners[2]]
			var cross := (c - a).cross(b - a)
			var face := cross.normalized()
			for corner in corners:
				flat = flat and normals[corner].dot(face) > 0.9999
			if is_equal_approx(a.y, 1.0) and is_equal_approx(b.y, 1.0) and is_equal_approx(c.y, 1.0):
				outward = outward and face.dot(Vector3.UP) > 0.9999
				area += cross.length() * 0.5
			else:
				var center := (a + b + c) / 3.0
				outward = outward and inside_l(center - 0.01 * face) and not inside_l(center + 0.01 * face)
				walls += 1
		results[str(mesh_node.name)] = {"flat": flat, "outward": outward, "area": area, "walls": walls}
	for _tick in 4:
		await physics_frame
	var space := builder.get_world_3d().direct_space_state
	var above := Vector3(2, 3, 0.5)
	var below := Vector3(2, 0, 0.5)
	var notch := Vector3(0, 0, 1)
	results["floor_from_above"] = hit_at(space, above, below, 1.0)
	results["floor_from_below"] = hit_at(space, below, above, 1.0)
	results["notch_open"] = space.intersect_ray(PhysicsRayQueryParameters3D.create(above + notch, below + notch)).is_empty()
	FileAccess.open("res://result.json", FileAccess.WRITE).store_string(JSON.stringify(results))
	quit()

func hit_at(space: PhysicsDirectSpaceState3D, from: Vector3, to: Vector3, height: float) -> bool:
	var hit := space.intersect_ray(PhysicsRayQueryParameters3D.create(from, to))
	return not hit.is_empty() and is_equal_approx(hit.position.y, height)

# These two rectangles describe the authored L independently of its triangle list.
func inside_l(point: Vector3) -> bool:
	return Rect2(0, 0, 3, 1).has_point(Vector2(point.x, point.z)) or Rect2(0, 1, 1, 1).has_point(Vector2(point.x, point.z))
