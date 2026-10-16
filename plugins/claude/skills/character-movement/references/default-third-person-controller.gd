class_name SummerThirdPersonController
extends CharacterBody3D

## Canonical controller for a playable Summer humanoid character package.
## Copy this file unchanged first. Customize the copy only when the user asks.

const REQUIRED_ROLES: Array[StringName] = [&"idle", &"walk", &"run", &"jump"]
const REQUIRED_ACTIONS: Array[StringName] = [
	&"move_left",
	&"move_right",
	&"move_forward",
	&"move_back",
	&"jump",
	&"sprint",
	&"ui_cancel",
]

@export_file("*.json") var character_manifest_path: String

@export_category("Movement")
@export var walk_speed: float = 4.0
@export var run_speed: float = 7.0
@export var acceleration: float = 24.0
@export var jump_velocity: float = 5.5
@export var turn_speed: float = 12.0
@export var floor_snap_distance: float = 0.3
@export var floor_stick_velocity: float = 0.5

@export_category("Camera")
@export var mouse_sensitivity: float = 0.002
@export var camera_height: float = 1.5
@export var camera_distance: float = 4.5
@export_flags_3d_physics var camera_collision_mask: int = 1
@export var camera_pitch_degrees: float = -20.0

@export_category("Respawn")
@export var respawn_below_y: float = -15.0

@export_category("Required Nodes")
@export_node_path("Node3D") var visual_root_path: NodePath = ^"CharacterRotationRoot"
@export_node_path("Node3D") var camera_yaw_path: NodePath = ^"CameraYaw"
@export_node_path("Node3D") var camera_pitch_path: NodePath = ^"CameraYaw/CameraPitch"
@export_node_path("SpringArm3D") var spring_arm_path: NodePath = ^"CameraYaw/CameraPitch/SpringArm3D"
@export_node_path("AnimationPlayer") var animation_player_path: NodePath = ^"CharacterRotationRoot/Character/Visual/AnimationPlayer"

@onready var _visual_root: Node3D = get_node(visual_root_path) as Node3D
@onready var _camera_yaw: Node3D = get_node(camera_yaw_path) as Node3D
@onready var _camera_pitch: Node3D = get_node(camera_pitch_path) as Node3D
@onready var _spring_arm: SpringArm3D = get_node(spring_arm_path) as SpringArm3D
@onready var _animation_player: AnimationPlayer = get_node(animation_player_path) as AnimationPlayer

var _gravity: float = 0.0
var _spawn_position: Vector3
var _clips_by_role: Dictionary = {}
var _active_role: StringName = &""


func _ready() -> void:
	_validate_scene_contract()
	_gravity = float(ProjectSettings.get_setting("physics/3d/default_gravity"))
	_spawn_position = global_position
	floor_snap_length = floor_snap_distance
	_camera_yaw.position.y = camera_height
	_camera_pitch.rotation = Vector3(deg_to_rad(camera_pitch_degrees), 0.0, 0.0)
	_spring_arm.spring_length = camera_distance
	_spring_arm.collision_mask = camera_collision_mask
	_spring_arm.add_excluded_object(get_rid())
	_configure_character_animation()
	_play_role(&"idle")
	Input.mouse_mode = Input.MOUSE_MODE_CAPTURED


func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed(&"ui_cancel"):
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
		return
	if event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
		Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
	if Input.mouse_mode != Input.MOUSE_MODE_CAPTURED:
		return
	if event is InputEventMouseMotion:
		_camera_yaw.rotate_y(-event.screen_relative.x * mouse_sensitivity)


func _physics_process(delta: float) -> void:
	var was_on_floor := is_on_floor()
	if was_on_floor:
		# A small downward velocity keeps the body snapped to flat and gently
		# descending floors instead of producing a one-frame false airborne state.
		velocity.y = -floor_stick_velocity
	else:
		velocity.y -= _gravity * delta
	if Input.is_action_just_pressed(&"jump") and was_on_floor:
		velocity.y = jump_velocity

	var input_vector: Vector2 = Input.get_vector(
		&"move_left",
		&"move_right",
		&"move_forward",
		&"move_back"
	)
	var camera_forward: Vector3 = -_camera_yaw.global_transform.basis.z
	var camera_right: Vector3 = _camera_yaw.global_transform.basis.x
	camera_forward.y = 0.0
	camera_right.y = 0.0
	camera_forward = camera_forward.normalized()
	camera_right = camera_right.normalized()
	var movement_direction: Vector3 = (
		camera_right * input_vector.x + camera_forward * -input_vector.y
	)
	if movement_direction.length_squared() > 1.0:
		movement_direction = movement_direction.normalized()

	var is_sprinting: bool = Input.is_action_pressed(&"sprint")
	var target_speed: float = run_speed if is_sprinting else walk_speed
	var target_velocity: Vector3 = movement_direction * target_speed
	velocity.x = move_toward(velocity.x, target_velocity.x, acceleration * delta)
	velocity.z = move_toward(velocity.z, target_velocity.z, acceleration * delta)

	move_and_slide()
	_turn_visual_toward(movement_direction, delta)
	_update_animation_state(is_sprinting)
	if global_position.y < respawn_below_y:
		global_position = _spawn_position
		velocity = Vector3.ZERO
		_play_role(&"idle")


func _validate_scene_contract() -> void:
	assert(_visual_root != null, "Missing CharacterRotationRoot")
	assert(_camera_yaw != null, "Missing CameraYaw")
	assert(_camera_pitch != null, "Missing CameraPitch")
	assert(_spring_arm != null, "Missing SpringArm3D")
	assert(_animation_player != null, "Missing character AnimationPlayer")
	assert(character_manifest_path != "", "Set character_manifest_path")
	for action in REQUIRED_ACTIONS:
		assert(InputMap.has_action(action), "Missing input action: %s" % action)


func _configure_character_animation() -> void:
	var file := FileAccess.open(character_manifest_path, FileAccess.READ)
	assert(file != null, "Missing character manifest: %s" % character_manifest_path)
	var manifest = JSON.parse_string(file.get_as_text())
	assert(manifest is Dictionary, "Invalid character manifest JSON")
	assert(manifest.get("status") == "ready", "Character package is not ready")
	assert(
		manifest.get("normalization", {}).get("forwardAxis") == "-Z",
		"Character package forward axis must be -Z"
	)

	for entry in manifest.get("animations", []):
		if not entry is Dictionary:
			continue
		var role := StringName(String(entry.get("semanticRole", "")).to_lower())
		if role not in REQUIRED_ROLES:
			continue
		var clip := StringName(String(entry.get("name", "")))
		assert(clip != &"", "Requested character role has no clip: %s" % role)
		assert(not _clips_by_role.has(role), "Ambiguous character role: %s" % role)
		assert(_animation_player.has_animation(clip), "Manifest clip is not playable: %s" % clip)
		_clips_by_role[role] = clip

	for role in REQUIRED_ROLES:
		assert(_clips_by_role.has(role), "Missing requested character role: %s" % role)
	for role in [&"idle", &"walk", &"run"]:
		_animation_player.get_animation(_clips_by_role[role]).loop_mode = Animation.LOOP_LINEAR
	_animation_player.get_animation(_clips_by_role[&"jump"]).loop_mode = Animation.LOOP_NONE


func _update_animation_state(is_sprinting: bool) -> void:
	var horizontal_speed := Vector2(velocity.x, velocity.z).length()
	var next_role: StringName
	if not is_on_floor():
		next_role = &"jump"
	elif horizontal_speed <= 0.05:
		next_role = &"idle"
	elif is_sprinting:
		next_role = &"run"
	else:
		next_role = &"walk"
	_play_role(next_role)


func _play_role(role: StringName) -> void:
	assert(_clips_by_role.has(role), "Missing requested character role: %s" % role)
	if role == _active_role:
		return
	_animation_player.play(_clips_by_role[role])
	# Apply the first keyed pose immediately. This prevents a visible bind-pose
	# frame while the AnimationPlayer waits for its next process tick.
	_animation_player.advance(0.0)
	_active_role = role


func _turn_visual_toward(direction: Vector3, delta: float) -> void:
	if direction.length_squared() <= 0.0001:
		return
	var local_direction: Vector3 = global_transform.basis.inverse() * direction
	var target_yaw := atan2(-local_direction.x, -local_direction.z)
	var weight := 1.0 - exp(-turn_speed * delta)
	_visual_root.rotation.y = lerp_angle(_visual_root.rotation.y, target_yaw, weight)
