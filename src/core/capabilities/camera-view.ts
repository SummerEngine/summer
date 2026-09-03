/**
 * Camera viewpoints (wave I perception): camera bookmarks and the fixed-pose
 * ScenePreview framings. Shared by the MCP tools (src/mcp/tools/visual-tools.ts)
 * and the CLI dispatcher so both faces validate the same way and send the same
 * op.
 *
 * Engine contract (doc/SUMMER/SCENE_SCRIPTING_CONTRACTS.md, "Wave I"):
 *   SaveCameraBookmark { name, position?, look_at?, fov? }  -> pose_source
 *   ListCameraBookmarks {}                                   -> names, bookmarks
 *   DeleteCameraBookmark { name }                            -> remaining
 * and ScenePreview framings "free" (camera_position, camera_look_at, fov) and
 * "bookmark:<name>" plus the Set-of-Mark overlay (marks, max_marks).
 *
 * Bookmarks live in the PROJECT (res://.summer/camera_bookmarks.json), so a
 * viewpoint saved once is the same viewpoint next session and on another
 * machine — the point is before/after screenshots that actually line up.
 */
import { ToolInputError } from "../tool-errors.js";

export const CAMERA_BOOKMARK_ACTIONS = ["save", "list", "delete"] as const;
export type CameraBookmarkAction = (typeof CAMERA_BOOKMARK_ACTIONS)[number];

/** Engine op kind per action — the pre-flight checks THIS kind, not all three. */
export const CAMERA_BOOKMARK_OPS: Record<CameraBookmarkAction, string> = {
  save: "SaveCameraBookmark",
  list: "ListCameraBookmarks",
  delete: "DeleteCameraBookmark",
};

/** What the engine_lacks_op result tells the model to do instead. */
export const CAMERA_BOOKMARK_FALLBACK =
  "pass the pose explicitly on every capture with summer_screenshot framing:\"free\" (camera_position + camera_look_at), or render through a Camera3D placed in the scene with framing:\"camera\"";

/** Bookmark name grammar (preview_ops.cpp): 1-64 of [A-Za-z0-9_-]. */
export const BOOKMARK_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface CameraBookmarkArgs {
  action: CameraBookmarkAction;
  name?: string;
  /** Godot literal, e.g. "Vector3(0, 5, 10)". Goes together with look_at. */
  position?: string;
  look_at?: string;
  fov?: number;
}

function requireBookmarkName(name: string | undefined, action: string): string {
  const trimmed = name?.trim() ?? "";
  if (!trimmed) {
    throw new ToolInputError(`action "${action}" needs a bookmark name (1-64 of A-Z a-z 0-9 _ -). Nothing was sent.`);
  }
  if (!BOOKMARK_NAME_PATTERN.test(trimmed)) {
    throw new ToolInputError(
      `Bookmark name "${trimmed}" is invalid — use 1-64 characters from A-Z a-z 0-9 _ - (no spaces or slashes). Nothing was sent.`
    );
  }
  return trimmed;
}

/** Build the engine op for one bookmark action. Throws ToolInputError (nothing
 *  sent) for a missing/invalid name or a half-given pose. */
export function buildCameraBookmarkOp(args: CameraBookmarkArgs): Record<string, unknown> {
  const kind = CAMERA_BOOKMARK_OPS[args.action];
  if (!kind) {
    throw new ToolInputError(`Unknown action "${String(args.action)}". Use save, list, or delete.`);
  }
  if (args.action === "list") return { op: kind };
  const name = requireBookmarkName(args.name, args.action);
  if (args.action === "delete") return { op: kind, name };

  const op: Record<string, unknown> = { op: kind, name };
  const position = args.position?.trim();
  const lookAt = args.look_at?.trim();
  if ((position && !lookAt) || (!position && lookAt)) {
    throw new ToolInputError(
      "position and look_at go together: pass both as Godot literals (\"Vector3(x, y, z)\") for an explicit pose, or omit both to capture the CURRENT editor 3D viewport camera. Nothing was sent."
    );
  }
  if (position && lookAt) {
    op.position = position;
    op.look_at = lookAt;
  }
  if (args.fov !== undefined) op.fov = args.fov;
  return op;
}

// ---------------------------------------------------------------------------
// ScenePreview framing (summer_screenshot target:"scene")
// ---------------------------------------------------------------------------

export const PRESET_FRAMINGS = ["auto", "iso", "top", "front", "back", "left", "right", "camera"] as const;
export const FIXED_POSE_FRAMINGS = ["free", "bookmark"] as const;
/** The framing enum both faces expose. "bookmark" pairs with `bookmark_name`
 *  (the wire form is "bookmark:<name>"; the enum stays closed so the
 *  descriptor/zod parity holds and agents see a finite list). */
export const SCREENSHOT_FRAMINGS = [...PRESET_FRAMINGS, ...FIXED_POSE_FRAMINGS] as const;
export type ScreenshotFraming = (typeof SCREENSHOT_FRAMINGS)[number];

export interface ScenePreviewArgs {
  scenePath?: string;
  framing?: ScreenshotFraming;
  bookmark_name?: string;
  size?: [number, number];
  nodePath?: string;
  camera_path?: string;
  camera_position?: string;
  camera_look_at?: string;
  fov?: number;
  marks?: boolean;
  max_marks?: number;
}

/** The api-client scenePreview input, with the framing resolved to its wire
 *  form ("bookmark" + bookmark_name -> "bookmark:<name>"). */
export interface ScenePreviewInput {
  scenePath?: string;
  /** Wire framing: a preset, "free", or "bookmark:<name>". */
  framing?: string;
  size?: [number, number];
  nodePath?: string;
  cameraPath?: string;
  cameraPosition?: string;
  cameraLookAt?: string;
  fov?: number;
  marks?: boolean;
  maxMarks?: number;
}

export const MAX_MARKS_CAP = 128;

/**
 * Resolve screenshot args into the ScenePreview input. Infers framing "free"
 * from a camera pose and "bookmark" from a bookmark_name when `framing` is
 * omitted; refuses (ToolInputError, nothing sent) when they contradict a
 * preset, when "free" lacks half its pose, or when "bookmark" has no name.
 */
export function buildScenePreviewInput(args: ScenePreviewArgs): ScenePreviewInput {
  const position = args.camera_position?.trim();
  const lookAt = args.camera_look_at?.trim();
  const bookmark = args.bookmark_name?.trim();
  let framing: string | undefined = args.framing;

  if (!framing) {
    if (bookmark) framing = "bookmark";
    else if (position || lookAt) framing = "free";
  }

  if (framing === "bookmark") {
    if (!bookmark) {
      throw new ToolInputError(
        'framing:"bookmark" needs bookmark_name — the name you saved with summer_camera_bookmark (list them with action:"list"). Nothing was sent.'
      );
    }
    if (!BOOKMARK_NAME_PATTERN.test(bookmark)) {
      throw new ToolInputError(
        `bookmark_name "${bookmark}" is invalid — bookmark names are 1-64 characters from A-Z a-z 0-9 _ -. Nothing was sent.`
      );
    }
    if (position || lookAt) {
      throw new ToolInputError(
        'framing:"bookmark" takes its pose from the bookmark; drop camera_position/camera_look_at, or use framing:"free" with both. Nothing was sent.'
      );
    }
  } else if (framing === "free") {
    if (!position || !lookAt) {
      throw new ToolInputError(
        'framing:"free" needs BOTH camera_position and camera_look_at as Godot literals ("Vector3(x, y, z)"). Nothing was sent.'
      );
    }
    if (bookmark) {
      throw new ToolInputError(
        'framing:"free" and bookmark_name contradict each other — use framing:"bookmark" with bookmark_name, or framing:"free" with a pose. Nothing was sent.'
      );
    }
  } else if (framing && (position || lookAt || bookmark)) {
    throw new ToolInputError(
      `framing:"${framing}" is a fixed preset; camera_position/camera_look_at need framing:"free" and bookmark_name needs framing:"bookmark". Nothing was sent.`
    );
  }

  if (args.max_marks !== undefined && (!Number.isInteger(args.max_marks) || args.max_marks < 1 || args.max_marks > MAX_MARKS_CAP)) {
    throw new ToolInputError(`max_marks must be an integer from 1 through ${MAX_MARKS_CAP}. Nothing was sent.`);
  }

  const input: ScenePreviewInput = {};
  if (args.scenePath) input.scenePath = args.scenePath;
  if (framing) input.framing = framing === "bookmark" ? `bookmark:${bookmark}` : framing;
  if (args.size) input.size = args.size;
  if (args.nodePath) input.nodePath = args.nodePath;
  if (args.camera_path) input.cameraPath = args.camera_path;
  if (framing === "free") {
    input.cameraPosition = position;
    input.cameraLookAt = lookAt;
  }
  if (args.fov !== undefined && (framing === "free" || framing === "bookmark")) input.fov = args.fov;
  if (args.marks !== undefined) input.marks = args.marks;
  if (args.max_marks !== undefined) input.maxMarks = args.max_marks;
  return input;
}

/** True for the wave-I fixed-pose framings ("free", "bookmark:<name>"). */
export function isFixedPoseFraming(wireFraming: string | undefined): boolean {
  return wireFraming === "free" || (wireFraming?.startsWith("bookmark:") ?? false);
}

// ---------------------------------------------------------------------------
// Result readers (shape-tolerant; the engine payload is the source of truth)
// ---------------------------------------------------------------------------

export interface SceneMark {
  id: number;
  path: string;
  class: string;
  screen_rect?: { x: number; y: number; w: number; h: number };
}

export interface SceneMarksSummary {
  marks: SceneMark[];
  skipped?: number;
  candidates?: number;
  truncated?: boolean;
  maxMarks?: number;
  /** "2d_scene" when the engine could not mark this scene. */
  unsupported?: string;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Read the Set-of-Mark fields off a ScenePreview payload (`metadata` of the
 *  EngineSnapshot). Returns null when the payload carries no marks key at all —
 *  i.e. the engine ignored `marks:true` (an older build). */
export function readSceneMarks(payload: Record<string, unknown> | undefined): SceneMarksSummary | null {
  if (!payload || !("marks" in payload)) return null;
  const raw = Array.isArray(payload.marks) ? payload.marks : [];
  const marks: SceneMark[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const mark = entry as Record<string, unknown>;
    const id = num(mark.id);
    if (id === undefined) continue;
    const rect = mark.screen_rect as Record<string, unknown> | undefined;
    const x = num(rect?.x);
    const y = num(rect?.y);
    const w = num(rect?.w);
    const h = num(rect?.h);
    marks.push({
      id,
      path: typeof mark.path === "string" ? mark.path : "?",
      class: typeof mark.class === "string" ? mark.class : "?",
      ...(x !== undefined && y !== undefined && w !== undefined && h !== undefined
        ? { screen_rect: { x, y, w, h } }
        : {}),
    });
  }
  return {
    marks,
    skipped: num(payload.marks_skipped),
    candidates: num(payload.marks_candidates),
    truncated: payload.marks_truncated === true ? true : undefined,
    maxMarks: num(payload.max_marks),
    unsupported: typeof payload.marks_unsupported === "string" ? payload.marks_unsupported : undefined,
  };
}

export interface CameraPose {
  position?: string;
  look_at?: string;
  fov?: number;
}

/** camera_pose {position, look_at, fov} as the engine echoes it (3dp literals). */
export function readCameraPose(payload: Record<string, unknown> | undefined): CameraPose | null {
  const raw = payload?.camera_pose;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const pose = raw as Record<string, unknown>;
  return {
    position: typeof pose.position === "string" ? pose.position : undefined,
    look_at: typeof pose.look_at === "string" ? pose.look_at : undefined,
    fov: num(pose.fov),
  };
}

/** One compact line per mark so the model can map a numbered label in the
 *  image to a node path: `1 -> Props/Crate_02 (MeshInstance3D) @ 120,80 200x140`. */
export function formatSceneMarks(summary: SceneMarksSummary): string[] {
  const lines: string[] = [];
  if (summary.unsupported) {
    lines.push(
      `marks: unsupported for this scene (${summary.unsupported}) — no overlay was drawn; the image carries no numbered labels.`
    );
    return lines;
  }
  const counts: string[] = [];
  if (summary.candidates !== undefined) counts.push(`${summary.candidates} candidate(s)`);
  if (summary.skipped) counts.push(`${summary.skipped} skipped off-screen/extent-less`);
  if (summary.truncated) counts.push(`truncated at max_marks ${summary.maxMarks ?? "?"}`);
  lines.push(
    `marks: ${summary.marks.length} numbered label(s) drawn${counts.length ? ` (${counts.join(", ")})` : ""}` +
      (summary.marks.length ? " — label -> node path:" : ".")
  );
  for (const mark of summary.marks) {
    const rect = mark.screen_rect
      ? ` @ ${Math.round(mark.screen_rect.x)},${Math.round(mark.screen_rect.y)} ${Math.round(mark.screen_rect.w)}x${Math.round(mark.screen_rect.h)}`
      : "";
    lines.push(`  ${mark.id} -> ${mark.path} (${mark.class})${rect}`);
  }
  return lines;
}
