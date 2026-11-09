---
name: summer-board-modeling
description: "How granular to model a game on its Summer Board: what earns a type, what stays a note or a field, and starter type sets per genre."
license: MIT
compatibility: [Cursor, Claude Code, Codex, Windsurf, Gemini, OpenCode, Factory, Copilot]
category: workflow
user-invocable: true
allowed-tools: summer_call summer_search
---

# How granular to model a game

Types are for the things a game has many of and the code reads. Everything else is notes. A board with 6 good types is easy to read; one with 25 thin ones is a mess nobody keeps up to date. When unsure, model less: adding a type later is easy, merging two is work for a person.

Defining them without duplicates: `summer-board-types`.

## 1. Does it earn a type?

A thing earns a type when all three are true:
1. **There are 3 or more of it,** now or soon. One hook, one pitch, one world are notes.
2. **They share 2 or more fields people compare.** "Which boss has the most hp?" means hp is a field and Boss things are cards.
3. **The game will use the data,** or the art and sound work needs it. A list nobody builds from is a note list.

Not a type: the hook, the pitch, the core loop, the mood, the timeline, open questions, playtest notes, references. They stay notes and pictures in frames.

## 2. One type with a choice, or two types?

Start with one type and a choice field. Split only when the kinds need 3 or more different fields.

- Hero, NPC, enemy, boss: one **Character** with `role`. They all have a name, a look and hp.
- Sword, potion, key: one **Item** with `kind`, until weapons need damage, range and rate and potions need none of them. Then **Weapon** splits off and Item keeps the rest.
- Forest level, ice level: one **Level** with `biome`. Never a type per level.

A type per instance (a `Dragon` type with one card) is always wrong: that is a card.

## 3. Field or linked type?

- A value: a field. `hp`, `biome`, `price`.
- A list of plain words: an array of strings. `tags`, `palette`.
- A thing with its own fields, used in more than one place: its own type, linked with `x-ref`. A boss's drops are Items; a level's boss is a Character.
- Never nest: if you want an object inside an object, that inner thing is a type.

## 4. Which fields earn a place

Keep a field if it changes play, or someone builds from it:
- **Play:** hp, damage, speed, cost, cooldown, unlock_level, spawn_rate, duration.
- **Build:** look (one line for art), palette, size, sound (one line), the links to other cards.
- **Track:** nothing. Status and owner come from the card's task; do not add `status`, `done` or `assigned_to` fields.

Drop: backstory paragraphs, design rationale, notes to self. Put prose in a note next to the card.

Numbers get units in the description ("metres per second"). Prefer an `enum` over free text when the game branches on it (`role`, `biome`, `rarity`).

Keep types short: 4 to 10 fields. More than 12 usually means two types in one.

## 5. How many types

- **Starting a game:** 3 to 6. See `starter-sets.md` for the genre.
- **A full game:** rarely more than 12. Over 15, look for types to merge (section 2) and propose it.
- **A type with 1 or 2 cards** after a while is probably a note or a choice value in another type.

## 6. Grow it when the need is real

- A person keeps writing "hp 30" in notes: time for a field.
- Three notes describe the same kind of thing: time for a type, and turn the notes into cards.
- Agents keep asking "which X are left": X should be cards with tasks.

Grow from what is on the board, not from what a game of this genre might have.

## Examples

Too fine:
```
Hero, Villain, Goblin, Orc, Shopkeeper, Sword, Axe, HealthPotion, ManaPotion, ForestLevel
```
Better:
```
Character (role: hero, villain, enemy, npc)   Item (kind: weapon, potion, key)   Level (biome)
```

Too coarse:
```
Thing (kind: character, level, item, sound)
```
Better: one type per kind of thing the code treats differently. A level and a sword never share fields.

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@latest` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `summer_search` | `summer ops search "<what you want>"` |
<!-- /shell-commands -->
