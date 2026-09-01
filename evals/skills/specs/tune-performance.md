---
spec: eval/skill-spec/tune-performance
skill: skill/tune-performance
status: ported
source: tests/specs/tune-performance.md
runner: manual   # /skill-test today; automated harness is a fast-follow (ROADMAP §3.4)
---

# Skill Spec: /tune-performance

## Fixture

- Summer Engine project with a 3D scene.
- Summer MCP tools available (engine running on localhost:6550).
- Host file tools available (Read, Edit, Write).

## Case 1: Happy Path — rendering hotspot (foliage)

**Fixture:** `World/Foliage` contains 240 individual MeshInstance3D children, all using the same tree mesh. Game runs at ~22 fps, render time ~14 ms / frame.

**Input:** "My game is slow when I look at the forest."

**Expected MCP tool sequence (in order):**

1. (Skill asks one focused question and waits — confirms it's framerate-drops-when-looking-at-X.)
2. `summer_clear_console`
3. `summer_play`
4. (Skill asks user to look at the forest for 5–10 seconds.)
5. `summer_get_diagnostics` — baseline numbers
6. `summer_stop`
7. (Skill identifies render time > 50% frame budget, dominant cost = rendering.)
8. `summer_get_scene_tree` + `summer_inspect_node "./World/Foliage"` — confirms 240 MeshInstance3D children.
9. (Skill states hypothesis: "240 MeshInstance3D = 240 draw calls. MultiMeshInstance3D will drop this to ~1.")
10. (Skill asks: "May I refactor `./World/Foliage` to use a MultiMeshInstance3D? Expected render time: 14 ms → 3–5 ms.")
11. After OK: applies fix, `summer_save_scene`, `summer_clear_console`, `summer_play`, `summer_get_diagnostics`, `summer_stop`.
12. Reports before/after.

**Assertions:**

- [ ] Skill takes a baseline measurement BEFORE proposing a fix.
- [ ] Skill identifies the dominant cost using actual numbers, not a guess.
- [ ] Skill proposes ONE fix, not a bundle of three.
- [ ] Proposal includes an expected metric movement (e.g. "14 ms → 3–5 ms").
- [ ] Skill asks "May I" before mutating.
- [ ] Skill re-measures after applying the fix and reports before/after.
- [ ] Skill never optimizes physics or scripting in this scenario (since rendering was dominant).

## Case 2: Failure Path — wrong subsystem hypothesis

**Fixture:** Game stutters every ~3 seconds. User suspects "lag spikes from too many enemies".

**Input:** "Game stutters every few seconds. I think it's the enemy AI."

**Expected behavior:**

- Skill resists the user's guess and takes a baseline.
- `summer_get_diagnostics` shows: avg frame time fine, but periodic 80 ms spikes.
- `summer_get_console` shows shader-compilation warnings: "Compiling SpatialMaterial #1234".
- Skill identifies: this is shader compile jitter, not AI.
- Skill says: "The spikes correlate with shader compilation, not the AI loop. Fix is a warmup pass on scene load (force-render off-screen to compile materials). Should I add the warmup pass?"

**Assertions:**

- [ ] Skill verifies via diagnostics + console BEFORE accepting the user's hypothesis.
- [ ] Skill names the actual cause (shader compile) explicitly.
- [ ] Skill does NOT optimize AI code that wasn't the cause.
- [ ] Skill proposes a targeted fix (warmup) rather than a generic one.

## Case 3: Edge Case — Summer MCP available but engine not currently running

**Fixture:** Same as Case 1 but the engine is open and idle, not playing.

**Input:** "Why is my game slow?"

**Expected behavior:**

- Skill calls `summer_is_running` → false.
- Skill explains: "I need to play the game and reproduce the slowdown to get real numbers."
- Asks user permission: "May I `summer_play` and ask you to reproduce the slow scenario?"
- After OK: runs the play → reproduce → diagnostics → stop loop.
- Does NOT skip baseline measurement and just guess from reading code.

**Assertions:**

- [ ] Skill checks `summer_is_running` first.
- [ ] Skill asks before invoking `summer_play`.
- [ ] Skill insists on baseline numbers before fixing anything.
- [ ] Skill does NOT skip straight to "let me read your scripts and guess".

## Case 4: No Summer MCP — fallback path

**Fixture:** Same as Case 1, but Summer MCP unavailable.

**Input:** "My forest scene is slow."

**Expected behavior:**

- Skill detects MCP unavailable.
- Asks the user to enable Godot's Monitor panel (`Debug → Monitors`) and paste at minimum: FPS, frame time (ms), draw calls, video/video memory used, physics active objects.
- Reasons over the pasted numbers the same way it would over diagnostics.
- Continues with hypothesis → proposal → "May I edit?" → manual verification (asks the user to re-run and paste new numbers).

**Assertions:**

- [ ] Skill does not blindly call `summer_*` tools and fail.
- [ ] Skill asks for the specific numbers it needs (not a vague "tell me more").
- [ ] Skill still anchors on baseline-first, ONE-fix-at-a-time loop.
- [ ] Skill names the dominant cost from the user-pasted numbers.

---

This spec runs via `/skill-test tune-performance spec` (see `workflow/skill-test/SKILL.md`).
