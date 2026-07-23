# Summer MCP Fresh-Chat Playbook

The minimum safe workflow for AI agents building in a Summer Engine project.

## Conversation routing

If Summer is connected but the user has not supplied a game goal, ask one
ordinary-text question:

> Do you already know what game you want to make, or should we brainstorm it together?

- Invoke `make-game` for a game build. If the idea is vague, it invokes
  `brainstorm-game` and resumes automatically after the brief is accepted.
- If the user already described the game shape and core loop, invoke
  `make-game` directly and skip onboarding.
- Ask only about material visible-product choices, paid generation,
  authentication, contradictions, or destructive actions.
- For an unspecified 3D player source, ask whether to use an existing/Asset
  Store character, generate a custom character, or use a temporary prototype.
- Do not ask about file/folder architecture, component organization,
  programming patterns, sky, or other reversible implementation details.
- MCP has no request-user-input menu. Ask required questions in ordinary text.

## Playable MVP contract

An empty scaffold is never a user-facing milestone. A floor, camera, light, or
clean first frame is internal setup.

Continue until the result has a visible controllable player, the requested
primary action, a challenge that exercises it, collision/camera behavior, and
the requested failure/restart or win loop. Explicitly requested characters and
animations are part of the MVP.

For 3D parkour, verify movement, jump, multiple reachable platforms, procedural
extension when requested, fall/respawn at the requested checkpoint, a following
camera, and requested locomotion states. Do not claim completion from
compilation or a static screenshot.

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
