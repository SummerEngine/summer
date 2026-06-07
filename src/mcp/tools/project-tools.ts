import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ASSET_POLICIES,
  GAME_TASK_MODES,
  GAME_TASK_TARGETS,
  VERIFICATION_LEVELS,
  buildGameTaskPlan,
} from "../../lib/game-task-plan.js";
import { getProjectMemorySummary } from "../../lib/project-memory.js";
import { withEngine } from "./with-engine.js";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function stringFrom(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function pickString(record: JsonRecord | null, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = stringFrom(record[key]);
    if (value) return value;
  }
  return null;
}

function getProjectData(projectState: unknown): JsonRecord | null {
  return asRecord(asRecord(projectState)?.data);
}

function getProjectSetting(projectState: unknown, keys: string[]): string | null {
  const data = getProjectData(projectState);
  const entries = data?.entries;
  if (!Array.isArray(entries)) return null;

  for (const entry of entries) {
    const item = asRecord(entry);
    const key = stringFrom(item?.key);
    if (key && keys.includes(key)) {
      return stringFrom(item?.value);
    }
  }

  return null;
}

function getProjectPath(projectState: unknown, health: unknown): string | null {
  const root = asRecord(projectState);
  const data = getProjectData(projectState);
  const healthRoot = asRecord(health);
  return (
    pickString(data, [
      "projectPath",
      "project_path",
      "projectRoot",
      "project_root",
      "rootPath",
      "root_path",
    ]) ??
    pickString(root, ["projectPath", "project_path", "projectRoot", "project_root"]) ??
    pickString(healthRoot, ["project_path", "projectPath", "projectRoot", "project_root"]) ??
    null
  );
}

function getProjectName(projectState: unknown, health: unknown): string | null {
  const root = asRecord(projectState);
  const data = getProjectData(projectState);
  const healthRoot = asRecord(health);
  return (
    pickString(data, ["projectName", "project_name", "name"]) ??
    pickString(root, ["projectName", "project_name", "name"]) ??
    pickString(healthRoot, ["project_name", "projectName", "name"]) ??
    getProjectSetting(projectState, ["application/config/name", "config/name"])
  );
}

function getMainScene(projectState: unknown): string | null {
  const root = asRecord(projectState);
  const data = getProjectData(projectState);
  return (
    pickString(data, ["mainScene", "main_scene", "mainScenePath", "main_scene_path"]) ??
    pickString(root, ["mainScene", "main_scene", "mainScenePath", "main_scene_path"]) ??
    getProjectSetting(projectState, [
      "application/run/main_scene",
      "run/main_scene",
    ])
  );
}

function getCurrentScene(
  projectState: unknown,
  sceneState: unknown,
  health: unknown
): string | null {
  const sceneRoot = asRecord(sceneState);
  const sceneData = asRecord(sceneRoot?.data);
  const sceneProvenance = asRecord(sceneRoot?.provenance);
  const projectRoot = asRecord(projectState);
  const projectData = getProjectData(projectState);
  const projectProvenance = asRecord(projectRoot?.provenance);
  const healthRoot = asRecord(health);

  return (
    pickString(sceneProvenance, ["scenePath", "scene_path"]) ??
    pickString(sceneData, ["scenePath", "scene_path", "currentScene", "current_scene"]) ??
    pickString(projectData, ["currentScene", "current_scene", "scenePath", "scene_path"]) ??
    pickString(projectProvenance, ["scenePath", "scene_path"]) ??
    pickString(healthRoot, ["scene", "scenePath", "scene_path"]) ??
    null
  );
}

export function registerProjectTools(server: McpServer): void {
  server.tool(
    "summer_start_game_task",
    `Start here for any substantial AI game-building task.

Takes the user's goal and returns the recommended Summer workflow: skill routes,
MCP tool groups, host-file boundaries, asset policy, user confirmation gates,
and verification steps. This is the router before deep skills and before
mutating the project.`,
    {
      goal: z.string().describe("The user's game-building goal or task."),
      mode: z
        .enum(GAME_TASK_MODES)
        .default("auto")
        .describe("Optional task mode override."),
      target: z
        .enum(GAME_TASK_TARGETS)
        .default("auto")
        .describe("Optional content/system target override."),
      assetPolicy: z
        .enum(ASSET_POLICIES)
        .default("ask-before-paid-generation")
        .describe("How aggressively to use paid asset generation."),
      verification: z
        .enum(VERIFICATION_LEVELS)
        .default("full")
        .describe("How much engine verification the agent should plan for."),
    },
    async ({ goal, mode, target, assetPolicy, verification }) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            buildGameTaskPlan({
              goal,
              mode,
              target,
              assetPolicy,
              verification,
            }),
            null,
            2
          ),
        },
      ],
    })
  );

  server.tool(
    "summer_get_agent_playbook",
    `AI-first operating guide for Summer Engine MCP.

Call this at the start of a fresh chat before touching scenes.
It returns the safe workflow, anti-patterns, and recovery steps.`,
    {},
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              startupChecklist: [
                "Understand the request and outline a brief plan before reaching for tools.",
                "Default medium is host file tools: write/edit .gd/.cs/.tscn/.tres/.json/docs/config directly as text.",
                "Use Summer MCP only when you need the LIVE engine: play/stop, diagnostics, screenshots/verification, navmesh or light bake, runtime inspect, or asset import.",
                "Call summer_get_project_context first so you do not guess scene paths or the project language.",
                "Use projectMemory from summer_get_project_context to decide which .summer Markdown files to read before creative/audio/dialogue/level/character work.",
                "After writing code, PLAY the scene you just made and read summer_get_diagnostics; iterate until it launches clean instead of waiting for the user to navigate to it.",
              ],
              safeDefaults: [
                "Never guess scene filenames (main.tscn/Main.tscn) -- get them from summer_get_project_context.",
                "Edit files (including .tscn/.tres) with host file tools by default. Reach for MCP scene-ops only for live-engine needs (bake, play, runtime inspect) or when you want the editor to manage node ids / instancing.",
                "If you hand-edit a .tscn that is OPEN in the editor, reload it there afterward -- the editor's open tab can overwrite your file (clobber).",
                "Write GDScript by default; use C# only if the project already uses it.",
                "Never remove multiple top-level nodes unless the user explicitly requests destructive edits.",
                "Never change priority: locked .summer memory, voice IDs, canon, or provider bindings without explicit user confirmation.",
              ],
              buildFlow: [
                "1. Understand what the user wants (one pass, no tool spelunking first).",
                "2. Outline the plan fast and briefly; proceed once it is clearly right.",
                "3. Execute in pure code -- edit .gd/.tscn/.tres as text (GDScript by default, C# only if the project already uses it).",
                "4. Play the scene/game (start with the scene you just made), read console + script/debugger errors via summer_get_diagnostics, fix, and repeat until it launches clean.",
              ],
              liveEngineFlow: [
                "Use this flow ONLY when you genuinely need live engine state (navmesh/light bake, instancing into an already-open scene, runtime inspect):",
                "summer_get_project_context",
                "summer_open_main_scene (if needed)",
                "summer_get_scene_tree",
                "summer_add_node / summer_set_prop / summer_set_resource_property",
                "summer_save_scene",
                "summer_get_diagnostics",
              ],
              recovery: [
                "If you see 'no scene open': run summer_open_main_scene.",
                "If open_scene fails: re-check mainScene from summer_get_project_context.",
                "If save fails: verify scene is open and game is not running.",
                "If a .tscn you wrote keeps reverting: the editor has that scene open -- reload or close the tab, then write again.",
              ],
            },
            null,
            2
          ),
        },
      ],
    })
  );

  server.tool(
    "summer_get_project_context",
    `Get essential project context before editing. Returns:
- engine health/status
- project name and project path when exposed by project state
- current scene path (if available)
- main scene path from project settings
- lightweight .summer project memory summary when project path is available

Use this first in every fresh chat to avoid guessing scene filenames or editing the wrong scene.`,
    {},
    async () =>
      withEngine(async (client) => {
        const [health, projectState, sceneState] = await Promise.all([
          client.health(),
          client.getProjectState(),
          client.getSceneState().catch((err) => ({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })),
        ]);

        const projectPath = getProjectPath(projectState, health);
        const projectName = getProjectName(projectState, health);
        const mainScene = getMainScene(projectState);
        const currentScene = getCurrentScene(projectState, sceneState, health);

        return {
          health,
          project: projectState,
          scene: sceneState,
          projectName,
          projectPath,
          currentScene,
          mainScene,
          projectMemory: getProjectMemorySummary(projectPath),
          guidance: mainScene
            ? "Use `summer_open_scene` with `mainScene` if no scene is open."
            : "Main scene not found in project state. Open a known scene path explicitly.",
          fileEditingGuidance:
            "Edit files (including .gd/.cs/.tscn/.tres/.json/docs) with host file tools by default. Use MCP only for live engine state: play/stop, diagnostics, screenshots/verification, navmesh or light bake, runtime inspect, and asset import. If you edit a .tscn that is open in the editor, reload it there afterward so the editor's tab does not overwrite your changes.",
        };
      })
  );

  server.tool(
    "summer_open_main_scene",
    `Open the project's configured main scene from project settings.

Safer than guessing scene names like main.tscn/Main.tscn.
Call this when you get "no scene open".`,
    {},
    async () =>
      withEngine(async (client) => {
        const projectState = await client.getProjectState();
        const mainScene = getMainScene(projectState);
        if (!mainScene) {
          throw new Error(
            "Could not resolve application/run/main_scene from project state. Call `summer_get_project_context` and open a scene explicitly."
          );
        }
        return client.executeOps([{ op: "OpenScene", path: mainScene }]);
      })
  );

  server.tool(
    "summer_project_setting",
    `Set a project setting in project.godot. Common settings:
- "application/config/name" — project name
- "application/run/main_scene" — main scene path
- "rendering/renderer/rendering_method" — "forward_plus", "mobile", or "gl_compatibility"
- "display/window/size/viewport_width" — window width
- "display/window/size/viewport_height" — window height
- "physics/3d/default_gravity" — gravity value (float)`,
    {
      key: z.string().describe("Setting key path, e.g. 'application/config/name'"),
      value: z.union([z.string(), z.number(), z.boolean()]).describe("Setting value"),
    },
    async ({ key, value }) =>
      withEngine(async (client) =>
        client.executeOps([{ op: "ProjectSetting", key, value }])
      )
  );

  server.tool(
    "summer_input_map_bind",
    `Set up input controls. Creates the action if it doesn't exist, then binds events to it.

Event format:
- Keyboard: { type: "key", key: "W" } or { type: "key", key: "Space" }
- Mouse button: { type: "mouse_button", button: 1 } (1=left, 2=right, 3=middle)
- Common keys: "W", "A", "S", "D", "Space", "Shift", "E", "Escape", "Up", "Down", "Left", "Right"

Example: Bind jump to Space and W:
  name: "jump", events: [{ type: "key", key: "Space" }, { type: "key", key: "W" }]`,
    {
      name: z.string().describe("Action name, e.g. 'jump', 'move_forward', 'interact'"),
      events: z.array(z.record(z.unknown())).describe("Array of input event objects"),
    },
    async ({ name, events }) =>
      withEngine(async (client) => {
        const ops = [
          { op: "InputMapAddAction", name },
          { op: "InputMapBind", name, events },
        ];
        return client.executeOps(ops);
      })
  );

  server.tool(
    "summer_get_scene_tree",
    `Get the full scene tree structure of the currently open scene.

Use this before structural edits (add/remove/replace).
If you get "no edited scene", call summer_open_main_scene first.`,
    {},
    async () => withEngine(async (client) => client.getSceneState())
  );

  server.tool(
    "summer_import_from_url",
    `Download a file from a URL and import it into the project. Triggers Godot's full import pipeline — generates .import files, extracts textures from .glb models, creates materials.

Use this for:
- 3D models (.glb, .gltf, .obj)
- Textures (.png, .jpg, .webp)
- Audio (.ogg, .wav, .mp3)

The path is auto-inferred from the URL filename if not specified. After import, the asset is immediately usable in scenes.`,
    {
      url: z.string().describe("HTTP(S) URL to download from"),
      path: z.string().optional().describe("Target path in project, e.g. 'res://assets/player.glb'. Auto-inferred from URL if omitted."),
    },
    async ({ url, path }) =>
      withEngine(async (client) => {
        const op: Record<string, unknown> = { op: "ImportFromUrl", url };
        if (path) op.path = path;
        return client.executeOps([op]);
      })
  );

  server.tool(
    "summer_import_from_url_batch",
    "Download multiple files from URLs in one operation. Performs a single filesystem scan after all downloads, which is faster than importing one at a time.",
    {
      imports: z.array(z.object({
        url: z.string().describe("URL to download"),
        path: z.string().describe("Target path in project"),
      })).describe("Array of {url, path} objects"),
    },
    async ({ imports }) =>
      withEngine(async (client) =>
        client.executeOps([{ op: "ImportFromUrlBatch", imports }])
      )
  );
}
