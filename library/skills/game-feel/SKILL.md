---
name: game-feel
description: Use when a Summer game "feels flat", "lacks impact", "needs juice", or "needs punch", or the user asks for hit feedback, screen shake, camera shake, audio ducking, or general game feel. Walks through Summer Engine's hit-flash, trauma camera shake, and audio-ducking stack, wired so one hit fires all three. Trigger on "vfx", "juice", "punch", "feels flat", "game feel", "hit flash", "screen shake", "camera shake", "ducking".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: visual-effects
user-invocable: true
allowed-tools: Read Grep Edit Write summer_write_file summer_read_file summer_get_scene_tree summer_inspect_node summer_inspect_resource summer_add_node summer_set_prop summer_set_resource_property summer_connect_signal summer_project_setting summer_save_scene summer_get_script_errors summer_get_debugger_errors summer_play summer_stop
paths: ["**/*.gd", "**/*.tscn", "**/*.tres"]
---

# /vfx — The Trio That Makes Games Feel Punchy

Particles do not make a game feel good. Screen shake alone does not either.
What makes a hit land is three systems firing on the same frame: a sub-frame
**hit flash** on the body that got hit, **trauma-based camera shake** with
quadratic falloff so big hits saturate, and **audio ducking** that briefly
squashes Music/Ambient so the impact SFX punches through. This skill installs
the canonical Summer Engine stack as three small systems wired to one signal.

## Step 1 — Ask what feels flat

Open with one focused question. Wait for the answer.

> What feels flat? Pick one to start: combat hits / pickups / explosions / spell casts / something else.

If the user says "all of it", anchor on **combat hits** — the hit-flash + shake + duck trio is the loudest perceived improvement per minute, and pickups/explosions reuse the same building blocks afterwards.

## Step 2 — Read the current scene state

Before adding anything, see what's there.

**Preferred (Summer MCP):**

```
summer_get_scene_tree
summer_inspect_node "./World/Enemy"   # the body that gets hit
summer_inspect_node "./World/Player/Camera3D"   # the camera to shake
```

You're looking for: a `MeshInstance3D` on the hurt body (for the flash), an existing `Camera3D` on the player (don't spawn a new one), and the names of the audio buses already present (Master + at least one of `Music`, `Ambient`, `SFX`).

If there's no Camera3D under the player, **stop and ask** before adding one — there may be a level camera elsewhere you'd be fighting.

If the only bus is `Master`, ducking will do nothing useful. See *Common mistakes* below.

**Fallback (no MCP):** ask the user to paste the relevant `.tscn` and the project's `default_bus_layout.tres` (or describe the bus list).

## Step 3 — Propose the bundle

Don't drip the systems in one at a time. The whole point is the trio fires together — install all three, wire one signal, see it land.

> I'm about to add: `HitFlash` on `./World/Enemy`, `CameraShake` script on `./World/Player/Camera3D`, `AudioDucker` autoload, and connect the `damaged` signal so one hit fires all three. About 130 lines of GDScript across 3 files. May I proceed?

## Step 4 — Install Section 1 (Hit Flash)

**Goal:** when a body takes damage, its mesh pulses to white for ~0.08s, then tweens back. Reads instantly even at 60 fps.

**Approach:** keep a reference to the original `albedo_color`. On `flash()`, write white directly to the mesh's `material_override` (or build a flash override the first time), then `create_tween()` back to the original over `duration` seconds. Tween, not `await` + sleep — tweens auto-cancel if `flash()` is re-called mid-flash, which matters during multi-hit combos.

**Node tree:**

```
World/
  Enemy (CharacterBody3D)
    Mesh (MeshInstance3D)        # the visible body
    HitFlash (Node)              # holds the script, no transform
```

**MCP path** (every scene-mutating call takes an explicit `scenePath`):

```
summer_add_node(scenePath="res://levels/world.tscn", parent="./World/Enemy", type="Node", name="HitFlash")
summer_set_prop(scenePath="res://levels/world.tscn", path="./World/Enemy/HitFlash", key="script", value="res://scripts/vfx/hit_flash.gd")
```

Then write `scripts/vfx/hit_flash.gd` (via `summer_write_file`, which requires exactly
one of `create_only` or `expected_sha256`):

```gdscript
class_name HitFlash
extends Node

@export var mesh: MeshInstance3D
@export var flash_color: Color = Color(1.0, 1.0, 1.0)
@export var duration: float = 0.08

var _orig_albedo: Color
var _flash_mat: StandardMaterial3D
var _tween: Tween

func _ready() -> void:
    if mesh == null:
        push_warning("HitFlash: mesh export not assigned")
        return
    # Build a dedicated override material once. Cloning the surface material
    # would also work, but a fresh StandardMaterial3D is simpler and free.
    _flash_mat = StandardMaterial3D.new()
    _flash_mat.albedo_color = flash_color
    _flash_mat.emission_enabled = true
    _flash_mat.emission = flash_color
    _flash_mat.emission_energy_multiplier = 2.0
    _orig_albedo = _flash_mat.albedo_color
    mesh.material_override = null  # leave original mesh material in place

func flash() -> void:
    if mesh == null:
        return
    if _tween and _tween.is_valid():
        _tween.kill()  # restart cleanly on rapid re-hits
    mesh.material_override = _flash_mat
    _flash_mat.albedo_color = flash_color
    _tween = create_tween()
    _tween.tween_interval(duration)
    _tween.tween_callback(func() -> void: mesh.material_override = null)
```

**Tunable knobs:** `duration` 0.06–0.12s — under 0.06 reads as a flicker, over 0.12 looks slow. `emission_energy_multiplier` 1.5–3.0.

> Note: `summer_set_prop(key="material_override", value="StandardMaterial3D")` creates an inline `StandardMaterial3D` sub_resource that `summer_set_resource_property(resourceProperty="material_override", subProperty="albedo_color", value="Color(r, g, b, a)")` then edits and `summer_save_scene` persists — so the inline route, the script above, and a saved `materials/flash.tres` are all valid. What breaks is the value *shape*: a JSON object instead of a Godot literal string, a misspelled `key`/`subProperty`, or a wrong-typed value returns `ok:true` yet silently no-ops or destructively coerces on current engines (dict → material cleared; dict → `Color(0,0,0,1)`; newer engines reject these with `unknown_property` / `bad_value_shape` / `type_mismatch`). Always pass class names and `Color(...)`/`Vector3(...)` strings, and confirm the result in the saved `.tscn` or a snapshot diff — never from `ok` alone. See `../../references/mcp-tools-reference/mcp-tools-reference.md`.

## Step 5 — Install Section 2 (Trauma Camera Shake)

**Goal:** any system can `add_trauma(amount)` to the camera. The camera accumulates trauma 0–1, decays it every frame, and shakes by `trauma² × random_offset`. The square is the trick: a 0.3 hit shakes very little (0.09), a 0.8 hit shakes a *lot* (0.64). Big hits feel huge, small hits don't pollute the screen.

**Approach:** put the shake on the existing Camera3D. Two variables — `_trauma` (0–1 accumulator) and `_shake_offset` (last frame's applied rotation). Every frame, **subtract last frame's offset first** so the next offset doesn't drift, then apply the new one. This is the non-obvious trick.

**Node tree:** the script attaches to the existing `./World/Player/Camera3D`. No new nodes.

```
summer_inspect_node(path="./World/Player/Camera3D")
summer_set_prop(scenePath="res://levels/world.tscn", path="./World/Player/Camera3D", key="script", value="res://scripts/vfx/camera_shake.gd")
```

`scripts/vfx/camera_shake.gd`:

```gdscript
class_name CameraShake
extends Camera3D

@export var trauma_decay: float = 3.0       # how fast trauma bleeds off (per second)
@export var max_shake_angle_deg: float = 2.5 # max pitch at trauma = 1.0
@export var yaw_factor: float = 0.5          # less yaw than pitch (eye anatomy)

var _trauma: float = 0.0
var _shake_offset: Vector3 = Vector3.ZERO

func _ready() -> void:
    # Node has no `groups` property, so there is nothing to set from the outside.
    # Joining the group here is how any actor finds this camera later.
    add_to_group(&"player_camera")

func add_trauma(amount: float) -> void:
    _trauma = clamp(_trauma + amount, 0.0, 1.0)

func _process(delta: float) -> void:
    # Always undo last frame's offset BEFORE deciding the next.
    # Without this, rotation drifts every frame trauma is non-zero.
    if _shake_offset != Vector3.ZERO:
        rotation -= _shake_offset
        _shake_offset = Vector3.ZERO

    if _trauma <= 0.0:
        return

    var shake := _trauma * _trauma   # quadratic — small hits barely shake
    var max_angle := deg_to_rad(max_shake_angle_deg) * shake

    _shake_offset = Vector3(
        randf_range(-max_angle, max_angle),
        randf_range(-max_angle, max_angle) * yaw_factor,
        0.0
    )
    rotation += _shake_offset
    _trauma = max(0.0, _trauma - trauma_decay * delta)
```

**Calling it:**

```gdscript
$Camera3D.add_trauma(0.3)   # light hit (parry, glancing blow)
$Camera3D.add_trauma(0.5)   # standard combat hit
$Camera3D.add_trauma(0.8)   # heavy / explosion
```

**Tunable knobs:** `trauma_decay` 3.0 (long-tail, cinematic) ↔ 6.0 (snappy, twitch-shooter feel). `max_shake_angle_deg` 2.0 (subtle) ↔ 4.0 (action-game). Keep `yaw_factor` ≤ 0.5 — equal pitch/yaw shake feels uniform and wrong; eyes are far more sensitive to vertical motion.

## Step 6 — Install Section 3 (Audio Ducking)

This is the system most projects skip and the one that makes the biggest perceived difference. On a hit, briefly attenuate Music + Ambient + Announcer (whatever non-impact buses you have) so the SFX bus stabs through the mix. Then smoothly tween volumes back. **Crucially: store original bus volumes once at startup, and apply ducking as an offset.** Snapping volumes to absolute values destroys the user's volume preferences.

**Approach:** an autoload (`AudioDucker`) so any system can call `AudioDucker.duck(0.5, 0.4)` from anywhere. Internally:

- `_initial_volumes: Dictionary[StringName, float]` captured once in `_ready()` from `AudioServer.get_bus_volume_db()` for each named bus.
- `duck(amount, duration)` lowers each non-impact bus by `amount × per_bus_weight`, scheduled via Tween, and tweens back over `duration`.
- Per-bus weights let Music duck more than Ambient (Music 0.9 = -90% intensity, Ambient 0.7, Announcer 0.5).
- Kill any in-flight tween before starting a new one so rapid-fire hits don't compound the duck and silence the mix.

**Node tree:** none — register the script as an autoload.

`scripts/vfx/audio_ducker.gd`:

```gdscript
extends Node

# Bus name -> duck weight (1.0 = full duck, 0.0 = never duck this bus).
# "SFX" / "UI" / "Voice" should NOT be ducked — those are the buses you want
# to punch through. Adjust to match your project's default_bus_layout.tres.
const BUS_WEIGHTS := {
    &"Music":     0.9,
    &"Ambient":   0.7,
    &"Announcer": 0.5,
}

# How loud the bus is "when not ducked", captured once. NEVER overwrite —
# this is the user's preference and mixer baseline.
var _initial_volumes: Dictionary = {}
var _tween: Tween

func _ready() -> void:
    for bus_name in BUS_WEIGHTS.keys():
        var idx := AudioServer.get_bus_index(bus_name)
        if idx == -1:
            push_warning("AudioDucker: bus '%s' not found in bus layout" % bus_name)
            continue
        _initial_volumes[bus_name] = AudioServer.get_bus_volume_db(idx)

# amount: 0.0–1.0 (0.5 = noticeable, 1.0 = near-silence on weighted buses)
# duration: total duck-and-restore time, seconds. 0.4–0.6 feels right for hits.
func duck(amount: float, duration: float = 0.5) -> void:
    if _initial_volumes.is_empty():
        return
    if _tween and _tween.is_valid():
        _tween.kill()
    _tween = create_tween().set_parallel(true)

    var attack := duration * 0.15  # fast duck-down, slow restore
    var release := duration * 0.85

    for bus_name in _initial_volumes.keys():
        var idx := AudioServer.get_bus_index(bus_name)
        if idx == -1:
            continue
        var base_db: float = _initial_volumes[bus_name]
        var weight: float = BUS_WEIGHTS.get(bus_name, 0.0)
        # Convert "amount" (0–1) into a dB drop. -24 dB at amount=1, weight=1
        # is "almost gone" without being absolute silence.
        var drop_db := -24.0 * amount * weight
        var target_db := base_db + drop_db

        # AudioServer exposes bus volume through a method, not an animatable
        # property, so tween_method is the only form that works here.
        # `tween_property(AudioServer, "bus_volume_db", ...)` errors at runtime.
        _tween.tween_method(_set_bus_db.bind(idx), base_db, target_db, attack)\
            .set_trans(Tween.TRANS_QUAD).set_ease(Tween.EASE_OUT)
        _tween.tween_method(_set_bus_db.bind(idx), target_db, base_db, release)\
            .set_trans(Tween.TRANS_QUAD).set_ease(Tween.EASE_IN)\
            .set_delay(attack)

func _set_bus_db(idx: int, db: float) -> void:
    AudioServer.set_bus_volume_db(idx, db)
```

Register it as an autoload:

```
summer_project_setting(...)   # autoload/AudioDucker = "*res://scripts/vfx/audio_ducker.gd"
```

(Equivalently, by hand: Project Settings → Autoload → Add `scripts/vfx/audio_ducker.gd`
as `AudioDucker`.)

**Calling it:**

```gdscript
AudioDucker.duck(0.5, 0.4)   # standard hit
AudioDucker.duck(0.8, 0.6)   # heavy / boss hit
AudioDucker.duck(1.0, 1.2)   # cinematic — explosion or boss intro
```

**Why offset-not-absolute matters:** if the user has Music slider at -10 dB in your settings menu, and ducking writes `set_bus_volume_db("Music", -24.0)` directly, the *restore* tween will pull Music up to -24's "neutral" which is louder than the user wanted. Capturing `_initial_volumes` at autoload `_ready()` and only ever offsetting from those values preserves the user's mix forever.

## Step 7 — Wire the trio to one signal

The whole point: one hit, all three fire on the same frame. Keep this in the hurt body's damage handler — *not* on a global event bus, because you want the trauma amount and flash to scale per-hit.

```gdscript
# scripts/enemy.gd (or wherever you handle damage on the body that got hit)
extends CharacterBody3D

signal damaged(amount: float)

@onready var _hit_flash: HitFlash = $HitFlash
@onready var _player_camera: CameraShake = get_tree().get_first_node_in_group("player_camera")

func take_damage(amount: float) -> void:
    # ... your existing health subtract / death check ...
    damaged.emit(amount)
    _on_damaged(amount)

func _on_damaged(amount: float) -> void:
    # 1. Hit flash on this body.
    _hit_flash.flash()
    # 2. Camera shake on the player's camera, scaled by hit weight.
    # clampf(), not clamp(): clamp() returns Variant, and inferring a variable from
    # a Variant is an error under Godot's default warning settings.
    var trauma := clampf(0.2 + amount * 0.05, 0.2, 0.9)
    if _player_camera:
        _player_camera.add_trauma(trauma)
    # 3. Audio duck, scaled by hit weight.
    var duck_amount := clampf(0.3 + amount * 0.04, 0.3, 1.0)
    AudioDucker.duck(duck_amount, 0.45)
```

The camera joins `player_camera` from its own `_ready()` (Step 5). `Node` has no
`groups` property, so `summer_set_prop(key="groups", ...)` cannot do this — and
`summer_set_prop` only accepts a string, number, or boolean anyway, never an array.
The two ways that do work are the `add_to_group()` call in `_ready()` or a `groups =
["player_camera"]` line written into the `.tscn` node header.

Or wire the signal explicitly via MCP if you prefer (`emitter`/`receiver`, not
`from`/`to`, and `scenePath` is required):

```
summer_connect_signal(scenePath="res://levels/world.tscn", emitter="./World/Enemy", signal="damaged", receiver="./World/Enemy/HitFlash", method="flash")
```

## Step 8 — Scaling intensity per hit weight

The trio's whole magic is that the same code makes a glancing parry feel different from a critical hit. Calibrate the curve once:

| Hit type | `damage` (HP) | trauma | duck amount |
|---|---|---|---|
| Glance / parry | 1–3 | 0.20 | 0.30 |
| Standard hit | 5–10 | 0.35 | 0.50 |
| Heavy hit | 15–25 | 0.55 | 0.70 |
| Critical / boss | 30–50 | 0.75 | 0.85 |
| Explosion / death | 50+ | 0.90 | 1.00 |

Because trauma is squared inside the camera, the *felt* difference between 0.35 (→ 0.12 shake) and 0.75 (→ 0.56 shake) is roughly 5×. That's the whole point — small hits stay clean, big hits saturate the screen.

## Step 9 — Verify

```
summer_save_scene(scenePath="res://levels/world.tscn")
summer_get_script_errors          # all three scripts parsed?
summer_play
# user reproduces a hit
summer_get_debugger_errors        # runtime errors from the tweens / bus lookups
summer_stop
```

Tune one knob at a time:

- Flash invisible → `emission_energy_multiplier` 1.5 → 3.0, or check that the mesh actually has a material to override.
- Shake feels jittery → reduce `max_shake_angle_deg`, or check `yaw_factor` is ≤ 0.5.
- Ducking inaudible → check `_initial_volumes` got populated (autoload running before the first hit?), and that `Music`/`Ambient` bus names actually match your `default_bus_layout.tres`.
- Ducking *too loud* → reduce per-bus weight, not the `amount` argument. Weights are per-project; amount is per-hit.

## Common mistakes

| Don't | Do | Why |
|---|---|---|
| `AudioServer.set_bus_volume_db("Music", -24)` directly | Capture `_initial_volumes` once, apply ducking as an offset | Absolute writes destroy the user's volume preferences |
| Linear shake (`shake = trauma`) | Quadratic (`shake = trauma * trauma`) | Linear feels uniform, twitchy. Quadratic separates small hits from big hits |
| Apply new shake offset without subtracting last frame's | Subtract `_shake_offset`, zero it, then write the new one | Otherwise rotation drifts every frame trauma > 0 |
| Hit flash with `await get_tree().create_timer(...)` | `create_tween().tween_callback(...)` | A timer can't be cancelled mid-flight on rapid re-hits, leaving albedo broken white |
| Only one bus ("Master") in the project | Add at least `Music`, `Ambient`, `SFX` and route SFX through SFX bus | Ducking does nothing if the impact SFX is on the same bus you're ducking |
| Duck for 1.5+ seconds | 0.4–0.6 second total duck-and-restore | Long ducks make the music feel broken, not punchy |
| Equal pitch/yaw shake | `yaw_factor ≤ 0.5` | Eyes are sensitive to vertical motion; equal axes feel mechanical |
| `Engine.time_scale` for every hit | Reserve hit-stop for big events only (boss hits, deaths) | Time-scale dips on every hit feel laggy, not impactful |
| A JSON object (or a misspelled key) as the `summer_set_prop` / `summer_set_resource_property` value — e.g. `value={"type": "StandardMaterial3D", ...}` through `summer_batch`, which forwards ops verbatim | `value="StandardMaterial3D"` to create the inline material, then `summer_set_resource_property(... value="Color(r, g, b, a)")` per field; confirm in the saved `.tscn` | Current engines return `ok:true` and silently no-op or coerce destructively — dict → material cleared, dict → `Color(0,0,0,1)`. The inline sub_resource itself is fine |
| `summer_set_prop(key="groups", value='["player_camera"]')` | `add_to_group(&"player_camera")` in `_ready()`, or a `groups = [...]` line in the `.tscn` | `Node` has no `groups` property, and `summer_set_prop` takes only string/number/boolean — never an array |
| `BaseMaterial3D.new()` | `StandardMaterial3D.new()` | `BaseMaterial3D` is abstract; constructing it is a parse error that kills the whole script |

## Collaborative protocol

This skill writes 3 GDScript files and adds 1 node + 1 autoload entry. Always ask before each section is applied. Group related writes into one ask: "I'm about to add HitFlash + CameraShake + AudioDucker autoload, wire one signal. OK?" See `../../references/collaborative-protocol/collaborative-protocol.md`.

## When NOT to use this skill

- **2D games** — the trauma curve and dB ducking still apply, but the camera-shake script needs a `Camera2D` rewrite (`offset` instead of `rotation`). Use this skill as a reference, not a drop-in.
- **Turn-based / strategy** — game-feel here lives in UI animation, not body-hit feedback. Skip the trio; reach for tween-based UI polish instead.
- **No audio buses configured** — ducking with one Master bus is a no-op. Set up `Music` / `Ambient` / `SFX` first via the audio-direction skill, then come back.
- **Networked games where the hurt body is remote** — the flash should run client-side on visual hit confirm, not on damage authority. Hook to a `hit_visual_received` signal, not the authoritative damage signal.

## See also

- `../../references/mcp-tools-reference/mcp-tools-reference.md` — full MCP tool list, especially `summer_set_resource_property` on inline sub_resources and which failures are loud vs. silent
- `../../references/godot-version/godot-version.md` — Summer compatibility and
  version-sensitive API notes
- `../../references/collaborative-protocol/collaborative-protocol.md` — "May I write" pattern
- `../../references/gd-style/gd-style.md` — typed GDScript conventions
- `audio/audio-direction/SKILL.md` — bus layout setup (prerequisite for ducking)
- `post-processing/screen-shake/SKILL.md` — deeper trauma variants (Perlin noise, stacked sources)
- `visual-effects/gpuparticles-3d-basics/SKILL.md` — particles to layer on top of the trio
- `visual-effects/hit-impact-flashes/SKILL.md` — flash material variations beyond white pulse
