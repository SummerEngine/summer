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

## Tool surface (37 tools)

### Scene graph (10)

| Tool | Use |
|---|---|
| `summer_get_scene_tree` | Read current scene graph. Always do this before mutating. |
| `summer_open_main_scene` | Open the project's main scene. |
| `summer_open_scene` | Open a specific `.tscn`. |
| `summer_create_scene` | Create a new scene. |
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

### Diagnostics (5)

| Tool | Use |
|---|---|
| `summer_get_diagnostics` | Aggregate error/warning summary. Call after every change. |
| `summer_get_console` | Engine output panel. |
| `summer_clear_console` | Clear before a fresh play, so post-run output is clean. |
| `summer_get_debugger_errors` | Runtime errors with stack traces. |
| `summer_get_script_errors` | Script compilation errors. |

### Asset library (2)

| Tool | Use |
|---|---|
| `summer_search_assets` | Free public asset search (community library + user's own). Sources: `library`, `community`, `my_assets`, `all`. |
| `summer_import_asset` | Download a found asset and run import. |

### Asset generation (4 — metered)

| Tool | Use |
|---|---|
| `summer_generate_image` | AI image gen. |
| `summer_generate_3d` | Image-to-3D. |
| `summer_generate_audio` | SFX / music gen. |
| `summer_generate_video` | Video gen. |

### Job tracking (2)

| Tool | Use |
|---|---|
| `summer_check_job` | Poll a generation job. |
| `summer_batch` | Run multiple ops as a transaction. |

### Meta (2)

| Tool | Use |
|---|---|
| `summer_get_project_context` | Project structure summary — call at start of session. |
| `summer_get_agent_playbook` | Daily operating contract — call at start of session. |

## Common pattern

Every scene-touching skill should follow this loop:

1. `summer_get_project_context` — orient.
2. `summer_get_agent_playbook` — read the rules.
3. `summer_get_scene_tree` — see what's there.
4. (mutations: `summer_add_node`, `summer_set_prop`, `summer_connect_signal`, ...)
5. `summer_save_scene` — persist.
6. `summer_get_script_errors` — catch GDScript breakage.
7. `summer_play` → `summer_get_debugger_errors` → `summer_stop` if verifying runtime.

## Trap: silent-fail on inline sub-resource SetResourceProperty

`summer_set_resource_property` will silently fail if the target resource is an inline `sub_resource` rather than a standalone `.tres`. If you need to set nested properties (mesh size, shape radius, material color), make the resource standalone first:

```
summer_add_node(... mesh = "BoxMesh" ...)         # creates inline sub_resource
# WRONG: summer_set_resource_property("./Box", "mesh.size", "Vector3(2,2,2)")  ← silently fails
# RIGHT: save mesh as .tres, then SetResourceProperty
```

This is documented in `public/knowledge/asset_pipeline.json`.
