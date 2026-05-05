# Summer MCP Fresh-Chat Playbook

This is the minimum safe workflow for AI agents using Summer Engine MCP in a brand-new chat.

## Always do this first

0. Decide operation type:
   - **Normal file edits** (`.gd`, `.tscn`, `.tres`, `.ts`, docs): use host file tools directly.
   - **Live engine/editor operations** (scene tree, play/stop, diagnostics, import): use Summer MCP.
1. Call `summer_get_agent_playbook`.
2. Call `summer_get_project_context`.
3. If no scene is open, call `summer_open_main_scene`.
4. Call `summer_get_scene_tree` before structural edits.

## Safe editing rules

- Never guess scene paths like `res://main.tscn` or `res://Main.tscn`.
- Never use Summer MCP `WriteFile` for `.tscn`/`.scn`; edit files directly with host tools when doing raw file edits.
- Never perform destructive bulk removals unless the user explicitly asks.
- Save after edits with `summer_save_scene`.
- Run diagnostics after changes with `summer_get_diagnostics`.

## Typical scene-edit flow

1. `summer_get_project_context`
2. `summer_open_main_scene` (if needed)
3. `summer_get_scene_tree`
4. `summer_add_node` / `summer_set_prop` / `summer_set_resource_property`
5. `summer_save_scene`
6. `summer_get_diagnostics`

## Error recovery

- `"no scene open"` or `"no edited scene"`  
  -> Call `summer_open_main_scene`.

- `"failed to open scene"`  
  -> Re-check `mainScene` from `summer_get_project_context`. Use exact path only.

- `"WriteFile cannot edit .tscn/.scn"`  
  -> Use scene operations, not file writes.
