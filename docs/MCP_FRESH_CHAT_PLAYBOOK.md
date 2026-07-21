# Summer MCP Fresh-Chat Playbook

The minimum safe workflow for AI agents building in a Summer Engine project.

## Build flow (default)

1. **Understand** the request, then outline a brief plan. Proceed once it's clearly right.
2. **Call `summer_get_project_context` first** so you don't guess scene paths or the project language and so the MCP session binds to the open project. Use `projectMemory` to decide which `.summer` files to read.
3. **Edit through identity-bound Summer tools.** Use `summer_read_file`, `summer_replace_text`, and guarded `summer_write_file` for `.gd`, `.tscn`, `.tres`, `.cs`, `.json`, docs, and config. Write GDScript by default; use C# only if the project already uses it.
4. **Play and iterate.** After writing code, **play the scene you just made** and read `summer_get_diagnostics`; fix and repeat until it launches clean — don't wait for the user to navigate to the feature before the first error shows.

## When to use Summer MCP (the live engine)

Use MCP for both guarded project file mutations and live-engine work:

- `summer_play` / `summer_stop` + `summer_get_diagnostics` — run and read errors
- `summer_screenshot` — see the editor viewport or running game (visual verification)
- navmesh or light baking
- runtime inspection of a live scene
- asset import
- structural edits into an **already-open** scene where you want the editor to manage node ids / instancing
- `summer_read_file` / `summer_replace_text` / `summer_write_file` — identity-bound text reads and guarded writes

Git, shell, and grep remain host-native. Project file mutations should stay on the Summer path when MCP is available.

## Safe editing rules

- Never guess scene paths like `res://main.tscn` — get them from `summer_get_project_context`.
- New files use `summer_write_file` with `create_only:true`; existing files use `summer_replace_text` or `summer_write_file` with the sha256 from `summer_read_file`.
- Guarded `.tscn`/`.tres` writes are supported. Prefer scene tools for live hierarchy and inspector edits; the engine schedules editor reload handling after file writes.
- Never perform destructive bulk removals unless the user explicitly asks.
- Never change `priority: locked` `.summer` memory, voice IDs, canon, or provider bindings without explicit user confirmation.
- Save live-engine scene edits with `summer_save_scene`; run `summer_get_diagnostics` after changes.

## Live-engine scene-edit flow (only when you need it)

1. `summer_get_project_context`
2. `summer_open_main_scene` (if needed)
3. `summer_get_scene_tree`
4. `summer_add_node` / `summer_set_prop` / `summer_set_resource_property`
5. `summer_save_scene`
6. `summer_get_diagnostics`

## Error recovery

- `"no scene open"` / `"no edited scene"` → call `summer_open_main_scene`.
- `"failed to open scene"` → re-check `mainScene` from `summer_get_project_context`; use the exact path only.
- A content/sha mismatch → re-read with `summer_read_file`, review the new bytes, and retry only if the intended edit still applies.
- An identity mismatch → call `summer_get_project_context` to rebind only if the newly open project is intentional.
