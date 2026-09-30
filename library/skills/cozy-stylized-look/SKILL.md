---
name: cozy-stylized-look
description: "Take a Summer 3D scene from realistic to cozy and vibrant: painted ground, chunky foliage, cartoon sky, warm key with blue fill, Compatibility-safe."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: rendering
user-invocable: true
allowed-tools: Read Grep Glob Edit Write summer_get_script_errors
paths: ["**/*.gd", "**/*.gdshader", "**/*.tscn"]
---

# Cozy stylized look

Evoke the qualities people love in cozy games (fresh saturated greens, chunky rounded shapes, warm sun, soft
blue shadows, clean blue sky). Do not copy a game's assets, palette values or silhouettes. Pick your own
numbers from the recipe below and judge them in your own captures.

Proven on a cozy multiplayer garden game built over a stylized medieval village: one look script, a
`stylized` switch in the shared ground shader, and a lighting profile applied after all scene passes.

## 1. Principles (with the reason)

- **Simple shapes and great light beat detail.** Photo textures read as noise from a high camera and fight
  saturated colour. Replace them with flat paint plus a few large, deliberate marks.
- **Put the style behind a switch.** Add a `stylized` uniform (default 0) to shared shaders and set it from the
  cozy profile. Other games that share the scene keep their look, and one material path serves both.
- **Colour comes from ramps, not textures.** Use top-to-bottom or root-to-tip gradients. Keep a botanical
  texture only for its alpha silhouette.
- **Warm key, cool fill.** Use a warm sun with a sky-blue ambient colour. Shadows then turn soft and blue
  instead of grey. This is what makes a scene feel sunny.
- **No haze, and bloom only on true highlights.** Fog and wide bloom wash saturated colour into pastel mud.

## 2. Palette and lighting recipe (sRGB albedo; tune from here)

| Element | Value |
|---|---|
| Grass base / cool / warm drift | (.42,.63,.33) / (.31,.53,.38) / (.55,.68,.33) |
| Tuft root to tip | (.34,.56,.32) to (.62,.78,.38). The root matches the ground so tufts melt in. |
| Dirt path / cliff | (.76,.54,.35) / (.86,.64,.46) |
| Garden soil / mound | (.48,.32,.22) / about 25% lighter (.66,.46,.30) |
| Canopy top to belly | (.56,.80,.32) to (.20,.47,.38). The belly is cooler (blue-green), not just darker. |
| Pine top to belly | (.30,.62,.36) to (.09,.33,.33) |
| Trunk | (.62,.43,.28), warm tan |
| Sun | colour (1.0,.90,.74), energy 1.2, pitch about -52 deg, shadow_blur 1.8 |
| Ambient | source COLOR, (.64,.74,.95), energy .92, sky contribution 0 |
| Tonemap | Filmic, exposure .96, adjustments brightness 1.02 / contrast 1.06 / saturation 1.05 |
| Glow | intensity .22, bloom 0, hdr_threshold 1.9 |
| Fog | density .0005, light colour sky-blue, sky_affect 0 |
| Sky (linear) | zenith (.05,.24,.78), horizon (.40,.66,.92), cloud belly (.56,.66,.86) |

Saturation multiplies everything. Once the palette is right, keep the `adjustment_saturation` boost at or below
1.1, or the grass goes neon.

## 3. Shader approach

- **Ground:** use two value-noise drifts (about 0.045 and 0.13 per metre) to mix cool, base and warm greens.
  Add scattered marks: one random leaf lens (the intersection of two circles) or a small triangle per random
  cell, 2.5 to 4 cells per metre and 30-40% of cells filled. Antialias them with `fwidth` and fade them out once
  a cell is under about 3 px, so they never shimmer.
  - Draw dirt paths from uniform segments (`vec4 dirt_paths[8]`, distance to segment). Wobble the edge with
    noise and give the grass a slightly darker lip.
  - Only really steep slopes become cliff bands. Gentle hills painted as cliff read as stripes.
  - Use a flat normal and roughness .95.
- **Foliage:** use chunky merged meshes. For a round tree, merge a trunk, one big crown sphere, four shoulder
  spheres and a top knot. For a pine, stack four cones.
  - Build 3-5 cached variants with `SurfaceTool.append_from` and hang one per tree root. Root hiding and
    colliders then keep working, at about two draws per tree.
  - In the vertex shader, displace along the normal with 3D noise to make the lumps.
  - In the fragment shader, ramp albedo on the world-normal y, add a tiny per-tree tint and soft dapple. Keep
    BACKLIGHT around .2 and add no emission.
- **Sky:** keep one sky shader with a `stylized` branch.
  - Gradient: use `pow(smoothstep(0,.8,alt),.55)`.
  - Clouds: project `dir.xz/(alt+.16)*1.9` and sum three value-noise octaves. Give the body a crisp but soft
    edge (smoothstep width .05). Shade it by sampling again with an offset: white tops, blue bellies.
  - Leave the storm mix after the branch so rain still greys the sky.
  - If a weather system swaps in a fresh sky material, restyle it one frame later.

## 4. Camera

Use a high 3/4 view (pitch about -0.74 rad, 8-9 m, FOV 45-50). Crops and flowers must be chunky enough for
that view: a tulip should be about knee-high to a 1.75 m character. The sky is mostly off-screen from there,
so the ground carries the look. Spend your effort on it first.

## 5. Compatibility renderer checks

- Run one capture with `--rendering-method gl_compatibility`. GLES3 lights and tonemaps in one sRGB pass, so
  the same numbers read paler and mintier there.
  - Branch on `RenderingServer.get_current_rendering_method() == "gl_compatibility"`: ambient about .62,
    exposure .86, contrast 1.12, saturation 1.18.
  - SSAO does nothing there. Do not rely on it for contact shading.
- Follow the Compatibility rules in `compatibility-renderer-traps`:
  - No `instance uniform`s (256-instance cap).
  - `use_colors=true` on any MultiMesh whose shader reads COLOR.
  - Convert vertex colours from sRGB to linear only when `!OUTPUT_IS_SRGB`.
- Take `source_color` on every colour uniform. Uniform arrays (`vec4[8]`) work on both renderers.

## 6. Verify

Capture the real game scene offscreen: gameplay camera, a sky or tree-line view, and rain. Read every PNG
against the brief.

- Check the logs for `SCRIPT ERROR` and shader errors. Exit code 0 is not success.
- `md5 -r *.png`: identical files mean the offscreen frame froze. Rerun.

## Don'ts

- Don't grade a photo texture greener and call it stylized. Its noise stays.
- Don't use emission or low glow thresholds for "pop". Foliage blows out. Get pop from saturation plus gloss
  on ripe fruit.
- Don't make cool shadows by darkening albedo. Do it with ambient colour, or undersides go black.
- Don't copy a reference game's exact colours, shapes or assets. Match the qualities, then make your own.
