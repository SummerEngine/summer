extends CharacterBody3D
## Sprite character on a capsule. Input moves in screen directions: up = away from the camera on the ground.
## The sprite is a vertical Y-billboard, stretched by 1 / cos(camera pitch) so it reads at full height from the
## tilted camera. Eight facings picked by 45 degree sectors; a missing diagonal falls back to its side row.
## The gait depends on the game type. Cozy, exploration and RPG games walk by default (about 1.8 m/s, walk cycle)
## and run on Shift (about 4 m/s, run cycle); action games may run by default (move_speed about 4.2). The cycle is
## chosen by speed (run cycle from `run_cycle_from`), and speed_scale = speed / the cycle's natural speed, so the
## feet never slide. Never play the run cycle for the default gait of a cozy game.
## Sheet: one row per animation (idle_down, walk_up_left, run_right, ...), fixed cell size. The json beside it:
## {"cell_w", "cell_h", "frames", "rows", "fps": {"idle": 6, "walk": 10, "run": 14}, "height_m": 1.8,
##  "stride_m": {"walk": 0.94, "run": 1.68}, "cycles_per_s": {"walk": 1.25, "run": 1.75}}
## (stride_m = metres per cycle at height_m).

const DIRS := ["right", "up_right", "up", "up_left", "left", "down_left", "down", "down_right"]

@export var sheet: Texture2D
@export_file("*.json") var sheet_json := ""
## About door height / 1.15: 2.15 m next to 2.5 m doors.
@export var height_m := 2.15
## m/s, the default gait. Cozy / exploration / RPG: 1.8 (walk cycle). Action: about 4.2 (run cycle).
@export var move_speed := 1.8
## m/s while Shift is held (run cycle). Cozy: 4.0. Action: up to 1.8x the run cycle's natural speed.
@export var sprint_speed := 4.0
## m/s from which the run cycle plays instead of the walk cycle.
@export var run_cycle_from := 3.0
## Tests and agents drive the character with this instead of keys (x = screen right, y = screen up):
## length up to 1 is the default gait, above 1 sprints.
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

## Ground speed (m/s) at which this kind's cycle keeps the feet still: stride (scaled to this height) x cycles/s.
## Without measurements: the generated cycles' typical values (walk 0.57, run 1.63 body heights per second).
func natural_speed(kind: String) -> float:
	var stride = meta.get("stride_m", {}).get(kind)
	if stride == null:
		return height_m * (1.63 if kind == "run" else 0.57)
	var cycles = meta.get("cycles_per_s", {}).get(kind, _fps(kind) / float(meta.frames))
	return float(stride) * height_m / float(meta.get("height_m", height_m)) * float(cycles)

## The cycle for a ground speed: the walk cycle below `run_cycle_from`, the run cycle from there.
func cycle_for(speed: float) -> String:
	if not sprite.sprite_frames.has_animation("run_down") or speed < run_cycle_from:
		return "walk"
	return "run"

func _play(kind: String, speed: float) -> void:
	var side := "left" if facing.ends_with("left") else ("right" if facing.ends_with("right") else facing)
	for anim in [kind + "_" + facing, kind + "_" + side, kind + "_down"]:
		if sprite.sprite_frames.has_animation(anim):
			sprite.play(anim)
			break
	sprite.speed_scale = 1.0 if kind == "idle" else clampf(speed / natural_speed(kind), 0.25, 4.0)

func _physics_process(delta: float) -> void:
	var v := input_override
	var speed := move_speed
	if v != Vector2.ZERO:
		speed = sprint_speed if v.length() > 1.05 else move_speed
	else:
		v = Input.get_vector("ui_left", "ui_right", "ui_down", "ui_up")
		if Input.is_key_pressed(KEY_SHIFT):
			speed = sprint_speed
	if v.length() < 0.1:
		speed = 0.0
	var right := Vector3(cam_basis.x.x, 0, cam_basis.x.z).normalized()
	var far := Vector3(-cam_basis.z.x, 0, -cam_basis.z.z).normalized()
	var dir := (right * v.x + far * v.y).normalized()
	velocity.x = dir.x * speed
	velocity.z = dir.z * speed
	velocity.y = 0.0 if is_on_floor() else velocity.y - 20.0 * delta
	move_and_slide()
	if speed > 0.0:
		facing = DIRS[wrapi(roundi(v.angle() / (PI / 4.0)), 0, 8)]
		_play(cycle_for(speed), speed)
	else:
		_play("idle", 0.0)
