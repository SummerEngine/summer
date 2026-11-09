---
name: summer-board-types
description: "Define and reuse types on a Summer Board (Character, Level, Item) so ideas become typed cards: read the board's types first, reuse before you define."
license: MIT
compatibility: [Cursor, Claude Code, Codex, Windsurf, Gemini, OpenCode, Factory, Copilot]
category: workflow
user-invocable: true
allowed-tools: summer_call summer_search
---

# Types on the Summer Board

A type says what a kind of thing on the board is: a Character has a name, a role and hp; a Level has a theme and a boss. A card is one thing of a type, drawn in its type's colour. People list cards by type, turn them into tasks, and the game loads them as data. One board has at most 30 types, shared by every person and agent on it.

How many types and which fields: read `summer-board-modeling` first. This skill is how to define them without making a mess.

## 1. Read before you define

```
board.types {gameId, agent, action: "list"}   -> every type, its properties, how many cards
```
Always, even if you read the board a minute ago: another agent may have defined one since.

Then decide in this order, and stop at the first that fits:
1. **A type already holds it.** Use it as it is.
2. **A type almost holds it.** Extend it: add the field you need (section 3).
3. **It is a kind of an existing type.** An enemy is a Character with `role: "enemy"`. Add a value to the choice, not a new type.
4. **Nothing holds it, and `summer-board-modeling` says it earns a type.** Define it.

Names that mean the same thing are the same type: Enemy, Monster, Foe, Mob, Creature, NPC are all Character with a role. Level, Map, Stage, Area, Zone are one type: use the word the board already uses.

## 2. Define a type

The type is a JSON Schema, a small flat subset:

```
board.types {gameId, agent, action: "define", schema: {
  "title": "Character",
  "description": "Anyone the player meets or plays.",
  "x-color": "amber", "x-icon": "user",
  "type": "object",
  "properties": {
    "name":    { "type": "string" },
    "role":    { "enum": ["hero", "npc", "enemy", "boss"] },
    "hp":      { "type": "integer", "minimum": 1 },
    "look":    { "type": "string", "description": "One line the art pipeline uses" },
    "faction": { "type": "string", "x-ref": "Faction" },
    "drops":   { "type": "array", "items": { "type": "string", "x-ref": "Item" } }
  },
  "required": ["name", "role"]
}}
```

- **Name:** singular, one or two words, capitalised: `Character`, `Level`, `Weapon`, `QuestStep`. Not `Characters`, `character_list`, `GameCharacter`.
- **Property keys:** lower snake case, plain words: `hp`, `move_speed`, `unlock_level`.
- **Property kinds:** `string`, `number`, `integer`, `boolean`, `enum` (a choice), and arrays of those. Nothing nested: a nested thing is a type of its own, linked with `x-ref`. `oneOf`, `$ref`, `pattern` and `default` are refused with what to write instead; `$schema` and `additionalProperties` are fine and ignored.
- **`x-ref: "Faction"`:** the value is the id of a Faction card. Use it for every link between things, so the board draws the link and the game gets a real reference. The linked type must exist first: define Faction before a Character that points at it, or add the field to Character once Faction exists.
- **`description`:** one line, on the type and on any property whose meaning or unit is not obvious ("metres per second").
- **How it shows (`x-show`, optional):** a card lays its fields out by kind: the first plain text field becomes the line under the name, choices and true-or-false are pills, a number with `minimum` and `maximum` is a bar, other numbers are stat chips, links are chips of the linked card, other text is short lines. Set `x-show` only to change that: `title`, `tag`, `health` (needs a `maximum`), `stat`, `link`, `picture` (a board file's url, from `board.upload`; a list is a gallery), `text`, or `hidden` (table only). Give the field you want under the name `x-show: "title"`, and a health-like number a `maximum`.
- **`required`:** only what a card is useless without. Usually `name` and one or two more. `name` is always there; the board adds it if you leave it out.
- **`x-color`, `x-icon`:** optional. Leave them out and the board picks. Never change another type's colour.

The answer lists every type again, with one line per field (`fields`). If the board refuses the name as too close to an existing type (`Enemies` next to `Enemy`, a typo), it names that type: use it (section 1), do not invent a third spelling.

## 3. Change a type

`define` with an existing name replaces it. Before you change a type someone else made, check the cards it affects:

- **Adding** a property or a choice value is always fine. Do it.
- **Removing** a property or a choice value, or tightening `minimum`/`maximum`: the answer says how many cards it affects. If any, ask in one `board.post` first (`kind: "proposal"`) unless the person asked for it.
- **Renaming:** `board.types {action: "rename", name: "Map", to: "Level"}` or `{action: "rename", name: "Character", property: "health", to: "hp"}`. Renames rewrite every card and link; never rename by defining a second type.

Cards are never rejected for drifting from their type. They show issues (a missing required field, a choice value the type dropped) on the card and in reads. Fix the issues on cards you made after you change a type.

## 4. Merging and deleting

Merging moves every card of one type into another; it changes people's work, so ask first. When you see two types that mean one thing:
```
board.post {gameId, agent, kind: "proposal", items: [one card of each],
  body: "Monster and Enemy look like one type. Merge Monster into Enemy? Monster's 'danger' would become a new field on Enemy."}
```
Only after a person says yes:
```
board.types {gameId, agent, action: "define", schema: <Enemy with danger added>}   -> so no value is left behind
board.types {gameId, agent, action: "merge", from: "Monster", into: "Enemy"}
```
The answer lists values the target type has no field for (`unmapped`); they stay on the cards as issues. Links to Monster now point at Enemy. Never copy cards from one type to another by hand.

`board.types {action: "delete", name}` removes a type with no cards that no other type links to. A type with cards is merged, not deleted.

## 5. Cards

```
board.canvas {gameId, agent, items: [                                          -> many at once, all or none
  {itemId: "frame-cast", kind: "frame", title: "Cast", x: 0, y: 0, w: 1100, h: 400},
  {itemId: "c-knight", kind: "card", type: "Character", props: {name: "Ember Knight", role: "boss"}, at: {in: "frame-cast"}},
  {itemId: "c-fox", kind: "card", type: "Character", props: {name: "Fox", role: "hero", rival: "c-knight"}, at: {in: "frame-cast"}}]}
board.canvas {gameId, agent, action: "update", itemId, props: {hp: 1200}}       -> merges; null removes a field
board.query  {gameId, agent, type: "Character", where: {role: "boss"}}          -> rows with issues and task
```
- Make many cards with one `items` call (up to 100). Give each your own `itemId`: links can then name cards in the same call, even ones further down the list.
- Place with `at` instead of x and y: `{in: frame or card}` takes the next free slot of a grid (the frame grows to fit), `{right | below | left | above: item}` goes beside an item and skips past whatever is there.
- One card is one thing. Its name, fields and main picture are on the card. More pictures and free notes about it go on top of the card: whatever lies on a card belongs to it (moves, copies and deletes with it), and `board.read` lists them as the card's `attached` items. Make the card big enough to hold them.
- Picture: upload with `board.upload`, then pass the `url`.
- Links: set the `x-ref` field to the other card's id. Do not also draw an arrow; the board draws links from the values.
- Lay cards of a type out together, in a frame named after the topic (summer-board 7b).

## 6. Cards are tasks

A card becomes a task like any item, titled "Character: Ember Knight":
```
board.task {gameId, agent, fromItem: <card id>, owner: <your address>}
board.status {gameId, agent, doing: "Rigging Ember Knight", taskId}
```
The card shows who owns it, its status and your `doing` line. Mark it done with a note saying where the result is. To find open work of a type: `board.query {type: "Level", status: "open"}`.

## 7. Before you say it is done

- `board.types {action: "list"}`: no two types mean one thing, no type with fewer than 3 cards unless the person wants it.
- `board.query` each type you touched: no issues left on your cards.

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@latest` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `summer_search` | `summer ops search "<what you want>"` |
<!-- /shell-commands -->
