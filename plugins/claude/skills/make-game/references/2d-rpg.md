# 2D Action RPG - Core

Top-down action RPG blueprint: event-driven architecture, player controller,
stats pipeline, combat components, weapons, and area transitions. NPCs,
dialogue, quests, inventory, perks, status effects, and enemies live in
`2d-rpg-content.md`.

## Minimum playable base (build this first)

One level extending LevelBase: player with 8-way movement + one sword swing +
dodge roll, a couple of chase enemies with `take_hit()`, HUD health bar. Prove
"move, hit enemy, get hit, see numbers" before any dialogue or quest exists.

Two rules for every scene:

- Dynamic viewport: `display/window/stretch/mode = "canvas_items"`,
  `stretch/aspect = "expand"`. UI via Control anchors; compute spawn points and
  bounds from `get_viewport_rect().size`, never hardcoded 1920x1080.
- Playable slice: every input gets feedback through the Juice autoload (shake,
  flash, float text, hitstop). A silent build fails even if every system works.

## Architecture: modules + EventBus

Systems NEVER reference each other directly. All cross-system communication
flows through EventBus, a global signal bus autoload. Each module can be added
or removed without breaking others.

```
core/
  autoloads/{event_bus,game_manager}.gd
  levels/level_base.gd
  player/{player.gd,player.tscn}
modules/
  audio/audio_manager.gd
  combat/{hitbox_component,hurtbox_component,knockback_component,
          stats,modified_value}.gd
  dialogue/{dialogue_box,dialogue_data,npc}.gd
  enemies/{enemy_base,enemy_data,enemy_database,enemy_spawner}.gd
  effects/{status_effect,effect_manager,burn_effect,freeze_effect,poison_effect}.gd
  inventory/{inventory_manager,inventory_ui,item_data}.gd
  juice/juice.gd
  loot/{area_transition,item_drop,loot_table,pickup_orb,treasure_chest}.gd
  progression/{perk_data,perk_database,perk_pool,perk_selection_ui}.gd
  quests/{quest_data,quest_manager}.gd
  weapons/{weapon_base,weapon_data,weapon_manager,projectile}.gd
  weapons/weapons/{sword,bow,staff,orb}.gd
content/levels/{town,forest,dungeon}.gd
ui/{hud/hud.gd, menus/{main_menu,pause_menu,game_over}.gd}
```

Six autoloads, in this order: EventBus, GameManager, AudioManager,
QuestManager, Juice, InventoryManager.

### EventBus signal groups (define up front)

Player: `player_health_changed`, `player_energy_changed`, `player_died`,
`player_leveled_up`, `player_xp_gained`. Combat: `damage_dealt`,
`enemy_killed(enemy, xp_value)`, `player_attack_executed`. Interaction:
`interaction_available/unavailable`, `dialogue_started/ended`. Inventory:
`item_picked_up/used/equipped/unequipped`, `gold_changed`. Quests:
`quest_started/updated/completed`, `quest_objective_progressed`. Progression:
`level_up_ready`, `perk_selected`, `perk_applied`. Scene:
`scene_transition_started/completed`, `scene_ready`. Spawner:
`wave_started/cleared`. UI: `notification_requested(text, color)`,
`boss_health_changed`.

## Physics layers and input

| Layer | Name |
|-------|------|
| 1 | terrain |
| 2 | player |
| 3 | enemies |
| 4 | player_hitbox |
| 5 | enemy_hitbox |
| 6 | interactions |
| 7 | pickups |

Hitbox on 4/5, hurtbox monitors the opposite side's layer.

Input map (9 actions): move_up/down/left/right (WASD + arrows + stick), attack
(LMB/Space), dodge (RMB/Shift), interact (E), pause (Esc), inventory (I).

## GameManager: states and transitions

```gdscript
enum GameState { MAIN_MENU, PLAYING, PAUSED, DIALOGUE, INVENTORY, LEVEL_UP, GAME_OVER }
```

Everything except MAIN_MENU/PLAYING pauses the tree; `change_state()` handles
pause/unpause. Gate gameplay input on `GameManager.is_gameplay_active()`.

Scene transition flow (fade overlay owned by GameManager):
`transition_to_scene(path, spawn_point, spawn_direction)` -> fade to black
0.3s -> emit `scene_transition_started` -> `change_scene_to_file` -> wait TWO
process frames -> emit `scene_ready`, state PLAYING -> fade in -> emit
`scene_transition_completed`. The player reads
`GameManager.player_spawn_point` / `player_spawn_direction` in `_ready()`.
Guard with an `_is_transitioning` flag; never call transition from inside a
transition callback.

Area transitions are trivial once this exists - an Area2D with three exports
(`target_scene`, `spawn_point`, `spawn_direction`) whose `body_entered` calls
`GameManager.transition_to_scene()`. Place at map edges and doorways.

## Player controller

```
Player (CharacterBody2D, layer 2, group "player")
  CollisionShape2D (circle, radius 8)
  WeaponManager (Node2D)
  HurtboxComponent (Area2D)
    CollisionShape2D (circle, radius 10)
  InteractionArea (Area2D)
    CollisionShape2D (circle, radius 30)
  Camera2D
```

State machine: `IDLE, MOVE, ATTACK, DODGE, HURT, DEAD, INTERACT`.

```gdscript
var input := Input.get_vector("move_left", "move_right", "move_up", "move_down")
if input.length() > 0.1:
	facing = input.normalized()
	velocity = facing * stats.get_speed()
	state = State.MOVE
else:
	velocity = velocity.move_toward(Vector2.ZERO, stats.get_speed() * 10.0 * delta)
	state = State.IDLE
move_and_slide()
```

- Attack: manual aims at mouse direction; optional auto_attack targets the
  nearest enemy within 250px. Delegate to
  `weapon_manager.attack(direction)` gated by `can_attack()`.
- Dodge roll: costs 20 energy (`stats.use_energy` returns false if broke),
  0.25s duration, invincible for the duration, fading trail rects.
- Hurt: ignore if invincible/dead/dodging. `stats.take_damage`, 0.5s i-frames,
  knockback velocity, `Juice.shake(5)`, red flash, float text, emit
  `player_health_changed`.

## Stats: the ModifiedValue pipeline

`final = (base + additive_sum) * (1.0 + multiplicative_sum)`. Modifiers are
tagged with a source string so a whole buff can be removed in one call:

```gdscript
stats.add_modifier("attack", 5, "fire_buff")
stats.remove_modifier("attack", "fire_buff")
```

Stats resource: base_max_health 100, base_attack 10, base_defense 5,
base_speed 120, base_crit_chance 0.05, base_crit_multiplier 1.5. Key methods:
`take_damage()` returns `{damage, killed}`, `calculate_damage(is_crit)`,
`roll_crit()`, `add_xp()` returns true on level-up, `use_energy()`.

MUST call `stats.initialize()` in `_ready()` - forgetting it leaves the
pipeline null and everything crashes on first hit.

Level-up: +10 max HP, +2 attack, +1 defense, +3 speed, full heal.
XP needed = `50 + level * 30`.

## Combat components (reusable trio)

- HitboxComponent (Area2D): the damage dealer. `damage`, `knockback_force`,
  `hit_cooldown` (per-target cooldown dictionary), `try_hit(target) -> bool`,
  `activate()/deactivate()` (deactivate clears cooldowns). Emits
  `hit_landed(target, damage, knockback)`.
- HurtboxComponent (Area2D): the receiver. `invincibility_duration` 0.3s,
  emits `damage_received(amount, source, knockback)` via
  `take_hit(damage, source, knockback)`.
- KnockbackComponent (Node on any CharacterBody2D): decaying velocity,
  `resistance` 0-1, `decay_rate` 8. `apply_knockback(force)` then add
  `get_knockback_velocity()` to movement.

Attach these to player, enemies, chests - anything hittable. This trio is
what keeps combat code out of entity scripts.

## Weapon system (data-driven)

WeaponData resource carries everything: type string, base_damage,
attack_speed (attacks/sec), knockback, range, piercing, projectile
speed/count/fan_angle, area_radius, orbit_count/speed, color. WeaponManager
(child of player) equips, switches (1-4 keys / scroll), and delegates attacks;
a `WEAPON_SCRIPTS` const maps type string -> preloaded script.

Four archetypes:

- Sword: 120-degree arc swing, alternating direction, ease-out for weight,
  forward lunge, physics cone query, trail.
- Bow: 0.15s draw, then a fan of projectiles (count + fan_angle from data).
- Staff: homing bolts (homing_strength 3.0) + optional `trigger_nova()` AoE.
- Orb: passive - orbits the player, contact damage with per-enemy cooldown,
  always active regardless of selected weapon.

One generic projectile script serves bow, staff, AND enemies: straight or
homing, piercing (tracks hit bodies to prevent double-hit), knockback, trail,
lifetime despawn. Configure per-shot via properties + `collision_mask` and a
`source_node` so it never hits its shooter.

## LevelBase and level authoring

All levels extend LevelBase, which does the boring wiring once:

```gdscript
func _ready() -> void:
	_spawn_player()      # instantiate player.tscn
	_setup_ui()          # HUD, PauseMenu, DialogueBox, Inventory, GameOver, PerkSelectionUI
	_setup_connections()
```

A concrete level sets `level_name`, calls `super._ready()`, then adds its
spawner / NPCs / AreaTransitions. Town = safe hub with NPCs. Forest = combat
area with wave spawner. Dungeon = boss arena with a kill gate.

## Build order

1. project.godot: 6 autoloads in order, input map, layer names, 1920x1080
   canvas_items/expand.
2. EventBus with the full signal catalog (empty handlers are fine).
3. Stats + ModifiedValue, then the combat component trio.
4. Player: movement -> dodge -> WeaponManager with sword only.
5. One chase enemy + Juice feedback + HUD health bar. Playable slice check.
6. GameManager transitions + LevelBase + a second area with AreaTransition.
7. Content systems from `2d-rpg-content.md`: enemies, NPCs, quests,
   inventory, perks, effects, save/load.

## Traps

- Direct module references. Never `get_node("/root/QuestManager")` from a
  weapon script - emit an EventBus signal. Modules only know EventBus and
  their own data types; anything else rots into circular dependencies.
- Skipping `stats.initialize()`. Null pipeline, crash on first damage.
- Huge `_ready()` chains needing other nodes. Await
  `get_tree().process_frame` or connect to `EventBus.scene_ready` instead.
- UI without `process_mode = ALWAYS`. Dialogue, inventory, level-up, and
  pause all pause the tree; the UI must keep processing.
- Wrong hitbox/hurtbox layers. Hitbox layer 4/5, hurtbox masks the OPPOSING
  side. Getting this backwards silently produces no hits.
- Renaming InteractionArea. NPC scripts access `$InteractionArea` by exact
  name; a rename kills interaction with no error at parse time.
