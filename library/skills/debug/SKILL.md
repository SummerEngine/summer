---
name: debug
description: Use when the user reports a bug, crash, error, or unexpected behavior in a Summer project, before making code or scene changes. Runs a disciplined script-errors, console, debugger, hypothesis, fix, and verify loop. Trigger on "debug", "crash", "error", "broken", "not working", "freezes", "wrong".
license: MIT
compatibility: [Cursor, Claude Code, Codex, Windsurf, Gemini, OpenCode]
category: debugging
user-invocable: true
allowed-tools: Read Edit Grep summer_create_debug_report summer_get_diagnostics summer_get_script_errors summer_get_console summer_clear_console summer_get_debugger_errors summer_get_debugger_warnings summer_play summer_stop summer_is_running summer_inspect_node summer_inspect_resource summer_get_scene_tree summer_screenshot summer_batch
paths: ["**/*.gd", "**/*.cs", "**/*.tscn", "**/*.tres", "project.godot"]
---

# /debug — Triage and Fix a Bug End-to-End

The disciplined debugging loop for Summer projects. Read the error before
guessing. Form a hypothesis before editing. Verify the fix before declaring
victory. Never grep the codebase before reading the actual error.

**Core principle:** The debugger already knows what's wrong. Your job is to listen to it before doing anything else.

## When to use this skill

- The user says "it crashes", "it broke", "throws an error", "doesn't work", "freezes", "wrong behavior".
- The user invokes `/summer debug`, asks for a support report, or wants something they can send to Summer.
- The user pastes a stack trace.
- A previous build or test step failed and the user wants to fix it.

## When NOT to use this skill

- The user is asking how to *prevent* a class of bug — that's a design question. Use the relevant discipline skill (`gdscript-patterns`, `scene-composition`).
- The user is asking for a feature with a known unfinished spec — that's `make-game` territory.
- The bug is in a non-Godot file the host agent can debug natively (CI config, npm scripts) — use the host's debugger.

## The Loop

```
  Listen → Diagnose → Hypothesize → Propose → Fix → Verify
```

Do not skip steps. Do not loop back to "Hypothesize" without re-running the cheap diagnostic.

### 0. Support report mode

If the user asks for `/summer debug`, "send this to Summer", "make a report", or they are stuck in Codex/cloud/another agent environment, create a portable report first:

```
summer_create_debug_report({
  issue: "<one-sentence user symptom>",
  include_play_session: <true only when the issue appears during runtime>
})
```

Tell the user where the Markdown file was written and remind them to review local paths and stack traces before sending. Then continue the normal debug loop only if they also asked you to fix the bug.

Fallback when the MCP tool is not available but shell is available:

```
summer debug "<one-sentence user symptom>"
```

Add `--play` only when the issue appears after pressing Play.

### 1. Listen

Ask the user **one** focused question and wait for the answer:

> What's happening, and when does it happen?

If they already gave a clear symptom in the request, skip the question.
If they say "something's broken", that one question is your only call until they reply. Don't run tools yet.

### 2. Diagnose — cheapest tool first

In strict order. Stop at the first one that returns useful signal.

| Order | Tool | When |
|---|---|---|
| 1 | `summer_get_script_errors` | Always start here. Catches GDScript parse errors, missing identifiers, signature mismatches. Cheapest, no side effects. |
| 2 | `summer_get_diagnostics` | Aggregate console + debugger error counts. One call, broad picture. |
| 3 | `summer_get_console` | Read the editor Output panel — print statements, warnings, errors that didn't crash. |
| 4 | `summer_get_debugger_errors` | Runtime errors caught by the debugger. Use AFTER `summer_play` for runtime-only bugs. |
| 5 | `summer_get_debugger_warnings` | Warning bodies (file/line/function/callstack). Use when diagnostics reports a non-zero `debugger.warnings`. |

**If `summer_get_script_errors` is clean and the user says it crashes only when running:** it's a runtime bug. Go to step 2b.

### 2b. Runtime-only bugs

**Reproduce it yourself first.** Write a `RunVerification` probe that performs the repro steps (`press` / `key`), reports the state you expect to be wrong, and saves a frame. See "Drive the game yourself" below for the exact call. The returned `results.errors_seen` and `reports` are the diagnostic. This costs one call, touches nothing the user owns, and gives you a repro you can re-run after the fix.

Fall back to the editor session only when the repro genuinely needs a human (feel, hardware, "is this what you meant?"):

```
  summer_clear_console
  summer_play
  ─▶ ASK USER: "Reproduce the bug now."
  (wait for confirmation)
  summer_get_debugger_errors
  summer_get_debugger_warnings   (if diagnostics showed warnings)
  summer_stop
```

If you go this route, do not skip the "reproduce now" prompt. Auto-running and grabbing whatever's in the buffer leads you to chase ghosts from previous sessions.

### 2c. MCP unavailable (engine not running, or no Summer install)

If `summer_get_script_errors` returns "Summer Engine is not running" or the tool isn't available:

1. Tell the user `summer run` starts it. One command restores every tool in this loop — try that before degrading to an interview.
2. If they cannot or will not, ask the user to copy-paste the Output panel and
   the Debugger panel from Summer Engine.
3. Reason over the pasted text exactly as you would over MCP output.
4. Continue with the rest of the loop unchanged.

Do NOT loop on MCP retry. Do NOT pretend the engine will come back. Use the fallback the moment it fails once.

### 3. Hypothesize — one specific theory

State exactly one hypothesis, in one sentence, naming the file and line.

> **Good:** "Typo at `scripts/player.gd:14` — `GRAVTY` should be `GRAVITY`."
> **Bad:** "Could be a typo, missing import, or wrong scope."

If you have multiple plausible theories, pick the highest-prior-probability one. The user can correct you if you're wrong; chasing all three at once wastes their time.

**Verify the hypothesis without editing.** If the error mentions a missing node, call `summer_inspect_node` to confirm. If it's a missing resource, `summer_inspect_resource`. If it's a scene-graph issue, `summer_get_scene_tree`. **Confirm the world state matches the error before proposing a fix.**

### 4. Propose — ask before writing

Surface the proposed fix in plain language and ask permission. Two patterns:

**Code fix:**
> May I edit `scripts/player.gd` to rename `GRAVTY` → `GRAVITY` on line 14?

**Scene fix vs code fix:**
> The script calls `audio.play()` but the `AudioStreamPlayer` child is gone. Two options:
> 1. Re-add the `AudioStreamPlayer` to `./Coin` (preserves the original behavior).
> 2. Null-check in `coin.gd` (defensive, but the audio is silent).
>
> Which one do you want?

**Never** unilaterally pick when there are two equally valid fixes (scene vs code, defensive vs strict, fast vs correct). Ask.

### 5. Fix — minimal, focused

- For GDScript edits: `Read` the 20–40 lines around the error, `Edit` the exact change. Don't read the whole file. Don't reformat. Don't rename other things.
- For scene edits: use the appropriate `summer_*` tool (`summer_add_node`, `summer_set_prop`, `summer_replace_node`). Group multi-step changes in `summer_batch` for one undo step.
- **Nested resource properties:** `summer_set_resource_property` works against inline `sub_resource` targets too — pass `nodePath`, `resourceProperty`, and `subProperty` (there is no dotted `"mesh.size"` form). Structural failures (`node not found`, `property is not a resource`, `resource is null`) are explicit errors; a bad value shape is not — a JSON object instead of a Godot literal string, a misspelled `key`/`subProperty`, or a wrong-typed value returns `ok:true` yet silently no-ops or coerces destructively on current engines (dict → material cleared; dict → `Color(0,0,0,1)`; newer engines reject these with `unknown_property` / `bad_value_shape` / `type_mismatch`). Pass class names and `Color(...)`/`Vector3(...)` strings, and confirm the fix in the saved `.tscn` or a snapshot diff, never from `ok` alone. See `../../references/mcp-tools-reference/mcp-tools-reference.md`.

### 6. Verify — re-run the diagnostic that found it

The fix is not done until the same diagnostic that found the bug returns clean.

- Script error → re-run `summer_get_script_errors`.
- Runtime error → re-run the play/reproduce/check-debugger loop.
- Console warning → `summer_clear_console`, then `summer_play` and confirm clean output.

If the diagnostic is still red after the fix, you formed the wrong hypothesis. Go back to step 3 — do **not** make a second edit on top of the first. Revert if the first edit didn't help, then re-hypothesize.

## Anti-Patterns

| Don't | Why |
|---|---|
| Grep the whole project before reading the error | The error already names the file and line. Save the user's tokens. |
| Read whole files | 20–40 lines around the error is enough 90% of the time. |
| Run multiple diagnostics in parallel | They mask each other's signal. Cheapest first, escalate. |
| Edit before asking | The user owns the fix decision, you own the diagnosis. |
| "Try this, see if it works" | That's not a hypothesis, that's gambling. State the theory or ask another question. |
| Reformat the file while you're in it | Out-of-scope edits make the diff hostile to review. |
| Auto-fix linter warnings unrelated to the bug | Same reason. |
| Declare victory after editing | Re-run the diagnostic. Always. |

## Quick reference — common Summer Engine bug families

| Symptom | First tool | Common cause |
|---|---|---|
| "Identifier X not declared" | `summer_get_script_errors` | Typo, missing import, wrong scope |
| "Invalid call. Nonexistent function 'X' in base 'Nil'" | `summer_get_debugger_errors` after `summer_play` | Node was deleted in editor, code still references it |
| "Cannot find type 'X'" | `summer_get_script_errors` | Class name mismatch, missing autoload, missing `class_name` |
| Game runs but visuals wrong | `summer_get_console` + `summer_inspect_node` | Material/light/camera misconfigured |
| Game freezes (no crash) | `summer_get_console` after `summer_play` for ~3s | Infinite loop in `_process` or `_ready` |
| `summer_set_resource_property` "succeeded" but nothing changed | n/a | Inline sub-resource silent-fail. Use `summer_set_prop` with class name first. |

## Closing

A debug session is done when:
1. The user-reported symptom no longer reproduces.
2. The diagnostic that originally flagged the bug returns clean.
3. No new errors or warnings have been introduced.

Tell the user one short sentence: "Fixed `<file>:<line>` — `<change>`. Diagnostic clean." Then stop.

## What the MCP debug tools CAN and CAN'T see (read this before claiming "clean")

The static and boot-time tools (`summer_get_script_errors`, `summer_get_console`, `summer_get_diagnostics`) **can't substitute for play-testing** — but you have a play-testing route, so a false-clean report is a choice, not a limitation. Know which tool answers which question.

### What the MCP CAN see

- **Script parse errors** (`summer_get_script_errors`) — full text + file:line. Reliable.
- **Editor console output** (`summer_get_console`) — `print` statements, editor-side warnings, std startup messages. Full text.
- **Runtime debugger error count + full text** (`summer_get_debugger_errors`) — returns `errors_data` with `error`, `error_descr`, `callstack`, `file`, `function`, `line`. Reliable for errors.
- **Runtime debugger warning text** (`summer_get_debugger_warnings`) — same structured shape as the errors tool, filtered to severity `warning`. Use it whenever `summer_get_diagnostics` shows a non-zero `debugger.warnings`; do not report a warning count you never read.
- **Diagnostics summary** (`summer_get_diagnostics`) — counts of console errors, debugger errors, debugger warnings, script errors. Tells you where to drill. **Counts only** — it carries no FPS, frame time, draw calls, or physics-body numbers.
- **Scene tree + node properties** (`summer_get_scene_tree`, `summer_inspect_node`) — only the **edited** scene, not the running game's live tree.
- **Rendered pixels** (`summer_screenshot`) — `target:"viewport"` for the editor's current view, `target:"scene"` for an offscreen render of a scene file, `target:"game"` for a frame of the running game (that one needs the Summer desktop app bridge and fails cleanly over a plain local connection). You look at the actual image, not a description of it.
- **Gameplay behaviour, driven by you** (`RunVerification` via `summer_batch`) — see the next section. Input, live tree, and frames from a real running instance.
- **Whether the game is running** (`summer_is_running`) — and on which scene.

### Drive the game yourself — `RunVerification`

For any bug that only fires from gameplay (movement, weapon firing, level transitions, button clicks), do **not** hand the repro to the user first. Spawn a hidden, disposable game instance that runs a GDScript probe and dies. It never touches the user's editor session.

```
summer_batch ops:[{
  "op": "RunVerification",
  "probe_source": "extends SummerProbeBase\nfunc _ready() -> void:\n\tawait super._ready()\n\tawait get_tree().process_frame\n\tvar p := get_tree().root.find_child(\"Player\", true, false)\n\treport(\"y0\", p.global_position.y)\n\tawait press(\"jump\", 120)\n\tawait get_tree().create_timer(0.4).timeout\n\treport(\"y1\", p.global_position.y)\n\tsave_frame(\"after\")\n\tdump_tree()\n\tfinish()",
  "max_seconds": 20
}]
```

Probe API: `report(key, value)`, `save_frame(name)`, `dump_tree(max_depth)`, `press(action, hold_ms)`, `key(keycode, hold_ms)`, `finish()`. Returns `{ok, results, frames, out_dir}`; `results.errors_seen` carries error-level engine/script messages from that run, so a probe is also a clean way to catch a runtime error without polluting the editor's debugger buffer.

This covers what static diagnostics cannot: pressed input, live scene tree (`dump_tree` reads the *running* tree, unlike `summer_get_scene_tree`), state sampled over several frames, and real rendered frames.

`summer_batch` forwards unknown ops verbatim, which is how you reach `RunVerification` with no dedicated tool. Note that the sibling `SimulateInput` op is **not** reachable this way — non-bridge callers get `{ok:false, failure_reason:"unsupported_transport"}`; it only works from the in-editor chat bridge. Drive input with `press()` / `key()` inside a probe instead.

### What still genuinely needs the user

- **Whether it feels right.** Frame counts and reports cannot tell you the jump feels floaty. See `debugging-game-feel`.
- **Hardware-specific and non-deterministic behaviour.** A bug that only fires on their GPU, their controller, or one run in twenty.
- **A judgement call on intent.** "Is this the behaviour you wanted?" is a question, not a measurement.

Everything else — press the button, read the state, look at the frame — is yours to do.

### The "static-only is not testing" rule

A clean `summer_get_diagnostics` after `summer_play` only proves: **the game booted without parse errors or @implicit_ready null-derefs.** It does NOT prove gameplay works. Auto-fire weapons, level transitions, spell casting, boss attacks, UI interactions all happen *after* boot and won't surface in the diagnostics until they fire.

When you've made code changes and want to declare them "verified":

1. **Required**: `summer_get_script_errors` clean on every modified file.
2. **Required**: `summer_play` boot returns 0 errors (use the scene most likely to exercise the change).
3. **Required**: exercise the specific scenario the change touches with a `RunVerification` probe — press the input, assert the state, save a frame. Quote the reports you got back.
4. Ask the user to play only for what a probe cannot judge: feel, hardware-specific behaviour, or whether the result is what they wanted.
5. **Never claim "verified" from static analysis alone.** Say "compiles and boots clean — needs play-test to confirm <specific behavior>."

### The cost of skipping it

A typical cautionary scenario: many parallel agents write thousands of lines of game code in one batch with verification static-only. The build is "diagnostic-clean" yet the running game has telegraph meshes that render the wrong axis, parse-valid scripts that crash on first autoload because of a guard pattern that doesn't compile, projectile tracers sized so they read as straight lines instead of projectiles, transform-leaked colliders from a copied scene, and `@onready` paths that throw on every boot when the script is loaded into a sibling scene that lacks one of the referenced children. None of these surface in `summer_get_diagnostics` until something actually plays the game — which is exactly what a `RunVerification` probe does, and why "I had no way to test it" is not an available excuse.

Static analysis is necessary but never sufficient.
