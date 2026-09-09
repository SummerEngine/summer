# Skill Spec: /fps-controller

## Fixture

- Empty Summer Engine project, main scene open with a single `World` (Node3D) root.
- Summer MCP tools available (engine running on localhost:6550).
- No existing input actions in InputMap beyond Godot defaults.
- No script files attached.

## Case 1: Happy Path — fresh FPS in an empty scene

**Input:** "Add a first-person controller to my scene."

**Expected MCP tool sequence (in order):**

1. `summer_get_scene_tree` — verify empty World exists.
2. `summer_add_node(parent="./World", type="CharacterBody3D", name="Player")`
3. `summer_add_node(parent="./World/Player", type="CollisionShape3D", name="Collision")`
4. `summer_set_prop("./World/Player/Collision", "shape", "CapsuleShape3D")` (creates standalone, NOT inline sub-resource)
5. `summer_set_resource_property("./World/Player/Collision", "shape", "radius", "0.4")`
6. `summer_set_resource_property("./World/Player/Collision", "shape", "height", "1.8")`
7. `summer_add_node(parent="./World/Player", type="Node3D", name="Head")`
8. `summer_set_prop("./World/Player/Head", "position", "Vector3(0, 1.6, 0)")`
9. `summer_add_node(parent="./World/Player/Head", type="Camera3D", name="Camera")`
10. `summer_input_map_bind(name="move_forward", events=[{type:"key", key:"W"}])`
11. `summer_input_map_bind(name="move_back",    events=[{type:"key", key:"S"}])`
12. `summer_input_map_bind(name="move_left",    events=[{type:"key", key:"A"}])`
13. `summer_input_map_bind(name="move_right",   events=[{type:"key", key:"D"}])`
14. `summer_input_map_bind(name="jump",         events=[{type:"key", key:"Space"}])`
15. `summer_input_map_bind(name="sprint",       events=[{type:"key", key:"Shift"}])`
16. (User-side write) `Write` script file `scripts/player_controller.gd` after the agent asks "May I create the controller script and attach it to ./World/Player?"
17. `summer_save_scene`
18. `summer_get_script_errors`

**Assertions:**

- [ ] CharacterBody3D node exists at `./World/Player`.
- [ ] CollisionShape3D is a child of Player with a CapsuleShape3D (NOT BoxShape, NOT SphereShape).
- [ ] A `Head` Node3D pivots at `y ≈ 1.6` and contains the Camera3D as a child (yaw on body, pitch on head — never both on the body).
- [ ] All 6 input actions bound: `move_forward`, `move_back`, `move_left`, `move_right`, `jump`, `sprint`.
- [ ] Skill asks "May I create / attach …" before the script write.
- [ ] Skill never calls `summer_set_resource_property` on an inline `sub_resource` (the silent-fail trap from `library/references/mcp-tools-reference/mcp-tools-reference.md`).
- [ ] Final step is `summer_save_scene` followed by `summer_get_script_errors`.
- [ ] Script uses typed GDScript per `library/references/gd-style/gd-style.md` (`@export`, `:=`, `class_name`).
- [ ] Script defines `coyote_time` and `jump_buffer_time` as `@export` floats with sensible defaults (0.05–0.2).
- [ ] Script defines separate `ground_accel`, `ground_friction`, `air_accel`, `air_friction` exports — NOT a single `move_speed` snap-to-target.
- [ ] Script implements `air_accel < ground_accel` (reduced air control, not zero, not full).
- [ ] Script defines an `external_velocity: Vector3` accumulator AND a public `add_external_velocity(impulse: Vector3)` method.
- [ ] Script subtracts the previous frame's external contribution at the top of `_physics_process` BEFORE applying gravity (prevents knockback compounding).
- [ ] Script uses `move_toward` for horizontal acceleration/deceleration — not `velocity.x = direction.x * speed` snap.
- [ ] Script applies asymmetric gravity (`fall_gravity_multiplier` when `velocity.y < 0`).
- [ ] Mouse look pitches `Head`, not `Player`. Pitch is clamped to `[pitch_min, pitch_max]`.
- [ ] `Input.mouse_mode = Input.MOUSE_MODE_CAPTURED` set in `_ready`.

## Case 2: Failure Path — existing PlayerOld in scene

**Fixture:** Same as Case 1, but `World/PlayerOld` exists with a CharacterBody3D + collision (manually authored).

**Input:** "Add a first-person controller to my scene."

**Expected behavior:**

- Skill detects the name collision via `summer_get_scene_tree`.
- Skill asks: "I see `World/PlayerOld` already exists. Should I replace it, add a second player as `Player2`, or something else?"
- Does NOT silently overwrite.

**Assertions:**

- [ ] Skill calls `summer_get_scene_tree` before any mutation.
- [ ] Skill asks the user how to handle the collision before adding any node.
- [ ] No `summer_add_node` calls happen until the user answers.

## Case 3: Edge Case — user says "third-person"

**Fixture:** Empty Summer project, main scene with `World` only.

**Input:** "Build a third-person FPS controller."

**Expected behavior:**

- Skill clarifies the contradiction: FPS = first-person; third-person ≠ FPS.
- Either asks the user which they meant, OR hands off to `/tps-controller` (when that skill ships) and explains the difference.

**Assertions:**

- [ ] Skill does NOT silently start building a third-person controller using FPS scaffolding.
- [ ] Skill explicitly names the ambiguity ("FPS means first-person; third-person is a separate skill").
- [ ] Skill offers a clear next step: clarify or use the right skill.

## Case 4: No Summer MCP — file-edit fallback path

**Fixture:** Same as Case 1 except Summer MCP is NOT available (running in plain Cursor on a project where the engine is not connected).

**Input:** "Add a first-person controller to my scene."

**Expected behavior:**

- Skill detects no MCP and falls back to direct file edits on `level.tscn` (or whatever main scene exists).
- Writes a `.tscn` snippet with CharacterBody3D + CollisionShape3D + Head Node3D + Camera3D following the format in the skill's "Fallback (no MCP)" section.
- Writes `scripts/player_controller.gd` directly via host file-write tools — same skeleton as the MCP path (coyote + buffer + air-accel + external-velocity + move_toward).
- Edits `project.godot` to add the InputMap actions (all 6: WASD + jump + sprint).

**Assertions:**

- [ ] Skill identifies that MCP is unavailable (does not blindly call `summer_*` tools and fail).
- [ ] Generated `.tscn` is syntactically valid Godot 4 scene format (parseable by Godot, includes `[gd_scene ... format=3]` header and a CapsuleShape3D sub-resource with `radius` and `height`).
- [ ] Generated `project.godot` patch follows Godot's input action format (`input/move_forward = { "deadzone": ..., "events": [...] }`).
- [ ] Generated script still includes coyote_time, jump_buffer_time, external_velocity, move_toward acceleration model (the fallback path is NOT a downgraded skeleton).
- [ ] Skill still asks "May I write …" before each file write.

---

This spec runs via `/skill-test fps-controller spec` (see `workflow/skill-test/SKILL.md`).
