---
name: fire
description: Use when authoring a fire visual effect — animated flames built with a particle shader, GPUParticles3D, and a noise-based color ramp. Trigger on "torch", "campfire", "bonfire", "flame", "fire effect", "burning", "make this thing on fire", "candle".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: visual-effects
user-invocable: true
allowed-tools: Read Write Edit summer_add_node summer_set_prop summer_set_resource_property summer_inspect_node summer_save_scene
paths: ["**/*.tscn", "**/*.gd", "**/*.gdshader", "addons/vfx/**"]
---

# fire — Animated Particle Flames

Fire in games is almost never a video clip and never an AI-generated sprite. It's a pile of additive billboard quads emitted from a cone, each running a noise-distorted UV through a hot color ramp (red → orange → yellow → smoky alpha-out). Think Skyrim torches, Doom Eternal's pyre, BotW's bonfires — all built from this same recipe with different dials. This skill writes the shader, the controller, and the node tree, then wires them into the open scene. Authoring, not generating.

## When to use

- "Add fire to this torch."
- "Make a campfire / bonfire / hearth flame."
- "Light the brazier."
- "I need a candle flame on this candlestick."
- "The dragon needs a flame breath" (use this for the persistent emitter; pair with a one-shot `muzzle-flash` for the burst).
- The player set something on fire and you need a continuous, physically-anchored flame.

## When NOT to use

- The user wants an object to *burn away* (mesh disintegrating with a fire edge) — route to `dissolve`. Fire is a separate effect; pair them.
- The user wants smoke without flame — go straight to `smoke`. (Most fires want a smoke trail above; spawn this recipe and add `smoke` on top.)
- The user wants a one-frame muzzle flash from a gun — that's `muzzle-flash`, not fire.
- The user wants 2D fire on a UI element — use `canvas_item` shader; this recipe is `spatial`/`particles`.
- The user wants stylized magic flame (blue, purple, ethereal) — use this recipe and load the `magic-fire` variant in the cookbook below.

## Recipe

### 1. Files to create

```
addons/vfx/fire/fire.gdshader              # spatial shader for the visual quad
addons/vfx/fire/fire_process.gdshader      # particle shader for the simulation
addons/vfx/fire/fire_controller.gd          # parameter dials + lifetime
addons/vfx/fire/fire.tscn                   # reusable scene (instantiate per torch)
```

### 2. Visual shader code

`addons/vfx/fire/fire.gdshader`:

```glsl
shader_type spatial;
render_mode unshaded, blend_add, depth_draw_never, cull_disabled, shadows_disabled;

#include "res://addons/vfx/_building-blocks/noise-3d-fbm.gdshaderinc"

uniform vec4 color_hot   : source_color = vec4(1.0, 0.95, 0.55, 1.0);
uniform vec4 color_mid   : source_color = vec4(1.0, 0.45, 0.10, 1.0);
uniform vec4 color_cool  : source_color = vec4(0.85, 0.10, 0.02, 1.0);
uniform vec4 color_smoke : source_color = vec4(0.05, 0.04, 0.04, 0.0);

uniform float noise_scale     : hint_range(0.5, 8.0)  = 3.0;
uniform float noise_speed     : hint_range(0.0, 4.0)  = 1.4;
uniform float distortion      : hint_range(0.0, 0.6)  = 0.20;
uniform float emission_energy : hint_range(0.0, 8.0)  = 3.5;
uniform float soft_edge       : hint_range(0.01, 0.5) = 0.20;

void vertex() {
    // Billboard the quad toward the camera (view-space).
    MODELVIEW_MATRIX = VIEW_MATRIX * mat4(
        INV_VIEW_MATRIX[0],
        INV_VIEW_MATRIX[1],
        INV_VIEW_MATRIX[2],
        MODEL_MATRIX[3]
    );
}

void fragment() {
    // CUSTOM.x is particle age 0..1 (set by the process material).
    float age = CUSTOM.x;

    // Distort UVs with scrolling 3D noise so the flame writhes.
    vec3 np = vec3(UV * noise_scale, TIME * noise_speed);
    float n = fbm3(np);
    vec2 uv = UV + vec2(n - 0.5) * distortion;

    // Soft round mask, hottest at the bottom-center, cooler toward the top.
    vec2 c = uv - vec2(0.5, 0.15);
    float r = length(c * vec2(1.0, 0.55));
    float mask = smoothstep(0.55, 0.55 - soft_edge, r);

    // Color ramp by particle age (0 = hot bright, 1 = smoky alpha-out).
    vec4 col;
    if (age < 0.33) {
        col = mix(color_hot, color_mid, age / 0.33);
    } else if (age < 0.75) {
        col = mix(color_mid, color_cool, (age - 0.33) / 0.42);
    } else {
        col = mix(color_cool, color_smoke, (age - 0.75) / 0.25);
    }

    // Add the noise as a brightness modulation so flames flicker.
    float flicker = mix(0.6, 1.2, n);

    ALBEDO = col.rgb * flicker;
    EMISSION = col.rgb * flicker * emission_energy * (1.0 - age);
    ALPHA = col.a * mask * (1.0 - age * age);
}
```

### 3. Particle process shader (optional)

For most fires the built-in `ParticleProcessMaterial` is fine. Drop in this custom shader only if you need turbulence beyond the standard params:

`addons/vfx/fire/fire_process.gdshader`:

```glsl
shader_type particles;

uniform float rise_speed   : hint_range(0.1, 6.0) = 1.8;
uniform float spread_angle : hint_range(0.0, 1.5) = 0.35;
uniform float lifetime_var : hint_range(0.0, 1.0) = 0.25;

void start() {
    // Random spawn within a small disc.
    float r  = sqrt(rand_from_seed(RANDOM_SEED + uint(7))) * 0.18;
    float th = rand_from_seed(RANDOM_SEED + uint(11)) * 6.2831853;
    TRANSFORM[3].xyz = vec3(cos(th) * r, 0.0, sin(th) * r);

    // Initial velocity: mostly up, slight cone.
    vec3 dir = vec3(
        (rand_from_seed(RANDOM_SEED + uint(13)) - 0.5) * spread_angle,
        1.0,
        (rand_from_seed(RANDOM_SEED + uint(17)) - 0.5) * spread_angle
    );
    VELOCITY = normalize(dir) * rise_speed;

    // Stagger lifetimes for variety.
    LIFETIME = LIFETIME * (1.0 + (rand_from_seed(RANDOM_SEED + uint(19)) - 0.5) * 2.0 * lifetime_var);

    CUSTOM.x = 0.0; // age
    CUSTOM.y = rand_from_seed(RANDOM_SEED + uint(23)); // per-particle seed
}

void process() {
    // Rise + small horizontal sway.
    VELOCITY.y += DELTA * 0.6;
    VELOCITY.x += sin(TIME * 2.0 + CUSTOM.y * 6.28) * DELTA * 0.4;
    VELOCITY.z += cos(TIME * 2.3 + CUSTOM.y * 6.28) * DELTA * 0.4;

    // Shrink as it ages.
    float age = clamp(1.0 - LIFETIME / TOTAL_LIFETIME, 0.0, 1.0);
    CUSTOM.x = age;
    float scale = mix(1.0, 0.35, age);
    TRANSFORM[0].xyz = vec3(scale, 0.0, 0.0);
    TRANSFORM[1].xyz = vec3(0.0, scale, 0.0);
    TRANSFORM[2].xyz = vec3(0.0, 0.0, scale);
}
```

### 4. GDScript controller

`addons/vfx/fire/fire_controller.gd`:

```gdscript
@tool
class_name FireController
extends GPUParticles3D

@export_group("Flame size")
@export_range(0.05, 5.0) var flame_height: float = 1.2 :
    set(v): flame_height = v; _apply()
@export_range(0.05, 3.0) var flame_radius: float = 0.35 :
    set(v): flame_radius = v; _apply()

@export_group("Flame intensity")
@export_range(8, 1024) var particle_count: int = 96 :
    set(v): particle_count = v; _apply()
@export_range(0.2, 4.0) var flame_lifetime: float = 1.4 :
    set(v): flame_lifetime = v; _apply()
@export_range(0.0, 8.0) var emission_energy: float = 3.5 :
    set(v): emission_energy = v; _apply()

@export_group("Color")
@export var color_hot:   Color = Color(1.0, 0.95, 0.55)
@export var color_mid:   Color = Color(1.0, 0.45, 0.10)
@export var color_cool:  Color = Color(0.85, 0.10, 0.02)

func _ready() -> void:
    one_shot = false
    explosiveness = 0.0
    _apply()

func _apply() -> void:
    amount = particle_count
    lifetime = flame_lifetime

    var pm := process_material as ParticleProcessMaterial
    if pm:
        pm.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_SPHERE
        pm.emission_sphere_radius = flame_radius
        pm.direction = Vector3.UP
        pm.spread = 12.0
        pm.initial_velocity_min = flame_height * 0.9
        pm.initial_velocity_max = flame_height * 1.4
        pm.gravity = Vector3.ZERO
        pm.scale_min = flame_radius * 1.1
        pm.scale_max = flame_radius * 1.6

    if draw_pass_1:
        var mesh := draw_pass_1 as QuadMesh
        var mat := mesh.surface_get_material(0) as ShaderMaterial
        if mat:
            mat.set_shader_parameter("color_hot",   color_hot)
            mat.set_shader_parameter("color_mid",   color_mid)
            mat.set_shader_parameter("color_cool",  color_cool)
            mat.set_shader_parameter("emission_energy", emission_energy)

func extinguish(fade_seconds: float = 0.5) -> void:
    var t := create_tween()
    t.tween_property(self, "amount_ratio", 0.0, fade_seconds)
    t.tween_callback(queue_free)
```

### 5. Node tree

```
GPUParticles3D ("Fire") [script: fire_controller.gd]
  ├── process_material: ParticleProcessMaterial (or ShaderMaterial w/ fire_process.gdshader)
  └── draw_pass_1: QuadMesh (size 1.0 × 1.0)
        └── surface_material_override[0]: ShaderMaterial (shader: fire.gdshader)
```

Add an OmniLight3D as a sibling (parented to the same anchor as the GPUParticles3D, NOT under it) for proper light cast. Recommended: `light_color = Color(1.0, 0.6, 0.25)`, `light_energy = 1.6`, `omni_range = 6.0`. Pulse it lightly via the controller for free atmosphere.

### 6. Wire it in (MCP calls)

```
summer_add_node(parent="./World/Torch", type="GPUParticles3D", name="Fire")
summer_set_prop(path="./World/Torch/Fire", property="script", value="res://addons/vfx/fire/fire_controller.gd")

summer_add_node(parent="./World/Torch/Fire", type="ParticleProcessMaterial", name="ProcessMat")
summer_set_resource_property(nodePath="./World/Torch/Fire", resourceProperty="process_material", value="res://addons/vfx/fire/process_mat.tres")

summer_set_resource_property(nodePath="./World/Torch/Fire", resourceProperty="draw_pass_1", value="res://addons/vfx/fire/quad.tres")
# quad.tres is a QuadMesh with size (1,1) and surface_material_override[0] = fire_material.tres (ShaderMaterial wrapping fire.gdshader)

summer_set_prop(path="./World/Torch/Fire", property="flame_height", value=1.2)
summer_set_prop(path="./World/Torch/Fire", property="flame_radius", value=0.35)
summer_set_prop(path="./World/Torch/Fire", property="particle_count", value=96)

summer_add_node(parent="./World/Torch", type="OmniLight3D", name="FireLight")
summer_set_prop(path="./World/Torch/FireLight", property="light_color", value="Color(1.0, 0.6, 0.25)")
summer_set_prop(path="./World/Torch/FireLight", property="light_energy", value=1.6)
summer_set_prop(path="./World/Torch/FireLight", property="omni_range", value=6.0)

summer_save_scene
```

### 7. Parameters to tune

| Parameter | Range | Effect |
|---|---|---|
| `particle_count` (`amount`) | 32–512 | density of the flame, perf cost is linear |
| `flame_lifetime` | 0.5–3.0 s | how long each particle lives before fade |
| `flame_height` | 0.2–4.0 | initial upward velocity → height of the column |
| `flame_radius` | 0.05–2.0 | spawn disc + per-particle scale |
| `emission_energy` | 0.0–8.0 | how much it blooms in the post-process |
| `noise_scale` | 0.5–8.0 | small = wide flowing tongues; large = fine flicker |
| `noise_speed` | 0.0–4.0 | how fast the flame moves |
| `distortion` | 0.0–0.6 | how warped the silhouette gets |
| `color_hot/mid/cool` | Color | the ramp; shift toward blue/green/purple for magic |

## Cookbook — named variants

### torch-flame (default)

Wall-mounted torch, ~1 m flame.

```
particle_count = 64
flame_lifetime = 1.2
flame_height   = 1.2
flame_radius   = 0.20
emission_energy = 3.5
color_hot   = Color(1.0, 0.95, 0.55)
color_mid   = Color(1.0, 0.45, 0.10)
color_cool  = Color(0.85, 0.10, 0.02)
OmniLight3D: light_energy = 1.6, omni_range = 6.0
```

### bonfire

Wide, tall, hungry. Pair with `smoke` directly above.

```
particle_count = 256
flame_lifetime = 1.8
flame_height   = 2.4
flame_radius   = 0.80
emission_energy = 4.5
OmniLight3D: light_energy = 3.5, omni_range = 12.0, pulse 1.0 Hz
```

### candle-flame

Tiny, calm, mostly motionless. Lifetime small so it shimmers in place.

```
particle_count = 24
flame_lifetime = 0.6
flame_height   = 0.18
flame_radius   = 0.04
emission_energy = 2.0
noise_speed    = 0.7
distortion     = 0.10
OmniLight3D: light_energy = 0.6, omni_range = 2.5
```

### magic-fire (blue / arcane)

Cool flame. Same dynamics, recolor the ramp.

```
particle_count = 96
flame_lifetime = 1.6
flame_height   = 1.4
flame_radius   = 0.30
emission_energy = 5.0
color_hot   = Color(0.85, 0.95, 1.00)
color_mid   = Color(0.20, 0.55, 1.00)
color_cool  = Color(0.05, 0.10, 0.55)
OmniLight3D: light_color = Color(0.40, 0.65, 1.0), light_energy = 2.4
```

## Anti-patterns

- **Spatial-only shader on the visual quad.** It still works, but you forgot `blend_add` + `unshaded` and the flame looks like a flat orange triangle in shadow. Always: `render_mode unshaded, blend_add, depth_draw_never;`.
- **Looping a one-shot emitter.** `one_shot = false` for fire (continuous). One-shot is for `muzzle-flash` and `hit-spark`.
- **Missing `cull_disabled`.** Particles billboard toward camera; if you cull backfaces, the flame disappears at certain angles.
- **`depth_draw_opaque` on the visual material.** You'll z-fight with anything inside the flame (the torch handle). Use `depth_draw_never`.
- **OmniLight3D parented under the GPUParticles3D.** The particles emit in local space; the light moves with them. Sibling, not child.
- **Procedural noise computed in world space without a per-instance seed.** Every particle pulses identically, looking like a strobe. The included shader uses `CUSTOM.y` as a per-particle seed.
- **Generating a fire image and using it as the particle texture.** That's the misroute this skill exists to prevent. The shader-driven look is more alive and trivially recolorable.

## Performance notes

- Default 96 particles per fire: ~0.05 ms on desktop GPU, scales linearly. Budget ~512 fire particles total in a scene before you should think about LOD.
- Mobile: drop default to 48, disable the `OmniLight3D` shadow cast, and use a 64×64 noise texture instead of FBM if FPS dips.
- LOD: in the controller's `_process`, scale `amount_ratio` by `clamp(1.0 - dist_to_camera / 30.0, 0.05, 1.0)`. Past 30 m, drop to a single billboard quad with the same shader (no particles).
- The OmniLight3D shadow is the expensive part. Disable shadows on torches that aren't doing dramatic work.
- `blend_add` skips the depth write — good for perf, but means you can't sort fires against each other. Avoid stacking 5 flames at the same Z.

## Edge cases

- **Underwater fire.** Don't. If the user insists (a magic underwater shrine), drop `flame_height` to 0.4, `noise_speed` to 0.3, and tint everything blue-green via the color ramp.
- **Wind affecting the flame.** The simple `process_material` doesn't know about wind. Either drive `pm.gravity = Vector3(wind.x, 0.6, wind.z)` from a script polling a wind vector, or use the `fire_process.gdshader` and pass a wind uniform.
- **Fire on a moving object (torch held by NPC).** Set `local_coords = true` so particles emit in the torch's local space. Otherwise they trail behind as the NPC walks.
- **Fire viewed in mirror / reflection probe.** The flame won't appear in baked reflections (it's transparent). Add a fake glow card (MeshInstance3D with an emissive material) for reflections to pick up.
- **Cinematic close-up of the flame.** Default 96 particles looks sparse at 1080p. Bump to 256 for cinematics, drop back for gameplay.

## Fallback (no MCP)

VFX is code, no MCP required. The user can:

1. Create the four files at `addons/vfx/fire/` with the contents above.
2. In Godot, add a `GPUParticles3D` node, attach `fire_controller.gd`.
3. Set `process_material` to a new `ParticleProcessMaterial` (the script configures it on `_ready`).
4. Set `draw_pass_1` to a new `QuadMesh` (size 1×1), with `surface_material_override[0]` set to a `ShaderMaterial` whose shader is `fire.gdshader`.
5. Save as `fire.tscn` and instantiate at every torch / brazier.

## Handoff

After firing this recipe, suggest neighbors:

- `summer:visual-effects/recipes/smoke` — every fire that lasts > 5 s wants smoke rising above. Spawn 0.5 m above the flame top.
- `summer:visual-effects/recipes/dissolve` — if the user wants the *fuel* (logs, body, paper) to gradually disappear as it burns.
- `summer:visual-effects/recipes/magic-glow` — for an `OmniLight3D` with proper sin-wave pulsing if the default is too constant.
- `summer:visual-effects/game-feel` — for a slight camera flicker / thermal heat-haze post-process near very large fires.
- `summer:audio/sound-effect` — generate `fire crackle, dry wood, soft pops, 2s loop` and wire to an `AudioStreamPlayer3D` on the same anchor.

## See also

- `_building-blocks/noise-3d-fbm.gdshaderinc` — the FBM noise this shader includes
- `_building-blocks/additive-billboard-particles.md` — canonical additive material settings
- `summer:visual-effects/recipes/smoke` — sister recipe for the column rising above
- `summer:visual-effects/recipes/dissolve` — for objects burning away
- `summer:visual-effects/recipes/magic-glow` — for the light source pulsing
- `summer:visual-effects/game-feel` — non-particle game-feel pairings
- `summer:gdscript-patterns` — for the controller's idioms (signals, exports, `@tool`)
