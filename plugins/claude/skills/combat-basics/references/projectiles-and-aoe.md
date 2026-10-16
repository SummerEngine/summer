# Projectiles, AoE, and Pooling

Extends the base projectile in SKILL.md. Pick the behavior you need; they compose.

## Homing

Steer the direction toward the nearest target each frame. Turn rate keeps it from
being unavoidable.

```gdscript
@export var turn_rate: float = 4.0
var target: Node2D

func _physics_process(delta: float) -> void:
	if is_instance_valid(target):
		var desired := (target.global_position - global_position).normalized()
		direction = direction.lerp(desired, turn_rate * delta).normalized()
	position += direction * speed * delta
	rotation = direction.angle()
```

Find the nearest target by querying a group: iterate
`get_tree().get_nodes_in_group("enemies")` and keep the min `distance_to`. For
hundreds of enemies, cache the list and refresh every few frames, not per bullet.

## Piercing

Do not free on first hit; count hits and track who was already hit.

```gdscript
@export var pierce: int = 3
var _hit: Array = []

func _on_hit(body: Node) -> void:
	if body in _hit:
		return
	_hit.append(body)
	_apply_damage(body)
	pierce -= 1
	if pierce <= 0:
		queue_free()
```

## Area of effect (explosion)

Spawn an Area with a large CollisionShape for one frame, damage everything
overlapping, then free. Scale damage by distance for a shockwave feel.

```gdscript
func explode() -> void:
	for body in $Blast.get_overlapping_bodies():
		if body.has_node("Health"):
			var t := 1.0 - global_position.distance_to(body.global_position) / radius
			body.get_node("Health").take_damage(int(max_damage * maxf(t, 0.2)))
	spawn_vfx()
	queue_free()
```

Ground DOT (burning patch): an Area that ticks damage on a `Timer.timeout` to
bodies currently inside it, for a lifetime, then frees.

## Object pooling (many projectiles)

Instancing and freeing hundreds of bullets per second stutters. Reuse a fixed pool.

```gdscript
extends Node2D   # BulletPool autoload or level node

@export var bullet_scene: PackedScene
@export var pool_size: int = 200
var _pool: Array[Node2D] = []
var _next: int = 0

func _ready() -> void:
	for i in pool_size:
		var b := bullet_scene.instantiate()
		b.set_process(false)
		b.hide()
		add_child(b)
		_pool.append(b)

func fire(pos: Vector2, dir: Vector2) -> void:
	var b := _pool[_next]
	_next = (_next + 1) % pool_size
	b.global_position = pos
	b.direction = dir
	b.set_process(true)
	b.show()
	# bullet hides + set_process(false) instead of queue_free on hit/lifetime
```

Deactivate (hide + `set_process(false)`) instead of freeing; the pool recycles the
oldest. This is how survivors-style games sustain thousands of projectiles.

## Traps

- Homing with no turn cap = undodgeable and unfun. Cap `turn_rate`.
- Pooled bullets that `queue_free()` defeat the pool - hide and disable instead.
- AoE that reads overlaps in `_process` re-damages every frame; do it once.
- Distance-scaled damage with no floor (`maxf(t, 0.2)`) makes edges deal 0.
