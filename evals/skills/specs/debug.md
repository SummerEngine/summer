---
spec: eval/skill-spec/debug
skill: skill/debug
status: ported
source: tests/specs/debug.md
runner: manual   # /skill-test today; automated harness is a fast-follow (ROADMAP §3.4)
---

# Skill Spec: /debug

## Fixture

- A Summer project with one or more reproducible bugs.
- Summer Engine running, MCP available.
- Host file tools available (Read, Edit, Write).

## Case 1: Happy Path — runtime error with clear stack trace

**Fixture:** `scripts/player.gd` has `velocity.y -= GRAVTY * delta` (typo: GRAVTY instead of GRAVITY). Player crashes on `_physics_process` first frame.

**Input:** "Debug my game. The player crashes the moment I press play."

**Expected MCP tool sequence (in order):**

1. (Skill asks the user one clarifying question and waits.)
2. `summer_get_script_errors` — finds `Identifier "GRAVTY" not declared` at scripts/player.gd:14
3. (Optional: `summer_get_console` to confirm no other errors hiding)
4. `Read scripts/player.gd` — read 20–40 lines around line 14
5. (Skill states hypothesis: typo, GRAVTY → GRAVITY)
6. (Skill asks: "May I edit `scripts/player.gd` to rename GRAVTY → GRAVITY?")
7. `Edit scripts/player.gd` — apply fix on user OK
8. `summer_get_script_errors` — verify clean

**Assertions:**

- [ ] Skill asks for the user's description before any tool call.
- [ ] First diagnostic tool called is `summer_get_script_errors` (cheapest).
- [ ] Skill does NOT grep the whole codebase before reading the error.
- [ ] Skill reads only the file + lines indicated by the error, not the whole file.
- [ ] Skill states a single specific hypothesis before proposing a fix.
- [ ] Skill asks "May I edit …" before writing.
- [ ] After the fix, skill re-runs `summer_get_script_errors` to verify.
- [ ] Skill never calls `summer_set_resource_property` on an inline sub-resource (silent-fail trap).

## Case 2: Failure Path — bug only reproduces at runtime

**Fixture:** Game compiles fine but crashes when player picks up a coin: `Invalid call. Nonexistent function 'play' in base 'Nil'.` AudioStreamPlayer node was deleted in editor but pickup script still references it.

**Input:** "When I pick up a coin, the game crashes."

**Expected behavior:**

- Skill calls `summer_get_script_errors` first → clean.
- Skill realizes it's runtime: `summer_clear_console`, `summer_play`.
- Skill asks user: "Reproduce the bug now — pick up a coin."
- After confirmation, calls `summer_get_debugger_errors`.
- Stack trace points to `coin.gd:32`, function `_on_body_entered`, calling `audio.play()` where `audio` is `null`.
- Skill calls `summer_inspect_node "./Coin/AudioStreamPlayer"` to confirm the node is missing.
- Skill proposes: re-add the AudioStreamPlayer (via `summer_add_node`) OR null-check in code.
- Asks the user which.

**Assertions:**

- [ ] Skill recognizes that script-errors-clean + crash-on-runtime = runtime-only bug.
- [ ] Skill explicitly invokes the play→reproduce→read-debugger loop, not just one shot.
- [ ] Skill verifies the missing-node hypothesis with `summer_inspect_node` BEFORE editing code.
- [ ] Skill offers BOTH options (fix scene OR fix code) instead of unilaterally picking.

## Case 3: Edge Case — user gives a vague description

**Fixture:** Same as Case 1.

**Input:** "Something's broken."

**Expected behavior:**

- Skill asks one focused follow-up: "What's happening, and when?"
- Does NOT start grepping code or running tools blindly.

**Assertions:**

- [ ] No tool calls happen until the user gives a concrete symptom.
- [ ] Skill's follow-up is one short question, not a checklist.

## Case 4: No Summer MCP — fallback path

**Fixture:** Same as Case 1, but Summer MCP is unavailable (engine not connected).

**Input:** "Debug my game."

**Expected behavior:**

- Skill detects MCP unavailable.
- Asks the user to copy-paste from Godot's Output and Debugger panels.
- Reasons over the pasted text the same way it would over MCP output.
- Continues with the rest of the workflow (read code, hypothesize, propose fix).

**Assertions:**

- [ ] Skill does not blindly call `summer_*` tools and fail.
- [ ] Skill explicitly asks for the panel output instead of guessing.
- [ ] The rest of the loop (hypothesis → "May I edit?" → verify) still runs.
