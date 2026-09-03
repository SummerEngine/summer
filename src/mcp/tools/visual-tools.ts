import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withEngine } from "./with-engine.js";
import type { getClient } from "../server.js";
import type { EngineSnapshot } from "../../core/api-client.js";
import {
  analyzeFrameBase64,
  describeFlatFrame,
  type FrameQuality,
} from "../../core/capabilities/frame-quality.js";
import { classifySceneKindFromTree, type SceneKindResult } from "../../core/capabilities/scene-kind.js";
import { sleep } from "../../core/util/sleep.js";

/**
 * Visual capture tools. Unlike the in-product chat agent (a text-only "brain"
 * that needs a separate vision model to describe frames for it), an MCP client
 * like Claude Code can SEE images directly. So we hand the raw engine frame back
 * as an MCP image content block — no vision-model prepass, no paraphrase. The
 * model reviews the actual pixels.
 *
 * Frame honesty (E2E 2026-09-03, F-01 / F-05):
 *  - Every frame goes through a zero-dependency content check
 *    (core/capabilities/frame-quality.ts). A "viewport" frame that comes back
 *    flat (uniformly black/grey) is recaptured ONCE after a settle delay, and
 *    the caption never presents a blank frame as evidence about the scene.
 *    Root-cause status is written in frame-quality.ts: the engine reads the
 *    editor SubViewport texture as-is (no forced draw, no blank retry), which
 *    is consistent with — but not proven to be — a not-yet-redrawn 2D
 *    subviewport right after the editor switched tabs.
 *  - The "scene" target's no-camera confession is phrased for the scene's
 *    kind: a 3D scene without a Camera3D plays grey/black; a 2D scene without a
 *    Camera2D simply plays from the origin and is NOT an error. The engine
 *    receipt reports scene_has_camera for both kinds without saying which, so
 *    the kind comes from a scene-tree read (core/capabilities/scene-kind.ts).
 */

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

/** EngineSnapshot plus the toolkit-side honesty fields the caption reads. */
export type CaptureResult = EngineSnapshot & {
  frameQuality?: FrameQuality;
  recapture?: RecaptureInfo;
  sceneKind?: SceneKindResult;
};

type CaptureClient = Awaited<ReturnType<typeof getClient>>;
type ScenePreviewInput = NonNullable<Parameters<CaptureClient["scenePreview"]>[0]>;

function analyzed(snap: EngineSnapshot): CaptureResult {
  if (!snap.ok || !snap.base64) return snap;
  return { ...snap, frameQuality: analyzeFrameBase64(snap.base64, snap.mime) };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Viewport capture with ONE automatic recapture when the first frame is flat.
 * Exported for tests.
 */
export async function captureViewport(client: CaptureClient): Promise<CaptureResult> {
  const first = analyzed(await client.viewportSnapshot());
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
  return { ...analyzed(second), recapture };
}

/**
 * Offscreen scene render; when the engine confesses the scene has no camera of
 * its own, read the tree to learn whether that is a 3D or a 2D scene.
 * Exported for tests.
 */
export async function captureScene(client: CaptureClient, input: ScenePreviewInput): Promise<CaptureResult> {
  const snap = analyzed(await client.scenePreview(input));
  if (!snap.ok || !snap.base64 || snap.sceneHasCamera !== false) return snap;
  return { ...snap, sceneKind: await readSceneKind(client, input.scenePath) };
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

function viewportLabel(snap: CaptureResult): string {
  const meta = snap.metadata as Record<string, unknown> | undefined;
  const surface = typeof meta?.source_surface === "string" ? meta.source_surface : "";
  if (surface === "editor_2d_subviewport_texture") return "Editor viewport (2D tab)";
  if (surface === "editor_3d_subviewport_texture") return "Editor viewport (3D tab)";
  return "Editor viewport";
}

const BLANK_VIEWPORT_ADVICE =
  "The engine reads the editor viewport texture as-is; right after a tab switch or a scene mutation it may not have been redrawn yet. This frame is NOT evidence about lights, cameras, materials, or scene content — do not fix anything based on it. Wait a moment and call summer_screenshot again (switching the editor tab or nudging the view forces a redraw), verify structure with summer_get_scene_tree / summer_inspect_node, or render the saved scene with target:\"scene\".";

export function registerVisualTools(server: McpServer): void {
  server.tool(
    "summer_screenshot",
    `Capture a frame from Summer Engine and return it as an image you can look at directly.

Use this to visually verify your work: scene layout, asset placement, scale, framing, missing/untextured assets, or runtime gameplay state. You see the actual pixels — no description layer in between. Lighting and materials are only truthfully shown by the "viewport" and "game" targets — see the note on "scene" below.

target:
  "viewport" (default) — the editor's CURRENT view (whatever scene/tab is open). No game boot. Use for edit-time checks of how the scene looks right now.
  "scene" — an OFFSCREEN render of a scene file (no game boot; scripts do not run, physics/particles/animations are static at t=0, so runtime-hidden UI shows as saved). Optionally pass scenePath/framing/size/nodePath. Use for COMPOSITION, SCALE and FRAMING without touching the editor's open tab.
    With the preset framings (iso/top/...), it does NOT use the scene's environment/sky, and it injects a synthetic camera and light when the scene has none. The scene's WorldEnvironment — sky, fog, tonemap, glow, SSAO, ambient — is replaced by a flat preview environment. So those framings CANNOT verify lighting, mood, or any material property that depends on the environment: change them and the frame comes back identical.
    framing:"camera" is the exception and the trustworthy way to check lighting edit-time: it renders through the scene's OWN current/first Camera3D (or the one named by camera_path) with the scene's REAL WorldEnvironment — sky, fog, tonemap, glow, ambient all live. Use it before/after any lighting, environment, or emissive-material change, and to see the scene the way the played game will actually frame it.
  "game" — a frame from the RUNNING game (real runtime state). Start the game first (summer_play). Works over the plain local connection on current Summer Engine builds (verified on 0.5.65, about 1.4 s); if a build refuses with bridge_required the result says so and names the alternatives.

BLANK FRAMES ARE A CAPTURE CONDITION, NOT A SCENE FACT. A uniformly black/grey "viewport" frame means the editor had not redrawn its viewport texture when it was read (typically right after a tab switch or a scene mutation) — not that the scene is dark or has no camera. Every frame is content-checked; a flat viewport frame is recaptured once automatically and the caption says what happened. Never conclude anything about lights, cameras, or content from a blank frame: recapture first.

Static frame only — one moment, not motion. For a SEQUENCE of frames over time, or for anything lighting-dependent on an engine build without framing:"camera", use a RunVerification probe's save_frame(name) — its instance has a real renderer.`,
    {
      target: z
        .enum(["viewport", "scene", "game"])
        .optional()
        .default("viewport")
        .describe(
          '"viewport" = editor current view (default), "scene" = offscreen render of a scene file, "game" = running game frame'
        ),
      scenePath: z
        .string()
        .optional()
        .describe(
          'target:"scene" only. Full scene path, e.g. "res://main.tscn". Omit to render the currently-open scene.'
        ),
      framing: z
        .enum(["auto", "iso", "top", "front", "back", "left", "right", "camera"])
        .optional()
        .describe(
          'target:"scene" only, 3D scenes. Camera direction preset: "iso" = 3/4 diagonal view, ' +
            '"top" = straight down, "front" = camera at +Z, "back" = camera at -Z, ' +
            '"left" = camera at -X, "right" = camera at +X. "auto" (default) is an alias of "iso". ' +
            '"camera" = render through the scene\'s OWN Camera3D with its REAL WorldEnvironment — ' +
            "the only edit-time framing that truthfully shows lighting/mood. " +
            "The result reports the resolved framing."
        ),
      size: z
        .array(z.number().int().positive())
        .length(2)
        .optional()
        .describe('target:"scene" only. Output image [width, height] in pixels.'),
      nodePath: z
        .string()
        .optional()
        .describe(
          'target:"scene" only. Node path relative to the scene root (e.g. "Player/Mesh") to frame ' +
            "INSTEAD of the whole scene — the camera fits that node's combined bounds (3D visual AABBs " +
            "or 2D rects, children included). A bare unique name is also found recursively. " +
            'Fails with failure_reason "node_not_found" when the path does not resolve (no silent whole-scene fallback).'
        ),
      camera_path: z
        .string()
        .optional()
        .describe(
          'framing:"camera" only. Path of the Camera3D to render through (relative to the scene root) when ' +
            "the scene has several cameras or none marked current. Omit to use the scene's current/first Camera3D."
        ),
    },
    async ({ target, scenePath, framing, size, nodePath, camera_path }) =>
      withEngine(
        async (client): Promise<CaptureResult> => {
          if (target === "game") return analyzed(await client.gameSnapshot());
          if (target === "scene")
            return captureScene(client, {
              scenePath,
              framing,
              size: size as [number, number] | undefined,
              nodePath,
              cameraPath: camera_path,
            });
          return captureViewport(client);
        },
        {
          // Game capture used to be structurally blocked over local HTTP (409
          // bridge_required); 0.5.65 answers it over the plain local connection.
          // Keep the honest failure for builds that still refuse — fail loud
          // (isError) so the model does not proceed as if it saw the game.
          onResult: (snap: CaptureResult) => {
            if (target === "game" && snap.failureReason === "bridge_required") {
              return {
                content: [
                  {
                    type: "text",
                    text:
                      "Game capture is not available over this connection on this Summer Engine build (it requires the desktop app bridge). " +
                      "Use target:'viewport' for the editor view, target:'scene' for an offscreen scene render, " +
                      "a RunVerification probe's save_frame for a rendered runtime frame, or ask the user to describe / screenshot the running game.\n\n" +
                      `Engine reason: ${snap.error ?? "unsupported_transport"}`,
                  },
                ],
                isError: true,
              };
            }
            return null;
          },
          toContent: (snap: CaptureResult) => {
            // withEngine only calls toContent on success (ok:true, error cleared
            // by extractOpError). Missing image bytes on a "success" is still
            // possible defensively, so fall back to text rather than emit a
            // broken image block.
            if (!snap.base64) {
              return [
                {
                  type: "text",
                  text:
                    snap.error ||
                    "Snapshot succeeded but returned no image data. Try again, or use summer_get_scene_tree to inspect structurally.",
                },
              ];
            }
            const dims =
              snap.width && snap.height ? `${snap.width}x${snap.height}` : "unknown size";
            const label =
              target === "game"
                ? "Running game frame"
                : target === "scene"
                  ? "Scene preview (offscreen render of the saved scene; scripts not run, physics/animations static)"
                  : viewportLabel(snap);

            const warnings: string[] = [];
            const notes: string[] = [];
            // Project-drift warning (item 4): the engine may have switched
            // projects since this session bound — this frame could be from the
            // WRONG project.
            if (snap.projectMismatch) {
              warnings.push(
                "WARNING: the engine is now on a DIFFERENT project than this session is bound to — this frame may be from the wrong project. Call summer_get_project_context to rebind before trusting it."
              );
            }

            // Frame content check (F-01). Wording is per target because a flat
            // frame means different things: viewport = texture not redrawn;
            // game = booting / loading / fade; scene = nothing visible in the
            // framing or a blank readback the engine's own retries did not fix.
            const quality = snap.frameQuality;
            const recapture = snap.recapture;
            let frameCheck = "";
            if (quality?.analyzable && quality.flat) {
              const flat = describeFlatFrame(quality);
              if (target === "viewport") {
                warnings.push(
                  recapture
                    ? `WARNING: this frame is ${flat}, and so was the automatic recapture ${recapture.delayMs} ms later${
                        recapture.error ? ` (the recapture failed: ${recapture.error}; this is the first frame)` : ""
                      }. ${BLANK_VIEWPORT_ADVICE}`
                    : `WARNING: this frame is ${flat}. ${BLANK_VIEWPORT_ADVICE}`
                );
              } else if (target === "game") {
                warnings.push(
                  `WARNING: this game frame is ${flat}. A game that has just booted, is loading, or is mid-fade legitimately shows this; it is NOT by itself evidence of a missing camera or light. Wait a moment and capture again before concluding anything.`
                );
              } else {
                warnings.push(
                  `WARNING: this preview is ${flat} (engine render retries: ${snap.renderRetries ?? 0}). Either nothing is visible in this framing or the readback was blank; verify with summer_get_scene_tree and, for 3D scenes, framing:"camera" before concluding anything.`
                );
              }
            } else if (quality?.analyzable) {
              frameCheck = ` Frame check: not blank (luma spread ${quality.lumaSpread}).`;
              if (recapture) {
                notes.push(
                  `NOTE: the first capture came back ${describeFlatFrame(recapture.firstFrame)} — the viewport texture had not been redrawn yet (this happens right after a tab switch or a scene mutation). This image is the automatic recapture taken ${recapture.delayMs} ms later.`
                );
              }
            } else if (quality && target !== "scene") {
              notes.push(
                `NOTE: frame content check unavailable (${quality.reason ?? "unknown reason"}). If the image is uniformly black or grey, the viewport had not redrawn when it was read — recapture before concluding anything about lights, cameras, or content.`
              );
            }

            // Scene-preview confession fields (P4.3 + F-05).
            if (target === "scene") {
              if (snap.sceneHasCamera === false) {
                const kind = snap.sceneKind?.kind ?? "unknown";
                if (kind === "3d") {
                  warnings.push(
                    "WARNING: this 3D scene has no Camera3D — it will render grey/black when played."
                  );
                } else if (kind === "2d" || kind === "none") {
                  notes.push(
                    "NOTE: this 2D scene has no Camera2D. That is normal for many 2D scenes and not an error: when played, the game shows the canvas from the viewport origin at the project's window size, not this fitted preview framing."
                  );
                } else {
                  const reason = snap.sceneKind?.reason ? ` (${snap.sceneKind.reason})` : "";
                  warnings.push(
                    `WARNING: this scene has no camera of its own (the preview camera was synthesized) and the scene tree could not be read to tell 2D from 3D${reason}. If it is a 3D scene it will render grey/black when played; a 2D scene simply plays from the viewport origin.`
                  );
                }
              }
              // The engine reports scene_had_light:false for 3D scenes only
              // (2D scenes get true = not applicable), so this stays unconditional.
              if (snap.sceneHadLight === false) {
                warnings.push(
                  "WARNING: this scene has no light — lit materials may appear black when played."
                );
              }
              // The engine ALWAYS synthesizes the preview camera (preview_ops.cpp
              // sets used_synthetic_camera unconditionally) — the flag says nothing
              // about the scene's own cameras. sceneHasCamera above is the
              // authoritative "does this scene have a camera" answer.
              if (snap.usedSyntheticCamera) {
                notes.push(
                  "NOTE: this preview is framed by a synthetic render camera, NOT the scene's own camera — the played game will not frame like this image."
                );
              }
              notes.push(
                'NOTE: this is the SAVED scene rendered with scripts not running: nodes a script hides, moves, or spawns at runtime (e.g. a PauseMenu CanvasLayer hidden in _ready) appear here exactly as saved. Judge runtime visibility with target:"game" or a RunVerification save_frame, not this image.'
              );
              // Old engines that predate framing:"camera" resolve unknown
              // framings to a preset and echo the result. Confess it rather
              // than let a flat-environment frame pass as a lighting check.
              if (framing === "camera" && snap.framing && snap.framing !== "camera") {
                warnings.push(
                  `WARNING: you asked for framing:"camera" but this Summer Engine build resolved it to "${snap.framing}" — it predates camera framing. This frame uses the synthetic preview camera and FLAT environment, so it does NOT verify lighting/mood. Update Summer Engine, or verify lighting by booting the game / a RunVerification probe.`
                );
              }
            }

            // Scene-preview capture details: resolved framing ("auto" -> "iso"),
            // which node was framed (confirms nodePath resolved), and how many
            // blank-readback retries the engine needed (0 = omitted).
            const details: string[] = [];
            if (target === "scene") {
              if (snap.framing) details.push(`framing: ${snap.framing}`);
              if (snap.framedNode) details.push(`framed node: ${snap.framedNode}`);
              if (snap.renderRetries) details.push(`render retries: ${snap.renderRetries}`);
              // Camera-framing provenance (contracts Wave B): which camera the
              // engine rendered through and which environment was live.
              const meta = snap.metadata as Record<string, unknown> | undefined;
              if (typeof meta?.camera_path === "string" && meta.camera_path) {
                details.push(`scene camera: ${meta.camera_path}`);
              }
              if (typeof meta?.environment_used === "string" && meta.environment_used) {
                details.push(`environment: ${meta.environment_used}`);
              }
            }
            const detailNote = details.length ? `; ${details.join(", ")}` : "";

            const trailer = [...warnings, ...notes];
            const caption =
              `${label} (${dims}${detailNote}). Saved to ${snap.localPath ?? "n/a"}.${frameCheck} Describe only what is visibly in the image above.` +
              (trailer.length ? `\n\n${trailer.join("\n")}` : "");

            return [
              { type: "image", data: snap.base64, mimeType: snap.mime || "image/jpeg" },
              { type: "text", text: caption },
            ];
          },
        }
      )
  );
}
