# Summer MCP — Tooling TODO

What the MCP server (TypeScript, this repo) needs from the Summer Engine binary (C++, separate repo / shipped artifact) to close known gaps.

The TS layer in this repo can only forward what the engine exposes. When users hit a wall, look at this list to see whether the gap is engine-side and what op needs adding.

## P0 — Runtime debugger warnings expose bodies *(SHIPPED 2026-05-10)*

**Status:** DONE engine-side. Pending engine binary rebuild.

**What landed:**

1. `state_provider.cpp` — diagnostics now returns `debugger.warnings_data` next to `errors_data`, both via `ScriptEditorDebugger::get_errors_data(200, true, true)` split by severity in C++. Capped at 50 each to bound token cost.
2. `debug_ops.cpp::get_debugger_errors` — was a stub returning empty `errors` array with a "needs debugger modification" note. Now actually wires to `get_errors_data()`, honors the documented `type` filter ("error" / "warning" / empty), and returns both error and warning bodies in a single op call.
3. `summer_get_debugger_warnings` MCP tool — calls `GetDebuggerErrors` with `type: "warning"` filter, returns severity=warning entries only.
4. `summer_get_debugger_errors` MCP tool description updated.

**To land in user's machine:** rebuild the Summer Engine binary (the C++ changes are in `modules/1summer_engine/editor/ops/debug_ops.cpp` and `modules/1summer_engine/editor/state/state_provider.cpp`). The TS-side MCP changes are live as soon as the npm package is republished.

## P1 — Live runtime scene tree introspection

**Status:** `summer_get_scene_tree` and `summer_inspect_node` return the **edited** scene (what's open in the editor), not the **running** game's instantiated scene tree.

**Why it matters:** gameplay-time issues like "this enemy spawned with wrong stats" or "the boss's HP node is at the wrong path" can't be inspected without stopping the game. Stopping the game often resets the bug.

**What's needed engine-side:** new ops `GetRuntimeSceneTree` and `GetRuntimeNode(path)` that read from `SceneTree.root` (the live scene) instead of the editor's `EditorInterface.get_edited_scene_root()`.

## P2 — Input simulation

**Status:** the MCP can `summer_play` a scene but cannot send keyboard / mouse / controller input afterward. Any bug that requires gameplay (player movement, weapon firing, dodge, level transitions, button clicks) needs the user to drive.

**What's needed engine-side:** ops `SendKey(keycode, pressed)`, `SendMouseButton(button, pressed, x, y)`, `SendMouseMotion(dx, dy)`, `SendJoyButton(...)`, `SendJoyAxis(...)`. Probably wired through `Input.action_press` / `Input.parse_input_event` so they go through Godot's standard input pipeline.

**Why P2:** unlocks self-testing — agents can play a scenario end-to-end and watch for errors. Combined with P0 + P1 above, the loop becomes "run scene → drive input → read warnings/errors → fix" without user intervention.

## P3 — Viewport screenshot

**Status:** no way to capture the rendered viewport. Visual regressions ("the floor looks wrong", "the camera clips through terrain", "the boss has no material") require user eyes.

**What's needed engine-side:** op `CaptureViewport()` returning a base64 PNG of the active viewport, optionally for a specific camera path.

## P4 — Engine log file path

**Status:** Godot writes to `user://logs/godot.log` by default. Reading this gives a complete log including warnings the in-memory debugger may have evicted. The MCP can read arbitrary files via `client.readFile`, but doesn't know the path.

**What's needed engine-side:** op `GetUserDir()` returning the resolved path of `user://`. Then a new MCP tool `summer_read_log_tail(lines: int)` can read the last N lines of `<userdir>/logs/godot.log`.

**Workaround until P4:** the MCP could try OS-default Godot user paths (`%APPDATA%/Godot/app_userdata/<project_name>` on Windows etc) but project_name varies — engine-side disclosure is cleaner.

---

## How to add a new op (engine team reference)

Each op is a `Dictionary` arriving over `POST /api/ops`. The engine's op-router dispatches by the `op` field. Pattern:

1. Add a new case to the op dispatcher (`scene/main/scene_tree_summer_ops.cpp` or wherever the router lives in the engine source).
2. Implement the handler. For `GetDebuggerWarnings`, mirror `GetDebuggerErrors`: read from the `EditorDebuggerNode` warning ring buffer, format as JSON, return.
3. No CLI changes needed — the TS client already calls the op forward-compatibly. The new tool `summer_get_debugger_warnings` (in `src/mcp/tools/debug-tools.ts`) catches "unknown op" today and will start returning real data the moment the engine ships support.

## Verification

After the engine ships an op:
- Check `summer_get_debugger_warnings` returns `errors_data`-like array.
- Check `summer_get_diagnostics`'s `debugger.warnings_data` becomes populated (engine-side change to the diagnostics endpoint to mirror the new data).
- Bump `version` in `summer-cli/package.json` and re-publish so the new tool description goes out.

---

Last updated: 2026-05-10.

---

## Brainstorm — what else is the toolkit missing

Open ideas, ranked by perceived value-to-effort. Move to P-numbered sections above when scoping concretely.

### Self-driving playtest loop

The unlock that follows P1+P2+P3 above. Combine live runtime tree + input simulation + viewport screenshot + diagnostics polling to give the agent a real "play the game and verify it works" loop without the user pressing keys. Pseudocode the agent runs:

```
summer_play(scene)
loop:
  send input (move forward / press attack / etc) via P2
  wait 0.5s
  capture viewport screenshot via P3
  read warnings + errors via P0 (already shipped)
  inspect a runtime node via P1 (e.g. player.HP)
  if expected condition met -> done; if error spike -> fail with full context
summer_stop
```

Effort: low once P1-P3 ship. The orchestrator is just glue. Currently 4 of 4 prerequisites missing. Mathias parked this. Worth revisiting once at least P2 + P3 land.

### Profiler readouts via MCP

Godot has a profiler panel (Frame Time, Physics Time, Process Time, Draw Calls, GPU time). No op exposes it today. "Game runs at 12 fps" can't be drilled in via MCP.

Op: `GetPerformanceMetrics()` returning the current frame's `Performance.MONITOR_*` values. Also a sliding window if cheap.

### Live `ProjectSettings` / autoload / input map readouts

Common diagnostic question: "is autoload X registered? what's the value of `application/run/main_scene`?" Currently no clean way to query at runtime. Op: `GetProjectSetting(key)` and `ListAutoloads()`.

### Hot-reload status

When you edit a `.gd` file, does the running engine pick it up? An op that confirms last reload time per script + which scripts are stale. Useful when "I edited but nothing changed" turns into a long debug session.

### Pre-flight `summer doctor` deep mode

Current `summer doctor` checks auth, version, port. Extend with: which MCP tools are live, which engine ops are available (so deprecated/missing ops surface early), what package version vs what engine binary expects. Gives the agent a clean way to know the runtime capability surface.

### Test-scene runner

Many projects have `scenes/debug/*.tscn` with self-asserting validators that call `get_tree().quit()` at end. There's no MCP op to run these headlessly and report pass/fail. Op: `RunHeadlessScene(path)` returning `{ exit_code, stdout, stderr, duration_ms }`.

### Skill / Command universal install

Done in this commit for Claude Code: `summer skills install --agent claude-code` now ALSO copies `tools/summer-cli/commands/*.md` into `~/.claude/commands/`. Want to extend equivalent to other agents (Cursor has its own commands convention, Codex prompt files, etc) so skills + commands travel together.

### Reference-quality skill template / linter

`tools/summer-cli/skills/workflow/skill-create/SKILL.md` exists but doesn't enforce the style rules (no dates, no project names, no em dashes, lead-with-the-why). A pre-commit hook + a `summer skills lint` subcommand would catch these mistakes before they ship into the canonical store.

### Engine-side log file tail

P4 above. Re-stating with a concrete shape: `summer_read_engine_log(lines: int = 200)` reads the tail of `<userdir>/logs/godot.log`. Engine-side: expose `GetUserDir()` op so the CLI can find the file. Wins: persistent logs survive process restarts, more complete than the in-memory debugger ring buffer.

### Asset pipeline introspection

`summer_import_from_url` exists. Missing: `ListImportedAssets()`, `GetImportStatus(uid)`, `RetryImport(uid)`. Useful for "the texture didn't import — why?" without opening the editor.

### Save/load profile tooling

For games with persistent progression (meta-currency, achievements), an op to inspect/clear `user://progress.cfg` from MCP would speed up balancing iterations dramatically.

### Cross-machine setup automation

A user asked: "I want gameskill on my other PC." Now solved by `summer skills install --agent claude-code` shipping the slash command. Bigger version: `summer setup-machine` that walks a fresh machine through everything (Godot install, Summer Engine binary download, project clone, skills + commands install, MCP server config). One-line bootstrapping.
