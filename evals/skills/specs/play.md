---
spec: eval/skill-spec/play
skill: skill/play
status: ported
source: tests/specs/play.md
runner: manual   # /skill-test today; automated harness is a fast-follow (ROADMAP §3.4)
---

# Skill Spec: /play

## Fixture

- A Summer project with a main scene set in `project.godot`.
- Summer Engine running, MCP available.

## Case 1: Happy Path — clean run

**Fixture:** Project compiles cleanly. Game is not currently running.

**Input:** "Play."

**Expected MCP tool sequence (in order):**

1. `summer_is_running` — false
2. `summer_get_script_errors` — clean
3. `summer_clear_console`
4. `summer_play`
5. (~2 second wait)
6. `summer_get_diagnostics`
7. `summer_get_debugger_errors`
8. (Skill reports "Running. No errors or warnings.")

**Assertions:**

- [ ] First call is `summer_is_running` to avoid double-launch.
- [ ] `summer_get_script_errors` runs BEFORE `summer_play` (avoid noisy fail).
- [ ] `summer_clear_console` runs before `summer_play` (so post-run output is clean).
- [ ] Skill waits before reading post-play state (≥1 second).
- [ ] Skill does NOT call `summer_stop` on its own.
- [ ] Skill reports state in one short sentence, doesn't dump raw tool output.

## Case 2: Failure — game is already running

**Fixture:** Game already running.

**Input:** "Play."

**Expected behavior:**

- `summer_is_running` returns true.
- Skill asks: "It's already playing. Stop and restart, or leave it?"
- Waits for user.
- On "leave it": no further calls. On "stop and restart": `summer_stop`, then continues from step 2.

**Assertions:**

- [ ] Skill does not unilaterally restart.
- [ ] Skill does not unilaterally `summer_stop` without asking.

## Case 3: Compile error before play

**Fixture:** Script error in `scripts/player.gd:14` (typo). Game not running.

**Input:** "Play."

**Expected behavior:**

- `summer_is_running` → false.
- `summer_get_script_errors` → returns error.
- Skill stops, surfaces the error, suggests `/debug`.
- Does NOT call `summer_play` (would just produce more noise).

**Assertions:**

- [ ] No `summer_play` call when script errors are present.
- [ ] Error message is one line, not raw tool output.
- [ ] Skill explicitly mentions `/debug` as the next move.

## Case 4: Runtime crash

**Fixture:** Compiles fine. Game crashes on first frame (e.g. null pointer in `_ready`).

**Input:** "Play."

**Expected behavior:**

- Steps 1–5 run normally.
- `summer_get_debugger_errors` returns a stack trace.
- Skill reports the crash in one line and offers `/debug`.
- Does NOT auto-`summer_stop` — the user might want to inspect.

**Assertions:**

- [ ] Skill detects the crash via `summer_get_debugger_errors`, not by absence of output.
- [ ] Crash report is concise: error class, location, message.
- [ ] Skill explicitly mentions `/debug` as the next move.
