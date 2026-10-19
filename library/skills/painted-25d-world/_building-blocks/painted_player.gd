extends CharacterBody3D
## Sprite character on a capsule. Input moves in screen directions: up = away from the camera on the ground.
## The sprite is a vertical Y-billboard, stretched by 1 / cos(camera pitch) so it reads at full height from the
## tilted camera. Eight facings picked by 45 degree sectors; a missing diagonal falls back to its side row.
## The animation speed follows the ground speed (stride_m), so the feet never slide.
## Sheet: one row per animation (idle_down, walk_up_left, run_right, ...), fixed cell size. The json beside it:
## {"cell_w", "cell_h", "frames", "rows", "fps": {"idle": 6, "walk": 10, "run": 14},
##  "stride_m": {"walk": 1.8, "run": 3.0}}  (metres travelled per animation cycle, at this character's height).

const DIRS := ["right", "up_right", "up", "up_left", "left", "down_left", "down", "down_right"]

@export var sheet: Texture2D
@export_file("*.json") var sheet_json := ""
## About door height / 1.15: 2.15 m next to 2.5 m doors.
@export var height_m := 2.15
## m/s. Slower feels sluggish at this camera.
@export var walk_speed := 4.2
## m/s, while Shift is held.
@export var run_speed := 7.8
## Tests and agents drive the character with this instead of keys (x = screen right, y = screen up; length > 1 runs).
var input_override := Vector2.ZERO
var cam_basis := Basis()
var sprite: AnimatedSprite3D
var facing := "down"
var meta: Dictionary

func _ready() -> void:
	meta = JSON.parse_string(FileAccess.get_file_as_string(sheet_json))
	var shape := CollisionShape3D.new()
	var cap := CapsuleShape3D.new()
	cap.radius = 0.4
	cap.height = height_m - 0.2
	shape.shape = cap
	shape.position.y = cap.height / 2.0
	add_child(shape)
	sprite = AnimatedSprite3D.new()
	sprite.sprite_frames = _frames()
	sprite.billboard = BaseMaterial3D.BILLBOARD_FIXED_Y
	sprite.shaded = false
	sprite.alpha_cut = SpriteBase3D.ALPHA_CUT_DISCARD   # writes depth, so painted walls hide the character
	add_child(sprite)

## Called by the world with the paint camera's basis.
func setup(view_basis: Basis) -> void:
	cam_basis = view_basis
	var pitch := asin(clampf(-view_basis.z.y, -1.0, 1.0))
	var h := height_m / cos(pitch)
	sprite.pixel_size = h / float(meta.cell_h)
	sprite.position.y = h / 2.0
	_play("idle", 0.0)

func _frames() -> SpriteFrames:
	var sf := SpriteFrames.new()
	sf.remove_animation("default")
	for r in meta.rows.size():
		var anim: String = meta.rows[r]
		sf.add_animation(anim)
		sf.set_animation_speed(anim, _fps(anim.get_slice("_", 0)))
		for c in int(meta.frames):
			var at := AtlasTexture.new()
			at.atlas = sheet
			at.region = Rect2(c * meta.cell_w, r * meta.cell_h, meta.cell_w, meta.cell_h)
			sf.add_frame(anim, at)
	return sf

## fps in the json: one number, or a dictionary by kind ("walk").
func _fps(kind: String) -> float:
	var fps = meta.get("fps", 8.0)
	if fps is Dictionary:
		return float(fps.get(kind, 8.0))
	return float(fps)

## Metres per animation cycle; without stride_m, typical values for this height.
func _stride(kind: String) -> float:
	var strides: Dictionary = meta.get("stride_m", {})
	return float(strides.get(kind, height_m * (1.4 if kind == "run" else 0.85)))

func _play(kind: String, speed: float) -> void:
	var side := "left" if facing.ends_with("left") else ("right" if facing.ends_with("right") else facing)
	for anim in [kind + "_" + facing, kind + "_" + side, kind + "_down"]:
		if sprite.sprite_frames.has_animation(anim):
			sprite.play(anim)
			break
	if kind == "idle":
		sprite.speed_scale = 1.0
	else:
		# one cycle covers stride_m metres: play it exactly as fast as the ground moves
		sprite.speed_scale = speed / (_stride(kind) * _fps(kind) / float(meta.frames))

func _physics_process(delta: float) -> void:
	var v := input_override
	var running := v.length() > 1.05
	if v == Vector2.ZERO:
		v = Input.get_vector("ui_left", "ui_right", "ui_down", "ui_up")
		running = Input.is_key_pressed(KEY_SHIFT)
	v = v.limit_length(1.0)
	var speed := (run_speed if running else walk_speed) * v.length()
	var right := Vector3(cam_basis.x.x, 0, cam_basis.x.z).normalized()
	var far := Vector3(-cam_basis.z.x, 0, -cam_basis.z.z).normalized()
	var dir := (right * v.x + far * v.y).normalized()
	velocity.x = dir.x * speed
	velocity.z = dir.z * speed
	velocity.y = 0.0 if is_on_floor() else velocity.y - 20.0 * delta
	move_and_slide()
	if v.length() > 0.1:
		facing = DIRS[wrapi(roundi(v.angle() / (PI / 4.0)), 0, 8)]
		_play("run" if running else "walk", speed)
	else:
		_play("idle", 0.0)
