---
spec: eval/skill-spec/art-direction
skill: skill/art-direction
status: ported
source: tests/specs/art-direction.md
runner: manual   # /skill-test today; automated harness is a fast-follow (ROADMAP §3.4)
---

# Skill Spec: /art-direction

## Fixture

- Summer Engine project, main scene with `World/WorldEnvironment` and `World/Sun` (DirectionalLight3D) present.
- `.summer/GameSoul.md` exists; brief: "Cozy farming sim, vertical slice scope."
- No `.summer/art-bible.md` yet.
- Summer MCP available.

## Case 1: Happy Path — define art direction for cozy farming sim

**Input:** "Help me define the art direction. References: Stardew Valley and Sable."

**Expected MCP tool sequence (in order):**

1. `Read .summer/GameSoul.md` — anchor
2. (Skill notes: brief says "cozy", which forbids harsh contrast / saturated reds)
3. (Skill walks: technique pick → palette (6-15 hex codes) → mood adjectives → lighting plan → post-processing rules → do/don't list)
4. (Skill shows the bible inline)
5. (Skill asks: "May I update `project.godot`'s default clear color to the palette primary, and enable MSAA 2x?")
6. `summer_project_setting(key="rendering/environment/defaults/default_clear_color", value="Color(...)")`
7. `summer_project_setting(key="rendering/anti_aliasing/quality/msaa_3d", value="2")`
8. (Skill asks: "May I dial in the WorldEnvironment + Sun to the lighting plan?")
9. `summer_inspect_node(path="./World/WorldEnvironment")`
10. `summer_set_prop(...)` — adjustments + tonemap per the plan
11. `summer_set_prop(path="./World/Sun", key="light_color", value="Color(...)")`
12. (Skill asks: "May I create `.summer/art-bible.md` with this bible?")
13. `Write .summer/art-bible.md`

**Assertions:**

- [ ] Skill reads `.summer/GameSoul.md` to anchor.
- [ ] Skill enforces 2+ references — does not proceed with single reference.
- [ ] Skill picks ONE rendering technique (does not allow blending without naming the conflict).
- [ ] Palette has 6-15 hex codes; uses off-white (e.g., #f4ecdf) and off-black (e.g., #1f1a16) — flags pure #ffffff or #000000 if user pitches them.
- [ ] Mood adjectives are concrete (e.g., "soft, hand-warmed, golden-hour"), not vague ("cool, atmospheric").
- [ ] Lighting plan names DirectionalLight3D color, energy, angle; sky colors; ambient; never-rules.
- [ ] Post-processing has explicit ON/OFF/value calls per item (Glow, SDFGI, SSAO, SSR, Tonemap, Vignette, Chromatic aberration, Film grain) — NOT a list of options.
- [ ] DO and DON'T lists each have at least 5 specific, enforceable rules.
- [ ] DON'T list explicitly forbids chromatic aberration, motion blur, lens flare unless mood justifies them.
- [ ] Skill asks "May I ..." before any `summer_project_setting` or `summer_set_prop` call.
- [ ] Skill writes `.summer/art-bible.md` only after asking.
- [ ] Skill never calls `summer_set_resource_property` on an inline sub_resource (silent-fail trap).
- [ ] Skill ends with routing to `/summer:audio-direction` or similar.

## Case 2: Failure Path — mixed-technique pitch

**Fixture:** Same as Case 1.

**Input:** "I want PBR realistic characters in a toon-shaded world."

**Expected behavior:**

- Skill identifies the conflict explicitly: "Toon characters in a PBR world fight. The lighting that makes PBR read realistic crushes toon shading; the flat shading that makes toon read clean strips PBR's value."
- Skill offers a hierarchy: "(a) PBR with toon outlines (one technique), (b) full-toon with PBR-feeling fabric (one technique), (c) accept the conflict and pick which side wins on which assets."
- Skill does NOT silently pick or design two parallel pipelines.

**Assertions:**

- [ ] Skill names the technique conflict out loud.
- [ ] Skill explains *why* the techniques fight (lighting interaction).
- [ ] Skill forces the user to pick one primary technique.
- [ ] No bible written until the technique is locked.

## Case 3: Edge Case — user pitches pure white + pure black palette

**Fixture:** Same as Case 1.

**Input:** "Black-and-white only, super high contrast. Like Limbo."

**Expected behavior:**

- Skill recognizes the intent (high-contrast monochrome) but flags pure values: "Limbo isn't actually pure black — it's #0a0a0a to #f0f0f0 with subtle warm tint. Pure #000 + #fff makes UI text vibrate and reads as unintentional."
- Skill offers a near-monochrome palette: e.g., #0a0a0a, #2a2a2a, #6e6e6e, #c0c0c0, #f0f0f0 with one accent color (often warm) reserved for a single mechanic-tied use.
- Skill writes the bible with off-pure values and documents the single-accent rule in the DO list.

**Assertions:**

- [ ] Skill flags pure #000 / #fff as a red flag and corrects to off-pure values.
- [ ] Bible includes at least one accent color reserved for mechanic-tied use.
- [ ] Skill explains *why* (UI vibration, "looks unintentional") not just "use these values".

## Case 4: No Summer MCP — file-edit fallback

**Fixture:** Same as Case 1, but Summer MCP is unavailable.

**Input:** "Define the art direction for my farming sim."

**Expected behavior:**

- Skill detects no MCP.
- Walks the design beats normally.
- Instead of `summer_project_setting`, prints the `project.godot` snippet for the user to paste:

  ```
  [rendering]
  environment/defaults/default_clear_color=Color(0.227, 0.290, 0.227, 1)
  anti_aliasing/quality/msaa_3d=2
  ```

- Instead of `summer_set_prop` on WorldEnvironment, prints the `.tscn` snippet for the user to paste into the main scene.
- Still writes `.summer/art-bible.md` via host `Write`.
- Asks "May I write ..." before each file write.

**Assertions:**

- [ ] Skill identifies that MCP is unavailable; does not blindly call `summer_*`.
- [ ] Generated `project.godot` snippet uses correct INI section format.
- [ ] Generated `.tscn` snippet for WorldEnvironment is parseable Godot 4.
- [ ] Skill still writes `.summer/art-bible.md`.
- [ ] Skill still asks "May I write ..." before each write.

---

This spec runs via `/skill-test art-direction spec` (see `workflow/skill-test/SKILL.md`).
