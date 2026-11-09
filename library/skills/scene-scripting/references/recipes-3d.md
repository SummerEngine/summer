# scene-scripting: 3D recipes

Every recipe below is the `source` of one call: `summer_run_script(scenePath="res://<the scene>.tscn", source=<the recipe>)`. Name the scene every time; it is opened first when it is not the edited one, and the person's tab comes back after the run. The core helpers (`add_node`, `find`, `add_mesh`, `make_material`, `save_scene` ...) are in the `scene-scripting` skill itself.

## Scatter N instances with randomized transforms

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

## Procedural mesh via SurfaceTool

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

## CSG primitives (fast blockouts)

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

Live CSG nodes are the **older-engine fallback** — they re-evaluate every frame and should be converted before shipping (`scene-composition`). On a geometry-tier engine prefer `ctx.boolean(...)`, which bakes to a plain ArrayMesh and leaves no CSG nodes behind.

## Boolean blockout — carve a doorway (geometry tier)

Box minus box, baked. The inputs are consumed; only the result remains.

```gdscript
func run(ctx):
    var wall = ctx.add_mesh("box", "Wall", null, {"size": Vector3(6, 3, 0.3)})
    var hole = ctx.add_mesh("box", "DoorHole", null, {"size": Vector3(1.0, 2.1, 0.5)})
    hole.position = Vector3(0, -0.45, 0)          # sink the opening to floor level
    var carved = ctx.boolean(wall, hole, "difference")
    if carved == null:
        return                                     # reports carry the reason — read them
    carved.name = "WallWithDoorway"
    ctx.uv_box(carved)                             # boolean output needs UVs to take a texture
    ctx.report("doorway", str(carved.get_path()))
```

Then `summer_snapshot_diff` must show `Wall` and `DoorHole` GONE and `WallWithDoorway` added — leftover inputs mean the boolean failed and returned null. Screenshot to check the opening is where you meant.

## Lathe a goblet / pillar (geometry tier)

`lathe` revolves a 2D profile (x = radius, y = height) around Y. Design the profile from the axis outward.

```gdscript
func run(ctx):
    var profile := PackedVector2Array([
        Vector2(0.0, 0.0),  Vector2(0.45, 0.0),   # foot
        Vector2(0.08, 0.1), Vector2(0.08, 0.55),  # stem
        Vector2(0.35, 0.7), Vector2(0.4, 1.1),    # bowl
        Vector2(0.0, 1.15),
    ])
    var goblet = ctx.lathe(profile, "Goblet", null, 360.0, 48)
    ctx.set_smooth(goblet, 40.0)                  # lathes look faceted without it
    ctx.apply_material(goblet, ctx.make_material({"albedo_color": Color(0.85, 0.7, 0.2), "metallic": 0.8, "roughness": 0.25}))
```

A square-ish profile with `sides: 8` and `spin_degrees: 360` makes a chamfered pillar; `spin_degrees: 180` makes an apse/half-dome.

## Sweep a rail / pipe (geometry tier)

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
    var pipe = ctx.sweep(section, path, "SteamPipe")
    ctx.set_smooth(pipe, 45.0)
```

Rails, roads, cables, gutters — same recipe, different cross-section. Keep path points a reasonable distance apart; hairpin corners self-intersect.

## Terrain with collision (geometry tier)

```gdscript
func run(ctx):
    var ground = ctx.terrain(Vector2(64, 64), 6.0, 1337, "Terrain")
    ctx.apply_material(ground, ctx.make_material({"albedo_color": Color(0.35, 0.5, 0.25), "roughness": 1.0}))
    ctx.report("terrain", ctx.summary())
```

Collision arrives automatically (a `StaticBody3D` + `HeightMapShape3D` child), already owned. Same seed → same terrain, so re-runs are deterministic. Pass `image_path` to drive heights from a grayscale heightmap instead of noise. Verify with `summer_screenshot framing:"camera"` — terrain reads wrong from preset framings' top-down angles.

## Text signage (geometry tier)

`add_mesh` accepts `torus` and `text` on geometry-tier engines:

```gdscript
func run(ctx):
    var sign = ctx.add_mesh("text", "ExitSign", null, {"text": "EXIT", "depth": 0.08})
    sign.position = Vector3(0, 2.6, -4)
    ctx.apply_material(sign, ctx.make_material({"albedo_color": Color(1, 0.2, 0.2), "emission_enabled": true, "emission": Color(1, 0.1, 0.1), "emission_energy_multiplier": 3.0}))
```

Emissive text only proves itself in a `framing:"camera"` screenshot — preset framings substitute the environment and mute emission.

## Decimate for LOD, convex collision for props (geometry tier)

Dense generated/imported meshes (Meshy-class output) want both before they ship:

```gdscript
func run(ctx):
    var prop = ctx.find("AncientStatue")         # e.g. a generated import
    if prop == null:
        ctx.report("error", "AncientStatue not found")
        return
    ctx.decimate(prop, 0.35)                      # keep ~35% of the triangles
    var body = ctx.convex_collision(prop, true)  # V-HACD multi-shape for concave props
    ctx.report("collision_body", str(body.get_path()))
```

`decimate` returns `false` (with a report entry) instead of ruining the mesh when the ratio is out of range. `convex_collision` owns every body it creates — the diff after `save_scene` is your receipt that nothing was silently dropped. Simple convex props (crates, rocks): leave `decompose` false, one hull is cheaper.

## Mirror symmetry (geometry tier)

```gdscript
func run(ctx):
    var left_tower = ctx.find("Tower")
    var right_tower = ctx.mirror(left_tower, "x")   # mirrored duplicate, owned
    right_tower.name = "TowerMirrored"
```

The mirror is a real duplicate with flipped winding/normals — edit either side independently afterward.

## Animate — camera flythrough and a door-open (geometry tier)

`animate` collapses the AnimationPlayer/library/track boilerplate into one call per property. Multiple calls with the same `anim_name` append tracks to the same clip.

```gdscript
func run(ctx):
    var cam = ctx.add_camera(Vector3(0, 4, 12), Vector3.ZERO, true)
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

    var door = ctx.find("Door")
    ctx.animate(door, "rotation_degrees", [
        [0.0, Vector3(0, 0, 0)],
        [0.8, Vector3(0, 110, 0)],
    ], "open")
```

Pass plain `position` / `rotation_degrees` values — the helper picks the right track type and handles the quaternion conversion for rotation. Verify by playing: `summer_play`, trigger the clip (or set autoplay), `summer_screenshot target:"game"`, `summer_stop`.

## make_shader — dissolve / glow FX with the compile-error loop (geometry tier)

`make_shader` is the safe lane for text shaders because compile errors come back **verbatim** in the result (the `make_shader_errors` report entry, with the line number) instead of failing silently to a magenta material:

```gdscript
func run(ctx):
    var mat = ctx.make_shader("""
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

## GridMap fills

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

## 3-point lighting rig

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

## Pitfalls

| Pitfall | Reality |
|---|---|
| Hand-building CSG node trees on a geometry-tier engine | `ctx.boolean/lathe/sweep/extrude_polygon` bake clean ArrayMeshes with no live CSG left behind. |
| Re-running a failed `make_shader` with a guessed fix | The compile error is in the `make_shader_errors` report verbatim, with the line. Read it, fix that line. |
| Hand-writing AnimationPlayer/library/track plumbing | `ctx.animate` is one call per property and dodges the quaternion trap. |
| Heavy batch loop in `summer_run_script` | It blocks the live editor. Move project-wide work to `summer_run_editor_script`. |

