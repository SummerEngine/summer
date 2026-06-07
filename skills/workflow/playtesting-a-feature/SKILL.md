---
name: playtesting-a-feature
description: Use when about to claim a gameplay feature is done, shipped, or working — requires actually running the game and walking through the feature before declaring completion. Static diagnostics and type checks do not count as playtesting.
---

# Playtesting A Feature

## Overview

A game feature is not done because it compiles. It is not done because the tests pass. It is not done because `summer_get_diagnostics` is clean. It is done when someone has played it and the thing it promised actually happens.

**Core principle:** If you have not pressed play and walked the feature, you have not shipped it.

This skill governs the play-the-game layer of verification. It does not replace:

- `summer:verification-before-completion` — type checks, build output, test runs. Run that for the code layer.
- `summer:debug` — operational triage when a feature is actively broken or crashing.
- `summer:investigating-bugs` — root-cause analysis once a specific bug is reproducible.

Use those skills first if they apply. This skill runs **after** code-level verification, **before** telling the user the feature is done.

<EXTREMELY-IMPORTANT>
Static analysis is necessary but never sufficient for gameplay features. A clean `summer_get_diagnostics` after `summer_play` only proves the game booted. It does NOT prove the feature works. Auto-fire weapons, level transitions, UI flows, input handling, multi-frame physics — none of these surface in diagnostics until they fire during real play.
</EXTREMELY-IMPORTANT>

## The Iron Law

```
NO "FEATURE SHIPPED" CLAIM WITHOUT A PLAYED WALKTHROUGH
```

If you have not, in this session, called `summer_play` and either:

1. Walked the feature yourself via MCP-driven repros where possible, OR
2. Asked the user to walk it and confirmed the result via `summer_get_console` / `summer_get_debugger_errors`

— then you cannot claim the feature works.

## The Loop

```
  Define golden path → Play → Walk it → Probe edges → Capture state → Decide
```

### 1. Define the golden path

Before pressing play, write down — in one or two sentences — what "feature works" means as a user-visible sequence. Be concrete.

> **Good:** "Player walks to chest, presses E, chest opens, item drops, item enters inventory, inventory UI updates."
> **Bad:** "Inventory pickup works."

If you cannot describe the golden path in one sentence, you do not understand the feature well enough to verify it. Ask the user.

### 2. Press play

```
  summer_clear_console
  summer_play
  summer_is_running  (confirm)
```

`summer_clear_console` first so the buffer is not polluted by a previous session's errors. If you skip this, you will chase ghost errors that have nothing to do with the current feature.

### 3. Walk the golden path

The MCP cannot simulate keyboard input, mouse motion, or controller. So either:

- **The user plays.** Ask them to walk the exact golden path you defined. Wait for their confirmation that they did. Then check state.
- **You drive via scene mutation.** For features that can be triggered through `summer_set_prop` or function calls exposed to the editor (e.g. autoload methods), drive them programmatically. Be honest about which path you took.

After the walkthrough:

```
  summer_get_console            (look for unexpected prints, warnings)
  summer_get_debugger_errors    (runtime errors caught mid-play)
  summer_get_diagnostics        (overall counts)
```

If anything is non-zero or unexpected, the feature is not done. Go to `summer:debug`.

### 4. Probe the edges

The golden path proves the happy case. Most gameplay bugs live in the edges. Before claiming done, probe at least these four classes:

| Edge | What to try | Why |
|---|---|---|
| Input spam | Press the action button 10x in a row, hold it, mash during a transition | Race conditions, state machines that swallow input, double-trigger bugs |
| Off-screen / out-of-range | Trigger the feature when the actor is far from the camera, off the navmesh, in a different scene | `@onready` paths that assume specific parent, signal connections that drop when nodes free |
| Paused / state-change | Trigger during pause, mid-cutscene, while another modal is open | `process_mode` mistakes, `get_tree().paused` not respected |
| Multi-frame | Repeat the feature 5 times in a row without restarting the scene | Leaked nodes, accumulating signals, growing arrays, sound stacking |

You do not need to probe every edge for every feature. Pick the 2-3 that are most relevant to the feature's mechanics. Skip with a one-line note if you skip: "Did not probe pause-state — feature only runs in main menu."

### 5. Capture state, then decide

After the walkthrough and edge probes, capture one final snapshot:

```
  summer_get_diagnostics
  summer_get_console  (if anything looked off)
```

State the result in plain language:

> "Played the chest-open feature: golden path works (chest opens, item enters inventory, UI updates). Probed input spam (no double-pickup), probed pause (correctly disabled). Diagnostics clean. Feature done."

Or:

> "Played the chest-open feature: golden path works, but pressing E twice in 100ms duplicates the pickup. Not done — going to summer:debug."

## "Looks right" vs "is right"

A common failure mode: the feature visually looks correct on first try, you stop there, ship it, and a deeper bug surfaces later.

**Looks right** means the rendered frame matches expectations.

**Is right** means the rendered frame matches expectations AND the underlying state is consistent AND it survives repetition AND no errors are silently logged.

The console catches "looks right but isn't right" cases — silent errors, deprecation warnings, signal misfires that don't crash but indicate a real bug. **Always read `summer_get_console` after a playthrough, even when the visuals looked fine.**

## When to record video vs when console+diagnostics is enough

Console + diagnostics + your walkthrough description is usually enough. Ask the user for a video or screenshot when:

- The feature is **visual** (camera, lighting, particles, animation, UI layout) and the user is the only one who can see the result.
- The feature **feels wrong** — see `summer:debugging-game-feel`. Frame counts and console output cannot capture "the jump feels floaty."
- The bug is **non-deterministic** — sometimes-works features need a recording to share with anyone diagnosing later.

Don't ask for video reflexively. Most features can be verified through `summer_get_console` + a "did the golden path work?" question. Cost-aware.

## Red Flags — STOP

| Red flag | Reality |
|---|---|
| "Compiles clean, shipping it" | Compiling is not playing. Press play. |
| "Diagnostics returned 0 errors after boot" | Boot is not play. The feature has not fired yet. |
| "User said make this — I'll move on once it builds" | The user wants the feature to work, not to build. |
| "It would take too long to play" | Playtest takes 60 seconds. Shipping a broken feature costs hours. |
| "The unit test passes" | Unit tests cover code paths, not gameplay sequences. |
| "I already played it in a previous session" | State changed. Press play in this session. |
| "I'll let the user catch any issues" | That is the user's job description for a non-AI engineer. Yours is to ship working features. |
| Skipping `summer_clear_console` before `summer_play` | You will chase last session's errors. |
| Skipping `summer_get_console` because diagnostics looked fine | Silent warnings and signal misfires hide there. |

## Rationalization Prevention

| Excuse | Reality |
|---|---|
| "Static checks are enough for this feature" | If it has any runtime behavior, no. |
| "The feature is too small to playtest" | Two lines of code can break a state machine. Play it. |
| "I'll batch the playtest with the next feature" | Bugs compound. Play each feature individually. |
| "User is in a hurry" | Shipping broken features is the slowest path. |
| "The repro is hard to set up" | That is a sign the feature has insufficient instrumentation. Add it, then play. |

## When the engine isn't running

If `summer_play` returns "Summer Engine is not running":

1. Tell the user: `summer run` to start it.
2. Do not claim the feature is verified from static analysis alone. Say: "Code compiles and looks correct, but I cannot playtest until the engine is running."
3. When the engine comes back, run the loop.

## The Bottom Line

A game feature is a promise to the player. Verifying it means seeing the promise kept on screen, not seeing the code that would, in theory, keep it.

Press play. Walk the path. Probe the edges. Read the console. Then claim done.

**Related skills:**
- `summer:verification-before-completion` — the code-layer verification this skill builds on.
- `summer:debug` — when the playtest surfaces a crash or error.
- `summer:investigating-bugs` — when the playtest surfaces a reproducible logical bug.
- `summer:debugging-game-feel` — when the feature works but feels wrong.
