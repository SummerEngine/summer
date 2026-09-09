---
name: scene-scripting
description: Use when building or modifying a scene takes more than a couple of node/property calls — scattering instances, procedural meshes, booleans/lathe/sweep geometry, terrain, GridMap fills, lighting rigs, keyframe animation, shader FX, 2D levels (tilemaps, sprites, bodies, cameras, parallax), HUDs and Control trees, persisted signal wiring, attached scripts, prefabs, input actions/autoloads/main scene, or anything with computed placement. Runs one GDScript inside the live editor via summer_run_script instead of long CRUD chains, verifies with summer_snapshot_diff + summer_screenshot, and checks API names with summer_api_docs instead of guessing.
---

# Scene Scripting

## Overview

`summer_run_script` executes a GDScript **inside the live editor, against the currently open scene**. One script replaces a chain of `summer_add_node` / `summer_set_prop` calls, and it can do what CRUD ops cannot: loops, randomness, math, procedural geometry, reading existing nodes before deciding.

**The rule: 3 or more related ops, or ANY computed placement → write a script.** A single property tweak → `summer_set_prop`. A cold project-wide batch job → `summer_run_editor_script` (see below).

## The contract

Your source is just the function — no `extends`, no `@tool`:

```gdscript
func run(ctx):
    var root = ctx.get_scene_root()
    var node := MeshInstance3D.new()
    node.mesh = BoxMesh.new()
    root.add_child(node)
    ctx.set_owner_recursive(node)   # REQUIRED — see owner rules
    ctx.report("added", node.name)
```

- `ctx.get_scene_root()` — root node of the open scene.
- `ctx.set_owner_recursive(node)` — stamp a created subtree with the scene-root owner.
- `ctx.report(key, value)` — structured results back to you (`reports` in the result).
- `print(...)` — captured into `output`.
- Values are real GDScript: `Vector3(0, 10, 0)`, `Color(1, 0, 0, 1)`. The quoted variant-string convention (`"Vector3(0, 10, 0)"`) belongs to `summer_set_prop`, not to script code.
- Budget: `max_seconds` default 20, clamp 5–120. The script blocks the editor between frames — keep it fast; move heavy batch work to `summer_run_editor_script`. On newer engines the budget is a HARD deadline: overrun raises the script error `"Summer script budget exceeded (Ns)"` (result `budget_enforced: true`). Split the work into smaller scripts — never resubmit the same oversized one.
- Transactions: newer engines wrap the run in ONE named undo action (`undo: "action"`, the default) and roll it back on a mid-script runtime error — the result then carries `rolled_back: true` and the scene is untouched. Pass `undo: "none"` for v1 behavior (checkpoint only, partial mutations survive an error). Older engines ignore the param; treat any `errors` there as a possible half-applied mutation.

## The ctx stdlib (newer engines)

Creation helpers that **set the owner for you** (to the edited scene root) and return the created node — prefer them over the manual `new()` + `add_child` + `set_owner_recursive` dance. Frozen signatures:

```gdscript
add_node(type: String, name: String, parent: Node = null, props: Dictionary = {}) -> Node
find(name: String) -> Node                    # recursive in edited scene; null on miss
get_or_create(type: String, name: String, parent: Node = null) -> Node
instance_scene(res_path: String, parent: Node = null, name: String = "") -> Node
add_mesh(shape: String, name: String, parent: Node = null, props: Dictionary = {}) -> MeshInstance3D
    # shape: box|sphere|capsule|cylinder|plane
add_mesh_with_collision(shape, name, parent = null, props = {}) -> MeshInstance3D
    # + StaticBody3D/CollisionShape3D child matching the mesh
mesh_from_arrays(vertices: PackedVector3Array, indices: PackedInt32Array,
                 uvs: PackedVector2Array = [], name: String = "Mesh",
                 parent: Node = null) -> MeshInstance3D
make_material(props: Dictionary) -> StandardMaterial3D
apply_material(node: Node, material: Material) -> bool
grid(count_x: int, count_z: int, spacing: Vector3, maker: Callable) -> Array
    # maker(i: int, pos: Vector3) -> Node
scatter(area: AABB, count: int, maker: Callable, seed: int = 0) -> Array
add_light_rig(target: Node = null) -> Node3D   # key/fill/rim under one Node3D
ensure_environment(props: Dictionary = {}) -> WorldEnvironment
add_camera(position: Vector3, look_at: Vector3 = Vector3.ZERO,
           make_current: bool = false) -> Camera3D
summary() -> Dictionary                        # counts by class, lights, cameras, scene AABB
save_scene(path: String = "") -> bool          # ownership audit first; false + report on audit failure
frames_budget_exceeded() -> bool
```

`props` dictionaries apply via `set()` per key; unknown keys are collected into a `prop_warnings` report entry, never silently dropped — read it. On an **older engine** a missing helper is a plain GDScript error (`Invalid call to method 'add_mesh'…`): fall back to the manual form, which works everywhere.

## The geometry & authoring stdlib (Wave F engines)

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

Conventions, same as the rest of the stdlib: creation helpers set the owner and return the created node; bad input produces a per-helper `report` entry plus a `null`/`false` return, never a crash; every baked mesh carries generated normals (and tangents where UVs exist). On an older engine these helpers are missing — the CSG-node fallback recipe below still works everywhere.

## The animation stdlib (Wave G engines)

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

## The game-completeness stdlib (Wave H engines — 2D, UI, gameplay code)

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

**Engine posture — read before relying on any of this.** Wave H is a frozen contract, not a shipped engine: the helpers land as follow-up commits on engine PR #156, and no shipped engine has them today — the same preview posture as `summer_run_script` itself (which returns `engine_lacks_op` on engines without RunSceneScript). On an engine that has RunSceneScript but predates Wave H, a missing helper is a plain GDScript error (`Invalid call to method 'add_ui'…`) and, under the default `undo: "action"`, the whole run rolls back. Fall back to what works everywhere:

| Wave H helper | Works on every engine |
|---|---|
| `add_tilemap` / `paint_tiles` / `paint_rect` | `TileMapLayer.new()` + `layer.tile_set = load(path)`, then `layer.set_cell(coords, source_id, atlas_coords)` in a loop — the GridMap recipe, in 2D |
| `add_sprite` / `add_animated_sprite` / `add_body_2d` / `add_camera_2d` / `add_parallax` | manual `.new()` + `add_child` + `ctx.set_owner_recursive` |
| `add_ui` / `add_canvas_layer` / `set_theme_overrides` | `.new()` + `set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)` + `add_theme_constant_override(...)`, owned as above — or the `ui-basics` skill's `summer_add_node` / `summer_set_prop` path |
| `connect_signal` | `summer_connect_signal` (persists in the `.tscn`); a raw `emitter.pressed.connect(...)` inside the run script does NOT persist |
| `attach_script` | `summer_write_file` the source, `summer_get_script_errors` on it, then `node.set_script(load(path))` in a script |
| `make_prefab` | `PackedScene.new().pack(node)` + `ResourceSaver.save(...)` (pack includes only OWNED descendants — owner rules again), then `summer_instantiate_scene` |
| `add_input_action` / `add_autoload` / `set_main_scene` | `summer_input_map_bind`; `summer_project_setting` (`autoload/<Name>`, `application/run/main_scene`) |

**Undo posture.** File-writing helpers (`attach_script`, `make_prefab`) and project-settings helpers (`add_autoload`, `add_input_action`, `set_main_scene`) are covered by the pre-run checkpoint, NOT by the packed-scene undo action — a `rolled_back: true` result has reverted the scene but not those files or settings. The result's `undo_action` note says so whenever any of them ran (`files_written: [paths]`, `project_settings_changed: [keys]`): read it, and surface `no_rewind_point: true` to the user before more work of this kind.

## Owner rules — the silent killer

<EXTREMELY-IMPORTANT>
**Every node you create must be owned by the scene root, or it silently vanishes when the scene saves.** Descendants too — being under an owned node is NOT enough. `add_child` succeeds, the screenshot even shows it, and the saved `.tscn` is missing it.

```gdscript
root.add_child(node)
ctx.set_owner_recursive(node)   # node + every descendant
```

`ctx.set_owner_recursive(node)` is the ctx helper for exactly this; the manual form is `node.owner = root` on the node AND each descendant. Either way, set owners AFTER `add_child` — owner assignment fails on a node not yet in the tree.
</EXTREMELY-IMPORTANT>

## The loop

1. `summer_world_snapshot` — the structured BEFORE baseline; keep its `snapshot_id`.
2. `summer_api_docs` — verify every property/method name you are not certain of.
3. `summer_run_script` — run the script.
4. Read `errors`, `reports`, and `rolled_back` in the result — `rolled_back: true` means a runtime error undid everything (fix and re-run); on older engines / `undo: "none"`, an error can leave a partial mutation.
5. `summer_snapshot_diff from_id:<the id>` — the structural receipt: exactly the nodes you meant to add were added, nothing else changed, nothing vanished (an unowned node dropping on save shows up HERE).
6. `summer_screenshot` — LOOK at it. Use `target:"scene" framing:"camera"` when the change touched lighting, environment, or emissive materials — the preset framings render a flat substitute environment and cannot show those.
7. Iterate. Never claim visual success without steps 5–6 (honesty rule: a capture is a fact; describing an unseen frame is fabrication). The full perception discipline lives in `verifying-scenes`.

## Verify names with summer_api_docs — never guess

Wrong property names fail silently or throw mid-script after half the mutation applied. Before using an unfamiliar class:

```
summer_api_docs class_name:"CylinderMesh"            → all properties/methods
summer_api_docs class_name:"BoxShape3D" member:"size" → {type:"Vector3", default:"Vector3(1, 1, 1)"}
```

Entries list only members **declared on that class** — `position` lives on `Node3D`, not `MeshInstance3D`. Walk `inherits` upward when a member seems missing.

## Recipes

### Scatter N instances with randomized transforms

```gdscript
func run(ctx):
    var root = ctx.get_scene_root()
    var rng := RandomNumberGenerator.new()
    rng.seed = 12345                       # deterministic re-runs
    var source: PackedScene = load("res://props/tree.tscn")
    for i in range(40):
        var tree := source.instantiate()
        root.add_child(tree)
        ctx.set_owner_recursive(tree)      # owns the whole instanced subtree
        tree.position = Vector3(rng.randf_range(-20, 20), 0, rng.randf_range(-20, 20))
        tree.rotation.y = rng.randf_range(0, TAU)
        var s := rng.randf_range(0.8, 1.3)
        tree.scale = Vector3(s, s, s)
    ctx.report("scattered", 40)
```

### Procedural mesh via SurfaceTool

```gdscript
func run(ctx):
    var root = ctx.get_scene_root()
    var st := SurfaceTool.new()
    st.begin(Mesh.PRIMITIVE_TRIANGLES)
    st.set_normal(Vector3.UP)
    st.add_vertex(Vector3(0, 0, 0))
    st.add_vertex(Vector3(1, 0, 0))
    st.add_vertex(Vector3(0, 0, 1))
    var mesh := st.commit()                 # ArrayMesh
    var mi := MeshInstance3D.new()
    mi.mesh = mesh
    mi.name = "GeneratedMesh"
    root.add_child(mi)
    ctx.set_owner_recursive(mi)
    ctx.report("surfaces", mesh.get_surface_count())
```

For grids/heightfields, build `PackedVector3Array`s and feed `ArrayMesh.add_surface_from_arrays` directly. Call `st.generate_normals()` before `commit()` when you did not set normals by hand.

### CSG primitives (fast blockouts)

```gdscript
func run(ctx):
    var root = ctx.get_scene_root()
    var body := CSGCombiner3D.new()
    body.name = "Blockout"
    root.add_child(body)
    var box := CSGBox3D.new()
    box.size = Vector3(6, 3, 6)
    body.add_child(box)
    var hole := CSGCylinder3D.new()
    hole.operation = CSGShape3D.OPERATION_SUBTRACTION
    hole.radius = 1.0
    hole.height = 7.0
    body.add_child(hole)
    ctx.set_owner_recursive(body)           # owner is the SCENE root, not the parent
```

Live CSG nodes are the **older-engine fallback** — they re-evaluate every frame and should be converted before shipping (`scene-composition`). On a Wave F engine prefer `ctx.boolean(...)`, which bakes to a plain ArrayMesh and leaves no CSG nodes behind.

### Boolean blockout — carve a doorway (Wave F)

Box minus box, baked. The inputs are consumed; only the result remains.

```gdscript
func run(ctx):
    var wall := ctx.add_mesh("box", "Wall", null, {"size": Vector3(6, 3, 0.3)})
    var hole := ctx.add_mesh("box", "DoorHole", null, {"size": Vector3(1.0, 2.1, 0.5)})
    hole.position = Vector3(0, -0.45, 0)          # sink the opening to floor level
    var carved := ctx.boolean(wall, hole, "difference")
    if carved == null:
        return                                     # reports carry the reason — read them
    carved.name = "WallWithDoorway"
    ctx.uv_box(carved)                             # boolean output needs UVs to take a texture
    ctx.report("doorway", str(carved.get_path()))
```

Then `summer_snapshot_diff` must show `Wall` and `DoorHole` GONE and `WallWithDoorway` added — leftover inputs mean the boolean failed and returned null. Screenshot to check the opening is where you meant.

### Lathe a goblet / pillar (Wave F)

`lathe` revolves a 2D profile (x = radius, y = height) around Y. Design the profile from the axis outward.

```gdscript
func run(ctx):
    var profile := PackedVector2Array([
        Vector2(0.0, 0.0),  Vector2(0.45, 0.0),   # foot
        Vector2(0.08, 0.1), Vector2(0.08, 0.55),  # stem
        Vector2(0.35, 0.7), Vector2(0.4, 1.1),    # bowl
        Vector2(0.0, 1.15),
    ])
    var goblet := ctx.lathe(profile, "Goblet", null, 360.0, 48)
    ctx.set_smooth(goblet, 40.0)                  # lathes look faceted without it
    ctx.apply_material(goblet, ctx.make_material({"albedo_color": Color(0.85, 0.7, 0.2), "metallic": 0.8, "roughness": 0.25}))
```

A square-ish profile with `sides: 8` and `spin_degrees: 360` makes a chamfered pillar; `spin_degrees: 180` makes an apse/half-dome.

### Sweep a rail / pipe (Wave F)

`sweep` extrudes a 2D cross-section along a 3D polyline.

```gdscript
func run(ctx):
    var section := PackedVector2Array([        # small circle-ish octagon, the pipe wall
        Vector2(0.05, 0), Vector2(0.035, 0.035), Vector2(0, 0.05), Vector2(-0.035, 0.035),
        Vector2(-0.05, 0), Vector2(-0.035, -0.035), Vector2(0, -0.05), Vector2(0.035, -0.035),
    ])
    var path := PackedVector3Array([
        Vector3(0, 1, 0), Vector3(4, 1, 0), Vector3(6, 1, 2), Vector3(6, 3, 6),
    ])
    var pipe := ctx.sweep(section, path, "SteamPipe")
    ctx.set_smooth(pipe, 45.0)
```

Rails, roads, cables, gutters — same recipe, different cross-section. Keep path points a reasonable distance apart; hairpin corners self-intersect.

### Terrain with collision (Wave F)

```gdscript
func run(ctx):
    var ground := ctx.terrain(Vector2(64, 64), 6.0, 1337, "Terrain")
    ctx.apply_material(ground, ctx.make_material({"albedo_color": Color(0.35, 0.5, 0.25), "roughness": 1.0}))
    ctx.report("terrain", ctx.summary())
```

Collision arrives automatically (a `StaticBody3D` + `HeightMapShape3D` child), already owned. Same seed → same terrain, so re-runs are deterministic. Pass `image_path` to drive heights from a grayscale heightmap instead of noise. Verify with `summer_screenshot framing:"camera"` — terrain reads wrong from preset framings' top-down angles.

### Text signage (Wave F)

`add_mesh` accepts `torus` and `text` on Wave F engines:

```gdscript
func run(ctx):
    var sign := ctx.add_mesh("text", "ExitSign", null, {"text": "EXIT", "depth": 0.08})
    sign.position = Vector3(0, 2.6, -4)
    ctx.apply_material(sign, ctx.make_material({"albedo_color": Color(1, 0.2, 0.2), "emission_enabled": true, "emission": Color(1, 0.1, 0.1), "emission_energy_multiplier": 3.0}))
```

Emissive text only proves itself in a `framing:"camera"` screenshot — preset framings substitute the environment and mute emission.

### Decimate for LOD, convex collision for props (Wave F)

Dense generated/imported meshes (Meshy-class output) want both before they ship:

```gdscript
func run(ctx):
    var prop := ctx.find("AncientStatue")         # e.g. a generated import
    if prop == null:
        ctx.report("error", "AncientStatue not found")
        return
    ctx.decimate(prop, 0.35)                      # keep ~35% of the triangles
    var body := ctx.convex_collision(prop, true)  # V-HACD multi-shape for concave props
    ctx.report("collision_body", str(body.get_path()))
```

`decimate` returns `false` (with a report entry) instead of ruining the mesh when the ratio is out of range. `convex_collision` owns every body it creates — the diff after `save_scene` is your receipt that nothing was silently dropped. Simple convex props (crates, rocks): leave `decompose` false, one hull is cheaper.

### Mirror symmetry (Wave F)

```gdscript
func run(ctx):
    var left_tower := ctx.find("Tower")
    var right_tower := ctx.mirror(left_tower, "x")   # mirrored duplicate, owned
    right_tower.name = "TowerMirrored"
```

The mirror is a real duplicate with flipped winding/normals — edit either side independently afterward.

### Animate — camera flythrough and a door-open (Wave F)

`animate` collapses the AnimationPlayer/library/track boilerplate into one call per property. Multiple calls with the same `anim_name` append tracks to the same clip.

```gdscript
func run(ctx):
    var cam := ctx.add_camera(Vector3(0, 4, 12), Vector3.ZERO, true)
    ctx.animate(cam, "position", [
        [0.0, Vector3(0, 4, 12)],
        [4.0, Vector3(8, 5, 4)],
        [8.0, Vector3(0, 6, -10)],
    ], "flythrough")
    ctx.animate(cam, "rotation_degrees", [
        [0.0, Vector3(-10, 0, 0)],
        [4.0, Vector3(-12, 60, 0)],
        [8.0, Vector3(-15, 175, 0)],
    ], "flythrough")                               # same clip — second track appended

    var door := ctx.find("Door")
    ctx.animate(door, "rotation_degrees", [
        [0.0, Vector3(0, 0, 0)],
        [0.8, Vector3(0, 110, 0)],
    ], "open")
```

Pass plain `position` / `rotation_degrees` values — the helper picks the right track type and handles the quaternion conversion for rotation. Verify by playing: `summer_play`, trigger the clip (or set autoplay), `summer_screenshot target:"game"`, `summer_stop`.

### make_shader — dissolve / glow FX with the compile-error loop (Wave F)

`make_shader` is the safe lane for text shaders because compile errors come back **verbatim** in the result (the `make_shader_errors` report entry, with the line number) instead of failing silently to a magenta material:

```gdscript
func run(ctx):
    var mat := ctx.make_shader("""
shader_type spatial;
uniform float threshold : hint_range(0.0, 1.0) = 0.3;
uniform vec4 edge_color : source_color = vec4(1.0, 0.55, 0.1, 1.0);
void fragment() {
    float n = fract(sin(dot(UV * 12.0, vec2(12.9898, 78.233))) * 43758.5453);
    if (n < threshold) { discard; }
    ALBEDO = vec3(0.8);
    EMISSION = edge_color.rgb * smoothstep(threshold + 0.08, threshold, n) * 4.0;
}
""", {"threshold": 0.35})
    ctx.apply_material(ctx.find("Crystal"), mat)
```

The loop when it fails: read the exact compile error (line number included) from the `make_shader_errors` report entry → fix that line → re-run. Do not guess-and-mutate; the error text names the line and identifier. For production-grade dissolve/fire/glow (FBM noise include, controllers, cookbook variants) use the `vfx-<effect>` recipes — `make_shader` is the fast lane for one-off FX and for iterating on a shader before writing it to a file.

### GridMap fills

```gdscript
func run(ctx):
    var root = ctx.get_scene_root()
    var grid: GridMap = root.get_node("GridMap")   # needs mesh_library assigned
    for x in range(16):
        for z in range(16):
            grid.set_cell_item(Vector3i(x, 0, z), 0)     # item = MeshLibrary index
    ctx.report("cells", 256)
```

Cells serialize into packed data — scripting is the ONLY sane way to fill them; never hand-edit `tile_map_data`-style fields as text.

### 3-point lighting rig

```gdscript
func run(ctx):
    var root = ctx.get_scene_root()
    var rig := Node3D.new()
    rig.name = "LightRig"
    root.add_child(rig)

    var key := DirectionalLight3D.new()
    key.name = "KeyLight"
    key.light_energy = 1.2
    key.shadow_enabled = true
    key.rotation_degrees = Vector3(-45, -30, 0)

    var fill := OmniLight3D.new()
    fill.name = "FillLight"
    fill.light_energy = 0.4
    fill.position = Vector3(-4, 2, 4)

    var rim := SpotLight3D.new()
    rim.name = "RimLight"
    rim.light_energy = 0.8
    rim.position = Vector3(0, 3, -5)
    rim.rotation_degrees = Vector3(-20, 180, 0)

    for light in [key, fill, rim]:
        rig.add_child(light)
    ctx.set_owner_recursive(rig)
```

Then `summer_screenshot` — lighting is exactly the kind of change you cannot judge without pixels.

### 2D platformer level — tilemap paint, character body, camera limits, parallax (Wave H)

One script lays down the level: paint the ground, drop a character body with collision, bound the camera to the level, stack parallax behind it. Tile coordinates are cells; camera limits are pixels (cells × tile size — 32 here).

```gdscript
func run(ctx):
    const TILE := 32
    var ground := ctx.add_tilemap("res://tilesets/grass.tres", "Ground")
    var painted := ctx.paint_rect(ground, Rect2i(0, 12, 64, 4), 0, Vector2i(0, 0))   # floor: 64 wide, 4 deep
    painted += ctx.paint_rect(ground, Rect2i(20, 8, 6, 1), 0, Vector2i(1, 0))       # a floating platform
    painted += ctx.paint_tiles(ground, [Vector2i(10, 11), Vector2i(11, 11), Vector2i(12, 11)], 0, Vector2i(2, 0))  # a step
    ctx.report("tiles_painted", painted)

    var player := ctx.add_body_2d("character", "Player", null,
        {"type": "capsule", "radius": 14.0, "height": 60.0},
        {"position": Vector2(3 * TILE, 11 * TILE)})
    ctx.add_sprite("res://sprites/player_idle.png", "Sprite", player)

    var cam := ctx.add_camera_2d(player.position, Vector2(2, 2), true, Rect2i(0, 0, 64 * TILE, 16 * TILE))
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

### Animated sprite (Wave H)

`add_animated_sprite` builds the `SpriteFrames` resource from per-frame texture paths — one entry per animation, `fps` and `loop` per clip — and optionally autoplays one. Cut a sheet into frames first (`summer_slice_asset_sheet`, or the `sprite-sheet` skill when generating them).

```gdscript
func run(ctx):
    var player := ctx.find("Player")
    if player == null:
        ctx.report("error", "Player not found")
        return
    var anim := ctx.add_animated_sprite({
        "idle": {"frames": ["res://sprites/player/idle_0.png", "res://sprites/player/idle_1.png"], "fps": 4.0, "loop": true},
        "run":  {"frames": ["res://sprites/player/run_0.png", "res://sprites/player/run_1.png",
                            "res://sprites/player/run_2.png", "res://sprites/player/run_3.png"], "fps": 12.0, "loop": true},
        "jump": {"frames": ["res://sprites/player/jump_0.png"], "fps": 1.0, "loop": false},
    }, "Anim", player, "idle")
    ctx.report("animations", anim.sprite_frames.get_animation_names())
```

A missing texture path comes back as a report entry — read it before wondering why a clip is short. Which clip plays when is gameplay code (`anim.play("run")` from the controller's `_physics_process`), not scene setup. Verify by playing: `summer_play`, move, `summer_screenshot target:"game"` — an edit-time preview shows frame 0 only.

### HUD — canvas layer, margin, vbox, label/progress/button, anchors, theme overrides (Wave H)

```gdscript
func run(ctx):
    var hud := ctx.add_canvas_layer("HUD", 1)
    var margin := ctx.add_ui("margin", "Margin", hud, {"anchor": "full_rect"})
    ctx.set_theme_overrides(margin, {"margin_left": 24, "margin_top": 24, "margin_right": 24, "margin_bottom": 24})

    var column := ctx.add_ui("vbox", "TopLeft", margin)
    var score := ctx.add_ui("label", "Score", column, {"text": "Score: 0"})
    ctx.set_theme_overrides(score, {"font_size": 28, "font_color": Color(1, 1, 1)})
    var health := ctx.add_ui("progress_bar", "Health", column,
        {"min_value": 0, "max_value": 100, "value": 100, "show_percentage": false,
         "custom_minimum_size": Vector2(240, 18)})

    var pause := ctx.add_ui("button", "PauseButton", hud, {"text": "Pause", "anchor": "top_right"})
    pause.process_mode = Node.PROCESS_MODE_ALWAYS      # still clickable while the tree is paused
    ctx.report("hud", ctx.summary())
```

`props.anchor` runs `set_anchors_and_offsets_preset` — the right way to pin a Control; hand-set `anchor_*`/`offset_*` values drift the moment the window resizes. The preset is applied before the other props, so an explicit `size`/`position` in the same dict wins. `add_ui("panel", …)` is a **PanelContainer** (it sizes to its child — a backdrop for a vbox/hbox); a plain `Panel` is `add_node("Panel", …)`. `set_theme_overrides` returns how many overrides it applied — compare with what you passed (an `int` on a key that is not `font_size` becomes a *constant* override, as with the margins above). Unknown `props` keys land in `prop_warnings` as always (use real property names: `custom_minimum_size`, not `min_size` or a guess). HUD Controls belong under a `CanvasLayer` — a Control parented under a `Node2D` scrolls with the camera and gets a `prop_warning`. For the layout and theme *design* — which container for which job, theme vs inline styling — use `ui-basics`; this is its one-script form.

### Wire a button with connect_signal() (Wave H)

`ctx.connect_signal` makes a **persisted** connection (`CONNECT_PERSIST`) — it survives in the `.tscn`, exactly what the editor's ConnectionsDock writes. The target needs a method to call, so attach the script first; a script attached in the same run has not compiled yet, and `connect_signal` accepts it because the source declares `func _on_pause_pressed(` (the method gate):

```gdscript
func run(ctx):
    var hud := ctx.find("HUD")
    var button := ctx.find("PauseButton")
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

### attach_script — behavior with the parse-error loop (Wave H)

`attach_script` validates the source **before** writing anything: a parse error comes back as a report entry (with the line) and the return is `null` — no half-written file, no broken node. Empty `path` → `res://scripts/<SceneName>/<NodeName>.gd`.

```gdscript
func run(ctx):
    var player := ctx.find("Player")
    var script := ctx.attach_script(player, """
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

### make_prefab — turn a built subtree into a reusable .tscn (Wave H)

Build the thing once in-scene, then pack it. With `replace_with_instance` (the default) the inline subtree is swapped for an instance of the new file — same name, transform, parent — and the instance is returned.

```gdscript
func run(ctx):
    var torch := ctx.find("Torch")               # Sprite2D + PointLight2D + Area2D you built above
    if torch == null:
        return
    var first := ctx.make_prefab(torch, "res://prefabs/torch.tscn")
    for i in range(3):
        var t := ctx.instance_scene("res://prefabs/torch.tscn", null, "Torch%d" % (i + 2))
        t.position = first.position + Vector2(160 * (i + 1), 0)
    ctx.report("prefab", first.scene_file_path)
```

The owner fix-up runs before packing, so a child you forgot to own is included instead of silently dropped. The prefab is authored at its origin — the node's position is zeroed for the pack (the editor's Save Branch default) and copied back onto the instance, so `first.position` above is still where the torch stood; rotation and scale stay in the prefab. `make_prefab` refuses the scene root (pack a child subtree, never `ctx.get_scene_root()`) and a path that is open in an editor tab. The receipt: `res://prefabs/torch.tscn` in the result's `files_written`, `Torch` now reporting a `scene_file_path`, and the copies in the diff's `added`. From here on, edit the prefab file, not the instances.

### Input actions, autoload, main scene (Wave H)

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

### Verifying 2D and UI work

Same loop, different framing:

- **Diff first.** `added` must carry the bodies' `CollisionShape2D` children, the `CanvasLayer` with its Controls, one `Parallax2D` per layer. Anchors and theme overrides show up as `changed` properties on the Controls.
- **2D scene captures.** `summer_screenshot target:"scene"` on a 2D scene synthesizes a `Camera2D` and auto-fits the `CanvasItem` bounds — the 3D presets do not apply, and `framing:"camera"` errors on a scene with no 3D content. `nodePath:"Player"` frames one node (its 2D rect, children included); `size:[1280, 720]` sets the resolution that anchors resolve against.
- **UI and anything input-driven** is only proven in the running game: `summer_play`, then `summer_screenshot target:"game"`. An edit-time preview of a HUD approximates a viewport the editor does not have.
- Read the confession fields in every capture (synthetic camera, no camera, project mismatch). A capture you did not receive is not evidence — `verifying-scenes` has the full discipline.

## summer_run_editor_script — the cold path

A different tool for a different job: it boots a **fresh headless child editor against the ON-DISK project**, runs one `EditorScript` (`func _run():`), and exits.

- Unsaved live edits are INVISIBLE to it; the live editor may need a file reload to show its output.
- Use for batch/project-wide work: re-saving every scene, sweeping resources, mass fixes, generating `.tres` assets.
- Budget default 120s, clamp 15–600 — include boot time (30s+ on large projects).
- It confesses `no_rewind_point:true` when no pre-run checkpoint could be taken — surface that to the user before more destructive work.
- No renderer: it can never screenshot. Judge it by artifacts on disk (see `headless-scripting` for the full discipline).

If `summer_run_script` fails with "doesn't support RunSceneScript yet", the engine build is too old — fall back to `summer_run_editor_script` or tell the user to update Summer Engine.

## Red Flags — STOP

| Red flag | Reality |
|---|---|
| Ten `summer_add_node`/`summer_set_prop` calls in a row | That is one script. Write the script. |
| `add_child` without `ctx.set_owner_recursive(node)` (or manual `.owner`) | Saved scene silently loses the node. |
| Guessing a property name "it's probably `color`" | `summer_api_docs` answers in one call. Wrong names fail after half the mutation applied. |
| Claiming "the forest looks great" without a screenshot | Describe only frames you received. Run `summer_screenshot`. |
| Heavy batch loop in `summer_run_script` | It blocks the live editor. Move it to `summer_run_editor_script`. |
| Using `summer_run_editor_script` to edit the OPEN scene | It sees only the on-disk file; live edits are invisible and collisions likely. Use `summer_run_script`. |
| `"Vector3(0,10,0)"` (quoted) inside script source | That is the `summer_set_prop` wire convention. In GDScript write `Vector3(0, 10, 0)`. |
| Ignoring `errors` because `ok` was true | A partially-failed script may have half-mutated the scene. Read them. |
| Hand-building CSG node trees on a Wave F engine | `ctx.boolean/lathe/sweep/extrude_polygon` bake clean ArrayMeshes with no live CSG left behind. |
| Re-running a failed `make_shader` with a guessed fix | The compile error is in the `make_shader_errors` report verbatim, with the line. Read it, fix that line. |
| Hand-writing AnimationPlayer/library/track plumbing | `ctx.animate` is one call per property and dodges the quaternion trap. |
| Painting tiles with `summer_set_prop`, or hand-editing `tile_map_data` | `ctx.paint_rect` / `paint_tiles` (or `set_cell` in a loop) — cells are packed data. |
| Building a HUD with a dozen `summer_add_node`/`summer_set_prop` calls | One script: `add_canvas_layer` → `add_ui` → `set_theme_overrides`. |
| `button.pressed.connect(...)` inside the run script | Not persisted — gone when the script ends. `ctx.connect_signal` (or `summer_connect_signal`) saves it in the `.tscn`. |
| `ctx.connect(button, "pressed", hud, "_on_pressed")` | That is `Object.connect` on the ctx object, not the helper — wrong-signature error. The helper is `ctx.connect_signal(...)`. |
| `{"min_size": ...}` in `add_ui` props | Not a Control property — lands in `prop_warnings` and does nothing. The property is `custom_minimum_size`. |
| `ctx.make_prefab(ctx.get_scene_root(), ...)` | Refused. Pack a child subtree; the scene itself is `save_scene`. |
| Re-running a failed `attach_script` with a guessed fix | The parse error is in the report with the line. Read it, fix that line. |
| Judging a HUD from an edit-time scene preview | Anchors resolve against the real viewport. `summer_play` + `target:"game"`. |
| Calling Wave H helpers on an engine that predates them | `Invalid call to method` — the run rolls back. Use the fallback table above. |
| Reading `rolled_back: true` as "nothing happened" after `attach_script` / `add_autoload` / `set_main_scene` | Files and `project.godot` sit outside the undo action. Read `files_written` / `project_settings_changed`; the checkpoint is the rollback. |

**Related skills:**
- `verifying-scenes` — the perception discipline: snapshot/diff/screenshot before-and-after, runtime reads, honest claims.
- `headless-scripting` — shell-launched engine scripts, imports, exports.
- `scene-composition` — what a well-structured scene looks like before you generate one.
- `ui-basics` — Control hierarchy, containers, anchors, theme vs inline styling: the design behind the HUD recipe.
- `gdscript-patterns` — idioms for the scripts `attach_script` writes.
- `sprite-sheet` — generating the frames `add_animated_sprite` consumes.
- `verification-before-completion` — proving the result before claiming done.
