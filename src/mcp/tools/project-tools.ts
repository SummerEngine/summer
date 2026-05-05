import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
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

function getProjectPath(projectState: unknown): string | null {
  const root = asRecord(projectState);
  const data = getProjectData(projectState);
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
    null
  );
}

function getProjectName(projectState: unknown): string | null {
  const root = asRecord(projectState);
  const data = getProjectData(projectState);
  return (
    pickString(data, ["projectName", "project_name", "name"]) ??
    pickString(root, ["projectName", "project_name", "name"]) ??
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

function getCurrentScene(projectState: unknown, sceneState: unknown): string | null {
  const sceneRoot = asRecord(sceneState);
  const sceneData = asRecord(sceneRoot?.data);
  const sceneProvenance = asRecord(sceneRoot?.provenance);
  const projectRoot = asRecord(projectState);
  const projectData = getProjectData(projectState);
  const projectProvenance = asRecord(projectRoot?.provenance);

  return (
    pickString(sceneProvenance, ["scenePath", "scene_path"]) ??
    pickString(sceneData, ["scenePath", "scene_path", "currentScene", "current_scene"]) ??
    pickString(projectData, ["currentScene", "current_scene", "scenePath", "scene_path"]) ??
    pickString(projectProvenance, ["scenePath", "scene_path"]) ??
    null
  );
}

export function registerProjectTools(server: McpServer): void {
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
                "Decide first: file edit or engine operation.",
                "Write .gd/.cs/.json/docs/simple config with host file-edit tools directly.",
                "Use Summer MCP for live scene state, inspector/node edits, imports, play/stop, diagnostics, screenshots/verification.",
                "Call summer_get_project_context first.",
                "If no scene is open, call summer_open_main_scene.",
                "Call summer_get_scene_tree before structural edits.",
                "Call summer_save_scene after edits.",
              ],
              safeDefaults: [
                "Never guess scene filenames (main.tscn/Main.tscn).",
                "Do not route ordinary script, JSON, docs, or simple config edits through MCP when direct file tools are available.",
                "Never remove multiple top-level nodes unless user explicitly requests destructive edits.",
                "Use MCP for scene-tree mutations and inspector-visible values instead of hand-editing live scene state.",
              ],
              preferredFlow: [
                "summer_get_project_context",
                "summer_open_main_scene (if needed)",
                "summer_get_scene_tree",
                "edit via summer_add_node / summer_set_prop / summer_set_resource_property",
                "write scripts/data/docs/simple config directly with host file-edit tools",
                "summer_save_scene",
                "summer_get_diagnostics",
              ],
              recovery: [
                "If you see 'no scene open': run summer_open_main_scene.",
                "If open_scene fails: re-check mainScene from summer_get_project_context.",
                "If save fails: verify scene is open and game is not running.",
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

        const projectPath = getProjectPath(projectState);
        const projectName = getProjectName(projectState);
        const mainScene = getMainScene(projectState);
        const currentScene = getCurrentScene(projectState, sceneState);

        return {
          health,
          project: projectState,
          scene: sceneState,
          projectName,
          projectPath,
          currentScene,
          mainScene,
          guidance: mainScene
            ? "Use `summer_open_scene` with `mainScene` if no scene is open."
            : "Main scene not found in project state. Open a known scene path explicitly.",
          fileEditingGuidance:
            "Write .gd/.cs/.json/docs/simple config directly with host file tools. Use MCP for live scene state, inspector/node edits, imports, play/stop, diagnostics, and visual verification.",
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
