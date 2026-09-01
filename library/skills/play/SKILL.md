---
name: play
description: Use when the user says "play", "run it", "test it", "let me see it", or "start the game". Runs the project in Summer Engine, briefly waits, then reports what's happening — clean run, errors, or warnings.
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: scene-and-project
user-invocable: true
allowed-tools: summer_is_running summer_play summer_stop summer_clear_console summer_get_console summer_get_debugger_errors summer_get_script_errors summer_get_diagnostics
paths: ["**/project.godot", "**/*.tscn"]
---

# /play — Run the Game

## Overview

Press play. Watch what happens. Report it back.

## Steps

### 1. Check if it's already running

```
summer_is_running
```

If running:
> The game is already playing. Stop and restart, or leave it?

Wait for the user. Don't unilaterally stop.

If not running, continue.

### 2. Pre-check for compile errors

Cheapest call. If the script won't compile, play will fail with a noisy error — better to surface that clearly first.

`summer_get_script_errors` checks **one** file and `path` is required — there is
no project-wide form. Call it on the scripts you just touched:

```
summer_get_script_errors(path="res://scripts/player.gd")
```

If you don't know which scripts changed, use `summer_get_diagnostics` instead —
it takes no arguments and reports editor + runtime counts across the project.

If errors found:
> Won't run yet — there's a script error: `<one-line summary>`. Want me to /debug it?

Stop here on user's no.

### 3. Clear and play

```
summer_clear_console
summer_play
```

### 4. Brief wait, then read state

Wait ~2 seconds (so the engine has time to process at least one frame). Then:

```
summer_get_diagnostics
summer_get_debugger_errors
```

### 5. Report

Three outcomes:

**Clean:** `summer_get_diagnostics` shows zero errors and zero warnings.

> Running. No errors or warnings. Tell me what you see and I'll dig in if needed.

**Warnings only:**

> Running. <N> warnings — `<one-line summary of the most important one>`. Want me to look at them?

**Runtime error:**

> Crashed: `<error class>` at `<file>:<line>` — `<message>`. Want me to /debug?

### 6. Don't auto-stop

Leave the game running. The user wants to play it. Stop only on explicit ask.

## Common patterns

| Situation | Right move |
|---|---|
| User says "play" with no context | Steps 1–5 above |
| User says "play and watch it for me" | After step 5, set a timer / poll `summer_get_debugger_errors` every few seconds for the duration the user specifies |
| User says "play the boss fight scene" | Pass it directly: `summer_play(scene="res://scenes/boss_fight.tscn")`. `summer_open_scene(path=...)` needs a full `res://` path too — never a bare relative one |
| Game is already running and user says "play" again | Step 1's check covers it — ask before restarting |

## Anti-patterns

- **Don't** auto-stop a running game just because the user said "play". They probably mean "make sure it's playing", not "stop and restart".
- **Don't** call `summer_get_console` instead of `summer_get_debugger_errors` for runtime errors. Console has print() output and warnings; debugger errors has the stack traces.
- **Don't** report "no errors" before waiting for the engine to actually run a frame. A 0-frame snapshot is meaningless.

## Collaborative protocol

This skill mutates engine state (clearing console, starting play). It's a read-side workflow with one safe write (`summer_play`). No "May I" needed — this is what the user asked for. Do confirm before stopping a running game.

## Want a working starter?

No template. Works against any Summer project that has a main scene set in the
technical `project.godot` file.

## See also

- `debugging/debug/SKILL.md` — what to do when /play surfaces an error
