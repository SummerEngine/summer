# Summer MCP Tools — Canonical Reference

> Which Summer MCP tool to call. Skills reference tool names exactly as written here.

**Operations.** Summer's cloud work is named by operation (`area.action`): `assets.generate_3d`, `jobs.wait`. A call written `area.action({...})` is one operation: use the tool `summer_area_action` when your client lists it, else `summer_call({ op: "area.action", input: {...} })`. `summer_search` finds any operation and its exact input. Engine tools keep their `summer_*` names below. Every answer has one shape: `done` with a `result`, `running` with a `job`, `needs_approval` with a link for the person, `dry_run` with a `preview`, or an `error` with a `code` and one `next` step. The person decides once what their agent may do: publishing (including `assets.make_public`), spending and building run at once by default, and deleting for good asks. An operation whose group they have not granted answers `needs_approval` with a link: give the link to the person, then `jobs.wait` on the `apr:` job.

## When to use Summer MCP vs. host tools

**Use Summer MCP for** anything that needs the live editor or the engine's import pipeline:
- Scene graph mutation (`.tscn`)
- Node properties and resources (`.tres`)
- Project settings (`project.godot`) and InputMap
- Asset import (the import pipeline must run)
- Play / stop / runtime state
- Diagnostics, console, debugger output, script errors
- Project text reads and guarded writes (`.gd`, `.cs`, `.tscn`, `.tres`, JSON, docs, config)

**Use host tools for** git, shell, searching outside the project, and non-project work. External host file writes bypass Summer's project-identity, sha256, and editor-reload safeguards and should not be used for project mutations while MCP is available.

**Rule of thumb:** project reads/writes go through Summer; live hierarchy/inspector changes use scene tools; process-level work remains with the host.

## Tool surface (131 tools)

### Local projects (2)

No shell needed (Claude Desktop, chat apps); the `summer dev` command does both in one step from a shell.

| Tool | Use |
|---|---|
| `summer_projects_create_local` | Write a new project from a template to this computer (`3d-basic` by default: sky, sun, ground and a hero). `dir`, or `name` next to the session's project, in the session's folder, or in `~/Documents/Summer`; never inside another project. A folder that already holds `project.godot` is left as it is. Returns `projectPath`. |
| `summer_projects_open_local` | Open a project in Summer Engine in the background and wait until it connects; the session's engine tools then work on it. Engine missing: answers `engine_not_running`; ask the person, and only with their yes call again with `install: true` (about 660 MB, free). A slow first open answers "call again in 30 seconds". It registers `summer preview` in the session folder's `.claude/launch.json`; `preview.url` is where the game shows. |

### Project files (4)

| Tool | Use |
|---|---|
| `summer_read_file` | Read project text plus a full-file sha256 receipt. Big files in parts: `offset`/`limit` page by lines (or `unit:'bytes'`), `data.window` gives `next_offset`/`eof`; for JSON, `json_path` picks one value (`pieces.wall_a`), `keys` keeps matching object keys (`['wall_*']`), `keys_only` lists key names. The sha256 always covers the whole file. |
| `summer_grep` | Regex search over project files (ripgrep through the engine): file, line and text per match, `context_lines` before/after (0-10), `path` (res:// dir or file), `glob`, `max_results` (default 50) with `truncated`. Find the part of a big file you need, then read just that part with `summer_read_file`. |
| `summer_write_file` | Create-only or sha256-guarded complete file write. |
| `summer_replace_text` | Unique (or explicit replace-all) text mutation with read/sha guard. |

### Scene graph (12)

| Tool | Use |
|---|---|
| `summer_get_scene_tree` | Read current scene graph. Always do this before mutating. |
| `summer_open_main_scene` | Open the project's main scene. |
| `summer_open_scene` | Open a specific `.tscn`. |
| `studio.open` (3.x `summer_open`; through `summer_call`) | Navigate for the user: open a summerengine.com page (billing, my games, pricing, an MCP guide) or an editor surface (scene, node, script, file, a dock) by intent name (`target`), or `open: false` to get the URL / op only. Runs in the Summer MCP on this computer. Destinations: the `product-map` reference; when to use it: the `navigate-summer` skill. |
| `summer_create_scene` | Create a new scene. |
| `summer_instantiate_scene` | Add an existing scene or 3D model as a child node; `position` / `rotation_degrees` / `scale` (or `transform`) place it in the same call. |
| `summer_inspect_node` | Read a single node's properties (about 5 KB). `fields` keeps only named properties/globs plus derived `transform`, `global_transform`, `scene_file_path`, `aabb`, `warnings` — e.g. `fields:['transform','global_transform','scene_file_path']`. |
| `summer_add_node` | Add a node to the explicit `scenePath`; the tab need not be open. |
| `summer_remove_node` | Remove a node from the explicit `scenePath`. |
| `summer_replace_node` | Swap a node for another scene/model or type in the explicit `scenePath` (a `.tscn`), keeping parent, index, name, transform, property overrides and added children. Verified: it saves, reads the saved file back and returns `persisted:true` only when the file holds the new scene; otherwise an error with `failure_reason: not_persisted`. `not_carried_over` lists what could not travel (groups, signal connections, sub_resource values). |
| `summer_select_node` | Set editor selection (visual feedback for the user). |
| `summer_save_scene` | Explicitly save/save-as a `scenePath`; mutation tools already append one final save. |

### Properties / resources (4)

| Tool | Use |
|---|---|
| `summer_set_prop` | Set a typed property in an explicit `scenePath` using `str_to_var()`. |
| `summer_set_resource_property` | Set a nested resource property in an explicit `scenePath`. |
| `summer_inspect_resource` | Read a resource FILE (`path`): a Mesh `.res` gives AABB, surfaces (primitive, vertex/index counts, attributes, triangles, material) and materials; a `.tscn`/`.glb` gives its nodes and meshes; anything else its non-default editor properties. Or a resource a node of the active scene holds (`nodePath` + `property`). |
| `summer_connect_signal` | Wire a signal between nodes in the explicit `scenePath` (a `.tscn`). Connects with `CONNECT_PERSIST` through a RunSceneScript probe (the engine's ConnectSignal op never saves the connection), saves, and returns `persisted:true` / `verified:true` only when the saved file holds the `[connection]` line; otherwise `failure_reason: not_persisted`. |

### Project & input (2)

| Tool | Use |
|---|---|
| `summer_project_setting` | Modify `project.godot` settings (rendering, physics). |
| `summer_input_map_bind` | Bind input actions in InputMap. Folds in the legacy `add_action` step. |

### Import pipeline (2)

| Tool | Use |
|---|---|
| `summer_import_from_url` | Download a `.glb`/`.png`/etc and run the engine's full import pipeline. |
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

### Editor UI control (5)

Preview: needs Summer Engine 0.5.66 or newer; older engines return `engine_lacks_op`. Scene work never goes through the editor UI (use the scene, scripting, and perception tools). UI ops are for editor-workflow steps a human does with the mouse — open Project Settings, switch the main screen, clear a blocking dialog, read a dock. Ladder: dedicated tool → named action → tree + activate → screenshot (pixels last, never for coordinates). Quit / project-reload / delete-without-confirm actions are denied by the engine. The `driving-the-editor-ui` skill carries the patterns.

| Tool | Use |
|---|---|
| `summer_ui_actions` | `mode:"list"` enumerates the editor's named actions (`name`, `label`, `shortcut_text`, `category`, `denied?`); `mode:"invoke" action_name:"editor/project_settings"` runs one exactly as its menu item / shortcut would and reports `handled`, `via`, `opened_dialog`. Failures: `unknown_action` (+`close_matches`), `denied_action`, `modal_open` (+`blocking_dialog`), `not_handled`. |
| `summer_ui_tree` | Structured Control tree of the live editor UI (class, path, rect, text/tooltip, `checked`/`enabled`/`tabs`/`current_tab`/`value`) from `root:"main" \| "window" \| "dock:<title\|id>" \| "dialog:<title>" \| "path:<node path>"`; `root:"dialogs"` lists every visible dialog/popup with `blocking`, `blocking_dialog`, and its `buttons`. The token-cheap alternative to a screenshot; its paths are what `summer_ui_activate` takes. |
| `summer_ui_activate` | Activate one control by tree path through its own input path — `press`, `toggle`, `focus`, `select_tab` (incl. `path:"main_screen" value:"3D"`), `set_text` (+`submit`), `set_value` — and `action:"dismiss_dialog"` (by `path` or `title`, `button` cancel/ok/text) to clear a blocking dialog. `state` / `visible_after` are read back after the action, never echoed. |
| `summer_ui_screenshot` | PNG of the editor window or one dock/dialog/control (`root`, `max_size`) returned as an image — the pixels-last fallback for LOOKING at the editor UI. Not for scene verification (`summer_screenshot`) and never for picking click coordinates. Honest `no_renderer` under a headless editor. |
| `summer_view_set` (`engine.view_set`) | Show the person what you work on: the frame's view (home, chat, 3D, 2D, script, game, Studio), the right rail, the focus and the nodes to frame. Use it when you start editing a scene or script, play the game, or finish on the best view of the result; not for reading a node (`summer_inspect_node`) or opening a web page (`studio.open`). Needs Summer Engine 4.6 or newer. |

### Perception (4)

| Tool | Use |
|---|---|
| `summer_world_snapshot` | Compact structured snapshot of the edited scene (paths, classes, transforms, world AABBs, visibility, resource fingerprints, light/camera/counts summary). The cheap read to run BEFORE and AFTER every mutation batch; keep the `snapshot_id`. Lists at most 200 nodes by default; `path_prefix` (one subtree), `classes`, `fields` (e.g. `['pos','aabb']`) and `offset` keep it small, `matched_counts` counts a subtree's classes. `counts` and the `snapshot_id` baseline always cover the whole scene. |
| `summer_snapshot_diff` | Diff two snapshots into added/removed/changed + count deltas — the structural receipt that a mutation did exactly what was intended. Omit `to_id` to diff against a fresh snapshot taken now. |
| `summer_get_runtime_tree` | Scene tree of the RUNNING game (spawned enemies, autoloads, pooled nodes) — live state the editor reads can't show. Needs `summer_play` first. |
| `summer_inspect_runtime_node` | One running-game node's live properties (actual stats/position/flags) without stopping the game. Get paths from `summer_get_runtime_tree`. |

### Spatial / world building (5)

Bounded spatial evidence for deliberate 3D arrangement. All five take exact `scenePath` + scene-root-relative node paths (editor selection is never consulted) and return a compact receipt under 5 KB (`summer_starcast` full detail: at most 12 KB). Read `skill/world-building-3d` for each tool's evidence boundary before the first call, and `skill/spatial-placement` for the inspect -> place -> starcast -> correct -> verify loop.

| Tool | Use |
|---|---|
| `summer_test_placement` | Ghost-test one node at a candidate global pose (read-only, never saves): overlap evidence, grounded state, signed floor gap. `fits: null` means physics could not prove clearance — never coerce it to success. |
| `summer_snap_to_surface` | Seat one subject on the first surface along a world ray (default downward); mutation + save. `evidence: physics` = collider sweep; `visual_aabb` = the engine's mesh-only broad-phase fallback; `visual_mesh` = the tool re-measured a `visual_aabb` answer (failure or seat) on visible triangles, placed the subject with one SetProp, verified the gap and saved (`engine`, `verify` in the receipt; `mesh_fallback` says why when it could not). A prop sunk into its support is lifted by the overlap depth plus 2 cm (at most its own extent, 0.5 m) and settled from there (`recovery` in the receipt). `gap_exceeds_hit_travel` / `overlap_recovery_exceeded` failures add `start_overlap`, `blocking` (the nodes it touches or sits in), `below` and a `next_step`. |
| `summer_align_distribute_3d` | Align (min/center/max) or equal-space (centers/gaps) 2–16 ordered subjects along one world axis from visible AABBs; mutation + save. One-axis evidence only. |
| `summer_navigation_probe` | Read-only reachability between two world points on the scene's navigation map: readiness, snapped endpoints + snap distances, route length, ≤16 route points. `ready: false` = unknown, not unreachable. |
| `summer_starcast` | Read-only 26-direction placement rundown around one exact node: per-direction `open`/`blocked` with nearest object, distance and evidence, contact-or-overlap paths, `grounded`, coverage, warnings. `detail: summary` ≤ 5 KB; `full` adds hit geometry, an objects table and nearby lists ≤ 12 KB and downgrades to summary rather than exceed it. `visual_aabb` evidence is broad-phase, never exact contact. |

### Kit placement (7)

Placement of modular kit pieces from measured geometry, built on the existing ops (a read-only `RunSceneScript` probe, then `SetProp` / `SnapToSurface` / `InstantiateScene` with the usual scene target, undo and final save). Each takes exact paths, needs the scene open in the editor (any tab; physics rays need the active tab) and returns a receipt under 5 KB that names its evidence. Arguments, result shapes, limits and the ops each one uses: `skill/spatial-placement` (`references/kit-placement-tools.md`).

| Tool | Use |
|---|---|
| `summer_inspect_asset` | Measure a `.tscn`/`.glb`/`.gltf` (or Mesh) WITHOUT adding it to a scene. A `summary` block first (AABB, origin label, the two largest opposite plane pairs with a `one_sided` flag per plane, port-like loop ids such as `+Y`), then per-mesh AABBs and triangle counts, the 6 largest planar faces, open boundary loops with stable ids by facing and position (`detail: "summary"` lists only port-like ones), Marker3D anchors, collision shapes. Read-only. |
| `summer_place_adjacent` | Put one node's bounds face against another's along an axis (gap, side), lining up the other axes (min/center/max, per axis); facade modules edge to edge, storeys stacked. One SetProp + save, verified. |
| `summer_attach_to_surface` | Turn a piece so its measured local back axis faces into a surface hit by a ray (up kept), then seat its back face (not its origin) with `SnapToSurface` at a standoff, keeping its height. Refuses and puts the piece back when the seat lands on another node or the move exceeds `maxMove`. Pipes, lamps, AC units, signs. |
| `summer_repeat_along` | Instance copies of a scene along a line (spacing or count, leftover aligned start/center/end), each placed in the same call; compact receipt with created paths. At most 64. |
| `summer_connect_ports` | Move and turn a piece so its port (open-loop id such as `+Y`, Marker3D name, or open-loop index) meets another piece's port, facing it; refuses a join that would tilt the piece more than `maxTiltDegrees` (default 5) unless `allowTilt`; verified distance, angle and tilt, and where the piece's other ports now point. |
| `summer_raycast` | One ray from any point, before anything is placed: hit path, point, normal. Physics first; visual-AABB fallback declared as such. Read-only. |
| `summer_measure` | Gap/overlap per axis between two nodes, or face coplanarity across 2-32 nodes (proud/recessed). Read-only. |

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

`summer_screenshot framing:"bookmark"` keeps a clean render (no marks, at most 1024 px) as the bookmark's one previous image in `res://.summer/shots/<bookmark>.jpg` when it has none; an existing one is the compare baseline and is replaced only by `compare_previous:true` (which returns previous | now | difference map in one image) or `update_previous:true`. With `marks:true` each labelled node gets an occlusion test (centre + 4 bounds points) and hidden ones are noted `(hidden behind <path>)`.

### Seeing (5)

Preview. Judge a 3D environment the way a player and an artist would. Every image comes back inline (one grid image per call, never N images) with a compact caption; renders are offscreen copies of the SAVED scene with its REAL WorldEnvironment and lights; nothing in the scene, the open tab or the undo history changes. Disk is bounded: only one previous-image slot per rendered bookmark plus explicit `save_to` copies, JPEG at most 1024 px, at most 20 MB under `res://.summer/shots/` (oldest evicted first). The `verifying-scenes` skill carries the environment review loop.

| Tool | Use |
|---|---|
| `summer_frame_nodes` | Fit a camera to the world bounds of 1-16 nodes (`direction` preset or `from` vector, `fill`) and render it with the real environment; `bookmark_name` saves the pose, `marks:true` maps labels to node paths (hidden nodes are noted). An explicit `from` is checked in-engine: walls in the way, or a camera behind or inside a one-sided surface (its back is not drawn, so the image looks through it), open the caption with a WARNING and the nearest valid `from` (+ `fov`). |
| `summer_shot_sheet` | 1-12 bookmarks/poses in one labelled grid, same tile size, one `view`; `compare_previous:true` gives previous / now / difference map per bookmark with the changed-pixel share and makes this render the next baseline. Without it the baseline is kept (a missing one is created); `update_previous:true` replaces it on purpose. |
| `summer_debug_views` | One pose as beauty, lighting, unshaded (albedo), world normals, overdraw and wireframe in one grid; the caption names the method per view. |
| `summer_zoom` | An exact sub-frustum of a `region` (honoured exactly: no pad by default, never widened to an aspect ratio; the image takes the region's aspect) or of `mark` N (pad 0.15; warns when the node is hidden) rendered at full resolution: seams, gaps, floating pieces, texture quality. The caption reports the real zoom and `widened_because`. |
| `summer_frame_shot` | Smart framing for `establishing`, `eye_level`, `low_angle`, `detail` or `corridor`: candidates measured in-engine (thick sweep visibility, near-lens check, low-angle rule, frame ray grid, a small beauty render per pose for featureless areas and near/far value contrast; walls reject, and so does a camera behind or inside a one-sided surface; props frame; transparent foliage and glass are see-through cover), scored (including the key light's direction and the world edge below the horizon; an establishing pose over 15% empty ground or world edge ranks below every cleaner one), top 3 returned with breakdowns as three different views and each camera's height above the surface below it, best saved as a bookmark, top 3 rendered as one sheet. Eye-level and corridor cameras stand 1.5-1.8 m (or `eye_height`) above the walkable surface and are never raised. |

### Scene audit (1)

Preview. One fast, read-only call that walks every node of a 3D scene and lists likely visual and placement problems, so you know exactly where to look; every issue is a flag to look at, never an auto-fix. Like the seeing tools it works on an offscreen private copy of the SAVED scene (ScenePreview): the open tab never becomes unsaved, undo is untouched, nothing is saved. Save first. The `verifying-scenes` skill carries the loop: audit after each build stage, then frame every error and look item up close before calling the scene done.

| Tool | Use |
|---|---|
| `summer_scene_audit` | Checks `through_hole` (ray grids through each facade line: rays that pass the wall and reach the far side of the building), `exposed_edge` (open outline edges of walls, bands, piers and corner blocks nothing covers within 4-7 mm, seen from walkable eye points, with a 2-60 cm reveal, a seam within 4 cm or a gap to the next sheet within 35 cm; warn on bands, look on walls unless `depth_step` agrees), `open_fixture_end` (open ends of run pieces, two or more open rims of one size, nothing joins within 2.5 cm; a cap, funnel or outlet is open by design; warn), `depth_step` (look: ray rows at each facade's band levels and every 1.25 m; band recesses, seams, proud modules, holes; a hole confirms a `through_hole`), `floor_gap` (down rays over the tiles, their seams and the strip from each tile edge to a wall within 1 m, classified by the first surface hit: the void, an underlay through a hole, or an underlay covering the floor's own drain or dip; areas from the missed rays' own footprints with the strip's size), `floating` / `sunken` (2 cm / 3 cm; the embed is against the first surface from above, named), `interpenetration` (3 cm, then every partner it cuts, up to 3), `orientation` (look: long props more than 15 deg off a wall within 1.2 m; never which way to face), `uv_stretch` (over 8:1 or collapsed UVs that an instance shows), `duplicate`, `z_fight` (coplanar overlaps from each mesh's planar face groups, between any two pieces and between two surfaces of one mesh, plus the ray samples; the tolerance is twice the 24-bit depth step at the view distance from the nearest walkable eye point, camera or bookmark, for the main camera's near/far; warn over 0.05 m2 seen from a viewpoint, `render_priority`, depth or normal offsets, see-through (alpha) materials and no depth test demoted to look with the reason), `lights` (per-object light limit, spot rims, shadowed count), `transform` (pieces left at the origin: an identity local transform under an identity parent, touching nothing, not one of a row of siblings; several sharing it warn), `resource`. `z_fight` evidence names the plane's normal and the axis to nudge (world and the piece's local). Returns at most 5 KB: counts and time per check, and one page of issues sorted by severity (`error` / `warn` / `look`) with node path, world position, reason, evidence numbers, the next tool and a `key`. `offset`/`limit` page, `checks`, `root` (subtree) and `min_severity` filter; `accept:[{key, reason}]` writes judged-fine look / warn items to `res://.summer/audit-accept.json` (later audits count them as `accepted` and hide them until their evidence changes; `show_accepted` lists them); `budget_ms` (default 3000) bounds the editor time, and a check past its weighted share stops and shows `partial` (the share it covered) in its counts; the gap detectors run last on the time the others leave; `render:"sheet"` adds one inline image of the page's first 6 issues framed from their open side, tiles labelled `#n`. Every check works from geometry, engine data and materials alone, never names or kit metadata; piece roles (dressing, wall, floor, roof, underlay, insert, facade structure, prop) come from shape. |

### Diagnostics (7)

| Tool | Use |
|---|---|
| `summer_create_debug_report` | Create a support-ready Markdown report (same as `summer debug`). |
| `summer_get_diagnostics` | Aggregate error/warning summary. Call after every change. |
| `summer_get_console` | Engine output panel. |
| `summer_clear_console` | Clear before a fresh play, so post-run output is clean. |
| `summer_get_debugger_errors` | Runtime errors with stack traces. |
| `summer_get_debugger_warnings` | Runtime warnings from the debugger panel. |
| `summer_get_script_errors` | Script compilation errors. |

### Asset library (6)

| Tool or operation | Use |
|---|---|
| `assets.search` | Free asset search: `query`, `scope` (`library` = the public Summer library, the default; `mine` = the person's own generated and uploaded assets, where an empty query lists the newest; `all`), `assetType` (`2d_image`, `animation`, `3d_model`, `audio`, `music`, `all`), `style` (realistic, stylized-lowpoly, toon, pixel, hand-painted, voxel: keeps one art direction), `limit` (at most 20), `cursor`. Answers `items` (`assetId`, `title`, `type`, `source`, `fileUrl`, `thumbnailUrl`, `format`, `license`) and `nextCursor`. There is no picture preview of the results and no community toggle. |
| `assets.get` | One exact asset by `assetId`: `fileUrl`, `downloadUrl`, `viewerUrl`, `status` (`expired`: regenerate it), file name, type and size, visibility, license, tags and `parentAssetId`. |
| `summer_import_asset` | Search, choose the top match, download, run the engine import, and optionally instantiate 3D models. |
| `summer_import_asset_by_id` | Import one exact Summer asset ID. Use after generation jobs or when the user selects a specific asset. |
| `summer_import_hdri` | Search Poly Haven's CC0 HDRIs (public API, no Summer login), import the `.hdr`/`.exr` into `res://sky/`, and get the exact `summer_run_script` snippet that wires it as the WorldEnvironment sky. |
| `assets.slice_sheet` | Detect and crop every distinct item of a sheet image the person owns: `slices` with `url`, `name`, `category`, `bbox` (works without the engine; import the URLs afterwards with `summer_import_from_url_batch`). Spends credits. |

### Asset generation (metered)

Each spends the person's credits. `dryRun: true` returns `preview.estimate` (`credits`, `balance`, `enough`) and makes nothing; never quote prices. Model lists are the enums in each operation's input (`summer_search` returns it).

| Operation | Use |
|---|---|
| `assets.generate_image` | Draw or edit an image: `prompt`, `model`, `style`, `aspectRatio`, `width` + `height` (minimum size), `numImages`, `referenceImageUrl` (edit), `removeBackground`, `seed`. Answers `assets` (`assetId`, `fileUrl`, real `width`/`height`). |
| `assets.generate_3d` | Text-, image- or multi-view-to-3D, optionally rigged and animated: `kind`, `prompt`, `imageUrl` / `imageUrls`, `model`, `rig`, `animationNames`, `targetPolycount`, `topology`. **Always a job.** |
| `assets.generate_audio` | Speech, sound effect, music or dialogue: `capability`, `text` / `prompt` / `inputs`, `voiceId` (a game-cast voice), `modelId`, `durationSeconds`, `loop`, `voiceSettings`. Sound effects without `modelId` use the person's approved default. |
| `assets.generate_sfx_choices` | One sound effect from 2-4 models, shown on a Summer Studio page where the person approves one or more. Answers `choiceSetId` and `reviewUrl`. |
| `assets.choices` | Read the person's picks for a choice set (`approved`, `note`, `audioUrl`, `assetId`); `waitSeconds` waits for them. Free. |
| `assets.generate_video` | Text- or image-to-video: `prompt`, `imageUrl`, `model`, `duration`, `aspectRatio`, `resolution`, `negativePrompt`. **Always a job.** |
| `assets.generate_motion` | Animate a rigged model: `rigAssetId`, `backend`, `motionNames` (library) or `prompts` (text to motion). **Always a job**, except clips the rig already has (`reused`). |
| `makers.<tool>` | One-shot recipes (MCP names `summer_tool_<tool>`): `makers.npc_voice`, `makers.trailer_forge`, ... `summer_search` lists them with their input. |

### Your assets

| Operation | Use |
|---|---|
| `assets.remove_background` | Transparent copies of up to 8 of the person's images (originals stay). Spends credits. |
| `assets.update` | Title, description, tags, and `private` or `team` visibility. To list an asset for everyone, `assets.make_public`. |
| `assets.make_public` | Lists one of the person's assets for everyone in Summer's asset store (publishing). Runs at once when the person lets their agent publish (the default), else answers `needs_approval` with a link. |
| `assets.delete` | Deletes one of their assets for good. Asks the person unless they let their agent delete: it answers `needs_approval` with a link, and nothing is deleted until they confirm. |
| `assets.upload_begin` → `assets.upload_complete` | Upload a PNG/JPEG/WebP from disk: a signed form to POST the file to, then the confirm step that makes the asset. |

### Jobs and batches

| Tool | Use |
|---|---|
| `jobs.wait` | Wait up to `timeoutSeconds` (at most 50) for a job from any operation that answered `running` or `needs_approval`; call again until `finished`. The finished job's `result` holds the asset ids. `jobs.get` reads it once. |
| `summer_batch` | Run multiple ops as a transaction. `InstantiateScene` ops may carry `position` / `rotation_degrees` / `scale` / `transform`; `receipt: "summary"` returns counts, failures with op index and created paths under 5 KB. A `ReparentNode` keeps the moved node's scene-owned children and grandchildren (the engine op drops them from the saved file) and is verified from the saved `.tscn` (`persisted:true` / `verified:true`, else `failure_reason: not_persisted`); a raw `ConnectSignal` is refused — use `summer_connect_signal`. `scenePersistence.saved` only means the SaveScene ran. |

### Meta (5)

| Tool | Use |
|---|---|
| `summer_call` `{"op":"docs.plan"}` | Route a user goal into the right workflow, skills, MCP tool groups, asset policy, gates, and verification path. Shell: `summer plan "<goal>"`. (3.x: `summer_start_game_task`.) |
| `summer_call` `{"op":"docs.workflows"}` | Discover Summer Studio's guided workflow recipes (starter prompts, ordered steps, required tools) for a goal. (3.x: `summer_get_studio_workflow`.) |
| `summer_get_project_context` | Project, scene, and `.summer` memory summary — call at start of session. Binds the session to the open project and surfaces a `capabilitySkewWarning` when the engine build and CLI have drifted; tools whose op the engine provably lacks return a structured `engine_lacks_op` result instead of running. Compact by default (a few KB: `sceneSummary`, scalar `health` with capability counts); `include:['scene_tree','capabilities','settings']` adds the heavy blocks, `omitted` says how. |
| `summer_call` `{"op":"summer_get_agent_playbook"}` | Daily operating contract (observe-first loop, content routing, invariants, verification ritual) — read at start of session. Also served natively as the `summer_agent_playbook` MCP prompt. |
| `plans.get` (3.x `summer_get_board`) | Read the person's game plan (look, characters, place, storyboard, picks): every item with its id, picture URL and revision, to compare screenshots against. `projects.get({ projectId })` gives the project's `planId` from the project id in the build brief; works without the engine. |

### Creator platform (8)

| Tool | Use |
|---|---|
| `summer_export_game` | Export the game in the file the Summer Games store takes, headless (no window), no running editor needed. `format:"bundle"` (default): the `summer.games` `.zip` the Summer apps run; `targets` picks `ios`, `android`, `macos`, `windows` (a game without a server: phones only) through a named `summer.games <targets>` preset in `export_presets.cfg`. `format:"download"` with one target: `web` (HTML5 `.zip` on Summer's WebGPU Forward+ template; refuses Compatibility projects), `macos` (ad hoc signed `.app` zip, `macos-universal`) or `windows` (`.exe` with embedded pack, zipped, `windows-x64`). Returns path, sha256, size, bundle manifest or store platform, warnings. |
| `summer_export_templates` | `list` or `install` export templates from Summer's CDN (`downloads.summer.games/engine-templates/<summerVersion>/manifest.json`) into the engine's user template folder (`<data>/Godot/export_templates/<FULL_CONFIG>/`), sha256-checked. Only download exports need them; store bundles need none. `summerVersion` is read on macOS, passed elsewhere. |
| `store.upload_file` (3.x `summer_publish_build`; through `summer_call`) | Upload that `.zip` to the creator's game through Studio's store upload: confirm-gated preview first, then declare, part upload from disk, seal, wait for the Build and for Summer's automated checks on each platform (`checks`: passed, or failed with `code`, `owner` and `fix`); `publish:true` also makes the Build available to players. Needs `summer login --store`; a retry with the same file and version continues the same upload. Without a shell, `store.upload_begin`, `store.upload_sign_parts` and `store.upload_complete` take the bytes in parts. |
| `store.go_live` (`summer_go_live`; through `summer_call`) | Take the store game live: release the uploaded bundle Build to the platforms that passed their checks and publish the store page, through the same store routes Studio uses, then watch until players get it. Confirm-gated: the plan first (or `live`, `blocked` with each failure's fix, `needs_changes` with Summer's feedback). It needs no owner approval link while the person's Agent permissions allow Publish (the default; otherwise `needs_permission`). `waiting` names what it waits on (`automated_checks`, `activation`, or `summer`: a hold on Summer's side that needs nothing from the creator). Call again to keep watching; nothing is asked twice. Run the `release-checklist` skill first. |
| `store.set_details` (`summer_store_set_details`; through `summer_call`) | The store page sections `store.update_listing` does not edit, on the draft: `genres`, `features`, `credits`, `languageSupport`, `systemRequirements`, `contentSurvey` (the age questionnaire) and `aiDisclosure`. A section given replaces it, `null` clears it. Never publishes. |
| `economy.sync_items` (`summer_sync_items`; through `summer_call`) | Bring the store game's items in line with `summer.items.json` in the project root, matched by slug, so staging and production carry the same items. Confirm-gated: the plan first (create, update with the changed fields, unchanged, blocked), then the changed images are uploaded and the plan goes to the owner, who approves it in Studio; the items are then created or revised, priced in Sparks and submitted for review. One approval takes at most 50 changed items (a larger plan lists `batches`; confirm each with `slugs`); a new item needs at least one image. Never activates or releases an item. Needs `summer login --store`. Staging or production is the gateway setting: switching takes `SUMMER_GATEWAY_URL` and `SUMMER_MCP_RESOURCE_URL`, then `summer login --store --force` (one store sign-in per machine). |
| `content.make` (`summer_content_make`; through `summer_call`) | Make one finished piece of content for a game on this computer and put it in the team's Review: picks the reference that fits today (a format the game has not posted, what changed in the repo), studies its cuts and caption look, maps each reference shot to a footage window with motion, cuts to its timings, draws its captions, puts a song on the beat, mixes at -14 LUFS, checks hook, motion per shot, safe zones, length and loudness, renders the reference side by side and saves the piece (failed checks: a draft). It never writes words: `needs_words` lists the beats, call again with `workDir` and `lines`; a reference that speaks also needs `voiceFile` in the team's voice (`needs_voice`). Same `workDir` continues where it stopped. Needs ffmpeg and ImageMagick (Whisper for a voice-over). |
| `summer_capture_gameplay` | Real gameplay frames without a running editor: starts the game (main scene or `scene`) in the engine's offscreen verify instance (`--summer-verify`, real renderer, window parked offscreen, no focus) (`--summer-offscreen`) at `resolution` (default `1920x1080`), waits `waitSeconds`, runs `steps` (`press` a button by text, `key`, `action`, `click`, `drag`, `wait`, `shot`), saves `frames` PNGs (HUD included; with a `shot` step, one per shot) to `<project>/.summer/captures/<time>/`. `args` are the game's own flags, passed after `--` (e.g. `["--autostart"]` to skip the title screen). Imports the project first when `.godot/` is missing. Returns each path with its real width and height; warns when the stretch settings render another size. For store screenshots. |

### Hosted store, publishing and Grow tools

These come from the hosted Summer server (the one ChatGPT and Claude connect to) and are mounted into the local MCP after `summer login`; `summer tool <name>` reaches them too.

- **Store page:** `summer_store_list_games`, `summer_store_create_game`, `summer_store_get_listing` (the page, the checklist and `availableTags`), `summer_store_update_listing` (text, tags, long description, support contact, release date, content rating), `summer_store_set_art`, `summer_store_set_trailer`, `summer_store_set_sound`, `summer_store_preview_link`, `summer_store_jams` and `summer_store_enter_jam`.
- **Builds and release:** `summer_build_begin_upload` / `_sign_parts` / `_complete_upload` / `_status` (the local `summer_publish_build` does these from disk), `summer_store_version_*` for web and native downloads, `summer_store_submit` (one approval link for the owner, for a person whose Agent permissions have Publish off; otherwise the local `summer_go_live` takes the game live), `summer_store_cancel_submission`, `summer_store_review`, `summer_store_releases`, `summer_build_release`. The engine profile leaves out `summer_store_releases` and `summer_store_version_status`: `summer_go_live` reports what players get and each download's state.
- **Grow:** `summer_grow_overview` and `summer_grow_analytics` (store page views, launches, play sessions, play time, custom events), `summer_grow_event_catalog`, `summer_grow_event_trend`, `summer_grow_event_funnel`, `summer_grow_members`, `summer_grow_ab_tests`, `summer_grow_prices`, `summer_grow_event_limit`, `summer_grow_apply` and `summer_grow_applications`.
- **Guides:** the `publish-your-game`, `release-checklist`, `store-listing`, `store-art` and `grow-analytics` skills (`summer_docs_read`).

### Library search (2)

| Tool | Use |
|---|---|
| `summer_docs_search` | Search the library (skills, tools, templates, references, examples, collections) by describing the task in plain words; ranked ids with `matched_by` (lexical / semantic). The first move for any task; works without the engine. |
| `summer_docs_read` | Load one entry by id: a skill's SKILL.md plus metadata, a tool's call recipe, a template's pin, a reference's body. A body ends with its relative links and the id that loads each; a linked file loads by `<entry id>/<link as written>` (e.g. `skill/spatial-placement/references/kit-placement-tools.md`). The last line is the `entry_id` footer to report through `docs.feedback`. |

### Summer API (5)

Signed in with `summer login` (one browser sign-in on this computer, renewed by itself; `summer token` prints a one-hour token for the person's own HTTP code). Each app spends the person's paid credits up to the limit they set in Connected apps. No rate limits on paid usage: jobs past the account's running slots (10 at once, up to 40 as it buys credits) answer `queued` and start in order. Money is the only refusal: `no_credits` (the paid balance) or `over_limit` (the app's own limit). The `summer-api` skill has the workflow.

| Tool | Use |
|---|---|
| `summer_api_models` (`models.list`) | The Summer API's curated game-dev models: id, capability, input schema, output formats, typical time and USD price; `model` for one, `capability` to filter. No sign-in. Shell: `summer api models`. |
| `summer_api_estimate` (`models.estimate`) | The exact USD price of one job, its breakdown and a `quoteId` that holds it 15 minutes. Charges nothing. Shell: `summer api estimate`. |
| `summer_api_run` (`models.run`) | Run one job into the person's Summer assets with the Summer sign-in on this computer; spends paid credits within the app's limit. `wait` follows it, `out` saves its files, `quoteId` caps the charge. Shell: `summer api run --wait --download`. |
| `summer_api_batch` (`POST /v1/batches`) | Run up to 500 jobs at once, all or none: queued at held prices when paid credits and the app's limit cover them all; otherwise nothing runs and the error says how many fit. `batchId` reads a batch; `wait` and `out` as for one job. Shell: `summer api run --batch jobs.jsonl --wait --download`. |
| `summer_api_job` (`jobs.get`, `jobs.cancel`) | Read a job (state, price, assets and file URLs); `wait`, `out` or `cancel`. Shell: `summer api jobs`. |

### Library feedback (1)

| Tool | Use |
|---|---|
| `summer_call` `{"op":"docs.feedback"}` | Report library-entry outcomes (worked/wrong/outdated/...) so entries get fixed and re-ranked. Fire-and-forget with a 1s cap; enum-first schema with no field for project files, chat content, or code; honors `SUMMER_NO_TELEMETRY=1` and `DO_NOT_TRACK=1`. |

### Summer Apps

Team tools inside Summer Studio that agents build: shared, live on the team's data and engine. Load the `summer-apps` and `summer-apps-design` skills first. A call written `apps.action({...})` is the tool `summer_apps_action` when your client lists it, else `summer_call({ op: "apps.action", input: {...} })`.

| Operation | Use |
|---|---|
| `apps.guide` | The build guide by `section`: when to build, Layout vs code, build loop, manifest, SDK, UI kit, layout format, design rules, worked examples. |
| `apps.list` | The apps in the person's workspaces (`workspaceId`, `q`, `limit`, `cursor`). |
| `apps.create` | New scratch app; the person's Studio tab opens it. |
| `apps.publish` | New immutable version from `files` (`{ path, content, encoding }`, `index.html` at the root) or a `layout`, plus the `manifest`. |
| `apps.get` | Manifest, current files and a data summary. |
| `apps.update` | Rename, move to a folder, keep, archive, restore or pin an app (`name`, `folder`, `status`, `pinned`). |
| `apps.duplicate` / `apps.add_starter` | Copy an app (to another team too); add one of Summer's starter apps to a team. |
| `apps.delete` | Delete an app for good. Asks the person: answers `needs_approval` with a link. |
| `apps.rollback` / `apps.update_starter` | Make an older version the live one; update a changed starter app to the newest starter. Each asks the app's owner (`needs_approval` with a link). |
| `apps.events` | Long-poll (up to 50 s) what the app sends agents, errors, feedback and tool calls; pass the `cursor` back as `after`. |
| `apps.page` / `apps.use_page` | Read the open app's declared fields and buttons; fill (`fill`) and press (`press`) them. Critical ones are the person's. |
| `apps.screenshot` | See the app without the person: a headless, read-only render (the picture) with console, errors, refused calls and the declared page; `width` 390 for a phone, `theme` dark. |
| `apps.read_data` / `apps.write_data` | Read (`items`, `nextCursor`) or write (`ops`, up to 100) the app's shared collections; no app needs to be open, the team sees writes live. |
| `apps.tools` | The app's declared agent tools and collections. |
| `apps.call` | Run an agent tool inside the person's open app; a `conflict` error with the app's link when it is not open. |
| `apps.feedback` | Tell the app's makers it works (`thumbs: "up"`) or needs work, with a `note`. |
| `apps.report_gap` | Report an SDK capability an app needed and did not have. |
| `apps.dock` (3.x `summer_app_dock`; through `summer_call`) | Dock an app in the editor (left, right, bottom), close it, list docks; runs in the Summer MCP on this computer; `engine_lacks_op` on engines without app docks. |
| `summer_enable_plugin` | Enable an editor plugin (`res://addons/<name>/`) and get the real load result (`enabled`, autoloads, or a failure `code`); older engines answer `queued: true, enabled: null` instead of claiming success. |

## Common pattern

Every scene-touching skill should follow this loop:

1. `summer_call` `{"op":"docs.plan","input":{"goal":"..."}}` — route the goal into skills/tools/gates.
2. `summer_get_project_context` — orient.
3. `summer_call` `{"op":"summer_get_agent_playbook"}` — read the rules.
4. Resolve the exact `res://` scene path; open it only for an intentional current-tab read/UI action.
5. Pass that `scenePath` to mutations (`summer_add_node`, `summer_set_prop`, `summer_connect_signal`, ...).
6. Mutation tools append one final `SaveScene`; use `summer_save_scene` directly only for a standalone save/save-as.
7. `summer_get_script_errors` — catch GDScript breakage.
8. `summer_play` → `summer_get_debugger_errors` → `summer_screenshot` (see what's on screen) → `summer_stop` if verifying runtime.

Read big things in parts, never whole:

- `summer_get_project_context` is compact by default; add `include:['scene_tree']` (or `'capabilities'`, `'settings'`) only when you need that block.
- `summer_world_snapshot path_prefix:'House3' fields:['pos','aabb']` reads one subtree; `classes` and `offset` narrow and page it.
- `summer_inspect_node fields:['transform','global_transform','scene_file_path']` reads a transform in a few hundred bytes.
- `summer_grep` finds the lines (with `context_lines`), then `summer_read_file` reads just that part: `offset`/`limit` for text, `json_path` / `keys` / `keys_only` for JSON such as a kit manifest.

Every asset-generation skill should follow this loop:

1. `assets.search` (`scope: "all"`, or `"mine"` for the person's own) — reuse before generating when reasonable.
2. `assets.generate_image` / `assets.generate_3d` / `assets.generate_audio` — metered creation (`dryRun: true` first when the person should see the credits).
3. `jobs.wait` when the answer was `running` (3D, video, animation), until the job is finished.
4. `assets.get` — resolve the returned `assetId`, `rigAssetId`, or `animationAssetId`.
5. `summer_import_asset_by_id` — import the exact result through the engine's import pipeline.
6. The `downloadUrl` from `assets.get` — only when the user explicitly wants a downloadable file/link.

`whoami()` shows the signed-in account: plan, `credits` (their balance) and whether generation is unlocked.

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

**Inline `sub_resource` targets work.** You do not need to save the resource as a standalone `.tres` first: the op reads the node's property and sets the sub-property on whatever resource it holds. The canonical example in the shipped `summer_batch` description does exactly this against an inline mesh.

Structural failures are explicit:

| Error | Meaning |
|---|---|
| `no edited scene` | Nothing open — pass `scenePath`. |
| `node not found: <path>` | `nodePath` is wrong; it is relative to the scene root. |
| `property is not a resource` | `resourceProperty` names a plain value, not a resource. |
| `resource is null` | The node has the property but nothing is assigned yet. Assign it first. |

What is *not* explicit on current engines is a bad value shape. `summer_set_prop` and `summer_set_resource_property` convert only string values (`res://` path → load, Resource class name → instantiate, anything else → `str_to_var`); a JSON object (reachable through `summer_batch`, which forwards ops verbatim, or raw `/api/ops`), a misspelled `key`/`subProperty`, or a wrong-typed value passes straight to `set()` and returns `ok:true` while silently no-op'ing or coercing destructively — a dict assigned to `material_override` clears the material, a dict assigned to a `Color` becomes `Color(0,0,0,1)`. Newer engines reject these with `unknown_property` / `bad_value_shape` / `type_mismatch`. Always pass class names and `Color(...)`/`Vector3(...)` strings, and confirm the result in the saved `.tscn` or a snapshot diff, never from `ok` alone.
