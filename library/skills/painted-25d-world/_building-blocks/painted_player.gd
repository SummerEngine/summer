extends CharacterBody3D
## Sprite character on a capsule. Input moves in screen directions: up = away from the camera on the ground.
## The sprite is a vertical Y-billboard, stretched by 1 / cos(camera pitch) so it reads at full height
## from the tilted camera. Sheet: one row per animation (idle_down, walk_down, walk_up, walk_left, ...),
## fixed cell size; the json next to it lists cell_w, cell_h, frames, rows and fps (a number, or a dictionary
## by row or by kind: {"idle": 6, "walk": 10, "run": 14}).

@export var sheet: Texture2D
@export_file("*.json") var sheet_json := ""
@export var height_m := 1.7
@export var speed := 4.0
var cam_basis := Basis()
var sprite: AnimatedSprite3D
var facing := "down"

func _ready() -> void:
	var meta: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(sheet_json))
	var shape := CollisionShape3D.new()
	var cap := CapsuleShape3D.new()
	cap.radius = 0.3
	cap.height = height_m - 0.1
	shape.shape = cap
	shape.position.y = cap.height / 2.0
	add_child(shape)
	sprite = AnimatedSprite3D.new()
	sprite.sprite_frames = _frames(meta)
	sprite.billboard = BaseMaterial3D.BILLBOARD_FIXED_Y
	sprite.shaded = false
	sprite.alpha_cut = SpriteBase3D.ALPHA_CUT_DISCARD   # writes depth, so painted walls hide the character
	add_child(sprite)

## Called by the level with the paint camera's basis (painted_world.gd does this in _ready).
func setup(view_basis: Basis) -> void:
	cam_basis = view_basis
	var pitch := asin(clampf(-view_basis.z.y, -1.0, 1.0))
	var meta: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(sheet_json))
	var h := height_m / cos(pitch)
	sprite.pixel_size = h / float(meta.cell_h)
	sprite.position.y = h / 2.0
	_play("idle")

func _frames(meta: Dictionary) -> SpriteFrames:
	var sf := SpriteFrames.new()
	sf.remove_animation("default")
	for r in meta.rows.size():
		var anim: String = meta.rows[r]
		sf.add_animation(anim)
		var fps = meta.fps   # one number, or a dictionary by row ("walk_down") or by kind ("walk")
		if fps is Dictionary:
			fps = fps.get(anim, fps.get(anim.get_slice("_", 0), 8.0))
		sf.set_animation_speed(anim, float(fps))
		for c in int(meta.frames):
			var at := AtlasTexture.new()
			at.atlas = sheet
			at.region = Rect2(c * meta.cell_w, r * meta.cell_h, meta.cell_w, meta.cell_h)
			sf.add_frame(anim, at)
	return sf

func _play(kind: String) -> void:
	for anim in [kind + "_" + facing, kind + "_down", "walk_" + facing]:
		if sprite.sprite_frames.has_animation(anim):
			sprite.play(anim)
			return

func _physics_process(delta: float) -> void:
	var v := Input.get_vector("ui_left", "ui_right", "ui_down", "ui_up")
	var right := Vector3(cam_basis.x.x, 0, cam_basis.x.z).normalized()
	var far := Vector3(-cam_basis.z.x, 0, -cam_basis.z.z).normalized()
	var dir := right * v.x + far * v.y
	velocity.x = dir.x * speed
	velocity.z = dir.z * speed
	velocity.y = 0.0 if is_on_floor() else velocity.y - 20.0 * delta
	move_and_slide()
	if v.length() > 0.1:
		if absf(v.x) > absf(v.y):
			facing = "right" if v.x > 0 else "left"
		else:
			facing = "up" if v.y > 0 else "down"
		_play("walk")
	else:
		_play("idle")
