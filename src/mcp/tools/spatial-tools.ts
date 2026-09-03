import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withEngine, missingEngineOpResult, ToolInputError, withOldEngineHint } from "./with-engine.js";
import { executeSceneMutation } from "./scene-tools.js";
// engine_lacks_op fallbacks: ONE copy for every face (E2E 2026-09-03 F-16).
import {
  ALIGN_DISTRIBUTE_FALLBACK,
  NAVIGATION_PROBE_FALLBACK,
  SNAP_TO_SURFACE_FALLBACK,
  STARCAST_FALLBACK,
  TEST_PLACEMENT_FALLBACK,
} from "../../core/capabilities/engine-fallbacks.js";

/**
 * Spatial / world-building tools. Five bounded engine ops that turn "roughly
 * positioned" into "deliberately arranged": ghost-test a pose, seat a prop on
 * a surface, align or space a group along one axis, probe navigation
 * reachability, and starcast a placed subject (26 directional clearance casts
 * plus contact and grounding evidence). Every op is evidence with a stated
 * boundary (physics sweep vs visual-AABB broad phase) and every result is
 * COMPACT by construction — the engine returns a receipt, never a scene dump.
 *
 * Two mutate the scene (snap, align/distribute) and go through the
 * scene-mutation contract (one undoable action + one final SaveScene); three
 * are read-only and never save (placement test, navigation probe, starcast).
 * All five take exact scenePath + node paths — editor selection is never
 * consulted.
 *
 * Every op here is newer than the perception ops and an engine in the field
 * may lack it. Same two layers as perception-tools: a capability pre-flight
 * (missingEngineOpResult — nothing is sent when /api/health PROVES the op is
 * missing) and a post-hoc rewrite of the per-op "unknown op" error into the
 * same upgrade path for engines that advertise nothing.
 */

type ToolResultContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: ToolResultContent[]; isError?: boolean };

/** Hard budget for one tool's model-visible result. These ops are designed to
 *  answer in a few hundred bytes; anything past this means the engine returned
 *  something this CLI does not understand (a newer/older receipt shape), and
 *  forwarding 40 KB of it to the model is worse than a 300-byte honest failure.
 *  Deliberately per-tool: v3 rejects a blanket cap in with-engine/server (see
 *  installResultSizeLogger) because the big read tools legitimately exceed it. */
const COMPACT_RESULT_LIMIT_BYTES = 5 * 1024;
const SCENE_PATH_LIMIT_BYTES = 512;
const NODE_PATH_LIMIT_BYTES = 256;
const MIN_PLACEMENT_FLOOR_DISTANCE = 0.001;
/** Mirrors the engine's SnapToSurface direction guard (length² > 1e-5). */
const MIN_SNAP_DIRECTION_LENGTH_SQUARED = 0.00001;

/** Starcast's own ceilings (engine spatial_ops.cpp starcast_3d): the engine
 *  measures the compact receipt as UTF-8 JSON, downgrades full -> summary
 *  above 12 KiB, and strips secondary paths above 5 KiB, so a receipt past the
 *  ceiling for its returnedDetail is one this CLI does not understand. Unlike
 *  COMPACT_RESULT_LIMIT_BYTES these are inclusive: the engine's contract is
 *  "at most". */
const STARCAST_SUMMARY_LIMIT_BYTES = 5 * 1024;
const STARCAST_FULL_LIMIT_BYTES = 12 * 1024;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function snapDirectionExceedsNativeMinimum(direction: readonly number[]): boolean {
  const lengthSquared = direction.reduce((sum, component) => sum + component * component, 0);
  return Number.isFinite(lengthSquared) && lengthSquared > MIN_SNAP_DIRECTION_LENGTH_SQUARED;
}

/** Zod's .max() counts UTF-16 code units; the engine's limit is UTF-8 bytes.
 *  The schemas below carry the same byte-boundary refine, so a host that
 *  validates the schema never reaches these; they stay as the defence for
 *  direct callers and throw ToolInputError (classified "input", nothing sent —
 *  never "transport"). */
function requireBoundedExactPath(
  value: string,
  label: string,
  limitBytes: number,
  emptyMessage?: string,
): string {
  const exactPath = value.trim();
  if (!exactPath) {
    throw new ToolInputError(emptyMessage ?? `${label} must name one exact path.`);
  }
  const pathBytes = Buffer.byteLength(exactPath, "utf8");
  if (pathBytes > limitBytes) {
    throw new ToolInputError(`${label} must be at most ${limitBytes} UTF-8 bytes after trimming.`);
  }
  return exactPath;
}

function requireBoundedSubjects(
  subjectPaths: readonly string[],
  min: number,
  max: number,
  combinedLimitBytes: number,
): string[] {
  const subjects = subjectPaths.map((path, index) =>
    requireBoundedExactPath(path, `subjectPaths[${index}]`, NODE_PATH_LIMIT_BYTES));
  if (subjects.length < min || subjects.length > max) {
    throw new ToolInputError(`subjectPaths must contain ${min}..${max} exact paths.`);
  }
  if (subjects.reduce((sum, path) => sum + Buffer.byteLength(path, "utf8"), 0) > combinedLimitBytes) {
    throw new ToolInputError(`Combined subject paths exceed the ${combinedLimitBytes}-byte UTF-8 limit.`);
  }
  if (new Set(subjects).size !== subjects.length) {
    throw new ToolInputError("subjectPaths must not contain duplicates.");
  }
  return subjects;
}

/** The receipt's entry for `op` (a mutation batch also carries the SaveScene
 *  result), else the first result, else the raw receipt. */
function opResult(receipt: unknown, op: string): unknown {
  const results = (receipt as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return receipt;
  return results.find((entry) => (entry as { op?: unknown })?.op === op) ?? results[0] ?? receipt;
}

interface CompactResultOptions {
  op: string;
  failureReason: string;
  /** Extra fields for the oversized envelope. Mutations MUST say the change
   *  already landed so the model does not blind-retry. */
  extra?: Record<string, unknown>;
}

/** withEngine options that return ONLY the compact native op result (not the
 *  transport envelope) and fail loud with a tiny envelope if it is oversized. */
function compactResult(options: CompactResultOptions) {
  const resultText = (receipt: unknown): string => JSON.stringify(opResult(receipt, options.op));
  return {
    onResult: (receipt: unknown): ToolResult | null => {
      const text = resultText(receipt);
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes < COMPACT_RESULT_LIMIT_BYTES) return null;
      return {
        isError: true,
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: false,
            op: options.op,
            failure_reason: options.failureReason,
            ...(options.extra ?? {}),
            actualBytes: bytes,
            limitBytes: COMPACT_RESULT_LIMIT_BYTES,
          }),
        }],
      };
    },
    toContent: (receipt: unknown): ToolResultContent[] => [{ type: "text", text: resultText(receipt) }],
  };
}

const MUTATION_LANDED = { mutationApplied: true, saved: true, retrySafe: false } as const;
const READ_ONLY = { readOnly: true } as const;

/** withEngine options for summer_starcast: return ONLY the compact native op
 *  result and fail loud when it exceeds the ceiling for its returnedDetail
 *  (at most 5 KiB summary, at most 12 KiB full — the engine's own contract).
 *  A downgraded receipt (requestedDetail full, returnedDetail summary) is
 *  judged against the summary ceiling, exactly as the engine judged it. */
function starcastResult() {
  const op = "Starcast3D";
  const resultText = (receipt: unknown): string => JSON.stringify(opResult(receipt, op));
  const returnedDetail = (receipt: unknown): "summary" | "full" => {
    const detail = (opResult(receipt, op) as { returnedDetail?: unknown } | null | undefined)?.returnedDetail;
    return detail === "full" ? "full" : "summary";
  };
  return {
    onResult: (receipt: unknown): ToolResult | null => {
      const text = resultText(receipt);
      const bytes = Buffer.byteLength(text, "utf8");
      const detail = returnedDetail(receipt);
      const limitBytes = detail === "full" ? STARCAST_FULL_LIMIT_BYTES : STARCAST_SUMMARY_LIMIT_BYTES;
      if (bytes <= limitBytes) return null;
      return {
        isError: true,
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: false,
            op,
            failure_reason: "starcast_result_exceeded_byte_limit",
            ...READ_ONLY,
            returnedDetail: detail,
            actualBytes: bytes,
            limitBytes,
            hint: "Update Summer Engine so Starcast3D returns its compact schema (schemaVersion 1).",
          }),
        }],
      };
    },
    toContent: (receipt: unknown): ToolResultContent[] => [{ type: "text", text: resultText(receipt) }],
  };
}

// Every check the engine would reject on is expressed in the schema so the
// MCP host rejects the call BEFORE the handler runs (an -32602 invalid-args
// error, never a tool result that looks like an engine failure). Byte caps
// and dedupe live here as refines; the fn-side helpers above repeat them only
// for direct callers.
const utf8Within = (limitBytes: number) => (value: string) => Buffer.byteLength(value, "utf8") <= limitBytes;
const exactScenePath = z
  .string()
  .trim()
  .min(1)
  .max(SCENE_PATH_LIMIT_BYTES)
  .refine(utf8Within(SCENE_PATH_LIMIT_BYTES), `scenePath must be at most ${SCENE_PATH_LIMIT_BYTES} UTF-8 bytes`);
const exactNodePath = z
  .string()
  .trim()
  .min(1)
  .max(NODE_PATH_LIMIT_BYTES)
  .refine(utf8Within(NODE_PATH_LIMIT_BYTES), `node paths must be at most ${NODE_PATH_LIMIT_BYTES} UTF-8 bytes`);
const noDuplicates = (paths: readonly string[]) => new Set(paths).size === paths.length;
const combinedUtf8Within = (limitBytes: number) => (paths: readonly string[]) =>
  paths.reduce((sum, path) => sum + Buffer.byteLength(path, "utf8"), 0) <= limitBytes;
/** Ordered, nonduplicate exact node paths with the engine's combined byte cap. */
const subjectPathList = (min: number, max: number, combinedLimitBytes: number) =>
  z
    .array(exactNodePath)
    .min(min)
    .max(max)
    .refine(noDuplicates, "subjectPaths must not contain duplicates")
    .refine(combinedUtf8Within(combinedLimitBytes), `Combined subject paths exceed the ${combinedLimitBytes}-byte UTF-8 limit`);
const finiteVector3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSpatialTools(server: McpServer): void {
  server.tool(
    "summer_test_placement",
    `Ghost-test one 3D node at an explicit candidate global pose without moving it or saving the scene.

Use this before placing a prop in a shelf, cubby, doorway, platform, or dense set. The compact result reports known overlap evidence, grounded state, signed floor gap, and at most eight overlapping object paths. Physics evidence uses enabled collider shapes; because Godot exposes no query-completeness bit, its overlap count is labeled a lower bound and an otherwise-clear physics result reports fits:null rather than claiming proof. visual_aabb evidence is a broad-phase fallback that also catches visible mesh-only obstacles.

The pose is always global/world-space: position and Euler rotation in degrees are both required, while the subject's current global scale is preserved. scenePath and subjectPath are exact; this tool never falls back to editor selection. The normal result is below 5 KB and the scene is never mutated. On an engine build that predates TestPlacement3D the result is a structured engine_lacks_op failure naming the fallback.`,
    {
      scenePath: exactScenePath.describe("Exact scene path containing the subject, e.g. 'res://levels/workshop.tscn'."),
      subjectPath: exactNodePath.describe("Exact node path relative to the scene root, e.g. './World/Crate'."),
      candidateGlobalPosition: finiteVector3.describe("Candidate global/world position as [x, y, z]."),
      candidateGlobalRotationDegrees: finiteVector3.describe(
        "Candidate global/world Euler rotation in degrees as [x, y, z]; current global scale is preserved.",
      ),
      collisionMask: z
        .number()
        .int()
        .nonnegative()
        .max(0xffffffff)
        .optional()
        .default(0xffffffff)
        .describe("Godot 3D physics layers included in overlap and floor queries."),
      collideWithAreas: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include Area3D objects as placement obstacles/support candidates."),
      maxFloorDistance: z
        .number()
        .min(MIN_PLACEMENT_FLOOR_DISTANCE)
        .max(1000)
        .optional()
        .default(5)
        .describe("Maximum world-space distance searched below the candidate footprint; range 0.001..1000."),
      groundTolerance: z
        .number()
        .nonnegative()
        .max(1)
        .optional()
        .default(0.05)
        .describe("Absolute floor-gap tolerance used to classify grounded support."),
      margin: z
        .number()
        .nonnegative()
        .max(1)
        .optional()
        .default(0.001)
        .describe("Physics shape-intersection margin; only an exact physics support collider+shape contact is excluded from overlaps."),
    },
    async ({
      scenePath,
      subjectPath,
      candidateGlobalPosition,
      candidateGlobalRotationDegrees,
      collisionMask,
      collideWithAreas,
      maxFloorDistance,
      groundTolerance,
      margin,
    }) =>
      withEngine(async (client) => {
        const missing = missingEngineOpResult(client, "TestPlacement3D", TEST_PLACEMENT_FALLBACK);
        if (missing) return missing;
        const exactScene = requireBoundedExactPath(scenePath, "scenePath", SCENE_PATH_LIMIT_BYTES);
        const exactSubject = requireBoundedExactPath(subjectPath, "subjectPath", NODE_PATH_LIMIT_BYTES);
        if (!Number.isFinite(maxFloorDistance) || maxFloorDistance < MIN_PLACEMENT_FLOOR_DISTANCE) {
          throw new ToolInputError("maxFloorDistance must be at least 0.001.");
        }
        const receipt = await client.executeIdentityBoundOps(
          [{
            op: "TestPlacement3D",
            subject_path: exactSubject,
            candidate_global_position: candidateGlobalPosition,
            candidate_global_rotation_degrees: candidateGlobalRotationDegrees,
            collision_mask: collisionMask,
            collide_with_areas: collideWithAreas,
            max_floor_distance: maxFloorDistance,
            ground_tolerance: groundTolerance,
            margin,
          }],
          { scenePath: exactScene },
        );
        return withOldEngineHint(receipt, "TestPlacement3D", TEST_PLACEMENT_FALLBACK);
      }, compactResult({
        op: "TestPlacement3D",
        failureReason: "placement_result_exceeded_byte_limit",
        extra: READ_ONLY,
      })),
  );

  server.tool(
    "summer_snap_to_surface",
    `Move one exact 3D subject along a world-space ray until its support face sits at the requested gap from the first surface. This changes only the subject's global transform, saves the scene, and is one reversible editor undo.

Use the default downward direction to seat props on floors, ramps, tables, or shelves. Set alignUp only when the prop should tilt to match the support normal.

EVIDENCE BOUNDARY:
- physics means Godot swept the subject's enabled collider shapes against body colliders and refined the first-contact bracket.
- visual_aabb is an explicit broad-phase fallback for mesh-only geometry; it does not prove triangle contact, and alignUp is not applied from that approximate normal.
- initiallyOverlapping and backoffDistance expose bounded pre-sweep recovery. The tool fails instead of teleporting when the subject cannot be cleared within maxDistance.

The normal result is bounded below 5 KB and returns before/after transforms, supportPath, finalGap with an error bound, slopeDeg, evidence, and warnings. scenePath and subjectPath are always required; there is no editor-selection fallback. On an engine build that predates SnapToSurface the result is a structured engine_lacks_op failure naming the fallback.`,
    {
      scenePath: exactScenePath.describe("Exact scene containing the subject, e.g. 'res://levels/market.tscn'"),
      subjectPath: exactNodePath.describe("Exact Node3D path relative to the scene root, e.g. './Props/Crate'"),
      direction: finiteVector3
        .refine(snapDirectionExceedsNativeMinimum, "direction squared length must exceed 0.00001")
        .optional()
        .default([0, -1, 0])
        .describe("Finite world-space cast direction [x,y,z] whose squared length exceeds 0.00001. Defaults downward."),
      maxDistance: z
        .number()
        .positive()
        .max(10000)
        .optional()
        .default(20)
        .describe("Maximum cast and overlap-recovery distance in scene units."),
      gap: z
        .number()
        .nonnegative()
        .max(10000)
        .optional()
        .default(0)
        .describe("Requested separation from the support surface; must not exceed maxDistance."),
      alignUp: z
        .boolean()
        .optional()
        .default(false)
        .describe("Rotate the subject's current world up toward an exact physics contact normal before seating it."),
    },
    async ({ scenePath, subjectPath, direction, maxDistance, gap, alignUp }) =>
      withEngine(async (client) => {
        const missing = missingEngineOpResult(client, "SnapToSurface", SNAP_TO_SURFACE_FALLBACK);
        if (missing) return missing;
        const exactScene = requireBoundedExactPath(scenePath, "scenePath", SCENE_PATH_LIMIT_BYTES);
        const exactSubject = requireBoundedExactPath(
          subjectPath,
          "subjectPath",
          NODE_PATH_LIMIT_BYTES,
          "subjectPath must name one exact Node3D; selection fallback is not supported.",
        );
        if (!snapDirectionExceedsNativeMinimum(direction)) {
          throw new ToolInputError("direction squared length must exceed 0.00001.");
        }
        // Cross-field: a raw zod shape cannot express it, so it stays here.
        if (gap > maxDistance) throw new ToolInputError("gap must not exceed maxDistance.");
        const receipt = await executeSceneMutation(client, exactScene, [{
          op: "SnapToSurface",
          subject_path: exactSubject,
          direction,
          max_distance: maxDistance,
          gap,
          align_up: alignUp,
        }]);
        return withOldEngineHint(receipt, "SnapToSurface", SNAP_TO_SURFACE_FALLBACK);
      }, compactResult({
        op: "SnapToSurface",
        failureReason: "snap_to_surface_result_exceeded_byte_limit",
        extra: MUTATION_LANDED,
      })),
  );

  server.tool(
    "summer_align_distribute_3d",
    `Align or equal-space an explicit ordered list of 3D subjects along one world-space axis, then save the exact target scene.

Every anchor and extent comes from visible descendant GeometryInstance3D world AABBs (evidence: visual_aabb). The tool never uses editor selection and fails instead of fabricating bounds. It preserves each subject's authored basis and scale, translates only along the normalized axis, and records all changed transforms in one undoable editor operation.

Alignment modes use the first ordered subject's minimum, center, or maximum projected anchor. Distribution modes keep the first and last subjects fixed and honor caller order. distribute_gaps accounts for each subject's projected half-extent and fails if the endpoint span cannot fit non-overlapping equal gaps. The compact result returns ordered before/after origins, resolved spacing, and numeric residuals under 5 KB. On an engine build that predates AlignDistribute3D the result is a structured engine_lacks_op failure naming the fallback.`,
    {
      scenePath: exactScenePath.describe("Exact target scene, e.g. 'res://levels/market.tscn'."),
      subjectPaths: subjectPathList(2, 16, 1536)
        .describe("Two to sixteen exact nonduplicate Node3D paths in the order to align or distribute."),
      axis: finiteVector3
        .refine(([x, y, zValue]) => Math.hypot(x, y, zValue) > 1e-6, "axis must be non-zero")
        .describe("Finite, non-zero world axis [x,y,z]; normalization is automatic."),
      mode: z
        .enum(["align_min", "align_center", "align_max", "distribute_centers", "distribute_gaps"])
        .describe("Alignment anchor or equal-spacing policy."),
    },
    async ({ scenePath, subjectPaths, axis, mode }) =>
      withEngine(async (client) => {
        const missing = missingEngineOpResult(client, "AlignDistribute3D", ALIGN_DISTRIBUTE_FALLBACK);
        if (missing) return missing;
        const exactScene = requireBoundedExactPath(scenePath, "scenePath", SCENE_PATH_LIMIT_BYTES);
        const paths = requireBoundedSubjects(subjectPaths, 2, 16, 1536);
        if (axis.some((component) => !Number.isFinite(component)) || Math.hypot(...axis) <= 1e-6) {
          throw new ToolInputError("axis must contain three finite values and have non-zero length.");
        }
        const receipt = await executeSceneMutation(client, exactScene, [{
          op: "AlignDistribute3D",
          subject_paths: paths,
          axis,
          mode,
        }]);
        return withOldEngineHint(receipt, "AlignDistribute3D", ALIGN_DISTRIBUTE_FALLBACK);
      }, compactResult({
        op: "AlignDistribute3D",
        failureReason: "align_result_exceeded_byte_limit",
        extra: MUTATION_LANDED,
      })),
  );

  server.tool(
    "summer_navigation_probe",
    `Inspect whether two explicit world-space points are connected by the targeted 3D scene's built-in Godot navigation map without changing or saving the scene.

Returns navigation readiness and its reason, map iteration and region counts, requested and layer-filtered snapped endpoints, snap distances, conservative reachability, full route length, and at most 16 deterministic route points. A path is reachable only when it terminates at both snapped endpoints within the reported tolerance.

ready:false means navigation evidence is unavailable, not that the route is unreachable. In particular, map iteration 0 precedes the first usable synchronization and can return silently empty paths; iteration 1 and later are usable. evidence is always navigation. Normal results are capped below 5 KB.

Always pass an exact scenePath and finite world-space start/end points. This read-only tool never uses editor selection, creates undo history, or calls SaveScene. On an engine build that predates NavigationProbe3D the result is a structured engine_lacks_op failure naming the fallback.`,
    {
      scenePath: exactScenePath.describe("Exact 3D scene whose World3D navigation map should be queried."),
      start: finiteVector3.describe("Requested world-space route start [x,y,z]."),
      end: finiteVector3.describe("Requested world-space route destination [x,y,z]."),
      navigationLayers: z
        .number()
        .int()
        .min(1)
        .max(0xffffffff)
        .optional()
        .default(1)
        .describe("Godot navigation-layer bitmask; only enabled matching regions are used."),
      optimize: z
        .boolean()
        .optional()
        .default(true)
        .describe("Use Godot's corridor-funnel path post-processing; false uses edge-centered points."),
    },
    async ({ scenePath, start, end, navigationLayers, optimize }) =>
      withEngine(async (client) => {
        const missing = missingEngineOpResult(client, "NavigationProbe3D", NAVIGATION_PROBE_FALLBACK);
        if (missing) return missing;
        const exactScene = requireBoundedExactPath(scenePath, "scenePath", SCENE_PATH_LIMIT_BYTES);
        if (start.length !== 3 || end.length !== 3 ||
            !start.every(Number.isFinite) || !end.every(Number.isFinite)) {
          throw new ToolInputError("start and end must each contain exactly three finite world-space numbers.");
        }
        if (!Number.isInteger(navigationLayers) || navigationLayers < 1 || navigationLayers > 0xffffffff) {
          throw new ToolInputError("navigationLayers must be an integer from 1 through 4294967295.");
        }
        const receipt = await client.executeIdentityBoundOps(
          [{
            op: "NavigationProbe3D",
            start,
            end,
            navigation_layers: navigationLayers,
            optimize,
          }],
          { scenePath: exactScene },
        );
        return withOldEngineHint(receipt, "NavigationProbe3D", NAVIGATION_PROBE_FALLBACK);
      }, compactResult({
        op: "NavigationProbe3D",
        failureReason: "navigation_probe_result_exceeded_byte_limit",
        extra: { ...READ_ONLY, evidence: "navigation" },
      })),
  );

  server.tool(
    "summer_starcast",
    `Read a 3D spatial rundown for one exact node in an exact scene without moving it or saving the scene: 26 directional clearance casts (6 axes, 12 edges, 8 corners) from the subject's bounds, contact-or-overlap evidence, grounded state, and, in full detail, bounded nearby-object lists. Use it before and after placing an object to learn which side is blocked, by what, and at what distance.

detail 'summary' (default) is a placement report of at most 5 KB: subject position and size, grounded and contactStatus, deduplicated contact paths, one compact record per direction (status open|blocked, nearest distance, object, evidence, relationship), coverage, and warnings. detail 'full' adds per-direction hit geometry, an objects table, nearby lists, and the query echo, at most 12 KB; the engine downgrades to summary rather than exceed that (warning full_result_exceeded_12kb_returned_summary) and always reports requestedDetail vs returnedDetail.

EVIDENCE BOUNDARY:
- evidence 'physics' uses Godot's PhysicsDirectSpaceState3D against exact collider geometry on collisionMask. Shape intersections say contact_or_overlap because the query does not establish penetration depth; touching and anything within margin are included.
- evidence 'visual_aabb' uses visible world-axis-aligned bounding boxes: it catches meshes without colliders but is broad-phase only, never triangle-level contact.
- Lights, cameras, audio, navigation, scripts, and plain Nodes are not obstacles unless they own visual or collision geometry. One representative ray per direction can miss off-center geometry.

scenePath and path are exact; editor selection is never consulted. This tool is read-only: it never moves the node or saves the scene. On an engine build that predates Starcast3D the result is a structured engine_lacks_op failure naming the fallback.`,
    {
      scenePath: exactScenePath.describe("Exact scene containing the subject, e.g. 'res://levels/level1.tscn'."),
      path: exactNodePath.describe("Exact Node3D path relative to the scene root, e.g. './World/Crate'."),
      detail: z
        .enum(["summary", "full"])
        .optional()
        .default("summary")
        .describe("summary: compact placement report (at most 5 KB). full: adds bounded hit geometry, an objects table, and nearby lists (at most 12 KB; the engine downgrades to summary rather than exceed it)."),
      maxDistance: z
        .number()
        .positive()
        .max(10000)
        .optional()
        .default(20)
        .describe("Maximum outward cast distance in scene units."),
      nearbyRadius: z
        .number()
        .nonnegative()
        .max(10000)
        .optional()
        .default(10)
        .describe("Maximum gap from the subject bounds for the nearby-object lists (full detail)."),
      directionSpace: z
        .enum(["world", "local"])
        .optional()
        .default("world")
        .describe("Cast along world axes, or along the subject's orthonormalized local axes when 'front', 'side', or 'up' mean the rotated subject's own orientation."),
      collisionMask: z
        .number()
        .int()
        .nonnegative()
        .max(0xffffffff)
        .optional()
        .default(0xffffffff)
        .describe("Godot 3D physics layer mask queried by rays, shape contacts/overlaps, and nearby-collider scans."),
      collideWithAreas: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include Area3D objects as well as physics bodies."),
      maxHitsPerDirection: z
        .number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .default(3)
        .describe("Maximum physics hits and visual AABB hits retained for each direction."),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(128)
        .optional()
        .default(64)
        .describe("Maximum retained contact/overlap and nearby entries per evidence channel."),
      margin: z
        .number()
        .nonnegative()
        .max(1)
        .optional()
        .default(0.001)
        .describe("Tolerance for exact-geometry physics shape intersection queries; touching and candidates within this margin are reported as contact_or_overlap."),
    },
    async ({
      scenePath,
      path,
      detail,
      maxDistance,
      nearbyRadius,
      directionSpace,
      collisionMask,
      collideWithAreas,
      maxHitsPerDirection,
      maxResults,
      margin,
    }) =>
      withEngine(async (client) => {
        const missing = missingEngineOpResult(client, "Starcast3D", STARCAST_FALLBACK);
        if (missing) return missing;
        const exactScene = requireBoundedExactPath(scenePath, "scenePath", SCENE_PATH_LIMIT_BYTES);
        const exactSubject = requireBoundedExactPath(
          path,
          "path",
          NODE_PATH_LIMIT_BYTES,
          "path must name one exact Node3D; selection fallback is not supported.",
        );
        if (!Number.isFinite(maxDistance) || maxDistance <= 0) {
          throw new ToolInputError("maxDistance must be positive.");
        }
        if (!Number.isFinite(nearbyRadius) || nearbyRadius < 0) {
          throw new ToolInputError("nearbyRadius must be zero or positive.");
        }
        const receipt = await client.executeIdentityBoundOps(
          [{
            op: "Starcast3D",
            path: exactSubject,
            detail,
            max_distance: maxDistance,
            nearby_radius: nearbyRadius,
            direction_space: directionSpace,
            collision_mask: collisionMask,
            collide_with_areas: collideWithAreas,
            max_hits_per_direction: maxHitsPerDirection,
            max_results: maxResults,
            margin,
          }],
          { scenePath: exactScene },
        );
        return withOldEngineHint(receipt, "Starcast3D", STARCAST_FALLBACK);
      }, starcastResult()),
  );
}
