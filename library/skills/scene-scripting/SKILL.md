---
name: scene-scripting
description: Use when building or modifying a scene takes more than a couple of node/property calls — scattering instances, procedural meshes, booleans/lathe/sweep geometry, terrain, GridMap fills, lighting rigs, keyframe animation, shader FX, or anything with computed placement. Runs one GDScript inside the live editor via summer_run_script instead of long CRUD chains, verifies with summer_snapshot_diff + summer_screenshot, and checks API names with summer_api_docs instead of guessing.
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

**Related skills:**
- `verifying-scenes` — the perception discipline: snapshot/diff/screenshot before-and-after, runtime reads, honest claims.
- `headless-scripting` — shell-launched engine scripts, imports, exports.
- `scene-composition` — what a well-structured scene looks like before you generate one.
- `verification-before-completion` — proving the result before claiming done.
