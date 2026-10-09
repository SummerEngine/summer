import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CreatorOperationError,
  listCreatorReleases,
  publishCreator,
} from "../../core/capabilities/creator.js";
import { captureGameplay } from "../../core/capabilities/capture-gameplay.js";
import { exportGame } from "../../core/capabilities/export-game.js";
import { STORE_TARGETS } from "../../core/capabilities/export-presets.js";
import { exportTemplates, TEMPLATE_PLATFORMS } from "../../core/capabilities/export-templates.js";
import { publishBuild } from "../../core/capabilities/publish-build.js";
import { BuildToolError } from "../../core/capabilities/summer-bundle.js";
import {
  CONFIG_KEYS,
  getConfigValue,
  isConfigKey,
  readSummerConfig,
  setConfigValue,
  unsetConfigValue,
} from "../../core/config.js";
import { textJson } from "./text-json.js";

async function creatorResult<T>(operation: () => Promise<T>) {
  try {
    return textJson(await operation());
  } catch (error) {
    if (error instanceof CreatorOperationError) {
      return textJson(
        {
          ok: false,
          code: error.code,
          operation: error.operation,
          message: error.message,
          recovery: error.recovery,
        },
        true
      );
    }
    if (error instanceof BuildToolError) {
      return textJson(
        {
          ok: false,
          code: error.code,
          message: error.message.replace(` ${error.recovery}`, ""),
          recovery: error.recovery,
          ...(error.status ? { status: error.status } : {}),
          ...error.detail,
        },
        true
      );
    }
    return textJson(
      {
        ok: false,
        code: "creator_request_invalid",
        message: error instanceof Error ? error.message : String(error),
      },
      true
    );
  }
}

export function registerCreatorTools(server: McpServer): void {
  server.tool(
    "summer_export_game",
    "Export the game in the exact file the Summer Games store takes, with the installed Summer Engine headless (no window). format \"bundle\" (default): the summer.games .zip the Summer apps run on iPhone, Android, macOS and Windows; targets picks the platforms (a game without a server: ios and android only); upload it with summer_publish_build. format \"download\" with one target: web (an HTML5 .zip on Summer's WebGPU Forward+ web template, played on summer.games), macos (.app zip, macos-universal) or windows (.exe zip, windows-x64); these need the export template from summer_export_templates and are uploaded as store versions. Works without the editor running. Returns path, sha256, size, the manifest or store platform, and warnings.",
    {
      project: z.string().optional().describe("Project folder with project.godot. Defaults to the MCP's bound project, then the working directory."),
      out: z.string().optional().describe("Output .zip path. Defaults to <project>/.summer/exports/."),
      targets: z
        .array(z.enum(STORE_TARGETS))
        .optional()
        .describe("Store platforms. Bundle: any of macos, windows, ios, android (omit to use every platform the project declares). Download: exactly one of web, macos, windows."),
      format: z
        .enum(["bundle", "download"])
        .optional()
        .describe("bundle (default): the summer.games store build. download: a web build or native download; the default when targets is [\"web\"]."),
      debug: z.boolean().default(false).describe("Export a debug build (--export-debug)."),
      timeoutSeconds: z.number().int().min(10).max(7200).optional().describe("Stop the engine after this many seconds (default 900; a first export imports every asset)."),
    },
    async ({ project, out, targets, format, debug, timeoutSeconds }) =>
      creatorResult(() =>
        exportGame({ project, out, targets, format, debug, ...(timeoutSeconds ? { timeoutMs: timeoutSeconds * 1000 } : {}) })
      )
  );

  server.tool(
    "summer_export_templates",
    "List, download and install Summer Engine export templates from Summer's CDN into the folder the installed engine reads, checking each file's sha256. Needed only for summer_export_game format \"download\": web (Summer's WebGPU Forward+ template), macos, windows. Store bundles (format \"bundle\") need no template. action list shows what is installed and published; action install fetches the platforms asked (default web).",
    {
      action: z.enum(["list", "install"]).describe("list: installed and published templates. install: download and install."),
      platforms: z
        .array(z.enum(TEMPLATE_PLATFORMS))
        .optional()
        .describe("Template platforms to install (default [\"web\"])."),
      includeDebug: z.boolean().default(false).describe("Also install the debug templates (for exports with debug true)."),
      summerVersion: z
        .string()
        .optional()
        .describe("The installed Summer Engine version (Help > About, e.g. 0.7.1). Read automatically on macOS; needed on Windows and Linux."),
    },
    async ({ action, platforms, includeDebug, summerVersion }) =>
      creatorResult(() => exportTemplates({ action, platforms, includeDebug, summerVersion }))
  );

  server.tool(
    "summer_capture_gameplay",
    "Capture real gameplay frames without a running editor: starts the game in Summer Engine's offscreen verify instance (a real renderer, a window parked offscreen with no focus, never on screen), lets it run waitSeconds, and saves PNG frames of what the game draws, HUD included. Use for store screenshots (1920x1080 landscape or 1080x1920 portrait). With an editor open, summer_screenshot target game also works. Returns each frame's path, width and height; look at them before using them.",
    {
      project: z.string().optional().describe("Project folder with project.godot. Defaults to the MCP's bound project, then the working directory."),
      scene: z.string().optional().describe("Scene to start (res://... or uid://...). Default: the project's main scene, which is often a title menu; pass the gameplay scene for gameplay frames."),
      resolution: z.string().optional().describe("Window size WIDTHxHEIGHT (default 1920x1080; 1080x1920 for portrait)."),
      frames: z.number().int().min(1).max(10).optional().describe("Frames to save (default 1)."),
      waitSeconds: z.number().min(0).max(120).optional().describe("Seconds the game runs before the first frame (default 3)."),
      intervalSeconds: z.number().min(0.1).max(60).optional().describe("Seconds between frames (default 1)."),
      out: z.string().optional().describe("Output folder. Defaults to <project>/.summer/captures/<time>/ (ignored by git)."),
    },
    async (args) => creatorResult(() => captureGameplay(args))
  );

  server.tool(
    "summer_publish_build",
    "Upload an export from summer_export_game to the creator's game on summer.games, through the same store upload Studio uses, straight from disk. A store bundle (format bundle): declare, upload parts, seal, wait until Summer makes the Build, name its client pack, and with publish=true approve it. A web build or native download (format download): upload it as the game's store version for its platform (web, macos-universal, windows-x64, linux-x64; read from the last export) and wait until Summer has checked it. First call with confirm=false and show the user the returned target; set confirm only after they approve. Needs \"summer login --store\". A retry with the same file and clientVersion continues the same upload. Nothing here makes a game live: the owner approves publishing (summer_store_submit).",
    {
      gameId: z.string().optional().describe("The store game id (Studio store page URL). Omit to get the list of your games."),
      file: z.string().optional().describe("Exported .zip. Defaults to the last summer_export_game result."),
      clientVersion: z.string().describe("Build version, vMAJOR.MINOR.PATCH (e.g. v1.0.0); a new upload needs a new version."),
      publish: z.boolean().default(false).describe("Bundles only: also approve the Build for players. A game that has not passed review keeps it as a preview; an agent needs the owner's approval."),
      platform: z
        .enum(["web", "macos-universal", "windows-x64", "linux-x64"])
        .optional()
        .describe("Web builds and native downloads: the store platform. Defaults to the last export's platform; omit for a store bundle."),
      confirm: z.boolean().default(false).describe("Set true only after the user approves the exact upload."),
      waitSeconds: z.number().int().min(0).max(1800).optional().describe("How long to wait for Summer to make the Build (default 600). On timeout, call again to keep waiting."),
    },
    async (args) => creatorResult(() => publishBuild({ ...args, face: "mcp" }))
  );

  server.tool(
    "summer_creator_publish",
    "Deprecated: use summer_export_game, then summer_publish_build, which upload the summer.games .zip to the game's store listing. This old path publishes a .pck to the legacy Summercraft creator API with a separate sc_ token and will be removed. First call with confirm=false and present the returned project, version, digest, size, artifact path, channel, and notes; set confirm only after the user approves that exact target. The server independently verifies token scope, ownership, bytes, and review state.",
    {
      project: z.string().optional().describe("Project root. Defaults to the current working directory."),
      artifact: z.string().describe("Exact path to the exported Summer .pck artifact."),
      version: z.string().describe("Immutable release version."),
      manifest: z.string().optional().describe("Optional path to a JSON release manifest."),
      projectId: z.string().optional().describe("Creator project ID. Defaults to ~/.summer/config.json."),
      channel: z.string().optional().describe("Release channel. Defaults to the configured channel or production."),
      notes: z.string().optional().describe("Release notes shown during confirmation and recorded in the local audit."),
      confirm: z.boolean().default(false).describe("Set true only after the user approves the exact release target."),
    },
    async (args) =>
      creatorResult(() =>
        publishCreator({
          ...args,
          face: "mcp",
        })
      )
  );

  server.tool(
    "summer_creator_releases",
    "List real creator-owned releases from the versioned Summer Platform creator API. The server independently verifies the exact publish scope and project ownership.",
    {
      projectId: z.string().optional().describe("Creator project ID. Defaults to ~/.summer/config.json."),
      limit: z.number().int().min(1).max(100).default(20),
      cursor: z.string().optional().describe("Opaque nextCursor from the previous page."),
    },
    async (args) =>
      creatorResult(() =>
        listCreatorReleases({
          ...args,
          face: "mcp",
        })
      )
  );

  server.tool(
    "summer_creator_config",
    "Read or update the shared non-secret ~/.summer configuration used by the CLI and this MCP. Mutations require confirm=true. Tokens are never returned or accepted by this tool.",
    {
      action: z.enum(["list", "get", "set", "unset"]),
      key: z.enum(CONFIG_KEYS).optional(),
      value: z.string().optional(),
      confirm: z.boolean().default(false),
    },
    async ({ action, key, value, confirm }) =>
      creatorResult(async () => {
        if (action === "list") {
          const config = await readSummerConfig();
          return {
            ok: true,
            values: Object.fromEntries(
              CONFIG_KEYS.map((name) => [
                name,
                getConfigValue(config, name) ?? null,
              ])
            ),
          };
        }
        if (!key || !isConfigKey(key)) {
          throw new Error(
            `A valid key is required. Recovery: use one of ${CONFIG_KEYS.join(", ")}.`
          );
        }
        if (action === "get") {
          return {
            ok: true,
            key,
            value: getConfigValue(await readSummerConfig(), key) ?? null,
          };
        }
        if (!confirm) {
          throw new Error(
            `Changing ${key} requires confirmation. Recovery: show the exact change to the user, then retry with confirm=true.`
          );
        }
        if (action === "set") {
          if (value === undefined) {
            throw new Error(
              `A value is required for ${key}. Recovery: provide value and retry with confirm=true.`
            );
          }
          const config = await setConfigValue(key, value);
          return { ok: true, key, value: getConfigValue(config, key) };
        }
        const config = await unsetConfigValue(key);
        return { ok: true, key, value: getConfigValue(config, key) ?? null };
      })
  );
}
