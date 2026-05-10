---
name: smoke
description: Use when authoring a smoke visual effect — a slow-rising column or puff of soft particles built with a noise + density falloff shader on a quad mesh, GPUParticles3D. Trigger on "smoke", "smoke trail", "puff", "chimney smoke", "smoke from a fire", "steam", "fog cloud", "explosion smoke".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: visual-effects
user-invocable: true
allowed-tools: Read Write Edit summer_add_node summer_set_prop summer_set_resource_property summer_inspect_node summer_save_scene
paths: ["**/*.tscn", "**/*.gd", "**/*.gdshader", "addons/vfx/**"]
---

# smoke — Soft Particle Smoke Plume

Smoke is the same particle pattern as fire — billboard quads emitted from a small disc, drifting upward — except the shader is dim, soft, low-emission, and tinted by depth instead of glowing. Slower spawn rate, longer lifetime, larger end scale. Pair it with `fire` for any campfire/torch/explosion. Used everywhere: chimney smoke, smoldering wreckage, smoke trails behind rockets, steam from vents, fog clouds.

## When to use

- "Smoke rising from the campfire."
- "Chimney smoke on the cottage."
- "Smoke trail behind the rocket."
- "Steam from the vent."
- "Smoke from the smoldering wreckage."
- "Fog cloud at the cave entrance."
- After spawning `fire`, smoke almost always belongs above it.

## When NOT to use

- The user wants flames, not smoke — use `fire`.
- The user wants a giant ground-hugging fog volume — use a `FogVolume` node with the `WorldEnvironment.volumetric_fog` shader, not a particle system. Particles don't scale to room-size fog.
- The user wants a 2D smoke effect — `canvas_item` shader, not this.
- The user wants the smoke to physically interact with the player (pushed by movement) — particles are visual; use a `FogVolume` + script that follows the player.
- The user wants thick black bonfire smoke that completely occludes — bump density way up, but consider a `FogVolume` for genuine visual occlusion.

## Recipe

### 1. Files to create

```
addons/vfx/smoke/smoke.gdshader
addons/vfx/smoke/smoke_controller.gd
addons/vfx/smoke/smoke.tscn
```

### 2. Shader code

`addons/vfx/smoke/smoke.gdshader`:

```glsl
shader_type spatial;
render_mode unshaded, blend_mix, depth_draw_never, cull_disabled, shadows_disabled;

#include "res://addons/vfx/_building-blocks/noise-3d-fbm.gdshaderinc"

uniform vec4  smoke_color_young : source_color = vec4(0.85, 0.85, 0.85, 1.0);  // freshly emitted
uniform vec4  smoke_color_old   : source_color = vec4(0.45, 0.45, 0.45, 1.0);  // late life
uniform float density           : hint_range(0.0, 1.0) = 0.55;
uniform float noise_scale       : hint_range(0.5, 8.0) = 2.0;
uniform float noise_speed       : hint_range(0.0, 2.0) = 0.5;
uniform float soft_edge         : hint_range(0.01, 0.5) = 0.30;
uniform float depth_fade        : hint_range(0.0, 4.0) = 1.0;  // soft against geometry behind

void vertex() {
    MODELVIEW_MATRIX = VIEW_MATRIX * mat4(
        INV_VIEW_MATRIX[0],
        INV_VIEW_MATRIX[1],
        INV_VIEW_MATRIX[2],
        MODEL_MATRIX[3]
    );
}

void fragment() {
    float age = CUSTOM.x;

    // Distort UVs with slow noise.
    vec3 np = vec3(UV * noise_scale, TIME * noise_speed + CUSTOM.y * 10.0);
    float n = fbm3(np);

    // Soft round mask, modulated by noise so the silhouette is wispy not circular.
    vec2 c = UV - vec2(0.5);
    float r = length(c) * 2.0;
    float mask = smoothstep(1.0, 1.0 - soft_edge, r);
    mask *= (0.6 + 0.4 * n);  // bite chunks out of the puff

    // Fade in fast, fade out slow.
    float alpha_age = smoothstep(0.0, 0.15, age) * (1.0 - smoothstep(0.6, 1.0, age));

    // Color drifts young → old as it ages (cools off / dilutes).
    vec3 col = mix(smoke_color_young.rgb, smoke_color_old.rgb, age);

    ALBEDO = col;
    ALPHA = mask * alpha_age * density;
}
```

Note: for soft-particle depth fade against geometry behind the puff, the proper way is sampling DEPTH_TEXTURE; for clarity we keep the shader straightforward and rely on `depth_draw_never` + alpha for soft-look. If you need true soft-particle blending, add a DEPTH_TEXTURE sample in `fragment` — see Edge Cases.

### 3. GDScript controller

`addons/vfx/smoke/smoke_controller.gd`:

```gdscript
@tool
class_name SmokeController
extends GPUParticles3D

@export_group("Plume size")
@export_range(0.1, 8.0)  var rise_height: float = 3.0 :
    set(v): rise_height = v; _apply()
@export_range(0.05, 3.0) var spawn_radius: float = 0.20 :
    set(v): spawn_radius = v; _apply()
@export_range(0.5, 4.0)  var end_scale_multiplier: float = 2.5 :
    set(v): end_scale_multiplier = v; _apply()

@export_group("Plume intensity")
@export_range(8, 512)    var particle_count: int = 64 :
    set(v): particle_count = v; _apply()
@export_range(1.0, 8.0)  var puff_lifetime: float = 4.0 :
    set(v): puff_lifetime = v; _apply()
@export_range(0.0, 1.0)  var density: float = 0.55

@export_group("Wind")
@export var wind_direction: Vector3 = Vector3(0.3, 0.0, 0.0) :
    set(v): wind_direction = v; _apply()
@export_range(0.0, 5.0)  var wind_strength: float = 0.4 :
    set(v): wind_strength = v; _apply()

@export_group("Color")
@export var color_young: Color = Color(0.85, 0.85, 0.85)
@export var color_old:   Color = Color(0.45, 0.45, 0.45)

func _ready() -> void:
    one_shot = false
    explosiveness = 0.0
    _apply()

func _apply() -> void:
    amount = particle_count
    lifetime = puff_lifetime

    var pm := process_material as ParticleProcessMaterial
    if pm:
        pm.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_SPHERE
        pm.emission_sphere_radius = spawn_radius
        pm.direction = Vector3.UP
        pm.spread = 8.0
        pm.initial_velocity_min = rise_height / puff_lifetime * 0.7
        pm.initial_velocity_max = rise_height / puff_lifetime * 1.2
        pm.gravity = wind_direction.normalized() * wind_strength
        pm.scale_min = spawn_radius * 1.2
        pm.scale_max = spawn_radius * 1.8
        pm.scale_curve = _make_scale_curve(end_scale_multiplier)
        pm.angular_velocity_min = -25.0
        pm.angular_velocity_max =  25.0

    if draw_pass_1:
        var mesh := draw_pass_1 as QuadMesh
        var mat := mesh.surface_get_material(0) as ShaderMaterial
        if mat:
            mat.set_shader_parameter("smoke_color_young", color_young)
            mat.set_shader_parameter("smoke_color_old", color_old)
            mat.set_shader_parameter("density", density)

func _make_scale_curve(end_mult: float) -> CurveTexture:
    var c := Curve.new()
    c.add_point(Vector2(0.0, 0.4))
    c.add_point(Vector2(0.3, 1.0))
    c.add_point(Vector2(1.0, end_mult))
    var ct := CurveTexture.new()
    ct.curve = c
    return ct

func puff(amount_scalar: float = 1.0) -> void:
    # One-shot burst on top of the continuous emission (e.g., chimney puffs from a sneeze).
    var saved := amount_ratio
    amount_ratio = amount_scalar
    restart()
    var t := create_tween()
    t.tween_interval(0.1)
    t.tween_callback(func() -> void: amount_ratio = saved)

func stop_smoke(fade_seconds: float = 1.5) -> void:
    var t := create_tween()
    t.tween_property(self, "amount_ratio", 0.0, fade_seconds)
```

### 4. Node tree

```
GPUParticles3D ("Smoke") [script: smoke_controller.gd]
  ├── process_material: ParticleProcessMaterial
  └── draw_pass_1: QuadMesh (size 1.0 × 1.0)
        └── surface_material_override[0]: ShaderMaterial (shader: smoke.gdshader)
```

### 5. Wire it in (MCP calls)

For chimney smoke or fire pairing, parent the Smoke just above the heat source:

```
summer_add_node(parent="./World/Cottage/Chimney", type="GPUParticles3D", name="Smoke")
summer_set_prop(path="./World/Cottage/Chimney/Smoke", property="script", value="res://addons/vfx/smoke/smoke_controller.gd")
summer_set_prop(path="./World/Cottage/Chimney/Smoke", property="position", value="Vector3(0, 0.3, 0)")
summer_set_prop(path="./World/Cottage/Chimney/Smoke", property="rise_height", value=4.0)
summer_set_prop(path="./World/Cottage/Chimney/Smoke", property="particle_count", value=48)
summer_set_prop(path="./World/Cottage/Chimney/Smoke", property="wind_direction", value="Vector3(0.4, 0, 0.1)")
summer_save_scene
```

For pairing with a fire:

```
summer_add_node(parent="./World/Campfire", type="GPUParticles3D", name="Smoke")
summer_set_prop(path="./World/Campfire/Smoke", property="position", value="Vector3(0, 1.5, 0)")  # above flame top
summer_set_prop(path="./World/Campfire/Smoke", property="rise_height", value=3.0)
```

For a rocket trail (smoke follows the rocket):

```gdscript
# On the Rocket scene:
$Smoke.local_coords = false  # smoke stays in world space, rocket leaves it behind
```

### 6. Parameters to tune

| Parameter | Range | Effect |
|---|---|---|
| `particle_count` (`amount`) | 16–256 | density of the column |
| `puff_lifetime` | 1.0–8.0 s | how long each puff is visible (longer = taller column) |
| `rise_height` | 0.1–8.0 m | how far each puff travels upward |
| `spawn_radius` | 0.05–3.0 m | spawn disc + initial puff size |
| `end_scale_multiplier` | 0.5–4.0× | how much each puff grows over its life |
| `density` | 0.0–1.0 | overall opacity of every puff |
| `wind_direction` | Vector3 | drift direction (also bends the column) |
| `wind_strength` | 0.0–5.0 | horizontal drift speed |
| `color_young` / `color_old` | Color | tint at birth and at death |

## Cookbook — named variants

### chimney-smoke (default)

Light gray, gentle, drifts on a slight wind.

```
particle_count = 48
puff_lifetime  = 4.0
rise_height    = 4.0
spawn_radius   = 0.30
end_scale_multiplier = 2.5
density        = 0.55
wind_direction = Vector3(0.3, 0.0, 0.1)
wind_strength  = 0.4
color_young    = Color(0.85, 0.85, 0.85)
color_old      = Color(0.55, 0.55, 0.55)
```

### black-fire-smoke

Burning oil / tires. Pair with `fire` set to `bonfire`.

```
particle_count = 96
puff_lifetime  = 5.0
rise_height    = 5.0
spawn_radius   = 0.60
end_scale_multiplier = 3.0
density        = 0.85
color_young    = Color(0.20, 0.18, 0.16)
color_old      = Color(0.05, 0.05, 0.05)
```

### steam-vent

White, fast-rising, short-lived.

```
particle_count = 64
puff_lifetime  = 1.6
rise_height    = 2.5
spawn_radius   = 0.10
end_scale_multiplier = 2.0
density        = 0.45
wind_strength  = 0.0
color_young    = Color(1.0, 1.0, 1.0)
color_old      = Color(0.95, 0.95, 1.0)
```

### rocket-trail

Long-lived, narrow spawn, follows the rocket.

```
particle_count = 128
puff_lifetime  = 3.0
rise_height    = 0.5     # local Y; the rocket's velocity drives it
spawn_radius   = 0.08
end_scale_multiplier = 4.0
density        = 0.50
local_coords   = false   # set on the node
color_young    = Color(0.95, 0.95, 0.95)
color_old      = Color(0.40, 0.40, 0.40)
```

### fog-bank

Slow, wide, ground-hugging. (For very large fog, use `FogVolume` instead.)

```
particle_count = 128
puff_lifetime  = 8.0
rise_height    = 0.3
spawn_radius   = 3.0
end_scale_multiplier = 1.5
density        = 0.30
gravity        = Vector3(0, -0.05, 0)  # slightly drift downward
color_young    = Color(0.75, 0.78, 0.85)
color_old      = Color(0.65, 0.68, 0.75)
```

## Anti-patterns

- **Using `blend_add` like fire.** Smoke is `blend_mix` (alpha-blended). Additive smoke looks like glowing dust.
- **Forgetting `cull_disabled`.** Billboarded quads disappear at certain camera angles otherwise.
- **`puff_lifetime < 1.0`.** Smoke needs time to spread out and dilute. Short-lifetime smoke looks like spray.
- **No scale curve.** Smoke that doesn't grow looks like a row of identical balls. The controller's `_make_scale_curve` ramps from 0.4× → 1.0× → end_mult.
- **`emission_energy > 0` on the shader's quad material.** Smoke isn't bright. Keep `unshaded` and let `ALBEDO` carry the look. (The shader as written has no EMISSION line — correct.)
- **Smoke local-space when paired with a moving emitter (rocket).** Set `local_coords = false` so puffs stay where they were emitted.
- **Skipping the angular velocity.** Static-rotation smoke looks weird. The controller adds ±25 deg/s for organic tumbling.

## Performance notes

- Default 48 particles per smoke source: ~0.03 ms on desktop.
- Heavy `density` at high count (128 particles, density 0.85) gets fillrate-bound — overdraw on a screen full of smoke. Budget ~256 smoke particles total visible at once.
- Mobile: drop default to 24, drop `puff_lifetime` to 2.5, drop `density` to 0.35.
- LOD: scale `amount_ratio` by `clamp(1.5 - dist_to_camera / 40.0, 0.10, 1.0)` for distant chimneys.
- The depth-fade soft-particle technique (sampling DEPTH_TEXTURE in fragment) costs an extra texture read per pixel — only enable for foreground smoke close to walls.

## Edge cases

- **Smoke clipping into walls/ceilings.** The basic shader doesn't depth-fade. Add this to the fragment for soft particles:

```glsl
uniform sampler2D depth_tex : hint_depth_texture;
// in fragment, after the mask line:
float scene_d = texture(depth_tex, SCREEN_UV).r;
vec4 wpos = INV_PROJECTION_MATRIX * vec4(SCREEN_UV * 2.0 - 1.0, scene_d * 2.0 - 1.0, 1.0);
wpos.xyz /= wpos.w;
float d = abs(VERTEX.z - wpos.z);
ALPHA *= clamp(d * depth_fade, 0.0, 1.0);
```

- **Wind-driven smoke on a ship at sea.** Drive `wind_direction` from a global wind script polled in `_process`.
- **Smoke from an explosion (one-shot huge puff).** Use `puff()` API, set `one_shot = true`, increase `amount` to 256 for the burst, then free the node after `puff_lifetime`.
- **Smoke at very low light (night scene).** With `unshaded`, smoke is the same brightness day or night — looks bright at night. Either change to `shading_mode lit` and accept lighting cost, or tween `density` down with sun angle.
- **Smoke for an underwater plume (silt).** Drop `wind_strength` to 0, `gravity` to slight upward, color tan: `Color(0.55, 0.50, 0.40)`.

## Fallback (no MCP)

VFX is code, no MCP required:

1. Create `addons/vfx/smoke/` with the three files.
2. In Godot, add a `GPUParticles3D`, attach `smoke_controller.gd`.
3. Set `process_material` to a new `ParticleProcessMaterial` (script configures it).
4. Set `draw_pass_1` to a new `QuadMesh` with `surface_material_override[0]` = `ShaderMaterial(smoke.gdshader)`.
5. Save as `smoke.tscn`; instantiate at every smoke source.

## Handoff

After firing this recipe, suggest:

- `summer:visual-effects/recipes/fire` — the partner; almost any fire wants smoke 0.5–2 m above the flame top.
- `summer:visual-effects/recipes/dissolve` — pair `black-fire-smoke` with a dissolving target for "the bandit camp burns and ashes drift away."
- `summer:visual-effects/recipes/lightning` — for a smoke flash from a lightning strike (use `puff()` on impact).
- `summer:audio/sound-effect` — generate `gentle wind through smoke, soft hiss, 4s loop` for chimneys.

## See also

- `_building-blocks/noise-3d-fbm.gdshaderinc` — the FBM noise this shader includes
- `summer:visual-effects/recipes/fire` — sister recipe, almost always paired
- `summer:visual-effects/recipes/dissolve` — for ash particles after disintegration
- `summer:gdscript-patterns` — for the controller idioms (signals, exports, `@tool`)
