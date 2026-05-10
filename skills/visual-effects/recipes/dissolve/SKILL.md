---
name: dissolve
description: Use when authoring a dissolve effect — an object's mesh disintegrating with a glowing burning edge, driven by a noise threshold ShaderMaterial overriding the target's existing material. Trigger on "dissolve", "disintegrate", "burn away", "Thanos snap", "vanish into ash", "enemy fades out", "object burns up".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: visual-effects
user-invocable: true
allowed-tools: Read Write Edit summer_add_node summer_set_prop summer_set_resource_property summer_inspect_node summer_save_scene
paths: ["**/*.tscn", "**/*.gd", "**/*.gdshader", "addons/vfx/**"]
---

# dissolve — Mesh Disintegration with Edge Glow

The dissolve shader samples 3D noise per fragment and clips pixels whose noise value is below a `threshold` uniform. Pixels just above the threshold are tinted with an emissive `edge_color` to fake the burning rim. Animate `threshold` from 0 to 1 over `duration` and the mesh appears to dissolve from "nothing missing" to "completely gone." Used for enemy death, item pickups, transitions, summon FX. NOT a particle system — this is a material override on the target mesh itself.

## When to use

- "Enemy disintegrates when killed."
- "Item dissolves when picked up."
- "Banish the demon back to the void."
- "Thanos snap — character turns to dust."
- "Object burns away."
- "Stealth cloak fades the player out."
- The user wants an object to *go away* dramatically rather than `queue_free()` instantly.

## When NOT to use

- The user wants *fire* on the object that doesn't consume it — use `fire`, not dissolve. Dissolve makes the mesh disappear; fire just sits on top.
- The user wants a particle-driven ash cloud as the object disappears — pair this with `smoke` (recolor to ash gray) spawned at the dissolving mesh's bounds.
- The user wants a fade-out via alpha (cheap, no shader) — set `transparency = TRANSPARENCY_ALPHA` and tween `albedo_color.a` to 0. Dissolve is better but more expensive.
- The user wants the *world* to dissolve in for a level transition — that's a screen-space post-process, not this per-mesh recipe.
- The character has skinned mesh + multiple materials — this works but you have to override every material slot. Confirm with user; consider a fade-out instead.

## Recipe

### 1. Files to create

```
addons/vfx/dissolve/dissolve.gdshader
addons/vfx/dissolve/dissolve_controller.gd
```

No `.tscn` needed — this overrides materials on existing meshes.

### 2. Shader code

`addons/vfx/dissolve/dissolve.gdshader`:

```glsl
shader_type spatial;
render_mode cull_back, depth_draw_opaque;

#include "res://addons/vfx/_building-blocks/noise-3d-fbm.gdshaderinc"

// Original material inputs (so the mesh still looks like itself until it dissolves).
uniform sampler2D albedo_texture : source_color, hint_default_white;
uniform vec4  base_color   : source_color = vec4(1.0, 1.0, 1.0, 1.0);
uniform float base_metallic   : hint_range(0.0, 1.0) = 0.0;
uniform float base_roughness  : hint_range(0.0, 1.0) = 0.7;

// Dissolve params.
uniform float threshold       : hint_range(0.0, 1.0) = 0.0;   // 0 = whole mesh, 1 = gone
uniform float edge_width      : hint_range(0.001, 0.30) = 0.06;
uniform vec4  edge_color      : source_color = vec4(1.0, 0.55, 0.10, 1.0);
uniform float edge_emission   : hint_range(0.0, 16.0) = 6.0;
uniform float noise_scale     : hint_range(0.5, 12.0) = 3.0;
uniform vec3  noise_offset                            = vec3(0.0);
uniform bool  use_object_space                        = true;

void fragment() {
    // Sample noise in object space so the dissolve pattern stays attached to the mesh.
    vec3 npos = (use_object_space ? (inverse(MODEL_MATRIX) * vec4(VERTEX, 1.0)).xyz : VERTEX) * noise_scale + noise_offset;
    float n = fbm3(npos);

    // Discard everything below the threshold.
    if (n < threshold) {
        discard;
    }

    // Edge: pixels within `edge_width` of the threshold get the burning glow.
    float edge_t = smoothstep(threshold + edge_width, threshold, n);

    vec4 tex = texture(albedo_texture, UV) * base_color;
    ALBEDO = mix(tex.rgb, edge_color.rgb, edge_t);
    METALLIC = base_metallic * (1.0 - edge_t);
    ROUGHNESS = mix(base_roughness, 0.4, edge_t);
    EMISSION = edge_color.rgb * edge_emission * edge_t;
}
```

### 3. GDScript controller

`addons/vfx/dissolve/dissolve_controller.gd`:

```gdscript
@tool
class_name DissolveController
extends RefCounted

## One-shot dissolve helper. Static-style API. Call from anywhere.
## Example: DissolveController.dissolve_object(enemy, 1.5, Color(1,0.55,0.1)).

const SHADER_PATH := "res://addons/vfx/dissolve/dissolve.gdshader"

## Dissolve a Node3D (and all MeshInstance3Ds under it) over `duration` seconds, then queue_free.
##   target: the Node3D to dissolve
##   duration: seconds (typical 0.6–2.5)
##   edge_color: glow color of the burning edge
##   edge_emission: bloom strength of the edge
##   free_when_done: queue_free target when threshold reaches 1.0
static func dissolve_object(
        target: Node3D,
        duration: float = 1.2,
        edge_color: Color = Color(1.0, 0.55, 0.10),
        edge_emission: float = 6.0,
        free_when_done: bool = true
    ) -> Tween:
    var meshes := _collect_meshes(target)
    if meshes.is_empty():
        push_warning("DissolveController: no MeshInstance3D under %s" % target.name)
        if free_when_done: target.queue_free()
        return null

    var mats: Array[ShaderMaterial] = []
    for mi in meshes:
        var sm := _override_material(mi, edge_color, edge_emission)
        if sm: mats.append(sm)

    var tween := target.create_tween()
    tween.tween_method(func(v: float) -> void:
        for m in mats:
            m.set_shader_parameter("threshold", v),
        0.0, 1.0, duration).set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_IN_OUT)
    if free_when_done:
        tween.tween_callback(target.queue_free)
    return tween

## Re-form: dissolve from gone (1.0) back to whole (0.0). For summons, teleports-in.
static func materialize_object(
        target: Node3D,
        duration: float = 1.0,
        edge_color: Color = Color(0.55, 0.85, 1.0),
        edge_emission: float = 6.0
    ) -> Tween:
    var meshes := _collect_meshes(target)
    if meshes.is_empty(): return null
    var mats: Array[ShaderMaterial] = []
    for mi in meshes:
        var sm := _override_material(mi, edge_color, edge_emission)
        if sm:
            sm.set_shader_parameter("threshold", 1.0)
            mats.append(sm)
    var tween := target.create_tween()
    tween.tween_method(func(v: float) -> void:
        for m in mats:
            m.set_shader_parameter("threshold", v),
        1.0, 0.0, duration).set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_OUT)
    tween.tween_callback(func() -> void:
        # Restore original materials by clearing overrides.
        for mi in meshes:
            mi.material_override = null)
    return tween

static func _collect_meshes(root: Node) -> Array[MeshInstance3D]:
    var out: Array[MeshInstance3D] = []
    if root is MeshInstance3D:
        out.append(root)
    for child in root.get_children():
        out.append_array(_collect_meshes(child))
    return out

static func _override_material(mi: MeshInstance3D, edge_color: Color, edge_emission: float) -> ShaderMaterial:
    var sm := ShaderMaterial.new()
    sm.shader = load(SHADER_PATH)
    sm.set_shader_parameter("threshold", 0.0)
    sm.set_shader_parameter("edge_color", edge_color)
    sm.set_shader_parameter("edge_emission", edge_emission)
    sm.set_shader_parameter("noise_offset", Vector3(randf(), randf(), randf()) * 10.0)

    # Try to inherit base color/texture from the original BaseMaterial3D.
    var orig_mat := mi.get_active_material(0)
    if orig_mat is BaseMaterial3D:
        var bm := orig_mat as BaseMaterial3D
        sm.set_shader_parameter("base_color", bm.albedo_color)
        sm.set_shader_parameter("base_metallic", bm.metallic)
        sm.set_shader_parameter("base_roughness", bm.roughness)
        if bm.albedo_texture:
            sm.set_shader_parameter("albedo_texture", bm.albedo_texture)

    mi.material_override = sm
    return sm
```

### 4. Node tree

No new nodes added. The recipe overrides the `material_override` on every `MeshInstance3D` under the target.

```
<target Node3D>          (e.g., the enemy)
  ├── MeshInstance3D     ← gets material_override = ShaderMaterial(dissolve.gdshader)
  ├── MeshInstance3D     ← also overridden
  └── ... (Skeleton3D etc. unchanged)
```

### 5. Wire it in (MCP calls)

This recipe is mostly script-driven, no scene mutation needed. Just create the files (Write tool) and call from gameplay code.

```gdscript
# When the enemy dies:
DissolveController.dissolve_object($Enemy, 1.5)

# When summoning a creature:
var minion: Node3D = preload("res://scenes/skeleton.tscn").instantiate()
add_child(minion)
minion.global_position = $SummoningCircle.global_position
DissolveController.materialize_object(minion, 1.0, Color(0.45, 0.85, 1.0))
```

If the target needs the dissolve to be cosmetic-only (no `queue_free`):

```gdscript
DissolveController.dissolve_object(target, 1.2, Color(1, 0.55, 0.1), 6.0, false)
# ...then re-materialize later
DissolveController.materialize_object(target, 0.8)
```

### 6. Parameters to tune

| Parameter | Range | Effect |
|---|---|---|
| `duration` | 0.3–4.0 s | how slow the dissolve plays (0.6 = fast, 1.5 = dramatic, 3.0 = ritual) |
| `edge_width` | 0.001–0.30 | thickness of the glowing rim; thicker = more "burning", thinner = "vanishing" |
| `edge_color` | Color | rim glow tint; orange = fire, blue = magic, green = poison, white = holy |
| `edge_emission` | 0.0–16.0 | rim bloom strength; needs Bloom in WorldEnvironment |
| `noise_scale` | 0.5–12.0 | small = big patches dissolving; large = fine pixel-grain dust |
| `use_object_space` | bool | true = pattern attached to mesh; false = pattern stays in world (cool for moving objects) |

## Cookbook — named variants

### enemy-burn-death (default)

Orange edge, 1.2s, fire-y character.

```
duration       = 1.2
edge_width     = 0.06
edge_color     = Color(1.0, 0.55, 0.10)
edge_emission  = 6.0
noise_scale    = 3.0
```

### thanos-snap

Fast, fine grain, blue edge for the cosmic feel. Pair with `smoke` in pale gray for ash particles rising.

```
duration       = 0.8
edge_width     = 0.04
edge_color     = Color(0.45, 0.65, 1.0)
edge_emission  = 8.0
noise_scale    = 8.0
```

### holy-banish

Slow, white edge, big halo. Add `magic-glow` underneath for a beam of light.

```
duration       = 2.5
edge_width     = 0.15
edge_color     = Color(1.0, 1.0, 0.85)
edge_emission  = 10.0
noise_scale    = 1.5
```

### poison-melt

Slow, sickly green, watery look.

```
duration       = 3.0
edge_width     = 0.10
edge_color     = Color(0.45, 1.0, 0.30)
edge_emission  = 4.0
noise_scale    = 5.0
```

### summon-arrival (use materialize_object)

Inverse of enemy-burn-death.

```
duration       = 0.9
edge_color     = Color(0.55, 0.85, 1.0)
edge_emission  = 7.0
noise_scale    = 4.0
```

## Anti-patterns

- **Calling `dissolve_object` and then `queue_free` immediately.** The tween needs the node alive. Pass `free_when_done = true` (default) so the tween's last call queues the free.
- **Dissolving a mesh with translucent materials (already `transparency = ALPHA`).** The dissolve shader's `discard` works in opaque pass; translucent meshes look weird. Convert to opaque or use a custom dissolve-with-alpha shader.
- **Dissolving a particle system (e.g., torch flame).** The shader is `spatial`, not `particles`. Stop the particles, don't try to dissolve them.
- **Forgetting to seed `noise_offset` per instance.** Two enemies dissolving at the same frame use identical patterns → they look like clones. The included controller randomizes per-instance.
- **Using world-space noise on a moving target.** The dissolve pattern slides over the surface as the mesh moves. Use `use_object_space = true` (default).
- **Skipping the texture inheritance.** The mesh dissolves but goes white because `base_color` defaults to white and no texture is set. The controller pulls from the original `BaseMaterial3D`; if your mesh uses a custom shader, manually wire the textures.
- **Dissolving a `Skeleton3D` directly.** It's not a mesh — recurse into `MeshInstance3D` children. The controller's `_collect_meshes` does this.

## Performance notes

- Per fragment: one FBM noise call + one branch. ~0.05 ms per dissolving object at 1080p covering 10% of the screen. Cheap.
- Multiple meshes on a character (head, body, weapon, cape): each gets its own override. ~5 materials × 0.05 ms = 0.25 ms during the dissolve. Still fine.
- `discard` defeats early-Z. For a screen full of dissolving enemies, consider `cull_back` (already enabled) and avoid stacking 20+ dissolves at once.
- Mobile: drop `noise_scale` to a value the FBM can compute in 1–2 octaves, or replace the `fbm3` include with a single-octave noise.

## Edge cases

- **Mesh has multiple material slots.** The controller only inherits slot 0. For multi-material meshes (helmet + body different textures), extend `_override_material` to loop over all surfaces with `mi.set_surface_override_material(i, ...)`.
- **Skinned mesh deforming during dissolve.** Object-space noise on a skinned mesh moves with the bones — looks fine. World-space noise (`use_object_space = false`) shears with deformation.
- **Mesh has emission already (glowing eyes, etc.).** The dissolve shader resets EMISSION. To preserve the original emission, sample an `emission_texture` uniform and add it to the EMISSION line.
- **Threshold at exactly 1.0 leaves a single subpixel of geometry.** The controller passes 1.0 as the final value; in practice this dissolves everything because no fbm3 returns above 1.0. If it doesn't on your noise, clamp the final value to 1.05.
- **Re-materializing while the dissolve is still tweening.** Both tweens run concurrently. Kill the previous tween first: store the returned `Tween` and call `kill()` before starting the next.

## Fallback (no MCP)

VFX is code, no MCP required:

1. Create `addons/vfx/dissolve/` and write the two files above.
2. From any gameplay script, call `DissolveController.dissolve_object(target_node)`.
3. The controller handles material override, texture inheritance, tween, and freeing.

## Handoff

After firing this recipe, suggest:

- `summer:visual-effects/recipes/smoke` — recolor pale gray, spawn at the target's bounds for ash particles. Especially good for `thanos-snap`.
- `summer:visual-effects/recipes/magic-glow` — for `holy-banish` and `summon-arrival` variants, add a vertical beam of light at the target.
- `summer:visual-effects/recipes/fire` — pair `enemy-burn-death` with a brief flame burst at the start of the dissolve.
- `summer:visual-effects/game-feel` — add a slow-mo on enemy death (`Engine.time_scale = 0.4` for 0.3 s) to emphasize the dissolve.
- `summer:audio/sound-effect` — generate `magical disintegration whoosh, fading shimmer, 1.5s` and play in sync.

## See also

- `_building-blocks/noise-3d-fbm.gdshaderinc` — the FBM noise this shader includes
- `summer:visual-effects/recipes/smoke` — pair for the ash cloud
- `summer:visual-effects/recipes/magic-glow` — for arrival/departure beams
- `summer:visual-effects/recipes/fire` — for the burn-up variant pairing
- `summer:gdscript-patterns` — for the static-API class pattern
