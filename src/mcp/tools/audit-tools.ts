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
- band_continuity: facade bands (base / dado / plinth, cornice, crown, trim, band, sill; pieces.json category or name) grouped per facade line, height and facing. A missing run over 5 cm (unless a door, gate or shutter, or a corner, end or pier piece, covers 80% of it over half the band height); a short end over 5 cm when the band covers half its block's facade; an outside corner whose square (this band's depth x the return band's depth) is under 70% covered (two bands that only touch at the corner leave it empty); a band facing into the wall, only when exposed_edge confirms it. Error when exposed_edge or depth_step confirms the spot (ev.confirmed_by), warn otherwise; only spots walkable eye points see (open-sky floor cells, flood-filled from the scene's cameras and characters, sight lines not through a building).
- exposed_edge: open outline edges of wall-, band- and pier-shaped pieces (cached per mesh) that nothing covers within 4-7 mm, seen from walkable space, with a 2-60 cm reveal behind them, or a coplanar sheet continuing within 4 cm (seam) or 35 cm (gap). Warn on band pieces and when depth_step agrees, look otherwise; repeats group per piece type.
- open_fixture_end: open ends of pipe, duct and gutter pieces (pieces.json ports, else the mesh's open loops) that nothing joins within 2.5 cm (sleeve tolerance), seen from walkable space: a missing elbow, coupler, section or outlet (warn). Outlets, funnels, vents and caps are open by design.
- depth_step (look): ray rows across each visible facade side at its band levels and every 1.25 m: band recesses and missing runs, seams, modules standing proud, holes with something behind them; a hole next to a through_hole confirms it (warn -> error); runs a door covers are skipped.
- floor_gap: down rays over the floor tiles, along their seams, and from each tile edge to a wall within 1 m (bare strips at wall bases), classified by the FIRST surface hit: the void (error); an underlay over the floor's own lower surface such as a drain channel ("covers the floor", warn, not a hole); an underlay through a hole or strip. Areas are the missed rays' own footprints with the strip's size; a tile whose own mesh has holes is one issue for the piece; next names the pack's documented ground alternative (PACK.json / ASSEMBLY.md).
- floating / sunken: support under each prop's footprint; gap over 2 cm, embed over 3 cm, measured against the first surface from above (the tile it is buried in, not the underlay under it); structure, wall-mounted and wall-held pieces excluded.
- interpenetration: each prop's convex hulls against props, walls and mounted pieces; a deepest overlap over 3 cm, then every partner it cuts (up to 3).
- insert_host: pieces.json fits_into (v1.3 host / offset_from_host_origin, or piece / local_offset_m); the named host must sit at the insert's transform minus the offset (2 cm, 1 deg); reports the host actually found.
- mount_gap: mounted pieces (wall_side, or v1.3 parts the artists hung on a wall: facing.wall_axis, or the side facing the nearest wall when their placements disagree); the largest gap of the centre and the 4 side samples over 5 cm, or over the pack's documented standoff + 5 cm (pieces.json standoff_m or facing.wall_gap_m, or ASSEMBLY.md "0.1 m off the wall"); pieces a wall-touching bracket or clamp holds (and their run) are fine; a gap onto a recessed window while the piece is on the wall plane is look; repeats group per piece.
- orientation (look): long props within 1.2 m of a wall more than 15 deg off parallel; mounted pieces whose mount side points away from the nearest wall, except front-back symmetric pieces (duct runs, strap braces; or pieces.json symmetric). It never says which way a piece should face.
- uv_stretch: per mesh resource, large triangles whose UV-to-world mapping is stretched over 8:1 or collapsed to a line, where an instance shows them (a reveal that inserts normally cover = warn).
- duplicate: the same scene at the same transform.
- z_fight: coplanar overlapping faces anywhere, from each mesh's planar face groups: between any two pieces (props, roofs, ledges, side walls, inserts against hosts, decals; opposite-facing only when both are double-sided) and between two surfaces of one mesh (once per mesh), plus the ray samples. Coplanar = a gap under twice the 24-bit depth step at the view distance (the nearest walkable eye point, camera or bookmark; 30 m without one) for the main camera's near/far; ev carries the overlap, gap, tolerance, surfaces, the plane's normal and the axis to nudge (nudge.world, nudge.local: a window can share its head or a jamb with its host, not its front). Warn over 0.05 m2 seen from a viewpoint; render_priority, depth or normal offsets, and decal or overlay names are demoted to look with the reason.
- lights: meshes paired with more than the per-object limit of omni or spot lights (Compatibility: 8 each; light cuts off at seams), spot lights with spot_angle_attenuation under 3; shadowed light counts.
- transform: NaN, negative or non-uniform scale, a piece far out of bounds, and pieces left at the origin: an identity LOCAL transform under an identity parent, touching nothing and not one of a row of siblings (several sharing it warn, one alone is look; a module whose corner is the world origin is placed).
- resource: missing dependency files, MeshInstance3D without a mesh, surfaces without a material.

budget_ms (default 3000) bounds the editor time: each check gets a weighted share of it, and a check past its share stops and is marked counts.<check>.partial (the share it covered), never clean. The four gap detectors run last on the time the other checks leave (band pieces and band rows first); rerun them alone when partial.

accept:[{key, reason}] (keys from issues[].key) records look and warn items you judged fine in res://.summer/audit-accept.json (the only file the audit writes); later audits count them (counts.<check>.accepted) but hide them until their evidence changes materially (severity rises, or the measured size moves by over 25%: shown again with accept_stale). Errors cannot be accepted; show_accepted lists them.

Returns at most 5 KB of JSON: counts per check, time per check (editor ms), the scene size, and ONE page of issues {n, check, sev (error|warn|look), path, pos (world), why, ev (evidence numbers: sizes, distances, angles, the ray to reproduce), next (the tool to use next), key (for accept)}. Page with offset/limit (next_offset names the next page); filter with checks, root (a subtree) and min_severity. render:"sheet" adds ONE inline image of the page's first 6 issues framed up close from their open side (a camera never behind a wall), each tile labelled #n.

Read-only: it audits the SAVED file in a private offscreen copy (ScenePreview), so the open tab never becomes unsaved, undo is untouched and nothing is saved (accept writes only its own file). Save the scene first. Pack metadata comes from pieces.json next to the instanced scenes, in the v1.3 parts format or the older pieces format, no adapter needed (or manifests). Failures are structured (failure_reason), never a silent fallback.`,
    sceneAuditShape,
    async (args: SceneAuditArgs) =>
      withEngine(async (client) => {
        const audit = await sceneAudit(client as unknown as AuditClient, args);
        return audit.ok ? ({ audit } as Wrapped) : ({ audit, failure_reason: audit.failure_reason } as Wrapped);
      }, { onResult: (wrapped: Wrapped) => auditContent(wrapped.audit) })
  );
}
