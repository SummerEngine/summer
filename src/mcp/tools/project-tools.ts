import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ASSET_POLICIES,
  GAME_TASK_MODES,
  GAME_TASK_TARGETS,
  VERIFICATION_LEVELS,
  buildGameTaskPlan,
} from "../../core/capabilities/game-task-plan.js";
import { getCachedBootDriftNotice } from "../boot-notice.js";
import { getProjectMemorySummary } from "../../project-memory/project-memory.js";
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

function getScenePathFromSceneState(sceneState: unknown): string | null {
  const root = asRecord(sceneState);
  return (
    pickString(asRecord(root?.provenance), ["scenePath", "scene_path"]) ??
    pickString(asRecord(root?.data), ["scenePath", "scene_path"]) ??
    null
  );
}

/** Default prefix set kept in summer_get_project_context when no settingsPrefix
 *  is given. The full settings dump measured 188KB (~47k tokens) on a real
 *  project; these prefixes cover what agents actually key on (main scene,
 *  window size, input actions, physics, renderer). */
const CONTEXT_SETTINGS_PREFIXES = [
  "application/",
  "display/",
  "input/",
  "physics/",
  "rendering/",
] as const;

/**
 * Bound the project-state payload. The engine ignores ?prefix= on
 * /api/state/project (snapshot-served with empty args — see
 * ApiClient.getProjectState), so ALL filtering here is client-side:
 * - settingsPrefix given: keep only entries under that prefix.
 * - no prefix: keep only the curated CONTEXT_SETTINGS_PREFIXES.
 * Trimming is always declared in the payload (settingsTruncated /
 * totalSettings / hint); everything outside data.entries is preserved.
 */
function trimProjectSettings(projectState: unknown, settingsPrefix?: string): unknown {
  const root = asRecord(projectState);
  const data = asRecord(root?.data);
  const entries = data?.entries;
  if (!root || !data || !Array.isArray(entries)) return projectState;

  const keyOf = (entry: unknown): string | null => stringFrom(asRecord(entry)?.key);
  const kept = settingsPrefix
    ? entries.filter((entry) => keyOf(entry)?.startsWith(settingsPrefix) ?? false)
    : entries.filter((entry) => {
        const key = keyOf(entry);
        return key !== null && CONTEXT_SETTINGS_PREFIXES.some((p) => key.startsWith(p));
      });

  return {
    ...root,
    data: {
      ...data,
      entries: kept,
      settingsTruncated: kept.length < entries.length,
      totalSettings: entries.length,
      returnedSettings: kept.length,
      ...(settingsPrefix
        ? { settingsPrefix }
        : {
            settingsPrefixesIncluded: [...CONTEXT_SETTINGS_PREFIXES],
            settingsHint:
              "Settings were trimmed to the curated prefixes above to bound payload size. Pass settingsPrefix (e.g. 'audio/' or 'layer_names/') to read another settings group.",
          }),
    },
  };
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
              summerUpdateNotice: getCachedBootDriftNotice()?.text ?? null,
              startupChecklist: [
                "Understand the request and outline a brief plan before reaching for tools.",
                "Use summer_read_file, summer_write_file, and summer_replace_text for project text files so reads and guarded writes stay bound to the open engine project.",
                "Use Summer MCP for project mutations and live-engine work: scenes, resources, play/stop, diagnostics, screenshots/verification, bake, runtime inspection, and asset import.",
                "Call summer_get_project_context first so you do not guess scene paths or the project language. It also BINDS this session to the currently-open project (see projectBinding below).",
                "Use projectMemory from summer_get_project_context to decide which .summer Markdown files to read before creative/audio/dialogue/level/character work.",
                "After writing code, VERIFY through the engine (see verificationLadder) instead of waiting for the user to navigate to it.",
              ],
              safeDefaults: [
                "Never guess scene filenames (main.tscn/Main.tscn) -- get them from summer_get_project_context.",
                "Use summer_replace_text for existing project text and summer_write_file with create_only:true for new files; overwrites require the sha256 from summer_read_file.",
                "For live scene hierarchy and inspector changes, prefer scene tools. Guarded text writes support .tscn/.tres, and the engine schedules editor reloads after they land.",
                "Write GDScript by default; use C# only if the project already uses it.",
                "Never remove multiple top-level nodes unless the user explicitly requests destructive edits.",
                "Never change priority: locked .summer memory, voice IDs, canon, or provider bindings without explicit user confirmation.",
              ],
              buildFlow: [
                "1. Understand what the user wants (one pass, no tool spelunking first).",
                "2. Outline the plan fast and briefly; proceed once it is clearly right.",
                "3. Execute through identity-bound MCP mutations -- guarded text tools for files, scene tools for live hierarchy/inspector work (GDScript by default, C# only if the project already uses it).",
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
                  "summer_play [scene]   -> boot the game (or a specific scene)",
                  "summer_get_debugger_errors  -> runtime errors (null refs, missing nodes, physics)",
                  "summer_screenshot target:'game'  -> optional visual of the live frame",
                  "summer_stop  -> stop when runtime verification is finished; editor scene mutations are not categorically blocked by a running game, but an existing game instance may need a restart to observe them",
                ],
                "4_interactive": [
                  "To prove input-driven behavior (does jump/move/shoot actually work), prefer RunVerification — a scripted, repeatable probe. SimulateInput is also reachable as a single op against the RUNNING game (see rawOpsViaBatch); do NOT hand this rung to the user while either route works.",
                  "RunVerification: spawn a hidden, disposable game instance that runs a GDScript probe (press inputs, read state, save frames) and dies — never touches the user's editor. Returns results.json + frames. Send it as a raw op through summer_batch (see rawOpsViaBatch).",
                  "Unlike the editor's own --headless mode, the verify instance renders REAL PIXELS, so save_frame('name') writes a real image and Performance.TIME_FPS reports a real number. save_frame REQUIRES a name argument — save_frame() with no args is a script error (probe fails).",
                  "Mount probe scenes DEFERRED: get_tree().root.add_child.call_deferred(instance); await get_tree().process_frame; await settle(). A direct add_child during _ready can hit the parent-busy guard and 'succeed' while capturing a black frame.",
                  "press()/key() are COROUTINES — 'await press(\"move_right\", 500)' or the hold never elapses and the input does nothing.",
                  "Assert on physics-frame-derived state (positions after N 'await get_tree().physics_frame'), which is reproducible. press(hold_ms) waits on wall clock, so distance-travelled jitters run to run — assert 'moved more than X', never an exact value.",
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
                "Use this flow when you genuinely need live engine state (navmesh/light bake, scene mutation, runtime inspect):",
                "summer_get_project_context",
                "Choose the exact res:// scenePath. OpenScene is a user-visible tab action, not a mutation prerequisite.",
                "summer_get_scene_tree with scenePath when that exact scene is already loaded; omit it only for the visible tab.",
                "summer_add_node / summer_set_prop / summer_set_resource_property with scenePath",
                "Mutation tools append one final SaveScene; use summer_save_scene only for a standalone save/save-as.",
                "summer_get_diagnostics",
              ],
              // summer_batch forwards each {op, ...} verbatim to the engine, so
              // engine ops that have no dedicated tool are still reachable.
              rawOpsViaBatch: [
                "summer_batch runs an array of raw engine ops in one undo group; each op is passed through untouched, so newer engine ops with no dedicated tool are still callable.",
                "RunVerification (hidden probe instance): summer_batch ops:[{op:'RunVerification', probe_source:'<gdscript>', max_seconds:20}]. probe_source extends SummerProbeBase and uses report(name, value)/save_frame(name)/press(action)/key(keycode)/finish(); returns {ok, results, frames, out_dir} or {ok:false, failure_reason: spawn_failed|timeout|bad_args|no_project|probe_not_node}. save_frame REQUIRES a name argument.",
                "SimulateInput (drive the RUNNING game — summer_play first): summer_batch ops:[{op:'SimulateInput', type:'action', action:'jump', pressed:true}], sent ALONE as the only op. failure_reason 'not_running' = start the game first; 'unsupported' = the running game build predates the handler — use RunVerification instead.",
                "SINGLE-OP CONTRACT: the engine rejects any multi-op batch containing SaveScene, InstantiateScene, ReplaceNode, SimulateInput, ViewportSnapshot, GameSnapshot, Run*/Import* or Git* ops (failure_reason 'unsupported_transport', nothing executes). summer_batch splits these into sequential requests for you; when composing raw batches keep them as their own call anyway.",
                "WriteFile and ReplaceText are rejected here by design — use summer_write_file / summer_replace_text so project identity, content guards and same-file ordering are enforced.",
                "You do not need an engine op to run a shell command: your own host already has a shell. The engine binary that runs project scripts is at OS.get_executable_path() (on macOS, /Applications/Summer.app/Contents/MacOS/Summer); see the summer-cli headless-scripting skill.",
                "These are runtime ops, not scene mutations — the batch undo group is a harmless no-op for them.",
              ],
              recovery: [
                "If a scene mutation reports missing_scene_path: pass the exact res:// scenePath and retry.",
                "If a scene target cannot load: repair the named missing/invalid dependency, then retry the same scenePath.",
                "If open_scene fails: re-check mainScene from summer_get_project_context.",
                "If save fails: use the returned scenePath/error to repair the exact cause. A running game alone is not a generic scene-mutation blocker.",
                "If a mutation is rejected with identity_mismatch: the engine switched projects — call summer_get_project_context to rebind (only if you meant to follow it), then retry.",
                "If a guarded file mutation is rejected with content mismatch: call summer_read_file again, review the new content, and retry with its new sha256 only if the edit is still valid.",
                "If a run op returns 'unsupported' / an unknown-op error: this engine build predates it — fall back to summer_play + summer_get_debugger_errors.",
                "If any op returns 'unsupported_transport': it was batched with other ops. Resend it as the ONLY op in the request (nothing from the rejected batch was applied).",
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

Use this first in every fresh chat to avoid guessing scene filenames or editing the wrong scene.

Project settings in project.data.entries are trimmed to a curated prefix set
(application/, display/, input/, physics/, rendering/) to bound payload size —
the untrimmed dump can exceed 45k tokens. The payload declares the trim
(settingsTruncated, totalSettings, settingsPrefixesIncluded). Pass
settingsPrefix to read a specific settings group (e.g. 'audio/') instead.`,
    {
      settingsPrefix: z
        .string()
        .optional()
        .describe(
          "Only return project settings whose key starts with this prefix, e.g. 'audio/' or 'application/config/'. Omit for the curated default set."
        ),
    },
    async ({ settingsPrefix }) =>
      withEngine(async (client) => {
        const [health, fullProjectState, sceneState] = await Promise.all([
          client.health(),
          client.getProjectState(settingsPrefix),
          client.getSceneState().catch((err) => ({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })),
        ]);
        // Derived fields read the UNtrimmed state so a narrow settingsPrefix
        // cannot hide mainScene/projectPath from the context summary.
        const projectState = trimProjectSettings(fullProjectState, settingsPrefix);

        const projectPath = getProjectPath(fullProjectState, health);
        const projectName = getProjectName(fullProjectState, health);
        const mainScene = getMainScene(fullProjectState);
        const currentScene = getCurrentScene(fullProjectState, sceneState, health);

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
          summerUpdateNotice: getCachedBootDriftNotice()?.text ?? null,
          guidance: mainScene
            ? "Use `summer_open_scene` with `mainScene` if no scene is open."
            : "Main scene not found in project state. Open a known scene path explicitly.",
          fileEditingGuidance:
            "Use summer_read_file plus summer_replace_text or guarded summer_write_file for project files, including .gd/.cs/.tscn/.tres/.json/docs. New files require create_only:true; overwrites require the sha256 receipt from summer_read_file. Prefer scene tools for live hierarchy/inspector changes.",
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
    `Get a scene tree. Pass scenePath to read that exact in-memory/open scene;
omit it only when you intentionally want the currently visible editor scene.
Scene mutations load their explicit target, so a follow-up targeted read does
not require OpenScene.

The engine defaults to depth 2 and limit 200 nodes and SILENTLY truncates
deeper hierarchies (the response then carries truncated: true and a visited
count lower than the real node count). Pass an explicit depth (e.g. 10) to
read a full tree — a 102-node scene returns only 61 nodes at the defaults.`,
    {
      scenePath: z.string().optional().describe("Exact res:// scene path to inspect"),
      depth: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum tree depth to walk. Engine default is 2 — pass a larger value for deep hierarchies."),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of nodes to return. Engine default is 200."),
    },
    async ({ scenePath, depth, limit }) =>
      withEngine(async (client) => {
        if (depth === undefined && limit === undefined) {
          return client.getSceneState(scenePath);
        }
        // The engine honors depth/limit ONLY on targeted (scene=) reads; an
        // untargeted read is served from a pre-published snapshot built with
        // the defaults, and its query params are dropped. Resolve the current
        // scene path first so depth/limit actually take effect.
        let target = scenePath;
        if (!target) {
          const snapshot = await client.getSceneState();
          target = getScenePathFromSceneState(snapshot) ?? undefined;
          if (!target) {
            const record = asRecord(snapshot);
            return {
              ...(record ?? { snapshot }),
              depthLimitApplied: false,
              note: "depth/limit were IGNORED: the current scene path could not be resolved, and the engine only honors depth/limit on scene-targeted reads. Pass scenePath explicitly to apply them.",
            };
          }
        }
        return client.getSceneState(target, { depth, limit });
      })
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
