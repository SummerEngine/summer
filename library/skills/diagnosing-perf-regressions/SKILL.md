---
name: diagnosing-perf-regressions
description: Use when frame rate, frame time, or load time has gotten worse since a known-good state — "it used to run at 60, now it's at 30." Focused on finding the cause of a regression, not general performance tuning.
---

# Diagnosing Performance Regressions

## Overview

There is a difference between "this game is slow" and "this game got slow." This skill is for the second one.

**Core principle:** A regression has a cause. The cause is a specific change. Bisect to find the change, then root-cause from there.

This skill is **not** general performance tuning. If the game has always run at 30fps and you want to push it to 60, that is `tune-performance` (the domain skill for budget-driven optimization). This skill is the diagnostic — what broke, where, when.

## When To Use

- "It used to run at 60fps, now it's at 30."
- "Load time was 3s yesterday, now it's 15s."
- "Frame stutters started after I added X."
- "Build went from buttery to choppy and I don't know why."

## When NOT To Use

- "The game has always been slow, help me speed it up." → `tune-performance`.
- "I want to know if my game is fast enough to ship." → `tune-performance`.
- "The game crashes." → `debug`.

## The Iron Law

```
NO PERF FIX WITHOUT A KNOWN-GOOD vs KNOWN-BAD MEASUREMENT
```

You cannot fix a regression you have not measured. Eyeballing "feels laggy" is not a measurement. Get a number for the good state and a number for the bad state before touching code.

## The Loop

```
  Measure now → Find last good → Bisect changes → Match to a cliff → A/B fix → Re-measure
```

### 1. Measure now

Measure in a `RunVerification` probe, not by eye. It spawns a hidden, disposable game instance with a real renderer, so `Performance.get_monitor(...)` returns the game's actual numbers and the user's editor session is untouched.

```
summer_batch ops:[{"op":"RunVerification","probe_source":"<probe>","max_seconds":20}]
```

```gdscript
extends SummerProbeBase
func _ready() -> void:
    await super._ready()
    await get_tree().process_frame
    var samples: Array = []
    for i in 30:                                  # ~5 s at 60 fps, sampled over time
        await get_tree().create_timer(0.16).timeout
        samples.append(Performance.get_monitor(Performance.TIME_FPS))
    report("fps_samples", samples)                # spike pattern lives here
    report("draw_calls", Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME))
    report("bodies_3d", Performance.get_monitor(Performance.PHYSICS_3D_ACTIVE_OBJECTS))
    report("objects", Performance.get_monitor(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME))
    dump_tree()
    finish()
```

What to capture:

| Metric | Source | Why |
|---|---|---|
| Avg FPS / frame time | `Performance.TIME_FPS` / `TIME_PROCESS` sampled in the probe | Headline number |
| Spike pattern | the per-sample FPS array above | Steady 30 vs intermittent stutters → different causes |
| Scene complexity | probe `dump_tree()` for the live tree; `summer_get_scene_tree` for the edited scene | Establishes baseline for instance/body count cliffs |

`summer_get_diagnostics` does **not** report performance. It returns counts of console errors, debugger errors, debugger warnings and script errors. Use it to confirm the slow run isn't also throwing, never as a source of FPS or draw-call numbers.

Discard every sample from the first second — `TIME_FPS` is a per-second average and reads exactly `1.0` until it has a second of history. A leading run of `1.0` in the array is warm-up, not a stall.

Write the bad-state number down. "Scene `Level3` runs at 31fps avg, drops to 12fps when 5+ enemies are on screen."

### 2. Find the last known-good state

Ask the user: when did it last run well? Then go to the VCS:

```bash
git log --oneline --since="<last good date>" --until="now"
```

If they can name a commit ("it was fine on Monday's build"), check that out and measure it the same way. You now have:

- Known good: commit X, scene `Level3`, 60fps avg.
- Known bad: HEAD, scene `Level3`, 31fps avg.

If they can't name a date: ask for the rough window, list the commits, ask which ones are likely candidates. Do not bisect blind across 200 commits.

### 3. Bisect the changes

```bash
git log --oneline <last-good>..HEAD
```

Read the list. Group commits into suspects:

| Likely culprit | Why |
|---|---|
| Big asset imports (.glb, textures, audio) | GPU memory, draw-call count |
| New shaders or material changes | Compilation stalls, overdraw, pipeline switches |
| Scene additions (enemies, props, lights) | Physics-body count, instance count, light count |
| `_process` / `_physics_process` additions | CPU per-frame cost |
| Signal connections in tight loops | Hidden per-frame cost |
| Particle systems | GPU + CPU |
| `@tool` scripts running in editor | Misleading editor FPS |
| Resource preload changes | First-use stalls |

If a single commit is the obvious suspect (e.g. "Added 200 enemies to spawner"), test it first. Otherwise actually `git bisect` — check out the midpoint, measure FPS, repeat. Don't theorize through it; the bisect is fast and definitive.

### 4. Match to one of the four Summer Engine performance cliffs

Godot 4.x regressions cluster heavily into four categories. Knowing them shortens diagnosis to minutes.

| Cliff | Symptom | How to verify | Common cause |
|---|---|---|---|
| **Too many physics bodies** | FPS scales inversely with on-screen actor count, no GPU pressure | Count active `CharacterBody`/`RigidBody`/`Area` nodes; FPS doubles when half are queue_freed | Spawner with no upper cap; bullets/particles using physics bodies; collision layers too broad |
| **Shader compilation stalls** | First-frame or first-effect-fire stutter, then smooth; only on shipped builds, not editor | Frame-time spike on first cast/shot; clean after; `OS.has_feature("editor")` differences | New shader added; `unique` material not pre-warmed; pipeline cache not built |
| **GPU instance count / draw calls** | Steady low FPS, scales with what's on screen, no CPU pressure | RenderingServer perf monitors show high draw call count; FPS recovers when camera looks away | Forgot to enable MultiMeshInstance; unique materials per instance breaking instancing; too-detailed LOD0 |
| **Transparent overdraw** | FPS tanks when looking at smoke, fire, foliage, glass — fine otherwise | Look at the offending region, FPS drops; look away, recovers | New particle effect with large quads; transparent UI over the viewport; fog/volumetrics |

If the bad-state symptom matches one row, you have your hypothesis. Verify by reverting just the change you suspect and re-measuring.

### 5. A/B with one variable

This is the most violated step. Discipline:

- **Revert one suspect commit** (or stub the suspect feature behind a flag).
- Rebuild / reload the scene.
- Measure FPS the same way you did in step 1.
- Compare to known-bad. Did it recover?

If yes → root cause confirmed. Now decide: fix the change, or accept the perf cost.
If no → that wasn't it. Restore. Try the next suspect.

**Never** revert multiple changes at once during diagnosis. You will not know which one was the cause, and the bug will return on the next merge.

### 6. Re-measure after the fix

The fix is not done until the same measurement that found the regression returns the good number. Same scene, same play duration, same warm-up.

Re-run the identical probe from step 1 — same scene, same sample count, same drive sequence. A number taken a different way is not a comparison.

State the result with the number: "Reverted the per-frame `get_tree().get_nodes_in_group()` call in `enemy_manager.gd`. Level3 back to 58fps avg." Not "should be faster now."

## When To Escalate

| Situation | Go to |
|---|---|
| Regression confirmed and root cause known, but the fix is "make the feature cheaper" rather than "undo the change" | `tune-performance` for the optimization pass |
| The regression turns out to be a crash or error in disguise (the slow path is throwing exceptions in a tight loop) | `debug` |
| The cause is a Godot version change or engine-side regression | Surface to the user; this is not a project-side fix |
| Bisect lands on a commit that touches 40 files | Subdivide the commit: check out the commit, revert subsets, re-measure |

## Red Flags — STOP

| Red flag | Reality |
|---|---|
| "Just optimize the whole scene" | That's tuning, not regression diagnosis. Find what changed first. |
| Reverting 3 commits at once to "see if it helps" | You learn nothing. Revert one. |
| Eyeballing "feels slow" without measuring | You will optimize the wrong thing. Get a number. |
| Skipping the known-good measurement | Without a baseline, you don't know when you're done. |
| Reading the slow scene's code top-to-bottom looking for inefficiency | The regression is in what changed, not in what was already there. |
| Adding caching / pooling / LOD before identifying the cause | These are tuning moves. They can hide the regression instead of fixing it. |
| Trusting editor FPS as ground truth | Editor runs `@tool` scripts, debug overlays, and a different render pipeline. Measure in a `RunVerification` probe or a built binary. |
| Profiling with `--headless` | No renderer: draw calls read `0.0` and the FPS figure is a bare loop rate. The verify instance is windowed-offscreen for exactly this reason. |
| Quoting FPS from `summer_get_diagnostics` | It returns error/warning counts only. That number did not come from where you said it did. |
| "Maybe it's just a Tuesday thing" | Performance does not regress randomly. There is a cause. |

## Rationalization Prevention

| Excuse | Reality |
|---|---|
| "User wants it fixed now, no time to bisect" | Bisect is 5-15 minutes. Blind optimization can burn a day. |
| "The slow commit is obvious, no need to A/B" | The "obvious" cause is wrong ~30% of the time. Verify before fixing. |
| "I'll measure after I fix it" | If you don't have the bad number, you can't prove the fix worked. |
| "It's probably just Godot" | Engine-side regressions exist but are rare. Suspect your project first. |
| "Adding a pool / LOD / cache will help anyway" | Premature optimization on the wrong system is wasted work. |

## When The Engine Isn't Running

If the MCP tools report the engine isn't running:

1. **Get it running.** `summer run` starts it and restores the probe route. That is one command, and it is almost always the right answer — do not degrade to interviewing the user because a tool returned "not running" once.
2. **If you have shell access, you can run a probe without the editor at all.** The same verify instance is a plain flag on the Summer binary:

   ```bash
   "<summer-binary>" --path <project-dir> \
     --summer-verify <abs/path/probe.gd> \
     --summer-verify-out <abs/out-dir> \
     --summer-verify-max 20
   ```

   Then read `<out-dir>/results.json` (`reports`, `frames`, `errors_seen`, `duration_ms`). Locate the binary rather than guessing a path — on macOS it is the executable inside the installed `Summer.app` bundle. The probe file must extend the probe base; when you invoke the binary directly, write the base alongside it and `extends` it by path.
3. Only if neither is possible: ask the user for an in-game perf overlay reading (FPS, frame time, draw call count) and walk the bisect with them — "run on commit X, tell me the FPS; run on commit Y, tell me the FPS."
4. Do not claim a fix is verified from code reading alone.

## The Bottom Line

A regression is a delta. Diagnose the delta, not the codebase.

Measure now. Measure last-good. Bisect what changed. Match to a Godot perf cliff. A/B one variable. Re-measure. Done.

**Related skills:**
- `tune-performance` — for general optimization once the regression is fixed or when no regression exists.
- `investigating-bugs` — when the slow path turns out to be a logic bug (errors in a tight loop).
- `debug` — when the perf issue is actually a crash or freeze.
- `verification-before-completion` — to claim the fix worked, with numbers.
