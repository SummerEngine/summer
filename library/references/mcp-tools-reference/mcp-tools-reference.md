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

**Use host tools for** git, shell, searching outside the project, and non-project work. External host file writes bypass Summer's project-identity, sha256, and editor-reload safeguards and should not be used for project mutations while MCP is available.

**Rule of thumb:** project reads/writes go through Summer; live hierarchy/inspector changes use scene tools; process-level work remains with the host.

## Tool surface (105 tools)

### Project files (4)

| Tool | Use |
|---|---|
| `summer_read_file` | Read project text plus a full-file sha256 receipt. Big files in parts: `offset`/`limit` page by lines (or `unit:'bytes'`), `data.window` gives `next_offset`/`eof`; for JSON, `json_path` picks one value (`pieces.wall_a`), `keys` keeps matching object keys (`['wall_*']`), `keys_only` lists key names. The sha256 always covers the whole file. |
| `summer_grep` | Regex search over project files (ripgrep through the engine): file, line and text per match, `context_lines` before/after (0-10), `path` (res:// dir or file), `glob`, `max_results` (default 50) with `truncated`. Find the part of a big file you need, then read just that part with `summer_read_file`. |
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
| `summer_set_prop` | Set a typed property in an explicit `scenePath` using Godot's `str_to_var()`. |
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
| `summer_search_assets` | Free public asset search (community library + user's own). Sources: `library`, `community`, `my_assets`, `all`. `style` keeps one art direction (realistic, stylized-lowpoly, toon, pixel, hand-painted, voxel); `preview` returns a numbered picture of the first 9 results; curated packs first unless `includeCommunity`. |
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
| `summer_batch` | Run multiple ops as a transaction. `InstantiateScene` ops may carry `position` / `rotation_degrees` / `scale` / `transform`; `receipt: "summary"` returns counts, failures with op index and created paths under 5 KB. A `ReparentNode` keeps the moved node's scene-owned children and grandchildren (the engine op drops them from the saved file) and is verified from the saved `.tscn` (`persisted:true` / `verified:true`, else `failure_reason: not_persisted`); a raw `ConnectSignal` is refused — use `summer_connect_signal`. `scenePersistence.saved` only means the SaveScene ran. |

### Meta (4)

| Tool | Use |
|---|---|
| `summer_start_game_task` | Route a user goal into the right workflow, skills, MCP tool groups, asset policy, gates, and verification path. |
| `summer_get_studio_workflow` | Discover Summer Studio's guided workflow recipes (starter prompts, ordered steps, required tools) for a goal. |
| `summer_get_project_context` | Project, scene, and `.summer` memory summary — call at start of session. Binds the session to the open project and surfaces a `capabilitySkewWarning` when the engine build and CLI have drifted; tools whose op the engine provably lacks return a structured `engine_lacks_op` result instead of running. Compact by default (a few KB: `sceneSummary`, scalar `health` with capability counts); `include:['scene_tree','capabilities','settings']` adds the heavy blocks, `omitted` says how. |
| `summer_get_agent_playbook` | Daily operating contract (observe-first loop, content routing, invariants, verification ritual) — call at start of session. Also served natively as the `summer_agent_playbook` MCP prompt. |

### Creator platform (7)

| Tool | Use |
|---|---|
| `summer_export_game` | Export the game in the file the Summer Games store takes, headless (no window), no running editor needed. `format:"bundle"` (default): the `summer.games` `.zip` the Summer apps run; `targets` picks `ios`, `android`, `macos`, `windows` (a game without a server: phones only) through a named `summer.games <targets>` preset in `export_presets.cfg`. `format:"download"` with one target: `web` (HTML5 `.zip` on Summer's WebGPU Forward+ template; refuses Compatibility projects), `macos` (ad hoc signed `.app` zip, `macos-universal`) or `windows` (`.exe` with embedded pack, zipped, `windows-x64`). Returns path, sha256, size, bundle manifest or store platform, warnings. |
| `summer_export_templates` | `list` or `install` export templates from Summer's CDN (`downloads.summer.games/engine-templates/<summerVersion>/manifest.json`) into the engine's user template folder (`<data>/Godot/export_templates/<FULL_CONFIG>/`), sha256-checked. Only download exports need them; store bundles need none. `summerVersion` is read on macOS, passed elsewhere. |
| `summer_publish_build` | Upload that `.zip` to the creator's game through Studio's store upload: confirm-gated preview first, then declare, part upload from disk, seal, wait for the Build, name its client pack; `publish:true` also approves it. Needs `summer login --store`; a retry with the same file and version continues the same upload. |
| `summer_creator_publish` | **Deprecated** (use the two tools above). Compute the exact `.pck` digest and size, require user confirmation, then run versioned prepare → write-once upload → finalize. The server independently verifies `publish` scope, ownership, bytes, and review state. |
| `summer_creator_releases` | List real creator-owned releases from `summer.creator.v1`, with opaque cursor pagination. |
| `summer_creator_config` | Read or confirm updates to the shared non-secret `~/.summer/config.json`. It never accepts or returns tokens. |
| `summer_capture_gameplay` | Real gameplay frames without a running editor: starts the game (main scene or `scene`) in the engine's offscreen verify instance (`--summer-verify`, real renderer, window parked offscreen, no focus) at `resolution` (default `1920x1080`), waits `waitSeconds`, saves `frames` PNGs (HUD included) to `<project>/.summer/captures/<time>/`. Imports the project first when `.godot/` is missing. Returns each path with its real width and height; warns when the stretch settings render another size. For store screenshots. |

### Library search (2)

| Tool | Use |
|---|---|
| `summer_search_library` | Search the library (skills, tools, templates, references, examples, collections) by describing the task in plain words; ranked ids with `matched_by` (lexical / semantic). The first move for any task; works without the engine. |
| `summer_read_library` | Load one entry by id: a skill's SKILL.md plus metadata, a tool's call recipe, a template's pin, a reference's body. A body ends with its relative links and the id that loads each; a linked file loads by `<entry id>/<link as written>` (e.g. `skill/spatial-placement/references/kit-placement-tools.md`). The last line is the `entry_id` footer to report through `summer_library_feedback`. |

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

Read big things in parts, never whole:

- `summer_get_project_context` is compact by default; add `include:['scene_tree']` (or `'capabilities'`, `'settings'`) only when you need that block.
- `summer_world_snapshot path_prefix:'House3' fields:['pos','aabb']` reads one subtree; `classes` and `offset` narrow and page it.
- `summer_inspect_node fields:['transform','global_transform','scene_file_path']` reads a transform in a few hundred bytes.
- `summer_grep` finds the lines (with `context_lines`), then `summer_read_file` reads just that part: `offset`/`limit` for text, `json_path` / `keys` / `keys_only` for JSON such as a kit manifest.

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
