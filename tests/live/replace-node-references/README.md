This on-demand regression starts a disposable headless editor with a private HOME, state and project. It uses actual MCP SDK initialization, tools/list and canonical V4 tools/call. SDK fetch is restricted to that editor's loopback port, SDK subprocess creation is blocked and telemetry is disabled. No customer project, paid service, GUI or automatic CI lane is used.

From a built toolkit checkout with its existing dependencies:

```sh
python3 tests/live/replace-node-references/audit.py --editor /path/to/summer --output /tmp/new-replacement-evidence
```

`--output` must be new. `--package /path/to/other/built/toolkit` selects a baseline checkout. The unfixed helper fails after both external and retained-child references reload as null despite verified:true. The candidate preserves them with both @tool and ordinary game scripts, leaves ordinary NodePath strings and child references unchanged, keeps plain type replacement working, refuses an incompatible replacement without removing the old node, and supports Undo/Redo of the reference property action. Undo goes through the public batch route; Redo uses native EditorUndoRedo through a local scene script because the editor does not advertise a Redo operation.

The probe preloads its fixture prefabs and explicitly opens each target, checking stable native root identity across three reads before replacement. Existing inactive InstantiateScene routing is outside this regression. An independent non-editor Godot process reloads point-in-time saved copies with CACHE_MODE_IGNORE; assertions do not trust the toolkit's persisted/verified receipt. Receipts, copied project, fresh graphs and editor lifecycle remain in the output directory; the owned editor is stopped even on failure.
