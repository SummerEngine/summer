/**
 * surface-snap-mesh — the visible-mesh measurement behind
 * `summer_snap_to_surface` when colliders cannot answer.
 *
 * The engine's SnapToSurface sweeps the subject's colliders against body
 * colliders. When the subject or the support has no collider it falls back to
 * visual_aabb: the subject's visible AABB swept against the AABB of every
 * other visible geometry in the scene. One large AABB anywhere around the
 * subject (a tree, a building block, a full-screen post quad whose mesh
 * carries a huge custom AABB) then counts as an overlap that no back-off
 * clears: collider-less ferns on a ground PlaneMesh all failed with
 * overlap_recovery_exceeded, "starts in contact with or inside (unnamed)".
 *
 * This probe measures the same move from triangles instead. It is one
 * read-only GDScript sent through RunSceneScript (undo "none", no
 * checkpoint), with its arguments as base64 data, never source:
 *
 *   - the subject's visible mesh triangles in scene space; its vertices are
 *     cast along the direction, each from the subject's top plane (the
 *     subject's extreme against the direction) above it, onto the
 *     triangles of every other visible mesh whose bounds meet the swept
 *     column. A surface between that plane and the vertex means the subject
 *     is sunk into it (negative travel);
 *   - the support's vertices inside the subject's footprint are cast back
 *     against the subject's triangles, for support peaks between subject
 *     vertices;
 *   - crossing edges supply the remaining projected triangle contacts;
 *   - travel = the smallest of those distances; the new local position is
 *     the current one plus (travel - gap) along the direction, mapped
 *     through the parent's transform.
 *
 * Meshes whose shader writes POSITION (screen-space quads) and non-mesh
 * geometry (CSG, MultiMesh, sprites) are skipped and counted. It reads the
 * scene only; the mutation is an ordinary SetProp + SaveScene sent by
 * surface-snap.ts.
 */
import { GRIDMAP_GEOMETRY_GDSCRIPT } from "./gridmap-geometry.js";
import { PARENT_TRANSLATION_GDSCRIPT, SCENE_SPACE_GDSCRIPT } from "./scene-space.js";

import { missingEngineOpResult, type CapabilityAdvertisingClient } from "../capability-skew.js";
import { asRecord, type JsonRecord } from "../util/json.js";
import { extractOpError } from "./engine-receipt.js";
import { encodeScriptArgs } from "./placement-script.js";
import { buildRunSceneScriptOp } from "./scene-script.js";

export const SNAP_MESH_ARGS_TOKEN = "__SUMMER_SNAP_MESH_ARGS__";

export interface SnapMeshProbeArgs {
  scenePath: string;
  subjectPath: string;
  direction: [number, number, number];
  maxDistance: number;
  gap: number;
  captureTransform?: boolean;
  nativeSupportPath?: string;
  initialTransform?: string;
}

export interface MeshSnapMeasure {
  ok: true;
  excluded_native_support?: boolean;
  /** A support was found within maxDistance. */
  found: boolean;
  /** Distance the subject can move along the direction before its visible
   *  triangles touch the support's (negative: it is sunk that deep). */
  travel?: number;
  /** travel - gap: the move along the direction. */
  shift?: number;
  /** Distance from an already-applied native seat to the measured target. */
  correction_distance?: number;
  support?: string;
  support_has_collider?: boolean;
  subject_colliders?: number;
  hit_point?: [number, number, number];
  hit_normal?: [number, number, number];
  /** Which projected triangle feature supplied the first contact. */
  contact_from?: "subject_vertex" | "support_vertex" | "crossing_edges";
  /** The subject's extent along the direction. */
  extent?: number;
  /** Godot literals of the subject's local position now and after the move. */
  transform?: string;
  position?: string;
  position_after?: string;
  origin_before?: [number, number, number];
  origin_after?: [number, number, number];
  samples?: number;
  subject_vertices?: number;
  support_meshes?: number;
  support_triangles?: number;
  reverse_partial?: boolean;
  skipped?: JsonRecord;
}

export interface MeshSnapFailure {
  ok: false;
  excluded_native_support?: boolean;
  failure_reason: string;
  error: string;
}

export interface SnapMeshClient extends CapabilityAdvertisingClient {
  executeIdentityBoundOps(ops: Record<string, unknown>[], options?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

/** Measure the visible-mesh snap from the subject's current pose. */
export async function measureMeshSnap(client: SnapMeshClient, args: SnapMeshProbeArgs): Promise<MeshSnapMeasure | MeshSnapFailure> {
  if (missingEngineOpResult(client, "RunSceneScript", "")) {
    return { ok: false, failure_reason: "engine_lacks_op", error: "this engine build has no RunSceneScript, so the visible-mesh measurement cannot run" };
  }
  const { op, timeoutMs } = buildRunSceneScriptOp({
    source: buildSnapMeshScript({
      scene_path: args.scenePath,
      subject: args.subjectPath,
      direction: args.direction,
      max_distance: args.maxDistance,
      gap: args.gap,
      ...(args.initialTransform ? { initial_transform: args.initialTransform } : {}),
      ...(args.nativeSupportPath ? { native_support: args.nativeSupportPath } : {}),
      ...(args.captureTransform ? { capture_transform: true } : {}),
    }),
    max_seconds: 30,
    checkpoint: false,
    undo: "none",
  });
  let receipt: unknown;
  try {
    receipt = await client.executeIdentityBoundOps([op], { scenePath: args.scenePath }, timeoutMs);
  } catch (err) {
    return { ok: false, failure_reason: "mesh_probe_failed", error: `the visible-mesh probe failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const results = asRecord(receipt)?.results;
  const entry = asRecord(Array.isArray(results) ? results.find((r) => asRecord(r)?.op === "RunSceneScript") ?? results[0] : undefined);
  const envelopeError = extractOpError(receipt);
  if (!entry || entry.ok === false || envelopeError) {
    if (/unknown op.*RunSceneScript|RunSceneScript.*(?:unsupported|not supported)/i.test(String(entry?.error ?? envelopeError))) {
      return { ok: false, failure_reason: "engine_lacks_op", error: "this engine build has no RunSceneScript" };
    }
    return { ok: false, failure_reason: "mesh_probe_failed", error: `the visible-mesh probe (RunSceneScript) failed: ${String(entry?.error ?? envelopeError ?? "no result")}` };
  }
  const result = asRecord(entry.result);
  if (!result) return { ok: false, failure_reason: "mesh_probe_failed", error: "the visible-mesh probe ran but returned no result" };
  if (result.ok !== true) {
    return {
      ok: false,
      ...(result.excluded_native_support === true ? { excluded_native_support: true } : {}),
      failure_reason: typeof result.failure_reason === "string" ? result.failure_reason : "mesh_probe_failed",
      error: typeof result.error === "string" ? result.error : "the visible-mesh probe reported a failure",
    };
  }
  return result as unknown as MeshSnapMeasure;
}

export function buildSnapMeshScript(args: Record<string, unknown>): string {
  return SNAP_MESH_PROBE_SOURCE.split(SNAP_MESH_ARGS_TOKEN).join(`"${encodeScriptArgs(args)}"`);
}

/** The probe source with its placeholder, for tests. */
export function snapMeshProbeTemplate(): string {
  return SNAP_MESH_PROBE_SOURCE;
}

// Tabs are significant: GDScript indentation. String.raw keeps backslashes
// literal; the source never contains a template placeholder.
const SNAP_MESH_PROBE_SOURCE = String.raw`@tool
extends RefCounted

const ARGS_B64 = __SUMMER_SNAP_MESH_ARGS__
const MAX_NODES = 60000
const MAX_SUPPORT_TRIS = 400000
const MAX_SUBJECT_SAMPLES = 6000
const MAX_REVERSE_VERTS = 150000
const EDGE_BANDS = 16
const MAX_EDGE_PAIRS = 60000
const MAX_EDGE_VISITS = 1000000
const EPS = 0.0001


func run(_ctx):
	var args = JSON.parse_string(Marshalls.base64_to_utf8(ARGS_B64))
	if typeof(args) != TYPE_DICTIONARY:
		return _fail("bad_args", "snap probe arguments did not parse")
	var scene = _open_scene(String(args.get("scene_path", "")))
	if scene.has("fail"):
		return scene["fail"]
	var root = scene["root"]
	var subject = _node(root, String(args.get("subject", "")))
	if subject == null:
		return _fail("node_not_found", "subject not found: " + String(args.get("subject", "")))
	if not (subject is Node3D) or subject == root:
		return _fail("not_snappable", "the subject must be a Node3D below the scene root")
	if args.get("capture_transform", false):
		return {"ok": true, "found": false, "transform": var_to_str(subject.transform)}
	var result = _measure(root, subject, args)
	if args.has("native_support"):
		var support = _node(root, String(args["native_support"]))
		if support is GeometryInstance3D and not _draws_surface(support, root):
			result["excluded_native_support"] = true
	return result


func _measure(root, subject, args):
	var dv = _vec(args.get("direction", [0, -1, 0]))
	if dv.length() < 0.000001:
		return _fail("bad_args", "direction must be non-zero")
	var d = dv.normalized()
	var max_distance = float(args.get("max_distance", 20.0))
	var gap = float(args.get("gap", 0.0))
	var skipped = {"screen_space": 0, "not_mesh": 0, "shadows_only": 0}
	var sub_faces = PackedVector3Array()
	var subject_meshes = _mesh_items(subject, root, null, skipped)
	var supports = _mesh_items(root, root, subject, skipped)
	if skipped.has("grid_budget") or (skipped.has("grid_meshes") and skipped.has("node_budget")):
		return _fail("grid_mesh_budget_exceeded", "Too many GridMap mesh entries to verify the first surface.")
	var parent = _parent_xf(subject, root)
	var start_local = subject.position
	var start_offset = Vector3.ZERO
	var replay_start = skipped.has("grid_meshes") and args.has("initial_transform")
	if replay_start:
		# An earlier editor can seat on a mesh below a GridMap. Cast from the captured
		# starting pose so a first surface above that provisional seat can still win.
		var initial: Transform3D = str_to_var(args.initial_transform)
		if not initial.basis.is_equal_approx(subject.transform.basis):
			return _fail("translation_not_representable", "The provisional seat changed the subject basis before its triangle sweep.")
		start_local = initial.origin
		start_offset = (parent * start_local) - _world_xf(subject, root).origin
	for it in subject_meshes:
		if not _inherits_3d(it[0], subject):
			return _fail("independent_subject_geometry", "visible geometry does not inherit the subject's transform: " + _rel(root, it[0]))
		var pose = it[1]
		pose.origin += start_offset
		sub_faces.append_array(pose * it[2].get_faces())
	if sub_faces.size() < 3:
		if skipped["shadows_only"] > 0 and subject_meshes.is_empty() and skipped["not_mesh"] == 0 and skipped["screen_space"] == 0 and not skipped.has("node_budget"):
			return _fail("shadows_only_subject", "The subject only has shadows-only geometry; it has no visible surface to seat.")
		return _fail("no_subject_mesh", "the subject has no visible mesh triangles to measure")
	# The subject's unique vertices, its extent along d and its bounds.
	var uniq = {}
	var verts = []
	var lo = INF
	var hi = -INF
	var bb = AABB(sub_faces[0], Vector3.ZERO)
	for p in sub_faces:
		var key = Vector3i(roundi(p.x * 10000.0), roundi(p.y * 10000.0), roundi(p.z * 10000.0))
		if uniq.has(key):
			continue
		uniq[key] = true
		verts.append(p)
		var s = p.dot(d)
		lo = minf(lo, s)
		hi = maxf(hi, s)
		bb = bb.expand(p)
	var u = d.cross(Vector3.UP if absf(d.y) < 0.9 else Vector3.RIGHT).normalized()
	var v = d.cross(u).normalized()
	var umin = INF
	var umax = -INF
	var vmin = INF
	var vmax = -INF
	for p in verts:
		umin = minf(umin, p.dot(u))
		umax = maxf(umax, p.dot(u))
		vmin = minf(vmin, p.dot(v))
		vmax = maxf(vmax, p.dot(v))
	# Visible meshes outside the subject whose bounds meet the swept column.
	var column = bb.merge(AABB(bb.position + d * max_distance, bb.size)).grow(0.001)
	var sup_faces = PackedVector3Array()
	var ranges = []
	var tris = 0
	for it in supports:
		var wb = it[1] * it[3]
		if not column.intersects(wb.grow(0.001)):
			continue
		var faces = it[1] * it[2].get_faces()
		if faces.size() < 3:
			continue
		tris += floori(faces.size() / 3.0)
		if tris > MAX_SUPPORT_TRIS:
			return _fail("grid_mesh_budget_exceeded" if skipped.has("grid_meshes") else "mesh_budget_exceeded", "the meshes around the subject have more than " + str(MAX_SUPPORT_TRIS) + " triangles; the visible-mesh measurement stops rather than miss a surface")
		sup_faces.append_array(faces)
		ranges.append([tris, it[0]])
	var stats = {"samples": 0, "subject_vertices": verts.size(), "support_meshes": ranges.size(), "support_triangles": tris, "extent": hi - lo, "skipped": skipped, "subject_colliders": _count_colliders(subject)}
	if tris == 0:
		return _done(stats, false)
	var tm = TriangleMesh.new()
	if not tm.create_from_faces(sup_faces):
		return _fail("mesh_build_failed", "could not build a triangle tree from the support meshes")
	# Subject samples: every vertex up to the cap, the leading band first.
	var samples = verts
	if verts.size() > MAX_SUBJECT_SAMPLES:
		samples = []
		var edge = hi - maxf(0.01, (hi - lo) * 0.1)
		var lead = []
		var rest = []
		for p in verts:
			if p.dot(d) >= edge:
				lead.append(p)
			else:
				rest.append(p)
		var half = floori(MAX_SUBJECT_SAMPLES * 0.5)
		var lstep = maxi(1, ceili(lead.size() / float(half)))
		for i in range(0, lead.size(), lstep):
			samples.append(lead[i])
		var room = maxi(1, MAX_SUBJECT_SAMPLES - samples.size())
		var rstep = maxi(1, ceili(rest.size() / float(room)))
		for i in range(0, rest.size(), rstep):
			samples.append(rest[i])
	stats["samples"] = samples.size()
	var best = INF
	var best_hit = {}
	# Subject vertices cast along d, each from the subject's top plane above it.
	for p in samples:
		var back = p.dot(d) - lo + EPS
		var begin = p - d * back
		var hit = tm.intersect_ray(begin, d)
		if hit.is_empty():
			continue
		var travel = (hit["position"] - begin).dot(d) - back
		if travel < best:
			best = travel
			best_hit = {"point": hit["position"], "normal": hit["normal"], "face": int(hit["face_index"]), "from": "subject_vertex"}
	# Support vertices inside the footprint cast back onto the subject.
	var stm = TriangleMesh.new()
	if stm.create_from_faces(sub_faces):
		var checked = 0
		for i in range(sup_faces.size()):
			var q = sup_faces[i]
			var sq = q.dot(d)
			if sq < lo or sq > hi + max_distance:
				continue
			var qu = q.dot(u)
			var qv = q.dot(v)
			if qu < umin or qu > umax or qv < vmin or qv > vmax:
				continue
			checked += 1
			if checked > MAX_REVERSE_VERTS:
				stats["reverse_partial"] = true
				break
			var down = maxf(0.0, hi - sq) + EPS
			var begin = q + d * down
			var hit = stm.intersect_ray(begin, -d)
			if hit.is_empty():
				continue
			var travel = (begin - hit["position"]).dot(d) - down
			if travel < best:
				best = travel
				best_hit = {"point": q, "normal": -hit["normal"], "face": floori(i / 3.0), "from": "support_vertex"}
	var footprint = Rect2(Vector2(umin, vmin), Vector2(umax - umin, vmax - vmin))
	var crossing = _crossing_contact(sub_faces, sup_faces, d, u, v, lo, hi, footprint, minf(best, max_distance + 2.0 * EPS))
	if crossing.has("failure_reason"):
		return crossing
	if not crossing.is_empty():
		best = crossing["travel"]
		best_hit = crossing
	if best_hit.is_empty() or best > max_distance:
		return _done(stats, false)
	var shift = best - gap
	var world_delta = [d.x * shift, d.y * shift, d.z * shift]
	var after = _translated_position_literal(parent, start_local, world_delta)
	if after == null:
		return _fail("translation_not_representable", "The parent transform cannot reproduce the requested mesh movement at engine precision.")
	var support = _support_of(ranges, int(best_hit["face"]))
	var origin = _world_xf(subject, root).origin
	stats["travel"] = best
	stats["shift"] = shift
	if replay_start:
		stats["correction_distance"] = origin.distance_to(parent * str_to_var(after))
	stats["support"] = _rel(root, support) if support != null else ""
	stats["support_has_collider"] = _has_collider(support, root)
	stats["hit_point"] = _raw3(best_hit["point"])
	stats["hit_normal"] = _raw3(Vector3(best_hit["normal"]).normalized())
	stats["contact_from"] = best_hit["from"]
	stats["position"] = var_to_str(subject.position)
	stats["position_after"] = after
	stats["origin_before"] = _raw3(origin + start_offset)
	stats["origin_after"] = _raw3(parent * str_to_var(after))
	return _done(stats, true)


# On the overlapping projections of two triangles, the travel along d is
# affine. Its minimum can be at two crossing edges even when neither
# triangle has a vertex in the other's footprint.
func _crossing_contact(subject, supports, d, u, v, lo, hi, footprint, best):
	var hit = {}
	var cells = {}
	var checks = 0
	var visits = 0
	var cell_size = Vector2(maxf(footprint.size.x, EPS), maxf(footprint.size.y, EPS)) / EDGE_BANDS
	var depth_axis = Vector3.ZERO
	var leading_depth = -INF
	var origin = subject[0]
	for i in range(0, supports.size(), 3):
		var depths = [supports[i].dot(d), supports[i + 1].dot(d), supports[i + 2].dot(d)]
		var nearest = minf(depths[0], minf(depths[1], depths[2]))
		var face_normal = (supports[i + 1] - supports[i]).cross(supports[i + 2] - supports[i]).normalized()
		var incidence = face_normal.dot(d)
		# At a shared edge both faces touch at the same travel. Prefer the
		# face that opposes the cast (a shelf's top over its vertical rim).
		var better_normal = not hit.is_empty() and absf(incidence) > absf(hit["normal"].dot(d)) + EPS
		var cutoff = best + EPS if better_normal else best - EPS
		if nearest - hi >= cutoff or maxf(depths[0], maxf(depths[1], depths[2])) < lo - EPS:
			continue
		var q = _project_face(supports, i, u, v)
		var bounds = _face_rect(q)
		if not footprint.intersects(bounds, true):
			continue
		# A slab containing every subject vertex provides a lower travel bound
		# against a support face, even when the subject is nonplanar.
		if depth_axis == Vector3.ZERO:
			depth_axis = d
			for j in range(0, subject.size(), 3):
				var n = (subject[j + 1] - subject[j]).cross(subject[j + 2] - subject[j]).normalized()
				var dot_d = n.dot(d)
				if absf(dot_d) > 0.25:
					depth_axis = n / dot_d
					break
			for vertex in subject:
				leading_depth = maxf(leading_depth, (vertex - origin).dot(depth_axis))
		var face_depth = INF
		for k in 3:
			face_depth = minf(face_depth, (supports[i + k] - origin).dot(depth_axis))
		if face_depth - leading_depth >= cutoff:
			continue
		if cells.is_empty():
			var slots = 0
			for j in range(0, subject.size(), 3):
				var p = _project_face(subject, j, u, v)
				var rect = _face_rect(p)
				var first = _edge_cell(rect.position, footprint.position, cell_size)
				var last = _edge_cell(rect.end, footprint.position, cell_size)
				var span = last - first + Vector2i.ONE
				slots += span.x * span.y
				if slots > MAX_EDGE_VISITS:
					return _edge_budget()
				var entry = [j, p, rect, first]
				for x in range(first.x, last.x + 1):
					for y in range(first.y, last.y + 1):
						var key = Vector2i(x, y)
						if not cells.has(key):
							cells[key] = []
						cells[key].append(entry)
		var first = _edge_cell(bounds.position, footprint.position, cell_size)
		var last = _edge_cell(bounds.end, footprint.position, cell_size)
		for x in range(first.x, last.x + 1):
			for y in range(first.y, last.y + 1):
				var key = Vector2i(x, y)
				for entry in cells.get(key, []):
					visits += 1
					if visits > MAX_EDGE_VISITS:
						return _edge_budget()
					if key != first.max(entry[3]) or not bounds.intersects(entry[2], true):
						continue
					var j = entry[0]
					if absf(incidence) > EPS:
						var earliest = INF
						for k in 3:
							earliest = minf(earliest, face_normal.dot(supports[i] - subject[j + k]) / incidence)
						if earliest >= cutoff:
							continue
					checks += 1
					if checks > MAX_EDGE_PAIRS:
						return _edge_budget()
					var contact = _face_edge_contact(subject, j, entry[1], supports, i, q, d, lo, best + EPS if better_normal else best)
					if not contact.is_empty():
						best = minf(best, contact["travel"])
						hit = contact
						hit["travel"] = best
						better_normal = false
						cutoff = best - EPS
	return hit


func _face_edge_contact(subject, subject_start, p, supports, support_start, q, direction, top, best):
	var hit = {}
	for a in 3:
		var b = (a + 1) % 3
		var ab = p[b] - p[a]
		if ab.length_squared() == 0.0:
			continue
		for c in 3:
			var e = (c + 1) % 3
			var ce = q[e] - q[c]
			if ce.length_squared() == 0.0:
				continue
			var cross_point = Geometry2D.segment_intersects_segment(p[a], p[b], q[c], q[e])
			if cross_point == null:
				continue
			var t = (cross_point - p[a]).dot(ab) / ab.length_squared()
			var s = (cross_point - q[c]).dot(ce) / ce.length_squared()
			var source = subject[subject_start + a].lerp(subject[subject_start + b], t)
			var target = supports[support_start + c].lerp(supports[support_start + e], s)
			var travel = (target - source).dot(direction)
			if travel >= best or target.dot(direction) < top - EPS:
				continue
			best = travel
			var normal = (supports[support_start + 1] - supports[support_start]).cross(supports[support_start + 2] - supports[support_start]).normalized()
			hit = {"travel": travel, "point": target, "normal": -normal if normal.dot(direction) > 0 else normal, "face": floori(support_start / 3.0), "from": "crossing_edges"}
	return hit


func _edge_budget():
	return _fail("mesh_edge_budget_exceeded", "The crossing-edge contact check exceeded its triangle-pair budget.")


func _edge_cell(point, origin, cell_size):
	return Vector2i(((point - origin) / cell_size).floor()).clampi(0, EDGE_BANDS - 1)


func _project_face(faces, index, u, v):
	var points = PackedVector2Array()
	for k in 3:
		var p = faces[index + k]
		points.append(Vector2(p.dot(u), p.dot(v)))
	return points


func _face_rect(points):
	return Rect2(points[0], Vector2.ZERO).expand(points[1]).expand(points[2])


func _done(stats, found):
	var out = {"ok": true, "found": found}
	for k in stats:
		out[k] = stats[k]
	return out


func _fail(reason, message):
	return {"ok": false, "failure_reason": reason, "error": message}


func _vec(a):
	return Vector3(float(a[0]), float(a[1]), float(a[2]))


func _raw3(v):
	return [v.x, v.y, v.z]


func _open_scene(scene_path):
	var wanted = scene_path.simplify_path()
	for r in EditorInterface.get_open_scene_roots():
		if r != null and String(r.scene_file_path).simplify_path() == wanted:
			return {"root": r}
	return {"fail": _fail("scene_not_open", "Scene " + wanted + " is not open in the editor")}


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


${SCENE_SPACE_GDSCRIPT}
${PARENT_TRANSLATION_GDSCRIPT}
${GRIDMAP_GEOMETRY_GDSCRIPT}

# Mesh, scene-space transform, local bounds and owning node for every drawn entry.
func _mesh_items(start, root, exclude, skipped):
	var out = []
	var stack = [start]
	var subject = exclude if exclude != null else start
	var world = subject.get_world_3d() if subject.is_inside_tree() else null
	var visited = 0
	while stack.size() > 0:
		visited += 1
		if visited > MAX_NODES:
			skipped["node_budget"] = true
			break
		var n = stack.pop_back()
		if exclude != null and n == exclude:
			continue
		if n is GeometryInstance3D and _draws_surface(n, root):
			if n is MeshInstance3D:
				if n.mesh != null:
					if _screen_space(n.mesh, n):
						skipped["screen_space"] += 1
					else:
						out.append([n, _world_xf(n, root), n.mesh, n.get_aabb()])
			else:
				skipped["not_mesh"] += 1
		elif n.is_class("GridMap") and _visible(n, root) and (world == null or n.get_world_3d() == world):
			var grid = _gridmap_geometry(n)
			var pairs = grid.pairs
			var count = int(pairs.size() / 2)
			if count > 0:
				skipped.grid_meshes = skipped.get("grid_meshes", 0) + count
				if skipped.grid_meshes > MAX_NODES:
					skipped.grid_budget = true
					return []
			var frame = _world_xf(n, root)
			for i in range(0, pairs.size(), 2):
				if grid.shadows_only.has(int(i / 2)):
					skipped.shadows_only += 1
					continue
				var mesh = pairs[i + 1]
				if _screen_space(mesh):
					skipped.screen_space += 1
				else:
					out.append([n, frame * pairs[i], mesh, mesh.get_aabb()])
		elif n is GeometryInstance3D and _visible(n, root):
			skipped["shadows_only"] += 1
		stack.append_array(n.get_children())
	return out


# A mesh whose shader writes POSITION is drawn in screen space (a post quad):
# its triangles are not where the scene shows anything.
func _screen_space(mesh, mi = null):
	var mats = []
	if mi != null and mi.material_override != null:
		mats.append(mi.material_override)
	for s in range(mesh.get_surface_count()):
		var m = mi.get_active_material(s) if mi != null else mesh.surface_get_material(s)
		if m != null:
			mats.append(m)
	for m in mats:
		if m is ShaderMaterial and m.shader != null:
			var code = String(m.shader.code)
			if code.contains("POSITION") and code.contains("vertex"):
				return true
	return false


func _support_of(ranges, face):
	for r in ranges:
		if face < int(r[0]):
			return r[1]
	return null


func _count_colliders(node):
	var count = 0
	var stack = [node]
	while stack.size() > 0:
		var n = stack.pop_back()
		if (n is CollisionShape3D or n is CollisionPolygon3D) and not n.disabled and n.get_parent() is CollisionObject3D:
			count += 1
		for c in n.get_children():
			stack.append(c)
	return count


# The support mesh sits in a collision body, or carries one below it.
func _has_collider(node, root):
	if node == null:
		return false
	var cur = node
	while cur != null and cur != root:
		if cur is CollisionObject3D:
			return true
		cur = cur.get_parent()
	return _count_colliders(node) > 0
`;
