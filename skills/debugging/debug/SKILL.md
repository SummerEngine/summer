---
name: debug
description: Use when the user reports a bug, crash, error, or unexpected behavior in a Godot/Summer project, before making any code or scene changes — runs a disciplined script-errors → console → debugger → hypothesis → fix → verify loop. Trigger on "debug", "crash", "error", "broken", "not working", "freezes", "wrong".
license: MIT
compatibility: [Cursor, Claude Code, Codex, Windsurf, Gemini, OpenCode]
category: debugging
user-invocable: true
allowed-tools: Read Edit Grep summer_create_debug_report summer_get_diagnostics summer_get_script_errors summer_get_console summer_clear_console summer_get_debugger_errors summer_play summer_stop summer_is_running summer_inspect_node summer_inspect_resource summer_get_scene_tree
paths: ["**/*.gd", "**/*.cs", "**/*.tscn", "**/*.tres", "project.godot"]
---

# /debug — Triage and Fix a Bug End-to-End

The disciplined debugging loop for Godot/Summer projects. Read the error before guessing. Form a hypothesis before editing. Verify the fix before declaring victory. Never grep the codebase before reading the actual error.

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

**If `summer_get_script_errors` is clean and the user says it crashes only when running:** it's a runtime bug. Go to step 2b.

### 2b. Runtime-only bugs

```
  summer_clear_console
  summer_play
  ─▶ ASK USER: "Reproduce the bug now."
  (wait for confirmation)
  summer_get_debugger_errors
  summer_stop
```

Do not skip the "reproduce now" prompt. Auto-running and grabbing whatever's in the buffer leads you to chase ghosts from previous sessions.

### 2c. MCP unavailable (engine not running, or no Summer install)

If `summer_get_script_errors` returns "Summer Engine is not running" or the tool isn't available:

1. Ask the user to copy-paste the Output panel and the Debugger panel from the Godot editor.
2. Reason over the pasted text exactly as you would over MCP output.
3. Continue with the rest of the loop unchanged.

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
- **Trap to avoid:** never call `summer_set_resource_property` against an inline `sub_resource` — the value is silently dropped. If the property is on a nested resource, first call `summer_set_prop` with the resource class name to instantiate a standalone resource, then drill in. See `references/mcp-tools-reference.md`.

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

## Quick reference — common Godot bug families

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

The `summer_*` tools are powerful for static + boot-time issues but **can't substitute for play-testing**. Knowing the gaps prevents false-clean reports.

### What the MCP CAN see

- **Script parse errors** (`summer_get_script_errors`) — full text + file:line. Reliable.
- **Editor console output** (`summer_get_console`) — `print` statements, editor-side warnings, std startup messages. Full text.
- **Runtime debugger error count + full text** (`summer_get_debugger_errors`) — returns `errors_data` with `error`, `error_descr`, `callstack`, `file`, `function`, `line`. Reliable for errors.
- **Diagnostics summary** (`summer_get_diagnostics`) — counts of console errors, debugger errors, debugger warnings, script errors. Tells you where to drill.
- **Scene tree + node properties** (`summer_get_scene_tree`, `summer_inspect_node`) — only the **edited** scene, not the running game's live tree.
- **Whether the game is running** (`summer_is_running`) — and on which scene.

### What the MCP CAN'T see (right now)

- **Debugger warning text.** `summer_get_debugger_errors` returns a `warnings: <count>` integer but no `warnings_data` array. You see "the game has 66 warnings" but you can't read them through MCP. **Tell the user: "I see N warnings exist but the MCP doesn't expose their text — paste the Debugger panel if any feel relevant."**
- **Live runtime scene tree.** `summer_get_scene_tree` returns the editor's edited scene, not what's currently instantiated in the running game. When debugging runtime state, you can't introspect the live nodes.
- **Keyboard / mouse / controller input simulation.** No tool sends key presses or mouse motion. So bugs that only fire from gameplay (player movement, weapon firing, level transitions, button clicks) require the user to play.
- **Screenshot / visual diff.** No tool captures the rendered viewport. Visual regressions ("the floor looks wrong", "the camera clips through terrain") require user eyes.
- **Frame-by-frame physics state.** No tool steps the simulation or watches for transient errors over time.

### The "static-only is not testing" rule

A clean `summer_get_diagnostics` after `summer_play` only proves: **the game booted without parse errors or @implicit_ready null-derefs.** It does NOT prove gameplay works. Auto-fire weapons, level transitions, spell casting, boss attacks, UI interactions all happen *after* boot and won't surface in the diagnostics until they fire.

When you've made code changes and want to declare them "verified":

1. **Required**: `summer_get_script_errors` clean on every modified file.
2. **Required**: `summer_play` boot returns 0 errors (use the scene most likely to exercise the change).
3. **Recommended**: ask the user to play through the specific scenario the change touches, then re-run `summer_get_diagnostics`.
4. **Never claim "verified" from static analysis alone.** Say "compiles and boots clean — needs play-test to confirm <specific behavior>."

### The cost of skipping it

A typical cautionary scenario: many parallel agents write thousands of lines of game code in one batch with verification static-only. The build is "diagnostic-clean" yet the running game has telegraph meshes that render the wrong axis, parse-valid scripts that crash on first autoload because of a guard pattern that doesn't compile, projectile tracers sized so they read as straight lines instead of projectiles, transform-leaked colliders from a copied scene, and `@onready` paths that throw on every boot when the script is loaded into a sibling scene that lacks one of the referenced children. None of these surface in `summer_get_diagnostics` until the user actually plays.

Static analysis is necessary but never sufficient.
