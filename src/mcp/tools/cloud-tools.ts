import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  cloudCheckpoints,
  cloudConflicts,
  cloudInit,
  cloudPull,
  cloudPush,
  cloudRestore,
  cloudStatus,
} from "../../lib/cloud/sync.js";

const projectArg = z.object({
  project: z.string().optional().describe("Project root path. Defaults to the current working directory."),
});

const bootstrap = z.enum(["keep-cloud", "keep-local", "merge"]);

function textJson(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

export function registerCloudTools(server: McpServer): void {
  server.tool("summer_cloud_init", "Enable Summer Cloud for a project.", projectArg.shape, async (args) =>
    textJson(await cloudInit({ project: args.project, face: "mcp" }))
  );

  server.tool("summer_cloud_status", "Show Summer Cloud sync status.", projectArg.shape, async (args) =>
    textJson(await cloudStatus({ project: args.project, face: "mcp" }))
  );

  server.tool(
    "summer_cloud_push",
    "Push local project changes to Summer Cloud.",
    {
      ...projectArg.shape,
      confirmDeletes: z.boolean().default(false).describe("Required when a push would delete many cloud files."),
      bootstrap: bootstrap.optional().describe("No-base bootstrap choice."),
      adoptPath: z.boolean().optional().describe("Accept that the project folder moved and update the recorded path."),
    },
    async (args) => textJson(await cloudPush({ ...args, face: "mcp" }))
  );

  server.tool(
    "summer_cloud_pull",
    "Pull Summer Cloud changes into the local project.",
    {
      ...projectArg.shape,
      bootstrap: bootstrap.optional().describe("No-base bootstrap choice."),
      adoptPath: z.boolean().optional().describe("Accept that the project folder moved and update the recorded path."),
    },
    async (args) => textJson(await cloudPull({ ...args, face: "mcp" }))
  );

  server.tool(
    "summer_cloud_restore",
    "Restore a retained cloud version (creates a new head version server-side, then pulls), or a local pre-sync checkpoint via checkpointStamp.",
    {
      ...projectArg.shape,
      version: z.number().int().positive().optional().describe("Cloud version to restore."),
      checkpointStamp: z.string().optional().describe("Local checkpoint stamp (see summer_cloud_checkpoints)."),
    },
    async (args) =>
      textJson(await cloudRestore({ project: args.project, version: args.version, checkpoint: args.checkpointStamp, face: "mcp" }))
  );

  server.tool("summer_cloud_checkpoints", "List local pre-sync checkpoints.", projectArg.shape, async (args) =>
    textJson(await cloudCheckpoints({ project: args.project, face: "mcp" }))
  );

  server.tool(
    "summer_cloud_conflicts",
    "List local Summer Cloud conflict sets, or restore a preserved conflict file with restorePath.",
    {
      ...projectArg.shape,
      restorePath: z.string().optional().describe("Project-relative path to restore from the conflict sets."),
      set: z.string().optional().describe("Conflict set stamp; defaults to the newest set containing the path."),
    },
    async (args) =>
      textJson(await cloudConflicts({ project: args.project, restorePath: args.restorePath, set: args.set, face: "mcp" }))
  );
}
