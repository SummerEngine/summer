extends SceneTree

# Exercise the production kernel against real physics. Equivalent baked meshes
# and scaled instances must report the same physical dimensions and clearance.
func _initialize() -> void:
	_run.call_deferred()

func _run() -> void:
	var kernel: Script = load("res://scene_audit.gd")
	var holder := Node3D.new()
	root.add_child(holder)
	var cases := [
		["scaled", Vector3(1, 0.2, 1), Vector3(2, 1, 1)],
		["baked", Vector3(2, 0.2, 1), Vector3.ONE],
		["axis_swap", Vector3(1, 0.2, 2), Vector3(4, 1, 0.25)],
		["axis_swap_baked", Vector3(4, 0.2, 0.5), Vector3.ONE],
		["threshold_scaled", Vector3(0.4, 0.2, 0.1), Vector3(2, 1, 2)],
		["threshold_baked", Vector3(0.8, 0.2, 0.2), Vector3.ONE],
		["small_basis", Vector3(20, 2, 4), Vector3(0.1, 0.1, 0.1)],
		["small_basis_baked", Vector3(2, 0.2, 0.4), Vector3.ONE],
		["long_z", Vector3(2, 0.2, 1), Vector3(0.25, 1, 3)],
		["long_z_baked", Vector3(0.5, 0.2, 3), Vector3.ONE],
	]
	var pending: Array = []
	for i in cases.size():
		var mesh := BoxMesh.new()
		mesh.size = cases[i][1]
		var xf := Transform3D(Basis.from_scale(cases[i][2]), Vector3(i * 20, 0, 0))
		var bounds: AABB = xf * mesh.get_aabb()
		var body := StaticBody3D.new()
		body.collision_layer = 1
		body.position = Vector3(bounds.end.x + 0.35, 0, 0)
		holder.add_child(body)
		var collision := CollisionShape3D.new()
		var shape := BoxShape3D.new()
		shape.size = Vector3(0.1, 10, 10)
		collision.shape = shape
		body.add_child(collision)
		pending.append([cases[i][0], mesh, xf, bounds, body])
	await physics_frame
	await physics_frame
	var observations: Array = []
	for c in pending:
		var audit: Node = kernel.new()
		var mesh: BoxMesh = c[1]
		var xf: Transform3D = c[2]
		var bounds: AABB = c[3]
		var body: StaticBody3D = c[4]
		audit.set("_state", holder.get_world_3d().direct_space_state)
		audit.set("_q", PhysicsRayQueryParameters3D.new())
		audit.set("_body_inst", {body.get_rid().get_id(): 1})
		audit.set("_inst", [
			{"i": 0, "role": "prop", "in": true, "laabb": mesh.get_aabb(), "waabb": bounds, "xf": xf, "bodies": []},
			{"i": 1, "role": "wall", "in": true},
		])
		var rows: Array = audit.call("_scan_long_props")
		# Independent oracle: the native transformed BoxMesh AABB and a direct
		# physics ray to the wall, not the kernel's support-distance formula.
		var query := PhysicsRayQueryParameters3D.create(xf.origin, xf.origin + Vector3(10, 0, 0), 1)
		var hit := holder.get_world_3d().direct_space_state.intersect_ray(query)
		var clearance := float(hit["position"].x) - bounds.end.x
		observations.append({"case": c[0], "rows": rows, "native_size": [bounds.size.x, bounds.size.z], "native_clearance": clearance})
		audit.free()
	var out := FileAccess.open("res://result.json", FileAccess.WRITE)
	out.store_string(JSON.stringify(observations))
	out.close()
	quit()
