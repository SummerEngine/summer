---
name: camera-rigs
description: "Camera rigs for 2D and 3D: Camera2D follow with limits, first-person head camera, SpringArm3D third-person, orthographic top-down, FOV guidance."
license: MIT
compatibility: [Cursor, Claude Code, Codex, Windsurf, Gemini, OpenCode]
category: scene-and-project
user-invocable: false
allowed-tools: Read Grep summer_get_scene_tree summer_inspect_node summer_add_node summer_set_prop summer_batch summer_save_scene summer_screenshot summer_play summer_stop summer_get_diagnostics
paths: ["**/*.tscn", "**/*.gd"]
---

# Camera Rigs

One rule above all: exactly ONE camera is active. In 3D that is the single
`Camera3D` with `current = true`; two current cameras = flicker or the wrong
view, and a scene with no current camera renders nothing in the game. In 2D a
`Camera2D` is active when `enabled = true` (the default) and it is in the tree;
with several enabled cameras, call `make_current()` on the one you want.

Trigger phrases: "black screen on play", "camera shows past the level edge",
"jerky follow", "wrong FOV", "I need a top-down / isometric / orbit camera".

Ops use engine variant strings (`"Vector3(0, 5, 10)"`), never JSON objects
(`{x: 0, y: 5, z: 10}` fails). Every mutation names its scene: pass the exact
`scenePath` (e.g. `res://main.tscn`). One `summer_batch` per rig saves the scene
once; the examples below use it.

## 2D follow camera

Add the `Camera2D` as a CHILD of the player so it follows for free, then smooth
it and clamp it to the level.

```
summer_batch(scenePath="res://main.tscn", ops=[
  {"op": "AddNode", "parent": "./Player", "type": "Camera2D", "name": "Camera"},
  {"op": "SetProp", "path": "./Player/Camera", "key": "position_smoothing_enabled", "value": true},
  {"op": "SetProp", "path": "./Player/Camera", "key": "position_smoothing_speed", "value": 6.0},
  {"op": "SetProp", "path": "./Player/Camera", "key": "limit_left", "value": 0},
  {"op": "SetProp", "path": "./Player/Camera", "key": "limit_right", "value": 1920},
  {"op": "SetProp", "path": "./Player/Camera", "key": "limit_top", "value": 0},
  {"op": "SetProp", "path": "./Player/Camera", "key": "limit_bottom", "value": 1080}
])
```

- Smoothing speed 5-8 feels responsive; higher = tighter, lower = drifty.
- Set limits to the actual level bounds (the numbers above are placeholders).
  `limit_smoothing_enabled = true` avoids a hard stop at the edge.
- Zoom `Vector2(2, 2)` zooms IN (bigger), `Vector2(0.5, 0.5)` zooms OUT (top-down).

## 2D top-down camera

Same as above minus the platformer edge-lock urgency. Zoom out to show the field
(`Vector2(0.5, 0.5)`). Keep it centered on the player; no vertical bias.

## 3D first-person camera

Camera is a child of a `Head` node on the player. Body yaws, Head pitches. See
the `character-movement` skill (its `references/movement-3d.md`) or
`fps-controller` for the look script. FOV 70-75, near 0.05.

```
summer_batch(scenePath="res://main.tscn", ops=[
  {"op": "AddNode", "parent": "./Player/Head", "type": "Camera3D", "name": "Camera"},
  {"op": "SetProp", "path": "./Player/Head/Camera", "key": "fov", "value": 72.0},
  {"op": "SetProp", "path": "./Player/Head/Camera", "key": "near", "value": 0.05},
  {"op": "SetProp", "path": "./Player/Head/Camera", "key": "current", "value": true}
])
```

## 3D third-person camera (spring arm)

The `SpringArm3D` pushes the camera in when a wall is behind the player, so it
never clips through geometry. This is the correct third-person rig - do not just
park a Camera3D behind the player.

```
summer_batch(scenePath="res://main.tscn", ops=[
  {"op": "AddNode", "parent": "./Player", "type": "SpringArm3D", "name": "SpringArm"},
  {"op": "SetProp", "path": "./Player/SpringArm", "key": "position", "value": "Vector3(0, 2, 0)"},
  {"op": "SetProp", "path": "./Player/SpringArm", "key": "spring_length", "value": 4.5},
  {"op": "SetProp", "path": "./Player/SpringArm", "key": "collision_mask", "value": 2},
  {"op": "AddNode", "parent": "./Player/SpringArm", "type": "Camera3D", "name": "Camera"},
  {"op": "SetProp", "path": "./Player/SpringArm/Camera", "key": "current", "value": true}
])
```

Set `collision_mask` to the LEVEL layer only. If it includes the player layer the
arm collapses to length 0 and you see inside the character (a controller script
can also call `add_excluded_object(get_rid())` on the arm).

## Orthographic top-down 3D (twin-stick, strategy, isometric)

```
summer_batch(scenePath="res://main.tscn", ops=[
  {"op": "SetProp", "path": "./Camera", "key": "projection", "value": 1},
  {"op": "SetProp", "path": "./Camera", "key": "size", "value": 20.0},
  {"op": "SetProp", "path": "./Camera", "key": "position", "value": "Vector3(0, 20, 0)"},
  {"op": "SetProp", "path": "./Camera", "key": "rotation_degrees", "value": "Vector3(-90, 0, 0)"}
])
```

`projection = 1` is orthogonal. `size` is the vertical world units shown - bigger
= more zoomed out. For isometric, rotate ~(-30, 45, 0) instead of straight down.

## FOV guidance

- 60-75: most 3D games. 90+: fast FPS (feels faster, more peripheral).
- Under 40 or over 110 distorts. Never animate FOV wildly; a small kick (+8 on
  sprint, tweened back) reads as speed.

## Verify

A camera is only proven by a frame. After the rig is in, `summer_play`, then
`summer_screenshot` with `target: "game"`, then `summer_stop`; or save frames
from a `RunVerification` probe while the player moves (see
`playtesting-a-feature`). An editor `viewport` screenshot shows the editor's
camera, not the game's.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Black screen | No current/enabled camera | 3D: `current = true` on exactly one; 2D: one enabled Camera2D in the tree |
| Camera inside geometry | Spawned inside a wall/player | Move it out; spring arm for 3P |
| Jerky follow | Smoothing off/too slow | Enable smoothing, speed 6-10 |
| Shows past level edge | No 2D limits | Set `limit_*` to level bounds |
| Wrong facing (3D) | rotation.y off | y: 0 = forward, 180 = backward |
| Everything tiny/huge (ortho) | `size` wrong | Tune `size`, not `position.y` |
