extends Node3D
## One painted frame: a PaintCamera, the blockout under Painted, and the paint-over projected onto it from
## that camera. With no `paint` set it shows the plain blockout (play it and capture that frame for the paint-over).
## Children: PaintCamera (Camera3D, orthographic, KEEP_WIDTH), Painted (Node3D with every block).

const PROJECTION := preload("res://painted/paint_projection.gdshader")

## The paint-over for this frame (4K, imported lossless).
@export var paint: Texture2D
## Rooms: frame the whole painting like a stage. Outdoors: follow the player.
@export var frame_whole := false

@onready var paint_cam: Camera3D = $PaintCamera
var paint_size := Vector2.ZERO
## Average colour along the painting's border: the clear colour while the player is here.
var edge_color := Color(0.1, 0.1, 0.1)

func _ready() -> void:
	if paint == null:
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
		# door slabs and steps stick out of the walls in the blockout; the painting already shows them
		if mi.name.containsn("door") or mi.name.containsn("steps"):
			mi.visible = false
			continue
		(mi as MeshInstance3D).material_override = mat
		(mi as MeshInstance3D).cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	edge_color = _edge_color()

## Where p sits in this frame's picture plane, in metres from the frame centre.
func plane(p: Vector3) -> Vector2:
	var d := p - paint_cam.global_position
	return Vector2(d.dot(paint_cam.global_basis.x), d.dot(paint_cam.global_basis.y))

func _edge_color() -> Color:
	var img := paint.get_image()
	if img == null:
		return edge_color
	if img.is_compressed():
		img.decompress()
	var w := img.get_width() - 1
	var h := img.get_height() - 1
	var sum := Color(0, 0, 0, 0)
	for i in 32:
		var t := i / 31.0
		for p in [Vector2i(int(t * w), 0), Vector2i(int(t * w), h), Vector2i(0, int(t * h)), Vector2i(w, int(t * h))]:
			sum += img.get_pixelv(p)
	return Color(sum.r / 128.0, sum.g / 128.0, sum.b / 128.0)
