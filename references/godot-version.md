# Summer Engine Technical Compatibility Reference

> This is an implementation note for version-sensitive engine work. Product
> language should say **Summer Engine**, **Summer SDK**, and **Summer game**.

## Current and planned upstream base

- Current Summer Engine base: **4.6.1**
- Planned next base: **4.7.1**
- Policy: Summer Engine follows upstream Godot continuously. Do not pin public
  onboarding, skills, or product descriptions to one upstream version.

Summer Engine is its own product and SDK. It inherits parts of its scene,
resource, scripting, and rendering API from the upstream Godot codebase, while
adding Summer-specific editor, agent, platform, and runtime capabilities.
Use the live Summer Engine build and this compatibility reference as the
authority; do not describe a creator's project as a Godot game.

## Version-sensitive areas

| Domain | Expected churn | Action |
|---|---|---|
| GDScript core | low | Prefer current Summer SDK patterns; spot-check signatures when uncertain. |
| Scene and node APIs | low | Prefer Summer MCP inspection over guessing. |
| Renderer (`RenderingServer`, `Compositor`) | high | Verify against the installed Summer Engine build before writing. |
| Shaders (`canvas_item`, `spatial`, `compute`) | medium | Verify built-ins and `hint_*` syntax against the installed build. |
| Animation (`AnimationTree`, `AnimationMixer`) | medium | Prefer current, non-deprecated Summer Engine APIs. |
| Multiplayer (`MultiplayerAPI`) | medium | Verify transport and replication behavior against Summer Engine. |
| Editor / `EditorPlugin` | medium | Treat as Engine-contributor work and spot-check the current source. |
| `Tween` / `SceneTreeTween` | low | Use current Summer SDK conventions. |

## Summer-specific surfaces

- The local Summer API server runs on `localhost:6550` and authenticates with
  the per-machine `~/.summer/api-token`.
- Summer editor integration lives in Summer-specific engine modules; do not
  assume an upstream editor build for editor or platform patches.
- Project memory lives in the project-root `.summer/` directory.
- Creator publishing uses the versioned `summer.creator.v1` contract and a
  separate Summercraft `creator-token`; it never replaces the core
  `auth-token`.

## When in doubt

1. Use Summer MCP tools such as `summer_inspect_node` and
   `summer_inspect_resource` to read live engine state.
2. Run `summer_get_diagnostics` after scene changes.
3. Check `references/mcp-tools-reference.md` for the canonical Summer tool
   surface.
4. For Engine-fork work, inspect the current source base rather than relying
   on a fixed-version tutorial.
