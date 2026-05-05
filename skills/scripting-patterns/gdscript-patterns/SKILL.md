---
name: gdscript-patterns
description: Common GDScript idioms — type hints, signals, exports, onready, lifecycle methods, naming conventions. Use when writing GDScript, attaching scripts, or refactoring untyped code. Trigger on "GDScript", "script", "signals", "exports".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: scripting-patterns
user-invocable: false
allowed-tools: Read Grep summer_get_script_errors
paths: ["**/*.gd"]
---

# GDScript Patterns for Summer Engine

When writing GDScript for Summer Engine projects, follow these patterns. They align with Godot 4.x conventions and work well with MCP scene operations.

## Type Hints

Always use type hints for clarity and editor support:

```gdscript
var health: int = 100
var speed: float = 5.0
var player_name: String = ""
var velocity: Vector3 = Vector3.ZERO
var is_alive: bool = true
```

For nodes, use typed references:

```gdscript
@onready var collision_shape: CollisionShape3D = $CollisionShape3D
@onready var camera: Camera3D = $Camera3D
```

## Signals

Define signals at the top of the script, then emit them:

```gdscript
signal died
signal health_changed(new_health: int)
signal item_collected(item_name: String)

func take_damage(amount: int) -> void:
    health -= amount
    health_changed.emit(health)
    if health <= 0:
        died.emit()
```

When connecting via MCP, use `summer_connect_signal` with the emitter path, signal name, receiver path, and method name. The receiver script must have the method defined.

## Exports

Use `@export` for inspector-editable properties:

```gdscript
@export var move_speed: float = 5.0
@export var jump_force: float = 10.0
@export var max_health: int = 100
@export var can_double_jump: bool = false
```

Exports appear in the inspector. MCP can set initial values via `summer_set_prop` after the node exists, but exports are best for values the designer tweaks.

## Lifecycle Methods

| Method | When it runs | Use for |
|--------|--------------|---------|
| `_ready()` | Once when node enters tree | Initialization, getting node references |
| `_process(delta: float)` | Every frame | UI, non-physics logic |
| `_physics_process(delta: float)` | Every physics frame (fixed) | Movement, physics, collision |

For character movement, use `_physics_process` and `move_and_slide()`.

## Node Access

```gdscript
# Prefer $ for direct children
var camera = $Camera3D

# get_node() for dynamic paths
var target = get_node("../Enemy/HealthBar")

# get_parent() / get_children() when needed
var siblings = get_parent().get_children()
```

## Common Patterns

For health systems, input handling, and state machines, see [reference.md](reference.md).

## Scene Integration

When the AI adds a node with Summer MCP tools and attaches a script, the script path is set via `summer_set_prop(path, "script", "res://path/to/script.gd")`. The script file must exist first. Create or edit `.gd` files with the host agent's normal file-editing tools, then use Summer MCP only to attach the script and connect scene signals.

For signal connections, the receiver must have the handler method. Create the script with the method stub before calling `summer_connect_signal`.
