---
name: vfx-lightning
description: Use when authoring a lightning bolt visual effect — procedural jagged path drawn via ImmediateMesh, glow shader, sparks at endpoints, screen shake. Trigger on "lightning bolt", "chain lightning", "electric attack", "tesla coil", "shock spell", "thunderbolt", "energy beam".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: visual-effects
user-invocable: true
allowed-tools: Read Write Edit summer_write_file summer_read_file summer_create_scene summer_add_node summer_set_prop summer_set_resource_property summer_inspect_node summer_save_scene summer_run_script summer_project_setting summer_get_script_errors summer_get_debugger_errors summer_play summer_stop
paths: ["**/*.tscn", "**/*.gd", "**/*.gdshader", "addons/vfx/**"]
---

# lightning — Procedural Jagged Bolt

A lightning bolt is a noisy line from A to B, drawn for ~150 ms with a glow shader, sparks at both endpoints, and camera shake on cast. The recipe builds the jagged path in GDScript (midpoint displacement on a polyline), feeds the verts into an `ImmediateMesh`, applies a `ShaderMaterial` for additive bloom + flicker, spawns `hit-spark` particles at each endpoint, and calls `CameraShake.add_trauma(0.6)` for the impact. Used for shock spells, tesla coils, weapon discharges, electric enemies.

## When to use

- "Cast a lightning bolt from the wizard's hand to the enemy."
- "Chain lightning from one enemy to the next." (call `cast_lightning` per segment)
- "Tesla coil firing at the player every 2 seconds."
- "Energy weapon laser." (use the `laser-beam` variant)
- "Lightning strike from the sky."
- The user wants a *short, dramatic* energy connection between two points.

## When NOT to use

- The user wants a continuous beam that holds (e.g., laser sniper holding the trigger) — use the same shader on a `MeshInstance3D` cylinder with continuous emission, not the `ImmediateMesh` one-shot pattern. (See variants for `held-beam`.)
- The user wants ambient electricity *on* an object (Frankenstein arcs) — use a custom shader on the mesh with screen-space arcs; this recipe is for two-point bolts.
- The user wants a 2D lightning effect on UI — `canvas_item` shader, not this.
- The user wants a tracer line for a bullet — use a simple `ImmediateMesh`
  without noise displacement; skip this recipe. The current Summer build has no
  `Line3D` (`ClassDB.class_exists("Line3D")` is `false`); `Line2D` is 2D-only.

## Recipe

### 1. Files to create

```
addons/vfx/lightning/lightning.gdshader     # spatial shader for the bolt mesh
addons/vfx/lightning/lightning_caster.gd     # build path, draw, animate, spawn endpoints, shake
addons/vfx/lightning/lightning.tscn          # reusable scene
```

### 2. Shader code

`addons/vfx/lightning/lightning.gdshader`:

```glsl
shader_type spatial;
render_mode unshaded, blend_add, depth_draw_never, cull_disabled, shadows_disabled;

uniform vec4  bolt_color    : source_color = vec4(0.55, 0.75, 1.00, 1.0);
uniform vec4  core_color    : source_color = vec4(1.00, 1.00, 1.00, 1.0);
uniform float intensity     : hint_range(0.0, 1.0) = 1.0;   // driven by the controller
uniform float emission_boost: hint_range(0.0, 16.0) = 8.0;
uniform float thickness     : hint_range(0.05, 1.0) = 0.30; // visual halo width
uniform float flicker_rate  : hint_range(0.0, 60.0) = 30.0;

void vertex() {
    // Billboard each segment toward the camera around its own forward axis.
    vec3 up = INV_VIEW_MATRIX[1].xyz;
    VERTEX += UV.y > 0.5 ? up * thickness * 0.5 : -up * thickness * 0.5;
}

void fragment() {
    // V across the line gives 0 (top) → 1 (bottom); recenter to ±1.
    float v = (UV.y - 0.5) * 2.0;
    float core = smoothstep(1.0, 0.0, abs(v));
    core = pow(core, 3.0);
    float halo = smoothstep(1.0, 0.0, abs(v));
    halo = pow(halo, 0.7);

    // Per-bolt flicker (random per fragment time slice).
    float t = floor(TIME * flicker_rate) / flicker_rate;
    float flick = 0.85 + 0.30 * fract(sin(t * 91.7) * 43758.5);

    vec3 col = mix(bolt_color.rgb, core_color.rgb, core);
    float a = (core + halo * 0.4) * intensity * flick;

    // `render_mode unshaded` outputs ALBEDO and discards EMISSION entirely
    // (scene_forward_clustered.glsl:2962 — `frag_color = vec4(albedo, alpha)`
    // under MODE_UNSHADED), so the bloom boost has to live in ALBEDO.
    ALBEDO = col * emission_boost * flick * (core + halo * 0.5);
    ALPHA = clamp(a, 0.0, 1.0);
}
```

### 3. GDScript controller

`addons/vfx/lightning/lightning_caster.gd`:

```gdscript
@tool
class_name LightningCaster
extends Node3D

## Static-style helper. Add one anywhere in the scene; call cast_lightning(from, to) anytime.

const LIFETIME := 0.15
const SEGMENTS := 18           ## subdivisions of the bolt
const DISPLACEMENT := 0.35     ## meters of jaggedness per segment
const BRANCH_CHANCE := 0.25    ## probability of a forked sub-bolt per segment
const BRANCH_LENGTH := 0.8     ## relative length of a forked branch

@export var bolt_color: Color = Color(0.55, 0.75, 1.00)
@export var core_color: Color = Color(1.00, 1.00, 1.00)
@export var emission_boost: float = 8.0
@export var thickness: float = 0.30
@export var trauma_amount: float = 0.6
@export var spawn_endpoint_sparks: bool = true
@export_file("*.tscn") var spark_scene_path: String = "res://addons/vfx/hit-spark/hit_spark.tscn"

## Public API. Call this to fire a bolt.
func cast_lightning(from: Vector3, to: Vector3, intensity_scale: float = 1.0) -> void:
    var bolt := _build_bolt_node(from, to, intensity_scale)
    add_child(bolt)
    bolt.global_position = Vector3.ZERO

    if spawn_endpoint_sparks:
        _spawn_sparks(from)
        _spawn_sparks(to)

    # An autoload is a node at /root/<Name>, not an engine singleton:
    # Engine.has_singleton("CameraShake") is always false for one (measured).
    # get_node_or_null returns null when nothing is registered — that is the guard.
    # (MainLoop has no `root`, so `var root := Engine.get_main_loop().root` is a
    # parse error that takes the entire script down with it.)
    var cs := get_node_or_null(^"/root/CameraShake")
    if cs and cs.has_method("add_trauma"):
        cs.add_trauma(trauma_amount * intensity_scale)

func _build_bolt_node(from: Vector3, to: Vector3, intensity_scale: float) -> Node3D:
    var holder := Node3D.new()
    var im := MeshInstance3D.new()
    var mesh := ImmediateMesh.new()
    im.mesh = mesh
    var mat := ShaderMaterial.new()
    mat.shader = preload("res://addons/vfx/lightning/lightning.gdshader")
    mat.set_shader_parameter("bolt_color", bolt_color)
    mat.set_shader_parameter("core_color", core_color)
    mat.set_shader_parameter("emission_boost", emission_boost)
    mat.set_shader_parameter("thickness", thickness)
    mat.set_shader_parameter("intensity", intensity_scale)
    im.material_override = mat
    holder.add_child(im)

    var path := _generate_path(from, to, SEGMENTS, DISPLACEMENT)
    _draw_polyline(mesh, path)

    # Optional forked branches.
    for i in range(1, path.size() - 1):
        if randf() < BRANCH_CHANCE:
            var dir := (path[i] - path[i - 1]).normalized()
            var perp := dir.cross(Vector3.UP).normalized()
            if perp.length_squared() < 0.01:
                perp = dir.cross(Vector3.RIGHT).normalized()
            var branch_end: Vector3 = path[i] + (dir + perp * randf_range(-1.5, 1.5)) * (to - from).length() * BRANCH_LENGTH * 0.25
            var branch_path := _generate_path(path[i], branch_end, SEGMENTS / 3, DISPLACEMENT * 0.6)
            _draw_polyline(mesh, branch_path)

    var t := holder.create_tween()
    t.tween_method(func(v: float) -> void:
        mat.set_shader_parameter("intensity", v * intensity_scale),
        1.0, 0.0, LIFETIME).set_trans(Tween.TRANS_EXPO).set_ease(Tween.EASE_IN)
    t.tween_callback(holder.queue_free)
    return holder

func _generate_path(a: Vector3, b: Vector3, n: int, displacement: float) -> PackedVector3Array:
    var path: PackedVector3Array = []
    var dir := (b - a).normalized()
    var perp1 := dir.cross(Vector3.UP).normalized()
    if perp1.length_squared() < 0.01:
        perp1 = dir.cross(Vector3.RIGHT).normalized()
    var perp2 := dir.cross(perp1).normalized()
    for i in n + 1:
        var t := float(i) / float(n)
        var p := a.lerp(b, t)
        # Falloff at endpoints so they meet cleanly.
        var falloff := sin(t * PI)
        var jitter := perp1 * randf_range(-1.0, 1.0) + perp2 * randf_range(-1.0, 1.0)
        p += jitter * displacement * falloff
        path.append(p)
    return path

func _draw_polyline(mesh: ImmediateMesh, points: PackedVector3Array) -> void:
    if points.size() < 2: return
    mesh.surface_begin(Mesh.PRIMITIVE_TRIANGLE_STRIP)
    for i in points.size():
        var v: float = float(i) / float(points.size() - 1)
        mesh.surface_set_uv(Vector2(v, 0.0))
        mesh.surface_add_vertex(points[i])
        mesh.surface_set_uv(Vector2(v, 1.0))
        mesh.surface_add_vertex(points[i])
    mesh.surface_end()

func _spawn_sparks(at: Vector3) -> void:
    if not ResourceLoader.exists(spark_scene_path):
        return
    # `var sparks := load(...).instantiate()` is a parse error — load() has no
    # static return type, so `:=` cannot infer. Annotate both steps.
    var packed: PackedScene = load(spark_scene_path)
    var sparks: Node3D = packed.instantiate()
    add_child(sparks)
    sparks.global_position = at
    if sparks.has_method("restart"):
        sparks.restart()
    var t := sparks.create_tween()
    t.tween_interval(0.5)
    t.tween_callback(sparks.queue_free)
```

### 4. Node tree

```
Node3D ("LightningCaster") [script: lightning_caster.gd, autoload-friendly]
  └── (children created at runtime per cast: ImmediateMesh + sparks scenes)
```

Recommended: register one `LightningCaster` as an autoload (`/root/Lightning`) so any system can call `Lightning.cast_lightning(from, to)` from anywhere.

### 5. Wire it in (MCP calls)

Place one `LightningCaster` per "world" (or autoload it), then call from gameplay code.

Every scene-mutating call takes an explicit `scenePath`. `summer_set_prop` uses `key`
(not `property`) and only accepts a string, number, or boolean.

```
summer_write_file(path="res://addons/vfx/lightning/lightning.gdshader", content="<section 2>", create_only=true)
summer_write_file(path="res://addons/vfx/lightning/lightning_caster.gd", content="<section 3>", create_only=true)

summer_add_node(scenePath="res://main.tscn", parent="./World", type="Node3D", name="LightningCaster")
summer_set_prop(scenePath="res://main.tscn", path="./World/LightningCaster", key="script", value="res://addons/vfx/lightning/lightning_caster.gd")
summer_set_prop(scenePath="res://main.tscn", path="./World/LightningCaster", key="bolt_color", value="Color(0.55, 0.75, 1.0)")
summer_set_prop(scenePath="res://main.tscn", path="./World/LightningCaster", key="trauma_amount", value=0.6)
summer_save_scene(scenePath="res://main.tscn")
```

Or, on engines with `summer_run_script` (see `scene-scripting`), the two node
calls collapse into one transactional ctx script — worth it when placing several
casters or anything computed:

```gdscript
func run(ctx):
    var caster := ctx.add_node("Node3D", "LightningCaster", null)
    caster.set_script(load("res://addons/vfx/lightning/lightning_caster.gd"))
    caster.set("bolt_color", Color(0.55, 0.75, 1.0))
    caster.set("trauma_amount", 0.6)
    ctx.save_scene()
```

Then verify — the caster `preload`s its own shader, so a shader that failed to write
takes the whole script down at parse time:

```
summer_get_script_errors          # lightning_caster.gd parsed?
summer_play
summer_get_debugger_errors        # shader compile errors surface here at runtime
summer_stop
```

Then from the spell code:

```gdscript
var origin: Vector3 = $Wizard/HandTip.global_position
var target: Vector3 = enemy.global_position
$World/LightningCaster.cast_lightning(origin, target)
enemy.take_damage(35)
```

For chain lightning:

```gdscript
var prev: Vector3 = origin
for enemy in nearest_enemies(prev, 4):
    $World/LightningCaster.cast_lightning(prev, enemy.global_position, 0.85)
    enemy.take_damage(20)
    prev = enemy.global_position
    await get_tree().create_timer(0.05).timeout
```

### 6. Parameters to tune

| Parameter | Range | Effect |
|---|---|---|
| `LIFETIME` (const) | 0.05–0.40 s | how long the bolt is on screen (0.15 is the sweet spot) |
| `SEGMENTS` (const) | 6–32 | path subdivisions; more = smoother jaggedness |
| `DISPLACEMENT` (const) | 0.05–1.5 m | how wild the jagged offset is per segment |
| `BRANCH_CHANCE` (const) | 0.0–0.6 | probability of forks per segment |
| `thickness` | 0.05–1.0 m | halo width of the bolt |
| `emission_boost` | 0.0–16.0 | bloom strength (needs Bloom in WorldEnvironment) |
| `bolt_color` / `core_color` | Color | recolor for fire-bolt, plasma, magic |
| `trauma_amount` | 0.0–1.0 | how hard the camera shakes |

## Cookbook — named variants

### thunderbolt (default)

Cool blue-white, dramatic shake, sky-to-ground.

```
bolt_color = Color(0.55, 0.75, 1.00)
core_color = Color(1.0, 1.0, 1.0)
emission_boost = 8.0
thickness = 0.30
trauma_amount = 0.6
LIFETIME = 0.18
DISPLACEMENT = 0.45
```

### chain-lightning-spell

Tighter, chains between targets.

```
bolt_color = Color(0.65, 0.85, 1.0)
emission_boost = 6.0
thickness = 0.18
trauma_amount = 0.25
LIFETIME = 0.12
DISPLACEMENT = 0.20
SEGMENTS = 14
BRANCH_CHANCE = 0.15
```

### tesla-arc

Short, fast, lots of forks.

```
bolt_color = Color(0.75, 0.95, 1.0)
emission_boost = 10.0
thickness = 0.10
LIFETIME = 0.06
DISPLACEMENT = 0.15
SEGMENTS = 24
BRANCH_CHANCE = 0.45
trauma_amount = 0.10
```

### plasma-laser (held beam variant)

Override the script to NOT free after `LIFETIME` — use a `MeshInstance3D` with a stretched cylinder mesh updated each frame between two transforms; same shader.

```
bolt_color = Color(1.0, 0.40, 0.55)
core_color = Color(1.0, 0.85, 0.95)
emission_boost = 12.0
thickness = 0.20
DISPLACEMENT = 0.05  # nearly straight
SEGMENTS = 8
trauma_amount = 0.0  # no shake on a held beam
```

## Anti-patterns

- **Reaching for a `Line3D`.** The current Summer build has no such class
  (`ClassDB.class_exists("Line3D")` is `false`); `Line2D` is 2D-only. Use an
  `ImmediateMesh` triangle strip with the billboard vertex shader.
- **Animating the path frame-by-frame.** A bolt is one shape, on screen for 150 ms. You don't see the inside detail moving. One generation per cast.
- **Forgetting `blend_add`.** A bolt that doesn't bloom looks like a curved metal stick.
- **No camera shake.** Lightning without screen shake feels weightless. Always call `add_trauma` on the `/root/CameraShake` autoload.
- **Gating the shake on `Engine.has_singleton("CameraShake")`.** That is always `false` for an autoload (measured) — the shake would never fire. Autoloads are nodes at `/root/<Name>`; look them up with `get_node_or_null`.
- **Spawning lightning every frame for a "continuous" beam.** Use the `plasma-laser` variant pattern instead — one mesh, updated per-frame transform, never re-instantiated.
- **`SEGMENTS` too low (< 6).** Bolt looks like a zigzag triangle. Default 18 is right.
- **`DISPLACEMENT` proportional to total length without falloff.** Endpoints drift away from `from`/`to`. The included code uses `sin(t * PI)` falloff so endpoints meet cleanly.

## Performance notes

- One bolt at `SEGMENTS = 18`: 19 path points × 2 verts = 38 verts for the trunk, plus 2 × (`SEGMENTS / 3` + 1) = 14 verts per forked branch. One draw call, freed after 150 ms. Effectively free.
- Chain lightning with 5 segments stays in the same negligible band — that is an order-of-magnitude expectation, not a measurement.
- Endpoint sparks (instantiated `hit-spark` scenes) are the bigger cost — 64 particles × 2 = 128 particles per cast. Throttle for storms (see edge cases).
- The shader's flicker uses `floor(TIME * flicker_rate)`, so it ages with `TIME` not particle time — flicker is consistent across all bolts in flight.

## Edge cases

- **Lightning storm (50 strikes/sec).** Disable endpoint sparks for ambient strikes. Pool the `LightningCaster` mesh nodes instead of allocating per cast.
- **Bolt passes through a wall.** Visual only — the bolt shader doesn't depth test. If the user wants the bolt to be occluded by walls, set `depth_draw_opaque` and let the depth buffer cull it (loses the additive bloom in front of geometry).
- **Bolt origin and target at the same point.** Falloff goes to zero; `_generate_path` returns a degenerate strip. Add a guard: if `(to - from).length() < 0.01`, skip.
- **Underwater bolt.** Tint blue-green, drop `emission_boost` to 5.0; underwater bloom is muted.
- **First-person caster (player's hand).** The bolt starts inside the player's view and reads as a flash. Use a `held-beam` variant or shorten `LIFETIME` to 0.08.
- **No `CameraShake` autoload registered.** `get_node_or_null("/root/CameraShake")` returns null and the `if cs` check skips the call; the bolt fires without shake. Suggest `_building-blocks/trauma-shake-snippet.md` to wire it.

## Fallback (no MCP)

Section 5 is fully automatable — `summer_write_file` writes the shader and the
caster, `summer_add_node` + `summer_set_prop` + `summer_save_scene` place it, and
`summer_project_setting` registers the autoload. Do not hand these steps to the user
when the MCP tools are available.

Without the MCP connection there is no engine to drive, so the user does it
manually in Summer Engine:

1. Create `addons/vfx/lightning/` and write the three files above.
2. Add a `Node3D`, attach `lightning_caster.gd`. Optionally autoload as `Lightning`.
3. From any spell script, call `Lightning.cast_lightning(from_pos, to_pos)`.
4. Wire the `CameraShake` autoload from `_building-blocks/trauma-shake-snippet.md` for the punch.
5. Check the Errors dock — `lightning_caster.gd` `preload`s the shader, so a broken shader path fails the script too.

## Handoff

After firing this recipe, suggest:

- `vfx-hit-spark` — automatically called at endpoints; tune the spark color to match `bolt_color`.
- `vfx-magic-glow` — for the wizard's hand glow during charge-up before the cast.
- `vfx-muzzle-flash` — for the brief bright flash at the casting hand on release frame.
- `game-feel` — `CameraShake.add_trauma` is already called; pair with hit-stop on the target for impact emphasis.
- `sound-effect` — generate `electric crack thunder, sharp impact, rumble tail, 800ms` and play on cast.

## See also

- `_building-blocks/trauma-shake-snippet.md` — `CameraShake` autoload (REQUIRED for the shake call)
- `_building-blocks/additive-billboard-particles.md` — for the endpoint sparks
- `vfx-hit-spark` — endpoint companion
- `vfx-magic-glow` — pre-cast charge-up
- `vfx-muzzle-flash` — for the cast-release flash
- `game-feel` — full game-feel pairing
