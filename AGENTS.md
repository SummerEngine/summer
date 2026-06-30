# Summer — Agent Context

This file is for any AI agent that loads context from `AGENTS.md` (Codex CLI, Factory Droid, etc). It mirrors the Summer onboarding rules — see `GEMINI.md` for the same content keyed for Gemini.

## What you're working with

**Summer Engine** is the AI-native game engine the user is building in. Editor, scene graph, asset pipeline, and runtime are all instrumented for programmatic control via the `summer-engine` MCP server. Summer Engine is compatible with Godot 4.5 — projects use GDScript (`.gd`), C# (`.cs`), scenes (`.tscn`/`.scn`), and resources (`.tres`/`.res`). Write code in those languages; talk to the engine through MCP tools.

## Critical rules

1. **Always check for a relevant Summer skill before responding.** Even a 1% chance a skill applies = invoke it. Start with `summer:using-summer` on every fresh Summer Engine session.
2. **The user owns fix decisions.** Diagnose first, propose, ask, then edit.
3. **Don't grep the whole project before reading the actual error.** Use `summer_get_script_errors` first.
4. **Don't edit `.tscn` files directly while the engine is running.** Use the `summer_*` MCP tools — direct edits get overwritten when the editor saves.
5. **Never call `summer_set_resource_property` against an inline `sub_resource`** — it silently drops the value. Instantiate via `summer_set_prop` with a class-name string first.

## Skill priority

- **Process** (`brainstorm-game`, `debug`, `play`) → how to approach.
- **Discipline** (`gdscript-patterns`, `scene-composition`, `art-direction`) → how to shape it.
- **Build** (`fps-controller`, `design-mechanic`, `design-level`, `setup-multiplayer`, `vfx`, `tune-performance`, `export-and-ship`) → produce the artifact.

## MCP tool palette (engine on `localhost:6550`)

52 tools total. Categories:

- Scene: `summer_get_scene_tree`, `summer_open_scene`, `summer_create_scene`, `summer_add_node`, `summer_set_prop`, `summer_set_resource_property`, `summer_remove_node`, `summer_save_scene`, `summer_instantiate_scene`, `summer_replace_node`, `summer_select_node`, `summer_inspect_node`, `summer_inspect_resource`, `summer_connect_signal`, `summer_batch`.
- Diagnostics: `summer_get_script_errors`, `summer_get_diagnostics`, `summer_get_console`, `summer_clear_console`, `summer_get_debugger_errors`, `summer_get_debugger_warnings`.
- Runtime: `summer_play`, `summer_stop`, `summer_is_running`.
- Visual: `summer_screenshot` (capture the editor viewport or running game as an image to verify it).
- Project: `summer_get_project_context`, `summer_open_main_scene`, `summer_project_setting`, `summer_input_map_bind`, `summer_get_agent_playbook`.
- Assets: `summer_search_assets`, `summer_list_my_assets`, `summer_get_asset`, `summer_get_asset_download_url`, `summer_import_asset`, `summer_import_asset_by_id`, `summer_import_from_url`, `summer_import_from_url_batch`.
- Generation: `summer_generate_image`, `summer_generate_3d`, `summer_generate_audio`, `summer_generate_video`, `summer_generate_motion`, `summer_check_job`.
- Meta: `summer_start_game_task`.

File ops, git, shell, and grep are NOT exposed — use the host's native tools.

## Type-system gotchas

`SetProp` values are engine-formatted strings (Godot type-system compatible), not JSON objects:
- `"Vector3(0, 10, 0)"`
- `"Color(1, 0.5, 0, 1)"` (RGBA, 4 components)
- `"Transform3D(1,0,0, 0,1,0, 0,0,1, 0,5,0)"`

Resources are class names: `"BoxMesh"`, `"StandardMaterial3D"`, `"CapsuleShape3D"`.

## When something is off

| Situation | Action |
|---|---|
| MCP tool returns "Summer Engine is not running" | Tell user `summer run`. Continue with non-MCP work. |
| Skill loads but seems wrong | Re-read it. Skills evolve. |
| Skill not found | Check `summer skills list`, then `summer setup <agent> --yes`. |
| Generic engine errors on launch | Run `summer doctor` first — usually reveals auth/port/path issues. |
