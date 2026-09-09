---
name: psx-retro-rendering
description: "Use when building or reviewing a hardware-informed PlayStation 1 rendering pipeline in Godot 4, including low-resolution output, RGB5 color and exact dithering, affine textures, screen-coordinate snapping, draw-order/depth approximation, vertex lighting, PS1 blend modes, and fog — when accuracy and the limits of each Godot approximation matter, not for a generic pixel-art filter."
license: MIT
category: shaders
tags:
  - rendering
  - shaders
  - retro
  - psx
  - godot4
confidence: extracted
source_refs:
  - sources/x/wyvernbw-psx-shader/source.md
  - sources/web/calinp-psx-rendering/source.md
adaptation: translated
summerengine_refs:
  - repository: SummerEngine/SummerEngine
    revision: a8e5ca520efa927bde6131c9fb36557f19c1bb18
    path: doc/classes/ShaderMaterial.xml
  - repository: SummerEngine/PublicSummerEngine
    revision: 63f6e5cf71d0ddd5df9092cbbe82fee9b9ecf6c0
    path: skills/look/materials-and-vfx/SKILL.md
  - repository: SummerEngine/summer-engine-agent
    revision: e49189b93fcfee88b57e22ba8467cc782b292ac0
    path: skills/workflow/playtesting-a-feature/SKILL.md
source_repo: SummerEngine/summer-gamedev-knowledge@cac7d50be8cfb3c0179c48e65438eb0d375b9fe9
---

# PSX Retro Rendering in Godot 4

## Outcome

Recreate the visible behavior of the original PlayStation rendering pipeline while keeping three things distinct:

1. behavior the PS1 actually had;
2. the Godot technique used to imitate it;
3. places where the imitation cannot reproduce the hardware exactly.

The characteristic result comes from several interacting constraints, not from a single fullscreen filter: a low-resolution framebuffer, 5-bit color, conditional polygon dithering, unfiltered affine textures, integer screen-coordinate vertices, CPU-style polygon ordering, vertex colors and lighting, fixed semi-transparency equations, and depth-cued fog.

The article author's MIT-licensed Godot 4 addon is useful implementation evidence:

- `https://github.com/wyvernbw/godot-psxlike`
- Treat it as a reference implementation, not as proof that every approximation is hardware-exact, compatible with the current Summer Engine build, or suitable for every scene.

## When to Use

- The game targets a PS1/PSX look and needs more than low resolution and vertex wobble.
- An existing PSX shader needs to be checked against hardware behavior.
- Artists need predictable rules for palettes, mesh subdivision, vertex colors, transparency, or fog.

Do not activate this skill for an ordinary low-resolution or pixel-art presentation that does not need PS1-specific rendering behavior.

## Authenticity Boundary

| Visible behavior | Original hardware mechanism | Practical Godot implementation | Accuracy boundary |
|---|---|---|---|
| Low resolution | 1 MB VRAM shared by framebuffers and textures | Render the root viewport at a PSX-era base size | Does not reproduce the VRAM budget |
| RGB5 color | GPU draws RGB555 plus one mask bit | Quantize fragment color to 31 levels per channel | Mask-bit write protection is normally omitted |
| Dithering | Sony 4x4 matrix, enabled per polygon | Apply the exact matrix in the material, commonly toggled per mesh | A fullscreen dither is not equivalent |
| Texture warping | UVs are interpolated affinely | Cancel the GPU's perspective correction with clip `w` | Subdivision strongly changes the result |
| Vertex wobble | Integer screen coordinates and no subpixel rasterization | Quantize clip/NDC coordinates against the viewport | Do not use an arbitrary object-space grid |
| Polygon overlap | No hardware Z-buffer; the CPU submits depth-sorted primitives | Flat `DEPTH`, mesh subdivision, and an optional depth bias | Flat depth is only a proxy for draw ordering |
| Lighting | CPU/GTE-derived colors, Gouraud interpolation | Calculate light at vertices and carry it through `COLOR` | Godot's ordinary per-pixel light pass is different |
| Semi-transparency | Four fixed framebuffer blend equations | Sample the screen texture in a transparent material | Transparent objects cannot reliably blend with each other |
| Fog | GTE depth cue and color operations | Quantized per-vertex factor plus modulation or a fragment blend | Authentic Silent Hill fog is a two-pass technique |

The PS1 GPU is fundamentally a 2D ordered polygon rasterizer. Avoid saying that it had a "flat depth buffer" or that its Z-fighting came from flat per-polygon depth; it had no depth buffer at all.

## Summer Engine Integration

At the pinned Summer Engine revision, `ShaderMaterial` supports shared shaders, material uniforms, and per-instance uniforms through `GeometryInstance3D.set_instance_shader_parameter()`. Prefer per-instance uniforms over duplicating materials when changing mesh-local PSX settings. See `SummerEngine/SummerEngine@a8e5ca520efa927bde6131c9fb36557f19c1bb18:doc/classes/ShaderMaterial.xml`.

In Summer's material workflow, attach a `.tres` material override to the `MeshInstance3D`, not its parent `Node3D`, and save the scene after assignment. A custom PSX pipeline is an appropriate `ShaderMaterial` use because `StandardMaterial3D` cannot express affine interpolation, screen-coordinate snapping, or fixed framebuffer blend equations. See `SummerEngine/PublicSummerEngine@63f6e5cf71d0ddd5df9092cbbe82fee9b9ecf6c0:skills/look/materials-and-vfx/SKILL.md`.

Use this project shape:

```text
Project Settings
|-- Display > Window > Size: 320 x 240, or another intentional PSX-era size
|-- Display > Window > Stretch > Mode: viewport
|-- Display > Window > Stretch > Aspect: keep
|-- Display > Window > Stretch > Scale Mode: integer, when perfect output pixels are desired
|-- Rendering > Renderer: forward_plus for the reference addon's batching path
`-- Rendering > Anti Aliasing: disabled for the PSX render path

Scene
|-- WorldEnvironment
|   `-- Environment with modern tonemapping, glow, SSAO, SSR, and similar effects disabled
|-- Camera3D
|-- MeshInstance3D using the shared opaque PSX material
|-- MeshInstance3D using the separate transparent PSX material when required
`-- PsxLightSystem autoload, only when using the reference addon's custom lights
```

Assign the spatial shader material to meshes. A `WorldEnvironment` or camera environment cannot replace mesh materials.

Shared materials, texture arrays, instance uniforms, and Forward+ can improve batching opportunities. They do not guarantee that arbitrary meshes render in one draw call. Transparent and opaque rendering already require separate materials.

Compatibility-sensitive names and shader behavior must be checked against the installed Summer Engine build. The pinned references document the integration surface used for this translation; they are not a permanent API guarantee.

## Agent Procedure

Implement one visible layer at a time. After each layer, run the game and compare a controlled test scene before composing the next layer. Do not diagnose a combined shader when a low-resolution, color-space, affine, depth, transparency, lighting, or fog boundary can be tested independently.

### 1. Establish the Low-Resolution Output

Use project settings where possible. At runtime, configure the root `Window`, not a nonexistent `content_scale_integer` property:

```gdscript
func configure_psx_output() -> void:
    var root: Window = get_tree().root
    root.content_scale_size = Vector2i(320, 240)
    root.content_scale_mode = Window.CONTENT_SCALE_MODE_VIEWPORT
    root.content_scale_aspect = Window.CONTENT_SCALE_ASPECT_KEEP
    root.content_scale_stretch = Window.CONTENT_SCALE_STRETCH_INTEGER
```

Integer scaling is optional. It preserves even output pixels but can introduce letterboxing when the window is not an integer multiple of the base resolution.

Disable MSAA, TAA, FXAA, texture filtering, and modern post-effects on the PSX path. Decide separately whether UI should share the low-resolution viewport or render at display resolution.

### 2. Keep the Color Pipeline Explicit

RGB5 quantization and the PS1 dither operate on display-encoded RGB values, not on linear-light values. Godot's Forward+ color conversions can otherwise change the palette and dither response.

Choose one coherent texture path:

- Raw sRGB samples: omit `source_color` on the texture uniform, perform modulation/dither/RGB5 in sRGB, then convert to linear before assigning `ALBEDO`.
- Linear samples: use `source_color`, convert the sample back to sRGB before PS1 operations, then convert the final result back to linear.

Do not mix the two paths. Color uniforms declared with `source_color` arrive in linear space and must be converted before combining them with raw sRGB texels.

The end of an opaque fragment pipeline should have this order:

```glsl
color = dither(color, FRAGCOORD.xy);
color = to_rgb5(color);
ALBEDO = to_linear(color);
```

Do not quantize before dithering. Do not describe sRGB itself as a post-effect to disable.

### 3. Quantize to RGB5 and Use the Exact Dither

Use `round()` rather than `floor()` in the final implementation. With fog and dithering, `floor()` can make a flat RGB5-representable color alternate with the next darker shade.

```glsl
vec3 to_rgb5(vec3 color) {
    return round(clamp(color, vec3(0.0), vec3(1.0)) * 31.0) / 31.0;
}
```

The matrix is the PS1 pattern, not a generic Bayer matrix:

```glsl
instance uniform bool use_dither = true;

vec3 psx_dither(vec3 color, vec2 fragcoord, bool eligible) {
    const int[16] DITHER = int[](
        -4,  0, -3,  1,
         2, -2,  3, -1,
        -3,  1, -4,  0,
         3, -1,  2, -2
    );

    if (use_dither && eligible) {
        ivec2 cell = ivec2(fragcoord) % ivec2(4);
        color += vec3(float(DITHER[cell.y * 4 + cell.x]) / 255.0);
    }
    return color;
}
```

On hardware, dithering was selectable per polygon and was available only to Gouraud-shaded or texture-modulated polygons. In a normal Godot mesh shader, a per-mesh instance uniform is a practical compromise:

```glsl
bool dither_eligible = shading == SHADING_GOURAUD || use_modulation;
color = psx_dither(color, FRAGCOORD.xy, dither_eligible);
```

Do not apply one fullscreen dither pass to the entire scene. Flat, unmodulated polygons should remain flat.

### 4. Sample and Author Textures Like PS1 Assets

The PS1 does not bilinearly filter textures. Sample exact texels at mip level zero:

```glsl
uniform sampler2D[10] textures;
instance uniform int tex_id = 0;

vec3 sample_psx_texture(vec2 uv) {
    ivec2 size = textureSize(textures[tex_id], 0);
    ivec2 texel = ivec2(uv * vec2(size));
    texel = clamp(texel, ivec2(0), size - ivec2(1));
    return texelFetch(textures[tex_id], texel, 0).rgb;
}
```

Disable imported filtering and mipmaps unless a deliberate approximation needs them. Handle repeat/wrap behavior explicitly when UVs can leave `[0, 1]`.

Full CLUT/VRAM emulation provides no modern performance benefit and complicates authoring. To reproduce the visible palette limitation, author indexed textures with 16 colors for a 4-bit-style asset or 256 colors for an 8-bit-style asset.

On PS1 textured polygons, a pure-black texel is transparent. If this behavior is enabled, discard black only for the relevant textured path; do not accidentally discard an intentionally black untextured polygon:

```glsl
if (texturing == TEX_TEXTURED && all(equal(color, vec3(0.0)))) {
    discard;
}
```

### 5. Support Raw Textures, Vertex Colors, and Texture Modulation

PS1 polygons can be flat- or Gouraud-shaded, textured or untextured, and raw-textured or texture-modulated. Preserve those as explicit modes.

True per-triangle flat colors are awkward in an ordinary Godot mesh shader. Practical choices are:

- use one `flat_color` instance uniform for a whole mesh;
- duplicate triangle vertices and bake the same color into all three;
- use Gouraud mode with equal colors at a triangle's vertices.

Texture modulation is visually important and is not ordinary multiplication:

```glsl
vec3 modulated = texel * vertex_color * 2.0;
```

The factor of two produces the PS1 overbright response. A half-gray vertex/tint color, `vec3(0.5)`, is neutral. Expose raw texture mode separately so textures can bypass vertex-color modulation.

### 6. Cancel Perspective-Correct UV Interpolation

Merely dividing ordinary interpolated UVs by `w` is incomplete. Multiply at each vertex first, allow the GPU to interpolate, then divide in the fragment shader:

```glsl
render_mode skip_vertex_transform;

varying vec4 clip_pos;

void vertex() {
    vec4 world = MODEL_MATRIX * vec4(VERTEX, 1.0);
    vec4 clip = PROJECTION_MATRIX * VIEW_MATRIX * world;

    POSITION = clip;
    clip_pos = clip;
    UV *= clip.w;
}

void fragment() {
    vec2 affine_uv = UV / clip_pos.w;
    // Sample the texture using affine_uv.
}
```

Affine distortion becomes extreme on large polygons and at grazing camera angles. Mesh subdivision is not just an optimization: it is the main artistic control for texture distortion and also improves the draw-order approximation. Fixed cameras and shorter view distances help. Some PS1 games tessellated geometry dynamically.

### 7. Quantize Vertices in Screen Space

The wobble comes from integer screen coordinates and the absence of subpixel rasterization. Quantize after projection, relative to the actual low-resolution viewport:

```glsl
vec4 snap_to_psx_grid(vec4 clip) {
    vec4 snapped = clip;
    snapped.xy = round(
        clip.xy / clip.w * VIEWPORT_SIZE.xy
    ) / VIEWPORT_SIZE.xy * clip.w;
    return snapped;
}
```

Use the snapped value for `POSITION` and for the clip position carried to the fragment shader. Do not snap local-space vertices to an arbitrary world grid; that produces a different motion artifact. Keep the snap resolution synchronized with the render viewport and visually verify the exact pixel cadence.

### 8. Treat Flat Depth as an Approximation

The original GPU drew polygons in submission order. A Godot shader cannot reproduce the CPU ordering table, so the reference shader uses a non-interpolated depth value:

```glsl
varying flat float polygon_depth;
instance uniform float depth_modifier = 0.0;

void vertex() {
    polygon_depth = clip.z / clip.w + depth_modifier / 100.0;
}

void fragment() {
    DEPTH = polygon_depth;
}
```

Important limitations:

- A `flat` varying normally comes from one provoking vertex, not the average of the triangle.
- A large floor can cover nearer objects because one value represents the entire triangle.
- Intersecting meshes can pop as whole triangles rather than resolve per pixel.
- `depth_modifier` is an artist-controlled ordering bias and is most manageable with fixed cameras.
- Subdivide large surfaces first. Use the bias only for residual ordering problems.

If exact ordering is a requirement, sort and submit appropriately partitioned geometry on the CPU or build a custom rendering path. Do not call this shader technique a real PS1 depth buffer.

### 9. Calculate Lighting Before Fragment Quantization

On original hardware, the CPU/GTE calculates vertex colors. Normals are not interpolated and lit per fragment. The GTE provides a basic three-light directional model; games can also implement their own point-light logic.

Godot's normal `light()` path is per fragment. Enabling Godot vertex lighting gets closer geometrically, but lighting can be applied after the custom fragment pipeline, which leaves gradients too smooth and bypasses the intended RGB5/dither response.

For a consistent result:

1. collect the supported lights in GDScript;
2. pack type, visibility, range, direction or position, and color into an `Image.FORMAT_RGBF` data texture;
3. sample that texture with `texelFetch()` in `vertex()`;
4. calculate Lambert-style illumination per vertex;
5. multiply or otherwise combine it with `COLOR` before affine interpolation, fog, dithering, and RGB5 conversion.

```glsl
COLOR.rgb *= psx_light(world_position, world_normal);
```

Keep positions, directions, and normals in the same coordinate space. Cap the active-light count deliberately. The reference addon uses a configurable 16-entry buffer with directional and omni lights; that is a useful game-facing extension, not the original hardware's three-light limit.

### 10. Implement All Four Semi-Transparency Modes

For existing framebuffer color `B` and incoming fragment color `F`, support:

| Mode | Equation |
|---|---|
| Average | `0.5 * B + 0.5 * F` |
| Add | `B + F` |
| Subtract | `B - F` |
| Quarter add | `B + 0.25 * F` |

These are fixed blend modes, not ordinary source-alpha blending. In Godot, screen-texture access moves the material into the transparent pass. Keep common pipeline code in a `.gdshaderinc` file and provide separate opaque and transparent shaders.

Apply the selected blend before the final dither, RGB5 quantization, and linear conversion:

```text
sample and modulate -> fog -> framebuffer blend -> dither -> RGB5 -> linear output
```

Critical limitation: transparent meshes sampling the screen texture do not contribute to the texture sampled by other transparent meshes in the same pass. When two transparent objects overlap, one can replace or ignore the other. Avoid overlap, split rendering into controlled passes, or use a custom compositor. Document this limitation rather than presenting the effect as generally correct.

### 11. Choose the Intended Fog Model

First compute a clamped near-to-far factor and quantize it to the GTE's 12-bit-style depth-cue range:

```glsl
float psx_fog_factor(float view_distance, float near_distance, float far_distance) {
    float width = max(far_distance - near_distance, 0.0001);
    float fog = clamp((view_distance - near_distance) / width, 0.0, 1.0);
    return floor(fog * 4096.0) / 4096.0;
}
```

The source addon's `view_distance / (far - near)` expression omits the near-plane subtraction. Preserve it only when matching that addon's existing visuals; use the normalized expression above when `near_distance` is intended to mark the start of fog.

Support two modes and label them accurately:

- **Modulation fog:** blend the vertex color toward the fog color, then texture-modulate. This is hardware-plausible but only resembles a conventional fog `lerp` when the fog color is black. Colored modulation fog can become overbright or otherwise look "wrong"; that is authentic to the operation.
- **Silent Hill-style fog:** the authentic technique draws world triangles twice—an untextured fog-color contribution and a textured contribution—using additive semi-transparency. This roughly halves available geometry throughput. A single fragment-shader `mix()` is a cheaper visual approximation, not the original technique.

When the fog factor is a varying in the fragment implementation, subject it to the same affine interpolation compensation as other vertex-derived values when matching the reference shader.

Choose a fog color exactly representable in RGB5:

```glsl
vec3 rgb5_fog_color = round(fog_color * 31.0) / 31.0;
```

This, together with `round()` in `to_rgb5()`, prevents a visually flat fog region from acquiring unnecessary alternating dither shades.

## Pipeline Invariants

Preserve these relationships even if the implementation is reorganized:

- Vertex snapping happens after projection and before rasterization.
- Affine UV compensation multiplies at the vertex and divides after interpolation.
- Vertex lighting and modulation happen before fragment dithering and quantization.
- Dithering uses fragment coordinates and precedes RGB5 quantization.
- RGB5 and dithering operate in sRGB; the final `ALBEDO` is converted to linear for Godot.
- Flat depth is explicitly labeled as a Godot approximation of ordered drawing.
- Opaque and transparent materials share code but remain separate render paths.
- Silent Hill-style single-pass fog is labeled as an approximation if geometry is not actually rendered twice.

## Tunables

| Parameter | Starting point | Tradeoff |
|---|---|---|
| Base viewport | `320 x 240` | Lower values exaggerate pixels and vertex stepping |
| Output scaling | Integer | Crisp pixels with possible letterboxing |
| Texture palette | 16 or 256 colors | Stronger or weaker CLUT-style restriction |
| Dither | Per mesh, hardware eligibility enforced | Authentic control without per-polygon material data |
| Vertex snap | Actual viewport size | Must stay synchronized with render resolution |
| Mesh subdivision | Art-dependent | Reduces affine warping and flat-depth failures; increases geometry |
| Depth modifier | Near zero | Useful for fixed-camera ordering; fragile for moving cameras |
| Active custom lights | Small explicit cap | Hardware fidelity versus game usability |
| Fog factor precision | 12 bit | Small but hardware-informed effect |
| Fog mode | Modulation or Silent Hill approximation | Authentic color behavior versus conventional readability |

## Failure Modes

- **The result is merely pixelated:** affine UVs, screen-coordinate snapping, RGB5, or conditional dithering is missing.
- **Dither appears on every flat surface:** it was applied fullscreen or without the Gouraud/modulation eligibility check.
- **Colors differ between Compatibility and Forward+:** linear and sRGB operations are mixed or performed twice.
- **Textures remain stable at oblique angles:** UVs were not multiplied by vertex `w` before interpolation.
- **Textures explode on large surfaces:** subdivide geometry or reduce grazing camera angles; affine mapping is working but uncontrolled.
- **A floor covers nearby meshes:** this is a flat-depth proxy failure; subdivide first, then apply a small depth modifier.
- **Transparent objects do not blend with each other:** this is the screen-texture/transparent-pass limitation.
- **Lighting gradients look modern and smooth:** Godot's per-fragment lighting is bypassing the custom vertex-color pipeline.
- **Colored modulation fog looks too bright:** modulation is not a conventional color lerp; choose black or use the labeled Silent Hill-style approximation.
- **Flat fog is excessively patterned:** use an RGB5-representable fog color, dither before quantizing, and quantize with `round()`.
- **Batching is worse than expected:** different meshes, materials, transparency paths, shader variants, or instance state can split batches; shared materials do not guarantee one draw call.

## Verification

Verify the running client, not only shader compilation:

1. Confirm the root 3D scene renders at the intended base resolution and scales cleanly at several window sizes.
2. Render an sRGB gradient and compare RGB5 bands with dithering on and off.
3. Confirm a flat unmodulated polygon does not dither while a Gouraud or modulated polygon does.
4. Move the camera slowly and verify vertices step in screen pixels rather than in world-space increments.
5. Rotate a large textured quad to expose affine warping, then subdivide it and confirm the distortion decreases.
6. Overlap intersecting triangles and verify the chosen flat-depth approximation and depth modifiers are understood.
7. Test raw texture mode, half-gray neutral modulation, and the pure-black transparency rule independently.
8. Compare a custom vertex-lit mesh against Godot per-pixel lighting and confirm the light gradient passes through dither and RGB5.
9. Exercise every transparency equation over known background colors, then separately demonstrate the overlapping-transparent limitation.
10. Test black modulation fog, colored modulation fog, and the Silent Hill-style approximation at the near and far planes.
11. Capture the same scene in Compatibility and Forward+ if both are supported; investigate color-space or feature differences rather than assuming parity.

## Confidence

`extracted` — Hardware mechanisms and the Godot techniques are drawn from Calin P's hardware-informed article and MIT reference addon. The skill explicitly identifies modern approximations and known limitations. It has not been verified end to end inside SummerEngine, so do not label a project `summerengine-verified` until the visible client flow and renderer-specific behavior have been tested.
