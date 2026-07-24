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
  server.tool(
    "summer_cloud_init",
    "Enable Summer Cloud (content-addressed whole-project sync) for a project, writing the git-tracked summer-cloud.json binding. Use once per project before the first push, or after deleting the binding to fork the project into a new cloud line.",
    projectArg.shape,
    async (args) => textJson(await cloudInit({ project: args.project, face: "mcp" }))
  );

  server.tool(
    "summer_cloud_status",
    "Show what a sync would move: file counts, paths queued to push or pull, and any waiting conflict sets. Always call this before push or pull so you can report the delete and change counts to the user; never sync blind.",
    projectArg.shape,
    async (args) => textJson(await cloudStatus({ project: args.project, face: "mcp" }))
  );

  server.tool(
    "summer_cloud_push",
    "Upload local project changes to Summer Cloud as a new restorable version (use to back up big assets, move to another machine, or snapshot before a risky bulk op). confirmDeletes gates large deletions (more than 10 files, or >=20% of the tree, or the whole tree): run summer_cloud_status first, show the exact delete count to the user, and only set it once they confirm. Never pass confirmDeletes blindly.",
    {
      ...projectArg.shape,
      confirmDeletes: z.boolean().default(false).describe("Gate for large cloud deletions. Required when a push would delete more than 10 files, at least 20% of the tracked tree, or the entire tree. Surface the delete count from summer_cloud_status to the user before setting this; never set it blindly."),
      bootstrap: bootstrap.optional().describe("No-base bootstrap choice when local and cloud both have files: keep-cloud, keep-local, or merge. Present the choice to the user."),
      adoptPath: z.boolean().optional().describe("Accept that the project folder moved and update the recorded path. Only set after confirming the move is intentional, not a copy."),
    },
    async (args) => textJson(await cloudPush({ ...args, face: "mcp" }))
  );

  server.tool(
    "summer_cloud_pull",
    "Download Summer Cloud changes into the local project (use to fetch a teammate's bytes or hydrate on a second machine). A local checkpoint is written before any destructive apply, and concurrent edits become recoverable conflict sets rather than silent overwrites. Run summer_cloud_status first.",
    {
      ...projectArg.shape,
      bootstrap: bootstrap.optional().describe("No-base bootstrap choice when local and cloud both have files: keep-cloud, keep-local, or merge. Present the choice to the user."),
      adoptPath: z.boolean().optional().describe("Accept that the project folder moved and update the recorded path. Only set after confirming the move is intentional, not a copy."),
    },
    async (args) => textJson(await cloudPull({ ...args, face: "mcp" }))
  );

  server.tool(
    "summer_cloud_restore",
    "Roll a project back to an earlier state. Pass version to restore a retained cloud version (creates a new head version server-side, then pulls); pass checkpointStamp to restore a local pre-sync checkpoint for unpushed work. The restore restores bytes but does not delete files a later sync added, so review the extraneous-file list it returns.",
    {
      ...projectArg.shape,
      version: z.number().int().positive().optional().describe("Cloud version to restore (see summer_cloud_status / version history)."),
      checkpointStamp: z.string().optional().describe("Local checkpoint stamp (see summer_cloud_checkpoints). Use for unpushed local-only work."),
    },
    async (args) =>
      textJson(await cloudRestore({ project: args.project, version: args.version, checkpoint: args.checkpointStamp, face: "mcp" }))
  );

  server.tool(
    "summer_cloud_checkpoints",
    "List the local pre-sync checkpoints taken before destructive applies. Use to find a checkpoint stamp to pass to summer_cloud_restore when recovering local-only work.",
    projectArg.shape,
    async (args) => textJson(await cloudCheckpoints({ project: args.project, face: "mcp" }))
  );

  server.tool(
    "summer_cloud_conflicts",
    "List preserved Summer Cloud conflict sets (the losing bytes from concurrent edits, never discarded), or recover one by passing restorePath to re-enter it as a fresh edit. Use after a push or pull reports conflicts so the user can choose what to keep.",
    {
      ...projectArg.shape,
      restorePath: z.string().optional().describe("Project-relative path to restore from the conflict sets, re-entered as a fresh edit."),
      set: z.string().optional().describe("Conflict set stamp; defaults to the newest set containing the path."),
    },
    async (args) =>
      textJson(await cloudConflicts({ project: args.project, restorePath: args.restorePath, set: args.set, face: "mcp" }))
  );
}
