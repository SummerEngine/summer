extends SummerProbeBase

## Runtime proof for the canonical playable humanoid controller.
## Pass this source unchanged as the probe_source of a RunVerification op:
##   summer_batch(ops=[{"op": "RunVerification", "max_seconds": 30, "probe_source": <this file>}])
##
## If RunVerification cannot run, this file is not part of your job: finish on
## the saved state and hand the playtest to the user. Do not paste this into a
## script, a scene, or the project.
## Saved frames come back in the result's `frames`; every reported boolean must
## be true.


func _find_first(node: Node, type_name: StringName) -> Node:
	if node.is_class(type_name):
		return node
	for child in node.get_children():
		var found := _find_first(child, type_name)
		if found != null:
			return found
	return null


func _pose_delta(before: Transform3D, after: Transform3D) -> float:
	var translation_delta := before.origin.distance_to(after.origin)
	var rotation_delta := before.basis.get_rotation_quaternion().angle_to(
		after.basis.get_rotation_quaternion()
	)
	return maxf(translation_delta, rotation_delta)


func _arm_down_ratio(
	skeleton: Skeleton3D,
	upper_arm_name: StringName,
	hand_name: StringName
) -> float:
	var upper_arm_index := skeleton.find_bone(upper_arm_name)
	var hand_index := skeleton.find_bone(hand_name)
	if upper_arm_index < 0 or hand_index < 0:
		return -1.0
	var upper_arm_position := skeleton.get_bone_global_pose(upper_arm_index).origin
	var hand_position := skeleton.get_bone_global_pose(hand_index).origin
	var arm_vector := hand_position - upper_arm_position
	if arm_vector.length_squared() <= 0.000001:
		return -1.0
	return (upper_arm_position.y - hand_position.y) / arm_vector.length()


func _ready() -> void:
	await super._ready()
	await settle(20)

	var scene := get_tree().current_scene
	var player := _find_first(scene, &"CharacterBody3D") as CharacterBody3D
	report("player_exists", player != null)
	if player == null:
		finish()
		return

	# Fresh scenes commonly spawn the capsule above the platform. Sampling after
	# a fixed 20 frames can catch the initial Jump clip and falsely call it idle.
	# Wait a bounded amount for real floor contact, then give the controller one
	# short state transition window before measuring the resting animation.
	for frame_index in 120:
		if player.is_on_floor():
			break
		await settle(1)
	report("idle_grounded", player.is_on_floor())
	await settle(12)

	var animation_player := _find_first(player, &"AnimationPlayer") as AnimationPlayer
	var skeleton := _find_first(player, &"Skeleton3D") as Skeleton3D
	report("animation_player_exists", animation_player != null)
	report("skeleton_exists", skeleton != null)
	if animation_player == null or skeleton == null:
		finish()
		return

	var idle_animation := String(animation_player.current_animation)
	report("idle_animation", idle_animation)
	report(
		"idle_named",
		idle_animation == "Idle" or idle_animation.ends_with("/Idle")
	)
	report("idle_playing", animation_player.is_playing())

	var before: Array[Transform3D] = []
	for bone_index in skeleton.get_bone_count():
		before.append(skeleton.get_bone_global_pose(bone_index))
	await settle(24)
	var maximum_pose_delta := 0.0
	for bone_index in skeleton.get_bone_count():
		maximum_pose_delta = maxf(
			maximum_pose_delta,
			_pose_delta(
				before[bone_index],
				skeleton.get_bone_global_pose(bone_index)
			)
		)
	report("idle_pose_delta", maximum_pose_delta)
	report("idle_moves_skeleton", maximum_pose_delta > 0.0001)

	var left_arm_down_ratio := _arm_down_ratio(
		skeleton,
		&"LeftArm",
		&"LeftHand"
	)
	var right_arm_down_ratio := _arm_down_ratio(
		skeleton,
		&"RightArm",
		&"RightHand"
	)
	var idle_arm_bones_exist := (
		left_arm_down_ratio >= 0.0 and right_arm_down_ratio >= 0.0
	)
	var idle_arms_relaxed := (
		idle_arm_bones_exist
		and minf(left_arm_down_ratio, right_arm_down_ratio) > 0.2
		and (left_arm_down_ratio + right_arm_down_ratio) * 0.5 > 0.55
	)
	report("idle_arm_bones_exist", idle_arm_bones_exist)
	report("idle_left_arm_down_ratio", left_arm_down_ratio)
	report("idle_right_arm_down_ratio", right_arm_down_ratio)
	report("idle_arms_relaxed", idle_arms_relaxed)
	await save_frame("canonical-third-person-idle")

	var camera_pitch := player.get_node_or_null("CameraYaw/CameraPitch") as Node3D
	report("camera_pitch_exists", camera_pitch != null)
	if camera_pitch != null:
		var pitch_before := camera_pitch.rotation
		var vertical_mouse := InputEventMouseMotion.new()
		vertical_mouse.relative = Vector2(0.0, 160.0)
		player._unhandled_input(vertical_mouse)
		report(
			"vertical_mouse_keeps_fixed_pitch",
			camera_pitch.rotation.is_equal_approx(pitch_before)
		)

	var start_position := player.global_position
	Input.action_press(&"move_forward")
	await settle(24)
	var moving_animation := animation_player.current_animation
	var moving_position := player.global_position
	Input.action_release(&"move_forward")
	report("forward_progress", start_position.z - moving_position.z)
	report("forward_moves_toward_minus_z", moving_position.z < start_position.z)
	report("locomotion_animation", moving_animation)
	report(
		"locomotion_animation_active",
		moving_animation == "Walk" or moving_animation == "Run"
	)

	await save_frame("canonical-third-person-moving")
	finish()
