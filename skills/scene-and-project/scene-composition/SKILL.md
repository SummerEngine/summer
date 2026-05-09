---
name: scene-composition
description: Use when building or organizing scenes in Godot — node hierarchy conventions, when to extract sub-scenes, reusable prefab patterns, instance vs add-node decisions. Trigger on "scene", "sub-scene", "instance", "prefab", "node hierarchy", "scene structure", "PackedScene".
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
3. Save as scene: `summer_save_scene(path="res://scenes/player.tscn")`. SaveScene saves the current open scene, so build reusable scenes in their own open scene and save them there. Do not handwrite `.tscn` files as the preferred path.
4. In the main scene, add it with `summer_instantiate_scene(parent="./World", scene="res://scenes/player.tscn", name="Player")`

**Practical approach:** Create reusable scenes (player.tscn, enemy.tscn) as separate scene files, then instantiate them into levels.

## InstantiateScene vs AddNode

| Use | Tool | Example |
|-----|------|---------|
| Built-in mesh (Box, Sphere) | AddNode + SetProp | `summer_add_node` type=MeshInstance3D, then `summer_set_prop` mesh=BoxMesh |
| Existing .tscn prefab | InstantiateScene | `summer_instantiate_scene` scene=res://player.tscn |
| Imported .glb model | ImportFromUrl then InstantiateScene | Import first, then instantiate |

**Do not** use `summer_set_prop` with `mesh` for a .glb path. Use `summer_instantiate_scene` for .tscn and .glb files.

## Save Conventions

- Always call `summer_save_scene` after changes you want to keep
- For new scenes: `summer_save_scene(path="res://scenes/level1.tscn")`
- For existing scenes: `summer_save_scene` (no path, uses current scene path)

## Common Mistakes

1. **Wrong parent path:** `./NonExistent` fails. Ensure the parent exists before adding children.
2. **Unnamed scene:** Saving without a path fails if the scene was never saved. Use `path` for new scenes.
3. **Duplicate names:** Godot auto-renames (Node, Node2, etc.). Use descriptive unique names.
4. **Mixing 2D and 3D:** Don't put Node2D under Node3D or vice versa in the same hierarchy.

## Fallback

No fallback for this — Summer MCP required. Handwriting `.tscn` files for hierarchy mutations is error-prone (UID collisions, wrong format version, broken sub_resource refs). If MCP isn't connected, open the scene in the Godot editor and use the SceneTree dock.

## Collaborative protocol

This skill creates and mutates scene files. Always ask before applying: "May I create `res://scenes/player.tscn` and instantiate it under `./World`?". See `../../_shared/collaborative-protocol.md`.
