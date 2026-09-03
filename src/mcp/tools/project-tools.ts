import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ASSET_POLICIES,
  GAME_TASK_MODES,
  GAME_TASK_TARGETS,
  VERIFICATION_LEVELS,
  buildGameTaskPlan,
} from "../../core/capabilities/game-task-plan.js";
import { EngineRebindError } from "../../core/api-client.js";
import { buildAgentPlaybook as buildCoreAgentPlaybook } from "../../core/capabilities/agent-playbook.js";
import { buildCapabilitySkewWarning } from "../../core/capability-skew.js";
import { isTrajectoryEvalMode } from "../../core/trajectory.js";
import { getCachedBootDriftNotice } from "../boot-notice.js";
import { appendMcpLogEvent } from "../../core/mcp-log.js";
import { getProjectMemorySummary } from "../../project-memory/project-memory.js";
import { withEngine } from "./with-engine.js";

import { asRecord, stringFrom as stringOrUndefined, type JsonRecord } from "../../core/util/json.js";

// One skew log line per MCP process — the warning itself stays in every
// summer_get_project_context payload.
let capabilitySkewLogged = false;

function stringFrom(value: unknown): string | null {
  return stringOrUndefined(value) ?? null;
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

/**
 * The agent playbook lives in core (src/core/capabilities/agent-playbook.ts)
 * so this tool, the MCP prompt below, and `summer tool get-agent-playbook`
 * share ONE implementation. The MCP surface contributes the boot drift notice
 * it owns. Exported for tests.
 */
export function buildAgentPlaybook(): Record<string, unknown> {
  return buildCoreAgentPlaybook({
    summerUpdateNotice: getCachedBootDriftNotice()?.text ?? null,
  });
}

export function renderAgentPlaybook(): string {
  return JSON.stringify(buildAgentPlaybook(), null, 2);
}

/**
 * Register the playbook as an MCP PROMPT as well, so hosts that surface
 * prompts (prompt pickers, slash commands) get the operating guide natively
 * without knowing to call the tool. Same content, second doorway.
 */
export function registerPlaybookPrompt(server: McpServer): void {
  server.registerPrompt(
    "summer_agent_playbook",
    {
      title: "Summer Engine agent playbook",
      description:
        "AI-first operating guide for the Summer Engine MCP tools: observe-first loop, screenshot before/after every mutation, content routing (reuse -> import -> generate -> script last), physical invariants, cost rules, verification ritual, honesty rules, and recovery steps.",
    },
    async () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              "Operate Summer Engine by this playbook for the rest of the session:\n\n" +
              renderAgentPlaybook(),
          },
        },
      ],
    })
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
It returns the observe-first loop, content routing (reuse -> import ->
generate -> script), physical invariants, cost rules, the verification
ladder, honesty rules, anti-patterns, and recovery steps.`,
    {},
    async () => ({
      content: [
        {
          type: "text" as const,
          text: renderAgentPlaybook(),
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
- capabilitySkewWarning (only when the engine build and this CLI have drifted
  apart — non-fatal; explains upcoming 'unknown op' failures)

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
        // A failed rebind keeps the previous identity; say so instead of
        // echoing the stale hash as if the switch had been followed.
        let boundProjectIdHash: string | undefined;
        let rebindError: string | undefined;
        try {
          boundProjectIdHash = await client.rebind();
        } catch (error) {
          if (!(error instanceof EngineRebindError)) throw error;
          rebindError = error.message;
        }

        // Handshake (Wave D): newer engines advertise capabilities
        // (protocolVersion + opKinds) in /api/health. Compare against the ops
        // this CLI can send and surface a one-line, NON-FATAL warning; engines
        // that predate the advert stay silent. Logged once per process.
        const capabilitySkewWarning = buildCapabilitySkewWarning(health);
        if (capabilitySkewWarning && !capabilitySkewLogged) {
          capabilitySkewLogged = true;
          appendMcpLogEvent("mcp:capability_skew", { warning: capabilitySkewWarning });
          process.stderr.write(
            `[summer-mcp] ${JSON.stringify({ event: "mcp:capability_skew", warning: capabilitySkewWarning })}\n`
          );
        }

        return {
          health,
          ...(capabilitySkewWarning ? { capabilitySkewWarning } : {}),
          project: projectState,
          scene: sceneState,
          projectName,
          projectPath,
          currentScene,
          mainScene,
          boundProjectIdHash,
          ...(rebindError ? { rebindError } : {}),
          projectMemory: getProjectMemorySummary(projectPath),
          summerUpdateNotice: getCachedBootDriftNotice()?.text ?? null,
          // Eval-mode trajectory capture (unredacted trajectory.full.jsonl) is
          // visible to the agent and to a human reading the transcript.
          ...(isTrajectoryEvalMode() ? { trajectory_eval_mode: true } : {}),
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
