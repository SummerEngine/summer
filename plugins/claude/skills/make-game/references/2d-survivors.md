# 2D Survivors - Core

Vampire Survivors-style auto-battler blueprint: arena, wave state machine, player,
and auto-firing weapons. The player only moves and dashes; weapons aim and fire
themselves. Waves, enemies, upgrades, shop, and evolution live in
`2d-survivors-progression.md`.

## Minimum playable base (build this first)

One arena scene: player CharacterBody2D with WASD movement, one auto-firing
projectile weapon, a handful of chasing enemies, and visible feedback on every
hit (flash + damage number). Prove "move, enemies chase, weapon kills them"
before waves, shop, or characters exist.

Two rules for every scene:

- Dynamic viewport: `display/window/stretch/mode = "canvas_items"`,
  `stretch/aspect = "expand"`. All UI uses Control anchors, never hardcoded
  pixel positions. Spawn enemies relative to the player (650-900px out), never
  from screen coordinates.
- Playable slice, not tech demo: every hit needs shake/flash/particles/damage
  number. A silent wave where numbers move but nothing feels alive fails.

## Architecture

```
res://
  scenes/
    main.tscn                  # main menu (run entry point)
    levels/arena.tscn          # THE gameplay scene (owns everything)
    player/player.tscn
    enemies/enemy.tscn         # one scene reused for ALL enemy types
    enemies/enemy_projectile.tscn
    pickups/pickup.tscn        # gold coin / health orb
    weapons/projectile.tscn
    ui/character_select.tscn
  scripts/
    autoloads/{game_manager,audio_manager}.gd
    player/player.gd
    enemies/{enemy_base,enemy_spawner,enemy_projectile,elite_system}.gd
    weapons/{projectile_weapon,projectile,orbital_weapon,area_weapon}.gd
    weapons/evolved/{piercing_projectile_weapon,radiant_orbital_weapon,supernova_weapon}.gd
    systems/{wave_data,upgrade_data,upgrade_manager,weapon_evolution,
             item_data,item_manager,item_registry,character_data,
             character_registry,pickup,camera_effects,arena_hazard}.gd
    ui/{main_menu,character_select_ui,hud,level_up_ui,shop_ui,
        pause_menu,game_over_ui}.gd
```

Two autoloads only: `GameManager` (single source of truth for ALL run state -
stats, gold, XP, health, wave, signals) and `AudioManager` (pooled SFX + music).
Every system reads and writes GameManager; UI listens to its signals.

## Physics layers

| Layer | Bit | Name |
|-------|-----|------|
| 1 | 1 | Player |
| 2 | 2 | Enemies |
| 3 | 4 | Pickups |
| 4 | 8 | PlayerProjectiles |
| 5 | 16 | Walls |
| 6 | 32 | EnemyProjectiles |

Wiring: Player body layer 1 mask 16 (walls only). Player Hurtbox layer 0 mask 34
(Enemies + EnemyProjectiles). PickupRange layer 0 mask 4. Enemies layer 2 mask 0.
Player projectiles layer 8 mask 2. Enemy projectiles layer 32 mask 1.

Input map: move_up/down/left/right (WASD + left stick), dash (Space + R2),
pause (Escape + Start).

## Wave state machine (arena.gd)

The arena scene owns the player, spawner, all managers, and all UI CanvasLayers.
Everything wires together via signals in `_ready()`. Per wave, 4 phases:

```
PRE_WAVE (1.5s announce) -> COMBAT (timed, 20-30s) ->
WAVE_CLEAR (2.5s: kill all, vacuum gold, slow-mo) ->
SHOPPING (buy/reroll/next) -> next PRE_WAVE
```

20 waves total, bosses at 10 and 20, victory after 20, death = game over.

```gdscript
# arena.gd core
enum WaveState { PRE_WAVE, COMBAT, WAVE_CLEAR, SHOPPING }

func _physics_process(delta: float) -> void:
	if GameManager.current_state != GameManager.State.PLAYING:
		return
	match _wave_state:
		WaveState.PRE_WAVE:
			_state_timer -= delta
			if _state_timer <= 0.0: _start_combat()
		WaveState.COMBAT:
			_combat_time_remaining -= delta
			hud.update_wave_timer(_combat_time_remaining)
			if _combat_time_remaining <= 0.0: _start_wave_clear()
		WaveState.WAVE_CLEAR:
			_state_timer -= delta
			if _state_timer <= 0.0: _start_shopping()
```

Wave clear = spawner off, `kill_all_enemies()`, gold bonus (5 + wave*2),
flash + slow_motion(0.4, 0.8) + zoom pulse. GameManager pauses the tree for
LEVEL_UP / SHOPPING / PAUSED / GAME_OVER states and unpauses on PLAYING:

```gdscript
func change_state(new_state: State) -> void:
	current_state = new_state
	state_changed.emit(new_state)
	match new_state:
		State.PLAYING: get_tree().paused = false
		State.PAUSED, State.LEVEL_UP, State.SHOPPING, State.GAME_OVER:
			get_tree().paused = true
```

Arena is a 6000x6000 field: background ColorRect, StaticBody2D walls on layer 5
at +-3020, Line2D border for visibility. Player collides with walls; enemies
do not (spawn logic clamps them).

## Player

```
Player (CharacterBody2D, layer 1, mask 16/Walls)
  CollisionShape2D (CircleShape2D radius 14)
  Body (Polygon2D, arrow shape, character color)
  Hurtbox (Area2D, layer 0, mask 34)
    CollisionShape2D (CircleShape2D radius 12)
  PickupRange (Area2D, layer 0, mask 4)
    CollisionShape2D (CircleShape2D radius 140, driven by GameManager stat)
  WeaponMount (Node2D)         # weapons attach here
  Camera2D (smoothing on, speed 4.0)
```

Movement is trivial by design - all depth lives in the build:

```gdscript
func _move() -> void:
	var input := Input.get_vector("move_left", "move_right", "move_up", "move_down")
	velocity = input * GameManager.player_speed
	move_and_slide()
	if input.length_squared() > 0.01:
		body.rotation = input.angle()
```

Dash: 0.14s invincible burst at 650px/s, 1.2s cooldown, afterimage ghost
(Polygon2D copy, tween alpha to 0 over 0.2s) every 0.025s. Invincibility timer =
dash duration + 0.08. HUD shows the cooldown bar.

Contact damage: do NOT use `area_entered` signals. Check
`hurtbox.get_overlapping_areas()` manually each `_physics_process` and apply
damage with a 0.6s invincibility window. Signals miss continuous contact;
polling + i-frames is reliable.

Player also handles: regen tick (1s interval, `GameManager.player_regen` HP),
pickup magnet (attract pickups inside PickupRange), and a `_weapons` Dictionary
keyed by weapon id - `add_or_upgrade_weapon(id)` upgrades if owned, else
instantiates the weapon script onto WeaponMount.

## Weapons (auto-fire, no aiming)

All weapons are Node2D scripts on WeaponMount, firing from `_physics_process`.
Damage scales with `GameManager.player_damage_mult`, cooldowns divide by
`player_attack_speed_mult`, crits roll `player_crit_chance` for 2x. Three bases:

- Projectile: fires at nearest enemy within 800px (compare
  `distance_squared_to` against 640000, never sqrt). Extra projectiles fan out
  at 0.15 rad spread. If no target, retry in 0.1s instead of a full cooldown.
- Orbital: N shields orbit at radius 80, speed 3.5 rad/s. Per-enemy hit
  cooldown Dictionary (0.4s keyed by instance id) so one orbit does not
  multi-hit the same enemy every frame.
- Area (nova): every 3.0s damage all enemies within radius 120 (group scan +
  distance_squared), show an expanding ring tween.

```gdscript
func _find_nearest_enemy() -> Node2D:
	var nearest: Node2D = null
	var best := MAX_TARGET_RANGE_SQ
	for enemy in get_tree().get_nodes_in_group("enemies"):
		if not is_instance_valid(enemy): continue
		var d := global_position.distance_squared_to(enemy.global_position)
		if d < best:
			best = d
			nearest = enemy
	return nearest
```

Group scan is fine to ~250 enemies (the max_alive cap); past that use spatial
hashing.

## Pickups and XP

XP is NOT a physical pickup - it auto-earns on kill (`GameManager.add_xp`,
amount = enemy xp_value). Gold and health orbs ARE physical Area2D pickups in
the "pickups" group with magnet behavior: once `attract()` is called (player
range overlap, or level-up vacuums all), accelerate toward the player at up to
650px/s and collect within 12px. Level-up curve:
`xp_needed = 5 + level*level + level*3`.

## Camera effects (the juice layer)

`camera_effects.gd` attaches as a child of the player's Camera2D. Provides
`screen_shake(intensity, duration)` (tween_method randomized offset decaying to
zero), `screen_flash(color, duration)`, `slow_motion(scale, duration)` (set
`Engine.time_scale`, restore via tween with `set_ignore_time_scale(true)`),
`zoom_pulse`, and a low-HP vignette shader that fades in below 35% health.
Register it on GameManager (`GameManager.camera_fx`) so every system can call it.

## Build order

1. project.godot: autoloads, input map, layer names, main scene, 1920x1080
   canvas_items/expand stretch. Audio buses: Master, Music, SFX.
2. Scenes smallest-first: pickup, projectile, enemy_projectile, enemy, player,
   character_select, main, arena.
3. Base loop: player move + dash, projectile weapon, walker enemies chasing.
4. GameManager stats + HUD (health, gold, XP bar, wave timer, kills, dash bar).
5. Wave state machine + spawner + wave data (progression file).
6. Level-up upgrades, shop, elites, evolution, characters (progression file).

## Traps

- Physics-based enemies. Never RigidBody2D or move_and_slide for enemies -
  direct `position +=` on Area2D. Hundreds of colliding bodies kill perf;
  enemies only need to chase, not collide with each other.
- Heavy enemy scenes. One Area2D + CollisionShape2D + Polygon2D + ProgressBar.
  No AnimationPlayer, no particles, no per-enemy shader materials - you will
  have 200+ alive.
- UI without `process_mode = ALWAYS`. The tree pauses during level-up, shop,
  and game over; without ALWAYS, no button responds and the game soft-locks.
- Manual aim. The entire input surface is move + dash. Weapons auto-target;
  adding aim breaks the genre.
- Editor-connected signals on runtime-instantiated scenes. Connect in `_ready()`
  via code for enemies/projectiles/pickups - editor connections on templates
  are fragile and undebuggable.
- On-screen spawns. Always 650-900px from the player, clamped to arena bounds.
