---
name: asset-strategy
description: Use when planning asset creation, picking an asset pipeline, or writing image-to-3D prompts — decision guide for whether to generate 3D, search the library, generate AI textures, or use primitives. Includes prompt templates for the AI image-to-3D pipeline. Trigger on "assets", "3D models", "textures", "art pipeline", "make a model", "generate asset".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: asset-pipeline
user-invocable: false
allowed-tools: Read Grep summer_search_assets summer_import_asset summer_generate_image summer_generate_3d summer_generate_audio summer_import_from_url
---

# Asset Strategy for Summer Engine

How to create different types of game assets. Pick the right pipeline for each asset type.

---

## Decision Tree

| Asset type | Pipeline | Why |
|-----------|----------|-----|
| Props (sword, barrel, chair, crate) | Image-to-3D | Best quality for isolated objects |
| Characters (player, NPC, enemy) | Image-to-3D (mannequin ref) | T-pose reference preserves proportions |
| Organic (trees, rocks, mushrooms) | Image-to-3D | Handles complex shapes well |
| Vehicles (car, spaceship, boat) | Image-to-3D | Good for hard-surface objects |
| Walls / floors / ceilings | Texture + BoxMesh/CSGBox | Tiled textures on simple geometry |
| Terrain / ground | Texture + PlaneMesh | Tileable ground textures |
| Buildings / structures | Texture + CSG or modular kit | Combine primitive shapes with textures |
| UI elements / icons / HUD | 2D image only | No 3D conversion needed |
| Sprites (2D games) | 2D image only | Direct use as Sprite2D texture |
| Skyboxes / backgrounds | Panoramic image gen | Environment, not mesh |
| Particles / VFX | Built in engine | GPUParticles3D, no generation |
| Audio / music / SFX | summer_generate_audio | Separate pipeline |

---

## Pipeline 1: Image-to-3D (Props, Characters, Organic)

### How it works

1. A reference template image (mannequin on white bg) is stored server-side
2. nano-banana-2 img2img replaces the mannequin with the desired asset
3. The result is a clean, 3D-ready reference image
4. That image feeds into Hunyuan 3D (default) or Trellis 2 for 3D conversion
5. You get a 3D model back

Available 3D models:
- **hunyuan** (default) — Hunyuan 3D v3.1 Pro, highest quality
- **trellis** — Trellis 2, fast and detailed
- **meshy** — Legacy option

From the CLI, the reference image step is invisible. Just call:

```
summer_generate_3d(prompt="a treasure chest with gold coins")
```

The server generates the reference image and feeds it to 3D automatically.

To pick a specific model:

```
summer_generate_3d(prompt="a treasure chest", model="trellis")
```

For manual control (you want to see/approve the reference image first):

```
summer_generate_image(prompt="a treasure chest with gold coins, game asset, white background, stylized, not ultra realistic")
# Review the image with Read tool
summer_generate_3d(kind="image-to-3d", imageUrl="<fileUrl from above>")
```

### Prompt template for 3D reference images

When generating images intended for 3D conversion, use this suffix:

```
[your asset description]. Game asset, centered in frame, 3D model render style, 
stylized game art, not ultra realistic, clean white background, soft studio 
lighting. Isolated object ready for 3D mesh generation.
```

Examples:

**Weapon:**
```
A medieval broadsword with ornate crossguard and leather-wrapped grip. Game asset, 
centered in frame, 3D model render style, stylized game art, not ultra realistic, 
clean white background, soft studio lighting. Isolated object ready for 3D mesh 
generation.
```

**Character:**
```
A fantasy knight in full plate armor, red cape, detailed pauldrons. T-pose, 
front-facing. Game character asset, 3D model render style, stylized game art, 
not ultra realistic, clean white background, soft studio lighting. Ready for 
3D mesh generation.
```

**Organic prop:**
```
Cluster of bioluminescent mushrooms growing from a small mossy rock base. Pale 
green glow, translucent caps, alien organic shapes. Game asset, centered in frame, 
3D model render style, stylized game art, not ultra realistic, clean white 
background, soft studio lighting. Isolated object ready for 3D mesh generation.
```

**Vehicle:**
```
A rusted sci-fi hover bike with exposed engine parts and worn paint. Game asset, 
centered in frame, 3D model render style, stylized game art, not ultra realistic, 
clean white background, soft studio lighting. Isolated vehicle ready for 3D mesh 
generation.
```

### What makes a BAD 3D reference

Avoid these in prompts:
- Scene context ("sword lying on a table") -- the table becomes part of the mesh
- Strong directional shadows -- baked into the mesh as geometry
- Ultra-realistic rendering -- too much detail for game-ready meshes
- Flat 2D angles (pure front/side view) -- 3D gen needs depth cues
- Multiple objects ("a sword and a shield") -- generates as one fused mesh
- Busy backgrounds -- bleeds into the model

### Polycount guidance

Pass in options when quality matters:

```
summer_generate_3d(prompt="...", options={ target_polycount: 5000 })
```

Rough targets:
- Mobile games: 1k-3k tris
- Indie/stylized PC: 3k-10k tris
- Detailed hero assets: 10k-30k tris
- Cinematics/showcase: 30k-100k tris

Default if not specified: provider decides (usually 10k-30k range).

---

## Pipeline 2: Textures + Geometry (Walls, Floors, Structures)

For flat surfaces and repeating structures, don't generate 3D models. Generate textures and apply them to simple geometry.

### Walls

```
summer_generate_image(prompt="seamless brick wall texture, tileable, game texture, diffuse map")
summer_import_from_url(url="<fileUrl>", path="res://assets/textures/brick_wall.png")
```

Then in the scene:
```
summer_add_node(parent="./Level", type="CSGBox3D", name="Wall")
summer_set_prop(path="./Level/Wall", key="size", value="Vector3(10, 3, 0.3)")
summer_set_prop(path="./Level/Wall", key="position", value="Vector3(0, 1.5, -5)")
```

Attach material with texture via script or manual setup.

### Floors / ground

```
summer_generate_image(prompt="seamless grass ground texture, top-down, tileable, game texture")
```

Apply to PlaneMesh or CSGBox3D scaled flat.

### Modular building kit

For buildings, combine CSG shapes:
- CSGBox3D for walls
- CSGBox3D for floors/ceilings
- CSGCylinder3D for pillars
- CSGPolygon3D for custom shapes

Generate different textures for each material:
- Wall texture (brick, stone, wood)
- Floor texture (tile, wood planks, concrete)
- Roof texture (shingles, metal)

### Texture prompt tips

For tileable textures, always include:
```
[material description], seamless, tileable, game texture, diffuse map, 
top-down view, uniform lighting, no perspective
```

---

## Pipeline 3: 2D Only (UI, Sprites, Icons)

For 2D game assets and UI elements:

```
summer_generate_image(prompt="pixel art heart icon, 64x64, red, game UI element", 
  style="pixel")
```

For sprite sheets, consider the sprite animation tools (separate from this pipeline).

### UI prompt tips

```
[element description], flat design, clean edges, game UI style, 
transparent background preferred, [size]px
```

---

## Pipeline 4: Audio

Separate from visual assets. See summer_generate_audio tool:

```
summer_generate_audio(capability="sound_effects", text="metal sword clash impact")
summer_generate_audio(capability="music", prompt="ambient fantasy forest theme", durationSeconds=60)
summer_generate_audio(capability="text_to_speech", text="You shall not pass!", voiceId="<id>")
```

---

## Edge Cases (add to this list as they come up)

- **Transparent/glass objects**: Add "translucent material, see-through" to prompt. 3D gen may struggle -- consider using engine materials instead.
- **Animated objects**: Generate static mesh first, animate in engine with AnimationPlayer.
- **Multi-part objects**: Generate each part separately, assemble in scene tree.
- **Extremely thin objects** (paper, cloth, flags): 3D gen produces thick meshes. Better to use MeshInstance3D with a plane + texture + shader.
- **Emissive/glowing objects**: Generate the mesh, add emissive material in engine. Don't rely on the glow being in the mesh.
- **LOD (Level of Detail)**: Generate one version. If perf needs LOD, use Godot's LOD system or generate a second low-poly version.

## Fallback

No fallback for this — Summer MCP required for the generation pipelines (`summer_generate_image`, `summer_generate_3d`, `summer_generate_audio`, `summer_search_assets`, `summer_import_from_url`). If MCP isn't connected, the user must source assets externally (Sketchfab, Quaternius, Kenney, AmbientCG) and import via Godot's import system.

## Collaborative protocol

This skill triggers metered generation (image / 3D / audio) and mutates the scene with imported assets. Always ask before generating ("May I generate a 3D treasure chest via image-to-3D? This is one metered generation.") and before importing ("May I import the result to `res://assets/models/chest.glb`?"). See `../../_shared/collaborative-protocol.md`.
