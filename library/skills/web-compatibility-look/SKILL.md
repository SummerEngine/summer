---
name: web-compatibility-look
description: "Make a web or browser game look high-end in the Compatibility renderer (WebGL 2): what works, what to avoid, 2D and 3D recipes, web performance."
license: MIT
compatibility: [Cursor, Claude Code, Codex, Windsurf, Gemini, OpenCode]
category: rendering-and-lighting
user-invocable: false
allowed-tools: Read Grep summer_get_scene_tree summer_add_node summer_set_prop summer_set_resource_property summer_batch summer_project_setting summer_save_scene summer_play summer_stop summer_screenshot summer_get_diagnostics
paths: ["**/*.tscn", "**/*.tres", "**/*.gdshader", "**/project.godot"]
---

# A great look in the Compatibility renderer

Browser play and web exports run only the **Compatibility** renderer (OpenGL 3 / WebGL 2). Forward+ and Mobile are not available on the web, so a project that plays in the browser must keep:

```
summer_project_setting(key="rendering/renderer/rendering_method", value="gl_compatibility")
summer_project_setting(key="rendering/renderer/rendering_method.mobile", value="gl_compatibility")
```

Never switch it to `forward_plus` or `mobile` for a web game. Features that only exist in Forward+ are ignored or break in Compatibility, so a scene can look fine in a desktop preview and flat or broken in the browser. Design for Compatibility from the start; it can still look premium.

## What to rely on, and what to avoid

| Rely on (works in Compatibility) | Avoid (Forward+ only, or ignored) |
|---|---|
| Unshaded and lit StandardMaterial3D, vertex colours, emission | SDFGI, VoxelGI, SSAO, SSIL, SSR |
| WorldEnvironment: background colour or sky, ambient light, tonemapping, depth fog | Volumetric fog, FogVolume |
| DirectionalLight3D with shadows, a few Omni/Spot lights | Dozens of shadowed real-time lights |
| CanvasItem shaders, 2D lights (PointLight2D, DirectionalLight2D), CanvasModulate | GPUParticles with compute-heavy setups (use CPUParticles2D/3D) |
| CPUParticles2D / CPUParticles3D | Native plugins, threads |
| Screen-reading canvas shaders (`hint_screen_texture`) for full-screen post effects | Effects you have not seen work in a browser capture |

Glow and some environment adjustments depend on the engine version. If you use them, take a screenshot in the web preview and check that they really show. Never assume a setting worked because the property exists.

## 2D: a finished look

1. **Palette first.** Pick 5 to 7 colours (a dark, a mid, a light, one accent, one danger) and use only those. The player is the brightest, most saturated thing on screen.
2. **Background with depth.** A GradientTexture2D sky behind two or three Parallax2D layers of simple shapes, each layer lighter and less saturated the further away it is. Nothing is ever a flat default grey.
3. **Shapes that read.** Polygon2D or `_draw()` per object, with a darker outline (2 to 4 px) and two-tone shading (a lighter top half). Characters get eyes or a face.
4. **Light and mood.** CanvasModulate tints the world (dusk, night, cave), and PointLight2D with a soft gradient texture makes lamps, pickups and the player glow.
5. **Post effect, optional.** One full-screen ColorRect on a top CanvasLayer with a canvas_item shader that reads the screen texture: a soft vignette and a slight colour grade. Keep it under a few texture reads.
6. **Hit flash and juice.** A tiny canvas_item shader (`uniform float flash; COLOR.rgb = mix(COLOR.rgb, vec3(1.0), flash);`) tweened on hits, plus particles and a small camera shake.

## 3D: a finished look

1. **Flat-shaded or stylised materials.** StandardMaterial3D with palette albedo, roughness 1, no metallic. For a toon look use `diffuse_mode = DIFFUSE_TOON` and `specular_mode = SPECULAR_TOON`, or a small spatial shader with banded lighting.
2. **One sun, real shadows.** One DirectionalLight3D (shadows on, a warm colour) plus an ambient light from the WorldEnvironment in the cool palette colour, so shadows are tinted, not black.
3. **Depth fog in a palette colour.** Fog that matches the sky colour hides the far edge and gives scale.
4. **Bake what you can.** Static props can carry vertex-colour ambient occlusion or a hand-painted gradient, which costs nothing at runtime.
5. **Emission for accents.** Pickups, eyes, lamps and the goal get emissive materials in the accent colour.
6. **Readable silhouettes.** Keep the camera far enough back, use a slightly saturated rim colour on the player (a fresnel term in a spatial shader), and avoid noisy textures.

## Performance on the web

- Aim for 60 fps on a mid laptop browser: fewer than about 200 visible meshes, shadows on one light only, CPU particles under about 300 alive.
- Reuse nodes (pools) instead of instancing every frame, and never allocate in `_process`.
- Keep textures small (1024 px or less) and power-of-two where you can.

## Verify

Run the game, take one screenshot in the web preview, and compare it to the palette and the look. A grey, blank or default-looking capture means the look is not there yet, or a Forward+-only feature was used: fix it before moving on.
