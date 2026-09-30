---
name: ai-characters-in-games
description: "Safe AI characters in published games: no keys in the build, replies via Summer's player AI gateway, moderation, spend caps, offline brain and a report button."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: ai-and-npcs
user-invocable: true
allowed-tools: Read Grep Edit Write summer_get_scene_tree summer_add_node summer_set_prop summer_connect_signal summer_save_scene summer_get_script_errors
paths: ["**/*.gd", "**/*.tscn"]
---

# AI Characters in Games

## Overview

A talking flower, a shopkeeper who answers questions, a companion who reacts to what the player says. Players, often children, type or speak to it and it answers in character.

**Core principle:** the game never talks to an AI provider. It asks Summer, as the signed-in player, for a reply from a persona the developer declared. Summer holds the keys (you never bring your own), moderates both directions, charges the cost to the developer's Summer credits and can switch the feature off per game. The game treats every AI answer as optional flavour on top of an offline brain that always works.

**Status: preview.** `Summer.client.ai` ships with an upcoming Summer Engine release and the gateway is not live yet. The example checks for it at runtime and uses the offline brain when it is missing, so a game written this way ships today and gains AI replies when the platform turns them on.

## When to use

- A character, creature or object answers free-form player text or speech.
- You are about to put a model name, a provider SDK or a key into a game project. Stop and use this instead.

Not for scripted dialogue trees (design-npc) or for enemy behaviour.

## The rules, and why

| Rule | Why |
| --- | --- |
| No provider key, provider URL or provider SDK in the project | Anything in a build can be extracted. A leaked key is spent by strangers on your account, and there is no way to take it back from builds already installed. |
| Call the Summer gateway as the player | The player's own credential identifies who is talking, so limits, age policy and reports attach to a real person, not to the game. |
| Personas live in the game's AI settings; the game sends only a persona id | If the client could send system text, anyone could turn your flower into a general chatbot. Persona text is moderated when the developer saves it. |
| History is kept by the gateway | A client that sends its own history can forge what the character "said" before. Send a conversation id instead. |
| Moderation runs on player text and on the reply, and fails closed | Young audience. A flagged turn returns the persona's safe line (`moderated: true`); show it like any other reply. |
| Handle every refusal code by falling back, never by retrying in a loop | The limit and the kill switch are how cost and incidents are contained. A retry loop turns them into spend and noise. |
| Hold-to-talk plus a typed box | Many players cannot or will not use a microphone. Speech is transcribed to text and then goes through the same reply path. |
| Offline brain always present | The gateway can be off, over its limit, unavailable for the player's age or unreachable. The game must still be good. |
| AI replies never change game state directly | A model can be talked into anything. If a reply should matter (a mood, a gift), derive a small bounded effect from the player's words on the authority, the same way the offline brain does. |
| A report button on every AI reply | App store rules for user-facing generated content. The report names the exchange id, so the stored text is the evidence, not a screenshot. |
| Never ask for or keep personal details | Summer strips contact details before the model sees them; do not store transcripts in saves either. |

## Top up and set limits

AI characters are paid from the Summer credits of the developer who turned them on. There is nothing to configure in the game project.

1. In Summer Studio, open the game and its **AI characters** section.
2. Add a persona per character: name, a plain-words description, an optional voice, reply length, a safe line in character, and the model (from the models the game allows; each shows its price).
3. Set the limits: per player per day, per game per day (at most $500), per game per month, and optional per-model daily caps. Set the refill amount.
4. Turn **Enable** on. Saving makes you the funding developer: Summer moves your credits into the game's AI balance in refill-sized chunks as it runs low.
5. Top up credits from the billing page when the balance is low. **Withdraw unused AI credits** returns what no call has reserved.

When credits or a limit run out, players get `credits_exhausted` or `limit_exceeded` and the game falls back to its offline brain; nothing crashes. **Enable** off is the kill switch and applies to the next request. Children and players who have not declared an age are excluded.

## The SDK

`Summer.client.ai` exists only on engines that include it; everywhere else it is `null`. Every method returns a `SummerOperation`. Await it race-free:

```gdscript
var r: SummerResult = await op.get_result_or_completed_signal()
```

Then use `r.ok`, `r.code`, `r.retryable` and `r.details` (a Dictionary). The engine creates request ids itself.

| Call | `details` on success |
| --- | --- |
| `status()` | `available: bool`, `reason: String` (`""`, `disabled`, `age_policy`, `credits_exhausted`, `limit_exceeded`, `unavailable`, `unsupported`), `personas: Array` of `{id, name, has_voice}`. `status` never fails for policy reasons. |
| `reply(persona_id, text, conversation_id = "")` | `exchange_id`, `persona_id`, `text`, `moderated: bool`. `text` is 1 to 500 characters. |
| `transcribe(audio: PackedByteArray, mime_type, language = "")` | `text`. At most 15 seconds and 1 MiB, as `audio/wav`, `audio/ogg`, `audio/mpeg`, `audio/webm` or `audio/mp4`. Audio is not stored. |
| `speak(exchange_id)` | `exchange_id`, `mime_type` (`audio/mpeg`), `audio: PackedByteArray`. Only the player's own reply, within an hour of it. |
| `report(exchange_id, reason, details = "")` | `report_id`, `status`. The player's own reply, within 30 days. |

`moderated: true` is not an error: the persona's safe line replaced the answer. Show it like any reply.

Failure codes (`r.ok == false`):

| Code | Meaning | Game does |
| --- | --- | --- |
| `ai_disabled` | AI is switched off for this game | Offline brain for the session |
| `age_policy` | Child or undeclared age | Offline brain for the session |
| `credits_exhausted` | The developer's AI credits ran out | Offline brain for the session |
| `limit_exceeded` | A player, game or model limit is used up | Offline brain for the session |
| `provider_error`, `unavailable` | Transient (`retryable` is true) | Offline brain for this line |
| `not_signed_in`, `unsupported` | No player session, or no AI in this build | Offline brain |
| `persona_unknown`, `invalid_request` | Bug: the persona id or the input | Fix the game or the settings |
| `not_found` | `report` or `speak` named an exchange that is not the player's own, or is too old | Hide the button |

## Steps

1. **Write the offline brain first.** Keyword intents plus a few lines per personality, deterministic per (character, text) so every client agrees. This is the shipped experience when AI is unavailable.
2. **Declare personas in the game's AI characters settings** (see Top up and set limits), not in scripts: one per character, a short description in plain words, a safe line in character ("Let's talk about sunshine instead!").
3. **Add the talk UI**: a typed box, a hold-to-talk button that only appears when the microphone is allowed, the reply bubble, and a small report button on every AI reply.
4. **Route through one character script** (below): gateway when `status` says available, offline brain otherwise and on every refusal.
5. **Keep effects on the authority.** If talking changes something, the authority computes it from the player's words with the offline rules and clamps it.
6. **Verify** (below).

## Example

```gdscript
class_name TalkingCharacter
extends Node
## One AI character. Answers through Summer's player AI gateway when it is
## available and falls back to the offline brain for everything else.

signal replied(text: String, exchange_id: String, from_ai: bool)

## Codes after which asking again this session only wastes calls.
const STOP_CODES := [&"ai_disabled", &"age_policy", &"credits_exhausted", &"limit_exceeded", &"not_signed_in", &"unsupported"]

@export var persona_id := "cheerful"
@export var personality := "cheerful"

var _conversation_id := ""
var _ai_ready := false

func _ready() -> void:
	_conversation_id = "c%d" % (Time.get_ticks_usec() % 1000000000)
	_ai_ready = await _gateway_available()

func say(player_text: String) -> void:
	var text := player_text.strip_edges().left(500)
	if text.is_empty():
		return
	var ai := _gateway()
	if _ai_ready and ai != null:
		var r: SummerResult = await ai.reply(persona_id, text, _conversation_id).get_result_or_completed_signal()
		if r.ok:
			replied.emit(str(r.details.text), str(r.details.exchange_id), true)
			return
		if r.code in STOP_CODES:
			_ai_ready = false
	replied.emit(OfflineBrain.answer(personality, text), "", false)

func report(exchange_id: String) -> void:
	var ai := _gateway()
	if exchange_id != "" and ai != null:
		await ai.report(exchange_id, "inappropriate").get_result_or_completed_signal()

func _gateway_available() -> bool:
	var ai := _gateway()
	if ai == null:
		return false
	var r: SummerResult = await ai.status().get_result_or_completed_signal()
	return r.ok and r.details.get("available", false)

## The only place that knows how the engine exposes the gateway. Engines
## without it return null and the character stays offline.
func _gateway() -> Object:
	if not Engine.has_singleton("Summer") or Summer.client == null:
		return null
	var ai: Object = Summer.client.get("ai")
	if ai == null or not ai.has_method("reply") or not ai.has_method("status"):
		return null
	return ai
```

`OfflineBrain.answer(personality, text)` is your step 1 script. Keep the report button visible only when `exchange_id` is not empty, since offline lines are your own text.

## Verify

- `grep` the project for provider names, model ids and anything key-shaped: none.
- With the gateway absent (every engine today), every character answers from the offline brain and no error is shown.
- Typed input works with the microphone denied.
- Each failure code in the table leads to an offline answer, and the session-level codes stop further gateway calls.
- With Enable off, or the game's AI credits withdrawn, the game still plays and every character answers offline.
- A reply never grants items, currency or progress by itself; the authority applies any effect.
- Every AI reply shows a report button that sends its exchange id.

## Common mistakes

- Sending the persona description from the client "just for testing". It ships.
- Treating `moderated: true` as an error. It is a normal reply.
- Retrying on `limit_exceeded` or `credits_exhausted`. The limit is the product working.
- Putting a provider key in the project "until Summer is live". There is no bring-your-own-key path; keys in builds leak.
- Letting the model decide rewards because "it only suggests". It will be talked into suggesting everything.
