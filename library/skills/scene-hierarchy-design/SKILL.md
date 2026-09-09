---
name: scene-hierarchy-design
description: "Use when applying data-oriented hierarchy principles (from Sander Mertens' ECS hierarchies article) to structure Summer Engine scenes: split asset vs. live hierarchies, group by dominant access pattern, use sub-scenes for reuse, and keep logic path-agnostic via MCP scene tools."
license: MIT
category: workflow
tags:
  - scenes
  - hierarchy
  - composition
  - ecs
confidence: extracted
source_refs:
  - sources/web/mertens-ecs-data-oriented-hierarchies/source.md
adaptation: translated
summerengine_refs:
  - repository: SummerEngine/summer-engine-agent
    revision: d4fb1b3b51fb5b5a2b5b4bde3073bf01e9e976b6
    path: skills/scene-and-project/scene-composition/SKILL.md
  - repository: SummerEngine/summer-engine-agent
    revision: d4fb1b3b51fb5b5a2b5b4bde3073bf01e9e976b6
    path: references/mcp-tools-reference.md
  - repository: SummerEngine/summer-engine-agent
    revision: d4fb1b3b51fb5b5a2b5b4bde3073bf01e9e976b6
    path: AGENTS.md
source_repo: SummerEngine/summer-gamedev-knowledge@cac7d50be8cfb3c0179c48e65438eb0d375b9fe9
---

# Scene Hierarchy Design for Summer Engine (Data-Oriented Principles)

## Outcome

Scenes in Summer Engine (Godot-based) that are organized by **access pattern**, not by accident: clear separation between reusable asset scenes (`.tscn` prefabs) and the live node tree, wrapper grouping where whole subtrees are operated on together, flat siblings where type-wide queries dominate, and gameplay logic that does not depend on deep fragile node paths.

## When to Use

- Structuring a new scene (level, character, prop cluster, UI screen) from scratch.
- Reorganizing a scene that has grown ad hoc (long chains, duplicate setups, hard-to-delete clusters).
- Deciding whether a setup belongs inline or as a separate sub-scene.
- Reviewing whether existing scenes match the dominant operations the game performs on them (spawn/despawn clusters, iterate all of a type, move single nodes).

Do not use this for shader/material work, asset import mechanics, or gameplay tuning — it is purely about hierarchy shape.

## Core Principle (translated)

Sander Mertens' ECS article evaluates hierarchies on two axes and both translate directly:

1. **Usability: two hierarchy kinds must compose.** *Asset hierarchies* (inheritance, variations, property overrides → Godot `.tscn` sub-scenes and scene inheritance) and *scene hierarchies* (live parent-child relations → the node tree). A scene that repeatedly rebuilds the same inline cluster is missing its asset hierarchy; an asset scene nobody instantiates is dead weight.
2. **Performance: match structure to dominant access patterns.** Group nodes stored/operated together under one parent (subtree operations become one operation); keep nodes queried independently as flat siblings. There is no universally optimal depth — analyze usage before picking one.
3. **Hierarchy-agnostic logic.** The article's hybrid design keeps application code independent of storage; the Summer translation is: scripts and agents should not hardcode deep paths. Use groups, signals, and exported `NodePath` references instead of long ancestor chains.

## Summer Engine Integration

Scene hierarchy features from the article map onto Summer MCP tools as follows:

| Feature (article) | Summer Engine tool |
|---|---|
| Instantiate assets | `summer_instantiate_scene` |
| Recursively despawn | `summer_remove_node` on the wrapper parent (removes the subtree) |
| Reparent children | `summer_remove_node` + `summer_add_node`/`summer_instantiate_scene` under the new parent |
| Iterate the live hierarchy | `summer_get_scene_tree` (always read before mutating) |
| Lookup by name | descriptive, unique node names resolved from `summer_get_scene_tree` |

Recommended scene shape — group by operation, name by role:

```
World (Node3D)                  # scene root
├── Camera3D                    # unique to this scene → inline
├── DirectionalLight3D          # unique → inline
├── Level (Node3D)              # wrapper: geometry operated as one subtree
├── Props (Node3D)              # wrapper: spawn/despawn clusters together
│   ├── Crate_01 (instance of res://scenes/props/crate.tscn)
│   └── Barrel_01 (instance)
├── Enemies (Node3D)            # wrapper: recursive clear of all enemies
│   └── Grunt_01 (instance of res://scenes/enemies/grunt.tscn)
└── Player (instance of res://scenes/player.tscn)
```

Rules of thumb:

- **Wrapper node per operation boundary.** If you ever need to "remove all enemies", "hide all props", or "rebuild the level", they share one parent; the operation becomes a single node op.
- **Sub-scene per reusable setup.** Same cluster appearing twice or more → extract to its own `.tscn` and instantiate. One-offs (main camera, a level-specific light) stay inline.
- **Flat over deep.** Every extra level of nesting adds path length and fragility. Prefer named sibling containers over long chains.
- **Unique descriptive names.** Godot auto-renames duplicates (`Node`, `Node2`); that breaks name lookup. Name by role and index (`Crate_01`).
- **Never mix 2D under 3D** (or vice versa) in one hierarchy.

## Agent Procedure

Follow the canonical scene loop from the Summer MCP reference: route → orient → read rules → resolve `scenePath` → mutate → verify.

1. **Orient.** `summer_start_game_task` to route the goal; `summer_get_project_context`; `summer_get_agent_playbook`.
2. **Read before writing.** `summer_get_scene_tree` on the exact `res://...tscn`. Never mutate blind, and never edit `.tscn` text while the engine is running — use the MCP tools.
3. **Pick the access pattern.** For each planned cluster decide: operated as a subtree (→ wrapper parent), queried by type across the scene (→ flat siblings + group), or unique (→ inline under root container).
4. **Build asset hierarchies first.** For reusable setups create the sub-scene (`summer_create_scene` / build inline then `summer_save_scene(scenePath="res://main.tscn", path="res://scenes/<name>.tscn")`), then bring them in with `summer_instantiate_scene(scenePath="res://main.tscn", parent="./<Wrapper>", scene="res://scenes/<name>.tscn", name="<Role>_01")`.
5. **Add inline nodes** with `summer_add_node(parent="./<Wrapper>", type="...", name="...", scenePath="res://main.tscn")`. Parent paths are relative with the `./` prefix (`./`, `./World/Props`); never `/World` or bare `World`.
6. **Keep logic path-agnostic.** When a script must reach another node, add it to a group or export a `NodePath`/signal connection (`summer_connect_signal`) rather than hardcoding `./World/Enemies/Grunt_01/Weapon`.
7. **Every mutation names its target.** Pass the exact `scenePath` to every add/set/remove/instantiate call. Dedicated mutation tools append one final save; use `summer_save_scene` only for save-as or an explicit flush.
8. **Verify.** `summer_get_script_errors`, then `summer_get_scene_tree` again to confirm the intended shape; `summer_screenshot` (editor viewport) for visual confirmation; `summer_play` → `summer_get_debugger_errors` → `summer_stop` only when runtime behaviour matters.

## Failure Modes

- **Deep fragile paths in scripts.** Hardcoded ancestor chains break on any reorganization; this is the direct analogue of the article's warning against logic coupled to hierarchy storage. Use groups/signals/exported paths.
- **Inline duplication instead of sub-scenes.** The same 5-node cluster rebuilt in three levels → edits must be made three times, and despawn/iteration must enumerate each copy. Extract the asset hierarchy.
- **Over-grouping.** Wrapping every node in its own container adds depth without enabling any operation. Group only where a real subtree operation exists.
- **Duplicate/unnamed nodes.** Auto-renamed `Node2` nodes break lookup-by-name. Rename immediately after adding.
- **Wrong parent path.** `./NonExistent` fails; ensure the parent exists before adding children (read the tree first).
- **Copying a scene as a template without auditing transforms.** Carried-over instances keep world-space offsets baked for the source level; re-zero or drop transform overrides per instance.
- **Direct `.tscn` edits while running.** They get overwritten when the editor saves; always go through MCP scene tools.

## Verification

1. `summer_get_scene_tree` shows the intended wrapper structure with unique descriptive names and no auto-renamed nodes.
2. Each repeated setup exists once as a `.tscn` and appears elsewhere only as instances.
3. Deleting a wrapper parent (`summer_remove_node`) removes exactly its subtree — the recursive-despawn feature works.
4. No script references a path deeper than one or two segments; group/signal/NodePath used instead.
5. `summer_get_script_errors` and (if played) `summer_get_debugger_errors` are clean; `summer_screenshot` matches the intended layout.
