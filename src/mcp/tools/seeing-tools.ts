import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withEngine } from "./with-engine.js";
import {
  debugViews,
  frameNodes,
  frameShot,
  shotSheet,
  zoom,
  type DebugViewsArgs,
  type FrameNodesArgs,
  type FrameShotArgs,
  type SeeingClient,
  type SeeingResult,
  type ShotSheetArgs,
  type ZoomArgs,
} from "../../core/capabilities/seeing/seeing.js";
import {
  debugViewsShape,
  frameNodesShape,
  frameShotShape,
  shotSheetShape,
  zoomShape,
} from "../../core/capabilities/seeing/args.js";

/**
 * Seeing tools: look at a 3D environment the way a player and an artist do.
 * Every image comes back INLINE as an MCP image block (one grid image for a
 * sheet, never N images), with a compact text caption (labels, poses, scores,
 * mark -> path). Renders use the scene's REAL WorldEnvironment and lights.
 * Implementation and the in-engine kernel: src/core/capabilities/seeing/.
 */

type ToolResultContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: ToolResultContent[]; isError?: boolean };

interface Wrapped {
  seeing: SeeingResult;
  /** Lifted for the per-call debug logger; never an envelope failure flag. */
  failure_reason?: string;
}

function wrap(result: SeeingResult): Wrapped {
  return result.ok ? { seeing: result } : { seeing: result, failure_reason: result.failure_reason };
}

export function seeingContent(result: SeeingResult): ToolResult {
  if (!result.ok) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: result.error,
              failure_reason: result.failure_reason,
              ...(result.hint ? { hint: result.hint } : {}),
              ...(result.detail ? { detail: result.detail } : {}),
            },
            null,
            2
          ),
        },
      ],
    };
  }
  const content: ToolResultContent[] = [];
  if (result.image) content.push({ type: "image", data: result.image.base64, mimeType: result.image.mime || "image/jpeg" });
  content.push({ type: "text", text: result.caption });
  return { content };
}

function run<A>(op: (client: SeeingClient, args: A) => Promise<SeeingResult>) {
  return async (args: A) =>
    withEngine(async (client) => wrap(await op(client as unknown as SeeingClient, args)), {
      onResult: (wrapped: Wrapped) => seeingContent(wrapped.seeing),
    });
}

const COMMON = `Read-only: the scene file, the open tab and the undo history are never touched (the render is an offscreen copy of the SAVED scene). The image arrives inline; the caption carries poses, labels and numbers. Failures are structured (failure_reason), never a silent fallback.`;

export function registerSeeingTools(server: McpServer): void {
  server.tool(
    "summer_frame_nodes",
    `Frame one or more nodes with a camera fitted to their WORLD bounds and render it with the scene's REAL WorldEnvironment, lights, fog and tonemap (unlike summer_screenshot nodePath, which only works with the flat preview environment).

Pick the side with direction (front/back/left/right/top/iso) or an explicit from vector; fill sets how much of the frame they span. bookmark_name also saves the fitted pose so every later render (summer_shot_sheet, summer_debug_views, summer_screenshot framing:"bookmark") lines up with it. marks:true adds numbered labels mapped to node paths.

An explicit from is checked in-engine before you trust the image: if walls block the nodes, or the camera stands behind or inside a one-sided surface (its back is not drawn, so the image would look THROUGH the wall), the caption opens with a WARNING and the nearest valid from (+ fov) to pass back. With marks:true every labelled node gets an occlusion test (centre + 4 bounds points); hidden ones are noted "(hidden behind <path>)".

Returns the image + caption: the pose as Vector3 literals, the bounds, the environment used, the view check, and the mark list. ${COMMON}`,
    frameNodesShape,
    run<FrameNodesArgs>(frameNodes)
  );

  server.tool(
    "summer_shot_sheet",
    `Render several bookmarks and/or explicit poses into ONE labelled grid image in a single call: same tile size, same view, real lighting. Use it after every change to see all hero views at once instead of N screenshots.

compare_previous:true turns each bookmark into a row of [previous | now | difference map] and reports the share of pixels that changed and where. Each bookmark keeps exactly one previous render (its compare baseline) at res://.summer/shots/<bookmark>.jpg (JPEG, <= 1024 px; the folder is capped at 20 MB, oldest first). Only compare_previous:true or update_previous:true replaces it; a plain sheet creates a missing baseline and never overwrites one. view renders every tile as lighting/unshaded/normals/overdraw/wireframe instead of beauty.

Returns the grid + caption (tile number -> label and pose, difference stats). ${COMMON}`,
    shotSheetShape,
    run<ShotSheetArgs>(shotSheet)
  );

  server.tool(
    "summer_debug_views",
    `One pose rendered as a grid of debug views next to the beauty pass: beauty, lighting (light only: direction, pools, dead-dark areas), unshaded (albedo: texture quality, value grouping), normals (world-space, x red y green z blue: seams, flipped or faceted normals), overdraw (stacked transparent layers), wireframe (triangle density, floating or duplicated pieces).

Use it on the weakest shot of a sheet to see WHY it reads badly. lighting/unshaded/overdraw/wireframe are the engine's Viewport debug draw modes; normals uses an unshaded override material on a private copy (normal maps and alpha cut-outs are not applied) and works on every renderer. The caption names the method per view.

Returns the grid + caption. ${COMMON}`,
    debugViewsShape,
    run<DebugViewsArgs>(debugViews)
  );

  server.tool(
    "summer_zoom",
    `High-resolution close look at part of a frame: region [x, y, w, h] (fractions of the frame) or mark N from a marks render of the same pose. The camera renders the EXACT sub-frustum of that region at full output resolution, so you see real texture detail, seams, gaps and floating pieces, not upscaled pixels. A region is honoured exactly (no pad by default, never widened to an aspect ratio: the image takes the region's own aspect, with dark bars only for extreme shapes); a mark gets pad 0.15.

Use after a sheet or debug view shows something suspicious. view picks beauty or a debug view. Returns the zoomed image + caption (the real zoom factor, the rendered region, widened_because when it is larger than asked, mark -> node path and a warning when that node is hidden). ${COMMON}`,
    zoomShape,
    run<ZoomArgs>(zoom)
  );

  server.tool(
    "summer_frame_shot",
    `Smart framing: find good camera poses for a shot type automatically, measured in-engine against the real geometry.

shot: establishing (wide), eye_level (from a spawn node at player eye height), low_angle (hero, near the ground looking up: the camera moves closer and widens its FOV instead of sinking into the ground), detail (close-up), corridor (down an alley or corridor found inside the subject by a free-space scan, preferring the view in from its open end, walls on both sides).

How: candidate poses on a ring/hemisphere (or along the corridor line) at the distance where the subject fills the shot's target share of the frame; each is checked with a THICK sphere sweep to points on the subject (thin rays miss corners), a near-lens sphere (camera inside or touching geometry is nudged forward or rejected), a ray grid through the frame, and a small beauty render per pose. Walls/terrain blocking the subject reject a pose, and so does a camera behind or inside a one-sided surface (a sight line or a quarter of the frame meeting a wall from behind: its back is not drawn, so the image would look through it). Foliage, fences, props and pipes in front are allowed (wanted, up to a limit) as framing; transparent materials (alpha, scissor, glass, foliage cards) are see-through cover at partial weight. Scored on rule-of-thirds placement, frame fill, level horizon, sky share, depth behind the subject (no flat wall right behind it), empty or featureless areas, near-wall clearance, near/far value contrast, foreground framing, surfaces seen from behind, the key light's direction (side or front-side beats a flat front-lit face) and the world edge (sky or void below the horizon).

Returns the top 3 with score breakdowns and poses — three different views (one per side of the subject while the score allows, at least 25 degrees apart) — saves the best as a bookmark (default <shot>_<subject>), and renders the 3 as one sheet with real lighting (render:"best" or "none" to save context). ${COMMON} Saving the bookmark writes res://.summer/camera_bookmarks.json.`,
    frameShotShape,
    run<FrameShotArgs>(frameShot)
  );
}
