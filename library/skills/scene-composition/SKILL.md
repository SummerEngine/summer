---
name: scene-composition
description: "Use when building or organizing Summer Engine scenes: node hierarchy conventions, when to extract sub-scenes, reusable prefab patterns, and instance-versus-add-node decisions. Trigger on \"scene\", \"sub-scene\", \"instance\", \"prefab\", \"node hierarchy\", \"scene structure\", \"PackedScene\"."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: scene-and-project
user-invocable: false
allowed-tools: Read Grep summer_create_scene summer_open_scene summer_get_scene_tree summer_add_node summer_instantiate_scene summer_save_scene
paths: ["**/*.tscn"]
---

# Scene Composition for Summer Engine

Organize scenes for clarity, reuse, and MCP compatibility. Follow these conventions when building levels, characters, and UI.

## Node Hierarchy Conventions

### 3D Scenes

```
World (Node3D)                    # Root or main container
├── Camera3D                      # Main camera
├── DirectionalLight3D            # Sun / primary light
├── WorldEnvironment              # Sky, ambient, fog
├── Level (Node3D)                # Level geometry
│   ├── Ground
│   ├── Walls
│   └── Platforms
├── Props (Node3D)                # Placed objects (trees, crates)
├── Enemies (Node3D)              # Enemy instances
└── Player                        # Player instance (or instantiated)
```

### 2D Scenes

```
Level (Node2D)
├── TileMapLayer                  # Or TileMap
├── Characters
├── Props
└── Effects
```

### UI Scenes

```
CanvasLayer or Control
├── MarginContainer
│   ├── VBoxContainer
│   │   ├── Label
│   │   ├── Button
│   │   └── Button
```

## Parent Paths for MCP

Use `./` for paths relative to the scene root:

| Path | Meaning |
|------|---------|
| `./` | Scene root |
| `./World` | Child named "World" of root |
| `./World/Player` | Player under World |
| `./World/Props/Tree1` | Tree1 under Props under World |

**Never use** `/World` (absolute) or `World` (missing `./`). The engine expects `./` prefix.

## When to Use Sub-Scenes

**Use sub-scenes (separate .tscn files) when:**
- The same setup appears in multiple places (player, enemy, pickup)
- The setup has many nodes and would clutter the main scene
- You want to edit a prefab in isolation

**Use inline nodes when:**
- The node is unique to this scene (main camera, level-specific light)
- It's a simple one-off (single MeshInstance3D)

### Creating a Sub-Scene

1. Build the hierarchy in the main scene
2. Select the root of what you want to extract
3. Save as scene: `summer_save_scene(scenePath="res://scenes/source.tscn", path="res://scenes/player.tscn")`. `scenePath` names the scene being saved and is **required**; `path` is the optional save-as target. There is no "current scene" default.
4. In the main scene, add it with `summer_instantiate_scene(scenePath="res://main.tscn", parent="./World", scene="res://scenes/player.tscn", name="Player")`

**Practical approach:** Create reusable scenes (player.tscn, enemy.tscn) as separate scene files, then instantiate them into levels.

## InstantiateScene vs AddNode

| Use | Tool | Example |
|-----|------|---------|
| Built-in mesh (Box, Sphere) | AddNode + SetProp | `summer_add_node` type=MeshInstance3D, then `summer_set_prop` mesh=BoxMesh |
| Existing .tscn prefab | InstantiateScene | `summer_instantiate_scene` scene=res://player.tscn |
| Imported .glb model | ImportFromUrl then InstantiateScene | Import first, then instantiate |

**Do not** use `summer_set_prop` with `mesh` for a .glb path. Use `summer_instantiate_scene` for .tscn and .glb files.

## Save Conventions

- The mutation tools (`summer_add_node`, `summer_set_prop`, ...) already append one save per call, so a standalone `summer_save_scene` is only for a save-as or an explicit extra flush
- Save-as: `summer_save_scene(scenePath="res://main.tscn", path="res://scenes/level1.tscn")`
- Plain save: `summer_save_scene(scenePath="res://main.tscn")` — `scenePath` is required in both forms

## Spatial Placement

When a 3D prop, character, collider, platform, wall-mounted object, shelf item,
or tight-space asset must sit flush, avoid overlap, or preserve clearance, load
the `spatial-placement` skill. Follow its inspect -> place -> Starcast -> correct
-> verify loop instead of judging precise placement from transforms or a
screenshot alone.

## Common Mistakes

1. **Wrong parent path:** `./NonExistent` fails. Ensure the parent exists before adding children.
2. **Unnamed scene:** Saving without a path fails if the scene was never saved. Use `path` for new scenes.
3. **Duplicate names:** Godot auto-renames (Node, Node2, etc.). Use descriptive unique names.
4. **Mixing 2D and 3D:** Don't put Node2D under Node3D or vice versa in the same hierarchy.

## Fallback

MCP is the preferred path, not a requirement. Hand-written `.tscn` text loads and
instantiates fine — including `[ext_resource]` lines with **no `uid=` field**,
which the engine resolves by path (verified by loading such a scene on the
shipped 4.6.1 build). Format version 3 is current for Godot 4.

What actually goes wrong when you hand-write scenes is mundane and checkable:
a `SubResource("id")` with no matching `[sub_resource id="id"]` block, a
`parent=` path naming a node that isn't declared above it, or an
`[ext_resource path=...]` pointing at a file that hasn't been imported yet
(`--headless --import`, or `summer_import_from_url`, before it will load).

So: use MCP when it's connected because the ops are undoable as one step and the
engine validates paths for you. When it isn't, write the `.tscn` and then open it
once to confirm it loads. Do not tell the user it's impossible.

## Trap — Cross-scene transform leak when copying a scene as a template

When you duplicate a scene to spawn a sibling level (for example, `level_1.tscn` → `level_2.tscn`), every child instance carries its transform offset baked at the original level's coordinate system. If the source level places its player at world `(223, 108, -1833)` and instances a kill-volume scene at offset `(512, -3, 512)`, those numbers are anchored to the source level's terrain origin. Drop the same kill-volume instance into a level whose player spawns at world `(0, 1, 0)` and the volume's wall colliders may end up slicing the new arena at world `x = 0`. The user sees a "glitching invisible line through the middle of the map" they can't pass through. The colliders are invisible under the floor, so visual diagnosis is hard. Only collision-walking through them reveals the problem.

Rule when copying a scene as a template:

1. Audit every child instance for hardcoded `transform = Transform3D(...)` lines.
2. Decide for each: keep, re-zero (origin = `(0,0,0)`), or drop entirely.
3. The bigger the original level's world-space coordinates, the more dangerous the copy. Re-zero by default; you can move things back if needed.
4. Levels that spawn the player at world origin (for example flat arenas centered on `(0,0,0)`) should drop ALL transform overrides from carry-over instances. Only re-add transforms relative to the new origin.

## Trap — Third-person camera collision when foliage shouldn't block

Godot's `SpringArm3D` shortens the camera boom when it raycasts into geometry on the configured `collision_mask`. If your trees, bushes, or grass have collision so the player physically bumps them, on the same layer the SpringArm queries, the camera shortens for foliage too. Players see the camera awkwardly snap forward whenever they walk near a tree.

The pattern that works:

1. Foliage gets its own physics layer. Conventionally layer 9 ("Foliage").
   - Foliage `StaticBody3D`: `collision_layer = 256` (which is 2^8, layer 9).
2. Player still bumps into foliage by including that layer in its `collision_mask`.
   - Player `CharacterBody3D`: `collision_mask = 259` (which is 1 + 2 + 256, Entities + Level + Foliage).
3. SpringArm uses a mask that catches solid level geometry but excludes foliage.
   - SpringArm: `collision_mask = 3` (which is 1 + 2, Entities + Level only).
4. For the visual fade the user expects when the camera is "behind" a tree, add the foliage mesh to the `camera_fade` group. An existing camera-occlusion fade system can ghost the mesh by AABB intersection with the camera-to-player segment without touching collision.

Why per-layer split: there's no clean way to exclude a single body type from `SpringArm3D`'s collision check via `add_excluded_object` for dynamically-spawned foliage. You'd have to register every tree at spawn time and re-register on level change. Layer-level filtering is set-and-forget.

Don't skip the player mask update. If you only move foliage to layer 9 without adding it to the player's mask, the player walks straight through trees.

## Collaborative protocol

This skill creates and mutates scene files. Always ask before applying: "May I create `res://scenes/player.tscn` and instantiate it under `./World`?".
