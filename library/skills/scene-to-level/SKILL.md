---
name: scene-to-level
description: Use when the user wants to go from a scene reference image or concept art to a playable Summer Engine scene populated with the right assets and terrain. Orchestrates concept, asset pack, terrain, composition, and scene assembly. Trigger on "build this scene", "make this playable", "I want a level that looks like this", "from a screenshot to a game", "implement this concept".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: level-design
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_create_scene summer_open_scene summer_add_node summer_set_prop summer_set_resource_property summer_save_scene summer_get_scene_tree summer_inspect_node summer_search_assets summer_import_from_url
paths: ["**/*.tscn", "**/*.gd", "assets/**", ".summer/**", "levels/**"]
---

# scene-to-level — From a reference image to a playable scene

This is the **orchestrator** skill. It does not generate art, slice sheets, or
write game code. It routes the user through the chain of skills that do and
stitches their outputs into a placeable Summer Engine scene.

Use it when the user shows you a screenshot or concept image and says "build this." The output is a `.tscn` you can hit play on, populated with assets that match the reference's style.

## The pipeline (decision tree)

```
1. Read the reference image (vision).
   └── What kind of scene is it?
        ├─ 2D top-down / isometric / side-scroller
        │   └── route to TERRAIN + 2D ASSETS path
        ├─ 3D third-person / first-person
        │   └── route to 3D ASSETS path (out of scope for this skill —
        │       use `asset-strategy` directly)
        └─ UI-only screen (menu, HUD)
            └── route to UI ASSETS path (just plan-asset-pack)

2. For each visible element, route to the right sub-pipeline:

   TERRAIN  → tileable-texture
              (auto-tiling Wang / 47-tile sheet; CURRENTLY a placeholder
              that generates a single tile — full auto-tile work is
              not yet built)

   PROPS / DECOR / LIGHTING / NATURE / WATER / BUILDINGS / UI / VFX
       ── If user has time for individual generation, prefer:
       │   create-asset-sheet (Plan + Generate Pack
       │   mode at /studio/plan-asset-pack — higher quality, each asset
       │   gets full model attention)
       └── If user wants fast / exploratory:
           create-asset-sheet (Slice from a sheet at
           /studio/create-tileset — one sheet, autoslice, cheaper)

   CHARACTERS → character-portrait first for the static
                frame, then sprite-sheet for animation

3. Once assets exist, USE-WIDGET-ASSET on any UI / panel / bar /
   toggle pack files to wire them as NinePatchRect / TextureProgressBar
   / etc. (see use-widget-asset)

4. Compose the scene:
   - summer_create_scene(path=..., rootName=..., allow_temporary_scene_mutation=true).
     It has no root-type argument: the new scene's root is copied from the
     currently-open (or main) scene's root, children stripped and root renamed.
     Start from a 2D scene if you want a Node2D root.
   - Add a TileMapLayer node for terrain; assign the generated tileset
     resource (`TileMap` is deprecated on the current Summer technical line)
   - Place props as Sprite2D / TextureRect children, positioned to
     match the reference's composition
   - Wire UI as Control nodes anchored to the viewport
   - Every mutation tool here takes a required `scenePath`

5. Validate:
   - summer_get_diagnostics (no args, project-wide) — or
     summer_get_script_errors(path="res://...gd") for one specific file
   - summer_play (the user takes over from here)
```

## When to use

- "Make this screenshot playable."
- "I want a level that looks exactly like this concept art."
- "Build a Japanese village scene like this reference."
- "I have a UI mockup — implement it."

## When NOT to use

- The user wants a **single asset** → `pixel-art` or a leaf skill directly.
- The user wants to **design** a level from scratch (gameplay beats, pacing, encounters) → `design-level`. This skill is post-design — it implements a known visual target.
- The user wants a **3D level** → use `asset-strategy` directly; the orchestration for 3D scenes isn't in this skill yet.
- The user wants a **playable prototype with mechanics already** → mechanics aren't in scope. This skill produces the *visuals*; the mechanic skills (e.g. `design-mechanic`) handle behavior.

## Required up-front

Before starting, you need either:

1. A reference image (URL or local file) the user provides, OR
2. A vivid text description of the target scene from the user

If neither is offered, stop and ask. Don't guess what a "japanese village scene" looks like — get the reference first.

## Honest reliability map

| Pipeline node | Reliability | Cost (rough) | What can go wrong |
|---|---|---|---|
| Reading the reference (vision call) | High | $0.02 | Model misidentifies the scene type |
| Plan + Generate Pack (theme → per-asset) | High for props / icons / UI | $0.10–0.50 per pack | Style drift across items if no style ref |
| Slice from a sheet (single-sheet path) | Medium for dense sheets | $0.08 + upscales | Touching sprites merge into one slice |
| Tileable terrain (auto-tile) | LOW today — not built. | n/a | Use a single tile placeholder or stitch by hand |
| Sprite-sheet animation | Medium — see that skill's own honesty section | varies | Frame consistency is the hard part |
| Scene assembly via `summer_*` tools | High | free | Engine must be running |

Surface this map to the user when relevant — don't claim "ready to play in 10 minutes" if terrain auto-tiling is what they actually need.

## A worked example

User shows you a screenshot of a Japanese village with multiple islands, water between them, buildings, characters, and a bottom palette UI:

1. **Vision pass** identifies the scene as 2D isometric with: water terrain (large area), grass terrain (per island), buildings (5+ distinct), characters (2), UI palette + toolbar.
2. **Plan the props pack** via the create-asset-sheet planner: 12 props at minimum (torii, sakura, lantern, pagoda, bridge, well, sign, banner, bucket, hay, fence, crate). Generated per-asset for quality.
3. **Plan the buildings pack**: 5 distinct buildings (small house, barn, shop, pagoda, watchtower).
4. **Generate terrain**: today, single grass tile + single water tile + edge variant placeholders. Full Wang-tile auto-tiling is the TERRAIN_AUTOTILE_IDEA.md unbuilt path.
5. **Plan the UI pack** via the planner with theme "isometric voxel game UI: bottom palette, toolbar with Place/Erase/Pan/Save/Reset, asset category tabs, instruction panel."
6. **For each UI slice that's a panel / button**, use `use-widget-asset` to wire as NinePatchRect.
7. **Compose**: TileMap for terrain; Sprite2D placement matching the reference; Control nodes for the UI.
8. **Validate + hand off**.

Total wall-clock: maybe 30 min for the asset packs (parallel), another 15 for scene composition. NOT a five-minute thing.

## What this skill explicitly defers

- **3D scene assembly.** Out of scope; use `asset-strategy` directly until a 3D variant of this orchestrator exists.
- **Auto-tiling terrain.** The pipeline node exists in the decision tree but the leaf skill that implements it is not built.
- **Animation orchestration.** Per-character `sprite-sheet` is invoked manually; no auto-pairing of characters with their animation pipelines yet.
- **Gameplay code.** Player movement, interactions, win conditions — those are level-design + gameplay-mechanics skills, not this one.
