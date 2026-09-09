import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CreatorOperationError,
  listCreatorReleases,
  publishCreator,
} from "../../core/capabilities/creator.js";
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
    "summer_creator_publish",
    "Publish an exact exported Summer .pck through the versioned Summer Platform creator API. First call with confirm=false and present the returned project, version, digest, size, artifact path, channel, and notes; set confirm only after the user approves that exact target. The server independently verifies token scope, ownership, bytes, and review state.",
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
