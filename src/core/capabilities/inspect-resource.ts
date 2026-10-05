/**
 * inspect-resource — ONE implementation of `summer_inspect_resource` for both
 * faces (src/mcp/tools/scene-tools.ts and tool-dispatch.ts).
 *
 * The engine's state:resource (StateProvider::resource_properties_state)
 * reads a resource a NODE holds: it takes nodePath + property and answers
 * "missing nodePath or property" to anything else. The tool used to send it
 * only `path`, so every call failed, on a mesh .res or a .glb alike. Two forms
 * now:
 *
 *   path               a resource FILE, loaded in the editor by a read-only
 *                      RunSceneScript probe (undo none, no checkpoint; the
 *                      path travels as base64 data, never as source):
 *                        Mesh         AABB, surfaces (primitive, vertex and
 *                                     index counts, attributes, triangles,
 *                                     material), materials, blend shapes
 *                        PackedScene  node count, the first nodes with their
 *                                     types, instanced scenes and meshes, and
 *                                     a pointer to summer_inspect_asset
 *                        Texture2D    size
 *                        every other  editor properties that differ from the
 *                                     class default (defaults are counted)
 *   nodePath+property  the engine endpoint, for a resource a node of the
 *                      active scene holds (e.g. Floor + mesh).
 */
import { z } from "zod";
import { missingEngineOpResult, type CapabilityAdvertisingClient } from "../capability-skew.js";
import { ToolInputError } from "../tool-errors.js";
import { asRecord, type JsonRecord } from "../util/json.js";
import { extractOpError, withOldEngineHint } from "./engine-receipt.js";
import { buildRunSceneScriptOp } from "./scene-script.js";
import { encodeScriptArgs } from "./placement-script.js";
import { fitToBudget } from "./placement.js";

export const INSPECT_RESOURCE_ARGS_TOKEN = "__SUMMER_RESOURCE_ARGS__";
export const INSPECT_RESOURCE_FALLBACK =
  "read a text resource (.tres/.tscn) with summer_read_file, or pass nodePath + property for a resource a node of the open scene holds";

const RES_FILE = /^res:\/\/[^\u0000-\u001f]+$/;

// Mirrors library/tools/inspect-resource/resource.yaml input_schema (parity-tested).
export const inspectResourceInputShape = {
  path: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .refine((value) => RES_FILE.test(value) && !value.includes(".."), "path must be a res:// resource file without '..'")
    .optional()
    .describe(
      "A resource FILE: 'res://materials/ground.tres', a mesh 'res://kit/meshes/wall_01.res', a texture, a shape, or a scene/model 'res://models/player.glb'. Loaded read-only in the editor."
    ),
  nodePath: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .optional()
    .describe("With property: a node of the ACTIVE scene tab whose resource to read, e.g. 'Floor'. Do not combine with path."),
  property: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .optional()
    .describe("With nodePath: the node property holding the resource, e.g. 'mesh', 'material_override', 'shape', 'environment'."),
};

export const inspectResourceInputSchema = z.object(inspectResourceInputShape).strict();
export type InspectResourceArgs = z.output<typeof inspectResourceInputSchema>;

export interface InspectResourceClient extends CapabilityAdvertisingClient {
  executeIdentityBoundOps(ops: Record<string, unknown>[], options?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  inspectNodeResource(nodePath: string, property: string): Promise<unknown>;
}

const TOOL = "summer_inspect_resource";
const RESULT_TARGET_BYTES = 6000;

function fail(failureReason: string, error: string, extra: JsonRecord = {}): JsonRecord {
  return { ok: false, tool: TOOL, failure_reason: failureReason, error, ...extra };
}

export async function inspectResource(client: InspectResourceClient, args: InspectResourceArgs): Promise<unknown> {
  const hasNodeForm = args.nodePath !== undefined || args.property !== undefined;
  if (args.path !== undefined && hasNodeForm) {
    throw new ToolInputError("Pass either path (a resource file) or nodePath + property (a resource a node holds), not both.");
  }
  if (args.path !== undefined) return inspectResourceFile(client, args.path);
  if (args.nodePath !== undefined && args.property !== undefined) {
    return client.inspectNodeResource(args.nodePath, args.property);
  }
  if (hasNodeForm) throw new ToolInputError("nodePath and property go together, e.g. nodePath 'Floor' + property 'mesh'.");
  throw new ToolInputError(
    "Pass path (a resource file, e.g. 'res://materials/ground.tres' or a mesh 'res://kit/meshes/wall_01.res'), or nodePath + property (e.g. 'Floor' + 'mesh')."
  );
}

/** Load a resource file read-only in the editor and describe it compactly. */
export async function inspectResourceFile(client: InspectResourceClient, path: string): Promise<JsonRecord> {
  const missing = missingEngineOpResult(client, "RunSceneScript", INSPECT_RESOURCE_FALLBACK);
  if (missing) return { ...missing, tool: TOOL };
  const { op, timeoutMs } = buildRunSceneScriptOp({
    source: buildInspectResourceScript({ path }),
    max_seconds: 20,
    checkpoint: false,
    undo: "none",
  });
  const receipt = await client.executeIdentityBoundOps([op], undefined, timeoutMs);
  const hinted = asRecord(withOldEngineHint(receipt, "RunSceneScript", INSPECT_RESOURCE_FALLBACK));
  if (hinted?.failure_reason === "engine_lacks_op") return fail("engine_lacks_op", String(hinted.error), { op: "RunSceneScript" });
  const envelope = asRecord(receipt) ?? {};
  const results = Array.isArray(envelope.results) ? envelope.results : [];
  const entry = asRecord(results.find((item) => asRecord(item)?.op === "RunSceneScript") ?? results[0]);
  const envelopeError = extractOpError(receipt);
  if (!entry || entry.ok === false || envelopeError) {
    return fail("resource_probe_failed", `The resource probe (RunSceneScript) failed: ${String(entry?.error ?? envelopeError ?? "no result")}`);
  }
  const result = asRecord(entry.result);
  if (!result) return fail("resource_probe_failed", "The resource probe ran but returned no result.");
  if (result.ok !== true) {
    return fail(
      typeof result.failure_reason === "string" ? result.failure_reason : "resource_probe_failed",
      typeof result.error === "string" ? result.error : "The resource probe reported a failure."
    );
  }
  const { ok: _ok, ...rest } = result;
  const out: JsonRecord = { ok: true, tool: TOOL, source: "file", ...rest, evidence: "resource_loader" };
  const mesh = asRecord(out.mesh);
  const scene = asRecord(out.scene);
  if (mesh) out.mesh = fitToBudget(mesh, ["surfaces", "materials"], RESULT_TARGET_BYTES - 600);
  if (scene) out.scene = fitToBudget(scene, ["nodes", "meshes"], RESULT_TARGET_BYTES - 600);
  return trimProps(out, RESULT_TARGET_BYTES);
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Drop trailing props until the result fits; declare the cut. */
function trimProps(out: JsonRecord, target: number): JsonRecord {
  const props = asRecord(out.props);
  if (!props || bytes(out) <= target) return out;
  const keys = Object.keys(props);
  const kept = (n: number) => Object.fromEntries(keys.slice(0, n).map((key) => [key, props[key]]));
  let n = keys.length;
  while (n > 0 && bytes({ ...out, props: kept(n) }) > target) n--;
  return { ...out, props: kept(n), truncated: { ...(asRecord(out.truncated) ?? {}), props: { shown: n, total: keys.length } } };
}

export function buildInspectResourceScript(args: { path: string }): string {
  return INSPECT_RESOURCE_PROBE_SOURCE.split(INSPECT_RESOURCE_ARGS_TOKEN).join(`"${encodeScriptArgs(args)}"`);
}

/** The probe source with its placeholder, for tests. */
export function inspectResourceProbeTemplate(): string {
  return INSPECT_RESOURCE_PROBE_SOURCE;
}

// Tabs are significant: GDScript indentation. String.raw keeps backslashes
// literal; the source never contains a template placeholder.
const INSPECT_RESOURCE_PROBE_SOURCE = String.raw`@tool
extends RefCounted

const ARGS_B64 = __SUMMER_RESOURCE_ARGS__
const MAX_SURFACES = 48
const MAX_PROPS = 80
const MAX_NODES = 40
const MAX_SCENE_MESHES = 24
const MAX_VALUE_CHARS = 160
const PRIMITIVES = ["points", "lines", "line_strip", "triangles", "triangle_strip"]


func run(_ctx):
	var args = JSON.parse_string(Marshalls.base64_to_utf8(ARGS_B64))
	if typeof(args) != TYPE_DICTIONARY:
		return _fail("bad_args", "resource probe arguments did not parse")
	var path = String(args.get("path", ""))
	if not ResourceLoader.exists(path):
		return _fail("resource_not_found", "No resource at " + path)
	var res = ResourceLoader.load(path)
	if res == null:
		return _fail("resource_load_failed", "ResourceLoader could not load " + path)
	var out = {"ok": true, "path": path, "resource_type": res.get_class()}
	if String(res.resource_name) != "":
		out["resource_name"] = String(res.resource_name)
	if res.get_script() != null:
		out["script"] = String(res.get_script().resource_path)
	if res is Mesh:
		out["mesh"] = _mesh(res)
	elif res is PackedScene:
		out["scene"] = _scene(res)
		out["next"] = "summer_inspect_asset measures this scene (AABB, origin, planes, ports, anchors, collision); summer_inspect_resource on one of its mesh paths lists that mesh's surfaces and materials"
		return out
	elif res is Texture2D:
		out["texture"] = {"width": res.get_width(), "height": res.get_height()}
	var pr = _props(res)
	out["props"] = pr["props"]
	out["props_at_default"] = pr["defaults"]
	if pr["cut"] > 0:
		out["props_cut"] = pr["cut"]
	return out


func _fail(reason, message):
	return {"ok": false, "failure_reason": reason, "error": message}


func _v3(v):
	return [snappedf(v.x, 0.0001), snappedf(v.y, 0.0001), snappedf(v.z, 0.0001)]


func _ref(r):
	if r == null:
		return null
	var rec = {"class": r.get_class()}
	var p = String(r.resource_path)
	if p != "" and not p.contains("::"):
		rec["path"] = p
	else:
		rec["embedded"] = true
	if String(r.resource_name) != "":
		rec["name"] = String(r.resource_name)
	return rec


func _material(mat):
	if mat == null:
		return null
	var rec = _ref(mat)
	if mat is BaseMaterial3D:
		rec["albedo_color"] = var_to_str(mat.albedo_color)
		if mat.albedo_texture != null:
			rec["albedo_texture"] = _ref(mat.albedo_texture)
		rec["transparency"] = int(mat.transparency)
		rec["cull_mode"] = int(mat.cull_mode)
	elif mat is ShaderMaterial and mat.shader != null:
		rec["shader"] = _ref(mat.shader)
	return rec


func _format(f):
	var names = []
	var flags = [[Mesh.ARRAY_FORMAT_NORMAL, "normal"], [Mesh.ARRAY_FORMAT_TANGENT, "tangent"], [Mesh.ARRAY_FORMAT_COLOR, "color"], [Mesh.ARRAY_FORMAT_TEX_UV, "uv"], [Mesh.ARRAY_FORMAT_TEX_UV2, "uv2"], [Mesh.ARRAY_FORMAT_BONES, "bones"], [Mesh.ARRAY_FORMAT_WEIGHTS, "weights"], [Mesh.ARRAY_FORMAT_INDEX, "index"]]
	for fl in flags:
		if (int(f) & int(fl[0])) != 0:
			names.append(fl[1])
	return names


func _mesh(mesh):
	var bb = mesh.get_aabb()
	var out = {"aabb": {"min": _v3(bb.position), "max": _v3(bb.end), "size": _v3(bb.size)}}
	var count = mesh.get_surface_count()
	out["surface_count"] = count
	var surfaces = []
	var materials = []
	var seen = {}
	var tris = 0
	var verts_total = 0
	for s in range(count):
		var rec = {"index": s}
		var prim = Mesh.PRIMITIVE_TRIANGLES
		var vc = 0
		var ic = 0
		if mesh is ArrayMesh:
			prim = mesh.surface_get_primitive_type(s)
			vc = mesh.surface_get_array_len(s)
			ic = mesh.surface_get_array_index_len(s)
			if String(mesh.surface_get_name(s)) != "":
				rec["name"] = String(mesh.surface_get_name(s))
			rec["attributes"] = _format(mesh.surface_get_format(s))
		else:
			var arr = mesh.surface_get_arrays(s)
			if arr.size() > Mesh.ARRAY_INDEX:
				var va = arr[Mesh.ARRAY_VERTEX]
				var ia = arr[Mesh.ARRAY_INDEX]
				vc = va.size() if va != null else 0
				ic = ia.size() if ia != null else 0
		rec["primitive"] = PRIMITIVES[prim] if prim >= 0 and prim < PRIMITIVES.size() else str(prim)
		rec["vertices"] = vc
		rec["indices"] = ic
		var n = ic if ic > 0 else vc
		var t = 0
		if prim == Mesh.PRIMITIVE_TRIANGLES:
			t = floori(n / 3.0)
		elif prim == Mesh.PRIMITIVE_TRIANGLE_STRIP:
			t = maxi(n - 2, 0)
		rec["triangles"] = t
		tris += t
		verts_total += vc
		var mat = mesh.surface_get_material(s)
		rec["material"] = _material(mat)
		if mat != null:
			var key = String(mat.resource_path) if String(mat.resource_path) != "" else str(mat.get_instance_id())
			if not seen.has(key):
				seen[key] = true
				materials.append(_material(mat))
		if surfaces.size() < MAX_SURFACES:
			surfaces.append(rec)
	out["surfaces"] = surfaces
	if count > surfaces.size():
		out["surfaces_cut"] = count - surfaces.size()
	out["triangles"] = tris
	out["vertices"] = verts_total
	out["materials"] = materials
	if mesh is ArrayMesh:
		out["blend_shapes"] = mesh.get_blend_shape_count()
	return out


func _scene(ps):
	var st = ps.get_state()
	var n = st.get_node_count()
	var nodes = []
	var meshes = []
	var seen = {}
	var mesh_nodes = 0
	for i in range(n):
		var rec = {"path": String(st.get_node_path(i)), "type": String(st.get_node_type(i))}
		var inst = st.get_node_instance(i)
		if inst != null:
			rec["instance"] = String(inst.resource_path)
		for k in range(st.get_node_property_count(i)):
			if String(st.get_node_property_name(i, k)) != "mesh":
				continue
			var m = st.get_node_property_value(i, k)
			if not (m is Mesh):
				continue
			mesh_nodes += 1
			var mref = _ref(m)
			rec["mesh"] = mref
			var key = String(m.resource_path) if String(m.resource_path) != "" else str(m.get_instance_id())
			if not seen.has(key) and meshes.size() < MAX_SCENE_MESHES:
				seen[key] = true
				var bb = m.get_aabb()
				var mrec = mref.duplicate()
				mrec["surfaces"] = m.get_surface_count()
				mrec["aabb_size"] = _v3(bb.size)
				meshes.append(mrec)
		if nodes.size() < MAX_NODES:
			nodes.append(rec)
	var out = {"node_count": n, "root_type": String(st.get_node_type(0)) if n > 0 else "", "nodes": nodes, "mesh_nodes": mesh_nodes, "meshes": meshes}
	if n > nodes.size():
		out["nodes_cut"] = n - nodes.size()
	return out


func _same(a, b):
	if typeof(a) != typeof(b):
		return false
	return a == b


func _value(v):
	var t = typeof(v)
	if t == TYPE_NIL or t == TYPE_BOOL or t == TYPE_INT or t == TYPE_FLOAT or t == TYPE_STRING or t == TYPE_STRING_NAME:
		return v if t != TYPE_STRING_NAME else String(v)
	if t == TYPE_OBJECT:
		if v is Resource:
			return _ref(v)
		return v.get_class() if v != null else null
	if t >= TYPE_PACKED_BYTE_ARRAY:
		return type_string(t) + "(" + str(v.size()) + " items)"
	var s = var_to_str(v)
	if s.length() > MAX_VALUE_CHARS:
		s = s.substr(0, MAX_VALUE_CHARS) + "..."
	return s


func _props(res):
	var props = {}
	var defaults = 0
	var cut = 0
	var cls = res.get_class()
	var builtin = res.get_script() == null
	var skip = PROPERTY_USAGE_GROUP | PROPERTY_USAGE_CATEGORY | PROPERTY_USAGE_SUBGROUP
	for p in res.get_property_list():
		var usage = int(p["usage"])
		if (usage & PROPERTY_USAGE_EDITOR) == 0 or (usage & skip) != 0:
			continue
		var name = String(p["name"])
		if name == "resource_path" or name == "resource_name" or name == "script":
			continue
		var v = res.get(name)
		if builtin and _same(v, ClassDB.class_get_property_default_value(cls, name)):
			defaults += 1
			continue
		if props.size() >= MAX_PROPS:
			cut += 1
			continue
		props[name] = _value(v)
	return {"props": props, "defaults": defaults, "cut": cut}
`;
