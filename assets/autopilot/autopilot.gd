# Autopilot — boots your game offscreen, finds the player, optionally drives it through
# a list of waypoints, saves a frame at each step, asserts what it saw, and exits.
#
# This is a starting point, not a finished test. Edit CONFIG below to match your game,
# then add your own assertions in _check_at_waypoint() / _check_at_end(). Everything
# here is ordinary GDScript against your real running game — there is no test
# framework to learn.
#
# Run it:
#   bash tests/autopilot/run.sh
# or from an agent, as a RunVerification probe (see tests/autopilot/README.md).

extends "res://tests/autopilot/probe_base.gd"

# ── CONFIG — edit this ────────────────────────────────────────────────────────────

# Node path to the player, from the current scene root. If nothing is at this path the
# probe looks for the first CharacterBody2D/3D, then the first RigidBody2D/3D, then any
# Node2D/Node3D whose name contains "player", and reports what it picked and how in
# reports.player_found_by / reports.player_path. Paste that path here once you know it.
const PLAYER_PATH := "Player"

# Input action names from your project's Input Map. Leave an entry empty to skip it.
const ACT_LEFT  := "move_left"
const ACT_RIGHT := "move_right"
const ACT_UP    := ""              # "move_forward" in 3D, "move_up" in top-down 2D
const ACT_DOWN  := ""
const ACT_JUMP  := "jump"

# Where to walk. 2D games use x/y in pixels; 3D games use x/z in metres (y ignored).
# Positions are WORLD positions, not offsets.
#
# EMPTY means a smoke test: boot the game, let it run, save frames, and pass when the
# engine logged no errors. Add waypoints once you know your level — they are what
# turns "it boots" into "the player can get from here to there":
#   const WAYPOINTS: Array = [Vector3(300, 0, 0), Vector3(600, 0, 0)]   # 2D, pixels
#   const WAYPOINTS: Array = [Vector3(5, 0, 0), Vector3(5, 0, -8)]      # 3D, metres
const WAYPOINTS: Array = []

# How close counts as arrived, and how long to allow per leg before giving up.
const ARRIVE_EPSILON := 40.0
const LEG_TIMEOUT_FRAMES := 240

# ── END CONFIG ────────────────────────────────────────────────────────────────────

var _player: Node = null
var _is_3d := false


func _ready() -> void:
    await super._ready()

    # Let the scene settle. Physics frames, not timers — timers are wall-clock and
    # make results differ between runs and between machines.
    for _i in 30:
        await get_tree().physics_frame

    var scene := get_tree().current_scene
    if scene == null:
        report("error", "no current scene — is run/main_scene set in project.godot?")
        finish()
        return

    var bound := _bind_player(scene)
    if bound:
        report("player_path", str(scene.get_path_to(_player)))
        report("player_class", _player.get_class())
        report("mode", "3D" if _is_3d else "2D")
        report("start_pos", str(_pos()))
    else:
        report("mode", "3D" if scene is Node3D else ("2D" if scene is Node2D else "unknown"))
    dump_tree()
    await settle()
    save_frame("00_start")

    if WAYPOINTS.is_empty():
        # Smoke test: nothing configured to walk to. Let the game run for a second and
        # take a second frame so the flipbook shows it running, not just booted.
        report("smoke", true)
        for _i in 60:
            await get_tree().physics_frame
        save_frame("01_running")
        _check_at_end()
        finish()
        return

    if not bound:
        report("error", "waypoints are configured but no player was found at '%s' (or by auto-detect)" % PLAYER_PATH)
        finish()
        return

    for i in WAYPOINTS.size():
        var target: Vector3 = WAYPOINTS[i]
        var arrived := await _walk_to(target)
        report("waypoint_%d_reached" % i, arrived)
        report("waypoint_%d_pos" % i, str(_pos()))
        save_frame("%02d_waypoint_%d" % [i + 1, i])
        _check_at_waypoint(i)
        if not arrived:
            report("failed_at_waypoint", i)
            break

    _check_at_end()
    finish()


# ── Your assertions go here ───────────────────────────────────────────────────────

# Called after arriving at (or failing to reach) each waypoint.
func _check_at_waypoint(index: int) -> void:
    # Assert things that are TRUE OR FALSE, not things that are approximately a number.
    # Hold durations are wall-clock, so exact distances drift between runs.
    #
    #   var hud := get_tree().current_scene.get_node_or_null("UI/HUD")
    #   report("hud_visible_at_%d" % index, hud != null and hud.visible)
    #   report("enemies_alive_at_%d" % index, get_tree().get_nodes_in_group("enemy").size())
    pass


# Called once at the end of the run (after the last waypoint, or after the smoke run).
func _check_at_end() -> void:
    #   report("player_alive", _player != null and _player.has_method("is_alive") and _player.is_alive())
    pass


# ── Machinery — you should not need to edit below this line ───────────────────────

# Resolve the player: CONFIG path first, then auto-detect. Records how it was found
# (reports.player_found_by) so the next edit to CONFIG is a paste, not a guess.
func _bind_player(scene: Node) -> bool:
    var found_by := "config PLAYER_PATH"
    _player = scene.get_node_or_null(PLAYER_PATH)
    if _player != null and not _is_spatial(_player):
        report("player_config_note", "'%s' is a %s, not a Node2D/Node3D — ignored" % [PLAYER_PATH, _player.get_class()])
        _player = null
    if _player == null:
        _player = _find_first(scene, func(n: Node) -> bool: return n is CharacterBody2D or n is CharacterBody3D)
        found_by = "first CharacterBody2D/3D"
    if _player == null:
        _player = _find_first(scene, func(n: Node) -> bool: return n is RigidBody2D or n is RigidBody3D)
        found_by = "first RigidBody2D/3D"
    if _player == null:
        _player = _find_first(scene, func(n: Node) -> bool: return _is_spatial(n) and n.name.to_lower().contains("player"))
        found_by = "name contains 'player'"
    if _player == null:
        report("player_found_by", "none")
        report("scene_children", _child_names(scene))
        return false
    report("player_found_by", found_by)
    _is_3d = _player is Node3D
    return true


func _is_spatial(n: Node) -> bool:
    return n is Node2D or n is Node3D


# Depth-first search below `root` (root itself excluded) for the first node `pred`
# accepts. Returns null when nothing matches.
func _find_first(root: Node, pred: Callable) -> Node:
    for c in root.get_children():
        if pred.call(c):
            return c
        var deeper := _find_first(c, pred)
        if deeper != null:
            return deeper
    return null


func _child_names(n: Node) -> Array:
    var names := []
    for c in n.get_children():
        names.append(c.name)
    return names


# Player position normalised to a Vector3 so one code path handles 2D and 3D.
# In 2D, x/y are screen pixels and z is unused.
func _pos() -> Vector3:
    if _is_3d:
        var p: Vector3 = _player.global_position
        return p
    var p2: Vector2 = _player.global_position
    return Vector3(p2.x, p2.y, 0.0)


# Distance that matters for "did we arrive", measured ONLY on axes the game can
# actually steer. A side-on platformer has no up/down actions, so its Y is gravity,
# not a destination — including it would mean the player never "arrives" while
# standing on the ground 368 pixels below Y=0. That is a real failure this scaffold
# hit on its first run.
func _planar_distance(a: Vector3, b: Vector3) -> float:
    var d := 0.0
    if _has_horizontal_actions():
        d += pow(b.x - a.x, 2.0)
    if _has_secondary_actions():
        var d2 := (b.z - a.z) if _is_3d else (b.y - a.y)
        d += pow(d2, 2.0)
    return sqrt(d)


func _has_horizontal_actions() -> bool:
    return _action_live(ACT_LEFT) or _action_live(ACT_RIGHT)


func _has_secondary_actions() -> bool:
    return _action_live(ACT_UP) or _action_live(ACT_DOWN)


func _action_live(action: String) -> bool:
    return action != "" and InputMap.has_action(action)


func _walk_to(target: Vector3) -> bool:
    var frames := 0
    var held: Array[String] = []

    while frames < LEG_TIMEOUT_FRAMES:
        var here := _pos()
        if _planar_distance(here, target) <= ARRIVE_EPSILON:
            _release(held)
            return true

        var want := _actions_toward(here, target)
        # Only touch actions that changed, so a held key stays held across frames
        # instead of being released and re-pressed every frame.
        for a in held:
            if not want.has(a):
                _set_action(a, false)
        for a in want:
            if not held.has(a):
                _set_action(a, true)
        held = want

        await get_tree().physics_frame
        frames += 1

    _release(held)
    return false


func _actions_toward(here: Vector3, target: Vector3) -> Array[String]:
    var out: Array[String] = []
    var dx := target.x - here.x
    if absf(dx) > ARRIVE_EPSILON * 0.5:
        var a := ACT_RIGHT if dx > 0.0 else ACT_LEFT
        if _action_live(a):
            out.append(a)

    # Second axis: z in 3D, y in 2D. Skipped when the game has no such actions
    # (a side-on platformer, for example).
    if _has_secondary_actions():
        var d2 := (target.z - here.z) if _is_3d else (target.y - here.y)
        if absf(d2) > ARRIVE_EPSILON * 0.5:
            var b := ACT_DOWN if d2 > 0.0 else ACT_UP
            if _action_live(b):
                out.append(b)

    return out


# Press and release directly rather than via press(), which awaits its own hold
# duration on the wall clock. Holding across physics frames is what makes an
# autopilot run reproducible.
func _set_action(action: String, pressed: bool) -> void:
    if action == "" or not InputMap.has_action(action):
        return
    var ev := InputEventAction.new()
    ev.action = action
    ev.pressed = pressed
    Input.parse_input_event(ev)


func _release(held: Array) -> void:
    for a in held:
        _set_action(a, false)
