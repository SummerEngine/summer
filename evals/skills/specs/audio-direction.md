---
spec: eval/skill-spec/audio-direction
skill: skill/audio-direction
status: ported
source: tests/specs/audio-direction.md
runner: manual   # /skill-test today; automated harness is a fast-follow (ROADMAP §3.4)
---

# Skill Spec: /audio-direction

## Fixture

- Summer Engine project, default audio bus layout (Master only).
- `.summer/GameSoul.md` exists; brief: "Cozy farming sim, vertical slice scope."
- `.summer/art-bible.md` exists; mood: "soft, hand-warmed, golden-hour, painterly".
- No `.summer/audio-bible.md` yet.
- No `audio/` folder yet.
- Summer MCP available.

## Case 1: Happy Path — define audio direction for cozy farming sim

**Input:** "Define the audio direction. References: Stardew Valley OST, Studio Ghibli scores, and Outer Wilds. Acoustic, organic SFX."

**Expected MCP tool sequence (in order):**

1. `Read .summer/GameSoul.md` — anchor to brief
2. `Read .summer/art-bible.md` — anchor to visual mood
3. (Skill notes the rhyme: "soft, hand-warmed, golden-hour" + acoustic references = acoustic / folk style as primary)
4. (Skill walks: music style → tempo + key → SFX vocabulary (8 classes) → dynamic music plan with state machine → spatial + mix rules)
5. (Skill shows the bible inline)
6. (Skill asks: "May I create `audio/default_bus_layout.tres` with these buses: Master / Music / SFX / UI / Voice / Ambient / Reverb_Small / Reverb_Large / Reverb_Outdoor?")
7. `Write audio/default_bus_layout.tres`
8. `summer_project_setting(key="audio/buses/default_bus_layout", value="res://audio/default_bus_layout.tres")`
9. (Skill asks: "May I create `.summer/audio-bible.md` with this bible?")
10. `Write .summer/audio-bible.md`
11. (Skill optionally asks: "May I generate first-pass SFX seeds for UI, pickup, damage?")
12. (On yes) `summer_generate_audio(prompt="soft woody UI click, 80ms, no reverb", duration=0.1)` etc.

**Assertions:**

- [ ] Skill reads BOTH `.summer/GameSoul.md` AND `.summer/art-bible.md` to anchor.
- [ ] Skill enforces 3+ references — does not proceed with one or two.
- [ ] Skill picks ONE primary music style; if user pitches multiple, names the conflict.
- [ ] Music section has explicit tempo range (BPM), key center, time signature — not "varies".
- [ ] SFX vocabulary has 8 classes, each with character + examples + a DON'T rule.
- [ ] DON'T rules include things like "no pure sine ding for pickup" and "no same footstep for all surfaces".
- [ ] Dynamic music plan picks ONE model (layered / vertical / horizontal / procedural) — not a list.
- [ ] Dynamic music plan defines a state machine with named states + transitions + crossfade times.
- [ ] Spatial + mix section has concrete dB values, attenuation curve, max distance, master ceiling -1 dBTP.
- [ ] Mix defaults to SFX 0 dB / Music -8 dB / UI -3 dB (SFX loudest).
- [ ] Bus layout has at least Music, SFX, UI, Voice, Ambient + 1+ Reverb send buses.
- [ ] Skill asks "May I ..." before any `Write`, `summer_project_setting`, or `summer_generate_audio` call.
- [ ] Skill writes `.summer/audio-bible.md` only after asking.
- [ ] Skill never calls `summer_set_resource_property` on an inline sub_resource (silent-fail trap).
- [ ] Skill ends with routing to `/summer:design-mechanic` or implementation skill.

## Case 2: Failure Path — references contradict the brief

**Fixture:** Same as Case 1, but brief says "horror walking sim".

**Input:** "References: Mario 64 OST, A Hat in Time, Banjo-Kazooie. Bouncy chiptune."

**Expected behavior:**

- Skill identifies the conflict: "Brief says horror; references are bright N64 platformer scores. Those want opposite shapes — horror wants ambient drone or industrial; bouncy chiptune undercuts dread."
- Skill asks the user to resolve: "(a) keep horror brief, change references to ambient/industrial, (b) keep bouncy references, change brief away from horror, or (c) intentional juxtaposition (rare; works in 1 in 50 games — Undertale, Buckshot Roulette)."
- Skill does NOT silently pick or design a "horror chiptune" hybrid without flagging the friction.

**Assertions:**

- [ ] Skill names the brief vs. references conflict explicitly.
- [ ] Skill explains *why* the shapes oppose.
- [ ] Skill offers (c) intentional juxtaposition as a valid but rare path.
- [ ] No bible written until the user resolves.

## Case 3: Edge Case — user wants no music

**Fixture:** Same as Case 1.

**Input:** "Reference: Inside, Limbo. No music — just diegetic sound and ambience."

**Expected behavior:**

- Skill accepts "no music" as a valid direction (those references genuinely use it).
- Skill replaces the dynamic music plan section with a "Diegetic-only ambience plan":
  - Named ambience layers (room tone / wind / distant water / heart-rate-tied sub-bass when tense)
  - Rules for when sub-bass enters (proximity to threat) and exits
  - SFX still gets all 8 vocabulary classes (with extra weight on the "Ambient layer" class)
- Skill keeps the bus layout but removes the Music bus or marks it "reserved (unused in v1)".
- Skill notes the trade-off: "Diegetic-only is harder to make feel paced — every level needs an ambient arc that does what music would normally do."

**Assertions:**

- [ ] Skill does NOT force a music style on a no-music game.
- [ ] Bible has a Diegetic / ambience plan section instead of (or supplementing) Dynamic music plan.
- [ ] Bus layout reflects the choice (no Music bus or marked reserved).
- [ ] Skill flags the trade-off: pacing is now ambience's job.

## Case 4: No Summer MCP — file-edit fallback

**Fixture:** Same as Case 1, but Summer MCP is unavailable.

**Input:** "Define the audio direction for my cozy farming sim."

**Expected behavior:**

- Skill detects no MCP.
- Walks the design beats normally.
- Instead of `summer_project_setting`, prints the `project.godot` snippet for the user to paste:

  ```
  [audio]
  buses/default_bus_layout="res://audio/default_bus_layout.tres"
  ```

- Generates `audio/default_bus_layout.tres` content as plain text for the user to save (Godot's `.tres` resource format with bus entries).
- Writes `.summer/audio-bible.md` via host `Write`.
- Does NOT call `summer_generate_audio` — instead suggests external SFX library searches or asks the user to handle generation later.
- Asks "May I write ..." before each file write.

**Assertions:**

- [ ] Skill identifies that MCP is unavailable; does not blindly call `summer_*`.
- [ ] Generated `project.godot` snippet uses correct INI section format.
- [ ] Generated `default_bus_layout.tres` is valid Godot 4 resource format.
- [ ] Skill still writes `.summer/audio-bible.md`.
- [ ] Skill does not attempt audio generation when generation tools are unavailable.

---

This spec runs via `/skill-test audio-direction spec` (see `workflow/skill-test/SKILL.md`).
