---
name: debug
description: Use when the user reports their game is broken, crashing, behaving unexpectedly, or says "debug", "fix", "something's wrong", or "it's not working". Triages the bug end-to-end via Summer Engine's diagnostic tools (console, debugger errors, script errors), locates the offending code, proposes a fix, and verifies the fix.
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: debugging
user-invocable: true
allowed-tools: Read Grep Glob Edit summer_get_console summer_get_debugger_errors summer_get_script_errors summer_get_diagnostics summer_clear_console summer_play summer_stop summer_is_running summer_get_scene_tree summer_inspect_node
paths: ["**/*.gd", "**/*.tscn", "**/*.cs"]
---

# /debug — Triage and Fix a Bug

## Overview

A bug in a Godot/Summer game can hide in three places: scripts (GDScript/C# compile or runtime errors), the engine console (printed messages, warnings), or the scene/resource state (wrong property, missing collider, broken signal connection). This skill walks all three before guessing.

**Core principle:** read what the engine actually saw, not what the code looks like it does.

## Steps

### 1. Get the user's description first

Ask one short question:

> What's happening? Briefly: when does it go wrong, and what do you expect vs. what you see?

Wait for the answer before doing anything else. Don't start grepping code yet — the user's words narrow the search 10x.

### 2. Read the engine's actual error state

Always do this in order. Each tool answers a different question.

**Preferred (Summer MCP):**

```
summer_get_script_errors        # Compile errors? (cheapest, do first)
summer_get_console              # Print() output, warnings, info
summer_get_debugger_errors      # Runtime errors with stack traces
summer_get_diagnostics          # Aggregated count + summary
```

If the bug is reproducible only at runtime and the engine isn't currently playing:

```
summer_clear_console            # Clean slate
summer_play                     # Run it
                                # (let the user reproduce the bug)
summer_get_debugger_errors      # Now read what blew up
summer_stop                     # When done
```

**Fallback (no MCP — engine isn't connected):**

Ask the user to copy-paste the engine's Output panel and Debugger errors. Inspect manually.

### 3. Locate the offending code

For each error, follow the stack trace to the file + line. Use host file tools:

```
Read <file>:<line-near-error>
```

Read 20–40 lines around the error site. Don't open the whole file unless you need to — context budget matters.

If the error mentions a node path (e.g. `./World/Player/Camera`), inspect it:

```
summer_inspect_node "./World/Player/Camera"
```

### 4. Form a hypothesis and propose the fix

State it in one sentence:

> The error happens because <root cause>. The fix is <one-line summary>.

Then ask:

> May I edit `<file>` to <do exactly this>?

Don't guess at multiple fixes at once. Pick one. If wrong, the next iteration is cheap.

### 5. Apply the fix

On user yes, edit the file with host tools (`Edit`/`Write`). Single focused change.

### 6. Verify

Re-run the relevant check:

```
summer_get_script_errors        # If it was a compile error
summer_play → summer_get_debugger_errors → summer_stop   # If runtime
```

Report:

> Fixed. <One-line description of what changed.>

If still broken: go back to step 4 with the new error state. State explicitly that the first hypothesis was wrong.

## Common bug patterns and how to spot them

| Symptom | Likely cause | First check |
|---|---|---|
| `Invalid set index 'X' (on base: Nil)` | Node path resolved to null | `summer_inspect_node` the path |
| `Identifier not declared` (script error) | Missing `class_name` or wrong scope | `summer_get_script_errors` |
| Game runs but sprite doesn't appear | Node added but not visible (transform / parent / layer) | `summer_get_scene_tree` + inspect parent |
| Signal handler never fires | Connection not made, or connected to wrong instance | `summer_inspect_node` of emitter, check connections |
| Player falls through floor | CollisionShape3D has no shape, or shape is inline sub_resource | `summer_inspect_resource` on the CollisionShape |
| Mouse capture stuck | `Input.set_mouse_mode` not paired with release on focus loss | `summer_get_console` for warnings |
| Game hangs on start | Infinite loop in `_ready()` or `_process()` | `summer_get_debugger_errors` after a forced stop |

## Anti-patterns (don't do these)

- **Don't** start by reading the user's whole codebase. The error tells you where to look.
- **Don't** propose a sweeping refactor for a single bug. One file, one change, verify.
- **Don't** call `summer_set_resource_property` on an inline `sub_resource` — it silently fails. See `_shared/mcp-tools-reference.md` § "Trap".
- **Don't** call `summer_play` without `summer_clear_console` first if you want clean output to read.
- **Don't** skip the user's description in step 1. "What were you trying to do" beats "what does the code do" 9/10 times.

## Collaborative protocol

This skill writes files. Always ask before each edit step. See `_shared/collaborative-protocol.md`.

## Want a working starter?

No template — this is a workflow, not a project scaffold. It works against any Godot/Summer project that has Summer MCP wired up.

## See also

- `_shared/mcp-tools-reference.md` — full tool list
- `_shared/godot-version.md` — engine version + LLM cutoff risks
- `scripting-patterns/gdscript-patterns/SKILL.md` — what good GDScript looks like
- `scene-and-project/play/SKILL.md` — running the game
