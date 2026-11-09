# summer_get_runtime_tree

Scene tree of the RUNNING GAME — live runtime state, not the edited scene. Use it during playtests to see what actually spawned: dynamically created enemies/projectiles/UI, autoloads, pooled nodes — everything summer_get_scene_tree (an EDITOR read) can never show. Inspecting live keeps the bug alive; stopping the game to look usually resets it.

Returns {tree: {name, class, path, children}, total_nodes, truncated}. Depth/limit are capped and truncation is declared — never assume a capped tree is complete. Drill into one node's live properties with summer_inspect_runtime_node.

Needs a running game: fails with failure_reason "game_not_running" otherwise — start with summer_play, then re-run.
