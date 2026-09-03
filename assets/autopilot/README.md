# tests/autopilot

A starting point for proving your game actually works — not that it compiles, that it *works*.

`autopilot.gd` boots your game in an invisible instance, finds the player, presses your real input actions to walk it through a list of waypoints, saves a rendered frame at each one, records what it found, and exits. It is ordinary GDScript against your real running game. There is no test framework here to learn.

## Run it

```bash
bash tests/autopilot/run.sh
```

No editor needed. Two things happen:

1. **First run only: asset import.** A never-opened checkout has no `.godot/` caches, so the engine's standard editor import runs once, headless, to build them (imported textures/fonts/audio/models, `uid_cache.bin`, `global_script_class_cache.cfg`). Without this the game boots into hundreds of `Unable to open file …ctex` / `invalid UID` / `Could not find type` errors that are not bugs in your game. Output goes to `tests/autopilot/out/import.log`; the pass is skipped once `.godot/global_script_class_cache.cfg` exists; `bash tests/autopilot/run.sh --reimport` forces it. Bounded by `IMPORT_MAX_SECONDS` (default 300).
2. **The verify run.** The probe runs in the engine's offscreen verify instance and `run.sh` reads `results.json`.

Exit code is 0 when the probe finished, every configured waypoint was reached, and the engine logged no `ERROR` / `SCRIPT ERROR`. Engine `WARNING`s are printed and counted but do not fail the run. The last line is the verdict: `PASSED: …` or `FAILED: …`.

Results land in `tests/autopilot/out/`:

```
results.json     reports, frame list, errors_seen, duration_ms, finished
00_start.jpg     a real rendered frame, one per step
engine.log       full engine output of the verify run
import.log       the asset import, when it ran
```

An agent can also run the same probe through MCP without touching your editor:

```
summer_batch ops:[{"op": "RunVerification",
                   "probe_source": "<contents of autopilot.gd>",
                   "max_seconds": 40}]
```

## What the shipped probe does

Out of the box `WAYPOINTS` is empty, so the run is a **smoke test**: boot, find the player, let the game run for a second, save two frames, pass when the engine logged no errors (`reports.smoke: true`). That already catches a project that does not boot, a main scene that fails to load, and every script that fails to parse.

The player is `PLAYER_PATH` when that path exists under the current scene; otherwise the probe auto-detects it — the first `CharacterBody2D`/`3D`, then the first `RigidBody2D`/`3D`, then any `Node2D`/`Node3D` whose name contains "player" — and reports `player_found_by` and the exact `player_path` it used, so the next edit to CONFIG is a paste. A workspace scene with no player still passes the smoke test (`player_found_by: "none"`); it only fails when waypoints are configured and there is nothing to drive.

## Make it yours

Open `autopilot.gd` and edit the `CONFIG` block at the top: the player's node path, your Input Map action names, and the waypoints to walk (2D in pixels, 3D in metres on x/z). Then put your real assertions in `_check_at_waypoint()` and `_check_at_end()` — the shipped version boots, walks and looks, but asserts nothing about *your* game, and a test that asserts nothing always passes.

Leave `ACT_UP` / `ACT_DOWN` empty for a side-on platformer. The autopilot then measures arrival on X alone, because in a side-scroller Y is gravity, not a destination.

## Rules that will bite you otherwise

**Assert inequalities, not exact numbers.** `position.x > start.x + 50` is a real assertion. `position.x == 250.0` is a flaky test you wrote yourself — hold durations resolve on the wall clock, so the same walk lands a few pixels apart between runs.

**Wait on `physics_frame`, not timers.** `await get_tree().physics_frame` is reproducible; `await get_tree().create_timer(1.0).timeout` is not.

**The global RNG is not seeded.** Anything downstream of `randf()` differs every run. Assert ranges, or seed it yourself at the top of the probe.

**`finished: false` is a failure.** It means the probe hit `--summer-verify-max` before calling `finish()`. `run.sh` exits non-zero on it; do not read the partial reports as a pass.

**Warnings are still worth reading.** An `invalid UID … using text path instead` warning means a scene's `uid://` does not match the resource's `.import`/`.uid` file; the load still works, and one day it will not.

**Never add `--headless` to the verify run.** Headless has no renderer: `save_frame()` gets a null image, and `draw_calls` reads 0.0 forever. The verify instance is windowed but positioned off-screen, which is why it can produce real frames and stay invisible. (The import pre-pass is headless on purpose: it needs no pixels.)

## Frames are the point

A saved frame sequence is a flipbook of your feature happening. It is the difference between "the code path executed" and "the thing the player was promised appeared on screen". Save one wherever you would otherwise have asked a human to look.
