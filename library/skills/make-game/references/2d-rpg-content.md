# 2D Action RPG - Content Systems

The content layer on top of `2d-rpg.md`: enemies, NPCs and dialogue, quests,
inventory, loot, perks, status effects, and save/load. Everything here talks
to the rest of the game only through EventBus and the autoloads.

## Enemies (data-driven, five archetypes)

EnemyData resource defines stats + behavior; enemy_base.gd implements all
five behaviors and reads the data. No per-enemy scenes.

```gdscript
enum BehaviorType { CHASE, RANGED, SWARM, TANK, BOSS }
```

- CHASE (slime): direct pursuit, melee lunge, low knockback resistance.
- RANGED (skeleton archer): holds preferred distance, fires projectiles,
  strafes at range, backs off when crowded.
- SWARM (bat): fast, random jitter movement, contact damage.
- TANK (golem): slow, high HP, knockback_resistance 0.8, ground slam with
  screen shake.
- BOSS (dark mage): cycling pattern (single shot -> fan of 3 -> charge),
  phase 2 at 40% HP (faster everything + aura), can summon minions. Emits
  `boss_health_changed` for the HUD boss bar.

EnemyData fields that matter for tuning: max_health, contact_damage,
move_speed, detection_range 200, attack_range 35, attack_cooldown 1.2,
knockback_resistance, xp_value, gold_min/max.

EnemyDatabase registers everything in code (no .tres files):
`db.get_enemy("slime")`, `db.get_enemies_for_wave(5)` returns a
wave-appropriate mix. Built-ins: slime, skeleton_archer, bat, golem,
dark_mage.

Contract: every enemy is in the "enemies" group and exposes
`take_hit(damage: int, source_position: Vector2, is_crit: bool = false)`.
Weapons and projectiles call it directly. Death drops XP + gold orbs via
`_drop_loot()` and emits `EventBus.enemy_killed(enemy, xp_value)`.

EnemySpawner is wave-based: `wave_interval` 12s, `enemies_per_wave_base` 3,
`enemies_per_wave_growth` 1, `max_enemies` 20, `difficulty_scale` 1.08
(HP/damage multiplier per wave). `spawn_boss("dark_mage", pos)` for arenas.

## NPCs and dialogue

DialogueData is a resource with a speaker name and a lines array. Each line
is a dictionary supporting optional keys:

```gdscript
{
  "text": "Hello!",
  "speaker": "Elder",                        # override
  "choices": [{"text": "Yes", "next": 2}],   # branching
  "action": "start_quest:slay_monsters",
  "condition": "quest_complete:slay_monsters"
}
```

Actions: `start_quest:<id>`, `give_item:<resource_path>`, `give_gold:<n>`,
`heal`. Conditions: `quest_complete:<id>`, `quest_active:<id>`,
`has_item:<id>`. This tiny string DSL covers most RPG dialogue needs -
resist building a graph editor.

Interaction flow (the pause dance):

```gdscript
func interact(player: Node2D) -> void:
	EventBus.dialogue_started.emit(npc_name)
	GameManager.change_state(GameManager.GameState.DIALOGUE)  # pauses tree
	await _run_dialogue(start_index)
	EventBus.dialogue_ended.emit()
	GameManager.change_state(GameManager.GameState.PLAYING)
	player.end_interaction()
```

NPC = CharacterBody2D + CollisionShape2D + child Area2D named EXACTLY
"InteractionArea" on the interactions layer. Player entering shows a prompt;
interact key starts dialogue. When building NPCs in code, add the node tree
first, `add_child` it, THEN set script properties (npc_name, dialogue,
quest_to_give) - properties set before the script enters the tree can be
stomped by `_ready`.

DialogueBox: typewriter at 40 chars/sec, click skips to full text, click
again advances, choices render as buttons. Must be process_mode ALWAYS (tree
is paused during dialogue).

## Quests

QuestData: id, title, description, objectives array
(`{"id": "kill_slimes", "description": "Kill 3 slimes", "target": 3}`),
xp_reward, gold_reward, prerequisite_quest_id.

QuestManager (autoload) API: `start_quest(data)`,
`progress_objective(quest_id, objective_id, amount = 1)`,
`is_quest_active/complete(id)`, `get_objective_progress(id, obj_id)`. When
all objectives hit target the quest auto-completes, grants rewards, and
emits `quest_completed`.

Wiring kills to quests happens in the LEVEL script, not the enemy:

```gdscript
func _ready() -> void:
	EventBus.enemy_killed.connect(_on_enemy_killed)

func _on_enemy_killed(_enemy: Node2D, _xp: int) -> void:
	QuestManager.progress_objective("slay_monsters", "kill_enemies")
```

Enemies stay dumb; levels decide what counts.

## Inventory and items

InventoryManager (autoload): 20 item slots, 3 equipment slots (weapon,
armor, accessory), gold. `add_item()` returns false when full;
`use_item()` only works on consumables; `equip_item()` auto-routes by the
item's slot; `get_total_stat_bonus("attack")` sums equipment bonuses for the
stats pipeline; `clear()` on restart.

ItemData: ItemType (CONSUMABLE/WEAPON/ARMOR/ACCESSORY/KEY_ITEM), Rarity
(COMMON/UNCOMMON/RARE/EPIC with white/green/blue/purple colors),
`stat_bonuses: Dictionary` ("attack" -> 5), heal_amount, buy/sell price.

## Loot

- LootTable: guaranteed gold range + guaranteed XP, then `drop_chance` roll
  over weighted entries (`{"item", "weight", "min_count", "max_count"}`).
  `table.roll()` returns the drops.
- PickupOrb: XP/gold orbs from dead enemies, magnet-pull within 100px,
  accelerating toward the player.
- TreasureChest: interactable static body - guaranteed item + gold orbs +
  a loot table roll on open.
- ItemDrop: dropped items render with a rarity glow.

## Perks (level-up progression)

PerkData: id, name, description (supports a `{value}` token), max_level 3,
`stat_modifiers: Dictionary`, `special_effect: String` + effect_value for
non-stat perks. Built-in pool:

| ID | Effect per level |
|----|------|
| attack_up | +3 attack |
| speed_boost | +20 speed |
| thick_skin | +2 defense |
| vampirism | 3% lifesteal |
| burning_strikes | apply burn on hit |
| frost_touch | 30% slow on hit |
| critical_eye | +5% crit |
| multishot | +1 projectile |
| thorns | 20% reflect |
| regeneration | 1 HP/sec |
| xp_boost | +25% XP |
| last_stand | +50% damage below 30% HP |

PerkPool: `roll_selection(3)` (unowned or upgradable only),
`acquire_perk()`, `get_stat_bonus("attack")`, `has_effect("lifesteal")` +
`get_effect_value()`, `reset()` per run.

Level-up flow: `stats.add_xp()` true -> emit `player_leveled_up` then
`level_up_ready` -> PerkSelectionUI shows 3 cards (LEVEL_UP state pauses
tree) -> pick emits `perk_selected` -> player acquires and applies stat
modifiers via `stats.add_modifier` -> resume. Special effects (lifesteal,
thorns, multishot) are checked at their point of use via
`pool.has_effect()`, not applied as stats.

## Status effects

StatusEffect base (Node): effect_id, duration 3s, tick_interval 1s,
max_stacks 3. Override `tick()`, `on_expire()`, `on_max_stacks()`,
`get_speed_multiplier()`. `add_stack()` refreshes duration.

EffectManager attaches to any entity: `apply_effect(BurnEffect, entity)`
handles stacking, `get_speed_multiplier()` returns the product of all active
effects (feed it into movement), `remove_effect/remove_all`.

Built-ins and their max-stack payoffs (the interesting design bit -
stacking to cap triggers a burst):

- Burn: 3 dmg per 0.5s, 5 stacks; at cap, a 15x damage burst.
- Freeze: 30% slow per stack, 3 stacks; at cap, full 2s stun.
- Poison: 2 dmg/s, 3 stacks; each new stack extends duration 2s; supports
  lifesteal back to the source.

## Juice quick reference

```gdscript
Juice.shake(4.0)                          # camera shake
Juice.hitstop(0.05)                       # freeze frame on big hits
Juice.flash_node(enemy, Color.WHITE, 0.1)
Juice.spawn_float_text(node, "+50 XP", Color.GOLD)
Juice.spawn_hit_particles(pos, Color.RED, 6)
Juice.bounce(node, 1.2)                   # scale bounce
Juice.register_camera(camera)             # once, from player _ready()
```

If `register_camera` is never called, shake silently does nothing - a
classic "why is there no juice" bug.

## HUD and notifications

HUD subscribes to EventBus only: health/energy/XP bars, level, gold, active
quest list, and a notification label (fade in, 2s hold, fade out) driven by
`EventBus.notification_requested.emit("Quest complete!", Color.GOLD)`.
HUD also owns pause and inventory toggles.

## Audio

AudioManager: `play_music(path)` crossfades (pass false for hard cut),
`play_sfx(stream, pitch_variation)`, `play_sfx_at(stream, pos, variation)`
positional. Auto-creates Music and SFX buses if missing. Town theme in the
hub, battle music in combat areas, switch on `scene_ready`.

## Save/load

GameManager saves to `user://savegame.cfg` (ConfigFile): current level path
+ spawn position, player stats (level, XP, health, attack, defense),
inventory + equipment as resource paths, gold, quest state (active with
progress, completed ids). `save_game()` from the pause menu,
`load_game() -> bool` from Continue, `has_save()` gates the button.
`restart_game()` clears inventory, resets perks, returns to town.

Save items by resource path, not serialized objects - paths survive schema
changes; serialized Resources do not.

## Order of content work

1. Enemy roster (CHASE first, then RANGED; TANK/SWARM/BOSS after combat
   feels right) + spawner in the forest level.
2. Loot orbs + level-up perks (progression pull).
3. One NPC with dialogue in town, one kill quest wired through the level.
4. Inventory + a treasure chest + equipment stat bonuses.
5. Status effects on weapons/perks (burning_strikes, frost_touch).
6. Boss + dungeon kill gate, then save/load last - it serializes everything
   above, so build it when the shapes are stable.
