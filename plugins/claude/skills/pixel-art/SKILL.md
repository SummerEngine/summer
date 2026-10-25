---
name: pixel-art
description: "Generate pixel-art sprites, items, tiles and portraits at a set resolution with a limited palette."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: 2d-assets
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_assets_generate_image summer_assets_search summer_import_from_url summer_set_resource_property summer_call
paths: ["assets/**", "art/pixel/**", "sprites/**"]
---

# pixel-art — Pixel-Perfect Sprites and Tiles

This skill generates pixel-art sprites, items, tiles, icons and portraits at a target resolution (32×32, 64×64, 128×128). Pixel art has hard constraints (grid alignment, limited palette, no anti-aliased edges) that diffusion models break by default. The prompt patterns and post-processing below make the output read as pixel art instead of a blurry small image.

**Backing operation:** `assets.generate_image` with an explicit pixel-art prompt.

Two things about that operation you have to know before writing a call:

- **There is no `"pixel"` style preset.** `style` accepts exactly `realistic`, `cartoon`, `anime`, `none`; anything else is coerced to `none`. Only `cartoon` and `anime` do anything at all (they append a short suffix); `realistic` and `none` append nothing. So `style: "pixel"` is identical to `style: "none"` — the pixel look has to come entirely from the prompt. Use `style: "none"`.
- **There is no `options` object and no negative prompt.** Shape is `aspectRatio` (`1:1` default, right for sprites and tiles), a minimum size is `width` + `height`, and `seed` repeats a look on Nano Banana models. Exclusions go in the prompt text. The model renders far above the pixel grid either way; the target resolution comes from the downscale below.

Pixel-perfect output is enforced in Summer Engine with Nearest texture filtering
and by downscaling to the target resolution after generation.

## When to use

- "Generate a 32×32 sword icon for the inventory."
- "I need a pixel-art portrait of the merchant for the dialogue UI."
- "Make a 64×64 enemy sprite — a slime monster."
- "Generate a tileset for a grass / dirt / stone biome at 16×16 per tile."
- The game has a pixel-art aesthetic and the user wants assets in-style.

## When NOT to use

- The user wants a high-resolution painterly portrait → `character-portrait`.
- The user wants animated frames (walk cycle, attack) → `sprite-sheet` (pixel art is harder for sprite sheets — read that skill's caveats).
- The user wants a tileable seamless texture (not pixel art) → `tileable-texture`.
- The game is 3D / non-pixel — verify the user actually wants pixel before generating.

## Steps

### 1. Lock the resolution and palette

Ask the user (or read `.summer/GameSoul.md`):

- **Resolution per asset:** 16×16, 32×32, 64×64, 128×128 are standard. Sprites usually 32 or 64; portraits 64 or 128; icons 16 or 32.
- **Palette:** named retro palette (NES 56-color, Game Boy 4-color green, PICO-8 16-color, Sweetie-16) OR custom hex list OR "no palette restriction."
- **Outline:** hard black outline, colored outline, or no outline?

Write to `.summer/pixel-anchor.md` so the rest of the cast/tileset stays consistent:

```
## Pixel anchor

base resolution: 32x32 per sprite
palette: PICO-8 16-color
outline: hard 1px dark outline (NOT pure black — use the palette's darkest color)
shading: 3-tone (light, mid, shadow), no gradients, no AA
```

### 2. Search for existing assets

```
assets.search({ query: "<subject> pixel", assetType: "2d_image", scope: "all" })
```

### 3. Build the prompt

Pattern:

```
pixel art <subject>, <resolution>, <palette>, <outline rule>, <shading rule>, no anti-aliasing, no blur, sharp pixel edges, transparent background
```

The model can't actually generate at 32×32 — it generates at 1024×1024 with pixel-art *style*. You then downscale to the target resolution post-import for crisp pixels.

### 4. Generate

```
assets.generate_image({
  prompt: "pixel art slime monster, 32x32 sprite, PICO-8 palette, hard 1px outline in palette's darkest color, 3-tone shading, no anti-aliasing, no blur, sharp pixel edges, front-facing. Not blurry, no smooth gradients, no soft edges, not photorealistic, no 3D render.",
  model: "nano-banana-2",
  style: "none",
  removeBackground: true
})
```

Two deliberate choices there:

- **The negations live in the prompt.** There is no `negative_prompt` argument. Diffusion models honor in-prompt negations less reliably than a real negative-prompt field, so state them as plain sentences at the end and expect to regenerate more often than you would on a provider UI that exposes the field.
- **`removeBackground: true` is its own argument.** It runs a background-removal pass after generation and returns a PNG with true alpha. Prefer it over asking for "transparent background" in the prompt, which makes models paint a literal checkerboard.

### 5. Downscale to target resolution

The generated image is 1024×1024 pixel-style. To get true crisp pixels at 32×32:

- Import to the engine, then in the import dock set `Filter: Nearest` (no smoothing).
- For a true 32×32 atlas/icon, downscale in an external editor (Aseprite, GIMP "nearest neighbor") to 32×32 before importing. Aseprite's "Sprite > Sprite Size" with Nearest gives the cleanest result.
- In Summer Engine, set `Project Settings → Rendering → Textures → Default
  Texture Filter: Nearest` if the entire game is pixel art. This disables
  bilinear smoothing project-wide.

### 6. Import and wire

```
summer_import_from_url(url="<fileUrl>", path="res://sprites/slime.png")
```

For a `Sprite2D`:

```
summer_set_prop(
  scenePath="res://main.tscn",
  path="./Slime/Sprite2D",
  key="texture",
  value="res://sprites/slime.png"
)
```

`texture` is a property **on the node**, so it is `summer_set_prop`. `summer_set_resource_property` is for reaching *inside* a resource the node already holds (mesh size, material albedo) and needs all five of `scenePath`, `nodePath`, `resourceProperty`, `subProperty`, `value` — there is no two-argument form.

Confirm `Filter: Nearest` is set in the import dock OR project-wide.

## Prompt patterns

| Goal | Prompt that works | Why |
|---|---|---|
| Item icon (32×32) | `pixel art iron sword icon, 32x32, NES palette, hard outline, 3-tone shading, no AA, sharp edges, transparent background, three-quarter view` | Three-quarter view reads better than pure side at 32px |
| Character sprite (64×64) | `pixel art knight character sprite, 64x64, PICO-8 palette, hard 1px outline, 3-tone shading, front-facing idle pose, no AA, sharp edges, transparent background` | Specifying "idle pose" prevents action poses that don't tile into a sheet |
| Pixel portrait (128×128) | `pixel art portrait of a young witch, 128x128, custom muted fantasy palette, hard outline, 4-tone shading, bust framing, looking forward, no AA, no blur, transparent background` | Higher resolution allows 4-tone shading; 32px is too small for that |
| Tileset (16×16/tile) | `pixel art top-down tileset, grass-to-dirt transition, 16x16 per tile, 3x3 grid layout, NES palette, hard outline between tiles, 3-tone shading, no AA, sharp edges` | Tilesets render best in a labeled grid layout |
| Background object (64×64) | `pixel art mossy boulder, 64x64, fantasy palette, hard outline, 3-tone shading, no AA, transparent background, three-quarter view` | Background props benefit from three-quarter for depth |
| GB-style asset (Game Boy) | `pixel art skeleton enemy, 32x32, Game Boy 4-color green palette (#0f380f, #306230, #8bac0f, #9bbc0f), hard 1px outline, 2-tone shading, no AA` | Naming the 4 hex codes locks the palette |

### Bad prompts (and why)

| Bad | Failure mode |
|---|---|
| `8-bit sword` | "8-bit" is interpreted loosely. Returns a smooth render of a sword with vague pixel feel. Specify resolution + palette + "no AA" explicitly. |
| `pixel art knight, photorealistic` | Conflicting directives. Model averages and gives you neither. |
| `pixel art at 32x32` with no negations | Model adds soft edges and gradient shading. Always spell out "no anti-aliasing, no blur, no smooth gradients" in the prompt itself — there is no negative-prompt argument to fall back on. |
| `pixel sprite walk cycle` | Walk cycles need consistent frames — single-prompt sprite sheets fail. Route to `sprite-sheet`. |
| `cute pixel art` | "Cute" without subject is undefined. Specify what. |

## Anti-patterns

- **Skipping the downscale.** The model returns a 1024×1024 pixel-style image. If you import that as a 1024 texture, the "pixels" are actually 32-pixel blocks of soft color. Downscale to true target resolution OR set `Filter: Nearest` so the up-rendering doesn't smooth.
- **No `Filter: Nearest`.** The default texture filtering is bilinear. Set
  Nearest on import or project-wide for pixel art.
- **Reaching for `negative_prompt` or `image_size`.** Neither exists on `assets.generate_image`, and a field it does not list does nothing, so the call looks like it worked and the output is off-style. Negations go in the prompt text; shape is `aspectRatio`, a minimum size `width` + `height`.
- **Inconsistent palette across the cast.** Pick a named palette (PICO-8, NES, custom hex list) and re-use across every asset in the project. Different palettes = the project doesn't read as one game.
- **Generating walk-cycle frames as one image.** Sprite sheets via single-prompt are unreliable. Route to `sprite-sheet`.

## Edge cases

- **User wants animated pixel sprites.** Generate base sprite here, then per-frame variants via img2img with the base as `referenceImageUrl`. For more than 2-3 frames, route to `sprite-sheet` (and read its caveats).
- **User wants the entire game in pixel art.** Set `Project Settings → Rendering → Textures → Default Texture Filter: Nearest` once. Saves you from re-setting it on every import.
- **User wants a high-res "pixel art" portrait that's not actually pixelated** (faux-pixel-aesthetic at full resolution). That's `character-portrait` with a "pixel art aesthetic" prompt — not this skill.
- **User specifies a palette like "Sweetie-16" or "Endesga-32" and the model ignores it.** Name the hex codes explicitly. Palette names alone are unreliable below the top 5-10 famous ones.
- **Tilesets need to tile cleanly.** Pixel-art tile-edge cleanliness from raw generation is poor. Generate the tile grid, then fix edge seams by hand in Aseprite.

## Without Summer Engine

In a session without Summer Engine tools (the assets profile; the `summer-assets` skill has the whole loop), do steps 1-5 and skip step 6 (import and wiring). In step 5, downscale with nearest-neighbour in an image editor; the engine settings there do not apply. Pass `out` with the person's folder so the PNG lands there (the `summer-assets` skill says how), and tell them to turn texture filtering off in their engine.

## Fallback (no MCP)

Print the call:

```
assets.generate_image({
  prompt: "<pixel art prompt with full anchor>. Not blurry, no smooth gradients, no anti-aliasing.",
  model: "nano-banana-2",
  style: "none",
  removeBackground: true
})
```

The Summer dashboard also exposes a negative-prompt control — if the user is running it there, tell them to set square + a real negative prompt.

Tell the user to run via the Summer dashboard, downscale in Aseprite/GIMP to true target resolution with nearest-neighbor, then `summer_import_from_url` (or drop into `res://sprites/`) and set `Filter: Nearest`.

If MCP is offline entirely: open Aseprite or Piskel and hand-author the asset. For pixel art at small resolutions, hand-authoring is often faster than fixing a generation.

## Handoff

After the asset is wired:

- **More assets in the same style** → re-invoke this skill, re-use the pixel anchor.
- **Animation frames for the sprite** → `sprite-sheet` with the base sprite as anchor.
- **Pixel UI** → re-invoke with UI subjects (icons, button frames) at appropriate resolution.
- **Tilemap setup** → `scene-composition` for `TileMap` / `TileMapLayer` wiring.

## See also

- `sprite-sheet` — animated pixel frames.
- `character-portrait` — high-res counterpart.
- `asset-strategy` — meta-router.
- `summer_docs_read` id `reference/mcp-tools-reference` — how to call `assets.generate_image`.

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@4.9.0` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `assets.generate_image`, `summer_assets_generate_image` | `summer assets generate-image` |
| `summer_assets_search` | `summer assets search` |
| `summer_docs_read` | `summer docs read` |
| `summer_import_from_url` | `summer engine import-from-url` |
| `summer_set_prop` | `summer engine set-prop` |
| `summer_set_resource_property` | `summer engine set-resource-property` |
<!-- /shell-commands -->
