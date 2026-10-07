# 3D Controllers: First + Third Person

Both build on the minimal 3D walk in SKILL.md. The difference is entirely the
camera rig and how look rotation is split across nodes.

## First-person node layout (non-negotiable)

```
Player (CharacterBody3D)          # yaw (horizontal look) rotates THIS
  CollisionShape3D                # CapsuleShape3D, radius 0.35, height 1.8
  Head (Node3D)                   # y = 1.5; pitch (vertical look) rotates THIS
    Camera3D                      # fov 70-75
      WeaponHolder (Node3D)       # weapons/tools ride here
```

Yaw on the body, pitch on the Head. Never pitch the body (gimbal lock + physics
tilt). Camera is a child of Head so it inherits both rotations.

```gdscript
extends CharacterBody3D

@export var speed: float = 5.0
@export var sprint_speed: float = 8.0
@export var jump_velocity: float = 4.5
@export var mouse_sensitivity: float = 0.002

@onready var head: Node3D = $Head
var gravity: float = ProjectSettings.get_setting("physics/3d/default_gravity")

func _ready() -> void:
	Input.mouse_mode = Input.MOUSE_MODE_CAPTURED

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseMotion:
		rotate_y(-event.relative.x * mouse_sensitivity)
		head.rotate_x(-event.relative.y * mouse_sensitivity)
		head.rotation.x = clampf(head.rotation.x, -PI / 2.0, PI / 2.0)
	if event.is_action_pressed("ui_cancel"):
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE

func _physics_process(delta: float) -> void:
	if not is_on_floor():
		velocity.y -= gravity * delta
	if Input.is_action_just_pressed("jump") and is_on_floor():
		velocity.y = jump_velocity
	var cur_speed := sprint_speed if Input.is_action_pressed("sprint") else speed
	var input_dir := Input.get_vector("move_left", "move_right", "move_forward", "move_back")
	var direction := (transform.basis * Vector3(input_dir.x, 0.0, input_dir.y)).normalized()
	if direction:
		velocity.x = direction.x * cur_speed
		velocity.z = direction.z * cur_speed
	else:
		velocity.x = move_toward(velocity.x, 0.0, cur_speed)
		velocity.z = move_toward(velocity.z, 0.0, cur_speed)
	move_and_slide()
```

## Crouch

Keep two collision shapes (standing + crouching), toggle `disabled`, and a
`RayCast3D` pointing up (`CeilingCheck`) so you cannot stand up under a ceiling.
Lerp the Head y from 1.5 to ~0.9 for a smooth crouch, not a snap.

## Headbob (optional polish)

Drive the Camera's local y with `sin(time * bob_freq) * bob_amp` scaled by
horizontal speed, only while `is_on_floor()`. Keep amp under 0.08 or it nauseates.

## Third-person node layout

```
Player (CharacterBody3D)
  CharacterRotationRoot (Node3D)   # only this visual node yaws toward movement
    character.tscn                  # normalized role-neutral visual package
  CameraController (Node3D)
    SpringArm3D                     # extends behind the -Z-facing visual on local +Z
      Camera3D
```

The `SpringArm3D` is the whole trick: it raycasts from the pivot to the camera
and shortens when a wall is in the way, so the camera never clips into geometry.
Set its `collision_mask` to your Level layer only (not the player).

Third-person differences from FPS:
- Mouse motion rotates the `CameraController` (orbit), not the body.
- The visual wrapper rotates to face the MOVEMENT direction, decoupled from the camera.
  Because imported characters face Godot forward `-Z`, lerp
  `CharacterRotationRoot.rotation.y` toward `atan2(-direction.x, -direction.z)`.
- Rotate only `CharacterRotationRoot.rotation.y`. Do not yaw the CharacterBody3D or add a
  compensating 180-degree model rotation. The package already normalizes forward to `-Z`.
- Keep the third-person camera behind the character on the camera rig's local `+Z` side.
- Camera direction drives movement basis: build `direction` from the spring-arm's
  global basis, flattened to the XZ plane, so "forward" means "where the camera
  looks".

## Canonical humanoid animation states

Keep translation in the controller and use package animations only as in-place visuals.
For a standard playable third-person character, read and copy
`default-third-person-controller.gd`. It already loads exact semantic roles
from `character.json`, selects state after `move_and_slide()`, gives airborne
Jump highest priority, changes clips only when state changes, uses camera-relative
movement, and turns only the normalized `-Z` visual root. Do not reassemble the
controller from partial examples.

Do not advance the `CharacterBody3D` from animation root translation. Rotate only the
visual child when movement is non-zero, and keep the last facing direction while idle.

## Legacy clip-name compatibility only

Use substring discovery only for old, non-package GLBs that have no manifest. Resolve Jump
before Run and claim each real clip at most once. Never use this for a canonical package:

```gdscript
func resolve_legacy_roles(player: AnimationPlayer) -> Dictionary:
	var result: Dictionary = {}
	var used_clips: Dictionary = {}
	for role in [&"jump", &"idle", &"walk", &"run"]: # Jump must precede Run.
		for clip in player.get_animation_list():
			if used_clips.has(clip):
				continue
			if String(clip).to_lower().contains(String(role)):
				result[role] = clip
				used_clips[clip] = true
				break
	return result
```

Validate every requested role after legacy resolution. Do not fall back from Jump to Walk
or Run, and do not reuse one clip for multiple roles.

## Shared traps

- Capture/release the mouse as a pair or you trap the player (see SKILL.md).
- Sprint reads an unbound `sprint` action = silent no-op; bind it first.
- Spring arm with the wrong mask collides with the player and jams at length 0.
