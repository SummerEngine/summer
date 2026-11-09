import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createLocalProject,
  LocalProjectError,
  localProjectFailure,
  openLocalProject,
} from "../../core/capabilities/projects-local.js";
import { EngineNotRunningError } from "../../core/error-codes.js";
import { bindMcpProject, currentMcpEngineSelection, logEngineSelfStart } from "../server.js";
import { textJson } from "./text-json.js";
import { engineNotRunningResult } from "./with-engine.js";

async function localProjectResult<T>(operation: () => Promise<T>) {
  try {
    return textJson(await operation());
  } catch (error) {
    if (error instanceof LocalProjectError) return textJson(localProjectFailure(error), true);
    if (error instanceof EngineNotRunningError) return engineNotRunningResult(error);
    throw error;
  }
}

/** The tool call's progress line (notifications/progress), when the client asked for progress. */
export function progressReporter(
  extra:
    | {
        _meta?: { progressToken?: string | number };
        sendNotification?: (notification: {
          method: "notifications/progress";
          params: { progressToken: string | number; progress: number; message?: string };
        }) => Promise<void>;
      }
    | undefined
): ((message: string) => void) | undefined {
  const token = extra?._meta?.progressToken;
  const send = extra?.sendNotification;
  if (token === undefined || !send) return undefined;
  let step = 0;
  return (message) => {
    void send({ method: "notifications/progress", params: { progressToken: token, progress: ++step, message } }).catch(() => undefined);
  };
}

/**
 * projects.create_local and projects.open_local: what `summer dev` does, for
 * agents with no shell (core/capabilities/projects-local.ts).
 */
export function registerLocalProjectTools(server: McpServer): void {
  server.tool(
    "summer_projects_create_local",
    "Create a Summer project on this computer from a template, with no shell: the built-in 3d-basic (sky, sun, ground and a hero; no download) unless template names another. Writes it into dir, or into <name> next to the session's project, in the session's folder, or in ~/Documents/Summer; never inside another project. A folder that already holds project.godot is left as it is. Returns projectPath. Next: summer_projects_open_local with that path.",
    {
      template: z.string().max(80).optional().describe("Template slug (docs.search finds them): 3d-basic (default), empty, 3d-third-person-controller, 2d-platformer, ..."),
      name: z.string().max(80).optional().describe("The project's name and folder name. Default my-game (or the template's name)."),
      dir: z.string().max(1000).optional().describe("The project folder: a new or empty folder, not inside another project; ~ is home. Default <name> next to the session's project, in the session's folder, or in ~/Documents/Summer."),
    },
    async (args) => localProjectResult(() => createLocalProject(args, currentMcpEngineSelection()?.cwd))
  );

  server.tool(
    "summer_projects_open_local",
    "Open a project on this computer in Summer Engine, in the background, and wait until it connects (an editor that has it open is used as it is; an editor with another project open switches to it in the same window); this session's engine tools then work on it. When Summer Engine is not installed it answers engine_not_running: ask the person, and only with their yes call again with install: true (about 660 MB, free). A first open can take a few minutes: the answer says to call again. It adds summer-preview to the session folder's .claude/launch.json (Claude Code Desktop's Browser pane), and preview.url is where the game shows. Next: summer_get_project_context.",
    {
      path: z.string().max(1000).optional().describe("The project folder (holds project.godot), e.g. projectPath from summer_projects_create_local. Default this session's project."),
      install: z.boolean().default(false).describe("Install Summer Engine first when it is missing. Set true only after the person said yes."),
    },
    async (args, extra) =>
      localProjectResult(() =>
        openLocalProject(args, currentMcpEngineSelection(), { log: logEngineSelfStart, progress: progressReporter(extra) }, (root, client) =>
          bindMcpProject(root, client)
        )
      )
  );
}
