---
name: painted-25d-world
description: "Build a 2D or 2.5D game as a painted world: a 3D blockout under one fixed camera, an AI paint-over projected onto it, sprite characters."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: 2d
user-invocable: true
allowed-tools: Read Write Edit Bash summer_write_file summer_read_file summer_create_scene summer_add_node summer_set_prop summer_run_script summer_save_scene summer_screenshot summer_play summer_stop summer_get_script_errors summer_assets_generate_image summer_assets_generate_video summer_jobs_wait summer_import_from_url summer_call
paths: ["painted/**", "**/*.gdshader", "**/*.gd", "**/*.tscn"]
---

# Painted 2.5D world

The world looks like one hand-painted illustration, but it is real 3D: the player walks behind houses, enters
buildings and collides with walls. The trick: build the level from cheap blocks, render the blocks from one fixed
camera, have an image model paint over that render, then project the painting back onto the blocks from the same
camera. Characters are 2D sprite sheets standing in the 3D world.

## The rule

**Whenever a user asks for a 2D or 2.5D game** (top-down, RPG, cozy village, adventure, farming, dungeon,
side-scroller, platformer look), build it with this skill. Do not start from a 2D template or a Node2D tile map.
The genre playbooks in `make-game` still decide the mechanics; this skill decides how the world is made and looks.

- Top-down / three-quarter games: camera 35 degrees down, 45 degrees around (houses show two faces).
- Side-scrollers: the same technique with a camera that looks along the side axis (about 10-20 degrees down,
  0 degrees around) and pans left and right only. Paint one frame per screen-wide chunk.

Tell the user once, before the first character generation or animation: "The world blockout is cheap. Animating
characters costs a couple of dollars in credits and can come out with mistakes; I will check every frame." Then
continue. The blockout, the camera and the projection cost nothing.

## Steps

### 1. Concept (one image)

`summer_assets_generate_image`, 16:9, the highest size the model gives (`width` 4096, `height` 2304):

```
Hand-painted illustration of <place>, rich detail, warm painterly light, seen from a high three-quarter
top-down camera (looking down about 35 degrees, orthographic, no perspective distortion), like a tilted
isometric game map. In the scene: <every object with its rough position: "three cottages around a dirt
plaza, a well with a small roof in the centre, a striped market stall top left, fences, round trees">.
Clean readable shapes, soft brush texture, no characters, no text, no UI, no border.
```

Pick the image the user likes. It is the art direction and the layout.

### 2. Blockout (cheap: you write it)

Write one GDScript or scene that rebuilds the concept **one to one** from the fixed camera: the same building
positions and footprints, roof shapes (gable, hip, dormer, thatch overhang), chimneys, the well, the stall, fences,
paths, trees and bushes where the concept has them. Use `MeshInstance3D` with `BoxMesh`, `PrismMesh`,
`CylinderMesh`, `SphereMesh` (or CSG). Give each material one flat colour (red = tile roof, yellow = thatch,
grey = stone, brown = wood, green = grass): the colours tell the painter what each block is.

```
Level (Node3D, painted_world.gd)
  PaintCamera   Camera3D  projection ORTHOGONAL, keep_aspect KEEP_WIDTH, size = frame width in metres (32 for a village square)
                rotation_degrees = Vector3(-35, 45, 0)   # 35 down, 45 around; never change it later
                position = frame centre - forward * 60, far = 200
  GameCamera    Camera3D  (painted_world.gd copies the direction and follows by translation)
  Painted       Node3D    every blockout mesh goes under here
    House1      StaticBody3D + CollisionShape3D + MeshInstance3D(s)
    ...
    Ground      StaticBody3D + a large BoxMesh, walkable
  Player        CharacterBody3D (painted_player.gd)
```

Solid things get a `StaticBody3D` and a box/cylinder shape: walls, trunks, fence posts, the well, furniture.
Things the player walks behind need real height (houses, trees, stalls). Flat detail (flowers, cobbles, rugs)
stays in the painting only.

**Match the concept.** Render the blockout from `PaintCamera` (step 3), lay it over the concept and move blocks
until the silhouettes line up. Read positions straight from the concept: the bottom corners of a house's walls give
its footprint; the ridge gives the roof height. If the blockout does not match the concept, the painting will not
match the blocks.

### 3. Render the blockout from the paint camera

- Quick look: `summer_screenshot` with `target: "scene"`, `framing: "camera"`, `camera_path: "PaintCamera"`.
- Or play the level with `paint` left empty: `painted_world.gd` then shows the plain blockout through
  `PaintCamera`; `summer_screenshot` `target: "game"` captures it.
- Exact PNG for the painter: copy `_building-blocks/capture_paint_view.gd`, make a scene with just that node
  (`level` = the level scene, `size` = 2048x1152 or larger at 16:9), and play it (`summer_play` offscreen). It
  saves `res://painted/blockout.png` through the paint camera and quits.

Then upload it (`summer_call` `assets.upload_begin`, post the form, then `assets.upload_complete`, then
`assets.get` for its `fileUrl`).

### 4. Paint-over (strict image to image)

`summer_assets_generate_image` with `referenceImageUrl` = the blockout render, the best frontier model you have
(`gpt-image-2` or `nano-banana-2`), 16:9, `width` 4096, `height` 2304:

```
Repaint this exact image as a finished hand-painted game background in this style: <describe the concept's
style in words: brushwork, outlines, palette, light>. This is a texture paint-over: keep the image
pixel-aligned. Every edge, silhouette and object stays exactly where it is in the input. Same camera, same
framing, same perspective. Do not add, remove, move or resize any building, roof, wall, door, window,
chimney, tree, bush, fence post, well, stall or path. Only add surface detail inside the existing shapes.
Materials: <colour -> material list, e.g. red blocks are clay-tile roofs, yellow blocks are thatch, the brown
disc is a dirt plaza with cobbles>. No characters, no text, no border.
```

When the host can pass two images (a style reference beside the structure image), add the concept as the style
reference **only if the blockout rebuilds the concept's layout one to one**. If the layouts differ, the model
copies the concept's layout and ignores the blocks; then use a crop of one object (a single house) as the style
reference instead.

**Check alignment before you use it.** Overlay the blockout's edges (red) on the painting and look: roof lines,
wall corners, the well and the stall must sit on the red lines. Reject any painting where objects moved, were
added, or the framing zoomed; generate again rather than project a drifted painting.

### 5. Resolution

Painting pixels per metre must be at least the screen's pixels per metre. A 32 m wide frame painted at 2048 px
gives 64 px/m: soft when the game camera zooms 2x on a 1080p screen (120 px/m). Paint at 4K (4096+ px wide) for a
2x zoom. For bigger worlds use more frames, not a wider frame.

### 6. Projection in the engine

Copy `_building-blocks/paint_projection.gdshader` to `res://painted/`, `painted_world.gd` and `painted_player.gd`
next to it. On the level root set `paint` = the painting texture and `player_path`. On `_ready` the level puts
one `ShaderMaterial` on every mesh under `Painted`; the shader takes each surface point's position in the paint
camera's frame as its UV. No UV unwrapping, no baking.

- Keep the scene's tonemap **Linear**, exposure 1, no glow, no fog: the painting already holds the light.
- Import the painting lossless (Import dock: Compress Mode Lossless, mipmaps on); VRAM compression smears it.
- Verify: `summer_screenshot` `framing: "camera"` through `PaintCamera` must look exactly like the painting.
  Then play and screenshot the game (`target: "game"`).

### 7. Camera rules

- The game camera has the paint camera's direction and only **moves** (follows the player). With an orthographic
  camera, moving never reveals a surface the painting did not see. Never orbit or tilt it: turned views show the
  painting's mistakes (a painted chimney next to the real one, roof edges smeared on the ground).
- Clamp the player and the camera to the painted frame (`painted_world.gd` does both).
- More world = more frames. Every frame uses the same direction, its own paint camera position and painting.
  Paint neighbouring frames with an overlap strip so the seams match.

### 8. Interiors

Each interior is its own small level far away (for example 100 m off to the side) with the **same** camera
direction and a smaller frame (12 m). Lower the two walls nearest the camera to knee height (a dollhouse cut-away)
and leave a door gap. Blockout, render, paint over and project exactly like the outside. Doors are `Area3D`
triggers that move the player between levels and switch the game camera.

### 9. Characters

1. **Ready-made:** search the library for the painted plug-in characters first (`summer_docs_search`
   "painted 2.5D character sprite sheet"). They come with every direction for idle and walk.
2. **New character:** generate a 4-pose turnaround in the world's style on flat pure green:
   ```
   Character turnaround sheet in the art style of <the world>: <character>. Draw the same character 4 times
   in one row, same size, feet on one baseline: facing down toward the viewer, facing up (back view), facing
   left, facing right. Seen from a high three-quarter top-down camera. Plain flat pure green background
   (#00FF00), no ground, no shadows, no text.
   ```
   Crop each pose, pad it to 9:16 with the same green, upload it, then `summer_assets_generate_video`
   (`model: "minimax-h3-max"`, `aspectRatio: "9:16"`, 5 s) per direction and animation:
   ```
   The character, <facing the viewer | seen from behind | in side view facing right>, walks in place on the
   spot with a steady, simple game walk cycle. The character stays exactly centred at the same size and never
   moves across the frame or turns. Static locked camera, no zoom. The plain flat pure green background stays
   perfectly flat and unchanged. Seamless loop.
   ```
   Idle: "stands still in a relaxed idle: gentle breathing, one blink, feet planted". Run: "runs in place".
3. **Clip to sheet** (host with a shell and ffmpeg): key out the green by colour, take one walk cycle (about
   1 s at 24 fps; skip the first second), sample 8 frames evenly, crop every frame of every clip with the **same**
   box so the feet stay on one line, and tile them into one sheet: one row per animation (`idle_down`,
   `walk_down`, `walk_up`, `walk_left`, `walk_right`, ...). Left can be the right row mirrored. Write a json
   beside it: `{"cell_w", "cell_h", "frames", "rows", "fps"}`. Look at every frame; regenerate a clip with a
   broken frame.
   Without video: `summer_call` `assets.generate_sprite_sheet` (8-frame walk from one picture, per direction).
4. **In the game:** `painted_player.gd` makes an `AnimatedSprite3D`: Y-billboard, unshaded, alpha cut (so painted
   walls hide the character), height stretched by `1 / cos(camera pitch)`. Spawn points 0.5 m or more away from
   walls, or the flat card cuts into them.

### 10. Weapons

- **Variant sheet (best look):** edit the turnaround so the character holds the weapon, then animate the clips
  again. One extra sheet per weapon.
- **Held sprite layer (cheap):** a second `Sprite3D` child with the weapon, a per-direction offset and draw order
  (behind the body when facing up). Good for many weapons; the hand will not wrap around the grip.

## Common mistakes

- **Concept as style reference with a different layout:** the painting copies the concept and ignores the blocks.
- **Generic boxes that do not follow the concept:** the painting then fights the geometry; rebuild one to one.
- **Rotating the game camera:** shows painted detail on the wrong surfaces. Translate only.
- **2K painting with a zoomed camera:** blurry. Paint 4K.
- **Filmic/ACES tonemap or lights on painted meshes:** colours shift. Unshaded material, Linear tonemap.
- **Perspective camera:** moving it reveals hidden faces. Use orthographic.
- **Player walking off the painted frame:** clamp to the frame.

## Optional: Blender route

If the host has Blender, `_building-blocks/blender-route.md` bakes the same projection into ordinary UVs and
exports glTF; use it when the scene must ship as plain textured meshes.

## See also

- `make-game` (genre mechanics), `concept-art`, `sprite-sheet`, `scene-composition`

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@latest` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `summer_assets_generate_image` | `summer assets generate-image` |
| `summer_assets_generate_video` | `summer assets generate-video` |
| `assets.get` | `summer assets get` |
| `assets.upload_begin` | `summer assets upload-begin` |
| `assets.upload_complete` | `summer assets upload-complete` |
| `summer_docs_search` | `summer docs search` |
| `summer_add_node` | `summer engine add-node` |
| `summer_create_scene` | `summer engine create-scene` |
| `summer_get_script_errors` | `summer engine get-script-errors` |
| `summer_import_from_url` | `summer engine import-from-url` |
| `summer_play` | `summer engine play` |
| `summer_read_file` | `summer engine read-file` |
| `summer_run_script` | `summer engine run-script` |
| `summer_save_scene` | `summer engine save-scene` |
| `summer_screenshot` | `summer engine screenshot` |
| `summer_set_prop` | `summer engine set-prop` |
| `summer_stop` | `summer engine stop` |
| `summer_write_file` | `summer engine write-file` |
| `summer_jobs_wait` | `summer jobs wait` |
<!-- /shell-commands -->
