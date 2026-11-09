# Trauma Camera Shake — Reusable Snippet

Variant of the canonical "trauma model" shake (the `game-feel` skill has the full game-feel discipline). Lightning and explosion recipes call `add_trauma()` to chain visual impact with screen-level reaction.

## Setup (autoload script)

`autoloads/CameraShake.gd`:

```gdscript
extends Node

var trauma: float = 0.0
var trauma_decay: float = 1.4
var max_offset: Vector3 = Vector3(0.4, 0.4, 0.0)
var max_yaw: float = 0.05
var max_pitch: float = 0.05
var camera: Camera3D
var _rot_offset := Vector2.ZERO  # shake rotation applied last frame

func _process(delta: float) -> void:
    if camera == null:
        camera = get_viewport().get_camera_3d()
        if camera == null:
            return
    # Undo last frame's shake first, so the camera never drifts.
    camera.rotation.x -= _rot_offset.x
    camera.rotation.y -= _rot_offset.y
    _rot_offset = Vector2.ZERO
    if trauma > 0.0:
        var s := trauma * trauma  # perceived intensity grows quadratically
        camera.h_offset = max_offset.x * s * (randf() * 2.0 - 1.0)
        camera.v_offset = max_offset.y * s * (randf() * 2.0 - 1.0)
        _rot_offset = Vector2(max_pitch * s * (randf() * 2.0 - 1.0), max_yaw * s * (randf() * 2.0 - 1.0))
        camera.rotation.x += _rot_offset.x
        camera.rotation.y += _rot_offset.y
        trauma = max(0.0, trauma - trauma_decay * delta)
    else:
        camera.h_offset = 0.0
        camera.v_offset = 0.0

func add_trauma(amount: float) -> void:
    trauma = clamp(trauma + amount, 0.0, 1.0)
```

Register `CameraShake` as autoload in Project Settings. An autoload is a node at
`/root/CameraShake`, not an engine singleton — reach it with
`get_node_or_null("/root/CameraShake")`. `Engine.has_singleton("CameraShake")` is
always `false` for an autoload (measured), so never gate the call on it.

## Usage

```gdscript
# In a recipe controller:
CameraShake.add_trauma(0.6)   # lightning strike
CameraShake.add_trauma(1.0)   # explosion (saturates to max)
CameraShake.add_trauma(0.2)   # hit spark
```

The trauma model: noise-driven shake whose intensity grows quadratically with `trauma`. Multiple sources stack but saturate — a player taking 5 hits in a row shakes harder, but never beyond the max.
