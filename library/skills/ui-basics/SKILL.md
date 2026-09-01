---
name: ui-basics
description: "Use when building Summer Engine UI: HUDs, main menus, pause menus, health bars, progress bars, dialogue boxes, or any Control-node tree. Covers anchors, containers (VBox/HBox/Margin), responsive layout, and theme versus inline styling. Trigger on \"UI\", \"HUD\", \"menu\", \"health bar\", \"Control\", \"anchors\", \"VBoxContainer\", \"main menu\", \"pause menu\"."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: ui-and-ux
user-invocable: false
allowed-tools: Read Grep summer_add_node summer_set_prop summer_connect_signal summer_save_scene
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

```
summer_add_node(parent="./", type="Control", name="MainMenu")
summer_add_node(parent="./MainMenu", type="MarginContainer", name="Margin")
summer_set_prop(path="./MainMenu/Margin", key="anchors_preset", value="15")  # Full rect
summer_set_prop(path="./MainMenu/Margin", key="theme_override_constants/margin_left", value="50")
summer_set_prop(path="./MainMenu/Margin", key="theme_override_constants/margin_right", value="50")
summer_set_prop(path="./MainMenu/Margin", key="theme_override_constants/margin_top", value="50")
summer_set_prop(path="./MainMenu/Margin", key="theme_override_constants/margin_bottom", value="50")

summer_add_node(parent="./MainMenu/Margin", type="VBoxContainer", name="VBox")
summer_add_node(parent="./MainMenu/Margin/VBox", type="Label", name="Title")
summer_set_prop(path="./MainMenu/Margin/VBox/Title", key="text", value="My Game")
summer_add_node(parent="./MainMenu/Margin/VBox", type="Button", name="StartButton")
summer_set_prop(path="./MainMenu/Margin/VBox/StartButton", key="text", value="Start Game")
summer_add_node(parent="./MainMenu/Margin/VBox", type="Button", name="QuitButton")
summer_set_prop(path="./MainMenu/Margin/VBox/QuitButton", key="text", value="Quit")
```

For nested theme overrides, use `summer_set_resource_property` if the property
is on a resource. For `theme_override_constants/margin_left`, inspect the live
node or the upstream API reference matching the current Summer technical base.
Some constants use `add_theme_constant_override`.

## HUD (Health Bar)

```
summer_add_node(parent="./", type="CanvasLayer", name="HUD")
summer_add_node(parent="./HUD", type="MarginContainer", name="TopLeft")
summer_set_prop(path="./HUD/TopLeft", key="anchors_preset", value="0")  # Top-left is 0; 1 is Top-right
summer_add_node(parent="./HUD/TopLeft", type="HBoxContainer", name="HealthContainer")
summer_add_node(parent="./HUD/TopLeft/HealthContainer", type="Label", name="HealthLabel")
summer_set_prop(path="./HUD/TopLeft/HealthContainer/HealthLabel", key="text", value="Health:")
summer_add_node(parent="./HUD/TopLeft/HealthContainer", type="ProgressBar", name="HealthBar")
summer_set_prop(path="./HUD/TopLeft/HealthContainer/HealthBar", key="max_value", value="100")
summer_set_prop(path="./HUD/TopLeft/HealthContainer/HealthBar", key="value", value="100")
summer_set_prop(path="./HUD/TopLeft/HealthContainer/HealthBar", key="size", value="Vector2(200, 20)")
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

Set via `summer_set_prop(path, key="anchors_preset", value="15")`.

## Connecting Buttons

Wire the `pressed` signal to a handler:

```
summer_connect_signal(scenePath="res://main.tscn", emitter="./MainMenu/Margin/VBox/StartButton", signal="pressed", receiver="./MainMenu", method="_on_start_pressed")
```

`scenePath` is required on every scene-mutating tool in this skill
(`summer_add_node`, `summer_set_prop`, `summer_connect_signal`,
`summer_save_scene`). The examples above omit it only for readability — a real
call without it is rejected before it reaches the engine.

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
