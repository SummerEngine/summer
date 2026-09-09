# Additive Billboard Particles — Canonical Material Settings

Reusable material configuration for additive particle billboards (motes, sparks, glow, ash). Used by `magic-glow`, optionally substitutable in `hit-spark` and `fire` if a custom shader is overkill.

`BaseMaterial3D` is abstract — `BaseMaterial3D.new()` is a parse error ("Native class
"BaseMaterial3D" cannot be constructed as it is abstract"). Instantiate
`StandardMaterial3D`; the `BaseMaterial3D.*` enum constants below are still the right
way to name the values.

## Settings

```gdscript
var bm := StandardMaterial3D.new()
bm.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
bm.blend_mode = BaseMaterial3D.BLEND_MODE_ADD
bm.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
bm.billboard_mode = BaseMaterial3D.BILLBOARD_PARTICLES
bm.emission_enabled = true
bm.emission_energy_multiplier = 3.0   # 1.0–5.0 typical; bump for HDR bloom
bm.disable_receive_shadows = true
bm.shadow_to_opacity = false
bm.no_depth_test = false              # true only if particles must read on TOP of opaque geometry
bm.billboard_keep_scale = true        # BILLBOARD_PARTICLES drops per-particle scale without this
bm.albedo_color = Color(R, G, B, 1.0)
bm.emission = Color(R, G, B)          # usually same as albedo for single-color motes
```

## When to use this vs a custom shader

- **Use this `StandardMaterial3D` config** when the effect is just a tinted soft-circle mote (magic glow, sparkles, dust). Less code, faster iteration, free Godot-managed billboard math.
- **Per-particle color over age does NOT need a custom shader.** `ParticleProcessMaterial` has `color_ramp`, `color_initial_ramp`, `alpha_curve` and `emission_curve` (all verified present in 4.6) — those drive the particle's `COLOR` from age and feed straight into a plain `StandardMaterial3D`. Reach for a ramp before reaching for a shader.
- **Use a custom `ShaderMaterial`** when you need per-fragment shape masks (muzzle flash star burst), noise-distorted UVs (fire, smoke), or anything that varies *within* the quad. Those are what `StandardMaterial3D` genuinely can't express.
- If a custom shader does need the particle age, note that the age lives in `INSTANCE_CUSTOM.y` (normalized by `INSTANCE_CUSTOM.w`, the lifetime), that `INSTANCE_CUSTOM.x` is the rotation angle — not the age — and that `INSTANCE_CUSTOM` is **vertex-stage only**. Pass it to `fragment()` through a `varying`.

## Performance note

Additive overdraw is fillrate-bound. `draw_pass_1` is a `Mesh`, so the size dial is on the mesh: keep `QuadMesh.size` at or under `Vector2(0.2, 0.2)` for motes/sparks. Larger quads at full additive intensity destroy mobile fillrate budgets fast.
