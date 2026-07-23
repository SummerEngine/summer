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
It returns the safe workflow, the verification ladder, honesty rules,
anti-patterns, and recovery steps.`,
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
                "Call summer_get_project_context first so you do not guess scene paths or the project language. It also BINDS this session to the currently-open project (see projectBinding below).",
                "Use projectMemory from summer_get_project_context to decide which .summer Markdown files to read before creative/audio/dialogue/level/character work.",
                "After writing code, VERIFY through the engine (see verificationLadder) instead of waiting for the user to navigate to it.",
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
                "4. Verify through the engine using the verificationLadder below, fix, and repeat until it launches clean.",
              ],
              // The MCP-native verification ladder. Climb only as high as the
              // change demands: a script edit needs rung 1; a gameplay change
              // needs rungs 3-4. Each rung is a REAL engine call, not a claim.
              verificationLadder: {
                "1_compiles": [
                  "After writing/editing a .gd file, call summer_get_script_errors <path> — compiles without running the game.",
                  "For a project-wide sweep of editor + runtime issues, call summer_get_diagnostics (it tells you whether to then read summer_get_console / summer_get_debugger_errors).",
                ],
                "2_looks_right": [
                  "To SEE the result, call summer_screenshot. Pick the target deliberately:",
                  "  target:'viewport' (default) = the editor's CURRENT open tab, exactly as it looks now. Edit-time check. No game boot.",
                  "  target:'scene' = an OFFSCREEN render of a scene FILE (pass scenePath). No game boot; physics/particles/animations are STATIC at t=0. Best for 'is the composition/scale right' without disturbing the open tab. It also confesses if the scene has no Camera3D (renders grey/black when played) or no light (lit materials look black) — READ those warnings.",
                  "  target:'game' = a frame from the RUNNING game (real runtime state). summer_play FIRST. Over a plain local HTTP connection this returns an honest failure (needs the Summer desktop bridge); when it fails, fall back to viewport/scene or ask the user.",
                ],
                "3_runs": [
                  "Compose the run-and-check yourself — there is no single 'verify' tool:",
                  "summer_clear_console  -> clean slate",
                  "summer_play [scene]   -> boot the game (or a specific scene)",
                  "summer_get_debugger_errors  -> runtime errors (null refs, missing nodes, physics)",
                  "summer_screenshot target:'game'  -> optional visual of the live frame",
                  "summer_stop  -> ALWAYS stop; scene mutations are refused while the game runs",
                ],
                "4_interactive": [
                  "Summer MCP does not expose live input injection or arbitrary verification probes.",
                  "Use summer_play, diagnostics, and a game screenshot for observable runtime evidence.",
                  "For behavior that still requires player input, ask the user to try the interaction and report what they see. Do not fake the result.",
                ],
              },
              // HONESTY — mirror the in-product agent's vision rules. A capture is
              // a fact, not a formality; a failed capture is itself a result.
              honestyRules: [
                "NEVER describe an image you did not actually receive. If summer_screenshot returned isError or a text-only fallback (no image block), say the capture failed and why — do not invent what the frame 'probably' shows.",
                "A failed or blocked capture is a RESULT, not a dead end: report it, then climb down the ladder (scene->viewport) or ask the user for a screenshot.",
                "Describe only what is actually in the returned frame. Do not pad with expected content.",
                "target:'scene' is STATIC (t=0) and may use a synthetic camera — do not claim animation/particles/gameplay motion from it, and heed its no-camera / no-light / synthetic-camera warnings.",
                "Pass structured engine failures (failure_reason, terminalState, errorClass) through to the user verbatim — never soften 'unsupported' or 'bridge_required' into a vague 'it didn't work'.",
              ],
              // The session is pinned to the project open when you first called
              // summer_get_project_context. This keeps a mutation from landing in
              // the WRONG project after an in-place project switch.
              projectBinding: [
                "summer_get_project_context binds this session to the currently-open project and is the deliberate (re)bind point.",
                "If the engine later switches projects in place, mutating ops are REJECTED with identity_mismatch (nothing is applied — your edit did NOT land in the wrong project).",
                "summer_screenshot adds a projectMismatch WARNING when the engine's live project no longer matches this binding — the frame may be from the wrong project; do not trust it until you rebind.",
                "To intentionally follow the switch, call summer_get_project_context again to rebind, then retry.",
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
              batchSafety: [
                "summer_batch accepts only a bounded allowlist of scene mutations: AddNode, SetProp, SetResourceProperty, RemoveNode, InstantiateScene, ConnectSignal, and ReplaceNode.",
                "The complete batch is validated before the engine receives anything. File, Git, shell, restore, live-input, verification, internal-diff, and unknown operations are rejected.",
                "Use the host's native file, search, shell, and Git capabilities outside Summer MCP.",
                "No typed verification-probe tool is currently exposed. Use the runtime verification ladder and ask the user for manual interaction when needed.",
              ],
              recovery: [
                "If you see 'no scene open': run summer_open_main_scene.",
                "If open_scene fails: re-check mainScene from summer_get_project_context.",
                "If save fails: verify scene is open and game is not running (summer_is_running / summer_stop).",
                "If a mutation is rejected with identity_mismatch: the engine switched projects — call summer_get_project_context to rebind (only if you meant to follow it), then retry.",
                "If a .tscn you wrote keeps reverting: the editor has that scene open -- reload or close the tab, then write again.",
                "If runtime evidence cannot prove an input-driven behavior, fall back to summer_play + summer_get_debugger_errors and ask the user to interact.",
              ],
              debugging: [
                "Set SUMMER_MCP_DEBUG=1 in the MCP server's environment to log a structured stderr line per tool call (tool, ok, durationMs, terminalState, errorClass, failureReason, retried, boundProjectIdHash). With the flag OFF, only failures are logged. Use it to see exactly which op failed and why.",
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

        // This tool is the deliberate (re)bind point: capture the currently-open
        // project as the one this session's mutations are pinned to. After an
        // engine project switch the agent calls this to intentionally follow the
        // new project; subsequent edits then target it instead of being rejected.
        const boundProjectIdHash = await client.rebind();

        return {
          health,
          project: projectState,
          scene: sceneState,
          projectName,
          projectPath,
          currentScene,
          mainScene,
          boundProjectIdHash,
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
