/**
 * Argument shapes for the seeing tools — ONE copy for both faces (the MCP
 * registration in src/mcp/tools/seeing-tools.ts and `summer tool <slug>` in
 * tool-dispatch.ts). The descriptions are the tool docs agents read.
 */
import { z } from "zod";
import { DIRECTION_PRESET_NAMES } from "./math.js";
import { SHOT_TYPES } from "./candidates.js";
import { MAX_IMAGE_EDGE, VIEW_MODES } from "./seeing.js";

const scenePath = z
  .string()
  .optional()
  .describe('Scene to look at, e.g. "res://levels/town.tscn" (the SAVED file). Omit for the scene open in the editor.');

const bookmarkName = z
  .string()
  .optional()
  .describe('Pose from a camera bookmark (summer_camera_bookmark). Use INSTEAD of camera_position/camera_look_at.');
const cameraPosition = z.string().optional().describe('Explicit pose: camera position, "Vector3(x, y, z)". Goes with camera_look_at.');
const cameraLookAt = z.string().optional().describe('Explicit pose: point the camera looks at, "Vector3(x, y, z)".');
const fov = z.number().optional().describe("Vertical field of view in degrees (1..179). Default: the bookmark's own, or 60.");
const maxSize = (fallback: number) =>
  z
    .number()
    .int()
    .min(64)
    .max(MAX_IMAGE_EDGE)
    .optional()
    .describe(`Longest edge of the returned JPEG in pixels (default ${fallback}). Bigger costs more context; up to ${MAX_IMAGE_EDGE} for detail work on a PC.`);
const aspect = z.number().optional().describe("Frame width/height (default 1.7778 = 16:9). Every tile uses it.");
const saveTo = z
  .string()
  .optional()
  .describe('Also write the returned image to res://.summer/shots/saved/<name>.jpg (1-64 of A-Z a-z 0-9 _ -; needs max_size <= 1024). Nothing is written without it, except one previous-image slot per rendered bookmark.');
const view = z
  .enum(VIEW_MODES)
  .optional()
  .describe('"beauty" (default: real environment, lights, fog, tonemap), "lighting" (light only), "unshaded" (albedo/texture only), "normals" (world normals, x red y green z blue), "overdraw", "wireframe".');

export const frameNodesShape = {
  scenePath,
  nodes: z
    .array(z.string())
    .min(1)
    .max(16)
    .describe('Node paths relative to the scene root ("House1", "Props/Crate_02"). The camera fits their combined WORLD bounds (visible meshes, children included).'),
  direction: z
    .enum(DIRECTION_PRESET_NAMES)
    .optional()
    .describe('Side the camera sits on: "front" (+Z), "back" (-Z), "left" (-X), "right" (+X), "top", "iso" (default, 3/4 from -X,+Y,-Z like summer_screenshot). Use from for anything else.'),
  from: z.string().optional().describe('Explicit direction FROM the nodes TOWARD the camera, "Vector3(1, 0.4, 2)". Replaces direction.'),
  fill: z.number().optional().describe("Share of the frame the nodes span along their limiting dimension (0.1..1.5, default 0.8)."),
  fov: z.number().optional().describe("Vertical field of view in degrees (default 50)."),
  max_size: maxSize(1024),
  aspect,
  marks: z.boolean().optional().describe("Numbered Set-of-Mark labels over the largest visible nodes; the caption maps label -> node path (feed a label to summer_zoom mark)."),
  max_marks: z.number().int().min(1).max(128).optional().describe("marks only: cap on labels (engine default 32)."),
  bookmark_name: z
    .string()
    .optional()
    .describe("Also save the fitted pose as this camera bookmark (1-64 of A-Z a-z 0-9 _ -), so later renders line up with it."),
};

const shotShape = z.object({
  bookmark_name: bookmarkName,
  camera_position: cameraPosition,
  camera_look_at: cameraLookAt,
  fov,
  label: z.string().optional().describe("Tile label (1-64 printable characters, no quotes, backslashes or $). Default: the bookmark name or 'shot N'."),
});

export const shotSheetShape = {
  scenePath,
  shots: z
    .array(shotShape)
    .min(1)
    .max(12)
    .describe("1-12 shots, each a bookmark_name OR camera_position + camera_look_at (+ fov), with an optional label. Rendered in this order, left to right, top to bottom."),
  view,
  compare_previous: z
    .boolean()
    .optional()
    .describe("For bookmark shots: one row per bookmark of [previous render | now | difference map], with the share of changed pixels in the caption. The previous render is the bookmark's slot in res://.summer/shots/, replaced by this render."),
  max_size: maxSize(1536),
  aspect,
  save_to: saveTo,
};

export const debugViewsShape = {
  scenePath,
  bookmark_name: bookmarkName,
  camera_position: cameraPosition,
  camera_look_at: cameraLookAt,
  fov,
  views: z
    .array(z.enum(VIEW_MODES))
    .max(8)
    .optional()
    .describe("Which views, in grid order (default all six: beauty, lighting, unshaded, normals, overdraw, wireframe)."),
  max_size: maxSize(1536),
  aspect,
  save_to: saveTo,
};

export const zoomShape = {
  scenePath,
  bookmark_name: bookmarkName,
  camera_position: cameraPosition,
  camera_look_at: cameraLookAt,
  fov,
  region: z
    .array(z.number())
    .length(4)
    .optional()
    .describe("[x, y, w, h] as fractions (0..1) of the frame from the same pose, x/y from the TOP-LEFT. Use this OR mark."),
  mark: z
    .number()
    .int()
    .optional()
    .describe("A label number from a marks:true render of the SAME pose and reference_size (summer_frame_nodes, or summer_screenshot framing free/bookmark at that size)."),
  reference_size: z
    .array(z.number().int())
    .length(2)
    .optional()
    .describe("[width, height] of the frame region/mark refer to (default [1024, 576]). Sets the zoom's aspect."),
  pad: z.number().optional().describe("Margin added around the region on each side, as a fraction of its size (0..1, default 0.15)."),
  view,
  max_size: maxSize(1024),
  save_to: saveTo,
};

export const frameShotShape = {
  scenePath,
  shot: z
    .enum(SHOT_TYPES)
    .describe('"establishing" (wide, whole subject, 12-40 deg up), "eye_level" (player eye at spawn: its Camera3D, or origin + eye_height), "low_angle" (hero, camera near the ground looking up), "detail" (close-up), "corridor" (down an alley/corridor inside the subject, found by a free-space scan; prefers looking in from its open end).'),
  subject: z
    .array(z.string())
    .max(8)
    .optional()
    .describe("Node paths to frame (required except for eye_level, where it is what the player looks at)."),
  spawn: z.string().optional().describe("eye_level only: node the player stands at, e.g. the player or a spawn marker. Its own geometry never counts as an occluder."),
  eye_height: z.number().optional().describe("eye_level/corridor: eye height above the spawn origin / corridor floor in metres (default: the spawn's Camera3D, else 1.6)."),
  fov: z.number().optional().describe("Override the shot type's field of view (establishing 55, eye_level 60/75, low_angle 60 then widened, detail 40, corridor 60/75)."),
  aspect,
  occluders: z
    .object({
      hard: z.array(z.string()).optional().describe("Path prefixes that must never block the view (walls, terrain): a pose they block is rejected."),
      soft: z.array(z.string()).optional().describe("Path prefixes that may sit in front as framing (foliage, fences, props)."),
      ignore: z.array(z.string()).optional().describe("Path prefixes left out of the visibility pass entirely."),
      hard_layers: z.number().int().optional().describe("Physics layer mask: geometry whose nearest CollisionObject3D is on these layers is hard."),
      soft_layers: z.number().int().optional().describe("Physics layer mask for soft geometry."),
    })
    .optional()
    .describe("Override the occluder classification. Default: path names (wall/house/terrain... = hard; tree/fence/lamp/prop/pipe... = soft), MultiMesh = soft, else size (<= 2.5 m = soft). The caption reports the counts by rule."),
  max_soft_fraction: z.number().optional().describe("Most of the subject that soft geometry may cover before a pose is rejected (0..1, default 0.67)."),
  bookmark_name: z.string().optional().describe("Name for the saved best pose (default <shot>_<subject leaf>)."),
  save_bookmark: z.boolean().optional().describe("Save the best pose as a camera bookmark (default true)."),
  render: z
    .enum(["sheet", "best", "none"])
    .optional()
    .describe('"sheet" (default): the top 3 in one labelled grid with real lighting; "best": the winner only; "none": scores only.'),
  max_size: maxSize(1536),
};

export const frameNodesArgsSchema = z.object(frameNodesShape).strict();
export const shotSheetArgsSchema = z.object(shotSheetShape).strict();
export const debugViewsArgsSchema = z.object(debugViewsShape).strict();
export const zoomArgsSchema = z.object(zoomShape).strict();
export const frameShotArgsSchema = z.object(frameShotShape).strict();
