/** Native Node3D inheritance shared by spatial readers, including inactive tabs. */
import { missingEngineOpResult, type CapabilityAdvertisingClient } from "../capability-skew.js";
import { asRecord } from "../util/json.js";
import { extractOpError } from "./engine-receipt.js";
import { parseGodotVector3, type Vec3 } from "./placement-math.js";
import { buildRunSceneScriptOp } from "./scene-script.js";

// Transform inheritance and visibility both stop at a non-Node3D parent.
// top_level stops transform inheritance, but keeps Node3D visibility inheritance.
export const SCENE_SPACE_GDSCRIPT = String.raw`
# Compose only as far as root, including its local transform. Asset reads use this frame even in a live tree.
func _xf(node, root):
	var chain = []
	var cur = node
	while cur is Node3D:
		chain.push_front(cur)
		if cur == root or cur.top_level:
			break
		cur = cur.get_parent()
	var t = Transform3D.IDENTITY
	for n in chain:
		t = t * n.transform
		if n.is_scale_disabled():
			t.basis = t.basis.orthonormalized()
	return t


func _world_xf(node, root):
	if node is Node3D and node.is_inside_tree():
		return node.global_transform
	return _xf(node, root)


func _parent_xf(node, root):
	if node is Node3D and (node != root or node.is_inside_tree()):
		var parent = node.get_parent_node_3d()
		if parent != null:
			return _world_xf(parent, root)
	return Transform3D.IDENTITY


func _visible(node, root):
	var cur = node
	while cur is Node3D:
		if not cur.visible:
			return false
		if cur == root:
			break
		cur = cur.get_parent()
	return true


func _inherits_3d(node, ancestor):
	var cur = node
	while cur != ancestor:
		if not (cur is Node3D) or cur.top_level:
			return false
		cur = cur.get_parent()
	return ancestor is Node3D
`;

// GDScript scalars retain the precision of the JSON numbers; Vector3 can round them.
export const REQUEST_DISTANCE_GDSCRIPT = String.raw`
func _distance_to_request(actual: Vector3, requested, origin := Vector3.ZERO):
	var dx = (actual.x - origin.x) - requested[0]
	var dy = (actual.y - origin.y) - requested[1]
	var dz = (actual.z - origin.z) - requested[2]
	return sqrt(dx * dx + dy * dy + dz * dz)
`;

export const PARENT_TRANSLATION_GDSCRIPT = String.raw`
${REQUEST_DISTANCE_GDSCRIPT}

# Author the same Vector3 that the editor will store and check its original requested movement.
func _translated_position_literal(parent: Transform3D, local: Vector3, requested):
	var det = parent.basis.determinant()
	if not is_finite(det) or det == 0.0:
		return null
	var before = parent * local
	var inverse = parent.basis.inverse()
	var delta = Vector3(requested[0], requested[1], requested[2])
	# Adding a long displacement to an opposite offset can erase a small, representable final gap.
	# Form an alternative parent-relative endpoint with scalar components before converting to Vector3.
	var end_x = (before.x - parent.origin.x) + requested[0]
	var end_y = (before.y - parent.origin.y) + requested[1]
	var end_z = (before.z - parent.origin.z) + requested[2]
	var relative_end = Vector3(end_x, end_y, end_z)
	for next in [local + inverse * delta, inverse * relative_end]:
		if not next.is_finite():
			continue
		var literal = var_to_str(next)
		var stored: Vector3 = str_to_var(literal)
		var after = parent * stored
		if after.is_finite() and _distance_to_request(after, requested, before) <= 0.0001:
			return literal
	return null
`;

interface TransformClient extends CapabilityAdvertisingClient {
  executeOps?(ops: Record<string, unknown>[], options?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  executeIdentityBoundOps?(ops: Record<string, unknown>[], options?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

type Translation = { literal: string; value: Vec3 };
type TransformError = { error: string; failureReason?: string };

export interface SceneNodeTransform {
  origin: Vec3;
  position: Vec3;
  transform: string;
  /** Native Vector3 literal after Godot verified the requested world movement. */
  translation?: Translation;
  independentGeometry: string[];
}

interface InspectedTransform extends SceneNodeTransform {
  worldOrigin: string;
  local: {
    position: string;
    rotation_degrees: string;
    scale: string;
    rotation_order: number;
    transform: string;
  };
}

export function buildSceneTransformScript(path: string, checkGeometry = false, worldDelta?: Vec3): string {
  const data = Buffer.from(JSON.stringify({ path, check_geometry: checkGeometry, world_delta: worldDelta }), "utf8").toString("base64");
  return String.raw`@tool
extends RefCounted
${SCENE_SPACE_GDSCRIPT}
${PARENT_TRANSLATION_GDSCRIPT}

func run(ctx):
	var args = JSON.parse_string(Marshalls.base64_to_utf8("${data}"))
	var root = ctx.get_scene_root()
	if root == null:
		return {"ok": false, "error": "no edited scene"}
	var path = String(args["path"])
	var node = root if path == "." or path == "./" else root.get_node_or_null(NodePath(path))
	if not (node is Node3D):
		return {"ok": false, "error": "the target is not a Node3D in the edited scene"}
	var xf = _world_xf(node, root)
	var independent = []
	if args["check_geometry"]:
		var stack = [node]
		while not stack.is_empty():
			var n = stack.pop_back()
			if n is GeometryInstance3D and _visible(n, root) and not _inherits_3d(n, node):
				independent.append(String(root.get_path_to(n)))
			stack.append_array(n.get_children())
	var result = {"ok": true, "origin": [xf.origin.x, xf.origin.y, xf.origin.z], "position": [node.position.x, node.position.y, node.position.z], "transform": var_to_str(xf), "independent_geometry": independent}
	if args.has("world_delta"):
		var next = _translated_position_literal(_parent_xf(node, root), node.position, args["world_delta"])
		if next == null:
			return {"ok": false, "failure_reason": "translation_not_representable", "error": "The parent transform cannot reproduce the requested world movement at engine precision."}
		result["translated_position"] = next
	else:
		result["world_origin"] = var_to_str(xf.origin)
		result["local"] = {
			"position": var_to_str(node.position),
			"rotation_degrees": var_to_str(node.rotation_degrees),
			"scale": var_to_str(node.scale),
			"rotation_order": node.rotation_order,
			"transform": var_to_str(node.transform),
		}
	return result
`;
}

/** Exact scene-local world transform; no rounded Euler reconstruction. */
export function readSceneNodeTransform(client: TransformClient, path: string, scenePath: string, checkGeometry: boolean, worldDelta: Vec3):
  Promise<(SceneNodeTransform & { translation: Translation }) | TransformError>;
export function readSceneNodeTransform(client: TransformClient, path: string, scenePath?: string, checkGeometry?: boolean):
  Promise<InspectedTransform | TransformError>;
export async function readSceneNodeTransform(client: TransformClient, path: string, scenePath?: string, checkGeometry = false, worldDelta?: Vec3):
  Promise<SceneNodeTransform | InspectedTransform | TransformError> {
  const missing = missingEngineOpResult(client, "RunSceneScript", "read the node's native transform with RunSceneScript");
  if (missing) return { error: missing.error };
  const execute = client.executeIdentityBoundOps ?? client.executeOps;
  if (!execute) return { error: "this client cannot read native scene transforms" };
  const { op, timeoutMs } = buildRunSceneScriptOp({ source: buildSceneTransformScript(path, checkGeometry, worldDelta), max_seconds: 10, undo: "none", checkpoint: false });
  try {
    const receipt = await execute.call(client, [op], scenePath ? { scenePath } : undefined, timeoutMs);
    const failure = extractOpError(receipt);
    if (failure) return { error: failure };
    const results = asRecord(receipt)?.results;
    const row = asRecord(Array.isArray(results) ? results.find((r) => asRecord(r)?.op === "RunSceneScript") : null);
    const result = asRecord(row?.result);
    if (row?.ok !== true || result?.ok !== true) {
      return {
        error: String(result?.error ?? row?.error ?? "native transform read returned no result"),
        ...(typeof result?.failure_reason === "string" ? { failureReason: result.failure_reason } : {}),
      };
    }
    const vector = (value: unknown): Vec3 | null =>
      Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number" && Number.isFinite(n)) ? value as Vec3 : null;
    const origin = vector(result.origin);
    const position = vector(result.position);
    if (!origin || !position || typeof result.transform !== "string") return { error: "native transform read returned incomplete data" };
    const base = { origin, position, transform: result.transform, independentGeometry: Array.isArray(result.independent_geometry) ? result.independent_geometry.map(String) : [] };
    if (worldDelta) {
      const literal = result.translated_position;
      const value = typeof literal === "string" ? parseGodotVector3(literal) : null;
      if (typeof literal !== "string" || !value) return { error: "native transform read returned no translated position" };
      return { ...base, translation: { literal, value } };
    }
    const local = asRecord(result.local);
    if (!local || typeof local.position !== "string" || typeof local.rotation_degrees !== "string" ||
        typeof local.scale !== "string" || typeof local.rotation_order !== "number" || typeof local.transform !== "string" ||
        typeof result.world_origin !== "string") return { error: "native transform read returned incomplete pose fields" };
    return { ...base, worldOrigin: result.world_origin, local: {
      position: local.position, rotation_degrees: local.rotation_degrees, scale: local.scale,
      rotation_order: local.rotation_order, transform: local.transform,
    } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
