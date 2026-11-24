extends SceneTree

class Context:
	extends RefCounted
	var scene: Node
	func get_scene_root():
		return scene

func _initialize():
	_run.call_deferred()

func _mesh(parent: Node, label: String) -> MeshInstance3D:
	var n := MeshInstance3D.new()
	n.name = label
	n.mesh = BoxMesh.new()
	parent.add_child(n)
	n.position = Vector3(1, 2, 3)
	return n

func _check_world_bounds(probe, errors: Array):
	var scene := Node3D.new()
	var piece := _mesh(scene, "Piece")
	for own in [false, true]:
		var view := SubViewport.new()
		view.name = "Private" if own else "Shared"
		view.own_world_3d = own
		piece.add_child(view)
		var geometry := _mesh(view, "Geometry")
		geometry.position.x = 100.0 if own else 18.0
	for attached in [false, true]:
		if attached:
			root.add_child(scene)
			await process_frame
		var shared = probe._cmd_bounds(scene, attached, {"nodes": [{"path": "Piece"}, {"path": "Piece/Shared/Geometry"}]})
		if not shared.ok or shared.nodes[0].geometry_count != 2 or shared.nodes[0].intervals[0] != [0.5, 18.5]:
			errors.append("bounds must include inherited-world geometry and ignore private-world geometry")
		var foreign = probe._cmd_bounds(scene, attached, {"nodes": [{"path": "Piece"}, {"path": "Piece/Private/Geometry"}]})
		if foreign.get("failure_reason") != "different_world_3d":
			errors.append("cannot compare bounds from different worlds")
		var private_only = probe._cmd_bounds(scene, attached, {"nodes": [{"path": "Piece/Private/Geometry"}]})
		if not private_only.ok or private_only.nodes[0].intervals[0] != [99.5, 100.5]:
			errors.append("bounds must use the subject's own private world")
	scene.free()

func _check_transform_plan(probe, errors: Array):
	var scene := Node3D.new()
	root.add_child(scene)
	var parent := Node3D.new()
	parent.name = "Rig"
	scene.add_child(parent)
	var piece := _mesh(parent, "Piece")
	var wanted := Transform3D(Basis.from_euler(Vector3(0.3, -0.7, 0.25)), Vector3(4.125, 3.3, -6.7))
	var request = {"path": "Rig/Piece", "desired": []}
	for v: Vector3 in [wanted.basis.x, wanted.basis.y, wanted.basis.z, wanted.origin]:
		request.desired.append([v.x, v.y, v.z])
	var small := Basis.IDENTITY.scaled(Vector3.ONE * 0.00005)
	var mirrored := Basis(Vector3.UP, 0.5).scaled(Vector3(-2, 1.3, 0.8))
	var lossy := Basis(Vector3.RIGHT, Vector3(1, 0.0000001, 0), Vector3.BACK)
	for case in [[small, true], [mirrored, true], [lossy, false], [Basis.IDENTITY.scaled(Vector3(0, 1, 1)), false]]:
		parent.basis = case[0]
		var original := piece.transform
		var plan = probe._plan_transform(scene, request)
		if piece.transform != original or plan.ok != case[1]:
			errors.append("full-pose preflight: " + str(case))
		elif plan.ok:
			piece.transform = str_to_var(plan.local_transform)
			if not piece.global_transform.is_equal_approx(wanted):
				errors.append("planned pose differs from Godot: " + str(case))
			piece.transform = str_to_var(plan.original_transform)
			if piece.transform != original:
				errors.append("original transform changed")
		elif plan.failure_reason != "transform_not_representable":
			errors.append("unexpected refusal: " + str(plan))
	scene.free()

func _run():
	var scene := Node3D.new()
	scene.name = "Scene"
	root.add_child(scene)
	scene.position = Vector3(10, 20, 30)
	scene.rotation = Vector3(0.2, 0.5, 0.1)
	scene.scale = Vector3(2, 1, 3)
	var parent := Node3D.new()
	parent.name = "Parent"
	scene.add_child(parent)
	parent.position = Vector3(4, 3, 2)
	parent.rotation = Vector3(0.1, 0.3, 0.2)
	parent.scale = Vector3(1.5, 2, 0.5)
	parent.visible = false
	var inherited := _mesh(parent, "Inherited")
	var top := _mesh(parent, "Top")
	top.top_level = true
	top.position = Vector3(2, 3, 4)
	var plain := Node.new()
	plain.name = "Plain"
	parent.add_child(plain)
	var independent := _mesh(plain, "Independent")
	var disabled_scale := _mesh(scene, "Unscaled")
	disabled_scale.set_disable_scale(true)
	var rotated := _mesh(scene, "RotationOrder")
	rotated.rotation_order = EULER_ORDER_ZXY
	rotated.rotation = Vector3(0.6, 0.4, 0.2)
	await process_frame
	var errors: Array = []
	var observations: Array = []
	var placement = load("res://placement.gd").new()
	var snap = load("res://snap.gd").new()
	for probe in [placement, snap]:
		for n in [scene, parent, inherited, top, independent, disabled_scale, rotated]:
			var actual: Transform3D = probe.call("_xf", n, scene)
			var visible: bool = probe.call("_visible", n, scene)
			if not actual.is_equal_approx(n.global_transform):
				errors.append("transform: " + str(scene.get_path_to(n)))
			if visible != n.is_visible_in_tree():
				errors.append("visibility: " + str(scene.get_path_to(n)))
			observations.append({"path": str(scene.get_path_to(n)), "origin": [actual.origin.x, actual.origin.y, actual.origin.z], "visible": visible})
		var parent_xf: Transform3D = probe.call("_parent_xf", top, scene)
		if not parent_xf.is_equal_approx(Transform3D.IDENTITY):
			errors.append("top_level parent space")
	var geoms: Array = placement.call("_geoms", scene, scene, [])
	var mesh_items: Array = snap.call("_mesh_items", scene, scene, null, {"screen_space": 0, "not_mesh": 0})
	for collection in [geoms, mesh_items]:
		if collection.size() != 3:
			errors.append("visible mesh count: " + str(collection.size()))
		for item in collection:
			if not (item[1] as Transform3D).is_equal_approx(item[0].global_transform):
				errors.append("mesh transform")
	var collected: Dictionary = placement.call("_collect", scene)
	for item in collected["meshes"]:
		var expected: Transform3D = scene.global_transform.affine_inverse() * item[0].global_transform
		if not (item[1] as Transform3D).is_equal_approx(expected):
			errors.append("asset frame: " + str(item[0].name))
		if bool(item[3]) != item[0].is_visible_in_tree():
			errors.append("asset visibility: " + str(item[0].name))
	var ctx := Context.new()
	ctx.scene = scene
	var read: Dictionary = load("res://transform.gd").new().run(ctx)
	if not read["ok"] or not str_to_var(read["transform"]).is_equal_approx(top.global_transform):
		errors.append("inspector transform")
	var bounds: Dictionary = placement.call("_cmd_bounds", scene, false, {"nodes": [{"path": "Parent/Plain/Independent"}, {"path": "Parent/Top"}, {"path": "Parent"}]})
	if bounds["nodes"][0]["parent_xform"] != bounds["nodes"][1]["parent_xform"]:
		errors.append("independent parent spaces")
	if bounds["nodes"][2]["independent_geometry"] != ["Parent/Plain/Independent"]:
		errors.append("independent geometry must name visible plain child only")
	_check_transform_plan(placement, errors)
	await _check_world_bounds(placement, errors)
	var f := FileAccess.open("res://result.json", FileAccess.WRITE)
	f.store_string(JSON.stringify({"errors": errors, "observations": observations, "bounds": bounds}))
	f.close()
	quit()
