# 3D Horror - Core

First-person horror blueprint: game state, the vulnerable-player controller,
flashlight mechanics, level building, lighting, and the minimal HUD. The
stalker AI, tension/atmosphere system, procedural audio, and interactables
live in `3d-horror-systems.md`.

The player scene reuses the 3d-fps hierarchy and controller (yaw on root,
pitch on Head, two crouch shapes, headbob) - see `3d-fps.md`. This file
covers what horror changes.

## Design law: vulnerability

No weapon, ever. The flashlight is the only tool. The moment the player can
fight back it becomes an action game. No health bar, no minimap, no kill
counter - the HUD shows only battery, interaction prompt, and notes.

## Minimum playable base (build this first)

One dark room + flashlight pickup + a locked door + the key that opens it.
Prove "dark, need the light, find key, open door" before any AI or
atmosphere exists.

## Autoloads

Two: GameManager and AudioManager, both `process_mode = PROCESS_MODE_ALWAYS`.

GameManager is the single source of truth:

```gdscript
enum GameState { MENU, PLAYING, PAUSED, GAME_OVER, ESCAPED }

var inventory: Array[String] = []
var notes_found: Array[String] = []
var has_flashlight: bool = false
var flashlight_battery: float = 100.0
var doors_unlocked: Array[String] = []
var tension_level: float = 0.0        # 0 calm .. 1 max
var is_reading_note: bool = false
```

- `set_state()` pauses the tree for PAUSED/GAME_OVER/ESCAPED, unpauses on
  PLAYING, and force-closes any open note on leaving PLAYING.
- Tension rises passively 0.005/sec while PLAYING; systems spike it via
  `increase_tension(amount)`. Everything atmospheric reads this one float.
- Note reading is a modal state: while `is_reading_note`, the player
  controller AND the stalker both stand down (safe reading).
- Inventory is just string ids: `add_item` / `has_item` / `remove_item`;
  `open_note(id, text)` / `close_note()` emit signals the HUD listens to.

AudioManager: 8 pooled AudioStreamPlayers on an "SFX" bus, dedicated
ambient + music players on an "Ambient" bus, buses created at runtime via
`AudioServer.add_bus()` if missing. `play_ambient` crossfades from -40dB.
Bus separation is mandatory - you cannot balance or add reverb/low-pass
later without it.

## Player controller (horror deltas from 3d-fps)

- Walk 3.0 / sprint 5.0 / crouch 1.5 (slow = vulnerable; FPS-speed movement
  kills dread).
- gravity_multiplier 1.5 - heavier, grounded.
- ALL input gated on `GameManager.current_state == PLAYING` in both
  `_unhandled_input` and `_physics_process` - frozen during notes, pause,
  game over.
- Extra child under Camera3D: Flashlight (SpotLight3D at (0.15, -0.1, -0.1),
  hidden until picked up) + FlashlightDust (GPUParticles3D).
- Input map adds `flashlight` (F); no shoot/aim/reload.
- Footsteps route through the procedural audio footstep with random pitch.

### Flashlight (the core mechanic)

```gdscript
func _handle_flashlight_drain(delta: float) -> void:
	if not flashlight_on:
		return
	GameManager.flashlight_battery -= flashlight_drain_rate * delta / 60.0  # 15%/min, ~6.5 min life
	GameManager.flashlight_battery = maxf(GameManager.flashlight_battery, 0.0)
	if GameManager.flashlight_battery < 15.0:
		# dual-sine = irregular organic flicker, not a metronome
		var flicker := sin(Time.get_ticks_msec() * 0.03) * sin(Time.get_ticks_msec() * 0.07)
		flashlight.light_energy = lerpf(0.3, 1.2, (flicker + 1.0) * 0.5)
	else:
		flashlight.light_energy = 1.5
	if GameManager.flashlight_battery <= 0.0:
		flashlight_on = false
		flashlight.visible = false
```

Toggle refuses until `GameManager.has_flashlight`. Battery pickups restore
+30. Drain rate is the game's difficulty dial.

Dust in the beam: GPUParticles3D (60 particles, 4s life, box emission
2x1.5x5 in front of camera, tiny unshaded spheres radius 0.008, alpha ramp
peaking at 0.08). Emits only while the flashlight is visible. Reads as
volumetrics at a fraction of the cost.

### Breathing (fear you can feel)

```gdscript
func _handle_breathing(delta: float) -> void:
	var target := 0.0
	if stamina < 30.0:
		target += (1.0 - stamina / 30.0) * 0.5
	target += GameManager.tension_level * 0.3
	breathing_intensity = lerpf(breathing_intensity, target, 2.0 * delta)
	if breathing_intensity > 0.05:
		var t := Time.get_ticks_msec() * 0.001
		camera.rotation.x += sin(t * 1.5) * breathing_intensity * 0.003
		camera.rotation.z = lerpf(camera.rotation.z,
			sin(t * 2.0) * breathing_intensity * 0.002, 3.0 * delta)
```

Involuntary camera sway from low stamina + high tension. Subtle numbers -
resist cranking them.

## Level building (library first, primitives last)

The level comes from real assets: route it through the `asset-strategy` skill
(`summer_search_assets`, then `summer_import_asset` / `summer_import_asset_by_id`)
and look for a ready horror location (an abandoned house, a haunted forest, a
modular horror-house kit) plus period props, keeping one coherent style. Import
the location that fits and build gameplay inside it. Do NOT grey-box a level a
real asset already provides.

Runtime primitive geometry (BoxMesh/PlaneMesh + StaticBody3D, collision
layer 2) is only for what the imported assets lack: interior partitions the
imported location does not have, trigger volumes, blockers. When you do need
it: WALL_HEIGHT 3.5, WALL_THICKNESS 0.15, helpers `_floor(center, size)`,
`_ceiling`, `_wall_x(z, x0, x1)` / `_wall_z(x, z0, z1)`, `_prop_box(pos,
size, mat)`. Materials: dark desaturated albedo (floor 0.12/0.11/0.1, walls
0.18/0.17/0.15), roughness 0.85.

Layout formula:

1. Entry area - well-lit, flashlight pickup here.
2. Main hall - central hub, multiple exits, player keeps returning.
3. Side corridors - long, narrow, dim; stalker territory.
4. Dead-end rooms - keys and notes; forced backtracking.
5. Back corridor - darkest, highest tension.
6. Final area - escape zone at the far end, exit key behind at least one
   locked door.

## Atmosphere rendering settings

WorldEnvironment is half the horror:

- Sky near-black (top 0.02/0.02/0.05); ambient color 0.03/0.03/0.05 at
  energy 0.5 - the player MUST need the flashlight.
- Tonemap ACES, white 6.0. SSAO on (radius 2, intensity 3 - darkens
  corners). SSIL on (radius 3, intensity 0.5). Glow subtle (0.3 / bloom 0.1).
- Fog density 0.02 dark; volumetric fog density 0.06, anisotropy 0.7 -
  this is what makes the flashlight beam a visible cone.

Lighting rules: OmniLights energy 0.4-0.8 (main hall 1.2 max), ALL with
`shadow_enabled = true` (the stalker casts a shadow before you see it).
Give each area a distinct temperature - entry warm (0.6, 0.5, 0.3),
corridors cool (0.3, 0.4, 0.35), lab sickly green (0.3, 0.6, 0.4) - it is
navigation AND variety without textures.

Collision layers: 1 Player, 2 Environment, 3 Interactable, 4 Enemy.

## HUD (minimal by design)

```
HUD (CanvasLayer)
  Crosshair (centered dot)
  InteractionPrompt (Label, bottom center, "[E] Open")
  BatteryContainer (top left, HIDDEN until flashlight found)
    BatteryBar (ProgressBar; red <20%, yellow <50%, blue else)
  NoteBackdrop (fullscreen black, 72% alpha)
  NotePanel (centered note text)
  Vignette (fullscreen; alpha = 0.2 + tension * 0.4)
```

Wire to GameManager signals (`note_opened/closed`, `game_state_changed`).
Note UX detail: 0.35s cooldown after opening before close input is
accepted - otherwise the same interact press that opened the note closes
it. HUD hides entirely when state is not PLAYING.

## Build order

1. Autoloads + input map + layers.
2. Player from 3d-fps base, horror speeds, state gating.
3. One room + WorldEnvironment settings + flashlight pickup + drain.
4. Doors/keys/notes + escape zone (`3d-horror-systems.md`).
5. Atmosphere controller, then the stalker LAST - it only lands once the
   world already feels wrong.

## Traps

- Giving the player any weapon, health bar, or combat UI.
- Ambient energy above 0.5 - no darkness, no battery economy, no fear.
- Constant jump scares. The template leans on anticipation; one of its
  five tension events is deliberately NOTHING.
- Stalker always visible - players habituate; long gaps are intentional.
- Constant music. Silence scares; use the drone + rare stingers, save
  music for peaks and safe rooms.
- Identical rooms - distinct color temperature per area or players get
  lost and bored simultaneously.
- Skipping audio buses - SFX through SFX bus, ambience through Ambient,
  or mixing and wall-muffling effects become impossible later.
