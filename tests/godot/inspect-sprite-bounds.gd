extends SceneTree


func _initialize():
	call_deferred("check")


func inspect_matches(asset: Node3D, expected: AABB, parser) -> bool:
	var packed := PackedScene.new()
	var path := "res://example.tscn"
	if packed.pack(asset) != OK or ResourceSaver.save(packed, path) != OK:
		return false
	var children := root.get_child_count(true)
	var report: Dictionary = parser._cmd_inspect_asset({"path": path})
	if root.get_child_count(true) != children or not report.ok or report.mesh_count != 1:
		return false
	var minimum: Array = report.aabb.min
	var maximum: Array = report.aabb.max
	return (Vector3(minimum[0], minimum[1], minimum[2]).is_equal_approx(expected.position)
			and Vector3(maximum[0], maximum[1], maximum[2]).is_equal_approx(expected.end))


func check():
	var texture := GradientTexture2D.new()
	texture.gradient = Gradient.new()
	texture.width = 64
	texture.height = 32
	var asset := Node3D.new()
	var mesh := MeshInstance3D.new()
	mesh.mesh = BoxMesh.new()
	asset.add_child(mesh)
	mesh.owner = asset
	var sprite := Sprite3D.new()
	sprite.texture = texture
	sprite.pixel_size = 0.125
	sprite.position = Vector3(12, 0, 0)
	asset.add_child(sprite)
	sprite.owner = asset
	root.add_child(asset)
	var parser = preload("res://probe.gd").new()
	for variant in ["ordinary", "region and frame", "billboard", "hidden", "empty"]:
		match variant:
			"region and frame":
				sprite.region_enabled = true
				sprite.region_rect = Rect2(0, 0, 24, 12)
				sprite.hframes = 2
				sprite.frame = 1
				sprite.axis = Vector3.AXIS_X
				sprite.centered = false
				sprite.offset = Vector2(3, 2)
			"billboard":
				sprite.billboard = BaseMaterial3D.BILLBOARD_ENABLED
			"hidden":
				sprite.visible = false
			"empty":
				sprite.visible = true
				sprite.texture = null
		await process_frame
		await process_frame
		var expected := mesh.get_aabb()
		if sprite.visible and sprite.texture:
			expected = expected.merge(sprite.transform * sprite.get_aabb())
		assert(inspect_matches(asset, expected, parser), variant)

	sprite.free()
	var small := GradientTexture2D.new()
	small.gradient = Gradient.new()
	small.width = 8
	small.height = 8
	var frames := SpriteFrames.new()
	frames.add_frame(&"default", small)
	frames.add_animation(&"walk")
	frames.add_frame(&"walk", small)
	frames.add_frame(&"walk", texture)
	frames.add_frame(&"walk", null)
	var animated := AnimatedSprite3D.new()
	animated.sprite_frames = frames
	animated.animation = &"walk"
	animated.position = Vector3(12, 0, 0)
	animated.pixel_size = 0.125
	animated.centered = false
	animated.offset = Vector2(2, 3)
	asset.add_child(animated)
	animated.owner = asset
	var wide_bounds: AABB
	for frame in [0, 1, 2]:
		animated.frame = frame
		await process_frame
		await process_frame
		var expected := mesh.get_aabb()
		# On an empty frame Godot discards the rendered mesh but keeps the old
		# cached AABB of a live sprite. A freshly loaded empty frame draws nothing.
		if frames.get_frame_texture(&"walk", frame) != null:
			expected = expected.merge(animated.transform * animated.get_aabb())
		if frame == 1:
			wide_bounds = expected
		assert(inspect_matches(asset, expected, parser), "saved animation frame %d" % frame)
		assert(animated.animation == &"walk" and animated.frame == frame and not animated.is_playing())

	root.remove_child(asset)
	animated.autoplay = &"default"
	animated.set_frame_and_progress(1, 0.625)
	# Inspection describes the saved frame even if a game would start another
	# animation when it enters the asset. Its source frame must stay stopped.
	assert(inspect_matches(asset, wide_bounds, parser), "autoplay changed the inspected frame")
	parser._describe(asset, {})
	assert(animated.animation == &"walk" and animated.frame == 1)
	assert(not animated.is_playing() and is_equal_approx(animated.frame_progress, 0.625))
	asset.free()
	print("PLACEMENT_FIXTURE_OK")
	quit()
