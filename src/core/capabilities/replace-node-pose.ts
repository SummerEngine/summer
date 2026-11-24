import { extractOpError } from "./engine-receipt.js";
import { buildRunSceneScriptOp } from "./scene-script.js";
import { asRecord, type JsonRecord } from "../util/json.js";

export type PoseOverride = { key: "top_level"; value: boolean } | { key: "transform"; value: string };

/** Both roots still exist under the same parent. Godot resolves the authored,
 * inherited and default components. A prefab using non-storage pose keys
 * can require a pinned override to retain the restored pose when saved. */
export async function prepareReplacementPose(
  client: { executeIdentityBoundOps(ops: JsonRecord[], options?: JsonRecord, timeoutMs?: number): Promise<unknown> },
  scenePath: string,
  oldPath: string,
  newPath: string,
  propsCopied: string[]
): Promise<{ overrides: PoseOverride[] } | { error: string }> {
  const source = `const TARGET_SCENE := ${JSON.stringify(scenePath)}
const POSE_SOURCE := ${JSON.stringify(oldPath)}
const POSE_DESTINATION := ${JSON.stringify(newPath)}
const COPIED_PROPERTIES := ${JSON.stringify(propsCopied)}

# Godot stores Node3D poses as a transform, and Node2D poses as components.
# A hand-authored prefab may set the other representation. PackedScene then
# compares an override with the class default when deciding whether to save it.
func uses_pose_aliases(node):
	if node.scene_file_path.is_empty():
		return false
	var aliases = ["position", "rotation", "rotation_degrees", "quaternion", "basis", "scale"] if node is Node3D else ["transform", "rotation_degrees"]
	var prefab = load(node.scene_file_path)
	while prefab is PackedScene:
		var state = prefab.get_state()
		if state.get_node_count() == 0:
			break
		for index in state.get_node_property_count(0):
			if state.get_node_property_name(0, index) in aliases:
				return true
		prefab = state.get_node_instance(0)
	return false

func run(ctx):
	var root = ctx.get_scene_root()
	if root == null or root.scene_file_path != TARGET_SCENE:
		return {"error": "The requested scene is not active"}
	var old = root.get_node_or_null(NodePath(POSE_SOURCE))
	var replacement = root.get_node_or_null(NodePath(POSE_DESTINATION))
	if old == null or replacement == null:
		return {"error": "The original or temporary replacement node is missing"}
	if not ((old is Node3D and replacement is Node3D) or (old is Node2D and replacement is Node2D)):
		return {"compared": true}
	var result = {"compared": true}
	if old.top_level != replacement.top_level:
		result.top_level = old.top_level
	if result.has("top_level") or old.transform != replacement.transform:
		result.transform = var_to_str(old.transform)
	var stored = ["transform"] if old is Node3D else ["position", "rotation", "scale", "skew"]
	var required = []
	for key in stored:
		if old.get(key) != replacement.get(key) or key in COPIED_PROPERTIES:
			required.append(key)
	if not required.is_empty() and uses_pose_aliases(replacement):
		var pinned = replacement.get_meta("_edit_pinned_properties_", [])
		var additions = required.filter(func(key): return not pinned.has(key))
		if not additions.is_empty():
			var history = EditorInterface.get_editor_undo_redo()
			if history == null or not replacement.has_method("_set_property_pinned"):
				return {"error": "The editor cannot pin the required prefab pose overrides"}
			history.create_action("Preserve replacement pose on save", UndoRedo.MERGE_DISABLE, root)
			for key in additions:
				history.add_do_method(replacement, "_set_property_pinned", key, true)
				history.add_undo_method(replacement, "_set_property_pinned", key, false)
			history.commit_action()
	return result
`;
  const { op, timeoutMs } = buildRunSceneScriptOp({ source, checkpoint: false, undo: "none", max_seconds: 5 });
  let receipt: unknown;
  try {
    receipt = await client.executeIdentityBoundOps([op], { scenePath }, timeoutMs);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const results = asRecord(receipt)?.results;
  const result = Array.isArray(results) ? asRecord(asRecord(results[0])?.result) : null;
  const error = extractOpError(receipt);
  if (error || result?.compared !== true) return { error: error ?? String(result?.error ?? "Godot returned no pose comparison") };
  const overrides: PoseOverride[] = [];
  if (typeof result.top_level === "boolean") overrides.push({ key: "top_level", value: result.top_level });
  if (typeof result.transform === "string") overrides.push({ key: "transform", value: result.transform });
  return { overrides };
}
