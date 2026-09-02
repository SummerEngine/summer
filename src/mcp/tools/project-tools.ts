import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ASSET_POLICIES,
  GAME_TASK_MODES,
  GAME_TASK_TARGETS,
  VERIFICATION_LEVELS,
  buildGameTaskPlan,
} from "../../core/capabilities/game-task-plan.js";
import { buildCapabilitySkewWarning } from "../../core/capability-skew.js";
import { getCachedBootDriftNotice } from "../boot-notice.js";
import { appendMcpLogEvent } from "../../core/mcp-log.js";
import { getProjectMemorySummary } from "../../project-memory/project-memory.js";
import { withEngine } from "./with-engine.js";

type JsonRecord = Record<string, unknown>;

// One skew log line per MCP process — the warning itself stays in every
// summer_get_project_context payload.
let capabilitySkewLogged = false;

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

/**
 * The agent playbook — a product surface, not boilerplate. Structured on the
 * observe-first / verify-always skeleton that measurably steers agents:
 * observe-first step 0, screenshot before AND after every mutation batch,
 * priority-ordered content routing with scripting as the explicit last
 * resort, per-route anti-patterns, physical invariants, cost rules, and a
 * closing verification ritual. Exposed BOTH as the summer_get_agent_playbook
 * tool and as an MCP prompt (registerPlaybookPrompt) so prompt-surfacing
 * hosts get it natively. Exported for tests.
 */
export function buildAgentPlaybook(): Record<string, unknown> {
  return {
    summerUpdateNotice: getCachedBootDriftNotice()?.text ?? null,
    // ------------------------------------------------------------------
    // STEP 0 — OBSERVE FIRST. Before anything else, every session, and
    // before EVERY mutation batch.
    // ------------------------------------------------------------------
    step0_observeFirst: [
      "Before anything, call summer_get_project_context — it returns project/scene paths, .summer memory, and BINDS this session to the open project (see projectBinding). Never guess scene filenames.",
      "Then call summer_world_snapshot and keep its snapshot_id: a compact structured read of the whole scene (paths, classes, transforms, world AABBs, counts, resource fingerprints). It is cheap — run it BEFORE and AFTER every mutation batch and diff the two with summer_snapshot_diff.",
      "Use projectMemory from summer_get_project_context to decide which .summer Markdown files to read before creative/audio/dialogue/level/character work. Never change priority: locked memory without explicit user confirmation.",
      "Understand the request and outline a brief plan before reaching for mutating tools.",
    ],
    // ------------------------------------------------------------------
    // VISUAL VERIFICATION — pixels are the second signal.
    // ------------------------------------------------------------------
    visualVerification: [
      "Use summer_screenshot BEFORE making changes to see the current state, and AFTER every mutation batch or asset import to verify the result. Two signals, two jobs: summer_snapshot_diff proves exact structural facts; the screenshot proves appearance. Run both.",
      "For lighting, mood, environment, or emissive materials, use summer_screenshot target:'scene' framing:'camera' — it renders through the scene's OWN camera with its REAL WorldEnvironment. The preset framings (iso/top/...) substitute a flat preview environment and CANNOT verify lighting.",
      "When executing multiple batches, screenshot between them — catch the wrong turn at batch 2, not batch 7.",
      "If something looks wrong in the screenshot or the diff, investigate and fix before proceeding. Do not stack more work on a broken base.",
    ],
    // ------------------------------------------------------------------
    // LIBRARY FEEDBACK — report how the library entries you used worked out.
    // ------------------------------------------------------------------
    libraryFeedback: [
      "At a natural checkpoint, call summer_library_feedback once with every skill/example/reference you loaded: outcome 'worked' only after in-engine verification (diff + screenshot), 'worked_with_fixes' with the deviation, 'wrong'/'outdated'/'incomplete' when the entry misled you.",
      "Fire-and-forget and privacy-bounded (entry IDs + outcome enums + short notes about the ENTRY, never the project). Honors SUMMER_NO_TELEMETRY=1 / DO_NOT_TRACK=1.",
    ],
    // ------------------------------------------------------------------
    // CONTENT ROUTING — priority-ordered. Scripting geometry by hand is
    // the LAST resort, not the default.
    // ------------------------------------------------------------------
    contentRouting: {
      priorityOrder: [
        "1_reuseProjectAssets",
        "2_assetLibraryImport",
        "3_generation",
        "4_scripting_LAST_RESORT",
      ],
      "1_reuseProjectAssets": {
        when: "Always check first. The project may already contain the model/texture/audio you need — or an instance you can duplicate.",
        how: "summer_world_snapshot counts + scene_file entries show what is already instanced; the fs-tree/read tools and summer_list_my_assets show what is already imported or previously generated.",
        antiPatterns: [
          "Regenerating an asset the project already has — duplicate the existing instance instead (a summer_run_script loop can clone and re-place it in one call).",
        ],
        fallBackWhen: "Nothing suitable exists in the project.",
      },
      "2_assetLibraryImport": {
        when: "Any recognizable object: props, furniture, vehicles, characters, vegetation, buildings. ESPECIALLY organic shapes — imported meshes beat hand-scripted geometry by miles.",
        how: "summer_search_assets (sources: library/community/my_assets) -> summer_import_asset or summer_import_asset_by_id -> instance it. When instancing an imported .glb, pass target_size to summer_instantiate_scene (chair 1.0, door 2.0, car 4.5, person 1.7) so the asset lands at a plausible physical size; the receipt reports dimensions + scale_applied.",
        antiPatterns: [
          "Importing without a target_size and eyeballing scale from a screenshot — commit to real-world size, then verify AABBs.",
          "Importing one asset per prop when a handful of kit pieces can be duplicated and recombined.",
        ],
        fallBackWhen: "No suitable asset in the library, or the user wants something the search cannot match.",
      },
      "3_generation": {
        when: "A custom or unique SINGLE item no library has (summer_generate_3d / summer_generate_image / summer_generate_audio). Generation is metered — respect the session's asset policy and ask before paid generation when unsure.",
        how: "Generate -> summer_check_job until the state is TERMINAL (never proceed on a pending job) -> summer_get_asset -> summer_import_asset_by_id -> instance with target_size -> CHECK the world AABB and adjust position/rotation.",
        antiPatterns: [
          "Never generate the whole scene in one shot — generation is for single items; composition happens in the scene.",
          "Do not generate ground/terrain — script a plane/heightfield or import a kit.",
          "Do not generate parts of one object separately and try to assemble them afterwards.",
        ],
        fallBackWhen: "Generation is unavailable/denied by policy, fails, or the item is a simple primitive.",
      },
      "4_scripting_LAST_RESORT": {
        when: [
          "A simple primitive or blockout is explicitly wanted (boxes, floors, CSG shapes).",
          "No suitable asset exists in the project or library and generation is unavailable, failed, or not worth the cost.",
          "The task is inherently procedural: scattering/duplicating EXISTING assets, grids, GridMap fills, lighting rigs, cameras, environment setup, basic materials/colors.",
        ],
        how: "summer_run_script (the scene-scripting skill has the recipes and the ctx helper API). Placement math, duplication loops, and rigs are scripting's home turf — hand-modeling detailed geometry is not.",
        antiPatterns: [
          "Never generate the whole scene in one script — build in small verified batches: script -> diff -> screenshot -> next.",
          "Don't hand-model organic shapes (characters, creatures, trees, rocks) with SurfaceTool/CSG — import them (route 2).",
          "Don't fake lighting with emissive materials when a light rig is wanted.",
        ],
      },
    },
    // ------------------------------------------------------------------
    // PHYSICAL INVARIANTS — hold after EVERY placement/import.
    // ------------------------------------------------------------------
    physicalInvariants: [
      "ALWAYS check world AABBs (summer_world_snapshot per-node aabb) after placing or importing: objects that should not clip must not clip, nothing floats above the ground it should rest on, nothing is buried in it.",
      "Spatial relationships must be plausible: a lamp ON the desk, a chair AT the table, wheels TOUCHING the road. Verify with AABBs (facts) plus a screenshot (appearance) — not either alone.",
      "Commit to real-world scale at import time (target_size), then verify: a door around 2 units, a person around 1.7. If the AABB says 40, the import scale is wrong — fix it before composing around it.",
    ],
    // ------------------------------------------------------------------
    // COST RULES.
    // ------------------------------------------------------------------
    costRules: [
      "Duplicate is cheaper than regenerate: reuse previously generated/imported assets by duplicating nodes in a script — never re-run a paid generation for the same item.",
      "Generation is metered; import and reuse are not. Exhaust routes 1-2 before route 3, and batch what you can.",
      "Engine calls are cheap; YOUR context is not: prefer summer_world_snapshot + summer_snapshot_diff (compact, capped, fingerprinted) over repeated full-tree dumps.",
    ],
    // ------------------------------------------------------------------
    // Verification ladder (climb only as high as the change demands).
    // ------------------------------------------------------------------
    verificationLadder: {
      "1_compiles": [
        "After writing/editing a .gd file, call summer_get_script_errors <path> — compiles without running the game.",
        "For a project-wide sweep of editor + runtime issues, call summer_get_diagnostics (it tells you whether to then read summer_get_console / summer_get_debugger_errors).",
      ],
      "2_looks_right": [
        "Structured: summer_snapshot_diff against your pre-mutation snapshot_id — exactly what was added/removed/changed, and nothing else.",
        "To SEE the result, call summer_screenshot. Pick the target deliberately:",
        "  target:'viewport' (default) = the editor's CURRENT open tab, exactly as it looks now. Edit-time check. No game boot.",
        "  target:'scene' = an OFFSCREEN render of a scene FILE (pass scenePath). No game boot; physics/particles/animations are STATIC at t=0. Best for 'is the composition/scale right' without disturbing the open tab. It confesses if the scene has no Camera3D or no light — READ those warnings.",
        "  target:'scene' framing:'camera' = through the scene's OWN camera with the REAL environment — the trustworthy edit-time lighting/mood check.",
        "  target:'game' = a frame from the RUNNING game (real runtime state). summer_play FIRST. Over a plain local HTTP connection this returns an honest failure (needs the Summer desktop bridge); when it fails, fall back to viewport/scene or ask the user.",
      ],
      "3_runs": [
        "Compose the run-and-check yourself — there is no single 'verify' tool:",
        "summer_play [scene]   -> boot the game (or a specific scene)",
        "summer_get_debugger_errors  -> runtime errors (null refs, missing nodes, physics)",
        "summer_get_runtime_tree / summer_inspect_runtime_node  -> LIVE runtime structure and node state (spawned enemies, autoloads, actual stats) without stopping the game",
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
      "target:'scene' with preset framings is STATIC (t=0), uses a synthetic camera and a FLAT environment — do not claim animation/particles/lighting/mood from it; framing:'camera' is the honest lighting view. Heed the no-camera / no-light / synthetic-camera warnings.",
      "Claim only what a diff or frame proved: 'the snapshot diff shows 40 trees added and the screenshot shows them on the terrain' — not 'the forest looks great' from imagination.",
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
      "summer_get_project_context also surfaces a capabilitySkewWarning when the engine build and this CLI have drifted apart — non-fatal; tools whose op the engine provably lacks return a structured engine_lacks_op result (nothing is sent) naming the fallback.",
    ],
    safeDefaults: [
      "Never guess scene filenames (main.tscn/Main.tscn) -- get them from summer_get_project_context.",
      "Use summer_replace_text for existing project text and summer_write_file with create_only:true for new files; overwrites require the sha256 from summer_read_file.",
      "For live scene hierarchy and inspector changes, prefer scene tools. Guarded text writes support .tscn/.tres, and the engine schedules editor reloads after they land.",
      "Write GDScript by default; use C# only if the project already uses it.",
      "Never remove multiple top-level nodes unless the user explicitly requests destructive edits.",
      "Never change priority: locked .summer memory, voice IDs, canon, or provider bindings without explicit user confirmation.",
    ],
    liveEngineFlow: [
      "Use this flow when you genuinely need live engine state (navmesh/light bake, scene mutation, runtime inspect):",
      "summer_get_project_context",
      "Choose the exact res:// scenePath. OpenScene is a user-visible tab action, not a mutation prerequisite.",
      "summer_world_snapshot (keep the snapshot_id) — or summer_get_scene_tree with scenePath for the hierarchy view.",
      "summer_add_node / summer_set_prop / summer_set_resource_property with scenePath — or one summer_run_script for anything computed.",
      "Mutation tools append one final SaveScene; use summer_save_scene only for a standalone save/save-as.",
      "summer_snapshot_diff from_id:<the id> + summer_screenshot — then summer_get_diagnostics.",
    ],
    // summer_batch forwards each {op, ...} verbatim to the engine, so
    // engine ops that have no dedicated tool are still reachable.
    rawOpsViaBatch: [
      "summer_batch runs an array of raw engine ops in one undo group; each op is passed through untouched, so newer engine ops with no dedicated tool are still callable.",
      "RunVerification (hidden probe instance): summer_batch ops:[{op:'RunVerification', probe_source:'<gdscript>', max_seconds:20}]. probe_source extends SummerProbeBase and uses report(name, value)/save_frame(name)/press(action)/key(keycode)/finish(); returns {ok, results, frames, out_dir} or {ok:false, failure_reason: spawn_failed|timeout|bad_args|no_project|probe_not_node}. save_frame REQUIRES a name argument.",
      "SimulateInput (drive the RUNNING game — summer_play first): summer_batch ops:[{op:'SimulateInput', type:'action', action:'jump', pressed:true}], sent ALONE as the only op. failure_reason 'not_running' = start the game first; 'unsupported' = the running game build predates the handler — use RunVerification instead.",
      "SINGLE-OP CONTRACT: the engine rejects any multi-op batch containing SaveScene, InstantiateScene, ReplaceNode, SimulateInput, ViewportSnapshot, GameSnapshot, GetRuntimeSceneTree, GetRuntimeNode, Run*/Import* or Git* ops (failure_reason 'unsupported_transport', nothing executes). summer_batch splits these into sequential requests for you; when composing raw batches keep them as their own call anyway.",
      "WriteFile and ReplaceText are rejected here by design — use summer_write_file / summer_replace_text so project identity, content guards and same-file ordering are enforced.",
      "You do not need an engine op to run a shell command: your own host already has a shell. The engine binary that runs project scripts is at OS.get_executable_path() (on macOS, /Applications/Summer.app/Contents/MacOS/Summer); see the summer-cli headless-scripting skill.",
      "These are runtime ops, not scene mutations — the batch undo group is a harmless no-op for them.",
    ],
    // Scene scripting: when one GDScript beats a chain of CRUD ops.
    scripting: [
      "Single property tweak -> summer_set_prop. Composition or ANY computed placement (3+ related ops, scatter/grids/rings, procedural meshes, bulk edits) -> summer_run_script: one GDScript `func run(ctx):` executed in the LIVE editor against the OPEN scene, with ctx.get_scene_root() / ctx.report(key, value) / print capture.",
      "OWNERSHIP in scripts: call ctx.set_owner_recursive(node) AFTER add_child on every created subtree (manual form: node.owner = root on the node AND each descendant), or the nodes silently vanish on save. The ctx creation helpers (ctx.add_node, ctx.add_mesh, ctx.instance_scene, ...) set the owner for you — prefer them.",
      "Cold batch/project-wide jobs (re-save every scene, resource sweeps, long bakes) -> summer_run_editor_script: a fresh HEADLESS child editor against the ON-DISK project. Unsaved live edits are invisible to it; it has no renderer, so it can never screenshot.",
      "Property/method/signal lookup -> summer_api_docs (offline class reference, stamped with the engine technical base it was generated from). Verify names before scripting instead of guessing; entries list declared members only, so walk `inherits` for inherited ones.",
      "The loop: summer_world_snapshot -> summer_run_script -> summer_snapshot_diff + summer_screenshot -> iterate. The scene-scripting skill carries the recipes (scatter, SurfaceTool, CSG, GridMap, lighting rigs) and the ctx helper API; the verifying-scenes skill carries the perception discipline.",
    ],
    recovery: [
      "If a scene mutation reports missing_scene_path: pass the exact res:// scenePath and retry.",
      "If a scene target cannot load: repair the named missing/invalid dependency, then retry the same scenePath.",
      "If open_scene fails: re-check mainScene from summer_get_project_context.",
      "If save fails: use the returned scenePath/error to repair the exact cause. A running game alone is not a generic scene-mutation blocker.",
      "If a mutation is rejected with identity_mismatch: the engine switched projects — call summer_get_project_context to rebind (only if you meant to follow it), then retry.",
      "If a guarded file mutation is rejected with content mismatch: call summer_read_file again, review the new content, and retry with its new sha256 only if the edit is still valid.",
      "If a tool returns failure_reason engine_lacks_op, or a run op returns 'unsupported' / an unknown-op error: this engine build predates it — the result names the fallback (e.g. summer_run_editor_script for RunSceneScript); otherwise fall back to summer_play + summer_get_debugger_errors. Update Summer Engine to clear the skew.",
      "If summer_snapshot_diff fails with unknown_snapshot: the id expired (engine keeps the last 8 per session) — take a fresh summer_world_snapshot baseline and redo the before/after pair.",
      "If a runtime read fails with game_not_running: start the game with summer_play, then re-run; for edited-scene structure use summer_get_scene_tree instead.",
      "If a script hits its budget ('Summer script budget exceeded'): the engine rolled the undo action back when undo:'action' was in effect (result rolled_back:true) — split the work into smaller scripts and re-run piece by piece; never resubmit the same oversized script.",
      "If any op returns 'unsupported_transport': it was batched with other ops. Resend it as the ONLY op in the request (nothing from the rejected batch was applied).",
    ],
    debugging: [
      "Set SUMMER_MCP_DEBUG=1 in the MCP server's environment to log a structured stderr line per tool call (tool, ok, durationMs, terminalState, errorClass, failureReason, retried, boundProjectIdHash). With the flag OFF, only failures are logged. Use it to see exactly which op failed and why.",
    ],
    // ------------------------------------------------------------------
    // CLOSING RITUAL — before claiming a task done.
    // ------------------------------------------------------------------
    verificationRitual: [
      "1. summer_snapshot_diff against the snapshot_id you took before the work — the structural receipt: exactly the intended nodes changed, nothing vanished, counts add up.",
      "2. summer_screenshot AFTER completing the task (framing:'camera' when lighting/mood was touched) — and LOOK at it.",
      "3. summer_get_diagnostics — no new errors/warnings.",
      "4. Claim only what steps 1-3 proved, citing them. A claim without its diff/frame/diagnostics is not a verification, it is a hope.",
    ],
  };
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
        const boundProjectIdHash = await client.rebind();

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
