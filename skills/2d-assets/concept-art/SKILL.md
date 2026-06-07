---
name: concept-art
description: Use when the user is exploring art direction — wants 3-4 rough variants of a character, environment, or prop to pick a vibe before committing to a final asset. Generates a batch of evocative concept images, not finals. Trigger on "concept art", "art direction", "explore the look", "give me some variants", "what could this character look like", "mood board", "rough sketches".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: 2d-assets
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_generate_image summer_search_assets summer_import_from_url
paths: ["assets/**", "art/**", "concepts/**"]
---

# concept-art — Batch-of-Variants for Art Direction

This skill produces **3-4 rough concept images** of the same subject under different stylistic interpretations. The goal is not the final asset — the goal is to give the user something visual to react to so they can lock a direction. Variants are deliberately divergent (different palette, mood, framing, era) so the user has real choices, not four near-identical takes.

If the user wants ONE polished image (a dialogue portrait, a hero card), this is the wrong skill — route to `summer:2d-assets/character-portrait`. The `summer:asset-pipeline/asset-strategy` meta-router uses the disambiguation phrase **"Quick check — exploring the look (3-4 variants for art direction) or generating a final character portrait for dialogue UI?"** to send users to one of the two. If you arrived here without that question being asked, ask it before generating.

## When to use

- "I'm not sure what this character should look like — give me some options."
- "Show me 3-4 directions for the witch."
- "I want a mood board for the swamp level."
- Early-project art direction, before the GameSoul.md visual style is locked.
- The user describes a vibe ("dark fantasy", "Ghibli-esque", "Mobius") and wants to see it rendered.

## When NOT to use

- The user wants a single locked portrait for a dialogue UI → `summer:2d-assets/character-portrait`.
- The user wants pixel art specifically → `summer:2d-assets/pixel-art`.
- The user wants a UI icon or HUD element → `summer:2d-assets/ui-graphics`.
- The user wants a tileable wall/floor texture → `summer:2d-assets/tileable-texture`.
- The user wants an image-to-3D reference → `summer:asset-pipeline/asset-strategy` (the 3D pipeline has its own prompt suffix).

## Steps

### 1. Confirm exploration vs final

Before generating, ask once:

> Quick check — exploring the look (3-4 variants for art direction) or generating a final character portrait for dialogue UI?

If "final" → hand off to `summer:2d-assets/character-portrait`. If "explore" → continue.

### 2. Search for prior concepts

```
summer_search_assets(query="<subject> concept", filter={ kind: "image" })
```

If something already exists, ask if the user wants to riff on it (img2img via `referenceImageUrl`) or start fresh.

### 3. Pick a variant axis

Variants must differ on **one explicit axis**, not noise. Pick one:

| Axis | Use when |
|---|---|
| Palette / mood | "Should this feel grim or hopeful?" |
| Era / setting | "Medieval, sci-fi, modern, post-apoc?" |
| Stylization | "Painterly, anime, photoreal, Mobius line-art?" |
| Silhouette / proportions | Character design — slim/bulky/childlike/monstrous |
| Time of day / lighting | Environment — dawn/noon/dusk/night |

State the axis to the user before generating: "I'll vary on **stylization** — painterly, anime, line-art, photoreal. OK?"

### 4. Generate the batch

Issue 3-4 calls in parallel, one per variant. Use the same subject phrasing across all four; only the style-modifier changes.

```
summer_generate_image(
  prompt="<subject>. <axis variant 1>. concept art, evocative, rough painterly, atmospheric lighting",
  model="nano-banana-2",
  style="none",
  options={ image_size: "landscape_16_9" }
)
```

`style: "none"` is intentional — concept art doesn't want the default "realistic" or "cartoon" preset overriding the prompt's stylistic direction.

### 5. Present the batch

After all 4 return, show the user the thumbnails (link `thumbnailUrl` for each) and ask:

> Which direction lands? I can generate variants on the chosen one, or hand off to `character-portrait` for a final.

Do NOT import any of these as `res://` assets yet. Concept art is reference, not shipped art. Only import once the user picks a winner — then either it goes to `character-portrait` for a polished version or directly to `summer_import_from_url` if they want to use it as-is as a reference.

## Prompt patterns

The structure: **subject + axis variant + "concept art" + lighting/atmosphere**. Keep prompts under 30 words.

| Goal | Prompt that works | Why |
|---|---|---|
| Character — palette axis | `young witch with raven familiar. <warm autumn palette / cold blue moonlit palette / sickly green swamp palette / monochrome ash palette>. concept art, painterly, atmospheric` | Locked subject + four explicit palettes |
| Character — silhouette axis | `goblin warrior. <slim wiry / hulking brute / childlike imp / multi-limbed mutant>. concept art, full body, rough painterly` | Forces real shape variation |
| Environment — mood axis | `swamp village at dusk. <hopeful warm lanterns / oppressive fog / abandoned ruins / overgrown nature reclaim>. concept art, wide shot, atmospheric` | Mood drives composition |
| Environment — stylization axis | `mountain temple. <Studio Ghibli soft painterly / Mobius clean line-art / dark Berserk ink / Hayao detailed wash>. concept art, wide establishing shot` | Names real reference styles the model recognizes |
| Prop — era axis | `royal sword. <bronze age / medieval / ornate baroque / sci-fi energy>. concept art, three-quarter view, neutral background` | Era as the only varying dimension |
| Creature — physiology axis | `forest spirit. <deer-like elegant / fungal grotesque / jellyfish floating / branch-and-moss elemental>. concept art, atmospheric, painterly` | Forces real morphological divergence |

### Bad prompts (and why)

| Bad | Failure mode |
|---|---|
| `cool fantasy character` | No subject, no axis. All 4 variants will look interchangeable. |
| `make 4 different witches` | Model doesn't render "4 of"; you must call 4 times. |
| `epic concept art masterpiece trending on artstation` | Adjective soup. Trending-on-artstation is a 2022 cliche; modern models render it as bland slop. |
| `same character but different` | "Different" is undefined. Pick an axis and name it. |

## Anti-patterns

- **Generating 4 near-identical variants** because you didn't pick a real axis. The user can't choose between four images that all look like the same painting.
- **Importing concept art as final assets.** These are exploration. The polished version comes from `character-portrait` after a direction is picked.
- **Using `style: "realistic"` or `style: "cartoon"`** — the preset fights the prompt's stylistic direction. Use `style: "none"` for concept art.
- **Skipping the disambiguation question.** If you don't ask, you'll get yelled at when you generate 4 portraits and the user wanted one polished bust.
- **Generating before the GameSoul.md is written.** If `.summer/GameSoul.md` exists, read it first — its visual-style section narrows the axis.

## Edge cases

- **User says "just one" after you propose 4.** That's a `character-portrait` job. Hand off.
- **User wants 8+ variants.** Generate 4 first; if the user wants more on the same axis, generate 4 more. Don't dump 8 at once — overload paralyzes choice.
- **Subject is a fully described scene, not an asset.** You're producing key art, not asset reference. Use `image_size: "landscape_16_9"` and bias toward atmospheric.
- **User wants the final to be 3D.** After they pick a direction, route to `summer:asset-pipeline/asset-strategy` — concept-art images are not 3D-ready references (they have backgrounds, scene context, dramatic lighting baked in). The 3D pipeline needs its own clean white-background reference.

## Fallback (no MCP)

Print the 4 prompts and the call for each:

```
summer_generate_image(prompt="<variant 1>", model="nano-banana-2", style="none", options={ image_size: "landscape_16_9" })
summer_generate_image(prompt="<variant 2>", ...)
...
```

Tell the user to run via the Summer dashboard, then come back and `summer_import_from_url` the winning variant.

## Handoff

Once the user picks a direction:

- **Character / NPC final** → `summer:2d-assets/character-portrait` (use the picked variant as `referenceImageUrl`).
- **3D model from this concept** → `summer:asset-pipeline/asset-strategy` (regenerate a 3D-ready reference; concept art is not 3D-ready as-is).
- **Tileable texture from this mood** → `summer:2d-assets/tileable-texture`.
- **Pixel-art version** → `summer:2d-assets/pixel-art`.
- **Lock the visual direction** → write the choice into `.summer/GameSoul.md` under `## Visual style` so future asset skills inherit it.

## See also

- `summer:asset-pipeline/asset-strategy` — meta-router that delegates here vs other 2d-assets skills.
- `summer:2d-assets/character-portrait` — the polished single-image counterpart.
- `references/mcp-tools-reference.md` — `summer_generate_image` parameter schema.
