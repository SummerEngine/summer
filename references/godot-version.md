# Summer Engine Compatibility Reference

> Read this before writing version-sensitive code, especially shaders,
> rendering code, extensions, or export configuration.

## Current technical base

Summer Engine is the product. Its current upstream technical base is **4.6.1**
(stable, Mono), the approved next target is **4.7.1**, and Summer follows
upstream continuously. These are compatibility and lineage facts. They are not
the Summer product name or a permanent SDK version.

The repository source of truth is
`compatibility/summer-engine.json`. The running engine also reports its measured
technical version:

```bash
<engineBinaryPath> --version      # measured: 4.6.1.stable.mono.custom_build.b708b1182
```

Get `engineBinaryPath` from `summer_get_project_context`. Prefer live
inspection to a copied version string. Creator onboarding and headlines should
say Summer Engine, Summer game, Summer SDK, and GDScript. Use the upstream name
only where technical compatibility, migration, extension APIs, contribution
routing, attribution, or licensing requires it.

## LLM training cutoff versus upstream releases

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

## Summer-specific deltas from the upstream engine

- Local API server runs on `localhost:6550` (set per machine via `~/.summer/api-token`).
- Engine ships a webview module in `modules/1summer_engine/`. Do not assume the
  unmodified upstream editor for UI patches.
- Project root contains `.summer/` for project memory; do not delete it.

## When in doubt

1. Use Summer MCP tools (`summer_inspect_node`, `summer_inspect_resource`) to read live editor state instead of guessing.
2. Use `summer_get_diagnostics` after every scene change.
3. Check `references/mcp-tools-reference.md` for the canonical tool list.
