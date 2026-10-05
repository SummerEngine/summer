/**
 * Instantiate-with-transform and compact batch receipts, shared by
 * summer_instantiate_scene, summer_batch, summer_repeat_along and their CLI
 * twins.
 *
 * The engine's InstantiateScene accepts only parent / scene / name /
 * target_size (scene_ops.cpp instantiate_scene) and must travel as its own
 * request (single-only). A placed piece is therefore an InstantiateScene plus
 * SetProps on the node path its receipt reports (meta.nodePath, which already
 * carries any collision rename). The caller writes ONE op; this module expands
 * it.
 *
 * Request cost: the SetProps of consecutive InstantiateScene ops are held back
 * and sent together (up to TRANSFORM_OPS_PER_REQUEST per request) just before
 * the next op that is not an InstantiateScene, riding along with it when it is
 * batchable. N placed pieces followed by the SaveScene therefore cost N + 2
 * requests, not 2N + 1. Every op that could depend on a piece's transform
 * (SetProp, SnapToSurface, AlignDistribute3D, a raw query, the SaveScene) runs
 * after the transforms land, and when an InstantiateScene fails the transforms
 * of the pieces already created are still sent, so a failure never leaves an
 * earlier piece sitting at the origin.
 *
 * With no placement fields and receipt "full", callers keep using the old
 * executeSceneMutation path unchanged.
 */
import { ToolInputError } from "../tool-errors.js";
import { asRecord, type JsonRecord } from "../util/json.js";
import { resolveSingleOnlyOps } from "../capability-skew.js";
import { extractOpError } from "./engine-receipt.js";
import { executeSceneBatch, rawConnectSignalRefusal, type SceneBatchClient } from "./scene-batch.js";
import {
  executeOpsChunked,
  executeSceneMutation,
  isSingleOnlyOp,
  sceneMutationOps,
  type SceneMutationClient,
} from "./engine-ops.js";
import {
  isFiniteVec3,
  parseGodotTransform,
  parseGodotVector3,
  toGodotTransform,
  toGodotVector3,
  type Vec3,
} from "./placement-math.js";

/** Fields an InstantiateScene op may carry that the engine op itself lacks. */
export const PLACEMENT_FIELDS = ["position", "rotation_degrees", "scale", "transform"] as const;
export type PlacementField = (typeof PLACEMENT_FIELDS)[number];

/** Model-visible budget for compact receipts (the 5 KB tool-result contract). */
export const COMPACT_LIMIT_BYTES = 5 * 1024;
/** Held-back transform SetProps sent per request; the engine refuses requests
 *  over 256 ops (local_api_server.cpp). */
export const TRANSFORM_OPS_PER_REQUEST = 200;
const SUMMARY_TARGET_BYTES = 4600;
const ERROR_TEXT_LIMIT = 240;

export interface PlacementProp {
  key: PlacementField;
  value: string;
}

function vectorField(value: unknown, label: string): Vec3 {
  if (isFiniteVec3(value)) return value;
  if (typeof value === "string") {
    const parsed = parseGodotVector3(value);
    if (parsed) return parsed;
  }
  throw new ToolInputError(`${label} must be [x, y, z] finite numbers or a "Vector3(x, y, z)" string.`);
}

/**
 * Split one InstantiateScene op into the engine op (placement fields removed)
 * and the SetProps that place it. Validates every field before anything is
 * sent; `label` names the op in error messages (e.g. "ops[3]").
 */
export function splitInstantiatePlacement(
  op: JsonRecord,
  label: string
): { op: JsonRecord; props: PlacementProp[] } {
  const present = PLACEMENT_FIELDS.filter((field) => op[field] !== undefined && op[field] !== null);
  if (present.length === 0) return { op, props: [] };
  const stripped: JsonRecord = { ...op };
  for (const field of PLACEMENT_FIELDS) delete stripped[field];
  if (present.includes("transform") && present.length > 1) {
    throw new ToolInputError(
      `${label}: pass either transform or position/rotation_degrees/scale, not both.`
    );
  }
  if (op.target_size !== undefined && (present.includes("scale") || present.includes("transform"))) {
    throw new ToolInputError(
      `${label}: target_size sets the scale; do not combine it with scale or transform.`
    );
  }
  if (present.includes("transform")) {
    const raw = op.transform;
    const parsed = typeof raw === "string" ? parseGodotTransform(raw) : null;
    if (!parsed) {
      throw new ToolInputError(
        `${label}.transform must be a "Transform3D(xx, xy, xz, yx, yy, yz, zx, zy, zz, ox, oy, oz)" string.`
      );
    }
    return { op: stripped, props: [{ key: "transform", value: toGodotTransform(parsed) }] };
  }
  // Rotation and scale first, position last: independent local properties,
  // but this order reads like the inspector.
  const props: PlacementProp[] = [];
  for (const key of ["rotation_degrees", "scale", "position"] as const) {
    if (op[key] === undefined || op[key] === null) continue;
    props.push({ key, value: toGodotVector3(vectorField(op[key], `${label}.${key}`)) });
  }
  return { op: stripped, props };
}

export function hasPlacementFields(op: JsonRecord): boolean {
  return PLACEMENT_FIELDS.some((field) => op[field] !== undefined && op[field] !== null);
}

// ---------------------------------------------------------------------------
// Execution trace
// ---------------------------------------------------------------------------

export interface TraceEntry {
  /** Index in the caller's op list; null for the appended SaveScene. */
  index: number | null;
  op: string;
  /** "transform" for SetProps expanded from an InstantiateScene's placement fields. */
  derived?: "transform";
  sent: boolean;
  result?: JsonRecord;
  ok?: boolean;
  error?: string;
  failureReason?: string;
}

export interface BatchTrace {
  entries: TraceEntry[];
  receipts: unknown[];
  requests: number;
  failed: boolean;
  /** Honest top-level error (what applied, what was not sent). */
  error?: string;
  /** The last engine envelope (for the full merged receipt). */
  last?: JsonRecord;
  failedEnvelope?: JsonRecord;
}

interface PlannedOp {
  op: JsonRecord;
  index: number | null;
  props: PlacementProp[];
}

function readFailure(result: JsonRecord | undefined): { error?: string; failureReason?: string } {
  if (!result) return {};
  const error = typeof result.error === "string" ? result.error : undefined;
  const failureReason =
    typeof result.failure_reason === "string"
      ? result.failure_reason
      : typeof result.failureReason === "string"
        ? result.failureReason
        : undefined;
  return { error, failureReason };
}

/** The node path an InstantiateScene / AddNode receipt reports. */
export function receiptNodePath(result: JsonRecord | undefined): string | undefined {
  const meta = asRecord(result?.meta);
  const path = meta?.nodePath;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

/**
 * Run an op list (SaveScene already appended by the caller when it mutates a
 * scene) honoring the single-op contract, expanding InstantiateScene placement
 * fields into SetProps on the created node. The SetProps of a run of
 * InstantiateScene ops are sent together before the next other op (see the
 * module comment).
 */
export async function executePlacementBatch(
  send: (chunk: JsonRecord[]) => Promise<unknown>,
  ops: JsonRecord[],
  singleOnly: ReadonlySet<string>,
  /** How many leading ops are the caller's; later ones (the appended
   *  SaveScene) are reported with index null. */
  inputCount: number = ops.length
): Promise<BatchTrace> {
  // Validate and plan everything before the first request. Placement fields
  // are read on InstantiateScene only; every other op is forwarded verbatim.
  const planned: PlannedOp[] = ops.map((op, index) => {
    const ownIndex = index < inputCount ? index : null;
    if (String(op.op ?? "") === "InstantiateScene") {
      const split = splitInstantiatePlacement(op, `ops[${index}]`);
      return { op: split.op, index: ownIndex, props: split.props };
    }
    return { op, index: ownIndex, props: [] };
  });

  // Group consecutive batchable ops; single-only ops travel alone.
  const chunks: PlannedOp[][] = [];
  let current: PlannedOp[] = [];
  for (const item of planned) {
    if (isSingleOnlyOp(String(item.op.op ?? ""), singleOnly)) {
      if (current.length > 0) chunks.push(current);
      current = [];
      chunks.push([item]);
    } else {
      current.push(item);
    }
  }
  if (current.length > 0) chunks.push(current);

  const trace: BatchTrace = { entries: [], receipts: [], requests: 0, failed: false };
  const entryFor = (item: PlannedOp, derived?: "transform", opKind?: string): TraceEntry => ({
    index: item.index,
    op: opKind ?? String(item.op.op ?? ""),
    ...(derived ? { derived } : {}),
    sent: false,
  });
  const allEntries: TraceEntry[][] = chunks.map((chunk) => chunk.map((item) => entryFor(item)));
  trace.entries = allEntries.flat();

  const sendChunk = async (sent: JsonRecord[], entries: TraceEntry[]): Promise<boolean> => {
    trace.requests++;
    const receipt = await send(sent);
    trace.receipts.push(receipt);
    const envelope = (asRecord(receipt) ?? {}) as JsonRecord;
    trace.last = envelope;
    const results = Array.isArray(envelope.results) ? (envelope.results as unknown[]) : [];
    const envelopeError = extractOpError(receipt);
    entries.forEach((entry, i) => {
      entry.sent = true;
      const result = asRecord(results[i]) ?? undefined;
      entry.result = result;
      if (result && result.ok === false) {
        entry.ok = false;
        Object.assign(entry, readFailure(result));
      } else if (result && result.ok === true) {
        entry.ok = true;
      } else if (envelopeError) {
        entry.ok = false;
        entry.error = typeof envelope.error === "string" ? envelope.error : envelopeError;
      } else {
        entry.ok = true;
      }
    });
    if (envelopeError) {
      trace.failed = true;
      trace.failedEnvelope = envelope;
      return false;
    }
    return true;
  };

  // Transform SetProps held back from InstantiateScene ops, sent together.
  const pending: Array<{ op: JsonRecord; entry: TraceEntry }> = [];
  const flushPending = async (): Promise<boolean> => {
    while (pending.length > 0) {
      const part = pending.splice(0, TRANSFORM_OPS_PER_REQUEST);
      const ok = await sendChunk(part.map((item) => item.op), part.map((item) => item.entry));
      if (!ok) return false;
    }
    return true;
  };

  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c]!;
    const entries = allEntries[c]!;
    const head = chunk[0]!;
    const instantiate = chunk.length === 1 && String(head.op.op ?? "") === "InstantiateScene";
    if (!instantiate && pending.length > 0) {
      const batchable = !isSingleOnlyOp(String(head.op.op ?? ""), singleOnly);
      if (batchable && pending.length + chunk.length <= TRANSFORM_OPS_PER_REQUEST) {
        // The held-back transforms ride along, ahead of the ops that may read them.
        const part = pending.splice(0);
        const ok = await sendChunk(
          [...part.map((item) => item.op), ...chunk.map((item) => item.op)],
          [...part.map((item) => item.entry), ...entries]
        );
        if (!ok) break;
        continue;
      }
      if (!(await flushPending())) break;
    }
    const ok = await sendChunk(chunk.map((item) => item.op), entries);
    if (!ok) {
      // The pieces created before the failure still get their transforms.
      if (instantiate) await flushPending();
      break;
    }
    if (instantiate && head.props.length > 0) {
      const nodePath = receiptNodePath(entries[0]!.result);
      if (!nodePath) {
        trace.failed = true;
        entries[0]!.ok = false;
        entries[0]!.failureReason = "instantiate_receipt_missing_node_path";
        entries[0]!.error =
          "InstantiateScene applied but its receipt carried no meta.nodePath, so the requested transform was NOT applied; the instance sits at its scene default. Set it with summer_set_prop.";
        await flushPending();
        break;
      }
      const propEntries = head.props.map(() => entryFor(head, "transform", "SetProp"));
      // Keep trace order: the derived SetProps right after their InstantiateScene.
      const at = trace.entries.indexOf(entries[0]!);
      trace.entries.splice(at + 1, 0, ...propEntries);
      head.props.forEach((prop, i) => {
        pending.push({ op: { op: "SetProp", path: nodePath, key: prop.key, value: prop.value }, entry: propEntries[i]! });
      });
    }
  }
  // An op list without a trailing op (no SaveScene) still sends its transforms.
  if (!trace.failed) await flushPending();

  if (trace.failed) trace.error = honestError(trace);
  return trace;
}

function honestError(trace: BatchTrace): string {
  const failed = trace.entries.find((entry) => entry.ok === false);
  const envelope = trace.failedEnvelope;
  const base =
    (typeof envelope?.error === "string" && envelope.error) ||
    failed?.error ||
    `Engine request failed (${failed?.op ?? "batch"}).`;
  const applied = trace.entries.filter((entry) => entry.sent && entry.ok === true).map((entry) => entry.op);
  const notSent = trace.entries.filter((entry) => !entry.sent).map((entry) => entry.op);
  if (applied.length === 0) return base;
  const savePending = notSent.includes("SaveScene");
  return (
    `${base} NOTE: ${applied.length} earlier op(s) already applied` +
    (savePending
      ? " — the scene is modified in the editor but NOT saved to disk. Fix the problem, then call summer_save_scene."
      : ".") +
    (notSent.length > 0 ? ` Not sent: ${notSent.length} op(s).` : "")
  );
}

/** The merged envelope in the same shape executeOpsChunked returns. */
export function traceEnvelope(trace: BatchTrace): JsonRecord {
  const results = trace.entries.filter((entry) => entry.result).map((entry) => entry.result!);
  if (trace.failed) {
    return {
      ...(trace.failedEnvelope ?? trace.last ?? {}),
      ok: false,
      status: "error",
      error: trace.error,
      results,
      receipts: trace.receipts,
    };
  }
  if (trace.requests === 1) return (asRecord(trace.receipts[0]) ?? {}) as JsonRecord;
  return { ...(trace.last ?? {}), results, requests: trace.requests, receipts: trace.receipts };
}

function clip(text: string | undefined): string | undefined {
  if (!text) return text;
  return text.length > ERROR_TEXT_LIMIT ? `${text.slice(0, ERROR_TEXT_LIMIT)}...` : text;
}

/**
 * Compact receipt: counts, failures with their op index, created node paths.
 * Lists are trimmed to stay under the 5 KB budget and the trim is declared.
 */
export function summarizeTrace(trace: BatchTrace, inputOps: JsonRecord[]): JsonRecord {
  const byIndex = new Map<number, TraceEntry[]>();
  for (const entry of trace.entries) {
    if (entry.index === null) continue;
    const list = byIndex.get(entry.index) ?? [];
    list.push(entry);
    byIndex.set(entry.index, list);
  }
  let applied = 0;
  let notSent = 0;
  const failures: JsonRecord[] = [];
  const created: string[] = [];
  const renamed: JsonRecord[] = [];
  for (let index = 0; index < inputOps.length; index++) {
    const entries = byIndex.get(index) ?? [];
    if (entries.length === 0 || entries.every((entry) => !entry.sent)) {
      notSent++;
      continue;
    }
    const bad = entries.find((entry) => entry.ok === false);
    if (bad) {
      failures.push({
        index,
        op: String(inputOps[index]!.op ?? ""),
        ...(bad.derived ? { step: "transform_setprop" } : {}),
        ...(bad.failureReason ? { failure_reason: bad.failureReason } : {}),
        error: clip(bad.error ?? "failed"),
      });
    } else {
      applied++;
    }
    const head = entries[0]!;
    if ((head.op === "InstantiateScene" || head.op === "AddNode") && head.ok) {
      const path = receiptNodePath(head.result);
      if (path) {
        created.push(path);
        const requested = inputOps[index]!.name;
        const actualName = path.split("/").pop();
        if (typeof requested === "string" && requested.length > 0 && actualName !== requested) {
          renamed.push({ index, requested, actual: path });
        }
      }
    }
  }
  const save = trace.entries.find((entry) => entry.index === null && entry.op === "SaveScene");
  const summary: JsonRecord = {
    ok: !trace.failed,
    receipt: "summary",
    ops: inputOps.length,
    requests: trace.requests,
    applied,
    failed: failures.length,
    not_sent: notSent,
    ...(save ? { saved: save.sent && save.ok === true } : {}),
    ...(trace.failed ? { error: clip(trace.error) } : {}),
    failures,
    created_total: created.length,
    created,
    renamed,
  };
  return fitSummary(summary);
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Trim created / renamed / failures (in that order) until the summary fits. */
function fitSummary(summary: JsonRecord): JsonRecord {
  if (bytes(summary) <= SUMMARY_TARGET_BYTES) return summary;
  const out: JsonRecord = { ...summary };
  const truncated: JsonRecord = {};
  for (const key of ["created", "renamed", "failures"] as const) {
    const list = [...((out[key] as unknown[]) ?? [])];
    const total = list.length;
    while (list.length > 0 && bytes({ ...out, [key]: list, truncated }) > SUMMARY_TARGET_BYTES) {
      list.pop();
    }
    if (list.length < total) {
      out[key] = list;
      truncated[key] = { shown: list.length, total };
    }
    if (bytes({ ...out, truncated }) <= SUMMARY_TARGET_BYTES) break;
  }
  out.truncated = truncated;
  out.truncation_note =
    "Lists were cut to fit the 5 KB receipt. Unlisted created nodes are at parent/name as requested unless a rename was listed; split the batch to see every path.";
  return out;
}

// ---------------------------------------------------------------------------
// summer_instantiate_scene and summer_batch (both faces)
// ---------------------------------------------------------------------------

export interface InstantiateSceneArgs {
  scenePath: string;
  parent: string;
  scene: string;
  name?: string;
  target_size?: number;
  position?: Vec3;
  rotation_degrees?: Vec3;
  scale?: Vec3;
  transform?: string;
}

/** An older engine applies the op but drops target_size: its receipt then
 *  lacks scale_applied. Confess that instead of letting a 40-unit "chair"
 *  pass as normalized. */
function withTargetSizeNote(result: unknown, targetSize: number | undefined): unknown {
  if (targetSize === undefined || !result || typeof result !== "object") return result;
  const envelope = result as JsonRecord & { results?: JsonRecord[] };
  const instanced = envelope.results?.find((entry) => entry.op === "InstantiateScene" && entry.ok === true);
  if (instanced && !("scale_applied" in instanced)) {
    return {
      ...envelope,
      target_size_note:
        `This Summer Engine build IGNORED target_size (no scale_applied in the receipt) — the instance is at the asset's raw scale, NOT normalized to ${targetSize}. ` +
        "Scale it yourself (summer_set_prop scale, or ctx code in summer_run_script), verify with summer_world_snapshot/summer_screenshot, or update Summer Engine.",
    };
  }
  return result;
}

export async function instantiateScene(client: SceneMutationClient, args: InstantiateSceneArgs): Promise<unknown> {
  const op: JsonRecord = { op: "InstantiateScene", parent: args.parent, scene: args.scene };
  if (args.name) op.name = args.name;
  if (args.target_size !== undefined) op.target_size = args.target_size;
  for (const field of PLACEMENT_FIELDS) {
    if (args[field] !== undefined) op[field] = args[field];
  }
  if (!hasPlacementFields(op)) {
    return withTargetSizeNote(await executeSceneMutation(client, args.scenePath, [op]), args.target_size);
  }
  const trace = await executePlacementBatch(
    (chunk) => client.executeIdentityBoundOps(chunk, { scenePath: args.scenePath }),
    sceneMutationOps([op]),
    resolveSingleOnlyOps(client),
    1
  );
  const envelope = traceEnvelope(trace);
  // results[] already holds every op's receipt; the per-request copies are
  // only kept when something failed (they carry the failing envelope).
  if (!trace.failed) delete envelope.receipts;
  const head = trace.entries[0];
  const nodePath = receiptNodePath(head?.result);
  const derived = trace.entries.filter((entry) => entry.derived === "transform");
  const applied = derived.length > 0 && derived.every((entry) => entry.ok === true);
  return withTargetSizeNote(
    {
      ...envelope,
      placement: {
        ...(nodePath ? { nodePath } : {}),
        applied,
        fields: PLACEMENT_FIELDS.filter((field) => op[field] !== undefined),
        space: "parent_local",
      },
    },
    args.target_size
  );
}

/** Scene mutation kinds summer_batch recognizes (one SaveScene appended). */
export const SCENE_MUTATION_OPS: ReadonlySet<string> = new Set([
  "AddNode", "RemoveNode", "MoveNode", "ReparentNode", "ReplaceNode",
  "SetProp", "SetResourceProperty", "ConnectSignal", "DisconnectSignal",
  "InstantiateScene", "SaveScene", "SnapToSurface", "AlignDistribute3D", "Undo",
]);

/** Read-only spatial queries: identity-bound to an exact scene, never saved. */
export const SCENE_QUERY_OPS: ReadonlySet<string> = new Set([
  "TestPlacement3D", "NavigationProbe3D", "Starcast3D",
]);

export type BatchClient = SceneMutationClient & {
  executeOps(ops: Record<string, unknown>[], options?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  /** The ReparentNode path reads the saved scene and the live tree (scene-batch.ts). */
  readProjectFile?: SceneBatchClient["readProjectFile"];
  getSceneState?: SceneBatchClient["getSceneState"];
};

export interface BatchArgs {
  scenePath?: string;
  ops: JsonRecord[];
  receipt?: "full" | "summary";
}

/**
 * summer_batch's engine path for both faces. Without placement fields and with
 * receipt "full" this is exactly the previous behavior. Raw WriteFile /
 * ReplaceText refusal stays in each face (their messages differ).
 */
export async function runBatch(client: BatchClient, args: BatchArgs): Promise<unknown> {
  const { scenePath, ops } = args;
  const containsMutation = ops.some((op) => SCENE_MUTATION_OPS.has(String(op.op ?? "")));
  const needsScenePath = containsMutation || ops.some((op) => SCENE_QUERY_OPS.has(String(op.op ?? "")));
  if (needsScenePath && !scenePath) {
    throw new ToolInputError("summer_batch requires scenePath when ops targets a scene");
  }
  const options: JsonRecord = { groupUndo: true, ...(scenePath ? { scenePath } : {}) };
  // A raw ConnectSignal is saved without its connection (scene-batch.ts).
  const connectRefusal = rawConnectSignalRefusal(ops);
  if (connectRefusal) throw new ToolInputError(connectRefusal);
  const placement = ops.some((op) => String(op.op ?? "") === "InstantiateScene" && hasPlacementFields(op));
  // ReparentNode drops the moved node's subtree on save; scene-batch.ts keeps
  // and verifies it, with its own full receipt.
  if (containsMutation && ops.some((op) => op.op === "ReparentNode")) {
    if (placement || args.receipt === "summary") {
      throw new ToolInputError(
        "summer_batch sends ReparentNode through its keep-and-verify path, which does not expand InstantiateScene placement fields or build a summary receipt. " +
          "Send the ReparentNode ops in their own summer_batch (receipt \"full\"). Nothing was sent."
      );
    }
    if (typeof client.readProjectFile !== "function" || typeof client.getSceneState !== "function") {
      throw new ToolInputError("summer_batch with ReparentNode needs an engine client that can read the saved scene back. Nothing was sent.");
    }
    return executeSceneBatch(client as SceneBatchClient, scenePath!, ops, options);
  }
  if (!placement && args.receipt !== "summary") {
    if (containsMutation) return executeSceneMutation(client, scenePath!, ops, options);
    return executeOpsChunked(
      (chunk) => (needsScenePath ? client.executeIdentityBoundOps(chunk, options) : client.executeOps(chunk, options)),
      ops,
      resolveSingleOnlyOps(client)
    );
  }
  const send = (chunk: JsonRecord[]) =>
    needsScenePath ? client.executeIdentityBoundOps(chunk, options) : client.executeOps(chunk, options);
  const trace = await executePlacementBatch(
    send,
    containsMutation ? sceneMutationOps(ops) : ops,
    resolveSingleOnlyOps(client),
    ops.length
  );
  return args.receipt === "summary" ? summarizeTrace(trace, ops) : traceEnvelope(trace);
}
