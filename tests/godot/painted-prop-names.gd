extends SceneTree

const LOCATION := preload("res://painted/painted_location.gd")
const BUILDER := preload("res://painted/blockout_builder.gd")

func _initialize() -> void:
	run.call_deferred()

func run() -> void:
	var viewport := SubViewport.new()
	viewport.size = Vector2i(600, 180)
	viewport.transparent_bg = true
	viewport.own_world_3d = true
	viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	root.add_child(viewport)

	var room := LOCATION.new()
	room.position = Vector3(36, 3, -8)
	room.rotation_degrees.y = 32.0
	room.scale = Vector3.ONE * 1.25
	var image := Image.create_empty(600, 180, false, Image.FORMAT_RGBA8)
	image.fill(Color(0.92, 0.63, 0.15))
	room.paint = ImageTexture.create_from_image(image)
	var camera := Camera3D.new()
	camera.name = "PaintCamera"
	camera.projection = Camera3D.PROJECTION_ORTHOGONAL
	camera.keep_aspect = Camera3D.KEEP_WIDTH
	camera.size = 21.0
	camera.position.z = 12.0
	room.add_child(camera)
	var builder := BUILDER.new()
	builder.name = "Painted"
	builder.spec = "res://props.json"
	room.add_child(builder)
	viewport.add_child(room)
	camera.make_current()

	var pixels: Image
	if OS.get_cmdline_user_args().has("--pixels"):
		await RenderingServer.frame_post_draw
		await RenderingServer.frame_post_draw
		pixels = viewport.get_texture().get_image()
		if pixels.save_png("res://props.png") != OK:
			quit(1)
			return
	var rows := {}
	for prop: MeshInstance3D in builder.find_children("*", "MeshInstance3D", true, false):
		var pos := Vector2i(camera.unproject_position(prop.global_position))
		rows[prop.name] = {
			"visible": prop.is_visible_in_tree(),
			"painted": prop.material_override is ShaderMaterial,
			"pixel": [pos.x, pos.y],
			"opaque": pixels.get_pixelv(pos).a > 0.95 if pixels else null,
		}
	FileAccess.open("res://result.json", FileAccess.WRITE).store_string(JSON.stringify(rows))
	quit()
