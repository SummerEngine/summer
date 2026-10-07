# Platformer Feel

The base controller in SKILL.md runs, but a raw `is_on_floor()` jump feels stiff
and unforgiving. These four additions are what separate a prototype from a game
that feels good. Add them in this order; each is independent.

## Coyote time

Let the player jump for a few frames AFTER walking off a ledge. Without it, jumps
near edges feel like the game ate the input.

```gdscript
@export var coyote_time: float = 0.1
var _coyote_timer: float = 0.0

func _physics_process(delta: float) -> void:
	if not is_on_floor():
		velocity.y += gravity * delta
		_coyote_timer -= delta
	else:
		_coyote_timer = coyote_time
	# jump check uses _coyote_timer > 0.0 instead of is_on_floor()
```

## Jump buffering

If the player presses jump a few frames BEFORE landing, remember it and fire on
touchdown. Without it, fast players feel like jumps get dropped.

```gdscript
@export var jump_buffer: float = 0.1
var _buffer_timer: float = 0.0

func _physics_process(delta: float) -> void:
	if Input.is_action_just_pressed("jump"):
		_buffer_timer = jump_buffer
	_buffer_timer -= delta
	if _buffer_timer > 0.0 and _coyote_timer > 0.0:
		velocity.y = jump_velocity
		_buffer_timer = 0.0
		_coyote_timer = 0.0
```

## Variable jump height

Tap = short hop, hold = full jump. Cut upward velocity when the button releases.

```gdscript
	if Input.is_action_just_released("jump") and velocity.y < 0.0:
		velocity.y *= 0.4
```

## Asymmetric gravity (fall faster than you rise)

A heavier fall gravity is the single biggest feel upgrade. Rising floaty, falling
snappy reads as responsive.

```gdscript
@export var fall_multiplier: float = 1.6

func _physics_process(delta: float) -> void:
	var g := gravity * (fall_multiplier if velocity.y > 0.0 else 1.0)
	if not is_on_floor():
		velocity.y += g * delta
```

## One-way platforms

Use a `CollisionPolygon2D`/`CollisionShape2D` on a platform with
`one_way_collision = true` in the platform's collision shape. Drop through by
briefly disabling the player's collision with that layer, or move the player to a
lower collision layer while `move_down` is held.

## Tuning starting points

| Feel | speed | jump_velocity | gravity scale |
|------|-------|---------------|---------------|
| Tight/precise | 180 | -320 | 1.0 (fall 1.8) |
| Floaty/explorer | 220 | -420 | 0.7 (fall 1.3) |
| Fast/action | 300 | -380 | 1.0 (fall 2.0) |

Never ship default gravity 980 with a -350 jump and call it done - that is the
"why does my jump feel bad" default. Tune fall_multiplier first.
