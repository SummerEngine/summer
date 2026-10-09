---
name: combat-basics
description: "Damage in Summer Engine: hitbox and hurtbox Areas on opposing layers, a reusable Health component, damage signals, knockback, hit feedback, projectiles."
license: MIT
compatibility: [Cursor, Claude Code, Codex, Windsurf, Gemini, OpenCode]
category: gameplay-mechanics
user-invocable: false
allowed-tools: Read Grep summer_read_file summer_write_file summer_replace_text summer_add_node summer_set_prop summer_batch summer_project_setting summer_save_scene summer_get_script_errors summer_get_diagnostics
paths: ["**/*.gd", "**/*.tscn"]
---

# Combat Basics

The standard combat pattern is hitbox + hurtbox + health, wired by signals. Build it
component-first: the same three pieces work for player, enemies, and destructibles.

## The layer model (set this up first)

Attacks are `Area2D`/`Area3D`, not solid bodies. A hitbox (the attack) detects a
hurtbox (the thing that can be hurt) via collision layers/masks:

| Node | on layer | masks (detects) |
|------|----------|-----------------|
| Player hurtbox | PlayerHurt | EnemyHit |
| Player hitbox (sword) | PlayerHit | EnemyHurt |
| Enemy hurtbox | EnemyHurt | PlayerHit |
| Enemy hitbox | EnemyHit | PlayerHurt |

Rule: every combat Area masks only the OPPOSING side. This is why the player's
sword never damages the player. An Area reports `area_entered` only for areas on
a layer in its OWN mask, so the hurtbox below (which listens) must mask the
opposing hitbox layer; a hurtbox with an empty mask never registers a hit.

Name the layers once so you are not counting bits by hand —
`summer_project_setting(key="layer_names/2d_physics/layer_4", value="PlayerHit")`
(use `layer_names/3d_physics/...` for 3D), one call per layer.

## Health component (reuse everywhere)

Attach to any damageable node. It owns HP and fires signals; UI and death logic
just listen.

```gdscript
class_name Health extends Node

signal damaged(amount: int, current: int)
signal died

@export var max_health: int = 100
var current: int

func _ready() -> void:
	current = max_health

func take_damage(amount: int) -> void:
	if current <= 0:
		return
	current = maxi(0, current - amount)
	damaged.emit(amount, current)
	if current == 0:
		died.emit()

func heal(amount: int) -> void:
	current = mini(max_health, current + amount)
```

## Hurtbox -> Health

The hurtbox is an Area on the body; when a hitbox overlaps it, read the hitbox's
damage and route it to the Health node.

```gdscript
extends Area2D   # Hurtbox, child of the character

@export var health_path: NodePath
@onready var health: Health = get_node(health_path)

func _ready() -> void:
	area_entered.connect(_on_area_entered)

func _on_area_entered(hitbox: Area2D) -> void:
	if hitbox.has_method("get_damage"):
		health.take_damage(hitbox.get_damage())
```

## Hitbox

```gdscript
extends Area2D   # Hitbox, child of weapon or attack

@export var damage: int = 10
func get_damage() -> int:
	return damage
```

Enable the hitbox only during the active frames of a swing (toggle
`monitoring`/`monitorable` or the CollisionShape's `disabled`), driven by an
AnimationPlayer track. An always-on melee hitbox hits on touch, which feels wrong.

## Death, knockback, feedback

- On `died`: `queue_free()`, spawn a death VFX, drop loot, `add_kill()` on your
  game manager. For the player, switch to a GAME_OVER state instead of freeing.
- Knockback: push the victim `velocity = (victim.global_position -
  attacker.global_position).normalized() * force`, decay it each frame.
- Every hit needs feedback or it reads as broken: a flash (`modulate` to white for
  0.05s), a damage number (floating Label), a small screen shake, a hitstop
  (`Engine.time_scale = 0.05` for one frame). Silent damage feels like a no-op.

## Projectiles (short version)

An `Area2D/3D` that moves forward and calls `take_damage` on what it hits, then
frees itself.

```gdscript
extends Area2D   # projectile

@export var speed: float = 600.0
@export var damage: int = 15
var direction: Vector2 = Vector2.RIGHT

func _ready() -> void:
	body_entered.connect(_on_hit)
	get_tree().create_timer(3.0).timeout.connect(queue_free)  # lifetime

func _physics_process(delta: float) -> void:
	position += direction * speed * delta

func _on_hit(body: Node) -> void:
	if body.has_node("Health"):
		body.get_node("Health").take_damage(damage)
	queue_free()
```

Homing, piercing, AoE, and pooling many bullets are in this skill's
`references/projectiles-and-aoe.md` — read it only when you need one of those.

## Traps

- Hitbox on the wrong layer/mask = no hits or friendly fire. Verify the layer
  table above before debugging the scripts.
- Two Areas with neither `monitoring` nor `monitorable` never report overlap.
- Freeing a node mid-signal can error - defer with `queue_free()` (safe), not
  `free()`.
- Damaging in `_process` instead of on overlap = continuous per-frame damage.

## Applying it in Summer Engine

- Scripts (`health.gd`, `hurtbox.gd`, `hitbox.gd`, `projectile.gd`) are files:
  create with `summer_write_file(path=..., content=..., create_only=true)`,
  change with `summer_replace_text`. Check each with `summer_get_script_errors`.
- Nodes (the Area, its CollisionShape, the Health child) are scene mutations:
  `summer_add_node` / `summer_set_prop` with `scenePath`, or one `summer_batch`
  with `AddNode` / `SetProp` ops so the scene saves once. Set `collision_layer`
  and `collision_mask` as integers (bit values), not layer names.
- Prove a hit with a `RunVerification` probe (see `playtesting-a-feature`):
  spawn or find one enemy, press the attack action, `report()` the enemy's
  `Health.current` before and after. A static scene check cannot show that a
  hit registered.
