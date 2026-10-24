import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodTypeAny } from "zod";
import { loadLibraryIndex } from "../core/library-search.js";
import { PROFILES, TOOLSETS, parseProfile, type Profile, type Toolset } from "../core/tool-profiles.js";

/**
 * The shape of the MCP tool surface: which toolset each tool belongs to, each
 * local tool's annotations, which results are capped, and which calls count
 * as single scene edits. Read by server.ts (registration, results) and, with
 * the profiles in core/tool-profiles.ts, by hosted-mount.ts (which hosted
 * tools a profile mounts).
 *
 * Tool names never change here: a profile only leaves tools out.
 */

export { TOOLSETS, PROFILES, PROFILE_TOOL_LIMIT, type Toolset, type Profile } from "../core/tool-profiles.js";

const LOCAL_TOOLSETS: Partial<Record<Toolset, readonly string[]>> = {
  core: [
    "summer_search_library",
    "summer_read_library",
    "summer_library_feedback",
    "summer_get_agent_playbook",
    "summer_start_game_task",
    "summer_open",
  ],
  assets: [
    "summer_generate_3d",
    "summer_generate_audio",
    "summer_generate_image",
    "summer_generate_motion",
    "summer_generate_sfx_choices",
    "summer_generate_video",
    "summer_check_job",
    "summer_get_choices",
    "summer_slice_asset_sheet",
    "summer_get_studio_workflow",
    "summer_search_assets",
    "summer_list_my_assets",
    "summer_get_asset",
    "summer_get_asset_download_url",
  ],
  ship: ["summer_export_game", "summer_export_templates", "summer_publish_build", "summer_go_live", "summer_store_set_details", "summer_capture_gameplay"],
  // summer_view_set is in the catalog (engine.view_set, summer_call) for every profile.
  ui: ["summer_ui_actions", "summer_ui_activate", "summer_ui_screenshot", "summer_ui_tree", "summer_view_set"],
  // Create and open a project on this computer with no shell (the full profile;
  // the engine profile's clients have a shell, `summer dev`, and a tool cap).
  projects: ["summer_projects_create_local", "summer_projects_open_local"],
  // The Summer API (the assets and full profiles; the engine profile's clients
  // have a shell, `summer login` and `summer api`, and a tool cap).
  tools: ["summer_api_models", "summer_api_estimate", "summer_api_run", "summer_api_batch", "summer_api_job"],
};

const localToolset = new Map<string, Toolset>(
  Object.entries(LOCAL_TOOLSETS).flatMap(([set, names]) => names.map((name) => [name, set as Toolset] as const))
);

/** Hosted tool names by pattern, first match wins. Unknown names land in `other` (full only). */
const HOSTED_TOOLSETS: ReadonlyArray<[RegExp, Toolset]> = [
  [/^summer_(account|team)$/, "core"],
  [/^summer_(remove_background|update_asset|delete_asset|upload_image_\w+)$/, "assets"],
  [/^summer_tool_\w+$/, "tools"],
  [/^summer_(store_version_(begin_upload|sign_parts|complete)|build_(begin_upload|sign_parts|complete_upload))$/, "uploads"],
  [/^summer_(store_\w+|list_games)$/, "ship"],
  [/^summer_board_\w+$/, "board"],
  [/^summer_grow_\w+$/, "grow"],
  [/^summer_studio_\w+$/, "studio"],
  [/^summer_app_\w+$/, "apps"],
  [/^summer_(build_\w+|make_game|game|game_\w+|list_projects|get_project)$/, "cloud"],
];

/** The toolset a tool belongs to: local tools by the table above, hosted ones by name. */
export function toolsetOf(name: string, local: boolean): Toolset {
  if (local) {
    if (localToolset.has(name)) return localToolset.get(name)!;
    return name.startsWith("summer_app_") ? "apps" : "engine";
  }
  if (localToolset.has(name)) return localToolset.get(name)!;
  return HOSTED_TOOLSETS.find(([pattern]) => pattern.test(name))?.[1] ?? "other";
}

export interface ToolSelection {
  /** "custom" = toolsets given without a profile. */
  profile: Profile | "custom";
  /** null = every toolset (the full profile). */
  toolsets: ReadonlySet<Toolset> | null;
  /** Unknown names given in flags or env, for one warning line. */
  ignored: string[];
}

const splitList = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

/**
 * `summer mcp --profile <p> --toolsets <a,b>` (env SUMMER_PROFILE,
 * SUMMER_TOOLSETS). Without either: the full profile. `--toolsets` alone
 * selects those toolsets plus core; with a profile it adds to it. `all` is
 * every toolset. Unknown names are ignored and reported, never fatal: a
 * typo must not stop an agent's MCP server from starting.
 */
export function resolveToolSelection(
  options: { profile?: string; toolsets?: string } = {},
  env: NodeJS.ProcessEnv = process.env
): ToolSelection {
  const ignored: string[] = [];
  const profileName = (options.profile ?? env.SUMMER_PROFILE ?? "").trim().toLowerCase();
  const requested = splitList(options.toolsets ?? env.SUMMER_TOOLSETS);

  const profile = parseProfile(profileName);
  if (profileName && !profile) ignored.push(profileName);

  const extra = new Set<Toolset>();
  let all = false;
  for (const name of requested) {
    if (name === "all") all = true;
    else if ((TOOLSETS as readonly string[]).includes(name)) extra.add(name as Toolset);
    else ignored.push(name);
  }

  if (all || profile === "full" || (profile === null && extra.size === 0)) {
    return { profile: "full", toolsets: null, ignored };
  }
  if (profile === null) return { profile: "custom", toolsets: new Set<Toolset>(["core", ...extra]), ignored };
  return { profile, toolsets: new Set<Toolset>([...PROFILES[profile], ...extra]), ignored };
}

/**
 * Hosted 3.x status tools a limited profile leaves out because summer_go_live
 * answers the same question (what players get now on each platform, and
 * where each upload and download stands), so the local go-live tools fit
 * under PROFILE_TOOL_LIMIT without pushing hosted store tools over it. The
 * full profile keeps them, and store.status answers it on the v4 surface.
 */
export const SUPERSEDED_HOSTED_TOOLS: ReadonlySet<string> = new Set(["summer_store_releases", "summer_store_version_status"]);

/** True when the selection keeps this tool. */
export function selectionIncludes(selection: ToolSelection, name: string, local: boolean): boolean {
  if (selection.toolsets === null) return true;
  if (!local && SUPERSEDED_HOSTED_TOOLS.has(name)) return false;
  return selection.toolsets.has(toolsetOf(name, local));
}

// ── Annotations ──────────────────────────────────────────────────────────────

/**
 * Local tools carry the registry's five `authority` booleans
 * (library/tools/<slug>/resource.yaml). They say what a tool may touch, not
 * whether it only reads, so a few sets refine them; the result is the MCP
 * effect hints clients use for approvals.
 */

/** Tools whose only file output is an image or render for the agent; they never change the game. */
const EVIDENCE_ONLY = new Set([
  "summer_screenshot",
  "summer_debug_views",
  "summer_shot_sheet",
  "summer_zoom",
  "summer_scene_audit",
  "summer_game_probe",
  "summer_capture_gameplay",
  "summer_app_screenshot",
]);

/** Generation on Summer's servers: costs credits, creates new assets. */
const SPENDS_CREDITS = new Set([
  "summer_generate_3d",
  "summer_generate_audio",
  "summer_generate_image",
  "summer_generate_motion",
  "summer_generate_sfx_choices",
  "summer_generate_video",
]);

/** Network-only tools that change the person's Summer data (the rest of the network tools read). */
const NETWORK_WRITES = new Set([
  "summer_app_create",
  "summer_app_data",
  "summer_app_page",
  "summer_app_call",
  "summer_app_report_gap",
  "summer_app_update",
  "summer_slice_asset_sheet",
  "summer_store_set_details",
]);

/** Changes that only add something new, or only touch the editor view or the running game. */
const ADDITIVE_OR_TRANSIENT = new Set([
  "summer_add_node",
  "summer_create_scene",
  "summer_instantiate_scene",
  "summer_connect_signal",
  "summer_input_map_bind",
  "summer_import_asset",
  "summer_import_asset_by_id",
  "summer_import_from_url",
  "summer_import_from_url_batch",
  "summer_import_hdri",
  "summer_repeat_along",
  "summer_fabricate_3d",
  "summer_frame_nodes",
  "summer_frame_shot",
  "summer_save_scene",
  "summer_enable_plugin",
  "summer_export_game",
  "summer_export_templates",
  "summer_create_debug_report",
  "summer_library_feedback",
  "summer_app_create",
  "summer_app_report_gap",
  "summer_app_dock",
  "summer_slice_asset_sheet",
  "summer_open_scene",
  "summer_open_main_scene",
  "summer_select_node",
  "summer_view_set",
  "summer_clear_console",
  "summer_play",
  "summer_stop",
  "summer_game_control",
  "summer_game_input",
  "summer_runtime_animate",
  "summer_runtime_call",
  "summer_runtime_set",
  "summer_runtime_spawn",
]);

/** Changes where a second identical call has no further effect. */
const IDEMPOTENT_WRITES = new Set([
  "summer_store_set_details",
  "summer_set_prop",
  "summer_set_resource_property",
  "summer_project_setting",
  "summer_remove_node",
  "summer_write_file",
  "summer_create_scene",
  "summer_save_scene",
  "summer_open_scene",
  "summer_open_main_scene",
  "summer_select_node",
  "summer_view_set",
  "summer_clear_console",
  "summer_stop",
  "summer_enable_plugin",
  "summer_place_adjacent",
  "summer_attach_to_surface",
  "summer_connect_ports",
  "summer_align_distribute_3d",
  "summer_snap_to_surface",
  "summer_camera_bookmark",
  "summer_frame_nodes",
  "summer_runtime_set",
  "summer_export_game",
  "summer_export_templates",
  "summer_app_update",
  "summer_app_dock",
]);

/** Every name the refinement sets mention (a test checks each is a real tool). */
export const ANNOTATION_REFINEMENTS: ReadonlySet<string> = new Set([
  ...EVIDENCE_ONLY,
  ...SPENDS_CREDITS,
  ...NETWORK_WRITES,
  ...ADDITIVE_OR_TRANSIENT,
  ...IDEMPOTENT_WRITES,
]);

export type Authority = Partial<Record<"filesystem" | "editor_mutation" | "network" | "credentials" | "publish", boolean>>;

/** MCP annotations for one local tool from its registry authority. */
export function annotationsFor(name: string, authority: Authority): ToolAnnotations {
  const openWorldHint = Boolean(authority.network || authority.publish);
  if (authority.publish) {
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  }
  if (SPENDS_CREDITS.has(name)) {
    return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  }
  const writes =
    !EVIDENCE_ONLY.has(name) &&
    Boolean(authority.filesystem || authority.editor_mutation || authority.credentials || NETWORK_WRITES.has(name));
  if (!writes) {
    return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint };
  }
  return {
    readOnlyHint: false,
    destructiveHint: !ADDITIVE_OR_TRANSIENT.has(name),
    idempotentHint: IDEMPOTENT_WRITES.has(name),
    openWorldHint,
  };
}

let authorityCache: Map<string, Authority> | null = null;

/** Registry authority per MCP tool name (registry/generated/index.json). */
export function registryAuthorities(): Map<string, Authority> {
  if (authorityCache) return authorityCache;
  const map = new Map<string, Authority>();
  try {
    for (const entry of loadLibraryIndex()) {
      if (entry.kind === "tool" && entry.mcp_tool_name && entry.authority) map.set(entry.mcp_tool_name, entry.authority);
    }
  } catch {
    // A broken install still serves tools; they go out without annotations.
  }
  authorityCache = map;
  return map;
}

// ── Output caps ──────────────────────────────────────────────────────────────

/** Default text cap for tools whose results can be large. */
export const DEFAULT_MAX_CHARACTERS = 4_000;

/**
 * Tools whose text results are capped by default, with their default cap.
 * Scene and runtime trees, console and debugger reads, inspect reads and
 * library reads. The scene tree and library reads get more room: a median
 * skill is about 12K characters, and cutting every skill read would double
 * the core search-then-read loop. Writes, job ids and file reads are never
 * capped.
 */
export const OUTPUT_CAPS: ReadonlyMap<string, number> = new Map([
  ["summer_get_scene_tree", 8_000],
  ["summer_get_runtime_tree", DEFAULT_MAX_CHARACTERS],
  ["summer_get_console", DEFAULT_MAX_CHARACTERS],
  ["summer_get_debugger_errors", DEFAULT_MAX_CHARACTERS],
  ["summer_get_debugger_warnings", DEFAULT_MAX_CHARACTERS],
  ["summer_inspect_node", DEFAULT_MAX_CHARACTERS],
  ["summer_inspect_resource", DEFAULT_MAX_CHARACTERS],
  ["summer_inspect_runtime_node", DEFAULT_MAX_CHARACTERS],
  ["summer_inspect_asset", DEFAULT_MAX_CHARACTERS],
  ["summer_read_library", 24_000],
]);

/**
 * A capped tool's input shape plus `maxCharacters`. server.ts adds it at
 * registration and strips it before the handler runs; the descriptor parity
 * test applies the same function, so library/tools/<slug>/resource.yaml
 * lists the argument too.
 */
export function withMaxCharactersArg<T extends Record<string, ZodTypeAny>>(name: string, shape: T): T {
  const cap = OUTPUT_CAPS.get(name);
  if (cap === undefined || "maxCharacters" in shape) return shape;
  return {
    ...shape,
    maxCharacters: z
      .number()
      .int()
      .min(500)
      .max(1_000_000)
      .optional()
      .describe(`Most characters of text to return (default ${cap}). A longer result is cut and says so.`),
  };
}

// ── Single scene edits ───────────────────────────────────────────────────────

/** One-change scene tools; a run of them is one summer_run_script. */
export const SINGLE_EDIT_TOOLS: ReadonlySet<string> = new Set([
  "summer_set_prop",
  "summer_add_node",
  "summer_remove_node",
  "summer_set_resource_property",
  "summer_instantiate_scene",
  "summer_connect_signal",
  "summer_replace_node",
]);

/** Calls that already batch edits; they end a run of single edits. */
export const BATCH_EDIT_TOOLS: ReadonlySet<string> = new Set([
  "summer_run_script",
  "summer_batch",
  "summer_run_editor_script",
]);
