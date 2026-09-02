---
name: ui-graphics
description: Use when generating UI elements — icons, buttons, panels, frames, HUD widgets, badges. Flat-design, transparent-background, game-UI style. Wires the result via TextureRect / NinePatchRect / AtlasTexture. Trigger on "UI icon", "button graphic", "HUD element", "panel frame", "menu background", "inventory slot", "ability icon", "badge".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: 2d-assets
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_generate_image summer_search_assets summer_import_from_url summer_set_resource_property summer_add_node summer_set_prop
paths: ["assets/**", "ui/**", "art/ui/**"]
---

# ui-graphics — Icons, Buttons, Panels, HUD

This skill generates flat game-UI graphics: icons, button states, panels,
frames, and HUD widgets. Output is **transparent PNG** by default and wires
through Summer Engine `TextureRect`, `NinePatchRect`, or `AtlasTexture` nodes.

UI graphics succeed or fail on **two specific things**: a clean transparent background (no checkerboard residue) and a consistent visual language across the set (all icons share line weight, color treatment, lighting). This skill encodes both.

## When to use

- "Generate a fire-spell icon for the ability bar."
- "I need a parchment panel background for the inventory."
- "Make a set of 8 status-effect icons (poison, burn, freeze, stun, ...)."
- "Create a button frame I can NinePatch."
- "HUD frame for the health bar."

## When NOT to use

- The user wants a character portrait → `character-portrait`.
- The user wants pixel-art UI → `pixel-art` (UI in pixel style needs a different prompt pattern).
- The user wants a 3D HUD element → that's a 3D mesh job; route to `asset-strategy`.
- The user wants a font → fonts aren't generated; use a `.ttf`/`.otf` and import via `FontFile`.

## Steps

### 1. Lock the UI style anchor

Check `.summer/ui-anchor.md`. If it doesn't exist, define it on the first UI asset and re-use:

```
## UI anchor

style: flat design with subtle gradient, soft inner shadow
line: 2px outline in deep navy (#1a2332)
fill palette: gold (#d4a24c), parchment (#f5e6c4), dark teal accent (#2c5f5d)
shape language: rounded rectangles, no sharp 90deg corners
mood: warm fantasy, slightly weathered
background: transparent PNG
```

Every icon / button / panel re-uses this anchor verbatim. Skipping this step produces the most common UI failure: 12 icons that all look like they came from 12 different games.

### 2. Search before generating

```
summer_search_assets(query="<subject> icon", assetType="2d_image", source="all")
```

### 3. Pick the right pattern (icon vs button vs panel)

`summer_generate_image` has no size or aspect argument — every MCP image comes back at the server's 1:1 default. Square suits icons, panels, and badges; for wide assets (buttons, HUD bar frames) describe the proportions in the prompt and crop after, or generate in the Summer dashboard where aspect ratio is exposed.

| Asset class | Framing | Wiring node | Notes |
|---|---|---|---|
| Icon (ability, item, status) | square (default) | `TextureRect` (or `AtlasTexture` if part of an icon sheet) | Centered subject, generous padding |
| Button (idle / hover / pressed) | wide — prompt for it, crop after | `Button` with custom theme OR `TextureButton` | Generate 3 variants of the same shape |
| Panel / frame (NinePatch-friendly) | square (default) | `NinePatchRect` | Border + center MUST be visually separable for 9-slicing |
| HUD bar frame | wide — prompt for it, crop after | `NinePatchRect` over `ProgressBar` | Frame only — bar fill is a separate gradient texture |
| Badge / emblem | square (default) | `TextureRect` | Symmetric, centered, no text |

### 4. Build the prompt — subject + anchor + transparent

Pattern:

```
<asset class> of <subject>, game UI, <anchor style>, flat design, clean edges, transparent background, centered, isolated
```

`isolated` is load-bearing. For the background, **do not rely on the prompt** — pass `options.removeBackground: true`, which runs a real background-removal pass after generation and returns a PNG with true alpha. That is the single highest-value argument in this skill, and it is the actual fix for the checkerboard failure listed below: models asked for a "transparent background" in text frequently paint the checkerboard.

### 5. Generate

**Icon example:**
```
summer_generate_image(
  prompt="ability icon for a fire spell, glowing flame in cupped hand, game UI, flat design with subtle gradient and soft inner shadow, 2px deep navy outline, gold and parchment palette, rounded square frame, centered, isolated on a plain background. Not photorealistic, no 3D render, no scene background, not busy, no multiple objects.",
  model="nano-banana-2",
  style="none",
  options={ removeBackground: true }
)
```

`image_size` and `negative_prompt` do not exist on this tool and are dropped without an error — the negations have to live in the prompt text, and the size is fixed. `removeBackground` is the one `options` key here that does real work.

**Button (3 states in 3 calls):**
```
summer_generate_image(prompt="<subject>, idle state, ...")
summer_generate_image(prompt="<subject>, hover state, slightly brighter glow, ...")
summer_generate_image(prompt="<subject>, pressed state, darker, slight inset shadow, ...")
```

**Panel for NinePatch:**
```
summer_generate_image(
  prompt="parchment scroll panel frame, ornate gold border, weathered tan center, clear distinction between border and center area, game UI, fantasy, transparent background, square format, centered",
  ...
)
```

The "clear distinction between border and center" is the NinePatch hint — without it, the border bleeds into the center and 9-slicing produces artifacts.

### 6. Import with transparency preserved

```
summer_import_from_url(url="<fileUrl>", path="res://ui/icons/fire_spell.png")
```

Verify in the import dock: `Mipmaps: off` (UI shouldn't mipmap), `Filter: Linear` for high-res UI (or `Nearest` if pixel-style).

### 7. Wire into the scene

Every scene-mutating tool takes an explicit `scenePath`, node paths are relative to that scene's root (`./`) rather than absolute `/root/...` runtime paths, and the property argument is named `key`, not `property`.

**Icon as TextureRect:**
```
summer_add_node(scenePath="res://ui/hud.tscn", parent="./AbilityBar", type="TextureRect", name="FireSpellIcon")
summer_set_prop(scenePath="res://ui/hud.tscn", path="./AbilityBar/FireSpellIcon", key="texture", value="res://ui/icons/fire_spell.png")
summer_set_prop(scenePath="res://ui/hud.tscn", path="./AbilityBar/FireSpellIcon", key="expand_mode", value=1)  # EXPAND_IGNORE_SIZE
summer_set_prop(scenePath="res://ui/hud.tscn", path="./AbilityBar/FireSpellIcon", key="stretch_mode", value=5)  # STRETCH_KEEP_ASPECT_CENTERED
```

**Panel as NinePatchRect:**
```
summer_add_node(scenePath="res://ui/hud.tscn", parent=".", type="NinePatchRect", name="InventoryPanel")
summer_set_prop(scenePath="res://ui/hud.tscn", path="./InventoryPanel", key="texture", value="res://ui/panels/parchment.png")
summer_set_prop(scenePath="res://ui/hud.tscn", path="./InventoryPanel", key="patch_margin_left", value=24)
summer_set_prop(scenePath="res://ui/hud.tscn", path="./InventoryPanel", key="patch_margin_right", value=24)
summer_set_prop(scenePath="res://ui/hud.tscn", path="./InventoryPanel", key="patch_margin_top", value=24)
summer_set_prop(scenePath="res://ui/hud.tscn", path="./InventoryPanel", key="patch_margin_bottom", value=24)
summer_save_scene(scenePath="res://ui/hud.tscn")
```

Tune patch margins to match the actual border width in the generated texture. Open the texture in the editor's NinePatch preview to verify.

**Multiple icons as AtlasTexture:**

If you generate a 4×4 grid of icons in one image, each icon becomes an `AtlasTexture` referencing the same source. Saves draw calls. Use a `Region` rect per icon.

## Prompt patterns

| Goal | Prompt that works | Why |
|---|---|---|
| Ability icon | `ability icon for <effect>, <visual metaphor>, game UI, flat design, 2px outline, <palette>, rounded square frame, transparent background, centered, isolated` | Visual metaphor (cupped hand, swirling vortex) reads better than abstract |
| Item icon (potion) | `inventory icon of red health potion, glass bottle with red liquid, cork stopper, game UI, flat design, soft inner shadow, transparent background, centered, isolated, three-quarter view` | Three-quarter beats pure front for items |
| Status icon (poison) | `status effect icon, green skull with dripping liquid, game UI, flat, bold silhouette readable at 32px, 2px outline, transparent background` | "Readable at 32px" forces bold silhouette |
| Button frame | `wooden button frame, ornate corners, slight bevel, game UI fantasy, transparent background, no text, no icon inside, just the empty frame` | "No text, no icon" prevents the model adding fake labels |
| NinePatch panel | `parchment panel frame, ornate gold border, weathered tan center, clear border-vs-center distinction, transparent background, square` | "Clear border-vs-center" enables 9-slicing |
| Badge / rank emblem | `gold rank emblem, laurel wreath, central star, symmetric, game UI heraldry style, transparent background, centered` | Symmetry + centered is critical for emblems |
| HUD health frame | `decorative frame for a horizontal health bar, ornate metal border, hollow center for the bar to show through, transparent background, landscape format` | "Hollow center" is the key for frame-over-bar |

### Bad prompts (and why)

| Bad | Failure mode |
|---|---|
| `cool button` | No subject, no anchor. Returns a generic button on a card background. |
| `transparent button with icon` | Model often renders a checkerboard "transparent" pattern as the actual fill. There is no negative-prompt argument to counter it — drop the word "transparent" from the prompt entirely and pass `options.removeBackground: true` instead. |
| `8 ability icons in one image` | Inconsistent style across the 8. Generate one at a time with the same anchor. |
| `realistic 3D rendered button` | Conflicts with flat-UI. Stay flat. |
| `button with the word "Play"` on it | Models render text badly. Add text in Summer Engine via a `Label` over the button, not in the texture. |

## Anti-patterns

- **Skipping the anchor.** A 12-icon ability bar with no anchor looks like 12 unrelated games. Define the anchor on icon #1.
- **Letting the model render text.** Diffusion models cannot render reliable
  text. Always overlay text in Summer Engine with a `Label` node. The button
  texture is the frame; the label is the word.
- **Forgetting `options.removeBackground: true`.** Default is opaque. Prompting for "transparent background" instead is what produces the painted-checkerboard failure below — the option runs a real alpha pass and does not.
- **Expecting `style` to do the work.** Only `cartoon` and `anime` append anything; `realistic` and `none` append nothing, and any other value is coerced to `none`. `style: "none"` is right for UI, but "flat design" has to be in the prompt regardless.
- **NinePatch with no border-vs-center distinction.** The 9-slice scaling smears the border into the center.
- **Mipmaps on UI.** UI textures shouldn't mipmap — they're displayed at 1:1 or near it. Mipmaps waste memory and blur sharp edges.

## Edge cases

- **User wants the same icon at multiple sizes (32, 64, 128).** Generate once
  at high resolution. Summer Engine's `TextureRect` with
  `STRETCH_KEEP_ASPECT_CENTERED` scales it down cleanly.
- **User wants pixel-style UI.** Route to `pixel-art` — different prompt pattern, different filter, different anchor.
- **User wants animated UI (spinning loading icon).** Generate the static frame here. Animate via `AnimationPlayer` rotating the `TextureRect`, not as a sprite sheet.
- **Transparency comes back as a checkerboard pattern in the image.** The model rendered the checkerboard literally because the prompt asked for transparency. Remove every mention of transparency from the prompt, generate on a plain background, and pass `options.removeBackground: true` to cut the alpha server-side.
- **Icons need to read at very small size (16-24px in a packed bar).** Bias prompts toward bold silhouette + minimal interior detail. Ornate detail is invisible at 16px and adds noise.

## Fallback (no MCP)

Print the call:

```
summer_generate_image(
  prompt="<asset + anchor>, isolated on a plain background. No scene background, not photorealistic, no 3D, not busy.",
  model="nano-banana-2",
  style="none",
  options={ removeBackground: true }
)
```

User runs via the Summer dashboard, then `summer_import_from_url` to `res://ui/icons/<name>.png` and wires manually.

## Handoff

After the UI graphic is wired:

- **More icons in the same set** → re-invoke this skill with the same anchor.
- **Button states (hover/pressed)** → re-invoke for each state.
- **Theme assembly (combining icons + panels into a Summer Engine Theme
  resource)** → `scene-composition` for the resource wiring.
- **Pixel-art UI** → `pixel-art`.
- **Dialogue UI with portraits** → `character-portrait` for the portrait, then back here for the surrounding panel.

## See also

- `character-portrait` — for in-UI character images.
- `pixel-art` — pixel-style UI.
- `scene-composition` — Theme and Control hierarchy.
- `../../references/mcp-tools-reference/mcp-tools-reference.md` — `summer_generate_image` schema.
