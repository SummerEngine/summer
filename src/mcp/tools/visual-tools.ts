import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withEngine, missingEngineOpResult, withOldEngineHint } from "./with-engine.js";
import { withFailureReasonHint } from "./perception-tools.js";
import {
  analyzedSnapshot,
  captureGame,
  captureScene,
  captureViewport,
  VIEWPORT_RECAPTURE_DELAY_MS,
  type CaptureResult,
  type RecaptureInfo,
} from "../../core/capabilities/capture.js";
import { describeFlatFrame } from "../../core/capabilities/frame-quality.js";
import {
  CAMERA_BOOKMARK_ACTIONS,
  CAMERA_BOOKMARK_FALLBACK,
  SCREENSHOT_FRAMINGS,
  MAX_MARKS_CAP,
  buildCameraBookmarkOp,
  buildScenePreviewInput,
  formatSceneMarks,
  isFixedPoseFraming,
  readCameraPose,
  readSceneMarks,
  type ScenePreviewInput,
} from "../../core/capabilities/camera-view.js";

// The capture path (content check, single viewport recapture, scene-kind read
// for the no-camera confession) is ONE copy in core/capabilities/capture.ts,
// shared with the CLI face; re-exported so tests and callers keep this door.
export { analyzedSnapshot, captureScene, captureViewport, VIEWPORT_RECAPTURE_DELAY_MS, type CaptureResult, type RecaptureInfo };

/**
 * Visual capture tools. Unlike the in-product chat agent (a text-only "brain"
 * that needs a separate vision model to describe frames for it), an MCP client
 * like Claude Code can SEE images directly. So we hand the raw engine frame back
 * as an MCP image content block — no vision-model prepass, no paraphrase. The
 * model reviews the actual pixels.
 *
 * Frame honesty (E2E 2026-09-03, F-01 / F-05) is decided in
 * core/capabilities/capture.ts (frame content check + one automatic viewport
 * recapture; scene kind for the no-camera confession). This module only
 * renders the caption from those fields; the CLI face prints them as JSON.
 *
 * Wave I perception adds stable viewpoints: camera bookmarks
 * (summer_camera_bookmark, persisted in the project) and the fixed-pose
 * framings "free" / "bookmark" plus the Set-of-Mark overlay on
 * summer_screenshot target:"scene". Older engines resolve the new framings to
 * a preset and echo it — the caption confesses that instead of letting a
 * preset render pass as a pose-stable comparison.
 */

function viewportLabel(snap: CaptureResult): string {
  const meta = snap.metadata as Record<string, unknown> | undefined;
  const surface = typeof meta?.source_surface === "string" ? meta.source_surface : "";
  if (surface === "editor_2d_subviewport_texture") return "Editor viewport (2D tab)";
  if (surface === "editor_3d_subviewport_texture") return "Editor viewport (3D tab)";
  return "Editor viewport";
}

const BLANK_VIEWPORT_ADVICE =
  "The engine reads the editor viewport texture as-is; right after a tab switch or a scene mutation it may not have been redrawn yet. This frame is NOT evidence about lights, cameras, materials, or scene content — do not fix anything based on it. Wait a moment and call summer_screenshot again (switching the editor tab or nudging the view forces a redraw), verify structure with summer_get_scene_tree / summer_inspect_node, or render the saved scene with target:\"scene\".";

/** The first per-op result inside an envelope (or the envelope itself). */
function firstOpResult(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") return {};
  const envelope = result as Record<string, unknown> & { results?: unknown[] };
  const first = Array.isArray(envelope.results) ? envelope.results[0] : undefined;
  return first && typeof first === "object" ? (first as Record<string, unknown>) : envelope;
}

/** Teach the engine's bookmark failure_reasons; `available` names ride along
 *  on not_found so the model can pick a real one without a second call. */
function teachBookmarkFailure(result: unknown): unknown {
  const failed = firstOpResult(result);
  const available = Array.isArray(failed.available)
    ? failed.available.filter((n): n is string => typeof n === "string")
    : [];
  const availableText = available.length
    ? ` Saved bookmarks: ${available.join(", ")}.`
    : " No bookmarks are saved yet — save one with action:\"save\".";
  return withFailureReasonHint(result, {
    not_found: `No bookmark by that name.${availableText}`,
    no_editor_camera:
      "No pose was given and the editor has no 3D viewport camera to capture (2D scene, or the 3D editor is not open). Pass position and look_at explicitly (\"Vector3(x, y, z)\" literals), or open the 3D viewport on the scene first.",
    bad_args:
      "Check the arguments: name is 1-64 of A-Z a-z 0-9 _ -; position and look_at are \"Vector3(x, y, z)\" literals given together and must differ; fov is 1..179.",
    io_failed:
      "res://.summer/camera_bookmarks.json could not be read or written (or exists but is not a JSON object — it was NOT overwritten). Inspect it with summer_read_file path:\"res://.summer/camera_bookmarks.json\".",
  });
}

/** Success prose for the bookmark tool: what happened and how to reuse it. */
function describeBookmarkResult(action: string, result: unknown): string {
  const data = firstOpResult(result);
  if (action === "save") {
    const name = typeof data.name === "string" ? data.name : "?";
    const source = typeof data.pose_source === "string" ? data.pose_source : "unknown";
    const overwritten = data.overwritten === true ? " (replaced an existing bookmark of the same name)" : "";
    return (
      `Saved camera bookmark "${name}" from ${source === "editor_viewport" ? "the current editor 3D viewport camera" : "the explicit pose"}${overwritten}. ` +
      `Reuse it for a pose-stable frame: summer_screenshot target:"scene" framing:"bookmark" bookmark_name:"${name}" — every capture from it lines up with the last, so before/after comparisons are real.`
    );
  }
  if (action === "delete") {
    const name = typeof data.name === "string" ? data.name : "?";
    const remaining = Array.isArray(data.remaining) ? data.remaining.filter((n): n is string => typeof n === "string") : null;
    return `Deleted camera bookmark "${name}".${remaining ? (remaining.length ? ` Remaining: ${remaining.join(", ")}.` : " No bookmarks remain.") : ""}`;
  }
  const names = Array.isArray(data.names) ? data.names.filter((n): n is string => typeof n === "string") : [];
  if (!names.length) {
    return 'No camera bookmarks saved in this project. Save one with action:"save" (omit position/look_at to capture the current editor viewport camera).';
  }
  return `${names.length} camera bookmark(s): ${names.join(", ")}. Use one with summer_screenshot target:"scene" framing:"bookmark" bookmark_name:"<name>".`;
}

/** Amend ScenePreview failures specific to the fixed-pose framings. The
 *  structured failureReason stays; only the error text is taught. */
function teachPreviewFailure(snap: CaptureResult): CaptureResult {
  const hints: Record<string, string> = {
    unknown_bookmark:
      'That bookmark does not exist in this project. List the saved names with summer_camera_bookmark action:"list", or save one with action:"save".',
    bad_camera_pose:
      'framing:"free" / "bookmark" needs a valid 3D pose: camera_position and camera_look_at as "Vector3(x, y, z)" literals that differ, fov 1..179, and a 3D scene (2D scenes have nowhere to place a Camera3D — use the default framing).',
    node_focus_unsupported:
      "A fixed camera pose cannot be re-aimed at a node. Drop nodePath, or use a directional framing (iso/top/...) with nodePath.",
  };
  const reason = snap.failureReason;
  if (!snap.ok && reason && reason in hints) {
    return { ...snap, error: `${hints[reason]} Engine said: ${snap.error ?? reason}` };
  }
  return snap;
}

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
    STABLE VIEWPOINTS (newer engines): framing:"bookmark" + bookmark_name renders from a pose saved with summer_camera_bookmark, and framing:"free" from an explicit camera_position / camera_look_at (+ fov). Both are fixed synthetic poses rendered with the scene's REAL WorldEnvironment, and the same pose every time — the way to take before/after frames that actually line up. marks:true draws a Set-of-Mark overlay (numbered tags + boxes over the largest visible 3D nodes, up to max_marks) and the caption lists label -> node path, so you can say "label 3 (Props/Crate_02) is floating" instead of guessing. The scene file is never touched. 2D scenes render normally with marks_unsupported. Older engines resolve the new framings to a preset and ignore marks — the caption says so; a frame from such a build is NOT pose-stable.
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
        .enum(SCREENSHOT_FRAMINGS)
        .optional()
        .describe(
          'target:"scene" only, 3D scenes. Camera direction preset: "iso" = 3/4 diagonal view, ' +
            '"top" = straight down, "front" = camera at +Z, "back" = camera at -Z, ' +
            '"left" = camera at -X, "right" = camera at +X. "auto" (default) is an alias of "iso". ' +
            '"camera" = render through the scene\'s OWN Camera3D with its REAL WorldEnvironment — ' +
            "the only edit-time framing that truthfully shows lighting/mood. " +
            '"bookmark" (+ bookmark_name) = the fixed pose saved with summer_camera_bookmark; "free" (+ camera_position, camera_look_at, fov) = an explicit fixed pose. ' +
            "Both keep the REAL WorldEnvironment and repeat exactly, so before/after frames line up. " +
            "The result reports the resolved framing — an older engine echoes a preset instead, and the caption warns."
        ),
      bookmark_name: z
        .string()
        .optional()
        .describe(
          'framing:"bookmark" only (implies it when framing is omitted). Name of a bookmark saved with summer_camera_bookmark (list them with action:"list"). Fails with failure_reason "unknown_bookmark" (+ the available names) when it does not exist.'
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
            'Fails with failure_reason "node_not_found" when the path does not resolve (no silent whole-scene fallback). ' +
            'Cannot combine with a fixed pose (framing "camera"/"free"/"bookmark").'
        ),
      camera_path: z
        .string()
        .optional()
        .describe(
          'framing:"camera" only. Path of the Camera3D to render through (relative to the scene root) when ' +
            "the scene has several cameras or none marked current. Omit to use the scene's current/first Camera3D."
        ),
      camera_position: z
        .string()
        .optional()
        .describe(
          'framing:"free" only (implies it when framing is omitted). Camera position as a Godot literal, e.g. "Vector3(0, 5, 12)". Goes together with camera_look_at.'
        ),
      camera_look_at: z
        .string()
        .optional()
        .describe(
          'framing:"free" only. Point the camera looks at, e.g. "Vector3(0, 1, 0)". Must differ from camera_position.'
        ),
      fov: z
        .number()
        .optional()
        .describe(
          'framing:"free" / "bookmark" only. Vertical field of view in degrees (1..179; default 60 for "free", the bookmark\'s own for "bookmark").'
        ),
      marks: z
        .boolean()
        .optional()
        .describe(
          'target:"scene" only, 3D scenes. Draw a Set-of-Mark overlay: numbered tags + box outlines over the largest visible VisualInstance3D nodes (lights excluded), ranked by projected screen area. The caption lists label -> node path (scene-root-relative) so you can name what you see. Works with every framing. 2D scenes return marks_unsupported. Default false.'
        ),
      max_marks: z
        .number()
        .int()
        .min(1)
        .max(MAX_MARKS_CAP)
        .optional()
        .describe(`marks:true only. Cap on numbered labels (engine default 32, at most ${MAX_MARKS_CAP}). The caption says when the cap truncated the list.`),
    },
    async ({
      target,
      scenePath,
      framing,
      bookmark_name,
      size,
      nodePath,
      camera_path,
      camera_position,
      camera_look_at,
      fov,
      marks,
      max_marks,
    }) => {
      // Resolved inside the engine closure so a contradictory framing is a
      // classified invalid_input (nothing sent), never a transport failure.
      let preview: ScenePreviewInput | undefined;
      return withEngine(
        async (client): Promise<CaptureResult> => {
          if (target === "game") return captureGame(client);
          if (target === "scene") {
            preview = buildScenePreviewInput({
              scenePath,
              framing,
              bookmark_name,
              size: size as [number, number] | undefined,
              nodePath,
              camera_path,
              camera_position,
              camera_look_at,
              fov,
              marks,
              max_marks,
            });
            return teachPreviewFailure(await captureScene(client, preview));
          }
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
            const meta = snap.metadata as Record<string, unknown> | undefined;
            const requestedFraming = preview?.framing;

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
              if (requestedFraming === "camera" && snap.framing && snap.framing !== "camera") {
                warnings.push(
                  `WARNING: you asked for framing:"camera" but this Summer Engine build resolved it to "${snap.framing}" — it predates camera framing. This frame uses the synthetic preview camera and FLAT environment, so it does NOT verify lighting/mood. Update Summer Engine, or verify lighting by booting the game / a RunVerification probe.`
                );
              }
              // Same confession for the wave I fixed poses: an older engine
              // echoes the preset it fell back to, so the frame is NOT the
              // requested viewpoint and cannot anchor a before/after comparison.
              if (isFixedPoseFraming(requestedFraming) && snap.framing && snap.framing !== requestedFraming) {
                warnings.push(
                  `WARNING: you asked for framing:"${requestedFraming}" but this Summer Engine build resolved it to "${snap.framing}" — it predates the free/bookmark framings (engine PR #156 follow-up). This is the "${snap.framing}" preset render from a synthetic camera with a FLAT environment, NOT your viewpoint, so it is not pose-stable and cannot anchor a before/after comparison. Update Summer Engine, or place a Camera3D at the pose and use framing:"camera".`
                );
              }
              // marks:true on an engine without Set-of-Mark: no marks key at all.
              if (preview?.marks && readSceneMarks(meta) === null) {
                warnings.push(
                  "WARNING: you asked for marks:true but this Summer Engine build ignored it (no Set-of-Mark overlay exists — it predates the wave I perception ops). There are NO numbered labels in this image; do not read any into it. Update Summer Engine to get label -> node path mapping."
                );
              }
            }

            // Scene-preview capture details: resolved framing ("auto" -> "iso"),
            // which node was framed (confirms nodePath resolved), and how many
            // blank-readback retries the engine needed (0 = omitted).
            const details: string[] = [];
            let marksBlock: string[] = [];
            if (target === "scene") {
              if (snap.framing) details.push(`framing: ${snap.framing}`);
              if (snap.framedNode) details.push(`framed node: ${snap.framedNode}`);
              if (snap.renderRetries) details.push(`render retries: ${snap.renderRetries}`);
              // Camera-framing provenance (contracts Wave B): which camera the
              // engine rendered through and which environment was live.
              if (typeof meta?.camera_path === "string" && meta.camera_path) {
                details.push(`scene camera: ${meta.camera_path}`);
              }
              if (typeof meta?.environment_used === "string" && meta.environment_used) {
                details.push(`environment: ${meta.environment_used}`);
              }
              // Wave I fixed-pose provenance: where the pose came from and the
              // exact pose rendered (3dp literals) — quote it when comparing.
              if (typeof meta?.framing_source === "string" && meta.framing_source) {
                details.push(
                  `framing source: ${meta.framing_source}${typeof meta.bookmark === "string" && meta.bookmark ? ` "${meta.bookmark}"` : ""}`
                );
              }
              const pose = readCameraPose(meta);
              if (pose) {
                const parts: string[] = [];
                if (pose.position) parts.push(`position ${pose.position}`);
                if (pose.look_at) parts.push(`look_at ${pose.look_at}`);
                if (pose.fov !== undefined) parts.push(`fov ${pose.fov}`);
                if (parts.length) details.push(`camera pose: ${parts.join(", ")}`);
              }
              const marksSummary = readSceneMarks(meta);
              if (marksSummary) marksBlock = formatSceneMarks(marksSummary);
            }
            const detailNote = details.length ? `; ${details.join(", ")}` : "";

            const trailer = [...warnings, ...notes];
            const caption =
              `${label} (${dims}${detailNote}). Saved to ${snap.localPath ?? "n/a"}.${frameCheck} Describe only what is visibly in the image above.` +
              (marksBlock.length ? `\n\n${marksBlock.join("\n")}` : "") +
              (trailer.length ? `\n\n${trailer.join("\n")}` : "");

            return [
              { type: "image", data: snap.base64, mimeType: snap.mime || "image/jpeg" },
              { type: "text", text: caption },
            ];
          },
        }
      );
    }
  );

  server.tool(
    "summer_camera_bookmark",
    `Save, list, or delete named camera viewpoints for the edited 3D scene. A bookmark is a fixed pose (position, look_at, fov) stored IN THE PROJECT at res://.summer/camera_bookmarks.json, so it survives sessions and machines — the scene file is never touched.

WHY: screenshots taken from a preset framing re-fit the scene bounds every time, so a before/after pair shifts whenever anything moves; a bookmark is the same pose every time, which makes before/after comparison real. Save once, then reuse on every capture: summer_screenshot target:"scene" framing:"bookmark" bookmark_name:"<name>" (add marks:true for numbered labels mapped to node paths).

action:
  "save"   — name (1-64 of A-Z a-z 0-9 _ -) plus EITHER position + look_at as Godot literals ("Vector3(x, y, z)", optional fov, default 60) OR neither: omit both to capture the CURRENT editor 3D viewport camera (result pose_source: "editor_viewport" vs "explicit"; overwritten says whether a same-named bookmark was replaced).
  "list"   — every saved bookmark (names sorted, poses, created timestamps, file path).
  "delete" — remove one by name (result lists the remaining names).

Failures are structured: bad_args (name grammar, half-given pose, fov outside 1..179, position == look_at), no_editor_camera (no pose given and no 3D viewport camera to capture), not_found (+ available names), io_failed (file unreadable/unwritable; a malformed file is reported, never overwritten). Edit-time only — no running game needed. If this engine build predates the bookmark ops, the result is a structured engine_lacks_op failure (nothing is sent) naming the fallback.`,
    {
      action: z
        .enum(CAMERA_BOOKMARK_ACTIONS)
        .describe('"save" a viewpoint, "list" the saved ones, or "delete" one by name.'),
      name: z
        .string()
        .optional()
        .describe("Bookmark name for save/delete: 1-64 characters from A-Z a-z 0-9 _ - (e.g. \"hero_closeup\")."),
      position: z
        .string()
        .optional()
        .describe(
          'save only. Camera position as a Godot literal, e.g. "Vector3(0, 5, 12)". Goes together with look_at; omit BOTH to capture the current editor 3D viewport camera.'
        ),
      look_at: z
        .string()
        .optional()
        .describe('save only. Point the camera looks at, e.g. "Vector3(0, 1, 0)". Must differ from position.'),
      fov: z
        .number()
        .optional()
        .describe("save only. Vertical field of view in degrees (1..179, default 60). With a captured viewport pose the viewport camera's fov wins."),
    },
    async ({ action, name, position, look_at, fov }) =>
      withEngine(
        async (client) => {
          // Argument validation first (a bad name never needs an engine), then
          // the capability pre-flight on THIS action's op kind.
          const op = buildCameraBookmarkOp({ action, name, position, look_at, fov });
          const kind = String(op.op);
          const missing = missingEngineOpResult(client, kind, CAMERA_BOOKMARK_FALLBACK);
          if (missing) return missing;
          const result = await client.executeOps([op]);
          return teachBookmarkFailure(withOldEngineHint(result, kind, CAMERA_BOOKMARK_FALLBACK));
        },
        {
          toContent: (result) => [
            {
              type: "text",
              text: `${JSON.stringify(result, null, 2)}\n\n${describeBookmarkResult(action, result)}`,
            },
          ],
        }
      )
  );
}
