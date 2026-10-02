# 3D FPS - Core

First-person shooter blueprint: player hierarchy, mouse look, movement feel,
and level setup. Shooting, weapons, interaction, and HUD live in
`3d-fps-systems.md`.

Rule for Summer Engine builds: scene operations (.tscn) go through the scene
tools (`summer_add_node` / `summer_set_prop` / `summer_set_resource_property`,
or one `summer_batch`, always with `scenePath`); script files (.gd) go through
`summer_write_file` / `summer_replace_text`. Never cross the streams. For a
production controller with air control and external velocity, see the
`fps-controller` skill.

## Minimum playable base (build this first)

Level with ground + light + WorldEnvironment, the player scene below, mouse
look + WASD + jump. Prove "walk around and look" before any weapon exists.

## Player hierarchy (non-negotiable)

```
Player (CharacterBody3D, group "player", collision_mask 6)
  StandingShape (CollisionShape3D, capsule r 0.35 h 1.8, at y 0.9)
  CrouchingShape (CollisionShape3D, capsule r 0.35 h 1.0, at y 0.5, disabled)
  Head (Node3D, y 1.5)                # receives PITCH
    Camera3D (fov 70)
      WeaponHolder (Node3D, (0.2, -0.15, -0.4))
      InteractionRay (RayCast3D, target (0,0,-2.5), mask 4)
      ShootRay (RayCast3D, target (0,0,-100), mask 6)
  CeilingCheck (RayCast3D, at y 1, target (0,1,0), mask 2)
```

Why this exact shape:

- Yaw rotates the Player ROOT, pitch rotates Head. Rotating the camera on
  both axes causes gimbal lock and drift.
- Camera under Head inherits both rotations; WeaponHolder under Camera makes
  weapons track the view exactly.
- Two collision shapes for crouch, toggled via `disabled`. Resizing one
  shape at runtime glitches physics.
- Short InteractionRay (2.5m) and long ShootRay (100m) are separate rays with
  separate masks.

Collision layers: 1 Player, 2 Environment, 3 Interactable, 4 Enemy. ShootRay
mask 6 = Environment + Enemy (never the player). InteractionRay mask 4 =
Interactable only.

Input map before any scripts: move_forward/back/left/right, jump (Space),
sprint (Shift), crouch (C), shoot (LMB), aim (RMB), reload (R), interact (E),
weapon_1/2/3, pause (Escape).

## Controller script

Tuning baseline: walk 5.0, sprint 8.0, crouch 2.5, acceleration 10.0, jump
4.5, mouse sensitivity 0.002, FOV 70 default / 80 sprint / 50 aim.

```gdscript
func _ready() -> void:
	Input.mouse_mode = Input.MOUSE_MODE_CAPTURED

func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("ui_cancel"):
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
		return
	if event is InputEventMouseButton and event.pressed \
			and Input.mouse_mode == Input.MOUSE_MODE_VISIBLE:
		Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
		get_viewport().set_input_as_handled()
		return
	if event is InputEventMouseMotion:
		rotate_y(-event.relative.x * mouse_sensitivity)
		head.rotate_x(-event.relative.y * mouse_sensitivity)
		head.rotation.x = clampf(head.rotation.x, deg_to_rad(-85.0), deg_to_rad(85.0))
```

Mouse capture is mandatory or look does not work; the Escape release +
click-to-recapture pair is mandatory or the player cannot quit.

Movement (in `_physics_process`, never `_process`):

```gdscript
func _handle_movement(delta: float) -> void:
	var input_dir := Input.get_vector("move_left", "move_right", "move_forward", "move_back")
	var direction := (transform.basis * Vector3(input_dir.x, 0.0, input_dir.y)).normalized()
	if direction:
		velocity.x = lerpf(velocity.x, direction.x * current_speed, acceleration * delta)
		velocity.z = lerpf(velocity.z, direction.z * current_speed, acceleration * delta)
	else:
		velocity.x = lerpf(velocity.x, 0.0, acceleration * delta)
		velocity.z = lerpf(velocity.z, 0.0, acceleration * delta)
	if is_on_floor() and Input.is_action_just_pressed("jump") and not is_crouching:
		velocity.y = jump_velocity
```

Gravity from project settings, not a magic number:
`velocity.y -= ProjectSettings.get_setting("physics/3d/default_gravity") * delta`
when not on floor. Then `move_and_slide()`.

### Sprint + stamina

Sprint only while pressing sprint, moving (velocity > 0.5), not crouching,
and stamina > 0. Drain 20/s, regen 15/s to 100. Sprinting also pushes FOV to
80 (lerp at 5.0/delta), aim pulls to 50 - the FOV lerp is a big part of feel.

### Crouch

Toggle: swap which CollisionShape3D is disabled, lerp `head.position.y`
between 1.5 and 0.8 at 8.0/delta. Standing up first checks
`ceiling_check.is_colliding()` - refuse to stand under low geometry.
Crouching cancels sprint and blocks jump.

### Headbob + footsteps

```gdscript
func _handle_headbob(delta: float) -> void:
	var speed := Vector2(velocity.x, velocity.z).length()
	if speed < 0.5 or not is_on_floor():
		camera.position.y = lerpf(camera.position.y, 0.0, 5.0 * delta)
		camera.position.x = lerpf(camera.position.x, 0.0, 5.0 * delta)
		return
	headbob_time += delta * (14.0 if is_sprinting else 10.0)
	var intensity := 0.05 if is_sprinting else 0.03
	var bob_y := sin(headbob_time) * intensity
	camera.position.y = bob_y
	camera.position.x = sin(headbob_time * 0.5) * intensity * 0.5
	if headbob_last_y >= 0.0 and bob_y < 0.0:
		_play_footstep()   # sine crossing zero downward = foot plants
	headbob_last_y = bob_y
```

The lerp-to-zero branch when stopped is required - without it the camera
freezes mid-bob. The zero-crossing footstep trigger syncs audio to motion
for free.

## Level scene

The real level comes from real assets, not primitives: route the need through
the `asset-strategy` skill (`summer_search_assets`, then `summer_import_asset` /
`summer_import_asset_by_id`), import a ready location or kit that fits, and build
gameplay inside it; weapons and props should share its style. A PlaneMesh ground
is only the walk-test blockout and for pieces no asset covers — never the
shipped level when a real one is available.

Blockout minimum: Node3D root + WorldEnvironment + ground (StaticBody3D with
BoxShape3D collision AND a PlaneMesh visual - a MeshInstance3D alone has no
collision) + DirectionalLight3D at (-45, 30, 0) with shadows + the player
instance at (0, 1, 0).

Environment presets:

- Outdoor: ProceduralSkyMaterial sky, angled DirectionalLight3D with
  shadows, ambient from sky.
- Indoor: no sky (custom color background), Omni/SpotLights per room, low
  ambient, SSAO on, optional fog.

## Build order

1. Input map + collision layer names.
2. Player scene per the hierarchy above (MCP), controller script (files).
3. Level: blockout ground, light, environment. Walk test.
4. Swap the blockout for an imported location + props (`asset-strategy`).
5. Hitscan shooting + one weapon + crosshair (`3d-fps-systems.md`).
6. Interaction (door, pickup), HUD, then weapon roster.

## Traps

- Mouse look on the Camera directly - split yaw (root) / pitch (Head) or
  you get gimbal lock.
- Movement in `_process` - variable framerate stutter. CharacterBody3D
  moves in `_physics_process` only.
- Forgetting `MOUSE_MODE_CAPTURED` (look does nothing) or the Escape
  release (player trapped).
- Camera at y 0 - you see from your feet. Head height is 1.5-1.7.
- Level geometry without StaticBody3D collision - the player falls through
  anything that is only a MeshInstance3D.
- One resized collision shape for crouch instead of two toggled shapes.
- ShootRay mask including the Player layer - you shoot yourself; mask 6.
