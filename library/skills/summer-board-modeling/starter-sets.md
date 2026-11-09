# Starter type sets

The first types for a genre. Start with the ones marked first; add the rest when the board needs them (`SKILL.md` section 6). Fields are suggestions: keep the ones this game uses.

Define them in the order listed: an `x-ref` names a type that already exists. A later type that the first ones should link to (Faction, Mode) gets its link added to them when it arrives.

## Action RPG / adventure

First:
- **Item:** name, kind (weapon, armour, potion, key, material), rarity, price, look
- **Character:** name, role (hero, npc, enemy, boss), hp, look, drops (x-ref Item, array)
- **Place:** name, biome, mood, connects_to (x-ref Place, array)

Later: **Ability** (name, cooldown, damage, range), **Quest** (name, giver x-ref Character, reward x-ref Item array), **Faction** (name, goal; then add faction x-ref Faction to Character).

## Platformer

First:
- **Character:** name, role (player, enemy, boss), hp, move_speed, look
- **Level:** name, theme, length (short, medium, long), new_mechanic, boss (x-ref Character)
- **Pickup:** name, effect, duration

Later: **Hazard** (name, damage, pattern).

## Shooter

First:
- **Weapon:** name, damage, fire_rate, range, ammo, look
- **Character:** name, role (player, enemy, boss), hp, move_speed, weapon (x-ref Weapon)
- **Map:** name, size (small, medium, large)

Later: **Mode** (name, rules, team_size; then add modes x-ref Mode array to Map).

## Racing

First:
- **Track:** name, length_km, surface, weather, difficulty
- **Vehicle:** name, top_speed, acceleration, handling, look

Later: **Driver** as Character, **Upgrade** (name, stat, amount, price).

## Survival / crafting

First:
- **Item:** name, kind (resource, tool, food, building), stack_size, look
- **Recipe:** name, makes (x-ref Item), needs (x-ref Item, array), station
- **Biome:** name, danger, resources (x-ref Item, array)

Later: **Character** (creatures and npcs), **Structure** if buildings need their own fields.

## Strategy / tower defence

First:
- **Unit:** name, role, hp, damage, range, cost, build_time
- **Building:** name, cost, produces (x-ref Unit, array)
- **Map:** name, players, size

Later: **Faction** (name, units x-ref Unit array), **Upgrade**.

## Puzzle

First:
- **Mechanic:** name, rule (one line)
- **Puzzle:** name, mechanic (x-ref Mechanic), difficulty, solution (one line)

Most puzzle games need nothing more.

## Party / multiplayer minigames

First:
- **Minigame:** name, players, duration_s, goal, controls (one line)

Later: **Map** if minigames share arenas.

## Narrative game

First:
- **Character:** name, role, want, look
- **Scene:** name, place, characters (x-ref Character, array), choice (one line)

Later: **Place**, **Ending** (name, reached_by).
