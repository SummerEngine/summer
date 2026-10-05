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
    `Audit a 3D scene in one fast, read-only call: every node and subnode is walked and likely visual and placement problems come back as a short list, sorted by severity, so you know exactly where to look. Each issue is a flag to LOOK at, never an auto-fix.

Checks (each can be picked with checks):
- through_hole: capped ray grids through every facade line (coplanar wall fronts); clusters of rays that pass the wall AND reach the far side of the building (a door insert narrower than its frame, a missing module, a seam). Inserts, shutters and boards close an opening; props do not.
- floor_gap: down rays over the floor tiles, along their seams, and from each tile edge to a wall within 1 m (bare strips at wall bases), classified by the FIRST surface hit: the void (error); an underlay over the floor's own lower surface such as a drain channel ("covers the floor", warn, not a hole); an underlay through a hole or strip. Areas are the missed rays' own footprints with the strip's size; a tile whose own mesh has holes is one issue for the piece.
- floating / sunken: support under each prop's footprint; gap over 2 cm, embed over 3 cm, measured against the first surface from above (the tile it is buried in, not the underlay under it); structure, wall-mounted and wall-held pieces excluded.
- interpenetration: each prop's convex hulls against props, walls and mounted pieces; a deepest overlap over 3 cm, then every partner it cuts (up to 3).
- insert_host: inserts a manifest fits into a host (fits_into); the named host must sit at the insert's transform minus local_offset_m (2 cm, 1 deg); reports the host actually found.
- mount_gap: pieces a manifest gives a mount_side; the largest gap of the centre and the 4 side samples over 5 cm, or over the manifest's standoff_m + 5 cm; pieces a wall-touching bracket or clamp holds (and their run) are fine; repeats group per piece.
- orientation (look): long props within 1.2 m of a wall more than 15 deg off parallel; mounted pieces whose mount side points away from the nearest wall, except front-back symmetric pieces (duct runs, strap braces; or the manifest's symmetric). It never says which way a piece should face.
- uv_stretch: per mesh resource, large triangles whose UV-to-world mapping is stretched over 8:1 or collapsed to a line, where an instance shows them (a reveal that inserts normally cover = warn).
- duplicate: the same scene at the same transform.
- z_fight: coplanar overlapping faces anywhere, from each mesh's planar face groups: between any two pieces (props, roofs, ledges, side walls, inserts against hosts, decals; opposite-facing only when both are double-sided) and between two surfaces of one mesh (once per mesh), plus the ray samples. Coplanar = a gap under twice the 24-bit depth step at the view distance (the nearest walkable eye point, camera or bookmark; 30 m without one) for the main camera's near/far; ev carries the overlap, gap, tolerance and surfaces. Warn over 0.05 m2 seen from a viewpoint; render_priority, depth or normal offsets, and decal or overlay names are demoted to look with the reason.
- lights: meshes paired with more than the per-object limit of omni or spot lights (Compatibility: 8 each; light cuts off at seams), spot lights with spot_angle_attenuation under 3; shadowed light counts.
- transform: NaN, negative or non-uniform scale, a piece left at the origin, a piece far out of bounds.
- resource: missing dependency files, MeshInstance3D without a mesh, surfaces without a material.

budget_ms (default 3000) bounds the editor time: each check gets a weighted share of it, and a check past its share stops and is marked counts.<check>.partial (the share it covered), never clean.

Returns at most 5 KB of JSON: counts per check, time per check (editor ms), the scene size, and ONE page of issues {n, check, sev (error|warn|look), path, pos (world), why, ev (evidence numbers: sizes, distances, angles, the ray to reproduce), next (the tool to use next)}. Page with offset/limit (next_offset names the next page); filter with checks, root (a subtree) and min_severity. render:"sheet" adds ONE inline image of the page's first 6 issues framed up close from their open side (a camera never behind a wall), each tile labelled #n.

Read-only: it audits the SAVED file in a private offscreen copy (ScenePreview), so the open tab never becomes unsaved, undo is untouched and nothing is saved. Save the scene first. Kit metadata is optional and comes only from the manifests you pass (res:// JSON: {"pieces": {"<scene path or name>": {category, front_axis, mount_side, standoff_m, symmetric, fits_into: {piece, local_offset_m}}}}); without them every check works from geometry and node names. Failures are structured (failure_reason), never a silent fallback.`,
    sceneAuditShape,
    async (args: SceneAuditArgs) =>
      withEngine(async (client) => {
        const audit = await sceneAudit(client as unknown as AuditClient, args);
        return audit.ok ? ({ audit } as Wrapped) : ({ audit, failure_reason: audit.failure_reason } as Wrapped);
      }, { onResult: (wrapped: Wrapped) => auditContent(wrapped.audit) })
  );
}
