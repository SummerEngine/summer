/**
 * The measurement probe behind the placement tools. ONE GDScript, sent through
 * the existing RunSceneScript op (summer_run_script's op: in-process, on the
 * live editor's main thread, no child editor is spawned), with a JSON argument
 * block selecting the command. It only READS: it never adds, moves, or frees a
 * node of an open scene. Mutations are sent afterwards as ordinary SetProp /
 * SnapToSurface / InstantiateScene ops so they get the scene-target, undo and
 * save contract every other scene tool has.
 *
 * Commands:
 *   inspect_asset  load a .tscn/.glb/.gltf/Mesh, instantiate it OFF the scene
 *                  tree, measure (AABB, meshes, planar faces, open boundary
 *                  loops, Marker3D anchors, collision shapes), free it.
 *   bounds         visible-geometry extents of nodes along three directions
 *                  (world axes or a node's local axes), plus transforms.
 *   raycast        physics ray (active scene only) and a visual-AABB ray.
 *   ports          resolve Marker3D ports or open-loop port indices, and
 *                  optionally the subject's other ports.
 *   blockers       what a node overlaps where it stands and what it would
 *                  touch first moving along a direction.
 *   multi          run several of the scene commands above in one call.
 *
 * "Scene space" = the scene root's frame, accumulated by hand from
 * Node3D.transform (the same walk GetWorldSnapshot uses), so it works for an
 * open scene tab that is not the active one. Physics needs the active tab:
 * only that scene's bodies are in the editor's physics space.
 */

export const PLACEMENT_SCRIPT_BUDGET_SECONDS = 20;

/** Placeholder for the argument literal; appears exactly once in the source. */
export const PLACEMENT_ARGS_TOKEN = "__SUMMER_PLACEMENT_ARGS__";
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Encode the arguments as base64 of their UTF-8 JSON. No caller text is ever
 * interpolated into the GDScript: node paths and port names can come from
 * scene content, so they are data the script decodes (Marshalls.base64_to_utf8
 * + JSON.parse_string), never source it compiles. The base64 alphabet cannot
 * close the string literal or start a statement.
 */
export function encodeScriptArgs(args: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(args), "utf8").toString("base64");
  if (!BASE64.test(encoded)) throw new Error("placement probe arguments did not encode to base64");
  return encoded;
}

export function buildPlacementScript(args: Record<string, unknown>): string {
  // split/join, not String.replace: a replacement string would interpret $&,
  // $`, $' and $1 patterns. The literal here is base64 only, but the splice
  // stays literal regardless of what it carries.
  return PLACEMENT_PROBE_SOURCE.split(PLACEMENT_ARGS_TOKEN).join(`"${encodeScriptArgs(args)}"`);
}

/** The probe source with its placeholder, for tests. */
export function placementProbeTemplate(): string {
  return PLACEMENT_PROBE_SOURCE;
}

// Tabs are significant: GDScript indentation. String.raw keeps every backslash
// literal; the source never contains a template placeholder.
const PLACEMENT_PROBE_SOURCE = String.raw`@tool
extends RefCounted

const ARGS_B64 = __SUMMER_PLACEMENT_ARGS__
const MAX_GEOMS = 20000


func run(_ctx):
	var args = JSON.parse_string(Marshalls.base64_to_utf8(ARGS_B64))
	if typeof(args) != TYPE_DICTIONARY:
		return _fail("bad_args", "placement probe arguments did not parse")
	var cmd = String(args.get("cmd", ""))
	if cmd == "inspect_asset":
		return _cmd_inspect_asset(args)
	var scene = _open_scene(String(args.get("scene_path", "")))
	if scene.has("fail"):
		return scene["fail"]
	if cmd == "multi":
		var steps = []
		for step in args.get("steps", []):
			var r = _dispatch(scene["root"], scene["active"], step)
			steps.append(r)
			if not r.get("ok", false):
				return r
		return {"ok": true, "steps": steps}
	return _dispatch(scene["root"], scene["active"], args)


func _dispatch(root, active, args):
	var cmd = String(args.get("cmd", ""))
	if cmd == "bounds":
		return _cmd_bounds(root, active, args)
	if cmd == "raycast":
		return _cmd_raycast(root, active, args)
	if cmd == "ports":
		return _cmd_ports(root, args)
	if cmd == "blockers":
		return _cmd_blockers(root, active, args)
	return _fail("bad_args", "unknown placement probe command: " + cmd)


# ---------------------------------------------------------------- helpers

func _fail(reason, message):
	return {"ok": false, "failure_reason": reason, "error": message}


func _r(x):
	return snappedf(float(x), 0.001)


func _v3(v):
	return [snappedf(v.x, 0.001), snappedf(v.y, 0.001), snappedf(v.z, 0.001)]


func _d3(v):
	return [snappedf(v.x, 0.0001), snappedf(v.y, 0.0001), snappedf(v.z, 0.0001)]


func _raw3(v):
	return [v.x, v.y, v.z]


func _xf12(t):
	return [t.basis.x.x, t.basis.x.y, t.basis.x.z, t.basis.y.x, t.basis.y.y, t.basis.y.z, t.basis.z.x, t.basis.z.y, t.basis.z.z, t.origin.x, t.origin.y, t.origin.z]


func _vec(a):
	return Vector3(float(a[0]), float(a[1]), float(a[2]))


func _open_scene(scene_path):
	var wanted = scene_path.simplify_path()
	var edited = EditorInterface.get_edited_scene_root()
	for r in EditorInterface.get_open_scene_roots():
		if r != null and String(r.scene_file_path).simplify_path() == wanted:
			return {"root": r, "active": r == edited and r.is_inside_tree()}
	return {"fail": _fail("scene_not_open", "Scene " + wanted + " is not open in the editor. Open it with summer_open_scene, or run any scene mutation with this scenePath (that opens it), then retry.")}


func _node(root, path):
	var p = String(path).strip_edges()
	if p == "" or p == "." or p == "./":
		return root
	if p.begins_with("./"):
		p = p.substr(2)
	var n = root.get_node_or_null(NodePath(p))
	if n == null and p.begins_with(String(root.name) + "/"):
		n = root.get_node_or_null(NodePath(p.substr(String(root.name).length() + 1)))
	return n


func _rel(root, n):
	if n == root:
		return "."
	return String(root.get_path_to(n))


# Scene-space transform: Node3D.transform accumulated up to and including root.
func _xf(node, root):
	var t = Transform3D.IDENTITY
	var cur = node
	while cur != null:
		if cur is Node3D:
			t = cur.transform * t
			if cur.top_level and cur != root:
				break
		if cur == root:
			break
		cur = cur.get_parent()
	return t


func _visible(node, root):
	var cur = node
	while cur != null:
		if cur is Node3D and not cur.visible:
			return false
		if cur == root:
			break
		cur = cur.get_parent()
	return true


# Visible GeometryInstance3D descendants of start (inclusive) with their
# scene-space transform and local AABB: the bounds definition AlignDistribute3D
# uses. exclude holds subtree roots to skip.
func _geoms(start, root, exclude):
	var base_xf = Transform3D.IDENTITY
	var base_vis = true
	if start != root and start.get_parent() != null:
		base_xf = _xf(start.get_parent(), root)
		base_vis = _visible(start.get_parent(), root)
	var out = []
	var stack = [[start, base_xf, base_vis]]
	var visited = 0
	while stack.size() > 0:
		visited += 1
		if visited > MAX_GEOMS:
			break
		var item = stack.pop_back()
		var n = item[0]
		if exclude.has(n):
			continue
		var t = item[1]
		var vis = item[2]
		if n is Node3D:
			if n.top_level and n != root:
				t = n.transform
			else:
				t = t * n.transform
			vis = vis and n.visible
		if vis and n is GeometryInstance3D:
			var bb = n.get_aabb()
			if bb.size != Vector3.ZERO:
				out.append([n, t, bb])
		for c in n.get_children():
			stack.append([c, t, vis])
	return out


func _corners(bb, t):
	var out = []
	var p = bb.position
	var s = bb.size
	for i in range(8):
		var c = Vector3(p.x + (s.x if (i & 1) != 0 else 0.0), p.y + (s.y if (i & 2) != 0 else 0.0), p.z + (s.z if (i & 4) != 0 else 0.0))
		out.append(t * c)
	return out


# [min, max] of the geometry corners projected on each direction.
func _intervals(geoms, dirs):
	var lo = []
	var hi = []
	for d in dirs:
		lo.append(INF)
		hi.append(-INF)
	for g in geoms:
		for c in _corners(g[2], g[1]):
			for k in range(dirs.size()):
				var v = c.dot(dirs[k])
				if v < lo[k]:
					lo[k] = v
				if v > hi[k]:
					hi[k] = v
	var out = []
	for k in range(dirs.size()):
		out.append([lo[k], hi[k]])
	return out


func _dirs(root, args):
	var space_node = String(args.get("space_node", ""))
	if space_node == "":
		return {"dirs": [Vector3.RIGHT, Vector3.UP, Vector3.BACK], "space": "world"}
	var n = _node(root, space_node)
	if n == null:
		return {"fail": _fail("node_not_found", "space node not found: " + space_node)}
	if not (n is Node3D):
		return {"fail": _fail("not_node3d", "space node is not a Node3D: " + space_node)}
	var b = _xf(n, root).basis.orthonormalized()
	return {"dirs": [b.x.normalized(), b.y.normalized(), b.z.normalized()], "space": "local"}


# ---------------------------------------------------------------- bounds

func _cmd_bounds(root, active, args):
	var d = _dirs(root, args)
	if d.has("fail"):
		return d["fail"]
	var dirs = d["dirs"]
	var nodes = []
	var excluded_subjects = []
	for spec in args.get("nodes", []):
		var path = String(spec.get("path", ""))
		var n = _node(root, path)
		if n == null:
			return _fail("node_not_found", "node not found in scene: " + path)
		if not (n is Node3D):
			return _fail("not_node3d", "node is not a Node3D: " + path)
		var exclude = []
		for ex in spec.get("exclude", []):
			var en = _node(root, String(ex))
			if en != null and n.is_ancestor_of(en):
				exclude.append(en)
				excluded_subjects.append(String(ex))
		var geoms = _geoms(n, root, exclude)
		var rec = {"path": path, "resolved": _rel(root, n), "geometry_count": geoms.size(), "xform": _xf12(_xf(n, root))}
		if n != root and n.get_parent() != null:
			rec["parent_xform"] = _xf12(_xf(n.get_parent(), root))
		else:
			rec["parent_xform"] = _xf12(Transform3D.IDENTITY)
		rec["position"] = _raw3(n.position)
		rec["transform_str"] = var_to_str(n.transform)
		if geoms.size() > 0:
			rec["intervals"] = _intervals(geoms, dirs)
			var reach = 0.0
			var o = _xf(n, root).origin
			for g in geoms:
				for c in _corners(g[2], g[1]):
					reach = maxf(reach, (c - o).length())
			rec["reach"] = reach
		nodes.append(rec)
	var dir_out = []
	for v in dirs:
		dir_out.append(_raw3(v))
	return {"ok": true, "space": d["space"], "dirs": dir_out, "nodes": nodes, "scene_active": active, "excluded": excluded_subjects}


# ---------------------------------------------------------------- raycast

func _phys_ray(root, active, origin, dir, dist, mask, areas, exclude_nodes, accept_under):
	if not active:
		return {"available": false, "reason": "scene_not_active"}
	var vp = root.get_viewport()
	var world = vp.find_world_3d() if vp != null else null
	if world == null:
		return {"available": false, "reason": "no_world_3d"}
	var space = world.direct_space_state
	if space == null:
		return {"available": false, "reason": "no_space_state"}
	var ex: Array[RID] = []
	for en in exclude_nodes:
		var stack = [en]
		while stack.size() > 0:
			var n = stack.pop_back()
			if n is CollisionObject3D:
				ex.append(n.get_rid())
			for c in n.get_children():
				stack.append(c)
	var skipped = 0
	for _attempt in range(9):
		var q = PhysicsRayQueryParameters3D.create(origin, origin + dir * dist, mask, ex)
		q.collide_with_areas = areas
		q.collide_with_bodies = true
		var hit = space.intersect_ray(q)
		if hit.is_empty():
			return {"available": true, "hit": false, "skipped": skipped}
		var col = hit.get("collider")
		if accept_under != null and col is Node and not (col == accept_under or accept_under.is_ancestor_of(col)):
			ex.append(hit.get("rid"))
			skipped += 1
			continue
		var path = ""
		if col is Node:
			path = _rel(root, col) if (col == root or root.is_ancestor_of(col)) else String(col.get_path())
		return {"available": true, "hit": true, "path": path, "point": hit.get("position"), "normal": hit.get("normal"), "skipped": skipped}
	return {"available": true, "hit": false, "skipped": skipped, "gave_up": true}


func _vis_ray(geoms, origin, dir, dist, accept_under):
	var best_t = INF
	var best = null
	var best_axis = -1
	var inside = 0
	for g in geoms:
		if accept_under != null and not (g[0] == accept_under or accept_under.is_ancestor_of(g[0])):
			continue
		var cs = _corners(g[2], g[1])
		var mn = cs[0]
		var mx = cs[0]
		for c in cs:
			mn = Vector3(minf(mn.x, c.x), minf(mn.y, c.y), minf(mn.z, c.z))
			mx = Vector3(maxf(mx.x, c.x), maxf(mx.y, c.y), maxf(mx.z, c.z))
		var tmin = -INF
		var tmax = INF
		var axis = -1
		var miss = false
		for k in range(3):
			var o = origin[k]
			var dk = dir[k]
			if absf(dk) < 0.000000001:
				if o < mn[k] or o > mx[k]:
					miss = true
					break
			else:
				var t1 = (mn[k] - o) / dk
				var t2 = (mx[k] - o) / dk
				if t1 > t2:
					var tmp = t1
					t1 = t2
					t2 = tmp
				if t1 > tmin:
					tmin = t1
					axis = k
				if t2 < tmax:
					tmax = t2
		if miss or axis < 0 or tmin > tmax or tmax < 0.0:
			continue
		if tmin < 0.0:
			inside += 1
			continue
		if tmin <= dist and tmin < best_t:
			best_t = tmin
			best = g[0]
			best_axis = axis
	if best == null:
		return {"hit": false, "inside": inside}
	var nrm = Vector3.ZERO
	nrm[best_axis] = -signf(dir[best_axis])
	return {"hit": true, "node": best, "t": best_t, "point": origin + dir * best_t, "normal": nrm, "inside": inside}


func _cmd_raycast(root, active, args):
	var origin = _vec(args.get("origin", [0, 0, 0]))
	var dir = _vec(args.get("direction", [0, -1, 0]))
	if dir.length() < 0.000001:
		return _fail("bad_args", "direction must be non-zero")
	dir = dir.normalized()
	var dist = float(args.get("max_distance", 100.0))
	var mask = int(args.get("collision_mask", 4294967295))
	var areas = bool(args.get("collide_with_areas", false))
	var mode = String(args.get("evidence", "auto"))
	var exclude_nodes = []
	for p in args.get("exclude", []):
		var en = _node(root, String(p))
		if en == null:
			return _fail("node_not_found", "exclude node not found: " + String(p))
		exclude_nodes.append(en)
	var accept_under = null
	var surface = String(args.get("surface", ""))
	if surface != "":
		accept_under = _node(root, surface)
		if accept_under == null:
			return _fail("node_not_found", "surface node not found: " + surface)
	# A ray from a subject toward a surface node: start at the subject origin,
	# aim at the nearest point of the surface's visible bounds.
	var from_subject = String(args.get("from_subject", ""))
	if from_subject != "":
		var sn = _node(root, from_subject)
		if sn == null:
			return _fail("node_not_found", "subject not found: " + from_subject)
		if accept_under == null:
			return _fail("bad_args", "from_subject needs a surface node")
		origin = _xf(sn, root).origin
		var sg = _geoms(accept_under, root, [])
		if sg.size() == 0:
			return _fail("surface_has_no_visual_bounds", "surface has no visible geometry to aim at: " + surface)
		var iv = _intervals(sg, [Vector3.RIGHT, Vector3.UP, Vector3.BACK])
		var closest = Vector3(clampf(origin.x, iv[0][0], iv[0][1]), clampf(origin.y, iv[1][0], iv[1][1]), clampf(origin.z, iv[2][0], iv[2][1]))
		if (closest - origin).length() < 0.0001:
			return _fail("subject_inside_surface_bounds", "the subject origin is inside the surface's bounds, so no direction toward it is defined; pass an explicit ray")
		dir = (closest - origin).normalized()
		exclude_nodes.append(sn)
	var out = {"ok": true, "origin": _raw3(origin), "direction": _raw3(dir), "scene_active": active}
	var phys = {"available": false, "reason": "not_requested"}
	if mode != "visual_aabb":
		phys = _phys_ray(root, active, origin, dir, dist, mask, areas, exclude_nodes, accept_under)
	var geoms = _geoms(root, root, exclude_nodes)
	var vis = _vis_ray(geoms, origin, dir, dist, accept_under)
	out["physics_available"] = phys.get("available", false)
	if not phys.get("available", false):
		out["physics_unavailable_reason"] = phys.get("reason", "")
	if phys.get("hit", false):
		out["physics"] = {"path": phys["path"], "point": _raw3(phys["point"]), "normal": _raw3(phys["normal"]), "distance": (phys["point"] - origin).length(), "skipped": phys.get("skipped", 0)}
	if vis.get("hit", false):
		out["visual"] = {"path": _rel(root, vis["node"]), "point": _raw3(vis["point"]), "normal": _raw3(vis["normal"]), "distance": vis["t"]}
	out["visual_origin_inside"] = vis.get("inside", 0)
	if geoms.size() >= MAX_GEOMS:
		out["visual_truncated"] = true
	return out


# ---------------------------------------------------------------- meshes

# Triangles of the given meshes (each [MeshInstance3D, frame transform, aabb])
# in one frame: area-binned planar faces and open boundary loops.
func _analyze(meshes, budget, want_planes, want_loops):
	var planes = {}
	var loops = []
	var analyzed = 0
	var truncated = false
	var open_chains = 0
	for mi in range(meshes.size()):
		if truncated:
			break
		var m = meshes[mi]
		var mesh = m[0].mesh
		var t = m[1]
		var flip = t.basis.determinant() < 0.0
		var weld = {}
		var pos = PackedVector3Array()
		var edges = {}
		for s in range(mesh.get_surface_count()):
			if truncated:
				break
			if mesh.surface_get_primitive_type(s) != Mesh.PRIMITIVE_TRIANGLES:
				continue
			var arr = mesh.surface_get_arrays(s)
			var verts = arr[Mesh.ARRAY_VERTEX]
			if verts == null or verts.size() == 0:
				continue
			if verts.size() > budget * 3:
				truncated = true
				break
			var idx = arr[Mesh.ARRAY_INDEX]
			var has_idx = idx != null and idx.size() > 0
			var count = idx.size() if has_idx else verts.size()
			var ids = PackedInt32Array()
			ids.resize(verts.size())
			var wv = PackedVector3Array()
			wv.resize(verts.size())
			for i in range(verts.size()):
				var p = t * verts[i]
				wv[i] = p
				var key = Vector3i(roundi(p.x * 10000.0), roundi(p.y * 10000.0), roundi(p.z * 10000.0))
				var id = weld.get(key, -1)
				if id < 0:
					id = pos.size()
					weld[key] = id
					pos.append(p)
				ids[i] = id
			var k = 0
			while k + 2 < count:
				if analyzed >= budget:
					truncated = true
					break
				analyzed += 1
				var i0 = idx[k] if has_idx else k
				var i1 = idx[k + 1] if has_idx else k + 1
				var i2 = idx[k + 2] if has_idx else k + 2
				k += 3
				if want_planes:
					var a = wv[i0]
					var cr = (a - wv[i2]).cross(a - wv[i1])
					if flip:
						cr = -cr
					var l = cr.length()
					if l > 0.0000000001:
						var nn = cr / l
						var area = l * 0.5
						var off = nn.dot(a)
						var pk = Vector4i(roundi(nn.x * 40.0), roundi(nn.y * 40.0), roundi(nn.z * 40.0), roundi(off * 100.0))
						var acc = planes.get(pk)
						if acc == null:
							planes[pk] = [area, nn * area, off * area, 1]
						else:
							acc[0] += area
							acc[1] += nn * area
							acc[2] += off * area
							acc[3] += 1
				if want_loops:
					_edge(edges, ids[i0], ids[i1])
					_edge(edges, ids[i1], ids[i2])
					_edge(edges, ids[i2], ids[i0])
		if want_loops and edges.size() > 0:
			var mc = t * m[2].get_center()
			var found = _loops(edges, pos)
			open_chains += found["open"]
			for lp in found["loops"]:
				var rec = _loop_record(lp, pos, mc)
				rec["mesh"] = mi
				loops.append(rec)
	var plist = []
	for pk in planes:
		var acc = planes[pk]
		plist.append({"area": acc[0], "normal": (acc[1] / acc[0]).normalized(), "offset": acc[2] / acc[0], "tris": acc[3]})
	plist.sort_custom(func(a, b): return a["area"] > b["area"])
	loops.sort_custom(_loop_less)
	return {"planes": plist, "loops": loops, "analyzed": analyzed, "truncated": truncated, "open_chains": open_chains}


func _edge(edges, a, b):
	if a == b:
		return
	var k = _ek(a, b)
	edges[k] = edges.get(k, 0) + 1


func _ek(a, b):
	return Vector2i(a, b) if a < b else Vector2i(b, a)


func _loops(edges, pos):
	var adj = {}
	var boundary = 0
	for k in edges:
		if edges[k] != 1:
			continue
		boundary += 1
		if boundary > 200000:
			break
		var a = k.x
		var b = k.y
		if not adj.has(a):
			adj[a] = []
		if not adj.has(b):
			adj[b] = []
		adj[a].append(b)
		adj[b].append(a)
	var used = {}
	var loops = []
	var open = 0
	for start in adj:
		if loops.size() >= 256:
			break
		for nb in adj[start]:
			var ek = _ek(start, nb)
			if used.has(ek):
				continue
			used[ek] = true
			var loop = [start]
			var cur = nb
			var closed = false
			var guard = 0
			while guard < 200000:
				guard += 1
				if cur == start:
					closed = true
					break
				loop.append(cur)
				var nxt = -1
				for cand in adj[cur]:
					var ck = _ek(cur, cand)
					if not used.has(ck):
						used[ck] = true
						nxt = cand
						break
				if nxt < 0:
					break
				cur = nxt
			if closed and loop.size() >= 3:
				loops.append(loop)
			else:
				open += 1
	return {"loops": loops, "open": open}


func _loop_record(loop, pos, mesh_center):
	var c = Vector3.ZERO
	for id in loop:
		c += pos[id]
	c /= float(loop.size())
	var n = Vector3.ZERO
	for i in range(loop.size()):
		var p = pos[loop[i]] - c
		var q = pos[loop[(i + 1) % loop.size()]] - c
		n += p.cross(q)
	var amb = false
	if n.length() < 0.000000000001:
		amb = true
		n = Vector3.ZERO
	else:
		n = n.normalized()
	var r = 0.0
	var dev = 0.0
	for id in loop:
		var d = pos[id] - c
		r += d.length()
		dev = maxf(dev, absf(d.dot(n)))
	r /= float(loop.size())
	var side = n.dot(c - mesh_center)
	if absf(side) < 0.00001:
		amb = true
	elif side < 0.0:
		n = -n
	return {"center": c, "direction": n, "radius": r, "vertices": loop.size(), "max_dev": dev, "ambiguous": amb}


func _loop_less(a, b):
	if absf(a["radius"] - b["radius"]) > 0.0001:
		return a["radius"] > b["radius"]
	for k in range(3):
		if absf(a["center"][k] - b["center"][k]) > 0.0001:
			return a["center"][k] < b["center"][k]
	return a["vertices"] > b["vertices"]


# Meshes, markers and shapes under top, in top's own frame (top's transform excluded).
func _collect(top):
	var meshes = []
	var geoms = []
	var markers = []
	var shapes = []
	var stack = [[top, Transform3D.IDENTITY, true, true]]
	while stack.size() > 0:
		var it = stack.pop_back()
		var n = it[0]
		var t = it[1]
		var vis = it[2]
		if n is Node3D:
			if not it[3]:
				t = t * n.transform
			vis = vis and n.visible
		if n is GeometryInstance3D:
			var bb = n.get_aabb()
			if bb.size != Vector3.ZERO:
				if vis:
					geoms.append([n, t, bb])
				if n is MeshInstance3D and n.mesh != null:
					meshes.append([n, t, bb, vis])
		elif n is Marker3D:
			markers.append([n, t])
		elif n is CollisionShape3D:
			shapes.append([n, t])
		for c in n.get_children():
			stack.append([c, t, vis, false])
	var by_path = func(a, b): return String(top.get_path_to(a[0])) < String(top.get_path_to(b[0]))
	meshes.sort_custom(by_path)
	markers.sort_custom(by_path)
	shapes.sort_custom(by_path)
	return {"meshes": meshes, "geoms": geoms, "markers": markers, "shapes": shapes}


func _visible_meshes(col):
	var out = []
	for m in col["meshes"]:
		if m[3]:
			out.append(m)
	return out


func _mesh_tris(mesh):
	var n = 0
	for s in range(mesh.get_surface_count()):
		if mesh.surface_get_primitive_type(s) != Mesh.PRIMITIVE_TRIANGLES:
			continue
		if mesh is ArrayMesh:
			var il = mesh.surface_get_array_index_len(s)
			n += floori(float(il if il > 0 else mesh.surface_get_array_len(s)) / 3.0)
		else:
			var arr = mesh.surface_get_arrays(s)
			var idx = arr[Mesh.ARRAY_INDEX]
			var verts = arr[Mesh.ARRAY_VERTEX]
			n += floori(float(idx.size() if idx != null and idx.size() > 0 else (verts.size() if verts != null else 0)) / 3.0)
	return n


func _shape_aabb(sh):
	if sh is BoxShape3D:
		return AABB(-sh.size * 0.5, sh.size)
	if sh is SphereShape3D:
		return AABB(Vector3.ONE * -sh.radius, Vector3.ONE * sh.radius * 2.0)
	if sh is CapsuleShape3D or sh is CylinderShape3D:
		return AABB(Vector3(-sh.radius, -sh.height * 0.5, -sh.radius), Vector3(sh.radius * 2.0, sh.height, sh.radius * 2.0))
	var pts = PackedVector3Array()
	if sh is ConcavePolygonShape3D:
		pts = sh.get_faces()
	elif sh is ConvexPolygonShape3D:
		pts = sh.points
	if pts.size() > 0:
		var bb = AABB(pts[0], Vector3.ZERO)
		for p in pts:
			bb = bb.expand(p)
		return bb
	if sh != null:
		var dm = sh.get_debug_mesh()
		if dm != null:
			return dm.get_aabb()
	return null


func _bounds_of(geoms):
	if geoms.size() == 0:
		return null
	var iv = _intervals(geoms, [Vector3.RIGHT, Vector3.UP, Vector3.BACK])
	return AABB(Vector3(iv[0][0], iv[1][0], iv[2][0]), Vector3(iv[0][1] - iv[0][0], iv[1][1] - iv[1][0], iv[2][1] - iv[2][0]))


func _frac_label(f):
	if f < -0.02 or f > 1.02:
		return "outside"
	if f < 0.02:
		return "min"
	if f > 0.98:
		return "max"
	if absf(f - 0.5) < 0.02:
		return "center"
	return "inside"


# ---------------------------------------------------------------- inspect_asset

func _cmd_inspect_asset(args):
	var path = String(args.get("path", ""))
	if not ResourceLoader.exists(path):
		return _fail("asset_not_found", "No resource at " + path)
	var res = ResourceLoader.load(path)
	if res == null:
		return _fail("asset_load_failed", "ResourceLoader could not load " + path)
	var inst = null
	if res is PackedScene:
		if not res.can_instantiate():
			return _fail("asset_not_instantiable", path + " cannot be instantiated")
		inst = res.instantiate()
	elif res is Mesh:
		inst = MeshInstance3D.new()
		inst.mesh = res
	else:
		return _fail("unsupported_resource", path + " is a " + res.get_class() + "; pass a scene (.tscn/.scn/.glb/.gltf) or a Mesh resource")
	if inst == null:
		return _fail("asset_instantiate_failed", "Could not instantiate " + path)
	var out = _describe(inst, args)
	inst.free()
	out["path"] = path
	return out


func _describe(inst, args):
	var budget = int(args.get("max_triangles", 60000))
	var col = _collect(inst)
	var out = {"ok": true, "frame": "asset_root", "root_class": inst.get_class(), "root_name": String(inst.name)}
	if inst is Node3D:
		out["root_transform_identity"] = inst.transform.is_equal_approx(Transform3D.IDENTITY)
	var bb = _bounds_of(col["geoms"])
	if bb == null:
		out["aabb"] = null
		out["origin"] = null
	else:
		out["aabb"] = {"min": _v3(bb.position), "max": _v3(bb.end), "size": _v3(bb.size)}
		var f = []
		var labels = []
		var names = ["x", "y", "z"]
		for k in range(3):
			var fk = 0.5 if bb.size[k] < 0.000001 else (0.0 - bb.position[k]) / bb.size[k]
			f.append(snappedf(fk, 0.001))
			labels.append(names[k] + ":" + _frac_label(fk))
		out["origin"] = {"fraction": f, "label": " ".join(labels)}
	var meshes_out = []
	var total = 0
	for m in col["meshes"]:
		var tris = _mesh_tris(m[0].mesh)
		total += tris
		var mb = _bounds_of([[m[0], m[1], m[2]]])
		var rec = {"path": String(inst.get_path_to(m[0])), "tris": tris, "min": _v3(mb.position), "max": _v3(mb.end)}
		if not m[3]:
			rec["hidden"] = true
		meshes_out.append(rec)
	out["mesh_count"] = meshes_out.size()
	out["meshes"] = meshes_out
	out["triangles"] = total
	var an = _analyze(_visible_meshes(col), budget, true, true)
	var planes_out = []
	for p in an["planes"]:
		if planes_out.size() >= 6:
			break
		planes_out.append({"normal": _d3(p["normal"]), "offset": _r(p["offset"]), "area": snappedf(p["area"], 0.000001), "tris": p["tris"]})
	out["planes"] = planes_out
	var loops_out = []
	for i in range(an["loops"].size()):
		var lp = an["loops"][i]
		var rec = {"index": i, "mesh": lp["mesh"], "center": _v3(lp["center"]), "direction": _d3(lp["direction"]), "radius": _r(lp["radius"]), "vertices": lp["vertices"], "max_dev": _r(lp["max_dev"])}
		if lp["ambiguous"]:
			rec["direction_ambiguous"] = true
		loops_out.append(rec)
	out["open_loop_count"] = loops_out.size()
	out["open_loops"] = loops_out
	out["open_chains"] = an["open_chains"]
	var anchors = []
	for mk in col["markers"]:
		var t = mk[1]
		anchors.append({"name": String(mk[0].name), "path": String(inst.get_path_to(mk[0])), "position": _v3(t.origin), "forward": _d3((-t.basis.z).normalized()), "up": _d3(t.basis.y.normalized())})
	out["anchor_count"] = anchors.size()
	out["anchors"] = anchors
	var shapes = []
	for sh in col["shapes"]:
		var node = sh[0]
		var t = sh[1]
		var shape = node.shape
		var rec = {"path": String(inst.get_path_to(node)), "shape": shape.get_class() if shape != null else "none", "center": _v3(t.origin)}
		if node.disabled:
			rec["disabled"] = true
		if shape is BoxShape3D:
			rec["size"] = _v3(shape.size)
		elif shape is SphereShape3D:
			rec["radius"] = _r(shape.radius)
		elif shape is CapsuleShape3D or shape is CylinderShape3D:
			rec["radius"] = _r(shape.radius)
			rec["height"] = _r(shape.height)
		elif shape is ConcavePolygonShape3D:
			rec["faces"] = floori(shape.get_faces().size() / 3.0)
		elif shape is ConvexPolygonShape3D:
			rec["points"] = shape.points.size()
		var sbb = _shape_aabb(shape)
		if sbb != null:
			var b2 = _bounds_of([[node, t, sbb]])
			rec["min"] = _v3(b2.position)
			rec["max"] = _v3(b2.end)
		shapes.append(rec)
	out["collision_count"] = shapes.size()
	out["collision"] = shapes
	out["analysis"] = {"triangles_analyzed": an["analyzed"], "triangle_budget": budget, "truncated": an["truncated"], "weld_m": 0.0001, "plane_bin": {"normal_step": 0.025, "offset_m": 0.01}}
	return out


# ---------------------------------------------------------------- ports

func _resolve_port(root, node, port, budget):
	var nt = _xf(node, root)
	if typeof(port) == TYPE_STRING:
		var mk = node.get_node_or_null(NodePath(String(port)))
		if mk == null:
			mk = node.find_child(String(port), true, false)
		if mk == null:
			return {"fail": _fail("port_not_found", "no node named '" + String(port) + "' under " + _rel(root, node))}
		if not (mk is Node3D):
			return {"fail": _fail("port_not_node3d", "port '" + String(port) + "' is not a Node3D")}
		var mt = _xf(mk, root)
		return {"kind": "marker", "name": String(port), "path": _rel(root, mk), "position": mt.origin, "direction": (-mt.basis.z).normalized()}
	var index = int(port)
	var col = _collect(node)
	var an = _analyze(_visible_meshes(col), budget, false, true)
	if index < 0 or index >= an["loops"].size():
		return {"fail": _fail("port_not_found", "open-loop port index " + str(index) + " not found on " + _rel(root, node) + " (" + str(an["loops"].size()) + " loop(s); see summer_inspect_asset open_loops)")}
	var lp = an["loops"][index]
	var out = {"kind": "open_loop", "index": index, "position": nt * lp["center"], "direction": (nt.basis * lp["direction"]).normalized(), "radius": lp["radius"], "loop_count": an["loops"].size()}
	if lp["ambiguous"]:
		out["direction_ambiguous"] = true
	if an["truncated"]:
		out["analysis_truncated"] = true
	return out


func _cmd_ports(root, args):
	var budget = int(args.get("max_triangles", 60000))
	var sub = _node(root, String(args.get("subject", "")))
	if sub == null:
		return _fail("node_not_found", "subject not found: " + String(args.get("subject", "")))
	var tgt = _node(root, String(args.get("target", "")))
	if tgt == null:
		return _fail("node_not_found", "target not found: " + String(args.get("target", "")))
	if not (sub is Node3D) or not (tgt is Node3D):
		return _fail("not_node3d", "subject and target must be Node3D")
	if sub == tgt or sub.is_ancestor_of(tgt):
		return _fail("target_inside_subject", "the target must not be the subject or inside it")
	var sp = _resolve_port(root, sub, args.get("subject_port"), budget)
	if sp.has("fail"):
		return sp["fail"]
	var tp = _resolve_port(root, tgt, args.get("target_port"), budget)
	if tp.has("fail"):
		return tp["fail"]
	for p in [sp, tp]:
		p["position"] = _raw3(p["position"])
		p["direction"] = _raw3(p["direction"])
	var parent_xf = Transform3D.IDENTITY
	if sub != root and sub.get_parent() != null:
		parent_xf = _xf(sub.get_parent(), root)
	return {"ok": true, "subject_port": sp, "target_port": tp, "xform": _xf12(_xf(sub, root)), "parent_xform": _xf12(parent_xf)}


# ---------------------------------------------------------------- blockers

# What holds a node where it stands: the nodes it overlaps now, and the first
# node it would touch moving along dir within dist. Physics (its enabled
# collision shapes against bodies) when it has shapes and the scene is the
# active tab, else visible-mesh AABBs (SnapToSurface's own fallback).
func _cmd_blockers(root, active, args):
	var path = String(args.get("path", ""))
	var n = _node(root, path)
	if n == null:
		return _fail("node_not_found", "node not found in scene: " + path)
	if not (n is Node3D):
		return _fail("not_node3d", "node is not a Node3D: " + path)
	var dir = _vec(args.get("direction", [0, -1, 0]))
	if dir.length() < 0.000001:
		return _fail("bad_args", "direction must be non-zero")
	dir = dir.normalized()
	var dist = float(args.get("max_distance", 1.0))
	var mask = int(args.get("collision_mask", 4294967295))
	var shapes = []
	var ex: Array[RID] = []
	var stack = [n]
	while stack.size() > 0:
		var cur = stack.pop_back()
		if cur is CollisionObject3D:
			ex.append(cur.get_rid())
		if cur is CollisionShape3D and not cur.disabled and cur.shape != null:
			shapes.append(cur)
		for c in cur.get_children():
			stack.append(c)
	var space = null
	if active and shapes.size() > 0 and n.is_inside_tree():
		var vp = root.get_viewport()
		var world = vp.find_world_3d() if vp != null else null
		if world != null:
			space = world.direct_space_state
	var overlaps = []
	var best = INF
	var best_path = ""
	if space != null:
		for cs in shapes:
			var q = PhysicsShapeQueryParameters3D.new()
			q.shape = cs.shape
			q.transform = cs.global_transform
			q.collision_mask = mask
			q.exclude = ex
			for hit in space.intersect_shape(q, 8):
				var col = hit.get("collider")
				if col is Node:
					var hp = _rel(root, col) if (col == root or root.is_ancestor_of(col)) else String(col.get_path())
					if not overlaps.has(hp):
						overlaps.append(hp)
			q.motion = dir * dist
			var frac = space.cast_motion(q)
			if frac.size() == 2 and frac[1] < 1.0 and frac[0] * dist < best:
				var q2 = PhysicsShapeQueryParameters3D.new()
				q2.shape = cs.shape
				q2.transform = cs.global_transform.translated(dir * (dist * frac[1]))
				q2.collision_mask = mask
				q2.exclude = ex
				var info = space.get_rest_info(q2)
				if not info.is_empty():
					var obj = instance_from_id(int(info.get("collider_id", 0)))
					if obj is Node:
						best = frac[0] * dist
						best_path = _rel(root, obj) if (obj == root or root.is_ancestor_of(obj)) else String(obj.get_path())
		var pout = {"ok": true, "evidence": "physics", "overlaps": overlaps, "first_contact": null}
		if best_path != "":
			pout["first_contact"] = {"path": best_path, "distance": best}
		return pout
	var mine = _bounds_of(_geoms(n, root, []))
	if mine == null:
		return _fail("no_bounds", "the node has no enabled collision shape in the active scene and no visible geometry")
	for g in _geoms(root, root, [n]):
		var ob = _bounds_of([g])
		if mine.intersects(ob):
			var vp_path = _rel(root, g[0])
			if overlaps.size() < 8 and not overlaps.has(vp_path):
				overlaps.append(vp_path)
			continue
		var t = _box_sweep(mine, ob, dir, dist)
		if t >= 0.0 and t < best:
			best = t
			best_path = _rel(root, g[0])
	var vout = {"ok": true, "evidence": "visual_aabb", "overlaps": overlaps, "first_contact": null}
	if shapes.size() > 0:
		vout["physics_unavailable_reason"] = "scene_not_active" if not active else "no_space_state"
	if best_path != "":
		vout["first_contact"] = {"path": best_path, "distance": best}
	return vout


# Travel t in [0, dist] at which box a, moved along unit dir, first touches
# box b; -1.0 when it does not within dist.
func _box_sweep(a, b, dir, dist):
	var lo = b.position - a.size
	var hi = b.end
	var o = a.position
	var tmin = 0.0
	var tmax = dist
	for k in range(3):
		if absf(dir[k]) < 0.000000001:
			if o[k] <= lo[k] or o[k] >= hi[k]:
				return -1.0
		else:
			var t1 = (lo[k] - o[k]) / dir[k]
			var t2 = (hi[k] - o[k]) / dir[k]
			if t1 > t2:
				var tmp = t1
				t1 = t2
				t2 = tmp
			tmin = maxf(tmin, t1)
			tmax = minf(tmax, t2)
			if tmin > tmax:
				return -1.0
	return tmin
`;
