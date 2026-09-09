---
name: playtesting-a-feature
description: Use when about to claim a gameplay feature is done, shipped, or working — requires actually running the game and walking through the feature before declaring completion. Static diagnostics and type checks do not count as playtesting.
---

# Playtesting A Feature

## Overview

A game feature is not done because it compiles. It is not done because the tests pass. It is not done because `summer_get_diagnostics` is clean. It is done when someone has played it and the thing it promised actually happens.

**Core principle:** If you have not pressed play and walked the feature, you have not shipped it.

This skill governs the play-the-game layer of verification. It does not replace:

- `verification-before-completion` — type checks, build output, test runs. Run that for the code layer.
- `debug` — operational triage when a feature is actively broken or crashing.
- `investigating-bugs` — root-cause analysis once a specific bug is reproducible.

Use those skills first if they apply. This skill runs **after** code-level verification, **before** telling the user the feature is done.

<EXTREMELY-IMPORTANT>
Static analysis is necessary but never sufficient for gameplay features. A clean `summer_get_diagnostics` after `summer_play` only proves the game booted. It does NOT prove the feature works. Auto-fire weapons, level transitions, UI flows, input handling, multi-frame physics — none of these surface in diagnostics until they fire during real play.
</EXTREMELY-IMPORTANT>

## The Iron Law

```
NO "FEATURE SHIPPED" CLAIM WITHOUT A PLAYED WALKTHROUGH
```

If you have not, in this session, driven the feature and read back what happened, you cannot claim it works.

**You walk the feature. Not the user.** A `RunVerification` probe presses your game's real inputs, reads state back across frames, and saves real rendered frames. Handing the walkthrough to the user is a last resort for things a probe genuinely cannot judge — see [What only a human can answer](#what-only-a-human-can-answer) — not the default.

On an engine build with the runtime-control ops (`summer_game_probe`, `summer_game_input`, `summer_game_control`, `summer_runtime_*`), drive the LIVE game instead of a hidden probe: deterministic launch, frame-stamped probe before and after every action, exact frame steps. That doctrine is the `agent-playtesting` skill; this skill's probe loop below is the path when those tools answer `engine_lacks_op`.

## The Loop

```
  Define golden path → Play → Walk it → Probe edges → Capture state → Decide
```

### 1. Define the golden path

Before pressing play, write down — in one or two sentences — what "feature works" means as a user-visible sequence. Be concrete.

> **Good:** "Player walks to chest, presses E, chest opens, item drops, item enters inventory, inventory UI updates."
> **Bad:** "Inventory pickup works."

If you cannot describe the golden path in one sentence, you do not understand the feature well enough to verify it. Ask the user.

### 2. Walk the golden path with a probe

Write the golden path as a `RunVerification` probe and send it as a raw op through `summer_batch`. The engine spawns a hidden, disposable game instance positioned offscreen, runs your GDScript, writes `results.json` plus any frames you saved, and kills the instance. It never touches the user's open editor, and nothing appears on their screen.

```
summer_batch ops:[{
  "op": "RunVerification",
  "probe_source": "<your GDScript>",
  "max_seconds": 20
}]
```

A probe extends `SummerProbeBase` and has: `report(key, value)`, `save_frame(name)`, `dump_tree()`, `press(action, hold_ms)`, `key(keycode, hold_ms)`, `finish()`.

```gdscript
extends SummerProbeBase

func _ready() -> void:
    await super._ready()
    for i in 20:
        await get_tree().physics_frame          # let the scene settle

    var player := get_tree().current_scene.get_node("Player")
    var start: Vector2 = player.position
    save_frame("00_start")

    await press("move_right", 500)              # await, or the hold never elapses
    await get_tree().physics_frame
    report("walked_right", player.position.x > start.x + 50)
    save_frame("01_after_walk")

    var y_before: float = player.position.y
    await press("jump", 50)
    var apex := y_before
    for i in 25:
        await get_tree().physics_frame
        apex = min(apex, player.position.y)
    report("jumped", apex < y_before - 30)
    save_frame("02_after_jump")

    finish()
```

Four rules the probe API will punish you for breaking:

- **`press()` and `key()` are coroutines.** `await press("jump", 50)` — calling them bare starts the press and never releases it. You also cannot store one in a variable and await it later; it returns void.
- **Assert on physics-frame-derived state.** `await get_tree().physics_frame` N times, then read positions. That is reproducible run to run.
- **Assert inequalities, never exact values.** `press(hold_ms)` waits on the wall clock, so the number of physics frames a key is held drifts between runs — the same walk lands on x=245 one run and x=250 the next. `position.x > start.x + 50` is a real assertion; `position.x == 250.0` is a flaky test you wrote yourself.
- **The global RNG is not seeded by default.** Anything downstream of `randf()` differs every run. Assert ranges, seed it yourself in the probe, or pin the launch — see [Deterministic runs](#deterministic-runs).

If the probe cannot express the check — no `SummerProbeBase` in this build, or a genuinely out-of-process feature — fall back to `summer_play` + diagnostics reads:

```
  summer_clear_console
  summer_play
  summer_is_running  (confirm)
```

`summer_clear_console` first so the buffer is not polluted by a previous session's errors. If you skip this, you will chase ghost errors that have nothing to do with the current feature.

Boot time varies, so do not sleep a guessed delay after `summer_play`. On engines with the events channel: `summer_recent_events` (note `next_seq`) → `summer_play` → `summer_wait_for_event since:<next_seq> kinds:["play.started"]`, then wait on `script.error` during the walkthrough to catch runtime script errors the moment they fire. `engine_lacks_events` means the build predates the channel — confirm with `summer_is_running` and read the console as above. A `timed_out` wait is not proof the game failed to start; check, do not assume.

### 3. Read back what actually happened

The probe's `results.json` is your primary evidence. Then read the editor's own view — in this order, because a played game's runtime errors are collected by the debugger and never reach the editor console:

```
  summer_get_diagnostics        (the verdict: console + debugger + script errors, complete counts)
  summer_get_debugger_errors    (the runtime errors themselves, with stacks)
  summer_get_console            (print() output and editor-side warnings — after the two above, never instead of them)
```

`summer_get_console` alone is never the verdict. Right after a play session that raised four runtime errors it honestly reports `errors 0`, because those errors live in the debugger; its result says so in `_scope`. A clean console proves only that nothing was printed to the editor log.

A probe also collects engine errors itself — `results.json` carries `errors_seen`. Read it. An empty `reports` block with `finished: false` means the probe hit its `max_seconds` ceiling before calling `finish()`, which is a failure, not a pass.

If anything is non-zero or unexpected, the feature is not done. Go to `debug`.

### What only a human can answer

A probe reports facts. It cannot hold an opinion. Ask the user only when the question is genuinely experiential:

- **Does it feel right?** Floaty jumps, sluggish input, mushy hit feedback — see `debugging-game-feel`.
- **Does it look good?** Composition, colour, readability. A probe can prove a light exists and prove the frame is not black; it cannot tell you the scene is ugly.
- **Is this fun?** Not a measurable property.

"I cannot simulate input" is not on that list, and has not been true since `RunVerification` shipped. If you catch yourself asking the user to press a key, write the probe instead.

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
  summer_get_diagnostics        (debugger.errors and console errors must both be 0)
  summer_get_debugger_errors    (if diagnostics shows any)
  summer_get_console            (if the printed output looked off)
```

State the result in plain language:

> "Played the chest-open feature: golden path works (chest opens, item enters inventory, UI updates). Probed input spam (no double-pickup), probed pause (correctly disabled). Diagnostics clean. Feature done."

Or:

> "Played the chest-open feature: golden path works, but pressing E twice in 100ms duplicates the pickup. Not done — going to debug."

## Deterministic runs

When a bug only shows on some runs, or two runs must be compared, pin the launch (newer engines): `summer_play seed:42 fixed_fps:60` (optionally `time_scale`). The pins ride on THIS launch's command line only — nothing is persisted, and omitting them is exactly the plain launch.

- **`seed` pins the GLOBAL RNG only** — `randi`/`randf`/`randi_range`/`randf_range`/`randfn`, `Array.shuffle`, `Array.pick_random`, re-seeded after the scene tree initializes and before autoloads and the main scene. It does **not** pin `RandomNumberGenerator` instances (self-randomized on construction), scripts that call `randomize()` (re-randomizes the global RNG from the wall clock), `rand_from_seed` (caller-seeded), wall-clock reads, thread/IO timing, or audio-device timing. The result restates this as `determinism.seed_scope`; a feature that still diverges with a seed is using one of those.
- **`fixed_fps` decouples scene time from the wall clock** — the game runs as fast as it renders, and frame-count-derived state lands on the same frame run to run. Assertions can become exact where they were ranges.
- **Read `determinism.applied`.** `applied:false` carries a `reason`: `already_running` (stop first, the pins cannot reach a live process), `editor_run_args_override` (a user-configured run argument re-sets the same flag and wins — `conflicting_flag` names it), `launch_not_started`. A result with NO `determinism` block after you sent a pin means the engine predates the params — the tool says "not applied"; the run is NOT reproducible and you may not claim it is.
- A `RunVerification` probe pins the same two flags on its own instance; `summer_play` pins are for the embedded game you then read through `summer_get_runtime_tree` / `summer_inspect_runtime_node`.

## "Looks right" vs "is right"

A common failure mode: the feature visually looks correct on first try, you stop there, ship it, and a deeper bug surfaces later.

**Looks right** means the rendered frame matches expectations.

**Is right** means the rendered frame matches expectations AND the underlying state is consistent AND it survives repetition AND no errors are silently logged.

The debugger and the console catch "looks right but isn't right" cases — runtime errors that did not crash the game (debugger), deprecation warnings and signal misfires (console). **Always read `summer_get_diagnostics` after a playthrough, even when the visuals looked fine — and never let a clean `summer_get_console` stand in for it: the console does not receive a played game's runtime errors.**

## When to record video vs when console+diagnostics is enough

Your probe already produces the visual record: `save_frame()` writes a real rendered JPEG at each step, and a sequence of them across a movement is a flipbook of the feature happening. **You are not the only one who cannot see the game — until you save frames, nobody can.** Save them at the interesting moments and read them back.

Ask the user for a video or a live look only when:

- The feature **feels wrong** — see `debugging-game-feel`. Frame counts and console output cannot capture "the jump feels floaty."
- The bug is **non-deterministic** and your probe cannot reproduce it after several attempts.
- The judgement is aesthetic — see [What only a human can answer](#what-only-a-human-can-answer).

Don't ask reflexively. A saved frame sequence answers most "did it visually work" questions without involving the user at all.

## Red Flags — STOP

| Red flag | Reality |
|---|---|
| "Compiles clean, shipping it" | Compiling is not playing. Press play. |
| "Diagnostics returned 0 errors after boot" | Boot is not play. The feature has not fired yet. |
| "User said make this — I'll move on once it builds" | The user wants the feature to work, not to build. |
| "It would take too long to play" | Playtest takes 60 seconds. Shipping a broken feature costs hours. |
| "The unit test passes" | Unit tests cover code paths, not gameplay sequences. |
| "I already played it in a previous session" | State changed. Verify in this session. |
| "I'll let the user catch any issues" | That is the user's job description for a non-AI engineer. Yours is to ship working features. |
| Skipping `summer_clear_console` before `summer_play` | You will chase last session's errors. |
| Sleeping a fixed delay after `summer_play` | Boot time varies. Wait for `play.started` with `summer_wait_for_event`, or confirm with `summer_is_running`. |
| Skipping `summer_get_console` because diagnostics looked fine | Silent warnings and signal misfires hide there. |
| Calling `summer_get_console` alone as the post-play check | It never receives a played game's runtime errors; `errors 0` there proves nothing. Read `summer_get_diagnostics` / `summer_get_debugger_errors`. |
| "The MCP can't simulate input, so the user has to test it" | False. `RunVerification` presses actions and keys. Write the probe. |
| "I'll ask the user to press jump and tell me what happened" | You can press jump. They should not have to QA your work. |
| Probe returned `finished: false`, you called it a pass | It hit `max_seconds` before `finish()`. That is a failure. |
| Asserting `position.x == 250.0` in a probe | Hold time is wall-clock. Assert `> start.x + 50`. |
| `press("jump", 50)` without `await` | It is a coroutine. The key is never released. |
| "I sent seed:42, so the run is reproducible" | Only if `determinism.applied` is true. An older engine ignores the pin and the tool says "not applied"; `seed` never pins `RandomNumberGenerator` instances or `randomize()` calls. |

## Rationalization Prevention

| Excuse | Reality |
|---|---|
| "Static checks are enough for this feature" | If it has any runtime behavior, no. |
| "The feature is too small to playtest" | Two lines of code can break a state machine. Play it. |
| "I'll batch the playtest with the next feature" | Bugs compound. Play each feature individually. |
| "User is in a hurry" | Shipping broken features is the slowest path. |
| "The repro is hard to set up" | That is a sign the feature has insufficient instrumentation. Add it, then play. |

## When the engine isn't running

`RunVerification` is dispatched by the editor, so it needs the editor running. **The verify instance itself does not.** You can spawn exactly the same probe runtime straight from your shell, with no editor at all:

```bash
/Applications/Summer.app/Contents/MacOS/Summer \
  --path <project-dir> \
  --summer-verify <abs-path-to-probe.gd> \
  --summer-verify-out <abs-out-dir> \
  --summer-verify-max 30
```

Then read `<out-dir>/results.json` and the JPEGs beside it. The probe must extend the base class — copy `summer_probe_base.gd` into the project and `extends "res://summer_probe_base.gd"`, or use the project's `tests/autopilot/` scaffold if it has one. See `headless-scripting` for the full pattern and its traps.

So if `summer_play` returns "Summer Engine is not running":

1. Run the probe directly from the shell as above. That is a real playtest.
2. Only if that is also impossible: tell the user `summer run` to start the editor, and say plainly "code compiles and looks correct, but I have not played it" — do not claim verification from static analysis alone.
3. When the engine comes back, run the loop.

## The Bottom Line

A game feature is a promise to the player. Verifying it means seeing the promise kept on screen, not seeing the code that would, in theory, keep it.

Press play. Walk the path. Probe the edges. Read the diagnostics. Then claim done.

**Related skills:**
- `verification-before-completion` — the code-layer verification this skill builds on.
- `debug` — when the playtest surfaces a crash or error.
- `investigating-bugs` — when the playtest surfaces a reproducible logical bug.
- `debugging-game-feel` — when the feature works but feels wrong.
