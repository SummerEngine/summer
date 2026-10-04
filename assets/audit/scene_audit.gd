@tool
extends Node
## Summer scene-audit kernel (summer_scene_audit).
##
## The MCP tool writes a throwaway wrapper scene into a private per-call OS
## temp directory: the wrapper instances the target scene as "Subject" and
## carries this script as a built-in @tool script. The wrapper is rendered with
## the engine's ScenePreview op, which instantiates it under an offscreen
## SubViewport with its own World3D, so this node runs inside a private COPY of
## the SAVED scene. Nothing here touches the edited scene, the open tab, the
## undo history or any project file. The only file written is result.json in
## the wrapper's own temp directory.
##
## Arguments arrive as DATA only: config.json next to the wrapper, found
## through this built-in script's own resource path and parsed as JSON.
##
## This kernel MEASURES; it does not judge. It walks every node, groups the
## geometry into kit instances, builds one private physics space from the
## VISIBLE meshes (one-sided like the renderer: a ray only hits a triangle
## from its front, so back faces are as see-through as on screen; shapes are
## cached per mesh resource and shared by every unscaled instance), casts
## capped ray grids and per-instance probes, and writes raw evidence. The
## TypeScript side (core/capabilities/audit/) clusters, applies thresholds,
## assigns severities, sorts, pages and frames.

const SUBJECT_NAME := "Subject"

const L_WALL := 1
const L_STRUCT := 2
const L_FLOOR := 4
const L_UNDERLAY := 8
const L_PROP := 16
const L_MOUNT := 32
const L_INSERT := 64
const ROLE_LAYER := {"wall": L_WALL, "struct": L_STRUCT, "floor": L_FLOOR, "underlay": L_UNDERLAY, "prop": L_PROP, "mount": L_MOUNT, "insert": L_INSERT}
const MASK_FACADE := L_WALL | L_STRUCT | L_INSERT
# What covers an opening: facade modules, inserts, and mounted pieces (a
# roller shutter or boarding over a frame). Props never close a hole.
const MASK_HOLE := MASK_FACADE | L_MOUNT
const MASK_SOLID := L_WALL | L_STRUCT | L_INSERT | L_FLOOR | L_UNDERLAY | L_PROP | L_MOUNT

const STRUCT_RE := "(wall|facade|building|house|floor|ground|road|street|pavement|sidewalk|terrain|roof|tower|bridge|stair|pier|corner|crown|cornice|base|dado|plinth|column|pillar|beam|ceiling|frame|trim|fence|gate|railing)"
const FLOOR_RE := "(floor|ground|road|street|pavement|sidewalk|plaza|tile|terrain|asphalt|courtyard_floor|deck)"
const WALL_RE := "(wall|facade|building|house)"
const UNDERLAY_RE := "(underlay|backing|catch|void)"
const SCATTER_RE := "(leaves|leaf|pebble|gravel|grass|weed|moss|litter|decal|puddle|ivy|vine|tree|bush|shrub|plant|flower|foliage)"
const ROOF_RE := "(roof|ceiling|canopy|awning|overhang)"
const HANGING_RE := "(ivy|vine|hanging|creeper)"
# floor_gap strips: edge step along a tile edge, and how far out a wall bounds
# the strip between that edge and the wall (walkable area enclosed by walls).
const STRIP_STEP := 0.25
const STRIP_REACH := 1.0
# Usual share of a check's editor time (the budget's weights).
const STAGE_WEIGHT := {"through_hole": 4.0, "floor_gap": 2.0, "floating_sunken": 1.0, "interpenetration": 2.0, "mount_gap": 1.0, "orientation": 1.0, "uv_stretch": 1.0, "insert_host": 0.3, "lights": 0.3, "resource": 0.5, "poses": 1.0}

var _cfg: Dictionary = {}
var _out_dir := ""
var _result: Dictionary = {}
var _subject: Node = null
var _checks: Dictionary = {}
var _report_root: Node = null
var _want_poses := false

var _t0 := 0
var _ms: Dictionary = {}

var _nodes := 0
var _hidden := 0
var _multimesh := 0
var _inst: Array = []
var _lights: Array = []
var _empty_meshes: Array = []
var _shader_no_code: Array = []

var _manifest_files: Dictionary = {}
var _manifest_by_scene: Dictionary = {}
var _manifest_loaded: Array = []

var _mesh_info: Dictionary = {}
var _space := RID()
var _state: PhysicsDirectSpaceState3D = null
var _bodies: Array = []
var _shapes: Array = []
var _hulls: Dictionary = {}
var _body_inst: Dictionary = {}
var _q: PhysicsRayQueryParameters3D = null
var _ex: Array[RID] = []
var _rays := 0
var _floor_gap_count := 0
var _floor_gap_void := false
var _floor_gap_covered := false
var _floor_recs: Array = []
# Ground alternatives packs document: [pack dir, source file, material, clause].
var _pack_docs: Array = []
# Wall standoffs ASSEMBLY.md gives per section: pack dir -> [[heading, metres]].
var _pack_standoff: Dictionary = {}

# Editor-time budget (budget_ms): each check gets a share of what is left,
# weighted by its usual cost; time a fast check leaves unused passes on to
# the next ones. A check past its share stops and is reported partial:
# _tally[stage] = [units done, units planned].
var _budget_us := 0
var _check_end := 0
var _pending: Array = []
var _tally: Dictionary = {}

var _re_struct: RegEx = null
var _re_floor: RegEx = null
var _re_wall: RegEx = null
var _re_underlay: RegEx = null
var _re_scatter: RegEx = null
var _re_hanging: RegEx = null
var _re_roof: RegEx = null


func _ready() -> void:
	_result = {"ok": false, "stage": "ready", "warnings": [], "errors": []}
	var script_path := String((get_script() as Script).resource_path)
	var wrapper_path := script_path.get_slice("::", 0)
	_out_dir = wrapper_path.get_base_dir()
	if wrapper_path == "" or not wrapper_path.ends_with("wrapper.tscn"):
		push_error("Summer scene audit: cannot locate its wrapper scene (script path '%s')." % script_path)
		return
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(_out_dir.path_join("config.json")))
	if typeof(parsed) != TYPE_DICTIONARY:
		_fail("config_unreadable", "Could not read the audit config.")
		return
	_cfg = parsed
	_result["renderer"] = RenderingServer.get_current_rendering_method()
	_subject = get_parent().get_node_or_null(SUBJECT_NAME)
	if _subject == null:
		_fail("no_subject", "The wrapper scene has no Subject instance (the target scene failed to instantiate).")
		return
	get_viewport().disable_3d = true
	_result["stage"] = "configured"
	_write_result()
	# Deferred so CSG roots and @tool scripts that settle with call_deferred
	# have run first. ScenePreview iterates the main loop, which flushes this.
	call_deferred("_run")


func _exit_tree() -> void:
	_free_physics()


# ---------------------------------------------------------------------------
# Plumbing
# ---------------------------------------------------------------------------

func _fail(reason: String, message: String) -> void:
	_result["ok"] = false
	_result["failure_reason"] = reason
	(_result["errors"] as Array).append(message)
	_write_result()


func _warn(message: String) -> void:
	var w: Array = _result["warnings"]
	if w.size() < 24 and not w.has(message):
		w.append(message)


func _write_result() -> void:
	var f := FileAccess.open(_out_dir.path_join("result.json"), FileAccess.WRITE)
	if f == null:
		return
	f.store_string(JSON.stringify(_result))
	f.close()


func _lap(stage: String, since: int) -> int:
	var now := Time.get_ticks_usec()
	_ms[stage] = snappedf(float(now - since) / 1000.0, 0.1)
	return now


# Start a check: its deadline is its weighted share of the budget left.
func _begin(stage: String) -> void:
	var w_all := 0.0
	for s in _pending:
		w_all += float(STAGE_WEIGHT.get(s, 1.0))
	var w := float(STAGE_WEIGHT.get(stage, 1.0))
	_pending.erase(stage)
	if _budget_us <= 0:
		_check_end = 0
		return
	var now := Time.get_ticks_usec()
	var left := maxi(0, _budget_us - (now - _t0))
	var share := int(float(left) * w / maxf(w_all, w))
	# Every check gets a little time, even when setup used up the budget.
	_check_end = now + maxi(share, int(float(_budget_us) / 30.0))


# The running check is past its share of the budget.
func _over() -> bool:
	return _check_end > 0 and Time.get_ticks_usec() > _check_end


func _count(stage: String, done: int, total: int) -> void:
	var tl: Array = _tally.get(stage, [0, 0])
	_tally[stage] = [int(tl[0]) + done, int(tl[1]) + total]


static func _a3(v: Vector3, step := 0.001) -> Array:
	return [snappedf(v.x, step), snappedf(v.y, step), snappedf(v.z, step)]


static func _b9(b: Basis) -> Array:
	return [snappedf(b.x.x, 0.0001), snappedf(b.x.y, 0.0001), snappedf(b.x.z, 0.0001), snappedf(b.y.x, 0.0001), snappedf(b.y.y, 0.0001), snappedf(b.y.z, 0.0001), snappedf(b.z.x, 0.0001), snappedf(b.z.y, 0.0001), snappedf(b.z.z, 0.0001)]


func _rel(node: Node) -> String:
	if node == _subject:
		return "."
	return String(_subject.get_path_to(node))


func _in_root(node: Node) -> bool:
	return _report_root == null or node == _report_root or _report_root.is_ancestor_of(node)


func _resolve(path: String) -> Node:
	var p := path.strip_edges()
	if p == "" or p == ".":
		return _subject
	var n := _subject.get_node_or_null(NodePath(p))
	var root_name := String(_subject.name)
	if n == null and p.begins_with(root_name + "/"):
		n = _subject.get_node_or_null(NodePath(p.substr(root_name.length() + 1)))
	return n


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

func _run() -> void:
	_t0 = Time.get_ticks_usec()
	var t := _t0
	_result["stage"] = "collect"
	for c in (_cfg.get("checks", []) as Array):
		_checks[String(c)] = true
	_want_poses = bool(_cfg.get("poses", false))
	_budget_us = int(float(_cfg.get("budget_ms", 0)) * 1000.0)
	var root_path := String(_cfg.get("root", ""))
	if root_path != "" and root_path != ".":
		_report_root = _resolve(root_path)
		if _report_root == null:
			_fail("node_not_found", "root node not found in the scene: " + root_path)
			return
	_re_struct = RegEx.create_from_string("(?i)" + STRUCT_RE)
	_re_floor = RegEx.create_from_string("(?i)" + FLOOR_RE)
	_re_wall = RegEx.create_from_string("(?i)" + WALL_RE)
	_re_underlay = RegEx.create_from_string("(?i)" + UNDERLAY_RE)
	_re_scatter = RegEx.create_from_string("(?i)" + SCATTER_RE)
	_re_hanging = RegEx.create_from_string("(?i)" + HANGING_RE)
	_re_roof = RegEx.create_from_string("(?i)" + ROOF_RE)

	_collect()
	t = _lap("collect", t)
	_load_manifests()
	for rec in _inst:
		_classify(rec)
	_resolve_underlays()
	t = _lap("manifests_roles", t)

	var need_physics := false
	for c in ["through_hole", "floor_gap", "floating", "sunken", "interpenetration", "mount_gap", "orientation", "uv_stretch", "z_fight"]:
		if _checks.has(c):
			need_physics = true
	var need_mesh_pass := need_physics or _checks.has("uv_stretch")
	if need_mesh_pass:
		_mesh_pass()
		t = _lap("mesh_pass", t)
	if need_physics:
		_build_space()
		t = _lap("physics_build", t)
		if _state == null:
			_fail("physics_unavailable", "Could not create a private physics space for the audit.")
			return
		_q = PhysicsRayQueryParameters3D.new()
		_q.collide_with_areas = false
		_q.collide_with_bodies = true

	_result["stage"] = "checks"
	var run_th := _checks.has("through_hole") or _checks.has("z_fight")
	var run_fl := _checks.has("floor_gap") or _checks.has("z_fight")
	var run_su := _checks.has("floating") or _checks.has("sunken")
	var run_mo := _checks.has("mount_gap") or _checks.has("orientation")
	var run_po := _want_poses and _state != null
	for stage_on in [["through_hole", run_th], ["floor_gap", run_fl], ["floating_sunken", run_su], ["interpenetration", _checks.has("interpenetration")], ["mount_gap", run_mo], ["orientation", _checks.has("orientation")], ["uv_stretch", _checks.has("uv_stretch")], ["insert_host", _checks.has("insert_host")], ["lights", _checks.has("lights")], ["resource", _checks.has("resource")], ["poses", run_po]]:
		if bool(stage_on[1]):
			_pending.append(String(stage_on[0]))
	if run_th:
		_begin("through_hole")
		_result["lines"] = _scan_facades()
		t = _lap("through_hole", t)
	if run_fl:
		_begin("floor_gap")
		_result["floors"] = _scan_floors()
		t = _lap("floor_gap", t)
	if run_su:
		_begin("floating_sunken")
		_result["support"] = _scan_support()
		t = _lap("floating_sunken", t)
	if _checks.has("interpenetration"):
		_begin("interpenetration")
		_result["overlaps"] = _scan_overlaps()
		t = _lap("interpenetration", t)
	if run_mo:
		_begin("mount_gap")
		_result["mounts"] = _scan_mounts()
		t = _lap("mount_gap", t)
	if _checks.has("orientation"):
		_begin("orientation")
		_result["long_props"] = _scan_long_props()
		t = _lap("orientation", t)
	if _checks.has("uv_stretch"):
		_begin("uv_stretch")
		_result["uv"] = _scan_uv()
		t = _lap("uv_stretch", t)
	if _checks.has("insert_host"):
		_begin("insert_host")
		_result["inserts"] = _scan_inserts()
		t = _lap("insert_host", t)
	if _checks.has("lights"):
		_begin("lights")
		_result["lights"] = _scan_lights()
		t = _lap("lights", t)
	if _checks.has("resource"):
		_begin("resource")
		_result["resources"] = _scan_resources()
		t = _lap("resource", t)
	if run_po:
		_begin("poses")
		_scan_clearances()
		t = _lap("poses", t)
	# Checks a budget stopped early: [units done, units planned].
	var partial: Dictionary = {}
	for stage in _tally:
		var tl: Array = _tally[stage]
		if int(tl[0]) < int(tl[1]):
			partial[stage] = [int(tl[0]), int(tl[1])]
	_result["partial"] = partial
	_result["instances"] = _instance_rows()
	t = _lap("emit", t)
	_ms["total"] = snappedf(float(Time.get_ticks_usec() - _t0) / 1000.0, 0.1)
	_result["ms"] = _ms
	_result["stats"] = {
		"nodes": _nodes, "hidden_skipped": _hidden, "instances": _inst.size(), "mesh_instances": _count_meshes(),
		"unique_meshes": _mesh_info.size(), "tris_unique": _tris_unique(), "bodies": _bodies.size(), "lights": _lights.size(),
		"multimesh_skipped": _multimesh, "rays": _rays,
	}
	_result["manifests"] = _manifest_loaded
	_result["packs"] = _pack_docs
	_result["ok"] = true
	_result["stage"] = "done"
	_write_result()
	_free_physics()


func _count_meshes() -> int:
	var n := 0
	for rec in _inst:
		n += (rec["meshes"] as Array).size()
	return n


func _tris_unique() -> int:
	var n := 0
	for k in _mesh_info:
		n += int((_mesh_info[k] as Dictionary).get("tris", 0))
	return n


# ---------------------------------------------------------------------------
# Collect: every node -> kit instances (outermost instanced scenes) and loose
# geometry, lights, empty meshes.
# ---------------------------------------------------------------------------

func _collect() -> void:
	var loose: Dictionary = {}
	var stack: Array = [[_subject, -1]]
	while not stack.is_empty():
		var item: Array = stack.pop_back()
		var node: Node = item[0]
		var owner_i: int = item[1]
		_nodes += 1
		if node is Node3D and not (node as Node3D).visible:
			_hidden += 1
			continue
		if node != _subject and owner_i < 0 and node.scene_file_path != "":
			owner_i = _new_inst(node, node.scene_file_path)
		if node is Light3D:
			_lights.append(node)
		elif node is MeshInstance3D:
			var mi := node as MeshInstance3D
			if mi.mesh == null or mi.mesh.get_surface_count() == 0:
				if _empty_meshes.size() < 64:
					_empty_meshes.append([_rel(mi), owner_i])
			else:
				var oi := owner_i if owner_i >= 0 else _loose_owner(mi, loose)
				(_inst[oi]["meshes"] as Array).append([mi, mi.mesh, mi.global_transform])
		elif node is CSGShape3D:
			var csg := node as CSGShape3D
			if csg.is_root_shape():
				var meshes: Array = csg.get_meshes()
				if meshes.size() >= 2 and meshes[1] is Mesh:
					var oi2 := owner_i if owner_i >= 0 else _loose_owner(csg, loose)
					(_inst[oi2]["meshes"] as Array).append([csg, meshes[1], csg.global_transform * Transform3D(meshes[0])])
			continue
		elif node is MultiMeshInstance3D:
			_multimesh += 1
		for child in node.get_children():
			stack.push_back([child, owner_i])
	var kept: Array = []
	for rec in _inst:
		if (rec["meshes"] as Array).is_empty():
			continue
		rec["i"] = kept.size()
		kept.append(rec)
	_inst = kept
	for rec in _inst:
		_bounds(rec)


func _new_inst(node: Node, scene: String) -> int:
	var xf := Transform3D.IDENTITY
	if node is Node3D:
		xf = (node as Node3D).global_transform
	var path := _rel(node)
	_inst.append({
		"i": _inst.size(), "node": node, "path": path, "scene": scene, "piece": scene.get_file().get_basename(),
		"name": String(node.name), "xf": xf, "meshes": [], "bodies": [], "man": {}, "role": "", "in": _in_root(node),
		"top": path.get_slice("/", 0),
	})
	return _inst.size() - 1


func _loose_owner(node: Node3D, loose: Dictionary) -> int:
	var key: Node = node
	var parent := node.get_parent()
	if parent is CollisionObject3D and parent != _subject:
		key = parent
	if loose.has(key):
		return int(loose[key])
	var i := _new_inst(key, "")
	_inst[i]["piece"] = String(key.name)
	loose[key] = i
	return i


static func _corners(box: AABB) -> Array:
	var p := box.position
	var s := box.size
	return [p, p + Vector3(s.x, 0, 0), p + Vector3(0, s.y, 0), p + Vector3(0, 0, s.z), p + Vector3(s.x, s.y, 0), p + Vector3(s.x, 0, s.z), p + Vector3(0, s.y, s.z), p + s]


func _bounds(rec: Dictionary) -> void:
	var xf: Transform3D = rec["xf"]
	var inv := xf.affine_inverse()
	var la := AABB()
	var wa := AABB()
	var first := true
	for m in (rec["meshes"] as Array):
		var mesh: Mesh = m[1]
		var mxf: Transform3D = m[2]
		var mb := mesh.get_aabb()
		var lx := inv * mxf
		for c in _corners(mb):
			var lp: Vector3 = lx * c
			var wp: Vector3 = mxf * c
			if first:
				la = AABB(lp, Vector3.ZERO)
				wa = AABB(wp, Vector3.ZERO)
				first = false
			else:
				la = la.expand(lp)
				wa = wa.expand(wp)
	rec["laabb"] = la
	rec["waabb"] = wa


# ---------------------------------------------------------------------------
# Manifests: pieces.json next to (or one or two folders above) each instanced
# scene, plus config "manifests", plus PACK.json wall-mount lists.
# ---------------------------------------------------------------------------

func _load_manifests() -> void:
	for p in (_cfg.get("manifests", []) as Array):
		_read_manifest(String(p), true)
	var dirs: Dictionary = {}
	for rec in _inst:
		var scene := String(rec["scene"])
		if scene == "" or not scene.begins_with("res://"):
			continue
		var d := scene.get_base_dir()
		for k in 3:
			if dirs.has(d):
				break
			dirs[d] = true
			_read_manifest(d.path_join("pieces.json"), false)
			_read_pack(d.path_join("PACK.json"))
			if d == "res://" or d.count("/") <= 2:
				break
			d = d.get_base_dir()
	for rec in _inst:
		var scene := String(rec["scene"])
		if _manifest_by_scene.has(scene):
			rec["man"] = _manifest_by_scene[scene]


func _read_manifest(path: String, explicit: bool) -> void:
	if _manifest_files.has(path):
		return
	_manifest_files[path] = true
	if not FileAccess.file_exists(path):
		if explicit:
			_warn("manifest not found: " + path)
		return
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(path))
	if typeof(parsed) != TYPE_DICTIONARY or typeof((parsed as Dictionary).get("pieces")) != TYPE_DICTIONARY:
		_warn("manifest has no pieces object: " + path)
		return
	var pieces: Dictionary = (parsed as Dictionary)["pieces"]
	var n := 0
	for name in pieces:
		var entry: Variant = pieces[name]
		if typeof(entry) != TYPE_DICTIONARY:
			continue
		var e: Dictionary = (entry as Dictionary).duplicate()
		e["piece"] = String(name)
		e["manifest"] = path
		var scene := String(e.get("scene", ""))
		if scene == "":
			scene = path.get_base_dir().path_join(String(name) + ".tscn")
		if not _manifest_by_scene.has(scene):
			_manifest_by_scene[scene] = e
			n += 1
	if _manifest_loaded.size() < 16:
		_manifest_loaded.append([path, n])


# A prop pack without pieces.json may still say which props mount on a wall:
# PACK.json how_to_use "Wall-mounted props (a, b, c) have their back ... at -Z".
func _read_pack(path: String) -> void:
	if _manifest_files.has(path):
		return
	_manifest_files[path] = true
	if not FileAccess.file_exists(path):
		return
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(path))
	if typeof(parsed) != TYPE_DICTIONARY:
		return
	var how := String((parsed as Dictionary).get("how_to_use", ""))
	var pack_dir := path.get_base_dir()
	var assembly := pack_dir.path_join("ASSEMBLY.md")
	var md := ""
	if FileAccess.file_exists(assembly):
		md = FileAccess.get_file_as_string(assembly)
	if not _pack_ground(pack_dir, "PACK.json", how):
		_pack_ground(pack_dir, "ASSEMBLY.md", md)
	_pack_standoffs(pack_dir, md)
	var re := RegEx.create_from_string("(?i)wall[- ]mounted[^(]{0,40}\\(([^)]{1,600})\\)([^.]{0,120})")
	var m := re.search(how)
	if m == null:
		return
	var side := "-Z"
	var tail := m.get_string(2)
	var sm := RegEx.create_from_string("([+-][XYZ])").search(tail)
	if sm != null:
		side = sm.get_string(1)
	var n := 0
	for raw in m.get_string(1).split(","):
		var word := String(raw).strip_edges().get_slice(" ", 0)
		if word == "":
			continue
		var scene := path.get_base_dir().path_join(word + ".tscn")
		if not _manifest_by_scene.has(scene):
			_manifest_by_scene[scene] = {"piece": word, "wall_side": side, "manifest": path, "from": "PACK.json how_to_use"}
			n += 1
	if n > 0 and _manifest_loaded.size() < 16:
		_manifest_loaded.append([path, n])


# A pack that documents a ground alternative ("for any other ground use
# material res://.../alley_ground.tres on a PlaneMesh"): the first clause that
# names a ground or floor AND an existing material. floor_gap names it in its
# next step. Returns whether one was found.
func _pack_ground(dir: String, source: String, text: String) -> bool:
	if text == "" or _pack_docs.size() >= 8:
		return false
	var re_path := RegEx.create_from_string("(res://[A-Za-z0-9_\\-./]+|[A-Za-z0-9_\\-]+/[A-Za-z0-9_\\-./]+)\\.(tres|material)")
	var re_ground := RegEx.create_from_string("(?i)\\b(ground|floor|terrain|planemesh)")
	for clause in text.replace("; ", "\n").replace(". ", "\n").split("\n"):
		var c := String(clause).strip_edges()
		if c.length() < 8 or re_ground.search(c) == null:
			continue
		var m := re_path.search(c)
		if m == null:
			continue
		var material := m.get_string(0)
		if not material.begins_with("res://"):
			material = dir.path_join(material)
		if not ResourceLoader.exists(material):
			continue
		_pack_docs.append([dir, source, material, c.substr(0, 200)])
		return true
	return false


# ASSEMBLY.md sections that give a wall standoff ("Ducts: ... standing about
# 0.1 m off the wall", "flush to the wall (0-10 cm)"): the largest distance
# per section heading. A mounted piece whose pieces.json category the heading
# names may stand that far off its wall (mount_gap).
func _pack_standoffs(dir: String, md: String) -> void:
	if md == "":
		return
	var re_off := RegEx.create_from_string("(?i)(\\d+(?:\\.\\d+)?)(?:\\s*-\\s*(\\d+(?:\\.\\d+)?))?\\s*(cm|m)\\s+off\\s+(?:the|a|its)\\s+wall")
	var re_flush := RegEx.create_from_string("(?i)flush\\s+(?:to|against|on)\\s+(?:the|a|its)\\s+wall\\s*\\(\\s*(\\d+(?:\\.\\d+)?)(?:\\s*-\\s*(\\d+(?:\\.\\d+)?))?\\s*(cm|m)\\s*\\)")
	var rows: Array = []
	for section in md.split("\n## "):
		var heading := String(section).get_slice("\n", 0).strip_edges().to_lower()
		var hi := -1.0
		for pattern in [re_off, re_flush]:
			for found in (pattern as RegEx).search_all(String(section)):
				var rm := found as RegExMatch
				var v := float(rm.get_string(2) if rm.get_string(2) != "" else rm.get_string(1))
				if rm.get_string(3).to_lower() == "cm":
					v /= 100.0
				hi = maxf(hi, v)
		if hi >= 0.0 and hi <= 1.0 and heading != "" and rows.size() < 24:
			rows.append([heading, hi])
	if not rows.is_empty():
		_pack_standoff[dir] = rows


# How far off its wall a mounted piece may stand: pieces.json standoff_m (a
# number, or [min, max]), else its pack's ASSEMBLY.md section whose heading
# names its category. [metres or null, source].
func _standoff_of(rec: Dictionary) -> Array:
	var man: Dictionary = rec["man"]
	var raw: Variant = man.get("standoff_m", null)
	if typeof(raw) == TYPE_FLOAT or typeof(raw) == TYPE_INT:
		return [snappedf(float(raw), 0.001), "pieces.json"]
	if typeof(raw) == TYPE_ARRAY:
		var top := -1.0
		for v in (raw as Array):
			if typeof(v) == TYPE_FLOAT or typeof(v) == TYPE_INT:
				top = maxf(top, float(v))
		if top >= 0.0:
			return [snappedf(top, 0.001), "pieces.json"]
	var cat := String(man.get("category", "")).to_lower().replace("_", " ")
	var scene := String(rec["scene"])
	if cat == "" or scene == "":
		return [null, ""]
	for pack in _pack_standoff:
		if not scene.begins_with(String(pack) + "/"):
			continue
		for row in (_pack_standoff[pack] as Array):
			if String(row[0]).contains(cat):
				return [snappedf(float(row[1]), 0.001), "ASSEMBLY.md"]
	return [null, ""]


static func _axis_of(text: String) -> Vector3:
	var t := text.strip_edges().to_upper()
	if t.length() < 2:
		return Vector3.ZERO
	var s := 1.0 if t[0] == "+" else (-1.0 if t[0] == "-" else 0.0)
	if s == 0.0:
		return Vector3.ZERO
	match t[1]:
		"X":
			return Vector3(s, 0, 0)
		"Y":
			return Vector3(0, s, 0)
		"Z":
			return Vector3(0, 0, s)
	return Vector3.ZERO


# ---------------------------------------------------------------------------
# Roles: wall (facade module), struct (other structural module), floor,
# underlay, insert (fits_into), mount (wall_side), prop, dressing.
# ---------------------------------------------------------------------------

func _classify(rec: Dictionary) -> void:
	var man: Dictionary = rec["man"]
	var name := (String(rec["piece"]) + " " + String(rec["name"])).to_lower()
	var la: AABB = rec["laabb"]
	var wa: AABB = rec["waabb"]
	var sx := la.size.x
	var sy := la.size.y
	var sz := la.size.z
	rec["front"] = Vector3.ZERO
	rec["mount"] = Vector3.ZERO
	var side := String(man.get("wall_side", man.get("mount_side", man.get("mount_axis", ""))))
	if man.has("fits_into") and typeof(man["fits_into"]) == TYPE_DICTIONARY:
		rec["role"] = "insert"
		rec["front"] = Vector3(0, 0, 1)
		return
	if side != "":
		var ax := _axis_of(side)
		if ax != Vector3.ZERO:
			rec["mount"] = ax
			if String(man.get("from", "")) == "":
				rec["role"] = "mount"
				rec["mount_src"] = "pieces"
				return
			# Read from a pack's prose: a free-standing prop that MAY hang on a
			# wall. It stays a prop (support, overlap) with a mount hint.
			rec["role"] = "prop"
			rec["mount_src"] = "pack_text"
			return
	var cat := String(man.get("category", "")).to_lower()
	if cat != "":
		if cat.contains("plant") or _re_scatter.search(name) != null:
			rec["role"] = "dressing"
			return
		if cat == "ground" or cat == "floor" or cat == "terrain":
			rec["role"] = "floor" if (_re_floor.search(name) != null and sy <= 0.6) else "dressing"
			return
		if cat.begins_with("facade") or cat == "courtyard" or cat == "walls" or cat == "wall":
			var fz := bool(man.get("front_faces_plus_z", false))
			if sy >= 1.0 and maxf(sx, sz) >= 0.8 and minf(sx, sz) <= 1.2:
				rec["role"] = "wall"
				rec["front"] = Vector3(0, 0, 1) if fz else Vector3.ZERO
				return
			rec["role"] = "struct"
			return
		rec["role"] = "struct"
		return
	# No manifest: names, then size.
	var horizontal := sx >= 1.5 and sz >= 1.5 and sy <= 0.6
	if _re_roof.search(name) != null:
		rec["role"] = "struct"
		return
	if _re_underlay.search(name) != null and horizontal:
		rec["role"] = "underlay"
		return
	if horizontal and (_re_floor.search(name) != null or sx * sz >= 30.0):
		rec["role"] = "floor"
		return
	if _re_scatter.search(name) != null:
		rec["role"] = "dressing"
		return
	if _re_wall.search(name) != null and sy >= 1.5 and maxf(sx, sz) >= 1.0 and minf(sx, sz) <= 1.2:
		rec["role"] = "wall"
		return
	if _re_struct.search(name) != null:
		rec["role"] = "struct"
		return
	var longest := maxf(wa.size.x, maxf(wa.size.y, wa.size.z))
	rec["role"] = "prop" if longest <= 3.5 else "struct"


func _resolve_underlays() -> void:
	var areas: Array = []
	for rec in _inst:
		if rec["role"] == "floor":
			var wa: AABB = rec["waabb"]
			areas.append(wa.size.x * wa.size.z)
	if areas.size() < 2:
		return
	areas.sort()
	var median: float = areas[areas.size() / 2]
	var tops: Array = []
	for rec in _inst:
		if rec["role"] == "floor":
			tops.append((rec["waabb"] as AABB).end.y)
	tops.sort()
	var median_top: float = tops[tops.size() / 2]
	for rec in _inst:
		if rec["role"] != "floor":
			continue
		var wa: AABB = rec["waabb"]
		if wa.size.x * wa.size.z >= 8.0 * median and wa.end.y < median_top - 0.005:
			rec["role"] = "underlay"


# ---------------------------------------------------------------------------
# One pass per mesh RESOURCE (cached by instance id): physics faces in index
# order (double-sided surfaces get both windings), outward face area per
# local axis (front inference), and UV-stretch candidate triangles.
# ---------------------------------------------------------------------------

func _mesh_pass() -> void:
	var want_uv := _checks.has("uv_stretch")
	# Meshes of mounted pieces also get their largest plane per axis and side
	# (front-back symmetry about the mount axis: mount_gap, orientation).
	var mount_meshes: Dictionary = {}
	if _checks.has("mount_gap") or _checks.has("orientation"):
		for rec in _inst:
			if (rec["mount"] as Vector3) != Vector3.ZERO:
				for m in (rec["meshes"] as Array):
					mount_meshes[(m[1] as Mesh).get_instance_id()] = true
	for rec in _inst:
		var role := String(rec["role"])
		if role == "dressing":
			continue
		for m in (rec["meshes"] as Array):
			var mesh: Mesh = m[1]
			var key := mesh.get_instance_id()
			if not _mesh_info.has(key):
				_mesh_info[key] = _analyze_mesh(mesh, want_uv and role != "underlay", mount_meshes.has(key))
	# Walls without a declared front: the thin local axis, signed by which side
	# carries more outward-facing area.
	for rec in _inst:
		if rec["role"] != "wall" or rec["front"] != Vector3.ZERO:
			continue
		var la: AABB = rec["laabb"]
		var axis := 2 if la.size.z <= la.size.x else 0
		var plus := 0.0
		var minus := 0.0
		for m in (rec["meshes"] as Array):
			var info: Dictionary = _mesh_info.get((m[1] as Mesh).get_instance_id(), {})
			var areas: PackedFloat32Array = info.get("axis_area", PackedFloat32Array([0, 0, 0, 0, 0, 0]))
			plus += areas[axis * 2]
			minus += areas[axis * 2 + 1]
		var v := Vector3.ZERO
		v[axis] = 1.0 if plus >= minus else -1.0
		rec["front"] = v


func _double_sided(mat: Material) -> bool:
	if mat is BaseMaterial3D:
		return (mat as BaseMaterial3D).cull_mode == BaseMaterial3D.CULL_DISABLED
	if mat is ShaderMaterial:
		var sh: Shader = (mat as ShaderMaterial).shader
		if sh == null:
			return false
		return sh.code.contains("cull_disabled")
	return false


func _analyze_mesh(mesh: Mesh, want_uv: bool, want_planes := false) -> Dictionary:
	var faces := PackedVector3Array()
	var axis_area := PackedFloat32Array([0, 0, 0, 0, 0, 0])
	# Axis-facing area in 1 cm slabs: Vector3i(axis, 0 for + / 1 for -, cm) -> m2.
	var planes: Dictionary = {}
	var uv_cands: Array = []
	var tris := 0
	var no_material := 0
	for s in mesh.get_surface_count():
		# Only ArrayMesh exposes the primitive; PrimitiveMesh surfaces are triangles.
		if mesh is ArrayMesh and (mesh as ArrayMesh).surface_get_primitive_type(s) != Mesh.PRIMITIVE_TRIANGLES:
			continue
		var arrays := mesh.surface_get_arrays(s)
		var verts: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
		if verts.is_empty():
			continue
		var mat := mesh.surface_get_material(s)
		if mat == null:
			no_material += 1
		var double := mat != null and _double_sided(mat)
		var idx: PackedInt32Array
		if arrays[Mesh.ARRAY_INDEX] != null:
			idx = arrays[Mesh.ARRAY_INDEX]
		else:
			idx = PackedInt32Array()
			idx.resize(verts.size())
			for k in verts.size():
				idx[k] = k
		var uvs := PackedVector2Array()
		if want_uv and arrays[Mesh.ARRAY_TEX_UV] != null:
			uvs = arrays[Mesh.ARRAY_TEX_UV]
		var has_uv := uvs.size() == verts.size()
		var n := idx.size() - idx.size() % 3
		var base := faces.size()
		faces.resize(base + (n * 2 if double else n))
		var w := base
		var j := 0
		while j < n:
			var i0 := idx[j]
			var i1 := idx[j + 1]
			var i2 := idx[j + 2]
			var p0: Vector3 = verts[i0]
			var p1: Vector3 = verts[i1]
			var p2: Vector3 = verts[i2]
			faces[w] = p0
			faces[w + 1] = p1
			faces[w + 2] = p2
			w += 3
			if double:
				faces[w] = p0
				faces[w + 1] = p2
				faces[w + 2] = p1
				w += 3
			# Plane(p0, p1, p2) normal: the side physics and the renderer call front.
			var cr: Vector3 = (p0 - p2).cross(p0 - p1)
			var a2 := cr.length()
			if a2 > 0.000001:
				var nn := cr / a2
				var area := a2 * 0.5
				if absf(nn.x) > 0.7:
					axis_area[0 if nn.x > 0 else 1] += area
				if absf(nn.y) > 0.7:
					axis_area[2 if nn.y > 0 else 3] += area
				if absf(nn.z) > 0.7:
					axis_area[4 if nn.z > 0 else 5] += area
				if want_planes:
					for pa in 3:
						if absf(nn[pa]) > 0.95:
							var pk := Vector3i(pa, 0 if nn[pa] > 0.0 else 1, int(round((p0[pa] + p1[pa] + p2[pa]) * 100.0 / 3.0)))
							planes[pk] = float(planes.get(pk, 0.0)) + area
				if has_uv and area >= 0.015:
					var t0: Vector2 = uvs[i0]
					var u1: Vector2 = uvs[i1] - t0
					var u2: Vector2 = uvs[i2] - t0
					var e1 := p1 - p0
					var e2 := p2 - p0
					var det := u1.x * u2.y - u2.x * u1.y
					var ratio := 1000.0
					if absf(det) > 1e-12:
						var inv := 1.0 / det
						var du := (e1 * u2.y - e2 * u1.y) * inv
						var dv := (e2 * u1.x - e1 * u2.x) * inv
						var aa := du.dot(du)
						var bb := dv.dot(dv)
						var ab := du.dot(dv)
						var disc := sqrt(maxf(0.0, (aa - bb) * (aa - bb) + 4.0 * ab * ab))
						var s2 := (aa + bb - disc) * 0.5
						var s1 := (aa + bb + disc) * 0.5
						ratio = 1000.0 if s2 <= 1e-14 else sqrt(s1 / s2)
					if ratio > 4.0:
						uv_cands.append([area, ratio, p0, p1, p2, uvs[i0], uvs[i1], uvs[i2], nn])
			j += 3
		tris += n / 3
	uv_cands.sort_custom(func(a, b): return float(a[0]) > float(b[0]))
	if uv_cands.size() > 6:
		uv_cands.resize(6)
	# The largest plane per (axis, side): [position (m), area (m2)] x 6, a plane
	# split across neighbouring 1 cm slabs counted whole.
	var plane_rows := PackedFloat32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
	for key in planes:
		var pk: Vector3i = key
		var sum := float(planes[key]) + float(planes.get(Vector3i(pk.x, pk.y, pk.z - 1), 0.0)) + float(planes.get(Vector3i(pk.x, pk.y, pk.z + 1), 0.0))
		var slot := (pk.x * 2 + pk.y) * 2
		if sum > plane_rows[slot + 1]:
			plane_rows[slot] = float(pk.z) / 100.0
			plane_rows[slot + 1] = sum
	return {"faces": faces, "axis_area": axis_area, "planes": plane_rows, "uv": uv_cands, "tris": tris, "no_material": no_material, "shape": RID(), "name": _mesh_name(mesh)}


func _mesh_name(mesh: Mesh) -> String:
	var p := String(mesh.resource_path)
	if p != "":
		return p.get_file()
	return String(mesh.resource_name) if String(mesh.resource_name) != "" else "mesh"


# ---------------------------------------------------------------------------
# Physics space from the visible meshes (dressing excluded).
# ---------------------------------------------------------------------------

static func _is_rigid(b: Basis) -> bool:
	return absf(b.x.length() - 1.0) < 0.001 and absf(b.y.length() - 1.0) < 0.001 and absf(b.z.length() - 1.0) < 0.001 \
		and absf(b.x.dot(b.y)) < 0.001 and absf(b.x.dot(b.z)) < 0.001 and absf(b.y.dot(b.z)) < 0.001


func _build_space() -> void:
	_space = PhysicsServer3D.space_create()
	PhysicsServer3D.space_set_active(_space, true)
	for rec in _inst:
		var layer := int(ROLE_LAYER.get(String(rec["role"]), 0))
		if layer == 0:
			continue
		for m in (rec["meshes"] as Array):
			var mesh: Mesh = m[1]
			var xf: Transform3D = m[2]
			var info: Dictionary = _mesh_info.get(mesh.get_instance_id(), {})
			var faces: PackedVector3Array = info.get("faces", PackedVector3Array())
			if faces.is_empty():
				continue
			var shape := RID()
			var body_xf := xf
			if _is_rigid(xf.basis):
				shape = info["shape"]
				if not shape.is_valid():
					shape = PhysicsServer3D.concave_polygon_shape_create()
					PhysicsServer3D.shape_set_data(shape, {"faces": faces, "backface_collision": true})
					info["shape"] = shape
					_shapes.append(shape)
			else:
				var baked := faces.duplicate()
				for k in baked.size():
					baked[k] = xf * baked[k]
				shape = PhysicsServer3D.concave_polygon_shape_create()
				PhysicsServer3D.shape_set_data(shape, {"faces": baked, "backface_collision": true})
				_shapes.append(shape)
				body_xf = Transform3D.IDENTITY
			var body := PhysicsServer3D.body_create()
			PhysicsServer3D.body_set_mode(body, PhysicsServer3D.BODY_MODE_STATIC)
			PhysicsServer3D.body_add_shape(body, shape)
			PhysicsServer3D.body_set_collision_layer(body, layer)
			PhysicsServer3D.body_set_collision_mask(body, 0)
			PhysicsServer3D.body_set_space(body, _space)
			PhysicsServer3D.body_set_state(body, PhysicsServer3D.BODY_STATE_TRANSFORM, body_xf)
			_bodies.append(body)
			_body_inst[body.get_id()] = int(rec["i"])
			(rec["bodies"] as Array).append(body)
	_state = PhysicsServer3D.space_get_direct_state(_space)


func _free_physics() -> void:
	for body in _bodies:
		PhysicsServer3D.free_rid(body)
	_bodies.clear()
	for shape in _shapes:
		PhysicsServer3D.free_rid(shape)
	_shapes.clear()
	_hulls.clear()
	if _space.is_valid():
		PhysicsServer3D.free_rid(_space)
		_space = RID()
	_state = null


# One-sided (renderer-like) ray unless `two_sided`. Returns {} on a miss.
func _ray(from: Vector3, to: Vector3, mask: int, exclude: Array = [], two_sided := false) -> Dictionary:
	_rays += 1
	_q.from = from
	_q.to = to
	_q.collision_mask = mask
	_q.hit_back_faces = two_sided
	_ex.clear()
	for r in exclude:
		_ex.append(r)
	_q.exclude = _ex
	return _state.intersect_ray(_q)


func _hit_inst(hit: Dictionary) -> int:
	if hit.is_empty():
		return -1
	return int(_body_inst.get((hit["rid"] as RID).get_id(), -1))


# Clear distance along dir from p (two-sided: any surface, front or back).
func _clear(p: Vector3, dir: Vector3, max_len: float, exclude: Array = []) -> float:
	var hit := _ray(p, p + dir * max_len, MASK_SOLID, exclude, true)
	if hit.is_empty():
		return max_len
	return (hit["position"] as Vector3).distance_to(p)


# ---------------------------------------------------------------------------
# through_hole (+ wall z-fight samples): facade lines -> capped ray grid
# ---------------------------------------------------------------------------

func _wall_plane(rec: Dictionary) -> Dictionary:
	var lf: Vector3 = rec["front"]
	if lf == Vector3.ZERO:
		return {}
	var xf: Transform3D = rec["xf"]
	var wn: Vector3 = xf.basis * lf
	var h := Vector3(wn.x, 0, wn.z)
	if h.length() < 0.7 * wn.length() or h.length() < 0.000001:
		return {}
	var n := h.normalized()
	var la: AABB = rec["laabb"]
	var c := la.get_center()
	var half := absf(lf.dot(la.size)) * 0.5
	var wf: Vector3 = xf * (c + lf * half)
	var wb: Vector3 = xf * (c - lf * half)
	return {"n": n, "d": n.dot(wf), "thick": maxf(0.0, n.dot(wf - wb))}


func _rect(rec: Dictionary, tax: Vector3) -> Array:
	var la: AABB = rec["laabb"]
	var xf: Transform3D = rec["xf"]
	var t0 := INF
	var t1 := -INF
	var y0 := INF
	var y1 := -INF
	for c in _corners(la):
		var w: Vector3 = xf * c
		var t := tax.dot(w)
		t0 = minf(t0, t)
		t1 = maxf(t1, t)
		y0 = minf(y0, w.y)
		y1 = maxf(y1, w.y)
	return [t0, t1, y0, y1]


func _scan_facades() -> Array:
	var lines: Array = []
	for rec in _inst:
		if rec["role"] != "wall":
			continue
		var pl := _wall_plane(rec)
		if pl.is_empty():
			continue
		var n: Vector3 = pl["n"]
		var placed := false
		for line in lines:
			var ln: Vector3 = line["n"]
			if ln.dot(n) > 0.9994 and absf(float(pl["d"]) - float(line["d"])) < 0.2:
				(line["walls"] as Array).append(rec)
				line["thick"] = maxf(float(line["thick"]), float(pl["thick"]))
				placed = true
				break
		if not placed:
			lines.append({"n": n, "d": float(pl["d"]), "thick": float(pl["thick"]), "walls": [rec]})
	# Rects, union area, spacing.
	var total_area := 0.0
	for line in lines:
		var n: Vector3 = line["n"]
		var tax := Vector3(n.z, 0, -n.x)
		line["t"] = tax
		var rects: Array = []
		for rec in (line["walls"] as Array):
			var r := _rect(rec, tax)
			rects.append([int(rec["i"]), r[0], r[1], r[2], r[3]])
			total_area += (r[1] - r[0]) * (r[3] - r[2])
		line["rects"] = rects
		var ins: Array = []
		for rec in _inst:
			if rec["role"] != "insert":
				continue
			var pl := _wall_plane(rec)
			if pl.is_empty() or (pl["n"] as Vector3).dot(n) < 0.996 or absf(float(pl["d"]) - float(line["d"])) > 0.6:
				continue
			var r := _rect(rec, tax)
			if _overlaps_any(rects, r):
				ins.append([int(rec["i"]), r[0], r[1], r[2], r[3]])
		line["inserts"] = ins
	var cap := int(_cfg.get("max_hole_rays", 24000))
	var s := clampf(sqrt(maxf(total_area, 1.0) / float(maxi(cap, 1000))), 0.15, 0.4)
	# Opposite-facing lines, for "reached the far side of the building".
	var out: Array = []
	for li in lines.size():
		var line: Dictionary = lines[li]
		out.append(_scan_line(line, lines, s))
	return out


static func _overlaps_any(rects: Array, r: Array) -> bool:
	for q in rects:
		if r[0] < q[2] and r[1] > q[1] and r[2] < q[4] and r[3] > q[3]:
			return true
	return false


# How far a ray that passed this facade must still travel to have reached the
# far side of the building: up to just before the nearest opposite-facing
# facade line behind it (its inside is the far side; what is on it, a shutter
# back or culled wall backs, is what the hole shows), else 4 m of open space.
func _far_distance(line: Dictionary, lines: Array, p: Vector3) -> float:
	var n: Vector3 = line["n"]
	var best_s := INF
	var stop := 4.0
	for other in lines:
		var on: Vector3 = other["n"]
		if on.dot(n) > -0.99:
			continue
		var s := float(other["d"]) - on.dot(p)
		# on ~ -n: the plane on.X = d lies at distance s behind p along -n.
		if s <= 0.3 or s >= best_s or s > 40.0:
			continue
		var tax: Vector3 = other["t"]
		var t := tax.dot(p)
		var covered := false
		for r in (other["rects"] as Array):
			if t >= float(r[1]) - 1.0 and t <= float(r[2]) + 1.0 and p.y >= float(r[3]) - 0.5 and p.y <= float(r[4]) + 0.5:
				covered = true
				break
		if covered:
			best_s = s
			stop = maxf(0.3, s - float(other["thick"]) - 0.15)
	return stop


func _scan_line(line: Dictionary, lines: Array, s: float) -> Dictionary:
	var n: Vector3 = line["n"]
	var tax: Vector3 = line["t"]
	var d := float(line["d"])
	var rects: Array = line["rects"]
	var inserts: Array = line["inserts"]
	var slab := clampf(float(line["thick"]) + 0.25, 0.35, 1.0)
	var in_scope := false
	for rec in (line["walls"] as Array):
		if bool(rec["in"]):
			in_scope = true
	var samples: Array = []  # [t, y, kind]
	if in_scope:
		# Grid over the union of the piece rects (cell centers, 1 cm inside).
		var seen: Dictionary = {}
		for r in rects:
			var i0 := int(floor((float(r[1]) + 0.01) / s))
			var i1 := int(floor((float(r[2]) - 0.01) / s))
			var j0 := int(floor((float(r[3]) + 0.01) / s))
			var j1 := int(floor((float(r[4]) - 0.01) / s))
			for i in range(i0, i1 + 1):
				var tc := (i + 0.5) * s
				if tc < float(r[1]) + 0.01 or tc > float(r[2]) - 0.01:
					continue
				for j in range(j0, j1 + 1):
					var yc := (j + 0.5) * s
					if yc < float(r[3]) + 0.01 or yc > float(r[4]) - 0.01:
						continue
					var key := Vector2i(i, j)
					if seen.has(key):
						continue
					seen[key] = true
					samples.append([tc, yc, 0])
		# Seams: AABB gaps between neighbours in the line (5 mm .. 1.5 m).
		for a in rects:
			for b in rects:
				if a == b:
					continue
				var gap := float(b[1]) - float(a[2])
				if gap <= 0.005 or gap > 1.5:
					continue
				var ylo := maxf(float(a[3]), float(b[3]))
				var yhi := minf(float(a[4]), float(b[4]))
				if yhi - ylo < 0.3:
					continue
				var tm := (float(a[2]) + float(b[1])) * 0.5
				var y := ylo + 0.05
				while y < yhi - 0.04:
					samples.append([tm, y, 1])
					y += 0.1
		# Insert borders: just outside each insert's rect, inside a host rect.
		for r in inserts:
			var t0 := float(r[1]) - 0.04
			var t1 := float(r[2]) + 0.04
			var y0 := float(r[3]) - 0.04
			var y1 := float(r[4]) + 0.04
			var y := float(r[3]) + 0.05
			while y < float(r[4]):
				for t in [t0, t1]:
					if _inside_rects(rects, t, y):
						samples.append([t, y, 2])
				y += 0.1
			var t := float(r[1]) + 0.05
			while t < float(r[2]):
				for yy in [y0, y1]:
					if _inside_rects(rects, t, yy):
						samples.append([t, yy, 2])
				t += 0.1
	var through: Array = []
	var zf: Dictionary = {}
	var blocked := 0
	var backed := 0
	var want_zf := _checks.has("z_fight")
	var want_holes := _checks.has("through_hole")
	var done := 0
	var stopped := false
	for smp in samples:
		if _over():
			stopped = true
			break
		done += 1
		var t := float(smp[0])
		var y := float(smp[1])
		var p := tax * t + n * d + Vector3(0, y, 0)
		var o := p + n * 0.6
		var e := p - n * slab
		var hit := _ray(o, e, MASK_HOLE)
		if not hit.is_empty():
			blocked += 1
			if want_zf and int(smp[2]) == 0:
				_zfight_probe(o, e, hit, MASK_HOLE, zf)
			continue
		if not want_holes:
			continue
		var far := _far_distance(line, lines, e)
		var hit2 := _ray(e, e - n * far, MASK_HOLE | L_FLOOR)
		if not hit2.is_empty():
			backed += 1
			continue
		var row := [snappedf(t, 0.001), snappedf(y, 0.001), int(smp[2]), snappedf(far, 0.01)]
		# Extent of the opening around this ray (3 cm steps, up to one cell).
		if through.size() < 400:
			row.append(snappedf(t - _extent(line, lines, tax, n, d, slab, t, y, -1.0, 0.0, s), 0.001))
			row.append(snappedf(t + _extent(line, lines, tax, n, d, slab, t, y, 1.0, 0.0, s), 0.001))
			row.append(snappedf(y - _extent(line, lines, tax, n, d, slab, t, y, 0.0, -1.0, s), 0.001))
			row.append(snappedf(y + _extent(line, lines, tax, n, d, slab, t, y, 0.0, 1.0, s), 0.001))
		else:
			row.append_array([row[0], row[0], row[1], row[1]])
		if _want_poses:
			row.append(snappedf(_clear(p + n * 0.05, n, 12.0), 0.01))
		through.append(row)
		if through.size() >= 4000:
			_warn("A facade line had more than 4000 see-through rays; the rest were not recorded.")
			break
	_count("through_hole", done if stopped else samples.size(), samples.size())
	var rect_rows: Array = []
	for r in rects:
		rect_rows.append([r[0], snappedf(r[1], 0.001), snappedf(r[2], 0.001), snappedf(r[3], 0.001), snappedf(r[4], 0.001)])
	var ins_rows: Array = []
	for r in inserts:
		ins_rows.append([r[0], snappedf(r[1], 0.001), snappedf(r[2], 0.001), snappedf(r[3], 0.001), snappedf(r[4], 0.001)])
	return {
		"n": _a3(n, 0.0001), "t": _a3(tax, 0.0001), "d": snappedf(d, 0.001), "slab": snappedf(slab, 0.01), "spacing": snappedf(s, 0.001),
		"in": in_scope, "rays": samples.size(), "blocked": blocked, "backed": backed, "through": through,
		"pieces": rect_rows, "inserts": ins_rows, "zfight": zf.values(),
	}


# A ray at (t, y) passes the facade slab AND reaches the far side.
func _passes(line: Dictionary, lines: Array, tax: Vector3, n: Vector3, d: float, slab: float, t: float, y: float) -> bool:
	var p := tax * t + n * d + Vector3(0, y, 0)
	var e := p - n * slab
	if not _ray(p + n * 0.6, e, MASK_HOLE).is_empty():
		return false
	return _ray(e, e - n * _far_distance(line, lines, e), MASK_HOLE | L_FLOOR).is_empty()


# How far the opening extends from (t, y) along (dt, dy), in 3 cm steps.
func _extent(line: Dictionary, lines: Array, tax: Vector3, n: Vector3, d: float, slab: float, t: float, y: float, dt: float, dy: float, limit: float) -> float:
	var step := 0.03
	var k := 1
	while step * k <= limit + 0.0001:
		if not _passes(line, lines, tax, n, d, slab, t + dt * step * k, y + dy * step * k):
			return step * (k - 1) + step * 0.5
		k += 1
	return limit


static func _inside_rects(rects: Array, t: float, y: float) -> bool:
	for r in rects:
		if t > float(r[1]) and t < float(r[2]) and y > float(r[3]) and y < float(r[4]):
			return true
	return false


# Second visible surface within 3 mm of the first, parallel, on a DIFFERENT
# instance: coplanar overlapping faces (z-fighting).
func _zfight_probe(o: Vector3, e: Vector3, hit: Dictionary, mask: int, acc: Dictionary) -> void:
	var a := _hit_inst(hit)
	if a < 0:
		return
	var p1: Vector3 = hit["position"]
	var n1: Vector3 = hit["normal"]
	var dir := (e - o).normalized()
	var start := p1 - dir * 0.01
	var hit2 := _ray(start, p1 + dir * 0.01, mask, [hit["rid"]])
	if hit2.is_empty():
		return
	var b := _hit_inst(hit2)
	if b < 0 or b == a:
		return
	var p2: Vector3 = hit2["position"]
	if absf(dir.dot(p2 - p1)) > 0.003 or (hit2["normal"] as Vector3).dot(n1) < 0.999:
		return
	var key := str(mini(a, b)) + ":" + str(maxi(a, b))
	if not acc.has(key):
		acc[key] = [mini(a, b), maxi(a, b), 0, _a3(p1), _a3(n1, 0.0001), _a3(p1), _a3(p1), (snappedf(_clear(p1 + n1 * 0.05, n1, 8.0), 0.01) if _want_poses else 0.0)]
	var row: Array = acc[key]
	row[2] = int(row[2]) + 1
	var lo: Array = row[5]
	var hi: Array = row[6]
	row[5] = [minf(lo[0], p1.x), minf(lo[1], p1.y), minf(lo[2], p1.z)]
	row[6] = [maxf(hi[0], p1.x), maxf(hi[1], p1.y), maxf(hi[2], p1.z)]


# ---------------------------------------------------------------------------
# floor_gap (+ floor z-fight samples): down rays over the floor tiles
# ---------------------------------------------------------------------------

func _scan_floors() -> Dictionary:
	var floors: Array = []
	var underlays: Array = []
	var area := 0.0
	for rec in _inst:
		if rec["role"] == "floor":
			floors.append(rec)
			var wa: AABB = rec["waabb"]
			area += wa.size.x * wa.size.z
		elif rec["role"] == "underlay":
			underlays.append(int(rec["i"]))
	if floors.is_empty():
		return {"floors": 0, "underlays": underlays, "gaps": [], "rays": 0}
	var cap := int(_cfg.get("max_floor_rays", 16000))
	var cell := clampf(sqrt(area / float(maxi(cap, 1000))), 0.25, 0.6)
	# Occupancy: cell -> owning floor (oriented footprint from the local AABB).
	var occ: Dictionary = {}
	var top_of: Dictionary = {}
	for rec in floors:
		var la: AABB = rec["laabb"]
		var xf: Transform3D = rec["xf"]
		var inv := xf.affine_inverse()
		var wa: AABB = rec["waabb"]
		var i0 := int(floor(wa.position.x / cell))
		var i1 := int(floor(wa.end.x / cell))
		var k0 := int(floor(wa.position.z / cell))
		var k1 := int(floor(wa.end.z / cell))
		for i in range(i0, i1 + 1):
			for k in range(k0, k1 + 1):
				var wp := Vector3((i + 0.5) * cell, wa.get_center().y, (k + 0.5) * cell)
				var lp: Vector3 = inv * wp
				if lp.x < la.position.x + 0.005 or lp.x > la.end.x - 0.005 or lp.z < la.position.z + 0.005 or lp.z > la.end.z - 0.005:
					continue
				var key := Vector2i(i, k)
				if not occ.has(key):
					occ[key] = int(rec["i"])
					top_of[key] = wa.end.y
				else:
					top_of[key] = maxf(float(top_of[key]), wa.end.y)
	var reach := int(ceil(0.5 / cell))
	var gaps: Array = []
	var zf: Dictionary = {}
	var rays := 0
	var want_gaps := _checks.has("floor_gap")
	var want_zf := _checks.has("z_fight")
	var interior := 0
	var per_owner: Dictionary = {}
	var keys_done := 0
	var stopped := false
	for key in occ:
		if _over():
			stopped = true
			break
		keys_done += 1
		var owner_i := int(occ[key])
		if not bool((_inst[owner_i] as Dictionary)["in"]):
			continue
		var c: Vector2i = key
		if not (occ.has(c + Vector2i(reach, 0)) and occ.has(c - Vector2i(reach, 0)) and occ.has(c + Vector2i(0, reach)) and occ.has(c - Vector2i(0, reach))):
			continue
		interior += 1
		var x := (c.x + 0.5) * cell
		var z := (c.y + 0.5) * cell
		var before := _floor_gap_count
		_floor_sample(x, z, float(top_of[key]), owner_i, gaps, zf, want_gaps, want_zf, 0, cell, cell)
		rays += 1
		# Per tile: cells, holes (the ray fell past the tile), of which void,
		# and cells where an underlay plane covers the tile's own low surface.
		if not per_owner.has(owner_i):
			per_owner[owner_i] = [owner_i, 0, 0, 0, 0]
		var po: Array = per_owner[owner_i]
		po[1] = int(po[1]) + 1
		if _floor_gap_count > before:
			if _floor_gap_covered:
				po[4] = int(po[4]) + 1
			else:
				po[2] = int(po[2]) + 1
				if _floor_gap_void:
					po[3] = int(po[3]) + 1
	_count("floor_gap", keys_done if stopped else occ.size(), occ.size())
	# Seams between neighbouring tiles (world AABB gaps of 2 mm .. 1 m).
	var seams := 0
	if want_gaps:
		var seam_done := 0
		for a in floors:
			if _over():
				break
			seam_done += 1
			for b in floors:
				if a == b or not (bool(a["in"]) or bool(b["in"])):
					continue
				var wa: AABB = a["waabb"]
				var wb: AABB = b["waabb"]
				for ax in [0, 2]:
					var axis: int = ax
					var other: int = 2 - axis
					var gap: float = wb.position[axis] - wa.end[axis]
					if gap <= 0.002 or gap > 1.0:
						continue
					var lo: float = maxf(wa.position[other], wb.position[other])
					var hi: float = minf(wa.end[other], wb.end[other])
					if hi - lo < 0.3:
						continue
					var mid: float = (wa.end[axis] + wb.position[axis]) * 0.5
					# Each seam ray stands for 10 cm of the seam, the seam's width across.
					var ssx: float = gap if axis == 0 else 0.1
					var ssz: float = 0.1 if axis == 0 else gap
					var u: float = lo + 0.05
					while u < hi - 0.04:
						var x: float = mid if axis == 0 else u
						var z: float = u if axis == 0 else mid
						_floor_sample(x, z, maxf(wa.end.y, wb.end.y), int(a["i"]), gaps, zf, true, false, 1, ssx, ssz)
						seams += 1
						u += 0.1
		_count("floor_gap", seam_done, floors.size())
	var strips := 0
	if want_gaps:
		strips = _scan_strips(floors, gaps, zf)
	return {"floors": floors.size(), "underlays": underlays, "cell": snappedf(cell, 0.001), "rays": rays + seams + strips, "interior_cells": interior, "seam_rays": seams, "strip_rays": strips, "gaps": gaps, "gap_rays": _floor_gap_count, "per_owner": per_owner.values(), "zfight": zf.values()}


# Bare strips OUTSIDE the tile footprints: a tile row that stops short of a
# wall (an alley's back wall 23-75 cm past the last tile) leaves the underlay
# showing at the wall base, where no grid cell or seam ray looks. Walk each
# in-scope tile's footprint edges; where a horizontal ray finds a wall within
# STRIP_REACH outside the edge, step down rays out from the edge to the wall
# base, stopping at the first floor (the next tile). An edge with no wall in
# reach is an open edge, not walkable area enclosed by walls: left alone.
func _scan_strips(floors: Array, gaps: Array, zf: Dictionary) -> int:
	var rays := 0
	var done := 0
	for rec in floors:
		if _over():
			break
		done += 1
		if not bool(rec["in"]):
			continue
		var la: AABB = rec["laabb"]
		var xf: Transform3D = rec["xf"]
		var top := (rec["waabb"] as AABB).end.y
		var owner_i := int(rec["i"])
		var x0 := la.position.x
		var x1 := la.end.x
		var z0 := la.position.z
		var z1 := la.end.z
		var ly := la.get_center().y
		# The four footprint edges in local XZ: [start, end, outward direction].
		var edges := [
			[Vector3(x0, ly, z0), Vector3(x0, ly, z1), Vector3(-1, 0, 0)],
			[Vector3(x1, ly, z0), Vector3(x1, ly, z1), Vector3(1, 0, 0)],
			[Vector3(x0, ly, z0), Vector3(x1, ly, z0), Vector3(0, 0, -1)],
			[Vector3(x0, ly, z1), Vector3(x1, ly, z1), Vector3(0, 0, 1)],
		]
		for edge in edges:
			var a: Vector3 = xf * (edge[0] as Vector3)
			var b: Vector3 = xf * (edge[1] as Vector3)
			var out: Vector3 = xf.basis * (edge[2] as Vector3)
			out.y = 0
			if out.length() < 0.2:
				continue
			out = out.normalized()
			var along := Vector3(b.x - a.x, 0, b.z - a.z)
			var edge_len := along.length()
			if edge_len < STRIP_STEP:
				continue
			along = along / edge_len
			var n := int(floor(edge_len / STRIP_STEP))
			var step := edge_len / float(n)
			for k in n:
				var p := Vector3(a.x, top, a.z) + along * (step * (float(k) + 0.5))
				var h := p + Vector3(0, 0.3, 0)
				rays += 1
				var wall := _ray(h, h + out * STRIP_REACH, MASK_FACADE, [], true)
				if wall.is_empty():
					continue
				var wp: Vector3 = wall["position"]
				var span := Vector3(wp.x - p.x, 0, wp.z - p.z).length() - 0.02
				if span < 0.03:
					continue
				var wi := _hit_inst(wall)
				var m := maxi(1, int(ceil(span / 0.1)))
				var ds := span / float(m)
				var ssx := absf(out.x) * ds + absf(along.x) * step
				var ssz := absf(out.z) * ds + absf(along.z) * step
				for j in m:
					var q := p + out * (ds * (float(j) + 0.5))
					rays += 1
					if _floor_sample(q.x, q.z, top, owner_i, gaps, zf, true, false, 2, ssx, ssz, wi, ds * step) == 0:
						break
	_count("floor_gap", done, floors.size())
	return rays


# One down ray at (x, z). Returns 0 when the floor (or a wall base over it)
# is there, 1 when a gap row was recorded.
# kind: 0 grid cell, 1 seam between tiles, 2 bare strip between a tile edge
# and a wall. sx / sz: the footprint the sample stands for (axis-aligned
# bounds); area: its area (default sx * sz). Gap row:
# [x, z, top, owner, first hit, first hit y, clearance, kind, sx, sz, area,
#  floor y under an underlay, that floor, the wall a strip runs along].
func _floor_sample(x: float, z: float, top: float, owner_i: int, gaps: Array, zf: Dictionary, want_gaps: bool, want_zf: bool, kind := 0, sx := 0.0, sz := 0.0, wall_i := -1, area := -1.0) -> int:
	var o := Vector3(x, top + 0.6, z)
	var e := Vector3(x, top - 1.5, z)
	var hit := _ray(o, e, L_FLOOR | L_UNDERLAY | MASK_FACADE)
	var hi := _hit_inst(hit)
	var role := "" if hi < 0 else String((_inst[hi] as Dictionary)["role"])
	if not hit.is_empty() and role != "underlay":
		if want_zf and role == "floor":
			_zfight_probe(o, e, hit, L_FLOOR, zf)
		return 0
	if not want_gaps:
		return 0
	# Missed the floor: under a wall or kerb (inside it) does not show.
	var cover := _ray(o, Vector3(x, top - 0.02, z), MASK_FACADE, [], true)
	if not cover.is_empty():
		return 0
	# The first surface is an underlay. A floor surface right under it means
	# the underlay plane sits ABOVE the floor's own low surface (a drain
	# channel, a dip in the slab) and paints over it: not a hole in the tile.
	var below: Variant = null
	var below_i := -1
	if not hit.is_empty():
		var hy := (hit["position"] as Vector3).y
		var under := _ray(Vector3(x, hy - 0.001, z), Vector3(x, hy - 0.5, z), L_FLOOR)
		if not under.is_empty():
			below = snappedf((under["position"] as Vector3).y, 0.001)
			below_i = _hit_inst(under)
	_floor_gap_count += 1
	_floor_gap_void = hit.is_empty()
	_floor_gap_covered = below != null
	if gaps.size() >= 6000:
		return 1
	var clear: Variant = null
	if _want_poses:
		clear = snappedf(_clear(Vector3(x, top + 0.05, z), Vector3(0.3, 1.0, 0.25).normalized(), 8.0), 0.01)
	var a := area if area >= 0.0 else sx * sz
	gaps.append([snappedf(x, 0.001), snappedf(z, 0.001), snappedf(top, 0.001), owner_i, hi, (snappedf((hit["position"] as Vector3).y, 0.001) if not hit.is_empty() else null), clear, kind, snappedf(sx, 0.001), snappedf(sz, 0.001), snappedf(a, 0.0001), below, below_i, wall_i])
	return 1


# ---------------------------------------------------------------------------
# floating / sunken: support under each prop's footprint
# ---------------------------------------------------------------------------

func _scan_support() -> Array:
	var out: Array = []
	var want_above := _checks.has("sunken")
	_floor_recs.clear()
	for f in _inst:
		if f["role"] == "floor":
			_floor_recs.append(f)
	var done := 0
	var total := 0
	for rec in _inst:
		if not bool(rec["in"]):
			continue
		var role := String(rec["role"])
		if role != "prop" and role != "dressing":
			continue
		if role == "dressing" and _re_hanging.search(String(rec["piece"]) + " " + String(rec["name"])) != null:
			continue
		total += 1
		if _over():
			continue
		done += 1
		var la: AABB = rec["laabb"]
		var wa: AABB = rec["waabb"]
		var xf: Transform3D = rec["xf"]
		var ymin := wa.position.y
		var oy := ymin + clampf(0.5 * wa.size.y, 0.1, 1.0)
		var c := la.get_center()
		var hx := la.size.x * 0.35
		var hz := la.size.z * 0.35
		var pts := [c, c + Vector3(hx, 0, hz), c + Vector3(-hx, 0, hz), c + Vector3(hx, 0, -hz), c + Vector3(-hx, 0, -hz)]
		var hits: Array = []
		var above: Array = []
		var ex: Array = rec["bodies"]
		var top := -INF
		for lp in pts:
			var w: Vector3 = xf * lp
			var hit := _ray(Vector3(w.x, oy, w.z), Vector3(w.x, ymin - 1.0, w.z), MASK_SOLID, ex)
			if hit.is_empty():
				hits.append(null)
			else:
				var hi := _hit_inst(hit)
				var hy := (hit["position"] as Vector3).y
				top = maxf(top, hy)
				hits.append([snappedf(hy, 0.0001), hi])
			# The first surface from ABOVE, down through the footprint: what the
			# prop stands in. A prop buried deeper than the support ray's start
			# (a bottle stood upright with its origin on the floor) has the
			# floor's top above that start, where the ray from oy never looks.
			if want_above:
				var ah := _ray(Vector3(w.x, wa.end.y + 0.02, w.z), Vector3(w.x, ymin - 0.5, w.z), MASK_SOLID, ex)
				if ah.is_empty():
					above.append(null)
				else:
					above.append([snappedf((ah["position"] as Vector3).y, 0.0001), _hit_inst(ah)])
		# Held by a wall? Only asked when it would otherwise float clearly.
		var touch: Variant = null
		if top == -INF or ymin - top > 0.3 or ((rec["mount"] as Vector3) != Vector3.ZERO and ymin - top > 0.02):
			var wc: Vector3 = xf * c
			for ldir in [Vector3(1, 0, 0), Vector3(-1, 0, 0), Vector3(0, 0, 1), Vector3(0, 0, -1)]:
				var wd: Vector3 = xf.basis * ldir
				wd.y = 0
				if wd.length() < 0.2:
					continue
				wd = wd.normalized()
				var ext := absf((ldir as Vector3).dot(la.size)) * 0.5
				var hit := _ray(wc, wc + wd * (ext + 0.3), MASK_FACADE, ex)
				if not hit.is_empty():
					var gap := (hit["position"] as Vector3).distance_to(wc) - ext
					if touch == null or gap < float(touch):
						touch = snappedf(gap, 0.001)
		# The floor level around it (top of the floor tiles whose footprint holds
		# its centre): a prop at that level over an underlay sits over a hole.
		var floor_top: Variant = null
		var wcen: Vector3 = wa.get_center()
		for f in _floor_recs:
			var fa: AABB = f["waabb"]
			if wcen.x >= fa.position.x and wcen.x <= fa.end.x and wcen.z >= fa.position.z and wcen.z <= fa.end.z:
				floor_top = fa.end.y if floor_top == null else maxf(float(floor_top), fa.end.y)
		out.append([int(rec["i"]), snappedf(ymin, 0.0001), snappedf(oy, 0.001), hits, touch, (snappedf(float(floor_top), 0.001) if floor_top != null else null), above])
	_count("floating_sunken", done, total)
	return out


# ---------------------------------------------------------------------------
# interpenetration: each prop's per-mesh convex hulls against props, walls,
# structure, inserts and mounts (floors excluded: that is support).
# ---------------------------------------------------------------------------

func _hull_for(mesh: Mesh) -> Shape3D:
	var key := mesh.get_instance_id()
	if _hulls.has(key):
		return _hulls[key]
	var hull: Shape3D = mesh.create_convex_shape(true, false)
	_hulls[key] = hull
	return hull


func _scan_overlaps() -> Array:
	var out: Array = []
	var seen: Dictionary = {}
	var q := PhysicsShapeQueryParameters3D.new()
	q.collide_with_areas = false
	q.margin = 0.0
	var mask := L_PROP | L_WALL | L_STRUCT | L_INSERT | L_MOUNT
	q.collision_mask = mask
	var done := 0
	var total := 0
	for rec in _inst:
		if rec["role"] != "prop" or not bool(rec["in"]):
			continue
		total += 1
		if _over():
			continue
		done += 1
		var own: Array = rec["bodies"]
		var depth_by: Dictionary = {}
		var point_by: Dictionary = {}
		for m in (rec["meshes"] as Array):
			var mesh: Mesh = m[1]
			var mxf: Transform3D = m[2]
			if not _is_rigid(mxf.basis):
				continue
			var hull := _hull_for(mesh)
			if hull == null:
				continue
			q.shape_rid = hull.get_rid()
			q.transform = mxf
			var ex: Array[RID] = []
			for r in own:
				ex.append(r)
			q.exclude = ex
			var touching := _state.intersect_shape(q, 32)
			if touching.is_empty():
				continue
			var by_inst: Dictionary = {}
			for t in touching:
				var bi := int(_body_inst.get((t["rid"] as RID).get_id(), -1))
				if bi < 0 or bi == int(rec["i"]):
					continue
				if not by_inst.has(bi):
					by_inst[bi] = []
				(by_inst[bi] as Array).append(t["rid"])
			for bi in by_inst:
				var ex2: Array[RID] = []
				for r in own:
					ex2.append(r)
				for t in touching:
					if not (by_inst[bi] as Array).has(t["rid"]):
						ex2.append(t["rid"])
				q.exclude = ex2
				var pairs := _state.collide_shape(q, 32)
				var depth := 0.0
				var at := Vector3.ZERO
				var k := 0
				while k + 1 < pairs.size():
					var dd := (pairs[k] as Vector3).distance_to(pairs[k + 1])
					if dd > depth:
						depth = dd
						at = (pairs[k] + pairs[k + 1]) * 0.5
					k += 2
				if depth > float(depth_by.get(bi, 0.0)):
					depth_by[bi] = depth
					point_by[bi] = at
		for bi in depth_by:
			var depth := float(depth_by[bi])
			if depth < 0.01:
				continue
			var a := int(rec["i"])
			var key := str(mini(a, bi)) + ":" + str(maxi(a, bi))
			if seen.has(key):
				if depth > float((out[int(seen[key])] as Array)[2]):
					(out[int(seen[key])] as Array)[2] = snappedf(depth, 0.001)
				continue
			seen[key] = out.size()
			out.append([a, int(bi), snappedf(depth, 0.001), _a3(point_by[bi])])
	_count("interpenetration", done, total)
	return out


# ---------------------------------------------------------------------------
# mount_gap + mount orientation: rays along the mount axis and around it
# ---------------------------------------------------------------------------

func _scan_mounts() -> Array:
	var out: Array = []
	var done := 0
	var total := 0
	for rec in _inst:
		if (rec["mount"] as Vector3) == Vector3.ZERO or not bool(rec["in"]):
			continue
		total += 1
		if _over():
			continue
		done += 1
		var ax: Vector3 = rec["mount"]
		var la: AABB = rec["laabb"]
		var xf: Transform3D = rec["xf"]
		var c := la.get_center()
		var half := absf(ax.dot(la.size)) * 0.5
		var back := c + ax * half
		var u := Vector3(ax.y, ax.z, ax.x)
		var v := ax.cross(u)
		var su := absf(u.dot(la.size)) * 0.45
		var sv := absf(v.dot(la.size)) * 0.45
		var wax: Vector3 = (xf.basis * ax).normalized()
		var ex: Array = rec["bodies"]
		var gaps: Array = []
		var hit_at: Array = []
		var hit_inst := -1
		# 9 samples on the mount-side face: centre, 4 corners, 4 side midpoints.
		for off in [Vector3.ZERO, u * su + v * sv, u * su - v * sv, -u * su + v * sv, -u * su - v * sv, u * su, -u * su, v * sv, -v * sv]:
			var wp: Vector3 = xf * (back + off)
			var o := wp - wax * 0.15
			var hit := _ray(o, wp + wax * 1.0, MASK_FACADE | L_MOUNT, ex)
			if hit.is_empty():
				gaps.append(null)
				hit_at.append(-1)
			else:
				gaps.append(snappedf((hit["position"] as Vector3).distance_to(o) - 0.15, 0.001))
				hit_at.append(_hit_inst(hit))
				if hit_inst < 0:
					hit_inst = _hit_inst(hit)
		# Nearest wall around the piece (horizontal +-local X, +-local Z).
		var wc: Vector3 = xf * c
		var around: Array = []
		for ldir in [Vector3(1, 0, 0), Vector3(-1, 0, 0), Vector3(0, 0, 1), Vector3(0, 0, -1)]:
			var wd: Vector3 = xf.basis * ldir
			wd.y = 0
			if wd.length() < 0.2:
				continue
			wd = wd.normalized()
			var ext := absf(ldir.dot(la.size)) * 0.5
			var hit := _ray(wc, wc + wd * (ext + 1.0), MASK_FACADE, ex)
			if hit.is_empty():
				continue
			var nrm: Vector3 = hit["normal"]
			if absf(nrm.y) > 0.35:
				continue
			around.append([_a3(wd, 0.0001), snappedf((hit["position"] as Vector3).distance_to(wc) - ext, 0.001), _hit_inst(hit)])
		# Held by another mounted piece (a ladder under its platform, an elbow
		# on its duct run): the nearest contact with a mount, any of 6 sides.
		var chain: Variant = null
		for ldir in [Vector3(1, 0, 0), Vector3(-1, 0, 0), Vector3(0, 0, 1), Vector3(0, 0, -1), Vector3(0, 1, 0), Vector3(0, -1, 0)]:
			var wd: Vector3 = (xf.basis * ldir).normalized()
			var ext := absf((ldir as Vector3).dot(la.size)) * 0.5
			var hit := _ray(wc, wc + wd * (ext + 0.15), L_MOUNT, ex)
			if not hit.is_empty():
				var gap := (hit["position"] as Vector3).distance_to(wc) - ext
				if chain == null or gap < float(chain):
					chain = snappedf(gap, 0.001)
		# Standing on something (a fence post on the ground) rather than hanging.
		var wa: AABB = rec["waabb"]
		var foot := Vector3(wa.get_center().x, wa.position.y + 0.05, wa.get_center().z)
		var down := _ray(foot, foot + Vector3.DOWN * 1.0, MASK_SOLID & ~L_MOUNT, ex)
		var ground: Variant = null
		if not down.is_empty():
			ground = snappedf(wa.position.y - (down["position"] as Vector3).y, 0.001)
		# How far off the wall the pack lets it stand, and its front-back
		# symmetry (planes, or pieces.json "symmetric").
		var so := _standoff_of(rec)
		var sym_meta: Variant = null
		var sym_raw: Variant = (rec["man"] as Dictionary).get("symmetric", null)
		if typeof(sym_raw) == TYPE_BOOL:
			sym_meta = sym_raw
		out.append([int(rec["i"]), _a3(wax, 0.0001), gaps, hit_inst, around, String((rec["man"] as Dictionary).get("category", "")), String(rec.get("mount_src", "")), _a3(ax, 1.0), chain, ground, so[0], so[1], _mount_planes(rec, ax), sym_meta, hit_at])
	_count("mount_gap", done, total)
	return out


# Front-back symmetry about a mount axis: the largest plane facing +axis and
# the largest facing -axis (instance-local position along the axis, area),
# and the piece's bounds along it: [pos+, area+, pos-, area-, lo, hi], or
# null without plane data. A duct run or a strap brace looks the same turned
# 180 degrees; the judge decides.
func _mount_planes(rec: Dictionary, ax: Vector3) -> Variant:
	var ai := 0 if absf(ax.x) > 0.5 else (1 if absf(ax.y) > 0.5 else 2)
	var e := Vector3.ZERO
	e[ai] = 1.0
	var inv := (rec["xf"] as Transform3D).affine_inverse()
	var best := [0.0, 0.0, 0.0, 0.0]
	var found := false
	for m in (rec["meshes"] as Array):
		var info: Dictionary = _mesh_info.get((m[1] as Mesh).get_instance_id(), {})
		var rows: PackedFloat32Array = info.get("planes", PackedFloat32Array())
		if rows.size() < 12:
			continue
		var rel: Transform3D = inv * (m[2] as Transform3D)
		for j in 3:
			var ej := Vector3.ZERO
			ej[j] = 1.0
			var d: Vector3 = rel.basis * ej
			var along := d.dot(e)
			if absf(along) < 0.99 * d.length():
				continue
			for s in 2:
				var slot := (j * 2 + s) * 2
				var area := rows[slot + 1]
				if area <= 0.0:
					continue
				var pos := rel.origin[ai] + along * rows[slot]
				# Mesh side s (0 = +e_j) faces +axis when e_j maps onto +axis.
				var k := 0 if ((s == 0) == (along > 0.0)) else 2
				if area > float(best[k + 1]):
					best[k] = pos
					best[k + 1] = area
					found = true
	if not found:
		return null
	var la: AABB = rec["laabb"]
	return [snappedf(float(best[0]), 0.001), snappedf(float(best[1]), 0.0001), snappedf(float(best[2]), 0.001), snappedf(float(best[3]), 0.0001), snappedf(la.position[ai], 0.001), snappedf(la.end[ai], 0.001)]


# ---------------------------------------------------------------------------
# orientation of long props near a wall
# ---------------------------------------------------------------------------

func _scan_long_props() -> Array:
	var out: Array = []
	var done := 0
	var total := 0
	for rec in _inst:
		if rec["role"] != "prop" or not bool(rec["in"]):
			continue
		total += 1
		if _over():
			continue
		done += 1
		var la: AABB = rec["laabb"]
		var xf: Transform3D = rec["xf"]
		var sx := la.size.x
		var sz := la.size.z
		var length := maxf(sx, sz)
		var depth := minf(sx, sz)
		if length < 0.6 or length < 1.8 * maxf(depth, 0.001) or (rec["mount"] as Vector3) != Vector3.ZERO:
			continue
		var lax := Vector3(1, 0, 0) if sx >= sz else Vector3(0, 0, 1)
		var wl: Vector3 = xf.basis * lax
		wl.y = 0
		if wl.length() < 0.2:
			continue
		wl = wl.normalized()
		var wx: Vector3 = (xf.basis * Vector3(1, 0, 0))
		var wz: Vector3 = (xf.basis * Vector3(0, 0, 1))
		wx.y = 0
		wz.y = 0
		var c := la.get_center()
		var wc: Vector3 = xf * c
		var wa: AABB = rec["waabb"]
		wc.y = wa.position.y + minf(0.5, wa.size.y * 0.5)
		var ex: Array = rec["bodies"]
		var best: Array = []
		for k in 8:
			var ang := TAU * float(k) / 8.0
			var dir := Vector3(sin(ang), 0, cos(ang))
			var ext := absf(dir.dot(wx.normalized())) * sx * 0.5 + absf(dir.dot(wz.normalized())) * sz * 0.5
			var hit := _ray(wc, wc + dir * (ext + 1.4), MASK_FACADE, ex)
			if hit.is_empty():
				continue
			var nrm: Vector3 = hit["normal"]
			if absf(nrm.y) > 0.35:
				continue
			var clearance := (hit["position"] as Vector3).distance_to(wc) - ext
			if best.is_empty() or clearance < float(best[0]):
				var hn := Vector3(nrm.x, 0, nrm.z).normalized()
				best = [snappedf(clearance, 0.001), _hit_inst(hit), _a3(hn, 0.0001), _a3(dir, 0.0001)]
		if best.is_empty():
			continue
		out.append([int(rec["i"]), _a3(wl, 0.0001), snappedf(length, 0.001), snappedf(depth, 0.001), best])
	_count("orientation", done, total)
	return out


# ---------------------------------------------------------------------------
# uv_stretch: candidate triangles per mesh, visibility per instance
# ---------------------------------------------------------------------------

func _scan_uv() -> Array:
	var users: Dictionary = {}
	for rec in _inst:
		if not bool(rec["in"]):
			continue
		var role := String(rec["role"])
		if role == "dressing" or role == "underlay":
			continue
		for m in (rec["meshes"] as Array):
			var key := (m[1] as Mesh).get_instance_id()
			var info: Dictionary = _mesh_info.get(key, {})
			if (info.get("uv", []) as Array).is_empty():
				continue
			if not users.has(key):
				users[key] = []
			if (users[key] as Array).size() < 64:
				(users[key] as Array).append([rec, m[2]])
	var out: Array = []
	var done := 0
	for key in users:
		if _over():
			break
		done += 1
		var info: Dictionary = _mesh_info[key]
		var cands: Array = info["uv"]
		var tris: Array = []
		for cnd in cands:
			var t0: Vector2 = cnd[5]
			var t1: Vector2 = cnd[6]
			var t2: Vector2 = cnd[7]
			tris.append([_a3(cnd[2], 0.0001), _a3(cnd[3], 0.0001), _a3(cnd[4], 0.0001), [snappedf(t0.x, 0.00001), snappedf(t0.y, 0.00001)], [snappedf(t1.x, 0.00001), snappedf(t1.y, 0.00001)], [snappedf(t2.x, 0.00001), snappedf(t2.y, 0.00001)]])
		var shown: Array = []
		for pair in (users[key] as Array):
			var rec: Dictionary = pair[0]
			var mxf: Transform3D = pair[1]
			var front: Vector3 = rec.get("front", Vector3.ZERO)
			var wfront := Vector3.ZERO
			if front != Vector3.ZERO:
				wfront = ((rec["xf"] as Transform3D).basis * front).normalized()
			# Per candidate triangle: visible (the view ray lands on it), or
			# covered (an insert or a mounted piece sits within 0.3 m in front of
			# it: a door, a shutter). Covered somewhere + visible here = exposed here.
			var mask_bits := 0
			var covered_bits := 0
			var viewer_out: Variant = null
			var center_out: Variant = null
			for ti in cands.size():
				var cnd: Array = cands[ti]
				var cw: Vector3 = mxf * ((cnd[2] + cnd[3] + cnd[4]) / 3.0)
				var nw: Vector3 = (mxf.basis * (cnd[8] as Vector3)).normalized()
				var viewer := cw + nw * 1.2 + wfront * 0.8
				var dir := (cw - viewer).normalized()
				var hit := _ray(viewer, cw + dir * 0.02, MASK_SOLID)
				if hit.is_empty():
					continue
				var hp: Vector3 = hit["position"]
				var hi := _hit_inst(hit)
				if hi == int(rec["i"]):
					if hp.distance_to(cw) <= 0.05:
						mask_bits |= 1 << ti
						if viewer_out == null:
							viewer_out = _a3(viewer)
							center_out = _a3(cw)
				elif hi >= 0 and hp.distance_to(cw) <= 0.3 and (String((_inst[hi] as Dictionary)["role"]) == "insert" or String((_inst[hi] as Dictionary)["role"]) == "mount"):
					covered_bits |= 1 << ti
			if mask_bits != 0 or covered_bits != 0:
				shown.append([int(rec["i"]), mask_bits, viewer_out, center_out, covered_bits])
		out.append({"mesh": String(info["name"]), "tris": tris, "users": (users[key] as Array).size(), "shown": shown})
	_count("uv_stretch", done, users.size())
	return out


# ---------------------------------------------------------------------------
# insert_host: what sits around each insert
# ---------------------------------------------------------------------------

func _scan_inserts() -> Array:
	var out: Array = []
	var done := 0
	var total := 0
	for rec in _inst:
		if rec["role"] != "insert" or not bool(rec["in"]):
			continue
		total += 1
		if _over():
			continue
		done += 1
		var fit: Dictionary = (rec["man"] as Dictionary)["fits_into"]
		var xf: Transform3D = rec["xf"]
		var near: Array = []
		for other in _inst:
			if other == rec:
				continue
			var oxf: Transform3D = other["xf"]
			if oxf.origin.distance_to(xf.origin) > 1.5:
				continue
			near.append([int(other["i"]), String(other["piece"]), _a3(oxf.origin, 0.0001), _b9(oxf.basis)])
			if near.size() >= 12:
				break
		var center: Vector3 = (rec["waabb"] as AABB).get_center()
		var containing: Array = []
		for other in _inst:
			if other == rec or other["role"] != "wall":
				continue
			if (other["waabb"] as AABB).grow(0.05).has_point(center):
				containing.append(int(other["i"]))
				if containing.size() >= 4:
					break
		var off: Variant = fit.get("local_offset_m", [0, 0, 0])
		out.append([int(rec["i"]), String(fit.get("piece", "")), off, _a3(xf.origin, 0.0001), _b9(xf.basis), near, containing])
	_count("insert_host", done, total)
	return out


# ---------------------------------------------------------------------------
# lights: per-mesh omni/spot pairing (light culling AABB vs mesh AABB),
# soft-rim spots, shadowed lights
# ---------------------------------------------------------------------------

func _light_aabb(light: Light3D) -> AABB:
	var xf := light.global_transform
	var local := AABB()
	if light is OmniLight3D:
		var r := (light as OmniLight3D).omni_range
		local = AABB(-Vector3(r, r, r), Vector3(r, r, r) * 2.0)
	elif light is SpotLight3D:
		var sp := light as SpotLight3D
		var size := tan(deg_to_rad(minf(sp.spot_angle, 89.0))) * sp.spot_range
		local = AABB(Vector3(-size, -size, -sp.spot_range), Vector3(size * 2.0, size * 2.0, sp.spot_range))
	var out := AABB()
	var first := true
	for c in _corners(local):
		var w: Vector3 = xf * c
		if first:
			out = AABB(w, Vector3.ZERO)
			first = false
		else:
			out = out.expand(w)
	return out


func _scan_lights() -> Dictionary:
	var limit := int(ProjectSettings.get_setting("rendering/limits/opengl/max_lights_per_object", 8))
	var omni: Array = []
	var spot: Array = []
	var counts := {"omni": 0, "spot": 0, "directional": 0}
	var shadowed := {"omni": 0, "spot": 0, "directional": 0}
	var hard_rim: Array = []
	for light in _lights:
		var l := light as Light3D
		if not l.is_visible_in_tree():
			continue
		var kind := "directional"
		if l is OmniLight3D:
			kind = "omni"
			omni.append([l, _light_aabb(l)])
		elif l is SpotLight3D:
			kind = "spot"
			spot.append([l, _light_aabb(l)])
			var att := (l as SpotLight3D).spot_angle_attenuation
			if att < 3.0 and _in_root(l):
				hard_rim.append([_rel(l), snappedf(att, 0.001), _a3(l.global_position)])
		counts[kind] = int(counts[kind]) + 1
		if l.shadow_enabled:
			shadowed[kind] = int(shadowed[kind]) + 1
	var over: Array = []
	var done := 0
	var total := 0
	for rec in _inst:
		if not bool(rec["in"]):
			continue
		total += 1
		if _over():
			continue
		done += 1
		var worst: Array = []
		for m in (rec["meshes"] as Array):
			var node: Node = m[0]
			var layers := 1
			if node is VisualInstance3D:
				layers = (node as VisualInstance3D).layers
			var box: AABB = (m[2] as Transform3D) * (m[1] as Mesh).get_aabb()
			var no := 0
			var ns := 0
			var names: Array = []
			for pair in omni:
				if (pair[0] as Light3D).light_cull_mask & layers and (pair[1] as AABB).intersects(box):
					no += 1
					if names.size() < 3:
						names.append(String((pair[0] as Node).name))
			for pair in spot:
				if (pair[0] as Light3D).light_cull_mask & layers and (pair[1] as AABB).intersects(box):
					ns += 1
					if names.size() < 3:
						names.append(String((pair[0] as Node).name))
			if (no > limit or ns > limit) and (worst.is_empty() or maxi(no, ns) > maxi(int(worst[2]), int(worst[3]))):
				worst = [int(rec["i"]), _rel(node), no, ns, names]
		if not worst.is_empty():
			over.append(worst)
	_count("lights", done, total)
	var renderer := RenderingServer.get_current_rendering_method()
	return {"renderer": renderer, "limit": limit, "counts": counts, "shadowed": shadowed, "over": over, "hard_rim": hard_rim}


# ---------------------------------------------------------------------------
# resource: missing dependency files, empty meshes, surfaces without material
# ---------------------------------------------------------------------------

func _scan_resources() -> Dictionary:
	var missing: Array = []
	var checked: Dictionary = {}
	var scenes: Dictionary = {}
	var root_scene := String(_cfg.get("scene_path", ""))
	if root_scene != "":
		scenes[root_scene] = -1
	for rec in _inst:
		var sc := String(rec["scene"])
		if sc != "" and not scenes.has(sc):
			scenes[sc] = int(rec["i"])
	var budget := 3000
	var queue: Array = []
	for sc in scenes:
		queue.append([sc, sc, int(scenes[sc]), 0])
	while not queue.is_empty() and budget > 0:
		if _over():
			break
		var item: Array = queue.pop_front()
		var path := String(item[0])
		if checked.has(path):
			continue
		checked[path] = true
		budget -= 1
		if not path.begins_with("res://"):
			continue
		for dep in ResourceLoader.get_dependencies(path):
			var dp := String(dep)
			if dp.get_slice_count("::") >= 3:
				dp = dp.get_slice("::", 2)
			if dp == "" or not dp.begins_with("res://"):
				continue
			if not ResourceLoader.exists(dp):
				if missing.size() < 32:
					missing.append([dp, String(item[1]), int(item[2])])
				continue
			var ext := dp.get_extension().to_lower()
			if int(item[3]) < 2 and (ext == "tres" or ext == "res" or ext == "material" or ext == "tscn"):
				queue.append([dp, String(item[1]), int(item[2]), int(item[3]) + 1])
	_count("resource", checked.size(), checked.size() + (queue.size() if budget > 0 else 0))
	var no_mat: Array = []
	for rec in _inst:
		if not bool(rec["in"]):
			continue
		var count := 0
		for m in (rec["meshes"] as Array):
			var node: Node = m[0]
			var mesh: Mesh = m[1]
			if not (node is MeshInstance3D):
				continue
			var mi := node as MeshInstance3D
			if mi.material_override != null:
				continue
			for s in mesh.get_surface_count():
				if mesh.surface_get_material(s) == null and mi.get_surface_override_material(s) == null:
					count += 1
				else:
					var mat := mi.get_surface_override_material(s)
					if mat == null:
						mat = mesh.surface_get_material(s)
					if mat is ShaderMaterial and (mat as ShaderMaterial).shader == null and _shader_no_code.size() < 16:
						_shader_no_code.append([int(rec["i"]), _rel(mi), s])
		if count > 0 and no_mat.size() < 64:
			no_mat.append([int(rec["i"]), count])
	var empty: Array = []
	for e in _empty_meshes:
		empty.append(e)
	return {"missing": missing, "checked": checked.size(), "empty": empty, "no_material": no_mat, "shader_missing": _shader_no_code}


# ---------------------------------------------------------------------------
# Clearance around each instance for framing (render: "sheet"): 8 directions
# at 20 deg and 45 deg up, two-sided (any surface counts, front or back).
# ---------------------------------------------------------------------------

func _scan_clearances() -> void:
	var done := 0
	var total := 0
	for rec in _inst:
		if not bool(rec["in"]):
			continue
		total += 1
		if _over():
			continue
		done += 1
		var wa: AABB = rec["waabb"]
		var c := wa.get_center()
		var ex: Array = rec["bodies"]
		var rows: Array = []
		for elev in [20.0, 45.0]:
			var ce := cos(deg_to_rad(elev))
			var se := sin(deg_to_rad(elev))
			for k in 8:
				var ang := TAU * float(k) / 8.0
				var dir := Vector3(sin(ang) * ce, se, cos(ang) * ce)
				rows.append(snappedf(_clear(c, dir, 10.0, ex), 0.01))
		rec["clear"] = rows
	_count("poses", done, total)


# ---------------------------------------------------------------------------
# Instance rows (compact): what the TypeScript side needs for every check.
# ---------------------------------------------------------------------------

func _instance_rows() -> Array:
	var rows: Array = []
	for rec in _inst:
		var xf: Transform3D = rec["xf"]
		var b := xf.basis
		var wa: AABB = rec["waabb"]
		var la: AABB = rec["laabb"]
		var bad := not (is_finite(xf.origin.x) and is_finite(xf.origin.y) and is_finite(xf.origin.z) and is_finite(b.x.x) and is_finite(b.y.y) and is_finite(b.z.z) and is_finite(b.x.y) and is_finite(b.x.z) and is_finite(b.y.x) and is_finite(b.y.z) and is_finite(b.z.x) and is_finite(b.z.y))
		var row := {
			"p": rec["path"], "k": rec["piece"], "s": rec["scene"], "r": rec["role"], "in": rec["in"],
			"o": _a3(xf.origin, 0.0001), "b": _b9(b), "sc": [snappedf(b.x.length(), 0.0001), snappedf(b.y.length(), 0.0001), snappedf(b.z.length(), 0.0001)],
			"det": snappedf(b.determinant(), 0.0001), "c": _a3(wa.get_center()), "e": _a3(wa.size), "le": _a3(la.size), "lc": _a3(la.get_center()),
			"m": (rec["meshes"] as Array).size(), "f": _a3(rec.get("front", Vector3.ZERO), 1.0),
		}
		if bad:
			row["nan"] = true
		var node: Node = rec["node"]
		if node is Node3D:
			row["lo"] = _a3((node as Node3D).position, 0.0001)
		if rec.has("clear"):
			row["cl"] = rec["clear"]
		if (rec["mount"] as Vector3) != Vector3.ZERO:
			row["mh"] = _a3(rec["mount"], 1.0)
			row["ms"] = String(rec.get("mount_src", ""))
		var man: Dictionary = rec["man"]
		if man.has("category"):
			row["cat"] = String(man["category"])
		rows.append(row)
	return rows
