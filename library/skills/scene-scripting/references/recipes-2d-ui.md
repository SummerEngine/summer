# scene-scripting: 2D, UI and gameplay-code recipes

Every recipe below is the `source` of one call: `summer_run_script(scenePath="res://<the scene>.tscn", source=<the recipe>)`. Name the scene every time; it is opened first when it is not the edited one, and the person's tab comes back after the run. The core helpers (`add_node`, `find`, `add_mesh`, `make_material`, `save_scene` ...) are in the `scene-scripting` skill itself.
These use the game-completeness tier (`ctx-api.md`, next to this file); on an engine that predates it, use the fallback table there.

## 2D platformer level — tilemap paint, character body, camera limits, parallax (game-completeness tier)

One script lays down the level: paint the ground, drop a character body with collision, bound the camera to the level, stack parallax behind it. Tile coordinates are cells; camera limits are pixels (cells × tile size — 32 here).

```gdscript
func run(ctx):
    const TILE := 32
    var ground = ctx.add_tilemap("res://tilesets/grass.tres", "Ground")
    var painted = ctx.paint_rect(ground, Rect2i(0, 12, 64, 4), 0, Vector2i(0, 0))   # floor: 64 wide, 4 deep
    painted += ctx.paint_rect(ground, Rect2i(20, 8, 6, 1), 0, Vector2i(1, 0))       # a floating platform
    painted += ctx.paint_tiles(ground, [Vector2i(10, 11), Vector2i(11, 11), Vector2i(12, 11)], 0, Vector2i(2, 0))  # a step
    ctx.report("tiles_painted", painted)

    var player = ctx.add_body_2d("character", "Player", null,
        {"type": "capsule", "radius": 14.0, "height": 60.0},
        {"position": Vector2(3 * TILE, 11 * TILE)})
    ctx.add_sprite("res://sprites/player_idle.png", "Sprite", player)

    var cam = ctx.add_camera_2d(player.position, Vector2(2, 2), true, Rect2i(0, 0, 64 * TILE, 16 * TILE))
    cam.reparent(player, false)              # follow the body...
    cam.position = Vector2.ZERO
    ctx.set_owner_recursive(cam)             # ...and re-stamp the owner after ANY reparent

    ctx.add_parallax([
        {"texture": "res://backgrounds/sky.png",   "motion_scale": Vector2(0.1, 0.1), "repeat": Vector2i(1024, 0)},
        {"texture": "res://backgrounds/hills.png", "motion_scale": Vector2(0.4, 0.4), "repeat": Vector2i(1024, 0)},
    ], "Background")
    ctx.report("level", ctx.summary())
```

Compare `tiles_painted` with the cell areas you asked for (256 + 6 + 3 here) — a short count means cells were skipped. Then `summer_snapshot_diff`: `added` must list `Ground`, `Player` **with its `CollisionShape2D` child**, the camera under `Player`, and the `Background` group with one `Parallax2D` per layer. Screenshot `target:"scene" nodePath:"Player"` to see the body standing on the floor row, then the whole scene to see the platform is reachable. Movement needs the controller script and the input actions — two recipes below. Want a working baseline instead of a blank scene? The `2d-platformer` template already has tilemap + `CharacterBody2D` + parallax wired.

## Animated sprite (game-completeness tier)

`add_animated_sprite` builds the `SpriteFrames` resource from per-frame texture paths — one entry per animation, `fps` and `loop` per clip — and optionally autoplays one. Cut a sheet into frames first (`assets.slice_sheet`, or the `sprite-sheet` skill when generating them).

```gdscript
func run(ctx):
    var player = ctx.find("Player")
    if player == null:
        ctx.report("error", "Player not found")
        return
    var anim = ctx.add_animated_sprite({
        "idle": {"frames": ["res://sprites/player/idle_0.png", "res://sprites/player/idle_1.png"], "fps": 4.0, "loop": true},
        "run":  {"frames": ["res://sprites/player/run_0.png", "res://sprites/player/run_1.png",
                            "res://sprites/player/run_2.png", "res://sprites/player/run_3.png"], "fps": 12.0, "loop": true},
        "jump": {"frames": ["res://sprites/player/jump_0.png"], "fps": 1.0, "loop": false},
    }, "Anim", player, "idle")
    ctx.report("animations", anim.sprite_frames.get_animation_names())
```

A missing texture path comes back as a report entry — read it before wondering why a clip is short. Which clip plays when is gameplay code (`anim.play("run")` from the controller's `_physics_process`), not scene setup. Verify by playing: `summer_play`, move, `summer_screenshot target:"game"` — an edit-time preview shows frame 0 only.

## HUD — canvas layer, margin, vbox, label/progress/button, anchors, theme overrides (game-completeness tier)

```gdscript
func run(ctx):
    var hud = ctx.add_canvas_layer("HUD", 1)
    var margin = ctx.add_ui("margin", "Margin", hud, {"anchor": "full_rect"})
    ctx.set_theme_overrides(margin, {"margin_left": 24, "margin_top": 24, "margin_right": 24, "margin_bottom": 24})

    var column = ctx.add_ui("vbox", "TopLeft", margin)
    var score = ctx.add_ui("label", "Score", column, {"text": "Score: 0"})
    ctx.set_theme_overrides(score, {"font_size": 28, "font_color": Color(1, 1, 1)})
    var health = ctx.add_ui("progress_bar", "Health", column,
        {"min_value": 0, "max_value": 100, "value": 100, "show_percentage": false,
         "custom_minimum_size": Vector2(240, 18)})

    var pause = ctx.add_ui("button", "PauseButton", hud, {"text": "Pause", "anchor": "top_right"})
    pause.process_mode = Node.PROCESS_MODE_ALWAYS      # still clickable while the tree is paused
    ctx.report("hud", ctx.summary())
```

`props.anchor` runs `set_anchors_and_offsets_preset` — the right way to pin a Control; hand-set `anchor_*`/`offset_*` values drift the moment the window resizes. The preset is applied before the other props, so an explicit `size`/`position` in the same dict wins. `add_ui("panel", …)` is a **PanelContainer** (it sizes to its child — a backdrop for a vbox/hbox); a plain `Panel` is `add_node("Panel", …)`. `set_theme_overrides` returns how many overrides it applied — compare with what you passed (an `int` on a key that is not `font_size` becomes a *constant* override, as with the margins above). Unknown `props` keys land in `prop_warnings` as always (use real property names: `custom_minimum_size`, not `min_size` or a guess). HUD Controls belong under a `CanvasLayer` — a Control parented under a `Node2D` scrolls with the camera and gets a `prop_warning`. For the layout and theme *design* — which container for which job, theme vs inline styling — use `ui-basics`; this is its one-script form.

## Wire a button with connect_signal() (game-completeness tier)

`ctx.connect_signal` makes a **persisted** connection (`CONNECT_PERSIST`) — it survives in the `.tscn`, exactly what the editor's ConnectionsDock writes. The target needs a method to call, so attach the script first; a script attached in the same run has not compiled yet, and `connect_signal` accepts it because the source declares `func _on_pause_pressed(` (the method gate):

```gdscript
func run(ctx):
    var hud = ctx.find("HUD")
    var button = ctx.find("PauseButton")
    if ctx.attach_script(hud, """
extends CanvasLayer

func _on_pause_pressed() -> void:
    get_tree().paused = not get_tree().paused
""") == null:
        return                                   # parse errors are in the report — fix, re-run
    if not ctx.connect_signal(button, "pressed", hud, "_on_pause_pressed"):
        return                                   # the report names the unknown signal or method
    ctx.report("wired", "PauseButton.pressed -> HUD._on_pause_pressed")
```

Never wire with a bare `button.pressed.connect(...)` inside the run script: that connection lives only in the editor process and is not saved. And the helper is `connect_signal`, not `connect` — `ctx.connect(...)` is `Object.connect` on the ctx object itself and fails with a wrong-signature error. `true` from `ctx.connect_signal` says the connection was made and flagged persistent (an already-connected pair also returns `true`, with `already_connected` in the report); both ends must be owned by the edited root or the `.tscn` cannot carry it. The proof is `summer_play`, click, `summer_screenshot target:"game"`.

## attach_script — behavior with the parse-error loop (game-completeness tier)

`attach_script` validates the source **before** writing anything: a parse error comes back as a report entry (with the line) and the return is `null` — no half-written file, no broken node. Empty `path` → `res://scripts/<SceneName>/<NodeName>.gd`.

```gdscript
func run(ctx):
    var player = ctx.find("Player")
    var script = ctx.attach_script(player, """
extends CharacterBody2D

const SPEED := 220.0
const JUMP_VELOCITY := -420.0

@onready var anim: AnimatedSprite2D = $Anim

func _physics_process(delta: float) -> void:
    if not is_on_floor():
        velocity += get_gravity() * delta
    if Input.is_action_just_pressed("jump") and is_on_floor():
        velocity.y = JUMP_VELOCITY
    var dir := Input.get_axis("move_left", "move_right")
    velocity.x = dir * SPEED
    if dir != 0.0:
        anim.flip_h = dir < 0.0
    anim.play("jump" if not is_on_floor() else ("run" if dir != 0.0 else "idle"))
    move_and_slide()
""")
    if script == null:
        return                                   # read the report: line + message; fix THAT line; re-run
    ctx.report("script", script.resource_path)
```

The loop: read the exact parse error (line and identifier) from the report → fix that line → re-run. Do not guess-and-mutate. An existing file at `path` is overwritten and its previous sha recorded in the report — the pre-run checkpoint is the rollback for that, not the undo action. Idioms (typed declarations, signals, `_ready` vs `_process`): `gdscript-patterns`. Later edits to a script already on disk: `summer_write_file` + `summer_get_script_errors`.

## make_prefab — turn a built subtree into a reusable .tscn (game-completeness tier)

Build the thing once in-scene, then pack it. With `replace_with_instance` (the default) the inline subtree is swapped for an instance of the new file — same name, transform, parent — and the instance is returned.

```gdscript
func run(ctx):
    var torch = ctx.find("Torch")               # Sprite2D + PointLight2D + Area2D you built above
    if torch == null:
        return
    var first = ctx.make_prefab(torch, "res://prefabs/torch.tscn")
    for i in range(3):
        var t = ctx.instance_scene("res://prefabs/torch.tscn", null, "Torch%d" % (i + 2))
        t.position = first.position + Vector2(160 * (i + 1), 0)
    ctx.report("prefab", first.scene_file_path)
```

The owner fix-up runs before packing, so a child you forgot to own is included instead of silently dropped. The prefab is authored at its origin — the node's position is zeroed for the pack (the editor's Save Branch default) and copied back onto the instance, so `first.position` above is still where the torch stood; rotation and scale stay in the prefab. `make_prefab` refuses the scene root (pack a child subtree, never `ctx.get_scene_root()`) and a path that is open in an editor tab. The receipt: `res://prefabs/torch.tscn` in the result's `files_written`, `Torch` now reporting a `scene_file_path`, and the copies in the diff's `added`. From here on, edit the prefab file, not the instances.

## Input actions, autoload, main scene (game-completeness tier)

Project-level wiring in one run — the platformer controller above already reads these actions:

```gdscript
func run(ctx):
    ctx.add_input_action("move_left",  [{"type": "key", "keycode": "A"}, {"type": "key", "keycode": "Left"},
                                        {"type": "joypad_axis", "axis": 0, "value": -1.0}])
    ctx.add_input_action("move_right", [{"type": "key", "keycode": "D"}, {"type": "key", "keycode": "Right"},
                                        {"type": "joypad_axis", "axis": 0, "value": 1.0}])
    ctx.add_input_action("jump",       [{"type": "key", "keycode": "Space"}, {"type": "joypad_button", "button_index": 0}])
    ctx.add_autoload("GameState", "res://scripts/autoload/game_state.gd")   # the file must exist — write it first
    if ctx.save_scene("res://levels/level_01.tscn"):
        ctx.set_main_scene("res://levels/level_01.tscn")
```

An unknown event shape → report + `false`, never a half-written action (every event is built before anything is written). A new action gets the engine's default deadzone, 0.2; re-running on an existing action keeps its deadzone and appends only the events it does not already match, so the recipe is safe to re-run. Keycode strings are `find_keycode` names (`"Space"`, `"Left"`, `"Ctrl+S"` — modifiers become the event's modifier flags). Write the autoload's script before registering it (`summer_write_file`, or `attach_script` on a node you then `make_prefab`) — `add_autoload` applies the editor dock's gates (valid identifier, no class-name collision, an existing `res://` Script or PackedScene). These helpers write the `res://` path form (`"*res://…"`, `"res://…"`); the editor UI writes `uid://` forms and both resolve — leave them be. They write `project.godot`, not the scene: the result's `undo_action` note lists them under `project_settings_changed`, outside the scene undo — checkpoint territory. Proof: `summer_play` → `summer_get_runtime_tree` shows `/root/GameState`; the keys move the body in a `target:"game"` capture.

## Verifying 2D and UI work

Same loop, different framing:

- **Diff first.** `added` must carry the bodies' `CollisionShape2D` children, the `CanvasLayer` with its Controls, one `Parallax2D` per layer. Anchors and theme overrides show up as `changed` properties on the Controls.
- **2D scene captures.** `summer_screenshot target:"scene"` on a 2D scene synthesizes a `Camera2D` and auto-fits the `CanvasItem` bounds — the 3D presets do not apply, and `framing:"camera"` errors on a scene with no 3D content. `nodePath:"Player"` frames one node (its 2D rect, children included); `size:[1280, 720]` sets the resolution that anchors resolve against.
- **UI and anything input-driven** is only proven in the running game: `summer_play`, then `summer_screenshot target:"game"`. An edit-time preview of a HUD approximates a viewport the editor does not have.
- Read the confession fields in every capture (synthetic camera, no camera, project mismatch). A capture you did not receive is not evidence — `verifying-scenes` has the full discipline.

## Pitfalls

| Pitfall | Reality |
|---|---|
| Painting tiles with `summer_set_prop`, or hand-editing `tile_map_data` | `ctx.paint_rect` / `paint_tiles` (or `set_cell` in a loop) — cells are packed data. |
| Building a HUD with a dozen `summer_add_node`/`summer_set_prop` calls | One script: `add_canvas_layer` → `add_ui` → `set_theme_overrides`. |
| `button.pressed.connect(...)` inside the run script | Not persisted — gone when the script ends. `ctx.connect_signal` (or `summer_connect_signal`) saves it in the `.tscn`. |
| `{"min_size": ...}` in `add_ui` props | Not a Control property — lands in `prop_warnings` and does nothing. The property is `custom_minimum_size`. |
| `ctx.make_prefab(ctx.get_scene_root(), ...)` | Refused. Pack a child subtree; the scene itself is `save_scene`. |
| Re-running a failed `attach_script` with a guessed fix | The parse error is in the report with the line. Read it, fix that line. |
| Judging a HUD from an edit-time scene preview | Anchors resolve against the real viewport. `summer_play` + `target:"game"`. |

