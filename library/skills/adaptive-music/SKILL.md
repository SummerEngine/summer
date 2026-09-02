---
name: adaptive-music
description: Use when wiring music stems to game state — combat / explore / boss / tension crossfades on a shared bus. Pairs generated stems with a state machine and AudioBus structure. Trigger on "adaptive music", "dynamic music", "music changes when combat starts", "layered music", "vertical music", "wire stems".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: audio
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_generate_audio summer_search_assets summer_import_from_url summer_add_node summer_set_prop summer_connect_signal summer_inspect_node summer_get_scene_tree summer_project_setting
paths: ["audio/music/**", "scripts/audio/**", "**/*.tscn", "default_bus_layout.tres"]
---

# /adaptive-music — Wire Stems to Game State

## Overview

This is the **wiring** skill, not the generation skill. The job is to take 3–5 music stems (or full tracks) and connect them to a game state machine so the music shifts as the player's situation changes — exploration → tension → combat → victory → exploration — with crossfades, ducking, and bus routing the player never consciously notices but always feels.

This skill assumes the stems already exist. If they don't, run `/music-track` first for each state, or generate matching stems (same tempo, same key, same bar count) so they layer/crossfade cleanly.

## When to use

- The audio bible specifies a dynamic music model (layered stems / vertical re-orchestration / horizontal sequencing).
- You have at least two music tracks for two different states and want the engine to switch between them.
- Player-state-driven crossfades, not random shuffling.

## When NOT to use

- Generating the stems themselves → `/music-track`.
- Single static loop with no state changes → `/music-track` and an `AudioStreamPlayer` is enough.

## Steps

### 1. Read the audio bible's dynamic music plan

```
Read .summer/audio-bible.md
```

Quote the plan back. Example:

> Bible plan: Layered stems. States CALM / TENSION / COMBAT / VICTORY. CALM → TENSION on enemy detect (2s crossfade). TENSION → COMBAT on first damage (instant drum stem). COMBAT → VICTORY on last enemy dies (drum cuts, brass swell). VICTORY → CALM after 4s. Music ducks `-6 dB` on dialogue.

If the plan is absent, run `/audio-direction` step 6 first.

### 2. Pick the wiring model

| Model | When | Implementation |
|---|---|---|
| **Horizontal sequencing** | 3–5 full tracks, one per state, crossfade | One `AudioStreamPlayer` per track on the `Music` bus, tween volumes on state change |
| **Layered stems** | One base loop + drum/brass/strings stems that turn on with intensity | All stems play simultaneously at silence; mute/unmute via volume tween |
| **Vertical re-orchestration** | Same melody, different orchestration per state, snap on bar | All variants play simultaneously muted; swap on next bar boundary |
| **Procedural / generative** | Rules generate music in real-time | Beyond this skill; needs a custom system |

For 90% of indie games, **horizontal sequencing** is correct. It's cheaper to author, easier to swap, and players don't notice the difference.

### 3. Confirm stems exist (or generate them)

```
summer_search_assets(query="music", assetType="music", source="all")
```

You need (typical case):

- `audio/music/calm.mp3` — exploration loop, sparse
- `audio/music/tension.mp3` — same tempo/key, denser, no drums
- `audio/music/combat.mp3` — same tempo/key, full drums, urgent
- (optional) `audio/music/boss.mp3` — distinct from combat
- (optional) `audio/music/victory.mp3` — short linear sting (4–8s)

If any are missing, run `/music-track` for each. Critically: **same BPM, same key, same time signature, same bar length** so they overlap cleanly.

### 4. Verify / extend the bus layout

The Music bus must exist and route to Master. If `/audio-direction` ran, it does. Verify:

```
Read default_bus_layout.tres   # or wherever the project stores it
```

You want this structure:

```
Master
├── Music         (-8 dB; ducks -6 dB when Voice is active)
├── SFX           (0 dB; routes to Reverb buses)
├── UI            (-3 dB)
├── Voice         (0 dB)
├── Ambient       (-12 dB)
├── Reverb_Small
├── Reverb_Large
└── Reverb_Outdoor
```

If `Music` bus is missing, run `/audio-direction` step 8.

For ducking, add a sidechain compressor on the `Music` bus with the `Voice` bus as the sidechain source. Or implement ducking in code (simpler — see step 7).

### 5. Build the player rig

For horizontal sequencing, instantiate one `AudioStreamPlayer` per state, all on the Music bus, all autoplay, all looping, all starting at `-60 dB` except the active state:

```
summer_add_node(scenePath="res://main.tscn", parent="./Music", type="AudioStreamPlayer", name="Calm")
summer_set_prop(scenePath="res://main.tscn", path="./Music/Calm", key="stream", value="res://audio/music/calm.mp3")
summer_set_prop(scenePath="res://main.tscn", path="./Music/Calm", key="bus", value="Music")
summer_set_prop(scenePath="res://main.tscn", path="./Music/Calm", key="volume_db", value=0.0)
summer_set_prop(scenePath="res://main.tscn", path="./Music/Calm", key="autoplay", value=true)

summer_add_node(scenePath="res://main.tscn", parent="./Music", type="AudioStreamPlayer", name="Tension")
summer_set_prop(scenePath="res://main.tscn", path="./Music/Tension", key="stream", value="res://audio/music/tension.mp3")
summer_set_prop(scenePath="res://main.tscn", path="./Music/Tension", key="bus", value="Music")
summer_set_prop(scenePath="res://main.tscn", path="./Music/Tension", key="volume_db", value=-60.0)
summer_set_prop(scenePath="res://main.tscn", path="./Music/Tension", key="autoplay", value=true)

summer_add_node(scenePath="res://main.tscn", parent="./Music", type="AudioStreamPlayer", name="Combat")
summer_set_prop(scenePath="res://main.tscn", path="./Music/Combat", key="stream", value="res://audio/music/combat.mp3")
summer_set_prop(scenePath="res://main.tscn", path="./Music/Combat", key="bus", value="Music")
summer_set_prop(scenePath="res://main.tscn", path="./Music/Combat", key="volume_db", value=-60.0)
summer_set_prop(scenePath="res://main.tscn", path="./Music/Combat", key="autoplay", value=true)
```

Every scene-mutating tool takes an explicit `scenePath`; node paths are relative to that scene's root (`./`), not absolute `/root/...` runtime paths; and the property argument is named `key`, not `property`.

All three play simultaneously, in sync, but only one is audible. State transitions tween volumes — the music never restarts, only fades.

This is why same BPM / same key / same bar length matter: all three are at the same playhead at all times.

### 6. The MusicDirector script

```gdscript
# scripts/audio/MusicDirector.gd
class_name MusicDirector
extends Node

enum State { CALM, TENSION, COMBAT, VICTORY, BOSS }

@export var calm: AudioStreamPlayer
@export var tension: AudioStreamPlayer
@export var combat: AudioStreamPlayer
@export var boss: AudioStreamPlayer
@export var victory_sting: AudioStreamPlayer  # one-shot, not looping

@export var crossfade_seconds: float = 2.0
@export var instant_states: Array[State] = [State.COMBAT]  # snap, no fade
@export var active_db: float = 0.0
@export var inactive_db: float = -60.0

var _state: State = State.CALM
var _tween: Tween

func _ready() -> void:
	_apply_state(_state, true)

func set_state(new_state: State) -> void:
	if new_state == _state:
		return
	var instant := new_state in instant_states
	_state = new_state
	_apply_state(new_state, instant)
	if new_state == State.VICTORY:
		victory_sting.play()
		await get_tree().create_timer(4.0).timeout
		set_state(State.CALM)

func _apply_state(state: State, instant: bool) -> void:
	if _tween and _tween.is_valid():
		_tween.kill()
	_tween = create_tween().set_parallel(true)
	var dur := 0.0 if instant else crossfade_seconds
	for pair in [
		[calm,    state == State.CALM],
		[tension, state == State.TENSION],
		[combat,  state == State.COMBAT],
		[boss,    state == State.BOSS],
	]:
		var player: AudioStreamPlayer = pair[0]
		var should_be_active: bool = pair[1]
		if player == null:
			continue
		var target_db := active_db if should_be_active else inactive_db
		_tween.tween_property(player, "volume_db", target_db, dur)
```

Attach it under `/root/Game/Music`, hook the exported player slots to the four players. The director is the single point of truth for music state.

### 7. Drive state from gameplay signals

Where does `set_state()` get called from? The game state machine. Hook signals from combat / detection / encounter logic:

```gdscript
# scripts/audio/MusicHooks.gd
extends Node
@export var director: MusicDirector

func _ready() -> void:
	EventBus.enemy_detected_player.connect(_on_tension)
	EventBus.player_took_damage.connect(_on_combat)
	EventBus.encounter_cleared.connect(_on_victory)
	EventBus.boss_started.connect(_on_boss)
	EventBus.boss_ended.connect(_on_calm)
	EventBus.dialogue_started.connect(_on_duck)
	EventBus.dialogue_ended.connect(_on_unduck)

func _on_tension() -> void: director.set_state(MusicDirector.State.TENSION)
func _on_combat()  -> void: director.set_state(MusicDirector.State.COMBAT)
func _on_victory() -> void: director.set_state(MusicDirector.State.VICTORY)
func _on_boss()    -> void: director.set_state(MusicDirector.State.BOSS)
func _on_calm()    -> void: director.set_state(MusicDirector.State.CALM)

func _on_duck() -> void:
	var bus_idx := AudioServer.get_bus_index(&"Music")
	create_tween().tween_method(
		func(db: float) -> void: AudioServer.set_bus_volume_db(bus_idx, db),
		AudioServer.get_bus_volume_db(bus_idx), -14.0, 0.3
	)

func _on_unduck() -> void:
	var bus_idx := AudioServer.get_bus_index(&"Music")
	create_tween().tween_method(
		func(db: float) -> void: AudioServer.set_bus_volume_db(bus_idx, db),
		AudioServer.get_bus_volume_db(bus_idx), -8.0, 0.5
	)
```

If your project doesn't have an `EventBus` autoload yet, add one — adaptive music depends on event-driven signals, not polling.

Wire the connections via `summer_connect_signal` so they survive a scene reload.

### 8. Layered stems variant (alternative to step 6)

If the bible says **layered stems** instead of horizontal sequencing, the rig is the same (multiple `AudioStreamPlayer`s, all looping in sync, all on Music bus) but the volume map is different:

| State | Base | Drums | Strings | Brass |
|---|---|---|---|---|
| CALM | 0 | -60 | -60 | -60 |
| TENSION | 0 | -60 | -10 | -60 |
| COMBAT | 0 | 0 | -3 | -10 |
| BOSS | -60 | 0 | 0 | 0 |

The director method is the same `_apply_state` pattern — just more players and per-player target_db tables.

### 9. Bar-locked snap (vertical re-orchestration)

For the third model, snapping must happen on a bar boundary (not mid-phrase). All players run in sync; on state change, schedule the snap for the next bar:

```gdscript
const BPM := 128.0
const BEATS_PER_BAR := 4
const SECONDS_PER_BAR := (60.0 / BPM) * BEATS_PER_BAR

func snap_at_next_bar(callable: Callable) -> void:
	var pos := calm.get_playback_position()
	var into_bar := fmod(pos, SECONDS_PER_BAR)
	var wait := SECONDS_PER_BAR - into_bar
	get_tree().create_timer(wait).timeout.connect(callable)
```

Use this for boss reveals, story beats — anywhere a snap-on-bar is more dramatic than a crossfade.

### 10. Test the transitions

Run the game (`summer_play`) and trigger each transition. Listen for:

- Crossfade artifacts at `crossfade_seconds = 2.0`. Too fast: fades are choppy. Too slow: state changes feel disconnected from gameplay.
- Out-of-sync stems. If combat enters and the drums hit on the wrong beat, the stems weren't generated at the same BPM/bar length. Regenerate.
- Ducking that's too aggressive (music disappears) or too subtle (voice still buried). The `-6 dB` is a starting value; tune in step 7.
- Victory sting that loops (it shouldn't). Set `victory_sting` to a non-loop AudioStream.

### 11. Edge case: scene transitions

When the player changes scenes, the `MusicDirector` either:

a) **Persists** as an autoload. New scenes call `MusicDirector.set_state()` to take over.
b) **Per-scene**, fades out the previous before the scene changes (`set_state(CALM)` then crossfade to `-60 dB` on all then change scene).

Persistent is preferred for open-world; per-scene for level-based games.

## Reference card — bus map

```
Master
├── Music          -8 dB         (ducks to -14 dB on Voice)
│   └── (one AudioStreamPlayer per state, all looping in sync)
├── SFX            0 dB
│   └── routes to Reverb_Small / Reverb_Large / Reverb_Outdoor sends
├── UI             -3 dB
├── Voice          0 dB
├── Ambient        -12 dB
├── Reverb_Small   (return)
├── Reverb_Large   (return)
└── Reverb_Outdoor (return)
```

## Anti-patterns

- **Stems generated at different BPM/key.** They will not crossfade cleanly. Same BPM, same key, same bar count.
- **Restarting tracks on state change.** Players hear the restart and the magic dies. Always crossfade volumes; never `play()` mid-state.
- **No autoplay on the silent stems.** They can't fade in to phase if they never started.
- **Polling state in `_process`.** Use signals. Music director listens to `EventBus`, not to game state every frame.
- **Hardcoding volumes in `set_state`.** Use the table-driven `_apply_state` so adding a new state doesn't fork the function.
- **Ducking music to silence on dialogue.** The bible says `-6 dB` (so music drops from `-8` to `-14`), not muted. Voice should sit on a present bed, not a dead one.
- **Boss music as a louder combat track.** Distinct, named instrument; ideally different tempo or key. The bible's `Boss music is its own track` rule.

## Edge cases

- **Player triggers TENSION → COMBAT in 0.2s.** The `instant_states = [State.COMBAT]` makes COMBAT snap so it lands on the swing connect. The intermediate fade is wrong — combat must feel immediate.
- **Player flees combat back to TENSION → CALM.** Use the regular `crossfade_seconds = 2.0`; the de-escalation can breathe.
- **Multiple enemies aware → one dies → none aware.** The state machine should hysteresis: only fall back to CALM after `no_enemies_aware AND no_recent_damage_for=8s`.
- **Audio service not ready on `_ready`.** If `AudioServer.get_bus_index("Music")` returns `-1`, the bus layout failed to load. Verify `default_bus_layout.tres`.
- **Stems generated at 60s but you want a 5-minute combat.** They loop. Crossfade is volume-only, not time-based, so loops are invisible to the director.

## Fallback (no MCP)

Print the bus layout, node tree, and GDScript. The user constructs it manually
in Summer Engine.

## Handoff

> MusicDirector wired. Calm / Tension / Combat play in sync, only one audible. State driven by `EventBus`. Music ducks `-6 dB` on dialogue. Next:
> - Run `summer_play` and trigger each transition; listen for sync issues.
> - If COMBAT lands on the wrong beat, the stems are off-tempo — regenerate via `/music-track` with identical BPM and bar count.
> - For boss-specific music, generate `boss.mp3` with `/music-track` and the director picks it up automatically.

## See also

- `audio/audio-direction` — defines the dynamic music plan and bus layout
- `audio/music-track` — generates the stems
- `audio/voice-line` — the voice bus that triggers ducking
- `../../references/godot-version/godot-version.md` — Summer compatibility for AudioServer
  and Tween APIs
