# GDScript Style — Summer Conventions

> The bar for GDScript in Summer. Skills should produce code that matches this. Where Godot's official style guide is silent, this is the tiebreaker.

## File structure

```gdscript
class_name PlayerController
extends CharacterBody3D

# 1. Constants
const SPEED := 5.0
const JUMP_VELOCITY := 4.5
const GRAVITY := 9.8

# 2. Exports (designer-tweakable in inspector)
@export var move_speed: float = 5.0
@export var jump_height: float = 1.0
@export_range(0.1, 10.0) var look_sensitivity: float = 1.0

# 3. Signals (events this node emits)
signal died
signal health_changed(new_value: int)

# 4. Onready references (cached node lookups)
@onready var camera: Camera3D = $Camera3D
@onready var collision: CollisionShape3D = $CollisionShape3D

# 5. Private state (snake_case, leading underscore optional)
var _is_grounded: bool = false
var _velocity := Vector3.ZERO

# 6. Lifecycle (in canonical order)
func _ready() -> void:
    pass

func _process(delta: float) -> void:
    pass

func _physics_process(delta: float) -> void:
    pass

func _input(event: InputEvent) -> void:
    pass

# 7. Public API (PascalCase or snake_case methods, snake_case for funcs)
func take_damage(amount: int) -> void:
    pass

# 8. Private helpers (leading underscore)
func _calculate_movement(delta: float) -> Vector3:
    return Vector3.ZERO
```

## Type hints

**Always type-hint.** No bare `var x = 5`. Use `:=` for inferred typing or `:` for explicit.

```gdscript
# RIGHT
var speed: float = 5.0
var name := "Player"
func attack(target: Node3D, amount: int) -> bool:
    return true

# WRONG
var speed = 5.0
func attack(target, amount):
    return true
```

## Naming

| Thing | Convention | Example |
|---|---|---|
| Class | PascalCase | `class_name PlayerController` |
| File | snake_case | `player_controller.gd` |
| Variable, function | snake_case | `move_speed`, `take_damage()` |
| Constant | SCREAMING_SNAKE_CASE | `const MAX_HEALTH := 100` |
| Signal | snake_case (past tense for events) | `died`, `health_changed` |
| Private | leading underscore | `_is_grounded`, `_calculate_movement` |
| Node in scene | PascalCase | `Player`, `Camera3D`, `CollisionShape3D` |

## Signals

Define with typed args. Connect in `_ready()` or in scene `.tscn` directly.

```gdscript
signal health_changed(new_value: int, max_value: int)

func _ready() -> void:
    health_changed.connect(_on_health_changed)

func _on_health_changed(new_value: int, max_value: int) -> void:
    pass
```

## Tweens

Use `create_tween()` for animation. Don't manually lerp in `_process` unless you need fine control.

```gdscript
var tween := create_tween()
tween.tween_property(self, "modulate", Color.WHITE, 0.3)
```

## What to avoid

- Bare `var x = something` (no type)
- `Object` typed parameters (use specific class)
- `match` for two-branch logic (use `if`)
- Recreating node lookups in `_process` (cache via `@onready`)
- Hard-coded strings for node paths in code (use `@onready` + scene-relative paths)
- Setting `position` in `_process` for physics objects (use `_physics_process` and `velocity`)

## See also

- [Official Godot GDScript style guide](https://docs.godotengine.org/en/stable/tutorials/scripting/gdscript/gdscript_styleguide.html)
- `scripting-patterns/gdscript-patterns/SKILL.md` — patterns and idioms
- `scripting-patterns/signal-patterns/SKILL.md` — signal usage
- `scripting-patterns/state-machine-patterns/SKILL.md` — state machine patterns
