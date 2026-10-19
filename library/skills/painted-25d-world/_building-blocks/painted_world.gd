extends Node3D
## Painted 2.5D level. Every mesh under $Painted shows `paint`, projected from $PaintCamera.
## The game camera keeps the paint camera's direction and only moves, so surfaces hidden in the
## painting stay hidden. The player and the camera are clamped to the painted frame.
## Scene: PaintCamera (Camera3D, orthographic, KEEP_WIDTH), GameCamera (Camera3D), Painted (the blockout).
## With no `paint` set the level shows the plain blockout through PaintCamera: play it and capture that
## frame as the paint-over's structure image.

const PROJECTION := preload("res://painted/paint_projection.gdshader")

## The paint-over. Leave empty to see the blockout through PaintCamera (the capture for the paint-over).
@export var paint: Texture2D
@export var player_path: NodePath
## The game camera shows 1 / zoom of the painted width. Keep painting px per metre >= screen px per metre.
@export var zoom := 2.0

@onready var paint_cam: Camera3D = $PaintCamera
@onready var game_cam: Camera3D = $GameCamera
@onready var player: Node3D = get_node(player_path)
var paint_size: Vector2

func _ready() -> void:
	if paint == null:
		paint_cam.make_current()
		set_physics_process(false)
		return
	paint_size = Vector2(paint_cam.size, paint_cam.size * paint.get_height() / float(paint.get_width()))
	var mat := ShaderMaterial.new()
	mat.shader = PROJECTION
	mat.set_shader_parameter("paint", paint)
	mat.set_shader_parameter("paint_origin", paint_cam.global_position)
	mat.set_shader_parameter("paint_right", paint_cam.global_basis.x)
	mat.set_shader_parameter("paint_up", paint_cam.global_basis.y)
	mat.set_shader_parameter("paint_size", paint_size)
	for mi in $Painted.find_children("*", "MeshInstance3D", true, false):
		(mi as MeshInstance3D).material_override = mat
		(mi as MeshInstance3D).cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	game_cam.projection = Camera3D.PROJECTION_ORTHOGONAL
	game_cam.keep_aspect = Camera3D.KEEP_WIDTH
	game_cam.global_basis = paint_cam.global_basis
	game_cam.size = paint_cam.size / zoom
	game_cam.far = paint_cam.far
	game_cam.make_current()
	if player.has_method("setup"):
		player.setup(paint_cam.global_basis)

## Where p sits in the paint camera's picture plane, in metres from the frame centre.
func plane(p: Vector3) -> Vector2:
	var d := p - paint_cam.global_position
	return Vector2(d.dot(paint_cam.global_basis.x), d.dot(paint_cam.global_basis.y))

func _physics_process(_delta: float) -> void:
	# keep the player inside the painting (move along the ground, not through the air)
	var half := paint_size / 2.0 - Vector2(1.0, 1.5)
	var c := plane(player.global_position)
	var clamped := c.clamp(-half, half)
	if clamped != c:
		var fwd := -paint_cam.global_basis.z
		var far := Vector3(fwd.x, 0, fwd.z).normalized()
		player.global_position += paint_cam.global_basis.x * (clamped.x - c.x) + far * (clamped.y - c.y) / far.dot(paint_cam.global_basis.y)
	# follow by translation only, and never show past the painting's edge
	var view := Vector2(game_cam.size, game_cam.size * paint_size.y / paint_size.x)
	var t := plane(player.global_position).clamp(-(paint_size - view) / 2.0, (paint_size - view) / 2.0)
	game_cam.global_position = paint_cam.global_position + paint_cam.global_basis.x * t.x + paint_cam.global_basis.y * t.y
