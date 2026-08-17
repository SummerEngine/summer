import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withEngine } from "./with-engine.js";
import type { EngineSnapshot } from "../../lib/api-client.js";

/**
 * Visual capture tools. Unlike the in-product chat agent (a text-only "brain"
 * that needs a separate vision model to describe frames for it), an MCP client
 * like Claude Code can SEE images directly. So we hand the raw engine frame back
 * as an MCP image content block — no vision-model prepass, no paraphrase. The
 * model reviews the actual pixels.
 */
export function registerVisualTools(server: McpServer): void {
  server.tool(
    "summer_screenshot",
    `Capture a frame from Summer Engine and return it as an image you can look at directly.

Use this to visually verify your work: scene layout, asset placement, scale, framing, missing/untextured assets, or runtime gameplay state. You see the actual pixels — no description layer in between. Lighting and materials are only truthfully shown by the "viewport" and "game" targets — see the note on "scene" below.

target:
  "viewport" (default) — the editor's CURRENT view (whatever scene/tab is open). No game boot. Use for edit-time checks of how the scene looks right now.
  "scene" — an OFFSCREEN render of a scene file (no game boot; physics/particles/animations are static at t=0). Optionally pass scenePath/framing/size/nodePath. Use for COMPOSITION, SCALE and FRAMING without touching the editor's open tab.
    It does NOT use the scene's environment/sky, and it injects a synthetic camera and light when the scene has none. The scene's WorldEnvironment — sky, fog, tonemap, glow, SSAO, ambient — is replaced by a flat preview environment. So this target CANNOT verify lighting, mood, or any material property that depends on the environment: change them and the frame comes back identical. For those, boot the game or run a RunVerification probe, whose instance renders the real environment.
  "game" — a frame from the RUNNING game (real runtime state). Start the game first (summer_play). Not available over a plain local connection — needs the Summer desktop app bridge.

Static frame only — one moment, not motion. For a SEQUENCE of frames over time, or for anything lighting-dependent when the desktop bridge is unavailable, use a RunVerification probe's save_frame() — its instance has a real renderer.`,
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
        .enum(["auto", "top", "front", "iso"])
        .optional()
        .describe('target:"scene" only. Camera framing preset. Default: auto.'),
      size: z
        .array(z.number().int().positive())
        .length(2)
        .optional()
        .describe('target:"scene" only. Output image [width, height] in pixels.'),
      nodePath: z
        .string()
        .optional()
        .describe('target:"scene" only. Scene-tree node path to frame on.'),
    },
    async ({ target, scenePath, framing, size, nodePath }) =>
      withEngine(
        async (client) => {
          if (target === "game") return client.gameSnapshot();
          if (target === "scene")
            return client.scenePreview({
              scenePath,
              framing,
              size: size as [number, number] | undefined,
              nodePath,
            });
          return client.viewportSnapshot();
        },
        {
          // Game capture is structurally blocked over local HTTP today (409
          // bridge_required). Treat that as a clean, honest failure rather than a
          // truncated generic error — fail loud (isError) so the model does not
          // proceed as if it saw the game. Written so that when the engine starts
          // answering over HTTP (P4.4) `failureReason` never fires and the normal
          // image path below just works.
          onResult: (snap: EngineSnapshot) => {
            if (target === "game" && snap.failureReason === "bridge_required") {
              return {
                content: [
                  {
                    type: "text",
                    text:
                      "Game capture is not available over this connection (requires the Summer desktop app bridge). " +
                      "Use target:'viewport' for the editor view, target:'scene' for an offscreen scene render, " +
                      "or ask the user to describe / screenshot the running game.\n\n" +
                      `Engine reason: ${snap.error ?? "unsupported_transport"}`,
                  },
                ],
                isError: true,
              };
            }
            return null;
          },
          toContent: (snap: EngineSnapshot) => {
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
                  ? "Scene preview (offscreen render, physics/animations static)"
                  : "Editor viewport";

            const warnings: string[] = [];
            // Project-drift warning (item 4): the engine may have switched
            // projects since this session bound — this frame could be from the
            // WRONG project.
            if (snap.projectMismatch) {
              warnings.push(
                "WARNING: the engine is now on a DIFFERENT project than this session is bound to — this frame may be from the wrong project. Call summer_get_project_context to rebind before trusting it."
              );
            }
            // Scene-preview confession fields (P4.3): a scene with no camera plays
            // grey/black.
            if (target === "scene") {
              if (snap.sceneHasCamera === false) {
                warnings.push(
                  "WARNING: this scene has no Camera3D — it will render grey/black when played."
                );
              }
              if (snap.sceneHadLight === false) {
                warnings.push(
                  "WARNING: this scene has no light — lit materials may appear black when played."
                );
              }
              if (snap.usedSyntheticCamera) {
                warnings.push(
                  "NOTE: this preview used a synthetic camera the engine added just for the render — the scene itself has no camera, so it will NOT frame like this when played."
                );
              }
            }

            const caption =
              `${label} (${dims}). Saved to ${snap.localPath ?? "n/a"}. Review the image above and describe what you actually see.` +
              (warnings.length ? `\n\n${warnings.join("\n")}` : "");

            return [
              { type: "image", data: snap.base64, mimeType: snap.mime || "image/jpeg" },
              { type: "text", text: caption },
            ];
          },
        }
      )
  );
}
