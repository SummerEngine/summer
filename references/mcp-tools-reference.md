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

## Tool surface (62 tools)

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

### Play / runtime (3)

| Tool | Use |
|---|---|
| `summer_play` | Run the game. |
| `summer_stop` | Stop the running game. |
| `summer_is_running` | Check play state before deciding to call `summer_stop`. |

### Visual capture (1)

| Tool | Use |
|---|---|
| `summer_screenshot` | Capture a frame and return it as an image the agent sees directly — editor viewport (`target:"viewport"`, default; no play needed) or running game (`target:"game"`). Use to visually verify scene layout, asset placement, scale, framing, lighting, or runtime state. On macOS the running game is a floating window that can't be captured; prefer `viewport`. |

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

### Asset library (6)

| Tool | Use |
|---|---|
| `summer_search_assets` | Free public asset search (community library + user's own). Sources: `library`, `community`, `my_assets`, `all`. |
| `summer_list_my_assets` | List/search the signed-in user's generated and uploaded assets. Empty query lists recent assets. |
| `summer_get_asset` | Fetch one exact asset by ID with file URL, download URL, viewer URL, metadata, license, and visibility. |
| `summer_get_asset_download_url` | Get the primary or thumbnail download URL for a specific asset. Stable shape for future signed URLs. |
| `summer_import_asset` | Search, choose the top match, download, run Godot import, and optionally instantiate 3D models. |
| `summer_import_asset_by_id` | Import one exact Summer asset ID. Use after generation jobs or when the user selects a specific asset. |

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

### Meta (3)

| Tool | Use |
|---|---|
| `summer_start_game_task` | Route a user goal into the right workflow, skills, MCP tool groups, asset policy, gates, and verification path. |
| `summer_get_project_context` | Project, scene, and `.summer` memory summary — call at start of session. |
| `summer_get_agent_playbook` | Daily operating contract — call at start of session. |

### Cloud sync (7)

| Tool | Use |
|---|---|
| `summer_cloud_init` | Enable Summer Cloud for a project. |
| `summer_cloud_status` | Show Summer Cloud sync status. |
| `summer_cloud_push` | Push local project changes to Summer Cloud. |
| `summer_cloud_pull` | Pull Summer Cloud changes into the local project. |
| `summer_cloud_restore` | Restore a retained cloud version, or a local pre-sync checkpoint. |
| `summer_cloud_checkpoints` | List local pre-sync checkpoints. |
| `summer_cloud_conflicts` | List conflict sets, or restore a preserved conflict file. |

### Creator platform (4)

| Tool | Use |
|---|---|
| `summer_creator_publish` | Compute the exact `.pck` digest and size, require user confirmation, then run versioned prepare → write-once upload → finalize. |
| `summer_creator_releases` | List real creator-owned releases from `summer.creator.v1`, preserving opaque pagination cursors. |
| `summer_creator_logs` | Fail closed until a durable, authorized, redacted runtime-log source exists. |
| `summer_creator_config` | Read or confirm changes to shared non-secret configuration. It never accepts or returns tokens. |

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

## Trap: silent-fail on inline sub-resource SetResourceProperty

`summer_set_resource_property` will silently fail if the target resource is an inline `sub_resource` rather than a standalone `.tres`. If you need to set nested properties (mesh size, shape radius, material color), make the resource standalone first:

```
summer_add_node(... mesh = "BoxMesh" ...)         # creates inline sub_resource
# WRONG: summer_set_resource_property("./Box", "mesh.size", "Vector3(2,2,2)")  ← silently fails
# RIGHT: save mesh as .tres, then SetResourceProperty
```

This is documented in `public/knowledge/asset_pipeline.json`.
