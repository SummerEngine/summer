# Summer MCP Fresh-Chat Playbook

The minimum safe workflow for AI agents building in a Summer Engine project.

## Build flow (default)

1. **Understand** the request, then outline a brief plan. Proceed once it's clearly right.
2. **Edit in pure code with host file tools.** `.gd`, `.tscn`, `.tres`, `.cs`, `.json`, docs, and config are all just text — edit them directly. Write GDScript by default; use C# only if the project already uses it.
3. **Call `summer_get_project_context` first** so you don't guess scene paths or the project language. Use `projectMemory` to decide which `.summer` files to read before creative/audio/dialogue/level/character work.
4. **Play and iterate.** After writing code, **play the scene you just made** and read `summer_get_diagnostics`; fix and repeat until it launches clean — don't wait for the user to navigate to the feature before the first error shows.

## When to use Summer MCP (the live engine)

Reach for MCP tools only when you need the running engine:

- `summer_play` / `summer_stop` + `summer_get_diagnostics` — run and read errors
- `summer_screenshot` — see the editor viewport or running game (visual verification)
- navmesh or light baking
- runtime inspection of a live scene
- asset import
- structural edits into an **already-open** scene where you want the editor to manage node ids / instancing

For everything else, edit files directly — it's faster and avoids editor/file conflicts.

## Safe editing rules

- Never guess scene paths like `res://main.tscn` — get them from `summer_get_project_context`.
- Edit `.tscn`/`.tres` as text by default. The MCP `WriteFile` tool refuses `.tscn`/`.scn` on purpose — that means "use host file tools," not "use scene ops."
- **Clobber gotcha:** if you hand-edit a `.tscn` that is open in the editor, reload (or close) that tab afterward — otherwise the editor's stale tab can overwrite your file on its next save.
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
- `"WriteFile cannot edit .tscn/.scn"` → edit the file with **host file tools** (not the MCP WriteFile — and not necessarily scene ops).
- A `.tscn` you wrote keeps reverting → the editor has it open; reload or close that tab, then write again.
