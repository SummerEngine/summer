---
name: web-and-touch-input
description: "Input for the browser and phones: the first-click rule for sound and mouse capture, focus, and touch buttons or a virtual stick on the same actions."
license: MIT
compatibility: [Cursor, Claude Code, Codex, Windsurf, Gemini, OpenCode]
category: scene-and-project
user-invocable: false
allowed-tools: Read Grep summer_input_map_bind summer_add_node summer_set_prop summer_batch summer_write_file summer_save_scene summer_play summer_stop summer_get_diagnostics summer_screenshot
paths: ["**/*.tscn", "**/*.gd", "**/project.godot"]
---

# Web and touch input

A browser game is played with a keyboard and mouse on a computer, and with fingers on a phone. Build one set of input actions and drive it from both.

## 1. One set of actions

Bind every control as an input action (`summer_input_map_bind`): `move_left`, `move_right`, `move_up`, `move_down`, `jump`, `action`, `pause`. Game code only reads actions (`Input.get_axis("move_left", "move_right")`, `Input.is_action_just_pressed("jump")`), never raw keys, so touch controls can press the same actions.

## 2. The browser rules

- **Sound and mouse capture need a first click or key.** Browsers block audio and pointer lock until the person interacts. Start music and call `Input.mouse_mode = Input.MOUSE_MODE_CAPTURED` from the title screen's "Click to play" handler, never in `_ready()`.
- **Escape releases the mouse** in the browser on its own. Treat losing capture as a pause, and recapture on the next click.
- **Focus:** the game only gets keys after it has been clicked. The title screen's "Click to play" covers this.
- **Keep keys browser-safe:** avoid Ctrl/Cmd shortcuts, F5, and Tab for gameplay.

## 3. Touch controls, only on touch screens

Add a `TouchControls` CanvasLayer (layer 10) and show it only when `DisplayServer.is_touchscreen_available()` is true:

- **Buttons:** a TouchScreenButton per action, with its `action` property set to the input action name (for example `jump`). It presses the same action as the keyboard. Make them large (at least 96 px), semi-transparent, and placed in the bottom corners, away from the HUD.
- **Movement:** for left/right only, two TouchScreenButtons (`move_left`, `move_right`). For free movement, a virtual stick: a Control in the bottom-left that reads `InputEventScreenTouch` and `InputEventScreenDrag` within its area and calls `Input.action_press("move_right", strength)` and `Input.action_release(...)` from the drag direction (dead zone about 0.2).
- **Camera look (3D):** drags on the right half of the screen rotate the camera; keep them separate from the stick's touch index.
- **Scale:** anchor the layer to the viewport corners so it works in portrait and landscape.

## 4. Verify

Run the game and check the keyboard controls and the title screen's first click. Set `input_devices/pointing/emulate_touch_from_mouse` on temporarily to try the touch buttons with the mouse, then turn it off again.
