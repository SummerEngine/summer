# GDScript Patterns — Reference

Detailed patterns for common game systems. Load this when implementing health, input, or state logic.

## Health System

```gdscript
signal died

var health: int = 100
var max_health: int = 100

func take_damage(amount: int) -> void:
    health = maxi(0, health - amount)
    if health <= 0:
        died.emit()

func heal(amount: int) -> void:
    health = mini(max_health, health + amount)
```

## Input Handling

Use `Input.get_axis()` for movement, `Input.is_action_just_pressed()` for discrete actions:

```gdscript
func _physics_process(_delta: float) -> void:
    var input_dir = Input.get_vector("move_left", "move_right", "move_forward", "move_back")
    velocity.x = input_dir.x * move_speed
    velocity.z = input_dir.y * move_speed

    if Input.is_action_just_pressed("jump"):
        velocity.y = jump_force

    move_and_slide()
```

Ensure InputMap actions exist via `summer_input_map_bind` before the game runs.

## State Machine (Simple)

```gdscript
enum State { IDLE, WALKING, JUMPING, FALLING }
var current_state: State = State.IDLE

func _physics_process(delta: float) -> void:
    match current_state:
        State.IDLE:
            if Input.is_action_just_pressed("jump"):
                current_state = State.JUMPING
            elif input_dir != Vector2.ZERO:
                current_state = State.WALKING
        State.WALKING:
            # ...
```
