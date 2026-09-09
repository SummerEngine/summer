---
name: fps-controller
description: Use when building an FPS, first-person movement, or a 3D character that walks, jumps, and reacts to external forces — production-quality first-person controller with WASD, mouse look, jump, coyote time, jump buffering, air control, and external-velocity handling. Trigger on "FPS", "first-person", "WASD", "character controller", "mouse look", "player movement", "jump".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: character-controllers
user-invocable: false
template-id: template-3d-fps
allowed-tools: Read Grep summer_get_scene_tree summer_add_node summer_set_prop summer_set_resource_property summer_input_map_bind summer_save_scene summer_get_script_errors
paths: ["**/*.gd", "**/*.tscn"]
---

# FPS Controller for Summer Engine

The canonical first-person controller. Coyote time, jump buffering, air control, external-velocity, the works. This is the production minimum for an FPS that doesn't feel like a Unity tutorial — it follows the shipping FPS standard for movement (gravity, grace timers, separate ground/air acceleration, external force accumulator) so the player never says "this feels stiff" or "I jumped right at the edge and died unfairly".

## Scene Structure

```
Player (CharacterBody3D)
├── CollisionShape3D          # CapsuleShape3D, body
├── Head (Node3D)             # yaw is on Player, pitch is on Head — keeps camera roll-free
│   └── Camera3D              # at eye level
└── (optional) RayCast3D      # ground / interaction probe
```

The Head/Camera split is the industry-standard movement model: yaw rotates the body, pitch rotates only the head. Don't pitch the body or you get tilted capsules and slope-collision bugs.

## Step-by-Step Setup via MCP

### 1. Verify the scene first

Always call `summer_get_scene_tree` before mutating. If `World/Player`, `World/PlayerOld`, or any existing CharacterBody3D is present, ASK the user how to proceed before adding nodes.

### 2. Add the Player root

```
summer_add_node(scenePath="res://main.tscn", parent="./World", type="CharacterBody3D", name="Player")
summer_set_prop(scenePath="res://main.tscn", path="./World/Player", key="position", value="Vector3(0, 1, 0)")
```

### 3. Add the collision shape and size it

```
summer_add_node(scenePath="res://main.tscn", parent="./World/Player", type="CollisionShape3D", name="Collision")
summer_set_prop(scenePath="res://main.tscn", path="./World/Player/Collision", key="shape", value="CapsuleShape3D")
summer_set_resource_property(scenePath="res://main.tscn", nodePath="./World/Player/Collision", resourceProperty="shape", subProperty="radius", value="0.4")
summer_set_resource_property(scenePath="res://main.tscn", nodePath="./World/Player/Collision", resourceProperty="shape", subProperty="height", value="1.8")
```

Two things the older version of this skill got wrong:

- **`scenePath` is required** on `summer_add_node`, `summer_set_prop`,
  `summer_set_resource_property` and `summer_save_scene`. Omit it and the call
  never reaches the engine. (`summer_input_map_bind` is the exception — it edits
  `project.godot`, not a scene, and takes only `name` + `events`.)
- **This inline-resource sequence is the supported pattern, not a trap.**
  `summer_set_prop` with a class-name string instantiates a scene-embedded
  (`[sub_resource]`) resource, and `summer_set_resource_property` then reads that
  property off the node and writes the sub-property straight onto it. Embedded
  and external `.tres` resources take the same path. Structural failures are
  explicit — `node not found`, `property is not a resource`, or `resource is
  null` when the property was never assigned — but a bad value shape is silent
  on current engines: a JSON object instead of a Godot literal string, a
  misspelled `key`/`subProperty`, or a wrong-typed value returns `ok:true` yet
  no-ops or coerces destructively. Assign the resource first, pass class names
  and `Vector3(...)`/`Color(...)` strings, and confirm in the saved `.tscn`,
  never from `ok` alone.

### 4. Add the Head pivot + Camera

```
summer_add_node(scenePath="res://main.tscn", parent="./World/Player", type="Node3D", name="Head")
summer_set_prop(scenePath="res://main.tscn", path="./World/Player/Head", key="position", value="Vector3(0, 1.6, 0)")
summer_add_node(scenePath="res://main.tscn", parent="./World/Player/Head", type="Camera3D", name="Camera")
```

Eye height of 1.6 sits the camera right at the top of a 1.8-tall capsule (capsule center 0.9, plus 0.7 to the eye). Tweak per art style.

### 5. InputMap actions

```
summer_input_map_bind(name="move_forward", events=[{type:"key", key:"W"}])
summer_input_map_bind(name="move_back",    events=[{type:"key", key:"S"}])
summer_input_map_bind(name="move_left",    events=[{type:"key", key:"A"}])
summer_input_map_bind(name="move_right",   events=[{type:"key", key:"D"}])
summer_input_map_bind(name="jump",         events=[{type:"key", key:"Space"}])
summer_input_map_bind(name="sprint",       events=[{type:"key", key:"Shift"}])
```

### 6. Attach the controller script

Ask before writing: "May I create `scripts/player_controller.gd` and attach it to `./World/Player`?" Then `Write` the file with the skeleton in the next section, attach via inspector, and finish with `summer_save_scene(scenePath="res://main.tscn")` + `summer_get_script_errors(path="res://scripts/player_controller.gd")` (that tool checks one file and requires `path`).

## Physics-Process Flow (the order matters)

Each frame, `_physics_process` runs these steps in this exact order. Reordering breaks specific edge cases — they are flagged inline.

1. **Subtract last frame's external velocity contribution.** If you skip this, knockback and explosions accumulate forever.
2. **Apply gravity** (asymmetric — heavier when falling).
3. **Update coyote timer.** Reset to full when grounded, tick down when airborne.
4. **Update jump buffer + fire jump** if both timers are active. Clearing the buffer on press-instead-of-fire is the bug everyone makes.
5. **Read input, build wish-direction in worldspace** by rotating the local 2D input through `transform.basis`.
6. **Pick acceleration / friction** based on grounded state, then `move_toward` the horizontal velocity toward `wish_dir * target_speed`.
7. **Apply external velocity, save it for next-frame subtraction, decay it** via `move_toward(0, damping * delta)`.
8. **`move_and_slide()`** — last, after everything else has settled `velocity`.

The skeleton below implements this exactly.

## GDScript Skeleton (drop into `scripts/player_controller.gd`)

```gdscript
class_name PlayerController
extends CharacterBody3D

# Movement tunables — the canonical defaults. Tweak in inspector, don't fork the script.
@export var walk_speed: float = 5.0
@export var sprint_speed: float = 8.0
@export var jump_velocity: float = 5.5         # ~1.5m peak with default gravity
@export var gravity: float = 20.0              # heavier than Earth — feels better
@export var fall_gravity_multiplier: float = 1.4  # snappier descent than ascent

# Acceleration model — separate ground/air so air control feels real, not on/off.
@export var ground_accel: float = 80.0
@export var ground_friction: float = 90.0
@export var air_accel: float = 25.0            # ~30% of ground — Quake-ish, not Mario
@export var air_friction: float = 5.0

# Grace timers — the difference between "feels tight" and "feels broken".
@export var coyote_time: float = 0.1           # jump-after-walking-off-ledge window
@export var jump_buffer_time: float = 0.1      # press-just-before-landing window

# Camera.
@export_range(0.0001, 0.01) var mouse_sensitivity: float = 0.002
@export var pitch_min: float = -1.4            # ~-80°
@export var pitch_max: float = 1.4             # ~+80°

# External-velocity damping — knockback / explosions / conveyor belts decay over time.
@export var external_damping: float = 8.0

@onready var head: Node3D = $Head
@onready var camera: Camera3D = $Head/Camera

# Internal state.
var _coyote_timer: float = 0.0
var _jump_buffer_timer: float = 0.0
var _was_on_floor: bool = false

# External velocity accumulator. Any system can push the player by adding to this;
# we apply it, then decay it. Keeps designer-driven forces from fighting input.
var external_velocity: Vector3 = Vector3.ZERO
var _prev_external_applied: Vector3 = Vector3.ZERO

func _ready() -> void:
    Input.mouse_mode = Input.MOUSE_MODE_CAPTURED

func _unhandled_input(event: InputEvent) -> void:
    if event is InputEventMouseMotion and Input.mouse_mode == Input.MOUSE_MODE_CAPTURED:
        rotate_y(-event.relative.x * mouse_sensitivity)
        head.rotate_x(-event.relative.y * mouse_sensitivity)
        head.rotation.x = clamp(head.rotation.x, pitch_min, pitch_max)
    elif event.is_action_pressed("ui_cancel"):
        Input.mouse_mode = Input.MOUSE_MODE_VISIBLE

func _physics_process(delta: float) -> void:
    # 1. Strip last frame's external contribution so it doesn't compound with input.
    velocity -= _prev_external_applied

    # 2. Gravity (asymmetric — falling faster than rising feels better).
    if not is_on_floor():
        var g := gravity * (fall_gravity_multiplier if velocity.y < 0.0 else 1.0)
        velocity.y -= g * delta

    # 3. Coyote-time bookkeeping. Reset on landing; tick down when airborne.
    if is_on_floor():
        _coyote_timer = coyote_time
    else:
        _coyote_timer = max(_coyote_timer - delta, 0.0)

    # 4. Jump buffer. Holding/tapping jump up to `jump_buffer_time` before landing
    #    queues the jump — fires the instant we touch ground.
    if Input.is_action_just_pressed("jump"):
        _jump_buffer_timer = jump_buffer_time
    else:
        _jump_buffer_timer = max(_jump_buffer_timer - delta, 0.0)

    if _jump_buffer_timer > 0.0 and _coyote_timer > 0.0:
        velocity.y = jump_velocity
        _jump_buffer_timer = 0.0
        _coyote_timer = 0.0

    # 5. Build wish-direction in worldspace from camera yaw.
    var input_v := Input.get_vector("move_left", "move_right", "move_forward", "move_back")
    var wish_dir := (transform.basis * Vector3(input_v.x, 0.0, input_v.y))
    wish_dir.y = 0.0
    wish_dir = wish_dir.normalized() if wish_dir.length() > 0.001 else Vector3.ZERO

    # 6. Pick speed + accel/friction based on grounded state.
    var target_speed := sprint_speed if Input.is_action_pressed("sprint") else walk_speed
    var accel := ground_accel if is_on_floor() else air_accel
    var friction := ground_friction if is_on_floor() else air_friction

    var horiz := Vector3(velocity.x, 0.0, velocity.z)
    if wish_dir.length() > 0.0:
        # Accelerate toward wish_dir at `accel` units/sec — not instant snap.
        horiz = horiz.move_toward(wish_dir * target_speed, accel * delta)
    else:
        # No input — decelerate via friction.
        horiz = horiz.move_toward(Vector3.ZERO, friction * delta)
    velocity.x = horiz.x
    velocity.z = horiz.z

    # 7. Apply external velocity, remember it for next-frame subtraction, decay it.
    velocity += external_velocity
    _prev_external_applied = external_velocity
    external_velocity = external_velocity.move_toward(Vector3.ZERO, external_damping * delta)

    _was_on_floor = is_on_floor()
    move_and_slide()

# Public API for other systems — knockback, explosions, jump pads, conveyor belts, etc.
func add_external_velocity(impulse: Vector3) -> void:
    external_velocity += impulse
```

## Property Reference

| Property | Default | Why |
|---|---|---|
| `walk_speed` | `5.0` | Standard FPS pace; feels right at 80–90° FOV. |
| `sprint_speed` | `8.0` | ~60% faster — noticeable without trivializing distances. |
| `jump_velocity` | `5.5` | ~1.5m apex — clears typical step + crate heights. |
| `gravity` | `20.0` | Heavier than 9.8 — game-feel default, not realism. |
| `fall_gravity_multiplier` | `1.4` | Snappier descent than ascent (variable-jump-feel staple). |
| `ground_accel` / `ground_friction` | `80 / 90` | Crisp start, near-instant stop. |
| `air_accel` / `air_friction` | `25 / 5` | Reduced air control + minimal air drag. |
| `coyote_time` | `0.1` | Standard 0.08–0.15s grace — invisible to players, fixes 60% of "unfair death" complaints. |
| `jump_buffer_time` | `0.1` | Same window the other direction. |
| `mouse_sensitivity` | `0.002` | Default raw multiplier; expose via settings. |
| `external_damping` | `8.0` | Knockback decays over ~0.5s. |

## Why Each Feature Matters

**Coyote time (~0.1s)** — Players judge ledges by what they see, not by frame-perfect collision. A small grace period after walking off a ledge where jump still works fixes the "I jumped right at the edge and died unfairly" complaint that breaks 60% of new players' tutorials. Cost: 3 lines. Industry-standard window is 0.08–0.15s — short enough to be invisible, long enough to mask the imprecision of human reaction time.

**Jump buffering (~0.1s)** — Pressing jump 50ms before landing should not be punished. Buffer the input for ~0.1s and fire on touchdown. Without this, fast-moving players feel like the controller "ate their input" — they pressed jump, they saw nothing happen, they blame the game. With it, every "near-miss" jump becomes a successful one. Cost: 4 lines.

**Air control with reduced acceleration (~30% of ground)** — Zero air control feels like ice; the player commits to a direction at jump-takeoff and can't course-correct. Full air control feels like a Unity tutorial; momentum is meaningless and a strafe-jump cancels itself. The shipping FPS standard sits around 25–30% of ground accel: enough to course-correct mid-jump, not enough to cancel realistic momentum. The `move_toward` formulation lets designers tune this with one number — `air_accel` — without forking code.

**External velocity accumulator** — Knockback, explosions, jump pads, conveyor belts, wind volumes, and grapple-yanks must not fight player input. Storing them in a separate `external_velocity`, applying once per frame, and decaying via `move_toward(0, damping * delta)` means an explosion shoves the player and then control returns smoothly — no "stuck at terminal velocity" or "input cancels the punch" bugs. The subtract-previous-contribution trick (line 1 of `_physics_process`) is the production fix that prevents accumulation when the player is also sprinting; it's the kind of detail you only learn by shipping multiplayer. Public API (`add_external_velocity`) means any system — AOE attack, jump pad scene, grapple ability — can shove the player with one call, no coupling.

**Acceleration / friction via `move_toward`** — Setting `velocity.x = direction.x * speed` is the AI-tutorial pattern: instant snap to target, instant snap to zero. Real controllers ramp up and ramp down. `move_toward(target, rate * delta)` gives four separate knobs (`ground_accel`, `ground_friction`, `air_accel`, `air_friction`) so designers can dial in "snappy military shooter" (high both) vs "floaty arena shooter" (high accel, low friction) without rewriting code. This is the single biggest reason a controller built from this skeleton feels like a real shipped FPS instead of a prototype.

## Tuning By Feel — Recipe Cards

Once the skeleton is in, designers tune by feel. Common targets:

**Snappy military shooter (industry-standard FPS feel):**
- `walk_speed = 5.5`, `sprint_speed = 8.0`
- `ground_accel = 90`, `ground_friction = 100`
- `air_accel = 20`, `air_friction = 4`
- `jump_velocity = 5.0`, `gravity = 22`, `fall_gravity_multiplier = 1.5`
- `coyote_time = 0.08`, `jump_buffer_time = 0.08`

**Floaty arena shooter (longer airtime, more air control):**
- `walk_speed = 6.5`, `sprint_speed = 10.0`
- `ground_accel = 60`, `ground_friction = 60`
- `air_accel = 35`, `air_friction = 2` (low air friction = momentum preserved)
- `jump_velocity = 7.0`, `gravity = 16`, `fall_gravity_multiplier = 1.2`

**Heavy / tactical (slower, more committed):**
- `walk_speed = 4.0`, `sprint_speed = 6.0`
- `ground_accel = 50`, `ground_friction = 60`
- `air_accel = 12`, `air_friction = 6`
- `jump_velocity = 4.5`, `gravity = 24`

The skeleton doesn't change — only the `@export` defaults. That's the point of typed exports.

## Common Issues

- **Controller feels stiff or instant** — verify `ground_accel` and `ground_friction` are not absurdly high (>500). If they are, `move_toward` saturates in one frame and you get the snap-to-target behaviour you were trying to avoid.
- **Controller feels mushy / slidey** — `ground_friction` is too low (under 30). Crank to 80–120 for crisp stops.
- **Jump occasionally fails near ledges** — coyote isn't being reset on landing. Confirm the `is_on_floor()` branch in step 3 runs before the buffer-fires branch in step 4.
- **Pressing jump just before landing does nothing** — `_jump_buffer_timer` is being decremented to zero before the player touches floor. The buffer must NOT be cleared by anything except a successful jump.
- **Knockback compounds forever** — `_prev_external_applied` isn't being subtracted. Step 1 of `_physics_process` MUST run before gravity, or external impulses pile up frame after frame.
- **Knockback decays too fast / too slow** — tune `external_damping`. `8.0` decays a 5 m/s impulse to near-zero in ~0.6s. Lower = longer hangtime.
- **Air control feels like ice OR like a Unity tutorial** — `air_accel` is the only knob. Industry-standard is 20–30% of `ground_accel`. Zero = ice. Equal = arcade-y. The shipping FPS standard sits around 25.
- **Camera tilts on slopes** — pitch is on the body instead of the Head. Pitch only on `Head`; yaw only on `Player`.
- **Camera rolls when looking around** — you're calling `rotate_x` on something that's already rotated on Y. Fix: only ever rotate Y on Player and X on Head, never combine.
- **Mouse look doesn't work** — `Input.mouse_mode` isn't set to `MOUSE_MODE_CAPTURED`, or another node is consuming `_input` before this script. Use `_unhandled_input` to be a good citizen.
- **Mouse look feels laggy at low FPS** — sensitivity is being applied in `_physics_process`. Mouse-motion handling MUST stay in `_input` or `_unhandled_input` — those fire per-event, not per-physics-tick.
- **Falling through floor** — floor needs a StaticBody3D + CollisionShape3D on the same physics layer as the player.
- **Camera clipping geometry** — push `Camera.near` to ~0.05 or shrink the capsule radius slightly.
- **Player jitters on slopes / stairs** — enable `floor_snap_length = 0.5` and `floor_max_angle = 0.785` (~45°) on the CharacterBody3D. Out of scope for this skeleton; see the character-body-tuning skill when it ships.

## Networking Note

For multiplayer, two viable patterns:

1. **Server-authoritative (the open-source-friendly path):** gate physics with `if not multiplayer.is_server(): return` for non-local players, sync `global_position` + `velocity` via `MultiplayerSynchronizer`, send input via RPC. This skeleton is compatible — wrap the `_physics_process` body in a `is_local_player` check and add a separate `apply_remote_player_physics` that interpolates from network snapshots.
2. **Custom action protocol (the shipped-game path):** the same skeleton runs on every client; one peer is "host" and broadcasts authoritative state at a fixed interval. Out of scope for this skill — see the multiplayer-and-networking category.

The external-velocity accumulator pattern is a multiplayer-correctness gift either way: explosions and knockbacks happen on the host, the impulse is RPC'd to the affected player, and the client's controller absorbs it without fighting local input. That's why the subtract-previous-contribution trick at the top of `_physics_process` exists — it is the single fix that prevents knockback drift in netcode.

## Beyond This Skeleton

The skeleton is intentionally ~90 lines. When you outgrow it, add features by *layering*, not by stuffing more branches into `_physics_process`:

- **Headbob.** Drive `Head.position.y` from a sine of `accumulated_walk_distance`, not of time — bob disappears when you stop without a fade-out timer. Amplitude scales with current horizontal speed / `walk_speed`. Disable while airborne.
- **Crouch.** Lerp the capsule height (e.g., 1.8 → 1.0) and the Head Y (1.6 → 0.9) over ~0.15s. Halve `walk_speed` while crouched. Block standing if a short upward shapecast hits ceiling.
- **Sprint FOV punch.** Tween `Camera.fov` from 75 → 82 over 0.2s when sprint starts, back when it ends. The single cheapest "feel of speed" effect available.
- **Slide.** When sprint + crouch are pressed together with horizontal speed above a threshold, lock direction to current velocity, set a `slide_timer`, and skip the wish-direction step. Apply slide-specific friction. Restore on timer expiry, ceiling clearance, or speed-below-threshold.
- **Wallrun, dash, double-jump.** Each is its own override state. Build a state machine (see `scripting-patterns/state-machine-patterns/SKILL.md`) and let each state run its own `_physics_process` branch with an early `move_and_slide()` return. Don't pile them as `if/elif` in a single function.
- **Camera shake.** Add a `trauma` float on the camera, accumulate via `add_trauma(amount)`, decay each frame, apply a randomized rotation offset proportional to `trauma * trauma`. Subtract the previous frame's shake offset before applying the new one to prevent drift. See the post-processing/screen-shake skill.

Each of these is a separate skill or a separate function, not a fork of this script.

## Fallback (no MCP — edit `.tscn` directly)

Save as `res://scenes/player.tscn`:

```
[gd_scene load_steps=3 format=3]

[ext_resource type="Script" path="res://scripts/player_controller.gd" id="1"]

[sub_resource type="CapsuleShape3D" id="caps"]
radius = 0.4
height = 1.8

[node name="Player" type="CharacterBody3D"]
position = Vector3(0, 1, 0)
script = ExtResource("1")

[node name="Collision" type="CollisionShape3D" parent="."]
shape = SubResource("caps")

[node name="Head" type="Node3D" parent="."]
position = Vector3(0, 1.6, 0)

[node name="Camera" type="Camera3D" parent="Head"]
```

Then patch `project.godot` with the InputMap actions (`input/move_forward = { ... }` etc.) and `Write` the script body from the section above.

## Collaborative Protocol

This skill writes scene nodes, an InputMap, and a `.gd` script. Always ask before applying. Group writes per phase: "May I add the Player + Collision + Head + Camera, bind WASD/jump/sprint, and attach `player_controller.gd`?"

If the user asks for a "third-person FPS", flag the contradiction: FPS = first-person. Either clarify, or hand off to the `tps-controller` skill when it ships.

## See Also

- `scripting-patterns/state-machine-patterns/SKILL.md` — once movement grows past this skeleton (slide, grapple, hover), refactor into a state machine instead of stuffing more branches into `_physics_process`.
- `physics/character-body-tuning/SKILL.md` (when shipped) — slope handling, step-up, floor-snap.
