extends SceneTree

const World = preload("res://painted/painted_world.gd")
const Location = preload("res://painted/painted_location.gd")
const PAINT_PIXELS := Vector2i(160, 90)


func _initialize() -> void:
	check.call_deferred()


func extent_in_view(from: Camera3D, to: Camera3D) -> Rect2:
	var source := from.get_viewport().get_visible_rect()
	var area := Rect2(to.unproject_position(from.project_position(source.position, 20.0)), Vector2.ZERO)
	for pixel in [Vector2(source.end.x, 0), source.end, Vector2(0, source.end.y)]:
		area = area.expand(to.unproject_position(from.project_position(pixel, 20.0)))
	return area


func check() -> void:
	var screen := SubViewport.new()
	root.add_child(screen)
	var reference := SubViewport.new()
	reference.size = PAINT_PIXELS
	root.add_child(reference)
	var world := World.new()
	var location := Location.new()
	location.name = "Location"
	location.position = Vector3(120, 2, -80)
	location.rotation.y = 0.5
	world.add_child(location)
	var paint_camera := Camera3D.new()
	paint_camera.name = "PaintCamera"
	paint_camera.projection = Camera3D.PROJECTION_ORTHOGONAL
	paint_camera.keep_aspect = Camera3D.KEEP_WIDTH
	paint_camera.size = 24.0
	paint_camera.near = 0.5
	paint_camera.far = 70.0
	paint_camera.rotation_degrees = Vector3(-30, 45, 0)
	if "--paint-offset" in OS.get_cmdline_user_args():
		paint_camera.h_offset = 1.5
		paint_camera.v_offset = -1.125
	location.add_child(paint_camera)
	var painted := Node3D.new()
	painted.name = "Painted"
	location.add_child(painted)
	var surface := MeshInstance3D.new()
	surface.mesh = QuadMesh.new()
	painted.add_child(surface)
	var texture := GradientTexture2D.new()
	texture.gradient = Gradient.new()
	texture.width = PAINT_PIXELS.x
	texture.height = PAINT_PIXELS.y
	location.paint = texture

	var player := CharacterBody3D.new()
	player.name = "Player"
	world.add_child(player)
	var camera := Camera3D.new()
	camera.name = "GameCamera"
	world.add_child(camera)
	world.start_location = ^"Location"
	world.player_path = ^"Player"
	screen.add_child(world)
	world.set_physics_process(false)
	if camera.near != paint_camera.near or camera.far != paint_camera.far:
		return fail("The game did not start with the first location's clip planes")
	var original := paint_camera.duplicate() as Camera3D
	reference.add_child(original)
	original.global_transform = paint_camera.global_transform
	var material := surface.material_override as ShaderMaterial
	var origin: Vector3 = material.get_shader_parameter("paint_origin")
	var right: Vector3 = material.get_shader_parameter("paint_right")
	var up: Vector3 = material.get_shader_parameter("paint_up")
	for pixel: Vector2 in [Vector2(80, 45), Vector2(16, 72)]:
		var point := original.project_position(pixel, 20.0)
		var expected := (pixel - Vector2(PAINT_PIXELS) * 0.5) * Vector2(1, -1) * paint_camera.size / PAINT_PIXELS.x
		var delta := point - origin
		var shader_plane := Vector2(delta.dot(right), delta.dot(up))
		if shader_plane.distance_to(expected) > 0.001 or location.plane(point).distance_to(expected) > 0.001:
			return fail("Projected paint and camera pixel disagree at %s" % pixel)

	for pixels in [Vector2i(320, 180), Vector2i(180, 320), Vector2i(360, 150)]:
		screen.size = pixels
		for mode in ["room", "full", "outdoor"]:
			location.frame_whole = mode == "room"
			world.full_view = mode == "full"
			player.global_position = location.global_position + Vector3(50, 0, 30)
			world._physics_process(0.0)
			var visible := screen.get_visible_rect()
			var bounds := extent_in_view(original, camera)
			if mode == "outdoor":
				if not reference.get_visible_rect().grow(0.01).encloses(extent_in_view(camera, original)):
					return fail("Outdoor view extends past the paint at %s" % pixels)
			elif not visible.grow(0.01).encloses(bounds) or not bounds.get_center().is_equal_approx(visible.get_center()):
				return fail("Paint extends past %s at %s: %s" % [mode, pixels, bounds])
			elif absf(bounds.size.x - visible.size.x) > 0.01 and absf(bounds.size.y - visible.size.y) > 0.01:
				return fail("Neither painting dimension fills %s at %s" % [mode, pixels])
	var cottage := location.duplicate() as Node3D
	cottage.name = "Cottage"
	cottage.position.x += 100.0
	var cottage_camera := cottage.get_node("PaintCamera") as Camera3D
	cottage_camera.near = 4.0
	cottage_camera.far = 160.0
	world.add_child(cottage)
	for stop in [cottage, location]:
		world.go(stop, stop.global_position)
		var expected: Camera3D = stop.paint_cam
		if camera.near != expected.near or camera.far != expected.far:
			return fail("Wrong clip planes in %s: %s to %s" % [stop.name, camera.near, camera.far])
	print("PAINTED_CAMERA_OK")
	quit()


func fail(message: String) -> void:
	push_error(message)
	quit(1)
