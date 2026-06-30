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

Use this to visually verify your work: scene layout, asset placement, scale, framing, lighting, materials, missing/untextured assets, or runtime gameplay state. You see the actual pixels — no description layer in between.

target:
  "viewport" (default) — the editor's current 3D/2D scene view. Works without running the game. Use for edit-time checks of how the scene looks.
  "game" — a frame from the running game. The game must be started first (summer_play). Use to verify runtime behavior.

Static frame only — one moment, not motion. On macOS the game often runs in a floating window that cannot be captured; if a game capture fails, prefer "viewport", or ask the user to share a screenshot.`,
    {
      target: z
        .enum(["viewport", "game"])
        .optional()
        .default("viewport")
        .describe('"viewport" = editor scene view (default), "game" = running game frame'),
    },
    async ({ target }) =>
      withEngine(
        async (client) =>
          target === "game" ? client.gameSnapshot() : client.viewportSnapshot(),
        {
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
            const label = target === "game" ? "Running game frame" : "Editor viewport";
            return [
              { type: "image", data: snap.base64, mimeType: snap.mime || "image/jpeg" },
              {
                type: "text",
                text: `${label} (${dims}). Saved to ${snap.localPath ?? "n/a"}. Review the image above and describe what you actually see.`,
              },
            ];
          },
        }
      )
  );
}
