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
##   "analyze": world bounds of subject nodes, spawn poses, the key light, and
##     (when asked) a physics pass built from the VISIBLE geometry: corridor
##     scans, per-candidate measurements (thick sweep visibility, back-face and
##     closed-shell lens checks, low-angle correction, a ray grid through the
##     frame) and a mark occlusion test. The preview's own 3D render is
##     disabled; only result.json matters.
##   Back faces: every physics face collides on both sides, and a short
##     front-faces-only ray at each hit tells which side the ray met. A back
##     face of a surface without cull_disabled is NOT drawn, so it never hides
##     anything in the image, but a camera on that side is behind or inside the
##     surface and would look through it.
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
# Transparent surfaces (alpha blend, alpha scissor, alpha hash, depth
# pre-pass, or a GeometryInstance3D fade): their own layer, whatever their
# class, so the solid sweeps never treat a foliage card or a glass pane as a
# wall. They count as see-through cover at partial weight.
const LAYER_SEE := 8
const CLASS_NAMES := ["hard", "soft", "subject"]
# Per-surface material flags. A surface without FLAG_DOUBLE is drawn from its
# front side only: seen from behind, the renderer culls it and the image shows
# whatever lies beyond, so a camera behind a one-sided wall looks THROUGH it.
const FLAG_DOUBLE := 1
const FLAG_SEE := 2
# A pose whose lens sits inside a closed shell: at least this many of the six
# axis rays meet a back face first.
const INSIDE_BACK_RAYS := 4

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

# Image check (analyze "measure" with config image_check): one small beauty
# render per candidate, read back after the draw, reduced to a per-cell
# luminance and texture code aligned with the ray grid.
var _checks: Array = []
var _measurements: Array = []

var _soft_re: RegEx = null
var _hard_re: RegEx = null
var _alpha_re: RegEx = null
var _render_mode_re: RegEx = null
var _material_flag_cache: Dictionary = {}

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
		if _cfg.has("occlusion"):
			# Deferred like the analyze pass; ScenePreview flushes it before the
			# first draw, so result.json carries it when the image is read.
			call_deferred("_render_occlusion")
	elif mode == "analyze":
		get_viewport().disable_3d = true
		_setup_image_checks()
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
	var key := _key_light()
	if not key.is_empty():
		_result["key_light"] = key
	var tasks: Array = _cfg.get("tasks", [])
	if tasks.has("corridor_scan") or tasks.has("measure") or tasks.has("occlusion"):
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
		if tasks.has("occlusion"):
			_result["occlusion"] = _occlusion(_cfg.get("occlusion", {}))
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
	# Deepest named segment wins: ".../House1/Front/lantern/Model/street_lamp"
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
	_alpha_re = RegEx.create_from_string("\\bALPHA(_SCISSOR_THRESHOLD|_HASH_SCALE)?\\s*=[^=]")
	_render_mode_re = RegEx.create_from_string("render_mode[^;]*;")
	var shape_cache: Dictionary = {}
	var counts := {"hard": 0, "soft": 0, "subject": 0, "ignored": 0, "translucent": 0, "double_sided": 0}
	var why_counts := {}
	var examples := {"hard": [], "soft": [], "subject": [], "translucent": []}
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
		var path := _rel(node)
		# One body per material behaviour: a mesh whose surfaces mix opaque,
		# double-sided and transparent materials (bark + leaf cards) is split,
		# so the leaves are see-through cover and the trunk stays solid.
		for part in _mesh_parts(node, mesh):
			var flags := int(part["flags"])
			# Physics bodies do not take scale reliably: a scaled (or sheared)
			# instance gets its own shape with the transform baked into the
			# faces; unscaled instances share one shape per mesh part.
			var body_xform := xform
			var scaled := not _is_rigid(xform.basis)
			var key := "%d:%s" % [mesh.get_instance_id(), String(part["key"])]
			var shape := RID()
			if not scaled and shape_cache.has(key):
				shape = shape_cache[key]
			else:
				var faces := _part_faces(mesh, part)
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
			var layer: int = [LAYER_HARD, LAYER_SOFT, LAYER_SUBJECT][cls]
			if flags & FLAG_SEE:
				layer = LAYER_SEE
			PhysicsServer3D.body_set_collision_layer(body, layer)
			PhysicsServer3D.body_set_collision_mask(body, 0)
			PhysicsServer3D.body_set_space(body, _space)
			PhysicsServer3D.body_set_state(body, PhysicsServer3D.BODY_STATE_TRANSFORM, body_xform)
			_bodies.append(body)
			var cls_name: String = CLASS_NAMES[cls]
			counts[cls_name] += 1
			if flags & FLAG_SEE:
				counts["translucent"] += 1
				var tex: Array = examples["translucent"]
				if tex.size() < 6 and not tex.has(path):
					tex.append(path)
			if flags & FLAG_DOUBLE:
				counts["double_sided"] += 1
			var why_key := cls_name + ":" + String(c["why"])
			why_counts[why_key] = int(why_counts.get(why_key, 0)) + 1
			_body_geom[body.get_id()] = {"path": path, "cls": cls, "flags": flags}
			var ex: Array = examples[cls_name]
			if ex.size() < 6 and not ex.has(path):
				ex.append(path)
	if capped:
		_warn("The visibility pass hit its face budget; some large meshes were skipped.")
	_state = PhysicsServer3D.space_get_direct_state(_space)
	_result["occluders"] = {"counts": counts, "by_rule": why_counts, "examples": examples, "faces": faces_total, "build_ms": Time.get_ticks_msec() - t0}


# The mesh as one or more {flags, key, surfaces} parts, one per distinct
# material behaviour (FLAG_DOUBLE / FLAG_SEE). Only flags are read here (cheap,
# per instance); faces are built in _part_faces on a shape-cache miss. The
# common single-behaviour mesh is one part covering every surface.
func _mesh_parts(node: Node, mesh: Mesh) -> Array:
	var count := mesh.get_surface_count()
	var per_surface: Array = []
	var distinct := {}
	for s in count:
		var f := _surface_flags(node, mesh, s)
		per_surface.append(f)
		distinct[f] = true
	if distinct.size() <= 1:
		var only := 0 if per_surface.is_empty() else int(per_surface[0])
		return [{"flags": only, "key": "all", "surfaces": []}]
	var parts: Array = []
	for f in distinct.keys():
		var used: Array = []
		for s in count:
			if int(per_surface[s]) == int(f):
				used.append(s)
		parts.append({"flags": int(f), "key": "s" + "_".join(PackedStringArray(used.map(func(v): return str(v)))), "surfaces": used})
	return parts


func _part_faces(mesh: Mesh, part: Dictionary) -> PackedVector3Array:
	var surfaces: Array = part.get("surfaces", [])
	if surfaces.is_empty():
		return mesh.get_faces()
	var tmp := ArrayMesh.new()
	for raw in surfaces:
		var s := int(raw)
		var prim := Mesh.PRIMITIVE_TRIANGLES
		if mesh is ArrayMesh:
			prim = (mesh as ArrayMesh).surface_get_primitive_type(s)
		if prim != Mesh.PRIMITIVE_TRIANGLES and prim != Mesh.PRIMITIVE_TRIANGLE_STRIP:
			continue
		tmp.add_surface_from_arrays(prim, mesh.surface_get_arrays(s))
	if tmp.get_surface_count() == 0:
		return PackedVector3Array()
	return tmp.get_faces()


# FLAG_DOUBLE when the surface is drawn from both sides (cull_disabled),
# FLAG_SEE when it is transparent in any way (alpha blend, scissor, hash,
# depth pre-pass, a shader that writes ALPHA, or the instance's fade).
func _surface_flags(node: Node, mesh: Mesh, surface: int) -> int:
	var mat: Material = null
	var geo := node as GeometryInstance3D
	if geo != null and geo.material_override != null:
		mat = geo.material_override
	elif node is MeshInstance3D:
		mat = (node as MeshInstance3D).get_active_material(surface)
	else:
		mat = mesh.surface_get_material(surface)
	var flags := _material_flags(mat)
	if geo != null and geo.transparency > 0.001:
		flags |= FLAG_SEE
	return flags


func _material_flags(mat: Material) -> int:
	if mat == null:
		return 0
	var id := mat.get_instance_id()
	if _material_flag_cache.has(id):
		return int(_material_flag_cache[id])
	var flags := 0
	if mat is BaseMaterial3D:
		var b := mat as BaseMaterial3D
		if b.cull_mode == BaseMaterial3D.CULL_DISABLED:
			flags |= FLAG_DOUBLE
		if b.transparency != BaseMaterial3D.TRANSPARENCY_DISABLED:
			flags |= FLAG_SEE
	elif mat is ShaderMaterial:
		var shader: Shader = (mat as ShaderMaterial).shader
		if shader != null:
			var code := shader.code
			var rm: RegExMatch = _render_mode_re.search(code)
			if rm != null:
				var modes := rm.get_string()
				if modes.contains("cull_disabled"):
					flags |= FLAG_DOUBLE
				for m in ["blend_add", "blend_sub", "blend_mul", "depth_prepass_alpha"]:
					if modes.contains(String(m)):
						flags |= FLAG_SEE
			if _alpha_re.search(code) != null:
				flags |= FLAG_SEE
	_material_flag_cache[id] = flags
	return flags


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


func _geom(hit: Dictionary) -> Dictionary:
	return _body_geom.get((hit["rid"] as RID).get_id(), {})


# Did a ray travelling along `dir` meet the surface at `point` from BEHIND?
# Both physics servers report hit normals turned toward the ray, so the side
# is read with a short FRONT-faces-only ray across the hit point instead: a
# front face there means the side facing the camera is drawn. A double-sided
# material is drawn from both sides and never counts as a back face.
func _is_back(point: Vector3, dir: Vector3, flags: int) -> bool:
	if flags & FLAG_DOUBLE:
		return false
	# Only the hit's own kind of surface: a glass pane 1 cm in front of a
	# wall's back must not count as that wall's front.
	var mask: int = LAYER_HARD | LAYER_SOFT | LAYER_SUBJECT
	if (flags & FLAG_SEE) != 0:
		mask = LAYER_SEE
	var q := PhysicsRayQueryParameters3D.create(point - dir * 0.02, point + dir * 0.02, mask)
	q.hit_back_faces = false
	return _state.intersect_ray(q).is_empty()


# What a line from `from` to `to` really crosses, in order, up to the first
# opaque surface met on its drawn (front or double-sided) side:
#   "back": path of a hard or subject surface crossed from BEHIND first (its
#     back face is culled, so the image looks through it): the camera is
#     behind or inside that surface;
#   "see": path of a transparent surface crossed (seen through, partial cover);
#   "stop": class of the first opaque drawn surface (-1 = none), its path and
#     distance.
# Soft surfaces crossed from behind are skipped here; the soft sweep, which
# collides on both sides, still counts them as framing.
func _walk(from: Vector3, to: Vector3, mask: int) -> Dictionary:
	var out := {"back": "", "back_dist": -1.0, "see": "", "stop": -1, "stop_path": "", "stop_dist": -1.0}
	var total := from.distance_to(to)
	if total < 0.001:
		return out
	var dir := (to - from) / total
	var start := from
	for _step in 8:
		var hit := _ray(start, to, mask | LAYER_SEE)
		if hit.is_empty():
			break
		var point: Vector3 = hit["position"]
		var g := _geom(hit)
		var flags := int(g.get("flags", 0))
		var cls := int(g.get("cls", CLASS_HARD))
		var back := _is_back(point, dir, flags)
		if flags & FLAG_SEE:
			if not back and String(out["see"]) == "":
				out["see"] = String(g.get("path", ""))
		elif back:
			if cls != CLASS_SOFT and String(out["back"]) == "":
				out["back"] = String(g.get("path", ""))
				out["back_dist"] = snappedf(from.distance_to(point), 0.01)
		else:
			out["stop"] = cls
			out["stop_path"] = String(g.get("path", ""))
			out["stop_dist"] = snappedf(from.distance_to(point), 0.01)
			return out
		start = point + dir * 0.01
		if from.distance_to(start) >= total:
			break
	return out


# Six axis rays from the lens: how many meet a hard or subject surface from
# behind first. A lens inside a closed shell of one-sided walls (a hollow
# building, a prop's interior) sees back faces in (nearly) every direction.
func _inside_back_rays(pos: Vector3) -> int:
	var count := 0
	for d in [Vector3.RIGHT, Vector3.LEFT, Vector3.UP, Vector3.DOWN, Vector3.FORWARD, Vector3.BACK]:
		var w := _walk(pos, pos + (d as Vector3) * 200.0, LAYER_HARD | LAYER_SOFT | LAYER_SUBJECT)
		if String(w["back"]) != "":
			count += 1
	return count


# A hard or subject back face within `reach` of the lens (axis rays plus the
# view direction): the lens sits just behind a one-sided surface.
func _near_back_face(pos: Vector3, fwd: Vector3, reach: float) -> String:
	for d in [fwd, -fwd, Vector3.RIGHT, Vector3.LEFT, Vector3.UP, Vector3.DOWN, Vector3.FORWARD, Vector3.BACK]:
		var w := _walk(pos, pos + (d as Vector3) * reach, LAYER_HARD | LAYER_SOFT | LAYER_SUBJECT)
		if String(w["back"]) != "":
			return String(w["back"])
	return ""


func _overlaps(pos: Vector3, radius: float, mask: int) -> Array:
	var q := PhysicsShapeQueryParameters3D.new()
	q.shape_rid = _sphere(radius)
	q.transform = Transform3D(Basis(), pos)
	q.collision_mask = mask
	return _state.intersect_shape(q, 4)


const SWEEP_SEGMENT := 4.0


# Fraction [0..1] of the motion a sphere can travel before touching `mask`
# geometry, plus the path of what it touched. The motion is swept in short
# segments: a cast's cost grows with every body inside its swept bounds, and
# one 40 m diagonal sweep through a city block touches most of the scene.
func _sweep(from: Vector3, motion: Vector3, radius: float, mask: int) -> Dictionary:
	var total := motion.length()
	if total < 0.001:
		return {"free": 1.0, "hit": ""}
	var dir := motion / total
	var steps := maxi(1, int(ceil(total / SWEEP_SEGMENT)))
	var seg := total / steps
	var q := PhysicsShapeQueryParameters3D.new()
	q.shape_rid = _sphere(radius)
	q.collision_mask = mask
	for k in steps:
		var start := from + dir * (seg * k)
		q.transform = Transform3D(Basis(), start)
		q.motion = dir * seg
		var res: PackedFloat32Array = _state.cast_motion(q)
		if res.size() < 2 or res[1] >= 1.0:
			continue
		var hit_path := ""
		var q2 := PhysicsShapeQueryParameters3D.new()
		q2.shape_rid = _sphere(radius * 1.05)
		q2.transform = Transform3D(Basis(), start + dir * seg * res[1])
		q2.collision_mask = mask
		var info := _state.get_rest_info(q2)
		if info.has("rid"):
			hit_path = String((_body_geom.get((info["rid"] as RID).get_id(), {}) as Dictionary).get("path", ""))
		return {"free": (seg * k + seg * float(res[0])) / total, "hit": hit_path}
	return {"free": 1.0, "hit": ""}


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
	# Free space is physical: glass and leaf cards (LAYER_SEE) still end a run.
	var mask := LAYER_HARD | LAYER_SOFT | LAYER_SUBJECT | LAYER_SEE
	var radius := float(spec.get("radius", 0.25))
	# Runs only matter inside the subject (+ a margin): the caller clips them
	# to its bounds + 2 m, so sweeping further is wasted engine time.
	var max_len := float(spec.get("max_len", clampf(maxf(box.size.x, box.size.z) + 4.0, 8.0, 120.0)))
	var side_len := minf(20.0, max_len)
	var grid := int(spec.get("grid", 3))
	var dirs := int(spec.get("directions", 8))
	var runs: Array = []
	var blocked := 0
	for gx in grid:
		for gz in grid:
			var fx := (gx + 0.5) / grid
			var fz := (gz + 0.5) / grid
			var seed := Vector3(box.position.x + box.size.x * fx, floor_y + height, box.position.z + box.size.z * fz)
			var g: Variant = _ground_below(seed, LAYER_HARD | LAYER_SUBJECT | LAYER_SEE)
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
					"left": snappedf(_free_run(seed, perp, side_len, radius, mask), 0.01),
					"right": snappedf(_free_run(seed, -perp, side_len, radius, mask), 0.01),
				})
	return {"runs": runs, "blocked_seeds": blocked}


func _look_basis(pos: Vector3, look: Vector3) -> Basis:
	var fwd := (look - pos).normalized()
	var up := Vector3.UP
	if absf(fwd.dot(up)) > 0.999:
		up = Vector3(0, 0, -1)
	return Basis.looking_at(fwd, up)


var _t_lens := 0
var _t_sweep := 0
var _t_grid := 0


func _measure_all(candidates: Array) -> Array:
	var spec: Dictionary = _cfg.get("measure", {})
	var out: Array = []
	for i in candidates.size():
		var rec := _measure_one(i, candidates[i], spec)
		out.append(rec)
		# The image check renders from the FINAL pose (after the low-angle rule
		# and the near-lens nudge); the draw comes after this deferred pass.
		if i < _checks.size() and not rec.has("rejected"):
			var cam: Camera3D = _checks[i]["cam"]
			var p := _vec(rec["position"])
			var l := _vec(rec["look_at"])
			cam.global_transform = Transform3D(_look_basis(p, l), p)
			cam.fov = float(rec["fov"])
	_result["measure_ms"] = {"lens": _t_lens / 1000, "sweeps": _t_sweep / 1000, "grid": _t_grid / 1000}
	_measurements = out
	return out


func _setup_image_checks() -> void:
	var check: Dictionary = _cfg.get("image_check", {})
	if check.is_empty() or not (_cfg.get("tasks", []) as Array).has("measure"):
		return
	var size := _vec2i(check.get("size", [96, 56]))
	var world: World3D = get_viewport().find_world_3d()
	var i := 0
	for cand in (_cfg.get("candidates", []) as Array):
		var sv := SubViewport.new()
		sv.size = size
		# One render is enough: the deferred measure pass places the camera at
		# the final pose before the first draw (ScenePreview iterates the main
		# loop, which flushes deferred calls before it draws).
		sv.render_target_update_mode = SubViewport.UPDATE_ONCE
		sv.world_3d = world
		var cam := Camera3D.new()
		sv.add_child(cam)
		add_child(sv)
		var p := _vec((cand as Dictionary).get("position"))
		var l := _vec((cand as Dictionary).get("look_at"), p + Vector3(0, 0, -1))
		cam.global_transform = Transform3D(_look_basis(p, l), p)
		cam.fov = float((cand as Dictionary).get("fov", 60.0))
		cam.near = 0.05
		cam.far = 1000.0
		cam.current = true
		_checks.append({"vp": sv, "cam": cam, "i": i, "done": false})
		i += 1
	RenderingServer.frame_post_draw.connect(_on_post_draw)


static func _image_blank(img: Image) -> bool:
	var probe := img.duplicate() as Image
	probe.resize(4, 4, Image.INTERPOLATE_BILINEAR)
	for y in 4:
		for x in 4:
			var c := probe.get_pixel(x, y)
			if c.r + c.g + c.b > 0.01:
				return false
	return true


# Per cell of the cols x rows grid: luminance decile ("0".."9") and texture
# (luminance spread inside the cell, "0" = featureless).
func _image_codes(img: Image, cols: int, rows: int) -> Dictionary:
	var sub := 3
	var work := img.duplicate() as Image
	work.convert(Image.FORMAT_RGB8)
	work.resize(cols * sub, rows * sub, Image.INTERPOLATE_BILINEAR)
	var lum := ""
	var tex := ""
	for r in rows:
		for c in cols:
			var lo := 1.0
			var hi := 0.0
			var sum := 0.0
			for y in sub:
				for x in sub:
					var px := work.get_pixel(c * sub + x, r * sub + y)
					var v := px.r * 0.299 + px.g * 0.587 + px.b * 0.114
					sum += v
					lo = minf(lo, v)
					hi = maxf(hi, v)
			lum += str(clampi(int(sum / float(sub * sub) * 10.0), 0, 9))
			tex += str(clampi(int((hi - lo) * 40.0), 0, 9))
	return {"lum": lum, "tex": tex}


func _measure_one(index: int, cand: Dictionary, spec: Dictionary) -> Dictionary:
	var pos := _vec(cand.get("position"))
	var look := _vec(cand.get("look_at"))
	var fov := float(cand.get("fov", 60.0))
	var aspect := float(spec.get("aspect", 16.0 / 9.0))
	var all_mask := LAYER_HARD | LAYER_SOFT | LAYER_SUBJECT
	# Ground under the camera: water and glass floors count (LAYER_SEE).
	var solid_mask := LAYER_HARD | LAYER_SUBJECT | LAYER_SEE
	# adjust:false (an explicit pose the caller asked for, e.g. frame_nodes
	# with from): measure it exactly as given and report what is wrong instead
	# of raising or nudging it.
	var adjust := bool(cand.get("adjust", true))
	var adjustments: Array = []
	var rec := {"i": index}
	# 1. Ground clearance and the low-angle rule: a camera that would end up in
	# the ground moves CLOSER along its line of sight and widens its FOV to keep
	# the framing, instead of being pushed up or buried.
	var clearance := float(cand.get("min_clearance", spec.get("min_clearance", 0.3)))
	var max_fov := float(spec.get("max_fov", 100.0))
	for _attempt in (2 if adjust else 0):
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
	# 2. Lens safeguards: a small sphere at the lens must be clear of every
	# kind of geometry, and the lens must not sit inside a closed shell or just
	# behind a one-sided surface (back faces are culled: the image would look
	# through the wall it stands behind). If not, nudge forward along the view
	# line a little (never for adjust:false).
	var t_lens := Time.get_ticks_usec()
	var lens_r := float(spec.get("near_lens_radius", 0.3))
	var fwd := (look - pos).normalized()
	if _lens_problem(pos, fwd, lens_r) != "":
		var nudged := false
		var step := float(spec.get("nudge_step", 0.25))
		var max_nudge := minf(float(spec.get("max_nudge", 1.5)), pos.distance_to(look) * 0.25)
		var k := 1
		while adjust and step * k <= max_nudge + 0.0001:
			var p2 := pos + fwd * step * k
			if _lens_problem(p2, fwd, lens_r) == "":
				adjustments.append({"kind": "near_lens_nudge", "by": snappedf(step * k, 0.01)})
				pos = p2
				nudged = true
				break
			k += 1
		if not nudged:
			var problem := _lens_problem(pos, fwd, lens_r)
			rec["rejected"] = problem
			var hit_path := ""
			if problem == "behind_surface":
				hit_path = _near_back_face(pos, fwd, lens_r + 0.05)
			else:
				var blockers := _overlaps(pos, lens_r, all_mask | LAYER_SEE)
				if not blockers.is_empty():
					hit_path = String((_body_geom.get((blockers[0]["rid"] as RID).get_id(), {}) as Dictionary).get("path", ""))
			if hit_path != "":
				rec["near_lens_hit"] = hit_path
			_t_lens += Time.get_ticks_usec() - t_lens
			return _finish_measure(rec, pos, look, fov, adjustments)
	_t_lens += Time.get_ticks_usec() - t_lens
	# 3. Visibility to sample points on the subject. Per line: a hard or
	# subject surface crossed from BEHIND first is "B" (the camera is behind a
	# wall it would look through); then the thick sweep: hard geometry blocks
	# ("H"), soft geometry (props, foliage, fences) only counts as framing
	# ("F"); a clear line through transparent surfaces is "T" (see-through
	# cover, partial weight); else "V". Transparent bodies sit on LAYER_SEE,
	# outside every sweep mask, so a foliage card never blocks like a wall.
	var t_sweep := Time.get_ticks_usec()
	var sweep_r := float(spec.get("sweep_radius", 0.15))
	var vis := ""
	var blockers_hard: Array = []
	var blockers_soft: Array = []
	var blockers_back: Array = []
	var seen_through: Array = []
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
		var line := _walk(pos, pos + motion, all_mask)
		var back_path := String(line["back"])
		if back_path != "":
			vis += "B"
			if not blockers_back.has(back_path) and blockers_back.size() < 4:
				blockers_back.append(back_path)
			continue
		# A thin ray that is already blocked settles it (the thick sweep would
		# be blocked too); only clear lines pay for the thick sweep, which is
		# what catches the corners a thin ray slips past.
		var thin := _ray(pos, pos + motion, sweep_hard_mask)
		if not thin.is_empty():
			vis += "H"
			var thin_path := String(_geom(thin).get("path", ""))
			if thin_path != "" and not blockers_hard.has(thin_path) and blockers_hard.size() < 4:
				blockers_hard.append(thin_path)
			continue
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
		var see_path := String(line["see"])
		if see_path != "":
			vis += "T"
			if not seen_through.has(see_path) and seen_through.size() < 4:
				seen_through.append(see_path)
			continue
		vis += "V"
	rec["vis"] = vis
	if not blockers_hard.is_empty():
		rec["blockers_hard"] = blockers_hard
	if not blockers_soft.is_empty():
		rec["blockers_soft"] = blockers_soft
	if not blockers_back.is_empty():
		rec["blockers_back"] = blockers_back
	if not seen_through.is_empty():
		rec["seen_through"] = seen_through
	_t_sweep += Time.get_ticks_usec() - t_sweep
	# 4. A ray grid through the frame: what each part of the image would show
	# and how far away it is. "." nothing (sky/void), "S" subject, "H" hard,
	# "F" soft, "T" a transparent surface (seen through), "B" a hard or subject
	# surface met from BEHIND (culled: the image looks through it). Back faces
	# of soft surfaces and transparent back faces are not drawn: the ray goes on.
	var t_grid := Time.get_ticks_usec()
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
			var cell := _grid_cell(pos, dir, max_dist, all_mask)
			codes += String(cell[0])
			dists.append(cell[1])
	rec["grid"] = codes
	rec["dist"] = dists
	_t_grid += Time.get_ticks_usec() - t_grid
	return _finish_measure(rec, pos, look, fov, adjustments)


# "" when the lens is fine, else why not: "near_lens_blocked" (geometry
# inside the lens sphere, or boxed in at arm's reach), "inside_volume" (inside
# a closed shell of one-sided surfaces) or "behind_surface" (a hard or subject
# back face within the lens radius).
func _lens_problem(pos: Vector3, fwd: Vector3, lens_r: float) -> String:
	if _inside_back_rays(pos) >= INSIDE_BACK_RAYS:
		return "inside_volume"
	if _near_back_face(pos, fwd, lens_r + 0.05) != "":
		return "behind_surface"
	if not _overlaps(pos, lens_r, LAYER_HARD | LAYER_SOFT | LAYER_SUBJECT | LAYER_SEE).is_empty() or _enclosed(pos, fwd):
		return "near_lens_blocked"
	return ""


func _grid_cell(pos: Vector3, dir: Vector3, max_dist: float, mask: int) -> Array:
	var start := pos
	var end := pos + dir * max_dist
	for _step in 6:
		var hit := _ray(start, end, mask | LAYER_SEE)
		if hit.is_empty():
			return [".", -1]
		var point: Vector3 = hit["position"]
		var g := _geom(hit)
		var flags := int(g.get("flags", 0))
		var cls := int(g.get("cls", CLASS_HARD))
		var back := _is_back(point, dir, flags)
		var d := snappedf(pos.distance_to(point), 0.1)
		if flags & FLAG_SEE:
			if not back:
				return ["S" if cls == CLASS_SUBJECT else "T", d]
		elif back:
			if cls != CLASS_SOFT:
				return ["B", d]
		else:
			return [["H", "F", "S"][cls], d]
		start = point + dir * 0.01
	return [".", -1]


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
# the physics server reports normals facing the ray; _is_back reads the side.)
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
		if not _ray(pos, pos + (d as Vector3) * reach, LAYER_HARD | LAYER_SOFT | LAYER_SUBJECT | LAYER_SEE).is_empty():
			sides += 1
	if not _ray(pos, pos + Vector3.UP * reach * 2.0, LAYER_HARD | LAYER_SOFT | LAYER_SUBJECT | LAYER_SEE).is_empty():
		sides += 1
	return sides


# The strongest visible DirectionalLight3D (the key light): the direction its
# light TRAVELS (the node's -Z), for the light-direction score.
func _key_light() -> Dictionary:
	var best: DirectionalLight3D = null
	for n in _subject.find_children("*", "DirectionalLight3D", true, false):
		var light := n as DirectionalLight3D
		if light == null or not light.is_visible_in_tree() or light.light_energy <= 0.0:
			continue
		if best == null or light.light_energy > best.light_energy:
			best = light
	if best == null:
		return {}
	return {
		"path": _rel(best),
		"direction": _arr(-best.global_transform.basis.z.normalized(), 4),
		"energy": snappedf(best.light_energy, 0.01),
		"shadow": best.shadow_enabled,
	}


# Mark occlusion: is each marked node really visible from the camera? Five
# points per node (its visible-bounds centre plus four points across the box
# face that faces the camera); a point is seen when the line to it reaches the
# node itself, or nothing, before any OTHER opaque surface drawn from that
# side. Back faces of one-sided surfaces and transparent surfaces are not
# drawn, so they hide nothing; a node met only from behind is not drawn either.
func _occlusion(spec: Dictionary) -> Dictionary:
	var cam := _vec(spec.get("position"))
	var mask := LAYER_HARD | LAYER_SOFT | LAYER_SUBJECT | LAYER_SEE
	var out: Array = []
	for raw in (spec.get("marks", []) as Array):
		var m: Dictionary = raw
		var path := String(m.get("path", ""))
		var entry := {"id": int(m.get("id", 0)), "path": path}
		var node := _resolve(path)
		if node == null:
			entry["missing"] = true
			out.append(entry)
			continue
		var b := _bounds(node)
		var own := _rel(node)
		var samples := _box_samples(b["aabb"], cam)
		var seen := 0
		var own_back := 0
		var blocker := ""
		for p in samples:
			var r := _sees_node(cam, p, own, mask)
			if bool(r["seen"]):
				seen += 1
			elif bool(r["own_back"]):
				own_back += 1
			elif blocker == "":
				blocker = String(r["blocker"])
		entry["visible"] = seen
		entry["samples"] = samples.size()
		if own_back > 0:
			entry["own_back"] = own_back
		if blocker != "":
			entry["blocker"] = blocker
		out.append(entry)
	return {"position": _arr(cam), "marks": out}


func _render_occlusion() -> void:
	_build_physics([])
	if _state == null:
		_warn("occlusion check skipped: no physics space")
	else:
		_result["occlusion"] = _occlusion(_cfg.get("occlusion", {}))
	_free_physics()
	_write_result()


func _box_samples(box: AABB, cam: Vector3) -> Array:
	var c := box.get_center()
	var view := c - cam
	# The two box axes least aligned with the view span the face it sees.
	var order := [0, 1, 2]
	order.sort_custom(func(a, b): return absf(view[a]) < absf(view[b]))
	var pts: Array = [c]
	for k in 2:
		var axis := int(order[k])
		for sgn in [-0.35, 0.35]:
			var off := Vector3.ZERO
			off[axis] = box.size[axis] * float(sgn)
			pts.append(c + off)
	return pts


func _sees_node(cam: Vector3, target: Vector3, own: String, mask: int) -> Dictionary:
	var total := cam.distance_to(target)
	if total < 0.01:
		return {"seen": true, "own_back": false, "blocker": ""}
	var dir := (target - cam) / total
	var end := target + dir * 0.05
	var start := cam
	var met_own_back := false
	for _step in 8:
		var hit := _ray(start, end, mask)
		if hit.is_empty():
			break
		var point: Vector3 = hit["position"]
		var g := _geom(hit)
		var flags := int(g.get("flags", 0))
		var path := String(g.get("path", ""))
		var back := _is_back(point, dir, flags)
		var is_own := own == "." or path == own or path.begins_with(own + "/")
		if is_own:
			if not back:
				return {"seen": true, "own_back": false, "blocker": ""}
			met_own_back = true
		elif (flags & FLAG_SEE) == 0 and not back:
			return {"seen": false, "own_back": false, "blocker": path}
		start = point + dir * 0.01
	return {"seen": not met_own_back, "own_back": met_own_back, "blocker": ""}


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
uniform float gain = 3.0;
void fragment() {
	// Compare 3x3-averaged neighbourhoods: JPEG blocks and fine texture
	// (bricks, gravel) must not light up as change, real shifts still do.
	vec2 px = TEXTURE_PIXEL_SIZE * 1.5;
	vec3 a = vec3(0.0);
	vec3 b = vec3(0.0);
	for (int x = -1; x <= 1; x++) {
		for (int y = -1; y <= 1; y++) {
			vec2 o = vec2(float(x), float(y)) * px;
			a += texture(prev_tex, UV + o).rgb;
			b += texture(now_tex, UV + o).rgb;
		}
	}
	a /= 9.0;
	b /= 9.0;
	float d = clamp(length(a - b) * gain, 0.0, 1.0);
	vec3 base = vec3(dot(b, vec3(0.299, 0.587, 0.114))) * 0.3;
	vec3 heat = mix(vec3(0.95, 0.12, 0.05), vec3(1.0, 0.95, 0.25), clamp(d * 2.0 - 1.0, 0.0, 1.0));
	COLOR = vec4(mix(base, heat, smoothstep(0.12, 0.4, d)), 1.0);
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
	if not _checks.is_empty() and not _measurements.is_empty():
		var spec: Dictionary = _cfg.get("measure", {})
		var cols := int(spec.get("grid_cols", 16))
		var rows := int(spec.get("grid_rows", 9))
		for chk in _checks:
			var idx := int(chk["i"])
			if idx >= _measurements.size():
				continue
			var rec: Dictionary = _measurements[idx]
			if rec.has("rejected") or bool(chk["done"]):
				continue
			var img: Image = (chk["vp"] as SubViewport).get_texture().get_image()
			if img == null or img.is_empty() or _image_blank(img):
				continue
			var codes := _image_codes(img, cols, rows)
			rec["lum"] = codes["lum"]
			rec["tex"] = codes["tex"]
			chk["done"] = true
		_result["image_checked"] = _draws
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
