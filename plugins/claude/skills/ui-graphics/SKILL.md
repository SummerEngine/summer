---
name: ui-graphics
description: "Generate game UI art (icons, buttons, panels, frames, HUD widgets) flat, on a transparent background."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: 2d-assets
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_assets_generate_image summer_assets_search summer_import_from_url summer_set_resource_property summer_add_node summer_set_prop summer_call
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
assets.search({ query: "<subject> icon", assetType: "2d_image", scope: "all" })
```

### 3. Pick the right pattern (icon vs button vs panel)

`assets.generate_image` takes `aspectRatio` (`1:1` default, `16:9`, `21:9`, `3:2`, `4:3`, ...) and, for a minimum size, `width` and `height`. Square suits icons, panels, and badges; wide assets (buttons, HUD bar frames) get a wide `aspectRatio`.

| Asset class | Framing | Wiring node | Notes |
|---|---|---|---|
| Icon (ability, item, status) | square (default) | `TextureRect` (or `AtlasTexture` if part of an icon sheet) | Centered subject, generous padding |
| Button (idle / hover / pressed) | wide — `aspectRatio: "3:2"` or `"21:9"` | `Button` with custom theme OR `TextureButton` | Generate 3 variants of the same shape |
| Panel / frame (NinePatch-friendly) | square (default) | `NinePatchRect` | Border + center MUST be visually separable for 9-slicing |
| HUD bar frame | wide — `aspectRatio: "21:9"` | `NinePatchRect` over `ProgressBar` | Frame only — bar fill is a separate gradient texture |
| Badge / emblem | square (default) | `TextureRect` | Symmetric, centered, no text |

### 4. Build the prompt — subject + anchor + transparent

Pattern:

```
<asset class> of <subject>, game UI, <anchor style>, flat design, clean edges, transparent background, centered, isolated
```

`isolated` is load-bearing. For the background, **do not rely on the prompt** — pass `removeBackground: true`, which runs a real background-removal pass after generation and returns a PNG with true alpha. That is the single highest-value argument in this skill, and it is the actual fix for the checkerboard failure listed below: models asked for a "transparent background" in text frequently paint the checkerboard.

### 5. Generate

**Icon example:**
```
assets.generate_image({
  prompt: "ability icon for a fire spell, glowing flame in cupped hand, game UI, flat design with subtle gradient and soft inner shadow, 2px deep navy outline, gold and parchment palette, rounded square frame, centered, isolated on a plain background. Not photorealistic, no 3D render, no scene background, not busy, no multiple objects.",
  model: "nano-banana-2",
  style: "none",
  removeBackground: true
})
```

There is no `negative_prompt`: the negations have to live in the prompt text.

**Button (3 states in 3 calls):**
```
assets.generate_image({ prompt: "<subject>, idle state, ...", aspectRatio: "3:2" })
assets.generate_image({ prompt: "<subject>, hover state, slightly brighter glow, ...", aspectRatio: "3:2" })
assets.generate_image({ prompt: "<subject>, pressed state, darker, slight inset shadow, ...", aspectRatio: "3:2" })
```

**Panel for NinePatch:**
```
assets.generate_image({
  prompt: "parchment scroll panel frame, ornate gold border, weathered tan center, clear distinction between border and center area, game UI, fantasy, transparent background, square format, centered",
  ...
})
```

The "clear distinction between border and center" is the NinePatch hint — without it, the border bleeds into the center and 9-slicing produces artifacts.

### 6. Import with transparency preserved

```
summer_import_from_url(url="<fileUrl>", path="res://ui/icons/fire_spell.png")
```

Verify in the import dock: `Mipmaps: off` (UI shouldn't mipmap), `Filter: Linear` for high-res UI (or `Nearest` if pixel-style).

### 7. Wire into the scene

One `summer_run_script` call wires each graphic with its settings; `scenePath` is the exact scene to change.

**Icon as TextureRect:**
```
summer_run_script(scenePath="res://ui/hud.tscn", source="""
func run(ctx):
    ctx.add_node("TextureRect", "FireSpellIcon", ctx.find("AbilityBar"), {
        "texture": load("res://ui/icons/fire_spell.png"),
        "expand_mode": TextureRect.EXPAND_IGNORE_SIZE,
        "stretch_mode": TextureRect.STRETCH_KEEP_ASPECT_CENTERED,
    })
    ctx.save_scene()
""")
```

**Panel as NinePatchRect:**
```
summer_run_script(scenePath="res://ui/hud.tscn", source="""
func run(ctx):
    var panel = ctx.add_node("NinePatchRect", "InventoryPanel", null, {"texture": load("res://ui/panels/parchment.png")})
    for side in ["patch_margin_left", "patch_margin_right", "patch_margin_top", "patch_margin_bottom"]:
        panel.set(side, 24)
    ctx.save_scene()
""")
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
| `transparent button with icon` | Model often renders a checkerboard "transparent" pattern as the actual fill. There is no negative-prompt argument to counter it — drop the word "transparent" from the prompt entirely and pass `removeBackground: true` instead. |
| `8 ability icons in one image` | Inconsistent style across the 8. Generate one at a time with the same anchor. |
| `realistic 3D rendered button` | Conflicts with flat-UI. Stay flat. |
| `button with the word "Play"` on it | Models render text badly. Add text in Summer Engine via a `Label` over the button, not in the texture. |

## Anti-patterns

- **Skipping the anchor.** A 12-icon ability bar with no anchor looks like 12 unrelated games. Define the anchor on icon #1.
- **Letting the model render text.** Diffusion models cannot render reliable
  text. Always overlay text in Summer Engine with a `Label` node. The button
  texture is the frame; the label is the word.
- **Forgetting `removeBackground: true`.** Default is opaque. Prompting for "transparent background" instead is what produces the painted-checkerboard failure below — the option runs a real alpha pass and does not.
- **Expecting `style` to do the work.** Only `cartoon` and `anime` append anything; `realistic` and `none` append nothing, and any other value is coerced to `none`. `style: "none"` is right for UI, but "flat design" has to be in the prompt regardless.
- **NinePatch with no border-vs-center distinction.** The 9-slice scaling smears the border into the center.
- **Mipmaps on UI.** UI textures shouldn't mipmap — they're displayed at 1:1 or near it. Mipmaps waste memory and blur sharp edges.

## Edge cases

- **User wants the same icon at multiple sizes (32, 64, 128).** Generate once
  at high resolution. Summer Engine's `TextureRect` with
  `STRETCH_KEEP_ASPECT_CENTERED` scales it down cleanly.
- **User wants pixel-style UI.** Route to `pixel-art` — different prompt pattern, different filter, different anchor.
- **User wants animated UI (spinning loading icon).** Generate the static frame here. Animate via `AnimationPlayer` rotating the `TextureRect`, not as a sprite sheet.
- **Transparency comes back as a checkerboard pattern in the image.** The model rendered the checkerboard literally because the prompt asked for transparency. Remove every mention of transparency from the prompt, generate on a plain background, and pass `removeBackground: true` to cut the alpha server-side.
- **Icons need to read at very small size (16-24px in a packed bar).** Bias prompts toward bold silhouette + minimal interior detail. Ornate detail is invisible at 16px and adds noise.

## Without Summer Engine

In a session without Summer Engine tools (the assets profile; the `summer-assets` skill has the whole loop), do steps 1-5 and skip steps 6-7 (import, scene wiring). Pass `out` with the person's folder so each PNG lands there (the `summer-assets` skill says how); keep `removeBackground: true` for icons and buttons that need transparency.

## Fallback (no MCP)

Print the call:

```
assets.generate_image({
  prompt: "<asset + anchor>, isolated on a plain background. No scene background, not photorealistic, no 3D, not busy.",
  model: "nano-banana-2",
  style: "none",
  removeBackground: true
})
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
- `summer_docs_read` id `reference/mcp-tools-reference` — how to call `assets.generate_image`.

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@4.9.0` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `assets.generate_image`, `summer_assets_generate_image` | `summer assets generate-image` |
| `summer_assets_search` | `summer assets search` |
| `summer_docs_read` | `summer docs read` |
| `summer_add_node` | `summer engine add-node` |
| `summer_import_from_url` | `summer engine import-from-url` |
| `summer_run_script` | `summer engine run-script` |
| `summer_set_prop` | `summer engine set-prop` |
| `summer_set_resource_property` | `summer engine set-resource-property` |
<!-- /shell-commands -->
