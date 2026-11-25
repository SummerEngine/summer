extends SceneTree

const Probe = preload("res://snap.gd")

func box(parent, label, dimensions, position):
	var mesh = BoxMesh.new()
	mesh.size = dimensions
	var node = MeshInstance3D.new()
	node.name = label
	node.mesh = mesh
	node.position = position
	parent.add_child(node)
	return node

func measure(prefix, column, hide = false):
	var scene = Node3D.new()
	root.add_child(scene)
	box(scene, "Floor", Vector3(20, 1, 20), Vector3(0, -0.5, 0))
	var shelf = MultiMeshInstance3D.new()
	shelf.name = "Shelf"
	scene.add_child(shelf)
	shelf.position = Vector3(1, 3, 0)
	shelf.rotation.y = 0.3
	var mesh = BoxMesh.new()
	mesh.size = Vector3(1, 0.5, 2)
	var instances = MultiMesh.new()
	instances.transform_format = MultiMesh.TRANSFORM_3D
	instances.mesh = mesh
	instances.instance_count = 2
	instances.set_instance_transform(0, Transform3D(Basis.IDENTITY, Vector3(-3, 0, 0)))
	instances.set_instance_transform(1, Transform3D(Basis.IDENTITY, Vector3(3, 1, 0)))
	instances.visible_instance_count = prefix
	shelf.multimesh = instances
	shelf.visible = not hide
	var center = shelf.global_transform * Vector3(column, 0, 0)
	var crate = box(scene, "Crate", Vector3(0.4, 0.6, 0.4), Vector3(center.x, 8, center.z))
	var args = {"direction": [0, -1, 0], "max_distance": 20, "gap": 0.15, "initial_transform": var_to_str(crate.transform)}
	crate.position.y = 0.45
	var probe = Probe.new()
	var hit = probe._measure(scene, crate, args)
	var answer = {"failure": hit.get("failure_reason")}
	if hit.get("found", false):
		crate.position = str_to_var(hit.position_after)
		args.erase("initial_transform")
		var fresh = probe._measure(scene, crate, args)
		answer = {"support": hit.support, "bottom": (crate.global_transform * crate.mesh.get_aabb()).position.y, "gap": fresh.travel}
	scene.free()
	return answer

func _initialize():
	run.call_deferred()

func run():
	var found = [measure(1, -3), measure(2, 3), measure(1, 3), measure(-1, 0), measure(0, -3), measure(-1, -3, true)]
	FileAccess.open("res://result.json", FileAccess.WRITE).store_string(JSON.stringify(found))
	quit()
