# Additive Billboard Particles — Canonical Material Settings

Reusable `BaseMaterial3D` configuration for additive particle billboards (motes, sparks, glow, ash). Used by `magic-glow`, optionally substitutable in `hit-spark` and `fire` if a custom shader is overkill.

## Settings

```
transparency: BaseMaterial3D.TRANSPARENCY_ALPHA
blend_mode: BaseMaterial3D.BLEND_MODE_ADD
shading_mode: BaseMaterial3D.SHADING_MODE_UNSHADED
billboard_mode: BaseMaterial3D.BILLBOARD_PARTICLES
emission_enabled: true
emission_energy_multiplier: 3.0   // 1.0–5.0 typical; bump for HDR bloom
disable_receive_shadows: true
shadow_to_opacity: false
no_depth_test: false              // true only if particles must read on TOP of opaque geometry
albedo_color: Color(R, G, B, 1.0)
emission: Color(R, G, B)          // usually same as albedo for single-color motes
```

## When to use this vs a custom shader

- **Use this `BaseMaterial3D` config** when the effect is just a tinted soft-circle mote (magic glow, sparkles, dust). Less code, faster iteration, free Godot-managed billboard math.
- **Use a custom `ShaderMaterial`** when you need per-particle color ramps over `CUSTOM.x` age (fire), shape masks (muzzle flash star burst), or stretched streaks (hit-spark). Those can't be expressed in `BaseMaterial3D`.

## Performance note

Additive overdraw is fillrate-bound. Keep `draw_pass_1.size <= 0.2` for motes/sparks; larger quads at full additive intensity destroy mobile fillrate budgets fast.
