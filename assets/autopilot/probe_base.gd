# SUMMER - Verification Runner v1: probe base class.
#
# An AI-authored probe extends this base. The engine injects the probe as a singleton
# named "SummerProbe" into a disposable, invisible --summer-verify game instance. The
# base provides the runtime API (report / save_frame / dump_tree / press / key / finish)
# and guarantees a results.json is written even if the probe hangs (at-exit backstop +
# the frames-based quit-after ceiling in main.cpp).
#
# The engine sets two members on the instance before _ready() via `set()`:
#   summer_out_dir     : String  - absolute temp dir to write results/frames into
#   summer_max_seconds : int     - soft budget; base auto-finishes at this ceiling
#
# Contract of <out_dir>/results.json:
#   { "reports": {..}, "frames": [names], "errors_seen": [strings],
#     "frame_warnings": [strings], "duration_ms": int, "finished": bool }
#
# PERCEPTION NOTES (measured against the shipped 0.5.55 binary, reproducible 3/3):
#   * This instance is NOT --headless. Headless has no renderer, so
#     viewport.get_texture().get_image() returns null and NO frame can ever be
#     captured. The verify child is a real windowed instance parked offscreen at
#     (-32000,-32000) precisely so capture works. Never add --headless here.
#   * The viewport does not hold your scene yet during _ready(). Measured, with a
#     red box on screen, sampling distinct colours in the captured image:
#         in _ready()              frames_drawn=0  ->  1 colour  (clear colour only)
#         after 1 process_frame    frames_drawn=0  ->  1 colour  (still empty)
#         after 2 process_frames   frames_drawn=1  ->  2 colours (the box is there)
#     So `await settle()` before your FIRST save_frame(). save_frame() records a
#     frame_warnings entry rather than lying if you skip it.
#   * RenderingServer.force_draw() is NOT a shortcut. Measured: it fills the image
#     with the clear colour (1 colour, all non-black) but the scene geometry is
#     still missing. A plausible-but-wrong frame is worse than a blank one.
#   * Audio IS assertable even though this instance forces the Dummy driver
#     (main.cpp, summer_verify block). AudioServer still mixes, so measured:
#         silent scene  -> AudioServer.get_bus_peak_volume_left_db(0,0) == -200.0
#         playing sound -> ... == -1.938
#   * Performance monitors work here and only here. Measured in this instance:
#     draw_calls=1, fps=46, objects=1, primitives=12. The same probe under
#     --headless reports draw_calls=0, fps=1, objects=0 -- all meaningless.
extends Node

var summer_out_dir: String = ""
var summer_max_seconds: int = 20

var _reports: Dictionary = {}
var _frames: Array = []
var _frame_warnings: Array = []
var _start_ms: int = 0
var _finished: bool = false

func _enter_tree() -> void:
	_start_ms = Time.get_ticks_msec()

func _ready() -> void:
	# Hard soft-ceiling: if the probe body never calls finish(), auto-finish just before
	# the main.cpp frames ceiling would kill us, so we still flush a partial results.json.
	var t := Timer.new()
	t.one_shot = true
	t.wait_time = float(summer_max_seconds)
	t.timeout.connect(_on_deadline)
	add_child(t)
	t.start()

func _on_deadline() -> void:
	if not _finished:
		report("_timeout", true)
		finish()

# --- Runtime API for the AI-authored probe --------------------------------------------

func report(key: String, value) -> void:
	_reports[key] = value

func settle(frames: int = 1) -> void:
	# Await until the renderer has actually PRESENTED `frames` more frames. Call this
	# before your first save_frame(), and after any change you want to see on screen.
	#
	#     await settle()          # first capture is now trustworthy
	#     save_frame("start")
	#
	# Counting presented frames (Engine.get_frames_drawn()) rather than awaiting
	# process_frame is deliberate: a process frame can complete without the renderer
	# having presented anything, which is exactly the blank-capture bug. See the
	# PERCEPTION NOTES at the top for the measurements behind this.
	#
	# But that counter only advances when there IS a renderer. Under --headless it is
	# 0 forever -- measured: 438 process frames awaited over 3005ms, frames_drawn
	# still 0 -- so waiting on it there would spin until the probe budget killed the
	# run. This base is normally injected into the windowed verify child, but the
	# headless-scripting path runs it under `--headless -s`, where that would hang.
	# So: fall back to process frames when there is no renderer, and bound the wait
	# either way so settle() can never be the reason a probe fails to finish.
	if not has_renderer():
		# +1 because content lands a frame later than the naive count suggests.
		for _i in range(maxi(1, frames) + 1):
			await get_tree().process_frame
		return
	var target := Engine.get_frames_drawn() + maxi(1, frames)
	var guard := 0
	while Engine.get_frames_drawn() < target and guard < 600:
		guard += 1
		await get_tree().process_frame
	if guard >= 600:
		report("_settle_timeout", true)

func has_renderer() -> bool:
	# True when this instance can actually draw. Use this, NOT OS.has_feature("headless"),
	# which is measurably FALSE under --headless and will mislead you. The rendering
	# method setting lies too -- it still reads "forward_plus" with no renderer behind it.
	# DisplayServer's own name is the honest signal.
	return DisplayServer.get_name() != "headless"

func settle_physics(frames: int = 1) -> void:
	# Await N physics frames. Call this after building a scene and BEFORE asserting
	# anything physical. A body added this frame has no space yet, so the natural
	# "build the scene, immediately assert physics" probe throws on frame 0:
	#   Parameter "body->get_space()" is null
	#   at: godot_physics_server_2d.cpp:997
	# One physics frame after add_child() is the minimum; raycasts and contacts
	# generally want two.
	for _i in range(maxi(1, frames)):
		await get_tree().physics_frame

func settle_navigation(max_frames: int = 60) -> bool:
	# Await until the navigation map is actually queryable, and report whether it got
	# there. Returns true on success, false if it timed out.
	#
	# This exists because the failure is SILENT. NavigationServer3D.map_get_path()
	# returns an EMPTY array with no error until the map has synchronized TWICE --
	# iteration_id == 1 is not enough. Measured here, awaiting physics_frame:
	#     frame 0-1  iter=0  path_pts=0
	#     frame 2-3  iter=1  path_pts=0     <- still empty, still no error
	#     frame 4+   iter=2  path_pts=2     <- queryable
	# So the obvious probe returns [] and reads as "navigation is broken" when
	# nothing is wrong. (map_get_closest_point() does error; map_get_path() does not.)
	# process_frame does NOT advance the iteration id as quickly -- await physics.
	var map := get_viewport().world_3d.navigation_map
	for _i in range(maxi(1, max_frames)):
		if NavigationServer3D.map_get_iteration_id(map) >= 2:
			return true
		await get_tree().physics_frame
	report("_navigation_settle_timeout", true)
	return false

func save_frame(name: String) -> String:
	# Capture the current viewport framebuffer to <out_dir>/<name> (jpg). Returns the
	# absolute path written, or "" on failure.
	#
	# If no frame has been presented yet, the file still lands (so the web side can look
	# at it) but a frame_warnings entry is recorded, because the image will be the flat
	# clear colour rather than your scene. Fix that by `await settle()` first -- do not
	# ignore the warning, the capture is not evidence of anything.
	if not has_renderer():
		var hw := "save_frame(\"%s\") called under --headless: there is NO renderer, get_image() returns null and no frame can ever be captured. Use the windowed verify path (--summer-verify), not --headless." % name
		if not _frame_warnings.has(hw):
			_frame_warnings.append(hw)
	elif Engine.get_frames_drawn() < 1:
		var w := "save_frame(\"%s\") ran before any frame was presented - the image is the clear colour, not the scene. `await settle()` first." % name
		if not _frame_warnings.has(w):
			_frame_warnings.append(w)
	var vp := get_viewport()
	if vp == null:
		return ""
	var tex := vp.get_texture()
	if tex == null:
		return ""
	var img := tex.get_image()
	if img == null:
		return ""
	var fname := name if name.ends_with(".jpg") else name + ".jpg"
	var path := summer_out_dir.path_join(fname)
	var err := img.save_jpg(path, 0.75)
	if err == OK:
		if not _frames.has(fname):
			_frames.append(fname)
		return path
	return ""

func dump_tree(max_depth: int = 6) -> void:
	# Summarize the live scene tree (names + classes) into the report under "tree".
	var root := get_tree().root
	var lines: Array = []
	_dump_node(root, 0, max_depth, lines)
	report("tree", lines)

func _dump_node(n: Node, depth: int, max_depth: int, lines: Array) -> void:
	if depth > max_depth:
		return
	var indent := "  ".repeat(depth)
	lines.append("%s%s (%s)" % [indent, n.name, n.get_class()])
	for c in n.get_children():
		_dump_node(c, depth + 1, max_depth, lines)

func press(action: String, hold_ms: int = 100) -> void:
	# Inject an input action press+release from INSIDE the process (no debugger).
	var ev := InputEventAction.new()
	ev.action = action
	ev.pressed = true
	Input.parse_input_event(ev)
	await get_tree().create_timer(hold_ms / 1000.0).timeout
	var up := InputEventAction.new()
	up.action = action
	up.pressed = false
	Input.parse_input_event(up)

func key(keycode: int, hold_ms: int = 100) -> void:
	# Inject a physical key press+release by keycode (e.g. KEY_SPACE).
	var ev := InputEventKey.new()
	ev.keycode = keycode
	ev.physical_keycode = keycode
	ev.pressed = true
	Input.parse_input_event(ev)
	await get_tree().create_timer(hold_ms / 1000.0).timeout
	var up := InputEventKey.new()
	up.keycode = keycode
	up.physical_keycode = keycode
	up.pressed = false
	Input.parse_input_event(up)

func finish() -> void:
	# Flush results.json and terminate the disposable instance.
	if _finished:
		return
	_finished = true
	_write_results(true)
	get_tree().quit()

# --- Results writing ------------------------------------------------------------------

func _collect_errors() -> Array:
	# The C++ SummerVerifyLogger appends error-level engine/script errors to errors.log.
	var errors: Array = []
	var p := summer_out_dir.path_join("errors.log")
	if FileAccess.file_exists(p):
		var f := FileAccess.open(p, FileAccess.READ)
		if f != null:
			while not f.eof_reached():
				var line := f.get_line()
				if line.strip_edges() != "":
					errors.append(line)
	return errors

func _write_results(finished: bool) -> void:
	var out := {
		"reports": _reports,
		"frames": _frames,
		"frame_warnings": _frame_warnings,
		"errors_seen": _collect_errors(),
		"duration_ms": Time.get_ticks_msec() - _start_ms,
		"finished": finished,
	}
	var path := summer_out_dir.path_join("results.json")
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f != null:
		f.store_string(JSON.stringify(out, "  "))
		f.flush()
		f.close()

func _exit_tree() -> void:
	# At-exit backstop: if finish() was never called (quit-after ceiling in main.cpp
	# killed us, or the probe crashed), still leave a partial results.json behind.
	if not _finished:
		_write_results(false)
