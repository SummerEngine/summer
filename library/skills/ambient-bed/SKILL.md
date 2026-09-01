---
name: ambient-bed
description: Use when generating a long looping location ambience — forest at dawn, dungeon air, city street, spaceship hum, cave drip. Non-melodic, low-energy, never draws attention. Wires as a looping AudioStreamPlayer on the Ambient bus with a marked seamless loop. Trigger on "ambient bed", "room tone", "background ambience", "forest ambience", "dungeon air", "make it sound like a cave".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: audio
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_generate_audio summer_search_assets summer_import_from_url summer_add_node summer_set_prop summer_inspect_node
paths: ["audio/ambient/**", "**/*.tscn", "**/*.import"]
---

# /ambient-bed — Long Looping Location Ambience

## Overview

An ambient bed is the *air* of a place. Forest at dawn, dungeon corridor, spaceship hum, market street, ocean cave. It plays at low energy under everything else — never melodic, never drawing attention, but its absence is immediately felt. Players don't notice an ambient bed; they notice the silence when you forget one.

This is **not** music. Use `summer_generate_audio({capability: 'sound_effects'})`, not `{capability: 'music'}`. SFX renders textures; Music renders melody. You want texture.

Generated at 15–22 seconds (the SFX duration ceiling) and looped with a Summer
Engine import loop point and optional crossfade.

## When to use

- Location bed for a level, room, biome, or zone.
- Background hum / drone under dialogue scenes.
- Atmosphere layer that complements a music track.

## When NOT to use

- Short event SFX (<5s) → `audio/sound-effect`.
- Music with melody / chord progression → `audio/music-track`.
- Voice barks → `audio/voice-line`.

## Steps

### 1. Read the audio bible

```
Read .summer/audio-bible.md
```

The bible's `Ambient layer` SFX class names the character — usually "continuous, low presence, no looping melody". Honor it. The mix rules sit ambient at the bus level the bible defined (typically `Ambient` bus around `-12 dB`).

### 2. Identify the location

Ask if it's not pinned by context:

> Which location's ambience? Be specific — "forest at dawn with light wind and distant birds" beats "outdoors". The model needs the time of day, the weather, and 2–3 sound sources.

### 3. Build the prompt — environment + time + weather + 2–3 sources + density + duration

ElevenLabs SFX renders ambient textures well when the prompt names sources, not vibes.

Prompts that work:

```
forest at dawn, gentle wind through leaves, distant bird calls every 6 seconds,
soft creaking branches, no music, no human sound, 22s seamless loop

stone dungeon corridor, distant water drip, low rumble, faint draft, no music,
no creature sound, 22s seamless loop

spaceship corridor, low hum at 60Hz, occasional electronic chirp, ventilation
whoosh, no human voices, 22s seamless loop

medieval marketplace at noon, distant chatter, footsteps on stone, occasional
horse, distant blacksmith hammer, no recognisable words, 22s loop

ocean cave, slow waves entering, low rumble, water drip echoes, no seagulls,
22s seamless loop

night swamp, crickets, distant owl, slow water lapping, occasional frog,
22s seamless loop

abandoned office building, fluorescent hum, distant air conditioning, faint
paper rustle from a vent, no human sound, 22s loop
```

Prompts that DON'T work:

| Bad prompt | Failure mode |
|---|---|
| `forest ambience` | No time / weather / sources. Returns generic forest with random energy spikes. |
| `creepy dungeon` | Vibe word, not a description. Model adds horror stings you don't want. |
| `peaceful background music` | Triggers musical interpretation. Use SFX-shaped prompts. |
| `loud bustling market` | Energy too high for a bed; use as a one-shot SFX layer instead. |
| `forest with wolves howling` | Wolf howl is an event, not a bed; promotes itself in the mix. |

### 4. Density — keep it low

A bed should be **boring**. Ask for sparse events.

- `every 6 seconds` rather than `often`.
- `occasional` not `frequent`.
- `distant` not `close`.
- `low` not `loud`.

If the user wants a busier bed (market, party), still prevent foreground events: `no recognisable words`, `no individual loud sounds`, `general crowd murmur`.

### 5. Generate at the duration ceiling

```
summer_generate_audio(
  capability: "sound_effects",
  text: "forest at dawn, gentle wind through leaves, distant bird calls every 6 seconds, soft creaking branches, no music, no human sound, 22s seamless loop",
  durationSeconds: 22
)
// Then: summer_import_from_url(url: "<fileUrl>", path: "res://audio/ambient/forest_dawn.wav")
```

`sound_effects` reads from **`text`**, not `prompt` — passing `prompt` is a 400 `text_required`. (`prompt` is the `music` capability's field.) The clip comes back as WAV, so a `.wav` target path is correct.

22s is the SFX ceiling. Always generate at the ceiling for ambient — longer cycle means less recognized repetition.

If the model returns a clip with a loud event near the start or end (a sudden bird right at 0:00), regenerate. That kills loop seamlessness.

### 6. Mark the seamless loop in Summer Engine's Import dock

This step is what makes the bed sound like a place rather than a 22-second sample.

WAV and MP3 use **different importers with different option names** — do not copy the MP3 block from `audio/music-track` here. The WAV importer has no `loop` / `loop_offset`; it has an `edit/loop_mode` enum plus sample-frame bounds.

In Summer Engine, select the `.wav` and open the Import dock:

| Setting | Value |
|---|---|
| Edit > Loop Mode | Forward |
| Edit > Loop Begin | 0 |
| Edit > Loop End | -1 (end of file) |

The `.import` file:

```
[params]
edit/loop_mode = 2
edit/loop_begin = 0
edit/loop_end = -1
```

`edit/loop_mode` is `0 = Detect From WAV, 1 = Disabled, 2 = Forward, 3 = Ping-Pong, 4 = Backward` — Forward is **2**, not 1. `edit/loop_begin` / `edit/loop_end` are integer sample frames, not seconds; to skip a 0.5 s fade-in artifact at 44.1 kHz set `edit/loop_begin = 22050`.

After changing, click `Reimport`.

### 7. Crossfade-loop pattern for seamlessness

ElevenLabs SFX returns are not gapless. Even with `loop = true`, you'll hear a tiny click on the loop point. Fix it with a two-player crossfade in code:

```gdscript
# scripts/audio/AmbientBed.gd
extends Node
@export var stream: AudioStream
@export var fade_seconds: float = 1.5
@export var bus: StringName = &"Ambient"
@export var volume_db: float = -12.0
var _a: AudioStreamPlayer
var _b: AudioStreamPlayer
var _active: AudioStreamPlayer

func _ready() -> void:
	_a = _make_player()
	_b = _make_player()
	_active = _a
	_active.play()
	_schedule_next()

func _make_player() -> AudioStreamPlayer:
	var p := AudioStreamPlayer.new()
	p.stream = stream
	p.bus = bus
	p.volume_db = volume_db
	add_child(p)
	return p

func _schedule_next() -> void:
	var len := stream.get_length()
	var t := get_tree().create_timer(len - fade_seconds)
	t.timeout.connect(_crossfade)

func _crossfade() -> void:
	var next := _b if _active == _a else _a
	next.volume_db = -60.0
	next.play()
	var tw := create_tween().set_parallel(true)
	tw.tween_property(next, "volume_db", volume_db, fade_seconds)
	tw.tween_property(_active, "volume_db", -60.0, fade_seconds)
	tw.chain().tween_callback(func() -> void: _active.stop())
	_active = next
	_schedule_next()
```

This eliminates the click and adds variation through phase-overlap (the loop overlaps itself by `fade_seconds` so the bed never repeats identically).

### 8. Wire the bed as `AudioStreamPlayer` on the Ambient bus

For most beds, non-positional is correct (the player is *in* the place; the bed isn't an emitter):

```
summer_add_node(scenePath="res://levels/level_01.tscn", parent="./Level", type="AudioStreamPlayer", name="AmbientBed")
summer_set_prop(scenePath="res://levels/level_01.tscn", path="./Level/AmbientBed", key="stream", value="res://audio/ambient/forest_dawn.wav")
summer_set_prop(scenePath="res://levels/level_01.tscn", path="./Level/AmbientBed", key="bus", value="Ambient")
summer_set_prop(scenePath="res://levels/level_01.tscn", path="./Level/AmbientBed", key="volume_db", value=-12.0)
summer_set_prop(scenePath="res://levels/level_01.tscn", path="./Level/AmbientBed", key="autoplay", value=true)
```

Or attach the script in step 7 to a Node, set its `stream` to the imported audio, and skip the `AudioStreamPlayer` node — the script provides its own.

For positional beds (ambience emitting from a fountain, a campfire, a vent) use `AudioStreamPlayer3D` with attenuation. The bible's `3D attenuation: inverse-square, 25m` rule applies.

### 9. Layer multiple beds for depth

Real places have layered ambiences. A forest at dawn might be:

- Bed A (loud): wind through leaves loop, `-12 dB`
- Bed B (medium): distant bird calls loop, `-18 dB`
- Bed C (occasional): one-shot SFX of a single bird call, fired by a Timer with random 8–20s interval

This is more expensive (3 generations) but produces a bed that doesn't sound like a 22-second loop. Reserve for hub locations or extended scenes.

## Reference card — prompts by environment

```
Forest dawn:        forest at dawn, gentle wind, distant birds every 6s,
                    creaking branches, 22s loop
Forest night:       forest at night, crickets, distant owl every 10s, soft
                    breeze, no music, 22s loop
Stone dungeon:      stone dungeon, distant water drip every 4s, low rumble,
                    faint draft, no creatures, 22s loop
Cave:               wet cave, water drip echoes, low air movement, distant
                    rumble, 22s loop
Spaceship:          spaceship corridor, 60Hz hum, occasional electronic chirp,
                    ventilation whoosh, no voices, 22s loop
Marketplace:        medieval marketplace at noon, distant chatter no recognisable
                    words, footsteps on stone, occasional horse, distant
                    blacksmith, 22s loop
Tavern:             medieval tavern interior, low chatter, fireplace crackle,
                    distant lute, occasional mug clink, 22s loop
Ocean cave:         ocean cave, slow waves, low rumble, water drip echoes,
                    no seagulls, 22s loop
Office:             empty office at night, fluorescent hum, distant AC,
                    faint paper rustle, 22s loop
Snowy plain:        snowy plain in wind, low howling wind, faint distant
                    branches, no music, no creatures, 22s loop
Underwater:         underwater, low rumble, distant bubbles, soft mid hum,
                    no marine life, 22s loop
Boss arena:         vast stone arena, low ominous drone, distant rumble,
                    occasional debris fall, no melody, 22s loop
```

## Anti-patterns

- **Using `summer_generate_audio({capability: 'music'})` for an ambient bed.** Music model adds melody. You don't want melody.
- **Foreground events in the bed.** A wolf howl, an explosion, a clear word — these promote themselves and the bed becomes annoying.
- **Bed louder than `-10 dB` on its bus.** Beds belong under everything; default is `-12 dB` to `-15 dB`.
- **No loop point set.** The clip plays once and silence follows.
- **Single-clip looping without crossfade.** Audible click every 22s.
- **Same bed everywhere.** Different rooms / biomes need different beds. The transition (room A → room B) is what sells the world.

## Edge cases

- **Bed too busy on regen.** Add `sparse`, `quiet`, `low`, `distant` to the prompt.
- **Bed has musical content you didn't ask for.** Add `no music, no melody, no chords`.
- **Bed has voices when you wanted abstract.** Add `no voices, no recognisable words`.
- **Loop click after import dock setup.** Use the crossfade script (step 7).
- **Need positional bed (a campfire crackle).** Use `AudioStreamPlayer3D` with `max_distance` matching the campfire's reasonable hearing radius (4–8m typical).
- **Multi-room transitions.** Use Areas; on player enter, fade in destination bed and fade out source bed over 1.5s.

## Fallback (no MCP)

Print the SFX prompt and the import dock settings. User runs via the Summer dashboard and imports manually.

## Handoff

> Bed `forest_dawn.wav` wired to `Level/AmbientBed`, looping with crossfade. Next:
> - Generate the night counterpart for time-of-day transitions.
> - Add a layered occasional bird-call SFX with a randomized Timer for depth.
> - For multi-room transitions, gate beds with Area3D triggers and fade with the same crossfade pattern.

## See also

- `audio/audio-direction` — defines the Ambient layer class
- `audio/sound-effect` — short event SFX layered over the bed
- `audio/music-track` — melodic music layered over the bed
- `audio/adaptive-music` — state-driven crossfades use the same pattern
