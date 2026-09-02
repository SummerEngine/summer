---
name: tileable-texture
description: Use when generating a seamless tileable texture for walls, floors, terrain, ceilings — square tile that repeats cleanly on all four edges. Wires onto PlaneMesh / CSGBox3D / MeshInstance3D as a StandardMaterial3D albedo. Trigger on "tileable texture", "seamless texture", "wall texture", "floor texture", "ground texture", "terrain texture", "tiled material".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: 2d-assets
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_generate_image summer_search_assets summer_import_from_url summer_set_resource_property summer_add_node summer_set_prop summer_inspect_node
paths: ["assets/**", "art/textures/**", "materials/**"]
---

# tileable-texture — Seamless Square That Repeats Cleanly

This skill generates a seamless square texture (typically 1024×1024) that tiles cleanly on all four edges with no visible seams. Output goes onto a `PlaneMesh`, `CSGBox3D`, or `MeshInstance3D` as a `StandardMaterial3D` albedo, often with `uv_scale` cranked up so a single tile covers a small area and the surface repeats it across a wall or floor.

The hard part is "seamless." Most diffusion models violate edge continuity by default — generate a brick wall and the bricks stop mid-row at the edge. This skill encodes the prompt suffix and the post-import verification that catches seams before they ship.

## When to use

- "Generate a brick wall texture for this room."
- "I need a grass ground texture for the level."
- "Tileable wood-floor texture, 1024×1024."
- "Stone tile texture for the dungeon."
- "Sand / dirt / metal-panel — seamless."

## When NOT to use

- The user wants a 3D-modeled wall with geometric brick relief → `asset-strategy` (image-to-3D).
- The user wants a unique mural / non-tiling artwork → `concept-art` or `character-portrait`.
- The user wants a skybox / 360° environment → `skybox-panorama`.
- The user wants a normal map / PBR material set — generation today is albedo-only. Normals must be derived (`MaterialMaker`, `NormalMap-Online`) or hand-authored.

## Steps

### 1. Search for an existing texture

```
summer_search_assets(query="<material> tileable", assetType="2d_image", source="all")
```

Texture libraries (AmbientCG, Polyhaven) often have free PBR sets that beat AI generation for realism. If the user wants photorealistic tiling, pause and suggest those.

### 2. Build the prompt — material + the seamless suffix

Pattern:

```
<material description>, seamless tileable texture, top-down view, uniform lighting, no perspective, no shadows, no edges, square format, no specific objects in frame
```

The load-bearing phrases are:

- **`seamless tileable texture`** — primes the model.
- **`top-down view`** — kills perspective convergence (which is the #1 source of visible seams).
- **`uniform lighting`** — kills directional shadows that bake into the tile and stripe across the surface when it repeats.
- **`no perspective, no shadows, no edges`** — explicit negation of common failure modes.
- **`no specific objects in frame`** — kills "interest" features the model adds (a single bright leaf, a chip in one brick) that scream "this is a repeating tile."

### 3. Generate

```
summer_generate_image(
  prompt="weathered red brick wall, seamless tileable texture, top-down view, uniform lighting, no perspective, no shadows, no specific objects, square format, photographic detail. No vanishing point, no directional shadow, no vignette, no single standout feature, no scene context, no sky, no sun.",
  model="nano-banana-2",
  style="realistic"
)
```

Two things about the arguments:

- **There is no `image_size` and no `negative_prompt`.** `summer_generate_image` takes only `prompt`, `model`, `style`, `referenceImageUrl`, and `options`, and `options` only recognizes Nano Banana provider keys (`seed`, `outputFormat`, `safetyTolerance`, `syncMode`, `systemPrompt`, `limitGenerations`, `thinkingLevel`) plus `removeBackground`. Anything else is dropped without an error, so the call looks like it worked. Put the negations in the prompt text. Square is what you get regardless — MCP images come back at the server's 1:1 default, which is exactly what a tileable texture wants.
- **`style: "realistic"` is a no-op.** Only `cartoon` and `anime` append anything to the prompt; `realistic` and `none` append nothing, and any other value is coerced to `none`. The photographic look has to come from the prompt (`photographic detail`). Switching to `"none"` for stylized work likewise changes nothing on its own — change the prompt.

### 4. Import to project

```
summer_import_from_url(url="<fileUrl>", path="res://art/textures/brick_red.png")
```

In the import dock, set:

- `Repeat: Enabled` (REQUIRED for tiling).
- `Filter: Linear with mipmaps` (smoother at distance).
- `Mipmaps: Enabled` (textures viewed at angle need mipmaps).
- `Compress: VRAM Compressed` for ship; `Lossless` while iterating.

### 5. Verify the seam

Before wiring into a scene, view the texture tiled. Quick check: in the editor's filesystem dock, right-click the texture → preview → set repeat 4×4 mentally. Or apply to a `PlaneMesh` with `uv_scale = (4, 4)` and look from above.

If you see a grid of identical "interest features" (a chip, a stain, a bright pixel) repeating, the tile has a hotspot — regenerate with stronger negative on "single feature."

If you see hard horizontal/vertical seams, the edges don't match — regenerate with extra emphasis on `seamless` or run the texture through a seamless-tile filter (Photoshop "Offset" + heal, GIMP "Make Seamless", or Aseprite's Tiled Mode).

### 6. Wire onto geometry

**On a PlaneMesh (floor/ceiling):**

Every scene-mutating tool takes an explicit `scenePath`; node paths are relative to that scene's root (`./`); `summer_set_prop`'s property argument is named `key`; and `summer_set_resource_property` needs all five of `scenePath`, `nodePath`, `resourceProperty`, `subProperty`, `value` (there is no two-argument form and no `"mesh:size"` colon-path form).

Assigning a bare class name to a resource property auto-instantiates it, so the mesh comes first:

```
summer_add_node(scenePath="res://levels/level_01.tscn", parent="./Level", type="MeshInstance3D", name="Floor")
summer_set_prop(scenePath="res://levels/level_01.tscn", path="./Level/Floor", key="mesh", value="PlaneMesh")
summer_set_resource_property(scenePath="res://levels/level_01.tscn", nodePath="./Level/Floor", resourceProperty="mesh", subProperty="size", value="Vector2(20, 20)")
```

Then the material. `material_override` is a `Material`, and `StandardMaterial3D` is the class name that auto-instantiates:

```
summer_set_prop(scenePath="res://levels/level_01.tscn", path="./Level/Floor", key="material_override", value="StandardMaterial3D")
summer_set_resource_property(
  scenePath="res://levels/level_01.tscn",
  nodePath="./Level/Floor",
  resourceProperty="material_override",
  subProperty="albedo_texture",
  value="res://art/textures/brick_red.png"
)
summer_set_resource_property(
  scenePath="res://levels/level_01.tscn",
  nodePath="./Level/Floor",
  resourceProperty="material_override",
  subProperty="uv1_scale",
  value="Vector3(20, 20, 1)"
)
summer_save_scene(scenePath="res://levels/level_01.tscn")
```

`uv1_scale = (20, 20, 1)` on a 20m plane means the texture tiles 20× across — each tile covers 1m².

**On a CSGBox3D (walls):**

```
summer_add_node(scenePath="res://levels/level_01.tscn", parent="./Level", type="CSGBox3D", name="WallNorth")
summer_set_prop(scenePath="res://levels/level_01.tscn", path="./Level/WallNorth", key="size", value="Vector3(10, 3, 0.3)")
```

Then attach the same material with `uv1_scale` tuned to wall dimensions.

## Prompt patterns

| Goal | Prompt that works | Why |
|---|---|---|
| Brick wall | `weathered red brick wall, seamless tileable texture, top-down view, uniform lighting, no perspective, no shadows, no specific objects, square, photographic` | Top-down + uniform lighting kill perspective seams |
| Grass ground | `dense fresh grass, seamless tileable texture, top-down view, uniform lighting, no shadows, no flowers, no patches, square` | "No flowers, no patches" kills hotspot features |
| Wood floor | `oak wood floor planks, seamless tileable, top-down view, uniform lighting, no perspective, no nails, no knots emphasized, square` | "No knots emphasized" kills the ONE bright knot per tile |
| Stone tiles | `cobblestone path, seamless tileable, top-down, uniform lighting, no shadows, no moss patches, square, photographic` | "No moss patches" kills hotspot |
| Metal panel | `industrial metal floor panel, seamless tileable, top-down, uniform lighting, no rust hotspots, no scratches concentrated, square` | Diffuse rust spreads across the tile instead of clumping |
| Sand / dirt | `dry desert sand, seamless tileable, top-down view, uniform soft lighting, no footprints, no rocks, no shadows, square` | Negative space is ideal for tiling |
| Stylized painterly grass | `stylized painterly grass, Studio Ghibli, seamless tileable, top-down, uniform lighting, no specific blades emphasized, square` | The painterly direction has to be in the prompt; no `style` value produces it |
| Sci-fi panel | `sci-fi metal floor panel with subtle glowing seams, seamless tileable, top-down, uniform lighting, square, the glowing seams form a regular grid that aligns with tile edges` | Make the seams part of the design |

### Bad prompts (and why)

| Bad | Failure mode |
|---|---|
| `brick wall` | No "seamless," no "top-down." Returns a 3D-photographed wall with perspective and a corner. Useless for tiling. |
| `seamless brick wall in a dungeon at night` | Scene context bakes shadows and ambience that won't tile. |
| `tileable grass with flowers and rocks` | Hotspot features. Each tile has the SAME flower. Visible repeat. |
| `seamless wood floor (not specifying square / top-down)` | Often returns floor-from-eye-level with perspective. |
| `pbr wood floor texture` | "PBR" implies a material set (albedo + normal + roughness). The model only outputs albedo. Generate albedo, derive maps separately. |

## Anti-patterns

- **Skipping `Repeat: Enabled` on import.** Default is `Repeat: Disabled`. The texture stretches across the whole surface instead of tiling. Looks blurry at distance.
- **Not tuning `uv1_scale`.** Default scale of (1, 1, 1) on a 20m floor means the 1m-real texture is stretched to 20m. Always scale to physical sizing.
- **Hotspot features** that scream "repeated tile." Regenerate with stronger negative on single-feature words.
- **Generating PBR sets with one image.** Diffusion outputs albedo only. For normals/roughness, use a derivation tool or hand-author. Don't claim it's PBR-ready when it's not.
- **Forgetting mipmaps.** Tileable textures viewed at distance need mipmaps; without them, you get shimmering moire.
- **Using textures with directional shadow** baked in. Even subtle shadow stripes when tiled. Always demand "uniform lighting."

## Edge cases

- **User wants normal map / roughness / AO too.** Generation today produces albedo only. Use `Materialize` (free) or `MaterialMaker` (open source) to derive a normal from the albedo. Hand-paint roughness if the surface is heterogeneous (wood = low roughness on knots, high on grain). Set the user's expectation: AI gives albedo; PBR is a follow-up step.
- **Texture must tile in only one direction (e.g., a brick wall that runs horizontally but not vertically).** Generate 1024×1024 seamless, then crop to your actual aspect; the horizontal tile remains seamless. Or: prompt `tileable horizontally only, distinct top and bottom edges` for ceiling-to-floor walls.
- **Texture must read at very low resolution (mobile, distant LOD).** You cannot request a generation size over MCP anyway — take the default and downscale on import (`Compress: VRAM Compressed`, or set a smaller size in the import dock).
- **User wants animated water / lava texture.** Generate a still tileable texture and use a `ShaderMaterial` with UV scrolling to animate. Don't try to generate frames.
- **Visible seam after generation.** Run through GIMP `Filters → Map → Make Seamless` or open in Aseprite, set Tiled mode, paint over the seam manually. AI-generated tileables often need a 5-minute touch-up.

## Fallback (no MCP)

Print the call:

```
summer_generate_image(
  prompt="<material> seamless tileable texture, top-down view, uniform lighting, no perspective, no shadows, no specific objects, square. No directional shadow, no single standout feature, no scene context.",
  model="nano-banana-2",
  style="realistic"
)
```

Tell the user to run via the Summer dashboard, then `summer_import_from_url` to `res://art/textures/<name>.png`, set `Repeat: Enabled`, and tune `uv1_scale` to physical size.

If MCP is offline entirely: AmbientCG and Polyhaven offer free CC0 PBR texture sets that often beat AI for realism. For stylized, hand-author in Aseprite/Krita with tile-mode preview.

## Handoff

After the texture is wired:

- **More textures in the same biome** → re-invoke this skill, hold style/lighting consistent.
- **Apply to a procedurally-built level** → `scene-composition` for CSG and modular wall kits.
- **PBR set with normals/roughness** → out of MCP scope today; user runs derivation in MaterialMaker.
- **Skybox for the level's environment** → `skybox-panorama`.

## See also

- `asset-strategy` — meta-router and 3D pipeline.
- `skybox-panorama` — sky/environment counterpart.
- `scene-composition` — applying textures to CSG and MeshInstance3D.
- `../../references/mcp-tools-reference/mcp-tools-reference.md` — `summer_generate_image` schema.
