/**
 * capture — frame capture with the toolkit-side honesty checks, ONE copy for
 * both faces (src/mcp/tools/visual-tools.ts renders the MCP caption from it;
 * src/core/capabilities/tool-dispatch.ts returns the receipt as JSON).
 *
 * Frame honesty (E2E 2026-09-03, F-01 / F-05):
 *  - Every frame goes through a zero-dependency content check
 *    (./frame-quality.ts). A "viewport" frame that comes back flat (uniformly
 *    black/grey) is recaptured ONCE after a settle delay; the result says which
 *    frame it is and what the first one looked like, so no face can present a
 *    blank frame as evidence about the scene. Root-cause status is written in
 *    frame-quality.ts: the engine reads the editor SubViewport texture as-is
 *    (no forced draw, no blank retry), consistent with — but not proven to be —
 *    a not-yet-redrawn 2D subviewport right after the editor switched tabs.
 *  - The "scene" target's no-camera confession is phrased for the scene's
 *    kind: a 3D scene without a Camera3D plays grey/black; a 2D scene without
 *    a Camera2D simply plays from the origin and is NOT an error. The engine
 *    receipt reports scene_has_camera for both kinds without saying which, so
 *    the kind comes from a scene-tree read (./scene-kind.ts).
 */
import type { EngineSnapshot } from "../api-client.js";
import { analyzeFrameBase64, type FrameQuality } from "./frame-quality.js";
import { classifySceneKindFromTree, type SceneKindResult } from "./scene-kind.js";
import { sleep } from "../util/sleep.js";
import type { ScenePreviewInput } from "./camera-view.js";

/** Settle delay before the single automatic viewport recapture. */
export const VIEWPORT_RECAPTURE_DELAY_MS = 700;
/** Bounds for the scene-kind tree read (the engine honours depth/limit only on
 *  scene-targeted reads; an untargeted read is the depth-2 snapshot). */
const SCENE_KIND_TREE_DEPTH = 8;
const SCENE_KIND_TREE_LIMIT = 600;

export interface RecaptureInfo {
  delayMs: number;
  /** Analysis of the flat frame that triggered the recapture. */
  firstFrame: FrameQuality;
  /** Set when the second capture itself failed — the FIRST frame is returned. */
  error?: string;
}

/** EngineSnapshot plus the toolkit-side honesty fields both faces read. */
export type CaptureResult = EngineSnapshot & {
  frameQuality?: FrameQuality;
  recapture?: RecaptureInfo;
  sceneKind?: SceneKindResult;
};

/** The ScenePreview input in its wire form (framing resolved to a preset,
 *  "free", or "bookmark:<name>"; camera pose / marks fields) is owned by
 *  ./camera-view.ts, where both faces build it from their arguments. */
export type { ScenePreviewInput } from "./camera-view.js";

/** The engine reads capture needs — a structural subset of EngineApiClient. */
export interface CaptureClient {
  viewportSnapshot(): Promise<EngineSnapshot>;
  scenePreview(input?: ScenePreviewInput): Promise<EngineSnapshot>;
  gameSnapshot(): Promise<EngineSnapshot>;
  getSceneState(scenePath?: string, options?: { depth?: number; limit?: number }): Promise<unknown>;
}

/** Stamp the content check onto a successful frame. */
export function analyzedSnapshot(snap: EngineSnapshot): CaptureResult {
  if (!snap.ok || !snap.base64) return snap;
  return { ...snap, frameQuality: analyzeFrameBase64(snap.base64, snap.mime) };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Viewport capture with ONE automatic recapture when the first frame is flat. */
export async function captureViewport(client: CaptureClient): Promise<CaptureResult> {
  const first = analyzedSnapshot(await client.viewportSnapshot());
  const quality = first.frameQuality;
  if (!quality?.analyzable || !quality.flat) return first;

  await sleep(VIEWPORT_RECAPTURE_DELAY_MS);
  const recapture: RecaptureInfo = { delayMs: VIEWPORT_RECAPTURE_DELAY_MS, firstFrame: quality };
  let second: EngineSnapshot;
  try {
    second = await client.viewportSnapshot();
  } catch (err) {
    return { ...first, recapture: { ...recapture, error: errorMessage(err) } };
  }
  if (!second.ok || !second.base64) {
    return {
      ...first,
      recapture: { ...recapture, error: second.error ?? "recapture returned no image data" },
    };
  }
  return { ...analyzedSnapshot(second), recapture };
}

/** Offscreen scene render; when the engine confesses the scene has no camera
 *  of its own, read the tree to learn whether that is a 3D or a 2D scene. */
export async function captureScene(client: CaptureClient, input: ScenePreviewInput): Promise<CaptureResult> {
  const snap = analyzedSnapshot(await client.scenePreview(input));
  if (!snap.ok || !snap.base64 || snap.sceneHasCamera !== false) return snap;
  return { ...snap, sceneKind: await readSceneKind(client, input.scenePath) };
}

/** Running-game frame with the content check (no recapture: a booting or
 *  fading game legitimately shows a flat frame). */
export async function captureGame(client: CaptureClient): Promise<CaptureResult> {
  return analyzedSnapshot(await client.gameSnapshot());
}

async function readSceneKind(client: CaptureClient, scenePath?: string): Promise<SceneKindResult> {
  try {
    const trimmed = scenePath?.trim();
    const targeted = trimmed && trimmed !== "." && trimmed !== "./" ? trimmed : undefined;
    const state = targeted
      ? await client.getSceneState(targeted, { depth: SCENE_KIND_TREE_DEPTH, limit: SCENE_KIND_TREE_LIMIT })
      : await client.getSceneState();
    return classifySceneKindFromTree(state);
  } catch (err) {
    return { kind: "unknown", reason: errorMessage(err) };
  }
}
