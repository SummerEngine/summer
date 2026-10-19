extends Node
## Renders the blockout through its PaintCamera into a PNG of an exact size, then quits.
## Make a scene with only this node, set `level` and `out_path`, and play it (summer_play, offscreen).
## The PNG is the structure image for the paint-over. Keep size at the painting's aspect (16:9).

@export var level: PackedScene
@export var size := Vector2i(2048, 1152)
@export var out_path := "res://painted/blockout.png"

func _ready() -> void:
	var vp := SubViewport.new()
	vp.size = size
	vp.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	vp.own_world_3d = true
	add_child(vp)
	var lvl := level.instantiate()
	# the capture shows the plain blockout: drop the level script so no paint is applied yet
	lvl.set_script(null)
	vp.add_child(lvl)
	var cam: Camera3D = lvl.get_node("PaintCamera")
	cam.current = true
	for i in 4:
		await RenderingServer.frame_post_draw
	var img := vp.get_texture().get_image()
	img.save_png(out_path)
	print("PAINT_VIEW_SAVED ", ProjectSettings.globalize_path(out_path), " ", img.get_size())
	get_tree().quit()
