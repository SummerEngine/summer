# Summer MCP Tools — Canonical Reference

> Use this as the single source of truth for which Summer MCP tool to call. Skills should reference tool names exactly as written here.

## When to use Summer MCP vs. host file edits

**Use Summer MCP for** anything that needs the live editor or Godot's import pipeline:
- Scene graph mutation (`.tscn`)
- Node properties and resources (`.tres`)
- Project settings (`project.godot`) and InputMap
- Asset import (Godot's import pipeline must run)
- Play / stop / runtime state
- Diagnostics, console, debugger output, script errors

**Use the host agent's file tools for** plain text:
- `.gd` GDScript files
- `.cs` C# files
- `.json`, `.md`, `.txt`, `.yaml`
- Most simple `.tres` resources where the structure is well-known

**Rule of thumb:** if Godot's importer or the live editor needs to know about it, MCP. Otherwise, file edits.

## Tool surface (52 tools)

The machine-checkable snapshot is
[`mcp-tool-inventory.json`](./mcp-tool-inventory.json). Run
`npm run check:mcp-contract` whenever a tool is added, removed, or renamed; the
check compares runtime registrations, this reference, and the snapshot.

### Scene graph (11)

| Tool | Use |
|---|---|
| `summer_get_scene_tree` | Read current scene graph. Always do this before mutating. |
| `summer_open_main_scene` | Open the project's main scene. |
| `summer_open_scene` | Open a specific `.tscn`. |
| `summer_create_scene` | Create a new scene. |
| `summer_instantiate_scene` | Add an existing scene or 3D model as a child node. |
| `summer_inspect_node` | Read a single node's properties. |
| `summer_add_node` | Add a node to the active scene. |
| `summer_remove_node` | Remove a node. |
| `summer_replace_node` | Swap a node's type, preserving children. |
| `summer_select_node` | Set editor selection (visual feedback for the user). |
| `summer_save_scene` | Persist changes. **Always save before play.** |

### Properties / resources (4)

| Tool | Use |
|---|---|
| `summer_set_prop` | Set a typed property (Vector3, Color, etc.) using Godot's `str_to_var()`. |
| `summer_set_resource_property` | Set a property on a nested resource (e.g., CollisionShape's `shape.radius`). |
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

### Diagnostics (6)

| Tool | Use |
|---|---|
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

Animated-character ambiguity is a text-only continuation. A successful MCP
call may return structured content with `status: "needs_user_input"`,
`question`, `candidates`, `resume`, and the original `idempotencyKey`. This is
not an MCP error and there is no menu, card, or `requestUserInput` tool. The
host agent asks `question` in ordinary text, applies the user's selection to
the provided resume request, and resubmits with the same idempotency key.

### Job tracking (2)

| Tool | Use |
|---|---|
| `summer_check_job` | Poll a generation job. |
| `summer_batch` | Run up to 50 allowlisted scene mutations in one undo group. The complete batch is validated before transport. |

`summer_batch` accepts only `AddNode`, `SetProp`, `SetResourceProperty`,
`RemoveNode`, `InstantiateScene`, `ConnectSignal`, and `ReplaceNode`. File,
Git, shell, restore, live-input, verification, internal-diff, and unknown
operations are rejected before the engine receives any item. Use the host's
native file, search, shell, and Git capabilities instead. Summer MCP does not
currently expose a typed verification-probe tool because no public source-size
limit has been established.

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

## Common pattern

Every scene-touching skill should follow this loop:

1. `summer_start_game_task` — route the goal into skills/tools/gates.
2. `summer_get_project_context` — orient.
3. `summer_get_agent_playbook` — read the rules.
4. `summer_get_scene_tree` — see what's there.
5. (mutations: `summer_add_node`, `summer_set_prop`, `summer_connect_signal`, ...)
6. `summer_save_scene` — persist.
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
