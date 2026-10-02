# 3D Third-Person - Core

Third-person action blueprint: camera-relative movement, orbit camera with
SpringArm3D and over-shoulder aim pivot, animation-driven character skin, and
level assembly. Combat, enemies, collectibles, and HUD live in
`3d-third-person-systems.md`.

## Minimum playable base (build this first)

Level (CSG floor + light + WorldEnvironment) + player capsule with
camera-relative WASD, orbit camera on a SpringArm3D, and jump. Prove "run
around, camera orbits, no wall clipping" before combat exists.

## Player scene tree

```
Player (CharacterBody3D)
  CharacterRotationRoot (Node3D)      # model rotation lives here, not on body
    CharacterSkin (Node3D)            # mesh + AnimationTree
    MeleeAnchor (Node3D)
      AnimationPlayer                 # "Attack" anim toggles hitbox
      MeleeAttackArea (Area3D + CollisionShape3D, disabled)
  CameraController (Node3D)           # follows via code, NOT rigid parenting
    CameraSpringArm (SpringArm3D)
      CameraThirdPersonPivot (Node3D)
    CameraOverShoulderPivot (Node3D)  # right + closer, for aiming
    PlayerCamera (Camera3D)
      CameraRayCast (RayCast3D, target (0,0,-100))  # aim target
  GrenadeLauncher (Node3D)            # LaunchPoint, ShapeCast3D, TrailMesh
  GroundShapeCast (ShapeCast3D, down) # ground height for camera
  StepSound / LandingSound (AudioStreamPlayer3D)
  UI (CanvasLayer)                    # %AimRecticle, %CoinsContainer, WeaponUI
```

Physics layers: 1 Entities, 2 Level, 3 Coins, 4 Player. Groups: "damageables"
(anything with `damage()`), "targeteables" (grenade lock-on).

Input: move_up/down/left/right, jump (Space, hold for air boost), attack
(LMB / RT), aim (RMB / LT), swap_weapons (Tab), pause, camera_left/right/up/
down (QERF keyboard fallback + right stick). The player script can
auto-register missing actions at runtime via `InputMap.add_action` so the
scene works when dropped into a bare project.

## Controller: the decisions that matter

Tuning baseline: move_speed 8.0, acceleration 4.0, rotation_speed 12.0,
jump_initial_impulse 12.0, jump_additional_force 4.5 (held-jump air boost),
attack_impulse 10.0, gravity -30.0 (deliberately NOT project default;
project gravity 16 is too floaty for 3D platforming - tune independently).

Camera-relative input with diagonal correction:

```gdscript
func _get_camera_oriented_input() -> Vector3:
	if _attack_animation_player.is_playing():
		return Vector3.ZERO                # attacking locks movement
	var raw := Input.get_vector("move_left", "move_right", "move_up", "move_down")
	var input := Vector3.ZERO
	input.x = -raw.x * sqrt(1.0 - raw.y * raw.y / 2.0)   # no faster diagonals
	input.z = -raw.y * sqrt(1.0 - raw.x * raw.x / 2.0)
	input = _camera_controller.global_transform.basis * input
	input.y = 0.0
	return input
```

Last strong direction - the model holds its facing when input stops instead
of snapping to zero; while aiming it faces camera-forward:

```gdscript
if _move_direction.length() > 0.2:
	_last_strong_direction = _move_direction.normalized()
if is_aiming:
	_last_strong_direction = (_camera_controller.global_transform.basis * Vector3.BACK).normalized()
```

Orientation slerps `CharacterRotationRoot` (never the body) toward that
direction at rotation_speed, preserving model scale.

Velocity: split Y off before lerping so gravity is never interpolated:

```gdscript
var y_velocity := velocity.y
velocity.y = 0.0
velocity = velocity.lerp(_move_direction * move_speed, acceleration * delta)
if _move_direction.length() == 0 and velocity.length() < stopping_speed:
	velocity = Vector3.ZERO
velocity.y = y_velocity
```

Jump: impulse on press, plus `jump_additional_force * delta` while jump is
held and still rising (variable height). Track `_is_on_floor_buffer` to
detect the landing frame for the landing sound.

Unstick hack after `move_and_slide()`: if velocity is nonzero but position
did not change (wedged in geometry), nudge
`global_position += get_wall_normal() * 0.1`.

`damage(impact_point, force)` on the player: force.y forced positive (always
tossed upward), clamped by max_throwback_force 15, drops up to 5 coins that
scatter for re-collection.

## Camera system

Two pivots, one camera. `CameraThirdPersonPivot` sits at the end of the
SpringArm3D (behind and above). `CameraOverShoulderPivot` is a plain Node3D
offset right and closer (about x 1.0, y 0.5, z -2.0). Aiming switches pivots
via `set_pivot()`; each `_process` the camera copies the active pivot's
global transform and zeroes `rotation.z`.

- Orbit uses accumulated euler angles from mouse (`_unhandled_input`, only
  while mouse captured) plus joystick strength added in `_process`; inputs
  are consumed and zeroed every frame. Tilt clamped -60..60 deg. Never
  `look_at()` per frame - it jitters.
- SpringArm3D handles wall avoidance for free, but MUST exclude the player:
  `_camera_spring_arm.add_excluded_object(anchor.get_rid())` and
  `_camera_raycast.add_exception_rid(anchor.get_rid())` in `setup()`.
- Ground-height tracking: camera Y lerps toward the player's
  `_ground_height` (from GroundShapeCast), not the player's Y - so jumps do
  not bounce the camera. The player computes `_ground_height` as the max
  collision point of the downward ShapeCast, clamped to its own Y when
  falling below it.
- Aim target: CameraRayCast collision point (or the ray end if no hit) is
  what bullets fly toward and what the grenade locks onto -
  `get_aim_target()` / `get_aim_collider()`.

## Character skin (AnimationTree)

If the visual is a Summer humanoid package, do not use the generic setup below.
Instantiate its `character.tscn` under `CharacterRotationRoot`, preserve the package's
normalized `-Z` forward axis, then install the `character-movement` skill's
`references/default-third-person-controller.gd` unchanged for the standard
playable controller (that skill has the byte-exact install steps and the
verification probe). Do not hand-write an equivalent controller. Never rebuild package clips
into a second AnimationTree.

The generic setup below is only for non-package character skins that already expose
compatible animations.

BlendTree root: a StateMachine (idle / move / jump / fall, where move is a
BlendSpace1D walk-run blended by normalized speed) plus a PunchOneShot
(AnimationNodeOneShot) layered on top so punches play over any state.

```gdscript
func set_moving(value: bool):      # SETTER - travel only on change
	moving = value
	state_machine.travel("move" if moving else "idle")

func punch():
	animation_tree["parameters/PunchOneShot/request"] = AnimationNodeOneShot.ONE_SHOT_REQUEST_FIRE
```

Driving rules from the player: `jump()` on jump press, `fall()` when
`not is_on_floor() and velocity.y < 0`, `set_moving(xz_speed > stopping_speed)`
plus `set_moving_speed(inverse_lerp(0, move_speed, xz_speed))` on the floor.

Footsteps: a `stepped` signal emitted from method-call keyframes in the
walk/run animations; player plays the step sound with `randfn(1.2, 0.2)`
pitch. Free audio sync, no timers.

`animation_tree.active = true` in `_ready()` or nothing plays. Imported
animations often default to non-looping: keep a `_force_loop` export array
and set `loop_mode = Animation.LOOP_LINEAR` on those at runtime.

## Level assembly

Check for real assets first (`asset-strategy`: `summer_search_assets`, then
`summer_import_asset`): a ready location or kit beats CSG. Keep CSG for the
first-motion blockout, invisible glue (death planes, triggers) and pieces no
asset covers — do not ship a grey-box level when a real one is available.

- WorldEnvironment: sky background (ProceduralSkyMaterial), ACES tonemap
  (`tonemap_mode = 2`), glow enabled. Without WorldEnvironment everything
  is flat and dark.
- DirectionalLight3D angled ~45 deg, `shadow_enabled = true` (off by
  default; without shadows objects float).
- Geometry: CSGCombiner3D with `use_collision = true`, CSGBox3D/
  CSGCylinder3D children; boolean subtraction (operation 2) for tunnels.
  Materials with `uv1_triplanar = true` so textures map on any face.
- DeathPlane: big Area3D at y -20; `body_entered` on the Player calls
  `reset_position()` (respawn at `_start_position` captured in `_ready`).
- Jump pad: Area3D setting
  `body.velocity = Vector3.UP * body.jump_initial_impulse + transform.basis * Vector3.UP * impulse_strength`
  (basis-relative so rotated pads launch at angles) + squash-and-elastic
  rebound tween on the mesh.
- Project: 1920x1080, stretch canvas_items / keep_height.
- Pause menu node needs `process_mode = ALWAYS` and must flip mouse mode
  between CAPTURED (gameplay) and VISIBLE (menu).

## Build order

1. Project settings + input actions + layer names.
2. Player scene tree above; movement + jump with a placeholder capsule.
3. CameraController: spring arm orbit, then over-shoulder aim pivot.
4. CharacterSkin AnimationTree once movement feels right.
5. Level: imported location/props (`asset-strategy`) where they fit;
   CSG floor/platforms only as blockout or for missing pieces; light,
   environment, death plane, jump pad.
6. Combat + enemies + coins (`3d-third-person-systems.md`).

## Traps

- Parenting the camera rigidly to the player - it inherits every rotation
  and nauseates. Follow via code with offset + lerp.
- Skipping SpringArm3D (camera clips walls) or forgetting to exclude the
  player's RID from it (camera collides with the player).
- `look_at()` every frame for camera or `state_machine.travel()` every
  frame for animation - both jitter/reset; only act on change.
- Scaling the CharacterBody3D itself - scale the mesh under
  CharacterRotationRoot. Physics on scaled bodies misbehaves.
- 1 unit = 1 meter. Characters are 1-2 units tall; extreme scales break
  physics and lighting.
- Toggling CollisionShape3D `disabled` directly inside physics callbacks -
  always `set_deferred("disabled", ...)`.
- Low gravity. -30 for the player feels right; project-default 16 is
  floaty. Tune player gravity independently of the physics setting.
