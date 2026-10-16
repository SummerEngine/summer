# scene-scripting: the extended ctx API

The second and later tiers of the `ctx` object that `summer_run_script` hands to `func run(ctx):`. The core tier (creation helpers, `find`, `save_scene`, `summary`) is in the `scene-scripting` skill. Call results from `ctx` are untyped: write `var wall = ctx.add_mesh(...)`, never `var wall := ...` (GDScript cannot infer a type from an untyped call and refuses to compile).

## The geometry & authoring stdlib (geometry tier)

Newer engines extend ctx with a second tier: real geometry (booleans, lathe, sweep, terrain), mesh post-processing (smooth, decimate, UVs, mirror, collision), keyframe animation, and text shaders. Frozen signatures:

```gdscript
boolean(a: Node, b: Node, op: String = "union") -> MeshInstance3D
    # op: union|difference|intersection. Manifold-exact CSG, baked to a plain
    # ArrayMesh — no live CSG nodes remain. a and b are CONSUMED (freed) by
    # default; pass keep_inputs: bool = true as the final param to keep them.
extrude_polygon(points: PackedVector2Array, depth: float, name: String,
                parent: Node = null) -> MeshInstance3D        # 2D footprint -> prism, baked
lathe(points: PackedVector2Array, name: String, parent: Node = null,
      spin_degrees: float = 360.0, sides: int = 32) -> MeshInstance3D  # revolve a profile, baked
sweep(points: PackedVector2Array, path_points: PackedVector3Array,
      name: String, parent: Node = null) -> MeshInstance3D    # profile swept along a 3D path, baked
# add_mesh shapes extended: torus | text (props.text: String, TextMesh)
set_smooth(node: Node, angle_deg: float = 30.0) -> bool       # shade smooth by angle
terrain(size: Vector2, height: float, seed: int, name: String,
        parent: Node = null, image_path: String = "") -> MeshInstance3D
    # noise heightfield (or heightmap image via image_path); adds
    # HeightMapShape3D collision under a StaticBody3D child automatically
decimate(node: Node, ratio: float) -> bool                    # simplify mesh to ~ratio of triangles
convex_collision(node: Node, decompose: bool = false) -> Node
    # single convex hull, or multi-shape convex decomposition when decompose;
    # ALL created bodies are owned — they survive the save
uv_planar(node: Node, axis: String = "y", scale: float = 1.0) -> bool
uv_box(node: Node, scale: float = 1.0) -> bool                # make textures land on generated geometry
mirror(node: Node, axis: String = "x") -> Node                # mirrored duplicate
animate(node: Node, property: String, keys: Array, anim_name: String = "",
        loop: bool = false, player: AnimationPlayer = null) -> AnimationPlayer
    # keys: [[time_s, value], ...]; gets-or-creates the AnimationPlayer and
    # library; position/rotation/scale get dedicated 3D tracks (rotation keys
    # are converted for you — never hand-build quaternion tracks)
make_shader(code: String, params: Dictionary = {}) -> ShaderMaterial
    # builds Shader + ShaderMaterial from source and sets shader parameters;
    # compile errors come back VERBATIM in the result (the `make_shader_errors`
    # report entry, plus errors[]) — read them
```

Conventions, same as the rest of the stdlib: creation helpers set the owner and return the created node; bad input produces a per-helper `report` entry plus a `null`/`false` return, never a crash; every baked mesh carries generated normals (and tangents where UVs exist). On an older engine these helpers are missing — the CSG-node fallback recipe in `recipes-3d.md` (next to this file) still works everywhere.

## The animation stdlib (animation tier)

Character-animation USAGE on top of `animate()` — state machines, method tracks, bone poses, head tracking. Same conventions. Frozen signatures:

```gdscript
animate(...) v2 — additive extensions, signature unchanged:
    # keys entries also accept {time, value, interpolation: "nearest"|"linear"|"cubic"}
    # property may target bones: "<skeleton_node>:<bone_name>/position|rotation|scale"
    #   -> creates bone position_3d/rotation_3d/scale_3d tracks (path "Skeleton:bone")
animate_method(node: Node, calls: Array, anim_name: String = "",
               loop: bool = false, player: AnimationPlayer = null) -> AnimationPlayer
    # calls: [[time_s, method_name, args_array], ...] -> one method-call track
anim_state_machine(target: Node, spec: Dictionary,
                   player: AnimationPlayer = null) -> AnimationTree
    # spec: { states: {name: clip_name}, transitions: [[from, to, {auto?: bool,
    #   blend_s?: float}], ...], start: name }
    # get-or-create AnimationTree wired to the (found or given) player,
    # AnimationNodeStateMachine, active=true; unknown clip names -> report
    # entry listing the player's actual clips (never silent)
bone_pose(skeleton: Node, bone: String, pose: Dictionary) -> bool
    # pose keys position/rotation/scale -> set_bone_pose_* on Skeleton3D;
    # unknown bone -> false + report listing bone names (capped 64)
look_at_modifier(node: Node, target: Node, props: Dictionary = {}) -> Node
    # LookAtModifier3D under the skeleton/node, owned
```

Blend shapes key through plain `animate()` with property `"blend_shapes/<name>"` (value tracks) — no separate helper. The end-to-end recipe (inspect an imported rig's real clips/bones, locomotion wiring, footstep method tracks, root motion, the raw-GDScript fallback for engines without these helpers) lives in `character-animation-wiring` — one hop, not duplicated here.

## The game-completeness stdlib (game-completeness tier: 2D, UI, gameplay code)

Everything a script needs to produce a GAME, not just a 3D scene: 2D levels, Control trees, persisted signal connections, attached scripts, prefabs, project settings. Same conventions (owner-by-default, return the node, `prop_warnings`, structured report entries on failure — never silent). 2D helpers work in any edited scene (root may be `Node2D` or `Node`); Control helpers parent under the edited root unless a parent is given. Frozen signatures:

```gdscript
# 2D
add_sprite(texture_path: String, name: String, parent: Node = null,
           props: Dictionary = {}) -> Sprite2D          # missing texture -> report + null
add_animated_sprite(frames: Dictionary, name: String, parent: Node = null,
                    autoplay: String = "") -> AnimatedSprite2D
    # frames: { anim_name: { frames: [texture_paths], fps: float, loop: bool } } -> SpriteFrames
add_tilemap(tileset_path: String, name: String, parent: Node = null) -> TileMapLayer
paint_tiles(layer: TileMapLayer, cells: Array, source_id: int,
            atlas_coords: Vector2i = Vector2i.ZERO) -> int     # cells: [Vector2i]; returns count
paint_rect(layer: TileMapLayer, rect: Rect2i, source_id: int,
           atlas_coords: Vector2i = Vector2i.ZERO) -> int
add_body_2d(kind: String, name: String, parent: Node = null,
            shape: Dictionary = {}, props: Dictionary = {}) -> Node
    # kind: static|rigid|character|area ; shape: {type: rect|circle|capsule, size|radius|height}
    # -> body + owned CollisionShape2D child. Empty shape = a 32x32 rect (confessed in
    #    prop_warnings); size may be a float (square); props try the body, then the shape
add_camera_2d(position: Vector2, zoom: Vector2 = Vector2.ONE, make_current: bool = true,
              limits: Rect2i = Rect2i()) -> Camera2D          # empty limits = unlimited
    # Camera2D has no saved "current" flag: make_current persists as `enabled` (+ a live
    # make_current()); make_current: false saves the camera disabled
add_parallax(layers: Array, name: String, parent: Node = null) -> Node
    # layers: [{texture: path, motion_scale: Vector2, repeat: Vector2i}] -> one Parallax2D per
    #   layer under one Node2D group; repeat -> repeat_size. Parallax2D is in the engine tree
    #   (no ParallaxBackground fallback); a layer whose texture fails to load is skipped + reported

# UI (Control)
add_ui(kind: String, name: String, parent: Node = null, props: Dictionary = {}) -> Control
    # kind: label|button|panel|vbox|hbox|grid|margin|texture_rect|progress_bar|line_edit|
    #       rich_text|color_rect|center ; panel -> PanelContainer (container semantics for HUD
    #       layouts; a plain Panel is add_node("Panel", ...)). props.anchor: full_rect|center|
    #       top_left|top_right|bottom_left|bottom_right|top_wide|bottom_wide (+ the other
    #       Control::PRESET_* names) -> set_anchors_and_offsets_preset, applied BEFORE the other
    #       props so an explicit size/position wins; props.text/custom_minimum_size/etc via set();
    #       props.texture as a "res://" path is loaded for you. A Control parented under a Node2D
    #       gets a prop_warning (it scrolls with the camera — HUDs go under add_canvas_layer)
add_canvas_layer(name: String, layer: int = 1, parent: Node = null) -> CanvasLayer
set_theme_overrides(control: Control, overrides: Dictionary) -> int
    # {font_size: int, font_color: Color, <theme_item>: value} -> add_theme_*_override; count applied
    # dispatch by value: Color or "#hex" -> color; int/float -> font_size when the key is/ends with
    #   font_size, else constant; StyleBox/Font/Texture2D (or a "res://" path) -> style/font/icon.
    #   An item the control's theme type does not define is stored but confessed in prop_warnings
connect_signal(emitter: Node, signal_name: String, target: Node, method: String,
               binds: Array = []) -> bool               # PERSIST flag so it saves in .tscn;
                                                        # unknown signal/method -> report, false
    # NOT `connect` — a ctx method of that name would shadow Object.connect on the ctx object,
    #   so nothing named `connect` is bound. Method gate: target.has_method, else its script
    #   has_method, else the script SOURCE declares `func <method>(` (attached this run, not yet
    #   compiled). Already connected -> true (+ already_connected in the report). Both ends must
    #   be owned by the edited root for the .tscn to carry the connection (prop_warning otherwise)

# Gameplay-code lane
attach_script(node: Node, source: String, path: String = "") -> Script
    # compile-validate first (GDScriptLanguage::validate; parse errors -> `attach_script_errors`
    # report entry {node, path, errors: [{line, column, message}]}, null, nothing written);
    # path empty -> res://scripts/<SceneName>/<NodeName>.gd (dirs created; the root node's name
    # when the scene was never saved, prop_warning); writes the file, FS rescan, set_script.
    # An existing file at path IS overwritten; its previous sha is recorded in the report (the
    # pre-run checkpoint covers rollback). Gate: the script's native base (`extends`) must be an
    # ancestor of the node's class — else the file is written but NOT attached (report, null)
make_prefab(node: Node, path: String, replace_with_instance: bool = true) -> Node
    # pack the subtree to res:// path as a PackedScene (owner fix-up first), save; when
    # replace_with_instance the node is swapped for an instance of the new file (same
    # name/transform/parent; outgoing persisted connections re-established) and the instance
    # is returned; else returns node. REFUSES the scene root and a path open in an editor tab.
    # The node's own position is zeroed for the pack (prefab authored at its origin, like the
    # editor's Save Branch) and restored / copied onto the instance; rotation and scale stay in
    # the prefab. A failure AFTER the file was written keeps + returns the original node (report)
add_autoload(name: String, path: String) -> bool       # ProjectSettings autoload/<name>="*res://…"
    # same gates as the editor's autoload dock: valid identifier, no engine/global-class
    # collision, existing res:// path to a Script or PackedScene
add_input_action(action: String, events: Array) -> bool
    # events: [{type: key, keycode: String|int} | {type: mouse_button, button_index: int} |
    #          {type: joypad_button, button_index: int} | {type: joypad_axis, axis:int, value:float}]
    # writes input/<action> = {deadzone, events} in ProjectSettings + saves; every event is
    # built BEFORE anything is written — unknown shape -> report, false, nothing half-written.
    # New action: deadzone = the engine default 0.2. Existing action: keeps its deadzone and
    # gains only the events it does not already match. Keycode strings go through
    # find_keycode ("Space", "Left", "Ctrl+S" — modifiers become the event's modifier flags)
set_main_scene(path: String) -> bool                   # application/run/main_scene + save
    # path must exist and be a PackedScene
# Project settings are written in the res:// PATH form ("*res://…", "res://…"); the editor UI
# writes uid:// forms — both resolve. Do not "fix" one into the other.
```

**Engine posture. Read before relying on any of this.** The game-completeness tier is a frozen contract that not every engine build exposes yet; treat it with the same preview posture as `summer_run_script` itself (which returns `engine_lacks_op` on engines without RunSceneScript). On an engine that has RunSceneScript but predates this tier, a missing helper is a plain GDScript error (`Invalid call to method 'add_ui'…`) and, under the default `undo: "action"`, the whole run rolls back. Fall back to what works everywhere:

| Game-completeness helper | Works on every engine |
|---|---|
| `add_tilemap` / `paint_tiles` / `paint_rect` | `TileMapLayer.new()` + `layer.tile_set = load(path)`, then `layer.set_cell(coords, source_id, atlas_coords)` in a loop — the GridMap recipe, in 2D |
| `add_sprite` / `add_animated_sprite` / `add_body_2d` / `add_camera_2d` / `add_parallax` | manual `.new()` + `add_child` + `ctx.set_owner_recursive` |
| `add_ui` / `add_canvas_layer` / `set_theme_overrides` | `.new()` + `set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)` + `add_theme_constant_override(...)`, owned as above — the `ui-basics` skill's plain-node script |
| `connect_signal` | `summer_connect_signal` (persists in the `.tscn`); a raw `emitter.pressed.connect(...)` inside the run script does NOT persist |
| `attach_script` | `summer_write_file` the source, `summer_get_script_errors` on it, then `node.set_script(load(path))` in a script |
| `make_prefab` | `PackedScene.new().pack(node)` + `ResourceSaver.save(...)` (pack includes only OWNED descendants — owner rules again), then `summer_instantiate_scene` |
| `add_input_action` / `add_autoload` / `set_main_scene` | `summer_input_map_bind`; `summer_project_setting` (`autoload/<Name>`, `application/run/main_scene`) |

**Undo posture.** File-writing helpers (`attach_script`, `make_prefab`) and project-settings helpers (`add_autoload`, `add_input_action`, `set_main_scene`) are covered by the pre-run checkpoint, NOT by the packed-scene undo action — a `rolled_back: true` result has reverted the scene but not those files or settings. The result's `undo_action` note says so whenever any of them ran (`files_written: [paths]`, `project_settings_changed: [keys]`): read it, and surface `no_rewind_point: true` to the user before more work of this kind.

## Pitfalls

| Pitfall | Reality |
|---|---|
| Calling a geometry, animation or game-completeness helper on an engine that predates it | `Invalid call to method` — the run rolls back. Use the fallback table above. |
| Reading `rolled_back: true` as "nothing happened" after `attach_script` / `add_autoload` / `set_main_scene` | Files and `project.godot` sit outside the undo action. Read `files_written` / `project_settings_changed`; the checkpoint is the rollback. |
| `ctx.connect(button, "pressed", hud, "_on_pressed")` | That is `Object.connect` on the ctx object, not the helper — wrong-signature error. The helper is `ctx.connect_signal(...)`. |
| `var node := ctx.add_node(...)` | `ctx` is untyped, so the type cannot be inferred and the script does not compile. Write `var node = ctx.add_node(...)`. |
