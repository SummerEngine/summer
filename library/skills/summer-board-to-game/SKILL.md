---
name: summer-board-to-game
description: "Bring a Summer Board's typed cards into the game as Godot Resources, load them through BoardData, and keep board and game in step."
license: MIT
compatibility: [Cursor, Claude Code, Codex, Windsurf, Gemini, OpenCode, Factory, Copilot]
category: workflow
user-invocable: true
allowed-tools: Read Grep Edit Write summer_call summer_search summer_get_script_errors summer_play summer_stop
---

# Board cards in the game

Cards on the board are the game's design data. Export them once and the game loads exactly what the board says: one Resource class per type (`CharacterData` for Character), one `.tres` per card, and a `BoardData` script that lists them all. The board is the source; the game follows it.

## 1. Export

```
board.export {gameId, agent}                        -> files: [{path, content}], skipped, how
board.export {gameId, agent, types: ["Character"]}  -> only those types and what they link to
```
Write every file in `files` at its path with your file tools. A file under `res://data/` that starts with the generated header and is not in `files` belongs to a card or type that is gone: delete it. Then let the editor scan the project (open it, or it rescans on focus) and check the console for errors.

What you get:
- `res://data/types/character_data.gd`: `class_name CharacterData extends Resource`, one `@export` per field. A choice is `@export_enum`, a link is the linked type (`@export var faction: FactionData`, `@export var drops: Array[ItemData]`). A field named like a GDScript word gets a trailing `_` (`class` is `class_`).
- `res://data/characters/ember_knight.tres`: one per card.
- `res://data/board_data.gd`: `class_name BoardData`, every card preloaded, a list per type and a lookup by name.

`skipped` lists links left out: a card that is gone, a card of the wrong type, or a link that would make two files load each other (Fox's rival is Ember Knight and the Knight's rival is Fox: one of the two is left out). Fix the cards if the game needs that link.

Every generated file starts with a `Generated from the Summer Board` header. Re-exporting replaces them. Your own scripts never go in `res://data/`.

## 2. Use it in gameplay code

```gdscript
# Every card of a type, as typed Resources.
for c in BoardData.characters:
	if c.role == "enemy":
		spawn_table.append(c)

# One card by name.
var boss: CharacterData = BoardData.character("Ember Knight")
health.max_value = boss.hp
for item in boss.drops:
	loot.add(item)

# Links are real references.
print(boss.faction.name)
```

- Read stats from the resource; do not copy numbers into scripts. The person tunes hp on the card, and the game follows.
- A resource is shared by everything that loads it. Before changing values at run time (damage taken, upgrades), `duplicate()` it, or keep run-time state in the node.
- A link whose card is gone, or that `skipped` names, is `null`. Check before use where a missing card would crash.
- Names follow the type: `BoardData.quest_steps` and `BoardData.quest_step("...")` for QuestStep.
- Look up by name only for named things (the boss, the starting level). Iterate for lists (all enemies, all levels).

## 3. Keep board and game in step

- **Tune on the card, then re-export.** `board.canvas {action: "update", itemId, props: {hp: 1200}}`, then `board.export`. Never edit a generated `.gd` or `.tres` by hand or in the inspector: the next export overwrites it.
- **A field the game needs and the type lacks:** add it to the type (`summer-board-types` section 3), fill the cards, re-export. Do not add an `@export` to the generated class.
- **Logic is not data.** How a boss fights is a script in the game; its hp, speed and drops are the card. A card can name the behaviour as a choice (`behaviour: "charger"`) that your code maps to a script.
- **Say what you did.** After an export the game uses, `board.post` one line: what changed in the game ("Enemies now spawn from the 6 Character cards with role enemy").
- **Re-export when the board changes.** A card update that a teammate's message names, or a task done on a card the game uses, means re-export before you test.

## 4. Before you say it is done

- The project opens with no errors from `res://data/`.
- Play the scene that uses the data (`playtesting-a-feature`): the boss has the card's hp, the level list matches the board.
- `board.query` the types you used: no card has issues. A card with a missing required field exports with that field at its default, which is usually a bug in play.

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@latest` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `summer_get_script_errors` | `summer engine get-script-errors` |
| `summer_play` | `summer engine play` |
| `summer_stop` | `summer engine stop` |
| `summer_search` | `summer ops search "<what you want>"` |
<!-- /shell-commands -->
