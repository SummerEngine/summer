/**
 * project-context — ONE builder for `summer_get_project_context`, called by
 * both faces (src/mcp/tools/project-tools.ts and
 * src/core/capabilities/tool-dispatch.ts) so the payload is identical
 * (CONTRACT.md §3, "one behavior, two faces").
 *
 * E2E 2026-09-03 F-04: the CLI face returned an untrimmed 969-setting dump
 * (144 KB) with no guidance/projectMemory while the MCP face returned the
 * trimmed 88 KB shape — two implementations, two payloads. Both now call
 * buildProjectContext(); the only face-specific input is the MCP boot drift
 * notice, passed in as an extra.
 *
 * Payload budget: the engine's /api/state/project ignores ?prefix= (it is
 * snapshot-served — see EngineApiClient.getProjectState), so every trim here
 * is client-side and every trim is declared (settingsTruncated, totalSettings,
 * settingsPrefixesIncluded, settingsPrefixesExcluded) — nothing is hidden,
 * only deferred behind settingsPrefixes.
 */
import { z } from "zod";
import { EngineRebindError } from "../api-client.js";
import { buildCapabilitySkewWarning } from "../capability-skew.js";
import { isTrajectoryEvalMode } from "../trajectory.js";
import {
  getProjectMemorySummary,
  type ProjectMemorySummary,
} from "../../project-memory/project-memory.js";
import { asRecord, stringFrom, type JsonRecord } from "../util/json.js";

/**
 * Settings groups an agent acts on by default: project identity and main
 * scene (application/), window size and stretch (display/window/), the
 * project's own input actions (input/), gravity, the renderer method
 * (forward_plus / mobile / gl_compatibility) and the 2D default texture
 * filter (pixel art vs. smooth). Everything else — audio buses, layer names,
 * editor prefs, per-feature rendering knobs — is one settingsPrefixes call
 * away and is counted in totalSettings.
 */
export const DEFAULT_PROJECT_CONTEXT_SETTINGS_PREFIXES: readonly string[] = [
  "application/",
  "display/window/",
  "input/",
  "physics/2d/default_gravity",
  "physics/3d/default_gravity",
  "rendering/renderer/",
  "rendering/textures/canvas_textures/",
];

/**
 * Dropped from the default set only: Godot's built-in `input/ui_*` actions
 * (72 of them, identical in every project, each carrying InputEvent dumps).
 * They are the single largest block of the default payload and never inform
 * a game-building decision. Read them with settingsPrefixes: ["input/ui_"].
 */
export const DEFAULT_PROJECT_CONTEXT_SETTINGS_EXCLUDED: readonly string[] = ["input/ui_"];

export const MAX_SETTINGS_PREFIXES = 32;

// Mirrors library/tools/get-project-context/resource.yaml input_schema (parity-tested).
export const projectContextInputShape = {
  settingsPrefix: z
    .string()
    .optional()
    .describe(
      "Only return project settings whose key starts with this prefix, e.g. 'audio/' or 'application/config/'. Omit for the curated default set."
    ),
  settingsPrefixes: z
    .array(z.string())
    .max(MAX_SETTINGS_PREFIXES)
    .optional()
    .describe(
      "Several settings groups at once, e.g. ['audio/', 'layer_names/2d_physics/', 'input/ui_']. Merged with settingsPrefix. Omit for the curated default set."
    ),
};

export const projectContextInputSchema = z.object(projectContextInputShape).strict();
export type ProjectContextArgs = z.infer<typeof projectContextInputSchema>;

/** The engine reads the builder needs — a structural subset of EngineApiClient
 *  so tests and the headless router can hand in a stand-in. */
export interface ProjectContextClient {
  health(): Promise<unknown>;
  getProjectState(prefix?: string): Promise<unknown>;
  getSceneState(): Promise<unknown>;
  rebind(): Promise<string | undefined>;
}

export interface ProjectContextExtras {
  /** MCP-only: the boot drift notice the server probes at startup. The CLI
   *  face has no such probe and passes nothing; the key is still emitted (null). */
  summerUpdateNotice?: string | null;
  /** Called with the skew warning when the engine advert and this toolkit
   *  disagree — the MCP face logs it once per process. */
  onCapabilitySkew?: (warning: string) => void;
}

export interface ProjectContextPayload extends JsonRecord {
  health: unknown;
  capabilitySkewWarning?: string;
  project: unknown;
  scene: unknown;
  projectName: string | null;
  projectPath: string | null;
  currentScene: string | null;
  mainScene: string | null;
  boundProjectIdHash: string | undefined;
  rebindError?: string;
  projectMemory: ProjectMemorySummary;
  summerUpdateNotice: string | null;
  /** Present (true) only while SUMMER_TRAJECTORY_DIR + SUMMER_TRAJECTORY_EVAL=1
   *  make every tool call also land unredacted in trajectory.full.jsonl. */
  trajectory_eval_mode?: true;
  guidance: string;
  fileEditingGuidance: string;
}

// ── Settings selection ──────────────────────────────────────────────────────

export interface SettingsSelection {
  prefixes: readonly string[];
  excluded: readonly string[];
  /** True when the caller named the prefixes (no default trim applies). */
  explicit: boolean;
  /** The single settingsPrefix argument as given (echoed in the payload). */
  settingsPrefix?: string;
}

/** Which settings groups to keep: the caller's prefixes (settingsPrefix and
 *  settingsPrefixes merged, blanks dropped, order kept, de-duplicated) or the
 *  curated default with its exclusion. */
export function resolveSettingsSelection(args: ProjectContextArgs): SettingsSelection {
  const requested: string[] = [];
  const push = (value: unknown) => {
    const prefix = stringFrom(value)?.trim();
    if (prefix && !requested.includes(prefix)) requested.push(prefix);
  };
  push(args.settingsPrefix);
  for (const prefix of args.settingsPrefixes ?? []) push(prefix);
  if (requested.length > 0) {
    const single = stringFrom(args.settingsPrefix)?.trim();
    return { prefixes: requested, excluded: [], explicit: true, ...(single ? { settingsPrefix: single } : {}) };
  }
  return {
    prefixes: DEFAULT_PROJECT_CONTEXT_SETTINGS_PREFIXES,
    excluded: DEFAULT_PROJECT_CONTEXT_SETTINGS_EXCLUDED,
    explicit: false,
  };
}

/**
 * Bound the project-state payload to the selected settings groups. Everything
 * outside data.entries is preserved; the trim is always declared so an agent
 * can see what it did not get and how to ask for it.
 */
export function trimProjectSettings(projectState: unknown, selection: SettingsSelection): unknown {
  const root = asRecord(projectState);
  const data = asRecord(root?.data);
  const entries = data?.entries;
  if (!root || !data || !Array.isArray(entries)) return projectState;

  const keyOf = (entry: unknown): string | null => stringFrom(asRecord(entry)?.key) ?? null;
  const kept = entries.filter((entry) => {
    const key = keyOf(entry);
    if (key === null) return false;
    if (!selection.prefixes.some((prefix) => key.startsWith(prefix))) return false;
    return !selection.excluded.some((prefix) => key.startsWith(prefix));
  });

  return {
    ...root,
    data: {
      ...data,
      entries: kept,
      settingsTruncated: kept.length < entries.length,
      totalSettings: entries.length,
      returnedSettings: kept.length,
      settingsPrefixesIncluded: [...selection.prefixes],
      ...(selection.settingsPrefix ? { settingsPrefix: selection.settingsPrefix } : {}),
      ...(selection.excluded.length > 0 ? { settingsPrefixesExcluded: [...selection.excluded] } : {}),
      settingsHint: selection.explicit
        ? "Settings were filtered to settingsPrefixesIncluded; totalSettings counts everything the engine holds. Pass settingsPrefixes (several groups) or settingsPrefix (one) to read another group."
        : `Settings were trimmed to the curated default groups in settingsPrefixesIncluded (minus settingsPrefixesExcluded) to bound payload size; the engine holds ${entries.length} in total. Pass settingsPrefixes — e.g. ["audio/"], ["layer_names/"], ["input/ui_"], ["rendering/"] — to read another group.`,
    },
  };
}

// ── Derived fields (shape-tolerant reads of the engine state) ──────────────

function pickString(record: JsonRecord | null, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = stringFrom(record[key]);
    if (value) return value;
  }
  return null;
}

function projectData(projectState: unknown): JsonRecord | null {
  return asRecord(asRecord(projectState)?.data);
}

/** The value of the first matching ProjectSettings key, or null. */
export function projectSettingValue(projectState: unknown, keys: string[]): string | null {
  const entries = projectData(projectState)?.entries;
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    const item = asRecord(entry);
    const key = stringFrom(item?.key);
    if (key && keys.includes(key)) return stringFrom(item?.value) ?? null;
  }
  return null;
}

export function resolveProjectPath(projectState: unknown, health: unknown): string | null {
  const root = asRecord(projectState);
  const data = projectData(projectState);
  const healthRoot = asRecord(health);
  return (
    pickString(data, ["projectPath", "project_path", "projectRoot", "project_root", "rootPath", "root_path"]) ??
    pickString(root, ["projectPath", "project_path", "projectRoot", "project_root"]) ??
    pickString(healthRoot, ["project_path", "projectPath", "projectRoot", "project_root"]) ??
    null
  );
}

export function resolveProjectName(projectState: unknown, health: unknown): string | null {
  const root = asRecord(projectState);
  const data = projectData(projectState);
  const healthRoot = asRecord(health);
  return (
    pickString(data, ["projectName", "project_name", "name"]) ??
    pickString(root, ["projectName", "project_name", "name"]) ??
    pickString(healthRoot, ["project_name", "projectName", "name"]) ??
    projectSettingValue(projectState, ["application/config/name", "config/name"])
  );
}

export function resolveMainScene(projectState: unknown): string | null {
  const root = asRecord(projectState);
  const data = projectData(projectState);
  return (
    pickString(data, ["mainScene", "main_scene", "mainScenePath", "main_scene_path"]) ??
    pickString(root, ["mainScene", "main_scene", "mainScenePath", "main_scene_path"]) ??
    projectSettingValue(projectState, ["application/run/main_scene", "run/main_scene"])
  );
}

export function resolveCurrentScene(projectState: unknown, sceneState: unknown, health: unknown): string | null {
  const sceneRoot = asRecord(sceneState);
  const projectRoot = asRecord(projectState);
  return (
    pickString(asRecord(sceneRoot?.provenance), ["scenePath", "scene_path"]) ??
    pickString(asRecord(sceneRoot?.data), ["scenePath", "scene_path", "currentScene", "current_scene"]) ??
    pickString(projectData(projectState), ["currentScene", "current_scene", "scenePath", "scene_path"]) ??
    pickString(asRecord(projectRoot?.provenance), ["scenePath", "scene_path"]) ??
    pickString(asRecord(health), ["scene", "scenePath", "scene_path"]) ??
    null
  );
}

// ── The builder ────────────────────────────────────────────────────────────

export async function buildProjectContext(
  client: ProjectContextClient,
  args: ProjectContextArgs = {},
  extras: ProjectContextExtras = {}
): Promise<ProjectContextPayload> {
  const selection = resolveSettingsSelection(args);
  const [health, fullProjectState, sceneState] = await Promise.all([
    client.health(),
    // ?prefix= rides along for forward-compatibility (a single prefix is all
    // the engine query can carry); current engines ignore it, so the
    // client-side trim below must hold on its own.
    client.getProjectState(stringFrom(args.settingsPrefix)),
    client.getSceneState().catch((err) => ({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })),
  ]);
  // Derived fields read the UNtrimmed state so a narrow prefix cannot hide
  // mainScene/projectPath from the context summary.
  const project = trimProjectSettings(fullProjectState, selection);
  const projectPath = resolveProjectPath(fullProjectState, health);
  const projectName = resolveProjectName(fullProjectState, health);
  const mainScene = resolveMainScene(fullProjectState);
  const currentScene = resolveCurrentScene(fullProjectState, sceneState, health);

  // This tool is the deliberate (re)bind point: capture the currently-open
  // project as the one this session's mutations are pinned to. A failed
  // rebind keeps the previous identity; say so instead of echoing the stale
  // hash as if the switch had been followed.
  let boundProjectIdHash: string | undefined;
  let rebindError: string | undefined;
  try {
    boundProjectIdHash = await client.rebind();
  } catch (error) {
    if (!(error instanceof EngineRebindError)) throw error;
    rebindError = error.message;
  }

  // Newer engines advertise capabilities (protocolVersion + opKinds) in
  // /api/health; a one-line NON-FATAL warning explains upcoming unknown-op
  // failures. Engines that predate the advert stay silent.
  const capabilitySkewWarning = buildCapabilitySkewWarning(health);
  if (capabilitySkewWarning) extras.onCapabilitySkew?.(capabilitySkewWarning);

  return {
    health,
    ...(capabilitySkewWarning ? { capabilitySkewWarning } : {}),
    project,
    scene: sceneState,
    projectName,
    projectPath,
    currentScene,
    mainScene,
    boundProjectIdHash,
    ...(rebindError ? { rebindError } : {}),
    projectMemory: getProjectMemorySummary(projectPath),
    summerUpdateNotice: extras.summerUpdateNotice ?? null,
    // Eval-mode trajectory capture (unredacted trajectory.full.jsonl) is
    // visible to the agent and to a human reading the transcript — on both
    // faces, since both call this builder.
    ...(isTrajectoryEvalMode() ? { trajectory_eval_mode: true as const } : {}),
    guidance: mainScene
      ? "Use `summer_open_scene` with `mainScene` if no scene is open."
      : "Main scene not found in project state. Open a known scene path explicitly.",
    fileEditingGuidance:
      "Use summer_read_file plus summer_replace_text or guarded summer_write_file for project files, including .gd/.cs/.tscn/.tres/.json/docs. New files require create_only:true; overwrites require the sha256 receipt from summer_read_file. Prefer scene tools for live hierarchy/inspector changes.",
  };
}
