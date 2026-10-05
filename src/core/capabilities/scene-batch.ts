/**
 * scene-batch — summer_batch's scene-mutation path, ONE implementation for both
 * faces (src/mcp/tools/scene-tools.ts and tool-dispatch.ts), plus the
 * re-owning step every MCP path that sends ReparentNode shares.
 *
 * Two engine ops answer ok for changes SaveScene then leaves out of the file
 * (engine modules/1summer_engine/editor/ops/scene_ops.cpp, engine 0.6.0):
 *
 *  - ReparentNode (SceneOps::reparent_node) re-owns only the node it moves
 *    (`add_do_method(node, "set_owner", root)`). The remove_child before it
 *    runs Node::_propagate_validate_owner over the detached subtree and clears
 *    every owner that is not inside it — the scene root. PackedScene::pack
 *    skips unowned nodes, so Box/Toy/ToyPart moved under Cabinet saved as
 *    Cabinet/Box alone.
 *  - ConnectSignal (SceneOps::connect_signal) connects without
 *    CONNECT_PERSIST, so no [connection] line is written. A raw ConnectSignal
 *    is refused here before anything is sent; summer_connect_signal
 *    (connect-signal.ts) connects with the flag and reads the line back.
 *
 * No engine op sets an owner, except ReparentNode's own set_owner(root) on the
 * node it moves. So a batch with ReparentNode runs as:
 *   0. SaveScene, then read the saved .tscn: the nodes the scene root owns;
 *   1. the ops in order; each ReparentNode travels in its own request together
 *      with an in-place ReparentNode (same parent, same live index, local
 *      transform kept) for every scene-owned descendant of the moved node,
 *      shallowest first — each of those re-owns one descendant;
 *   2. the final SaveScene; then the file is read back and every moved node
 *      and re-owned descendant is looked up at its new path. Any one missing
 *      is failure_reason not_persisted (persisted:false), never success.
 */
import { resolveSingleOnlyOps, type CapabilityAdvertisingClient } from "../capability-skew.js";
import { ToolInputError } from "../tool-errors.js";
import { asRecord, stringFrom, type JsonRecord } from "../util/json.js";
import { executeOpsChunked, safeProjectPath, sceneMutationOps } from "./engine-ops.js";
import { extractOpError } from "./engine-receipt.js";
import { isReadbackFailure, readSavedScene } from "./scene-readback.js";
import { isAtOrBelow, isSceneCreatedNode, joinNodePath, normalizeNodePath, parentNodePath } from "./tscn.js";

/** The engine calls summer_batch's scene path needs — a structural subset of
 *  EngineApiClient so tests can hand in a fake engine. */
export interface SceneBatchClient extends CapabilityAdvertisingClient {
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

// ---------------------------------------------------------------------------
// Re-owning (shared with summer_replace_node)
// ---------------------------------------------------------------------------

function depth(path: string): number {
  return path === "." ? 0 : path.split("/").length;
}

/**
 * The in-place ReparentNode ops that give a moved node's descendants back to
 * the scene root: each op moves one descendant onto the parent it already has
 * (its own set_owner(root) is the only engine path that sets an owner),
 * keeping the local transform and, when the live index is known, the sibling
 * index. `descendants` are paths BEFORE the move; `rebase` maps one to its
 * path after it. Shallowest first: re-parenting a node clears the owners
 * below it again, so a child is only re-owned after its parent.
 */
export function reownInPlaceOps(
  descendants: readonly string[],
  rebase: (path: string) => string,
  liveIndex?: ReadonlyMap<string, number>
): JsonRecord[] {
  const ordered = descendants
    .map((path, order) => ({ path, order }))
    .sort(
      (a, b) =>
        depth(a.path) - depth(b.path) ||
        (liveIndex?.get(a.path) ?? a.order) - (liveIndex?.get(b.path) ?? b.order) ||
        a.order - b.order
    );
  return ordered.map(({ path }) => {
    const index = liveIndex?.get(path);
    return {
      op: "ReparentNode",
      path: rebase(path),
      new_parent_path: rebase(parentNodePath(path) ?? "."),
      keep_global_transform: false,
      ...(index !== undefined ? { new_index: index } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** summer_batch guard (both faces): a raw ConnectSignal is saved without its
 *  connection. Refuse it before anything is sent. Null when the ops are fine. */
export function rawConnectSignalRefusal(ops: ReadonlyArray<Record<string, unknown>>): string | null {
  if (!ops.some((op) => op.op === "ConnectSignal")) return null;
  return (
    "summer_batch does not send a raw ConnectSignal: the engine connects without CONNECT_PERSIST, so the receipt says ok " +
    "but SaveScene leaves the connection out of the .tscn and it is gone on reload. Nothing was sent. " +
    "Use summer_connect_signal: it connects with CONNECT_PERSIST and confirms the [connection] line in the saved file."
  );
}

// ---------------------------------------------------------------------------
// Which nodes the scene root owns, followed through the batch
// ---------------------------------------------------------------------------

/** Root-owned node paths, and the paths the batch must prove in the saved
 *  file, rewritten as the batch renames, moves and removes nodes. */
class OwnedPaths {
  owned = new Set<string>();
  /** Moved and re-owned nodes the read-back must find, at their current path. */
  expected = new Set<string>();

  constructor(initial: Iterable<string>) {
    for (const path of initial) if (path !== ".") this.owned.add(path);
  }

  below(path: string): string[] {
    return [...this.owned].filter((p) => p !== path && isAtOrBelow(p, path));
  }

  move(from: string, to: string): void {
    if (from === "." || from === to) return;
    const rewrite = (paths: Set<string>) =>
      new Set([...paths].map((p) => (isAtOrBelow(p, from) ? `${to}${p.slice(from.length)}` : p)));
    this.owned = rewrite(this.owned);
    this.expected = rewrite(this.expected);
  }

  remove(path: string): void {
    if (path === ".") return;
    for (const p of [...this.owned]) if (isAtOrBelow(p, path)) this.owned.delete(p);
    for (const p of [...this.expected]) if (isAtOrBelow(p, path)) this.expected.delete(p);
  }

  /** Follow one op the engine applied (`result` is its receipt). */
  apply(op: JsonRecord, result: JsonRecord | undefined): void {
    if (result?.ok === false) return;
    const meta = asRecord(result?.meta);
    switch (op.op) {
      case "AddNode":
      case "InstantiateScene": {
        const reported = stringFrom(meta?.nodePath);
        const name = stringFrom(op.name);
        const path = reported
          ? normalizeNodePath(reported)
          : name
            ? joinNodePath(normalizeNodePath(String(op.parent ?? ".")), name)
            : undefined;
        if (path && path !== ".") this.owned.add(path);
        break;
      }
      case "RemoveNode":
        this.remove(normalizeNodePath(String(op.path ?? "")));
        break;
      case "SetProp": {
        if (op.key !== "name" || typeof op.value !== "string") break;
        const from = normalizeNodePath(String(op.path ?? ""));
        const parent = parentNodePath(from);
        if (parent !== null) this.move(from, joinNodePath(parent, op.value));
        break;
      }
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Live reads
// ---------------------------------------------------------------------------

interface LiveSubtree {
  /** Root-relative path -> index among its live siblings. */
  index: Map<string, number>;
  /** False when the engine cut the walk (depth/limit). */
  complete: boolean;
}

/** The live subtree under `nodePath` (children in tree order), or null when
 *  the engine cannot answer for that node. */
async function readLiveSubtree(
  client: SceneBatchClient,
  scenePath: string,
  nodePath: string,
  depthLimit: number
): Promise<{ data: JsonRecord; live: LiveSubtree } | null> {
  try {
    const state = asRecord(await client.getSceneState(scenePath, { root: nodePath, depth: depthLimit, limit: 100_000 }));
    if (!state || state.ok === false) return null;
    const data = asRecord(state.data);
    // A path the engine cannot resolve falls back to the scene root: compare.
    if (!data || normalizeNodePath(String(data.path ?? "")) !== nodePath) return null;
    const index = new Map<string, number>();
    const walk = (node: JsonRecord) => {
      const children = Array.isArray(node.children) ? node.children : [];
      children.forEach((child, i) => {
        const record = asRecord(child);
        if (!record) return;
        index.set(normalizeNodePath(String(record.path ?? "")), i);
        walk(record);
      });
    };
    walk(data);
    return { data, live: { index, complete: data.truncated !== true } };
  } catch {
    return null;
  }
}

async function readLiveChildNames(client: SceneBatchClient, scenePath: string, nodePath: string): Promise<string[] | null> {
  const read = await readLiveSubtree(client, scenePath, nodePath, 1);
  if (!read) return null;
  const children = Array.isArray(read.data.children) ? read.data.children : [];
  return children.map((child) => String(asRecord(child)?.name ?? ""));
}

// ---------------------------------------------------------------------------
// The batch
// ---------------------------------------------------------------------------

function opResults(receipt: unknown): JsonRecord[] {
  const results = asRecord(receipt)?.results;
  return Array.isArray(results) ? results.map((r) => asRecord(r) ?? {}) : [];
}

function receiptList(receipt: unknown): unknown[] {
  const nested = asRecord(receipt)?.receipts;
  return Array.isArray(nested) ? nested : [receipt];
}

const TOO_LARGE_HINT =
  "Move the nodes with summer_run_script instead (reparent, then ctx.set_owner_recursive on the moved node), and confirm the saved scene with summer_read_file.";

/**
 * summer_batch's scene-mutation path. A raw ConnectSignal is refused (nothing
 * sent); a batch without ReparentNode is sent exactly as before; a batch with
 * ReparentNode keeps every scene-owned descendant of each moved node and is
 * verified from the saved file.
 */
export async function executeSceneBatch(
  client: SceneBatchClient,
  scenePath: string,
  ops: JsonRecord[],
  options: JsonRecord = {}
): Promise<unknown> {
  const refusal = rawConnectSignalRefusal(ops);
  if (refusal) throw new ToolInputError(refusal);
  const singleOnly = resolveSingleOnlyOps(client);
  const send = (chunk: JsonRecord[]) => client.executeIdentityBoundOps(chunk, { ...options, scenePath });
  if (!ops.some((op) => op.op === "ReparentNode")) {
    return executeOpsChunked(send, sceneMutationOps(ops), singleOnly);
  }

  const target = safeProjectPath(scenePath);
  if (!target.endsWith(".tscn")) {
    throw new ToolInputError(
      "summer_batch with ReparentNode verifies the moved nodes in the saved text scene, so scenePath must be a .tscn file. " +
        "For a binary .scn move the nodes with summer_run_script (reparent, then ctx.set_owner_recursive on the moved node)."
    );
  }
  if (ops.some((op) => op.op === "Undo")) {
    throw new ToolInputError(
      "summer_batch does not combine Undo with ReparentNode: the moved nodes are re-owned and verified from the scene as it was before the batch, which an Undo changes. Send the Undo in its own summer_batch. Nothing was sent."
    );
  }
  const all = sceneMutationOps(ops);

  // 0. Save, so the file is the editor state, and read which nodes the root owns.
  const pre = await executeOpsChunked(send, [{ op: "SaveScene" }], singleOnly);
  if (extractOpError(pre)) {
    return { ...(asRecord(pre) ?? {}), note: "Nothing from the batch was sent: the SaveScene that precedes a ReparentNode batch failed." };
  }
  const before = await readSavedScene(client, target, TOO_LARGE_HINT);
  if (isReadbackFailure(before)) return { ...before, note: "Nothing from the batch was sent." };
  const tracked = new OwnedPaths(before.parsed.nodes.filter(isSceneCreatedNode).map((n) => n.path));

  const receipts: unknown[] = [...receiptList(pre)];
  const results: JsonRecord[] = [];
  const applied: string[] = [];
  const reparented: JsonRecord[] = [];
  const warnings: string[] = [];
  let last: JsonRecord = asRecord(pre) ?? {};

  const partial = (receipt: unknown, failedKind: string, notSent: JsonRecord[]): JsonRecord => {
    const envelope = asRecord(receipt) ?? {};
    const base = (typeof envelope.error === "string" && envelope.error) || extractOpError(receipt) || `Engine request failed (${failedKind}).`;
    const notSentKinds = notSent.map((op) => String(op.op ?? ""));
    return {
      ...envelope,
      ok: false,
      status: "error",
      persisted: false,
      error:
        applied.length > 0
          ? `${base} NOTE: ${applied.length} earlier op(s) already applied (${applied.join(", ")}) — the scene is modified in the editor but NOT saved to disk.` +
            (notSentKinds.length ? ` Not sent: ${notSentKinds.join(", ")}.` : "")
          : base,
      results,
      receipts,
      ...(reparented.length ? { reparented } : {}),
    };
  };

  /** Send `chunk`; the first `callerOps` entries are the caller's ops, the
   *  rest the workaround's. Null on success, else the failure envelope. */
  const run = async (chunk: JsonRecord[], callerOps: number, rest: JsonRecord[]): Promise<JsonRecord | null> => {
    const receipt = await executeOpsChunked(send, chunk, singleOnly);
    receipts.push(...receiptList(receipt));
    const rs = opResults(receipt);
    results.push(...rs.slice(0, callerOps));
    const error = extractOpError(receipt);
    for (let i = 0; i < callerOps; i++) {
      if (rs[i] && rs[i]!.ok !== false) {
        tracked.apply(chunk[i]!, rs[i]);
        applied.push(String(chunk[i]!.op ?? ""));
      }
    }
    if (error) return partial(receipt, String(chunk[0]?.op ?? "batch"), rest);
    last = asRecord(receipt) ?? last;
    return null;
  };

  let pending: JsonRecord[] = [];
  for (let i = 0; i < all.length; i++) {
    const op = all[i]!;
    const from = normalizeNodePath(String(op.path ?? ""));
    // The root cannot move; the engine refuses that op with its own error.
    if (op.op !== "ReparentNode" || from === ".") {
      pending.push(op);
      continue;
    }
    if (pending.length) {
      const failed = await run(pending, pending.length, all.slice(i));
      if (failed) return failed;
      pending = [];
    }

    const newParent = normalizeNodePath(String(op.new_parent_path ?? ""));
    const name = from.split("/").pop()!;
    const to = joinNodePath(newParent, name);
    const descendants = tracked.below(from);

    // add_child(node, true) renames on a name clash ("Box" -> "Box2"), so the
    // new path could not be predicted, re-owned or verified.
    if (newParent !== parentNodePath(from)) {
      const siblings = await readLiveChildNames(client, target, newParent);
      if (siblings?.includes(name)) {
        return {
          ...partial(
            { error: `ReparentNode ${from} -> ${newParent} not sent: ${newParent} already has a child named "${name}", and the engine would rename the moved node, so its subtree could not be kept and verified. Rename one of them first (SetProp name), then retry.` },
            "ReparentNode",
            all.slice(i)
          ),
          failure_reason: "name_collision",
        };
      }
    }

    let repairs: JsonRecord[] = [];
    let reowned: string[] = [];
    if (descendants.length > 0) {
      const live = await readLiveSubtree(client, target, from, 64);
      let keep = descendants;
      if (!live) {
        warnings.push(`The live order under ${from} could not be read, so the re-owned descendants of ${from} may change sibling order.`);
      } else if (live.live.complete) {
        const gone = descendants.filter((d) => !live.live.index.has(d));
        if (gone.length) warnings.push(`Not in the live tree, so not re-owned: ${gone.join(", ")}.`);
        keep = descendants.filter((d) => live.live.index.has(d));
      }
      const rebase = (path: string) => (path === from ? to : `${to}${path.slice(from.length)}`);
      repairs = reownInPlaceOps(keep, rebase, live?.live.index);
      reowned = repairs.map((r) => String(r.path));
    }

    const failed = await run([op, ...repairs], 1, all.slice(i + 1));
    if (failed) return failed;
    // The moved node's own receipt went into results; the in-place moves did not.
    tracked.move(from, to);
    tracked.owned.add(to);
    tracked.expected.add(to);
    for (const path of reowned) tracked.expected.add(path);
    reparented.push({ path: from, new_path: to, ...(reowned.length ? { reowned } : {}) });
  }
  if (pending.length) {
    const failed = await run(pending, pending.length, []);
    if (failed) return failed;
  }

  // 2. The batch's SaveScene ran last. Read the file and find every moved node.
  const saved = asRecord(last.scenePersistence);
  const envelope: JsonRecord = {
    ...last,
    results,
    requests: receipts.length,
    receipts,
    reparented,
    workaround:
      "ReparentNode clears the scene owner below the moved node, so each scene-owned descendant was moved onto its own parent again (one in-place ReparentNode each) before the save.",
  };
  const after = await readSavedScene(client, target, TOO_LARGE_HINT);
  if (isReadbackFailure(after)) {
    return {
      ...envelope,
      ...after,
      persisted: false,
      verified: false,
      ...(saved ? { scenePersistence: { ...saved, verified: false } } : {}),
      error: `${after.error} The batch was applied and saved, but the moved nodes could not be verified in the file.`,
    };
  }
  const expected = [...tracked.expected.keys()];
  const missing = expected.filter((path) => !after.parsed.nodes.some((n) => n.path === path && isSceneCreatedNode(n)));
  const verification: JsonRecord = {
    verified: missing.length === 0,
    read_back: target,
    checked: expected,
    ...(missing.length ? { missing } : {}),
  };
  if (missing.length) {
    return {
      ...envelope,
      ok: false,
      status: "error",
      failure_reason: "not_persisted",
      persisted: false,
      verified: false,
      ...(saved ? { scenePersistence: { ...saved, verified: false } } : {}),
      verification,
      ...(warnings.length ? { warnings } : {}),
      error:
        `summer_batch ReparentNode did NOT persist (persisted:false): the saved ${target} has no ${missing.join(", ")}. ` +
        "The editor still shows them, but they are not owned by the scene, so they are gone on reload. Do not report the move as done: " +
        "read the saved file (summer_read_file), then move them again with summer_run_script (reparent, then ctx.set_owner_recursive on each node that has no instanced scene below it).",
    };
  }
  return {
    ...envelope,
    ok: true,
    persisted: true,
    verified: true,
    ...(saved ? { scenePersistence: { ...saved, verified: true } } : {}),
    verification,
    ...(warnings.length ? { warnings } : {}),
  };
}
