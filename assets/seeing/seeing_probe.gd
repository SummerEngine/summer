@tool
extends Node
## Summer seeing kernel.
##
## The MCP seeing tools (summer_frame_nodes, summer_shot_sheet,
## summer_debug_views, summer_zoom, summer_frame_shot) write a throwaway
## wrapper scene into a per-call OS temp directory: the wrapper instances the
## target scene as "Subject" and carries this script as a built-in @tool
## script. The wrapper is rendered with the engine's ScenePreview op, which
## instantiates it under an offscreen SubViewport with its own World3D, so this
## node runs inside a private COPY of the scene. Nothing here touches the edited
## scene, the undo history or any project file. The only files written are in
## the wrapper's own temp directory: result.json and, when asked, tile
## captures.
##
## Arguments arrive as DATA only: config.json next to the wrapper scene, found
## through this built-in script's own resource path and parsed as JSON. No
## caller text is ever spliced into this source.
##
## Modes (config "mode"):
##   "analyze": world bounds of subject nodes, spawn poses, and (when asked) a
##     physics pass built from the VISIBLE geometry: corridor scans and
##     per-candidate measurements (thick sweep visibility, near-lens check,
##     low-angle correction, a ray grid through the frame). The preview's own 3D
##     render is disabled; only result.json matters.
##   "render": a labelled grid of tiles. Each "shot" tile is a SubViewport with
##     its own Camera3D at an explicit pose sharing the preview world, so the
##     scene's REAL WorldEnvironment and lights apply. Views are native
##     Viewport.debug_draw modes, except "normals", which renders a second
##     private copy with an unshaded world-normal override material. "prev" and
##     "diff" tiles compare a shot against a previous JPEG. ScenePreview reads
##     the composed canvas back as the returned image.

const SUBJECT_NAME := "Subject"

const CLASS_HARD := 0
const CLASS_SOFT := 1
const CLASS_SUBJECT := 2
const LAYER_HARD := 1
const LAYER_SOFT := 2
const LAYER_SUBJECT := 4
const CLASS_NAMES := ["hard", "soft", "subject"]

const DEFAULT_SOFT_PATTERN := "(tree|bush|shrub|grass|weed|moss|foliage|leaf|leaves|plant|flower|vine|ivy|hedge|pebble|gravel|rubble|litter|puddle|decal|fence|rail|lamp|lantern|light|pole|post|sign|wire|cable|pipe|crate|barrel|bench|prop|clutter|debris|trash|bin|bollard|hydrant|planter|pot|chair|table|awning|banner|flag)"
const DEFAULT_HARD_PATTERN := "(wall|building|house|facade|terrain|ground|floor|road|street|pavement|sidewalk|cliff|rock|mountain|roof|tower|bridge|stair|pier|corner|crown|cornice|base|dado|block)"

var _cfg: Dictionary = {}
var _out_dir := ""
var _result: Dictionary = {}
var _subject: Node = null
var _scene_root_name := ""
var _captures: Array = []
var _diffs: Array = []
var _draws := 0

# Physics pass state (analyze mode only).
var _space := RID()
var _state: PhysicsDirectSpaceState3D = null
var _bodies: Array = []
var _shapes: Array = []
var _body_geom: Dictionary = {}
var _geoms: Array = []
var _sphere_shapes: Dictionary = {}

var _soft_re: RegEx = null
var _hard_re: RegEx = null

# Render mode state.
var _normals_world: World3D = null


func _ready() -> void:
	_result = {"ok": false, "stage": "ready", "warnings": [], "errors": []}
	# Built-in script path: "<dir>/wrapper.tscn::GDScript_seeing".
	var script_path := String((get_script() as Script).resource_path)
	var wrapper_path := script_path.get_slice("::", 0)
	_out_dir = wrapper_path.get_base_dir()
	if wrapper_path == "" or not wrapper_path.ends_with("wrapper.tscn"):
		push_error("Summer seeing kernel: cannot locate its wrapper scene (script path '%s')." % script_path)
		return
	var config_path := _out_dir.path_join("config.json")
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(config_path))
	if typeof(parsed) != TYPE_DICTIONARY:
		_fail("config_unreadable", "Could not read the seeing config at " + config_path)
		return
	_cfg = parsed
	_result["renderer"] = RenderingServer.get_current_rendering_method()
	_subject = get_parent().get_node_or_null(SUBJECT_NAME)
	if _subject == null:
		_fail("no_subject", "The wrapper scene has no Subject instance (the target scene failed to instantiate).")
		return
	var packed: PackedScene = load(String(_cfg.get("scene_path", ""))) as PackedScene
	if packed != null and packed.get_state().get_node_count() > 0:
		_scene_root_name = String(packed.get_state().get_node_name(0))
	_result["scene_root_name"] = _scene_root_name
	_result["stage"] = "configured"
	var mode := String(_cfg.get("mode", ""))
	if mode == "render":
		_setup_render()
	elif mode == "analyze":
		get_viewport().disable_3d = true
		_write_result()
		# Deferred so CSG roots and @tool scripts that settle with call_deferred
		# have run before the geometry is read. ScenePreview iterates the main
		# loop after instantiating, which flushes this call.
		call_deferred("_analyze")
	else:
		_fail("bad_mode", "Unknown seeing mode '" + mode + "'.")


func _exit_tree() -> void:
	if RenderingServer.frame_post_draw.is_connected(_on_post_draw):
		RenderingServer.frame_post_draw.disconnect(_on_post_draw)
	_free_physics()


# ---------------------------------------------------------------------------
# Result plumbing
# ---------------------------------------------------------------------------

func _fail(reason: String, message: String) -> void:
	_result["ok"] = false
	_result["failure_reason"] = reason
	(_result["errors"] as Array).append(message)
	_write_result()


func _warn(message: String) -> void:
	var warnings: Array = _result["warnings"]
	if warnings.size() < 24 and not warnings.has(message):
		warnings.append(message)


func _write_result() -> void:
	var f := FileAccess.open(_out_dir.path_join("result.json"), FileAccess.WRITE)
	if f == null:
		return
	f.store_string(JSON.stringify(_result))
	f.close()


static func _vec(value: Variant, fallback := Vector3.ZERO) -> Vector3:
	if value is Array and (value as Array).size() >= 3:
		var a: Array = value
		return Vector3(float(a[0]), float(a[1]), float(a[2]))
	return fallback


static func _arr(v: Vector3, digits := 3) -> Array:
	var step := pow(10.0, -digits)
	return [snappedf(v.x, step), snappedf(v.y, step), snappedf(v.z, step)]


static func _aabb_dict(box: AABB) -> Dictionary:
	return {"position": _arr(box.position), "size": _arr(box.size)}


# Lenient path resolution, the same spellings ScenePreview accepts: a path
# relative to the scene root, one that includes the root's name, the root
# itself ("." or its name), or a bare unique name searched recursively.
func _resolve(path: String) -> Node:
	var p := path.strip_edges()
	if p == "" or p == "." or p == _scene_root_name:
		return _subject
	var node := _subject.get_node_or_null(NodePath(p))
	if node == null and _scene_root_name != "" and p.begins_with(_scene_root_name + "/"):
		node = _subject.get_node_or_null(NodePath(p.substr(_scene_root_name.length() + 1)))
	if node == null and not p.contains("/"):
		node = _subject.find_child(p, true, false)
	return node


func _rel(node: Node) -> String:
	if node == _subject:
		return "."
	return String(_subject.get_path_to(node))


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------

func _hidden(node: Node) -> bool:
	return node is Node3D and not (node as Node3D).is_visible_in_tree()


# Every visible mesh under `root` as {node, mesh, xform}. MultiMesh instances
# and GridMap cells expand to one entry each (capped); CSG contributes its
# root mesh only.
func _geometry_items(root: Node, multimesh_cap: int) -> Array:
	var items: Array = []
	var stack: Array = [root]
	while not stack.is_empty():
		var node: Node = stack.pop_back()
		if _hidden(node):
			continue
		var descend := true
		if node is MeshInstance3D:
			var mi := node as MeshInstance3D
			if mi.mesh != null:
				items.append({"node": mi, "mesh": mi.mesh, "xform": mi.global_transform})
		elif node is MultiMeshInstance3D:
			var mm: MultiMesh = (node as MultiMeshInstance3D).multimesh
			if mm != null and mm.mesh != null and mm.transform_format == MultiMesh.TRANSFORM_3D:
				var count := mm.instance_count
				if mm.visible_instance_count >= 0:
					count = mini(count, mm.visible_instance_count)
				if count > multimesh_cap:
					_warn("MultiMesh %s has %d instances; only the first %d were used." % [_rel(node), count, multimesh_cap])
					count = multimesh_cap
				var base := (node as Node3D).global_transform
				for i in count:
					items.append({"node": node, "mesh": mm.mesh, "xform": base * mm.get_instance_transform(i)})
		elif node is CSGShape3D:
			var csg := node as CSGShape3D
			if csg.is_root_shape():
				var meshes: Array = csg.get_meshes()
				if meshes.size() >= 2 and meshes[1] is Mesh:
					items.append({"node": csg, "mesh": meshes[1], "xform": csg.global_transform * Transform3D(meshes[0])})
			descend = false
		elif node is GridMap:
			var gm := node as GridMap
			var pairs: Array = gm.get_meshes()
			var i := 0
			while i + 1 < pairs.size():
				if pairs[i + 1] is Mesh:
					items.append({"node": gm, "mesh": pairs[i + 1], "xform": gm.global_transform * Transform3D(pairs[i])})
				i += 2
		if descend:
			for child in node.get_children():
				stack.push_back(child)
	return items


# Merged world bounds of the visible geometry under `root` (Label3D/Sprite3D
# included, lights/particles/probes excluded).
func _bounds(root: Node) -> Dictionary:
	var box := AABB()
	var has := false
	var count := 0
	for item in _geometry_items(root, 4096):
		var mesh: Mesh = item["mesh"]
		var b: AABB = (item["xform"] as Transform3D) * mesh.get_aabb()
		box = b if not has else box.merge(b)
		has = true
		count += 1
	var stack: Array = [root]
	while not stack.is_empty():
		var node: Node = stack.pop_back()
		if _hidden(node):
			continue
		if node is SpriteBase3D or node is Label3D:
			var vi := node as VisualInstance3D
			var b2: AABB = vi.global_transform * vi.get_aabb()
			if b2.size != Vector3.ZERO:
				box = b2 if not has else box.merge(b2)
				has = true
				count += 1
		for child in node.get_children():
			stack.push_back(child)
	if not has and root is Node3D:
		box = AABB((root as Node3D).global_position - Vector3(0.5, 0.5, 0.5), Vector3.ONE)
	return {"has": has, "aabb": box, "count": count}


# ---------------------------------------------------------------------------
# Analyze
# ---------------------------------------------------------------------------

func _analyze() -> void:
	var started := Time.get_ticks_msec()
	_result["stage"] = "analyze"
	var subjects: Array = []
	var subject_nodes: Array = []
	var merged := AABB()
	var missing: Array = []
	for raw in (_cfg.get("subjects", []) as Array):
		var path := String(raw)
		var node := _resolve(path)
		if node == null:
			missing.append(path)
			continue
		subject_nodes.append(node)
		var b := _bounds(node)
		merged = b["aabb"] if subjects.is_empty() else merged.merge(b["aabb"])
		subjects.append({"path": path, "resolved": _rel(node), "has_geometry": b["has"], "visuals": b["count"], "aabb": _aabb_dict(b["aabb"])})
	_result["subjects"] = subjects
	if not missing.is_empty():
		_result["missing"] = missing
		_fail("node_not_found", "Node(s) not found in the scene: " + ", ".join(PackedStringArray(missing)))
		return
	var spawn_path := String(_cfg.get("spawn", ""))
	if spawn_path != "":
		var spawn := _resolve(spawn_path)
		if spawn == null or not (spawn is Node3D):
			_result["missing"] = [spawn_path]
			_fail("node_not_found", "Spawn node not found or not a Node3D: " + spawn_path)
			return
		var s3 := spawn as Node3D
		var info := {"path": spawn_path, "origin": _arr(s3.global_position), "forward": _arr(-s3.global_transform.basis.z.normalized())}
		var cams := spawn.find_children("*", "Camera3D", true, false)
		if spawn is Camera3D:
			cams.push_front(spawn)
		if not cams.is_empty():
			var cam := cams[0] as Camera3D
			info["camera"] = {"path": _rel(cam), "position": _arr(cam.global_position), "forward": _arr(-cam.global_transform.basis.z.normalized()), "fov": cam.fov}
		_result["spawn"] = info
	var tasks: Array = _cfg.get("tasks", [])
	if tasks.has("corridor_scan") or tasks.has("measure"):
		_build_physics(subject_nodes)
		if _state == null:
			_fail("physics_unavailable", "Could not create a physics space for the visibility pass.")
			return
		if tasks.has("corridor_scan"):
			var spec: Dictionary = (_cfg.get("corridor", {}) as Dictionary).duplicate()
			if not spec.has("aabb"):
				spec["aabb"] = _aabb_dict(merged)
			_result["corridor_scan"] = _corridor_scan(spec)
		if tasks.has("measure"):
			_result["measurements"] = _measure_all(_cfg.get("candidates", []))
	_result["duration_ms"] = Time.get_ticks_msec() - started
	_result["ok"] = true
	_result["stage"] = "done"
	_write_result()
	_free_physics()


func _class_for(node: Node, box: AABB, subject_nodes: Array, occ: Dictionary) -> Dictionary:
	var path := _rel(node)
	if not bool(occ.get("subject_occludes", false)):
		for s in subject_nodes:
			if s == node or (s as Node).is_ancestor_of(node):
				return {"cls": CLASS_SUBJECT, "why": "subject"}
	for prefix in (occ.get("ignore", []) as Array):
		if _path_has_prefix(path, String(prefix)):
			return {"cls": -1, "why": "ignored"}
	for prefix in (occ.get("hard", []) as Array):
		if _path_has_prefix(path, String(prefix)):
			return {"cls": CLASS_HARD, "why": "path"}
	for prefix in (occ.get("soft", []) as Array):
		if _path_has_prefix(path, String(prefix)):
			return {"cls": CLASS_SOFT, "why": "path"}
	var hard_layers := int(occ.get("hard_layers", 0))
	var soft_layers := int(occ.get("soft_layers", 0))
	if hard_layers != 0 or soft_layers != 0:
		var layer := _collision_layer_near(node)
		if layer != 0:
			if layer & hard_layers:
				return {"cls": CLASS_HARD, "why": "layer"}
			if layer & soft_layers:
				return {"cls": CLASS_SOFT, "why": "layer"}
	var cur: Node = node
	while cur != null and cur != _subject.get_parent():
		if cur.is_in_group("camera_soft"):
			return {"cls": CLASS_SOFT, "why": "group"}
		if cur.is_in_group("camera_hard"):
			return {"cls": CLASS_HARD, "why": "group"}
		cur = cur.get_parent()
	if node is MultiMeshInstance3D:
		return {"cls": CLASS_SOFT, "why": "multimesh"}
	# Deepest named segment wins: ".../House1/Front/lantern/Model/street_lamp_02"
	# is a lamp (soft), ".../House1/Front/s0_c0/Model/wall_double_..." a wall.
	var segments := path.split("/")
	for i in range(segments.size() - 1, -1, -1):
		var seg := segments[i]
		if _soft_re != null and _soft_re.search(seg) != null:
			return {"cls": CLASS_SOFT, "why": "name"}
		if _hard_re != null and _hard_re.search(seg) != null:
			return {"cls": CLASS_HARD, "why": "name"}
	var longest := maxf(box.size.x, maxf(box.size.y, box.size.z))
	if longest <= float(occ.get("soft_max_extent", 2.5)):
		return {"cls": CLASS_SOFT, "why": "size"}
	return {"cls": CLASS_HARD, "why": "size"}


static func _path_has_prefix(path: String, prefix: String) -> bool:
	var p := prefix.strip_edges().trim_suffix("/")
	if p == "":
		return false
	return path == p or path.begins_with(p + "/")


func _collision_layer_near(node: Node) -> int:
	var cur: Node = node
	for i in 4:
		if cur == null:
			break
		if cur is CollisionObject3D:
			return (cur as CollisionObject3D).collision_layer
		cur = cur.get_parent()
	for child in node.get_children():
		if child is CollisionObject3D:
			return (child as CollisionObject3D).collision_layer
	return 0


func _build_physics(subject_nodes: Array) -> void:
	var t0 := Time.get_ticks_msec()
	_space = PhysicsServer3D.space_create()
	PhysicsServer3D.space_set_active(_space, true)
	var occ: Dictionary = _cfg.get("occluders", {})
	_soft_re = RegEx.create_from_string("(?i)" + String(occ.get("soft_pattern", DEFAULT_SOFT_PATTERN)))
	_hard_re = RegEx.create_from_string("(?i)" + String(occ.get("hard_pattern", DEFAULT_HARD_PATTERN)))
	var shape_cache: Dictionary = {}
	var counts := {"hard": 0, "soft": 0, "subject": 0, "ignored": 0}
	var why_counts := {}
	var examples := {"hard": [], "soft": [], "subject": []}
	var faces_total := 0
	var face_cap := int(_cfg.get("face_cap", 4000000))
	var capped := false
	for item in _geometry_items(_subject, int(_cfg.get("multimesh_cap", 2000))):
		var node: Node = item["node"]
		var mesh: Mesh = item["mesh"]
		var xform: Transform3D = item["xform"]
		var box: AABB = xform * mesh.get_aabb()
		var c := _class_for(node, box, subject_nodes, occ)
		var cls := int(c["cls"])
		if cls < 0:
			counts["ignored"] += 1
			continue
		# Physics bodies do not take scale reliably: a scaled (or sheared)
		# instance gets its own shape with the transform baked into the faces;
		# unscaled instances share one shape per mesh.
		var body_xform := xform
		var scaled := not _is_rigid(xform.basis)
		var key := mesh.get_instance_id()
		var shape := RID()
		if not scaled and shape_cache.has(key):
			shape = shape_cache[key]
		else:
			var faces: PackedVector3Array = mesh.get_faces()
			if faces.is_empty():
				if not scaled:
					shape_cache[key] = RID()
				continue
			if faces_total + faces.size() / 3 > face_cap:
				capped = true
				continue
			faces_total += faces.size() / 3
			if scaled:
				for k in faces.size():
					faces[k] = xform * faces[k]
				body_xform = Transform3D.IDENTITY
			shape = PhysicsServer3D.concave_polygon_shape_create()
			PhysicsServer3D.shape_set_data(shape, {"faces": faces, "backface_collision": true})
			_shapes.append(shape)
			if not scaled:
				shape_cache[key] = shape
		if not shape.is_valid():
			continue
		var body := PhysicsServer3D.body_create()
		PhysicsServer3D.body_set_mode(body, PhysicsServer3D.BODY_MODE_STATIC)
		PhysicsServer3D.body_add_shape(body, shape)
		PhysicsServer3D.body_set_collision_layer(body, [LAYER_HARD, LAYER_SOFT, LAYER_SUBJECT][cls])
		PhysicsServer3D.body_set_collision_mask(body, 0)
		PhysicsServer3D.body_set_space(body, _space)
		PhysicsServer3D.body_set_state(body, PhysicsServer3D.BODY_STATE_TRANSFORM, body_xform)
		_bodies.append(body)
		var cls_name: String = CLASS_NAMES[cls]
		counts[cls_name] += 1
		var why_key := cls_name + ":" + String(c["why"])
		why_counts[why_key] = int(why_counts.get(why_key, 0)) + 1
		var path := _rel(node)
		_body_geom[body.get_id()] = {"path": path, "cls": cls}
		var ex: Array = examples[cls_name]
		if ex.size() < 6 and not ex.has(path):
			ex.append(path)
	if capped:
		_warn("The visibility pass hit its face budget; some large meshes were skipped.")
	_state = PhysicsServer3D.space_get_direct_state(_space)
	_result["occluders"] = {"counts": counts, "by_rule": why_counts, "examples": examples, "faces": faces_total, "build_ms": Time.get_ticks_msec() - t0}


static func _is_rigid(b: Basis) -> bool:
	return absf(b.x.length() - 1.0) < 0.001 and absf(b.y.length() - 1.0) < 0.001 and absf(b.z.length() - 1.0) < 0.001 \
		and absf(b.x.dot(b.y)) < 0.001 and absf(b.x.dot(b.z)) < 0.001 and absf(b.y.dot(b.z)) < 0.001


func _free_physics() -> void:
	for body in _bodies:
		PhysicsServer3D.free_rid(body)
	_bodies.clear()
	for shape in _shapes:
		PhysicsServer3D.free_rid(shape)
	_shapes.clear()
	for r in _sphere_shapes.values():
		PhysicsServer3D.free_rid(r)
	_sphere_shapes.clear()
	if _space.is_valid():
		PhysicsServer3D.free_rid(_space)
		_space = RID()
	_state = null


func _sphere(radius: float) -> RID:
	var key := snappedf(radius, 0.001)
	if _sphere_shapes.has(key):
		return _sphere_shapes[key]
	var s := PhysicsServer3D.sphere_shape_create()
	PhysicsServer3D.shape_set_data(s, key)
	_sphere_shapes[key] = s
	return s


func _ray(from: Vector3, to: Vector3, mask: int) -> Dictionary:
	var q := PhysicsRayQueryParameters3D.create(from, to, mask)
	q.hit_back_faces = true
	return _state.intersect_ray(q)


func _overlaps(pos: Vector3, radius: float, mask: int) -> Array:
	var q := PhysicsShapeQueryParameters3D.new()
	q.shape_rid = _sphere(radius)
	q.transform = Transform3D(Basis(), pos)
	q.collision_mask = mask
	return _state.intersect_shape(q, 4)


# Fraction [0..1] of the motion a sphere can travel before touching `mask`
# geometry, plus the path of what it touched.
func _sweep(from: Vector3, motion: Vector3, radius: float, mask: int) -> Dictionary:
	if motion.length() < 0.001:
		return {"free": 1.0, "hit": ""}
	var q := PhysicsShapeQueryParameters3D.new()
	q.shape_rid = _sphere(radius)
	q.transform = Transform3D(Basis(), from)
	q.motion = motion
	q.collision_mask = mask
	var res: PackedFloat32Array = _state.cast_motion(q)
	if res.size() < 2 or res[1] >= 1.0:
		return {"free": 1.0, "hit": ""}
	var hit_path := ""
	var q2 := PhysicsShapeQueryParameters3D.new()
	q2.shape_rid = _sphere(radius * 1.05)
	q2.transform = Transform3D(Basis(), from + motion * res[1])
	q2.collision_mask = mask
	var info := _state.get_rest_info(q2)
	if info.has("rid"):
		hit_path = String((_body_geom.get((info["rid"] as RID).get_id(), {}) as Dictionary).get("path", ""))
	return {"free": float(res[0]), "hit": hit_path}


# cast_motion resolves the free fraction in coarse steps of the motion, so a
# long run is refined with a second, short sweep around the first contact.
func _free_run(origin: Vector3, dir: Vector3, max_len: float, radius: float, mask: int) -> float:
	var s := _sweep(origin, dir * max_len, radius, mask)
	var coarse := float(s["free"]) * max_len
	if float(s["free"]) >= 1.0:
		return max_len
	var start := maxf(0.0, coarse - 1.0)
	var span := minf(max_len - start, 2.5)
	var fine := _sweep(origin + dir * start, dir * span, radius, mask)
	return minf(max_len, start + float(fine["free"]) * span)


# The first surface under the camera (from 1 m above it, so a camera sunk
# slightly into the ground still finds that ground, while roofs and wall caps
# overhead never count as "ground").
func _ground_below(pos: Vector3, mask: int) -> Variant:
	var hit := _ray(pos + Vector3.UP * 1.0, pos + Vector3.DOWN * 200.0, mask)
	if hit.is_empty():
		return null
	return float((hit["position"] as Vector3).y)


func _corridor_scan(spec: Dictionary) -> Dictionary:
	var box := AABB(_vec((spec.get("aabb", {}) as Dictionary).get("position")), _vec((spec.get("aabb", {}) as Dictionary).get("size")))
	var height := float(spec.get("height", 1.6))
	var floor_y := float(spec.get("floor_y", box.position.y))
	var mask := LAYER_HARD | LAYER_SOFT | LAYER_SUBJECT
	var radius := float(spec.get("radius", 0.25))
	var max_len := float(spec.get("max_len", 120.0))
	var grid := int(spec.get("grid", 4))
	var dirs := int(spec.get("directions", 8))
	var runs: Array = []
	var blocked := 0
	for gx in grid:
		for gz in grid:
			var fx := (gx + 0.5) / grid
			var fz := (gz + 0.5) / grid
			var seed := Vector3(box.position.x + box.size.x * fx, floor_y + height, box.position.z + box.size.z * fz)
			var g: Variant = _ground_below(seed, LAYER_HARD | LAYER_SUBJECT)
			if g != null and float(g) > floor_y - 1.0 and float(g) < seed.y:
				seed.y = float(g) + height
			if not _overlaps(seed, 0.3, mask).is_empty():
				blocked += 1
				continue
			for k in dirs:
				var a := PI * float(k) / float(dirs)
				var d := Vector3(sin(a), 0.0, cos(a))
				var perp := Vector3(d.z, 0.0, -d.x)
				runs.append({
					"seed": _arr(seed, 2), "dir": _arr(d, 4),
					"fwd": snappedf(_free_run(seed, d, max_len, radius, mask), 0.01),
					"back": snappedf(_free_run(seed, -d, max_len, radius, mask), 0.01),
					"left": snappedf(_free_run(seed, perp, 40.0, radius, mask), 0.01),
					"right": snappedf(_free_run(seed, -perp, 40.0, radius, mask), 0.01),
				})
	return {"runs": runs, "blocked_seeds": blocked}


func _look_basis(pos: Vector3, look: Vector3) -> Basis:
	var fwd := (look - pos).normalized()
	var up := Vector3.UP
	if absf(fwd.dot(up)) > 0.999:
		up = Vector3(0, 0, -1)
	return Basis.looking_at(fwd, up)


func _measure_all(candidates: Array) -> Array:
	var spec: Dictionary = _cfg.get("measure", {})
	var out: Array = []
	for i in candidates.size():
		out.append(_measure_one(i, candidates[i], spec))
	return out


func _measure_one(index: int, cand: Dictionary, spec: Dictionary) -> Dictionary:
	var pos := _vec(cand.get("position"))
	var look := _vec(cand.get("look_at"))
	var fov := float(cand.get("fov", 60.0))
	var aspect := float(spec.get("aspect", 16.0 / 9.0))
	var all_mask := LAYER_HARD | LAYER_SOFT | LAYER_SUBJECT
	var solid_mask := LAYER_HARD | LAYER_SUBJECT
	var adjustments: Array = []
	var rec := {"i": index}
	# 1. Ground clearance and the low-angle rule: a camera that would end up in
	# the ground moves CLOSER along its line of sight and widens its FOV to keep
	# the framing, instead of being pushed up or buried.
	var clearance := float(cand.get("min_clearance", spec.get("min_clearance", 0.3)))
	var max_fov := float(spec.get("max_fov", 100.0))
	for _attempt in 2:
		var ground: Variant = _ground_below(pos, solid_mask)
		if ground == null or pos.y >= float(ground) + clearance:
			break
		var target_y := float(ground) + clearance
		var dir := (pos - look).normalized()
		var dist := pos.distance_to(look)
		if bool(cand.get("low_angle_rule", true)) and dir.y < -0.02:
			var d2 := (target_y - look.y) / dir.y
			if d2 < 0.5:
				rec["rejected"] = "below_ground"
				break
			var fov2 := rad_to_deg(2.0 * atan(tan(deg_to_rad(fov) * 0.5) * dist / d2))
			fov2 = clampf(fov2, fov, max_fov)
			adjustments.append({"kind": "low_angle", "distance_from": snappedf(dist, 0.01), "distance_to": snappedf(d2, 0.01), "fov_from": snappedf(fov, 0.1), "fov_to": snappedf(fov2, 0.1)})
			pos = look + dir * d2
			fov = fov2
		else:
			adjustments.append({"kind": "raised", "by": snappedf(target_y - pos.y, 0.01)})
			pos.y = target_y
	if rec.has("rejected"):
		return _finish_measure(rec, pos, look, fov, adjustments)
	# 2. Near-lens safeguard: a small sphere at the lens must be clear of every
	# kind of geometry; if not, nudge forward along the view line a little.
	var lens_r := float(spec.get("near_lens_radius", 0.3))
	var fwd := (look - pos).normalized()
	if not _overlaps(pos, lens_r, all_mask).is_empty() or _enclosed(pos, fwd):
		var nudged := false
		var step := float(spec.get("nudge_step", 0.25))
		var max_nudge := minf(float(spec.get("max_nudge", 1.5)), pos.distance_to(look) * 0.25)
		var k := 1
		while step * k <= max_nudge + 0.0001:
			var p2 := pos + fwd * step * k
			if _overlaps(p2, lens_r, all_mask).is_empty() and not _enclosed(p2, fwd):
				adjustments.append({"kind": "near_lens_nudge", "by": snappedf(step * k, 0.01)})
				pos = p2
				nudged = true
				break
			k += 1
		if not nudged:
			var blockers := _overlaps(pos, lens_r, all_mask)
			if not blockers.is_empty():
				rec["near_lens_hit"] = String((_body_geom.get((blockers[0]["rid"] as RID).get_id(), {}) as Dictionary).get("path", ""))
			rec["rejected"] = "near_lens_blocked"
			return _finish_measure(rec, pos, look, fov, adjustments)
	# 3. Thick swept visibility to sample points on the subject: hard geometry
	# rejects, soft geometry (props, foliage, fences) only counts as framing.
	var sweep_r := float(spec.get("sweep_radius", 0.15))
	var vis := ""
	var blockers_hard: Array = []
	var blockers_soft: Array = []
	var sweep_hard_mask := LAYER_HARD
	var sweep_soft_mask := LAYER_SOFT
	if bool(spec.get("subject_occludes", false)):
		sweep_hard_mask = LAYER_HARD | LAYER_SUBJECT
	for raw in (cand.get("samples", []) as Array):
		var target := _vec(raw)
		var v := target - pos
		var length := v.length()
		if length < sweep_r * 2.0 + 0.05:
			vis += "V"
			continue
		var motion := v.normalized() * (length - sweep_r - 0.05)
		var h := _sweep(pos, motion, sweep_r, sweep_hard_mask)
		if float(h["free"]) < 1.0:
			vis += "H"
			if h["hit"] != "" and not blockers_hard.has(h["hit"]) and blockers_hard.size() < 4:
				blockers_hard.append(h["hit"])
			continue
		var s := _sweep(pos, motion, sweep_r, sweep_soft_mask)
		if float(s["free"]) < 1.0:
			vis += "F"
			if s["hit"] != "" and not blockers_soft.has(s["hit"]) and blockers_soft.size() < 4:
				blockers_soft.append(s["hit"])
			continue
		vis += "V"
	rec["vis"] = vis
	if not blockers_hard.is_empty():
		rec["blockers_hard"] = blockers_hard
	if not blockers_soft.is_empty():
		rec["blockers_soft"] = blockers_soft
	# 4. A ray grid through the frame: what each part of the image would show
	# (sky, subject, hard or soft geometry) and how far away it is.
	var cols := int(spec.get("grid_cols", 16))
	var rows := int(spec.get("grid_rows", 9))
	var max_dist := float(spec.get("max_ray", 600.0))
	var basis := _look_basis(pos, look)
	var tan_v := tan(deg_to_rad(fov) * 0.5)
	var tan_h := tan_v * aspect
	var codes := ""
	var dists: Array = []
	for j in rows:
		for i in cols:
			var x := ((i + 0.5) / cols * 2.0 - 1.0) * tan_h
			var y := (1.0 - (j + 0.5) / rows * 2.0) * tan_v
			var dir := (basis * Vector3(x, y, -1.0)).normalized()
			var hit := _ray(pos, pos + dir * max_dist, all_mask)
			if hit.is_empty():
				codes += "."
				dists.append(-1)
				continue
			var g: Dictionary = _body_geom.get((hit["rid"] as RID).get_id(), {})
			var cls := int(g.get("cls", CLASS_HARD))
			codes += ["H", "F", "S"][cls]
			dists.append(snappedf(pos.distance_to(hit["position"]), 0.1))
	rec["grid"] = codes
	rec["dist"] = dists
	return _finish_measure(rec, pos, look, fov, adjustments)


func _finish_measure(rec: Dictionary, pos: Vector3, look: Vector3, fov: float, adjustments: Array) -> Dictionary:
	rec["position"] = _arr(pos)
	rec["look_at"] = _arr(look)
	rec["fov"] = snappedf(fov, 0.01)
	if not adjustments.is_empty():
		rec["adjustments"] = adjustments
	return rec


# Boxed in: geometry within arm's reach on all four horizontal sides AND
# overhead. A camera there is inside a wall cavity, a prop or a solid block,
# never a place to shoot from. (Ray normals cannot tell inside from outside:
# the physics server reports normals facing the ray.)
func _enclosed(pos: Vector3, fwd: Vector3) -> bool:
	return _enclosure_sides(pos, fwd) >= 5


func _enclosure_sides(pos: Vector3, fwd: Vector3) -> int:
	var flat := Vector3(fwd.x, 0.0, fwd.z).normalized()
	if flat.length() < 0.5:
		flat = Vector3(0, 0, -1)
	var side := Vector3(flat.z, 0.0, -flat.x)
	var reach := float((_cfg.get("measure", {}) as Dictionary).get("enclosure_reach", 1.2))
	var sides := 0
	for d in [flat, -flat, side, -side]:
		if not _ray(pos, pos + (d as Vector3) * reach, LAYER_HARD | LAYER_SOFT | LAYER_SUBJECT).is_empty():
			sides += 1
	if not _ray(pos, pos + Vector3.UP * reach * 2.0, LAYER_HARD | LAYER_SOFT | LAYER_SUBJECT).is_empty():
		sides += 1
	return sides


# ---------------------------------------------------------------------------
# Render
# ---------------------------------------------------------------------------

func _setup_render() -> void:
	var vp := get_viewport()
	# The preview viewport's own camera would render the whole scene once more,
	# hidden behind the opaque grid. Turn its 3D pass off; the tiles below render
	# through their own SubViewports that SHARE this world.
	vp.disable_3d = true
	var world: World3D = vp.find_world_3d()
	var canvas_size := _vec2i(_cfg.get("canvas", [1024, 576]))
	var layer := CanvasLayer.new()
	add_child(layer)
	var bg := ColorRect.new()
	bg.color = Color(0.06, 0.065, 0.075)
	bg.position = Vector2.ZERO
	bg.size = Vector2(canvas_size)
	layer.add_child(bg)
	var tiles: Array = _cfg.get("tiles", [])
	var tile_vps: Array = []
	var infos: Array = []
	for i in tiles.size():
		var t: Dictionary = tiles[i]
		var kind := String(t.get("kind", "shot"))
		var info := {"i": i, "kind": kind}
		var sv: SubViewport = null
		if kind == "shot":
			sv = _make_shot_tile(t, world, layer, info)
		elif kind == "prev":
			_make_image_tile(t, layer, info)
		elif kind == "note":
			_make_note_tile(t, layer)
		tile_vps.append(sv)
		infos.append(info)
	for i in tiles.size():
		var t: Dictionary = tiles[i]
		if String(t.get("kind", "")) == "diff":
			var now_index := int(t.get("now_tile", -1))
			var now_vp: SubViewport = tile_vps[now_index] if now_index >= 0 and now_index < tile_vps.size() else null
			_make_diff_tile(t, layer, now_vp, infos[i])
	for i in tiles.size():
		_add_label(tiles[i], layer)
	_result["tiles"] = infos
	_result["ok"] = true
	_result["stage"] = "render_setup"
	_write_result()
	RenderingServer.frame_post_draw.connect(_on_post_draw)


static func _vec2i(value: Variant) -> Vector2i:
	if value is Array and (value as Array).size() >= 2:
		return Vector2i(int(value[0]), int(value[1]))
	return Vector2i(16, 16)


static func _rect(t: Dictionary) -> Rect2:
	var r: Array = t.get("rect", [0, 0, 16, 16])
	return Rect2(float(r[0]), float(r[1]), float(r[2]), float(r[3]))


func _apply_project_aa(sv: SubViewport) -> void:
	sv.msaa_3d = int(ProjectSettings.get_setting("rendering/anti_aliasing/quality/msaa_3d", 0))
	sv.screen_space_aa = int(ProjectSettings.get_setting("rendering/anti_aliasing/quality/screen_space_aa", 0))
	sv.use_taa = bool(ProjectSettings.get_setting("rendering/anti_aliasing/quality/use_taa", false))
	sv.use_debanding = bool(ProjectSettings.get_setting("rendering/anti_aliasing/quality/use_debanding", false))


func _make_shot_tile(t: Dictionary, world: World3D, layer: CanvasLayer, info: Dictionary) -> SubViewport:
	var rect := _rect(t)
	var render_size := _vec2i(t.get("render_size", [int(rect.size.x), int(rect.size.y)]))
	var view := String(t.get("view", "beauty"))
	var sv := SubViewport.new()
	sv.size = render_size
	sv.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	sv.transparent_bg = false
	_apply_project_aa(sv)
	var cam := Camera3D.new()
	var method := "beauty"
	match view:
		"lighting":
			sv.debug_draw = Viewport.DEBUG_DRAW_LIGHTING
			method = "debug_draw"
		"unshaded":
			sv.debug_draw = Viewport.DEBUG_DRAW_UNSHADED
			method = "debug_draw"
		"overdraw":
			sv.debug_draw = Viewport.DEBUG_DRAW_OVERDRAW
			method = "debug_draw"
		"wireframe":
			sv.debug_draw = Viewport.DEBUG_DRAW_WIREFRAME
			method = "debug_draw"
		"normals":
			method = "material_override"
	if view == "normals":
		sv.world_3d = _get_normals_world()
		var env := Environment.new()
		env.background_mode = Environment.BG_COLOR
		env.background_color = Color(0, 0, 0)
		cam.environment = env
	else:
		sv.world_3d = world
	info["view"] = view
	info["method"] = method
	sv.add_child(cam)
	add_child(sv)
	var pose: Dictionary = t.get("pose", {})
	var pos := _vec(pose.get("position"))
	var look := _vec(pose.get("look_at"), pos + Vector3(0, 0, -1))
	cam.global_transform = Transform3D(_look_basis(pos, look), pos)
	var near := float(pose.get("near", 0.05))
	var far := float(pose.get("far", 1000.0))
	var fov := float(pose.get("fov", 60.0))
	var crop: Array = pose.get("crop", [])
	if crop.size() == 4:
		# Exact sub-frustum of the reference frame: the crop renders at full
		# resolution (real texture detail), not an upscaled crop of pixels.
		var ref_aspect := float(pose.get("ref_aspect", 16.0 / 9.0))
		var h_near := 2.0 * near * tan(deg_to_rad(fov) * 0.5)
		var w_near := h_near * ref_aspect
		var u0 := float(crop[0])
		var v0 := float(crop[1])
		var u1 := float(crop[2])
		var v1 := float(crop[3])
		cam.projection = Camera3D.PROJECTION_FRUSTUM
		cam.size = h_near * (v1 - v0)
		cam.frustum_offset = Vector2(((u0 + u1) * 0.5 - 0.5) * w_near, (0.5 - (v0 + v1) * 0.5) * h_near)
		cam.near = near
		cam.far = far
		info["crop"] = crop
	else:
		cam.fov = fov
		cam.near = near
		cam.far = far
	cam.current = true
	var tr := TextureRect.new()
	tr.texture = sv.get_texture()
	tr.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	tr.stretch_mode = TextureRect.STRETCH_SCALE
	tr.position = rect.position
	tr.size = rect.size
	layer.add_child(tr)
	var capture := String(t.get("capture_path", ""))
	if capture != "" and (not capture.begins_with(_out_dir + "/") or capture.contains("..")):
		_warn("capture path outside the run directory was ignored")
		capture = ""
	if capture != "":
		_captures.append({"vp": sv, "path": capture, "max_edge": int(t.get("capture_max_edge", 1024)), "i": int(info["i"])})
	return sv


func _make_image_tile(t: Dictionary, layer: CanvasLayer, info: Dictionary) -> void:
	var rect := _rect(t)
	var path := String(t.get("image_path", ""))
	var img := Image.load_from_file(path) if path != "" else null
	if img == null or img.is_empty():
		info["error"] = "could not load " + path
		_make_note_tile({"rect": t.get("rect"), "text": "previous image unreadable"}, layer)
		return
	info["image_size"] = [img.get_width(), img.get_height()]
	var tr := TextureRect.new()
	tr.texture = ImageTexture.create_from_image(img)
	tr.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	tr.stretch_mode = TextureRect.STRETCH_SCALE
	tr.position = rect.position
	tr.size = rect.size
	layer.add_child(tr)


const DIFF_SHADER := """
shader_type canvas_item;
uniform sampler2D prev_tex : filter_linear;
uniform sampler2D now_tex : filter_linear;
uniform float gain = 4.0;
void fragment() {
	vec3 a = texture(prev_tex, UV).rgb;
	vec3 b = texture(now_tex, UV).rgb;
	float d = clamp(length(a - b) * gain, 0.0, 1.0);
	vec3 base = vec3(dot(b, vec3(0.299, 0.587, 0.114))) * 0.3;
	vec3 heat = mix(vec3(0.95, 0.12, 0.05), vec3(1.0, 0.95, 0.25), clamp(d * 2.0 - 1.0, 0.0, 1.0));
	COLOR = vec4(mix(base, heat, smoothstep(0.06, 0.3, d)), 1.0);
}
"""


func _make_diff_tile(t: Dictionary, layer: CanvasLayer, now_vp: SubViewport, info: Dictionary) -> void:
	var rect := _rect(t)
	var path := String(t.get("image_path", ""))
	var img := Image.load_from_file(path) if path != "" else null
	if img == null or img.is_empty() or now_vp == null:
		info["error"] = "diff needs a previous image and a current shot"
		_make_note_tile({"rect": t.get("rect"), "text": "no difference map"}, layer)
		return
	var shader := Shader.new()
	shader.code = DIFF_SHADER
	var mat := ShaderMaterial.new()
	mat.shader = shader
	mat.set_shader_parameter("prev_tex", ImageTexture.create_from_image(img))
	mat.set_shader_parameter("now_tex", now_vp.get_texture())
	var tr := TextureRect.new()
	tr.texture = now_vp.get_texture()
	tr.material = mat
	tr.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	tr.stretch_mode = TextureRect.STRETCH_SCALE
	tr.position = rect.position
	tr.size = rect.size
	layer.add_child(tr)
	_diffs.append({"i": int(info["i"]), "vp": now_vp, "prev": img})


func _make_note_tile(t: Dictionary, layer: CanvasLayer) -> void:
	var rect := _rect(t)
	var bg := ColorRect.new()
	bg.color = Color(0.12, 0.12, 0.14)
	bg.position = rect.position
	bg.size = rect.size
	layer.add_child(bg)
	var label := Label.new()
	label.text = String(t.get("text", ""))
	label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	label.position = rect.position
	label.size = rect.size
	var settings := LabelSettings.new()
	settings.font_size = int(clampf(rect.size.y / 14.0, 12.0, 28.0))
	settings.font_color = Color(0.85, 0.85, 0.88)
	label.label_settings = settings
	layer.add_child(label)


func _add_label(t: Dictionary, layer: CanvasLayer) -> void:
	var text := String(t.get("label", ""))
	if text == "":
		return
	var rect := _rect(t)
	var label := Label.new()
	label.text = text
	var settings := LabelSettings.new()
	settings.font_size = int(clampf(rect.size.y / 16.0, 12.0, 30.0))
	settings.font_color = Color(1, 1, 1)
	settings.outline_size = 4
	settings.outline_color = Color(0, 0, 0, 0.9)
	label.label_settings = settings
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0, 0, 0, 0.55)
	sb.content_margin_left = 6
	sb.content_margin_right = 6
	sb.content_margin_top = 2
	sb.content_margin_bottom = 2
	label.add_theme_stylebox_override("normal", sb)
	label.position = rect.position + Vector2(4, 4)
	layer.add_child(label)


func _get_normals_world() -> World3D:
	if _normals_world != null:
		return _normals_world
	_normals_world = World3D.new()
	var holder := SubViewport.new()
	holder.size = Vector2i(2, 2)
	holder.render_target_update_mode = SubViewport.UPDATE_DISABLED
	holder.world_3d = _normals_world
	add_child(holder)
	var packed: PackedScene = load(String(_cfg.get("scene_path", ""))) as PackedScene
	if packed == null:
		_warn("normals view: the scene could not be loaded a second time")
		return _normals_world
	var copy := packed.instantiate(PackedScene.GEN_EDIT_STATE_DISABLED)
	var shader := Shader.new()
	shader.code = """
shader_type spatial;
render_mode unshaded, cull_disabled;
void fragment() {
	vec3 n = normalize((INV_VIEW_MATRIX * vec4(NORMAL, 0.0)).xyz);
	ALBEDO = n * 0.5 + 0.5;
}
"""
	var mat := ShaderMaterial.new()
	mat.shader = shader
	for g in copy.find_children("*", "GeometryInstance3D", true, false):
		(g as GeometryInstance3D).material_override = mat
	if copy is GeometryInstance3D:
		(copy as GeometryInstance3D).material_override = mat
	holder.add_child(copy)
	return _normals_world


func _on_post_draw() -> void:
	_draws += 1
	_result["draws"] = _draws
	var captured: Array = []
	for c in _captures:
		var img: Image = (c["vp"] as SubViewport).get_texture().get_image()
		if img == null or img.is_empty():
			continue
		var max_edge := int(c["max_edge"])
		var longest := maxi(img.get_width(), img.get_height())
		if longest > max_edge:
			var scale := float(max_edge) / float(longest)
			img.resize(maxi(1, int(round(img.get_width() * scale))), maxi(1, int(round(img.get_height() * scale))), Image.INTERPOLATE_LANCZOS)
		if img.save_jpg(String(c["path"]), 0.85) == OK:
			captured.append({"i": c["i"], "path": c["path"], "size": [img.get_width(), img.get_height()]})
	if not _captures.is_empty():
		_result["captures"] = captured
	var diffs: Array = []
	for d in _diffs:
		var now_img: Image = (d["vp"] as SubViewport).get_texture().get_image()
		if now_img == null or now_img.is_empty():
			continue
		diffs.append(_diff_stats(int(d["i"]), d["prev"], now_img))
	if not _diffs.is_empty():
		_result["diffs"] = diffs
	_write_result()


# Downsampled per-pixel comparison: mean absolute difference, the fraction of
# pixels that changed visibly, and the normalized box around the changes.
func _diff_stats(index: int, prev: Image, now: Image) -> Dictionary:
	var w := 160
	var h := maxi(1, int(round(160.0 * now.get_height() / maxf(1.0, now.get_width()))))
	var a := prev.duplicate() as Image
	var b := now.duplicate() as Image
	a.convert(Image.FORMAT_RGB8)
	b.convert(Image.FORMAT_RGB8)
	a.resize(w, h, Image.INTERPOLATE_BILINEAR)
	b.resize(w, h, Image.INTERPOLATE_BILINEAR)
	var total := 0.0
	var changed := 0
	var min_x := w
	var min_y := h
	var max_x := -1
	var max_y := -1
	for y in h:
		for x in w:
			var ca := a.get_pixel(x, y)
			var cb := b.get_pixel(x, y)
			var d := (absf(ca.r - cb.r) + absf(ca.g - cb.g) + absf(ca.b - cb.b)) / 3.0
			total += d
			if d > 0.08:
				changed += 1
				min_x = mini(min_x, x)
				min_y = mini(min_y, y)
				max_x = maxi(max_x, x)
				max_y = maxi(max_y, y)
	var stats := {
		"i": index,
		"mean_abs": snappedf(total / float(w * h), 0.0001),
		"changed_fraction": snappedf(float(changed) / float(w * h), 0.0001),
		"prev_size": [prev.get_width(), prev.get_height()],
		"now_size": [now.get_width(), now.get_height()],
	}
	if changed > 0:
		stats["changed_box"] = [snappedf(float(min_x) / w, 0.001), snappedf(float(min_y) / h, 0.001), snappedf(float(max_x + 1) / w, 0.001), snappedf(float(max_y + 1) / h, 0.001)]
	return stats
