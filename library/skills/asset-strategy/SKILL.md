---
name: asset-strategy
description: Use when planning asset creation, picking an asset pipeline, or routing an "I need a [thing]" request to the right specialist skill. Disambiguates between 2D / 3D / audio / video / VFX / animation pipelines and dispatches via the Skill tool. Trigger on "assets", "asset pipeline", "make a model", "I need a sound", "create concept art", "generate something", broad creative requests.
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: asset-pipeline
user-invocable: false
allowed-tools: Read Grep Skill summer_search_assets summer_list_my_assets summer_get_asset summer_import_asset_by_id
---

# Asset Strategy — Meta-Router for Asset Creation

Classify the user's request, ask at most one clarifying question, then dispatch to the right specialist via the `Skill` tool. Don't generate anything yourself — every media-type/asset-class combination has a dedicated specialist that owns the prompt patterns, polycount targets, gates, and fallbacks. Your job is the routing decision, not the work.

## Step 1 — Classify by media type

| Signal in user request | Continue at |
|---|---|
| image, art, concept, portrait, icon, sprite, texture, skybox, HUD | 2D table |
| model, mesh, 3D, prop, character, rigged, vehicle, tree, level kit | 3D table |
| sound, SFX, music, ambient, voice, VO | Audio table |
| cutscene, trailer, loop video, animated background | Video table |
| animation, idle, walk, attack, retarget, blend tree, IK, lipsync | Animation table |
| fire, muzzle flash, smoke, lightning, shake, hit-stop, particles | VFX table |

If the request spans rows ("a witch with idle and a fire spell"), classify the **first** asset and dispatch — the specialist hands off when it's done.

## Step 2 — Disambiguate (one question max)

Ask the **exact phrase** before dispatching. Skipping the question is the most common routing mistake.

| Ambiguity | Disambiguation question (verbatim) | Routes |
|---|---|---|
| Concept art vs character portrait | "Quick check — exploring the look (3-4 variants for art direction) or generating a final character portrait for dialogue UI?" | `summer:2d-assets/concept-art` (exploring) / `summer:2d-assets/character-portrait` (final) |
| Prop vs character model | "Static object (sword, chair, lantern) or rigged character that needs animation?" | `summer:3d-assets/prop-model` / `summer:3d-assets/character-model` |
| Tile vs sprite sheet | "One seamless tile that repeats, or a frame grid for an animated sprite?" | `summer:2d-assets/tileable-texture` / `summer:2d-assets/sprite-sheet` |
| SFX vs music | "One-shot effect or a longer track (loop, theme, ambient bed)?" | `summer:audio/sound-effect` / `summer:audio/music-track` (or `audio/ambient-bed`) |
| Generate vs retarget motion | "Generate a new clip on this character, or apply an existing library to a new character?" | `summer:animation/generate-motion` / `summer:animation/retarget` |
| VFX recipe vs game-feel | "Particle/shader effect in the world or screen-feel (camera shake, hit-stop)?" | `summer:visual-effects/recipes/<name>` / `summer:visual-effects/game-feel` |

## Step 3 — Dispatch

Invoke the specialist via the `Skill` tool. Don't paraphrase — let it run. Pass the user's original phrasing through.

## Routing tables

### 2D assets

| Request | Skill |
|---|---|
| Concept / mood board / variants | `summer:2d-assets/concept-art` |
| Polished portrait / NPC bust | `summer:2d-assets/character-portrait` |
| Pixel sprite / retro icon | `summer:2d-assets/pixel-art` |
| HUD / button / inventory frame | `summer:2d-assets/ui-graphics` |
| Wall / floor / seamless ground | `summer:2d-assets/tileable-texture` |
| Run cycle / spritesheet grid | `summer:2d-assets/sprite-sheet` |
| 360 sky / panoramic background | `summer:2d-assets/skybox-panorama` |

### 3D assets

| Request | Skill |
|---|---|
| Sword / chair / barrel / static object | `summer:3d-assets/prop-model` |
| Player / NPC / enemy / boss / rigged humanoid | `summer:3d-assets/character-model` (canonical Meshy auto-rig) |
| Modular dungeon / building blocks | `summer:3d-assets/environment-kit` |
| Car / spaceship / hard-surface vehicle | `summer:3d-assets/vehicle-model` |
| Tree / rock / mushroom / foliage | `summer:3d-assets/organic-model` |

Polycount targets (hero 8k–15k, grunt 3k–6k, mobile 1k–3k, cinematic 20k–40k) live in each specialist.

### Audio

| Request | Skill |
|---|---|
| Sword clash / footstep / UI click | `summer:audio/sound-effect` |
| Theme / level music / boss track | `summer:audio/music-track` |
| Forest ambience / cave drone | `summer:audio/ambient-bed` |
| NPC line / VO / spoken dialogue | `summer:audio/voice-line` |
| Music that reacts to combat | `summer:audio/adaptive-music` |
| What should this game sound like | `summer:audio/audio-direction` |

### Animation

| Request | Skill |
|---|---|
| Idle / walk / run / attack — new clip | `summer:animation/generate-motion` |
| Apply library to a different character | `summer:animation/retarget` |
| Blend tree / state machine | `summer:animation/animation-tree` |
| Look-at / IK / foot placement | `summer:animation/procedural-animation` |
| Lipsync / facial blendshapes | `summer:animation/facial-and-lipsync` |

### Video

| Request | Skill |
|---|---|
| Intro cutscene / story sequence | `summer:video/cinematic-cutscene` |
| Steam trailer / marketing clip | `summer:video/trailer-shot` |
| Animated menu background / loop | `summer:video/animated-loop` |

### Visual effects

VFX is **code, not generative** — recipes are shader + GDScript + node setup, not image generation.

| Request | Skill |
|---|---|
| Fire / torch / campfire | `summer:visual-effects/recipes/fire` |
| Muzzle flash / gunshot | `summer:visual-effects/recipes/muzzle-flash` |
| Water ripple / splash | `summer:visual-effects/recipes/water-ripple` |
| Lightning / electric arc | `summer:visual-effects/recipes/lightning` |
| Dissolve / disintegrate | `summer:visual-effects/recipes/dissolve` |
| Smoke / dust puff | `summer:visual-effects/recipes/smoke` |
| Hit spark / impact flash | `summer:visual-effects/recipes/hit-spark` |
| Magic glow / aura | `summer:visual-effects/recipes/magic-glow` |
| Camera shake / hit-stop | `summer:visual-effects/game-feel` |

## When NOT to use this skill

- The user already named the specific skill — go straight there.
- The user is debugging or running the game — route to `summer:debug` or `summer:play`.
- The asset is an existing Summer asset ID — call `summer_get_asset`, then `summer_import_asset_by_id`.
- The asset is being imported from a non-Summer URL (`.glb` / `.wav` from Sketchfab, Quaternius, AmbientCG) — call `summer_import_from_url` directly.
- The user wants to plan the whole game's asset list — `summer:brainstorm-game` first, then this router on each item.

## Anti-patterns

- **Generating yourself instead of dispatching.** This file holds zero prompt patterns by design. If you're writing a `summer_generate_image` call from here, stop and invoke the specialist.
- **Skipping the disambiguation question.** Sends users to the wrong specialist and burns a paid generation. The verbatim phrasing in Step 2 is required.
- **Routing concept-art to character-portrait** (or the reverse). Different goals: concept-art produces 4 divergent variants for art direction; character-portrait produces 1 polished bust for dialogue UI.
- **Inventing skill names.** Only dispatch to skills listed above. If nothing fits, ask the user to clarify.
- **Routing rigged-humanoid requests to `prop-model`.** Anything that needs animation always goes to `summer:3d-assets/character-model`.

## Fallback (no MCP)

The router still works without MCP — classification is text-only. It hands off to the specialist, which surfaces its own no-MCP fallback (typically: run the equivalent generation via the Summer dashboard / Meshy / nano-banana web, then `summer_import_from_url` once MCP is back).
