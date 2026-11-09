---
name: summer-router
description: "AI characters for games on Summer Games: Summer Router replies, tools, speech, images."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: ai-and-npcs
user-invocable: true
allowed-tools: Read Grep Edit Write summer_get_scene_tree summer_add_node summer_set_prop summer_connect_signal summer_save_scene summer_get_script_errors
paths: ["**/*.gd", "**/*.tscn"]
---

# Summer Router: AI characters in your game

A shopkeeper who haggles, a guard who opens the gate when convinced, a narrator who says the player's name. With **Summer Router**, a game calls AI while people play. The game names a character and sends what the player said. Summer holds the instructions, the model, the voice, the caps and the provider keys, and meters each call from the creator's paid Summer credits. Players never pay, and nothing secret is in the build.

## What works today (early preview)

| | Status |
|---|---|
| Where | Games **published on Summer Games**, played in the Summer app (desktop, phone) or on summer.games, by a signed-in player. Other platforms and storefronts answer `not_on_summer_games`; they are coming soon. |
| Engine | Summer Engine 0.8 or later: `Summer.client.router`, `Summer.authority.router` and the `SummerRouterCharacter` node |
| Character replies | Available: text replies that keep the conversation and call your game's tools (`reply`) |
| Speech | Available: a whole clip in the character's voice (`speak`) |
| Images | Available: one image from a prompt and an optional reference picture (`generate("image", ...)`) |
| Transcription | Coming soon: `transcribe` answers `unavailable`. Keep typed input. |
| Realtime voice | Coming soon: a `talk` session in `"voice"` mode talks in text turns and still speaks the replies |

In the editor and in Local Play, every call answers `unavailable`, so the game uses its offline lines. Test the character with the test conversation (step 2) and play the real thing on Summer Games.

## 1. Plan: who calls

Ask the person one question if it is not clear: is the game single-player or multiplayer?

| Game | Who calls | Counts toward |
|---|---|---|
| Single-player | The player's game: `Summer.client.router` | The player's caps and the game's caps |
| Multiplayer | The game server (the authority): `Summer.authority.router`, for one player's `SummerSession` | The game's caps and call rate |

In a multiplayer game, the server owns the world. Anything a character does that changes the game (sell an item, give gold, open a shared door) runs on the server. A player's game may also talk to a character itself and tell the server what happened; then the server checks the exchange with `verify_exchange` before it acts (step 4).

## 2. Make the character

A character lives on Summer, not in the build. Make it in Summer Studio (the game's **Grow > Summer Router** tab), or with the Summer MCP:

```text
router.save_character({
  gameId: "<from games.list>",
  character: {
    id: "shopkeeper",
    name: "Mira the shopkeeper",
    instructions: "You run the potion shop in Emberfall. Warm, a little greedy, never rude. You sell only what is in stock: {{stock}}. When the player agrees on a potion and its price, call sell_item. You never give items for free.",
    first_message: "Welcome, traveller! Potions, tonics, a little luck in a bottle?",
    variables: { stock: "health potion 25 gold, mana potion 30 gold" },
    overridable: ["variables"],
    tools: [{
      name: "sell_item",
      description: "Sell one item to the player once they agree on it and its price.",
      parameters: { type: "object", properties: { item: { type: "string" }, price: { type: "integer" } }, required: ["item", "price"] }
    }]
  }
})
```

- Over MCP, call it with `summer_call({ op: "router.save_character", input: {...} })`, or from a shell: `summer router save-character --input '<json>'`. Find the game id with `games.list`. On a game that is live, the person approves the change with one link.
- Test it before you write game code: `router.test_character({ gameId, characterId: "shopkeeper", messages: ["Do you have anything for my wounds?", "Fine, 25 gold for the health potion."], toolOutputs: { sell_item: { ok: true } }, expectTools: ["sell_item"] })`. Test turns count toward a developer cap of their own.
- `router.models` lists the text models, voices and the full character schema (`include: ["schema"]`). Pick `model` and `voice.id` from it, or leave them out for the game's defaults.
- The tool `name` in the character is the name your game handles. Tool arguments come from the model: check every one in game code.

The character, field by field:

| Field | What it does |
|---|---|
| `id` | What the game calls it by: lowercase letters, digits, `_` or `-`, up to 64 |
| `name`, `first_message`, `language` | Display name, its opening line, a language such as `en` or `pt-BR` |
| `instructions` | Who it is and how it talks, up to 20,000 characters. `{{name}}` placeholders must be declared in `variables` |
| `variables` | Declared placeholders and their defaults. A build may send new values only when `overridable` lists `"variables"` |
| `overridable` | Fields a build may change per call, such as `"variables"` or `"first_message"`. `context` needs no entry: a build may always send it |
| `model`, `temperature`, `max_output_tokens`, `reasoning` | The text model (from `router.models`) and how it answers; leave out for the game's default |
| `voice` | `{"id": "<from router.models voices>"}` for `speak` |
| `tools` | Up to 32: `name`, `description`, `parameters` (a JSON Schema object) |
| `limits` | This character's own daily caps: `player_daily_micro_usd`, `game_daily_micro_usd` (1,000,000 = 1 US dollar) |

## 3. Single-player: call from the player's game

```gdscript
var conversation_id := ""

func ask_shopkeeper(line: String) -> void:
	var r: SummerRouterResult = await Summer.client.router.reply("shopkeeper", line, {
		"conversation_id": conversation_id,
		"variables": {"stock": Shop.stock_line()},
		"context": "The player has %d gold." % Player.gold,
		"tools": {"sell_item": func(args: Dictionary): return Shop.sell(str(args.get("item", "")), int(args.get("price", 0)))},
	})
	if r.ok:
		conversation_id = r.conversation_id
		$Bubble.show_line(r.text, r.exchange_id)   # label it as AI; offer a report button
	else:
		$Bubble.show_line(OfflineLines.shopkeeper(line), "")
```

- `tools` maps each tool name to a `Callable`. The SDK runs the handler, sends what it returns back to the character, and the character goes on, up to 8 rounds in one call. Return `{"error": "..."}` when the action fails (not enough gold, out of stock); the character then says so.
- `Shop.sell` checks the price against your own price list, the stock and the gold. The model's word is never the price.
- `conversation_id`: Summer keeps the history. Send the one the last result named. Without it, each call starts a new conversation.
- For a whole conversation in one node, add a `SummerRouterCharacter`, set **Character ID**, turn on **Show UI**, and give it `tools`. It shows a bar with the character's words and a text field.

Speech and images from the player's game:

```gdscript
var line: SummerRouterResult = await Summer.client.router.speak("", {"exchange_id": r.exchange_id})  # voice that reply
if line.ok:
	$Voice.stream = line.audio
	$Voice.play()

var art: SummerRouterResult = await Summer.client.router.generate("image", {"prompt": "a shop sign shaped like a potion", "size": "1024x1024"})
if art.ok:
	$Sign.texture = art.texture
```

Voice only when the character has one (the `has_voice` of each entry in `status().characters`), and consider voicing on tap: speech costs more than text.

`await Summer.client.router.status()` asks Summer what this player can use now: `available` (and `reason`, an error tag, when it is not), `characters` (each `id`, `name`, `has_voice`, `client_tools`), `kinds` (the capabilities Summer serves) and `voice` (realtime voice, `false` during the early preview). `report(exchange_id, reason)` answers `report_id` and `status`; it takes one of this player's replies from the last 30 days.

## 4. Multiplayer: call from the server

The player's game sends what the player typed to the server as a Command (the `multiplayer-state` skill sets up Commands and shared State). The server answers the Command at once, asks the character for that player's session, runs the tool calls itself, and publishes the line in shared State so every player sees it.

```gdscript
# Server (authority). Call from your Command handler for {"c": "talk", "text": ...}.
const MAX_ROUNDS := 3

func _talk(request: SummerNetworkCommandRequest, text: String) -> void:
	var session := request.get_session()
	request.accept({}, Game.pack({"asked": true}))   # the reply arrives in shared State
	var conversation := "shop_" + session.session_id.md5_text()
	var options := {"conversation_id": conversation, "variables": {"stock": Shop.stock_line()}}
	var r: SummerRouterResult = await Summer.authority.router.reply(session, "shopkeeper", text.strip_edges().left(4000), options)
	for _round in MAX_ROUNDS:
		if not r.ok or r.tool_calls.is_empty():
			break
		var results := []
		for call in r.tool_calls:
			var output: Variant = {"error": "unknown tool"}
			if call.name == "sell_item":
				output = Shop.sell_to(session, str(call.args.get("item", "")))   # checks stock, price and wallet
			results.append({"call_id": call.call_id, "output": output})
		r = await Summer.authority.router.reply(session, "shopkeeper", "", {"conversation_id": conversation, "tool_results": results})
	var line := r.text if r.ok else r.message   # r.message is a plain line for players
	if line.is_empty():
		line = OfflineLines.shopkeeper(text)
	shop_doc.lines.append({"by": session.player.display_name, "text": line})
	shop_group.reset(Game.pack(shop_doc))
```

- The server has `reply(session, character, text, options)`, `speak(session, text, {"character": id})` and `generate(session, "image", {...})`. Options are the client's without `tools`: the server reads `r.tool_calls` and answers them with `tool_results` on the next call, with the same `conversation_id`.
- `speak` and `generate` on the server return `data` and `mime_type`. Audio and images are too big for shared State: to voice a line, each player's game calls `Summer.client.router.speak(line, {"character": "shopkeeper"})` for the line it shows (it counts toward that player's caps).
- Server calls count toward the game's caps, not the player's. Keep your own pace per player on the server: one line in flight per player, a short gap between lines, and a length cap on the text, so one player cannot spend the whole game's daily cap.
- `Shop.sell_to` on the server is the only place an item or gold changes hands. Never apply an effect a client reports.

**A client talked, the server acts.** When the player's game called `Summer.client.router` itself and tells the server "the shopkeeper agreed to sell", the server checks the exchange first:

```gdscript
var check: SummerRouterResult = await Summer.authority.router.verify_exchange(session, exchange_id)
if check.ok and check.tool_calls.any(func(call): return call.name == "sell_item"):
	Shop.sell_to(session, str(check.tool_calls[0].args.get("item", "")))
# Anything else (another player's exchange, older than an hour, made up): do nothing.
```

## 5. Every refusal keeps the game running

Every call returns a `SummerRouterResult`. Read `ok` first. On a refusal, `error` is a stable tag, `fix` says what to do (for you), and `message` is a plain line you may show players. Show `message` or your own offline line, and go on. Treat a tag you do not know as `unavailable`.

| Tag | Means | Game does |
|---|---|---|
| `unavailable` | No Summer app, an old app, the editor or Local Play, or the service is down (`reason` says which) | Offline line |
| `not_signed_in` | The player is not signed in | Offline line |
| `not_on_summer_games` | The game is not running from Summer Games | Offline line; publish on Summer Games |
| `router_disabled` | The creator turned Summer Router off for the game | Offline lines until the game restarts |
| `credits_required` | The creator's paid credits ran out | Offline lines until the game restarts |
| `limit_reached` | A cap has no room: `scope` (such as `player_day`, `game_day`, `game_month`), `resets_at` (Unix seconds) | Offline lines until `resets_at` |
| `rate_limited` | Too many calls a minute (`retry_after` seconds) | Offline line; wait before the next call |
| `age_restricted` | This player may not talk to this character | Offline lines for this player |
| `moderated` | The safety filter blocked this turn | Offline line |
| `provider_unavailable` | The model is down for a moment | Offline line; the next call may work |
| `character_not_found` | No character with this id | Bug: fix the id, or save the character |
| `invalid_input` | The call breaks a limit (text 1 to 4000 characters, at most 32 variables), or sends `variables` the character does not let a build set | Bug: fix the call or the character |
| `tool_unhandled` | The character called a tool the game has no handler for | Add the handler to `tools` |

`retryable` is `true` when the same call can work later (`unavailable`, `limit_reached`, `provider_unavailable`, `rate_limited`). Never retry in a loop: a cap is the product working.

## 6. Caps and money

Every game starts on, with caps on from day one:

| Cap | Default |
|---|---|
| Spend per player per day | 5 US dollars |
| Spend per game per day | 100 US dollars |
| Spend per game per month | 1,000 US dollars |
| Spend per account per month, all games | 2,000 US dollars |
| Calls a minute per player | 30 |
| Calls a minute per game | 1,200 |

- The creator changes them per game in Grow > Summer Router, or an agent asks with `router.set_settings` (the person approves with one link). `router.set_account_limit` changes the account cap. `router.usage` shows calls, units, how much of each cap is used and which calls a cap stopped.
- A character can carry its own daily caps per player and per game (`limits` in the character).
- Calls are paid from the creator's paid Summer credits (plan credits and top-ups), the same balance as the Summer API. A result never carries a price.

## 7. Ship it safely

- No provider key, provider SDK, model id or character instructions in the project. The build holds character ids only.
- Every character keeps an offline line set that is good on its own. Most refusals happen in normal play.
- Label AI lines as AI in the game (a small tag on the bubble), and offer a report button: `Summer.client.router.report(exchange_id, "inappropriate")`.
- Never ask players for personal details, and keep characters off romance, self-harm and medical advice. Write it into the instructions.
- In a multiplayer game, a reply never changes shared state on a client. The server applies every effect and checks every tool argument.
- `Summer.client.router.is_available()` says, without a network call, whether this run can call Summer Router. `status()` asks Summer which characters and kinds it serves for this player.

## Verify

- `grep` the project for provider names, model ids and anything key-shaped: none.
- In the editor every character answers with its offline line, and no error is shown.
- `router.test_character` with `expectTools` passes for each tool the game handles.
- Every tool handler refuses bad arguments (an unknown item, a wrong price, not enough gold).
- In multiplayer, the server is the only code that sells, gives or opens anything, and it checks a relayed exchange with `verify_exchange`.
- On Summer Games, signed in, the character answers, its tool works, and `router.usage` shows the calls.

## Common mistakes

| Mistake | Do this instead |
|---|---|
| Calling a provider from the game "until Summer Router is on" | Summer Router only; offline lines meanwhile |
| Sending the character's instructions from the build | Save them on Summer; the build sends `variables` and `context` |
| Trusting the price or item a tool call names | Check them against your own list on the game's side |
| Retrying on `limit_reached` or `credits_required` | Offline lines until the cap resets or the creator acts |
| Waiting for transcription before shipping | Ship typed input now; transcription is coming soon |
| Testing only in the editor | The editor answers `unavailable`; use the test conversation, then Summer Games |

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@latest` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `summer_add_node` | `summer engine add-node` |
| `summer_connect_signal` | `summer engine connect-signal` |
| `summer_get_scene_tree` | `summer engine get-scene-tree` |
| `summer_get_script_errors` | `summer engine get-script-errors` |
| `summer_save_scene` | `summer engine save-scene` |
| `summer_set_prop` | `summer engine set-prop` |
| `games.list` | `summer games list` |
<!-- /shell-commands -->
