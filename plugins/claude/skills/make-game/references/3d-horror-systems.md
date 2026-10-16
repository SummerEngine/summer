# 3D Horror - Systems

The dread machinery on top of `3d-horror.md`: the tension-driven atmosphere
controller, the stalker AI, procedural audio, interactables, and the escape
objective chain.

## Atmosphere controller (tension in, dread out)

One Node3D in the level reads `GameManager.tension_level` and escalates
three channels. It auto-discovers OmniLights from a sibling "Lights" node
and creates 4 roaming AudioStreamPlayer3D emitters (Ambient bus, max
distance 20).

### Flickering lights

Per-frame chance `0.005 * (1.0 + tension)` per light. A flicker is a tween
of 2-5 random off/on cycles (off 0.02-0.08s at energy 0-0.3, on 0.02-0.1s
at 50-100%), then restore. Random durations - regular flicker reads as a
broken script, not a broken light.

### Positional ambient sounds

Every 15-45s (interval shrinks to half at max tension), one emitter
teleports to a random point around the player
(x/z +-15, y 0-5 - behind walls, above the ceiling) and plays from a pool
that GROWS with tension:

- base: door close, pipe stress, wind vent
- tension > 0.3: + creature whisper
- tension > 0.5: + distant scream
- tension > 0.7: + creature growl

Random volume -12..-4 dB and pitch 0.7-1.3 so nothing repeats exactly.

### Tension events

Every 30s at base, down to ~12s at max tension, pick one of FIVE:
0 = flicker all lights, 1 = audio stinger + tension +0.05, 2 = brief
darkness, 3 = extra ambient sound, 4 = NOTHING. The nothing case is
deliberate - a scare that never comes after buildup is the horror.

Brief darkness: tween all lights to energy 0.05 over 0.5s, hold a random
0.5-2s, restore over 0.3s, tension +0.08. Save original energies first.

## Stalker AI

A solid-black unshaded capsule (CapsuleMesh r 0.2 h 2.2, albedo 0.01 -
reads as a silhouette in any lighting). Mesh and collision built at
runtime, no assets. Core mechanic: it only moves when you are NOT looking.

```gdscript
func _process_showing(delta: float) -> void:
	look_at(Vector3(player.global_position.x, global_position.y, player.global_position.z))
	var to_me := (global_position - player.global_position).normalized()
	var player_fwd := -player.global_transform.basis.z.normalized()
	var angle := rad_to_deg(acos(clampf(player_fwd.dot(to_me), -1.0, 1.0)))
	if angle < 20.0:
		# player looking directly: freeze and stare back
		stare_timer += delta
		if stare_timer >= stare_time:      # 2.0s of being watched
			_disappear()
	else:
		stare_timer = 0.0
		var dir := (player.global_position - global_position).normalized()
		dir.y = 0.0
		velocity = dir * approach_speed    # 1.5 m/s
		move_and_slide()
		if global_position.distance_to(player.global_position) < catch_distance:  # 1.5m
			AudioManager.play_sfx(ProceduralAudio.get_creature_screech(), 0.0)
			GameManager.set_state(GameManager.GameState.GAME_OVER)
```

Pacing rules (tuned, keep them):

- First appearance at 15s - the player needs time to find the flashlight.
- Reappear interval starts 18s, shrinks 15% per appearance, floor 8s:
  `reappear_interval = maxf(reappear_interval * 0.85, 8.0)`.
- Spawn selection: from a hand-placed spawn-point list, pick the FARTHEST
  point that is between 6m and 18m from the player. Under 6m is unfair -
  no time to react.
- On appear: whisper from its own 3D emitter + low-pitched stinger
  (pitch 0.5-0.8) + tension +0.1.
- Fully idle while `GameManager.is_reading_note` or state != PLAYING -
  notes are safe rooms.
- After `stare_time` of being watched it vanishes (visible = false) and
  the wait timer restarts. Player-facing check is a dot-product cone of
  20 degrees, not a raycast - cheap and good enough.

## Procedural audio

`ProceduralAudio` is a static class generating every sound from math into
cached AudioStreamWAVs - zero audio files; swap in recordings later
without touching call sites. Catalog: footsteps (4 variations),
door open/close/locked, ambient drone (detuned 40Hz sines, looping),
tension hit (sub boom + metallic ring), pickup chime, creature
whisper/growl/screech, heartbeat, distant scream, water drip, machinery
hum, wind vent, fluorescent buzz, pipe stress, radio static.

Generation pattern all sounds follow (16-bit, 22050 Hz):

```gdscript
static func _generate_example() -> void:
	var num_samples := int(duration * SAMPLE_RATE)
	var samples := PackedByteArray()
	samples.resize(num_samples * 2)
	for s in num_samples:
		var t := float(s) / SAMPLE_RATE
		var envelope := exp(-t * 3.0)
		var value := sin(t * 440.0 * TAU) * envelope * 0.3
		var sample := clampi(int(value * 16000), -32768, 32767)
		samples[s * 2] = sample & 0xFF
		samples[s * 2 + 1] = (sample >> 8) & 0xFF
	_stream = AudioStreamWAV.new()
	_stream.format = AudioStreamWAV.FORMAT_16_BITS
	_stream.mix_rate = SAMPLE_RATE
	_stream.data = samples
	# looping sounds: loop_mode = LOOP_FORWARD, loop_begin = 0, loop_end = num_samples
```

Recipes that matter: creature sounds = low fundamentals (30Hz growl) +
inharmonic partials; whispers/screams = filtered noise; drones = slightly
detuned sine pairs (beating); always exponential envelopes.

## Interactables

Same duck-typed interface as 3d-fps: `interact(player)` +
`get_interaction_prompt() -> String`, found by the InteractionRay (mask 4).

### HorrorDoor

Node3D rotating on Y, hinge at the parent origin (mesh offset
(0.5, 1.4, 0)), lerp `rotation.y` toward target at open_speed. Opens away
from the player (approach-side check). Horror-specific exports:

- `required_key`: locked until `GameManager.has_item(key)`; unlocking
  consumes the key. Locked interaction plays a rattle - +-2 degree shake
  tween + locked sound. Prompt: "Locked" / "Unlock" / "Open" / "Close".
- `auto_close_delay`: door closes itself behind the player (room traps).
- `creepy_auto_open`: opens by itself ONCE after a delay - cheapest scare
  in the kit.

### InteractableItem

RigidBody3D with `freeze = true`, bob + rotate idle (randomized phase),
per-type runtime mesh + OmniLight3D glow:

| Type | Effect | Visual |
|---|---|---|
| KEY | `add_item(item_id)` | gold box, warm glow |
| FLASHLIGHT | `player.pickup_flashlight()` | gray cylinder, amber glow |
| NOTE | `open_note(id, text)` - NOT consumed | paper-white flat box |
| BATTERY | battery +30 (cap 100) | dark blue box, blue glow |

Everything except notes `queue_free()`s on pickup.

### EscapeZone

Area3D (mask 1) at the exit with a green OmniLight beacon. On player
enter: with the exit key -> `set_state(ESCAPED)`; without it -> open a
note ("The door is chained from the outside. I need a key.") - the
rejection delivers story instead of a dead trigger.

## Objective chain

The loop is explore -> find -> unlock -> escape:

1. Spawn in entry area, find flashlight.
2. Main hall, Note 1 hints at the storage key.
3. Side corridor -> office -> storage key.
4. Storage room (locked) -> exit key.
5. Back corridor (darkest) -> escape zone with exit key -> ESCAPED.

The whole chain is data: `required_key` on doors, `item_id` on pickups,
`required_key` on the EscapeZone, and note texts for direction. Re-theme a
level by editing strings, not code. Keys live in dead ends so the stalker
gets backtracking time; notes double as the hint system - no quest UI.

## Escalation timeline (why it works)

Minute 1: quiet, base ambient sounds, flashlight secured. Minute 2-3:
first stalker appearance, whispers join the pool. Mid-game: battery
pressure, screams, shorter stalker gaps, brief-darkness events. Endgame:
tension near 1.0 - vignette closed in, breathing sway, growls, stalker
every 8s, in the darkest corridor with the exit key. All of it falls out
of one passive float plus event spikes; tune the drain rate, the
reappear floor, and ambient intervals - not scripted scares.
