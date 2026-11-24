import { asRecord, type JsonRecord } from "../util/json.js";
import { extractOpError } from "./engine-receipt.js";
import { buildRunSceneScriptOp } from "./scene-script.js";
import { decodeGodotString, isAtOrBelow, type ParsedTscn } from "./tscn.js";

export interface NodeReference {
  owner: string;
  key: string;
}

function referencedPath(owner: string, raw: string): string | undefined {
  const match = /^NodePath\("((?:[^"\\]|\\.)*)"\)$/.exec(raw.trim());
  if (!match) return undefined;
  const relative = decodeGodotString(match[1]!);
  if (!relative || relative.startsWith("/") || relative.includes(":")) return undefined;
  const parts = owner === "." ? [] : owner.split("/");
  for (const part of relative.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/") || ".";
}

export function incomingNodeReferences(parsed: ParsedTscn, target: string, keptPaths: string[]): NodeReference[] {
  return parsed.nodes.flatMap((node) => {
    if (node.path === target) return [];
    if (isAtOrBelow(node.path, target) && !keptPaths.some((path) => isAtOrBelow(node.path, path))) return [];
    return node.props
      .filter((prop) => node.nodePaths?.includes(prop.key) && referencedPath(node.path, prop.value) === target)
      .map((prop) => ({ owner: node.path, key: prop.key }));
  });
}

export function missingNodeReferences(parsed: ParsedTscn, target: string, refs: NodeReference[]): NodeReference[] {
  return refs.filter((ref) => {
    const owner = parsed.nodes.find((node) => node.path === ref.owner);
    const prop = owner?.props.find((item) => item.key === ref.key);
    return !owner?.nodePaths?.includes(ref.key) || !prop || referencedPath(ref.owner, prop.value) !== target;
  });
}

export function rebindNodeReferencesScript(scenePath: string, oldPath: string, newPath: string, refs: NodeReference[]): string {
  const lit = JSON.stringify;
  return `const TARGET_SCENE = ${lit(scenePath)}
const OLD_PATH = ${lit(oldPath)}
const NEW_PATH = ${lit(newPath)}
const REFERENCES = ${lit(refs)}

func run(ctx):
	var root = ctx.get_scene_root()
	if root == null or root.scene_file_path != TARGET_SCENE:
		return {"ok":false,"unchanged":true,"error":"The target scene is not active"}
	var old = root.get_node_or_null(NodePath(OLD_PATH))
	var replacement = root.get_node_or_null(NodePath(NEW_PATH))
	if old == null or replacement == null:
		return {"ok":false,"unchanged":true,"error":"The old or replacement node is missing"}
	if not EditorInterface.has_method("get_editor_undo_redo"):
		return {"ok":false,"unchanged":true,"error":"Node-reference preservation requires editor undo support; update the editor"}
	var history = EditorInterface.get_editor_undo_redo()
	if history == null:
		return {"ok":false,"unchanged":true,"error":"Editor property undo history is unavailable"}
	var bindings = []
	for ref in REFERENCES:
		var holder = root.get_node_or_null(NodePath(ref.owner))
		if holder == null or holder.get(ref.key) != old:
			return {"ok":false,"unchanged":true,"error":"A saved Node reference no longer points to the old node","reference":ref}
		var info = {}
		for prop in holder.get_property_list():
			if prop.name == ref.key: info = prop
		if info.get("type",TYPE_NIL) != TYPE_OBJECT or not (int(info.get("usage",0)) & PROPERTY_USAGE_STORAGE):
			return {"ok":false,"unchanged":true,"error":"The reference is not a stored Object property","reference":ref}
		var expected = str(info.get("class_name",""))
		var compatible = expected == "" or replacement.is_class(expected)
		if not compatible and not ClassDB.class_exists(expected):
			for entry in ProjectSettings.get_global_class_list():
				if entry["class"] == expected:
					compatible = is_instance_of(replacement,load(entry.path))
		if not compatible:
			return {"ok":false,"unchanged":true,"error":"The replacement is incompatible with an exported Node reference","reference":ref,"expected":expected}
		bindings.append({"holder":holder,"key":ref.key})
	var attempted = []
	for binding in bindings:
		attempted.append(binding)
		binding.holder.set(binding.key,replacement)
		if binding.holder.get(binding.key) != replacement:
			for restore in attempted: restore.holder.set(restore.key,old)
			var unchanged = true
			for restore in bindings: unchanged = unchanged and restore.holder.get(restore.key) == old
			return {"ok":false,"unchanged":unchanged,"error":"An exported Node reference rejected the replacement"}
	history.create_action("Rebind replacement Node references",UndoRedo.MERGE_DISABLE,root)
	for binding in bindings:
		history.add_do_property(binding.holder,binding.key,replacement)
		history.add_undo_property(binding.holder,binding.key,old)
	history.commit_action(false)
	return {"ok":true,"rebound":REFERENCES.size()}
`;
}

export async function rebindNodeReferences(
  client: { executeIdentityBoundOps(ops: JsonRecord[], options?: JsonRecord, timeoutMs?: number): Promise<unknown> },
  scenePath: string,
  oldPath: string,
  newPath: string,
  refs: NodeReference[]
): Promise<JsonRecord> {
  const { op, timeoutMs } = buildRunSceneScriptOp({
    source: rebindNodeReferencesScript(scenePath, oldPath, newPath, refs),
    checkpoint: false,
    undo: "none",
    max_seconds: 10,
  });
  const receipt = await client.executeIdentityBoundOps([op], { scenePath }, timeoutMs);
  const error = extractOpError(receipt);
  const rows = asRecord(receipt)?.results;
  const result = Array.isArray(rows) ? asRecord(asRecord(rows[0])?.result) : null;
  if (error || !result) return { ok: false, unchanged: false, error: error ?? "The Node-reference probe returned no result" };
  return result;
}
