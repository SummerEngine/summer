/**
 * world-snapshot — the shared request builder and result filter of
 * `summer_world_snapshot` (src/mcp/tools/perception-tools.ts and
 * tool-dispatch.ts).
 *
 * The engine's GetWorldSnapshot (world_snapshot_ops.cpp) takes only
 * scene_path / max_nodes / max_lights / include_2d and returns every node it
 * walked, about 250 bytes each: a scene of a few thousand nodes is far too
 * big to read.
 * The engine snapshot is still taken whole — its snapshot_id is the baseline
 * summer_snapshot_diff compares against, and capping it would hide changes —
 * but the agent gets a filtered, capped view: a subtree (path_prefix), some
 * classes, some fields, a page (offset/max_nodes), plus class counts of what
 * matched. Whole-scene `counts` and `total_nodes` stay as the engine sent them.
 */
import { z } from "zod";
import { asRecord, type JsonRecord } from "../util/json.js";
import { isAtOrBelow, normalizeNodePath } from "./tscn.js";

/** Node entries returned to the agent unless max_nodes says otherwise. */
export const WORLD_SNAPSHOT_DEFAULT_MAX_NODES = 200;
/** The engine's own default cap (SNAPSHOT_MAX_NODES_DEFAULT) for the stored snapshot. */
export const ENGINE_SNAPSHOT_MAX_NODES = 4000;

/** Per-node fields the engine writes (path is always kept). */
export const WORLD_SNAPSHOT_NODE_FIELDS: readonly string[] = [
  "class", "name", "pos", "rot_deg", "scale", "visible", "aabb", "scene_file",
  "script_fp", "material_fps", "material_fps_truncated", "z_index", "rect", "view_rect", "limit_rect",
];

// Mirrors library/tools/world-snapshot/resource.yaml input_schema (parity-tested).
export const worldSnapshotInputShape = {
  scene_path: z
    .string()
    .optional()
    .describe("Scene to snapshot, e.g. 'res://main.tscn'. Omit for the currently edited scene."),
  max_nodes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Most node entries to return (default ${WORLD_SNAPSHOT_DEFAULT_MAX_NODES}). The engine still snapshots the whole scene for the diff baseline; the result says when the list is cut (truncated, next_offset).`
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Skip this many matching nodes (path-sorted) before listing — page with the result's next_offset."),
  path_prefix: z
    .string()
    .optional()
    .describe("Only this subtree: the node at this scene-relative path and everything below it, e.g. 'House3' or 'Lane2/Props'."),
  classes: z
    .array(z.string())
    .max(32)
    .optional()
    .describe("Only nodes of these classes, e.g. ['MeshInstance3D', 'OmniLight3D'] (* wildcards allowed)."),
  fields: z
    .array(z.string())
    .max(16)
    .optional()
    .describe(
      "Only these per-node fields (path is always kept): class, name, pos, rot_deg, scale, visible, aabb, scene_file, script_fp, material_fps, z_index, rect, view_rect, limit_rect."
    ),
};

export const worldSnapshotInputSchema = z.object(worldSnapshotInputShape).strict();
export type WorldSnapshotArgs = z.infer<typeof worldSnapshotInputSchema>;

export function buildWorldSnapshotOp(args: WorldSnapshotArgs): JsonRecord {
  const op: JsonRecord = { op: "GetWorldSnapshot" };
  if (args.scene_path) op.scene_path = args.scene_path;
  // The stored snapshot is the diff baseline: never smaller than the engine
  // default, larger only when the caller asks to see more than that.
  if (args.max_nodes !== undefined && args.max_nodes > ENGINE_SNAPSHOT_MAX_NODES) op.max_nodes = args.max_nodes;
  return op;
}

function globMatcher(patterns: readonly string[]): (value: string) => boolean {
  const regexes = patterns.map(
    (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`)
  );
  return (value) => regexes.some((regex) => regex.test(value));
}

/** The GetWorldSnapshot payload inside an /api/ops envelope (or the envelope itself). */
function snapshotPayload(result: unknown): { holder: JsonRecord; index: number | null } | null {
  const root = asRecord(result);
  if (!root) return null;
  if (Array.isArray(root.nodes)) return { holder: root, index: null };
  const results = Array.isArray(root.results) ? root.results : [];
  const index = results.findIndex((entry) => {
    const record = asRecord(entry);
    return record?.op === "GetWorldSnapshot" && Array.isArray(record.nodes);
  });
  return index >= 0 ? { holder: root, index } : null;
}

/** Filter and cap a successful snapshot for the agent. Anything that is not a
 *  snapshot payload (a failure, an older shape) passes through untouched. */
export function shapeWorldSnapshot(result: unknown, args: WorldSnapshotArgs): unknown {
  const found = snapshotPayload(result);
  if (!found) return result;
  const payload = (found.index === null ? found.holder : asRecord((found.holder.results as unknown[])[found.index])!) as JsonRecord;
  const nodes = (payload.nodes as unknown[]).map((node) => asRecord(node)).filter((node): node is JsonRecord => !!node);

  const prefix = args.path_prefix !== undefined ? normalizeNodePath(args.path_prefix) : undefined;
  const classMatch = args.classes && args.classes.length > 0 ? globMatcher(args.classes) : undefined;
  const inSubtree = (path: unknown) => prefix === undefined || (typeof path === "string" && isAtOrBelow(normalizeNodePath(path), prefix));
  const matched = nodes.filter((node) => inSubtree(node.path) && (!classMatch || classMatch(String(node.class ?? ""))));

  const offset = args.offset ?? 0;
  const maxNodes = args.max_nodes ?? WORLD_SNAPSHOT_DEFAULT_MAX_NODES;
  const page = matched.slice(offset, offset + maxNodes);
  const keep = args.fields && args.fields.length > 0 ? new Set(["path", ...args.fields]) : undefined;
  const listed = keep
    ? page.map((node) => Object.fromEntries(Object.entries(node).filter(([key]) => keep.has(key))))
    : page;

  const engineTruncated = payload.truncated === true;
  const end = offset + page.length;
  const filtered = prefix !== undefined || classMatch !== undefined;
  const shaped: JsonRecord = {
    ...payload,
    nodes: listed,
    // truncated: this list is not every matching node (page cut, or the engine's own cap).
    truncated: end < matched.length || engineTruncated,
    engine_truncated: engineTruncated,
    engine_listed_nodes: nodes.length,
    matched_nodes: matched.length,
    returned_nodes: listed.length,
    offset,
    next_offset: end < matched.length ? end : null,
    ...(filtered ? { filter: { ...(prefix !== undefined ? { path_prefix: prefix } : {}), ...(args.classes ? { classes: args.classes } : {}) } } : {}),
    ...(keep ? { fields: [...keep] } : {}),
  };
  if (filtered) {
    const counts: Record<string, number> = {};
    for (const node of matched) {
      const cls = String(node.class ?? "?");
      counts[cls] = (counts[cls] ?? 0) + 1;
    }
    shaped.matched_counts = counts;
  }
  if (prefix !== undefined) {
    for (const key of ["lights", "cameras"] as const) {
      if (Array.isArray(payload[key])) {
        shaped[key] = (payload[key] as unknown[]).filter((entry) => inSubtree(asRecord(entry)?.path));
      }
    }
  }
  if (end < matched.length || offset > 0 || filtered) {
    shaped.note =
      "nodes is a filtered/paged view; counts and total_nodes describe the whole scene, and snapshot_id covers the whole scene for summer_snapshot_diff.";
  }

  if (found.index === null) return shaped;
  const results = [...(found.holder.results as unknown[])];
  results[found.index] = shaped;
  return { ...found.holder, results };
}
