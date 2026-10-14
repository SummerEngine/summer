import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withEngine } from "./with-engine.js";
import { sceneAudit, type AuditClient, type AuditResult } from "../../core/capabilities/audit/audit.js";
import { sceneAuditShape, type SceneAuditArgs } from "../../core/capabilities/audit/args.js";

/**
 * summer_scene_audit: one read-only call that walks every node of a 3D scene
 * and lists likely visual and placement problems, so a build agent knows
 * exactly where to look. Implementation and the in-engine kernel:
 * src/core/capabilities/audit/ and assets/audit/scene_audit.gd.
 */

type ToolResultContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: ToolResultContent[]; isError?: boolean };

interface Wrapped {
  audit: AuditResult;
  failure_reason?: string;
}

export function auditContent(result: AuditResult): ToolResult {
  if (!result.ok) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            tool: "summer_scene_audit",
            failure_reason: result.failure_reason,
            error: result.error,
            ...(result.hint ? { hint: result.hint } : {}),
            ...(result.detail ? { detail: result.detail } : {}),
          }),
        },
      ],
    };
  }
  const content: ToolResultContent[] = [];
  if (result.image) content.push({ type: "image", data: result.image.base64, mimeType: result.image.mime || "image/jpeg" });
  content.push({ type: "text", text: JSON.stringify(result.summary) });
  return { content };
}

export function registerAuditTools(server: McpServer): void {
  server.tool(
    "summer_scene_audit",
    `Audit a 3D scene in one fast, read-only call: it walks every node and subnode and lists likely visual and placement problems, sorted by severity. Each issue is a flag to LOOK at, never an auto-fix.

Checks (pick with checks; the verifying-scenes skill explains each):
- through_hole: ray grids through each facade line that pass the wall AND reach the building's far side (an insert narrower than its frame, a missing module). Props do not close an opening.
- exposed_edge: edges of walls, bands, piers and corner blocks nothing covers within 4-7 mm, seen from walkable space, with a 2-60 cm reveal, a 4 cm seam or a 35 cm gap. Warn on bands or when depth_step agrees, else look.
- open_fixture_end (warn): open ends of pipe, duct or gutter runs (2+ open rims of one size) nothing joins within 2.5 cm; caps, funnels, outlets are open by design.
- depth_step (look): ray rows at each facade's band levels and every 1.25 m: recesses, missing runs, seams, proud modules, holes (a hole by a through_hole makes it an error).
- floor_gap: down rays over tiles, seams and the strip to a wall within 1 m, by FIRST surface hit: the void (error), underlay over the floor's own drain (warn, not a hole), underlay through a hole.
- floating / sunken: over 2 cm above or 3 cm into the first surface from above; structure and wall-mounted pieces excluded.
- interpenetration: prop hulls cutting props, walls, structure or inserts over 3 cm, with every partner (up to 3).
- orientation (look): long props within 1.2 m of a wall over 15 deg off parallel; never says which way to face.
- uv_stretch: shown triangles with UVs stretched over 8:1 or collapsed.
- duplicate: same scene, same transform.
- z_fight: coplanar overlapping faces of two pieces (opposite-facing only if both double-sided) or of one mesh: a gap under twice the 24-bit depth step at the view distance (else 30 m). Warn over 0.05 m2 seen; ev.nudge names the axis to move (world and local). render_priority, depth or normal offsets, alpha, no depth test or writes demote it to look, with the reason.
- lights: over the per-object omni/spot limit (Compatibility: 8 each), spot_angle_attenuation under 3; shadowed counts.
- transform: NaN, negative or non-uniform scale, far out of bounds, pieces left at the origin (several = warn, one = look).
- resource: missing dependencies, a MeshInstance3D without a mesh, surfaces without a material.

budget_ms (default 3000) bounds editor time: each check gets a weighted share; one past it stops, marked counts.<check>.partial (the share covered), never clean. exposed_edge, open_fixture_end and depth_step run last on the time left: rerun them alone when partial.

accept:[{key, reason}] (issues[].key) records look/warn items you judged fine in res://.summer/audit-accept.json, the only file the audit writes. Later audits count them (counts.<check>.accepted) but hide them until severity rises or the measured size moves over 25% (then accept_stale). Errors cannot be accepted; show_accepted lists them.

Returns at most 5 KB of JSON: counts and editor ms per check, scene size, ONE page of issues {n, check, sev (error|warn|look), path, pos (world), why, ev (evidence numbers, the ray to reproduce), next (the next tool), key}. Page with offset/limit (next_offset); filter with checks, root (subtree), min_severity. render:"sheet" adds ONE image of the page's first 6 issues framed close from their open side, tiles labelled #n.

Every check works from geometry, node and resource data and materials alone: never node or file names, never kit metadata. Each piece's role (dressing, wall, floor, roof, underlay, insert, structure, a prop up to 3.5 m) comes from its shape.

Read-only: audits the SAVED file (save first) in a private offscreen copy (ScenePreview): the open tab never becomes unsaved, undo is untouched, nothing is saved. Failures are structured (failure_reason), never a silent fallback.`,
    sceneAuditShape,
    async (args: SceneAuditArgs) =>
      withEngine(async (client) => {
        const audit = await sceneAudit(client as unknown as AuditClient, args);
        return audit.ok ? ({ audit } as Wrapped) : ({ audit, failure_reason: audit.failure_reason } as Wrapped);
      }, { onResult: (wrapped: Wrapped) => auditContent(wrapped.audit) })
  );
}
