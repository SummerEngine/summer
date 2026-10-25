---
name: ui-basics
description: "Build UI: HUDs, menus, health bars, dialogue boxes, Control trees, anchors, containers and themes."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: ui-and-ux
user-invocable: false
allowed-tools: Read Grep summer_run_script summer_add_node summer_set_prop summer_connect_signal summer_save_scene
paths: ["**/*.tscn", "**/*.gd"]
---

# UI Basics for Summer Engine

Build menus and HUDs using Summer Engine Control nodes. Follow these patterns
for layout, buttons, and responsive design.

## Control Hierarchy

Use containers for layout, then add content nodes:

```
Control or CanvasLayer (root)
└── MarginContainer
    └── VBoxContainer (or HBoxContainer)
        ├── Label
        ├── Button
        ├── Button
        └── ProgressBar
```

## Common Containers

| Container | Use |
|-----------|-----|
| MarginContainer | Padding from edges |
| VBoxContainer | Stack vertically |
| HBoxContainer | Stack horizontally |
| CenterContainer | Center child |
| GridContainer | Grid layout |

## Basic Menu

A menu is a dozen nodes: build it in one `summer_run_script` call (one undo
step), never as a chain of `summer_add_node` / `summer_set_prop` calls.

```
summer_run_script(scenePath="res://main.tscn", source="""
func run(ctx):
    var menu = ctx.add_node("Control", "MainMenu")
    menu.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
    var margin = ctx.add_node("MarginContainer", "Margin", menu)
    margin.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
    for side in ["margin_left", "margin_right", "margin_top", "margin_bottom"]:
        margin.add_theme_constant_override(side, 50)
    var column = ctx.add_node("VBoxContainer", "VBox", margin)
    ctx.add_node("Label", "Title", column, {"text": "My Game"})
    ctx.add_node("Button", "StartButton", column, {"text": "Start Game"})
    ctx.add_node("Button", "QuitButton", column, {"text": "Quit"})
    ctx.save_scene()
""")
```

Container margins are theme constants, not plain properties: set them with
`add_theme_constant_override` as above. `set_anchors_and_offsets_preset` pins
a Control the way the editor's layout menu does.

## HUD (Health Bar)

```
summer_run_script(scenePath="res://main.tscn", source="""
func run(ctx):
    var hud = ctx.add_node("CanvasLayer", "HUD")
    var top_left = ctx.add_node("MarginContainer", "TopLeft", hud)
    top_left.set_anchors_and_offsets_preset(Control.PRESET_TOP_LEFT)
    var row = ctx.add_node("HBoxContainer", "HealthContainer", top_left)
    ctx.add_node("Label", "HealthLabel", row, {"text": "Health:"})
    ctx.add_node("ProgressBar", "HealthBar", row, {
        "max_value": 100.0,
        "value": 100.0,
        "custom_minimum_size": Vector2(200, 20),   # a container sets size; ask for a minimum
    })
    ctx.save_scene()
""")
```

ProgressBar uses `value` and `max_value` for the fill. Update `value` from a script when health changes.

## Anchors Preset

Common preset values in the current Summer Engine UI API:

| Preset | Value | Description |
|--------|-------|-------------|
| Top Left | 0 | Anchor to top-left |
| Top Right | 1 | Anchor to top-right |
| Bottom Left | 2 | Anchor to bottom-left |
| Bottom Right | 3 | Anchor to bottom-right |
| Full Rect | 15 | Stretch to fill parent |

Set via `summer_set_prop(scenePath, path, key="anchors_preset", value="15")`.

## Connecting Buttons

Wire the `pressed` signal to a handler:

```
summer_connect_signal(scenePath="res://main.tscn", emitter="./MainMenu/Margin/VBox/StartButton", signal="pressed", receiver="./MainMenu", method="_on_start_pressed")
```

`scenePath` is required on every scene tool in this skill
(`summer_run_script`, `summer_set_prop`, `summer_connect_signal`,
`summer_save_scene`); the examples use `res://main.tscn`. A call without it is
rejected before it reaches the engine.

The receiver node must have a script with `func _on_start_pressed() -> void:`.

## Property Reference

| Node | Property | Example |
|------|----------|---------|
| Label | text | `"Score: 0"` |
| Button | text | `"Start"` |
| ProgressBar | value | `75` |
| ProgressBar | max_value | `100` |
| Control | size | `"Vector2(200, 50)"` |
| Control | anchors_preset | `15` |
| Control | custom_minimum_size | `"Vector2(100, 30)"` |

## Responsive Layout

For UI that scales with window size:
1. Use `anchors_preset` to anchor to corners or edges
2. Use `size_flags_horizontal` and `size_flags_vertical` on children (SIZE_EXPAND_FILL, etc.)
3. MarginContainer with percentage-based margins (may need theme or script)

For simple cases, CenterContainer + fixed-size children works. For complex layouts, a Theme resource or script may be needed.

## Text, fonts and symbols

The default font only has letters, digits and common punctuation. Anything else renders as an empty box with a hex code in it (for example a box reading `25 B2` for ▲, or `25 C0` for ◀), and on the web there is no system font to fall back to.

- Never put emoji or Unicode symbols in Label, Button or RichTextLabel text: arrows (▲ ▼ ◀ ▶ ← →), stars, hearts, check marks, music notes, keycap symbols. Write the words instead ("Up", "Next"), or show an icon.
- Draw icons as nodes: a TextureRect with a small texture, a Polygon2D triangle for arrows, or a `_draw()` shape. Key prompts are a rounded StyleBoxFlat panel with the key's letter in it.
- If the game really needs symbols or another script (Japanese, Arabic, Cyrillic), add a font file that contains them: import a TTF/OTF that covers the characters, set it as the theme's default font, and add it to the fallbacks of any other font you use.
- Never use `SystemFont` for text players see on iPhone or Android, not even as a fallback: in the Summer Games app on iPhone it has no system fonts and draws every glyph as a box, while desktop looks fine. Import a TTF/OTF into the project, and fall back to `ThemeDB.fallback_font`. If you load font bytes with `FileAccess` instead, the file must be in the pack (`release-readiness` check 8).
- After adding text, take one screenshot and look for boxes with hex codes; fix any you find before moving on.

## Fallback (no MCP — edit `.tscn` directly)

If Summer MCP isn't connected, write the menu hierarchy by hand:

```
[node name="MainMenu" type="Control" parent="."]
anchors_preset = 15

[node name="Margin" type="MarginContainer" parent="MainMenu"]
anchors_preset = 15
theme_override_constants/margin_left = 50
theme_override_constants/margin_right = 50
theme_override_constants/margin_top = 50
theme_override_constants/margin_bottom = 50

[node name="VBox" type="VBoxContainer" parent="MainMenu/Margin"]

[node name="Title" type="Label" parent="MainMenu/Margin/VBox"]
text = "My Game"

[node name="StartButton" type="Button" parent="MainMenu/Margin/VBox"]
text = "Start Game"
```

## Collaborative protocol

This skill writes UI scene nodes and wires button signals. Always ask before applying: "May I add the MainMenu (Control + Margin + VBox + Title + Start/Quit buttons) and connect Start.pressed to `_on_start_pressed`?".

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@4.9.0` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `summer_add_node` | `summer engine add-node` |
| `summer_connect_signal` | `summer engine connect-signal` |
| `summer_run_script` | `summer engine run-script` |
| `summer_save_scene` | `summer engine save-scene` |
| `summer_set_prop` | `summer engine set-prop` |
<!-- /shell-commands -->
