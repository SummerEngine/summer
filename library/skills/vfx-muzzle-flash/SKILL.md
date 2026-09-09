---
name: vfx-muzzle-flash
description: Use when authoring a muzzle-flash visual effect — a one-shot ~80 ms burst at a gun barrel built with a particle one-shot OR a flashing quad with a star-burst shader. Trigger on "muzzle flash", "gun fire", "weapon flash", "barrel flash", "shoot a gun", "spell-cast burst at hand".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: visual-effects
user-invocable: true
allowed-tools: Read Write Edit summer_write_file summer_read_file summer_create_scene summer_add_node summer_set_prop summer_set_resource_property summer_connect_signal summer_inspect_node summer_save_scene summer_run_script summer_get_script_errors summer_get_debugger_errors summer_play summer_stop
paths: ["**/*.tscn", "**/*.gd", "**/*.gdshader", "addons/vfx/**"]
---

# muzzle-flash — One-Shot Star-Burst Flare

A muzzle flash is on screen for 60–100 ms. Long enough to read, too short to animate. The recipe: a single billboarded quad with a star-burst gradient shader, fired by `restart()` on a weapon's `fired` signal, plus an `OmniLight3D` snapping on for 60 ms to light the room. Optional: a tiny GPUParticles3D one-shot for sparks. Doom Eternal does this. Half-Life 2 did this. Every shooter does this.

## When to use

- "Add a muzzle flash to the rifle / pistol / shotgun."
- "When I fire, the gun should flash."
- "Spell-cast burst at the wizard's palm." (one-shot at hand position)
- "Cannon fires, big flash at the barrel."
- The user just hooked up a weapon and the firing reads as silent / weightless.

## When NOT to use

- The user wants a *continuous* flame (flamethrower) — use `fire`, not muzzle-flash.
- The user wants the impact spark on the wall the bullet hit — that's `hit-spark`.
- The user wants a tracer line from barrel to target — use an `ImmediateMesh`
  recipe, not this. The current Summer build has no `Line3D`
  (`ClassDB.class_exists("Line3D")` is `false`).
- The user wants a slow-glowing spell charge-up — use `magic-glow` for the buildup, then this for the release frame.

## Recipe

### 1. Files to create

```
addons/vfx/muzzle-flash/muzzle_flash.gdshader
addons/vfx/muzzle-flash/muzzle_flash.gd
addons/vfx/muzzle-flash/muzzle_flash.tscn  (reusable scene)
```

### 2. Shader code

`addons/vfx/muzzle-flash/muzzle_flash.gdshader`:

```glsl
shader_type spatial;
render_mode unshaded, blend_add, depth_draw_never, cull_disabled, shadows_disabled;

uniform vec4  flash_color    : source_color = vec4(1.0, 0.85, 0.45, 1.0);
uniform vec4  core_color     : source_color = vec4(1.0, 1.0, 0.95, 1.0);
uniform float intensity      : hint_range(0.0, 1.0) = 1.0;       // driven by the controller (1 → 0)
uniform float emission_boost : hint_range(0.0, 12.0) = 6.0;
uniform int   ray_count      : hint_range(2, 8) = 4;
uniform float ray_sharpness  : hint_range(0.5, 32.0) = 8.0;
uniform float random_seed    : hint_range(0.0, 6.2831) = 0.0;    // rotates the star per shot

void vertex() {
    // Billboard toward the camera. The bare mat4(INV_VIEW_MATRIX[0..2], MODEL_MATRIX[3])
    // form discards the node's scale, so the per-shot `flash_size` randomisation in
    // fire() would never reach the screen — normalize the basis and re-apply scale.
    MODELVIEW_MATRIX = VIEW_MATRIX * mat4(
        normalize(INV_VIEW_MATRIX[0]),
        normalize(INV_VIEW_MATRIX[1]),
        normalize(INV_VIEW_MATRIX[2]),
        MODEL_MATRIX[3]) * mat4(
        vec4(length(MODEL_MATRIX[0].xyz), 0.0, 0.0, 0.0),
        vec4(0.0, length(MODEL_MATRIX[1].xyz), 0.0, 0.0),
        vec4(0.0, 0.0, length(MODEL_MATRIX[2].xyz), 0.0),
        vec4(0.0, 0.0, 0.0, 1.0));
    MODELVIEW_NORMAL_MATRIX = mat3(MODELVIEW_MATRIX);
}

void fragment() {
    vec2 c = UV - vec2(0.5);
    float r = length(c) * 2.0;
    float ang = atan(c.y, c.x) + random_seed;

    // Soft radial core: hottest at center, falls off to zero at the edge.
    float core = smoothstep(1.0, 0.0, r);
    core = pow(core, 2.0);

    // Star-burst rays: cosine of angle * ray_count gives N spokes.
    float rays = pow(max(cos(ang * float(ray_count)), 0.0), ray_sharpness);
    rays *= smoothstep(1.05, 0.05, r);  // rays fade to edge

    float mask = clamp(core + rays * 0.85, 0.0, 1.0);

    // Mix core color (white-hot) into flash color at the very center.
    vec3 col = mix(flash_color.rgb, core_color.rgb, pow(core, 4.0));

    // `render_mode unshaded` outputs ALBEDO and discards EMISSION entirely
    // (scene_forward_clustered.glsl:2962 — `frag_color = vec4(albedo, alpha)`
    // under MODE_UNSHADED), so the bloom boost has to live in ALBEDO.
    ALBEDO = col * emission_boost * intensity;
    ALPHA  = mask * intensity;
}
```

### 3. GDScript controller

`addons/vfx/muzzle-flash/muzzle_flash.gd`:

```gdscript
@tool
class_name MuzzleFlash
extends Node3D

## Spawn one of these as a child of the gun's barrel tip and call `fire()` on each shot.

const SPARK_SCENE := "res://addons/vfx/hit-spark/hit_spark.tscn"

@export var flash_color: Color = Color(1.0, 0.85, 0.45)
@export_range(0.02, 0.30) var flash_duration: float = 0.08  ## seconds visible
@export_range(0.10, 4.0)  var flash_size: float = 0.6      ## meters across
@export_range(0.0, 12.0)  var emission_boost: float = 6.0
@export_range(0.0, 8.0)   var light_energy: float = 4.0
@export_range(0.5, 12.0)  var light_range: float = 6.0
@export var spawn_sparks: bool = true

var _quad: MeshInstance3D
var _mat: ShaderMaterial
var _light: OmniLight3D
var _sparks: GPUParticles3D
var _t: float = 0.0
var _firing: bool = false

func _ready() -> void:
    _quad = MeshInstance3D.new()
    var mesh := QuadMesh.new()
    mesh.size = Vector2(flash_size, flash_size)
    _quad.mesh = mesh
    _mat = ShaderMaterial.new()
    _mat.shader = preload("res://addons/vfx/muzzle-flash/muzzle_flash.gdshader")
    _mat.set_shader_parameter("flash_color", flash_color)
    _mat.set_shader_parameter("emission_boost", emission_boost)
    _mat.set_shader_parameter("intensity", 0.0)
    _quad.material_override = _mat
    _quad.visible = false
    add_child(_quad)

    _light = OmniLight3D.new()
    _light.light_color = flash_color
    _light.omni_range = light_range
    _light.light_energy = 0.0
    _light.shadow_enabled = false
    add_child(_light)

    # preload() resolves at PARSE time, so a runtime ResourceLoader.exists() check
    # cannot guard it — "Parse Error: Preload file ... does not exist" takes the
    # whole script down when hit-spark hasn't been installed. Use load().
    if spawn_sparks and ResourceLoader.exists(SPARK_SCENE):
        var packed: PackedScene = load(SPARK_SCENE)
        _sparks = packed.instantiate() as GPUParticles3D
        if _sparks:
            _sparks.one_shot = true
            _sparks.emitting = false
            add_child(_sparks)

    set_process(false)

func fire() -> void:
    _t = flash_duration
    _firing = true
    _quad.visible = true
    _mat.set_shader_parameter("random_seed", randf() * TAU)
    var random_scale := flash_size * randf_range(0.85, 1.15)
    (_quad.mesh as QuadMesh).size = Vector2(random_scale, random_scale)
    if _sparks:
        _sparks.restart()
        _sparks.emitting = true
    set_process(true)

func _process(delta: float) -> void:
    if not _firing:
        return
    _t -= delta
    var k: float = clamp(_t / flash_duration, 0.0, 1.0)
    # Snappy decay: spike, then exponential drop.
    var intensity: float = pow(k, 0.5)
    _mat.set_shader_parameter("intensity", intensity)
    _light.light_energy = light_energy * intensity
    if _t <= 0.0:
        _firing = false
        _quad.visible = false
        _light.light_energy = 0.0
        set_process(false)
```

### 4. Node tree

```
Node3D ("MuzzleFlash") [script: muzzle_flash.gd]
  ├── MeshInstance3D (created at runtime — the visual quad)
  ├── OmniLight3D    (created at runtime — the room flash)
  └── GPUParticles3D ("Sparks", optional — instantiated from hit-spark.tscn)
```

### 5. Wire it in (MCP calls)

Place the node at the **barrel tip** of the weapon. If your gun model has a `BarrelTip` Marker3D, parent there directly.

Every scene-mutating call takes an explicit `scenePath`. `summer_set_prop` uses `key`
(not `property`) and only accepts a string, number, or boolean.

```
summer_write_file(path="res://addons/vfx/muzzle-flash/muzzle_flash.gdshader", content="<section 2>", create_only=true)
summer_write_file(path="res://addons/vfx/muzzle-flash/muzzle_flash.gd", content="<section 3>", create_only=true)

summer_add_node(scenePath="res://main.tscn", parent="./Player/Weapon/BarrelTip", type="Node3D", name="MuzzleFlash")
summer_set_prop(scenePath="res://main.tscn", path="./Player/Weapon/BarrelTip/MuzzleFlash", key="script", value="res://addons/vfx/muzzle-flash/muzzle_flash.gd")
summer_set_prop(scenePath="res://main.tscn", path="./Player/Weapon/BarrelTip/MuzzleFlash", key="flash_size", value=0.6)
summer_set_prop(scenePath="res://main.tscn", path="./Player/Weapon/BarrelTip/MuzzleFlash", key="flash_duration", value=0.08)
summer_set_prop(scenePath="res://main.tscn", path="./Player/Weapon/BarrelTip/MuzzleFlash", key="light_energy", value=4.0)
summer_save_scene(scenePath="res://main.tscn")
```

Then in your weapon script, on `fire()`:

```gdscript
$BarrelTip/MuzzleFlash.fire()
```

Or connect the weapon's `fired` signal in the scene:

```
summer_connect_signal(scenePath="res://main.tscn", emitter="./Player/Weapon", signal="fired", receiver="./Player/Weapon/BarrelTip/MuzzleFlash", method="fire")
```

### 5a. One-script wiring (summer_run_script)

On engines with `summer_run_script` (see `scene-scripting`), the node calls
above are ONE transactional ctx script — and mounting a flash on every weapon in the
scene becomes a loop instead of a CRUD chain per gun:

```gdscript
func run(ctx):
    var tip := ctx.find("BarrelTip")
    var flash := ctx.add_node("Node3D", "MuzzleFlash", tip)
    flash.set_script(load("res://addons/vfx/muzzle-flash/muzzle_flash.gd"))
    flash.set("flash_size", 0.6)
    flash.set("flash_duration", 0.08)
    flash.set("light_energy", 4.0)
    var weapon := ctx.find("Weapon")
    weapon.connect("fired", Callable(flash, "fire"), CONNECT_PERSIST)
    # CONNECT_PERSIST is required — a bare connect() works live but is NOT saved
    ctx.save_scene()
```

### 5b. Verify

`muzzle_flash.gd` `preload`s its own shader, so a shader that failed to write takes
the script down at parse time. Check before firing a shot.

```
summer_get_script_errors          # muzzle_flash.gd parsed?
summer_play
summer_get_debugger_errors        # shader compile errors surface here at runtime
summer_stop
```

### 6. Parameters to tune

| Parameter | Range | Effect |
|---|---|---|
| `flash_duration` | 0.04–0.20 s | how long the flash is visible; >0.15 looks like a flamethrower |
| `flash_size` | 0.10–4.0 m | quad size; matches the weapon's caliber |
| `emission_boost` | 0.0–12.0 | bloom strength; higher needs Bloom in WorldEnvironment |
| `light_energy` | 0.0–8.0 | how much the muzzle lights the surroundings |
| `light_range` | 0.5–12.0 m | how far the flash light reaches |
| `ray_count` (shader) | 2–8 | spokes in the star-burst; pistol = 4, shotgun = 6 |
| `ray_sharpness` (shader) | 0.5–32.0 | tightness of each ray |

## Cookbook — named variants

### pistol-flash (default)

```
flash_duration = 0.06
flash_size     = 0.35
emission_boost = 6.0
light_energy   = 3.0
light_range    = 4.0
ray_count      = 4
ray_sharpness  = 10.0
```

### rifle-flash

Slightly longer flash, narrower star.

```
flash_duration = 0.08
flash_size     = 0.50
emission_boost = 7.0
light_energy   = 4.0
light_range    = 6.0
ray_count      = 4
ray_sharpness  = 14.0
```

### shotgun-blast

Wide, short, lots of spokes.

```
flash_duration = 0.09
flash_size     = 0.95
emission_boost = 9.0
light_energy   = 6.0
light_range    = 9.0
ray_count      = 6
ray_sharpness  = 5.0
spawn_sparks   = true
```

### plasma-cast (sci-fi / spell)

Cool color, slightly longer hold, no random rotation.

```
flash_color    = Color(0.45, 0.85, 1.0)
flash_duration = 0.12
flash_size     = 0.70
emission_boost = 10.0
light_energy   = 5.0
light_range    = 7.0
ray_count      = 8
ray_sharpness  = 18.0
```

## Anti-patterns

- **Looping the flash.** It's a one-shot. `set_process(false)` after the timer; do NOT call `fire()` from `_process`.
- **Forgetting to randomize `random_seed` per shot.** Otherwise every flash is the identical orientation and the player notices it as a rendered sprite, not a flash.
- **Using `blend_mix` instead of `blend_add`.** A flash mixes light, it doesn't occlude. Always `blend_add`.
- **OmniLight3D with shadows enabled.** A 60 ms shadow pass costs more than the flash itself. `shadow_enabled = false`.
- **Flash duration > 150 ms.** Reads as a flamethrower or a stuck animation. Stay under 100 ms unless intentional.
- **Spawning a new MuzzleFlash each shot and freeing it.** Rapid-fire weapons leak. Reuse one anchored to the barrel and call `fire()`.
- **`preload`ing the optional hit-spark scene.** `preload()` resolves at parse time, so wrapping it in a runtime `ResourceLoader.exists()` check does nothing — the script fails to load entirely when hit-spark isn't installed. Use `load()` behind the check.
- **Generating an animated flash sprite.** That's the misroute this skill exists to prevent. The procedural shader rotates per shot for free, and you can recolor without regenerating.

## Performance notes

- One quad + one light + ~8 sparks is negligible — safe at any rate of fire. That is an order-of-magnitude expectation, not a measurement.
- The `OmniLight3D` snapping on/off per shot will trigger a shadow re-bake on lights with `shadow_enabled = true` — keep it off, always.
- For full-auto weapons (10+ shots/sec), consider raising `flash_duration` to 0.10 and dropping `intensity` to 0.6 so consecutive flashes blend instead of strobe.

## Edge cases

- **First-person view, gun fills half the screen.** Your `flash_size` of 0.35 will look tiny because the camera is 0.3 m from the barrel. Bump to 0.6+ for FPS, scale down for third-person.
- **Weapon visible in a mirror / scope.** The additive quad will appear in reflections only if the reflection probe captures it; for scope ADS, render the flash into the scope's separate viewport.
- **Underwater shooting.** Tint the flash blue-green via `flash_color`, drop `light_range` to 30%.
- **Silenced weapon.** `flash_size = 0.10`, `light_energy = 0.5`, `flash_duration = 0.04`. Just a wink at the barrel.
- **Suppressed flash with a tracer.** Pair this with an `ImmediateMesh` tracer from barrel to hit point, fired in the same call.

## Fallback (no MCP)

Section 5 is fully automatable — `summer_write_file` writes the shader and the
controller, `summer_add_node` + `summer_set_prop` place it, and
`summer_connect_signal` wires `fired` → `fire`. Do not hand these steps to the user
when the MCP tools are available.

Without the MCP connection there is no engine to drive, so the user does it
manually in Summer Engine:

1. Create `addons/vfx/muzzle-flash/` and write the three files above.
2. Add a `Node3D` child to your weapon's barrel tip Marker3D.
3. Attach `muzzle_flash.gd` as the script. The runtime builds the quad + light.
4. In your weapon's fire code: `$BarrelTip/MuzzleFlash.fire()`.
5. Check the Errors dock — `muzzle_flash.gd` `preload`s the shader, so a broken shader path fails the script too.

## Handoff

After firing this recipe, suggest:

- `vfx-hit-spark` — pair on the bullet impact end.
- `vfx-smoke` — for a small puff at the barrel after the flash for high-caliber weapons.
- `game-feel` — recoil camera kick + screen shake (`CameraShake.add_trauma(0.15)`) on every shot makes the flash feel 5× more powerful.
- `sound-effect` — generate `9mm pistol shot, sharp crack, indoor, short tail, 400ms` and play in the same `fire()`.

## See also

- `_building-blocks/additive-billboard-particles.md` — canonical additive material reference
- `_building-blocks/trauma-shake-snippet.md` — `CameraShake.add_trauma()` for the recoil punch
- `vfx-hit-spark` — companion impact effect
- `vfx-lightning` — for energy weapons (replace the flash with a beam)
- `game-feel` — recoil + hit-stop wiring
