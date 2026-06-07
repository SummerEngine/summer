---
name: skybox-panorama
description: Use when generating a 360° panoramic sky image for use as a Sky resource (PanoramaSkyMaterial) in a 3D scene. Equirectangular projection, 2:1 aspect. Wires into WorldEnvironment.sky. Trigger on "skybox", "sky panorama", "360 background", "environment sky", "HDRI sky", "panoramic background", "panorama sky".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: 2d-assets
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_generate_image summer_search_assets summer_import_from_url summer_set_resource_property summer_add_node summer_set_prop summer_inspect_node
paths: ["assets/**", "art/sky/**", "environments/**"]
---

# skybox-panorama — 360° Sky for WorldEnvironment

This skill generates a single equirectangular panoramic image (2:1 aspect, e.g. 2048×1024 or 4096×2048) suitable for Godot's `PanoramaSkyMaterial`. Wires it into a `Sky` resource on a `WorldEnvironment` node so the sky is visible from every camera angle in your 3D scene.

The single biggest failure mode is **non-equirectangular output**. Diffusion models default to flat 2D scenes; if you don't explicitly demand "equirectangular projection," the result looks fine in a thumbnail but distorts brutally when wrapped onto a sphere — horizon bows, zenith pinches, the sun stretches into a smear. This skill encodes the prompt suffix and the import discipline that produces a usable sky on the first or second try.

## When to use

- "Generate a fantasy sky for the level."
- "I need a sci-fi nebula skybox."
- "Make a sunset panorama for the desert scene."
- "Stormy night sky for the haunted level."
- The 3D scene needs a visible sky (not just a flat color background).

## When NOT to use

- The user wants a 2D parallax background → that's a separate `Sprite2D` job, not a panorama.
- The user wants a HDRI for environment lighting (not just visual sky) → AI panoramas are LDR by default. For real IBL/HDR, use Polyhaven HDRIs (free CC0). Mention this to the user if lighting realism matters.
- The user wants a 3D-modeled sky-dome with geometry (clouds-as-meshes) → out of scope; use a `Sphere` mesh + custom shader.
- The scene is 2D → no sky needed.

## Steps

### 1. Search for an existing sky

```
summer_search_assets(query="<vibe> sky panorama", filter={ kind: "image" })
```

Polyhaven (`polyhaven.com/hdris`) hosts hundreds of free CC0 HDRIs that beat AI generation for realism and provide IBL data. For realistic exterior scenes, prefer Polyhaven; for stylized / fantasy / sci-fi, AI generation wins.

### 2. Build the prompt — sky description + equirectangular suffix

Pattern:

```
<sky description>, 360 degree panoramic equirectangular projection, seamless horizontal wrap, no visible seam at left and right edges, distortion-correct for sphere mapping, no foreground objects, no ground horizon line, sky and clouds and atmosphere only
```

Load-bearing phrases:

- **`360 degree panoramic equirectangular projection`** — primes the model for the right format.
- **`seamless horizontal wrap, no visible seam at left and right edges`** — the left and right edges of the image meet when wrapped. If they don't match, you see a vertical seam in the sky.
- **`no foreground objects, no ground horizon line`** — skies show only sky. If you include a horizon, it warps weirdly when sphere-mapped and kills the illusion that the sky is at infinite distance.
- **`distortion-correct for sphere mapping`** — reminds the model that the top/bottom of the image map to the zenith/nadir.

### 3. Generate at 2:1 aspect

```
summer_generate_image(
  prompt="dramatic fantasy sky, golden hour, large purple-orange clouds, distant mountains silhouetted at very bottom, soft god-rays, 360 degree panoramic equirectangular projection, seamless horizontal wrap, no visible seam, no foreground objects, sky only",
  model="nano-banana-2",
  style="realistic",
  options={
    aspectRatio: "2:1",
    image_size: "landscape_16_9",
    negative_prompt: "vertical seam, ground objects, horizon-level details, distorted, warped, characters, buildings"
  }
)
```

`aspectRatio: "2:1"` is critical. Equirectangular MUST be 2:1 (width = 2× height). If the model returns 16:9 or 4:3, the wrap will be wrong.

### 4. Verify the seam and projection

Before wiring, inspect:

- **Left edge ↔ right edge:** mentally place them side-by-side. They should match continuously. If there's a cloud cut in half on the left and a different cloud on the right, regenerate with stronger emphasis on `seamless horizontal wrap`.
- **Top stretching:** the top 10% of the image stretches enormously when mapped to the zenith. If there are tight features (a sun, a cloud edge) high up, they'll smear. Generations with diffuse, soft top regions wrap better than crisp ones.
- **Bottom:** same applies to the nadir. Most skies don't show much bottom anyway since the camera sits below the horizon — but avoid generating tight features at the very bottom.

If the image fails seam check, regenerate. Some models support `seed` for variation while keeping prompt — bump the seed.

### 5. Import to project

```
summer_import_from_url(url="<fileUrl>", path="res://art/sky/fantasy_sunset.png")
```

In the import dock:

- `Repeat: Disabled` (panoramas don't tile — they wrap once via the material).
- `Filter: Linear with mipmaps` (smoother as the camera turns).
- `Mipmaps: Enabled`.
- `Compress: VRAM Compressed` for ship.

### 6. Wire into WorldEnvironment (3 lines)

```
summer_add_node(parentPath="/root/Game", type="WorldEnvironment", name="WorldEnvironment")

summer_set_resource_property(
  nodePath="/root/Game/WorldEnvironment",
  resourceProperty="environment:background_mode",
  value=2  # BG_SKY
)

summer_set_resource_property(
  nodePath="/root/Game/WorldEnvironment",
  resourceProperty="environment:sky:sky_material",
  value="<new PanoramaSkyMaterial with panorama: res://art/sky/fantasy_sunset.png>"
)
```

Then, if the user wants the sky to also light the scene (image-based lighting):

```
summer_set_resource_property(
  nodePath="/root/Game/WorldEnvironment",
  resourceProperty="environment:ambient_light_source",
  value=3  # AMBIENT_SOURCE_SKY
)
```

Note: AI-generated panoramas are LDR (8-bit per channel). For physically-correct IBL with bright suns, the lighting is muted compared to true HDRI. Mention this to the user if they expect strong IBL.

### 7. Verify in scene

```
summer_inspect_node(path="/root/Game/WorldEnvironment")
```

Then `summer_play` and look around. Sun in the right place? Seam invisible? Top/bottom okay?

## Prompt patterns

| Goal | Prompt that works | Why |
|---|---|---|
| Fantasy sunset | `dramatic fantasy sky at golden hour, large purple and orange clouds, soft god-rays, distant mountain silhouettes at very bottom only, 360 degree panoramic equirectangular projection, seamless horizontal wrap, no visible seam, no foreground, sky only` | Soft top, distant horizon = clean wrap |
| Sci-fi space nebula | `vast space nebula, deep blue and magenta gas clouds, scattered bright stars, distant galaxy disc, 360 degree panoramic equirectangular projection, seamless horizontal wrap, no visible seam, no foreground objects, no ground` | Space skies wrap easily; no horizon issues |
| Stormy night | `dark stormy night sky, heavy rolling clouds, distant lightning flashes, full moon partly obscured, 360 degree panoramic equirectangular, seamless wrap, no foreground` | Diffuse cloud structure tolerates wrapping well |
| Clear blue day | `bright clear blue sky with scattered cumulus clouds, midday sun upper left, 360 degree panoramic equirectangular projection, seamless horizontal wrap, no visible seam, no ground` | Tight sun feature warps; place sun off-center |
| Alien planet sky | `alien planet sky, two suns one large red one small white, swirling green-purple atmosphere, distant ringed planet at horizon, 360 panoramic equirectangular, seamless wrap, no foreground` | Multi-sun setups wrap if features stay diffuse |
| Underwater (caustic dome) | `underwater scene seen from below, sun rays piercing water surface, deep blue gradient downward to black, 360 panoramic equirectangular, seamless wrap` | Treat ocean surface as the "sky"; works for underwater levels |
| Stylized painterly sky | `Studio Ghibli painterly sky, soft cumulus clouds at sunset, warm pastel palette, 360 panoramic equirectangular, seamless wrap, no foreground` (style: "none") | Style preset would fight painterly |

### Bad prompts (and why)

| Bad | Failure mode |
|---|---|
| `beautiful sky` | No equirectangular suffix. Returns flat 16:9 photograph. Wrap looks broken. |
| `sky with mountains and trees and a castle` | Foreground objects. Horizon-level details warp catastrophically when sphere-mapped. |
| `360 sky` (without 2:1 aspect) | Aspect mismatch. Wrap is misaligned. |
| `panoramic sky in 4k` | "4k" implies 3840×2160 (16:9), not 2:1. Specify aspect. |
| `sky with the sun in the center top` | Sun at zenith stretches into a smear. Place sun off-axis. |

## Anti-patterns

- **Including foreground or horizon.** Mountains, trees, buildings at horizon level warp weirdly when sphere-mapped (the "swimming horizon" effect). Skies show ONLY sky. If the level needs distant mountains, model them as low-poly meshes in the scene, not in the sky texture.
- **Not specifying 2:1 aspect.** A 16:9 panorama wrapped equirectangular has obvious horizontal compression. Always `aspectRatio: "2:1"`.
- **Tight features at zenith/nadir.** Anything in the top or bottom 10% of the image gets pinched. Bias toward soft, diffuse features there.
- **Expecting HDR / IBL quality.** AI panoramas are 8-bit. If the user needs realistic environment lighting from the sky, point them at Polyhaven HDRIs (CC0). AI is for visual sky, not for lighting.
- **Forgetting `Repeat: Disabled` on import.** Panoramas wrap once via the material; if `Repeat` is on, you can get duplicate-tile artifacts at the seam.
- **Visible vertical seam on the wrap.** If left/right edges don't match, regenerate with seed bump or fix the seam in Photoshop/GIMP via the offset trick (offset by 50% horizontally → heal the new visible seam → offset back).

## Edge cases

- **Animated sky (clouds drift).** AI gives one frame. Animate via shader (UV scroll on the panorama texture) or layer two panoramas with `ProceduralSkyMaterial` for the base + a transparent cloud layer.
- **Day/night cycle.** Generate two panoramas (day + night). Cross-fade the `sky_material` via shader blend or by swapping `panorama` over a tween. Two LDR panoramas + a blend = serviceable cycle.
- **First-person VR.** AI panoramas at 2048×1024 are too low-res for VR (visible pixels). Generate at 4096×2048 if the model supports it; otherwise use Polyhaven HDRIs at 8K.
- **Indoor scene.** Skyboxes are wasted indoors — use `BG_COLOR` or a flat black background. Don't generate a sky for a windowless dungeon.
- **Visible vertical seam after generation.** Fix in Photoshop/GIMP: `Filter → Other → Offset` by 50% horizontally → the seam moves to the center → heal with content-aware fill or clone stamp → offset back to 0. Or regenerate with seed bump and `seamless horizontal wrap, no visible seam at left and right edges` repeated twice in the prompt.

## Fallback (no MCP)

Print the call:

```
summer_generate_image(
  prompt="<sky> 360 degree panoramic equirectangular projection, seamless horizontal wrap, no visible seam, no foreground objects, sky only",
  model="nano-banana-2",
  style="realistic",
  options={ aspectRatio: "2:1", negative_prompt: "vertical seam, foreground, distorted, warped, characters, buildings" }
)
```

User runs via Summer dashboard, then `summer_import_from_url` to `res://art/sky/<name>.png`, sets `Repeat: Disabled`, and wires the WorldEnvironment manually.

If MCP is offline entirely: Polyhaven (`polyhaven.com/hdris`) has hundreds of free CC0 HDRIs ready to drop into `PanoramaSkyMaterial`. Often a better choice than AI for realistic exteriors anyway.

## Handoff

After the sky is wired:

- **Add atmospheric fog matching the sky's mood** → `summer:scene-composition` (fog is on the same Environment resource).
- **Add a directional `DirectionalLight3D` matching the sun position in the panorama** → `summer:3d-lighting` for sun + shadows.
- **Day/night cycle** → re-invoke this skill for the night sky, then write a small tween between the two `panorama` properties.
- **Tileable ground texture for the level floor** → `summer:2d-assets/tileable-texture`.

## See also

- `summer:3d-lighting` — sun, ambient, fog wired alongside the sky.
- `summer:2d-assets/tileable-texture` — ground/floor counterpart.
- `summer:scene-composition` — WorldEnvironment placement and configuration.
- `summer:asset-pipeline/asset-strategy` — meta-router.
- `references/mcp-tools-reference.md` — `summer_generate_image` schema.
