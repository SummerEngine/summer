/**
 * Kit-placement tools, shared by both faces: the MCP tools
 * (src/mcp/tools/placement-tools.ts) register these zod shapes and call these
 * runners; `summer tool <slug>` (tool-dispatch.ts) parses with the same
 * schemas and calls the same runners.
 *
 *   summer_inspect_asset      measure an asset file without adding it to a scene
 *   summer_place_adjacent     put one node's bounds face against another's
 *   summer_attach_to_surface  turn a piece's back onto a surface and seat it
 *   summer_repeat_along       instance copies of a scene along a line
 *   summer_connect_ports      meet one piece's port with another's
 *   summer_raycast            cast an arbitrary ray (physics, then visual AABB)
 *   summer_measure            gap/overlap per axis, or face coplanarity
 *
 * No engine op is new. Reads run the placement probe (placement-script.ts)
 * through RunSceneScript with undo "none" and no checkpoint; mutations are the
 * ordinary SetProp / SnapToSurface / InstantiateScene ops with the usual scene
 * target, undo and final SaveScene. attach_to_surface checks its seat before
 * the SaveScene and, when it refuses, sets the piece's original transform back
 * instead of saving. Every result is compact (< 5 KB) and names its evidence:
 * visual_aabb (visible GeometryInstance3D bounds, the definition
 * AlignDistribute3D uses), physics (collider queries), or mesh_triangles.
 */
import { z } from "zod";
import { missingEngineOpResult, resolveSingleOnlyOps, type CapabilityAdvertisingClient } from "../capability-skew.js";
import { ToolInputError } from "../tool-errors.js";
import { asRecord, type JsonRecord } from "../util/json.js";
import { executeSceneMutation, sceneMutationOps } from "./engine-ops.js";
import { extractOpError, withOldEngineHint } from "./engine-receipt.js";
import { SNAP_TO_SURFACE_FALLBACK } from "./engine-fallbacks.js";
import { buildRunSceneScriptOp } from "./scene-script.js";
import { buildPlacementScript } from "./placement-script.js";
import { executePlacementBatch, summarizeTrace } from "./placement-batch.js";
import {
  AXIS_NAMES,
  WORLD_AXES,
  add,
  angleDegrees,
  axisIndex,
  basisInverse,
  basisMul,
  basisMulVec,
  basisDeterminant,
  basisScale,
  dot,
  isFiniteVec3,
  length,
  normalize,
  parseGodotTransform,
  rotationAbout,
  rotationBetween,
  rotationFromFrames,
  round,
  roundVec,
  sameAxisLine,
  scale,
  signedAxisVector,
  sub,
  toGodotTransform,
  toGodotVector3,
  xformCompose,
  xformFromArray,
  xformInverse,
  type Basis3,
  type SignedAxis,
  type Vec3,
  type WorldAxis,
  type Xform,
} from "./placement-math.js";

// ---------------------------------------------------------------------------
// Client + shared schema pieces
// ---------------------------------------------------------------------------

export interface PlacementClient extends CapabilityAdvertisingClient {
  executeIdentityBoundOps(
    ops: Record<string, unknown>[],
    options?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<unknown>;
}

export type PlacementResult = JsonRecord & { ok: boolean };

/** What a placement tool tells the model when the engine lacks RunSceneScript. */
export const PLACEMENT_PROBE_FALLBACK =
  "read bounds with summer_starcast (or summer_inspect_node + summer_inspect_resource) and place with summer_set_prop, then verify with summer_screenshot";

const SCENE_PATH_LIMIT_BYTES = 512;
const NODE_PATH_LIMIT_BYTES = 256;
const FIT_TARGET_BYTES = 4700;
const utf8Within = (limit: number) => (value: string) => Buffer.byteLength(value, "utf8") <= limit;

// Strict character sets for every string that names a node, port or file.
// They travel to the editor only as base64 data (placement-script.ts), but a
// name with quotes, $, backslashes or control characters is never a real kit
// node, so it is refused at the boundary with a clear message.
const NODE_PATH_CHARS = /^[\p{L}\p{N}_\- ./]+$/u;
const PORT_NAME_CHARS = /^[\p{L}\p{N}_\- /]+$/u;
const RES_PATH_CHARS = /^res:\/\/[\p{L}\p{N}_\- ./]+$/u;
const SAFE_NODE_PATH_MESSAGE = "node paths may use letters, digits, _, -, spaces, '.' and '/' only";
const SAFE_RES_PATH_MESSAGE = "res:// paths may use letters, digits, _, -, spaces, '.' and '/' only";

export function isSafeNodePath(value: string): boolean {
  return NODE_PATH_CHARS.test(value) && !value.includes("..");
}

export function isSafeResPath(value: string): boolean {
  return RES_PATH_CHARS.test(value) && !value.includes("..");
}

const scenePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(SCENE_PATH_LIMIT_BYTES)
  .refine(utf8Within(SCENE_PATH_LIMIT_BYTES), `scenePath must be at most ${SCENE_PATH_LIMIT_BYTES} UTF-8 bytes`)
  .refine((value) => /^res:\/\/.+\.(tscn|scn)$/i.test(value), "scenePath must be an exact res:// .tscn or .scn path")
  .refine(isSafeResPath, SAFE_RES_PATH_MESSAGE)
  .describe("Exact scene to read or change, e.g. 'res://levels/alley.tscn'. It must be open in the editor (any tab).");

const nodePathSchema = (what: string) =>
  z
    .string()
    .trim()
    .min(1)
    .max(NODE_PATH_LIMIT_BYTES)
    .refine(utf8Within(NODE_PATH_LIMIT_BYTES), `node paths must be at most ${NODE_PATH_LIMIT_BYTES} UTF-8 bytes`)
    .refine(isSafeNodePath, SAFE_NODE_PATH_MESSAGE)
    .describe(`${what}: exact node path relative to the scene root, e.g. './Facade/Wall_01'.`);

const finite = z.number().finite();
const vec3 = z.tuple([finite, finite, finite]);
const nonZeroVec3 = vec3.refine((v) => Math.hypot(v[0], v[1], v[2]) > 1e-6, "vector must be non-zero");
const signedAxis = z.enum(AXIS_NAMES);
const worldAxis = z.enum(WORLD_AXES);
const collisionMask = z
  .number()
  .int()
  .min(0)
  .max(0xffffffff)
  .optional()
  .default(0xffffffff)
  .describe("Godot 3D physics layer mask for physics queries.");

const ASSET_PATH = /^res:\/\/.+\.(tscn|scn|glb|gltf|res|tres|mesh|obj)$/i;
const SCENE_ASSET_PATH = /^res:\/\/.+\.(tscn|scn|glb|gltf)$/i;
const NODE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_\- ]*$/;

// ---------------------------------------------------------------------------
// Probe plumbing
// ---------------------------------------------------------------------------

function fail(tool: string, failureReason: string, error: string, extra: JsonRecord = {}): PlacementResult {
  return { ok: false, tool, failure_reason: failureReason, error, ...extra };
}

function firstScriptError(entry: JsonRecord): string | undefined {
  const lists = [entry.parse_errors, entry.errors];
  for (const list of lists) {
    if (!Array.isArray(list) || list.length === 0) continue;
    const first = asRecord(list[0]);
    if (first) {
      const message = first.message ?? first.error ?? first.text;
      const line = first.line;
      if (typeof message === "string") return typeof line === "number" ? `line ${line}: ${message}` : message;
    }
    if (typeof list[0] === "string") return list[0] as string;
  }
  return undefined;
}

/**
 * Run the placement probe and return its result dictionary, or a structured
 * failure. Never mutates: undo "none", no checkpoint.
 */
export async function runPlacementProbe(
  client: PlacementClient,
  tool: string,
  args: JsonRecord,
  seconds = 20
): Promise<PlacementResult> {
  const missing = missingEngineOpResult(client, "RunSceneScript", PLACEMENT_PROBE_FALLBACK);
  if (missing) return { ...missing, tool } as PlacementResult;
  const { op, timeoutMs } = buildRunSceneScriptOp({
    source: buildPlacementScript(args),
    max_seconds: seconds,
    checkpoint: false,
    undo: "none",
  });
  const receipt = await client.executeIdentityBoundOps([op], undefined, timeoutMs);
  const hinted = asRecord(withOldEngineHint(receipt, "RunSceneScript", PLACEMENT_PROBE_FALLBACK));
  if (hinted?.failure_reason === "engine_lacks_op") {
    return fail(tool, "engine_lacks_op", String(hinted.error), { op: "RunSceneScript" });
  }
  const envelope = asRecord(receipt) ?? {};
  const results = Array.isArray(envelope.results) ? envelope.results : [];
  const entry = asRecord(results.find((item) => asRecord(item)?.op === "RunSceneScript") ?? results[0]);
  const envelopeError = extractOpError(receipt);
  if (!entry || entry.ok === false || envelopeError) {
    const reason = typeof entry?.failure_reason === "string" ? entry.failure_reason : "probe_failed";
    const scriptError = entry ? firstScriptError(entry) : undefined;
    return fail(
      tool,
      "measurement_script_failed",
      `The placement probe (RunSceneScript) failed: ${String(entry?.error ?? envelopeError ?? "no result")}`,
      { engine_failure_reason: reason, ...(scriptError ? { script_error: scriptError.slice(0, 300) } : {}) }
    );
  }
  const result = asRecord(entry.result);
  if (!result) {
    return fail(tool, "measurement_script_failed", "The placement probe ran but returned no result.");
  }
  if (result.ok !== true) {
    return fail(
      tool,
      typeof result.failure_reason === "string" ? result.failure_reason : "measurement_failed",
      typeof result.error === "string" ? result.error : "The placement probe reported a failure."
    );
  }
  return result as PlacementResult;
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Trim the named lists (in order) until the result fits; declare every trim. */
export function fitToBudget(result: JsonRecord, listKeys: string[], target = FIT_TARGET_BYTES): JsonRecord {
  if (bytes(result) <= target) return result;
  const out: JsonRecord = { ...result };
  const truncated: JsonRecord = {};
  for (const key of listKeys) {
    const original = out[key];
    if (!Array.isArray(original)) continue;
    const list = [...original];
    while (list.length > 0 && bytes({ ...out, [key]: list, truncated: { ...truncated, [key]: {} } }) > target) {
      list.pop();
    }
    if (list.length < original.length) {
      out[key] = list;
      truncated[key] = { shown: list.length, total: original.length };
    }
    if (bytes({ ...out, truncated }) <= target) break;
  }
  out.truncated = truncated;
  return out;
}

/** Engine mutation receipt -> null on success, or a compact failure. */
function mutationFailure(tool: string, receipt: unknown, extra: JsonRecord = {}): PlacementResult | null {
  const error = extractOpError(receipt);
  if (!error) return null;
  let message = error;
  let reason = "mutation_failed";
  try {
    const parsed = JSON.parse(error) as { error?: unknown; failure_reason?: unknown };
    if (typeof parsed.error === "string") message = parsed.error;
    if (typeof parsed.failure_reason === "string") reason = parsed.failure_reason;
  } catch {
    // plain-text failure
  }
  return fail(tool, reason, message.slice(0, 600), extra);
}

function opEntry(receipt: unknown, op: string): JsonRecord | undefined {
  const results = asRecord(receipt)?.results;
  if (!Array.isArray(results)) return undefined;
  return asRecord(results.find((item) => asRecord(item)?.op === op)) ?? undefined;
}

// ---------------------------------------------------------------------------
// Bounds read helpers
// ---------------------------------------------------------------------------

interface NodeBounds {
  path: string;
  resolved: string;
  geometryCount: number;
  xform: Xform;
  parent: Xform;
  position: Vec3;
  /** The node's local transform as Godot writes it (var_to_str), for an
   *  exact restore. */
  transformStr?: string;
  intervals?: Array<[number, number]>;
  reach?: number;
}

function parseBounds(record: unknown): NodeBounds {
  const r = asRecord(record) ?? {};
  return {
    path: String(r.path ?? ""),
    resolved: String(r.resolved ?? ""),
    geometryCount: typeof r.geometry_count === "number" ? r.geometry_count : 0,
    xform: xformFromArray(r.xform),
    parent: xformFromArray(r.parent_xform),
    position: (Array.isArray(r.position) ? r.position : [0, 0, 0]) as Vec3,
    transformStr: typeof r.transform_str === "string" ? r.transform_str : undefined,
    intervals: Array.isArray(r.intervals) ? (r.intervals as Array<[number, number]>) : undefined,
    reach: typeof r.reach === "number" ? r.reach : undefined,
  };
}

function dirsOf(read: JsonRecord): Vec3[] {
  return (Array.isArray(read.dirs) ? read.dirs : []) as Vec3[];
}

/** "./Facade/Wall" and "Facade/Wall" name the same node. */
function stripDotSlash(path: string): string {
  return path.startsWith("./") ? path.slice(2) || "." : path;
}

/** Path b is inside path a (scene-root-relative, "." = root). */
function isInside(inner: string, outer: string): boolean {
  if (outer === ".") return inner !== ".";
  return inner.startsWith(`${outer}/`);
}

/** World delta -> new parent-local position. */
function localPositionAfter(bounds: NodeBounds, worldDelta: Vec3): Vec3 {
  const localDelta = basisMulVec(basisInverse(bounds.parent.basis), worldDelta);
  return add(bounds.position, localDelta);
}

// ---------------------------------------------------------------------------
// summer_inspect_asset
// ---------------------------------------------------------------------------

export const inspectAssetArgsSchema = z.object({
  path: z
    .string()
    .trim()
    .min(1)
    .max(SCENE_PATH_LIMIT_BYTES)
    .refine((value) => ASSET_PATH.test(value), "path must be a res:// .tscn, .scn, .glb, .gltf, .res, .tres, .mesh or .obj file")
    .refine(isSafeResPath, SAFE_RES_PATH_MESSAGE)
    .describe("Asset to measure, e.g. 'res://kit/facade/wall_single_01.tscn'. It is loaded and instanced off-scene, never added to an open scene."),
  maxTriangles: z
    .number()
    .int()
    .min(100)
    .max(300000)
    .optional()
    .default(60000)
    .describe("Triangle budget (100-300000) for the face and open-loop analysis (AABBs and counts are always complete). summary.warnings says when the budget cut the analysis and which budget covers the whole mesh."),
  detail: z
    .enum(["summary", "full"])
    .optional()
    .default("summary")
    .describe("summary (default): open_loops lists only port-like loops (radius over 2 cm with a partner loop facing another way), or none. full: every open loop, including the outline of flat sheets."),
});
export type InspectAssetArgs = z.output<typeof inspectAssetArgsSchema>;

/** Planes the probe reports, largest first. */
interface PlaneRecord {
  normal: Vec3;
  offset: number;
  area: number;
  tris?: number;
  cull_back?: number;
}

interface LoopRecord {
  index: number;
  direction: Vec3;
  radius: number;
  direction_ambiguous?: boolean;
  [key: string]: unknown;
}

/** Normals closer than this (cosine) are one plane direction. */
const PAIR_COS = 0.996;
/** Pairs smaller than this share of the largest pair are left out. */
const PAIR_MIN_AREA_FRACTION = 0.01;
/** A normal this close (cosine) to a signed axis is labelled with it. */
const AXIS_LABEL_COS = 0.9998;
const PORT_MIN_RADIUS = 0.02;
const PORT_RADIUS_RATIO = 0.7;
/** Partner loops must face more than 60 degrees apart. */
const PORT_PARTNER_COS = 0.5;
const SUMMARY_PLANE_COUNT = 6;

function axisLabel(normal: Vec3): SignedAxis | undefined {
  for (const axis of AXIS_NAMES) {
    if (dot(normal, signedAxisVector(axis)) >= AXIS_LABEL_COS) return axis;
  }
  return undefined;
}

function planeOut(plane: PlaneRecord): JsonRecord {
  const label = axisLabel(plane.normal);
  return {
    ...(label ? { axis: label } : {}),
    normal: roundVec(plane.normal, 4),
    offset: round(plane.offset),
    area: round(plane.area, 4),
    ...(typeof plane.cull_back === "number" ? { one_sided: plane.cull_back >= 0.5 } : {}),
  };
}

/**
 * The two largest pairs of opposite planes, for reading facing at a glance:
 * per plane direction the largest plane and the largest one facing the other
 * way (null for a single sheet), ranked by their combined area; pairs under 1%
 * of the largest pair's area are left out. Exported for tests.
 */
export function planePairs(planes: PlaneRecord[], limit = 2): JsonRecord[] {
  const groups: Array<{ larger: PlaneRecord; opposite?: PlaneRecord }> = [];
  for (const plane of [...planes].sort((a, b) => b.area - a.area)) {
    const group = groups.find((g) => Math.abs(dot(g.larger.normal, plane.normal)) >= PAIR_COS);
    if (!group) {
      groups.push({ larger: plane });
    } else if (!group.opposite && dot(group.larger.normal, plane.normal) < 0) {
      group.opposite = plane;
    }
  }
  const area = (g: { larger: PlaneRecord; opposite?: PlaneRecord }) => g.larger.area + (g.opposite?.area ?? 0);
  const ranked = groups.sort((a, b) => area(b) - area(a));
  const floor = ranked.length ? area(ranked[0]!) * PAIR_MIN_AREA_FRACTION : 0;
  return ranked
    .filter((g) => area(g) >= floor)
    .slice(0, limit)
    .map((g) => ({
      larger: planeOut(g.larger),
      opposite: g.opposite ? planeOut(g.opposite) : null,
      ...(g.opposite ? { separation: round(g.larger.offset + g.opposite.offset) } : {}),
    }));
}

/**
 * Loops that look like pipe or duct ends: radius over 2 cm, a decided
 * direction, and at least one partner loop of similar radius facing more than
 * 60 degrees away (the other end of a straight run or a bend). The outline of
 * a flat sheet and its holes all face one way and never qualify. Exported for
 * tests.
 */
export function portLikeLoops<T extends LoopRecord>(loops: T[]): T[] {
  const candidates = loops.filter((loop) => loop.radius > PORT_MIN_RADIUS && !loop.direction_ambiguous);
  return candidates.filter((loop) =>
    candidates.some(
      (other) =>
        other !== loop &&
        Math.min(other.radius, loop.radius) / Math.max(other.radius, loop.radius) >= PORT_RADIUS_RATIO &&
        dot(normalize(other.direction), normalize(loop.direction)) < PORT_PARTNER_COS
    )
  );
}

function inspectSummary(probe: JsonRecord, planes: PlaneRecord[], portLike: LoopRecord[]): JsonRecord {
  const analysis = asRecord(probe.analysis) ?? {};
  const triangles = typeof probe.triangles === "number" ? probe.triangles : 0;
  const warnings: string[] = [];
  if (analysis.truncated === true) {
    const analyzed = typeof analysis.triangles_analyzed === "number" ? analysis.triangles_analyzed : 0;
    warnings.push(
      `the triangle budget cut the analysis (${analyzed} of ${triangles} triangles): planes and open loops are incomplete; pass maxTriangles ${Math.min(300000, Math.max(triangles, 100))} for the whole mesh`
    );
  }
  return {
    aabb: probe.aabb ?? null,
    origin: probe.origin ?? null,
    plane_pairs: planePairs(planes),
    port_like_loops: portLike.map((loop) => loop.index),
    triangles,
    mesh_count: probe.mesh_count ?? 0,
    anchor_count: probe.anchor_count ?? 0,
    collision_count: probe.collision_count ?? 0,
    ...(warnings.length ? { warnings } : {}),
  };
}

export async function inspectAsset(client: PlacementClient, args: InspectAssetArgs): Promise<PlacementResult> {
  const tool = "summer_inspect_asset";
  const probe = await runPlacementProbe(client, tool, {
    cmd: "inspect_asset",
    path: args.path,
    max_triangles: args.maxTriangles,
  }, 30);
  if (!probe.ok) return probe;
  const planes = (Array.isArray(probe.planes) ? probe.planes : []) as PlaneRecord[];
  const loops = (Array.isArray(probe.open_loops) ? probe.open_loops : []) as LoopRecord[];
  const portLike = portLikeLoops(loops);
  const { ok: _ok, planes: _planes, open_loops: _loops, ...rest } = probe;
  const listed = args.detail === "full" ? loops : portLike;
  const result: JsonRecord = {
    ok: true,
    tool,
    detail: args.detail,
    summary: inspectSummary(probe, planes, portLike),
    ...rest,
    planes: planes.slice(0, SUMMARY_PLANE_COUNT).map((plane) => ({ ...plane, ...(typeof plane.cull_back === "number" ? { one_sided: plane.cull_back >= 0.5 } : {}) })),
    open_loops: listed,
    ...(args.detail === "full" ? {} : { open_loops_listed: "port_like", open_loops_omitted: loops.length - listed.length }),
    evidence: "mesh_triangles",
  };
  return fitToBudget(result, ["meshes", "collision", "anchors", "open_loops", "planes"]) as PlacementResult;
}

// ---------------------------------------------------------------------------
// summer_measure
// ---------------------------------------------------------------------------

export const measureArgsSchema = z.object({
  scenePath: scenePathSchema,
  mode: z
    .enum(["pair", "plane"])
    .optional()
    .default("pair")
    .describe("pair: gap or overlap per axis between nodes a and b. plane: whether one face of every node in `nodes` lies on one plane."),
  a: nodePathSchema("pair mode, first node").optional(),
  b: nodePathSchema("pair mode, second node").optional(),
  axis: worldAxis.optional().describe("pair mode: report only this axis (x, y or z of the chosen space)."),
  nodes: z
    .array(nodePathSchema("plane mode node"))
    .min(2)
    .max(32)
    .optional()
    .describe("plane mode: 2-32 nodes whose face is checked, e.g. every module of one facade line."),
  face: signedAxis
    .optional()
    .describe("plane mode: which face, e.g. '+z' for the face pointing along +z (a facade front that looks toward +z)."),
  space: z
    .enum(["world", "local"])
    .optional()
    .default("world")
    .describe("world: world axes. local: the axes of a (pair) or nodes[0] (plane), for rotated facades."),
  tolerance: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0.005)
    .describe("Distance in scene units treated as touching (pair) or coplanar (plane). Default 5 mm."),
});
export type MeasureArgs = z.output<typeof measureArgsSchema>;

export async function measure(client: PlacementClient, args: MeasureArgs): Promise<PlacementResult> {
  const tool = "summer_measure";
  if (args.mode === "plane") {
    if (!args.nodes || !args.face) {
      throw new ToolInputError("plane mode needs nodes (2-32 paths) and face (e.g. '+z').");
    }
    return measurePlane(client, tool, args, args.nodes, args.face);
  }
  if (!args.a || !args.b) throw new ToolInputError("pair mode needs a and b.");
  if (args.a === args.b) throw new ToolInputError("a and b must be different nodes.");
  const read = await runPlacementProbe(client, tool, {
    cmd: "bounds",
    scene_path: args.scenePath,
    space_node: args.space === "local" ? args.a : "",
    nodes: [{ path: args.a }, { path: args.b }],
  });
  if (!read.ok) return read;
  const nodes = (read.nodes as unknown[]).map(parseBounds);
  const [a, b] = [nodes[0]!, nodes[1]!];
  for (const node of [a, b]) {
    if (!node.intervals) {
      return fail(tool, "no_visual_bounds", `${node.path} has no visible GeometryInstance3D bounds to measure.`);
    }
  }
  const names = WORLD_AXES;
  const axes: JsonRecord = {};
  const seps: number[] = [];
  for (let k = 0; k < 3; k++) {
    const [amin, amax] = a.intervals![k]!;
    const [bmin, bmax] = b.intervals![k]!;
    const sep = Math.max(bmin - amax, amin - bmax);
    seps.push(sep);
    if (args.axis && names[k] !== args.axis) continue;
    axes[names[k]!] = {
      gap: round(sep),
      relation: sep > args.tolerance ? "gap" : sep < -args.tolerance ? "overlap" : "touching",
      a: [round(amin), round(amax)],
      b: [round(bmin), round(bmax)],
      delta_min: round(bmin - amin),
      delta_max: round(bmax - amax),
      delta_center: round((bmin + bmax) / 2 - (amin + amax) / 2),
    };
  }
  return {
    ok: true,
    tool,
    mode: "pair",
    evidence: "visual_aabb",
    space: read.space,
    ...(read.space === "local" ? { dirs: dirsOf(read).map((v) => roundVec(v, 4)) } : {}),
    a: a.resolved,
    b: b.resolved,
    tolerance: args.tolerance,
    axes,
    boxes_overlap: seps.every((sep) => sep < -args.tolerance),
    note: "gap > 0 is clearance, gap < 0 is overlap depth; delta_* are b minus a. Bounds are visible-mesh AABBs (projected corners in local space), not triangle contact.",
  };
}

async function measurePlane(
  client: PlacementClient,
  tool: string,
  args: MeasureArgs,
  nodes: string[],
  face: SignedAxis
): Promise<PlacementResult> {
  if (new Set(nodes).size !== nodes.length) throw new ToolInputError("nodes must not contain duplicates.");
  const read = await runPlacementProbe(client, tool, {
    cmd: "bounds",
    scene_path: args.scenePath,
    space_node: args.space === "local" ? nodes[0] : "",
    nodes: nodes.map((path) => ({ path })),
  });
  if (!read.ok) return read;
  const k = axisIndex(face[1] as WorldAxis);
  const positive = face[0] === "+";
  const parsed = (read.nodes as unknown[]).map(parseBounds);
  const measured = parsed
    .filter((node) => node.intervals)
    .map((node) => ({ path: node.resolved, coord: positive ? node.intervals![k]![1] : node.intervals![k]![0] }));
  const missing = parsed.filter((node) => !node.intervals).map((node) => node.resolved);
  if (measured.length < 2) {
    return fail(tool, "no_visual_bounds", "Fewer than two of the nodes have visible geometry to measure.", { no_geometry: missing });
  }
  const sorted = measured.map((entry) => entry.coord).sort((x, y) => x - y);
  const mid = sorted.length / 2;
  const median = sorted.length % 2 ? sorted[Math.floor(mid)]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const spread = sorted[sorted.length - 1]! - sorted[0]!;
  const rows = measured
    .map((entry) => {
      const deviation = entry.coord - median;
      const outward = positive ? deviation : -deviation;
      return {
        path: entry.path,
        face: round(entry.coord),
        deviation: round(deviation),
        ...(Math.abs(deviation) > args.tolerance ? { off_plane: outward > 0 ? "proud" : "recessed" } : {}),
      };
    })
    .sort((x, y) => Math.abs(y.deviation) - Math.abs(x.deviation));
  const result: JsonRecord = {
    ok: true,
    tool,
    mode: "plane",
    evidence: "visual_aabb",
    face,
    space: read.space,
    ...(read.space === "local" ? { dirs: dirsOf(read).map((v) => roundVec(v, 4)) } : {}),
    tolerance: args.tolerance,
    coplanar: spread <= args.tolerance,
    plane: round(median),
    spread: round(spread),
    off_plane_count: rows.filter((row) => "off_plane" in row).length,
    nodes: rows,
    ...(missing.length ? { no_geometry: missing } : {}),
    note: "face is the node's extreme visible-mesh coordinate along the face axis; proud = sticks out past the median plane in the face's direction.",
  };
  return fitToBudget(result, ["nodes"]) as PlacementResult;
}

// ---------------------------------------------------------------------------
// summer_raycast
// ---------------------------------------------------------------------------

export const raycastArgsSchema = z.object({
  scenePath: scenePathSchema,
  origin: vec3.describe("Ray start in scene (world) space [x, y, z]. Nothing needs to be placed there."),
  direction: nonZeroVec3.describe("Ray direction [x, y, z]; normalized for you."),
  maxDistance: z.number().positive().max(10000).optional().default(100).describe("Maximum ray length in scene units."),
  collisionMask,
  collideWithAreas: z.boolean().optional().default(false).describe("Also hit Area3D volumes (physics only)."),
  evidence: z
    .enum(["auto", "physics", "visual_aabb"])
    .optional()
    .default("auto")
    .describe("auto: physics first, visual AABB fallback when physics finds nothing (declared). physics or visual_aabb: that channel only."),
  exclude: z
    .array(nodePathSchema("node to ignore"))
    .max(16)
    .optional()
    .describe("Nodes (with their descendants) the ray ignores, e.g. the piece you are about to move."),
});
export type RaycastArgs = z.output<typeof raycastArgsSchema>;

interface RayHit {
  path: string;
  point: Vec3;
  normal: Vec3;
  distance: number;
}

function parseHit(value: unknown): RayHit | undefined {
  const r = asRecord(value);
  if (!r) return undefined;
  return {
    path: String(r.path ?? ""),
    point: r.point as Vec3,
    normal: r.normal as Vec3,
    distance: Number(r.distance),
  };
}

function hitOut(hit: RayHit): JsonRecord {
  return { path: hit.path, point: roundVec(hit.point), normal: roundVec(hit.normal, 4), distance: round(hit.distance) };
}

/** physics first; the visual AABB hit only when physics has none (declared). */
function chooseHit(
  read: JsonRecord,
  evidence: "auto" | "physics" | "visual_aabb"
): { hit?: RayHit; evidence?: string; fallback?: string; nearerVisual?: RayHit; warnings: string[] } {
  const physics = parseHit(read.physics);
  const visual = parseHit(read.visual);
  const warnings: string[] = [];
  if (typeof read.visual_origin_inside === "number" && read.visual_origin_inside > 0) {
    warnings.push(`ray_origin_inside_${read.visual_origin_inside}_visual_bounds_ignored`);
  }
  if (read.visual_truncated === true) warnings.push("visual_scan_truncated_at_20000_nodes");
  if (evidence === "visual_aabb") return { hit: visual, evidence: visual ? "visual_aabb" : undefined, warnings };
  if (physics) {
    const nearerVisual =
      evidence === "auto" && visual && visual.distance < physics.distance - 0.01 ? visual : undefined;
    return { hit: physics, evidence: "physics", nearerVisual, warnings };
  }
  if (evidence === "physics") return { warnings };
  if (visual) {
    const why = read.physics_available === true ? "physics_ray_hit_nothing" : `physics_unavailable_${String(read.physics_unavailable_reason || "unknown")}`;
    return { hit: visual, evidence: "visual_aabb", fallback: why, warnings };
  }
  return { warnings };
}

export async function raycast(client: PlacementClient, args: RaycastArgs): Promise<PlacementResult> {
  const tool = "summer_raycast";
  const read = await runPlacementProbe(client, tool, {
    cmd: "raycast",
    scene_path: args.scenePath,
    origin: args.origin,
    direction: args.direction,
    max_distance: args.maxDistance,
    collision_mask: args.collisionMask,
    collide_with_areas: args.collideWithAreas,
    evidence: args.evidence,
    exclude: args.exclude ?? [],
  });
  if (!read.ok) return read;
  if (args.evidence === "physics" && read.physics_available !== true) {
    return fail(tool, "physics_unavailable", `Physics ray unavailable: ${String(read.physics_unavailable_reason ?? "unknown")}. The scene must be the active editor tab for physics queries; use evidence 'auto' or 'visual_aabb', or open the scene with summer_open_scene.`);
  }
  const chosen = chooseHit(read, args.evidence);
  return {
    ok: true,
    tool,
    hit: Boolean(chosen.hit),
    ...(chosen.hit ? { evidence: chosen.evidence, ...hitOut(chosen.hit) } : {}),
    ...(chosen.fallback ? { fallback: true, fallback_reason: chosen.fallback } : {}),
    ...(chosen.nearerVisual ? { nearer_visual_only: hitOut(chosen.nearerVisual) } : {}),
    origin: roundVec(args.origin),
    direction: roundVec(normalize(args.direction), 4),
    physics_available: read.physics_available === true,
    ...(read.physics_available !== true ? { physics_unavailable_reason: read.physics_unavailable_reason } : {}),
    warnings: chosen.warnings,
  };
}

// ---------------------------------------------------------------------------
// summer_place_adjacent
// ---------------------------------------------------------------------------

const alignMode = z.enum(["min", "center", "max", "none"]);
type AlignMode = z.output<typeof alignMode>;

export const placeAdjacentArgsSchema = z.object({
  scenePath: scenePathSchema,
  subject: nodePathSchema("Node to move"),
  reference: nodePathSchema("Node that stays put"),
  axis: worldAxis.describe("Axis along which the two pieces meet (x, y or z of the chosen space)."),
  side: z
    .enum(["min", "max"])
    .describe("max: subject goes on the reference's +axis side (its min face against the reference's max face). min: the -axis side."),
  gap: z
    .number()
    .finite()
    .min(-100)
    .max(1000)
    .optional()
    .default(0)
    .describe("Distance between the two faces along axis. 0 = flush; negative = overlap (inset)."),
  alignOtherAxes: z
    .union([
      alignMode,
      z.object({ x: alignMode.optional(), y: alignMode.optional(), z: alignMode.optional() }),
    ])
    .optional()
    .default("none")
    .describe("How to line up the other two axes: min, center, max or none (keep). One mode for both, or per axis, e.g. {y: 'min', z: 'max'} for same base height and one front plane."),
  space: z
    .enum(["world", "local"])
    .optional()
    .default("world")
    .describe("world: world axes. local: the reference's own axes, for a rotated facade."),
});
export type PlaceAdjacentArgs = z.output<typeof placeAdjacentArgsSchema>;

function alignFor(args: PlaceAdjacentArgs, axis: WorldAxis): AlignMode {
  const spec = args.alignOtherAxes;
  if (typeof spec === "string") return spec;
  return spec[axis] ?? "none";
}

/** Per-axis translation that puts subject against reference. Exported for tests. */
export function adjacentDeltas(
  subject: Array<[number, number]>,
  reference: Array<[number, number]>,
  axis: WorldAxis,
  side: "min" | "max",
  gap: number,
  align: (axis: WorldAxis) => AlignMode
): Vec3 {
  const main = axisIndex(axis);
  const out: Vec3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const [smin, smax] = subject[k]!;
    const [rmin, rmax] = reference[k]!;
    if (k === main) {
      out[k] = side === "max" ? rmax + gap - smin : rmin - gap - smax;
      continue;
    }
    const mode = align(WORLD_AXES[k]!);
    out[k] =
      mode === "min" ? rmin - smin : mode === "max" ? rmax - smax : mode === "center" ? (rmin + rmax - smin - smax) / 2 : 0;
  }
  return out;
}

export async function placeAdjacent(client: PlacementClient, args: PlaceAdjacentArgs): Promise<PlacementResult> {
  const tool = "summer_place_adjacent";
  if (args.subject === args.reference) throw new ToolInputError("subject and reference must be different nodes.");
  const typed = args.alignOtherAxes;
  if (typeof typed === "object" && typed[args.axis] !== undefined) {
    throw new ToolInputError(`alignOtherAxes.${args.axis} is the placement axis itself; set gap and side instead.`);
  }
  const readArgs = {
    cmd: "bounds",
    scene_path: args.scenePath,
    space_node: args.space === "local" ? args.reference : "",
    nodes: [{ path: args.subject }, { path: args.reference, exclude: [args.subject] }],
  };
  const read = await runPlacementProbe(client, tool, readArgs);
  if (!read.ok) return read;
  const [subject, reference] = (read.nodes as unknown[]).map(parseBounds) as [NodeBounds, NodeBounds];
  if (isInside(reference.resolved, subject.resolved)) {
    return fail(tool, "reference_inside_subject", "The reference is inside the subject, so moving the subject would move the reference too.");
  }
  if (!subject.intervals) return fail(tool, "subject_has_no_visual_bounds", `${args.subject} has no visible GeometryInstance3D bounds.`);
  if (!reference.intervals) return fail(tool, "reference_has_no_visual_bounds", `${args.reference} has no visible GeometryInstance3D bounds (outside the subject).`);
  const dirs = dirsOf(read);
  const deltas = adjacentDeltas(subject.intervals, reference.intervals, args.axis, args.side, args.gap, (axis) => alignFor(args, axis));
  const worldDelta = dirs.reduce<Vec3>((acc, dir, k) => add(acc, scale(dir, deltas[k]!)), [0, 0, 0]);
  const excludes = Array.isArray(read.excluded) && read.excluded.length > 0;
  const base: JsonRecord = {
    tool,
    evidence: "visual_aabb",
    space: read.space,
    subject: subject.resolved,
    reference: reference.resolved,
    axis: args.axis,
    side: args.side,
    gap: args.gap,
    ...(excludes ? { reference_excludes_subject: true } : {}),
  };
  if (length(worldDelta) < 1e-6) {
    return { ok: true, ...base, moved: false, moved_by: [0, 0, 0], saved: false, note: "Already in place; nothing was changed." };
  }
  const position = localPositionAfter(subject, worldDelta);
  const receipt = await executeSceneMutation(client, args.scenePath, [
    { op: "SetProp", path: args.subject, key: "position", value: toGodotVector3(position) },
  ]);
  const failed = mutationFailure(tool, receipt);
  if (failed) return failed;
  // Verify from a fresh read: the achieved gap and alignment residuals.
  const after = await runPlacementProbe(client, tool, readArgs);
  const result: JsonRecord = {
    ok: true,
    ...base,
    moved: true,
    moved_by: roundVec(worldDelta),
    position: roundVec(position),
    saved: true,
  };
  if (!after.ok) {
    result.verify = { ok: false, error: after.error };
    return result as PlacementResult;
  }
  const [s2, r2] = (after.nodes as unknown[]).map(parseBounds) as [NodeBounds, NodeBounds];
  if (s2.intervals && r2.intervals) {
    const main = axisIndex(args.axis);
    const achievedGap =
      args.side === "max" ? s2.intervals[main]![0] - r2.intervals[main]![1] : r2.intervals[main]![0] - s2.intervals[main]![1];
    const residuals: JsonRecord = {};
    const remaining = adjacentDeltas(s2.intervals, r2.intervals, args.axis, args.side, args.gap, (axis) => alignFor(args, axis));
    WORLD_AXES.forEach((name, k) => {
      if (k !== main && alignFor(args, name) !== "none") residuals[name] = round(remaining[k]!);
    });
    result.verify = { gap: round(achievedGap), residuals };
  }
  return result as PlacementResult;
}

// ---------------------------------------------------------------------------
// summer_attach_to_surface
// ---------------------------------------------------------------------------

export const attachToSurfaceArgsSchema = z.object({
  scenePath: scenePathSchema,
  subject: nodePathSchema("Piece to mount"),
  surface: nodePathSchema("Surface node (wall, ceiling, floor). Without ray, the ray runs from the subject's origin to the nearest point of this node's bounds; with ray, hits on other nodes are skipped. The seat must land on this node: a seat on any other node is refused and the piece is put back").optional(),
  ray: z
    .object({
      origin: vec3.describe("Ray start [x, y, z] in scene space, e.g. a point in front of the wall."),
      direction: nonZeroVec3.describe("Ray direction [x, y, z], e.g. toward the wall."),
    })
    .optional()
    .describe("Explicit ray that finds the surface plane and its normal. Pass this or surface (or both)."),
  placeAt: z
    .enum(["current", "hit"])
    .optional()
    .default("current")
    .describe("current (default): the piece keeps its height and its place along the surface and only moves along the surface normal, so its measured back face ends at standoff from the surface. hit: it also slides along the surface so the centre of its back face lands on the ray hit point (its height then follows the ray)."),
  maxMove: z
    .number()
    .positive()
    .max(100)
    .optional()
    .default(2)
    .describe("Refuse, changing nothing, when the piece would end farther than this from where it starts (scene units). Place the piece near its mount first; raise this only for a deliberate long move."),
  backAxis: signedAxis
    .optional()
    .default("-z")
    .describe("The subject's LOCAL axis that must face into the surface, e.g. '-z' for a piece whose back is -Z. Measure it first with summer_inspect_asset."),
  upAxis: signedAxis
    .optional()
    .default("+y")
    .describe("The subject's LOCAL axis kept closest to worldUp. Must not be on the same line as backAxis."),
  worldUp: nonZeroVec3.optional().default([0, 1, 0]).describe("World direction the upAxis should follow (projected onto the surface)."),
  standoff: z.number().min(0).max(10).optional().default(0).describe("Gap between the subject's back face and the surface, in scene units."),
  maxDistance: z.number().positive().max(1000).optional().default(20).describe("Maximum ray length when looking for the surface."),
  collisionMask,
});
export type AttachToSurfaceArgs = z.output<typeof attachToSurfaceArgsSchema>;

/** The piece is turned and put this far in front of its planned seat before
 *  SnapToSurface sweeps it in. */
export const ATTACH_PRESEAT_CLEARANCE = 0.05;
/** How far past the planned seat the sweep may go (a collider set back from
 *  the visible back face). */
export const ATTACH_SEAT_REACH = 0.25;
/** A seat this far in front of the planned plane stopped on something else. */
export const ATTACH_PLAN_TOLERANCE = 0.03;

/** Extents of a node's visible bounds along its own local axes, relative to
 *  its origin: lo/hi per local x, y, z. Exported for tests. */
export function localExtents(intervals: Array<[number, number]>, dirs: Vec3[], origin: Vec3): { lo: Vec3; hi: Vec3 } {
  const lo: Vec3 = [0, 0, 0];
  const hi: Vec3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const at = dot(origin, dirs[k]!);
    lo[k] = intervals[k]![0] - at;
    hi[k] = intervals[k]![1] - at;
  }
  return { lo, hi };
}

/**
 * Where the subject's origin must go so its back face (the extreme of its
 * visible bounds along backAxis) sits standoff in front of the surface plane
 * through hitPoint. `current` keeps the origin's place along the surface (and
 * so its height on a wall); `hit` puts the centre of the back face on the hit
 * point. `rotation` maps local unit axes to their new world directions.
 * Exported for tests.
 */
export function seatOrigin(plan: {
  origin: Vec3;
  extents: { lo: Vec3; hi: Vec3 };
  backAxis: SignedAxis;
  rotation: Basis3;
  hitPoint: Vec3;
  normal: Vec3;
  standoff: number;
  placeAt: "current" | "hit";
}): { origin: Vec3; backOffset: number; backCentre: Vec3 } {
  const n = normalize(plan.normal);
  const k = axisIndex(plan.backAxis[1] as WorldAxis);
  const positive = plan.backAxis[0] === "+";
  const { lo, hi } = plan.extents;
  // Distance from the origin to the back face, measured along the back axis.
  const backOffset = positive ? hi[k]! : -lo[k]!;
  // The back face's centre relative to the origin, turned into the mount.
  const centre: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  centre[k] = positive ? hi[k]! : lo[k]!;
  const offset = basisMulVec(plan.rotation, centre);
  if (plan.placeAt === "current") {
    const depth = plan.standoff + backOffset - dot(sub(plan.origin, plan.hitPoint), n);
    const origin = add(plan.origin, scale(n, depth));
    return { origin, backOffset, backCentre: add(origin, offset) };
  }
  const backCentre = add(plan.hitPoint, scale(n, plan.standoff));
  return { origin: sub(backCentre, offset), backOffset, backCentre };
}

/** Same node, or one inside the other ("./" ignored; the engine cuts paths
 *  over 160 characters to 157 + "..."). */
function pathRelation(support: string, intended: string): "same" | "inside" | "ancestor" | "other" {
  const a = stripDotSlash(support);
  const b = stripDotSlash(intended);
  if (a.endsWith("...")) {
    const prefix = a.slice(0, -3);
    return b.startsWith(prefix) || prefix.startsWith(b) ? "inside" : "other";
  }
  if (a === b) return "same";
  if (isInside(a, b)) return "inside";
  if (isInside(b, a)) return "ancestor";
  return "other";
}

/** The mounting rotation: local back -> -normal, local up -> world up projected
 *  onto the surface plane. Exported for tests. */
export function mountingRotation(
  backAxis: SignedAxis,
  upAxis: SignedAxis,
  normal: Vec3,
  worldUp: Vec3,
  currentUp?: Vec3
): { rotation: Basis3; up: Vec3; usedCurrentUp: boolean } | null {
  const n = normalize(normal);
  const project = (v: Vec3): Vec3 => sub(v, scale(n, dot(v, n)));
  let up = project(worldUp);
  let usedCurrentUp = false;
  if (length(up) < 1e-3 && currentUp) {
    up = project(currentUp);
    usedCurrentUp = true;
  }
  if (length(up) < 1e-3) return null;
  up = normalize(up);
  const rotation = rotationFromFrames(signedAxisVector(backAxis), signedAxisVector(upAxis), scale(n, -1), up);
  return { rotation, up, usedCurrentUp };
}

function scaledBasis(rotation: Basis3, s: Vec3): Basis3 {
  return [scale(rotation[0], s[0]), scale(rotation[1], s[1]), scale(rotation[2], s[2])];
}

function compactSnap(entry: JsonRecord | undefined): JsonRecord {
  if (!entry) return {};
  const after = asRecord(entry.after);
  const keep: JsonRecord = {};
  for (const key of ["ok", "evidence", "supportPath", "finalGap", "gapErrorBound", "initiallyOverlapping", "backoffDistance", "hitTravel", "failure_reason", "failureReason", "error"]) {
    if (entry[key] !== undefined) keep[key] = entry[key];
  }
  if (after && Array.isArray(after.origin)) keep.origin = after.origin;
  if (Array.isArray(entry.warnings) && entry.warnings.length) keep.warnings = (entry.warnings as unknown[]).slice(0, 6);
  return keep;
}

/** What blocks the subject where it stands (the placement probe's blockers
 *  command), compacted; undefined when the probe itself failed. */
async function readBlockers(
  client: PlacementClient,
  tool: string,
  args: AttachToSurfaceArgs,
  direction: Vec3,
  distance: number
): Promise<JsonRecord | undefined> {
  const read = await runPlacementProbe(client, tool, {
    cmd: "blockers",
    scene_path: args.scenePath,
    path: args.subject,
    direction: roundVec(direction, 6),
    max_distance: distance,
    collision_mask: args.collisionMask,
  });
  if (!read.ok) return undefined;
  const overlaps = (Array.isArray(read.overlaps) ? read.overlaps : []).map(String);
  const contact = asRecord(read.first_contact);
  return {
    evidence: read.evidence,
    overlapping: overlaps.length > 0,
    overlaps: overlaps.slice(0, 8),
    first_contact: contact ? { path: String(contact.path), distance: round(Number(contact.distance)) } : null,
  };
}

/** One concrete next step for a failed seat, naming what blocked it. */
export function seatNextStep(reason: string, blockers: JsonRecord | undefined, sweep: number): string {
  const overlaps = Array.isArray(blockers?.overlaps) ? (blockers!.overlaps as string[]) : [];
  const contact = asRecord(blockers?.first_contact);
  const blocker = typeof contact?.path === "string" ? contact.path : overlaps[0];
  switch (reason) {
    case "overlap_recovery_exceeded":
    case "aligned_overlap_recovery_exceeded":
      return `In front of the surface the piece already overlaps ${overlaps.length ? overlaps.join(", ") : "something"}, and backing away from the surface does not clear it (it is probably sunk into the floor or a neighbour). Move it clear of ${blocker ?? "that node"} (for example lift it a few cm) and re-run.`;
    case "gap_exceeds_hit_travel":
      return `${blocker ?? "Something"} sits between the piece and the surface, closer than the standoff. Move the piece along the surface clear of it, lower standoff, or name ${blocker ?? "it"} as surface if that is the intended mount.`;
    case "surface_not_found":
      return `The seat sweep (${round(sweep)} along -normal from just in front of the planned seat) touched nothing: the surface has no collider there, or the piece's collider sits farther behind its visible back. Compare summer_inspect_asset collision with aabb, and check the spot with summer_raycast.`;
    case "subject_not_ready":
      return "Make the scene the active editor tab (summer_open_scene) and re-run: the seat needs the scene's physics.";
    default:
      return "Read seat.error and fix the cause, then re-run.";
  }
}

export async function attachToSurface(client: PlacementClient, args: AttachToSurfaceArgs): Promise<PlacementResult> {
  const tool = "summer_attach_to_surface";
  if (!args.surface && !args.ray) throw new ToolInputError("Pass surface (a node path) or ray ({origin, direction}).");
  if (sameAxisLine(args.backAxis, args.upAxis)) throw new ToolInputError("backAxis and upAxis must be different axes.");
  if (args.surface && args.surface === args.subject) throw new ToolInputError("surface must not be the subject.");
  const missingSnap = missingEngineOpResult(client, "SnapToSurface", SNAP_TO_SURFACE_FALLBACK);
  if (missingSnap) return { ...missingSnap, tool } as PlacementResult;
  const ray = args.ray
    ? { origin: args.ray.origin, direction: args.ray.direction }
    : { origin: [0, 0, 0], direction: [0, 0, -1], from_subject: args.subject };
  const read = await runPlacementProbe(client, tool, {
    cmd: "multi",
    scene_path: args.scenePath,
    steps: [
      // The subject's bounds along its OWN axes: where its back face is.
      { cmd: "bounds", space_node: args.subject, nodes: [{ path: args.subject }] },
      {
        cmd: "raycast",
        ...ray,
        surface: args.surface ?? "",
        exclude: [args.subject],
        max_distance: args.maxDistance,
        collision_mask: args.collisionMask,
        evidence: "auto",
      },
    ],
  });
  if (!read.ok) return read;
  const [boundsStep, rayStep] = read.steps as [JsonRecord, JsonRecord];
  const subject = parseBounds((boundsStep.nodes as unknown[])[0]);
  if (!subject.intervals) {
    return fail(tool, "subject_has_no_visual_bounds", `${args.subject} has no visible geometry to seat.`);
  }
  if (basisDeterminant(subject.xform.basis) < 0) {
    return fail(tool, "mirrored_subject", `${args.subject} is mirrored (negative scale here or on a parent); turning it with a rotation would un-mirror it. Place it with summer_set_prop instead.`);
  }
  const chosen = chooseHit(rayStep, "auto");
  if (!chosen.hit) {
    return fail(tool, "surface_not_hit", args.surface ? `The ray did not hit ${args.surface} within ${args.maxDistance}.` : `The ray hit nothing within ${args.maxDistance}.`, {
      origin: roundVec(rayStep.origin as Vec3),
      direction: roundVec(rayStep.direction as Vec3, 4),
    });
  }
  const hit = chosen.hit;
  const warnings = [...chosen.warnings];
  if (chosen.fallback) warnings.push(`surface_found_by_visual_aabb (${chosen.fallback}): the normal is an AABB face normal`);
  if (chosen.nearerVisual) warnings.push(`mesh_only_geometry_nearer_than_hit: ${chosen.nearerVisual.path}`);
  let n = normalize(hit.normal);
  // The piece mounts on the side the ray came from, also when the ray hit a
  // back face whose normal points away from it.
  if (Array.isArray(rayStep.direction) && dot(n, rayStep.direction as Vec3) > 0) {
    n = scale(n, -1);
    warnings.push("hit_normal_pointed_away_from_the_ray_flipped");
  }
  const currentUp = basisMulVec(subject.xform.basis, signedAxisVector(args.upAxis));
  const mount = mountingRotation(args.backAxis, args.upAxis, n, args.worldUp, currentUp);
  if (!mount) {
    return fail(tool, "up_axis_degenerate", "worldUp and the subject's current up are both parallel to the surface normal; pass a worldUp that lies along the surface.");
  }
  if (mount.usedCurrentUp) warnings.push("world_up_parallel_to_normal_kept_current_up");

  const start = subject.xform.origin;
  const extents = localExtents(subject.intervals, dirsOf(boundsStep), start);
  const plan = seatOrigin({
    origin: start,
    extents,
    backAxis: args.backAxis,
    rotation: mount.rotation,
    hitPoint: hit.point,
    normal: n,
    standoff: args.standoff,
    placeAt: args.placeAt,
  });
  const surfaceHit = { evidence: chosen.evidence, ...hitOut(hit) };
  const base: JsonRecord = {
    tool,
    subject: subject.resolved,
    placed_at: args.placeAt,
    surface_hit: surfaceHit,
    orientation: {
      backAxis: args.backAxis,
      upAxis: args.upAxis,
      world_back: roundVec(scale(n, -1), 4),
      world_up: roundVec(mount.up, 4),
    },
    back_face_offset: round(plan.backOffset),
    standoff: args.standoff,
  };
  // How far along the surface the hit is from the piece's back face: in
  // "current" mode the piece stays where it is along the surface, so a hit
  // metres to the side means the ray found the surface somewhere else.
  const toHit = sub(hit.point, plan.backCentre);
  const alongSurface = length(sub(toHit, scale(n, dot(toHit, n))));
  if (alongSurface > args.maxMove) {
    return fail(tool, "hit_far_from_piece", `The ray hit ${hit.path} ${round(alongSurface)} along the surface from the piece, more than maxMove ${args.maxMove}. placeAt "current" keeps the piece where it is along the surface, so it would not go to the hit. Nothing was changed.`, {
      ...base,
      mutationApplied: false,
      saved: false,
      next_step: "Aim the ray at the piece, pass placeAt \"hit\" to move it to the hit point, or place it near the hit first (summer_set_prop position).",
    });
  }
  const plannedMove = length(sub(plan.origin, start));
  if (plannedMove > args.maxMove) {
    return fail(tool, "move_exceeds_max_move", `The piece would move ${round(plannedMove)} from where it starts, more than maxMove ${args.maxMove}. Nothing was changed.`, {
      ...base,
      planned_origin: roundVec(plan.origin),
      mutationApplied: false,
      saved: false,
      next_step:
        args.placeAt === "hit"
          ? "Aim the ray at the spot next to the piece, place the piece near its mount first (summer_set_prop position), or raise maxMove for a deliberate long move."
          : "Place the piece near its mount first (summer_set_prop position, or summer_instantiate_scene with position), or raise maxMove for a deliberate long move.",
    });
  }

  // Turn the piece and put its back face just in front of the planned seat,
  // then let SnapToSurface sweep it in over a short, bounded distance.
  const basis = scaledBasis(mount.rotation, basisScale(subject.xform.basis));
  const preseat: Xform = { basis, origin: add(plan.origin, scale(n, ATTACH_PRESEAT_CLEARANCE)) };
  const local = xformCompose(xformInverse(subject.parent), preseat);
  const sweep = round(args.standoff + ATTACH_PRESEAT_CLEARANCE + ATTACH_SEAT_REACH, 4);
  const options = { scenePath: args.scenePath };
  const restore = async (): Promise<boolean> => {
    const original = subject.transformStr && parseGodotTransform(subject.transformStr)
      ? subject.transformStr
      : toGodotTransform(xformCompose(xformInverse(subject.parent), subject.xform));
    const receipt = await client.executeIdentityBoundOps(
      [{ op: "SetProp", path: args.subject, key: "transform", value: original }],
      options
    );
    return !extractOpError(receipt);
  };
  const refuse = async (reason: string, message: string, extra: JsonRecord): Promise<PlacementResult> => {
    const restored = await restore();
    return fail(tool, reason, message, {
      ...base,
      ...extra,
      restored,
      mutationApplied: !restored,
      saved: false,
      note: restored
        ? "The piece was put back where it started; the scene was not saved."
        : "Putting the piece back FAILED: it is turned and moved in the editor, the scene is not saved. Undo it (summer_batch [{op:\"Undo\"}]) or set its transform.",
    });
  };

  const receipt = await client.executeIdentityBoundOps([
    { op: "SetProp", path: args.subject, key: "transform", value: toGodotTransform(local) },
    {
      op: "SnapToSurface",
      subject_path: args.subject,
      direction: roundVec(scale(n, -1), 6),
      max_distance: sweep,
      gap: args.standoff,
      align_up: false,
    },
  ], options);
  const hinted = asRecord(withOldEngineHint(receipt, "SnapToSurface", SNAP_TO_SURFACE_FALLBACK));
  const setProp = opEntry(receipt, "SetProp");
  const snap = compactSnap(opEntry(receipt, "SnapToSurface"));
  const seatError = extractOpError(hinted ?? receipt);
  if (seatError) {
    if (setProp?.ok !== true) {
      return mutationFailure(tool, hinted ?? receipt, { ...base, seat: snap, mutationApplied: false, saved: false })!;
    }
    if (hinted?.failure_reason === "engine_lacks_op") {
      return refuse("engine_lacks_op", String(hinted.error), { op: "SnapToSurface", seat: snap });
    }
    const reason = String(snap.failure_reason ?? snap.failureReason ?? "seat_failed");
    // Name the obstacle while the piece still stands where the seat started.
    const blockers = await readBlockers(client, tool, args, scale(n, -1), sweep);
    return refuse(reason, `The seat failed: ${String(snap.error ?? seatError).slice(0, 300)}`, {
      seat: snap,
      ...(blockers ? { blockers } : {}),
      next_step: seatNextStep(reason, blockers, sweep),
    });
  }

  // The seat applied. Check WHERE before saving: on the intended surface, at
  // the planned plane, within maxMove.
  const supportPath = typeof snap.supportPath === "string" && snap.supportPath.length > 0 ? stripDotSlash(snap.supportPath) : undefined;
  const intended = stripDotSlash(args.surface ?? hit.path);
  const afterOrigin = isFiniteVec3(snap.origin) ? snap.origin : undefined;
  // > 0: stopped in front of the planned seat; < 0: went deeper.
  const deviation = afterOrigin ? dot(sub(afterOrigin, plan.origin), n) : undefined;
  const relation = supportPath ? pathRelation(supportPath, intended) : undefined;
  const inFront = deviation !== undefined && deviation > ATTACH_PLAN_TOLERANCE;
  const seatFacts: JsonRecord = {
    seat: snap,
    seated_on: supportPath ?? null,
    intended_surface: intended,
    ...(deviation !== undefined ? { back_face_gap: round(args.standoff + deviation), in_front_of_plan: round(deviation) } : {}),
  };
  const otherNode = relation === "other" || (relation === "ancestor" && inFront);
  if (otherNode && (args.surface || deviation === undefined || inFront)) {
    return refuse("seated_on_other_node", `The seat stopped on ${supportPath}, not on ${intended}${deviation !== undefined ? `, ${round(deviation)} in front of the planned seat` : ""}.`, {
      ...seatFacts,
      next_step: `Move the piece along the surface clear of ${supportPath} (summer_measure pair with it shows the overlap), or name ${supportPath} as surface if it is the intended mount, then re-run.`,
    });
  }
  if (!supportPath && inFront) {
    return refuse("seated_in_front_of_surface", `The seat stopped ${round(deviation!)} in front of the planned seat and the engine did not name the support.`, {
      ...seatFacts,
      next_step: "Check what is between the piece and the surface with summer_starcast (directionSpace local) or summer_test_placement, move the piece clear, then re-run.",
    });
  }
  const finalMove = afterOrigin ? length(sub(afterOrigin, start)) : undefined;
  if (finalMove !== undefined && finalMove > args.maxMove + sweep) {
    return refuse("move_exceeds_max_move", `The seat moved the piece ${round(finalMove)} from where it started, more than maxMove ${args.maxMove}.`, {
      ...seatFacts,
      next_step: "Place the piece near its mount first, or raise maxMove for a deliberate long move.",
    });
  }
  if (otherNode) warnings.push(`seated_on_coplanar_${supportPath}`);
  if (!supportPath) warnings.push("seat_support_not_named_by_engine");
  if (inFront && relation !== undefined && relation !== "other") {
    warnings.push(`surface_not_flat_under_piece: seated ${round(deviation!)} in front of the ray hit plane`);
  }
  if (deviation !== undefined && deviation < -ATTACH_PLAN_TOLERANCE) {
    warnings.push(`visible_back_${round(-deviation)}_into_surface: the collider sits behind the visible back face; add that to standoff to keep the mesh flush`);
  }
  if (!afterOrigin) warnings.push("seat_origin_missing_plan_not_checked");

  const saveReceipt = await client.executeIdentityBoundOps([{ op: "SaveScene" }], options);
  const saveError = extractOpError(saveReceipt);
  if (saveError) {
    return fail(tool, "save_failed", `The piece is seated in the editor but SaveScene failed: ${saveError.slice(0, 300)}`, {
      ...base,
      ...seatFacts,
      mutationApplied: true,
      saved: false,
      note: "Fix the cause, then call summer_save_scene.",
    });
  }
  return fitToBudget({
    ok: true,
    ...base,
    seated_on: supportPath ?? null,
    final_gap: snap.finalGap ?? null,
    ...(deviation !== undefined ? { back_face_gap: round(args.standoff + deviation) } : {}),
    ...(afterOrigin ? { moved_by: roundVec(sub(afterOrigin, start)) } : {}),
    seat: snap,
    saved: true,
    warnings,
  }, ["warnings"]) as PlacementResult;
}

// ---------------------------------------------------------------------------
// summer_repeat_along
// ---------------------------------------------------------------------------

export const repeatAlongArgsSchema = z.object({
  scenePath: scenePathSchema,
  template: z
    .string()
    .trim()
    .min(1)
    .max(SCENE_PATH_LIMIT_BYTES)
    .refine((value) => SCENE_ASSET_PATH.test(value), "template must be a res:// .tscn, .scn, .glb or .gltf scene")
    .refine(isSafeResPath, SAFE_RES_PATH_MESSAGE)
    .describe("Scene to instance for every copy, e.g. 'res://kit/pipes/wall_clamp_01.tscn'."),
  parent: nodePathSchema("Parent for the copies").describe("Parent for the copies; start/end/direction are in this parent's local space (same as position)."),
  start: vec3.describe("First copy's position [x, y, z] in the parent's space."),
  end: vec3.optional().describe("Line end. With spacing: as many copies as fit; with count: count copies spread from start to end."),
  direction: nonZeroVec3.optional().describe("Instead of end: direction of the row; needs count and spacing."),
  count: z.number().int().min(1).max(64).optional().describe("Number of copies (1-64)."),
  spacing: z.number().positive().max(1000).optional().describe("Distance between neighbouring copies' origins."),
  align: z
    .enum(["start", "center", "end"])
    .optional()
    .default("start")
    .describe("With end + spacing: where the leftover length goes. start = first copy at start; center = leftover split; end = last copy at end."),
  rotationDegrees: vec3.optional().describe("rotation_degrees for every copy [x, y, z]."),
  scale: vec3.optional().describe("scale for every copy [x, y, z]."),
  namePrefix: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine((value) => NODE_NAME.test(value), "namePrefix may use letters, digits, _, - and spaces")
    .optional()
    .describe("Copies are named <namePrefix>_<n> (default: the template file name)."),
});
export type RepeatAlongArgs = z.output<typeof repeatAlongArgsSchema>;

export const REPEAT_MAX_COPIES = 64;

/** Copy positions for a repeat_along call. Exported for tests. */
export function repeatPositions(args: Pick<RepeatAlongArgs, "start" | "end" | "direction" | "count" | "spacing" | "align">): {
  positions: Vec3[];
  spacing: number;
  direction: Vec3;
} {
  const start = args.start;
  if (args.end) {
    if (args.direction) throw new ToolInputError("Pass end or direction, not both.");
    if (args.count !== undefined && args.spacing !== undefined) {
      throw new ToolInputError("With end, pass spacing or count, not both.");
    }
    const span = sub(args.end, start);
    const total = length(span);
    if (args.count === 1) {
      const at = args.align === "end" ? args.end : args.align === "center" ? scale(add(start, args.end), 0.5) : start;
      return { positions: [at], spacing: 0, direction: total > 1e-9 ? normalize(span) : [0, 0, 0] };
    }
    if (total < 1e-9) throw new ToolInputError("start and end are the same point; pass count 1 or a longer line.");
    const dir = normalize(span);
    if (args.spacing !== undefined) {
      const n = Math.floor(total / args.spacing + 1e-9) + 1;
      if (n > REPEAT_MAX_COPIES) {
        throw new ToolInputError(`That line holds ${n} copies at spacing ${args.spacing}; the limit is ${REPEAT_MAX_COPIES} per call. Split the line.`);
      }
      const leftover = total - (n - 1) * args.spacing;
      const offset = args.align === "end" ? leftover : args.align === "center" ? leftover / 2 : 0;
      const positions = Array.from({ length: n }, (_, i) => add(start, scale(dir, offset + i * args.spacing!)));
      return { positions, spacing: args.spacing, direction: dir };
    }
    if (args.count !== undefined) {
      const spacing = total / (args.count - 1);
      const positions = Array.from({ length: args.count }, (_, i) => add(start, scale(dir, i * spacing)));
      return { positions, spacing, direction: dir };
    }
    throw new ToolInputError("With end, pass spacing or count.");
  }
  if (args.direction) {
    if (args.count === undefined) throw new ToolInputError("With direction, pass count.");
    if (args.count > 1 && args.spacing === undefined) throw new ToolInputError("With direction and count > 1, pass spacing.");
    const dir = normalize(args.direction);
    const spacing = args.spacing ?? 0;
    const positions = Array.from({ length: args.count }, (_, i) => add(start, scale(dir, i * spacing)));
    return { positions, spacing, direction: dir };
  }
  if (args.count === 1) return { positions: [start], spacing: 0, direction: [0, 0, 0] };
  throw new ToolInputError("Pass end (with spacing or count) or direction (with count and spacing).");
}

function templateName(template: string): string {
  const base = template.split("/").pop() ?? "Copy";
  const stem = base.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_\- ]/g, "_");
  return /^[A-Za-z0-9_]/.test(stem) ? stem : `Copy_${stem}`;
}

export async function repeatAlong(client: PlacementClient, args: RepeatAlongArgs): Promise<PlacementResult> {
  const tool = "summer_repeat_along";
  const { positions, spacing, direction } = repeatPositions(args);
  const prefix = args.namePrefix ?? templateName(args.template);
  const ops: JsonRecord[] = positions.map((position, i) => ({
    op: "InstantiateScene",
    parent: args.parent,
    scene: args.template,
    name: `${prefix}_${i + 1}`,
    ...(args.rotationDegrees ? { rotation_degrees: args.rotationDegrees } : {}),
    ...(args.scale ? { scale: args.scale } : {}),
    position,
  }));
  const trace = await executePlacementBatch(
    (chunk) => client.executeIdentityBoundOps(chunk, { groupUndo: true, scenePath: args.scenePath }),
    sceneMutationOps(ops),
    resolveSingleOnlyOps(client),
    ops.length
  );
  const summary = summarizeTrace(trace, ops);
  return fitToBudget({
    ...summary,
    ok: summary.ok === true,
    tool,
    template: args.template,
    parent: args.parent,
    count: positions.length,
    spacing: round(spacing),
    direction: roundVec(direction, 4),
    first: roundVec(positions[0]!),
    last: roundVec(positions[positions.length - 1]!),
  }, ["created", "renamed", "failures"]) as PlacementResult;
}

// ---------------------------------------------------------------------------
// summer_connect_ports
// ---------------------------------------------------------------------------

const portSchema = (what: string) =>
  z
    .union([
      z
        .string()
        .trim()
        .min(1)
        .max(128)
        .refine((value) => PORT_NAME_CHARS.test(value) && !value.includes(".."), "port names may use letters, digits, _, -, spaces and '/' only"),
      z.number().int().min(0).max(255),
    ])
    .describe(`${what}: a Marker3D (or any Node3D) name under the node, whose -Z axis points out of the port; or an open-loop index from summer_inspect_asset on that node's scene.`);

export const connectPortsArgsSchema = z.object({
  scenePath: scenePathSchema,
  subject: nodePathSchema("Piece to move"),
  subjectPort: portSchema("Port on the subject"),
  target: nodePathSchema("Piece that stays put"),
  targetPort: portSchema("Port on the target"),
  gap: z.number().min(-1).max(10).optional().default(0).describe("Distance between the two ports along the target port's direction. 0 = touching."),
  rollDegrees: z
    .number()
    .min(-360)
    .max(360)
    .optional()
    .default(0)
    .describe(
      "Extra turn of the subject, in degrees, about the joined port axis, applied after the ports are lined up. Axis: the target port's direction reversed, i.e. pointing from the joint into the target (receipt roll_axis). Sign: right-hand rule about that axis; positive turns counter-clockwise when you look back along the axis from inside the target toward the subject. Zero: the shortest turn that makes the subject's port face the target's from the subject's CURRENT orientation, so the same value gives different results from different start poses. Read other_ports in the receipt; once the ports are joined, a second call turns by exactly rollDegrees about the joint (e.g. 180 flips a bend's free end to the other side)."
    ),
  maxTriangles: z.number().int().min(100).max(300000).optional().default(60000).describe("Triangle budget (100-300000) per node when ports are open-loop indices."),
});
export type ConnectPortsArgs = z.output<typeof connectPortsArgsSchema>;

/** At most this many of the subject's other ports go in the receipt. */
const OTHER_PORTS_SHOWN = 8;

interface PortRead {
  kind: string;
  position: Vec3;
  direction: Vec3;
  radius?: number;
  name?: string;
  index?: number;
  direction_ambiguous?: boolean;
  analysis_truncated?: boolean;
  /** The subject's other ports (ports read with other_ports). */
  others?: PortRead[];
  others_total?: number;
}

function portOut(port: PortRead): JsonRecord {
  return {
    kind: port.kind,
    ...(port.name !== undefined ? { name: port.name } : {}),
    ...(port.index !== undefined ? { index: port.index } : {}),
    position: roundVec(port.position),
    direction: roundVec(port.direction, 4),
    ...(port.radius !== undefined ? { radius: round(port.radius) } : {}),
    ...(port.direction_ambiguous ? { direction_ambiguous: true } : {}),
  };
}

/** New scene-space transform that joins the subject port to the target port.
 *  `joint` is where the subject port lands; a subject point p moves to
 *  rotation * (p - subject port) + joint. */
export function connectTransform(subject: Xform, sp: PortRead, tp: PortRead, gap: number, rollDegrees: number): { xform: Xform; rotation: Basis3; joint: Vec3; rollAxis: Vec3 } {
  const ds = normalize(sp.direction);
  const dt = normalize(tp.direction);
  const want = scale(dt, -1);
  const fallback = normalize(basisMulVec(subject.basis, [0, 1, 0]));
  let rotation = rotationBetween(ds, want, fallback);
  if (Math.abs(rollDegrees) > 1e-9) rotation = basisMul(rotationAbout(want, (rollDegrees * Math.PI) / 180), rotation);
  const joint = add(tp.position, scale(dt, gap));
  const origin = add(basisMulVec(rotation, sub(subject.origin, sp.position)), joint);
  return { xform: { basis: basisMul(rotation, subject.basis), origin }, rotation, joint, rollAxis: want };
}

/** Where the subject's other ports end up: measured after the move when the
 *  verify read has them, else predicted from the move itself. */
function otherPortsOut(
  before: PortRead,
  after: PortRead | undefined,
  move: { rotation: Basis3; joint: Vec3 }
): { ports: JsonRecord[]; total: number; predicted: boolean } {
  const measured = after?.others;
  const source = measured ?? before.others ?? [];
  const ports = source.slice(0, OTHER_PORTS_SHOWN).map((port) => {
    if (measured) return portOut(port);
    return portOut({
      ...port,
      position: add(basisMulVec(move.rotation, sub(port.position, before.position)), move.joint),
      direction: basisMulVec(move.rotation, port.direction),
    });
  });
  const total = (measured ? after?.others_total : before.others_total) ?? source.length;
  return { ports, total, predicted: !measured };
}

function rotationAngleDegrees(r: Basis3): number {
  const trace = r[0][0] + r[1][1] + r[2][2];
  return (Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2))) * 180) / Math.PI;
}

export async function connectPorts(client: PlacementClient, args: ConnectPortsArgs): Promise<PlacementResult> {
  const tool = "summer_connect_ports";
  if (args.subject === args.target) throw new ToolInputError("subject and target must be different nodes.");
  const readArgs = {
    cmd: "ports",
    scene_path: args.scenePath,
    subject: args.subject,
    subject_port: args.subjectPort,
    target: args.target,
    target_port: args.targetPort,
    max_triangles: args.maxTriangles,
    other_ports: true,
  };
  const read = await runPlacementProbe(client, tool, readArgs);
  if (!read.ok) return read;
  const sp = read.subject_port as PortRead;
  const tp = read.target_port as PortRead;
  const subjectXf = xformFromArray(read.xform);
  const parentXf = xformFromArray(read.parent_xform);
  const { xform, rotation, joint, rollAxis } = connectTransform(subjectXf, sp, tp, args.gap, args.rollDegrees);
  const local = xformCompose(xformInverse(parentXf), xform);
  const warnings: string[] = [];
  for (const [label, port] of [["subject", sp], ["target", tp]] as const) {
    if (port.direction_ambiguous) warnings.push(`${label}_port_direction_ambiguous`);
    if (port.analysis_truncated) warnings.push(`${label}_port_analysis_truncated`);
  }
  const receipt = await executeSceneMutation(client, args.scenePath, [
    { op: "SetProp", path: args.subject, key: "transform", value: toGodotTransform(local) },
  ]);
  const failed = mutationFailure(tool, receipt);
  if (failed) return failed;
  const result: JsonRecord = {
    ok: true,
    tool,
    evidence: sp.kind === "marker" && tp.kind === "marker" ? "markers" : "mesh_triangles",
    subject_port: portOut(sp),
    target_port: portOut(tp),
    roll_axis: roundVec(rollAxis, 4),
    roll_degrees: args.rollDegrees,
    rotated_degrees: round(rotationAngleDegrees(rotation), 2),
    moved_by: roundVec(sub(xform.origin, subjectXf.origin)),
    saved: true,
    warnings,
  };
  const after = await runPlacementProbe(client, tool, readArgs);
  const sp2 = after.ok ? (after.subject_port as PortRead) : undefined;
  const others = otherPortsOut(sp, sp2, { rotation, joint });
  // Every other end of the subject, where it is now: a bend's free end tells
  // you at once whether it points where the run continues.
  result.other_ports = others.ports;
  if (others.total > others.ports.length) result.other_ports_total = others.total;
  if (others.predicted && others.ports.length > 0) result.other_ports_predicted = true;
  if (!after.ok || !sp2) {
    result.verify = { ok: false, error: after.error };
    return fitToBudget(result, ["other_ports", "warnings"]) as PlacementResult;
  }
  const tp2 = after.target_port as PortRead;
  const meet = add(tp2.position, scale(normalize(tp2.direction), args.gap));
  result.verify = {
    distance: round(length(sub(sp2.position, meet)), 4),
    angle_degrees: round(angleDegrees(sp2.direction, scale(tp2.direction, -1)), 2),
  };
  return fitToBudget(result, ["other_ports", "warnings"]) as PlacementResult;
}

