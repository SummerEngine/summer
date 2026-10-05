/**
 * surface-snap — ONE implementation of `summer_snap_to_surface` for both faces
 * (src/mcp/tools/spatial-tools.ts and tool-dispatch.ts), around the engine's
 * SnapToSurface op (modules/1summer_engine/editor/ops/surface_snap_ops.cpp).
 *
 * Two gaps in the engine op, closed here with ops main already ships:
 *
 * 1. Its two recovery failures say nothing about WHY. gap_exceeds_hit_travel
 *    and overlap_recovery_exceeded name neither the node in the way nor
 *    whether the subject started out overlapping. After either failure a
 *    read-only Starcast3D at the subject's current pose names the contacts,
 *    the start-overlap state and what is below, and the failure gains a
 *    concrete next_step.
 *
 * 2. It cannot lift a prop SUNK into its support. When the start pose
 *    overlaps, the engine backs the subject off against the cast direction,
 *    sweeps, and measures hitTravel from the ORIGINAL pose — negative for a
 *    sunk prop — then refuses any gap above it ("would move opposite the
 *    verified sweep"), although the backed-off sweep did verify that space
 *    (_solve_physics compares p_gap with hit_travel instead of with the swept
 *    distance from the backed-off start). So on gap_exceeds_hit_travel with a
 *    start overlap this module lifts the subject against the cast direction
 *    by the overlap depth plus a margin (exact local position from the saved
 *    scene), snaps again from there, and keeps the result only when it
 *    settles back on a node the subject was sunk into. Otherwise the original
 *    position is restored and the failure is reported.
 */
import { missingEngineOpResult, resolveSingleOnlyOps, type CapabilityAdvertisingClient } from "../capability-skew.js";
import { asRecord, type JsonRecord } from "../util/json.js";
import { executeOpsChunked, sceneMutationOps } from "./engine-ops.js";
import { extractOpError } from "./engine-receipt.js";
import { STARCAST_FALLBACK } from "./engine-fallbacks.js";
import {
  applyMat3,
  IDENTITY3,
  invertMat3,
  mulMat3,
  parseTransform3D,
  vec3Literal,
  vec3LiteralExact,
  type Mat3,
  type Vec3,
} from "./math3d.js";
import { findTscnNode, isSceneCreatedNode, normalizeNodePath, parentNodePath, parseTscn } from "./tscn.js";

/** Clearance added above the support before the second sweep. */
export const SNAP_LIFT_MARGIN = 0.02;
/** Never lift further than this automatically (a deeper overlap is a placement mistake to report). */
export const SNAP_MAX_AUTO_LIFT = 0.5;

export interface SnapToSurfaceArgs {
  scenePath: string;
  subjectPath: string;
  direction: Vec3;
  maxDistance: number;
  gap: number;
  alignUp: boolean;
}

export interface SnapClient extends CapabilityAdvertisingClient {
  executeIdentityBoundOps(ops: Record<string, unknown>[], options?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  readProjectFile(path: string, maxBytes?: number): Promise<unknown>;
}

const RECOVERY_FAILURES = new Set(["gap_exceeds_hit_travel", "overlap_recovery_exceeded", "aligned_overlap_recovery_exceeded"]);

export function buildSnapToSurfaceOp(args: SnapToSurfaceArgs): JsonRecord {
  return {
    op: "SnapToSurface",
    subject_path: args.subjectPath,
    direction: args.direction,
    max_distance: args.maxDistance,
    gap: args.gap,
    align_up: args.alignUp,
  };
}

function snapResult(receipt: unknown): JsonRecord | null {
  const results = asRecord(receipt)?.results;
  if (!Array.isArray(results)) return null;
  return asRecord(results.find((entry) => asRecord(entry)?.op === "SnapToSurface")) ?? null;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Diagnosis (read-only Starcast3D at the current pose)
// ---------------------------------------------------------------------------

export interface SnapDiagnosis {
  available: boolean;
  /** true / false from the starcast contact state; null when it could not run. */
  startOverlap: boolean | null;
  contacts: string[];
  below?: { status?: unknown; object?: unknown; distance?: unknown };
  /** World AABB size of the subject. */
  size?: Vec3;
  note?: string;
}

async function diagnose(client: SnapClient, args: SnapToSurfaceArgs): Promise<SnapDiagnosis> {
  const missing = missingEngineOpResult(client, "Starcast3D", STARCAST_FALLBACK);
  if (missing) return { available: false, startOverlap: null, contacts: [], note: "this engine build has no Starcast3D" };
  let receipt: unknown;
  try {
    receipt = await client.executeIdentityBoundOps(
      [{
        op: "Starcast3D",
        path: args.subjectPath,
        detail: "summary",
        max_distance: Math.min(args.maxDistance, 20),
        nearby_radius: 0,
        direction_space: "world",
        collision_mask: 0xffffffff,
        collide_with_areas: false,
        max_hits_per_direction: 1,
        max_results: 8,
        margin: 0.001,
      }],
      { scenePath: args.scenePath }
    );
  } catch (err) {
    return { available: false, startOverlap: null, contacts: [], note: `starcast failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (extractOpError(receipt)) {
    return { available: false, startOverlap: null, contacts: [], note: `starcast failed: ${extractOpError(receipt)}` };
  }
  const results = asRecord(receipt)?.results;
  const cast = asRecord(Array.isArray(results) ? results.find((r) => asRecord(r)?.op === "Starcast3D") ?? results[0] : receipt);
  if (!cast) return { available: false, startOverlap: null, contacts: [], note: "starcast returned no result" };
  const contacts = Array.isArray(cast.contacts) ? cast.contacts.map(String) : [];
  const status = typeof cast.contactStatus === "string" ? cast.contactStatus : undefined;
  const down = asRecord(asRecord(cast.directions)?.down);
  const sizeRaw = asRecord(cast.subject)?.size;
  const size = Array.isArray(sizeRaw) && sizeRaw.length === 3 && sizeRaw.every((v) => typeof v === "number") ? (sizeRaw as Vec3) : undefined;
  return {
    available: true,
    startOverlap: status === undefined ? contacts.length > 0 : status !== "none_detected",
    contacts,
    ...(down ? { below: { status: down.status, object: down.object, distance: down.distance } } : {}),
    ...(size ? { size } : {}),
  };
}

// ---------------------------------------------------------------------------
// Lift (exact local position from the saved scene)
// ---------------------------------------------------------------------------

interface LiftPlan {
  original: Vec3;
  lifted: Vec3;
}

/** Local position of the subject and the world basis of its parent, read
 *  from the saved .tscn (exact floats). Ancestors without a transform line
 *  are identity; an ancestor the file does not list (a node inside an
 *  instanced scene) makes the plan unavailable. */
async function planLift(client: SnapClient, args: SnapToSurfaceArgs, lift: number): Promise<LiftPlan | { reason: string }> {
  const read = asRecord(await client.readProjectFile(args.scenePath, 1_000_000));
  const content = asRecord(read?.data)?.content;
  if (read?.ok === false || typeof content !== "string" || asRecord(read?.data)?.truncated === true) {
    return { reason: `${args.scenePath} could not be read back as a whole text scene` };
  }
  const parsed = parseTscn(content);
  const subjectPath = normalizeNodePath(args.subjectPath);
  const subject = findTscnNode(parsed, subjectPath);
  if (!subject || !isSceneCreatedNode(subject)) {
    return { reason: `${subjectPath} is not a node the scene file creates (it may live inside an instanced scene)` };
  }
  const local = (node: ReturnType<typeof findTscnNode>) => {
    const raw = node?.props.find((p) => p.key === "transform")?.value;
    return raw ? parseTransform3D(raw) : { basis: IDENTITY3, origin: [0, 0, 0] as Vec3 };
  };
  const own = local(subject);
  if (!own) return { reason: `${subjectPath} has a transform the planner cannot read` };
  if (subject.props.some((p) => p.key === "top_level" && p.value.trim() === "true")) {
    return { reason: `${subjectPath} is top_level` };
  }
  const chain: Mat3[] = [];
  for (let p = parentNodePath(subjectPath); p !== null; p = parentNodePath(p)) {
    const node = findTscnNode(parsed, p);
    if (!node) return { reason: `ancestor ${p} is not listed in the scene file` };
    const t = local(node);
    if (!t) return { reason: `ancestor ${p} has a transform the planner cannot read` };
    chain.unshift(t.basis);
  }
  const parentBasis = chain.reduce((acc, basis) => mulMat3(acc, basis), IDENTITY3);
  const inverse = invertMat3(parentBasis);
  if (!inverse) return { reason: "the parent transform is singular" };
  const length = Math.hypot(...args.direction);
  const worldDelta = args.direction.map((d) => (-d / length) * lift) as Vec3;
  const localDelta = applyMat3(inverse, worldDelta);
  const original = own.origin;
  return { original, lifted: [original[0] + localDelta[0], original[1] + localDelta[1], original[2] + localDelta[2]] };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function extentAlong(size: Vec3 | undefined, direction: Vec3): number | undefined {
  if (!size) return undefined;
  const length = Math.hypot(...direction);
  return Math.abs(size[0] * direction[0] / length) + Math.abs(size[1] * direction[1] / length) + Math.abs(size[2] * direction[2] / length);
}

function nextStepFor(reason: string, failed: JsonRecord, args: SnapToSurfaceArgs, diagnosis: SnapDiagnosis, lift: number | undefined, liftNote?: string): string {
  const blocking = diagnosis.contacts.length ? diagnosis.contacts.join(", ") : undefined;
  if (reason === "gap_exceeds_hit_travel") {
    const hitTravel = typeof failed.hitTravel === "number" ? failed.hitTravel : undefined;
    if (diagnosis.startOverlap !== false && lift !== undefined) {
      return (
        `The subject starts ${hitTravel !== undefined && hitTravel < 0 ? `${round3(-hitTravel)} m ` : ""}inside ${blocking ?? "its support"}` +
        `${liftNote ? ` and the automatic lift was not applied (${liftNote})` : ""}. ` +
        `Raise it about ${round3(lift)} m against the cast direction with summer_set_prop position, then call summer_snap_to_surface again; ` +
        "check the result with summer_starcast."
      );
    }
    return (
      `The first surface along the cast is ${hitTravel !== undefined ? `${round3(hitTravel)} m` : "closer than the requested gap"} away, so gap ${args.gap} cannot be kept. ` +
      `Pass gap of at most ${hitTravel !== undefined ? round3(Math.max(0, hitTravel)) : "that distance"}, or move the subject away from ${blocking ?? diagnosis.below?.object ?? "the surface"} first.`
    );
  }
  const visual = failed.evidence === "visual_aabb";
  return (
    `The subject starts overlapping ${blocking ?? "something"} and moving it ${args.maxDistance} m against the cast direction did not clear it. ` +
    (visual
      ? "It has no enabled collider, so its visible bounding box was tested against the bounding boxes around it. Set its position by hand with summer_set_prop (read the support height with summer_starcast or summer_inspect_node), or give it a CollisionShape3D. "
      : `Move it clear of ${blocking ?? "the overlapping node"} with summer_set_prop position (summer_test_placement checks a candidate pose first), or raise maxDistance. `) +
    "Then call summer_snap_to_surface again."
  );
}

function failureEnvelope(
  receipt: unknown,
  failed: JsonRecord,
  args: SnapToSurfaceArgs,
  diagnosis: SnapDiagnosis,
  extra: { lift?: number; liftNote?: string; recovery?: JsonRecord } = {}
): JsonRecord {
  const reason = String(failed.failure_reason);
  const nextStep = nextStepFor(reason, failed, args, diagnosis, extra.lift, extra.liftNote);
  const startState = diagnosis.startOverlap === null
    ? `start overlap unknown (${diagnosis.note ?? "no starcast"})`
    : diagnosis.startOverlap
      ? `the subject starts in contact with or inside: ${diagnosis.contacts.join(", ") || "(unnamed)"}`
      : "the subject does not start overlapping anything";
  const augmented: JsonRecord = {
    ...failed,
    start_overlap: diagnosis.startOverlap,
    ...(diagnosis.contacts.length ? { blocking: diagnosis.contacts } : {}),
    ...(diagnosis.below ? { below: diagnosis.below } : {}),
    ...(extra.recovery ? { recovery: extra.recovery } : {}),
    next_step: nextStep,
  };
  const root = asRecord(receipt) ?? {};
  const results = Array.isArray(root.results) ? root.results.map((r) => (asRecord(r)?.op === "SnapToSurface" ? augmented : r)) : [augmented];
  return {
    ...root,
    ok: false,
    error: `${String(failed.error ?? reason)} (${reason}): ${startState}. Next step: ${nextStep}`,
    results,
  };
}

export async function snapToSurface(client: SnapClient, args: SnapToSurfaceArgs): Promise<unknown> {
  const op = buildSnapToSurfaceOp(args);
  const singleOnly = resolveSingleOnlyOps(client);
  const send = (ops: JsonRecord[], options: JsonRecord = {}) =>
    executeOpsChunked((chunk) => client.executeIdentityBoundOps(chunk, { ...options, scenePath: args.scenePath }), ops, singleOnly);

  const first = await send(sceneMutationOps([op]));
  if (!extractOpError(first)) return first;
  const failed = snapResult(first);
  const reason = typeof failed?.failure_reason === "string" ? failed.failure_reason : "";
  if (!failed || !RECOVERY_FAILURES.has(reason)) return first;

  const diagnosis = await diagnose(client, args);
  if (reason !== "gap_exceeds_hit_travel" || typeof failed.hitTravel !== "number") {
    return failureEnvelope(first, failed, args, diagnosis);
  }

  // A sunk subject: hitTravel is how far along the cast the contact is from
  // the CURRENT pose (negative = behind it). Lift past it, then settle.
  const lift = args.gap - failed.hitTravel + SNAP_LIFT_MARGIN;
  const extent = extentAlong(diagnosis.size, args.direction);
  const cap = Math.min(SNAP_MAX_AUTO_LIFT, args.maxDistance, extent !== undefined ? Math.max(extent, 0.05) : SNAP_MAX_AUTO_LIFT);
  // Lift only a subject that provably starts in or on its support: starcast
  // contacts, or (without starcast) a contact behind the current pose.
  const sunk = diagnosis.startOverlap === true || (diagnosis.startOverlap === null && failed.hitTravel < 0);
  if (!sunk) return failureEnvelope(first, failed, args, diagnosis);
  if (lift > cap) {
    return failureEnvelope(first, failed, args, diagnosis, {
      lift,
      liftNote: `it would need ${round3(lift)} m, more than the ${round3(cap)} m allowed automatically`,
    });
  }

  // Save first: the lift is computed from the exact transform in the file.
  const preSave = await send([{ op: "SaveScene" }]);
  if (extractOpError(preSave)) {
    return failureEnvelope(first, failed, args, diagnosis, { lift, liftNote: "the scene could not be saved before lifting" });
  }
  const plan = await planLift(client, args, lift);
  if ("reason" in plan) return failureEnvelope(first, failed, args, diagnosis, { lift, liftNote: plan.reason });

  const position = (v: Vec3) => ({ op: "SetProp", path: args.subjectPath, key: "position", value: vec3LiteralExact(v) });
  const restore = async () => !extractOpError(await send(sceneMutationOps([position(plan.original)])));
  const recovery: JsonRecord = {
    lifted_by: round3(lift),
    original_local_position: vec3Literal(plan.original),
    lifted_local_position: vec3Literal(plan.lifted),
  };

  const second = await send([position(plan.lifted), op], { groupUndo: true });
  const settled = snapResult(second);
  if (extractOpError(second) || !settled || settled.ok === false) {
    const restored = await restore();
    return failureEnvelope(first, settled ?? failed, args, diagnosis, {
      lift,
      liftNote: `the snap from the lifted pose failed too (${String(settled?.failure_reason ?? extractOpError(second))}); ${restored ? "the original position was restored" : "restoring the original position FAILED — check it"}`,
      recovery: { ...recovery, restored },
    });
  }
  const support = typeof settled.supportPath === "string" ? settled.supportPath : "";
  const sameSupport = diagnosis.contacts.length === 0 || support === "" || diagnosis.contacts.some((c) => normalizeNodePath(c) === normalizeNodePath(support));
  if (!sameSupport) {
    const restored = await restore();
    return failureEnvelope(first, failed, args, diagnosis, {
      lift,
      liftNote: `from the lifted pose it settled on ${support}, not on a node it was sunk into; ${restored ? "the original position was restored" : "restoring the original position FAILED — check it"}`,
      recovery: { ...recovery, settled_on: support, restored },
    });
  }
  const saved = await send([{ op: "SaveScene" }]);
  const warnings = Array.isArray(settled.warnings) ? [...settled.warnings] : [];
  warnings.push(
    `The subject started ${round3(-failed.hitTravel)} m inside ${diagnosis.contacts.join(", ") || "its support"}; it was lifted ${round3(lift)} m against the cast direction and settled from there. 'before' is the lifted pose; recovery.original_local_position is where it was.`
  );
  const result: JsonRecord = { ...settled, warnings, recovery: { ...recovery, recovered_from: "gap_exceeds_hit_travel", start_contacts: diagnosis.contacts } };
  const root = asRecord(second) ?? {};
  const results = Array.isArray(root.results) ? root.results.map((r) => (asRecord(r)?.op === "SnapToSurface" ? result : r)) : [result];
  if (extractOpError(saved)) {
    return {
      ...root,
      ok: false,
      error: `The subject was lifted and settled in the editor, but SaveScene failed, so ${args.scenePath} on disk still holds the sunk pose: ${extractOpError(saved)}. Call summer_save_scene.`,
      results,
    };
  }
  return { ...root, results: [...results, ...(Array.isArray(asRecord(saved)?.results) ? (asRecord(saved)!.results as unknown[]) : [])] };
}
