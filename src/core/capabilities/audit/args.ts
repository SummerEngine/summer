/**
 * Argument shape for summer_scene_audit — ONE copy for both faces (the MCP
 * registration in src/mcp/tools/audit-tools.ts and `summer tool scene-audit`
 * in tool-dispatch.ts). The descriptions are the docs agents read.
 *
 * Strings that name scene content are validated again in audit.ts with the
 * seeing tools' strict patterns before anything is sent; they reach the
 * engine only as JSON data in config.json, never as source.
 */
import { z } from "zod";

export const AUDIT_CHECKS = [
  "through_hole",
  "floor_gap",
  "floating",
  "sunken",
  "interpenetration",
  "insert_host",
  "mount_gap",
  "orientation",
  "uv_stretch",
  "duplicate",
  "z_fight",
  "lights",
  "transform",
  "resource",
] as const;
export type AuditCheck = (typeof AUDIT_CHECKS)[number];

export const SEVERITIES = ["error", "warn", "look"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const AUDIT_DEFAULT_LIMIT = 15;
export const AUDIT_MAX_LIMIT = 50;
export const AUDIT_MAX_MANIFESTS = 8;
/** Editor time the checks may take before the slow ones stop early (partial). */
export const AUDIT_DEFAULT_BUDGET_MS = 3000;
export const AUDIT_MIN_BUDGET_MS = 250;
export const AUDIT_MAX_BUDGET_MS = 60000;

export const sceneAuditShape = {
  scenePath: z
    .string()
    .optional()
    .describe('Scene to audit, e.g. "res://levels/town.tscn" (the SAVED file). Omit for the scene open in the editor.'),
  checks: z
    .array(z.enum(AUDIT_CHECKS))
    .min(1)
    .max(AUDIT_CHECKS.length)
    .optional()
    .describe(
      "Only these checks (default: all 14). through_hole, floor_gap, floating, sunken, interpenetration, insert_host, mount_gap, orientation, uv_stretch, duplicate, z_fight, lights, transform, resource. Fewer checks run faster (insert_host, duplicate, lights, transform and resource need no physics); rerun a check budget_ms left partial on its own."
    ),
  root: z
    .string()
    .optional()
    .describe('Report only issues under this node (subtree), e.g. "Block3". The whole scene is still loaded so walls and floors outside it count as surroundings.'),
  min_severity: z
    .enum(SEVERITIES)
    .optional()
    .describe('"error" (only errors), "warn" (errors and warnings) or "look" (default: everything, including look items that only ask you to look).'),
  offset: z.number().int().min(0).max(100000).optional().describe("Skip this many issues of the sorted, filtered list (paging; the result names the next offset)."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(AUDIT_MAX_LIMIT)
    .optional()
    .describe(`Issues per page (default ${AUDIT_DEFAULT_LIMIT}, max ${AUDIT_MAX_LIMIT}). The result is capped at 5 KB; a page that does not fit is cut and says so.`),
  manifests: z
    .array(z.string())
    .max(AUDIT_MAX_MANIFESTS)
    .optional()
    .describe(
      'Optional kit manifests (res:// .json), read only when passed here: {"pieces": {"<scene path, or a scene name relative to the manifest>": {category, front_axis, mount_side, standoff_m, symmetric, fits_into: {piece, local_offset_m}}}}. category: wall/facade, floor, prop, dressing, or any structural word (band, corner, pier, ...); front_axis / mount_side: a local axis such as "+Z" / "-Z" (mount_side = the side that faces the wall it hangs on); standoff_m: how far off that wall it stands by design (a number or [min, max]); symmetric: looks the same turned 180 deg; fits_into: an insert (window, door) and its host piece, with its offset in the host\'s frame. Every field is optional; without manifests the checks use geometry and node names.'
    ),
  budget_ms: z
    .number()
    .int()
    .min(AUDIT_MIN_BUDGET_MS)
    .max(AUDIT_MAX_BUDGET_MS)
    .optional()
    .describe(
      `Editor time for the whole audit (default ${AUDIT_DEFAULT_BUDGET_MS} ms, ${AUDIT_MIN_BUDGET_MS}-${AUDIT_MAX_BUDGET_MS}). Each check gets a share weighted by its usual cost (unused time passes on); a check past its share stops and counts.<check>.partial gives the share it covered. Under load, rerun the partial checks with checks:[...] or a larger budget.`
    ),
  render: z
    .enum(["sheet", "none"])
    .optional()
    .describe('"sheet": also return ONE inline image of the first 6 issues of this page framed up close from their open side, each tile labelled with its issue number. Default "none" (no image).'),
};

export const sceneAuditArgsSchema = z.object(sceneAuditShape).strict();
export type SceneAuditArgs = z.output<typeof sceneAuditArgsSchema>;
