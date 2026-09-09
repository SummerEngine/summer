---
spec: eval/skill-spec/design-npc
skill: skill/design-npc
status: ported
source: tests/specs/design-npc.md
runner: manual   # /skill-test today; automated harness is a fast-follow (ROADMAP §3.4)
---

# Skill Spec: /design-npc

## Fixture

- Summer Engine project, main scene with `World/Player` (CharacterBody3D in `player` group) and an empty `World/Enemies` parent.
- Summer MCP tools available.
- Host file tools available (Read, Edit, Write).

## Case 1: Happy Path — basic patrol-and-chase enemy with personality + intent

**Input:** "Add a basic enemy that chases the player when it sees them."

**Expected MCP tool sequence (in order):**

1. (Skill asks the archetype question and waits.)
2. User confirms "basic enemy".
3. `summer_get_scene_tree`
4. `summer_inspect_node "./World/Player"` — confirms it's in `player` group
5. (Skill proposes the bundle: scene tree + script + personality knobs + intent enum + action SM + telegraph + loot hook + "May I create?")
6. After user OK:
   - `summer_add_node(parent="./World/Enemies", type="CharacterBody3D", name="Enemy")`
   - `summer_add_node(parent="./World/Enemies/Enemy", type="CollisionShape3D", name="Body")`
   - `summer_add_node(parent="./World/Enemies/Enemy", type="MeshInstance3D", name="Mesh")`
   - `summer_add_node(parent="./World/Enemies/Enemy", type="Area3D", name="Vision")`
   - `summer_add_node(parent="./World/Enemies/Enemy/Vision", type="CollisionShape3D", name="VisionShape")`
   - `summer_add_node(parent="./World/Enemies/Enemy", type="RayCast3D", name="Sight")`
   - (Vision SphereShape3D saved as standalone `.tres`, NOT inline)
   - `summer_set_prop` on Sight: `enabled = true`
   - `Write scripts/enemy_ai.gd`
   - `summer_connect_signal(from="./World/Enemies/Enemy/Vision", signal="body_entered", to="./World/Enemies/Enemy", method="_on_body_entered")`
   - `summer_save_scene`
   - `summer_get_script_errors`

**Assertions:**

- [ ] Skill asks the archetype question before any tool call.
- [ ] Scene has BOTH a Vision Area3D AND a Sight RayCast3D (the two-step perception pattern).
- [ ] Vision shape is saved as a standalone `.tres`, NOT inline sub_resource (silent-fail trap).
- [ ] Script declares four `@export_range(0.0, 1.0)` personality knobs: `aggression`, `patience`, `caution`, `punishment`.
- [ ] Script jitters personality in `_ready` via `randf_range` clamped to `[0.0, 1.0]`.
- [ ] Script defines an `enum Intent` with at least 5 values from {IDLE, PATROL, INVESTIGATE, HUNT, KILL, RETREAT, RESCUE_ALLY}.
- [ ] Script defines an `enum State` with the 4 action states (CALM / ALERT / AGGRESSIVE / DEFEATED).
- [ ] Intent layer (`_update_intent` / `_decide_intent`) computes `current_intent` from perception + personality.
- [ ] Action SM (`_update_action`) reads `current_intent`; it does NOT write it.
- [ ] Script has an `attack_telegraph` parameter in 0.3–0.7 sec range, scaled by aggression at attack time.
- [ ] Script emits a `died` signal AND an `ally_defeated` signal.
- [ ] Script uses `distance_squared_to` (NOT `distance_to`) for range comparisons.
- [ ] Script uses typed GDScript per `library/references/gd-style/gd-style.md`.
- [ ] Skill asks "May I create / write …" before each user-visible mutation.
- [ ] Final step is `summer_save_scene` then `summer_get_script_errors`.

## Case 2: Failure Path — wave-mob archetype but user asks for full FSM

**Fixture:** User wants 100+ enemies on screen at once.

**Input:** "Spawn 100 enemies that chase the player. Each one should perceive, decide, telegraph attacks, and drop loot."

**Expected behavior:**

- Skill recognizes the scale conflict.
- Says: "100 enemies with full intent SM + LOS perception will eat your frame budget. For wave mobs at this scale, the right archetype is the wave-mob (single KILL intent, 2 action states, no LOS). Want me to build that instead?"
- Does NOT silently build 100 expensive enemies.
- Offers the trade-off explicitly.

**Assertions:**

- [ ] Skill names the performance trade-off, not just "this is hard".
- [ ] Skill points to the wave-mob archetype as the right answer.
- [ ] Skill does NOT proceed without confirmation.
- [ ] Skill never starts spawning 100 expensive nodes.

## Case 3: Edge Case — boss with phases

**Fixture:** Same as Case 1.

**Input:** "Design a 3-phase boss for the dungeon room."

**Expected behavior:**

- Skill picks the **boss** archetype (different complexity budget).
- Calls out: "Boss complexity (6–10 action states, 5–7 intents incl. RESCUE_ALLY, scripted phases) is at the threshold where a behavior tree might pay off, but I recommend a hand-coded FSM with phase enum first since you're a single dev."
- Recommends boss personality bias: aggression 0.7–0.9, patience 0.7–0.9, punishment 0.8–1.0 (from the tunable matrix).
- Walks all six pillars at boss scale: more tells per state, telegraph 0.5–0.7 sec, distinct mechanics per phase (cap at 4–6 total mechanics).
- Defers to `ai-and-npcs/boss-patterns/SKILL.md` for the deeper phase-transition patterns.
- Does NOT just scale up the basic-enemy stub.

**Assertions:**

- [ ] Skill recognizes "boss" requires a different design.
- [ ] Skill caps at 4–6 distinct mechanics across phases.
- [ ] Skill mentions phase enum as the FSM extension.
- [ ] Skill cites boss-archetype personality ranges from the tunable matrix.
- [ ] Skill defers to boss-patterns for deeper detail rather than trying to one-shot it.

## Case 4: No Summer MCP — fallback path

**Fixture:** Same as Case 1, but Summer MCP unavailable.

**Input:** "Add a basic enemy that chases the player."

**Expected behavior:**

- Skill detects MCP unavailable.
- Asks user to paste the existing scene tree (or relevant `.tscn` snippet) so node paths are right.
- Generates a `.tscn` snippet (Enemy + Vision + Sight + Mesh + CollisionShape) with valid Godot 4 scene syntax.
- Writes `scripts/enemy_ai.gd` directly with the personality + intent + action layers intact.
- Provides manual editor instructions for connecting the `body_entered` signal.
- Still asks "May I write …" before each file write.

**Assertions:**

- [ ] Skill does not blindly call `summer_*` tools and fail.
- [ ] Generated `.tscn` is valid Godot 4 syntax (parseable).
- [ ] Generated GDScript has personality knobs, intent enum, action SM (same structure as MCP path).
- [ ] Skill still asks "May I" on writes.

## Case 5: Group emergence — squad of 4 with varied aggression

**Fixture:** Same as Case 1. User wants a small squad, not a wave.

**Input:** "Spawn a patrol squad of 4 basic_grunt enemies near the gate."

**Expected behavior:**

- Skill picks the **basic enemy** archetype with squad framing.
- Confirms the squad uses the **same `enemy_ai.gd` script and same archetype `.tscn`** — variation comes from per-instance personality jitter, NOT 4 different scripts.
- Shows / verifies that `personality_jitter` (default 0.15) is set on each instance, with base aggression in the basic_grunt range (0.5–0.7).
- Predicts the emergent roles: with jitter, post-spawn aggression values land roughly across `0.35 / 0.5 / 0.65 / 0.85` and produce a sniper / anchor / flanker / berserker mix.
- Does NOT author per-instance roles by hand.
- Does NOT duplicate the script per role.

**Assertions:**

- [ ] All 4 spawned NPCs use the same script file and same archetype scene.
- [ ] Each instance's `_ready` jitters all 4 personality knobs via `randf_range` clamped to `[0.0, 1.0]`.
- [ ] Skill explicitly cites group emergence (varied aggression -> varied roles) instead of authoring roles centrally.
- [ ] Skill does NOT recommend creating `sniper_ai.gd`, `flanker_ai.gd`, etc. as separate scripts.
- [ ] Skill calls out that two NPCs with the same base archetype will still feel different post-jitter.
- [ ] If the user pushes back ("I want one to definitely be a sniper"), skill suggests narrowing that *instance's* base values (e.g., aggression 0.2, caution 0.8) rather than forking the script.

---

This spec runs via `/skill-test design-npc spec` (see `workflow/skill-test/SKILL.md`).
