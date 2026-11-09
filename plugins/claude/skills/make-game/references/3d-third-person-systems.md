# 3D Third-Person - Systems

The combat and content layer on top of `3d-third-person.md`: melee, bullets,
grenade with arc preview, two enemy archetypes, coins, destructible boxes,
and the HUD.

## Shared damage interface

Everything hittable (player, enemies, boxes) implements:

```gdscript
func damage(impact_point: Vector3, force: Vector3) -> void
```

and joins the "damageables" group. `impact_point` is
`global_position - body.global_position` (direction from body to impact),
`force` is the knockback vector. Enemies additionally join "targeteables"
for grenade lock-on. One interface, three weapons, all content - keep it.

## Weapons

Tab toggles DEFAULT and GRENADE (a `weapon_switched` signal drives the HUD
icons). DEFAULT: left-click = melee from the hip, aim (RMB) + left-click =
ranged shot with over-shoulder camera + crosshair. GRENADE: left-click
throws with a live arc preview.

### Melee (animation-gated hitbox)

The MeleeAttackArea's CollisionShape3D starts disabled. The "Attack"
animation (0.3-0.5s) has method-call tracks: `activate()` at the impact
frame (~0.15s), `deactivate()` at the end. The area's `body_entered` damages
"damageables" with force pointing away from the player. Player side:
`attack()` plays the animation, fires the skin's punch OneShot, and sets
`velocity = rotation_root.basis * Vector3.BACK * attack_impulse` (forward
lunge). Movement is locked while the attack animation plays.

Animation-gated hitboxes beat timer-gated ones: the active window is
authored visually next to the swing frames.

### Bullet (shared by player AND enemies)

Node3D moved manually in `_process` - no physics body:

```gdscript
func _ready() -> void:
	_area.body_entered.connect(_on_body_entered)
	look_at(global_position + velocity)
	_alive_limit = distance_limit / velocity.length()

func _process(delta: float) -> void:
	global_position += velocity * delta
	_time_alive += delta
	_bullet_visuals.scale = Vector3.ONE * scale_decay.sample(_time_alive / _alive_limit)
	if _time_alive > _alive_limit:
		queue_free()

func _on_body_entered(body: Node3D) -> void:
	if body == shooter:
		return
	if body.is_in_group("damageables"):
		body.damage(global_position - body.global_position, velocity)
	queue_free()
```

The `shooter` reference prevents self-hits, which is what lets one bullet
scene serve both sides. Distance limit expressed as time
(`distance / speed`); visual scale decays via an exported Curve so bullets
fade with range. Player shots originate at `global_position + Vector3.UP`
and fly toward `camera_controller.get_aim_target()`.

Fast projectiles tunnel through thin walls: keep speeds moderate (player
10, enemies 6) or fatten the Area3D shape.

### Grenade launcher (arc preview + lock-on)

While GRENADE is equipped the launcher is visible and every physics frame:
camera tilt lerps throw distance between min 7 and max 16; a ShapeCast3D
finds the landing point; if the cast hits a "targeteables" body, the landing
snaps to that enemy (lock-on, SnapMesh indicator); initial velocity
decomposes into vertical `sqrt(2 * gravity * peak_height)` and horizontal
`distance / time_to_land`; the preview trail is a triangle-strip mesh built
with SurfaceTool sampling the parabola at 0.05s steps.

The grenade itself is a CharacterBody3D using `move_and_collide` (NOT
move_and_slide) so it can bounce:

```gdscript
func _physics_process(delta) -> void:
	_velocity += Vector3.DOWN * gravity * delta
	var collision := move_and_collide(_velocity * delta)
	if collision:
		_velocity = _velocity.bounce(collision.get_normal(0)) * 0.7
		if _explosion_start_timer.is_stopped():
			_explosion_start_timer.start()
```

First bounce arms the fuse timer. Explosion: damage all overlapping
"damageables" in the ExplosionArea EXCEPT the Player (`not body is Player` -
self-immunity), spawn explosion visuals, hide, await the sound, free. On
throw, add a collision exception between grenade and thrower via
`PhysicsServer3D.body_add_collision_exception`.

## Enemies

Both are RigidBody3D with a PlayerDetectionArea (big sphere Area3D), a
reaction label ("!" / "?" animations on detect/lose), and the same death
choreography: play defeat sound, set `_alive = false`, DISCONNECT the
detection signals (dead enemies must not react), enable the death collider,
enable gravity so the body drops, wait 2s, spawn a smoke puff, `await
puff.full`, burst coins out of the smoke, `queue_free()`.

The smoke puff emits `full` from an animation keyframe at peak opacity -
awaiting it makes coins appear to burst out of the cloud instead of
clipping through a half-formed puff.

### Bee bot (flying turret)

RigidBody3D with `gravity_scale = 0` (floats). While a target is set:

```gdscript
var target_transform := transform.looking_at(_target.global_position)
transform = transform.interpolate_with(target_transform, 0.1)
```

Fires the SAME bullet scene as the player every 1.5s at speed 6, aimed at
`target.global_position + Vector3.UP`. `damage()` applies an impulse
(clamped length 3) then runs the death choreography; gravity_scale flips to
1.0 so it falls out of the air.

### Beetle bot (NavigationAgent3D chaser)

RigidBody3D with rotation axes locked (rigid until death). Chase loop:

```gdscript
_navigation_agent.target_position = _target.global_position
var next := _navigation_agent.get_next_path_position()
if not _navigation_agent.is_target_reached():
	var direction := (next - global_position)
	direction.y = 0                      # never dive/fly
	direction = direction.normalized()
	var collision := move_and_collide(direction * delta * 3)
	if collision and collision.get_collider() is Player:
		var force := -(global_position - collider.global_position)
		force.y = 0.5
		collider.damage(impact_point, force * 10.0)
		_beetle_skin.attack()
```

`look_at` the target with Y flattened to its own height. On death, unlock
all angular axes so the corpse tumbles.

Navigation requirements: the level MUST have a baked NavigationRegion3D or
the beetle stands still forever; the target must be reachable on the
navmesh; always zero the Y of path directions.

Enemy skins: AnimationTree state machines (Idle/Walk/Attack/Shake/PowerOff)
with a secondary-action timer firing random idle shakes every 3-8s;
`power_off()` stops that timer.

## Coins

RigidBody3D collectible, either placed in the level or scattered by
`spawn()` (random impulse: direction rotated randomly around UP, range 2-4,
height 1-3). Collection is DELAYED: layer 3 collision is off for
`coin_delay` (0.5s default, 1.5s when the player drops them) so coins from
a kill do not vacuum back instantly.

Magnet: when the player enters the coin's detection area (mask = Player
layer 4), freeze physics and tween to the player:

```gdscript
func set_target(new_target: PhysicsBody3D) -> void:
	PhysicsServer3D.body_add_collision_exception(get_rid(), new_target.get_rid())
	if _target == null:
		sleeping = true
		freeze = true
		_initial_tween_position = global_position
		_target = new_target
		var tween := create_tween()
		tween.tween_method(_follow, 0.0, 1.0, 0.5)   # lerp start -> player
		tween.tween_callback(_collect)
```

`_follow` lerps from the captured start to the LIVE player position, so the
coin homes even while the player runs. Collect: random-pitch sound,
`player.collect_coin()`, hide, await audio, free. Coin model: spin
`rotation.y += 1.5 * delta`, bob `sin(t) * 0.04`.

## Destructible boxes

`damage()` on the box: spawn 5 coins with `spawn()`, instantiate a
pre-fractured debris scene, disable own collision (deferred), play sound,
await it, free. Debris scene = 6 hidden frozen RigidBody3D pieces; on ready,
shuffle and launch 3 random ones with `apply_force(rand_vector * 500)`,
leave the rest hidden. Half-count random debris looks as good as full
simulation at a fraction of the cost.

## HUD

```
UI (CanvasLayer)
  AimRecticle (%unique, ColorRect centered)   # visible only while aiming
  CoinsContainer (%unique, HBoxContainer)     # slides in on change
    CoinIcon + CoinsLabel + Timer
  WeaponUI (PanelContainer)                   # Flash / Grenade icons
```

Coin counter: slides from y -100 to y 20 on `update_coins_amount`, restarts
its display timer per change, slides back out on timeout. Weapon icons:
inactive at alpha 0.2, tween to full white on select; `switch_to()` guards
against reselecting the current one. Use unique names (%) so the deep
player script reaches UI without brittle paths.

## Order of work

1. Melee: attack animation + gated hitbox + a destructible box to punch.
2. Coins with magnet + HUD counter (the reward loop).
3. Aim mode: over-shoulder pivot + crosshair + bullet.
4. Bee bot (reuses your bullet), then beetle bot (navmesh required).
5. Grenade launcher last - arc preview, lock-on, explosion.
