/**
 * The agent playbook — a product surface, not boilerplate. Structured on the
 * observe-first / verify-always skeleton that measurably steers agents:
 * observe-first step 0, screenshot before AND after every mutation batch,
 * priority-ordered content routing with scripting as the explicit last
 * resort, per-route anti-patterns, physical invariants, cost rules, and a
 * closing verification ritual.
 *
 * ONE implementation for every surface (CONTRACT §2): the MCP
 * summer_get_agent_playbook tool and summer_agent_playbook prompt
 * (src/mcp/tools/project-tools.ts) and `summer tool get-agent-playbook`
 * (tool-dispatch.ts) all render this. Surface-owned extras — the MCP boot
 * drift notice — are passed in, never imported: core does not know mcp.
 */
export interface AgentPlaybookOptions {
  /** The MCP layer's cached "Summer update available" notice, if any. */
  summerUpdateNotice?: string | null;
}

export function buildAgentPlaybook(
  options: AgentPlaybookOptions = {}
): Record<string, unknown> {
  return {
    summerUpdateNotice: options.summerUpdateNotice ?? null,
    // ------------------------------------------------------------------
    // STEP 0 — OBSERVE FIRST. Before anything else, every session, and
    // before EVERY mutation batch.
    // ------------------------------------------------------------------
    step0_observeFirst: [
      "Before anything, call summer_get_project_context — it returns project/scene paths, .summer memory, and BINDS this session to the open project (see projectBinding). Never guess scene filenames.",
      "Then read the scene. IF the engine advertises GetWorldSnapshot (summer_get_project_context returns no capabilitySkewWarning naming it — and the build is new enough to have summer_world_snapshot at all): call summer_world_snapshot and keep its snapshot_id — a compact structured read of the whole scene (paths, classes, transforms, world AABBs, counts, resource fingerprints); run it BEFORE and AFTER every mutation batch and diff the two with summer_snapshot_diff. OTHERWISE (older engine, or the tool returns failure_reason engine_lacks_op / an unknown-op error): use summer_get_scene_tree with scenePath for structure and summer_inspect_node for transforms, and verify with summer_screenshot — do not keep retrying summer_world_snapshot.",
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
        how: "summer_search_assets (source: library | my_assets | all) -> summer_import_asset or summer_import_asset_by_id -> instance it. When instancing an imported .glb, pass target_size to summer_instantiate_scene (chair 1.0, door 2.0, car 4.5, person 1.7) so the asset lands at a plausible physical size; the receipt reports dimensions + scale_applied.",
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
        "summer_game_probe / summer_game_control / summer_game_input / summer_runtime_set|call|spawn|animate  -> runtime-control engine builds only (engine_lacks_op otherwise): probe ONE frame (state + pixels, frame-stamped), pause/step exact frames, script or record/replay input, set/call/spawn/animate live nodes. The agent-playtesting skill is the loop: summer_play (seed/fixed_fps; instance + mode:'offscreen' for a parallel instance) -> probe -> act -> step/probe -> assert. Never claim motion without a probe of the frame after.",
        "summer_screenshot target:'game'  -> optional visual of the live frame",
        "summer_stop  -> stop when runtime verification is finished; editor scene mutations are not categorically blocked by a running game, but an existing game instance may need a restart to observe them",
      ],
      "4_interactive": [
        "To prove input-driven behavior (does jump/move/shoot actually work), prefer RunVerification — a scripted, repeatable probe. SimulateInput is also reachable as a single op against the RUNNING game (see rawOpsViaBatch); do NOT hand this rung to the user while either route works.",
        "On a runtime-control engine build, summer_game_input action:'script' drives the LIVE game with timed events ({at_frame, type:'action'|'key'|'mouse_click'|'axis'|'raw', ...}); record_start/record_stop capture real input and replay plays it back (seed only on a deterministic offscreen instance). One script in flight per instance (busy). Pair every script with summer_game_probe before and after, or summer_game_control action:'step' for the exact frame.",
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
      "SINGLE-OP CONTRACT: the engine rejects any multi-op batch containing SaveScene, InstantiateScene, ReplaceNode, SimulateInput, ViewportSnapshot, GameSnapshot, GetRuntimeSceneTree, GetRuntimeNode, the runtime-control ops (SetRuntimeProp, CallRuntimeMethod, SpawnRuntimeScene, FreeRuntimeNode, RuntimeAnimation, RuntimeAnimationTree, GetRuntimeBones, GamePause, GameStep, GameSpeed, SimulateInputScript, InputRecordStart, InputRecordStop, InputReplay, GameProbe), Run*/Import* or Git* ops (failure_reason 'unsupported_transport', nothing executes). summer_batch splits these into sequential requests for you; when composing raw batches keep them as their own call anyway.",
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

export function renderAgentPlaybook(options: AgentPlaybookOptions = {}): string {
  return JSON.stringify(buildAgentPlaybook(options), null, 2);
}
