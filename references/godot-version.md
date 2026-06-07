# Godot / Summer Engine Version Reference

> Read this **before** writing any code, especially shaders or rendering code. Godot's API is moving; the LLM cutoff date matters per domain.

## Engine fork base

Summer Engine is a fork of **Godot 4.5** (stable). All skills assume Godot 4.x APIs.

## LLM training cutoff vs. Godot release dates

| Domain | Godot 4.x churn | Action |
|---|---|---|
| Scripting (GDScript core) | low | Trust your training. Spot-check signatures only when something feels off. |
| Scene / node tree APIs | low | Trust your training. |
| Renderer (`RenderingServer`, `Compositor`) | high in 4.4 / 4.5 | Verify before writing. Check `MovieMaker`, `Compositor` effects, `RenderSceneBuffers` — these renamed/added recently. |
| Shaders (`canvas_item`, `spatial`, `compute`) | medium | Built-in functions stable, but `hint_*` flags shifted. Verify `hint_screen_texture` / `hint_depth_texture` syntax. |
| Animation (`AnimationTree`, `AnimationMixer`) | high (4.0 → 4.3 rename) | Use `AnimationMixer` for new code, not deprecated `AnimationPlayer`-as-mixer. |
| Multiplayer (`MultiplayerAPI`) | medium | High-level API stable. `SceneReplicationConfig` settled in 4.0+. |
| Editor / EditorPlugin | medium | Spot-check. |
| `Tween` / `SceneTreeTween` | low | Stable since 4.0. |

## Summer-specific deltas from vanilla Godot

- Local API server runs on `localhost:6550` (set per machine via `~/.summer/api-token`).
- Engine ships a webview module in `modules/1summer_engine/` — do not assume vanilla Godot for editor UI patches.
- Project root contains `.summer/` for project memory; do not delete it.

## When in doubt

1. Use Summer MCP tools (`summer_inspect_node`, `summer_inspect_resource`) to read live editor state instead of guessing.
2. Use `summer_get_diagnostics` after every scene change.
3. Check `references/mcp-tools-reference.md` for the canonical tool list.
