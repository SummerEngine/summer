# summer_inspect_runtime_node

Live properties of ONE node in the RUNNING GAME: {node: {path, class, properties, children_names}} with a curated common-property set (transform, visibility, physics state, ...). The runtime counterpart of summer_inspect_node (which reads the EDITED scene) — use it to answer "what are this enemy's actual stats right now", "where IS the player", "did that flag flip" without stopping the game and losing the state.

Find the path with summer_get_runtime_tree first — runtime paths (e.g. '/root/Main/Enemies/Goblin3') often differ from edited-scene paths because nodes are spawned, renamed, or reparented at runtime.

Needs a running game: fails with failure_reason "game_not_running" otherwise — start with summer_play, then re-run.
