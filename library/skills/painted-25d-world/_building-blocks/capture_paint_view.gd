extends Node
## Renders a location's plain, lit blockout through its PaintCamera into a PNG of an exact size, then quits.
## Make a scene with only this node, set `level` (the world scene) and `camera_path`, and play it. The PNG is the
## structure image for the paint-over. Keep size at the painting's aspect (16:9). Needs a rendering run (the
## editor's play, or a windowed run); a --headless run renders nothing.

@export var level: PackedScene
@export var size := Vector2i(2048, 1152)
@export var out_path := "res://painted/blockout.png"
## The location's paint camera inside `level`.
@export var camera_path := "Village/PaintCamera"

func _ready() -> void:
	var vp := SubViewport.new()
	vp.size = size
	vp.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	vp.own_world_3d = true
	add_child(vp)
	var lvl := level.instantiate()
	# no painting: painted_world.gd then shows the plain blockout, lit, through the paint camera
	for node in lvl.find_children("*", "Node3D", true, false):
		if "paint" in node:
			node.paint = null
	vp.add_child(lvl)
	await get_tree().process_frame
	(lvl.get_node(camera_path) as Camera3D).make_current()
	for i in 4:
		await RenderingServer.frame_post_draw
	var img := vp.get_texture().get_image()
	img.save_png(out_path)
	print("PAINT_VIEW_SAVED ", ProjectSettings.globalize_path(out_path), " ", img.get_size())
	get_tree().quit()
