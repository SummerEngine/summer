---
name: audio-direction
description: Use when defining the sonic identity — music style, instruments, SFX vocabulary, dynamic music plan. Outputs an audio bible at `.summer/audio-bible.md`. Trigger on "audio direction", "audio bible", "music style", "sound design", "what should it sound like", "dynamic music".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: audio
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_get_project_context summer_get_scene_tree summer_inspect_node summer_add_node summer_project_setting summer_generate_audio
paths: [".summer/**", "project.godot", "**/*.tscn", "audio/**"]
---

# /audio-direction — Define the Sonic Identity

## Overview

Most indie games sound like a single library used flat. The same generic "swoosh" for menu, jump, pickup, hit. That's not audio direction — that's audio absence. This skill builds an audio bible that names the music style, the SFX vocabulary, the dynamic music plan, and the spatial / mix rules. Writes to `.summer/audio-bible.md` and configures the audio bus layout in the project so the rest of the work has a real foundation.

**Core principle:** SFX needs a *vocabulary*, not a *library*. Eight named SFX classes with consistent character beat 80 random library hits.

## Steps

### 1. Open with three references

Ask exactly this:

> Three reference tracks, games, or films for the music. What instruments matter? And what's the SFX vibe — chunky, clean, synthetic, or organic?

Three is the minimum. One or two collapses into a clone. References are the highest-signal input — listen carefully.

If they freeze, offer four axes (not titles):

> Pick the closest: a) orchestral + cinematic (Hollow Knight, Journey), b) lo-fi electronic + ambient (Disco Elysium, Outer Wilds), c) chiptune / synth (Hyper Light Drifter, Celeste), d) acoustic / folk (Sable, A Short Hike).

### 2. Read the brief and art bible if they exist

```
Read .summer/GameSoul.md
Read .summer/art-bible.md
```

Audio must rhyme with the visuals. Quote it back:

> Art bible says "soft, hand-warmed, golden-hour, painterly". That rhymes with acoustic / folk / lo-fi over orchestral or aggressive synth. Confirming.

If the brief says "horror", that constrains the music style harder than the user's references will. Name the constraint.

### 3. Pin the music style

Force one primary style. Sub-styles can blend, but a primary is required.

| Style | Anchor instruments | Pairs with | Avoid |
|---|---|---|---|
| Orchestral cinematic | Strings, brass, choir | Story-led, fantasy | Casual / cozy |
| Acoustic / folk | Guitar, piano, hand percussion | Cozy, narrative | Action / horror |
| Lo-fi electronic | Vintage synth pad, tape sat, light beat | Atmospheric, indie | Combat-heavy |
| Chiptune / synthwave | 8-bit / 16-bit chips, FM synth | Retro, platformer | Realism |
| Industrial / metal | Distorted bass, percussion-led | Horror, action | Cozy |
| Ambient drone | Pads, no drums, slow movement | Walking sim, horror | Action |
| Jazz / fusion | Live instruments, improv | Stylish, narrative | Generic action |
| Tracker / hyperpop | Glitchy, dense, modern | Esoteric, indie | Mass appeal |

Ask:

> One primary style. Which?

### 4. Define tempo + key range

Concrete numbers, not "varies".

```
Tempo range: 80–110 BPM (slow side; combat would push 120+)
Key center: D minor (warm but melancholic)
Modulation rule: combat tracks shift to D dorian, calm tracks to D natural minor
Time signature: 4/4 default; 6/8 for emotional cues
```

### 5. Build the SFX vocabulary

Eight named classes. Each class has a *character*, not a single sound.

| Class | Character | Examples in this game | DON'T |
|---|---|---|---|
| **UI** | Soft, woody, short (60-100ms) | Menu hover, button click, tab switch | No bell tones, no synth blips |
| **Pickup positive** | Warm, ascending interval (major third), 200-400ms | Coin, key, heal | No pure sine "ding" |
| **Pickup neutral** | Brief tactile, no melodic component | Note, breadcrumb, lore item | No ascending pitch (reads as reward) |
| **Negative / damage** | Punchy low-mid, slight detune | Player hit, enemy hit, fall damage | No long reverb tail |
| **Movement / footstep** | Material-aware (wood / stone / grass) | Walk, run, jump, land | No same sample for all surfaces |
| **Attack / action** | Front-loaded transient, short body | Swing, parry, dash | No layered orchestral hit |
| **Ambient layer** | Continuous, low presence | Wind, room tone, distant waves | No looping melody |
| **Stinger / event** | Distinctive, rare, melodic | Boss intro, level clear, story beat | No reuse for normal events |

Ask:

> Eight classes above. Adjust any character / examples / DON'Ts?

### 6. Define the dynamic music plan

Static music = one track loops forever in a level. Boring. Dynamic music = layers swell with player state. Pick a model.

| Model | How it works | Cost | Best for |
|---|---|---|---|
| **Layered stems** | One bar / multiple instrument layers; combat adds drum stem, calm removes it | Medium (need stems authored) | Most games |
| **Vertical re-orchestration** | Same melody, different instrumentation per state | High (composer-led) | Story-led / boss-heavy |
| **Horizontal sequencing** | Different tracks for different states, crossfade | Low (just author 3-5 full tracks) | Vertical slice scope |
| **Procedural / generative** | Generate from rules in real-time | High dev cost | Special-case |

Pick one. State the state machine:

```
States:
  CALM        — exploration, low intensity
  TENSION     — enemies aware but not engaged
  COMBAT      — engaged
  VICTORY     — encounter cleared (4-second sting → return to CALM)

Transitions:
  CALM → TENSION   when an enemy detects the player (2s crossfade)
  TENSION → COMBAT when first damage exchanged (instant drum stem)
  COMBAT → VICTORY when last enemy dies (drum stem cuts, brass swell)
  VICTORY → CALM   after 4s

Rules:
  No state stays > 90s without variation (loop with bar-1 randomization)
  Volume ducking: dialogue active → music -6dB
  Boss music is its own track; ignores normal state machine
```

### 7. Define the spatial + mix rules

| Rule | Value |
|---|---|
| 3D attenuation curve | Inverse-square (default), max distance 25m |
| Reverb buses | 1 small (interior), 1 large (cave / hall), 1 outdoor |
| HRTF for player | ON (headphone-friendly directional cues) |
| Master ceiling | -1 dBTP (true peak, no clipping on consoles) |
| Music vs SFX vs UI mix | -8 dB / 0 dB / -3 dB (SFX is loudest) |
| Footstep rolloff | Cuts at 4m for player; cuts at 10m for NPC (player needs them, distant NPCs are noise) |
| Compression | Light bus compression on master (2:1, slow attack, 100ms release) |

### 8. Configure the audio bus layout

Real audio in Summer Engine needs a bus layout. A new project starts with only
the Master bus, so configure the remaining buses now.

**Preferred (Summer MCP):** Buses are typically in `default_bus_layout.tres`. Modify project setting:

```
summer_project_setting(key="audio/buses/default_bus_layout", value="res://audio/default_bus_layout.tres")
```

Ask the user:

> May I create `audio/default_bus_layout.tres` with these buses: Master / Music / SFX / UI / Voice / Ambient / Reverb_Small / Reverb_Large / Reverb_Outdoor?

On yes, write the `.tres` directly via `Write` (it is the engine's plain-text
resource format):

```
Write audio/default_bus_layout.tres
```

**Fallback (no MCP):** Print the `.tres` for the user to paste, plus the `project.godot` line.

### 9. Save the audio bible

Always write the bible. Path: `.summer/audio-bible.md`.

```markdown
# Audio Bible — <Game Name>

**References:** <3 specific tracks / games / films>
**Style:** <one of the 8 above>
**Tempo / key:** 80–110 BPM, D minor, 4/4

## SFX Vocabulary
| Class | Character | Examples | DON'T |
|---|---|---|---|
| UI | Soft, woody, 60-100ms | hover, click | bell tones |
| Pickup positive | Warm major-third, 200-400ms | coin, heal | pure sine |
| ... | ... | ... | ... |

## Dynamic Music Plan
**Model:** Layered stems
**States:** CALM / TENSION / COMBAT / VICTORY
**Transitions:** ...
**Rules:** ...

## Spatial + Mix
- 3D attenuation: inverse-square, 25m
- Reverb buses: small / large / outdoor
- HRTF: ON
- Master ceiling: -1 dBTP
- Mix bus: Music -8 dB, SFX 0 dB, UI -3 dB
- Footstep rolloff: 4m player / 10m NPC

## Bus Layout
Master → Music, SFX (→ Reverb_Small / Large / Outdoor), UI, Voice, Ambient
```

Ask:

> May I create `.summer/audio-bible.md` with this bible?

### 10. Optional — generate first SFX seeds

If the user wants to start generating, propose 3-5 SFX seeds aligned with the vocabulary. These are starting points, not finals.

```
summer_generate_audio(capability="sound_effects", text="soft woody UI click, 80ms, no reverb, neutral pitch", durationSeconds=0.5)
summer_generate_audio(capability="sound_effects", text="warm major-third coin pickup, 300ms, light reverb", durationSeconds=0.5)
summer_generate_audio(capability="sound_effects", text="punchy low-mid player damage hit, slight detune, 200ms, no tail", durationSeconds=0.5)
```

`capability` is required; `sound_effects` reads from `text` (not `prompt`), and the length argument is `durationSeconds` (not `duration`) with a floor of 0.5 s. Ask for the character you want inside the text and let the player only use the front of the clip — you cannot request 80 ms.

Ask first:

> May I generate first-pass SFX seeds for UI, pickup, and damage classes? They're starting points, not finals.

### 11. Route to the next step

End with:

> Bible saved. Next:
> - `/design-mechanic` to wire SFX cues into specific mechanics.
> - `/game-feel` if you haven't paired audio with visual effect cues yet.
> - Author or generate the calm music track first; it's the longest-running and sets the room tone.

## Common mistakes

| Mistake | Fix |
|---|---|
| Single reference for music | Three minimum. Listen for the *common* element across them. |
| "Library" instead of "vocabulary" | A bag of free SFX with no shared character feels random. Eight named classes with character notes. |
| Same SFX for all events | If pickup-coin and pickup-key sound identical, the player learns nothing from audio. |
| No dynamic music plan | Static loops bore in 90s. Pick a model (layered / vertical / horizontal / procedural). |
| Music louder than SFX | Players need SFX for gameplay; music is mood. Default mix is -8 dB music vs 0 dB SFX. |
| No reverb buses | "Send" architecture (rooms route to a small/large/outdoor reverb bus) is mandatory or your mix sounds dry-then-wet inconsistently. |
| Pure sine "ding" for pickup | Reads as cheap mobile game. Use a major-third interval with character. |
| Same footstep sample for all surfaces | Material-aware footsteps are 80% of the perceived audio quality. |
| No master ceiling / true peak | Audio clips on console builds without `-1 dBTP` ceiling. Always set it. |
| Assuming SetResourceProperty fails silently on inline sub_resources | It does not — inline targets work, and the structural failures (`node not found`, `property is not a resource`, `resource is null`) are explicit errors. What *is* silent on current engines is a bad value shape: a JSON object instead of a Godot literal string, a misspelled `subProperty`, or a wrong-typed value returns `ok:true` yet no-ops or coerces destructively. Pass class names and literal strings, and confirm in the saved `.tres`/`.tscn`, never from `ok` alone. See `../../references/mcp-tools-reference/mcp-tools-reference.md`. |

## Collaborative protocol

This skill writes one bible (`.summer/audio-bible.md`), creates a bus layout (`audio/default_bus_layout.tres`), modifies `project.godot`, and may generate audio (metered). Always ask before writing or generating. See `../../references/collaborative-protocol/collaborative-protocol.md`.

## Want a working starter?

No template — this is a workflow that produces the bible the rest of the project obeys. After the bible exists, the bus layout is set up and any subsequent audio work (footstep system, dynamic music) reads from it.

## See also

- `../../references/collaborative-protocol/collaborative-protocol.md`
- `../../references/godot-version/godot-version.md` — Summer compatibility and
  version-sensitive audio API notes
- `../../references/mcp-tools-reference/mcp-tools-reference.md`
- `scene-and-project/brainstorm-game/SKILL.md` — produces the brief that anchors the bible
- `rendering-and-lighting/art-direction/SKILL.md` — the visual counterpart; audio must rhyme with it
- `audio/audio-bus-setup/SKILL.md` (NEXT) — implements the bus layout in detail
- `audio/3d-spatial-audio/SKILL.md` (NEXT) — spatial attenuation patterns
- `audio/footstep-systems/SKILL.md` (NEXT) — material-aware footstep impl
- `audio/dynamic-music-stingers/SKILL.md` (LATER) — implements the dynamic music plan
