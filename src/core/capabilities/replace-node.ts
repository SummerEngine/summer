/**
 * replace-node — ONE implementation of `summer_replace_node` for both faces
 * (src/mcp/tools/scene-tools.ts and tool-dispatch.ts), built from ops whose
 * results persist, and verified against the SAVED scene file.
 *
 * Why not the engine's ReplaceNode op for scenes: SceneOps::replace_node
 * (engine modules/1summer_engine/editor/ops/scene_ops.cpp, scene branch and
 * the async _finish_replace_node) instantiates the new PackedScene and hands
 * it to SceneTreeDock::replace_node — the editor's "Change Type" path — which
 * ends in Node::replace_by (scene/main/node.cpp). replace_by finishes with
 * `p_node->set_scene_file_path(get_scene_file_path())`: the new instance is
 * stamped with the OLD node's scene path. The editor draws the new subtree,
 * the receipt says ok, and SaveScene packs the node as
 * `instance=ExtResource(<old scene>)` with a fresh unique_id — the change is
 * gone on reload. A plain
 * node replaced by a scene loses the other way (scene_file_path cleared, the
 * instance's children owned by the instance root and dropped on save), and a
 * type change of an instanced node stays an instance of the old scene.
 *
 * So the scene branch (and a type change of an instanced node) runs as:
 *   0. SaveScene, so the file on disk is exactly the editor state;
 *   1. read + parse the saved .tscn (which children the scene added under the
 *      node, which properties it overrides, its sibling index);
 *   2. InstantiateScene / AddNode at the same parent under a temporary name;
 *   3. SetProp every copyable property override (transform, visibility, ...);
 *   4. ReparentNode each scene-added child onto the new node (local
 *      transforms kept), then re-parent each deeper scene-added descendant in
 *      place — the engine's ReparentNode re-owns only the node it moves, and
 *      remove_child clears the owner of everything below it;
 *   5. MoveNode to the old sibling index, RemoveNode the old node, SetProp
 *      name back to the original name;
 *   6. SaveScene, read the file back and check it: the node at the path
 *      instances the new scene (or has the new type), the parent and every
 *      scene-added descendant are there. persisted:false is reported as a
 *      failure, never as success.
 * A type change of a plain node keeps the engine's ReplaceNode (it persists:
 * replace_by copies an empty scene path) and gets the same read-back check.
 */
import { z } from "zod";
import { resolveSingleOnlyOps, missingEngineOpResult, type CapabilityAdvertisingClient } from "../capability-skew.js";
import { ToolInputError } from "../tool-errors.js";
import { asRecord, type JsonRecord } from "../util/json.js";
import { executeOpsChunked, safeProjectPath, sceneMutationOps } from "./engine-ops.js";
import { extractOpError } from "./engine-receipt.js";
import { REPLACE_NODE_FALLBACK } from "./engine-fallbacks.js";
import { reownInPlaceOps } from "./scene-batch.js";
import { isReadbackFailure, readSavedScene as readSceneFile, readbackFailure, type ReadbackFailure } from "./scene-readback.js";
import {
  decodeGodotString,
  extResourceId,
  findTscnNode,
  isAtOrBelow,
  isSceneCreatedNode,
  joinNodePath,
  normalizeNodePath,
  normalizeResPath,
  quotedLiteral,
  type ParsedTscn,
  type TscnNode,
  type TscnProp,
} from "./tscn.js";

// Mirrors library/tools/replace-node/resource.yaml input_schema (parity-tested).
export const replaceNodeInputShape = {
  scenePath: z.string().describe("Target scene path, e.g. 'res://main.tscn'"),
  path: z.string().describe("Node path to replace, e.g. './House3/Front/G_f2_door'"),
  type: z.string().optional().describe("New node type, e.g. 'RigidBody3D'. Give exactly one of type or scene."),
  scene: z
    .string()
    .optional()
    .describe("Scene or model to replace with, e.g. 'res://kit/wall_door_02.tscn'. Give exactly one of type or scene."),
};

export const replaceNodeInputSchema = z.object(replaceNodeInputShape).strict();
export type ReplaceNodeArgs = z.infer<typeof replaceNodeInputSchema>;

/** The engine reads the replacement needs — a structural subset of
 *  EngineApiClient so tests can hand in a fake engine. */
export interface ReplaceNodeClient extends CapabilityAdvertisingClient {
  executeIdentityBoundOps(
    ops: Record<string, unknown>[],
    options?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<unknown>;
  readProjectFile(path: string, maxBytes?: number): Promise<unknown>;
  getSceneState(
    scenePath?: string,
    options?: { depth?: number; limit?: number; root?: string }
  ): Promise<unknown>;
}

type Failure = ReadbackFailure;
const failure = readbackFailure;
const isFailure = isReadbackFailure;

const TOO_LARGE_HINT =
  "Replace by hand: summer_remove_node, then summer_instantiate_scene with the same parent and name, then summer_set_prop for the transform.";

const readSavedScene = (client: ReplaceNodeClient, scenePath: string) => readSceneFile(client, scenePath, TOO_LARGE_HINT);

/** Per-op results of a (possibly chunked) receipt. */
function opResults(receipt: unknown): JsonRecord[] {
  const results = asRecord(receipt)?.results;
  return Array.isArray(results) ? (results.filter((r) => asRecord(r)) as JsonRecord[]) : [];
}

/** Live child names of `nodePath`, in tree order, from a targeted scene read
 *  rooted at that node; null when the engine cannot answer (an older build
 *  ignores `root` and answers the scene root instead — detected by path). */
async function readLiveChildren(client: ReplaceNodeClient, scenePath: string, nodePath: string): Promise<string[] | null> {
  try {
    const state = asRecord(await client.getSceneState(scenePath, { root: nodePath, depth: 1, limit: 100_000 }));
    if (!state || state.ok === false) return null;
    const data = asRecord(state.data);
    if (!data || normalizeNodePath(String(data.path ?? "")) !== nodePath) return null;
    if (!Array.isArray(data.children)) return null;
    return data.children.map((child) => String(asRecord(child)?.name ?? ""));
  } catch {
    return null;
  }
}

/** A property override as a SetProp value, or why it cannot be copied. */
export function propSetValue(prop: TscnProp, parsed: ParsedTscn): { value: string | number | boolean } | { reason: string } {
  const raw = prop.value.trim();
  if (/\bSubResource\(/.test(raw)) {
    return { reason: "scene-local sub_resource: it cannot be copied by reference; set it again on the new node" };
  }
  const ext = extResourceId(raw);
  if (ext !== undefined) {
    const path = parsed.extResources.get(ext)?.path;
    return path ? { value: path } : { reason: `ext_resource ${ext} is not listed in the scene file` };
  }
  if (/\bExtResource\(/.test(raw)) return { reason: "the value embeds resource references; set it again on the new node" };
  if (raw === "true") return { value: true };
  if (raw === "false") return { value: false };
  if (/^-?\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i.test(raw)) return { value: Number(raw) };
  const text = quotedLiteral(raw);
  if (text !== undefined) return { value: text };
  const nodePath = /^NodePath\("((?:[^"\\]|\\.)*)"\)$/.exec(raw);
  if (nodePath) return { value: decodeGodotString(nodePath[1]!) };
  // Godot literal text (Transform3D(...), Vector3(...), Color(...), arrays,
  // dictionaries): SetProp parses it with str_to_var.
  return { value: raw };
}

function tempName(base: string, taken: Set<string>): string {
  const stem = `${base}_SummerReplace`;
  let name = stem;
  for (let i = 2; taken.has(name); i++) name = `${stem}${i}`;
  return name;
}

function siblingIndexInFile(parsed: ParsedTscn, node: TscnNode): number {
  return parsed.nodes.filter((n) => n.parent === node.parent && n.order < node.order).length;
}

function describeNode(node: TscnNode): string {
  if (node.instancePath) return node.instancePath;
  if (node.instance) return `ExtResource("${node.instance}")`;
  return `type ${node.type ?? "?"}`;
}

interface Plan {
  scenePath: string;
  target: string;
  parent: string | null;
  scene?: string;
  type?: string;
  /** Scene-created descendants of the old node that must survive. */
  keptNodes: TscnNode[];
  oldTransform?: string;
  fileIndex: number;
}

interface Verification {
  persisted: boolean;
  problems: string[];
  warnings: string[];
  saved: JsonRecord;
}

function verifyAgainstSaved(after: ParsedTscn, plan: Plan): Verification {
  const problems: string[] = [];
  const warnings: string[] = [];
  const node = findTscnNode(after, plan.target);
  const saved: JsonRecord = { read_back: plan.scenePath };
  if (!node) {
    problems.push(`the saved file has no node at ${plan.target}`);
  } else {
    saved.node = describeNode(node);
    saved.parent = node.parent;
    if (plan.scene !== undefined) {
      if (!node.instance) {
        problems.push(`the saved node is a plain ${node.type ?? "node"}, not an instance of ${plan.scene}`);
      } else if (normalizeResPath(node.instancePath ?? "") !== normalizeResPath(plan.scene)) {
        problems.push(`the saved node still instances ${describeNode(node)}, not ${plan.scene}`);
      }
    } else if (node.instance) {
      problems.push(`the saved node is still an instance of ${describeNode(node)}`);
    } else if (node.type !== plan.type) {
      problems.push(`the saved node has type ${node.type ?? "?"}, not ${plan.type}`);
    }
    if (node.parent !== plan.parent) {
      problems.push(`the saved node's parent is ${node.parent ?? "(none)"}, not ${plan.parent ?? "(none)"}`);
    }
    const index = siblingIndexInFile(after, node);
    saved.index = index;
    if (index !== plan.fileIndex) {
      warnings.push(`sibling order changed: index ${index} among the saved siblings, was ${plan.fileIndex}`);
    }
    if (plan.oldTransform !== undefined) {
      const now = node.props.find((p) => p.key === "transform")?.value;
      const squash = (s: string) => s.replace(/\s+/g, "");
      if (now === undefined) {
        warnings.push("the saved node lists no transform override (it now uses the new scene's own root transform); check its placement");
      } else if (squash(now) !== squash(plan.oldTransform)) {
        warnings.push(`the saved transform differs from the old one: ${now} (was ${plan.oldTransform})`);
      }
    }
  }
  const missing = plan.keptNodes
    .filter((kept) => !after.nodes.some((n) => n.path === kept.path && isSceneCreatedNode(n)))
    .map((kept) => kept.path);
  if (missing.length > 0) problems.push(`children missing from the saved file: ${missing.join(", ")}`);
  return { persisted: problems.length === 0, problems, warnings, saved };
}

function notPersistedFailure(plan: Plan, verification: Verification, extra: JsonRecord): Failure {
  return failure(
    "not_persisted",
    `summer_replace_node did NOT persist (persisted:false): ${verification.problems.join("; ")}. ` +
      `The editor may show the change, but ${plan.scenePath} on disk does not, so it reverts on reload. Do not report it as done: ` +
      "inspect the saved file (summer_read_file), then redo it with summer_remove_node + summer_instantiate_scene (same parent and name) + summer_set_prop transform.",
    { persisted: false, verified: false, scenePath: plan.scenePath, path: plan.target, verification: { ...verification.saved, problems: verification.problems, warnings: verification.warnings }, ...extra }
  );
}

/** summer_batch guard (both faces): a raw ReplaceNode with `scene` is the op
 *  that saves the OLD scene reference. Refuse it before anything is sent and
 *  point at the tool that persists. Null when the ops are fine. */
export function rawSceneReplaceRefusal(ops: ReadonlyArray<Record<string, unknown>>): string | null {
  const raw = ops.find((op) => op.op === "ReplaceNode" && typeof op.scene === "string" && op.scene.trim() !== "");
  if (!raw) return null;
  return (
    "summer_batch does not send a raw ReplaceNode with scene: on current engines it shows the new scene in the editor but saves the OLD scene reference, " +
    "so the change reverts on reload. Nothing was sent. Use summer_replace_node (it verifies the saved file), or RemoveNode + InstantiateScene."
  );
}

/**
 * Replace the node at `path` in `scenePath` with `scene` (or a node of
 * `type`) and prove the saved file holds the result.
 */
export async function replaceNodePersisted(client: ReplaceNodeClient, args: ReplaceNodeArgs): Promise<JsonRecord> {
  const scenePath = safeProjectPath(args.scenePath);
  if (!scenePath.endsWith(".tscn")) {
    throw new ToolInputError(
      "summer_replace_node verifies the result in the saved text scene, so scenePath must be a .tscn file. For a binary .scn use summer_remove_node + summer_instantiate_scene."
    );
  }
  const type = args.type?.trim() || undefined;
  const scene = args.scene?.trim() ? safeProjectPath(args.scene) : undefined;
  if ((type === undefined) === (scene === undefined)) {
    throw new ToolInputError("Give exactly one of type (a node class) or scene (a res:// scene or model path).");
  }
  if (type !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(type)) {
    throw new ToolInputError(`Invalid type "${type}": pass a plain node class name such as 'RigidBody3D'.`);
  }
  const target = normalizeNodePath(args.path);

  const singleOnly = resolveSingleOnlyOps(client);
  const send = (ops: JsonRecord[], options: JsonRecord = {}) =>
    executeOpsChunked(
      (chunk) => client.executeIdentityBoundOps(chunk, { groupUndo: true, ...options, scenePath }),
      ops,
      singleOnly
    );

  // 0. Save first: the plan is read from the file, so the file must be the editor state.
  const preSave = await send([{ op: "SaveScene" }]);
  if (extractOpError(preSave)) return asRecord(preSave) ?? { ok: false, error: "SaveScene failed" };

  // 1. Read the scene as saved.
  const before = await readSavedScene(client, scenePath);
  if (isFailure(before)) return before;
  const node = findTscnNode(before.parsed, target);
  if (!node) {
    return failure(
      "node_not_found",
      `No node at "${target}" in ${scenePath} (paths are relative to the scene root, e.g. "World/Door"). Nothing was replaced; read the hierarchy with summer_get_scene_tree.`
    );
  }

  const keptNodes = before.parsed.nodes.filter(
    (n) => n !== node && isAtOrBelow(n.path, target) && isSceneCreatedNode(n)
  );
  const plan: Plan = {
    scenePath,
    target,
    parent: node.parent,
    ...(scene !== undefined ? { scene } : {}),
    ...(type !== undefined ? { type } : {}),
    keptNodes,
    fileIndex: siblingIndexInFile(before.parsed, node),
  };
  const from = describeNode(node);

  // A type change of a plain node: the engine op persists. Verify it anyway.
  if (type !== undefined && !node.instance && !node.instancePlaceholder) {
    const receipt = await send(sceneMutationOps([{ op: "ReplaceNode", path: args.path, type }]));
    if (extractOpError(receipt)) return asRecord(receipt) ?? { ok: false, error: "ReplaceNode failed" };
    const after = await readSavedScene(client, scenePath);
    if (isFailure(after)) return { ...after, applied: true, note: "ReplaceNode and SaveScene reported success, but the saved file could not be read back to verify it." };
    const verification = verifyAgainstSaved(after.parsed, plan);
    const extra = { method: "engine_replace_node", replaced: { from, to: `type ${type}` } };
    if (!verification.persisted) return notPersistedFailure(plan, verification, extra);
    return {
      ok: true,
      persisted: true,
      verified: true,
      scenePath,
      path: target,
      ...extra,
      verification: { ...verification.saved, ...(verification.warnings.length ? { warnings: verification.warnings } : {}) },
    };
  }

  if (node.parent === null) {
    return failure(
      "root_not_supported",
      `"${target}" is the scene root. Replacing the root with ${scene ?? `type ${type}`} cannot be expressed as instantiate-and-remove; ` +
        "create a new scene instead (summer_create_scene), or change the root's own properties."
    );
  }
  const parent = node.parent;

  // Capability pre-flight for every op this path sends.
  for (const op of [scene !== undefined ? "InstantiateScene" : "AddNode", "SetProp", "ReparentNode", "MoveNode", "RemoveNode"]) {
    const missing = missingEngineOpResult(client, op, REPLACE_NODE_FALLBACK);
    if (missing) return { ...missing };
  }

  // What the new node takes over, and what cannot travel.
  const props: Array<{ key: string; value: string | number | boolean }> = [];
  const notCopied: Array<{ key: string; reason: string }> = [];
  for (const prop of node.props) {
    const converted = propSetValue(prop, before.parsed);
    if ("value" in converted) props.push({ key: prop.key, value: converted.value });
    else notCopied.push({ key: prop.key, reason: converted.reason });
  }
  const oldTransform = node.props.find((p) => p.key === "transform")?.value;
  if (oldTransform !== undefined) plan.oldTransform = oldTransform;

  const directChildren = keptNodes.filter((n) => n.parent === target);
  const deeper = keptNodes
    .filter((n) => n.parent !== target)
    .sort((a, b) => a.order - b.order)
    .map((n) => n.path);
  // Overrides of nodes the OLD instance creates (no type/instance, nearest
  // scene-created ancestor is the old node) belong to the old scene and go.
  const droppedOverrides = before.parsed.nodes
    .filter((n) => !isSceneCreatedNode(n) && isAtOrBelow(n.path, target) && n !== node)
    .filter((n) => !keptNodes.some((k) => n.path.startsWith(`${k.path}/`)))
    .map((n) => n.path);
  const editableDropped = before.parsed.editable.includes(target);
  const connections = before.parsed.connections.filter((c) => c.from === target || c.to === target);
  const notCarriedOver: JsonRecord = {
    ...(notCopied.length ? { props: notCopied } : {}),
    ...(node.groups.length ? { groups: node.groups } : {}),
    ...(connections.length
      ? { connections: connections.map((c) => `${c.from}:${c.signal} -> ${c.to}:${c.method}`) }
      : {}),
    ...(droppedOverrides.length ? { overrides_of_old_scene_nodes: droppedOverrides } : {}),
    ...(editableDropped ? { editable_children: true } : {}),
  };

  // 2. Create the replacement next to the old node under a temporary name.
  const siblingNames = new Set(before.parsed.nodes.filter((n) => n.parent === parent).map((n) => n.name));
  const liveSiblings = await readLiveChildren(client, scenePath, parent);
  for (const name of liveSiblings ?? []) siblingNames.add(name);
  const tmp = tempName(node.name, siblingNames);
  const createOp: JsonRecord = scene !== undefined
    ? { op: "InstantiateScene", parent, scene, name: tmp }
    : { op: "AddNode", parent, type: type!, name: tmp };
  const created = await send([createOp]);
  if (extractOpError(created)) {
    return { ...(asRecord(created) ?? {}), ok: false, note: `Nothing was replaced: creating the new node failed. ${scenePath} is unchanged.` };
  }
  const createdMeta = asRecord(opResults(created)[0]?.meta);
  const newPath = normalizeNodePath(typeof createdMeta?.nodePath === "string" && createdMeta.nodePath ? createdMeta.nodePath : joinNodePath(parent, tmp));

  // Remove the temporary node again (nothing else was changed yet).
  const rollbackNew = async (reason: string, message: string): Promise<Failure> => {
    const undo = await send([{ op: "RemoveNode", path: newPath }]);
    const rolledBack = !extractOpError(undo);
    return failure(
      reason,
      rolledBack
        ? `${message} The temporary node was removed again; the old node is untouched and ${scenePath} on disk is unchanged.`
        : `${message} Removing the temporary node ${newPath} also failed: remove it with summer_remove_node. ${scenePath} on disk is unchanged (not saved).`,
      { persisted: false, rolled_back: rolledBack }
    );
  };

  // Children of the new scene that would collide with the moved children.
  const newChildren = await readLiveChildren(client, scenePath, newPath);
  if (newChildren) {
    const clashes = directChildren.filter((c) => newChildren.includes(c.name)).map((c) => c.name);
    if (clashes.length > 0) {
      return rollbackNew(
        "child_name_collision",
        `The new ${scene ?? `type ${type}`} already has children named ${clashes.join(", ")}, the same names as children added under ${target}; ` +
          "moving them would rename them. Rename those children first (summer_set_prop name), then retry."
      );
    }
  }

  // Live sibling index of the old node (an instanced or inherited parent has
  // children the file does not list).
  const liveIndex = liveSiblings ? liveSiblings.indexOf(node.name) : -1;
  const oldIndex = liveIndex >= 0 ? liveIndex : plan.fileIndex;

  // 3. Property overrides (each attempted; a failure is reported, not fatal).
  const propsCopied: string[] = [];
  if (props.length > 0) {
    const receipt = await send(
      props.map((p) => ({ op: "SetProp", path: newPath, key: p.key, value: p.value })),
      { stopOnError: false }
    );
    const results = opResults(receipt);
    props.forEach((p, i) => {
      const r = results[i];
      if (r && r.ok !== false) propsCopied.push(p.key);
      else notCopied.push({ key: p.key, reason: String(r?.error ?? "SetProp failed") });
    });
    if (notCopied.length) notCarriedOver.props = notCopied;
  }

  // 4 + 5. Move children, restore ownership below them, take the old slot, drop the old node, take its name.
  const rebase = (path: string) => (path === target ? newPath : `${newPath}${path.slice(target.length)}`);
  const structure: JsonRecord[] = [
    ...directChildren.map((c) => ({ op: "ReparentNode", path: c.path, new_parent_path: newPath, keep_global_transform: false })),
    ...reownInPlaceOps(deeper, rebase),
    { op: "MoveNode", path: newPath, new_index: oldIndex },
    { op: "RemoveNode", path: target },
    { op: "SetProp", path: newPath, key: "name", value: node.name },
  ];
  const moved = await send(structure);
  if (extractOpError(moved)) {
    const results = opResults(moved);
    const applied = results.filter((r) => r.ok !== false).length;
    const removedOld = results.some((r, i) => r.ok !== false && structure[i]?.op === "RemoveNode");
    if (applied === 0) {
      return rollbackNew("replace_failed", `Replacement stopped before anything moved: ${extractOpError(moved)}.`);
    }
    return failure(
      "replace_partially_applied",
      `summer_replace_node stopped after ${applied} of ${structure.length} steps: ${extractOpError(moved)}. ` +
        `Applied in the editor only, NOT saved (${scenePath} on disk still holds the original node). ` +
        (removedOld
          ? `The old node is gone and the new one is at ${newPath}: rename it with summer_set_prop name "${node.name}", then summer_save_scene.`
          : `The new node is at ${newPath} next to the old one: undo with Ctrl+Z in the editor, or move the children back and remove ${newPath}.`),
      { persisted: false, applied_steps: structure.slice(0, applied).map((op) => String(op.op)) }
    );
  }

  // 6. Save, then read the file back and check it.
  const saved = await send([{ op: "SaveScene" }]);
  if (extractOpError(saved)) {
    return {
      ...(asRecord(saved) ?? {}),
      ok: false,
      persisted: false,
      note: `The replacement is applied in the editor but SaveScene failed, so ${scenePath} on disk still holds the original node. Fix the save error, then call summer_save_scene.`,
    };
  }
  const after = await readSavedScene(client, scenePath);
  if (isFailure(after)) return { ...after, persisted: false, note: "The replacement was applied and saved, but the file could not be read back to verify it." };
  const verification = verifyAgainstSaved(after.parsed, plan);
  const extra: JsonRecord = {
    method: "instantiate_move_remove",
    replaced: { from, to: scene ?? `type ${type}` },
    ...(directChildren.length ? { moved_children: directChildren.map((c) => c.name) } : {}),
    ...(propsCopied.length ? { props_copied: propsCopied } : {}),
    ...(Object.keys(notCarriedOver).length ? { not_carried_over: notCarriedOver } : {}),
  };
  if (!verification.persisted) return notPersistedFailure(plan, verification, extra);
  const warnings = [...verification.warnings];
  if (Object.keys(notCarriedOver).length) {
    warnings.push("Some state of the old node did not carry over (see not_carried_over): re-apply what is still wanted.");
  }
  return {
    ok: true,
    persisted: true,
    verified: true,
    scenePath,
    path: target,
    ...extra,
    verification: verification.saved,
    ...(warnings.length ? { warnings } : {}),
    undo: "Sent as separate engine requests: undoing it in the editor takes one Ctrl+Z per step (create, properties, move/remove).",
  };
}
