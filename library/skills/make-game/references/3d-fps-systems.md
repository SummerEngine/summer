# 3D FPS - Systems

The combat and interaction layer on top of `3d-fps.md`: hitscan and
projectile shooting, the data-driven weapon system, raycast interaction, and
the HUD.

## Shooting: hitscan vs projectile

Hitscan (raycast) for rifles/pistols, projectiles for rockets/grenades.
Most weapons should be hitscan - instant, cheap, reliable.

### Hitscan

Uses the player's ShootRay (RayCast3D under Camera3D, target (0,0,-100),
mask 6 = Environment + Enemy):

```gdscript
func _shoot() -> void:
	if not can_shoot:
		return
	can_shoot = false
	shoot_cooldown = 0.1  # fire rate
	shoot_ray.force_raycast_update()
	if shoot_ray.is_colliding():
		var collider := shoot_ray.get_collider()
		_spawn_hit_effect(shoot_ray.get_collision_point(), shoot_ray.get_collision_normal())
		if collider.has_method("take_damage"):
			collider.take_damage(25.0)
```

`force_raycast_update()` matters: the ray otherwise reports last frame's
state and fast turns produce misses. Cooldown ticks down in `_process` and
re-arms `can_shoot`.

### Projectile

CharacterBody3D moved with `move_and_collide` (not RigidBody - you want
deterministic flight):

```gdscript
func _physics_process(delta: float) -> void:
	time_alive += delta
	if time_alive >= lifetime:   # 5s despawn, always
		queue_free()
		return
	velocity = direction * speed
	if gravity_affected:
		velocity.y -= 9.8 * delta
	var collision := move_and_collide(velocity * delta)
	if collision:
		var collider := collision.get_collider()
		if collider and collider.has_method("take_damage"):
			collider.take_damage(damage)
		_explode()
		queue_free()
```

Spawn from the camera, not the weapon model, so shots go where the
crosshair points:

```gdscript
proj.global_position = camera.global_position
proj.direction = -camera.global_transform.basis.z
get_tree().current_scene.add_child(proj)
```

## Weapon system (data-driven)

WeaponData is a Resource; one .tres (or in-code instance) per weapon:

```gdscript
class_name WeaponData
extends Resource

@export var weapon_name: String = "Pistol"
@export var damage: float = 25.0
@export var fire_rate: float = 0.15      # seconds between shots
@export var reload_time: float = 1.5
@export var magazine_size: int = 12
@export var max_ammo: int = 120
@export var is_automatic: bool = false
@export var is_hitscan: bool = true
@export var spread: float = 0.0          # radians of random spread
@export var projectile_scene: PackedScene = null
@export var weapon_model_scene: PackedScene = null
```

WeaponManager (Node3D child of Player) owns `weapons: Array[WeaponData]`,
current index, magazine/reserve ammo, and these signals for the HUD:
`weapon_changed`, `ammo_changed(current, reserve)`,
`reload_started(time)`, `reload_finished`.

Core rules learned the hard way:

- Automatic vs semi-auto is one branch: automatic polls
  `Input.is_action_pressed("shoot")`, semi-auto uses
  `is_action_just_pressed`.
- Fire path: refuse if `not can_shoot or is_reloading`; if magazine empty,
  auto-start reload instead of firing; decrement ammo and emit
  `ammo_changed` BEFORE resolving the hit.
- Spread: randomize `shoot_ray.target_position` x/y within +-spread before
  the raycast, then RESET it to (0,0,-100) after - a forgotten reset makes
  every later weapon inherit the spread.
- Switching: clear WeaponHolder children (`queue_free`), instantiate the
  new `weapon_model_scene`, reset `is_reloading`/`can_shoot`/`shoot_timer`.
  Guard against re-equipping the same index.
- Reload:

```gdscript
func _start_reload() -> void:
	if is_reloading or magazine_ammo == current_weapon.magazine_size:
		return
	if reserve_ammo <= 0:
		return
	is_reloading = true
	can_shoot = false
	reload_started.emit(current_weapon.reload_time)
	var tween := create_tween()
	tween.tween_interval(current_weapon.reload_time)
	tween.tween_callback(_finish_reload)

func _finish_reload() -> void:
	var available := mini(current_weapon.magazine_size - magazine_ammo, reserve_ammo)
	magazine_ammo += available
	reserve_ammo -= available
	is_reloading = false
	can_shoot = true
	ammo_changed.emit(magazine_ammo, reserve_ammo)
	reload_finished.emit()
```

The `is_reloading` guard is not optional - without it players stack reload
timers. Partial reloads take `mini(needed, reserve)`, never a full magazine.

Weapon switching by number keys: loop `weapons.size()` checking
`Input.is_action_just_pressed("weapon_%d" % (i + 1))`.

## Interaction system

Duck-typed interface - any node is interactable if it implements:

```gdscript
func interact(player: Node3D) -> void
func get_interaction_prompt() -> String
```

The player polls its InteractionRay every physics frame and caches
`look_target`. Check the collider AND its parent for the methods (the
collider is often a StaticBody3D child of the actual object):

```gdscript
func _update_interaction_target() -> void:
	if interaction_ray.is_colliding():
		var target: Node = interaction_ray.get_collider()
		if target and not target.has_method("get_interaction_prompt"):
			target = target.get_parent()
		if target and target.has_method("get_interaction_prompt"):
			look_target = target
			return
	look_target = null
```

### Door pattern

Node3D root that rotates; mesh + StaticBody3D child positioned at
(0.5, 1.4, 0) so the hinge is the parent origin, not the door center.
`_process` lerps `rotation.y` toward `target_rotation`. Open away from the
player by checking which side they are on:

```gdscript
var to_door := global_position - player.global_position
var local_dir := global_transform.basis.inverse() * to_door
target_rotation = deg_to_rad(open_angle if local_dir.z > 0 else -open_angle)
```

Prompt reflects state: "Locked" / "Open" / "Close". The door body's
collision_layer is 6 (Environment + Interactable) so it both blocks
movement and answers the interaction ray.

### Pickup pattern

RigidBody3D with `freeze = true` (physics off, still hit by rays), idle bob
(`base_y + sin(bob_time) * 0.05`) and slow rotate, randomized starting
phase (`bob_time = randf() * TAU`) so a row of pickups does not bob in
lockstep. `interact()` applies the effect and `queue_free()`s.

## HUD

```
HUD (CanvasLayer)
  Crosshair (TextureRect, centered 16x16)
  InteractionPrompt (Label, bottom center, "[E] Open")
  AmmoLabel (Label, bottom right, "12 / 120")
  HealthBar (ProgressBar, bottom left)
  DamageOverlay (ColorRect, full rect, red, alpha 0)
```

Wiring pattern: the HUD finds the player via the "player" group in
`_process` (retry until found - spawn order is not guaranteed), then
connects `weapon_manager.ammo_changed`. Interaction prompt shows
`"[E] " + player.look_target.get_interaction_prompt()` while `look_target`
is set, hides otherwise.

Damage feedback: on hit, set the overlay to `Color(1, 0, 0, 0.3)` and fade
alpha down at 2.0/s in `_process`. Cheap and effective.

## Order of work

1. Hitscan fire on the base controller (fixed 25 damage, no weapon data).
2. Hit effects + damage overlay - shooting must feel real before it is
   configurable.
3. WeaponData + WeaponManager, migrate the hardcoded fire into it, add
   ammo/reload + HUD ammo label.
4. Second and third weapons (one automatic with spread, one projectile) to
   prove the data path.
5. Interaction ray + door + pickup + prompt label.
