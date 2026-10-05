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
 *   - travel = the smallest of those distances; the new local position is
 *     the current one plus (travel - gap) along the direction, mapped
 *     through the parent's transform.
 *
 * Meshes whose shader writes POSITION (screen-space quads) and non-mesh
 * geometry (CSG, MultiMesh, sprites) are skipped and counted. It reads the
 * scene only; the mutation is an ordinary SetProp + SaveScene sent by
 * surface-snap.ts.
 */
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
}

export interface MeshSnapMeasure {
  ok: true;
  /** A support was found within maxDistance. */
  found: boolean;
  /** Distance the subject can move along the direction before its visible
   *  triangles touch the support's (negative: it is sunk that deep). */
  travel?: number;
  /** travel - gap: the move along the direction. */
  shift?: number;
  support?: string;
  support_has_collider?: boolean;
  subject_colliders?: number;
  hit_point?: [number, number, number];
  hit_normal?: [number, number, number];
  /** Which cast found the contact: a subject vertex onto the support, or a support vertex onto the subject. */
  contact_from?: "subject_vertex" | "support_vertex";
  /** The subject's extent along the direction. */
  extent?: number;
  /** Godot literals of the subject's local position now and after the move. */
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
    }),
    max_seconds: 30,
    checkpoint: false,
    undo: "none",
  });
  let receipt: unknown;
  try {
    receipt = await client.executeIdentityBoundOps([op], undefined, timeoutMs);
  } catch (err) {
    return { ok: false, failure_reason: "mesh_probe_failed", error: `the visible-mesh probe failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const results = asRecord(receipt)?.results;
  const entry = asRecord(Array.isArray(results) ? results.find((r) => asRecord(r)?.op === "RunSceneScript") ?? results[0] : undefined);
  const envelopeError = extractOpError(receipt);
  if (!entry || entry.ok === false || envelopeError) {
    return { ok: false, failure_reason: "mesh_probe_failed", error: `the visible-mesh probe (RunSceneScript) failed: ${String(entry?.error ?? envelopeError ?? "no result")}` };
  }
  const result = asRecord(entry.result);
  if (!result) return { ok: false, failure_reason: "mesh_probe_failed", error: "the visible-mesh probe ran but returned no result" };
  if (result.ok !== true) {
    return {
      ok: false,
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
	var dv = _vec(args.get("direction", [0, -1, 0]))
	if dv.length() < 0.000001:
		return _fail("bad_args", "direction must be non-zero")
	var d = dv.normalized()
	var max_distance = float(args.get("max_distance", 20.0))
	var gap = float(args.get("gap", 0.0))
	var skipped = {"screen_space": 0, "not_mesh": 0}
	var sub_faces = PackedVector3Array()
	for it in _mesh_items(subject, root, null, skipped):
		sub_faces.append_array(it[1] * it[0].mesh.get_faces())
	if sub_faces.size() < 3:
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
	for it in _mesh_items(root, root, subject, skipped):
		var wb = it[1] * it[0].get_aabb()
		if not column.intersects(wb.grow(0.001)):
			continue
		var faces = it[1] * it[0].mesh.get_faces()
		if faces.size() < 3:
			continue
		tris += floori(faces.size() / 3.0)
		if tris > MAX_SUPPORT_TRIS:
			return _fail("mesh_budget_exceeded", "the meshes around the subject have more than " + str(MAX_SUPPORT_TRIS) + " triangles; the visible-mesh measurement stops rather than miss a surface")
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
	if best_hit.is_empty() or best > max_distance:
		return _done(stats, false)
	var shift = best - gap
	var world_delta = d * shift
	var parent_basis = Basis.IDENTITY
	if not subject.top_level and subject.get_parent() != null:
		parent_basis = _xf(subject.get_parent(), root).basis
	if absf(parent_basis.determinant()) < 0.0000001:
		return _fail("singular_parent", "the subject's parent transform is singular")
	var after = subject.position + parent_basis.inverse() * world_delta
	var support = _support_of(ranges, int(best_hit["face"]))
	var origin = _xf(subject, root).origin
	stats["travel"] = best
	stats["shift"] = shift
	stats["support"] = _rel(root, support) if support != null else ""
	stats["support_has_collider"] = _has_collider(support, root)
	stats["hit_point"] = _raw3(best_hit["point"])
	stats["hit_normal"] = _raw3(Vector3(best_hit["normal"]).normalized())
	stats["contact_from"] = best_hit["from"]
	stats["position"] = var_to_str(subject.position)
	stats["position_after"] = var_to_str(after)
	stats["origin_before"] = _raw3(origin)
	stats["origin_after"] = _raw3(origin + world_delta)
	return _done(stats, true)


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


# Visible MeshInstance3D nodes under start (inclusive) with their scene-space
# transform; exclude is a subtree root to skip.
func _mesh_items(start, root, exclude, skipped):
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
		if visited > MAX_NODES:
			skipped["node_budget"] = true
			break
		var item = stack.pop_back()
		var n = item[0]
		if exclude != null and n == exclude:
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
			if n is MeshInstance3D:
				if n.mesh != null:
					if _screen_space(n):
						skipped["screen_space"] += 1
					else:
						out.append([n, t])
			else:
				skipped["not_mesh"] += 1
		for c in n.get_children():
			stack.append([c, t, vis])
	return out


# A mesh whose shader writes POSITION is drawn in screen space (a post quad):
# its triangles are not where the scene shows anything.
func _screen_space(mi):
	var mats = []
	if mi.material_override != null:
		mats.append(mi.material_override)
	for s in range(mi.mesh.get_surface_count()):
		var m = mi.get_active_material(s)
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
