extends SceneTree


func _initialize():
	call_deferred("check")


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
		var packed := PackedScene.new()
		assert(packed.pack(asset) == OK)
		var path := "res://example.tscn"
		assert(ResourceSaver.save(packed, path) == OK)
		var children := root.get_child_count(true)
		var report: Dictionary = parser._cmd_inspect_asset({"path": path})
		assert(root.get_child_count(true) == children)
		assert(report.ok and report.mesh_count == 1)
		var minimum: Array = report.aabb.min
		var maximum: Array = report.aabb.max
		assert(Vector3(minimum[0], minimum[1], minimum[2]).is_equal_approx(expected.position), variant)
		assert(Vector3(maximum[0], maximum[1], maximum[2]).is_equal_approx(expected.end), variant)
	asset.free()
	print("PLACEMENT_FIXTURE_OK")
	quit()
