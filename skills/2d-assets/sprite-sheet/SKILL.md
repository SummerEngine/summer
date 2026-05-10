---
name: sprite-sheet
description: Use when generating animated 2D character sprites laid out as a sprite sheet (grid of frames) — walk cycle, attack frames, idle bob, death sequence. Wires into AnimatedSprite2D / SpriteFrames. Trigger on "sprite sheet", "walk cycle", "attack frames", "animated sprite", "frame-by-frame animation", "2D character animation".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: 2d-assets
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_generate_image summer_search_assets summer_import_from_url summer_set_resource_property summer_add_node summer_set_prop
paths: ["assets/**", "sprites/**", "art/sprites/**"]
---

# sprite-sheet — Frame-by-Frame 2D Animation

This skill produces a grid of animation frames for a 2D character — walk cycle, idle bob, attack swing, death sequence — and wires the result into an `AnimatedSprite2D` via a `SpriteFrames` resource.

**Up-front honesty:** sprite-sheet generation from a single text-to-image call is **unreliable**. Models can render "a sprite sheet of a knight walking" and produce 8 frames, but the inter-frame consistency (same anatomy, same costume, same lighting) is poor. Limbs morph between frames. Pixel sprites get extra fingers in frame 3. The result usually looks worse than the static sprite did.

This skill therefore offers **three paths**, ranked by reliability:

1. **Per-frame img2img** (most reliable) — generate the base pose, then generate each subsequent frame via `referenceImageUrl` with a small pose delta. Composite the frames into a sheet externally or wire each as a separate `SpriteFrames` entry.
2. **Single-call sheet generation** (fast, unreliable) — one prompt asks for the grid. Works ~30% of the time. Worth trying once for short cycles (4 frames or fewer) before falling back to (1).
3. **Manual authoring** (most reliable, slowest) — hand-author in **Aseprite** or **Piskel**. For pixel art at 32×32, this is often faster than fixing AI generations.

**(Plan 2)** A dedicated `summer_generate_spritesheet(prompt, frameCount, gridSize)` tool is on the roadmap and will use a model fine-tuned on sprite sheets with frame-coherence loss. Until it ships, expect to do per-frame img2img or fall back to Aseprite.

## When to use

- "Generate a walk cycle for the goblin sprite."
- "I need 4 attack frames for the player character."
- "Make a death animation — 6 frames of the enemy collapsing."
- "Create an idle bob, 2-frame loop."
- The character exists as a static sprite and needs animation.

## When NOT to use

- The character is 3D — use `summer:animation/generate-motion` for skeletal animation.
- The user wants a single static sprite → `summer:2d-assets/pixel-art` or `summer:2d-assets/character-portrait`.
- The user wants UI animation (loading spinner, button hover) — animate via `AnimationPlayer` rotating/tweening a static texture instead. Don't sprite-sheet UI.
- The user has 12+ frames per animation and 4+ animations — that's hundreds of generations at $0.02 each. Pause and discuss budget.

## Steps

### 1. Anchor the base sprite

You need a stable reference. Either:

- The user has a static sprite already (`res://sprites/goblin.png`) — use it as `referenceImageUrl`.
- Generate a base sprite via `summer:2d-assets/pixel-art` or `summer:2d-assets/character-portrait` first, then return here.

Without a base, every frame drifts.

### 2. Pick the path

Ask the user (or decide based on context):

| Signal | Path |
|---|---|
| Short cycle (≤4 frames), willing to accept some drift | Try **single-call sheet** first; fall back if bad |
| Pixel art at small resolution | **Aseprite manual** is often fastest |
| Higher-res character (128px+), 6-12 frames | **Per-frame img2img** |
| User wants exact-pixel consistency | **Aseprite manual** — AI cannot deliver exact pixels |

State the path before starting: "I'll do per-frame img2img — 6 generations, ~$0.12. The first frame is the base; each next frame uses the previous as reference. OK?"

### 3a. Path 1 — Per-frame img2img

Generate frame 1 (or use existing base). For each subsequent frame, prompt the pose delta and pass the previous frame as `referenceImageUrl`:

```
summer_generate_image(
  prompt="goblin warrior, walk cycle frame 2 of 6, right leg forward, slight bob upward, identical character, same costume, same palette, transparent background",
  referenceImageUrl="<frame 1 fileUrl>",
  model="nano-banana-2",
  style="<same as base>",
  options={ image_size: "square_hd", negative_prompt: "different character, different costume, scene background" }
)
```

Repeat for each frame. Save each as `goblin_walk_01.png`, `goblin_walk_02.png`, etc.

After all frames return, either:

- Wire each as a separate frame in a `SpriteFrames` resource (Godot will treat them as a sequence — no need to composite into a single sheet image).
- Composite into a single sheet image via Aseprite (`File → Import Sprite Sheet`) or ImageMagick (`montage frame_*.png -tile 6x1 -geometry +0+0 sheet.png`).

### 3b. Path 2 — Single-call sheet (try once)

```
summer_generate_image(
  prompt="goblin warrior walk cycle, sprite sheet, 6 frames in a horizontal row, identical character across frames, side view, transparent background, frames clearly separated, consistent lighting, consistent palette",
  model="nano-banana-2",
  style="pixel",
  options={ image_size: "landscape_16_9", negative_prompt: "different character per frame, scene background, varying lighting" }
)
```

Inspect the result. If frames are coherent and the count matches, proceed. If anatomy morphs or count is wrong, fall back to Path 1 or Path 3.

### 3c. Path 3 — Aseprite manual fallback

Tell the user:

> AI sprite-sheet generation is unreliable — best path for clean pixel animation is to hand-author in Aseprite (or Piskel for free in-browser). Onion-skin frame-by-frame; ~10 minutes for a 4-frame walk cycle. Want me to generate a base reference image you can trace?

If yes, generate the static base via `summer:2d-assets/pixel-art` and stop here. The user takes it to Aseprite.

### 4. Import frames into Godot

For per-frame import (Path 1):

```
summer_import_from_url(url="<frame 1>", path="res://sprites/goblin/walk_01.png")
summer_import_from_url(url="<frame 2>", path="res://sprites/goblin/walk_02.png")
...
```

For a composited sheet (Path 2 or external composite):

```
summer_import_from_url(url="<sheet>", path="res://sprites/goblin/walk_sheet.png")
```

Set `Filter: Nearest` on import for pixel art, `Linear` for high-res.

### 5. Wire as AnimatedSprite2D

```
summer_add_node(parentPath="/root/Game/Goblin", type="AnimatedSprite2D", name="Sprite")
```

Create a `SpriteFrames` resource and add an animation named `walk`. For per-frame textures:

```
summer_set_resource_property(
  nodePath="/root/Game/Goblin/Sprite",
  resourceProperty="sprite_frames:animations/walk/frames",
  value=["res://sprites/goblin/walk_01.png", "res://sprites/goblin/walk_02.png", ...]
)
summer_set_resource_property(
  nodePath="/root/Game/Goblin/Sprite",
  resourceProperty="sprite_frames:animations/walk/speed",
  value=8.0
)
summer_set_resource_property(
  nodePath="/root/Game/Goblin/Sprite",
  resourceProperty="sprite_frames:animations/walk/loop",
  value=true
)
```

For sheet-based (Path 2): use `AtlasTexture` with one region per frame, then add each AtlasTexture as a frame.

### 6. Trigger from code

```gdscript
@onready var sprite: AnimatedSprite2D = $Sprite

func _physics_process(delta):
    if velocity.length() > 0.1:
        sprite.play("walk")
    else:
        sprite.play("idle")
```

## Prompt patterns

### Per-frame img2img (Path 1)

| Goal | Frame 1 (base) | Frame N prompt skeleton (with `referenceImageUrl: <frame N-1>`) |
|---|---|---|
| Walk cycle (6 frames, side view) | `<character>, side view, idle stance, transparent bg` | `<character>, walk cycle frame N of 6, <leg position description>, identical character, same costume, transparent bg` |
| Attack swing (4 frames) | `<character>, side view, weapon raised over head` | `<character>, attack frame N, <weapon position: descending / impact / recovery>, identical character, transparent bg` |
| Idle bob (2 frames, loop) | `<character>, neutral stance, slightly compressed` | `<character>, idle bob upper position, slightly extended upward, identical character, transparent bg` |
| Death (6 frames) | `<character>, hit react, leaning back` | `<character>, death frame N, <position: stumbling / kneeling / falling / collapsed>, identical character, transparent bg` |
| Jump (3 frames) | `<character>, crouched ready to jump` | `<character>, jump frame N, <apex extended / falling tucked / land impact>, identical character, transparent bg` |

### Single-call sheet (Path 2)

| Goal | Prompt that sometimes works |
|---|---|
| 4-frame walk cycle | `<character> walk cycle, sprite sheet, 4 frames in horizontal row, side view, identical character, transparent background, clear frame separation, consistent lighting` |
| 2-frame idle | `<character> idle bob, sprite sheet, 2 frames horizontal, identical character, slight up-down delta, transparent background` |

### Bad prompts (and why)

| Bad | Failure mode |
|---|---|
| `goblin walking` | Returns one image of a walking goblin. Not a sheet, not multiple frames. |
| `12-frame walk cycle in one image` | Frame count too high for single-call. Anatomy morphs across the row. |
| `walk cycle for any character` | No character anchor. Frames have different characters. |
| Per-frame without `referenceImageUrl` | Each frame is a different goblin. |
| `sprite sheet, photorealistic` | Photoreal characters in tight frames lose identity coherence fast. Stay stylized. |

## Anti-patterns

- **Skipping the base anchor.** Without a stable reference (existing sprite or generated base), every frame drifts. Anchor first.
- **Generating walk cycles at high frame counts (12+) via single call.** Will fail. Use per-frame img2img or split into chunks.
- **Wiring an inconsistent sheet anyway** because you don't want to regenerate. Ship the inconsistency and the player notices the morphing limbs immediately. Cut the frame count or hand-author instead.
- **Sprite-sheeting things that don't need to be sprite-sheeted.** UI animation, simple bobs, fades — use `AnimationPlayer` to tween a static texture instead. Sprite sheets are for character animation specifically.
- **Pretending Aseprite is a failure.** Hand-authoring 4 pixel-art frames takes 10 minutes and looks better than 8 AI generations. Don't oversell AI here.

## Edge cases

- **Pixel art at low resolution.** AI per-frame img2img at 16×16 or 32×32 is ~impossible — the model can't preserve exact pixel positions. Aseprite or Piskel manual is the only reliable path. Generate a high-res reference and trace it down.
- **Character with cloth / cape physics.** Cloth animation is hard for any AI. Use a base sprite and add cloth as a separate `AnimationPlayer`-tweened layer (`Sprite2D` for the cape, sin-wave-tweened rotation).
- **8-direction sprite (top-down RPG with N/NE/E/SE/S/SW/W/NW).** Generate one direction's full cycle, then for each other direction generate the FIRST FRAME via img2img with a "rotated to face X" prompt and use it as the new base for that direction's per-frame work. Multiplies generation count by 8 — pause for budget confirmation.
- **User wants a turn-around (rotating in place over 8 frames).** Same as 8-direction; generate single-frame per angle as anchor, accept that AI rotation won't be perfectly consistent.
- **Animation needs to loop seamlessly.** Make frame N+1 explicitly bridge back to frame 1 in your prompt. Or generate one extra "bridge" frame and drop it.

## Fallback (no MCP)

Print the per-frame call sequence:

```
Frame 1: summer_generate_image(prompt="<base>", model="nano-banana-2", style="pixel", ...)
Frame 2: summer_generate_image(prompt="<base + delta>", referenceImageUrl="<frame 1>", ...)
Frame 3: summer_generate_image(prompt="<base + delta>", referenceImageUrl="<frame 2>", ...)
...
```

Tell the user to run via the Summer dashboard. Or recommend Aseprite (paid, $20) / Piskel (free in-browser) for hand-authoring — for pixel art under 64×64, it is the faster path even with MCP available.

## Handoff

After the animation is wired:

- **More animations on the same character** (idle, attack, death) → re-invoke this skill with the same base anchor, vary the delta.
- **Sound effects synced to animation frames** → `summer:audio/sound-effect`, then wire via `Call Method Track` in `AnimationPlayer`.
- **Multi-direction sprites** → re-invoke per direction (budget warning).
- **Pixel-art static base if not yet generated** → `summer:2d-assets/pixel-art` first.
- **3D character animation instead** → `summer:animation/generate-motion`.

## See also

- `summer:2d-assets/pixel-art` — base sprite generation.
- `summer:2d-assets/character-portrait` — base portrait for higher-res characters.
- `summer:animation/generate-motion` — 3D-skeletal counterpart.
- `summer:audio/sound-effect` — frame-synced SFX.
- `_shared/mcp-tools-reference.md` — `summer_generate_image` schema.
