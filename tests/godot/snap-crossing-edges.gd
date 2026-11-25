extends SceneTree

class Probe extends "res://snap.gd":
	var fixture: Node3D

	func _open_scene(_path):
		return {"root": fixture}

func mesh(parent, name, resource, position):
	var node = MeshInstance3D.new()
	node.name = name
	node.mesh = resource
	node.position = position
	parent.add_child(node)
	return node

func box(parent, name, size, position):
	var resource = BoxMesh.new()
	resource.size = size
	return mesh(parent, name, resource, position)

func check_case(rotated, offset, shelf_size, shelf_x, shelf_mode := GeometryInstance3D.SHADOW_CASTING_SETTING_ON):
	var fixture = Node3D.new()
	root.add_child(fixture)
	if rotated:
		fixture.rotation.y = 0.47
		fixture.scale = Vector3(-1.2, 1.0, 0.82)
	var plate = PlaneMesh.new()
	plate.size = Vector2(6.4, 0.7)
	plate.center_offset = offset
	var plank = mesh(fixture, "Plank", plate, Vector3(0, 11, 0) - offset)
	box(fixture, "Shelf", shelf_size, Vector3(shelf_x, 2.7, -0.13)).cast_shadow = shelf_mode
	box(fixture, "Floor", Vector3(24, 0.6, 24), Vector3(0, -0.3, 0))
	var probe = Probe.new()
	probe.fixture = fixture
	var measured = probe.run(null)
	if not measured.get("found", false):
		fixture.free()
		return measured
	plank.position = str_to_var(measured["position_after"])
	var vertices = plank.global_transform * plate.get_faces()
	var result = {"support": measured["support"], "contact": measured["contact_from"], "normal": measured["hit_normal"], "mesh_height": vertices[0].y, "verified_gap": probe.run(null).get("travel")}
	fixture.free()
	return result

func check_only_casters():
	var fixture := Node3D.new()
	root.add_child(fixture)
	var subject = box(fixture, "Plank", Vector3.ONE, Vector3.UP * 5)
	var shelf = box(fixture, "Shelf", Vector3(5, 1, 5), Vector3.ZERO)
	shelf.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_SHADOWS_ONLY
	var probe = Probe.new()
	probe.fixture = fixture
	var unsupported = probe.run(null)
	assert(unsupported.ok and not unsupported.found and unsupported.excluded_native_support)
	shelf.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON
	subject.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_SHADOWS_ONLY
	assert(probe.run(null).failure_reason == "shadows_only_subject")
	box(subject, "Badge", Vector3.ONE, Vector3.UP)
	var supported = probe.run(null)
	assert(supported.found and supported.support == "Shelf")
	assert(is_equal_approx(supported.travel, 5.0))
	fixture.free()


func check_tessellated_slope(subdivisions):
	var fixture = Node3D.new()
	root.add_child(fixture)
	var plane = PlaneMesh.new()
	plane.size = Vector2(6, 6)
	plane.subdivide_depth = subdivisions
	plane.subdivide_width = subdivisions
	var plank = mesh(fixture, "Plank", plane, Vector3(0, 8, 0))
	var shelf = mesh(fixture, "Shelf", plane, Vector3(0, 2, 0))
	plank.rotation.z = 0.32
	shelf.rotation.z = 0.32
	var probe = Probe.new()
	probe.fixture = fixture
	var measured = probe.run(null)
	if not measured.get("found", false):
		fixture.free()
		return measured
	plank.position = str_to_var(measured["position_after"])
	var vertices = plank.global_transform * plane.get_faces()
	var support_vertices = shelf.global_transform * plane.get_faces()
	var result = {"support": measured["support"], "mesh_gap": vertices[0].y - support_vertices[0].y, "verified_gap": probe.run(null).get("travel")}
	fixture.free()
	return result

func check_parent_write(units, mirrored, far):
	var fixture := Node3D.new()
	root.add_child(fixture)
	fixture.scale = Vector3(-units if mirrored else units, units, units)
	fixture.position.y = 100000000 if far else 0
	var start = Vector3(0, -99999992 if far else 4 / units, 0)
	var plank = box(fixture, "Plank", Vector3.ONE, start)
	plank.scale = Vector3.ONE / units
	var floor_mesh = box(fixture, "Floor", Vector3(10, 0.5, 10), Vector3.ZERO)
	floor_mesh.top_level = true
	floor_mesh.position = Vector3(0, -0.25, 0)
	floor_mesh.scale = Vector3.ONE
	var probe = Probe.new()
	probe.fixture = fixture
	var measured = probe.run(null)
	if not measured.get("found", false):
		fixture.free()
		return {"failure": measured.get("failure_reason")}
	plank.position = str_to_var(measured["position_after"])
	var gap = (plank.global_transform * plank.get_aabb()).position.y
	fixture.free()
	return {"actual_gap": gap}

func _initialize():
	call_deferred("run")

func run():
	check_only_casters()
	var narrow = Vector3(0.6, 0.6, 6.5)
	var offset = Vector3(1.75, 1.25, -0.7)
	var rows = [
		check_case(false, Vector3.ZERO, narrow, 0.17),
		check_case(true, offset, narrow, 0.17),
		check_case(true, offset, Vector3(8.8, 0.6, 6.5), 0.17),
		check_case(true, offset, narrow, 8),
		check_case(true, offset, narrow, 0.17, GeometryInstance3D.SHADOW_CASTING_SETTING_SHADOWS_ONLY),
	]
	var file = FileAccess.open("res://result.json", FileAccess.WRITE)
	file.store_string(JSON.stringify({"rows": rows, "slopes": [check_tessellated_slope(16), check_tessellated_slope(96)], "parents": [check_parent_write(1.0, false, false), check_parent_write(0.00005, false, false), check_parent_write(0.00005, true, false), check_parent_write(1.0, false, true)]}))
	file.close()
	quit()
