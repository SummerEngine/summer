extends Node3D
## Painted 2.5D world: painted locations (painted_location.gd: Village, Cottage, ...), one player, one game camera.
## The game camera keeps the paint direction and only moves, so surfaces hidden in a painting stay hidden.
## Outdoors it shows about `view_width` metres and is clamped inside the painting with the REAL viewport aspect;
## rooms are framed whole. The clear colour is the current painting's edge colour.
## Proof shots from the real game window: run with `-- --shots=<dir>`; the player walks and runs through
## `shot_plan`, each step saves a JPG, then the game quits. Add your door walks to shot_plan.

@export var player_path: NodePath
@export var start_location: NodePath
## Metres across the screen outdoors: about 16 m, 7-8 hero heights.
@export var view_width := 16.0
## [name, screen input (x right, y up; length > 1 runs), seconds, "follow" or "full"]
@export var shot_plan: Array = [
	["start", Vector2.ZERO, 0.6, "follow"],
	["walk", Vector2(-1, 1).normalized(), 1.6, "follow"],
	["run", Vector2(-1.8, -0.6), 0.9, "follow"],
	["full_frame", Vector2.ZERO, 0.4, "full"],
]

@onready var game_cam: Camera3D = $GameCamera
@onready var player: CharacterBody3D = get_node(player_path)
var location: Node3D
var full_view := false

func _ready() -> void:
	location = get_node(start_location)
	if location.paint == null:
		_capture_mode()
		return
	game_cam.projection = Camera3D.PROJECTION_ORTHOGONAL
	game_cam.keep_aspect = Camera3D.KEEP_WIDTH
	game_cam.far = location.paint_cam.far
	game_cam.make_current()
	_enter(location)
	if player.has_method("setup"):
		player.setup(location.paint_cam.global_basis)
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--shots="):
			_take_shots.call_deferred(arg.trim_prefix("--shots="))

## No painting yet: show the plain blockout through the paint camera, lit so its faces read for the painter
## (the painted game itself stays unshaded). Play it and capture the frame for the paint-over.
func _capture_mode() -> void:
	location.paint_cam.make_current()
	set_physics_process(false)
	if player.has_method("setup"):
		player.setup(location.paint_cam.global_basis)
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-50, 20, 0)
	sun.light_energy = 1.2
	add_child(sun)
	var env := WorldEnvironment.new()
	env.environment = Environment.new()
	env.environment.background_mode = Environment.BG_COLOR
	env.environment.background_color = Color(0.1, 0.1, 0.12)
	env.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.environment.ambient_light_color = Color.WHITE
	env.environment.ambient_light_energy = 0.55
	add_child(env)

## Doors call this: move the player into another painted location.
func go(to: Node3D, spawn: Vector3) -> void:
	location = to
	player.global_position = spawn
	player.velocity = Vector3.ZERO
	_enter(to)

func _enter(loc: Node3D) -> void:
	game_cam.global_basis = loc.paint_cam.global_basis
	RenderingServer.set_default_clear_color(loc.edge_color)
	_physics_process(0.0)

## Viewport height / width. The editor's game view and phones are not 16:9.
func _aspect() -> float:
	var vp := get_viewport().get_visible_rect().size
	return vp.y / vp.x if vp.x > 0 else 9.0 / 16.0

func _physics_process(_delta: float) -> void:
	var size: Vector2 = location.paint_size
	var aspect := _aspect()
	var fit := minf(size.x, size.y / aspect)   # the widest view that stays inside the painting
	var cam_basis: Basis = location.paint_cam.global_basis
	if location.frame_whole or full_view:
		game_cam.size = fit
		game_cam.global_position = location.paint_cam.global_position
		return
	# keep the player inside the painting (move along the ground, not through the air)
	var half := size / 2.0 - Vector2(1.0, 2.0)
	var c: Vector2 = location.plane(player.global_position)
	var clamped := c.clamp(-half, half)
	if clamped != c:
		var fwd := -cam_basis.z
		var far := Vector3(fwd.x, 0, fwd.z).normalized()
		player.global_position += cam_basis.x * (clamped.x - c.x) + far * (clamped.y - c.y) / far.dot(cam_basis.y)
	game_cam.size = minf(view_width, fit)
	var view := Vector2(game_cam.size, game_cam.size * aspect)
	var t: Vector2 = location.plane(player.global_position + Vector3(0, 1, 0)).clamp(-(size - view) / 2.0, (size - view) / 2.0)
	game_cam.global_position = location.paint_cam.global_position + cam_basis.x * t.x + cam_basis.y * t.y

func _take_shots(dir: String) -> void:
	DirAccess.make_dir_recursive_absolute(dir)
	for step in shot_plan:
		full_view = step[3] == "full"
		player.input_override = step[1]
		await get_tree().create_timer(step[2]).timeout
		await RenderingServer.frame_post_draw
		get_viewport().get_texture().get_image().save_jpg(dir.path_join(str(step[0]) + ".jpg"), 0.92)
	player.input_override = Vector2.ZERO
	full_view = false
	get_tree().quit()
