---
name: vfx-dissolve
description: Use when authoring a dissolve effect — an object's mesh disintegrating with a glowing burning edge, driven by a noise threshold ShaderMaterial overriding the target's existing material. Trigger on "dissolve", "disintegrate", "burn away", "Thanos snap", "vanish into ash", "enemy fades out", "object burns up".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: visual-effects
user-invocable: true
allowed-tools: Read Write Edit summer_write_file summer_read_file summer_inspect_node summer_inspect_resource summer_run_script summer_screenshot summer_get_script_errors summer_get_debugger_errors summer_play summer_stop
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
addons/vfx/_building-blocks/noise-3d-fbm.gdshaderinc   # copy from this skill FIRST
addons/vfx/dissolve/dissolve.gdshader
addons/vfx/dissolve/dissolve_controller.gd
```

No `.tscn` needed — this overrides materials on existing meshes.

`dissolve.gdshader` `#include`s the FBM noise file. A missing include is a hard
compile error, so copy `_building-blocks/noise-3d-fbm.gdshaderinc` from this skill
into `res://addons/vfx/_building-blocks/` before writing the shader.

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
    // In fragment(), VERTEX is in VIEW space — not world, not object. Undo the view
    // transform first, then the model transform, or neither branch samples where it
    // claims to (`inverse(MODEL_MATRIX) * vec4(VERTEX, 1.0)` alone is object-space
    // noise driven by camera-relative coordinates, which slides with the camera).
    vec3 wpos = (INV_VIEW_MATRIX * vec4(VERTEX, 1.0)).xyz;
    vec3 opos = (inverse(MODEL_MATRIX) * vec4(wpos, 1.0)).xyz;

    // Object space keeps the dissolve pattern attached to the mesh; world space
    // keeps it fixed in the level and lets the mesh move through it.
    vec3 npos = (use_object_space ? opos : wpos) * noise_scale + noise_offset;
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

This recipe is script-driven — no scene mutation. Write the two files with
`summer_write_file` (one of `create_only` or `expected_sha256` is required), plus the
`.gdshaderinc`, then call from gameplay code.

```
summer_write_file(path="res://addons/vfx/_building-blocks/noise-3d-fbm.gdshaderinc", content="<from this skill>", create_only=true)
summer_write_file(path="res://addons/vfx/dissolve/dissolve.gdshader", content="<section 2>", create_only=true)
summer_write_file(path="res://addons/vfx/dissolve/dissolve_controller.gd", content="<section 3>", create_only=true)
```

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

### 5a. Iterate on the shader with ctx.make_shader (summer_run_script)

On engines with the Wave F ctx stdlib (see `scene-scripting`), prototype the
shader BEFORE committing it to a file: `ctx.make_shader(code, params)` compiles the
source and returns compile errors **verbatim** in the result (the
`make_shader_errors` report entry, line numbers included) — no silent magenta
material, no play-mode round-trip:

```gdscript
func run(ctx):
    var mat := ctx.make_shader("<section 2 source>", {"threshold": 0.4})
    ctx.apply_material(ctx.find("TestDummy"), mat)   # eyeball it with summer_screenshot
```

The loop: read the exact error from the report → fix that line → re-run. Once it
compiles and a screenshot at `threshold: 0.4` shows the edge glow, write the final
source to `dissolve.gdshader` with `summer_write_file` so the controller can preload
it. (The editor-side preview does not replace 5b — the tweened runtime effect still
needs a play-mode check.)

### 5b. Verify

Both files are compiled code. Check them before claiming the dissolve works.

```
summer_get_script_errors          # dissolve_controller.gd parsed?
summer_play
summer_get_debugger_errors        # shader compile errors surface here at runtime
summer_stop
```

A missing `noise-3d-fbm.gdshaderinc` fails the whole shader, and the mesh then
renders with the fallback material rather than dissolving.

### 6. Parameters to tune

| Parameter | Range | Effect |
|---|---|---|
| `duration` | 0.3–4.0 s | how slow the dissolve plays (0.6 = fast, 1.5 = dramatic, 3.0 = ritual) |
| `edge_width` | 0.001–0.30 | thickness of the glowing rim; thicker = more "burning", thinner = "vanishing" |
| `edge_color` | Color | rim glow tint; orange = fire, blue = magic, green = poison, white = holy |
| `edge_emission` | 0.0–16.0 | rim bloom strength; needs Bloom in WorldEnvironment |
| `noise_scale` | 0.5–12.0 | small = big patches dissolving; large = fine pixel-grain dust |
| `use_object_space` | bool | true = pattern attached to mesh; false = pattern stays in world (cool for moving objects). Both branches derive their position from `INV_VIEW_MATRIX * vec4(VERTEX, 1.0)`, because `VERTEX` in `fragment()` is view space |

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
- **Treating `VERTEX` in `fragment()` as world space.** It is view space. Sampling noise from it directly makes the pattern slide as the *camera* moves, and `inverse(MODEL_MATRIX) * vec4(VERTEX, 1.0)` is not object space either. Go through `INV_VIEW_MATRIX` first, as section 2 does.
- **Skipping the texture inheritance.** The mesh dissolves but goes white because `base_color` defaults to white and no texture is set. The controller pulls from the original `BaseMaterial3D`; if your mesh uses a custom shader, manually wire the textures.
- **Dissolving a `Skeleton3D` directly.** It's not a mesh — recurse into `MeshInstance3D` children. The controller's `_collect_meshes` does this.

## Performance notes

- Per fragment: one FBM noise call (4 octaves, 8 hashes each) + one branch + two 4×4 inversions. Sub-millisecond per dissolving object at 1080p covering 10% of the screen — an order-of-magnitude expectation, not a measurement. Profile if you need a number.
- Multiple meshes on a character (head, body, weapon, cape): each gets its own override, and the cost scales with the number of materials. Still fine for a handful.
- `inverse(MODEL_MATRIX)` runs per fragment. If you are dissolving a large screen-filling mesh and profiling says this hurts, hoist the object-space position into a `varying` computed in `vertex()`.
- `discard` defeats early-Z. For a screen full of dissolving enemies, consider `cull_back` (already enabled) and avoid stacking 20+ dissolves at once.
- Mobile: drop `noise_scale` to a value the FBM can compute in 1–2 octaves, or replace the `fbm3` include with a single-octave noise.

## Edge cases

- **Mesh has multiple material slots.** The controller only inherits slot 0. For multi-material meshes (helmet + body different textures), extend `_override_material` to loop over all surfaces with `mi.set_surface_override_material(i, ...)`.
- **Skinned mesh deforming during dissolve.** Object-space noise on a skinned mesh moves with the bones — looks fine. World-space noise (`use_object_space = false`) shears with deformation.
- **Mesh has emission already (glowing eyes, etc.).** The dissolve shader resets EMISSION. To preserve the original emission, sample an `emission_texture` uniform and add it to the EMISSION line.
- **Threshold at exactly 1.0 leaves a single subpixel of geometry.** The controller passes 1.0 as the final value; in practice this dissolves everything because no fbm3 returns above 1.0. If it doesn't on your noise, clamp the final value to 1.05.
- **Re-materializing while the dissolve is still tweening.** Both tweens run concurrently. Kill the previous tween first: store the returned `Tween` and call `kill()` before starting the next.

## Fallback (no MCP)

Section 5 is fully automatable — `summer_write_file` writes all three files and
`summer_get_script_errors` proves they parsed. Do not hand these steps to the user
when the MCP tools are available.

Without the MCP connection there is no engine to drive, so the user does it themselves:

1. Create `addons/vfx/_building-blocks/` and `addons/vfx/dissolve/` and write the three files above.
2. From any gameplay script, call `DissolveController.dissolve_object(target_node)`.
3. The controller handles material override, texture inheritance, tween, and freeing.
4. Check the Errors dock — a missing `.gdshaderinc` fails the whole shader.

## Handoff

After firing this recipe, suggest:

- `vfx-smoke` — recolor pale gray, spawn at the target's bounds for ash particles. Especially good for `thanos-snap`.
- `vfx-magic-glow` — for `holy-banish` and `summon-arrival` variants, add a vertical beam of light at the target.
- `vfx-fire` — pair `enemy-burn-death` with a brief flame burst at the start of the dissolve.
- `game-feel` — add a slow-mo on enemy death (`Engine.time_scale = 0.4` for 0.3 s) to emphasize the dissolve.
- `sound-effect` — generate `magical disintegration whoosh, fading shimmer, 1.5s` and play in sync.

## See also

- `_building-blocks/noise-3d-fbm.gdshaderinc` — the FBM noise this shader includes
- `vfx-smoke` — pair for the ash cloud
- `vfx-magic-glow` — for arrival/departure beams
- `vfx-fire` — for the burn-up variant pairing
- `gdscript-patterns` — for the static-API class pattern
