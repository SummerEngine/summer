---
spec: eval/skill-spec/game-feel
skill: skill/game-feel
status: ported
source: tests/specs/vfx.md
runner: manual   # /skill-test today; automated harness is a fast-follow (ROADMAP §3.4)
---

# Skill Spec: /vfx

## Fixture

- Summer Engine project, main scene with `World/Player` (CharacterBody3D + Camera3D) and `World/Enemy` (CharacterBody3D + MeshInstance3D + a `damaged(amount)` signal).
- `default_bus_layout.tres` defines `Master`, `Music`, `Ambient`, `SFX` buses (at minimum).
- Summer MCP tools available (engine running on localhost:6550).
- Host file tools available (Read, Edit, Write).

## Case 1: Happy Path — combat hits feel flat

**Input:** "My combat feels flat. Add some juice."

**Expected behavior:**

1. Skill asks one focused question: "What feels flat? combat hits / pickups / explosions / spell casts / something else."
2. User says "combat hits".
3. Skill calls `summer_get_scene_tree`, `summer_inspect_node "./World/Enemy"`, `summer_inspect_node "./World/Player/Camera3D"`, and confirms the audio bus list.
4. Skill proposes the full trio bundle: "I'm about to add HitFlash on `./World/Enemy`, CameraShake script on `./World/Player/Camera3D`, AudioDucker autoload, and wire the `damaged` signal so one hit fires all three. OK?"
5. After user OK:
   - `summer_add_node(parent="./World/Enemy", type="Node", name="HitFlash")`
   - `Write scripts/vfx/hit_flash.gd`
   - `Write scripts/vfx/camera_shake.gd`
   - `Write scripts/vfx/audio_ducker.gd`
   - Register `AudioDucker` as an autoload (project settings or `.cfg` edit).
   - `summer_connect_signal(from="./World/Enemy", signal="damaged", to="./World/Enemy/HitFlash", method="flash")`
   - `summer_save_scene`
   - `summer_get_script_errors`

**Assertions:**

- [ ] Skill asks the "what feels flat?" question before any tool call.
- [ ] Skill reads scene tree AND inspects both Enemy mesh and Player Camera3D before mutation.
- [ ] Skill confirms audio bus names exist before installing AudioDucker.
- [ ] Skill explicitly states the bundle of changes and asks "May I" / "OK?" before mutation.
- [ ] HitFlash uses `create_tween()` + `tween_callback`, NOT `await create_timer().timeout`.
- [ ] HitFlash kills any in-flight tween on re-entry (rapid hits).
- [ ] CameraShake uses quadratic falloff (`_trauma * _trauma`), NOT linear.
- [ ] CameraShake subtracts last frame's `_shake_offset` before applying the new one.
- [ ] AudioDucker captures `_initial_volumes` once in `_ready()` and applies ducking as an offset (relative dB drop), NOT absolute writes.
- [ ] AudioDucker kills any in-flight tween before starting a new duck.
- [ ] Final hit flash duration is 0.06–0.12 sec.
- [ ] Skill never calls `summer_set_resource_property` on an inline sub_resource (e.g. for the flash StandardMaterial3D).
- [ ] Skill ends with `summer_save_scene` then `summer_get_script_errors`.

## Case 2: Failure Path — missing audio buses

**Fixture:** project's `default_bus_layout.tres` has only `Master`. No `Music`, `Ambient`, `SFX`.

**Input:** "Add hit feedback. Audio ducking too."

**Expected behavior:**

- Skill calls `summer_get_scene_tree` then inspects the bus layout (or asks the user to paste it).
- Sees only `Master` exists.
- Skill does NOT install AudioDucker silently — it explains: "Audio ducking only works if at least Music/Ambient/SFX buses exist. With one Master bus, ducking would also duck the impact SFX you're trying to highlight. I can either (a) install hit-flash + camera-shake now and defer ducking until you set up buses via the `audio-direction` skill, or (b) walk through bus setup first."
- Waits for user choice.
- Whichever path: hit-flash + camera-shake still install correctly.

**Assertions:**

- [ ] Skill detects single-bus layout and stops to ask.
- [ ] Skill does NOT register AudioDucker autoload silently.
- [ ] Skill names `audio-direction` skill as the prerequisite.
- [ ] Skill still ships the other two systems in this session if the user picks (a).

## Case 3: Edge Case — pickup pulse without trauma

**Fixture:** Same as Case 1, but the user is polishing pickups (peaceful glow), not combat.

**Input:** "Make my health pickups feel more rewarding when collected."

**Expected behavior:**

- Skill asks the focused question; user says "pickups".
- Skill recognizes pickups should NOT trigger camera shake or aggressive audio ducking — those read as combat, not reward.
- Skill installs only the HitFlash module (renaming usage as a pickup pulse — same script, called on collection), and proposes a small upward duck (0.2 amount, 0.3 duration) so the pickup "ding" reads above ambient.
- Skill explicitly says: "Skipping camera shake here — shake reads as 'something hit me', wrong feeling for pickups. Same for heavy ducking. Want a tiny duck (0.2) to make the pickup chime pop?"
- Does NOT call `add_trauma` from the pickup handler.

**Assertions:**

- [ ] Skill recognizes pickups ≠ combat and adapts the trio.
- [ ] Skill explicitly skips camera-shake with reasoning, not silently.
- [ ] HitFlash script is reused (not a forked copy) — `flash()` called on the pickup mesh.
- [ ] Audio duck `amount` ≤ 0.3, duration ≤ 0.4 (gentle).
- [ ] Skill does NOT install the full combat trio when the answer was "pickups".

## Case 4: No Summer MCP — file-edit fallback

**Fixture:** Same as Case 1, but Summer MCP is unavailable (Cursor in a project where the engine is not connected).

**Input:** "Add hit-flash + camera-shake + audio ducking to my combat."

**Expected behavior:**

- Skill detects MCP unavailable.
- Asks the user to paste (a) the relevant `.tscn` snippet showing Enemy + Player + Camera3D node paths, and (b) the bus list from `default_bus_layout.tres`.
- Writes `scripts/vfx/hit_flash.gd`, `scripts/vfx/camera_shake.gd`, `scripts/vfx/audio_ducker.gd` directly via host file tools.
- Provides a `.tscn` patch for adding the HitFlash node and a manual instruction for registering the AudioDucker autoload via `project.godot` or the editor.
- Provides a manual signal-connect instruction (or a `.tscn` connection block) instead of `summer_connect_signal`.
- Still asks "May I write `scripts/vfx/<file>.gd`?" before each file write.
- Does NOT blindly call `summer_*` tools.

**Assertions:**

- [ ] Skill identifies MCP unavailable and adapts.
- [ ] Generated GDScript is syntactically valid for the current Summer Engine
      compatibility line and uses type hints.
- [ ] Skill asks the user to paste the scene snippet AND the bus list.
- [ ] Skill provides explicit autoload-registration instructions (no `summer_*` autoload tool exists).
- [ ] Skill applies "May I write …" protocol on each of the 3 file writes.
- [ ] No `summer_*` tool calls appear in the transcript when MCP is flagged unavailable.

---

This spec runs via `/skill-test vfx spec` (see `workflow/skill-test/SKILL.md`).
