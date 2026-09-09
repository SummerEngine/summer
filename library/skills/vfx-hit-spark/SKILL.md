---
name: vfx-hit-spark
description: Use when authoring a hit-spark visual effect — a one-shot burst of additive billboard particles oriented to a surface normal, fired on impact. Trigger on "hit spark", "impact spark", "bullet hit", "sword clash", "metal-on-metal", "ricochet", "impact effect", "spawn sparks at hit point".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: visual-effects
user-invocable: true
allowed-tools: Read Write Edit summer_write_file summer_read_file summer_create_scene summer_add_node summer_replace_node summer_set_prop summer_set_resource_property summer_inspect_node summer_save_scene summer_get_script_errors summer_get_debugger_errors summer_play summer_stop
paths: ["**/*.tscn", "**/*.gd", "**/*.gdshader", "addons/vfx/**"]
---

# hit-spark — One-Shot Impact Sparks

Tiny stretched additive billboards spraying outward from an impact point, oriented to the surface normal so the burst points the right way. Used for: bullets hitting metal, sword clashes, footsteps on stone, ricochets, lightning endpoints, hammer strikes. The recipe is a `GPUParticles3D` configured for one-shot bursts plus a `spawn_hit_spark(position, normal)` static helper that orients the emitter, restarts it, and frees after lifetime.

## When to use

- "Sparks when the bullet hits the wall."
- "Sword clash sparks."
- "Sparks under the hammer when the blacksmith works."
- "Footstep sparks on stone for the heavy armor."
- "Ricochet sparks when the projectile glances off."
- "Mining: sparks fly when pickaxe hits rock."
- Endpoint sparks on `lightning` and `muzzle-flash` recipes (they reference this).

## When NOT to use

- The user wants a *flash* at the impact, not a spray of particles — use `muzzle-flash` (recolor it).
- The user wants debris chunks (rock pieces, splinters) — those are physics objects, not particles. Spawn `RigidBody3D` shards, then sparks on top.
- The user wants water droplets at a water impact — recolor this recipe blue/white (it works) or pair with `water-ripple` for the ring on the surface.
- The user wants persistent burning sparks that linger and cool down — that's a hybrid; use this for the burst, then tiny `fire` particles for residual embers.

## Recipe

### 1. Files to create

```
addons/vfx/hit-spark/hit_spark.gd
addons/vfx/hit-spark/hit_spark.tscn
```

No custom shader — uses the canonical additive billboard material (see `_building-blocks/additive-billboard-particles.md`). A `StandardMaterial3D` with the right flags is enough. (`BaseMaterial3D` is abstract: `BaseMaterial3D.new()` is a parse error. Its enum constants are still the right names to use.)

### 2. GDScript controller

`addons/vfx/hit-spark/hit_spark.gd`:

```gdscript
@tool
class_name HitSpark
extends GPUParticles3D

@export_group("Spark size")
@export_range(8, 256)   var spark_count: int = 24 :
    set(v): spark_count = v; _apply()
@export_range(0.05, 1.5) var burst_speed: float = 0.6 :
    set(v): burst_speed = v; _apply()
@export_range(0.05, 1.5) var spark_lifetime: float = 0.35 :
    set(v): spark_lifetime = v; _apply()
@export_range(5.0, 90.0) var spread_degrees: float = 35.0 :
    set(v): spread_degrees = v; _apply()
@export_range(0.0, 9.8)  var gravity_strength: float = 4.0 :
    set(v): gravity_strength = v; _apply()

@export_group("Look")
@export var spark_color: Color = Color(1.0, 0.85, 0.45)
@export_range(0.0, 12.0) var emission_boost: float = 5.0
@export var stretch_to_velocity: bool = true

func _ready() -> void:
    one_shot = true
    emitting = false
    explosiveness = 1.0   # all particles spawn in frame 1
    _apply()
    _ensure_material()

func _apply() -> void:
    amount = spark_count
    lifetime = spark_lifetime

    var pm := process_material as ParticleProcessMaterial
    if pm == null:
        pm = ParticleProcessMaterial.new()
        process_material = pm
    pm.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_POINT
    pm.direction = Vector3.UP                  # local +Y; the controller orients the node to the surface normal
    pm.spread = spread_degrees
    pm.initial_velocity_min = burst_speed * 6.0
    pm.initial_velocity_max = burst_speed * 12.0
    pm.gravity = Vector3(0, -gravity_strength, 0)
    pm.scale_min = 0.04
    pm.scale_max = 0.10
    pm.color = spark_color
    pm.damping_min = 1.5
    pm.damping_max = 3.0
    if stretch_to_velocity:
        pm.particle_flag_align_y = true
        pm.scale_curve = _make_streak_curve()

func _ensure_material() -> void:
    if draw_pass_1 == null:
        var mesh := QuadMesh.new()
        mesh.size = Vector2(0.08, 0.30) if stretch_to_velocity else Vector2(0.10, 0.10)
        # BaseMaterial3D is abstract ("Native class "BaseMaterial3D" cannot be
        # constructed as it is abstract"); StandardMaterial3D is the concrete subclass.
        var bm := StandardMaterial3D.new()
        bm.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
        bm.blend_mode = BaseMaterial3D.BLEND_MODE_ADD
        bm.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
        bm.billboard_mode = BaseMaterial3D.BILLBOARD_PARTICLES
        bm.albedo_color = spark_color
        bm.emission_enabled = true
        bm.emission = spark_color
        bm.emission_energy_multiplier = emission_boost
        mesh.material = bm
        draw_pass_1 = mesh

func _make_streak_curve() -> CurveTexture:
    var c := Curve.new()
    c.add_point(Vector2(0.0, 1.0))
    c.add_point(Vector2(0.8, 1.0))
    c.add_point(Vector2(1.0, 0.0))   # shrink at end of life
    var ct := CurveTexture.new()
    ct.curve = c
    return ct

## Static helper. Spawns a transient one-shot burst at world `position`, oriented to `normal`.
##   parent: where to attach the spark instance (defaults to the scene tree root)
##   position: world-space impact point
##   normal: world-space surface normal at the impact
##   intensity: 0.0–1.0+ scales the burst (light tap = 0.4, heavy hit = 1.0, explosion = 1.6)
static func spawn_hit_spark(
        parent: Node,
        position: Vector3,
        normal: Vector3 = Vector3.UP,
        intensity: float = 1.0,
        scene_path: String = "res://addons/vfx/hit-spark/hit_spark.tscn"
    ) -> HitSpark:
    if not ResourceLoader.exists(scene_path):
        push_error("HitSpark: scene missing at %s" % scene_path)
        return null
    # `var inst := load(...).instantiate()` cannot infer a type; the `as HitSpark`
    # cast is what gives this one a static type.
    var inst := load(scene_path).instantiate() as HitSpark
    if inst == null:
        push_error("HitSpark: %s is not a HitSpark scene" % scene_path)
        return null
    parent.add_child(inst)
    inst.global_position = position
    # Orient local +Y (cone direction) to the surface normal.
    if normal.length_squared() > 0.0001:
        inst.look_at(position + normal, _safe_up(normal))
        inst.rotate_object_local(Vector3.RIGHT, deg_to_rad(-90.0))   # because look_at uses -Z forward
    inst.amount = max(4, int(inst.spark_count * intensity))
    inst.restart()
    inst.emitting = true
    var t := inst.get_tree().create_timer(inst.spark_lifetime + 0.1)
    t.timeout.connect(inst.queue_free)
    return inst

static func _safe_up(n: Vector3) -> Vector3:
    return Vector3.RIGHT if absf(n.dot(Vector3.UP)) > 0.99 else Vector3.UP
```

### 3. Node tree

```
GPUParticles3D ("HitSpark") [script: hit_spark.gd]
  ├── process_material: ParticleProcessMaterial (configured by script)
  └── draw_pass_1: QuadMesh (0.08 × 0.30, additive billboard)
```

The script builds material and process material on `_ready` if missing, so the `.tscn` can be empty besides the script.

### 4. Wire it in (MCP calls)

This recipe is a `.tscn` you instantiate per impact, not added once to the open scene.
Building that `.tscn` is itself an MCP job — `summer_create_scene` makes it,
`summer_set_prop` attaches the script, `summer_save_scene` writes it out. Every
scene-mutating call takes an explicit `scenePath`, and `summer_set_prop` uses `key`
(not `property`).

```
summer_write_file(path="res://addons/vfx/hit-spark/hit_spark.gd", content="<section 2>", create_only=true)

summer_create_scene(path="res://addons/vfx/hit-spark/hit_spark.tscn", rootName="HitSpark", allow_temporary_scene_mutation=true)
# The .tscn root must be a GPUParticles3D, since hit_spark.gd extends it.
# Inspect what summer_create_scene produced and convert the root if it isn't one:
summer_inspect_node(path="HitSpark")
summer_replace_node(scenePath="res://addons/vfx/hit-spark/hit_spark.tscn", path=".", type="GPUParticles3D")
summer_set_prop(scenePath="res://addons/vfx/hit-spark/hit_spark.tscn", path=".", key="script", value="res://addons/vfx/hit-spark/hit_spark.gd")
summer_save_scene(scenePath="res://addons/vfx/hit-spark/hit_spark.tscn")
```

Note on the script lane: `summer_run_script` operates on the **open** scene, and
this recipe builds a standalone `hit_spark.tscn` — so the `summer_create_scene` /
`summer_replace_node` chain above stays the right wiring here. Reach for
`scene-scripting` only if you are placing many pre-spawned spark emitters
into the open scene with computed positions.

### 4b. Verify

`hit_spark.gd` is the whole recipe — if it did not parse, every `spawn_hit_spark`
call is a no-op.

```
summer_get_script_errors          # hit_spark.gd parsed?
summer_play
summer_get_debugger_errors        # e.g. a wrong root type on the .tscn shows up here
summer_stop
```

Then from any impact handler:

```gdscript
# Bullet impact:
var hit := space_state.intersect_ray(query)
if hit:
    HitSpark.spawn_hit_spark(get_tree().root, hit.position, hit.normal, 1.0)

# Sword clash (perpendicular spray, normal = velocity reflection):
HitSpark.spawn_hit_spark(get_tree().root, clash_point, clash_normal, 0.7)

# Pickaxe on stone (heavier burst):
HitSpark.spawn_hit_spark(get_tree().root, hit_pos, hit_normal, 1.4)
```

### 5. Parameters to tune

| Parameter | Range | Effect |
|---|---|---|
| `spark_count` | 8–256 | particles per burst (24 is default; 64 for heavy hits) |
| `burst_speed` | 0.05–1.5 | how fast they fly outward |
| `spark_lifetime` | 0.05–1.5 s | how long visible (short = snappy, long = lingering trails) |
| `spread_degrees` | 5–90° | cone width; 35° = focused outward, 90° = hemisphere |
| `gravity_strength` | 0.0–9.8 | how much they arc downward |
| `spark_color` | Color | tint and emission color |
| `emission_boost` | 0.0–12.0 | bloom strength |
| `stretch_to_velocity` | bool | true = streaked sparks (metal); false = round dots (water) |

## Cookbook — named variants

### bullet-on-metal (default)

Bright orange, fast, gravity arcs them downward.

```
spark_count    = 24
burst_speed    = 0.7
spark_lifetime = 0.35
spread_degrees = 35
gravity_strength = 5.0
spark_color    = Color(1.0, 0.85, 0.45)
emission_boost = 5.0
stretch_to_velocity = true
```

### sword-clash

Wide spray, brief, white-hot.

```
spark_count    = 36
burst_speed    = 0.6
spark_lifetime = 0.25
spread_degrees = 60
gravity_strength = 4.0
spark_color    = Color(1.0, 0.95, 0.75)
emission_boost = 7.0
```

### water-droplet

No emission boost, blue-white, gravity-heavy, round dots.

```
spark_count    = 18
burst_speed    = 0.5
spark_lifetime = 0.6
spread_degrees = 45
gravity_strength = 9.8
spark_color    = Color(0.85, 0.95, 1.0)
emission_boost = 0.5
stretch_to_velocity = false
```

### blood-spurt

Recolor + heavy gravity. Pair with a small decal on the floor where they land.

```
spark_count    = 32
burst_speed    = 0.8
spark_lifetime = 0.5
spread_degrees = 30
gravity_strength = 9.8
spark_color    = Color(0.55, 0.05, 0.05)
emission_boost = 0.8
stretch_to_velocity = true
```

### electric-discharge (paired with lightning endpoints)

Cool blue, low gravity (sparks float briefly), high emission.

```
spark_count    = 20
burst_speed    = 0.5
spark_lifetime = 0.20
spread_degrees = 70
gravity_strength = 1.0
spark_color    = Color(0.55, 0.85, 1.0)
emission_boost = 9.0
```

## Anti-patterns

- **Forgetting `one_shot = true`.** Continuous-emission sparks look like a sparkler held still. One-shot + restart pattern is mandatory.
- **`explosiveness < 1.0` for a one-shot.** Particles spawn over the lifetime instead of in frame 1; the burst looks dribbly. Set `explosiveness = 1.0`.
- **Skipping the surface-normal orientation.** Sparks always shoot upward regardless of impact direction. The `spawn_hit_spark` helper handles `look_at` + the −90° rotate-around-X (because `look_at` uses −Z as forward).
- **Spawning the spark scene as a child of the impacted object.** If the object moves or frees, the sparks vanish. Spawn under the scene tree root.
- **`BLEND_MODE_MIX` instead of `BLEND_MODE_ADD`.** Sparks don't bloom; they look like flat orange triangles.
- **`BaseMaterial3D.new()`.** `BaseMaterial3D` is abstract — that line is a parse error and takes the whole script down. Instantiate `StandardMaterial3D`; keep using the `BaseMaterial3D.*` enum constants.
- **Forgetting to free.** The `spawn_hit_spark` helper creates a `Timer`-equivalent via `get_tree().create_timer` to free after lifetime. Otherwise spent emitters accumulate forever.
- **`spark_lifetime > 1.0` for sharp impacts.** Sparks lingering for a full second look like fairy dust. Keep ≤ 0.5 s for snappy hits.

## Performance notes

- One burst: 24 particles × 0.35 s = ~negligible. Spawning 60 bursts/sec (full-auto fire) = ~1500 live particles. Still well under the GPU budget.
- For sustained automatic fire, pool the spark instances instead of instantiating per shot. Pre-create 16 spark scenes; round-robin them.
- The `look_at` + `rotate_object_local` pair is the most expensive part of the spawn (one matrix decompose). If you spawn 100/frame, cache the orientation math.
- Mobile: drop `spark_count` to 12, `spark_lifetime` to 0.20.

## Edge cases

- **Surface normal points exactly UP.** `look_at` with up = UP fails. The `_safe_up` helper picks RIGHT in that case.
- **Surface normal is zero (interior trigger volume hit).** The function defaults to `Vector3.UP` if `normal.length_squared() < 0.0001`.
- **Impact inside a tight space (corner).** Sparks penetrate walls visually. Either accept it (additive bloom hides it well) or use a `Decal` for the burn mark and skip particles.
- **First-person view, sparks from your own gun's barrel hit.** Use a smaller burst (intensity 0.4) so the camera isn't flooded.
- **Networked multiplayer.** Spawn sparks client-side based on hit events; never replicate the spark node itself (waste of bandwidth).
- **Slow-motion.** Sparks freeze gracefully because `Engine.time_scale` slows the particle simulation. No special handling needed.

## Fallback (no MCP)

Section 4 is fully automatable — `summer_write_file` writes the controller and
`summer_create_scene` + `summer_set_prop` + `summer_save_scene` build `hit_spark.tscn`.
Do not hand these steps to the user when the MCP tools are available.

Without the MCP connection there is no engine to drive, so the user does it
manually in Summer Engine:

1. Create `addons/vfx/hit-spark/` with the two files above.
2. Add a `GPUParticles3D` to a new scene, attach `hit_spark.gd`. Save as `hit_spark.tscn`.
3. From any impact handler: `HitSpark.spawn_hit_spark(get_tree().root, position, normal)`.
4. Check the Errors dock before wiring the first impact.

## Handoff

After firing this recipe, suggest:

- `vfx-muzzle-flash` — pair on the gun side; this recipe handles the bullet-impact side.
- `vfx-lightning` — automatically calls this at endpoints.
- `vfx-water-ripple` — pair the `water-droplet` variant with a ripple ring at the impact for water surfaces.
- `game-feel` — `CameraShake.add_trauma(0.15)` on heavy hits, hit-stop for crit kills.
- `sound-effect` — generate `metal-on-metal clang, sharp transient, short ring, 350ms` per spark variant.

## See also

- `_building-blocks/additive-billboard-particles.md` — canonical additive material settings (this recipe uses them)
- `vfx-muzzle-flash` — the gun-end companion
- `vfx-lightning` — caller; spawns sparks at bolt endpoints
- `vfx-water-ripple` — surface companion for water impacts
- `game-feel` — shake/hit-stop pairings
