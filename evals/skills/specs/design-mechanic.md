---
spec: eval/skill-spec/design-mechanic
skill: skill/design-mechanic
status: ported
source: tests/specs/design-mechanic.md
runner: manual   # /skill-test today; automated harness is a fast-follow (ROADMAP §3.4)
---

# Skill Spec: /design-mechanic

## Fixture

- Summer Engine project with `World/Player` (CharacterBody3D + CollisionShape3D + Camera3D) already in the main scene.
- A `scripts/player_controller.gd` exists with single-jump logic.
- `.summer/GameSoul.md` exists, brief says: "core loop is precise platforming, three mechanics: dash, double-jump, parry".
- Summer MCP available.

## Case 1: Happy Path — design double-jump

**Input:** "Design the double-jump mechanic."

**Expected MCP tool sequence (in order):**

1. (Skill asks one clarifying question if any — e.g., "Tap or hold-and-release?" — and waits.)
2. `Read .summer/GameSoul.md` — anchor to the brief
3. (Skill walks the five layers: input, response, feedback (visual/audio/mechanical), failure modes, depth)
4. (Skill names tunables as `@export` vars)
5. (Skill sketches the node-graph plan and asks "May I add `DoubleJumpFX` and `JumpAudio` to `./World/Player`?")
6. `summer_get_scene_tree` — confirm Player exists
7. `summer_add_node(parent="./World/Player", type="GPUParticles3D", name="DoubleJumpFX")`
8. `summer_set_prop("./World/Player/DoubleJumpFX", "emitting", "false")`
9. `summer_add_node(parent="./World/Player", type="AudioStreamPlayer3D", name="JumpAudio")`
10. `summer_input_map_bind(name="jump", events=[{type:"key", key:"Space"}])` (idempotent)
11. (Skill asks "May I modify `scripts/player_controller.gd` to add double-jump logic?")
12. `Edit scripts/player_controller.gd` — merge double-jump logic
13. (Skill asks "May I create `.summer/mechanics/double-jump.md` with the design doc?")
14. `Write .summer/mechanics/double-jump.md`
15. `summer_save_scene`
16. `summer_get_script_errors`

**Assertions:**

- [ ] Skill reads `.summer/GameSoul.md` to anchor the design to the brief.
- [ ] Skill walks all five layers (input, response, feedback, failure modes, depth) before scaffolding.
- [ ] Skill enforces all THREE feedback channels (visual, audio, mechanical) — pushes back if user only names two.
- [ ] Skill lists 3-7 tunables as `@export` vars (not `const`).
- [ ] Skill asks "May I add ..." before scene mutations.
- [ ] Skill asks "May I modify ..." before script edits.
- [ ] Skill writes the design doc to `.summer/mechanics/<name>.md`.
- [ ] Skill never calls `summer_set_resource_property` on an inline sub_resource (silent-fail trap).
- [ ] Generated GDScript uses typed vars, `@export`, `class_name`, `@onready`, signals (matches `library/references/gd-style/gd-style.md`).
- [ ] Final step is `summer_save_scene` then `summer_get_script_errors`.

## Case 2: Failure Path — user names a system, not a mechanic

**Fixture:** Same as Case 1.

**Input:** "Design the inventory."

**Expected behavior:**

- Skill recognizes "inventory" is a system, not a mechanic.
- Skill pushes back: "Inventory is a system. The mechanics inside it are pickup, equip, drop, use, swap. Which one?"
- Does NOT start designing a generic "inventory mechanic".
- Waits for the user to pick a verb.

**Assertions:**

- [ ] Skill explicitly distinguishes system vs. mechanic.
- [ ] Skill asks the user to pick a verb before walking the five layers.
- [ ] No scene mutations or file writes happen until the user picks.

## Case 3: Edge Case — user can't articulate depth

**Fixture:** Same as Case 1.

**Input:** "Design the double-jump."

**During step 3, on Layer 5 (depth):**

User says: "Players will use it strategically."

**Expected behavior:**

- Skill rejects the hand-wave: "That's not depth — name the choice the player makes."
- Skill offers a concrete frame: "Depth = the resource is finite or has a cost, and level design forces a choice between using it now or saving it. If neither is true, this is just a higher-jumping single-jump."
- Skill asks the user to either (a) name the cost / choice, or (b) cut the mechanic.
- Skill does NOT scaffold a depth-less mechanic.

**Assertions:**

- [ ] Skill does not accept "strategically" / "for skilled play" / "it's interesting" as depth.
- [ ] Skill names a concrete depth-vector (cost, resource, choice).
- [ ] Skill explicitly offers "cut the mechanic" as a valid outcome.
- [ ] No scaffolding happens until depth is articulated.

## Case 4: No Summer MCP — file-edit fallback

**Fixture:** Same as Case 1, but Summer MCP is unavailable (engine not connected).

**Input:** "Design the double-jump mechanic."

**Expected behavior:**

- Skill detects no MCP and falls back to file edits.
- Walks the five layers normally.
- Instead of `summer_add_node`, prints the `.tscn` snippet for `DoubleJumpFX` and `JumpAudio` nodes for the user to paste into the scene file (or asks the user which `.tscn` to edit).
- Asks before each file write.
- Still writes the GDScript stub via `Edit` and the design doc via `Write`.

**Assertions:**

- [ ] Skill identifies that MCP is unavailable; does not blindly call `summer_*` tools.
- [ ] Generated `.tscn` snippet is syntactically valid Godot 4 scene format.
- [ ] Skill still asks "May I write ..." before each file write.
- [ ] Skill still produces both the GDScript stub AND the design doc at `.summer/mechanics/<name>.md`.

---

This spec runs via `/skill-test design-mechanic spec` (see `workflow/skill-test/SKILL.md`).
