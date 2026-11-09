# 2D Platformer - Enemies, Hazards, Juice, Progression

Add these only after the core loop (run/jump/goal/death) from `2d-platformer.md`
feels good. Combat mechanics reuse the `combat-basics` skill.

## Patrol enemy

A `CharacterBody2D` that walks, turns at ledges/walls, and hurts on contact. Ledge
detection via a downward `RayCast2D` at the front foot.

```gdscript
extends CharacterBody2D
@export var speed: float = 60.0
var dir: float = 1.0
var gravity: float = ProjectSettings.get_setting("physics/2d/default_gravity")
@onready var ledge: RayCast2D = $LedgeCheck   # points down, ahead of feet

func _physics_process(delta: float) -> void:
	if not is_on_floor():
		velocity.y += gravity * delta
	if is_on_wall() or (is_on_floor() and not ledge.is_colliding()):
		dir *= -1.0
		ledge.position.x *= -1.0
		$Sprite2D.flip_h = dir < 0.0
	velocity.x = dir * speed
	move_and_slide()
```

Give it a hurtbox (masks PlayerHurtbox) and a Health node from `combat-basics`.

## Stomp-to-kill

The classic platformer verb. A separate Area2D under the player masking only the
Enemies layer; on overlap, kill the enemy and bounce the player.

```gdscript
# in player, StompArea (Area2D) child
func _on_stomp_body_entered(enemy: Node) -> void:
	if velocity.y > 0.0 and enemy.has_method("die"):
		enemy.die()
		velocity.y = jump_velocity * 0.7   # bounce
```

Falling (`velocity.y > 0`) distinguishes a stomp from a side hit that should damage
the player instead.

## Hazards

- Spikes/lava: an Area2D on the Triggers layer that calls `player.die()`.
- Bounce pad: Area2D that sets `player.velocity.y = -launch_force` on enter.
- Bottomless pit: one wide killzone under the level.

## Juice (the difference between prototype and game)

Route through a small helper so every hit feels alive:

- Hit flash: `modulate` to white, tween back over 0.06s.
- Screen shake: offset the Camera2D by decaying random noise for ~0.2s.
- Hitstop: `Engine.time_scale = 0.05` for one frame on a kill, then back to 1.0.
- Floating text: spawn a Label that rises and fades on coin/hit.
- Squash/stretch: tween the sprite `scale` to (1.2, 0.8) on land, back over 0.1s.
- Dust particles on land and on turn.

A silent, still platformer fails the 30-second bar even if every system works.

## Progression: coins, gems, and a level goal

- Coins increment `GameManager.score`; emit `score_changed` for the HUD.
- A `level_end` Area2D (flag/door) triggers the level-complete screen with time and
  coin count, then advances to the next room `.tscn`.
- Save unlocked rooms + best times via the `save-load` skill.

## Metroidvania gating (optional)

For an interconnected map with ability gates:

- `AbilityManager` autoload: `unlocked: Dictionary`, `has(name)`, `unlock(name)`.
- Ability pickup: Area2D that calls `AbilityManager.unlock("double_jump")`.
- Ability gate: a wall/door that only opens if `AbilityManager.has("dash")`, or a
  ledge only reachable with double jump.
- The player controller checks `AbilityManager.has("double_jump")` before allowing
  a second air jump, `has("dash")` before a dash, etc.

Keep gating data-driven: one place lists what each ability unlocks, so designers
tune it without touching the controller.

## Traps

- Enemies as RigidBody2D fight the player physically; use CharacterBody2D or Area2D.
- Stomp check without a `velocity.y > 0` guard kills enemies on any touch.
- Ledge raycast that does not flip with direction walks enemies off cliffs.
- Piling on juice at once (shake + hitstop + flash on every coin) reads as noise;
  reserve the big feedback for kills and damage, keep coins light.
