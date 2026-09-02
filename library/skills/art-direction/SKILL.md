---
name: art-direction
description: Use when defining the visual style of the game — references, palette, mood, lighting plan, post-processing, do/don't list. Outputs an art bible at `.summer/art-bible.md`. Trigger on "art direction", "art bible", "visual style", "color palette", "what should it look like", "the look".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: rendering-and-lighting
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_get_project_context summer_project_setting summer_inspect_node summer_set_prop
paths: [".summer/**", "project.godot", "**/*.tscn"]
---

# /art-direction — Define the Visual Style

## Overview

A consistent art direction is what makes a low-budget game *look* like a finished game. Most solo devs lose this fight by mixing styles — a toon-shaded character on a photoreal terrain, a pixel UI over a smooth 3D world. This skill builds an art bible the rest of the project obeys: references, palette, mood, lighting plan, post-processing, and a do/don't list. It writes to `.summer/art-bible.md` — the file every rendering / shader / lighting / VFX skill reads later.

**Core principle:** Constraint produces style. A game with **15 colors total** looks more intentional than a game with infinite-color textures. Pick the constraint, then defend it.

## Steps

### 1. Open with references

Ask exactly this:

> Two or three references — games, films, art books, anything visual. What's the vibe?

Don't suggest. Listen. References are the single most reliable signal of what they actually want. If they say one game, ask for one more — single-reference art bibles converge into a clone of that game.

If they freeze, offer 4 axes (not games):

> Pick the one that feels right: a) painterly + warm + handcrafted (Sable, Tunic), b) crisp + saturated + toon (Hi-Fi Rush, Splatoon), c) dark + moody + grounded (Dishonored, Inside), d) lo-fi + nostalgic + crunchy (Dusk, Faith).

### 2. Read the brief if it exists

```
Read .summer/GameSoul.md
```

Brief might say "horror" — that constrains palette and lighting. Brief might say "cozy" — that *forbids* harsh contrast. Quote it back:

> Brief is "cozy farming sim". That rules out harsh shadows and saturated reds. Confirming.

### 3. Pin the rendering technique

This is the technique question, not the mood question. Force a choice:

| Technique | When | Pro | Con |
|---|---|---|---|
| Toon / cel-shaded | Stylized 3D, expressive characters | Forgiving on textures, ages well | Can feel generic without strong palette |
| PBR realistic | Grounded sim, horror, military | Lighting does the work | Asset cost is brutal solo |
| Lo-fi PS1 | Nostalgia, horror, indie cred | Tiny assets, fast iteration | Niche audience appeal |
| Flat / matte | Minimalist puzzle, casual | Cheapest to author | Limited mood range |
| Painterly (textured-shaded) | Story-led, fantasy | Distinctive | Requires consistent texture authoring |
| 2D pixel | Retro, platformer, RPG | Mature pipeline | Animation cost scales fast |
| 2D hand-drawn | Narrative, indie | Distinctive, expressive | Animation cost extreme |

Ask:

> One technique. Which is it?

If they pick more than one ("PBR characters in a toon world"), name the conflict and force a hierarchy:

> Mixed techniques rarely cohere. If you mean "stylized PBR with toon outlines" — that's one technique (PBR + post-process outline). If you mean "toon characters in a PBR world" — that's two, and they'll fight. Pick one as primary.

### 4. Build the palette

A palette is **6-15 colors** total. Not a vibe, not "warm tones" — actual hex codes. Force it.

Walk:

```
Primary background — what color does the screen mostly read as?
Secondary background — second most common?
Accent — what does the player's eye go to?
Warning / damage — what reads as bad?
Reward / pickup — what reads as good?
UI base — text, frames
UI emphasis — buttons, callouts
Skin / character — if applicable
```

State candidates as hex. For a "cozy farming" game:

```
#3a4a3a   primary BG (deep moss green)
#5e6f4f   secondary BG (sage)
#e6c068   accent (golden wheat)
#a83e3e   warning (warm red, not pure red)
#c8a268   reward (warm tan)
#1f1a16   UI base (warm near-black, NOT pure black)
#f4ecdf   UI text (cream, NOT pure white)
#e3b08a   skin warm
#a8784f   skin cool
```

Pure white (#ffffff) and pure black (#000000) are almost always wrong — they break the palette. Flag it if the user pitches them.

Ask:

> Palette above. Adjust any, or lock it?

### 5. Define the mood adjectives

Three to five adjectives. Concrete, not vague.

Bad: "cool, atmospheric, immersive."
Good: "soft, hand-warmed, slightly melancholic, golden-hour."

Ask:

> Three to five adjectives that aren't 'cool' or 'atmospheric'. Pick from concrete sensory words.

### 6. Write the lighting plan

State the plan in one block. For the current Summer Engine rendering stack:

```
Sun: DirectionalLight3D, color #fff2d9, energy 0.9, angle ~30° (warm low-angle)
Sky: ProceduralSkyMaterial, sky_top_color #6b88a3, sky_horizon_color #d8b88e
Ambient: AmbientLight #4a5570, energy 0.15
Indoor fills: OmniLight3D color #ffd9a8, energy 0.6, range 4m
NEVER: pure-white DirectionalLight, no ambient, hard cube shadows
```

For 2D:

```
Base: CanvasModulate #f4ecdf, gentle warm wash
Accent: PointLight2D for fireflies / lanterns, color from accent palette
NEVER: full-bright modulation, no soft falloff
```

### 7. Define post-processing rules

Summer Engine post stack: Glow, SDFGI, SSAO, SSR, Adjustments, Color Correction
(LUT). State opinions, not options.

```
Glow: ON, threshold 0.9, intensity 0.5  (soft bloom on highlights only)
SDFGI: OFF for vertical-slice scope (perf cost; bake light probes later)
SSAO: ON, light_affect 0.3 (just enough for grounding)
SSR: OFF unless we have wet/glass surfaces
Color correction: Filmic tonemap, slight S-curve LUT toward warm
Vignette (custom shader): ON, subtle, 0.15 strength
Chromatic aberration: OFF (overused, looks cheap)
Film grain: ON only if mood adjective is "lo-fi" or "vintage"
```

Make these calls. Don't enumerate options.

### 8. Build the do / don't list

This is the contract. Five do's, five don'ts. Specific, enforceable.

```markdown
## DO
- All colors come from the palette. New asset? Pick the closest existing color, don't invent.
- Outline shader on character + interactable props (no outline on environment).
- Soft shadows (DirectionalLight3D shadow_blur 1.5).
- Warm key + cool fill — never both warm or both cool.
- Texture filter: Linear with mipmaps OFF for crunchy near-pixel feel.

## DON'T
- No pure white (#ffffff). Use #f4ecdf.
- No pure black (#000000). Use #1f1a16.
- No realistic photo-textures. All textures must read as "painted" at 1m distance.
- No procedural sky shaders mid-day with full sun — too generic. Always angle the sun.
- No chromatic aberration / lens flare / motion blur — they're cheap and date-fast.
```

### 9. Apply Summer project-level settings

Some art-direction calls translate to `project.godot` settings. Apply them.

**Preferred (Summer MCP):**

```
summer_project_setting(key="rendering/textures/canvas_textures/default_texture_filter", value="2")  # Linear no mipmaps if pixel-art-ish
summer_project_setting(key="rendering/environment/defaults/default_clear_color", value="Color(0.227, 0.290, 0.227)")  # palette primary
summer_project_setting(key="rendering/anti_aliasing/quality/msaa_3d", value="2")  # MSAA 2x for clean edges
```

If a `WorldEnvironment` node is in the main scene, set its environment defaults to match the lighting plan:

```
summer_inspect_node(path="./World/WorldEnvironment")
summer_set_prop(path="./World/WorldEnvironment/...", key="...", value="...")
```

Ask before each:

> May I update `project.godot`'s default clear color to the palette primary, and enable MSAA 2x?

**Fallback (no MCP):** print the `project.godot` snippet for the user to paste.

### 10. Save the art bible

Always write the bible. Path: `.summer/art-bible.md`.

```markdown
# Art Bible — <Game Name>

**References:** <2-3 specific games / films>
**Technique:** <one of the 7 above>
**Mood:** <3-5 concrete adjectives>

## Palette
| Hex | Role |
|---|---|
| #3a4a3a | Primary BG |
| #5e6f4f | Secondary BG |
| ... | ... |

## Lighting plan
- Sun: DirectionalLight3D, color #fff2d9, energy 0.9
- Sky: ProceduralSkyMaterial top #6b88a3, horizon #d8b88e
- Ambient: #4a5570 energy 0.15
- Indoor fills: OmniLight3D color #ffd9a8 range 4m
- NEVER: pure-white sun, no ambient

## Post-processing
- Glow: ON, threshold 0.9
- SDFGI: OFF (vertical-slice scope)
- SSAO: ON, 0.3
- SSR: OFF
- Tonemap: Filmic
- Vignette: subtle 0.15
- Chromatic aberration: OFF

## DO
- ...

## DON'T
- ...
```

Ask:

> May I create `.summer/art-bible.md` with this bible?

### 11. Route to the next step

End with:

> Bible saved. Next:
> - `/audio-direction` to define the sonic identity that pairs with this look.
> - `/game-feel` to design particle / hit-feedback styles within the palette.
> - Open the project's `WorldEnvironment` node and dial in the lighting plan.
> - Or generate first-pass concept assets via `summer_generate_image` using the palette + mood as the prompt prefix.

## Common mistakes

| Mistake | Fix |
|---|---|
| Vague palette ("warm tones") | Hex codes only. 6-15 of them. Locked. |
| Pure white / pure black | Off-white (#f4ecdf) and off-black (#1f1a16). Pure values blow out the palette. |
| Single reference | At least two references. Single = clone. |
| Mixing techniques | Toon characters in a PBR world fight. Pick one technique, stick to it. |
| No "DON'T" list | The DON'T list is the actual contract. The DO is aspirational. |
| Chromatic aberration / motion blur | Cheap, overused, date-fast. Off by default. |
| Procedural skybox without angle | Mid-day sun + uniform fog reads generic. Always angle the sun. |
| Skipping the lighting plan | Lighting *is* art direction in 3D. Without a plan, every level looks different. |
| Adopting "AAA realism" at vertical-slice scope | Asset cost is brutal solo. Stylized always wins. |
| Calling SetResourceProperty before the property holds a resource | Explicit `resource is null` error, not a silent drop. Assign the resource first (`summer_set_prop key="environment" value="Environment"`), then set its sub-properties. Scene-embedded sub_resources are fully supported targets. |

## Collaborative protocol

This skill writes one design doc (`.summer/art-bible.md`) and may modify `project.godot` settings + the main scene's `WorldEnvironment`. Always ask.

## Want a working starter?

No template — this is a workflow that produces the bible the rest of the project obeys. After the bible exists, every Summer rendering / lighting / shader / VFX skill reads it.

## See also

- `scene-and-project/brainstorm-game/SKILL.md` — produces the brief that anchors the bible
- `audio/audio-direction/SKILL.md` — the sonic counterpart
- `rendering-and-lighting/3d-lighting/SKILL.md` — implements the lighting plan
- `shaders/shader-basics/SKILL.md` — for outline / toon shaders
- `post-processing/bloom-and-glow/SKILL.md` — implements the glow rule
- `post-processing/color-grading/SKILL.md` — implements the LUT and tonemap call
