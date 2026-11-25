extends Node
## Verify the projection: renders the painted world through a location's PaintCamera and saves the PNG. It must
## match the painting (compare them, or overlay). `summer_screenshot` of the scene cannot do this when the blockout
## is built by a script: scene renders do not run scripts. Make a scene with only this node and play it.

@export var level: PackedScene
@export var camera_path := "Village/PaintCamera"
@export var size := Vector2i(2048, 1152)
@export var out_path := "res://painted/paintcam_check.png"

func _ready() -> void:
	var vp := SubViewport.new()
	vp.size = size
	vp.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	vp.own_world_3d = true
	add_child(vp)
	var lvl := level.instantiate()
	vp.add_child(lvl)
	await get_tree().process_frame
	(lvl.get_node(camera_path) as Camera3D).make_current()
	for i in 6:
		await RenderingServer.frame_post_draw
	var img := vp.get_texture().get_image()
	var error := img.save_png(out_path) if img != null and not img.is_empty() else ERR_INVALID_DATA
	if error != OK:
		push_error("Could not save projection PNG at %s (%s)" % [out_path, error_string(error)])
		get_tree().quit(1)
		return
	print("PAINTCAM_SAVED ", ProjectSettings.globalize_path(out_path))
	get_tree().quit()
