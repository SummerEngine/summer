# Changelog

All notable changes to summer-engine will be documented here. Following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [3.4.2] - 2026-10-10

Agents that publish a game find the publishing guides in the library:

- `summer_search_library` and `summer_read_library` now find `skill/publish-your-game`, `skill/store-listing`, `skill/store-art` and `skill/grow-analytics`. Before, they were only hosted MCP resources and a read returned not_found.
- A read loads the current text from the hosted Summer Engine MCP with the store sign-in (`summer login --store`). Without the sign-in it shows a short summary, the reason, and how to load the rest. The entries also load by their `summer://skills/<slug>` URI.

- `summer_capture_gameplay` gets past the title screen. `args` passes the game's own flags after `--` (for example `["--autostart"]`). `steps` play like a player before and between frames: press a button by its text, a key, an input action, a click, a drag, a wait, and a shot. The run always passes `--summer-offscreen`.

- `summer_generate_image` sends no model unless you name one, so width 1920 with height 1080 gets a model that reaches it instead of `size_unreachable`. It waits up to 3 minutes for the larger models. The new `out` parameter (a folder or a .png/.jpg/.webp path) says where to save the image; without it, it goes to `<TMPDIR>/summer-gen/`.
- `summer_export_game` exports the targets the installed engine can build: Android on 0.7.0 is left out with a warning (it needs 0.7.1), and the other targets still export. `skippedTargets` names what was left out.

### Added
- Skill field `hosted_resource` in `resource.yaml`: the skill's body comes from that hosted MCP resource (#90).
- `summer_capture_gameplay` `args` and `steps`; a step that cannot run (no such button, key or action) is a warning, not a failure.

## [3.4.1] - 2026-10-10

Agents that publish a game find the right tools:

- A request such as "release version 1.2.0 of my game" now leads to `summer_publish_build`, not to the legacy creator tool.
- The library and the tool reference name the store tools for the steps after an upload: store page text and art, submitting for the owner's approval, releasing, and `summer_store_releases` for what players get now. These are hosted tools, mounted after `summer login --store`.
- The library and the docs are shorter, and stale or internal content is gone.

### Changed
- `tool/creator-publish` and `tool/creator-releases` match only old projects that publish to the legacy Summercraft creator channel. `creator-releases` is marked deprecated.
- `summer_creator_releases` (MCP and `summer tool`) says it reads the legacy creator API and points to `summer_store_releases`.
- `tool/publish-build` matches release requests. Its "do not use" list names the store tools.
- Library and docs clean-up: generation prices, internal references and wrong tool calls removed (#78, #81, #83, #84, #85, #86).

## [3.4.0] - 2026-10-09

Publishing a game from your agent now works end to end, with fewer surprises:

- Take store screenshots of real gameplay without opening the editor (`summer_capture_gameplay`).
- Make store-size art: ask `summer_generate_image` for an aspect ratio or a size.
- See the store tools as soon as your agent connects, and use them from the terminal (`summer tool`). `summer doctor` checks that the store accepts your sign-in.
- An export tells you first when your Summer Engine is too old, shows the engine's real error when it fails, and lists the project files it changed.
- A publish preview checks that the game exists before it asks you to confirm.
- `summer install --path` installs Summer.app into the folder you name, and every command uses that engine.
- New skills for running the engine safely from an agent and for games that also run on the Compatibility renderer.

### Added
- `summer_capture_gameplay` (CLI `summer tool capture-gameplay`): saves real gameplay frames (HUD included) without a running editor. It starts the game in the engine's offscreen verify instance (`--summer-verify`, real renderer, window offscreen, no focus, never `--headless`) at `resolution` (default `1920x1080`), waits `waitSeconds`, and saves `frames` PNGs to `<project>/.summer/captures/<time>/`. It imports a never-opened project first, passes `--summer-no-api`, and returns each frame's path with its real width and height. It warns when the stretch settings render another size.
- `summer_generate_image` `aspectRatio` (1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 5:4, 4:5, 21:9) and `width` + `height` (64 to 4096), sent to the image route as top-level fields. The server picks a model that reaches the size, or refuses a named model that cannot, before any spend. The result reports the real size and the model. The `options` description now says what the server really does. Until the server side ships, the new fields are accepted and ignored.
- `summer tool` runs a name that is not a local tool on the hosted Summer Engine MCP with the store sign-in (`summer tool summer_store_list_games`). `summer tool --list` lists the hosted tools after the local ones, or says to run `summer login --store`.
- `summer doctor` store-access check: with a store sign-in it calls `summer_store_list_games` (8 s limit) and shows the answer, or the store's code, message and request id on a refusal. Without a sign-in it says only publishing needs one.
- `summer doctor` shows the installed engine version and warns below 0.7.0, the first version that exports for summer.games.
- Skills `bounded-engine-runs` (run the engine from an agent with a time limit, a memory cap, one engine per project, muted and offscreen) and `compatibility-renderer-traps` (Forward+ games that also run on Compatibility: the instance-uniform budget, black MultiMesh colors, sRGB vertex colors, paired captures).

### Changed
- With a store sign-in, the first `tools/list` waits up to 5 s for the hosted mount, so hosts that list tools once see the store tools. Without a sign-in nothing waits. A slower mount still adds them later.
- `summer_export_game` reads the engine version before it writes any preset. Below 0.7.0 it stops with `engine_too_old` and says how to update; nothing is written to the project.
- `summer_export_game` runs the engine with `--summer-no-api`, so an export no longer starts the local engine API. The result lists `projectChanges` (top-level files created, changed or deleted) and warns when the engine rewrote `project.godot`.
- `summer_publish_build` checks the game in the store before the confirmation preview. An unknown id returns `game_not_found` with your real games. A platform the store page does not list returns a warning. The preview shows the game name and id.
- `summer install --path` on macOS installs to `<dir>/Summer.app` (before, the bundle's contents went loose into the folder). Each install is recorded in `~/.summer/engine-install.json`, and run, doctor and export use that engine before the default locations. Without a terminal, progress prints one line per 10%. After an install, a note says the first start of a new engine version can take several minutes.
- `export-and-ship` skill: store key art, covers and icons carry no text, logos or UI; screenshots are real gameplay and may show the game's own HUD. On the hosted-game error "is in the source graph's authority_engine domain", narrow the authority root in `source-domains.json`.
- `concept-art` skill no longer says the aspect ratio cannot be set over MCP.

### Fixed
- `summer_export_game` failures show the engine's own `ERROR:` lines: the first three in the message, up to 20 in `detail.errors`, instead of a guess about an old engine. The old-engine hint appears only when the engine names a missing or invalid preset. A source-graph domain error gets its own recovery step.
- `summer_publish_build` without a `gameId` says why the game list is missing (for example the store's 401 message). `store_auth_refused` carries the store's message and request id and no longer sends you to `summer login --store --force` first, which looped.
- `gateway.url`, `creator.apiUrl` and the creator upload URL accept the IPv6 loopback (`http://[::1]:3000`) as local HTTP.
- `in-game-purchases` skill: uses only engine APIs that exist. It no longer calls `Summer.client.store.request_sparks_purchase`, `check_sparks_purchase_readiness` or `Summer.authority.items.consume`, which the engine does not have. Short players get Sparks in the Summer app; an authority grants a paid effect after checking `Summer.authority.items.inventory_for_session` and recording the redemption in the player's secret player data.
- `summer_api_docs`: the offline class reference is rebuilt from the engine's current class XML (1282 classes), so it now includes `SummerRuntime` (`Summer`), `Summer.client.*`, `Summer.authority.*` and the Summer SDK types.

## [3.3.0] - 2026-10-09

Your agent can now take a game from the editor to the Summer Games store:

- Export for every platform the store takes: iPhone, Android, Mac, Windows and the web, as a summer.games bundle or as a store download.
- Install the export templates for your engine version with one tool call. Each file is checked before it is installed.
- Sign in to the store from the terminal with `summer login --store`.
- Upload a build and publish it with `summer_publish_build`, after you confirm the game, file and version.
- Use the Studio, board and store tools (projects, store page, art, build upload, send for the owner's approval, the board, Grow) through the one Summer Engine MCP. After the store sign-in, the local MCP loads the hosted tools, prompts and resources next to the engine tools.

### Added
- `summer_export_game` (preview): exports the game for summer.games with the installed Summer Engine, headless and without a window (`--headless --path <project> --export-release "summer.games" <out>.zip`), and returns the `.zip` path, sha256, size and the bundle manifest (main scene, target platforms, hosted or not). The default output is `<project>/.summer/exports/`, ignored by the editor and by git. No running editor and no export template are needed.
- `summer_publish_build` (preview): uploads that `.zip` to the creator's game through the creator store routes Studio's export upload uses: declare the export, upload 64 MiB parts straight from disk to presigned URLs, seal, wait until Summer makes the Build, name its client pack, and with `publish: true` approve it. The first call returns the exact game, file, digest, size and version for the user to confirm. A retry with the same file and version continues the same upload. Defaults to the last export.
- `summer login --store`: browser sign-in to the Summer store (OAuth 2.1 with PKCE and a loopback redirect) against the hosted MCP's authorization server. The CLI is one public client: it listens on a fixed loopback port (47615, 47616 or 47617), registers its client once per machine for exactly those redirects (`~/.summer/oauth-client`) and reuses it on later logins and refreshes; `--store --force` registers a new one. The token and its refresh token live in `~/.summer/oauth-token`; `summer logout` clears it.
- `summer_export_game` `targets` and `format`: export in the exact file the Summer Games store takes per platform. `format: "bundle"` (default) makes the summer.games bundle for `ios`, `android`, `macos`, `windows` through a named `summer.games <targets>` preset written to `export_presets.cfg` (only its platform options are ever rewritten). `format: "download"` with one target makes the store's web build (`web`: an HTML5 `.zip` with `index.html` at the root, on Summer's WebGPU/JSPI Forward+ template, checked against the store's size limits; Compatibility-renderer projects are refused) or a desktop download (`macos`: ad hoc signed `.app` zip for `macos-universal`; `windows`: `.exe` with its pack embedded, zipped for `windows-x64`). Missing templates, platforms the installed engine cannot export and platforms the store will refuse come back as clear errors and warnings.
- `summer_export_templates` (preview): `list` and `install` export templates from Summer's CDN (`<base>/<summerVersion>/manifest.json`, schema `summer.export-templates.v1`; `SUMMER_TEMPLATES_URL` overrides the base) into the folder the engine reads, `<data>/Godot/export_templates/<FULL_CONFIG>/`, each file sha256-checked before it is installed.
- One Summer Engine MCP: with a store sign-in (`summer login --store`), the local MCP mounts the hosted Summer Engine MCP's tools, prompts and resources (mcp.summerengine.com: projects, store page, art, build upload, `summer_store_submit` for the owner's approval, the board, Grow, the publish-your-game, store-listing and store-art skills, the docs pointer) under their own names and forwards each call with that sign-in. A name the local MCP already has stays local. The mount runs after the server is up and never delays the engine tools; without a sign-in, `summer_store_tools` says how to sign in and mounts on the next call.
- `summer_publish_build` uploads web builds and desktop downloads (`summer_export_game` `format: "download"`) as the game's store version for `web`, `macos-universal`, `windows-x64` or `linux-x64` (the store's second build path): create, upload parts from disk (16 MiB for web, 64 MiB for native), complete, wait until checked. The platform comes from the last export or `platform`. A retry continues an unfinished upload of the same file and version and skips the parts storage has. Web zips are checked first (`index.html` at the root, at most 2000 files, 500 MiB). On a game that is already live the store leaves finishing the upload to the owner, and the tool says so.

### Fixed
- `summer_publish_build` accepted only iPhone for a game without a server; the store also takes Android (summer-platform `StandaloneTargets`). It now accepts `ios` and `android` and declares exactly the bundle's platforms.

### Deprecated
- `summer_creator_publish` and `summer publish` (a `.pck` to the legacy Summercraft creator API with a separate `sc_` token). Use `summer_export_game`, then `summer_publish_build`.

## [3.2.1] - 2026-10-07

### Changed
- The README now opens with what this package is: the MCP server, skills and CLI that connect AI coding agents to Summer Engine, and that it builds multiplayer games, adds analytics and publishes to summer.games.

## [3.2.0] - 2026-10-07

### Added
- Multiplayer skills, rewritten from scratch around Summer's own networking. `multiplayer` explains the model (one project, a client scene and a headless authority scene, Worlds, Sessions, queues, Local Play) and routes to a linked sequence:
  - `multiplayer-project`: the export-ready layout (`client/`, `authority/`, `network/`), `summer.build.json`, `world.json`, the runtime descriptor, the source graph, one network composition, joining a queue and a first Local Play run.
  - `multiplayer-movement`: client-side movement. The owner moves its character locally and publishes a pose to an owner-written State group bound to its player entity. The authority checks every pose with a refilling distance allowance and can teleport players with `reset()`. Others glide between poses 100 ms behind, ordered by authority acceptance time.
  - `multiplayer-state`: shared and private authority-written State groups, Commands with verified Sessions and request ids, and Transient Events.
  - `multiplayer-testing`: Local Play under latency, jitter and loss, bots driven through `-- --bot={client}`, and what a passing run must show. "Every client joined" alone can hide a composition that never attached.
  - `multiplayer-publish` (preview): the two export presets, the summer.games bundle, the source graph analyzer and native upload probe, and uploading a Build. `export-errors.md` lists every exporter message.
  - One skill per Summer SDK service: `summer-matchmaking` (preview), `summer-match-results`, `summer-leaderboards` (preview), `summer-parties` (preview), `summer-friends` (preview; needs an engine release with the Friends SDK), `summer-player-data`, `summer-world-saves` (preview), `summer-world-chat` (preview), `summer-store` (preview), `summer-analytics` (preview).
  - The core skills' code was run as written: a 2-player Local Play game at 100 ms round trip, 10 ms jitter and 1 % loss (movement, a refused teleport cheat, Commands, private state, Events), and a summer.games bundle export that passes the source graph analyzer and the native upload probe.
- Kit-placement tools (preview), built only on existing engine ops (a read-only `RunSceneScript` probe, then `SetProp` / `SnapToSurface` / `InstantiateScene` with the usual scene target, undo and final save). Every result is under 5 KB, names its evidence (`visual_aabb`, `physics`, `mesh_triangles`, `markers`) and declares any cut list:
  - `summer_inspect_asset`: measure a `.tscn`/`.glb`/`.gltf` (or Mesh) without adding it to a scene. A `summary` block comes first: AABB, origin label, the two largest opposite plane pairs with a `one_sided` flag per plane (its material culls back faces) and the ids of port-like open loops. Then per-mesh AABBs and triangle counts, the 6 largest planar faces, open boundary loops, Marker3D anchors, collision shapes. Open loops have stable ids by facing and position (`+Y` = the outermost loop facing +Y in the piece's own axes, `+Y#2` the next), never by radius, so the same id names the same loop in every pose. `detail: "summary"` (default) lists only port-like loops (radius over 2 cm with a partner loop facing another way, or the one opening of an end piece such as an outlet's socket), so a flat wall's outline no longer buries the facing; `detail: "full"` lists every loop. `maxTriangles` goes down to 100, and the summary says which budget covers a mesh the budget cut.
  - `summer_place_adjacent`: put one node's bounds face against another's along an axis, lining up the other axes per axis; verified by a fresh read.
  - `summer_attach_to_surface`: turn a piece's measured local back axis into a surface found by a ray (up kept), then seat its back face (the extreme of its visible bounds along the back axis, not its origin) with `SnapToSurface` at a standoff. The piece keeps its height and place along the surface (`placeAt: "current"`) unless `placeAt: "hit"` slides its back-face centre onto the ray hit. Before saving it refuses, and puts the piece back exactly where it started, when the seat lands on another node than the named surface (or, with a ray only, off the hit plane) or the piece would move more than `maxMove` (default 2). The receipt names `seated_on`, `final_gap`, `back_face_gap` and `moved_by`; a failed seat adds `blockers` (what the piece overlaps, whether it started overlapping, the first contact) and a `next_step`.
  - `summer_repeat_along`: instance up to 64 copies of a scene along a line by spacing or count, with a compact receipt of the created paths. N copies cost N + 2 engine requests.
  - `summer_connect_ports`: move and turn a piece so its port (open-loop id such as `"+Y"`, Marker3D name, or open-loop index) meets another piece's port; verified distance, angle and tilt. A join that would tilt the piece's up axis more than `maxTiltDegrees` (default 5) is refused before anything changes, with the predicted tilt and the ports that join within the limit, unless `allowTilt` is set. `rollDegrees` is documented exactly (axis = the target port direction reversed, right-hand rule, zero = the shortest turn from the current orientation), and the receipt adds `roll_axis` and `other_ports`: where each other port of the subject ends up (world position and outward direction), so a bend's free end needs no extra measure.
  - `summer_raycast`: one ray from any point; physics first, visual-AABB fallback declared.
  - `summer_measure`: gap or overlap per axis between two nodes, or face coplanarity across 2-32 nodes (proud / recessed).
- `summer_instantiate_scene` takes `position`, `rotation_degrees`, `scale` or `transform`, set on the node path the receipt reports right after the instance exists: one call per placed piece. The same fields work on `InstantiateScene` ops in `summer_batch`, where the transforms of a run of placed pieces travel in one request before the next other op: N placed pieces cost about N + 2 engine requests instead of 2N + 1.
- `summer_batch` gains `receipt: "summary"`: counts, failures with their op index, created node paths and renames, under 5 KB.
- `spatial-placement` skill: a question-to-tool table for every placement tool, a modular-kit workflow and a worked two-storey facade example with a downpipe, clamps and a lamp; `references/kit-placement-tools.md` documents each tool's arguments, results, limits and engine ops. `world-building-3d` routes kit placement to it.
- `summer_generate_motion` gains `backend: "text-to-motion"`: custom 2-second clips from text prompts on any of your own rigged models (humanoid, animal, creature, cartoon plant, prop; 5-70 bones). New fields `prompt` / `prompts` (1-8), `takes` (1-4), `lockJoints`, `cfgScale` (1.5-8) and `idempotencyKey`; one billed clip per prompt x take; poll `summer_check_job`, import with `summer_import_asset_by_id`. The server keeps the backend off until it is enabled and answers `backend_unavailable`; the tool then points back to `meshy-library`. `summer tool generate-motion` validates with the same schema.
- `text-to-motion` skill (preview): route, rigging for non-humanoids (human bone names, the talking-flower recipe), prompts and controls, failure codes. `asset-strategy` and `generate-motion` route custom and non-humanoid motion to it.
- Seeing tools (preview) for judging 3D environments like a player and an artist; every image inline (one grid per call), rendered from the saved scene with its REAL WorldEnvironment and lights, read-only, structured failures. `summer_frame_nodes` (fit a pose to node world bounds, optional bookmark and marks), `summer_shot_sheet` (N bookmarks/poses in one labelled grid; `compare_previous` adds previous / now / difference map), `summer_debug_views` (beauty, lighting, unshaded, normals, overdraw, wireframe), `summer_zoom` (exact sub-frustum of a region or mark N at full resolution), `summer_frame_shot` (smart framing for establishing / eye_level / low_angle / detail / corridor: thick-sweep visibility, selective occluders, near-lens check, low-angle rule, a small beauty render per pose, rule-of-thirds / fill / horizon / sky / depth / featureless-area / value-contrast / foreground scoring; top 3, best bookmarked, one sheet). Built on the existing ScenePreview op (a throwaway wrapper scene with a read-only @tool kernel, `assets/seeing/seeing_probe.gd`); no engine change.
- Bounded shot storage: one previous-image slot per rendered bookmark at `res://.summer/shots/<bookmark>.jpg` (JPEG, at most 1024 px, folder capped at 20 MB with oldest-first eviction) and explicit `save_to` copies; nothing else is written. `summer_screenshot framing:"bookmark"` keeps a clean render there when the bookmark has none, and gains `compare_previous` and `update_previous`.
- `verifying-scenes` gains an environment review section (the loop and a beauty rubric); the playbook gains a `seeing` section.
- `summer_scene_audit` (preview): one read-only call that walks every node of a 3D scene and lists likely visual and placement problems, at most 5 KB, sorted error / warn / look, each with node path, world position, reason, evidence numbers and the next tool; counts and editor time per check; `offset`/`limit` paging, `checks`, `root` (subtree) and `min_severity` filters; `render:"sheet"` adds one inline image of the page's first 6 issues framed from their open side. Checks: `through_hole` (capped ray grids through each facade line; rays that pass the wall and reach the far side of the building), `floor_gap`, `floating` / `sunken`, `interpenetration`, `orientation`, `uv_stretch`, `duplicate` / `z_fight`, `lights`, `transform`, `resource`. Every check works on any scene from geometry, the engine's node and resource data and materials alone, never node or file names or kit metadata: each piece's role comes from its shape (see-through cards are dressing, upright sheets walls, flat slabs floors, raised slabs with walls under them roofs, a large slab below the rest the underlay, a piece in a wall's opening an insert, bands, piers and corner blocks against a facade structure, the rest props). Built on the seeing tools' private-copy path (ScenePreview of a throwaway wrapper scene with a read-only @tool kernel, `assets/audit/scene_audit.gd`): the open tab never becomes unsaved; no engine change. `verifying-scenes` gains the audit loop and the playbook routes to it.
- `summer_scene_audit` check refinements:
  - `floor_gap` classifies each ray by the surface it hits first. An underlay plane above the floor's own drain channel or dip is "covers the floor" (warn), not a hole.
  - `floor_gap` also samples bare strips between each tile edge and a wall within 1 m.
  - `floor_gap` measures areas from the missed rays' own footprints, with the strip's size (a thin seam counts its own area, not whole grid cells).
  - `sunken` measures and names the surface a prop is buried in, seen from above.
  - `interpenetration` lists every partner a prop cuts (up to 3).
- `summer_scene_audit` `budget_ms` (default 3000): each check gets a weighted share of the editor time. A check past its share stops and shows `partial` (the share it covered) in its counts, and is never listed as clean.
- `summer_scene_audit` `z_fight` is exhaustive. A geometry pass (its own stage time) compares each mesh's planar face groups:
  - between any two pieces: props, roofs, ledges, side walls, inserts against hosts, decals; opposite-facing pairs only when both are double-sided;
  - between two surfaces of one mesh, reported once per mesh;
  - the ray samples still run.
  - "Coplanar" means a gap under twice the 24-bit depth step at the view distance (the nearest walkable eye point, camera or bookmark) for the main camera's near/far. `ev` carries the overlap, gap, tolerance and surfaces.
  - The material decides what is demoted to look, with the reason: `render_priority`, depth or normal offsets, a see-through (alpha) material such as a decal or overlay, no depth test or depth writes.
- `summer_scene_audit` gains three gap detectors. They run last in `budget_ms`, on the time the other checks leave, so no other check loses time to them. Like every check they decide from geometry alone: the pieces they look at are walls and the facade members (bands, piers, corner blocks) the roles found, and run pieces for open ends.
  - `exposed_edge`: open outline edges of walls, bands, piers and corner blocks (cached per mesh) that nothing covers within 4-7 mm and that walkable space sees (eye points over open-sky floor cells, flood-filled from the scene's cameras and characters, sight lines not through a building). Each comes with its reveal: a 2-60 cm step, a seam (the next sheet within 4 cm) or a gap (the next sheet within 35 cm). Band pieces warn. Wall pieces are look items, or warn when `depth_step` agrees. Band pieces are scanned first.
  - `open_fixture_end`: an open end of a run piece (a mesh with two or more open rims of one size: a pipe, duct or gutter section, an elbow, a tee) that nothing joins within 2.5 cm (sleeve tolerance), seen from walkable space (warn). A piece with one rim, or rims of different sizes (a cap, a funnel, an outlet), is open by design.
  - `depth_step` (look): ray rows across each facade at its band levels (band rows first) and every 1.25 m. It finds band recesses and missing band runs, seams, proud modules and holes with something behind them. A hole confirms a nearby `through_hole` (warn -> error). Runs a door-like opening (an insert reaching the floor) covers are skipped.
- `summer_scene_audit` `accept:[{key, reason}]`: look and warn items you judged fine are written to `res://.summer/audit-accept.json`, the only file the audit writes. Each issue carries a `key` (check:path@x,y,z, rounded to 0.1 m). Later audits count accepted items (`counts.<check>.accepted`, `accepted`) and hide them until their evidence changes materially (severity rises, or the measured size moves by over 25%); then they show again with `accept_stale`. Errors cannot be accepted. `show_accepted` lists them.
- `summer_grep` (preview): regex search over project files through the engine's ripgrep `Grep` op, which agents could reach only as an undocumented raw `summer_batch` op. Returns file, line and text per match; `context_lines` (0-10) adds the lines before and after each match (read back from the matched files, because the engine op drops ripgrep's context output); `path` (a res:// directory or file), `glob`, `case_sensitive`, `multiline`; `max_results` (default 50, max 500) with `truncated`; every line is clipped to `max_line_chars`. A missing path is `failure_reason: path_not_found` instead of a raw ripgrep error string.
- `summer_read_file` reads big files in parts. `offset` / `limit` page by lines (default) or bytes (`unit: "bytes"`, cut on UTF-8 boundaries), and `data.window` reports `start_line` / `end_line`, `total_lines`, `next_offset` and `eof`. For JSON, `json_path` returns one value (`pieces.wall_a`, `items[3]`), `keys` keeps matching object keys (`["wall_*"]`) and `keys_only` lists key names only; `data.json` says what matched. The sha256 stays the full-file receipt, so a windowed read still guards an overwrite. Without these arguments the call is unchanged.
- `summer_world_snapshot` filters: `path_prefix` (one subtree), `classes`, `fields` and `offset`. A filtered read adds `matched_nodes` and `matched_counts` (the subtree's class counts) and filters `lights` / `cameras` to the subtree. `counts`, `total_nodes` and the `snapshot_id` diff baseline still cover the whole scene.
- `summer_inspect_node` `fields`: only the named properties (globs allowed) plus derived `transform` (local position / rotation_degrees / scale and a `Transform3D` literal), `global_transform` (composed from the world snapshot), `scene_file_path`, `aabb` and `warnings`. Reading a transform drops from about 5 KB to a few hundred bytes.

### Changed
- `fps-controller`, `procedural-animation`, `make-game`, `browse-templates`, `using-summer` and the `.summer/` folder reference point at the new multiplayer skills and no longer suggest `@rpc` or `MultiplayerSynchronizer`.
- The `3d-lan-multiplayer-starter` template (host/join over Godot RPCs) is deprecated: it cannot use Summer hosting, matchmaking or identity.
- `summer_get_agent_playbook` gains a `placement3d` section: read `spatial-placement` first, then a question-to-tool map for the spatial tools that already ship (`summer_starcast`, `summer_test_placement`, `summer_snap_to_surface`, `summer_align_distribute_3d`, `summer_navigation_probe`, world snapshot + diff + screenshot) and the kit-placement tools (measure the piece, place it in one call, place relative, mount, repeat, join ports, raycast, measure), with their preview status.
- `summer_get_project_context` returns a compact payload by default (a few KB instead of tens of KB): project name and path, current and main scene, `sceneSummary` (root node and node count), `health` with scalar fields and capability counts, `projectMemory`, and the warnings. The open scene's tree, the engine's capability lists and the project settings come back with `include: ["scene_tree" | "capabilities" | "settings"]`; `settingsPrefix` / `settingsPrefixes` imply `settings`; `omitted` says how to ask for each block left out. Callers that read `scene`, `project` or `health.capabilities` must pass `include`.
- `summer_world_snapshot` lists at most 200 nodes by default, and `max_nodes` now caps the listed entries rather than the stored snapshot: the engine always snapshots the whole scene (its default 4000), so `summer_snapshot_diff` keeps seeing every change. `truncated` and `next_offset` say when the list is cut.
- `summer_generate_motion`: `motionName` is optional in the schema and still required for `meshy-library` (checked before any request); text-to-motion fields sent with `meshy-library` are rejected instead of silently ignored. The description lists the five motion aliases that always resolve instead of names that do not. `summer tool generate-motion` waits up to 10 minutes, like the MCP tool.
- Scene receipts carry `scenePersistence.saved` instead of `scenePersistence.persisted`: the engine sets that flag when the SaveScene ran, which says nothing about what the file holds. Callers that read `persisted` must read `saved`; `verified` appears only where a tool read the saved file back (`summer_replace_node`, `summer_batch` with ReparentNode, `summer_connect_signal`).

### Removed
- `setup-multiplayer`, `host-authoritative-state` and `peer-to-peer-multiplayer`, replaced by the multiplayer skills above. `summer setup --force` prunes installed copies.

### Fixed
- `summer_scene_audit`:
  - `transform` no longer flags correctly placed pieces whose global origin is the world origin. A piece is "left at the origin" only when its LOCAL transform is identity, its parent's is identity, it touches nothing and it is not one of a row of siblings. Several pieces sharing that transform are a warning each; one alone is a look item.
  - Screen-space quads (a post-process `extra_cull_margin` or a huge `custom_aabb`) are skipped. They were "sunken" and "at the origin".
  - `z_fight` evidence names the shared plane's `normal` and the axis to nudge (`nudge.world`, `nudge.local`), so a window insert whose head or jamb is the shared plane is not nudged along the facade normal.
- Seeing tools (preview):
  - Camera poses behind one-sided walls. The visibility pass now reads which side of each surface a ray meets (a short front-faces-only ray at the hit). A sight line that crosses a hard or subject surface from behind blocks like a wall, unless the material is transparent. A frame that is more than 25% surfaces seen from behind is rejected as `behind_surface`. So is a lens inside a closed shell (`inside_volume`) or within 0.3 m behind a back face. This removes `summer_frame_shot` corridor winners that stood behind a back wall and looked through its door hole.
  - `summer_frame_nodes` with an explicit `from` measures that exact pose plus about 20 nearby alternatives (wider lens, turned, raised or lowered). If walls block it, or it stands behind or inside a surface, the caption opens with a WARNING and the nearest valid `from` (+ `fov`). The requested view is still rendered. `receipt.view_check` carries the result.
  - Marks no longer pass off hidden nodes as visible. `summer_frame_nodes marks:true`, `summer_screenshot marks:true` (3D scene) and `summer_zoom mark` test each labelled node from the rendered camera (centre plus 4 points across the box face it shows). Hidden labels are noted `(hidden behind <path>)`, and a zoom on a hidden mark warns.
  - `summer_zoom` honours the region exactly. The region is no longer grown to 16:9 or padded by default. The image takes the region's own aspect, with dark bars only past 0.5-3.2. The caption reports the real zoom per axis and `widened_because`. `pad` defaults to 0 for `region` and to 0.15 for `mark`.
  - Establishing shots:
    - the top 3 are three different views: one per side of the subject while the score is within 0.15 of the best, and always at least 25 degrees apart. This also applies to low-angle and detail shots; eye-level looks are spaced 25 degrees apart;
    - a `light` term reads the strongest DirectionalLight3D: side or front-side light scores best, light from straight behind the camera (a flat-lit face) worst;
    - an `edge` term penalises sky or void below the horizon from 4% of the frame;
    - a `solid` term counts surfaces seen from behind.
  - `summer_frame_shot` eye-level and corridor cameras stay at eye height. Corridor winners could come back "adjusted: raised" well above eye height: the candidates included 2.4 m and 3.5 m eyes, and the ground-clearance check read a duct or balcony overhead as ground and lifted the camera over it. Now every eye-level and corridor pose stands 1.5-1.8 m (or exactly `eye_height`) above the walkable surface straight below the lens, within a step of the spawn's or corridor's floor, and is never raised. A pose that cannot stand there moves horizontally (along the view, then sideways) or is rejected (`no_walkable_ground`, `not_walkable`; a raised or off-height pose is `raised_above_eye` / `above_eye_height`). The corridor scan seeds on the walkable floor inside the subject (a 7 x 7 grid of downward rays from the subject's middle; the most common horizontal surface met from above with headroom for an eye wins) instead of the subject's lowest point, which walls sunk into the ground put under the floor. The caption and `receipt.scan_floor` say where it seeded, and a fallback to the lowest point is declared.
  - Establishing shots rank in tiers: a pose showing more than 15% empty ground (featureless ground or surroundings outside the subject's footprint, from the image check) or world edge ranks below every pose showing less, whatever its score.
  - Every `summer_frame_shot` top pose and tile label states the real camera height: metres above the first surface below it and the absolute y (`receipt.top[].camera_y`, `ground_y`, `height_above_ground`).
  - Transparent materials (alpha blend, scissor, hash, depth pre-pass, shaders that write ALPHA, instance fade) no longer block like walls. They get their own physics layer, outside every sweep. A sight line through them counts 0.8, and a grid cell counts half a soft cell. Meshes that mix opaque and transparent surfaces are split per surface.
  - `summer_shot_sheet` without `compare_previous` no longer overwrites each bookmark's previous image (the compare baseline). The same rule now holds for `summer_debug_views` and `summer_screenshot framing:"bookmark"` (MCP and `summer tool`). A plain render creates a missing baseline and keeps an existing one, and says so. Only `compare_previous:true`, the new `update_previous:true`, or re-saving the pose with `summer_frame_nodes` / `summer_frame_shot` replaces it.
- `summer_snap_to_surface` could not seat a prop sunk into its support: the engine backs a start overlap off, sweeps, then measures `hitTravel` from the original pose (negative when sunk) and refuses with `gap_exceeds_hit_travel`, so agents set the height by hand. When the subject starts inside its support the tool now lifts it against the cast direction by the overlap depth plus 2 cm (at most the subject's extent and 0.5 m; exact local position from the saved scene, mapped through the parent transform), snaps again, and keeps the result only when it settles on a node it was sunk into; otherwise it restores the original position. The receipt carries `recovery` (`lifted_by`, `original_local_position`).
- `summer_snap_to_surface` failed on props without colliders: collider-less ferns on a ground PlaneMesh all answered `overlap_recovery_exceeded`, "starts in contact with or inside (unnamed)". Without a collider on the subject or the support the engine falls back to `visual_aabb`, the subject's AABB swept against every other visible AABB, and one big AABB around it (a tree, a block, a post quad with a huge custom AABB) is an overlap no back-off clears; a seat can also rest on an AABB above the real surface. Whenever the engine answers with `visual_aabb` (that failure, `gap_exceeds_hit_travel`, `surface_not_found`, or a seat) a read-only probe measures the move from visible triangles: the subject's vertices cast along the direction onto the triangles of the meshes below (a surface through the subject means it is sunk and is lifted out, at most 0.5 m), plus the support's vertices under it cast back onto the subject. One SetProp places it, a second read verifies the gap (undone beyond 5 mm), and the scene is saved: `evidence: visual_mesh`, with the engine's answer under `engine`, `verify`, and `evidenceDetails` (samples, triangles, colliders). Screen-space meshes (a shader that writes `POSITION`) are not surfaces. When the triangles find no support either, the engine's failure comes back with `mesh_fallback`.
- `summer_snap_to_surface` failures `gap_exceeds_hit_travel` and `overlap_recovery_exceeded` said nothing about why. A read-only starcast at the current pose now adds `start_overlap`, `blocking` (the nodes the subject touches or sits inside), `below`, and a concrete `next_step`, also in the error text. Same implementation on `summer tool snap-to-surface`.
- `summer_replace_node` with `scene` lost the change silently: the editor showed the new piece and the receipt said ok, but the saved .tscn kept the OLD scene reference (with a new unique_id), so the swap reverted on reload. The engine's ReplaceNode routes through the editor's "Change Type" path, whose `Node::replace_by` copies the old node's `scene_file_path` onto the new instance. The tool now saves, reads the saved scene, and swaps through ops that persist: InstantiateScene under a temporary name, SetProp for each property override (transform, visibility, ...), ReparentNode for each child the scene added (re-owning deeper descendants the engine's ReparentNode leaves unowned), MoveNode to the old index, RemoveNode, rename, SaveScene. It then reads the file back and returns `persisted: true` only when the node at the path instances the new scene under the same parent with every child present; otherwise it is an error with `failure_reason: not_persisted`. State that cannot travel (groups, signal connections, scene-local sub_resource values, overrides of nodes inside the old scene) is listed in `not_carried_over`. A type change of a plain node keeps the engine op, which persists, and gets the same read-back. `summer_batch` refuses a raw `ReplaceNode` with `scene`. Same implementation on `summer tool replace-node`.
- `summer_batch` with `ReparentNode` lost the moved node's children and grandchildren on save while the op said ok: the engine's ReparentNode re-owns only the node it moves, and its `remove_child` clears the scene owner of everything below it, so the saved .tscn held `Cabinet/Box` but not `Box/Toy` or `Box/Toy/ToyPart`. A batch with ReparentNode now saves, reads the saved scene (which nodes the scene owns), sends each ReparentNode in its own request together with one in-place ReparentNode per scene-owned descendant (same parent, same live index, local transform kept), which gives each back to the scene, and after the final save reads the file again. `persisted: true` / `verified: true` only when every moved node and descendant is at its new path; otherwise an error with `failure_reason: not_persisted` and the missing paths. Nodes created earlier in the batch and renames after the move are followed. A move onto a parent that already has a child of that name is refused (`name_collision`), and so are `Undo` in the same batch and a binary `.scn`. `summer_replace_node` shares the same re-owning step. Same implementation on `summer tool batch`.
- `summer_inspect_resource` failed on every call with "missing nodePath or property", on a mesh `.res` and a `.glb` alike: it sent only `path`, but the engine's resource endpoint reads a resource a node holds and takes `nodePath` + `property`. `path` now loads the resource FILE read-only in the editor (a RunSceneScript probe): a Mesh returns its AABB, `surface_count`, per-surface primitive, vertex and index counts, attributes, triangles and material, the unique materials and blend shapes; a `.tscn`/`.glb`/`.gltf` returns its node count, first 40 nodes (type, instanced scene, mesh) and meshes, pointing to `summer_inspect_asset` for measurements; any other resource returns its editor properties that differ from the class default (`props`, `props_at_default`). `nodePath` + `property` reach the engine endpoint as it expects. Same implementation on `summer tool inspect-resource`.
- `summer_read_library` could not load a file a skill links: `spatial-placement` points to `references/kit-placement-tools.md` for arguments, result shapes and limits, but `reference/kit-placement-tools` was `not_found` and `part: "resource"` returned only resource.yaml. A linked file now loads by `<entry id>/<link as written>` (resolved inside `library/` only, text files only, at most 256 KB), by the relative path alone when exactly one entry ships it, and `reference/<slug>` falls back to the one `references/<slug>.md` an entry ships. Every body ends with its relative links and the id that loads each (`links` in the result); a link to another entry's `SKILL.md` or body resolves to that entry. A test walks every markdown file every skill ships and loads each link both ways. `realtime-wet-surfaces` linked a source record outside the package; it is now named, not linked.
- `summer_connect_signal` never saved the connection while the receipt said ok: the engine's ConnectSignal connects without `CONNECT_PERSIST` and reads no flags argument, so the saved .tscn had no `[connection]` line. The tool now connects through a RunSceneScript probe with `emitter.connect(signal, Callable(receiver, method), CONNECT_PERSIST)` (a non-persistent connection of the same pair, left by the old op, is replaced), saves (the run marks the tab unsaved; the save leaves it clean), reads the saved scene back and returns `persisted: true` / `verified: true` only when the `[connection]` line is there; otherwise `failure_reason: not_persisted`. A missing emitter, receiver or signal is a structured failure (`emitter_not_found`, `receiver_not_found`, `signal_not_found` with the emitter's signals). The probe runs in the active tab, so a scene in a background tab is brought forward and the user's tab restored (`tab_switched`). The scene must be a `.tscn`. `summer_batch` refuses a raw `ConnectSignal` before anything is sent. Same implementation on `summer tool connect-signal`.
- `summer_play` takes `players`, `spectators` and `queue` for Local Play on Summer multiplayer games. The engine starts the game's authority headless plus that many clients on this machine, each joining through the game's own `Summer.client.join`, with scenes and queue taken from the project's `summer.build.json`. The result's `local_play` block lists every process. An engine without Local Play ignores the keys and runs one client; the tool adds `local_play_note` saying so.

## [3.1.1] - 2026-09-11

### Fixed
- Skill descriptions no longer blow the hosts' skills context budget. Every SKILL.md description is now the skill's 160-character `summary` (94 skills: 13k characters, about 3.3k tokens, down from 32k characters). Codex had started truncating descriptions and Claude Code's budget is about 15k characters. Trigger phrases live in the skill body; `validate-library` fails when a description and its summary differ.
- `summer setup goose` / `hermes` on an empty config wrote the file as one flow mapping; new files are block-style YAML.

### Changed
- Agents whose docs read the agentskills.io folder now install skills to `~/.agents/skills` (project: `.agents/skills`) instead of each agent's own folder: Codex, Cursor, Zed, OpenCode, Copilot in VS Code, Devin Desktop, Amp, Crush, Warp, Kimi Code, Factory Droid, Rovo Dev, Grok Build; Antigravity, Goose, Hermes and Mistral Vibe at project scope. One install serves all of them and "where are the skills" has one answer. `skills install --force` removes the copies 3.1.0 wrote in the old per-agent folders.

## [3.1.0] - 2026-09-11

### Added
- `summer setup` now covers every MCP-capable coding agent with a user-editable config: Claude Desktop, Antigravity, Zed, Kiro, Goose, Hermes Agent, GitHub Copilot in Visual Studio and in JetBrains IDEs, Trae, Qwen Code, Kimi Code CLI, Crush, Amp, Factory Droid, Junie, Warp, Rovo Dev CLI, Qoder CLI, Grok Build, Mistral Vibe and Cline CLI join the existing targets (31 active agents). New file shapes: Zed `context_servers`, Amp `amp.mcpServers`, Crush `mcp`, Rovo `transport: stdio`, Mistral Vibe `[[mcp_servers]]` TOML, Goose and Hermes YAML (comments preserved), typed-stdio `mcpServers`.
- One agent table (`src/installer/agent-table.ts`) now holds every per-agent fact: label, aliases, MCP path per scope and OS, file shape, skills home, restart hint. `integrations/<id>/` folders, `AGENT_CLIENTS`, doctor's skill-marker probes and the docs tables are checked against it by tests.

### Changed
- Cursor skills install as `~/.cursor/skills/<skill>/SKILL.md` (Cursor's skills format) instead of `.cursor/rules/*.mdc`; `--force` removes the old rule files.
- Devin Desktop (formerly Windsurf) skills install as `~/.codeium/windsurf/skills/<skill>/SKILL.md` instead of a `.windsurfrules` block.
- Cline skills install to `~/.cline/skills` (shared by the VS Code extension and the CLI) instead of `Documents/Cline/Rules` markdown.
- OpenCode skills install to `~/.config/opencode/skills/<skill>/SKILL.md` (OpenCode's native skills folder) instead of `agents/summer/*.md`; `--force` removes the old files.
- Kilo Code config moved to `~/.config/kilo/kilo.json` (`mcp` key, array command, `enabled: true`) and `./kilo.json` for project scope, matching Kilo's current CLI + extension; skills go to `~/.kilo/skills`.
- Claude Code and Cursor entries now carry `type: "stdio"`, which both products' docs list as required.
- Project requests on agents with a user-only config now warn with one shared wording ("writing user scope instead"); Trae, whose user-level servers are UI-managed, writes its project file.

### Deprecated
- `gemini` (Gemini CLI, retired for individual accounts 2026-06-18) and `roo-code` (shut down 2026-05-15) still work but are hidden from help and warn on use; `antigravity` is the replacement for Gemini users.

## [3.0.0] (2026-09-09): "The Library"

v3 rebuilds the package around one idea: every resource is described once (`library/<kind>/<slug>/resource.yaml`) and everything else (the searchable index, every agent manifest, the skill and template registries, counts, aliases) is generated from it, with CI failing on drift. Migrating from v2: `docs/MIGRATION-V2-V3.md`. The design contract and the verified-vs-planned status live in the repository under `docs/design/`.

### Engine compatibility
- **Works with the shipped engine 0.5.65.** 61 tools have full function there (39 engine tools, live-verified on 0.5.65 with a real project, plus 22 engine-free tools). The 25 tools marked `status: preview` in the registry depend on engine ops that 0.5.65 does not have; on that engine they return a structured `engine_lacks_op` result (the two events tools: `engine_lacks_events`) on both the MCP and CLI face, before anything is sent, and name the fallback tool to use instead. They are: scripting (`run_script`, `world_snapshot`, `snapshot_diff`, `get_runtime_tree`, `inspect_runtime_node`), spatial (`test_placement`, `snap_to_surface`, `align_distribute_3d`, `navigation_probe`, `starcast`), `camera_bookmark`, `fabricate_3d`, editor UI (`ui_actions`, `ui_tree`, `ui_activate`, `ui_screenshot`), runtime control (`game_probe`, `game_control`, `game_input`, `runtime_set`, `runtime_call`, `runtime_spawn`, `runtime_animate`), events (`wait_for_event`, `recent_events`). `summer_run_editor_script` is stable and works on 0.5.65.
- **Full capability with engine 0.5.66+** (125 ops): every one of the 86 tools, `summer run` in the background posture, `summer open` editor targets through the engine's `Navigate` op. Verified end to end on 2026-09-09 through the toolkit's own launch path (`summer run --bin --background`): `capabilitySkewWarning` empty, placed GDScript running in the game, spatial and starcast ops applied.
- The running engine is the authority: `summer_get_project_context` reports `capabilitySkewWarning` naming every op this toolkit can send that the connected build does not advertise. Older engines than 0.5.60 keep the 2.8.1 batch-splitting behaviour; nothing below 0.5.60 was re-tested for this release.

### Breaking changes vs 2.8.x
- **Removed commands and tools.** `summer cloud` (and the seven `summer_cloud_*` MCP tools + the `summer-cloud` skill), `summer agent`, `summer logs` / `summer_creator_logs`. Tool count 62 → 86: 54 names unchanged, 8 removed (listed), 32 new. No MCP tool was renamed; no tool argument was renamed.
- **Skill layout.** `skills/<category>/<name>/` became flat `library/skills/<slug>/`; `references/` became `library/references/<slug>/`; `_persona/` is gone. Anything that read skills from the package path (`node_modules/summer-engine/skills/…`) must read `library/skills/`. Plugin-marketplace installs expose `/summer:<slug>` instead of `/summer:<category>/<name>`. Cross-references in prompts using the v2 `summer:<category>/<name>` form do not resolve; the old names are recorded in `registry/generated/aliases.json` but nothing resolves them at runtime yet (only legacy `template-<slug>` names in `summer create` do). **Installed skill snapshots are not refreshed automatically**: run `npx -y summer-engine@latest setup <agent> --yes --force` once (`summer doctor` flags the stale snapshot as `skills-version-stale`).
- **`summer setup <agent>` installs every skill** (94, preview ones labelled) instead of the recommended subset; `--recommended` restores the 2.8.x behaviour, `--stable-only` skips preview skills.
- **Templates are pinned.** `summer create <slug>` fetches an exact commit and verifies a tree digest instead of cloning a repository's default branch, and writes `.summer/project.json`; `summer list templates` reads the compiled registry, never a GitHub org listing. Legacy `template-<slug>` names still resolve.
- **Launch and play are quiet by default when an agent drives.** `summer run` launches the engine in the background (no focus steal) whenever stdout is not a TTY and the engine supports it (0.5.66+; older engines launch with focus and say so); `--focus` restores the old behaviour; a human in a terminal still gets focus. `summer_play` no longer switches the editor to the Game tab or grabs focus (`PlayGame agent:true`); `focus: true` restores the toolbar-Play behaviour. `summer run` with no path needs `--no-project` to open a bare editor.
- **Exit codes.** `summer <unknown-command>` exits 1 instead of printing the intro. `summer tool <name>` exits 1 on every result the MCP face marks `isError` (including `engine_lacks_op`).
- **Node 20+** (`engines.node >= 20`, was 18). Node 22.18+ is needed only to run the repo's TypeScript scripts, not the published package.
- **Package contents.** `library/`, `registry/generated/`, `registry/schemas/`, and `integrations/` ship; `skills/`, `references/`, and `_persona/` no longer exist. The root plugin manifests (`.claude-plugin/*`, `gemini-extension.json`, `.mcp.json`, …) are generated and version-stamped.
- `summer mcp setup <agent>` still works as a deprecated alias of `summer setup <agent>`.

### Added
- Optional image background removal (`removeBackground`) on `summer_generate_image` / `summer tool generate-image`, with a shared validated schema and searchable descriptor.
- **The librarian**: `summer_search_library` (BM25 over the compiled index, optional semantic fusion when an embeddings sidecar exists, lexical-only offline, never throws) returns ranked entries of every kind for a plain-words task description; `summer_read_library` loads one entry by id (a skill's body, a tool's call recipe, a template's pin, a reference's text), ending in the feedback footer (`entry_id@hash`) that `summer_library_feedback` reports against. Both engine-free, both faces (`summer tool search-library` / `read-library`). Preview entries never outrank stable ones on comparable evidence.
- **Navigation**: `summer open <target>` / `summer_open` / `summer tool open` opens the exact summerengine.com page or editor surface by intent (a product-map id such as `billing`, `my-games`, `mcp-guide`, `scene`, `inspector`; an intent phrase; a `res://` path; or a site path), in the browser (through `/login?returnUrl=` when needed) or in the running editor; `--print` resolves without opening, `--list` prints the map. Web rows come from summerengine.com's route catalog (vendored snapshot `assets/navigation/web-routes.json`); editor rows forward to the engine's `Navigate` op (0.5.66+) and fall back to the original ops (`OpenScene`, `SelectNode`, `OpenResource`, `FocusDock`, `RevealInFileSystem`) on 0.5.65. `summer open <project-dir>` is unchanged. Design: `docs/design/NAVIGATION-DESIGN.md`.
- **Launch posture** (`docs/TESTING.md` "Working in the background"): `summer run [--background|--focus]`: background is the default when stdout is not a TTY. The positive gate is a `<engine> --help` probe for `--summer-background` (cached per binary path + mtime in `~/.summer/launch-probe-cache.json`), never a version pre-check, so dev builds still stamped 0.5.65 are detected correctly; once up, `/api/health capabilities.launchPostures` is the authoritative advert and `summer_get_project_context` surfaces it. `summer_play` is quiet by default (`focus: true` opts in) and its result echoes `agent_quiet` or a `posture_note` when the engine predates quiet play.
- **CLI engine discovery** falls back to the instance registry (`~/.summer/instances/`, live = pid alive + `/api/health` answers) when the global api-token pointer is missing or stale; `SUMMER_ENGINE_PROJECT` / `SUMMER_ENGINE_INSTANCE_ID` pin the editor for the CLI face the way `summer mcp --project` / `--instance` do. `summer run --bin <executable>` / `SUMMER_BIN` launch an engine build that is not installed.
- **`summer setup --channel <dist-tag>`** (`SUMMER_CHANNEL`): the agent's MCP entry runs `npx -y summer-engine@<dist-tag> mcp`; use `--channel next` while a release soaks on the `next` tag; default `latest`, unchanged for everyone else.
- **MCP `instructions`** in the initialize response: the session entry guidance every host receives before the first tool call.
- **The Library** (`library/`): the v2 `skills/` and `references/` trees became flat `library/skills/<slug>/` and `library/references/<slug>/`, each with a `resource.yaml` descriptor (id, summary, `use_when`, facets, `related`, aliases for every old path); every MCP tool got a `library/tools/<slug>/` descriptor (implementation path, MCP/CLI surfaces, `input_schema`, `authority` booleans, `remote`); templates became `library/templates/<slug>/` pin manifests. JSON Schemas per kind in `registry/schemas/`. New skills: `scene-scripting`, `verifying-scenes`, `character-animation-wiring`, `world-building-3d`, `running-in-the-cloud`. The session entry skill `using-summer` is now installed by `setup` (v2 installed only the recommended subset, which never included it).
- **Registry compiler** (`scripts/generate-registry`): compiles `library/` into `registry/generated/` (`index.json`, `counts.json`, `aliases.json`, `skills-registry.json`, `templates-registry.json`) and applies every agent manifest at the repo root (`.claude-plugin/*`, `.codex-plugin/`, `.cursor-plugin/`, `.factory-plugin/`, `gemini-extension.json`, `.mcp.json`). `--check` is the CI parity gate. `scripts/validate-library`: schema validation, capability lint (allowlisted URLs only, no install commands, no credential references, no encoded blobs or invisible unicode), and cross-checks that every tool descriptor names a real module, export, and MCP registration.
- **`summer tool <name> --args '<json>'`**: every MCP tool from the shell, same implementation, arguments validated with the tool's own zod schema; `summer tool --list`. A descriptor ↔ zod parity test fails the build when a tool's `input_schema` disagrees with its registration (it found three drifted descriptors on its first run).
- **Pinned templates**: `summer create <slug>` resolves only through the compiled pin manifests: `git fetch --depth 1` of the exact commit, tree-digest verification (mismatch removes the directory), detached checkout; built-in templates (`builtin: true`) generate offline. The pin is recorded into **`.summer/project.json`** (`template {id, version, repo, commit, tree_digest}` or `builtin: true`, `toolkit_version`, `created_at`). `summer list templates` reads the same registry; there is no GitHub-org listing anywhere in the CLI.
- **`summer_library_feedback`**: the library outcome mailbox (worked / worked_with_fixes / wrong / outdated / incomplete / did_not_apply / misrouted, 280-char note and deviation). Sends entry ids, outcomes, `engine_version`, `agent_model`, `toolkit_version`, host `client`, a per-process `session_id`, and, when logged out, a random `install_id` uuid; nothing else. The first call on a machine sends nothing and returns a notice; `SUMMER_NO_TELEMETRY=1` / `DO_NOT_TRACK=1` disable it.
- **Scene scripting, perception, and spatial tools**: `summer_run_editor_script` (editor-side GDScript; stable, works on 0.5.65) and `summer_api_docs` (offline class reference, works without the engine); and, in preview (`engine_lacks_op` on 0.5.65, full function on 0.5.66+), `summer_run_script` (checkpointed scene scripts), `summer_world_snapshot`, `summer_snapshot_diff`, `summer_get_runtime_tree`, `summer_inspect_runtime_node`, `summer_import_hdri` (Poly Haven CC0 HDRIs), `summer_test_placement`, `summer_snap_to_surface`, `summer_align_distribute_3d`, `summer_navigation_probe`.
- **Mesh fabrication** (preview; `engine_lacks_op` on 0.5.65; the `FabricateMesh` op ships in 0.5.66): `summer_fabricate_3d` / `summer tool fabricate-3d` runs a Blender Python (bpy) script in the user's own installed Blender, headless and engine-supervised, imports the exported `.glb` into `res://` and optionally instantiates it with `target_size`. Summer never bundles or downloads Blender; a missing install comes back as a prescriptive `blender_not_found`. The `fabricating-assets` skill carries the route decision (fabricate vs generate vs library), the bpy rules that survive glTF export, and the failure taxonomy.
- **Stable viewpoints and deterministic playtests** (Summer Engine 0.5.66 or newer): `summer_camera_bookmark` saves/lists/deletes named camera poses in the project (`res://.summer/camera_bookmarks.json`; `engine_lacks_op` on older engines); `summer_screenshot` target `scene` gains `framing: "bookmark"` (+ `bookmark_name`) and `"free"` (+ `camera_position`/`camera_look_at`/`fov`) for before/after frames from one fixed pose, plus `marks`/`max_marks`, a Set-of-Mark overlay whose numbered labels the caption maps to node paths; older engines echo the preset they fell back to and the caption says the frame is not pose-stable. `summer_play` gains `seed` / `fixed_fps` / `time_scale` (sent as an explicit `PlayGame` op; the result narrates `determinism.applied`, `reason`, `seed_scope`, and says "not applied" when the engine predates the params). Skills `verifying-scenes` (stable viewpoints) and `playtesting-a-feature` (deterministic runs) updated.
- **Editor UI control** (preview; `engine_lacks_op` on 0.5.65; the seven `Ui*` ops ship in 0.5.66): `summer_ui_actions` (list the editor's named actions / invoke one exactly as its shortcut would), `summer_ui_tree` (structured Control tree, or every visible dialog with its blocking flag via `root:"dialogs"`), `summer_ui_activate` (press / toggle / focus / select_tab incl. the `main_screen` switch / set_text / set_value by tree path, plus `action:"dismiss_dialog"`), `summer_ui_screenshot` (PNG of the editor window or one control, honest `no_renderer` headless); the same four exist as `summer tool ui-*`. Semantic-first by design: scene work stays with the scene tools, there is no coordinate click, and quit / project-reload / delete-without-confirm actions are denied by the engine. The `driving-the-editor-ui` skill carries the blocking-dialog and main-screen patterns.
- **Runtime control & playtest tools** (preview; `engine_lacks_op` on 0.5.65; the runtime-control ops ship in 0.5.66): `summer_game_probe` (state + screenshot of ONE frame, frame-stamped, returned as an image), `summer_game_control` (pause / resume / step exact frames / speed / instances), `summer_game_input` (timed input scripts; record real input and replay it deterministically), `summer_runtime_set`, `summer_runtime_call`, `summer_runtime_spawn`, `summer_runtime_animate`, all instance-aware. `summer_play` gains `instance` / `mode:"offscreen"` / `deterministic` / `seed` / `fixed_fps` / `speed` (plain play is unchanged); `summer_stop` gains `instance`. The `agent-playtesting` skill carries the doctrine: deterministic launch, probe before/after, frame stepping for exact assertions, scripts vs recordings, what a seed does not pin.
- **Capability pre-flight**: `summer_get_project_context` reads the engine's capability list; tools whose op the running build lacks return a structured `engine_lacks_op` result instead of failing mid-flight. `SUMMER_CAPABILITY_PREFLIGHT=off` sends everything anyway.
- **Events channel** (preview; `engine_lacks_events` on 0.5.65; `GET /api/events` ships in 0.5.66): `summer_wait_for_event` blocks until a matching engine event arrives (`play.started` after `summer_play`, `op.applied` / `op.failed` filtered by `requestId`, `script.error` during a playtest, `scene.saved`, `import.completed`, …) or a bounded timeout elapses, reporting `timed_out` honestly and returning `next_seq` as the cursor for the next wait; `summer_recent_events` reads the newest events in one zero-wait poll (take its `next_seq` before triggering the action you will wait on); `summer events [--follow] [--kinds …] [--since N] [--json]` streams them from the shell over the same long-poll route (an SSE client is a follow-up). Engines without `capabilities.events` get a structured `engine_lacks_events` result on both faces before anything is sent.
- **Headless per-project routing** behind `SUMMER_HEADLESS_ROUTING=1` (`src/core/headless/`): with no editor open, file/import/scene-read/game-run ops route to a spawned engine worker; editor-only tools fail with an explicit "not supported by the headless worker". Unset, the module is never loaded. Needs the engine's worker mode (`--summer-worker`, 0.5.66+).
- **Linux** `summer install` (x86_64): installs the engine binary under `~/.summer/engine/` or symlinks a local build via `--path`; `SUMMER_ENGINE_BINARY` overrides engine discovery everywhere.
- **`SUMMER_TOKEN`** env override for the auth token (CI / cloud sessions); `summer status` and `summer logout` say when it is in effect.
- **Opt-in trajectory capture** (`SUMMER_TRAJECTORY_DIR`): per-tool-call JSONL for eval corpora; off by default.
- **Evals**: routing eval (`npm run eval:routing`, gated on a committed baseline; refuses a stale baseline or fallback corpus) plus a blind held-out set (`eval:routing:heldout`, report-only); per-kind eval contracts under `evals/`.
- **`integrations/`**: one folder per supported client (13) documenting exactly what `summer setup <client>` writes where; a test keeps it in step with the compiler's manifest targets.
- Playbook served natively as the `summer_agent_playbook` MCP prompt; `summer_get_agent_playbook` and `summer tool get-agent-playbook` share one implementation.

### Changed
- `summer_play` is quiet by default (`PlayGame agent:true`: no Game-tab switch, no focus grab, no render-health self-check; the game still runs embedded and is visible to `summer_is_running` / `summer_screenshot target:'game'` / diagnostics); `focus: true` launches like the toolbar Play button. One `playGame` implementation serves both faces.
- `summer setup <agent>` installs **every** skill in the library (v2 installed the recommended subset and silently skipped the entry skill); `--recommended` restores the subset. Skills and MCP config are installed in the same scope. Setup reports counts and destination.
- `summer install` no longer deletes an installed `/Applications/Summer.app` before copying the new one. An equal version exits 0 as "up to date"; replacing a different version needs `--yes` or a TTY confirmation; the new bundle is staged as `Summer.app.new` and swapped in only after the copy succeeds, so a failed copy leaves the old engine in place; Ctrl-C mid-download removes the partial DMG.
- `summer tool <name> --args <json>` is the argument flag (every other command's `--json` is a boolean output switch). Pre-release v3 builds accepted `--json <args>`; it still works for one release as a hidden alias and prints a deprecation note. 2.8.x had no `summer tool` command.
- `summer mcp setup <agent>` is a deprecated alias of `summer setup <agent>` (the one setup path: MCP config + skills + doctor). Its contributor-only `--local-dev` flag is hidden from `--help` (also honoured via `SUMMER_DEV=1`).
- `summer run` with no path requires `--no-project` to launch a bare editor; `summer <unknown-command>` exits 1 instead of printing the intro.
- `summer login` fails fast on terminal gateway answers (4xx, invalid token type) instead of polling for 15 minutes with the error hidden behind the heartbeat.
- One `resolveGatewayUrl()` for every gateway caller: `gateway.url` in `~/.summer/config.json` (and `SUMMER_GATEWAY_URL`) now steers login, token validation, feedback, creator publish/releases, and version checks alike; previously only login honoured it, so tokens for a dev gateway were posted to production.
- `summer skills list/install/info` and `summer setup` read the generated `skills-registry.json`; the hand-maintained TS `SKILL_REGISTRY` is gone. Skill cross-references use the bare slug (`use the design-mechanic skill`); the v2 `summer:<category>/<name>` form is retired.
- `withEngine` classifies validation and capability failures as `input` / `unsupported` instead of labelling every throw a transport failure ("may have partially applied").
- `authority` on `summer_generate_image`, `summer_creator_publish`, `summer_library_feedback`, and `summer_screenshot` now says `filesystem: true` (they write files); `surfaces.mcp.remote` is set explicitly on every tool.
- Package: `engines.node >= 20` (was 18; the scripts need Node 22+ to run TypeScript natively), `@modelcontextprotocol/sdk` ^1.30 (MCP v2 posture, stdio unchanged). `library/`, `registry/generated/`, `registry/schemas/`, and `integrations/` ship in the npm package.
- Docs: `AGENTS.md` is a four-part router (trust, understand, navigate, work); `CLAUDE.md` and `GEMINI.md` are thin shims over it; the README carries the agent install playbook. `docs/TEMPLATES.md` retired in favour of `library/templates/README.md`.

### Removed
- **`summer_frame_camera` / `summer_camera_visibility`** (never published; added and dropped within the v3 cycle): follow-up benchmarks showed the two spatial tools did not improve placement outcomes, so the MCP and `summer tool` faces, descriptors, skill guidance and canary entries are gone. Their engine ops (`FrameCamera3D`, `CameraVisibility3D`) may be removed from the engine as well.
- **Summer Cloud** (research preview): the `summer cloud` command group, the seven `summer_cloud_*` MCP tools, the `summer-cloud` skill, the `library/tools/cloud-*` descriptors, the sync engine under `src/core/capabilities/cloud/`, and cloud-token minting during `summer login`. It was not operational or maintained; Summer Platform publish/releases is the supported path. `summer-cloud.json` and `.summer/local/cloud/` in old projects are inert and can be deleted; `summer logout` still removes a legacy `~/.summer/cloud-token`. The `doctor` "Git (cloud checkpoints)" check went with it. Web-side cleanup (`/cloud` page, `app/api/cloud/*`, cli-login `cloudToken` minting) is a separate web-repo PR.
- **The v2 `skills/` and `references/` trees** and every hand-written plugin manifest; `library/` is canonical and the root manifests are build artifacts.
- **`summer agent`** (`src/cli/commands/orchestrator.ts`): a development-only launcher for the web app from a sibling checkout (hardcoded sibling paths, non-portable `URL.pathname`, `spawn("pnpm")` without a shell). It never belonged in the published CLI. Its `~/.summer/web-app-path` and `~/.summer/agent-port` files are inert.
- **`summer logs` / `summer_creator_logs`**: the command, MCP tool, `summer tool creator-logs` dispatch entry, and `library/tools/creator-logs` descriptor. The implementation could only ever throw `creator_backend_unavailable` (there is no platform runtime-log API), so every call failed by design. It returns when a durable log source exists.
- Dead `postinstall` entry (`src/bin/postinstall.ts`, never referenced by `package.json`) and the stale welcome box in `banner.ts` (`getWelcome`/`printWelcome`/`printBanner` with "cloud: animation, texturing" and `/help` copy). Only `getBanner` remains.
- Dead dependencies `ai` and `@ai-sdk/anthropic` (12.9 MB, imported by nothing) and the unused `diff` dependency; the unused `assertCredentialScopes` export.

### Fixed
- Three tool descriptors had drifted from their zod (`summer_library_feedback` missing the required `agent_model`, `summer_instantiate_scene` `target_size`, `summer_screenshot` `camera` framing); caught by the new parity test.
- Template pinning was documentation-only in the first v3 cut (`summer create` still cloned mutable default branches, nothing wrote `project.json`); the resolver now does what the docs said. Built-in templates no longer carry placeholder "self-pins"; the schema requires exactly one of `builtin: true` or a real pin. The one template whose repo is private is `status: preview`.
- 359 cross-skill references in the v2 `summer:<category>/<name>` form (none resolved), 46 broken relative links, and 20 references to skills that do not exist, purged from skill and reference bodies.
- The pre-commit doctor hook never fired in Claude Code or Cursor (wrong matcher shape); it now fires, is opt-in (`SUMMER_PRE_COMMIT_DOCTOR`), and is portable. The OpenCode plugin pointed at the deleted `skills/` directory and loaded zero skills; it now loads `library/skills/`.
- `summer open <path>` failed whenever the engine was not running (commander argument binding); `summer run` spawn errors are handled; `summer plan` routes on whole words (no more "spaceship" → ship, "build" → ui).
- `summer install` on Linux; the Gemini installer writes the generated manifest plus `GEMINI.md`/`AGENTS.md` into the extension dir; five integration READMEs corrected (factory is a marketplace-only target, kilo-code paths, gemini manifest, opencode config shape, scope mismatch).
- Corrupt `credential-metadata.json` no longer strands the auth token; `summer status` survives a corrupt `user.json`; store errors name the OS error code; `rebind()` fails typed instead of returning stale identity; `gameSnapshot` issues one request instead of a probe plus a capture; stale snapshot files are reaped.
- `summer_batch` no longer promises an undo step it cannot keep; the playbook's step 0 no longer leads with an op most shipped engines lack; login/run hints use `npx -y summer-engine@latest`.
- Capability lint: closed the false negatives found by a 58-probe smuggling audit; count-claims guard scans the docs that actually carry counts (`README.md`, `AGENTS.md`, `GEMINI.md`, `CLAUDE.md`, `library/references/**`, `integrations/**`, `.opencode/**`) and derives expectations from `counts.json`, never literals.
- Routing eval refuses to pass on a stale baseline or a fallback corpus; the op-drift tripwire runs when an engine checkout is available (`SUMMER_ENGINE_REPO`) instead of silently passing.
- CLI engine discovery (`summer tool`, `summer open`, debug reports) read only the global `~/.summer/api-token` pointer and reported "not running" for an editor launched `--summer-no-publish` or a second editor. It now falls back to the instance registry (`~/.summer/instances/`, live = pid alive + `/api/health` answers): one live editor is used, several are broken by the project enclosing the working directory, otherwise the error lists them. `SUMMER_ENGINE_PROJECT` / `SUMMER_ENGINE_INSTANCE_ID` pin the editor for the CLI the way `summer mcp --project` / `--instance` do.
- `summer create` had no network timeout, so a stalled template fetch could hang indefinitely. Every network git call is now bounded (`SUMMER_FETCH_TIMEOUT_S`, default 120), the child is killed on expiry, and the error names the repository, says the pin is unchanged, and how to retry. Credential prompts stay disabled (`GIT_TERMINAL_PROMPT=0`), so a private repository fails at once.
- `summer run` could only launch the installed engine. `--bin <executable>` / `SUMMER_BIN` (the name the autopilot scaffold already used) launch a build that is not installed; the `--help` background probe runs against that binary. A bare `.app` path is refused with the reason (the toolkit spawns the in-bundle executable directly; `open` would activate the app, a copied-out binary dies on its Sparkle @rpath), and an override that points nowhere is an error rather than a silent launch of the installed engine. `SUMMER_ENGINE_BINARY` stays honoured as the older name.

## [2.8.2] (2026-09-01): "Windows setup works out of the box"

### Fixed
- Windows: generated MCP configs now launch the server via `cmd.exe /c npx ...` instead of `command: "npx"`. `npx` is a `.cmd`/`.ps1` shim on Windows and Node's `spawn()` does no PATHEXT resolution, so agent hosts that spawn the command directly (Claude Code, Kimi Code, Cursor, ...) failed with `spawn npx ENOENT` even though npx worked in a terminal. Reported by Imitater967, thank you. Re-run `npx -y summer-engine@latest setup <agent> --yes --force` on Windows to rewrite the config; docs for manual configs carry the same note.
- Six shipped skills (`host-authoritative-state`, `setup-multiplayer`, `scene-composition`, `make-game`, `ui-basics`, `mcpupdate`) had unquoted colons in their YAML frontmatter descriptions; strict YAML parsers rejected the frontmatter and skipped the skill entirely. Descriptions are now quoted; all shipped skill frontmatter is YAML-validated.

## [2.8.1] (2026-08-18): "Scene mutations work again on engine 0.5.60+"

### Added
- `summer_get_scene_tree` accepts optional `depth` and `limit` params (engine defaults: depth 2, limit 200; a 102-node scene silently truncated to 61 nodes at the defaults). The engine only honors them on scene-targeted reads, so the tool resolves the current scene path first when needed and says so when it can't. `summer_get_project_context` accepts an optional `settingsPrefix` and, without one, trims `project.data.entries` to a curated prefix set (application/, display/, input/, physics/, rendering/) instead of returning the full ~188KB settings dump; the payload declares the trim via `settingsTruncated`/`totalSettings`/`settingsHint`.
- `summer_screenshot` scene captures accept `nodePath` (frame a specific node, honest `node_not_found` failure) and new framing directions `back`/`left`/`right`; captions report the resolved framing and any render retries. Requires engine 0.5.62+ to take effect; older engines silently ignore the new fields.
- `summer_get_diagnostics` returns a prioritized bounded view (errors first, then warnings, capped info tail) with honest suppression counters, plus `includeAll: true` for the untrimmed payload. Severity + recency + caps only, no noise-pattern matching.
- `scripts/compat-smoke.sh`: a latest-MCP × candidate-engine release gate that drives the real built MCP server against a live engine and fails loudly on batch-contract incompatibilities (the class of bug that broke 2.7.0–2.8.0 × engine 0.5.60+). Run it before every engine release and every npm publish.

### Fixed
- `summer_create_scene` no longer uses the destructive temporary-template strategy (open current scene → delete its children → save-as → restore). It now writes a minimal `.tscn` through the identity-bound engine `WriteFile` with a create-only guard, never touches the open scene, verifies by reading the file back, and gained a `rootType` param (Node3D/Node2D/Control). `allow_temporary_scene_mutation` remains accepted as a deprecated no-op.
- **Scene mutations were completely broken against engine 0.5.60/0.5.61.** The engine now requires `SaveScene`, `InstantiateScene`, `ReplaceNode`, `SimulateInput`, and the `Run*`/`Import*`/`Git*` ops to travel as their own single-op request, and rejects any multi-op batch containing one of them wholesale (`failure_reason: "unsupported_transport"`). Since 2.7.0 appended `SaveScene` to every mutation batch, every `summer_add_node`/`summer_set_prop`/`summer_batch`/`summer_create_scene` call was rejected before anything executed. Mutation batches are now automatically split into sequential requests around single-only ops; all receipts are preserved and merged, and a mutation that applied followed by a save that failed is reported honestly (including which ops already applied and which were not sent).
- Engine failures no longer hide the precise rejection. `extractOpError` previously returned a generic `"Engine operation failed (terminalState: failed)"` without inspecting `results[]`; it now surfaces the failed op's own error and `failure_reason` (envelope or per-op, either spelling), rendered as JSON when a classifier is present so agents can key on `failure_reason` reliably.
- `save_frame` is documented with its required `name` argument everywhere (`save_frame()` with no args is a probe script error), plus the deferred scene-mount pattern that avoids black frames.
- SimulateInput guidance corrected: it IS reachable over MCP/CLI as a single op against the running game (`failure_reason: "not_running"`/`"unsupported"` are the real failure modes); `"unsupported_transport"` only means it was batched with other ops. The previous claim that it needs the in-editor bridge on every build was stale.
- The scene-preview synthetic-camera note no longer claims the scene has no camera; the engine always synthesizes the preview camera; `sceneHasCamera` is the authoritative signal and keeps its own warning.
- `summer login` waits 15 minutes on one session id (was 2) with periodic reminders, covering first-time account creation + email confirmation. The gateway never expires a pending session, so the single id stays valid the whole window.
- Removed the stale "Engine mirror only" banner from the README (it shipped to npm and the public repo, and its claims were wrong).

## [2.8.0] (2026-08-17): "Multi-editor MCP routing"

### Added
- MCP discovers every live Summer editor through `~/.summer/instances/` and automatically binds local tools to the editor whose project contains the agent's current working directory.
- `summer mcp --project <path>` and `summer mcp --instance <id>` provide explicit selection for hosts that do not start the MCP server from a project directory.

### Changed
- Multiple live editors are now a fail-closed state when no project can be inferred. MCP lists the non-secret project/instance choices instead of following the machine-global last-opened editor pointer.
- Selected MCP sessions keep following the same project across editor restarts and validate registry identity against `/api/health` before connecting.

## [2.7.0] (2026-07-24): "Reliable project mutations"

### Added
- `summer_read_file`, `summer_write_file`, and `summer_replace_text` expose engine-routed project file access, including `.tscn` and `.tres`. New files require `create_only:true`; overwrites require an engine sha256 receipt.
- File mutations fail closed unless the MCP client has a complete engine/project identity and use the bound project hash even if caller options attempt to override it.

### Changed
- Agent playbooks now route project file mutations through Summer MCP instead of recommending host writes that bypass identity, content guards, and editor reload handling.
- Scene mutation tools require an explicit `scenePath`; the target scene does not need to be the visible editor tab.
- `summer_open_scene` is navigation only and no longer acts as implicit mutation targeting.
- Dedicated scene mutations and mutation batches append one final `SaveScene` at the transaction boundary.
- Agent guidance no longer claims that routine scene edits require stopping the running game.

### Fixed
- Bridge/project identity rejections now return one correlated `not_sent`
  terminal, allowing the web harness to retry safely instead of waiting for a
  mutation receipt that cannot exist.
- Same-file MCP mutations now serialize the complete read-to-write transaction,
  preventing concurrent replacements from racing on a stale file preimage.
- Accepted engine operations preserve their request identity and report whether
  they are still queued, still running, or uncertain instead of claiming that
  nothing was applied after a client wait deadline.
- `summer_batch` no longer permits raw file mutations that bypass the guarded
  `summer_write_file` and `summer_replace_text` tools.
- Scene operations return target/persistence evidence and concrete dependency errors instead of relying on ambient open-scene state.
- Asset placement reports success only after both the import and explicit target-scene mutation are confirmed.

### Limitations
- The package cannot intercept an external agent's native filesystem tools. A host can still mutate files outside MCP, and a non-atomic external write can race the engine between validation and write; those cases remain technically unenforceable.

## [2.6.6] (2026-07-15): "Project-bound engine requests"

### Fixed
- Every local engine request now carries the engine instance ID, stable project ID, project ID hash, and identity protocol version captured when the CLI connects. This lets compatible engine builds reject stale requests after a project or engine switch instead of acting on the wrong target.
- An explicit project rebind now refreshes the complete engine and project identity, while keeping the existing project-hash mutation guard and screenshot drift checks.
- Summer Cloud's engine bridge now binds its save, rescan, and scene reload requests to the project it verified on disk.

### Changed
- Summer Cloud is documented as an optional Research Preview instead of part of the core local CLI and MCP workflow.
- Release metadata and the manual npm runbook now pin the public registry and require a clean, reviewed public source checkout.

## [2.6.5] (2026-07-04): "Cloud tools don't need the engine"

### Fixed
- Tool descriptions now say explicitly which tools run in Summer's cloud and work WITHOUT the engine open (`summer_generate_*`, `summer_search_assets`, `summer_list_my_assets`, `summer_get_asset`, `summer_get_asset_download_url`, `summer_check_job`) and which need the engine (imports, scene ops). Agents were misreading a missing `npx summer-engine login` as "MCP requires the engine".
- The "Summer Engine is not running" error now tells the agent that cloud tools still work without the engine.

## [2.6.4] (2026-07-03): "See-Work + project binding" (unpublished, ships with 2.6.5)

### Added
- MCP session binds to its project; the engine rejects wrong-project writes (`identity_mismatch`) instead of applying them to whatever project is open.
- Structured per-tool-call stderr logging; agent playbook rewritten around the MCP verification ladder; honest game-capture failure states and identity-stamped reads.

## [2.6.3] (2026-06-30): "Agent vision"

### Added
- `summer_screenshot` MCP tool: capture the editor viewport or the running game as an image the agent sees directly (`target: "viewport" | "game"`, viewport by default). Lets the agent visually verify scene layout, asset placement, scale, framing, and runtime state; the client reads the actual frame, with no description step in between. Total MCP tool surface is now 52.

### Fixed
- MCP/CLI session now reconnects automatically after a transient engine restart (the engine rotates its api-token and can move its port on relaunch), instead of surfacing as a "disconnected" error.

## [2.6.0] (2026-06-10): "Summer Cloud"

### Added
- `summer cloud` command group: `init`, `status`, `push`, `pull`, `restore`, `checkpoints`: content-addressed project sync against Summer Cloud (R2-backed). Code stays in git; big assets sync by hash with three-way merge, conflict sets, and SummerGit checkpoints before any destructive apply.
- Matching MCP tools: `summer_cloud_init`, `summer_cloud_status`, `summer_cloud_push`, `summer_cloud_pull`, `summer_cloud_restore`, `summer_cloud_checkpoints`, `summer_cloud_conflicts`.
- `.summercloudignore` support plus built-in hard excludes (`.env*`, `.summer/local/`, `node_modules/`, OS junk) so secrets and machine-local state never upload.

### Safety
- Pulls stage to a temp dir and verify every blob hash before an atomic rename; mass-delete guardrails, edit-beats-delete conflict rule, and case-only rename handling for macOS/Windows volumes.

## [2.5.1] (2026-05-27): "README Polish"

### Changed
- Removed the pseudo-JSON status example from the npm README because npm syntax highlighting made normal setup statuses look like alarming errors.

### Fixed
- MCP generation requests now include client/tool attribution headers and surface provider 422 validation details instead of opaque `[Object]` failures.

## [2.5.0] (2026-05-27): "Project Memory"

Note: `2.1.0` through `2.4.0` were internal package/plugin snapshots in the engine repo. npm `latest` was still `2.3.0` before this release, so `2.5.0` is the public catch-up release for the memory, setup, and MCP reliability work.

### Added
- `summer memory`: read-only CLI view of `.summer` project memory, with `--json`, `show <file>`, and `path` subcommands.
- `projectMemory` in `summer_get_project_context`: lightweight summary of `.summer` canonical files and structured memory for agents.
- `.summer/memory/` convention for locked project facts such as voice IDs, world canon, provider bindings, and cross-session decisions.
- Project-memory checks in `summer status` and `summer doctor`.
- First-class `summer setup github-copilot` and `summer setup vscode-copilot` targets for Copilot CLI and GitHub Copilot in VS Code.
- Copy-paste setup prompt docs: users can paste "Install Summer Engine and let's make a game." into their AI environment instead of starting with npm commands.

### Changed
- `/summer:voice-line` now writes locked cast assignments to `.summer/memory/casting/voices.md`, while still reading legacy `.summer/voice-cast.md`.
- Agent playbook and `using-summer` now require agents to read relevant project memory before creative/audio/dialogue/level/character work.
- CLI and docs now link directly to the public source repo: `https://github.com/SummerEngine/summer-engine-agent`.

### Fixed
- MCP project context now falls back to engine health fields for project path, project name, and current scene.
- Mutating MCP tools now surface failure terminal states and no-results failure envelopes instead of masking them as success.

## [2.0.0] (2026-05-09): "Superpowers"

The plugin rebrand. Summer is now positioned as superpowers for AI game dev, installable in Claude Code, Codex (CLI + App), Cursor, Factory Droid, Gemini CLI, OpenCode, GitHub Copilot CLI, and Windsurf with one canonical command per harness.

### Added
- **`summer:using-summer`** meta-skill: establishes workflow priority, red-flag list, and skill-invocation discipline. Auto-loads on session start. Modeled on `superpowers:using-superpowers`.
- **`summer:debug`** skill: the missing flagship skill. Disciplined script-errors → console → debugger → hypothesize → propose → fix → verify loop. Honors all 4 cases in `tests/specs/debug.md`.
- **Manifest validator** (`src/lib/plugin-manifests.test.ts`): vitest test that walks every plugin manifest and verifies each referenced skill resolves to a real `SKILL.md` on disk. Also enforces the "Use when…" auto-trigger pattern in every skill's description.
- **`AGENTS.md`** + **`GEMINI.md`** at repo root: context primer for harnesses that read AGENTS-style files (Codex, Factory) and the Gemini extension.
- **`.opencode/INSTALL.md`**: explicit OpenCode setup guide.
- **`docs/marketplace-repo/`**: drop-in contents for the separate `SummerEngine/summer-marketplace` repo (Claude marketplace listing).
- Multiplayer skills (`host-authoritative-state`, `peer-to-peer-multiplayer`) added to all plugin manifests.

### Changed
- **Brand:** "Summer" replaces "Summer Engine CLI" across all plugin descriptions, READMEs, and orientation banners. The npm package stays `summer-engine` (continuity).
- **README** rewritten in superpowers-homepage style: install matrix per harness, philosophy section, basic workflow walkthrough.
- **MCP_STRATEGY.md** updated: documents the deliberate decision to NOT ship file/git/shell/grep tools (host agents have those natively). The then-current tool surface shipped.
- All 22 user-facing skill descriptions audited and rewritten to lead with "Use when X" for tighter auto-trigger.
- `.codex-plugin/plugin.json` `longDescription` rewritten: accurate skill count, mentions the host-native tool exclusion.
- `.opencode/plugins/summer.js` orientation banner updated to 22 skills with explicit process / discipline / build priority.

### Fixed
- **Critical:** 4 broken skill paths in `.claude-plugin/plugin.json` and `.cursor-plugin/plugin.json`. Plugin install would silently fail for `gdscript-patterns`, `ui-basics`, `asset-strategy`, and `debug` (the latter didn't exist at all). All paths now resolve.
- 2 missing HAVE-status multiplayer skills now listed in all manifests.
- TypeScript build excludes `*.test.ts` so `npx tsc` produces clean dist without vitest type leakage.

### Notes for plugin install
- After v2, `claude /plugin install summer@summer-marketplace` resolves cleanly. The `SummerEngine/summer-marketplace` repo (one-file marketplace) needs to be created and pushed; contents are in `docs/marketplace-repo/`.
- Existing `1.x` users updating: `npm update -g summer-engine` then `summer setup <agent> --yes` to refresh skill installs.

## [1.3.2] (2026-05-05)

### Fixed
- `summer_input_map_bind` syntax aligned across `fps-controller` SKILL.md and its behavioral test spec.
- `workflow/skill-test` static linter relaxed to allow forward-reference `See also` links to other SKILL.md files (warn instead of fail).

### Added
- `references/summer-folder.md`: canonical `.summer/` folder convention (documents files written by `/summer:brainstorm-game`, `/summer:art-direction`, etc.).
- `CHANGELOG.md`: retroactive v1.0.0 → v1.3.1 history.

## [1.3.1] (2026-05-05)

### Added
- ASCII banner displays on bare `summer` command (`npx summer-engine`).
- ANSI colors throughout: green ✓ for OK, yellow ⚠ for warnings, red ✗ for failures.
- Brand line + colored slash command list in setup output.
- `/debug` workflow skill: triage and fix a bug end-to-end via Summer MCP diagnostics.
- `/play` workflow skill: run the game and report state.
- 7 specialist skills marked `user-invocable: false` (auto-trigger only).

### Fixed
- `summer doctor` defaults to human-readable output instead of JSON.
- Engine path display shortened (`/Applications/Summer.app/Contents/MacOS/Summer` → `/Applications/Summer.app`).
- Home-relative paths now display tildeified.
- MCP server status no longer leaks "stdio" implementation detail (now reads "ready").
- `tools/summer-cli/src/bin/` finally tracked in git (root `.gitignore`'s `[Bb]in/` was silently excluding the npm entrypoint).
- `LICENSE` now bundled in the npm tarball.

## [1.3.0] (2026-05-05)

### Added
- 20-category skill library scaffold with descriptive folder names (`character-controllers`, `gameplay-mechanics`, `scripting-patterns`, etc.).
- `references/` directory with 5 canonical references (godot-version, mcp-tools-reference, collaborative-protocol, template-registry, gd-style).
- `workflow/` directory with 3 meta-skills (skill-test linter, skill-create bootstrap, skill-improve eval harness).
- `tests/specs/` directory with per-skill behavioral test specs (fps-controller as canonical format).
- `catalog.yaml`: 85-skill roadmap with HAVE / NEXT / LATER status.

### Changed
- 7 existing skills migrated into category folders with Anthropic-spec frontmatter (`category`, `template-id`, `allowed-tools`, `paths`).
- CLI `skills install` walks `<skillsDir>/<category>/<name>/` paths.

## [1.2.1] (2026-05-05)

### Added
- `summer setup <agent>`: one-shot MCP config + recommended skills install + doctor.
- `summer doctor`: node, login, engine, local API, MCP boot diagnostics.
- `summer mcp setup <agent>`: idempotent JSON/TOML config writer.
- Multi-agent skills install (codex, claude-code, cursor, windsurf with user/project scopes; Cursor `.mdc` rule generation; Windsurf rule blocks).
- Skill registry (`src/lib/skills-registry.ts`) with category metadata.
- Per-agent docs (OVERVIEW, CLAUDE_CODE, CODEX, CURSOR, SKILLS, TEMPLATES).

### Changed
- `/api/mcp/assets`: removed Pro gate; public/community asset search now free for all signed-in users (deployed on summerengine.com).
- `/api/mcp/log-local-call`: removed visible 100/week quota; auth-gated telemetry only.

## [1.2.0] (2026-04-23)

### Added
- Initial public release on npm.
- MCP server with 36 `summer_*` tools.
- 7 specialist skills (`fps-controller`, `gdscript-patterns`, `scene-composition`, `3d-lighting`, `ui-basics`, `asset-strategy`, `make-game`).
- CLI commands (`install`, `login`, `logout`, `status`, `run`, `open`, `create`, `list`, `skills`, `mcp`).
- MIT license.
