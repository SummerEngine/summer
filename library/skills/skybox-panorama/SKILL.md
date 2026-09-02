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

This skill generates a single equirectangular panoramic image (2:1 aspect,
e.g. 2048×1024 or 4096×2048) suitable for Summer Engine's
`PanoramaSkyMaterial`. It wires the image into a `Sky` resource on a
`WorldEnvironment` node so the sky is visible from every camera angle.

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
summer_search_assets(query="<vibe> sky panorama", assetType="2d_image", source="all")
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

### 3. Generate, then fix the aspect yourself

Equirectangular MUST be 2:1 (width = 2× height). **`summer_generate_image` cannot give you that.** The tool takes only `prompt`, `model`, `style`, `referenceImageUrl`, and `options` — there is no aspect or size argument, so every MCP image comes back at the server's 1:1 default. `aspectRatio` and `image_size` inside `options` are not recognized and are dropped without an error; the underlying provider does support 2:1-class aspect ratios, but nothing on this surface lets you request one.

```
summer_generate_image(
  prompt="dramatic fantasy sky, golden hour, large purple-orange clouds, distant mountains silhouetted at very bottom, soft god-rays, 360 degree panoramic equirectangular projection, wide 2:1 panoramic framing, seamless horizontal wrap, no visible seam, no foreground objects, sky only. No vertical seam, no ground objects, no horizon-level detail, not distorted or warped, no characters, no buildings.",
  model="nano-banana-2",
  style="realistic"
)
```

Asking for "2:1 panoramic framing" in the prompt biases the composition; it does not change the returned pixel dimensions. So one of these has to happen before the image is usable as a panorama:

- **Generate in the Summer dashboard instead**, which does expose aspect ratio, and bring the 2:1 result back with `summer_import_from_url`. This is the right path when the sky matters.
- **Or crop the 1:1 result to 2:1** in any image editor before importing. You lose the top and bottom, which is usually acceptable for sky-only content — the zenith and nadir are the least informative regions — but it will clip a sun placed high in frame.
- **Or use a Polyhaven HDRI**, already 2:1 and better for realistic exteriors.

Do not import a 1:1 image as a `PanoramaSkyMaterial` panorama and call it done — it wraps with obvious horizontal compression.

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

This is not three tool calls. `summer_set_resource_property` reaches exactly **one** level into a resource — it takes `scenePath`, `nodePath`, `resourceProperty`, `subProperty`, `value`, and there is no `"a:b:c"` colon-path form for walking Environment → Sky → SkyMaterial. Write the `Environment` (with its `Sky` and `PanoramaSkyMaterial` as sub-resources) as a `.tres`, then attach it in one property set:

```
summer_write_file(
  path="res://environments/fantasy_sunset.tres",
  content="<Environment .tres: background_mode = 2 (BG_SKY), sky = Sky with a PanoramaSkyMaterial whose panorama is res://art/sky/fantasy_sunset.png, ambient_light_source = 3 (AMBIENT_SOURCE_SKY) if you want IBL>",
  create_only=true
)

summer_add_node(scenePath="res://main.tscn", parent=".", type="WorldEnvironment", name="WorldEnvironment")
summer_set_prop(scenePath="res://main.tscn", path="./WorldEnvironment", key="environment", value="res://environments/fantasy_sunset.tres")
summer_save_scene(scenePath="res://main.tscn")
```

Every scene-mutating tool takes an explicit `scenePath`; node paths are relative to that scene's root (`./`), not absolute `/root/...` runtime paths.

Note: AI-generated panoramas are LDR (8-bit per channel). For physically-correct IBL with bright suns, the lighting is muted compared to true HDRI. Mention this to the user if they expect strong IBL.

### 7. Verify in scene

```
summer_inspect_node(path="WorldEnvironment")
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
- **Assuming `options.aspectRatio` gave you 2:1.** It is silently ignored — the call succeeds and hands you a square image. A 1:1 or 16:9 panorama wrapped equirectangular has obvious horizontal compression. Crop it, or generate in the dashboard where the control exists.
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
  style="realistic"
)
```

The dashboard is actually the *better* surface for this skill, not just the fallback: it exposes aspect ratio and a real negative prompt, which MCP does not. Tell the user to set 2:1 and a negative of `vertical seam, foreground, distorted, warped, characters, buildings`, then `summer_import_from_url` to `res://art/sky/<name>.png`, set `Repeat: Disabled`, and wire the WorldEnvironment.

If MCP is offline entirely: Polyhaven (`polyhaven.com/hdris`) has hundreds of free CC0 HDRIs ready to drop into `PanoramaSkyMaterial`. Often a better choice than AI for realistic exteriors anyway.

## Handoff

After the sky is wired:

- **Add atmospheric fog matching the sky's mood** → `scene-composition` (fog is on the same Environment resource).
- **Add a directional `DirectionalLight3D` matching the sun position in the panorama** → `3d-lighting` for sun + shadows.
- **Day/night cycle** → re-invoke this skill for the night sky, then write a small tween between the two `panorama` properties.
- **Tileable ground texture for the level floor** → `tileable-texture`.

## See also

- `3d-lighting` — sun, ambient, fog wired alongside the sky.
- `tileable-texture` — ground/floor counterpart.
- `scene-composition` — WorldEnvironment placement and configuration.
- `asset-strategy` — meta-router.
- `../../references/mcp-tools-reference/mcp-tools-reference.md` — `summer_generate_image` schema.
