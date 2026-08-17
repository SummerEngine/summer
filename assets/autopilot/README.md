# tests/autopilot

A starting point for proving your game actually works — not that it compiles, that it *works*.

`autopilot.gd` boots your game in an invisible instance, presses your real input actions to walk the player through a list of waypoints, saves a rendered frame at each one, records what it found, and exits. It is ordinary GDScript against your real running game. There is no test framework here to learn.

## Run it

```bash
bash tests/autopilot/run.sh
```

No editor needed. Exit code is 0 when the probe finished cleanly and the engine logged no errors.

Results land in `tests/autopilot/out/`:

```
results.json     reports, frame list, errors_seen, duration_ms, finished
00_start.jpg     a real rendered frame, one per waypoint
engine.log       full engine output if something went wrong
```

An agent can also run the same probe through MCP without touching your editor:

```
summer_batch ops:[{"op": "RunVerification",
                   "probe_source": "<contents of autopilot.gd>",
                   "max_seconds": 40}]
```

## Make it yours

Open `autopilot.gd` and edit the `CONFIG` block at the top: the player's node path, your Input Map action names, and the waypoints to walk. Then put your real assertions in `_check_at_waypoint()` and `_check_at_end()` — the shipped version walks and looks, but asserts nothing about *your* game, and a test that asserts nothing always passes.

Leave `ACT_UP` / `ACT_DOWN` empty for a side-on platformer. The autopilot then measures arrival on X alone, because in a side-scroller Y is gravity, not a destination.

## Rules that will bite you otherwise

**Assert inequalities, not exact numbers.** `position.x > start.x + 50` is a real assertion. `position.x == 250.0` is a flaky test you wrote yourself — hold durations resolve on the wall clock, so the same walk lands a few pixels apart between runs.

**Wait on `physics_frame`, not timers.** `await get_tree().physics_frame` is reproducible; `await get_tree().create_timer(1.0).timeout` is not.

**The global RNG is not seeded.** Anything downstream of `randf()` differs every run. Assert ranges, or seed it yourself at the top of the probe.

**`finished: false` is a failure.** It means the probe hit `--summer-verify-max` before calling `finish()`. `run.sh` exits non-zero on it; do not read the partial reports as a pass.

**Never add `--headless` to this.** Headless has no renderer: `save_frame()` gets a null image, and `draw_calls` reads 0.0 forever. The verify instance is windowed but positioned off-screen, which is why it can produce real frames and stay invisible.

## Frames are the point

A saved frame sequence is a flipbook of your feature happening. It is the difference between "the code path executed" and "the thing the player was promised appeared on screen". Save one wherever you would otherwise have asked a human to look.
