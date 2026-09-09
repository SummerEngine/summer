# Summer MCP Tools — Canonical Reference

> Use this as the single source of truth for which Summer MCP tool to call. Skills should reference tool names exactly as written here.

## When to use Summer MCP vs. host tools

**Use Summer MCP for** anything that needs the live editor or Godot's import pipeline:
- Scene graph mutation (`.tscn`)
- Node properties and resources (`.tres`)
- Project settings (`project.godot`) and InputMap
- Asset import (Godot's import pipeline must run)
- Play / stop / runtime state
- Diagnostics, console, debugger output, script errors
- Project text reads and guarded writes (`.gd`, `.cs`, `.tscn`, `.tres`, JSON, docs, config)

**Use host tools for** git, shell, grep, and non-project work. External host file writes bypass Summer's project-identity, sha256, and editor-reload safeguards and should not be used for project mutations while MCP is available.

**Rule of thumb:** project reads/writes go through Summer; live hierarchy/inspector changes use scene tools; process-level work remains with the host.

## Tool surface (86 tools)

### Project files (3)

| Tool | Use |
|---|---|
| `summer_read_file` | Read project text plus a full-file sha256 receipt. |
| `summer_write_file` | Create-only or sha256-guarded complete file write. |
| `summer_replace_text` | Unique (or explicit replace-all) text mutation with read/sha guard. |

### Scene graph (11)

| Tool | Use |
|---|---|
| `summer_get_scene_tree` | Read current scene graph. Always do this before mutating. |
| `summer_open_main_scene` | Open the project's main scene. |
| `summer_open_scene` | Open a specific `.tscn`. |
| `summer_open` | Navigate for the user: open a summerengine.com page (billing, my games, pricing, an MCP guide) or an editor surface (scene, node, script, file, a dock) by intent name, or `print` the URL / op. Destinations: the `product-map` reference; when to use it: the `navigate-summer` skill. |
| `summer_create_scene` | Create a new scene. |
| `summer_instantiate_scene` | Add an existing scene or 3D model as a child node. |
| `summer_inspect_node` | Read a single node's properties. |
| `summer_add_node` | Add a node to the explicit `scenePath`; the tab need not be open. |
| `summer_remove_node` | Remove a node from the explicit `scenePath`. |
| `summer_replace_node` | Swap a node's type in the explicit `scenePath`, preserving children. |
| `summer_select_node` | Set editor selection (visual feedback for the user). |
| `summer_save_scene` | Explicitly save/save-as a `scenePath`; mutation tools already append one final save. |

### Properties / resources (4)

| Tool | Use |
|---|---|
| `summer_set_prop` | Set a typed property in an explicit `scenePath` using Godot's `str_to_var()`. |
| `summer_set_resource_property` | Set a nested resource property in an explicit `scenePath`. |
| `summer_inspect_resource` | Read a resource's properties. |
| `summer_connect_signal` | Wire a signal between nodes. |

### Project & input (2)

| Tool | Use |
|---|---|
| `summer_project_setting` | Modify `project.godot` settings (rendering, physics). |
| `summer_input_map_bind` | Bind input actions in InputMap. Folds in the legacy `add_action` step. |

### Import pipeline (2)

| Tool | Use |
|---|---|
| `summer_import_from_url` | Download a `.glb`/`.png`/etc and run Godot's full import pipeline. |
| `summer_import_from_url_batch` | Same, batched (single filesystem scan). |

### Scene scripting (3)

| Tool | Use |
|---|---|
| `summer_run_script` | Run a GDScript (`func run(ctx):`) inside the live editor against the OPEN scene. Prefer it over 3+ CRUD ops or any computed placement (scatter, procedural meshes, bulk edits). Created nodes need `ctx.set_owner_recursive(node)` after `add_child`. |
| `summer_run_editor_script` | Run an EditorScript (`func _run():`) in a fresh headless child editor against the ON-DISK project. Cold path for batch/project-wide jobs; unsaved live edits are invisible to it. |
| `summer_api_docs` | Offline class-reference lookup (properties, methods, signals, constants). Verify names before scripting instead of guessing; works without the engine. |

### Mesh fabrication (1)

| Tool | Use |
|---|---|
| `summer_fabricate_3d` | Run a Blender Python (bpy) script in the user's OWN installed Blender — headless, engine-supervised — then import the exported `.glb` into `res://` and optionally instantiate it with `target_size`. For modular kits with exact dimensions, VFX meshes (shatter, sweeps, LOD chains), and post-processing generated models (decimate/UV/bake); generic props go to the library and characters to generation. Requires Blender on the machine (never bundled); `blender_not_found` carries the fix. The `fabricating-assets` skill has the bpy rules that survive glTF export. |

### Editor UI control (4)

Preview — the `Ui*` engine ops ship with a follow-up engine build; until then these return `engine_lacks_op`. Semantic first: scene work never goes through the editor UI (use the scene, scripting, and perception tools). UI ops are for editor-workflow steps a human does with the mouse — open Project Settings, switch the main screen, clear a blocking dialog, read a dock. Ladder: dedicated tool → named action → tree + activate → screenshot (pixels last, never for coordinates). Quit / project-reload / delete-without-confirm actions are denied by the engine. The `driving-the-editor-ui` skill carries the patterns.

| Tool | Use |
|---|---|
| `summer_ui_actions` | `mode:"list"` enumerates the editor's named actions (`name`, `label`, `shortcut_text`, `category`, `denied?`); `mode:"invoke" action_name:"editor/project_settings"` runs one exactly as its menu item / shortcut would and reports `handled`, `via`, `opened_dialog`. Failures: `unknown_action` (+`close_matches`), `denied_action`, `modal_open` (+`blocking_dialog`), `not_handled`. |
| `summer_ui_tree` | Structured Control tree of the live editor UI (class, path, rect, text/tooltip, `checked`/`enabled`/`tabs`/`current_tab`/`value`) from `root:"main" \| "window" \| "dock:<title\|id>" \| "dialog:<title>" \| "path:<node path>"`; `root:"dialogs"` lists every visible dialog/popup with `blocking`, `blocking_dialog`, and its `buttons`. The token-cheap alternative to a screenshot; its paths are what `summer_ui_activate` takes. |
| `summer_ui_activate` | Activate one control by tree path through its own input path — `press`, `toggle`, `focus`, `select_tab` (incl. `path:"main_screen" value:"3D"`), `set_text` (+`submit`), `set_value` — and `action:"dismiss_dialog"` (by `path` or `title`, `button` cancel/ok/text) to clear a blocking dialog. `state` / `visible_after` are read back after the action, never echoed. |
| `summer_ui_screenshot` | PNG of the editor window or one dock/dialog/control (`root`, `max_size`) returned as an image — the pixels-last fallback for LOOKING at the editor UI. Not for scene verification (`summer_screenshot`) and never for picking click coordinates. Honest `no_renderer` under a headless editor. |

### Perception (4)

| Tool | Use |
|---|---|
| `summer_world_snapshot` | Compact structured snapshot of the edited scene (paths, classes, transforms, world AABBs, visibility, resource fingerprints, light/camera/counts summary). The cheap read to run BEFORE and AFTER every mutation batch; keep the `snapshot_id`. |
| `summer_snapshot_diff` | Diff two snapshots into added/removed/changed + count deltas — the structural receipt that a mutation did exactly what was intended. Omit `to_id` to diff against a fresh snapshot taken now. |
| `summer_get_runtime_tree` | Scene tree of the RUNNING game (spawned enemies, autoloads, pooled nodes) — live state the editor reads can't show. Needs `summer_play` first. |
| `summer_inspect_runtime_node` | One running-game node's live properties (actual stats/position/flags) without stopping the game. Get paths from `summer_get_runtime_tree`. |

### Spatial / world building (5)

Bounded spatial evidence for deliberate 3D arrangement. All five take exact `scenePath` + scene-root-relative node paths (editor selection is never consulted) and return a compact receipt under 5 KB (`summer_starcast` full detail: at most 12 KB). Read `skill/world-building-3d` for each tool's evidence boundary before the first call, and `skill/spatial-placement` for the inspect -> place -> starcast -> correct -> verify loop.

| Tool | Use |
|---|---|
| `summer_test_placement` | Ghost-test one node at a candidate global pose (read-only, never saves): overlap evidence, grounded state, signed floor gap. `fits: null` means physics could not prove clearance — never coerce it to success. |
| `summer_snap_to_surface` | Seat one subject on the first surface along a world ray (default downward); mutation + save. `evidence: physics` = collider sweep; `visual_aabb` = mesh-only broad-phase fallback. |
| `summer_align_distribute_3d` | Align (min/center/max) or equal-space (centers/gaps) 2–16 ordered subjects along one world axis from visible AABBs; mutation + save. One-axis evidence only. |
| `summer_navigation_probe` | Read-only reachability between two world points on the scene's navigation map: readiness, snapped endpoints + snap distances, route length, ≤16 route points. `ready: false` = unknown, not unreachable. |
| `summer_starcast` | Read-only 26-direction placement rundown around one exact node: per-direction `open`/`blocked` with nearest object, distance and evidence, contact-or-overlap paths, `grounded`, coverage, warnings. `detail: summary` ≤ 5 KB; `full` adds hit geometry, an objects table and nearby lists ≤ 12 KB and downgrades to summary rather than exceed it. `visual_aabb` evidence is broad-phase, never exact contact. |

### Play / runtime (3)

| Tool | Use |
|---|---|
| `summer_play` | Run the game. Plain = the editor's embedded main game. Optional `seed` / `fixed_fps` / `time_scale` pin THIS launch (newer engines); the result's `determinism.applied` + `seed_scope` say what was pinned — a missing block means the engine ignored the pins. `instance` + `mode:"offscreen"` (+ `deterministic:true`, `speed`) spawn a hidden parallel instance (at most 3) that the runtime-control tools address by name. |
| `summer_stop` | Stop the running game, or `instance` to stop one offscreen instance. |
| `summer_is_running` | Check play state before deciding to call `summer_stop`; the boot check after `summer_play` (never sleep a guessed delay). |

### Runtime control & playtest (7)

Drive and observe the RUNNING game (engine runtime-control ops, preview — `engine_lacks_op` on older builds names the fallback). Every tool needs a running game (`game_not_running` otherwise), takes `instance`, and is sent alone. The `agent-playtesting` skill is the doctrine: launch deterministically → probe → act → step/probe → assert; never claim motion, spawning or a state change without a probe of the frame after.

| Tool | Use |
|---|---|
| `summer_game_probe` | State AND pixels of ONE frame, atomically: live tree, up to 64 `path:property` reads, screenshot (returned as an image), all stamped with the same frame counters. The evidence read of the loop. |
| `summer_game_control` | `pause` / `resume` / `step` exactly N physics or process frames (leaves the game suspended) / `speed` / `instances` (live instances with `attached`). |
| `summer_game_input` | `script` timed synthetic input (action / key / mouse_click / axis / raw), `record_start` / `record_stop` real input to `res://.summer/replays/`, `replay` a recording (`seed` only on a deterministic offscreen instance). One script in flight per instance (`busy`). |
| `summer_runtime_set` | Set one property on a live node; `applied:false` means the read-back disagreed. Never touches the scene file. |
| `summer_runtime_call` | Call one method on a live node and get its return value. |
| `summer_runtime_spawn` | `spawn` a PackedScene into the live game, or `free` a live node. |
| `summer_runtime_animate` | AnimationPlayer (`player`), AnimationTree state machine (`tree`), Skeleton3D bone poses (`bones`) — read (`cmd:"state"`, default) or drive. |

### Events (2)

| Tool | Use |
|---|---|
| `summer_wait_for_event` | Block until a matching engine event arrives — `play.started` after `summer_play`, `op.applied` / `op.failed` for one `requestId` after a long op, `script.error` during a playtest, `scene.saved`, `import.completed` — or the timeout elapses (default 30 s, max 120). Returns the events, `next_seq`, and an honest `timed_out`; never claim an event you did not receive. Take a cursor with `summer_recent_events` first so a moment that arrives immediately is not missed. Preview: engines without the events channel return `engine_lacks_events`. |
| `summer_recent_events` | The newest engine events (or everything after `since`) in one zero-wait read; its `next_seq` is the `since` cursor to hand `summer_wait_for_event` before triggering the action you will wait on. Shell twin: `summer events [--follow]`. |

### Visual capture (2)

| Tool | Use |
|---|---|
| `summer_screenshot` | Capture a frame and return it as an image the agent sees directly — editor viewport (`target:"viewport"`, default; no play needed), offscreen scene render (`target:"scene"`, presets or `framing:"camera"` which renders through the scene's OWN camera with its REAL WorldEnvironment — the trustworthy edit-time lighting check), or running game (`target:"game"`). Newer engines add fixed poses — `framing:"bookmark"` + `bookmark_name` (saved with `summer_camera_bookmark`) or `framing:"free"` + `camera_position`/`camera_look_at` — for before/after frames that line up, and `marks:true` for numbered labels the caption maps to node paths. Use to visually verify scene layout, asset placement, scale, framing, lighting, or runtime state. On macOS the running game is a floating window that can't be captured; prefer `viewport`. |
| `summer_camera_bookmark` | Save (`action:"save"`, from the editor viewport camera or an explicit pose), list, or delete named camera viewpoints persisted in the project (`res://.summer/camera_bookmarks.json`). Save once, then screenshot from it with `framing:"bookmark"` every time. Returns `engine_lacks_op` on engines that predate the bookmark ops. |

### Diagnostics (7)

| Tool | Use |
|---|---|
| `summer_create_debug_report` | Create a support-ready Markdown report for `/summer debug`. |
| `summer_get_diagnostics` | Aggregate error/warning summary. Call after every change. |
| `summer_get_console` | Engine output panel. |
| `summer_clear_console` | Clear before a fresh play, so post-run output is clean. |
| `summer_get_debugger_errors` | Runtime errors with stack traces. |
| `summer_get_debugger_warnings` | Runtime warnings from the debugger panel. |
| `summer_get_script_errors` | Script compilation errors. |

### Asset library (8)

| Tool | Use |
|---|---|
| `summer_search_assets` | Free public asset search (community library + user's own). Sources: `library`, `community`, `my_assets`, `all`. |
| `summer_list_my_assets` | List/search the signed-in user's generated and uploaded assets. Empty query lists recent assets. |
| `summer_get_asset` | Fetch one exact asset by ID with file URL, download URL, viewer URL, metadata, license, and visibility. |
| `summer_get_asset_download_url` | Get the primary or thumbnail download URL for a specific asset. Stable shape for future signed URLs. |
| `summer_import_asset` | Search, choose the top match, download, run Godot import, and optionally instantiate 3D models. |
| `summer_import_asset_by_id` | Import one exact Summer asset ID. Use after generation jobs or when the user selects a specific asset. |
| `summer_import_hdri` | Search Poly Haven's CC0 HDRIs (public API, no Summer login), import the `.hdr`/`.exr` into `res://sky/`, and get the exact `summer_run_script` snippet that wires it as the WorldEnvironment sky. The cheapest whole-scene lighting upgrade. |
| `summer_slice_asset_sheet` | Detect and crop every distinct asset from a generated sheet image into named individual assets (works without the engine; import the results afterwards). |

### Asset generation (5 — metered)

| Tool | Use |
|---|---|
| `summer_generate_image` | AI image gen. |
| `summer_generate_3d` | Image-to-3D. |
| `summer_generate_audio` | SFX / music gen. |
| `summer_generate_video` | Video gen. |
| `summer_generate_motion` | Generate/apply 3D skeletal motion from a rigged asset. |

### Job tracking (2)

| Tool | Use |
|---|---|
| `summer_check_job` | Poll a generation job. |
| `summer_batch` | Run multiple ops as a transaction. |

### Meta (4)

| Tool | Use |
|---|---|
| `summer_start_game_task` | Route a user goal into the right workflow, skills, MCP tool groups, asset policy, gates, and verification path. |
| `summer_get_studio_workflow` | Discover Summer Studio's guided workflow recipes (starter prompts, ordered steps, required tools) for a goal. |
| `summer_get_project_context` | Project, scene, and `.summer` memory summary — call at start of session. Binds the session to the open project and surfaces a `capabilitySkewWarning` when the engine build and CLI have drifted; tools whose op the engine provably lacks return a structured `engine_lacks_op` result instead of running. |
| `summer_get_agent_playbook` | Daily operating contract (observe-first loop, content routing, invariants, verification ritual) — call at start of session. Also served natively as the `summer_agent_playbook` MCP prompt. |

### Creator platform (3)

| Tool | Use |
|---|---|
| `summer_creator_publish` | Compute the exact `.pck` digest and size, require user confirmation, then run versioned prepare → write-once upload → finalize. The server independently verifies `publish` scope, ownership, bytes, and review state. |
| `summer_creator_releases` | List real creator-owned releases from `summer.creator.v1`, with opaque cursor pagination. |
| `summer_creator_config` | Read or confirm updates to the shared non-secret `~/.summer/config.json`. It never accepts or returns tokens. |

### Library search (2)

| Tool | Use |
|---|---|
| `summer_search_library` | Search the library (skills, tools, templates, references, examples, collections) by describing the task in plain words; ranked ids with `matched_by` (lexical / semantic). The first move for any task; works without the engine. |
| `summer_read_library` | Load one entry by id: a skill's SKILL.md plus metadata, a tool's call recipe, a template's pin, a reference's body. The last line is the `entry_id` footer to report through `summer_library_feedback`. |

### Library feedback (1)

| Tool | Use |
|---|---|
| `summer_library_feedback` | Report library-entry outcomes (worked/wrong/outdated/...) so entries get fixed and re-ranked. Fire-and-forget with a 1s cap; enum-first schema with no field for project files, chat content, or code; honors `SUMMER_NO_TELEMETRY=1` and `DO_NOT_TRACK=1`. |

## Common pattern

Every scene-touching skill should follow this loop:

1. `summer_start_game_task` — route the goal into skills/tools/gates.
2. `summer_get_project_context` — orient.
3. `summer_get_agent_playbook` — read the rules.
4. Resolve the exact `res://` scene path; open it only for an intentional current-tab read/UI action.
5. Pass that `scenePath` to mutations (`summer_add_node`, `summer_set_prop`, `summer_connect_signal`, ...).
6. Mutation tools append one final `SaveScene`; use `summer_save_scene` directly only for a standalone save/save-as.
7. `summer_get_script_errors` — catch GDScript breakage.
8. `summer_play` → `summer_get_debugger_errors` → `summer_screenshot` (see what's on screen) → `summer_stop` if verifying runtime.

Every asset-generation skill should follow this loop:

1. `summer_search_assets` or `summer_list_my_assets` — reuse before generating when reasonable.
2. `summer_generate_image` / `summer_generate_3d` / `summer_generate_audio` — metered creation.
3. `summer_check_job` if the generation was async.
4. `summer_get_asset` — resolve the returned `assetId`, `rigAssetId`, or `animationAssetId`.
5. `summer_import_asset_by_id` — import the exact result into Godot's pipeline.
6. `summer_get_asset_download_url` — only when the user explicitly wants a downloadable file/link.

## summer_set_resource_property — nested properties

Use it to reach a property *of a resource attached to a node* — mesh size, shape radius, material colour — the thing `summer_set_prop` cannot reach.

```
summer_add_node(parent="/", type="MeshInstance3D", name="Box", scenePath="res://main.tscn")
summer_set_prop(path="Box", key="mesh", value="BoxMesh", scenePath="res://main.tscn")
summer_set_resource_property(
    nodePath="Box", resourceProperty="mesh", subProperty="size",
    value="Vector3(2, 2, 2)", scenePath="res://main.tscn")
```

`nodePath`, `resourceProperty` and `subProperty` are all required and canonical. There is no dotted `"mesh.size"` form.

**Inline `sub_resource` targets work.** An earlier revision of this file claimed the op silently fails on an inline sub-resource and told you to save the resource as a standalone `.tres` first. That was wrong, and it propagated into nine skills. The implementation reads `node->get(resourceProperty)` and sets the sub-property on whatever comes back (`modules/1summer_engine/editor/ops/scene_ops.cpp:1273-1400`) — there is no inline-versus-external branch anywhere in it. The canonical example in the shipped `summer_batch` description does exactly this against an inline mesh.

Structural failures are explicit:

| Error | Meaning |
|---|---|
| `no edited scene` | Nothing open — pass `scenePath`. |
| `node not found: <path>` | `nodePath` is wrong; it is relative to the scene root. |
| `property is not a resource` | `resourceProperty` names a plain value, not a resource. |
| `resource is null` | The node has the property but nothing is assigned yet. Assign it first. |

What is *not* explicit on current engines is a bad value shape. `summer_set_prop` and `summer_set_resource_property` convert only string values (`res://` path → load, Resource class name → instantiate, anything else → `str_to_var`); a JSON object (reachable through `summer_batch`, which forwards ops verbatim, or raw `/api/ops`), a misspelled `key`/`subProperty`, or a wrong-typed value passes straight to `set()` and returns `ok:true` while silently no-op'ing or coercing destructively — a dict assigned to `material_override` clears the material, a dict assigned to a `Color` becomes `Color(0,0,0,1)`. Newer engines reject these with `unknown_property` / `bad_value_shape` / `type_mismatch`. Always pass class names and `Color(...)`/`Vector3(...)` strings, and confirm the result in the saved `.tscn` or a snapshot diff, never from `ok` alone.
