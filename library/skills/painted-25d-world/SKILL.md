---
name: painted-25d-world
description: "Build a 2D or 2.5D game as a painted world: a 3D blockout under one fixed camera, an AI paint-over projected onto it, sprite characters."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: 2d
user-invocable: true
allowed-tools: Read Write Edit Bash summer_write_file summer_read_file summer_create_scene summer_add_node summer_set_prop summer_run_script summer_save_scene summer_screenshot summer_play summer_stop summer_get_script_errors summer_assets_generate_image summer_get_project_context summer_jobs_wait summer_import_from_url summer_call
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

- Top-down / three-quarter games: camera 30 degrees down, 45 degrees around (houses show two faces). Image
  models draw "isometric" as 2:1 dimetric, which is exactly 30 degrees down; use 30 so the blockout can match a
  generated concept.
- Side-scrollers: the same technique with a camera that looks along the side axis (about 10-20 degrees down,
  0 degrees around) and pans left and right only. Paint one frame per screen-wide chunk.

Tell the user once, before the first character generation or animation: "The world blockout is cheap. Animating
characters costs a couple of dollars in credits and can come out with mistakes; I will check every frame." Then
continue. The blockout, the camera and the projection cost nothing.

## Hard rules (a playtest found each one)

1. **Scale.** Doors 2.5 m. Hero height = door height / 1.15 (2.15 m). One-storey eaves 3.5-4 m, two-storey about
   6 m. Check the hero against a door in the first screenshot.
2. **The gait follows the game type.** Cozy, exploration and RPG games walk by default (about 1.8 m/s, walk cycle)
   and run on Shift (about 4 m/s, run cycle). Action games may run by default (about 4.2 m/s, run cycle). Never
   play the run cycle for the default gait of a cozy game. `painted_player.gd`: `move_speed`, `sprint_speed`,
   `run_cycle_from` (3 m/s).
3. **Animation speed follows ground speed.** A cycle's natural speed is the ground speed at which its feet stick
   (stride per cycle x cycles per second, scaled to the hero height). Each sheet json carries `height_m`,
   `stride_m` and `cycles_per_s` per kind; `speed_scale = speed / natural speed`, clamped. The feet must not
   slide. Never one fixed fps for every speed.
4. **Framing.** The game camera shows about 16 m across (7-8 hero heights). Clamp it inside the painting with
   the real viewport aspect, never an assumed 16:9. The clear colour is the painting's edge colour, per location.
   Rooms are framed whole, like a stage.
5. **At least one enterable building** in every village: a cut-away interior, same view direction, its own 4K
   paint-over, door triggers both ways, a door gap of about 1.8 m. Blockout door and step slabs are hidden in the
   game; the painting shows them.
6. **Eight directions** for idle, walk and run: down, up, left, right, down_left, down_right, up_left, up_right.
   One clip per direction and animation. Mirror only where every frame holds up (never asymmetric hair, a held
   weapon or a walking stick). The player picks the facing by 45 degree sectors.
7. **Blockout proportions from the concept.** Dormers sit on the roof slope (never floating); gables and roofs
   from measured concept pixels; doors 2.5 m; a low block for every flower bed, barrel and crate.
8. **No long cast shadows in the paint.** "Soft short contact shadows only, no long cast shadows on the ground":
   baked long shadows look wrong once the hero walks through them.
9. **Verify in a real window.** Run the game with `-- --shots=<dir>`: `painted_world.gd` walks and runs the hero
   through `shot_plan` (add a walk through each door) and saves a JPG per step. Look at every frame.
10. **Generate a walk whose stride fits the default speed.** Keep the walk cycle's playback within about 1.5x
   (`speed / natural <= 1.5`): a short-step clip played fast looks wrong. Measure the natural walk speed; if it
   is too low, regenerate the walk clips with the brisk long-stride prompt (step 9). The plug-in walks are natural
   at about 1.25-1.4 m/s at 2.15 m, so 1.8 m/s plays at 1.3-1.45x. Short, 4-heads-tall characters reach about
   half a body height per cycle at most; taller proportions (6-7 heads) give longer strides.

## Steps

### 0. The project and the engine

- No project yet: `summer create empty <name>` (or write a plain `project.godot`), open it with
  `summer run <path>`, and check that `summer_get_project_context` answers for that project.
- `engine_not_running` while an editor is open: the editor was started with another HOME, or the MCP is bound to
  a different editor. Start this project's editor with `summer run <path>`, or drive it from a shell with the CLI
  and `SUMMER_ENGINE_PROJECT=<path>` set.
- Image generation through Summer: always pass an `idempotencyKey` and `numImages: 1`. A call that answers
  `outcome_unknown` (a timeout) may still run and charge: retry with the **same** key, never a new one.

### 1. Concept (one image)

`summer_assets_generate_image` with `model: "seedream-5-pro"`, `width` 2048, `height` 1152 (the largest 16:9
image Summer's models return; the others stop near 1024x576):

```
Hand-painted illustration of <place>, rich detail, warm painterly light, seen from a high three-quarter
top-down camera (looking down about 30 degrees, orthographic, no perspective distortion), like a tilted
isometric game map. In the scene: <every object with its rough position: "three cottages around a dirt
plaza, a well with a small roof in the centre, a striped market stall top left, fences, round trees">.
Clean readable shapes, soft brush texture, no characters, no text, no UI, no border.
```

Pick the image the user likes. It is the art direction and the layout.

### 2. Blockout (cheap: you write it)

Write one GDScript or scene that rebuilds the concept **one to one** from the fixed camera: the same building
positions and footprints, roof shapes (gable, hip, dormers on the slope, thatch overhang), chimneys, the well, the
stall, fences, paths, trees and bushes where the concept has them. Use `MeshInstance3D` with `BoxMesh`,
`PrismMesh`, `CylinderMesh`, `SphereMesh` (not CSG: only MeshInstance3D nodes get the painting). Give each
material one flat colour (red = tile roof, yellow =
thatch, dark blue = slate, cream = plaster walls, grey = stone, brown = wood, tall brown slabs = doors, green =
grass, pink low blocks = flower beds): the colours tell the painter what each block is, and the paint-over prompt
repeats them as a colour key. Name door and step slabs `..._door` / `..._steps`: they are hidden in the game.

```
World (Node3D, painted_world.gd: player_path, start_location)
  Village       Node3D, painted_location.gd (paint, frame_whole = false)
    PaintCamera Camera3D  ORTHOGONAL, KEEP_WIDTH, size = frame width in metres (40 for a village square)
                rotation_degrees = Vector3(-30, 45, 0)   # 30 down, 45 around; never change it later
                position = frame centre - forward * 60, far = 200
    Painted     Node3D    every block (or blockout_builder.gd reading a spec), Ground walkable
  Cottage       Node3D, painted_location.gd (frame_whole = true), 100 m off to the side
    PaintCamera same rotation, size 14 for a 9 x 7.5 m room
    Painted     ...
  DoorIn        Area3D, painted_door.gd (to = Cottage, spawn = a Marker3D inside the room)
  DoorOut       Area3D, painted_door.gd (to = Village, spawn = a Marker3D outside the village door)
  GameCamera    Camera3D
  Player        CharacterBody3D, painted_player.gd (sheet, sheet_json)
```

One world script owns the player, the camera and the doors; locations never move the player themselves.
`painted_world.gd` sets the player up after every child is ready, so the node order is free.

In a `.tscn`, the paint camera line for 30 down, 45 around is (Godot writes the basis by rows; hand-written
columns give a wrong camera):
`transform = Transform3D(0.707107, -0.353553, 0.612372, 0, 0.866025, 0.5, -0.707107, -0.353553, 0.612372, cx + 36.742, cy + 30, cz + 36.742)`
for a frame centred on (cx, cy, cz), 60 m back along the view.

**Write the blockout as a spec** (`_building-blocks/blockout_builder.gd` documents the JSON: box, prism, cyl,
sphere, poly ground, invisible wall blockers). The same file drives the engine (the builder is the location's
`Painted` node) and an engine-free wireframe preview over the concept (`tools/preview.py`), so the fitting loop
needs no engine runs.

- **Gable roofs are two parts:** a wall-coloured prism for the gable triangle plus two thin slanted roof slabs
  with an overhang. A single roof-coloured prism makes the painter paint roof on the gable wall.
- **Edges and water:** put invisible `wall` blockers along water and ledge edges, with gaps at pier roots and
  doorways. Ground made from a polygon is one-sided: use the spec's `poly` (two-sided collision) or a box.

Solid things get a `StaticBody3D` and a box/cylinder shape: walls, trunks, fence posts, the well, furniture.
Things the player walks behind need real height (houses, trees, stalls).

**Paint richness follows blockout density.** The painter details what the blocks give it. Add low blocks for
flower beds, barrels, crates, benches, lanterns and window boxes wherever the concept has them; a sparse blockout
comes back as a sparse painting. Only truly flat detail (cobbles, rugs, grass) can stay paint-only.

**Match the concept.** Read positions straight from the concept by inverting the orthographic camera
(`tools/cam.py <height> <px,py> ...` does it). With the
concept W x H pixels, `s` = pixels per metre (W / frame width), `elev` = 30 degrees and a pixel (sx, sy) on the
ground (a wall's bottom corner):

```
u = (sx - W/2) / s                      # metres along the camera's right axis
v = (H/2 - sy) / (s * sin(elev))        # metres along the ground, away from the camera
height = dy / (s * cos(elev))           # a vertical edge dy pixels long (wall, ridge, chimney)
world = target + right_ground * u + far_ground * v
```

Three wall-bottom corners give a footprint; the ridge gives the roof height. Draw the spec over the concept with
`tools/preview.py` and move blocks until the red silhouettes line up, then build it in the engine.
If the blockout does not match the concept, the painting will not match the blocks.

### 3. Render the blockout from the paint camera

- Play with the location's `paint` left empty: `painted_world.gd` then shows the blockout through that
  `PaintCamera`, lit by a sun and ambient light so its faces read (an unlit blockout comes out near black).
  `summer_screenshot` `target: "game"` captures it.
- Exact PNG for the painter: copy `_building-blocks/capture_paint_view.gd`, make a scene with just that node
  (`level` = the world scene, `camera_path` = the location's camera, `size` = 2048x1152), and play it in a run
  that renders (the editor, or a windowed run; `--headless` renders nothing). It saves
  `res://painted/blockout.png` and quits.
- `summer_screenshot` `target: "scene"` renders the saved scene without running scripts: a blockout built by a
  script or the spec builder shows nothing there.

Then upload it: `summer_call` `assets.upload_begin`, post its form fields plus the file to `uploadUrl`, then
`assets.upload_complete` with `publicId`, `version`, `uploadSignature` (the `signature` of the upload's answer)
and `format`. Its answer carries the `fileUrl`.

### 4. Paint-over (strict image to image)

**Never pass the whole concept as a reference.** Even when the blockout rebuilds it one to one, frontier edit
models copy the full concept and ignore the blocks. Pass a **material sheet** instead: a 2x2 grid of close-up
crops from the concept (for a village: clay-tile roof with a timber-framed wall, thatch, market stall with
cobbles, slate roof with flower beds). It carries the style and materials but no layout.

With two images (image 1 = blockout render, image 2 = material sheet), the best frontier edit model you have, 16:9,
the largest size (4K):

```
Image 1 is a flat-coloured 3D blockout render of <place> from a fixed game camera. Image 2 is a sheet of four
close-up material samples from the finished concept art (<the four samples>). Image 2 is a style and
material reference only: never copy its layout or composition.
Repaint image 1 in exactly that style, materials, light and detail. This is a strict image-to-image
paint-over: keep every shape, edge and position of image 1 identical, pixel-aligned. Same camera, same
framing. Every <building, roof, chimney, dormer, door, steps, well, stall, crate, bench, barrel, fence, tree and
bush> stays exactly where image 1 has it, with exactly the same silhouette and size. Do not add, remove or move
anything. Do not add extra props, buildings or trees. Only paint surface detail inside the existing shapes.
Colour key of image 1: red = clay-tile roof, yellow = golden thatch roof, dark blue = slate roof, cream =
timber-framed plaster walls, grey = mossy stone (chimneys, well, low walls, steps), brown = worn wood (tall
brown slabs on walls = wooden doors), light brown floor = cobblestone plaza, green ground = grass, green
spheres = round leafy tree canopies, small green domes = flowering bushes, orange = lit lanterns and fruit
crates, pink low blocks = dense flower beds and window boxes.
<Light and finish: e.g. warm golden late-afternoon light, soft short contact shadows only (no long cast shadows
on the ground), glowing windows, painterly near-realistic detail as in image 2: ivy on walls, moss on stones,
rich textures>. No characters, no text, no border.
```

`summer_assets_generate_image` takes one `referenceImageUrl` (the blockout render): put the material and
style description into the prompt in words and keep the colour key. Use `model: "seedream-5-pro"`, `width`
2048, `height` 1152, `numImages: 1` and an `idempotencyKey`: it holds pixel alignment well and is the only
Summer model that returns 2048 px.

**Check alignment before you use it.** Overlay the blockout's edges (red) on the painting
(`tools/overlay.py <blockout.png> <painting.png> <out.png>`) and look: roof lines,
wall corners, the well and the stall must sit on the red lines. Reject any painting where objects moved, were
added, or the framing zoomed; generate again rather than project a drifted painting.

### 5. Resolution

Painting pixels per metre must be at least the screen's pixels per metre. A 4K painting (about 5500 px) over a
40 m frame gives 137 px/m; a 16 m view on a 1080p-class game view needs about 96-120 px/m, so it stays sharp. A
2048 px painting over 32 m (64 px/m) is soft at that view. For bigger worlds use more frames, not a wider frame.

**4K through Summer:** no Summer image model returns 4K. `tools/detail4k.py <painting_2k.png> <out_dir> "<style
words>"` upscales the 2K paint-over 2x, cuts nine overlapping 2048x1152 tiles, runs a strict "redraw sharper,
pixel-aligned" image-to-image pass on each with `seedream-5-pro` and blends them back. Nine generations; the
alignment holds.

### 6. Projection in the engine

Copy `_building-blocks/paint_projection.gdshader`, `painted_location.gd`, `painted_world.gd`,
`painted_door.gd` and `painted_player.gd` to `res://painted/`. Set each location's `paint`. On `_ready` a
location puts one `ShaderMaterial` on every mesh under its `Painted`; the shader takes each surface point's
position in that location's paint camera frame as its UV. No UV unwrapping, no baking.

- Keep the scene's tonemap **Linear**, exposure 1, no glow, no fog: the painting already holds the light.
- Import the painting lossless (Import dock: Compress Mode Lossless, mipmaps on); VRAM compression smears it.
- Verify: `_building-blocks/paintcam_check.gd` renders the painted world through a `PaintCamera` to a PNG; it
  must match the painting. Then play and look at the real window (hard rule 9).

### 7. Camera rules

- The game camera has the paint camera's direction and only **moves** (follows the player). With an orthographic
  camera, moving never reveals a surface the painting did not see. Never orbit or tilt it: turned views show the
  painting's mistakes (a painted chimney next to the real one, roof edges smeared on the ground).
- Outdoors it shows about 16 m across; rooms are framed whole. `painted_world.gd` sizes and clamps it with the
  real viewport aspect and sets the clear colour to the painting's edge colour.
- More world = more frames. Every frame uses the same direction, its own paint camera position and painting.
  Paint neighbouring frames with an overlap strip so the seams match.

### 8. Interiors

Every village gets at least one enterable building. Each interior is its own location far away (for example 100 m
off to the side) with the **same** camera direction and a frame that holds the whole room with its back walls
(14 m for a 9 x 7.5 m room; 12 m cut the walls off), `frame_whole = true`. Lower
the two walls nearest the camera to knee height (a dollhouse cut-away) and leave a door gap of about 1.8 m.
Blockout, render, paint over (its own 4K paint-over, the same rules and colour key: warm floorboards, plaster,
beams, fireplace, bed, shelves, rug, "keep the area outside the room plain flat dark") and project exactly like
the outside. `painted_door.gd` triggers go both ways; put each spawn marker clear of the other door's trigger.

### 9. Characters

1. **Ready-made:** use the painted plug-in characters first: a man, a woman, the man with a sword and an old man,
   8 directions, idle, walk and run (`hero_m_sword`: idle and walk). They live in the public repo
   `SummerEngine/painted-characters`, pinned at commit `c70dae1b4043656ad23d5ab6d76fe992f593b6ba`. For `<id>`, import
   `https://raw.githubusercontent.com/SummerEngine/painted-characters/c70dae1b4043656ad23d5ab6d76fe992f593b6ba/characters/<id>/<file>`
   for the three files `<id>_sheet.png`, `<id>_sheet.json` and `<id>_frames.tres` into `res://characters/<id>/`
   (`summer_import_from_url`; the `.tres` expects that path), then set `sheet` = `<id>_sheet.png` and
   `sheet_json` = `<id>_sheet.json` on `painted_player.gd`. With a shell, `git clone` the repo and copy
   `characters/` to the project root. Need a different look: make one.
2. **New character:** generate an 8-pose turnaround (or two 4-pose sheets) in the world's style on flat pure
   green:
   ```
   Character turnaround sheet in the art style of <the world>: <character>. Draw the same character 8 times,
   same size, feet on one baseline: facing down toward the viewer, down-left, left, up-left, up (back view),
   up-right, right, down-right. Seen from a high three-quarter top-down camera. Plain flat pure green
   background (#00FF00), no ground, no shadows, no text.
   ```
   Crop each pose, pad it to 9:16 with the same green, upload it, then `summer_call` `assets.generate_video`
   (`model: "minimax-h3-max"`, `aspectRatio: "9:16"`, 5 s, an `idempotencyKey`): one clip per direction and
   animation:
   ```
   The character, <facing>, walks in place on the spot with a brisk, purposeful walk cycle: long confident strides, heel to toe, the front leg reaching far forward and the back leg pushing far back, arms swinging strongly opposite the legs, upright posture. The character
   stays exactly centred at the same size and never moves across the frame or turns. Static locked camera, no
   zoom. The plain flat pure green background stays perfectly flat and unchanged. Seamless loop.
   ```
   That is the walk prompt for a default walk (a plain "steady, simple walk cycle" takes short steps and must be
   over-sped). For a longer stride still: "walks in place on the spot with a long-legged power walk: very wide
   steps, at each step the front heel lands far ahead and the back foot pushes off far behind, legs nearly fully
   extended front to back, arms swinging wide, a quick purposeful pace."
   Idle: "stands still in a relaxed idle: gentle breathing, one blink, feet planted". Run: "runs in place".
3. **Clip to sheet** (host with a shell and ffmpeg): key out the green by colour, take one cycle (skip the
   first second), sample 8 frames evenly, crop every frame of every clip with the **same** box so the feet stay
   on one line, and tile them into one sheet: one row per animation and direction (`idle_down`,
   `walk_up_left`, `run_right`, ...). Write the json beside it: `{"cell_w", "cell_h", "frames", "rows",
   "fps": {"idle", "walk", "run"}, "height_m", "stride_m": {"walk", "run"}, "cycles_per_s": {"walk", "run"}}`.
   Measure once per kind: `stride_m` = how far a planted foot slides back during one cycle at `height_m`,
   `cycles_per_s` = cycles per second at the sheet's fps. Look at every frame; regenerate a clip with a broken
   frame.
   Without video: `summer_call` `assets.generate_sprite_sheet` (8-frame walk from one picture, per direction).
4. **In the game:** `painted_player.gd` makes an `AnimatedSprite3D`: Y-billboard, unshaded, alpha cut (so painted
   walls hide the character), height stretched by `1 / cos(camera pitch)`, 8 facings by 45 degree sectors (a
   missing diagonal falls back to its side row), the game-type gait (hard rule 2), animation speed = speed /
   natural speed.
   Spawn points 0.5 m or more away from walls, or the flat card cuts into them.

### 10. Weapons

- **Variant sheet (best look):** edit the turnaround so the character holds the weapon, then animate the clips
  again. One extra sheet per weapon. Never mirror a sheet with a held weapon.
- **Held sprite layer (cheap):** a second `Sprite3D` child with the weapon, a per-direction offset and draw order
  (behind the body when facing up). Good for many weapons; the hand will not wrap around the grip.

## Common mistakes

- **The whole concept as a reference:** the painting copies the concept and ignores the blocks, even when the
  blockout matches it. Pass a 2x2 material sheet cropped from the concept.
- **A sparse blockout:** the painting comes back sparse. Add low blocks for flower beds, crates, barrels, benches.
- **35 degrees against a generated concept:** generated "isometric" art is 30 degrees down; the blocks will not fit.
- **A tiny or giant hero:** check the hero against a door (door = hero x 1.15) in the first screenshot.
- **Sliding feet or the wrong gait:** speed_scale = speed / natural; cozy games walk by default and run on Shift.
- **4096 px asked from Summer's image models:** refused. 2048x1152 with seedream-5-pro, then the tiled 4K pass.
- **A new idempotencyKey after a timeout:** pays twice. Retry with the same key; keep numImages 1.
- **An unlit blockout capture, CSG blocks, a one-sided polygon ground, no water blockers:** see steps 2 and 3.
- **Long baked shadows:** they lie on the ground while the hero walks through them. Contact shadows only.
- **Floating dormers, blockout door slabs left visible:** dormers on the slope; hide door and step slabs.
- **Rotating the game camera:** shows painted detail on the wrong surfaces. Translate only.
- **Filmic/ACES tonemap or lights on painted meshes:** colours shift. Unshaded material, Linear tonemap.
- **Perspective camera:** moving it reveals hidden faces. Use orthographic.
- **Assuming a 16:9 window:** the clamp shows past the painting in the editor's game view. Use the real aspect.

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
| `assets.generate_video` | `summer assets generate-video` |
| `assets.upload_begin` | `summer assets upload-begin` |
| `assets.upload_complete` | `summer assets upload-complete` |
| `summer_add_node` | `summer engine add-node` |
| `summer_create_scene` | `summer engine create-scene` |
| `summer_get_project_context` | `summer engine get-project-context` |
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
