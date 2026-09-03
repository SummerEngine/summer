---
name: agent-playtesting
description: Use when proving a gameplay feature, reproducing a bug, or comparing two variants by driving the LIVE running game yourself — deterministic launch (seed, fixed_fps, offscreen instances), frame-stamped probes before and after every action, exact frame stepping, scripted or recorded input. The doctrine behind summer_game_probe, summer_game_input, summer_game_control and the summer_runtime_* tools.
---

# Agent Playtesting

## Overview

`playtesting-a-feature` says a feature is not done until someone has played it. This skill is how *you* play it — not a hidden probe that dies when it finishes, but the live game, driven one action at a time, with a frame-stamped record of what each action did.

The engine's runtime-control ops make the running game a thing you can see and touch:

| Tool | Does |
|---|---|
| `summer_play` | Start the game. With `instance` + `mode:"offscreen"` a disposable parallel instance; with `seed` / `fixed_fps` (and `deterministic:true` offscreen) a reproducible one. |
| `summer_game_probe` | State AND pixels of ONE frame, atomically: live tree, property reads, screenshot, all stamped with the same frame counters. The evidence tool. |
| `summer_game_control` | `pause`, `resume`, `step` exactly N physics/process frames, `speed`, `instances`. |
| `summer_game_input` | `script` timed synthetic input; `record_start` / `record_stop` real input into `res://.summer/replays/`; `replay` a recording (with `seed` on a deterministic instance). |
| `summer_runtime_set` / `summer_runtime_call` | Set a property / call a method on a live node. Actions, not evidence. |
| `summer_runtime_spawn` | Spawn a PackedScene into, or free a node from, the live game. |
| `summer_runtime_animate` | Read/drive an AnimationPlayer, an AnimationTree state machine, or read Skeleton3D bone poses. |
| `summer_stop` | Stop the main game, or `instance` to stop one offscreen instance. |

Every one of these needs a RUNNING game and answers `game_not_running` otherwise. On an engine build that predates them the result is `engine_lacks_op` naming the fallback — usually the `RunVerification` probe from `playtesting-a-feature`. Record that as the expected outcome, not a failure.

<EXTREMELY-IMPORTANT>
An action is not evidence. `summer_runtime_set` returning `applied: true`, `summer_game_input` returning `completed: true`, `summer_runtime_call` returning a value — each proves the request was honoured, not that the game did what the feature promises. Only a probe of the frame AFTER, compared with a probe of the frame BEFORE, proves motion, spawning, damage, or a state change. Never claim any of those without the two frame numbers.
</EXTREMELY-IMPORTANT>

## The Loop

```
  Launch deterministically → Wait for boot → Probe BEFORE → Act → Step (or run) → Probe AFTER → Assert → Stop
```

### 1. Launch deterministically

Decide before pressing play what the run must pin.

- **Embedded main game** (`summer_play` with no instance): the game the user sees. Add `seed` and `fixed_fps` to pin the RNG and the frame clock — `seed` only applies to a game that is not already running (`determinism.applied: false` with `reason: already_running` means `summer_stop` first).
- **Offscreen instance** (`summer_play {instance:"a", mode:"offscreen"}`): a hidden child process the user never sees, addressed by name on every runtime tool. Up to three at once. `deterministic: true` launches it with `--fixed-fps 60 --summer-seed <seed> --audio-driver Dummy`; this is the only kind of instance on which `summer_game_input action:"replay"` accepts a `seed`.
- **Two variants side by side**: `instance:"before"` and `instance:"after"` (different scenes or different `summer_runtime_set` setups), the same recorded input replayed into each, probes compared frame for frame.

The result's `determinism.seed_scope` tells you what the seed does NOT pin: `RandomNumberGenerator` instances (self-randomized on construction), scripts that call `randomize()`, wall-clock reads, thread timing. A feature that uses any of those is not deterministic under a seed; assert ranges there, or fix the script to use the global RNG.

### 2. Wait for boot — never sleep a guessed delay

Boot time varies. Confirm, do not assume:

- Main game: `summer_is_running` until it reports running.
- Offscreen instance: `summer_game_control action:"instances"` until the instance shows `attached: true`. Before that, every runtime op answers `request_failed` ("session has not attached yet"). `session_timeout` means the child never attached and was killed — read `summer_get_console` for its stderr.

### 3. Probe BEFORE

```
summer_game_probe
  tree: {path: "/root/Main", depth: 2}
  props: ["/root/Main/Player:position", "/root/Main/Player:velocity", "/root/Main/HUD/Health:value"]
```

Write down `frame.process_frames` and `frame.physics_frames`. Every path you will act on comes from this tree — runtime paths are absolute (`/root/Main/Player`) and differ from the edited scene when nodes spawn, rename, or reparent at runtime. Look at the screenshot and say what is in it.

### 4. Act

One action per step, so the AFTER probe attributes cleanly:

- `summer_runtime_set path:"/root/Main/Player" property:"position" value:"Vector3(0, 2, 0)"` — read `applied`. `applied: false` (`not_applied`) means a script rewrote the value the same frame, or the literal type was wrong; do not proceed as if it landed.
- `summer_runtime_call path:"/root/Main/Boss" method:"take_damage" args:[25]` — `return` is what the method answered; the effect still needs the probe.
- `summer_game_input action:"script" events:[{at_frame:0, type:"action", action:"move_right", hold_ms:500}, {at_frame:30, type:"action", action:"jump", hold_ms:50}]` — `rejected[]` names events the game refused (`unknown_action` = not in the InputMap; bind it with `summer_input_map_bind` and restart, or drive `type:"key"`). One script in flight per instance: `busy` means wait for the first.
- `summer_runtime_spawn action:"spawn" parent:"/root/Main/Enemies" scene:"res://enemies/goblin.tscn" props:{position:"Vector3(4, 0, -2)"}` — use the returned `node.path` from here on.

### 5. Step — for exact assertions

When "after 3 physics frames the velocity is zero" is the claim, do not let wall-clock time decide how many frames ran:

```
summer_game_control action:"pause"
summer_game_probe props:[...]                 # frame N
summer_runtime_set ... / summer_game_input ... wait:false
summer_game_control action:"step" frames:3   # kind "physics" (default)
summer_game_probe props:[...]                 # frame N+3 — the step draws its last frame before replying
```

The step result carries `before`, `after`, `exact`, and `overshoot`; cite them. The game stays suspended after a step — `summer_game_control action:"resume"` when you want it to run again. Time-based behaviour (a 500 ms hold, a 2 s cooldown) runs on the game's clock: with `fixed_fps` a step of N frames IS N/fps seconds; without it, use `at_ms` and read `clock_mapping` ("approximate" means the mapping went through the physics tick rate).

A minimized game window draws no frames and cannot step (`timeout`). `game_breaked` means the game sits at a script breakpoint; continue it in the debugger first.

### 6. Probe AFTER, then assert

Same probe as step 3. Compare the two:

- positions, velocities, HUD values — as inequalities (`x > before.x + 50`), never exact equality unless the run is deterministic AND frame-stepped;
- `tree` — the spawned node exists under its parent; the freed one is gone (a `queue_free` takes effect at the end of the frame, so step once before asserting absence);
- the screenshots — look at both and describe the difference in words. A tree that says "goblin spawned" and a frame that shows no goblin is a bug, not a pass.

Then `summer_get_debugger_errors` — a feature that "worked" while logging null-reference errors did not work.

### 7. Stop

`summer_stop` (main) or `summer_stop instance:"a"` for each offscreen instance you started. Offscreen children also die when the editor exits, but do not leave them for the user to discover.

## Input scripts vs. recordings

| | `action:"script"` | `record_start` / `record_stop` / `replay` |
|---|---|---|
| Source | You write it from the spec | Whatever actually happened — a human's hands or a script's output |
| Readable | Yes; edit a frame number and re-run | A JSON file of events; treat it as an artifact |
| Timing | `at_frame` exact; `at_ms` exact only with `fixed_fps` | Recorded frames re-based on the first event |
| Best for | Golden paths, edge probes, regression checks | "Do exactly what the user did", A/B of two builds under identical input |
| Reproducible | With `seed` + `fixed_fps` on the instance | With `seed` on a `deterministic:true` offscreen instance (`replay` refuses `seed` elsewhere: `nondeterministic_instance`) |

Recording caps at 20,000 events / about 1 MiB (`truncated: true` when hit). Files land in `res://.summer/replays/<id>.json`; pass that exact path to `replay`. A waited script or replay is capped at 20 s by the engine — for longer sequences pass `wait:false` and follow along with probes.

## What seed does not pin

Read `determinism.seed_scope` on the play result and believe it. Pinned: the global RNG (`randi`, `randf`, `randi_range`, `randf_range`, `randfn`, `Array.shuffle`, `Array.pick_random`), re-seeded after `SceneTree` init and before autoloads and the main scene. Not pinned: `RandomNumberGenerator` instances, scripts calling `randomize()`, wall-clock reads (`Time.get_ticks_msec` used as a source of variation), thread timing, and anything read from the network or the file system. When a replay diverges on a deterministic instance, one of these is the reason — find it in the script before doubting the tooling.

## Honesty rules

- **Cite frames.** "At frame 1834 the player was at x=12.0; after `move_right` for 30 frames, at frame 1864 x=57.3" is a verification. "The player moved" is not.
- **`applied: false` is a no.** Do not narrate a value change the read-back denied.
- **`completed: false` is a no.** The script did not finish inside the wait; probe to see how far it got, do not call it done.
- **`rejected[]` is part of the result.** Report the rejected events and why, even when the rest applied.
- **`engine_lacks_op` is the expected outcome on an engine without these ops.** Say so, fall back to the `playtesting-a-feature` probe loop, and do not describe a runtime playtest you could not run.
- **A screenshot you did not look at is not a screenshot.** Describe what is in it.
- **Parallel instances are not the user's game.** Findings from `instance:"a"` describe that instance's launch (scene, seed, fixed_fps); say which instance a claim came from.
- **Do not hand the walkthrough to the user** while any of these tools works. Ask a human only for what a probe cannot judge — feel, beauty, fun (`debugging-game-feel`).

## Red flags — STOP

| Red flag | Reality |
|---|---|
| Asserting motion from a `summer_runtime_set` result | applied means the write landed; probe to see the motion |
| One probe, then "it works" | One frame proves a state, not a change; two frames prove a change |
| Sleeping a fixed delay after `summer_play` | Boot varies; `summer_is_running` / `instances` `attached:true` |
| `position.x == 250.0` on a non-deterministic run | Assert inequality, or pin the run with `fixed_fps` + steps |
| Ignoring `rejected[]` because `applied > 0` | The rejected event may be the one the feature needed |
| `seed` on the embedded game called "deterministic" | It pins the global RNG only; `deterministic:true` needs an offscreen instance |
| Leaving offscreen instances running | Stop each one you started |

## Related skills

- `playtesting-a-feature` — the iron law (no shipped claim without a played walkthrough) and the `RunVerification` probe loop this skill replaces when the runtime tools exist.
- `verifying-scenes` — evidence discipline for the EDITED scene (snapshot, diff, screenshot).
- `verification-before-completion` — the code layer that must be green before any of this.
- `debugging-game-feel` — when the feature works but feels wrong.
- `investigating-bugs` — root-causing a reproducible bug once a recording reproduces it.
