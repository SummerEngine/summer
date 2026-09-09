---
name: vfx-magic-glow
description: Use when authoring a magic-glow visual effect — a pulsing OmniLight3D plus drifting additive motes plus optional emission shader on the source mesh. Trigger on "magic glow", "enchanted item", "soul gem", "pulsing aura", "rune glow", "magical orb", "summon circle glow", "fairy", "wisp".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: visual-effects
user-invocable: true
allowed-tools: Read Write Edit summer_write_file summer_read_file summer_create_scene summer_add_node summer_set_prop summer_set_resource_property summer_inspect_node summer_save_scene summer_run_script summer_screenshot summer_get_script_errors summer_get_debugger_errors summer_play summer_stop
paths: ["**/*.tscn", "**/*.gd", "**/*.gdshader", "addons/vfx/**"]
---

# magic-glow — Pulsing Light + Drifting Motes

Three layered cues that together read as "magical": a pulsing `OmniLight3D` (sin-wave energy), drifting additive billboard motes orbiting the source, and optional emission on the source mesh itself. Used for: enchanted items, soul gems, runes, summoning circles, wisps, fairies, magical waypoints. The recipe writes a single controller that builds and animates all three layers from one node.

## When to use

- "This sword is enchanted — add a glow."
- "Make the soul gem pulse with light."
- "Magic rune on the floor glowing."
- "Wisp / fairy / firefly companion."
- "The summoning circle is active."
- "Quest item glows so the player notices it."
- Pre-charge phase before casting `lightning` or `muzzle-flash` (charge-up beam).

## When NOT to use

- The user wants a static, non-animated glow — just enable emission on the mesh's material; this recipe is overkill.
- The user wants flames, not a glow — use `fire` (or `magic-fire` variant of `fire`).
- The user wants a beam shooting out, not an aura — use `lightning` with the `plasma-laser` variant.
- The user wants a screen-space bloom on the whole scene — that's `WorldEnvironment.glow_*`, not a per-object recipe.
- The user wants a 2D glow on a UI sprite — use `canvas_item` shader with a radial gradient, not this 3D recipe.

## Recipe

### 1. Files to create

```
addons/vfx/magic-glow/magic_glow.gd
addons/vfx/magic-glow/magic_glow.tscn
```

No custom shader — uses canonical additive billboard motes (see `_building-blocks/additive-billboard-particles.md`) plus an `OmniLight3D`. Optional: pair with the source mesh's existing material's emission.

### 2. GDScript controller

`addons/vfx/magic-glow/magic_glow.gd`:

```gdscript
@tool
class_name MagicGlow
extends Node3D

## Builds: OmniLight3D (pulsing) + GPUParticles3D motes (drifting orbit) + optional mesh emission tween.
## Add as a child of any glowing object.

@export_group("Color")
@export var glow_color: Color = Color(0.55, 0.85, 1.0)
@export_range(0.0, 12.0) var light_energy_base: float = 1.4
@export_range(0.0, 12.0) var light_energy_amplitude: float = 0.8

@export_group("Pulse")
@export_range(0.05, 4.0) var pulse_hz: float = 0.7
@export var pulse_easing: Curve  ## leave null for sine; assign for custom

@export_group("Light")
@export_range(0.5, 30.0) var light_range: float = 4.0
@export var light_shadow_enabled: bool = false

@export_group("Motes")
@export_range(0, 256) var mote_count: int = 24
@export_range(0.05, 4.0) var mote_radius: float = 0.6
@export_range(0.5, 8.0)  var mote_lifetime: float = 2.0
@export_range(0.01, 0.30) var mote_size: float = 0.06
@export_range(0.0, 8.0)  var mote_emission_boost: float = 4.0
@export var mote_drift_up: float = 0.3       ## meters/sec mean upward drift

@export_group("Source mesh emission (optional)")
@export var pulse_source_mesh: NodePath      ## point at a MeshInstance3D to tween its emission_energy_multiplier
@export_range(0.0, 12.0) var source_emission_base: float = 1.0
@export_range(0.0, 12.0) var source_emission_amplitude: float = 1.5

var _light: OmniLight3D
var _motes: GPUParticles3D
var _source_mesh: MeshInstance3D
var _source_mat: BaseMaterial3D
var _t: float = 0.0
var _intensity: float = 1.0

func _ready() -> void:
    _build_light()
    _build_motes()
    _resolve_source_mesh()
    set_process(true)

func _build_light() -> void:
    _light = OmniLight3D.new()
    _light.light_color = glow_color
    _light.light_energy = light_energy_base
    _light.omni_range = light_range
    _light.shadow_enabled = light_shadow_enabled
    add_child(_light)

func _build_motes() -> void:
    if mote_count <= 0:
        return
    _motes = GPUParticles3D.new()
    _motes.amount = mote_count
    _motes.lifetime = mote_lifetime
    _motes.one_shot = false
    _motes.explosiveness = 0.0
    _motes.local_coords = true

    var pm := ParticleProcessMaterial.new()
    pm.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_SPHERE
    pm.emission_sphere_radius = mote_radius
    pm.direction = Vector3.UP
    pm.spread = 180.0
    pm.initial_velocity_min = 0.05
    pm.initial_velocity_max = 0.20
    pm.gravity = Vector3(0, mote_drift_up * 0.5, 0)
    pm.scale_min = mote_size * 0.7
    pm.scale_max = mote_size * 1.3
    pm.color = glow_color
    pm.damping_min = 0.5
    pm.damping_max = 1.2
    _motes.process_material = pm

    var mesh := QuadMesh.new()
    mesh.size = Vector2.ONE
    # BaseMaterial3D is abstract ("Native class "BaseMaterial3D" cannot be
    # constructed as it is abstract"); StandardMaterial3D is the concrete subclass.
    var bm := StandardMaterial3D.new()
    bm.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
    bm.blend_mode = BaseMaterial3D.BLEND_MODE_ADD
    bm.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
    bm.billboard_mode = BaseMaterial3D.BILLBOARD_PARTICLES
    bm.albedo_color = glow_color
    bm.emission_enabled = true
    bm.emission = glow_color
    bm.emission_energy_multiplier = mote_emission_boost
    mesh.material = bm
    _motes.draw_pass_1 = mesh

    add_child(_motes)

func _resolve_source_mesh() -> void:
    if pulse_source_mesh.is_empty(): return
    var n := get_node_or_null(pulse_source_mesh)
    if n is MeshInstance3D:
        _source_mesh = n
        var m := _source_mesh.get_active_material(0)
        if m is BaseMaterial3D:
            _source_mat = m
            _source_mat.emission_enabled = true
            if _source_mat.emission == Color.BLACK:
                _source_mat.emission = glow_color

func _process(delta: float) -> void:
    _t += delta
    var phase: float = (sin(_t * TAU * pulse_hz) + 1.0) * 0.5   # 0..1
    if pulse_easing:
        phase = pulse_easing.sample(phase)

    if _light:
        _light.light_energy = (light_energy_base + light_energy_amplitude * phase) * _intensity
    if _source_mat:
        _source_mat.emission_energy_multiplier = (source_emission_base + source_emission_amplitude * phase) * _intensity

func set_intensity(scale: float) -> void:
    ## Scale all visible cues 0..1+ (e.g., charge-up: tween from 0 to 1 over a second).
    ## Held as a separate factor rather than multiplied into light_energy_base /
    ## light_energy_amplitude: a multiplying version (`light_energy_base *= scale`)
    ## pins both fields to 0.0 forever after set_intensity(0.0), so the charge-up
    ## tween from 0 to 1 never brings the glow back.
    _intensity = scale
    if _motes:
        _motes.amount_ratio = scale

func extinguish(fade_seconds: float = 0.6) -> void:
    var t := create_tween().set_parallel(true)
    t.tween_property(_light, "light_energy", 0.0, fade_seconds)
    if _motes:
        t.tween_property(_motes, "amount_ratio", 0.0, fade_seconds)
    t.chain().tween_callback(queue_free)
```

### 3. Node tree

```
Node3D ("MagicGlow") [script: magic_glow.gd]
  ├── OmniLight3D    (created at runtime, pulses)
  └── GPUParticles3D (created at runtime, drifting motes)
```

### 4. Wire it in (MCP calls)

For an enchanted sword:

Every scene-mutating call takes an explicit `scenePath`. `summer_set_prop` uses `key`
(not `property`) and only accepts a string, number, or boolean.

```
summer_write_file(path="res://addons/vfx/magic-glow/magic_glow.gd", content="<section 2>", create_only=true)

summer_add_node(scenePath="res://main.tscn", parent="./Player/Hand/Sword", type="Node3D", name="Glow")
summer_set_prop(scenePath="res://main.tscn", path="./Player/Hand/Sword/Glow", key="script", value="res://addons/vfx/magic-glow/magic_glow.gd")
summer_set_prop(scenePath="res://main.tscn", path="./Player/Hand/Sword/Glow", key="glow_color", value="Color(0.55, 0.85, 1.0)")
summer_set_prop(scenePath="res://main.tscn", path="./Player/Hand/Sword/Glow", key="light_energy_base", value=1.2)
summer_set_prop(scenePath="res://main.tscn", path="./Player/Hand/Sword/Glow", key="light_energy_amplitude", value=0.6)
summer_set_prop(scenePath="res://main.tscn", path="./Player/Hand/Sword/Glow", key="mote_count", value=16)
summer_set_prop(scenePath="res://main.tscn", path="./Player/Hand/Sword/Glow", key="mote_radius", value=0.20)
summer_set_prop(scenePath="res://main.tscn", path="./Player/Hand/Sword/Glow", key="pulse_source_mesh", value="../Blade")
summer_save_scene(scenePath="res://main.tscn")
```

For a soul gem on a pedestal:

```
summer_add_node(scenePath="res://main.tscn", parent="./World/Pedestal/SoulGem", type="Node3D", name="Glow")
summer_set_prop(scenePath="res://main.tscn", path="./World/Pedestal/SoulGem/Glow", key="glow_color", value="Color(0.85, 0.45, 1.0)")
summer_set_prop(scenePath="res://main.tscn", path="./World/Pedestal/SoulGem/Glow", key="pulse_hz", value=0.4)
summer_set_prop(scenePath="res://main.tscn", path="./World/Pedestal/SoulGem/Glow", key="mote_count", value=32)
summer_set_prop(scenePath="res://main.tscn", path="./World/Pedestal/SoulGem/Glow", key="mote_radius", value=0.30)
```

Either wiring block is also ONE ctx script on engines with `summer_run_script`
(see `scene-scripting`) — the eight `summer_set_prop` calls become one
transactional run, and computed placement (a glow per gem in a ring) becomes a loop:

```gdscript
func run(ctx):
    var glow := ctx.add_node("Node3D", "Glow", ctx.find("Sword"))
    glow.set_script(load("res://addons/vfx/magic-glow/magic_glow.gd"))
    glow.set("glow_color", Color(0.55, 0.85, 1.0))
    glow.set("light_energy_base", 1.2)
    glow.set("light_energy_amplitude", 0.6)
    glow.set("mote_count", 16)
    glow.set("mote_radius", 0.20)
    glow.set("pulse_source_mesh", NodePath("../Blade"))
    ctx.save_scene()
```

Judge the pulse with `summer_screenshot framing:"camera"` — emissive glow does not
survive the preset framings' substitute environment.

Then verify — this recipe is one script, so a parse error is the whole effect:

```
summer_get_script_errors          # magic_glow.gd parsed?
summer_play
summer_get_debugger_errors
summer_stop
```

For a charge-up before casting:

```gdscript
# Spawn at the wizard's hand:
var glow: MagicGlow = preload("res://addons/vfx/magic-glow/magic_glow.tscn").instantiate()
$Wizard/HandTip.add_child(glow)
glow.set_intensity(0.0)
var t := create_tween()
t.tween_method(glow.set_intensity, 0.0, 1.0, 0.8)
t.tween_callback(func() -> void:
    Lightning.cast_lightning($Wizard/HandTip.global_position, target.global_position)
    glow.extinguish(0.3))
```

### 5. Parameters to tune

| Parameter | Range | Effect |
|---|---|---|
| `glow_color` | Color | controls light, motes, and (if linked) source emission |
| `light_energy_base` | 0.0–12.0 | resting light brightness |
| `light_energy_amplitude` | 0.0–12.0 | pulse swing on top of base |
| `pulse_hz` | 0.05–4.0 | beats per second; <1 for slow breathing, >2 for buzzing |
| `light_range` | 0.5–30.0 m | reach of the light cast |
| `mote_count` | 0–256 | number of motes orbiting (0 = light only) |
| `mote_radius` | 0.05–4.0 m | spawn sphere radius around the source |
| `mote_lifetime` | 0.5–8.0 s | how long each mote drifts |
| `mote_size` | 0.01–0.30 m | per-mote billboard size |
| `mote_emission_boost` | 0.0–8.0 | bloom strength of motes |
| `mote_drift_up` | -1.0–3.0 | mean upward drift (negative = sink) |
| `pulse_source_mesh` | NodePath | optional: pulse a mesh's emission with the same phase |

## Cookbook — named variants

### enchanted-sword (default)

Cool blue, gentle pulse, few tight motes.

```
glow_color           = Color(0.55, 0.85, 1.0)
light_energy_base    = 1.2
light_energy_amplitude = 0.5
pulse_hz             = 0.7
light_range          = 3.0
mote_count           = 16
mote_radius          = 0.15
mote_size            = 0.04
pulse_source_mesh    = "../Blade"   # blade emission pulses too
```

### soul-gem

Deeper purple, slow heartbeat pulse, many motes.

```
glow_color           = Color(0.75, 0.30, 1.0)
light_energy_base    = 1.0
light_energy_amplitude = 0.8
pulse_hz             = 0.4
light_range          = 4.0
mote_count           = 32
mote_radius          = 0.25
mote_size            = 0.05
mote_drift_up        = 0.4
```

### summoning-circle

Strong, broad, many motes drifting upward.

```
glow_color           = Color(0.45, 0.80, 1.0)
light_energy_base    = 0.8
light_energy_amplitude = 1.6
pulse_hz             = 0.3
light_range          = 8.0
mote_count           = 96
mote_radius          = 1.5
mote_size            = 0.08
mote_drift_up        = 1.0
mote_lifetime        = 3.0
```

### wisp-companion

Tiny floating orb. Attach to a `PathFollow3D` for the wandering motion.

```
glow_color           = Color(0.85, 1.0, 0.65)
light_energy_base    = 0.6
light_energy_amplitude = 0.3
pulse_hz             = 1.2
light_range          = 2.5
mote_count           = 8
mote_radius          = 0.10
mote_size            = 0.03
mote_drift_up        = 0.0
```

### charge-up (paired with lightning/muzzle-flash)

Author the **fully-charged** values here; `set_intensity(0.0 → 1.0)` scales them at
runtime. Leaving `light_energy_base` at 0.0 means the fully-charged glow is also 0.0.

```
glow_color           = Color(0.55, 0.75, 1.0)
light_energy_base    = 1.5     # fully-charged value; set_intensity scales it
light_energy_amplitude = 2.0
pulse_hz             = 2.5     # buzzing
mote_count           = 24
mote_radius          = 0.20
mote_drift_up        = 0.5
```

## Anti-patterns

- **`light_shadow_enabled = true` on every magical item.** A player carrying a glowing sword adds a fast-moving shadow caster; expensive. Default off.
- **Light range too large** (10+ m for a small item). The glow lights up an entire room and the player loses sense of location. Match `light_range` to the item's importance.
- **Mote material set to `BLEND_MODE_MIX`.** Motes look like opaque dots, not glowing dust. Always `BLEND_MODE_ADD`.
- **Motes parented in world space (`local_coords = false`) for an item the player carries.** Motes trail behind as the player walks. Default `local_coords = true`.
- **Forgetting to enable the source mesh's emission before assigning the glow color.** The shader's emission stays black. The controller's `_resolve_source_mesh` enables it.
- **`pulse_hz` too high.** Above 3 Hz it strobes — accessibility issue (photosensitivity). Default 0.7 is calm.
- **Generating an "aura" PNG and using as a billboard sprite.** The misroute. The procedural light + motes are alive and scale to any item.
- **`BaseMaterial3D.new()` for the mote material.** `BaseMaterial3D` is abstract — that line is a parse error and takes the whole script down. Instantiate `StandardMaterial3D`; keep using the `BaseMaterial3D.*` enum constants.
- **A multiplicative `set_intensity` (`light_energy_base *= scale`).** One `set_intensity(0.0)` pins the field to 0.0 permanently, so the charge-up tween from 0 to 1 does nothing. Hold the scale in its own variable and apply it where the energy is written.

## Performance notes

- One glow = 1 light + 16–32 particles. Sub-millisecond — an order-of-magnitude expectation, not a measurement.
- N glowing items in a scene: budget ~12 active `OmniLight3D`s before you start
  culling. The current Summer build has no `LightOccluder3D`
  (`ClassDB.class_exists` is `false`; `LightOccluder2D` is 2D-only). Cull with
  `distance_fade_enabled` / `distance_fade_begin` or a smaller `omni_range`.
- Mobile: drop `mote_count` to 8, `light_range` × 0.5, `light_shadow_enabled = false` always.
- LOD: in `_process`, scale `_motes.amount_ratio` and `_light.light_energy` by `clamp(1.5 - dist_to_camera / 20.0, 0.10, 1.0)`. Past 20 m, drop motes entirely; keep light.

## Edge cases

- **Glow on a moving NPC's head (wisp follower).** Set `local_coords = true` (default) and parent under the NPC. The light moves with the character.
- **Glow on a particle system** (e.g., the wisp is a particle itself). Don't — combine into a single Node3D with the glow attached, or the light won't track the particle's position.
- **Multiple glows on the same object** (sword pommel + blade). Two MagicGlow children, different `pulse_hz` and slightly offset phases → richer feel. Use `pulse_easing` curve to sync if you want them to beat together.
- **Glow visible underwater.** Reduce `light_range` 50% (water absorbs light); tint slightly green.
- **Pulse needs to sync with audio (heartbeat).** Drive `pulse_hz` from your audio system's BPM, or replace `_process` with an `AnimationPlayer` track timed to a music event.

## Fallback (no MCP)

Section 4 is fully automatable — `summer_write_file` writes the controller,
`summer_add_node` + `summer_set_prop` attach and tune it, and `summer_create_scene` +
`summer_save_scene` produce `magic_glow.tscn`. Do not hand these steps to the user
when the MCP tools are available.

Without the MCP connection there is no engine to drive, so the user does it
manually in Summer Engine:

1. Create `addons/vfx/magic-glow/` with the two files above.
2. Add a `Node3D` child to the glowing object, attach `magic_glow.gd`. Save as `magic_glow.tscn` if you want a scene to instantiate.
3. Tune the exported parameters in the inspector or via script.
4. Check the Errors dock before tuning anything.

## Handoff

After firing this recipe, suggest:

- `vfx-lightning` — perfect pre-cast charge-up. Use the `charge-up` variant and ramp `set_intensity(0→1)` then call `Lightning.cast_lightning`.
- `vfx-dissolve` — pair `summon-arrival` (materialize_object) with the `summoning-circle` variant.
- `vfx-fire` (the `magic-fire` variant) — for items that should glow AND flame.
- `game-feel` — slight time-dilation when picking up a pulsing quest item adds weight.
- `sound-effect` — generate `magical hum, ethereal shimmer, 2s loop` and play on the same anchor.

## See also

- `_building-blocks/additive-billboard-particles.md` — canonical additive material settings (this recipe uses them for motes)
- `vfx-lightning` — pre-cast charge-up partner
- `vfx-dissolve` — for summon arrival pairing
- `vfx-fire` — for the `magic-fire` variant
- `gdscript-patterns` — for the controller idioms (signals, exports, `@tool`)
