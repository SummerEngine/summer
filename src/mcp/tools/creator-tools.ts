import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CreatorOperationError,
  listCreatorReleases,
  publishCreator,
} from "../../core/capabilities/creator.js";
import { exportGame } from "../../core/capabilities/export-game.js";
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
    "Export the game for summer.games: runs the installed Summer Engine headless (no window) with the project's summer.games export preset and returns the .zip bundle path, sha256, size and the bundle manifest (main scene, target platforms, hosted or not). Works without the editor running. Upload the result with summer_publish_build.",
    {
      project: z.string().optional().describe("Project folder with project.godot. Defaults to the MCP's bound project, then the working directory."),
      out: z.string().optional().describe("Output .zip path. Defaults to <project>/.summer/exports/<name>-<time>.zip."),
      debug: z.boolean().default(false).describe("Export a debug build (--export-debug)."),
      timeoutSeconds: z.number().int().min(10).max(7200).optional().describe("Stop the engine after this many seconds (default 900; a first export imports every asset)."),
    },
    async ({ project, out, debug, timeoutSeconds }) =>
      creatorResult(() =>
        exportGame({ project, out, debug, ...(timeoutSeconds ? { timeoutMs: timeoutSeconds * 1000 } : {}) })
      )
  );

  server.tool(
    "summer_publish_build",
    "Upload a summer.games export (.zip from summer_export_game) to the creator's game on summer.games, through the same store upload Studio uses: declare, upload parts straight from disk, seal, wait until Summer makes the Build, name its client pack, and with publish=true approve it. First call with confirm=false and show the user the returned game, file, sha256, size, version and publish choice; set confirm only after they approve. Needs \"summer login --store\". A retry with the same file and clientVersion continues the same upload.",
    {
      gameId: z.string().optional().describe("The store game id (Studio store page URL). Omit to get the list of your games."),
      file: z.string().optional().describe("Exported .zip. Defaults to the last summer_export_game result."),
      clientVersion: z.string().describe("Build version, vMAJOR.MINOR.PATCH (e.g. v1.0.0); a new upload needs a new version."),
      publish: z.boolean().default(false).describe("Also approve the Build for players. A game that has not passed review keeps it as a preview."),
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
