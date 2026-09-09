---
name: vfx-water-ripple
description: Use when authoring a water-ripple visual effect — animated normal-distortion ripples on a water plane (or as a Decal) triggered by impacts. Trigger on "water ripple", "ripples on water", "raindrop ripple", "splash ripple", "rain on water", "footstep in puddle", "fish jumps".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: visual-effects
user-invocable: true
allowed-tools: Read Write Edit summer_write_file summer_read_file summer_create_scene summer_add_node summer_set_prop summer_set_resource_property summer_inspect_node summer_inspect_resource summer_save_scene summer_run_script summer_get_script_errors summer_get_debugger_errors summer_play summer_stop
paths: ["**/*.tscn", "**/*.gd", "**/*.gdshader", "addons/vfx/**"]
---

# water-ripple — Impact Ripples on a Water Plane

Concentric expanding rings on a water surface, normal-distorted so the ripple actually refracts the reflection. The shader keeps a small ring buffer of (origin, time, amplitude) tuples and renders all of them simultaneously over a base water plane. GDScript exposes `add_ripple(world_pos, amplitude)` so any system (rain, footsteps, projectile impacts, fish) can spawn one with a single call.

## When to use

- "Add ripples when the player walks through the puddle."
- "Rain hitting the lake should make ripples."
- "When the bullet hits the water, ripple."
- "Fish jumping leaves ripples."
- "Footsteps on the wet street should ripple."
- A water plane already exists and looks too static.

## When NOT to use

- The user wants the *whole* water surface to wave (Gerstner / FFT ocean) — that's a separate `ocean-water` recipe; this is impact ripples on top.
- The user wants a 2D top-down ripple effect on a UI map — use `canvas_item` shader, not this `spatial` one.
- The user wants splash particles flying upward on impact — pair this with `hit-spark` (recolor blue) for the droplets; this only handles the ring on the surface.
- The user wants the ripple to physically displace floating objects — this is visual only. Use `Area3D` impulses for the simulation side.

## Recipe

### 1. Files to create

```
addons/vfx/water-ripple/water_ripple.gdshader     # spatial shader on the water plane
addons/vfx/water-ripple/water_ripple_surface.gd    # MeshInstance3D controller w/ add_ripple()
addons/vfx/water-ripple/water_ripple.tscn          # reusable plane
```

### 2. Shader code

`addons/vfx/water-ripple/water_ripple.gdshader`:

```glsl
shader_type spatial;
render_mode blend_mix, depth_draw_opaque, cull_disabled;

const int MAX_RIPPLES = 16;

uniform vec4  water_color    : source_color = vec4(0.10, 0.30, 0.45, 0.85);
uniform vec4  ripple_color   : source_color = vec4(0.85, 0.95, 1.00, 1.0);
uniform float water_metallic : hint_range(0.0, 1.0) = 0.4;
uniform float water_roughness: hint_range(0.0, 1.0) = 0.15;
uniform float fresnel_power  : hint_range(0.5, 8.0) = 4.0;
uniform float scroll_speed   : hint_range(0.0, 0.5) = 0.05;
uniform sampler2D normal_map : hint_normal;

// Per-ripple data: (origin.xz, start_time, amplitude * (1 if active else 0))
uniform vec4 ripples[MAX_RIPPLES];

// Ripple ages run off the controller's own clock, pushed here every frame. They
// cannot run off TIME: shader TIME wraps at
// rendering/limits/time/time_rollover_secs (3600 by default, verified), which
// would send every live ripple to a negative age once an hour of uptime.
uniform float now = 0.0;

uniform float ripple_speed       : hint_range(0.5, 8.0)  = 2.5;   // m/s expansion
uniform float ripple_wavelength  : hint_range(0.05, 1.0) = 0.20;  // distance between crests
uniform float ripple_lifetime    : hint_range(0.5, 6.0)  = 2.5;   // seconds visible
uniform float ripple_height      : hint_range(0.0, 0.4)  = 0.08;  // visual normal kick

void vertex() {
    // Sample ripples in vertex to displace Y for proper silhouette.
    vec3 wpos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
    float disp = 0.0;
    for (int i = 0; i < MAX_RIPPLES; i++) {
        vec4 r = ripples[i];
        if (r.w <= 0.0) continue;
        float age = now - r.z;
        if (age < 0.0 || age > ripple_lifetime) continue;
        float dist = length(wpos.xz - r.xy);
        float front = age * ripple_speed;
        float ring = exp(-pow((dist - front) / 0.25, 2.0));
        float fade = 1.0 - smoothstep(0.0, ripple_lifetime, age);
        disp += sin((dist - front) / ripple_wavelength * 6.2831) * ring * fade * r.w;
    }
    VERTEX.y += disp * ripple_height;
}

void fragment() {
    // Base water normal scroll.
    vec2 nuv = UV + vec2(TIME * scroll_speed, TIME * scroll_speed * 0.7);
    vec3 base_n = texture(normal_map, nuv).rgb * 2.0 - 1.0;

    // Composite ripple normals on top.
    vec3 wpos = (INV_VIEW_MATRIX * vec4(VERTEX, 1.0)).xyz;
    vec3 ripple_n = vec3(0.0, 0.0, 1.0);
    float ripple_glow = 0.0;
    for (int i = 0; i < MAX_RIPPLES; i++) {
        vec4 r = ripples[i];
        if (r.w <= 0.0) continue;
        float age = now - r.z;
        if (age < 0.0 || age > ripple_lifetime) continue;
        vec2 d = wpos.xz - r.xy;
        float dist = length(d);
        float front = age * ripple_speed;
        float ring = exp(-pow((dist - front) / 0.25, 2.0));
        float fade = 1.0 - smoothstep(0.0, ripple_lifetime, age);
        vec2 dir = (dist > 0.0001) ? (d / dist) : vec2(0.0);
        float wave = cos((dist - front) / ripple_wavelength * 6.2831);
        ripple_n.xy += dir * wave * ring * fade * r.w * 1.5;
        ripple_glow += ring * fade * r.w * 0.5;
    }

    // NORMAL_MAP is decoded by the engine (scene_forward_clustered.glsl:1427 —
    // `normal_map.xy = normal_map.xy * 2.0 - 1.0`), so hand it the RAW [0,1] texel
    // encoding. Assigning an already-decoded +/-1 vector makes a flat surface read
    // as permanent maximum tilt.
    NORMAL_MAP = normalize(base_n + vec3(ripple_n.xy, 0.0)) * 0.5 + 0.5;
    NORMAL_MAP_DEPTH = 0.6;

    // Fresnel-tinted color.
    float fres = pow(1.0 - clamp(dot(NORMAL, VIEW), 0.0, 1.0), fresnel_power);
    ALBEDO = mix(water_color.rgb, ripple_color.rgb, ripple_glow);
    METALLIC = water_metallic;
    ROUGHNESS = water_roughness;
    ALPHA = mix(water_color.a, 1.0, fres);
    EMISSION = ripple_color.rgb * ripple_glow * 0.4;
}
```

### 3. GDScript controller

`addons/vfx/water-ripple/water_ripple_surface.gd`:

```gdscript
@tool
class_name WaterRippleSurface
extends MeshInstance3D

const MAX_RIPPLES := 16

@export var water_color: Color = Color(0.10, 0.30, 0.45, 0.85)
@export var ripple_color: Color = Color(0.85, 0.95, 1.00)
@export_range(0.5, 8.0) var ripple_speed: float = 2.5
@export_range(0.5, 6.0) var ripple_lifetime: float = 2.5
@export_range(0.0, 0.4) var ripple_height: float = 0.08
@export var normal_texture: Texture2D

var _ripples: Array[Vector4] = []
var _next_slot: int = 0
var _mat: ShaderMaterial
var _time: float = 0.0

func _ready() -> void:
    _ripples.resize(MAX_RIPPLES)
    for i in MAX_RIPPLES:
        _ripples[i] = Vector4.ZERO
    if material_override == null or not (material_override is ShaderMaterial):
        var sm := ShaderMaterial.new()
        sm.shader = preload("res://addons/vfx/water-ripple/water_ripple.gdshader")
        material_override = sm
    _mat = material_override as ShaderMaterial
    _apply()
    set_process(true)

func _apply() -> void:
    if _mat == null: return
    _mat.set_shader_parameter("water_color", water_color)
    _mat.set_shader_parameter("ripple_color", ripple_color)
    _mat.set_shader_parameter("ripple_speed", ripple_speed)
    _mat.set_shader_parameter("ripple_lifetime", ripple_lifetime)
    _mat.set_shader_parameter("ripple_height", ripple_height)
    if normal_texture:
        _mat.set_shader_parameter("normal_map", normal_texture)

## Spawn a ripple at a world position.
##   amplitude: 0..1 (raindrop ~0.2, footstep ~0.5, body splash ~1.0)
func add_ripple(world_pos: Vector3, amplitude: float = 0.5) -> void:
    # Stamp with our own clock, not Time.get_ticks_msec(): the shader compares
    # against the same `now` uniform, so the two only line up if one source drives both.
    _ripples[_next_slot] = Vector4(world_pos.x, world_pos.z, _time, clamp(amplitude, 0.0, 1.0))
    _next_slot = (_next_slot + 1) % MAX_RIPPLES
    _push()

## True when `world_pos` is over this surface (XZ against the mesh's local AABB).
## Use this rather than a containment method on the caller — there isn't one.
func contains_point(world_pos: Vector3) -> bool:
    if mesh == null:
        return false
    var local := to_local(world_pos)
    var box := mesh.get_aabb()
    return local.x >= box.position.x and local.x <= box.end.x \
        and local.z >= box.position.z and local.z <= box.end.z

func _push() -> void:
    if _mat == null: return
    _mat.set_shader_parameter("ripples", _ripples)

func _process(delta: float) -> void:
    # Drive ripple age from this clock and push it every frame. Using the shader's
    # TIME instead would silently kill every ripple after
    # rendering/limits/time/time_rollover_secs (3600 s default) of uptime.
    _time += delta
    if _mat:
        _mat.set_shader_parameter("now", _time)
    # Re-push so editor updates pick up changes; cheap.
    if Engine.is_editor_hint():
        _push()
```

### 4. Node tree

```
MeshInstance3D ("Water") [script: water_ripple_surface.gd]
  └── mesh: PlaneMesh (size matches the puddle / lake)
        └── material_override: ShaderMaterial (shader: water_ripple.gdshader, normal_map: <noise>)
```

### 5. Wire it in (MCP calls)

Every scene-mutating call takes an explicit `scenePath`. `summer_set_prop` uses `key`
(not `property`); `summer_set_resource_property` always needs a `subProperty` and is
for reaching *into* a resource, not for assigning one.

```
summer_write_file(path="res://addons/vfx/water-ripple/water_ripple.gdshader", content="<section 2>", create_only=true)
summer_write_file(path="res://addons/vfx/water-ripple/water_ripple_surface.gd", content="<section 3>", create_only=true)

summer_add_node(scenePath="res://main.tscn", parent="./World", type="MeshInstance3D", name="Puddle")
summer_set_prop(scenePath="res://main.tscn", path="./World/Puddle", key="script", value="res://addons/vfx/water-ripple/water_ripple_surface.gd")
summer_set_prop(scenePath="res://main.tscn", path="./World/Puddle", key="position", value="Vector3(0, 0.01, 0)")

# Whole resources are assigned by path with summer_set_prop.
summer_set_prop(scenePath="res://main.tscn", path="./World/Puddle", key="mesh", value="res://addons/vfx/water-ripple/plane.tres")
# `normal_texture` is an exported script property on the controller, not a
# MeshInstance3D property — MeshInstance3D has no `normal_texture`.
summer_set_prop(scenePath="res://main.tscn", path="./World/Puddle", key="normal_texture", value="res://addons/vfx/water-ripple/water_normals.png")

# subProperty is required — this is how you reach into the PlaneMesh itself.
summer_set_resource_property(scenePath="res://main.tscn", nodePath="./World/Puddle", resourceProperty="mesh", subProperty="subdivide_width", value=32)
summer_set_resource_property(scenePath="res://main.tscn", nodePath="./World/Puddle", resourceProperty="mesh", subProperty="subdivide_depth", value=32)

summer_save_scene(scenePath="res://main.tscn")
```

### 5a. One-script wiring (summer_run_script)

On engines with `summer_run_script` (see `scene-scripting`), the node and
resource wiring is ONE transactional ctx script — and it builds the subdivided
PlaneMesh directly, so the `plane.tres` sidecar disappears:

```gdscript
func run(ctx):
    var puddle := ctx.add_node("MeshInstance3D", "Puddle", null)
    var plane := PlaneMesh.new()
    plane.subdivide_width = 32
    plane.subdivide_depth = 32
    puddle.mesh = plane
    puddle.position = Vector3(0, 0.01, 0)
    puddle.set_script(load("res://addons/vfx/water-ripple/water_ripple_surface.gd"))
    puddle.set("normal_texture", load("res://addons/vfx/water-ripple/water_normals.png"))
    ctx.save_scene()
```

Set the mesh BEFORE the script if the controller reads it in `_ready`; either way,
`ctx.add_node` has already owned the node, so it survives the save.

### 5b. Verify

The shader and the controller are compiled code, and the controller `preload`s the
shader — a shader that failed to write takes the script down at parse time.

```
summer_get_script_errors          # water_ripple_surface.gd parsed?
summer_play
summer_get_debugger_errors        # shader compile errors surface here at runtime
summer_stop
```

Then trigger ripples from any system. Footstep:

```gdscript
# In your character controller's footstep callback:
if puddle and puddle.contains_point(global_position):
    puddle.add_ripple(global_position, 0.5)
```

Rain:

```gdscript
# In a Rain node spawning N drops/sec on the water plane bounds:
puddle.add_ripple(rand_xz_inside_puddle(), 0.20)
```

Bullet impact:

```gdscript
# In the bullet's hit handler when hit.collider == puddle:
puddle.add_ripple(hit.position, 0.8)
```

### 6. Parameters to tune

| Parameter | Range | Effect |
|---|---|---|
| `ripple_speed` | 0.5–8.0 m/s | how fast the ring expands |
| `ripple_lifetime` | 0.5–6.0 s | how long before it fades |
| `ripple_height` | 0.0–0.4 | vertex displacement amplitude (silhouette wobble) |
| `ripple_wavelength` | 0.05–1.0 m | distance between crests within one ring |
| `water_color` | Color | base tint, alpha controls transparency |
| `ripple_color` | Color | crest tint, additive glow at the ring front |
| `fresnel_power` | 0.5–8.0 | how grazing the angle has to be before the surface goes opaque |
| `scroll_speed` | 0.0–0.5 | base normal map scroll speed (subtle shimmer) |

## Cookbook — named variants

### puddle-shallow (default)

Tight, fast ripples, high contrast.

```
ripple_speed     = 3.0
ripple_lifetime  = 1.6
ripple_height    = 0.04
ripple_wavelength= 0.12
water_color      = Color(0.05, 0.07, 0.10, 0.75)
```

### lake-calm

Slow, wide, long-lived ripples.

```
ripple_speed     = 1.5
ripple_lifetime  = 4.0
ripple_height    = 0.10
ripple_wavelength= 0.30
water_color      = Color(0.10, 0.30, 0.45, 0.85)
```

### lava-glow (recolor for hot liquid)

```
water_color      = Color(0.12, 0.02, 0.0, 1.0)
ripple_color     = Color(1.0, 0.55, 0.10)
ripple_lifetime  = 1.2
ripple_height    = 0.02
emission via shader: bump fres mix toward ripple_color
```

### blood-pool

Sticky, slow, dark.

```
water_color      = Color(0.18, 0.02, 0.02, 0.95)
ripple_color     = Color(0.45, 0.05, 0.05)
ripple_speed     = 1.0
ripple_lifetime  = 3.0
ripple_wavelength= 0.40
```

## Anti-patterns

- **Spawning more than 16 ripples per surface.** The shader has a fixed array. Older ripples get overwritten — fine for rain (they were fading anyway), bad if you spawn 50 in one frame. Either raise `MAX_RIPPLES` (and the GLSL `MAX_RIPPLES`) together, or throttle spawns.
- **Ripple position in local instead of world space.** The shader expects world XZ. Always convert in the GDScript before pushing.
- **No normal map assigned.** The surface looks like flat-shaded plastic. Always assign a tileable water normals texture (any blue noise normals will do).
- **Writing a decoded ±1 vector into `NORMAL_MAP`.** The engine decodes it again (`normal_map.xy = normal_map.xy * 2.0 - 1.0`), so a flat surface reads as permanent maximum tilt. Re-encode with `* 0.5 + 0.5` before assigning, as section 2 does.
- **Timing ripples against shader `TIME`.** `TIME` wraps at `rendering/limits/time/time_rollover_secs` (3600 s default) and is not `Time.get_ticks_msec() / 1000`. Push your own accumulated clock as a uniform and compare against that; otherwise every ripple silently vanishes after an hour of uptime.
- **PlaneMesh too low-res.** The vertex displacement needs ~2–4 verts per meter or the silhouette wobble looks blocky. Use `subdivide_width = 32, subdivide_depth = 32` minimum on a 10×10 plane.
- **`depth_draw_disabled` on the water material.** You'll see the bottom of the puddle through the water at every angle. Use `depth_draw_opaque`.
- **Triggering ripples in `_process` without spacing.** Spamming 60/sec floods the buffer. Throttle to ~5 ripples/sec for rain unless tuned.

## Performance notes

- Cost is O(MAX_RIPPLES × pixels_drawn) in the fragment loop plus O(MAX_RIPPLES × verts) in the vertex loop. 16 ripples on a 5×5 m puddle at 1080p is cheap — an order-of-magnitude expectation, not a measurement. Profile if you need a number.
- The vertex displacement loop runs per vertex; raising plane subdivision past 64 starts to hurt. 32×32 is plenty.
- For lakes (large planes), don't apply this shader to the entire lake — split the lake into chunks and only apply ripples to the chunk near impacts. Or use a `Decal` projection instead (see edge cases).
- Mobile: drop `MAX_RIPPLES` to 8, disable vertex displacement (set `ripple_height = 0` and skip the vertex loop), and rely on normal-only ripples.

## Edge cases

- **Ripple on a non-flat water surface (Gerstner ocean).** This shader assumes the water plane is flat. For wavy water, sample the wave height in the same shader and add the ripple displacement on top.
- **Want to use a Decal instead of overriding the water material.** Use `Decal` projecting straight down with a 256×256 ring texture animated by `albedo_mix`. Cheaper but doesn't refract reflections — only colors the surface.
- **Ripple needs to interact with floating debris.** Visual ripples don't push physics. Spawn an `Area3D` impulse alongside if you need physical effect.
- **Camera under water (POV swimming).** This shader is one-sided in concept (ring expanding outward from above). For under-water POV, render a separate shader.
- **Ripple at the edge of the plane.** It clips at the plane boundary because the plane has no geometry past it. Expand the plane 2 m beyond the gameplay area.

## Fallback (no MCP)

Section 5 is fully automatable — `summer_write_file` writes the shader and the
controller, and `summer_add_node` + `summer_set_prop` +
`summer_set_resource_property` + `summer_save_scene` build the plane including its
subdivision. Do not hand these steps to the user when the MCP tools are available.

Without the MCP connection there is no engine to drive, so the user does it
manually in Summer Engine:

1. Create `addons/vfx/water-ripple/` and write the three files above.
2. Add a `MeshInstance3D` with a high-subdivision `PlaneMesh` (32×32 minimum).
3. Attach `water_ripple_surface.gd` and assign a tileable water normals texture.
4. From your trigger code, call `$Puddle.add_ripple(impact_pos, amplitude)`.
5. Check the Errors dock — the controller `preload`s the shader, so a broken shader path fails the script too.

## Handoff

After firing this recipe, suggest:

- `vfx-hit-spark` — recolor white-blue and spawn at the impact point for a few water droplets flying up. Pair them.
- `vfx-smoke` — recolor pale gray for the steam if you're hitting hot water or lava.
- `sound-effect` — generate `single water drop in shallow puddle, splash, 200ms` and trigger on each `add_ripple`.
- For weather-driven rain ripples, scaffold a simple Rain node that calls `add_ripple` 30×/sec across the puddle bounds.

## See also

- `_building-blocks/additive-billboard-particles.md` — for paired splash droplets
- `vfx-hit-spark` — sister recipe for the upward droplets
- `vfx-smoke` — for steam over hot liquids
- `gdscript-patterns` — for the controller idioms
