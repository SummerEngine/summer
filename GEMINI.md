# Summer — Context Primer for Gemini

Summer is the AI game-dev studio for **Summer Engine** — the AI-native game engine. When you see this file in a session, it means the user has installed the Summer Gemini extension and you have access to the `summer-engine` MCP server plus Summer skills under the `summer:` namespace.

## What Summer Engine is

A game engine designed for AI agents. The user is making a **Summer game**
with the **Summer SDK**. Editor, scene graph, asset pipeline, and runtime are
instrumented for programmatic control via MCP. GDScript (`.gd`) is the default
language; C# (`.cs`), scenes (`.tscn`/`.scn`), and resources (`.tres`/`.res`)
are also supported. Talk to the engine through `summer_*` tools, and use the
bundled technical compatibility reference for version-sensitive upstream APIs.

## How to behave

**Always check for a relevant Summer skill before writing code or running tools.** Skills encode discipline that matters — debug protocols, scene-composition rules, GDScript idioms Gemini regularly gets wrong. If a skill might apply, even at 1% probability, activate it via `activate_skill`.

The single most important skill to know is `summer:using-summer` — it explains the workflow, priority, and the red-flag table of rationalizations the model needs to resist. Activate it first thing in any Summer Engine session.

## Skill priority

1. **Process skills first**: `brainstorm-game`, `debug`, `play`. These determine HOW.
2. **Discipline skills second**: `gdscript-patterns`, `scene-composition`, `art-direction`, `audio-direction`. These shape content.
3. **Build skills third**: `fps-controller`, `design-mechanic`, `design-level`, `setup-multiplayer`, `vfx`, `tune-performance`, `export-and-ship`.

## MCP tools (when the project-matched local editor is running)

The `summer-engine` MCP server exposes 62 tools. The most important:

- **Scene mutation**: `summer_add_node`, `summer_set_prop`, `summer_set_resource_property`, `summer_remove_node`, `summer_save_scene`, `summer_replace_node`, `summer_batch`. Every scene mutation requires the exact `res://...tscn` `scenePath`; opening a scene is a user-visible UI action, not a mutation prerequisite. Mutation tools append one final `SaveScene`; raw engine batches must do the same.
- **Scene inspection**: `summer_get_scene_tree`, `summer_inspect_node`, `summer_inspect_resource`.
- **Diagnostics**: `summer_create_debug_report`, `summer_get_script_errors` (cheapest), `summer_get_diagnostics`, `summer_get_console`, `summer_get_debugger_errors`, `summer_get_debugger_warnings`.
- **Run game**: `summer_play`, `summer_stop`, `summer_is_running`.
- **Visual**: `summer_screenshot` (capture the viewport or running game as an image you can see).
- **Project**: `summer_get_project_context`, `summer_open_main_scene`, `summer_project_setting`, `summer_input_map_bind`.
- **Files**: `summer_read_file`, `summer_write_file`, `summer_replace_text` (identity-bound, create-only or sha256-guarded mutations).
- **Assets**: `summer_search_assets`, `summer_import_asset`, `summer_import_from_url`, `summer_generate_image`, `summer_generate_3d`, `summer_generate_audio`, `summer_generate_video`, `summer_check_job`.

Git, shell, and grep remain host-native. Use the Summer file tools for project reads and writes whenever MCP is available; host file writes bypass engine identity, sha guards, and reload handling and cannot be technically prevented by this package.

## Type-system traps

`SetProp` values are Summer Engine-formatted **strings**:

- `"Vector3(0, 10, 0)"` — NOT `{x: 0, y: 10, z: 0}`.
- `"Color(1, 0.5, 0, 1)"` — RGBA, 4 components.
- `"Transform3D(1,0,0, 0,1,0, 0,0,1, 0,5,0)"`.

Resources are class names: `"BoxMesh"`, `"StandardMaterial3D"`, `"CapsuleShape3D"`.

**Trap**: never call `summer_set_resource_property` against an inline `sub_resource` — the value silently drops. Use `summer_set_prop` with a class-name string first to instantiate a standalone resource, then drill in.

## When the engine isn't running

Tools return "Summer Engine is not running." Tell the user to run `summer run` (or open the engine and load the project), then continue with non-MCP work in the meantime. Do NOT fall back to editing `.tscn` files directly — the editor holds in-memory state that diverges from disk.

## Setup help

If skills aren't loading or the MCP server fails:

- `npx -y summer-engine@latest setup gemini --yes --force` — writes the right MCP config.
- `npx -y summer-engine@latest doctor` — reports auth, engine, port, project memory, and skill state.
