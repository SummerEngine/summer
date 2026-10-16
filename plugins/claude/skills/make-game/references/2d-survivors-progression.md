# 2D Survivors - Progression

The systems layer on top of `2d-survivors.md`: enemy roster, wave-driven
spawning, elites, level-up upgrades, the between-wave shop, weapon evolution,
and characters. Build these only after the core loop (move + auto-fire + chase)
runs.

## Enemy roster (one script, many behaviors)

All types share `enemy_base.gd` (Area2D, "enemies" group), configured through
`setup(type, wave)` - no per-type scenes. HP/speed scale with wave number:

| Type | Behavior | Health | Speed | Special |
|---|---|---|---|---|
| Walker | chase + wobble | 15 + wave*8 | 55 + wave*2 | standard horde unit |
| Runner | fast chase | 8 + wave*4 | 110 + wave*3 | 0.7x scale |
| Tank | slow, big | 50 + wave*15 | 35 + wave*1 | 1.5x scale, 3 XP |
| Boss | massive | 500 + wave*80 | 45 | 2.8x scale, 25 XP |
| Ranged | keeps distance | 12 + wave*5 | 50 + wave*1.5 | fires projectiles |
| Charger | telegraph + dash | 20 + wave*7 | 50 + wave*1.5 | 550px/s burst |
| Spawner | stays back | 80 + wave*20 | 30 | spawns 2-3 minions |

Behavior dispatch is a `match behavior:` in `_physics_process`. Give every
enemy a randomized wobble (`_wobble_phase = randf() * TAU`, per-enemy speed and
amplitude) so hordes look organic instead of converging in a straight line.

Charger is a 4-state machine: WALK -> TELEGRAPH (0.45s, within 320px trigger
range) -> CHARGE (0.4s at 550px/s in the locked direction) -> RECOVER (0.3s),
then 3.5s cooldown. The telegraph is what makes it fair - flash/scale the sprite
during it.

Knockback: on hit, set `_knockback_vel = (pos - source).normalized() * 180`,
decay with `move_toward(Vector2.ZERO, 900 * delta)` and add to movement.

### Hit feedback and death (non-negotiable)

`take_damage(amount, source_pos, is_crit)` must: flash the sprite, spawn a
floating damage number (bigger + colored on crit), spawn directional particles,
apply knockback, show the health bar. Death: `GameManager.add_kill()`,
`add_xp(xp_value)`, drop gold (rare health orb), particle burst, then disable
before animating out:

```gdscript
set_physics_process(false)
set_deferred("monitoring", false)
set_deferred("monitorable", false)
var tween := create_tween().set_parallel(true)
tween.tween_property(self, "scale", scale * 1.5, 0.1)
tween.tween_property(self, "modulate:a", 0.0, 0.1)
tween.chain().tween_callback(queue_free)
```

The `set_deferred` pair matters: freeing an Area2D mid-physics-callback without
disabling monitoring first throws errors.

## Spawner and wave data

The spawner reads a per-wave config and spawns groups on an interval, always
off-screen (650-900px from the player, clamped to arena bounds):

```gdscript
func _random_spawn_pos() -> Vector2:
	var angle := randf() * TAU
	var dist := randf_range(650.0, 900.0)
	var pos := GameManager.player_node.global_position + Vector2.from_angle(angle) * dist
	pos.x = clampf(pos.x, -ARENA_HALF_SIZE, ARENA_HALF_SIZE)
	pos.y = clampf(pos.y, -ARENA_HALF_SIZE, ARENA_HALF_SIZE)
	return pos
```

Each WaveConfig: `enemy_weights: Dictionary`, `spawn_interval`, `group_size`,
`max_alive`, `elite_chance`, `boss: bool`, `hazards: int`, `duration`. Type
selection is weighted random over the dictionary. Hand-tune 20 waves; the ramp
that matters:

| Wave | Types | Interval | Group | Max alive | Elite % | Boss | Duration |
|---|---|---|---|---|---|---|---|
| 1 | walker | 2.5s | 2 | 25 | 0% | no | 20s |
| 3 | +runner | 2.0s | 4 | 45 | 0% | no | 20s |
| 5 | +charger | 1.7s | 5 | 65 | 3% | no | 22s |
| 8 | +tank +ranged | 1.3s | 8 | 100 | 6% | no | 22s |
| 10 | all 6 | 1.1s | 10 | 120 | 8% | YES | 30s |
| 15 | tank heavy | 0.75s | 15 | 190 | 13% | no | 28s |
| 20 | max density | 0.45s | 22 | 250 | 20% | YES | 30s |

Do NOT scale difficulty by HP alone. The ramp is spawn rate + group size +
max alive + type diversity + elite chance + new mechanics at fixed waves.
Bosses spawn 3s into their combat phase via a scene-tree timer.

Arena hazards from wave 3+: spike traps (static) and fire pools (drift at
15-35px/s). Tick damage every 0.6s (6 + wave*1.5) to enemies in radius, half
damage to the player - positioning pressure for both sides.

## Elites

`elite_system.gd` is a static RefCounted helper applied at spawn time with
`elite_chance` probability. One of four modifiers, 3x XP:

- FAST: speed x1.8, HP x1.3, lightened color
- TANKY: HP x3, scale x1.3, contact damage x1.5, darkened
- SPLITTING: HP x1.5, green; on death spawns 2 walker copies at 0.6x scale,
  0.3x HP (use `call_deferred("add_child", copy)` - you are inside a physics
  callback)
- VAMPIRIC: HP x2; heals 8% max HP every 3s

Give elites a visible pulse tween so players can prioritize them.

## Two-track progression

Track 1 - mid-wave level-ups: on level-up the tree pauses, 3 random stat
upgrades from the pool are offered, each stackable to level 3. Also vacuum all
pickups (`attract()` on the "pickups" group) as a reward beat.

| Upgrade | Per level | Stat touched |
|---|---|---|
| Might | +15% damage | player_damage_mult |
| Haste | +12% attack speed | player_attack_speed_mult |
| Swiftness | +20 speed | player_speed |
| Vitality | +15 max HP (and heal 15) | player_max_health |
| Magnetism | +20 pickup range | player_pickup_range |
| Armor | +1 flat reduction | player_armor |
| Regeneration | +0.5 HP/s | player_regen |
| Critical Eye | +5% crit | player_crit_chance |

`get_random_choices(3)` filters out maxed upgrades, shuffles, takes 3.
`apply_upgrade` bumps level and writes the stat straight onto GameManager.
Armor applies as `maxi(1, amount - player_armor)` - always at least 1 damage.

Track 2 - between-wave shop: 4 random items, gold-priced, 4 tiers (Common /
Uncommon / Rare / Legendary). Tier odds shift with wave - by wave 16+:
15% Legendary / 30% Rare / 35% Uncommon / 20% Common; waves 1-5 have no
Legendary at all. Prices scale `cost_base * (1.0 + wave * 0.12)`; reroll costs
`2 + reroll_count + wave / 5` (escalates within a single shop visit).

Items are either stat dictionaries applied to GameManager
(`{"player_armor": 2}`) or weapon grants that call
`player.add_or_upgrade_weapon(id)`. The interesting ones trade off:

```gdscript
_add("glass_cannon", "Glass Cannon", 2, 40,
	{"player_damage_mult": 0.35, "player_max_health": -25}, ["offense"])
_add("berserker_mask", "Berserker Mask", 2, 45,
	{"player_damage_mult": 0.25, "player_attack_speed_mult": 0.20,
	 "player_armor": -3}, ["offense"])
```

Do not skip the shop. Without a between-wave decision point the game is just
"survive longer"; trade-off items are what create builds.

## Weapon evolution

A base weapon evolves when the player owns it AND a specific catalyst upgrade
is maxed (level 3). Check after every upgrade pick and shop purchase; emit
`evolution_available` once per recipe:

| Evolved | Base weapon | Catalyst | Effect |
|---|---|---|---|
| Piercing Barrage | Projectile | Multi Shot | pierces 4+, faster bullets |
| Radiant Barrier | Orbital | Armor | 4 large orbitals + damage pulses |
| Supernova | Holy Nova | Might | bigger AoE + burning ground DOT |

Evolving replaces the node: `queue_free()` the old weapon, erase from the
player's `_weapons` dict, instantiate the evolved script, screen flash + zoom
pulse. DOT zones (Supernova) are a Polygon2D + tween loop: N tick callbacks at
0.5s intervals doing a group distance scan, then fade and free. Guard every
tick with `is_instance_valid` - the zone can outlive enemies and vice versa.

## Characters

Four picks before the run, each a starting weapon + stat override dictionary:

- Sentinel: projectile, no overrides (baseline)
- Berserker: projectile, damage_mult 1.4, speed 240, max HP 80
- Warden: orbital, max HP 150, armor 3, attack_speed 0.85
- Arcanist: nova, attack_speed 1.25, damage_mult 1.15, max HP 70

`GameManager.reset_run()` resets all stats to base, then applies
`selected_character.stat_overrides` via `set(key, value)` and fills health to
max. Character select is just 4 cards that set `selected_character` and load
the arena.

## UI stack (all procedural, all CanvasLayer, all process_mode ALWAYS)

- HUD: health + dash bars top-left, wave counter + timer top-center,
  gold/kills/level top-right, full-width 6px XP bar at the bottom.
- LevelUpUI (layer 20): dark overlay, 3 cards, gamepad focus.
- ShopUI (layer 25): stats panel left, 4 tier-colored item cards, reroll +
  next-wave buttons, "SOLD" placeholders, live stat refresh after purchase.
- PauseMenu / GameOverUI (layer 40): game over shows victory or death plus
  time / kills / level / wave, retry + menu.

Retry = `get_tree().paused = false` THEN `reload_current_scene()`. Forgetting
the unpause is the classic frozen-retry bug.

## Audio integration points

Pooled AudioManager (16 global + 16 positional players, round-robin; all play
methods null-safe so missing streams never crash). Pitch variance 5% global /
10% positional prevents machine-gun repetition. Hook: enemy hit + death
(positional), pickup collect, level-up, shop purchase, weapon fire (-6dB, it
fires constantly), music on combat start with fade.
