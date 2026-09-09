---
name: realtime-wet-surfaces
description: "Use when adding real-time wetness to existing Godot 4 materials while preserving their parameter values, mapping Unity's Lit-preserving wet ShaderGraph swap onto a value-copying shader conversion with a geometry-driven wet mask and instance-uniform control."
license: MIT
category: shaders
tags:
  - rendering
  - shaders
  - godot4
  - weather
  - materials
confidence: extracted
source_refs:
  - sources/x/tenmomo-unity-realtime-wet/source.md
source_repo: SummerEngine/summer-gamedev-knowledge@cac7d50be8cfb3c0179c48e65438eb0d375b9fe9
---

# Real-Time Wet Surfaces (Value-Preserving Wet Materials in Godot 4)

## Outcome

Implement a real-time wetness effect in SummerEngine that can be applied to existing materials **without losing their configured values** (albedo, metallic, roughness, textures). The wet mask is driven by geometry alone (upward-facing surfaces collect wetness first), with a global/per-instance wet amount that can be animated at runtime. This mirrors the Unity architecture described in the source evidence: a pre-configured shader-graph swap that keeps the standard Lit material's values, driven by a CustomFunction bridge.

## When to Use

- Rain, wet caves, shorelines, or post-rain scenes where surfaces should darken and become glossy in real time.
- You need to wet many existing materials without re-authoring each one or losing its parameter values.
- You want a wetness amount that a gameplay system (rain zone, weather controller) can drive at runtime.

## Core Principle

The source technique's key idea is **separation of wetness from material authoring**: the wet logic is a self-contained graph/function that receives material values and injects a wet mask, so enabling wetness is a swap, not a rewrite.

Godot 4 mapping of the Unity concepts:

| Unity concept (from source) | Godot 4 equivalent |
|---|---|
| Standard Lit material with retained values | `StandardMaterial3D` values copied into a `ShaderMaterial` by a one-time converter |
| Pre-configured ShaderGraph swap | Shared wet-enabled `.gdshader`; swap the material once, keep all parameter values |
| CustomFunction carrying values into the graph | Shader uniforms + instance uniforms (`set_instance_shader_parameter`) or `RenderingServer` global shader parameters for scene-wide wet state |
| Wet mask from geometry shape alone | Fragment mask from world-space normal up-facing component (`world_normal.y`), optionally broken up by world-position noise |
| Planned heightmap flow | Sample a heightmap texture and offset the wet mask along its gradient (future extension; not evidenced in source) |

**Important constraint:** Godot cannot inject custom nodes into a `StandardMaterial3D` at runtime. The faithful equivalent of "swap in the pre-configured SG while keeping all values" is a **converter that copies `StandardMaterial3D` parameters into the wet shader** (below). The alternative — leaving `StandardMaterial3D` untouched and overlaying wetness via decals or post-processing — does not match the source's material-preserving architecture and is not recommended here.

## Scene / Node Shape

```
Scene
├── Node3D (level)
│   ├── MeshInstance3D × N
│   │     └── Surface overrides: ShaderMaterial (wet-enabled shader, one shared .gdshader)
│   │           instance uniform `wet_amount` driven per object or globally
│   └── RainZone: Area3D (optional)
│         └── body_entered/exited signals → WetnessController
└── WetnessController: Node
      └── typed GDScript; animates wet_amount up while raining, down while drying
```

## Implementation Steps

### 1. Write the shared wet-enabled spatial shader

Preserve the PBR parameters as uniforms and compute the wet mask from geometry. In Godot 4, fragment-stage `NORMAL` is **view-space**, so pass a world-space normal from the vertex stage — otherwise the "upward-facing" mask rotates with the camera.

```glsl
shader_type spatial;
render_mode blend_mix, depth_draw_opaque, cull_back;

// Values copied from the original StandardMaterial3D by the converter
uniform vec4 albedo_color : source_color = vec4(1.0);
uniform sampler2D albedo_tex : filter_linear_mipmap;
uniform float metallic : hint_range(0.0, 1.0) = 0.0;
uniform float roughness : hint_range(0.0, 1.0) = 0.5;

// Wet state
instance uniform float wet_amount : hint_range(0.0, 1.0) = 0.0;
uniform float up_bias : hint_range(0.0, 1.0) = 0.35;    // wetness starts below fully-upward
uniform float darkening : hint_range(0.0, 1.0) = 0.55;  // how much wet albedo darkens
uniform float wet_roughness : hint_range(0.0, 1.0) = 0.08;
uniform float noise_scale = 8.0;
uniform sampler2D droplet_noise : filter_linear_mipmap, repeat_enable;

varying vec3 world_normal;
varying vec3 world_pos;

void vertex() {
    world_normal = (MODEL_MATRIX * vec4(NORMAL, 0.0)).xyz;
    world_pos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

void fragment() {
    vec4 alb := texture(albedo_tex, UV) * albedo_color;
    vec3 wn := normalize(world_normal);

    // Geometry-driven wet mask: upward-facing surfaces collect wetness first
    float facing := clamp(wn.y, 0.0, 1.0);
    float mask := smoothstep(up_bias, 1.0, facing) * wet_amount;

    // Break up the mask so it reads as weathering, not a flat shader pass
    mask *= 0.75 + 0.25 * texture(droplet_noise, world_pos.xz * noise_scale).r;

    ALBEDO = mix(alb.rgb, alb.rgb * (1.0 - darkening), mask);
    ROUGHNESS = mix(roughness, wet_roughness, mask);
    METALLIC = metallic;
    SPECULAR = mix(0.5, 0.9, mask);  // glossy film sells "wet"
}
```

Assumes near-uniform mesh scale; for heavily non-uniform scale, use the inverse-transpose normal transform instead of `MODEL_MATRIX` directly.

### 2. Convert existing materials while preserving their values

This is the Godot equivalent of the source's "swap in the pre-configured SG; all values retained" step. Run once (editor tool or import-time), not per frame.

```gdscript
@tool
func convert_to_wet_material(src: StandardMaterial3D, wet_shader: Shader) -> ShaderMaterial:
    var m := ShaderMaterial.new()
    m.shader = wet_shader
    m.set_shader_parameter("albedo_color", src.albedo_color)
    m.set_shader_parameter("metallic", src.metallic)
    m.set_shader_parameter("roughness", src.roughness)
    if src.albedo_texture != null:
        m.set_shader_parameter("albedo_tex", src.albedo_texture)
    return m
```

Extend the copy list for any extra `StandardMaterial3D` properties your project uses (normal maps, emission, UV transforms). Keep the converter in one place so every wet-enabled material is produced identically.

### 3. Drive wetness at runtime with instance uniforms

```gdscript
class_name WetnessController
extends Node

@export var targets: Array[GeometryInstance3D] = []
@export_range(0.0, 1.0) var wet_rate: float = 0.15  # per second while raining
@export_range(0.0, 1.0) var dry_rate: float = 0.05  # per second after rain

var raining := false
var _wet: float = 0.0

func _process(delta: float) -> void:
    var goal := 1.0 if raining else 0.0
    var rate := wet_rate if raining else dry_rate
    _wet = move_toward(_wet, goal, rate * delta)
    for gi: GeometryInstance3D in targets:
        gi.set_instance_shader_parameter("wet_amount", _wet)
```

Use `Area3D` rain zones to toggle `raining` for objects inside them. For scene-wide weather without enumerating targets, register a global shader parameter once (`RenderingServer.global_shader_parameter_add("global_wet_amount", RenderingServer.GLOBAL_VAR_TYPE_FLOAT, 0.0)`) and set it per frame with `RenderingServer.global_shader_parameter_set`; read it in the shader instead of the instance uniform.

### 4. Planned extension: heightmap-guided flow

The source author states heightmap support so wetness flows along map bumps is **planned, not shipped**. When implementing later in Godot: sample a heightmap texture in the fragment stage and bias the wet mask along its gradient (e.g., offset `world_pos.xz` lookups downhill using the height texture derivatives) so streaks follow surface relief. Do not treat this as part of the evidenced technique.

## Tunables

| Parameter | Typical Value | Notes |
|---|---|---|
| `wet_amount` | 0–1, animated | Instance uniform or global shader parameter |
| `up_bias` | 0.35 | Lower = walls and slopes also wet; higher = only flat tops |
| `darkening` | 0.4–0.6 | Wet albedo multiplier = `1.0 - darkening` |
| `wet_roughness` | 0.05–0.15 | Lower = glassy puddle look |
| `noise_scale` | 4–16 | World-space breakup frequency |
| `wet_rate` / `dry_rate` | 0.15 / 0.05 per s | Asymmetric rates feel natural (wets fast, dries slow) |

## Failure Modes & Gotchas

- **View-space normal mistake:** using fragment `NORMAL` directly makes the up-facing mask rotate with the camera. Always pass world normal from `vertex()` via a varying.
- **Expecting in-place injection:** Godot cannot add wet logic to a live `StandardMaterial3D`. The value-preserving step is the one-time conversion, not runtime patching.
- **Duplicate shaders per material:** keep ONE shared `.gdshader`; per-material differences live in uniforms, per-object state in instance uniforms. Otherwise you pay shader compilation and draw-call overhead.
- **Over-darkening:** on already-dark albedos, clamp the darkened result or lower `darkening`.
- **Transparent/unshaded materials:** out of scope; this skill targets opaque PBR surfaces.
- **Skinned meshes:** verify the `MODEL_MATRIX` world-normal transform still behaves with skeletal animation before relying on the up-facing mask.

## Verification

1. With `wet_amount = 0`, converted materials render identically to their original `StandardMaterial3D` values (compare albedo/roughness response under a fixed light).
2. Raising `wet_amount` darkens and glosses upward-facing surfaces; downward-facing and underside faces stay mostly dry.
3. Rotating the camera does NOT shift the wet mask boundaries (confirms world-space normal).
4. `WetnessController` animates wet/dry transitions smoothly with no per-material edits during play.
5. Multiple meshes share one shader resource; adding wet-enabled objects does not add new shader variants.

## Confidence

`extracted` — the Unity-side architecture (Lit-preserving wet swap, CustomFunction→ShaderGraph value bridge, geometry-only mask, planned heightmap flow) is extracted from the linked X post (see evidence boundaries in the source file: demo video and replies not retrievable, no code published). The Godot 4 mapping, shader, and scripts are librarian engineering guidance consistent with that evidence, **not** source-extracted implementation and **not** verified inside SummerEngine.

## Evidence

- [sources/x/tenmomo-unity-realtime-wet/source.md](../../../sources/x/tenmomo-unity-realtime-wet/source.md)
