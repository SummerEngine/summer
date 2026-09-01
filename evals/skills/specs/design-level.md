---
spec: eval/skill-spec/design-level
skill: skill/design-level
status: ported
source: tests/specs/design-level.md
runner: manual   # /skill-test today; automated harness is a fast-follow (ROADMAP §3.4)
---

# Skill Spec: /design-level

## Fixture

- Summer Engine project, main scene already has a `World/Player` (CharacterBody3D) with FPS controller wired.
- `.summer/GameSoul.md` exists; brief: "Action-combat game, three mechanics: dash, parry, double-jump. Vertical slice scope."
- `.summer/mechanics/parry.md` exists.
- No `levels/` folder yet.
- Summer MCP available.

## Case 1: Happy Path — design level 1, a combat encounter

**Input:** "Design level 1, a 5-minute combat encounter that teaches parry."

**Expected MCP tool sequence (in order):**

1. `Read .summer/GameSoul.md` — anchor to the brief
2. (Optional: `Read .summer/mechanics/parry.md` — anchor to the mechanic being taught)
3. (Skill walks: type → teaching goal → pacing curve (5 beats with intensity numbers) → encounters list → secrets list → reward gating → spaces list)
4. (Skill shows the node-tree skeleton inline)
5. (Skill asks: "May I create `levels/level_01.tscn` with this skeleton?")
6. `summer_create_scene(path="res://levels/level_01.tscn", root_type="Node3D", root_name="World")`
7. `summer_add_node(parent="./World", type="Node3D", name="Geometry")` and children
8. `summer_add_node(parent="./World", type="Node3D", name="Spawns")` and children
9. `summer_add_node(parent="./World", type="Node3D", name="Triggers")` and Area3D children
10. `summer_add_node(parent="./World", type="Node3D", name="Pickups")`
11. `summer_add_node(parent="./World", type="Node3D", name="Secrets")`
12. `summer_add_node(parent="./World", type="Node3D", name="Lighting")` with WorldEnvironment + DirectionalLight3D
13. `summer_save_scene`
14. (Skill asks: "May I create `.summer/levels/level_01.md` with the design doc?")
15. `Write .summer/levels/level_01.md`
16. `summer_get_script_errors`

**Assertions:**

- [ ] Skill reads `.summer/GameSoul.md` to anchor.
- [ ] Skill reads the relevant `.summer/mechanics/<name>.md` if the level teaches an existing mechanic.
- [ ] Skill states a concrete teaching goal — not a vague "fun encounter".
- [ ] Skill draws a 5-beat pacing curve with intensity numbers (Intro / Build / Peak / Release / Hook).
- [ ] Skill lists 4 encounters with timing + space mapping.
- [ ] Skill lists 3 secrets with which beat each lives in.
- [ ] Skill lists reward gating, gates rewards behind tests.
- [ ] Skill enforces 4-6 distinct spaces (does not produce 12 micro-rooms).
- [ ] Skill asks "May I create ..." before `summer_create_scene`.
- [ ] Skeleton is markers + Area3Ds, NOT meshes / enemy scripts (those come later).
- [ ] Skill writes the design doc to `.summer/levels/<name>.md`.
- [ ] Skill never calls `summer_set_resource_property` on an inline sub_resource.
- [ ] Final step is `summer_save_scene` then `summer_get_script_errors`.

## Case 2: Failure Path — user blends three level types

**Fixture:** Same as Case 1.

**Input:** "Design a stealth level with a puzzle in the middle and a boss at the end."

**Expected behavior:**

- Skill recognizes blended types: stealth + puzzle + boss.
- Skill pushes back: "That's three level types. Pick one as the primary; the other two become flavor or get split into sequential levels."
- Skill names the trade-off: "Stealth + boss in the same level kills both — stealth wants tension that releases at the encounter, boss wants tension that builds *to* the encounter. They're opposite shapes."
- Skill does NOT silently pick one or design all three at once.

**Assertions:**

- [ ] Skill identifies the blend explicitly.
- [ ] Skill explains the design tension between the blended types.
- [ ] Skill asks the user to pick one primary type before designing.
- [ ] No `summer_create_scene` call until user picks.

## Case 3: Edge Case — no `.summer/GameSoul.md` exists

**Fixture:** Same as Case 1, but `.summer/GameSoul.md` does NOT exist.

**Input:** "Design level 1 of my game."

**Expected behavior:**

- Skill detects no brief exists.
- Skill suggests: "No `.summer/GameSoul.md` yet — without a brief, this level has no game to serve. Run `/summer:brainstorm-game` first, or give me the core loop + mechanics inline so I can anchor the design."
- Skill does NOT design a generic level in a vacuum.

**Assertions:**

- [ ] Skill checks for `.summer/GameSoul.md` early (before designing).
- [ ] Skill explicitly recommends `/summer:brainstorm-game` if absent.
- [ ] Skill offers the inline-anchor alternative as a fallback.
- [ ] No design happens without anchoring information.

## Case 4: No Summer MCP — file-edit fallback

**Fixture:** Same as Case 1, but Summer MCP is unavailable.

**Input:** "Design level 1 — a 5-minute combat encounter."

**Expected behavior:**

- Skill detects no MCP.
- Walks the design beats normally.
- Instead of `summer_create_scene` + `summer_add_node`, prints the full `.tscn` file contents for the user to save manually at `levels/level_01.tscn`.
- Generated `.tscn` is syntactically valid Godot 4 scene format with the marker/Area3D skeleton (no meshes).
- Still writes the design doc to `.summer/levels/level_01.md` via host `Write`.
- Asks "May I write ..." before each file write.

**Assertions:**

- [ ] Skill identifies that MCP is unavailable; does not blindly call `summer_*`.
- [ ] Generated `.tscn` is parseable Godot 4 scene file.
- [ ] Skeleton in the `.tscn` matches the spaces / spawns / triggers structure from the design doc.
- [ ] Skill still writes `.summer/levels/<name>.md`.

---

This spec runs via `/skill-test design-level spec` (see `workflow/skill-test/SKILL.md`).
