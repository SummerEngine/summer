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

This skill generates flat, game-UI-style graphics: icons (skill / item / status), buttons (idle / hover / pressed states), panels and frames (NinePatch-friendly), HUD widgets (health frames, minimaps, badges). Output is **transparent PNG** by default and wires via Godot's `TextureRect`, `NinePatchRect`, or `AtlasTexture`.

UI graphics succeed or fail on **two specific things**: a clean transparent background (no checkerboard residue) and a consistent visual language across the set (all icons share line weight, color treatment, lighting). This skill encodes both.

## When to use

- "Generate a fire-spell icon for the ability bar."
- "I need a parchment panel background for the inventory."
- "Make a set of 8 status-effect icons (poison, burn, freeze, stun, ...)."
- "Create a button frame I can NinePatch."
- "HUD frame for the health bar."

## When NOT to use

- The user wants a character portrait → `summer:2d-assets/character-portrait`.
- The user wants pixel-art UI → `summer:2d-assets/pixel-art` (UI in pixel style needs a different prompt pattern).
- The user wants a 3D HUD element → that's a 3D mesh job; route to `summer:asset-pipeline/asset-strategy`.
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
summer_search_assets(query="<subject> icon", filter={ kind: "image" })
```

### 3. Pick the right pattern (icon vs button vs panel)

| Asset class | Image size | Wiring node | Notes |
|---|---|---|---|
| Icon (ability, item, status) | `square_hd` | `TextureRect` (or `AtlasTexture` if part of an icon sheet) | Centered subject, generous padding |
| Button (idle / hover / pressed) | `landscape_4_3` | `Button` with custom theme OR `TextureButton` | Generate 3 variants of the same shape |
| Panel / frame (NinePatch-friendly) | `square_hd` | `NinePatchRect` | Border + center MUST be visually separable for 9-slicing |
| HUD bar frame | `landscape_16_9` | `NinePatchRect` over `ProgressBar` | Frame only — bar fill is a separate gradient texture |
| Badge / emblem | `square_hd` | `TextureRect` | Symmetric, centered, no text |

### 4. Build the prompt — subject + anchor + transparent

Pattern:

```
<asset class> of <subject>, game UI, <anchor style>, flat design, clean edges, transparent background, centered, isolated
```

`transparent background` and `isolated` are the load-bearing words. Without them, you get a square card with a textured background that defeats the purpose.

### 5. Generate

**Icon example:**
```
summer_generate_image(
  prompt="ability icon for a fire spell, glowing flame in cupped hand, game UI, flat design with subtle gradient and soft inner shadow, 2px deep navy outline, gold and parchment palette, rounded square frame, transparent background, centered, isolated",
  model="nano-banana-2",
  style="none",
  options={ image_size: "square_hd", negative_prompt: "photorealistic, 3D render, scene background, busy, multiple objects" }
)
```

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

**Icon as TextureRect:**
```
summer_add_node(parentPath="/root/UI/AbilityBar", type="TextureRect", name="FireSpellIcon")
summer_set_prop(path="/root/UI/AbilityBar/FireSpellIcon", property="texture", value="res://ui/icons/fire_spell.png")
summer_set_prop(path="/root/UI/AbilityBar/FireSpellIcon", property="expand_mode", value=1)  # KEEP_SIZE → 1 = STRETCH
summer_set_prop(path="/root/UI/AbilityBar/FireSpellIcon", property="stretch_mode", value=5)  # KEEP_ASPECT_CENTERED
```

**Panel as NinePatchRect:**
```
summer_add_node(parentPath="/root/UI", type="NinePatchRect", name="InventoryPanel")
summer_set_prop(path="/root/UI/InventoryPanel", property="texture", value="res://ui/panels/parchment.png")
summer_set_prop(path="/root/UI/InventoryPanel", property="patch_margin_left", value=24)
summer_set_prop(path="/root/UI/InventoryPanel", property="patch_margin_right", value=24)
summer_set_prop(path="/root/UI/InventoryPanel", property="patch_margin_top", value=24)
summer_set_prop(path="/root/UI/InventoryPanel", property="patch_margin_bottom", value=24)
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
| `transparent button with icon` (no negative prompt) | Model often renders a checkerboard "transparent" pattern as the actual fill. Add `no checkerboard pattern` to negative. |
| `8 ability icons in one image` | Inconsistent style across the 8. Generate one at a time with the same anchor. |
| `realistic 3D rendered button` | Conflicts with flat-UI. Stay flat. |
| `button with the word "Play"` on it | Models render text badly. Add text in Godot via a `Label` over the button, not in the texture. |

## Anti-patterns

- **Skipping the anchor.** A 12-icon ability bar with no anchor looks like 12 unrelated games. Define the anchor on icon #1.
- **Letting the model render text.** Diffusion models can't render reliable text. Always overlay text in Godot via a `Label` node. The button texture is the frame; the label is the word.
- **Forgetting `transparent background` in the prompt.** Default is opaque. Without the keyword, you import an icon with a 200×200 white square around the actual icon.
- **Using `style: "realistic"` for UI.** UI is flat. `style: "none"` lets the prompt's "flat design" land cleanly.
- **NinePatch with no border-vs-center distinction.** The 9-slice scaling smears the border into the center.
- **Mipmaps on UI.** UI textures shouldn't mipmap — they're displayed at 1:1 or near it. Mipmaps waste memory and blur sharp edges.

## Edge cases

- **User wants the same icon at multiple sizes (32, 64, 128).** Generate once at high res. Godot's `TextureRect` with `STRETCH_KEEP_ASPECT_CENTERED` scales it down cleanly. Don't generate three sizes.
- **User wants pixel-style UI.** Route to `summer:2d-assets/pixel-art` — different prompt pattern, different filter, different anchor.
- **User wants animated UI (spinning loading icon).** Generate the static frame here. Animate via `AnimationPlayer` rotating the `TextureRect`, not as a sprite sheet.
- **Transparency comes back as a checkerboard pattern in the image.** The model rendered the checkerboard literally. Regenerate with `no checkerboard pattern, true alpha transparency` in the negative prompt.
- **Icons need to read at very small size (16-24px in a packed bar).** Bias prompts toward bold silhouette + minimal interior detail. Ornate detail is invisible at 16px and adds noise.

## Fallback (no MCP)

Print the call:

```
summer_generate_image(
  prompt="<asset + anchor + transparent>",
  model="nano-banana-2",
  style="none",
  options={ image_size: "square_hd", negative_prompt: "scene background, photorealistic, 3D, busy" }
)
```

User runs via the Summer dashboard, then `summer_import_from_url` to `res://ui/icons/<name>.png` and wires manually.

## Handoff

After the UI graphic is wired:

- **More icons in the same set** → re-invoke this skill with the same anchor.
- **Button states (hover/pressed)** → re-invoke for each state.
- **Theme assembly (combining icons + panels into a Godot Theme resource)** → `summer:scene-composition` for the Theme resource wiring.
- **Pixel-art UI** → `summer:2d-assets/pixel-art`.
- **Dialogue UI with portraits** → `summer:2d-assets/character-portrait` for the portrait, then back here for the surrounding panel.

## See also

- `summer:2d-assets/character-portrait` — for in-UI character images.
- `summer:2d-assets/pixel-art` — pixel-style UI.
- `summer:scene-composition` — Theme and Control hierarchy.
- `_shared/mcp-tools-reference.md` — `summer_generate_image` schema.
