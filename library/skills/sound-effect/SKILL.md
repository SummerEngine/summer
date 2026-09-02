---
name: sound-effect
description: Use when generating short SFX one-shots — footsteps, weapon swings, UI clicks, hit impacts, environmental cues. Wires the resulting clip as an AudioStreamPlayer / 2D / 3D and auto-frees on finished. Trigger on "make a sword swing sound", "generate a UI click", "I need a footstep", "add a hit sound", "spawn an SFX".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: audio
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_generate_audio summer_search_assets summer_import_from_url summer_add_node summer_set_prop summer_inspect_node summer_get_scene_tree
paths: ["audio/sfx/**", "scripts/**", "**/*.tscn"]
---

# /sound-effect — Generate a Short SFX One-Shot and Wire It

## Overview

This skill produces one named SFX clip aligned with the audio bible's vocabulary, then wires it into the scene as an AudioStreamPlayer that plays once and frees its parent (or stops cleanly if it's a looped texture). The shape of the prompt is what makes the difference between "metal sword swing whoosh, dry, sharp, 250ms" returning the right clip on the first try and "epic battle sound" returning twenty seconds of musical noise.

ElevenLabs SFX (the `sound_effects` capability of `summer_generate_audio`) is *literal*. It treats the prompt as a description of a real sound, not as a vibe. Concrete material + action + intensity beats adjectives every time.

## When to use

- One-shot SFX: footstep, swing, click, hit, impact, pickup, jump, land, door, breath.
- Short loops < 2s: hum, drone snippet, rain texture (for very short looping ambients prefer `audio/ambient-bed`).
- Replacing a placeholder beep with something on-bible.

## When NOT to use

- Music or musical stings → `audio/music-track`.
- Long location ambience (>5s) → `audio/ambient-bed`.
- Voice / dialogue → `audio/voice-line`.
- Defining the *vocabulary* of SFX — that's `audio/audio-direction`. This skill executes against an existing bible.

## Steps

### 1. Read the audio bible

```
Read .summer/audio-bible.md
```

If it doesn't exist, ask:

> No audio bible at `.summer/audio-bible.md`. Want to run `/audio-direction` first to define the SFX vocabulary, or shall I just one-shot this with sensible defaults?

The bible defines an SFX *class* (UI, Pickup positive, Damage, Footstep, Attack, Stinger, Ambient layer, Pickup neutral). Map the user's request to a class. Quote the class's character and DON'Ts back so the prompt obeys them.

### 2. Search for an existing clip first

Generation is metered. Reuse beats regenerate.

```
summer_search_assets(query="<class> <subject>", assetType="audio", source="all")
```

If something fits, ask:

> Found `audio/sfx/sword_swing_01.wav`. Use this, or generate fresh?

### 3. Build the prompt — subject + material + action + intensity + duration cue

ElevenLabs SFX responds to literal sound descriptions. Pattern:

```
<subject> <material> <action>, <intensity>, <character>, <duration cue>
```

Working examples (these produce the right clip on the first try):

| Goal | Prompt that works | Why |
|---|---|---|
| Sword swing | `metal sword swing whoosh, dry, sharp, 250ms` | material + action + dry rules out reverb |
| UI click | `soft woody UI click, short, neutral pitch, 80ms` | material + duration; "click" alone is too vague |
| Footstep on stone | `single footstep on dry stone, leather sole, mid-weight, 180ms` | surface + footwear + body weight |
| Player hit | `punchy low-mid body hit impact, slight detune, no tail, 200ms` | "no tail" kills reverb the bible forbids |
| Coin pickup | `bright metallic coin pickup, warm major-third interval, 300ms, light room reverb` | named interval = melodic shape |
| Door creak open | `old wooden door creak opening slowly, 1.2s, dry interior` | duration + space |
| Bow draw | `recurve bow draw, taut string, leather grip, 600ms` | material specificity |
| Magic cast | `short ice magic cast, crystalline shimmer, ascending, 500ms` | element + pitch motion |

Prompts that DON'T work (and why):

| Bad prompt | Failure mode |
|---|---|
| `epic sword sound` | "Epic" is a vibe; the model can't render a vibe. Returns generic noise. |
| `cool UI click` | No material, no duration. Returns a 5-second synth blip. |
| `the sound when the player gets hit really hard and falls down` | Multiple events. Model tries to render all and returns nothing coherent. Split into two SFX. |
| `swoosh` | Underspecified. Returns inconsistent character every regen. |
| `realistic gunshot` | "Realistic" is a constraint, not a description. Use `9mm pistol shot, indoor, sharp crack, short tail, 400ms`. |

### 4. Confirm and call

Show the prompt and the call before running:

> Prompt: `metal sword swing whoosh, dry, sharp, 250ms`. Duration 0.5s (model floor). Model: ElevenLabs SFX. Cost: ~1 credit. Generate?

The `sound_effects` capability reads the description from **`text`**, not `prompt`. Passing `prompt` here is a 400 `text_required` — `prompt` is only for the `music` capability.

```
summer_generate_audio(
  capability: "sound_effects",
  text: "metal sword swing whoosh, dry, sharp, 250ms",
  durationSeconds: 0.5
)
// Then: summer_import_from_url(url: "<fileUrl>", path: "res://audio/sfx/sword_swing_01.wav")
```

`durationSeconds` floor is 0.5, ceiling is 22. If the user wants a 100ms click, generate 0.5s and the player only plays the front; or trim in the engine.

SFX comes back as **WAV**, not MP3 — Summer requests raw PCM from the provider, trims the model's lead-in silence, applies short anti-click fades, and emits a 16-bit mono WAV. A `.wav` target path is therefore correct, and the usual "ElevenLabs one-shots start with dead air" problem is already handled upstream.

### 5. Decision: one-shot vs loop

| Use case | Setup |
|---|---|
| Footstep, swing, click, hit | One-shot AudioStreamPlayer, `autoplay=false`, fired by code or animation. |
| Short hum / drone < 2s | Set the imported `AudioStream` `loop=true` in the import dock. |

For one-shots, set `Loop` OFF on the import. Default ElevenLabs returns are not loop-clean — looping a one-shot will click.

### 6. Wire it into the scene

Choose the right player node:

| Node | Use for |
|---|---|
| `AudioStreamPlayer` | UI, music, non-positional (HUD click, menu confirm) |
| `AudioStreamPlayer2D` | 2D positional (top-down hit, 2D pickup) |
| `AudioStreamPlayer3D` | 3D positional (footstep on a 3D character, weapon swing in world) |

Add it under the emitting node:

Every scene-mutating tool takes an explicit `scenePath`, node paths are relative to the scene root (`./`), and the property argument is named `key`, not `property`:

```
summer_add_node(scenePath="res://main.tscn", parent="./Player", type="AudioStreamPlayer3D", name="SwingSFX")
summer_set_prop(scenePath="res://main.tscn", path="./Player/SwingSFX", key="stream", value="res://audio/sfx/sword_swing_01.wav")
summer_set_prop(scenePath="res://main.tscn", path="./Player/SwingSFX", key="bus", value="SFX")
summer_set_prop(scenePath="res://main.tscn", path="./Player/SwingSFX", key="volume_db", value=0.0)
summer_set_prop(scenePath="res://main.tscn", path="./Player/SwingSFX", key="max_distance", value=25.0)
summer_set_prop(scenePath="res://main.tscn", path="./Player/SwingSFX", key="attenuation_model", value=0)
```

Bus name must match the bible (`SFX`, `UI`, `Ambient`, etc.). If the bus doesn't exist, run `/audio-direction` step 8.

### 7. Spawn-and-free pattern (one-shots in flight)

For SFX that needs to outlive the emitter (player dies but the death-blow SFX should finish), instantiate a small scene with this script:

```gdscript
# scripts/audio/SfxOneShot.gd
extends AudioStreamPlayer3D

func _ready() -> void:
	finished.connect(queue_free)
	play()
```

Save it as a `.tscn`, then `summer_instantiate_scene(scenePath, parent, scene, name)` to place it. Note this only wires the node into a scene at author time — spawning one per event at the emitter's runtime position is a job for GDScript (`preload(...).instantiate()` + `add_child`), not for an MCP call. The node frees itself when the stream finishes — no leaks.

### 8. Volume calibration

If the clip comes back too quiet:

- First try `volume_db` on the player (+3 to +9 typical).
- If still quiet, the clip itself is hot-low — regenerate with a louder intensity word: `loud`, `forceful`, `heavy`.
- Never push `volume_db` past +12; clipping artifacts.

If it comes back too loud (rare): negative `volume_db`, or trim attack in an editor.

### 9. Confirm in scene

```
summer_inspect_node(path="/root/Game/Player/SwingSFX")
```

Verify `stream`, `bus`, `volume_db`. Trigger it via `summer_play` if the user wants to hear it now.

## Reference card — prompt patterns by class

```
UI click:        soft woody UI click, neutral pitch, 80ms
UI confirm:      affirmative UI chime, warm minor-third, 250ms
UI error:        flat UI buzz, slight dissonance, 200ms
Pickup positive: bright pickup, ascending major-third, 300ms, light reverb
Pickup neutral:  small tactile pickup, no melody, 150ms
Footstep wood:   single footstep on hollow wood floor, leather sole, 180ms
Footstep grass:  single footstep on damp grass, soft, 200ms
Footstep stone:  single footstep on dry stone, mid-weight, 180ms
Hit body:        punchy body hit, low-mid thump, no tail, 200ms
Hit metal:       metal-on-metal clang, sharp transient, short ring, 350ms
Swing whoosh:    fast air whoosh from a swung blade, dry, 250ms
Door creak:      old wooden door creak opening, 1.2s, dry interior
Magic ice:       crystalline ice cast, ascending shimmer, 500ms
Magic fire:      whoosh of fire ignition, low rumble, 700ms
Stinger event:   short triumphant brass stinger, 1.5s, hall reverb
```

## Anti-patterns

- **Adjective-only prompts.** `epic`, `cool`, `realistic`, `professional` — meaningless to the model.
- **Multiple events in one prompt.** Split into two generations.
- **Looping a non-loop-clean clip.** Will click. Use `audio/ambient-bed` for actual loops.
- **Skipping the bus.** Default bus is `Master`. SFX must route to the `SFX` bus or the mix breaks.
- **Generating before searching.** Reuse before regenerate.
- **Generating before reading the bible.** The clip will fight the rest of the audio.

## Edge cases

- **Clip too quiet:** `volume_db` first; regenerate with louder intensity word second.
- **Clip too long:** trim in audio editor or set `AudioStreamPlayer` to `stop()` on a timer.
- **Footstep needs surface variants:** generate one per material (wood / stone / grass / metal / dirt) and switch in code based on raycast on the floor's `physics_material`.
- **SFX for an animation event:** wire to the animation's `Call Method Track`, not to `_process`.

## Fallback (no MCP)

Print the call:

```
ElevenLabs SFX prompt: "metal sword swing whoosh, dry, sharp, 250ms"
Duration: 0.5s
Save to: audio/sfx/sword_swing_01.wav
```

Tell the user to run it via the Summer dashboard, then `summer_import_from_url` the result.

## Handoff

After the SFX is wired:

> SFX `sword_swing_01.wav` wired to `Player/SwingSFX` on the `SFX` bus. Next:
> - Trigger it from your attack animation's `Call Method Track` → `play()`.
> - Generate the parry / clash counterpart with `/sound-effect` again.
> - For a full footstep system across surfaces, see `audio/footstep-systems`.

## See also

- `audio/audio-direction` — defines the vocabulary this skill obeys
- `audio/ambient-bed` — long looping textures
- `audio/music-track` — music
- `audio/voice-line` — TTS
- `../../references/mcp-tools-reference/mcp-tools-reference.md`
- `../../references/godot-version/godot-version.md` — Summer compatibility for audio nodes
