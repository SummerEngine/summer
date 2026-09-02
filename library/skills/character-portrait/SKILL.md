---
name: character-portrait
description: Use when generating a single, polished bust/portrait of a character for dialogue UI, character-select screens, lore cards, or codex entries. One character, locked composition, VN-style. Trigger on "character portrait", "dialogue portrait", "VN portrait", "character bust", "headshot", "character select image", "lore card art".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: 2d-assets
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_generate_image summer_search_assets summer_import_from_url summer_set_resource_property
paths: ["assets/**", "art/portraits/**", "ui/portraits/**"]
---

# character-portrait — Locked Bust for Dialogue UI

This skill produces ONE polished character portrait — bust or shoulders-up framing, neutral or stylized background, designed to drop into a dialogue UI, character-select screen, or lore card. It is the **opposite** of `concept-art`: concept art explores; this skill commits.

The single biggest failure mode is **inconsistency across a cast**. Generating five party members one at a time without a locked anchor produces five images that look like they're from five different games — different lighting, different angle, different palette, different rendering style. This skill makes you write a **locked anchor suffix** the first time and re-use it verbatim for every subsequent portrait.

If the user is still exploring the look, this is the wrong skill — route to `concept-art` first, lock a direction, then come back here. The `asset-strategy` meta-router asks **"Quick check — exploring the look (3-4 variants for art direction) or generating a final character portrait for dialogue UI?"** to disambiguate.

## When to use

- "Generate a portrait for the merchant NPC."
- "I need a character-select image for the four playable heroes."
- "Make a lore-card image of the king."
- "Add a VN-style dialogue portrait for Aria."
- The cast is locked and the visual direction is locked; you're producing finals.

## When NOT to use

- The user is still exploring → `concept-art`.
- The user wants pixel art → `pixel-art`.
- The user wants a full-body 3D model → `asset-strategy`.
- The user wants 4+ animated expressions of the same character — generate one base portrait here, then use img2img with the base as `referenceImageUrl` for each expression.

## Steps

### 1. Read or establish the locked anchor

Check `.summer/portrait-anchor.md` first.

```
Read .summer/portrait-anchor.md
```

If it doesn't exist, this is the first portrait in the cast — you must define the anchor now. Ask the user (or infer from `.summer/GameSoul.md`):

- **Framing:** bust (chest up) or shoulders-up?
- **Angle:** straight-on, three-quarter left, three-quarter right?
- **Lighting:** soft front, dramatic side, rim-lit, golden-hour?
- **Background:** flat color, soft gradient, painterly blur, in-world environment?
- **Rendering style:** painterly, anime, semi-realistic, line-art-with-flat-color?

Write the anchor to `.summer/portrait-anchor.md`:

```
## Portrait anchor (re-use verbatim for every cast member)

framing: bust, shoulders to crown of head visible
angle: three-quarter view, slight turn to character's left
lighting: soft warm key from upper right, cool fill from left, gentle rim
background: muted painterly gradient, dark teal to deep brown, no scene detail
style: semi-realistic painterly, soft edges, oil-painting feel
```

Note there is no aspect line. `summer_generate_image` has no size or aspect argument — every MCP image comes back at the server's 1:1 default. Bust framing reads fine square, which is why this skill works over MCP at all; if the cast needs true portrait framing, generate in the Summer dashboard (which exposes aspect ratio) and bring the results back with `summer_import_from_url`, or crop after. Whichever you pick, do it for the *whole* cast — mixed aspect is as visible as mixed lighting.

Every subsequent portrait in this cast appends the anchor to the prompt verbatim. **Do not edit the anchor mid-cast** unless the user explicitly says "I want the new ones to look different."

### 2. Search for an existing portrait

```
summer_search_assets(query="<character name> portrait", assetType="2d_image", source="all")
```

Reuse beats regenerate. If the user wants to iterate on an existing one, pull its URL and pass it as `referenceImageUrl` for img2img.

### 3. Build the prompt — character + anchor

Pattern:

```
<character description>. <anchor framing/angle/lighting/background/style>
```

The character description should include: identity (age, build, hair, distinctive features), expression, costume/equipment, any signature prop. Keep it under 60 words including the anchor.

### 4. Confirm and call

> Generating Aria the witch portrait — 1 image, ~$0.02, model nano-banana-2, anchor locked from `.summer/portrait-anchor.md`. OK?

```
summer_generate_image(
  prompt="Aria, young witch, mid-twenties, pale skin, long black hair with silver streak, sharp green eyes, half-smile, wearing dark indigo robes with silver embroidery, raven on shoulder. <anchor verbatim>",
  model="nano-banana-2",
  style="none"
)
```

`style: "none"` because the anchor's "semi-realistic painterly" already specifies style. Be clear about what the preset actually does though: only `cartoon` and `anime` append anything to the prompt, and `realistic` / `none` append nothing — any other value is coerced to `none`. So the preset cannot "fight" a painterly anchor; it just does nothing either way, and every bit of the look has to be in the prompt.

`options={ image_size: ... }` is dropped without an error — see the anchor note above.

### 5. Import and wire into UI

```
summer_import_from_url(
  url="<fileUrl from generation>",
  path="res://ui/portraits/aria.png"
)
```

For dialogue UI nodes, wire the texture into a `TextureRect`:

```
summer_set_prop(
  scenePath="res://ui/dialogue.tscn",
  path="./DialogueBox/PortraitRect",
  key="texture",
  value="res://ui/portraits/aria.png"
)
```

`texture` is a property on the node, so this is `summer_set_prop` — which needs an explicit `scenePath`, a node path relative to that scene's root (`./`), and a `key` argument, not `property`. `summer_set_resource_property` is for reaching one level *inside* a resource the node already holds and requires all five of `scenePath`, `nodePath`, `resourceProperty`, `subProperty`, `value`.

For character-select with multiple portraits, name files consistently: `aria.png`, `borin.png`, `cael.png`, `dara.png`. Index-able from code via `"res://ui/portraits/%s.png" % character_id`.

### 6. Iterate (img2img) instead of regenerating from scratch

If the user wants the portrait tweaked ("smaller smile", "darker robes"), use img2img with the existing image as `referenceImageUrl`. Preserves identity and lighting.

```
summer_generate_image(
  prompt="<original prompt> with a smaller, more subtle smile",
  referenceImageUrl="<previous fileUrl>",
  model="nano-banana-2",
  style="none"
)
```

## Prompt patterns

| Goal | Prompt skeleton (subject part only — append anchor verbatim) | Why |
|---|---|---|
| Generic NPC | `<name>, <age> <build>, <hair>, <eyes>, <expression>, wearing <costume>` | Identity-first; no scene context |
| Hero / protagonist | `<name>, <age> <build>, <hair>, <distinctive feature>, confident <expression>, wearing <signature outfit>, holding <signature prop>` | Adds prop for memorability |
| Antagonist | `<name>, <imposing detail>, <unsettling expression>, wearing <costume with menacing detail>, <signature scar/mark>` | Antagonists need visual asymmetry |
| Lore card / king | `<name>, <age>, regal <expression>, wearing <ornate detail>, <crown/insignia>, formal portrait pose` | Formal pose overrides anchor's three-quarter |
| Expression variant | `<previous prompt> with <new expression: angry / surprised / sad / laughing>` + `referenceImageUrl: <base portrait>` | img2img preserves identity |
| Younger / older variant | `<character> as a <child / elder>` + `referenceImageUrl: <base>` | For flashback / time-skip portraits |

### Bad prompts (and why)

| Bad | Failure mode |
|---|---|
| `cool warrior portrait` | No identity, no anchor. Returns generic stock art. |
| `the witch but make her sad` (no img2img ref) | Without `referenceImageUrl`, you get a *different* witch who is sad. Identity drift. |
| Anchor inconsistent across cast | Each portrait looks like a different game. The cast doesn't read as a cast. |
| `full body portrait` | "Portrait" implies bust. If you want full body, say so explicitly in the prompt — there is no size argument to reframe with, and full body in a square frame is a different asset class anyway; consider `concept-art` or the 3D pipeline. |
| `transparent background` for a painterly portrait | Painterly + transparent fails on most models. Use a flat or gradient background, then alpha-cut in an editor if you must. |

## Anti-patterns

- **No anchor file.** Every cast member generated ad-hoc looks unrelated. Define the anchor on portrait #1, re-use for the rest of the cast.
- **Editing the anchor mid-cast.** If you change lighting from "warm key" to "dramatic side" halfway through, the cast splits visually. Either commit to the change and regenerate everyone, or stick with the anchor.
- **Regenerating from scratch when img2img would do.** Identity drifts every regen. Iterate via `referenceImageUrl`.
- **Using the portrait as a 3D reference.** Portraits have dramatic lighting, painterly backgrounds, and cropped framing — all of which corrupt 3D generation. For 3D, generate a separate clean white-bg full-body T-pose via `asset-strategy`.
- **Expecting `style` to carry the look.** Only `cartoon` and `anime` append anything; `realistic` and `none` append nothing and any other value is coerced to `none`. If the anchor names the style, `"none"` is correct — but the anchor text is doing all the work, not the preset.

## Edge cases

- **Character has a non-human silhouette (lizardfolk, demon, robot).** The anchor still applies — framing, lighting, background, rendering style. Only the subject description changes. Verify the model can hold the silhouette under "bust framing" — some models default to humanoid.
- **Player wants to swap costumes mid-game.** Generate one base portrait per costume (`aria_traveler.png`, `aria_robes.png`, `aria_armored.png`) and switch by index. Use img2img from the base for consistency.
- **Cast of 12+ characters.** Anchor discipline gets harder as fatigue sets in. Print the anchor as a header in your generation script and don't write any prompt without it.
- **User wants the portrait to "read at small size" (32×32 in a portrait list).** That's pixel-art territory; route to `pixel-art`.

## Fallback (no MCP)

Print the prompt and the call:

```
summer_generate_image(prompt="<character + anchor>", model="nano-banana-2", style="none")
```

Tell the user to run via the Summer dashboard, then `summer_import_from_url` the result to `res://ui/portraits/<name>.png`.

## Handoff

After the portrait is wired:

- **More cast members** → re-invoke this skill with the same anchor. Don't redefine.
- **Expression variants** → re-invoke with `referenceImageUrl` set to the base portrait.
- **Pixel-art version of the same character** → `pixel-art`.
- **3D model of the same character** → `asset-strategy` (the portrait is NOT a usable 3D reference; generate a separate T-pose).
- **Dialogue system wiring** → `scene-composition` for the UI hierarchy.

## See also

- `concept-art` — explore the look first if not yet locked.
- `asset-strategy` — meta-router and the 3D pipeline.
- `scene-composition` — wiring the portrait into a dialogue UI scene.
- `../../references/mcp-tools-reference/mcp-tools-reference.md` — `summer_generate_image` parameter schema.
