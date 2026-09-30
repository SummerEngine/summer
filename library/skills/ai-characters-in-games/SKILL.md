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

**Core principle:** the game never talks to an AI provider. It asks Summer, as the signed-in player, for a reply from a persona the developer declared. Summer holds the keys, moderates both directions, meters the cost and can switch the feature off per game. The game treats every AI answer as optional flavour on top of an offline brain that always works.

**Status: preview.** The player AI gateway and its engine calls are not in a shipped Summer Engine yet. The example below checks for them at runtime and uses the offline brain when they are missing, so a game written this way ships today and gains AI replies when the platform turns them on.

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

## Gateway contract

Summer's player routes, reached through the engine (the game never calls them over the network itself):

- **status** — whether AI is usable for this player and game, plus the declared personas (`id`, `name`, `hasVoice`). `reason` is `disabled`, `age_policy` or `unavailable` when it is not.
- **transcribe** — one hold-to-talk clip (at most 15 seconds, 1 MiB; wav, ogg, mp3, webm or mp4 audio) to text. Audio is not stored.
- **reply** — `requestId` (unique per attempt, reused only to retry the same line), `personaId`, optional `conversationId`, `text` (up to 500 characters). Returns `exchangeId`, `text`, `moderated`. The same `requestId` returns the same answer without new cost.
- **speak** — voices the stored reply named by `exchangeId`, within an hour of it. Arbitrary text cannot be spoken.
- **report** — a safety report whose target is the `exchangeId`, within 30 days.

Refusals the game must handle:

| Code | Meaning | Game does |
| --- | --- | --- |
| `ai_disabled` | The developer or Summer switched AI off for this game | Offline brain, no error shown |
| `age_policy` | Player is a child (or has not declared an age) and the game has not opted children in | Offline brain |
| `limit_exceeded` | Daily allowance for this player, game or platform is used up | Offline brain until tomorrow |
| `persona_unknown` | The persona id is not declared | Bug: fix the id or the settings |
| `provider_error`, `unavailable` | Transient | Offline brain for this line; maybe try the next line |
| `duplicate_request` | A `requestId` was reused for different text | Bug: new id per new line |

Developers set, per game: the on/off switch, whether children may use it, the personas (name, character description, optional voice, reply length, safe line) and per-player and per-game daily spend limits.

## Steps

1. **Write the offline brain first.** Keyword intents plus a few lines per personality, deterministic per (character, text) so every client agrees. This is the shipped experience when AI is unavailable.
2. **Declare personas in the game's AI settings**, not in scripts: one per character, a short description in plain words, a safe line in character ("Let's talk about sunshine instead!").
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

@export var persona_id := "rose"
@export var personality := "cheerful"

var _conversation_id := ""
var _ai_ready := false

func _ready() -> void:
	_conversation_id = "c%d" % Time.get_ticks_usec()
	_ai_ready = await _gateway_available()

func say(player_text: String) -> void:
	var text := player_text.strip_edges().left(500)
	if text.is_empty():
		return
	if _ai_ready:
		var result: Dictionary = await _gateway().reply(persona_id, text, _conversation_id, _new_request_id())
		if result.get("ok", false):
			replied.emit(str(result.text), str(result.exchange_id), true)
			return
		# Disabled, age policy, limits and outages all mean: stop asking.
		if result.get("code", "") in ["ai_disabled", "age_policy", "limit_exceeded"]:
			_ai_ready = false
	replied.emit(OfflineBrain.answer(personality, text), "", false)

func report(exchange_id: String) -> void:
	if exchange_id != "" and _gateway() != null:
		_gateway().report(exchange_id, "inappropriate")

func _gateway_available() -> bool:
	var ai = _gateway()
	if ai == null:
		return false
	var status: Dictionary = await ai.status()
	return status.get("available", false)

## The only place that knows how the engine exposes the gateway. Engines
## without it return null and the character stays offline.
func _gateway() -> Object:
	if not Engine.has_singleton("Summer") or Summer.client == null:
		return null
	var ai: Object = Summer.client.get("ai")
	if ai == null or not ai.has_method("reply") or not ai.has_method("status"):
		return null
	return ai

func _new_request_id() -> String:
	return "req_%d_%d" % [Time.get_ticks_usec(), randi()]
```

`OfflineBrain.answer(personality, text)` is your step 1 script. Keep the report button visible only when `exchange_id` is not empty, since offline lines are your own text.

## Verify

- `grep` the project for provider names, model ids and anything key-shaped: none.
- With the gateway absent (every engine today), every character answers from the offline brain and no error is shown.
- Typed input works with the microphone denied.
- Each refusal code in the table leads to an offline answer, and `ai_disabled`, `age_policy` and `limit_exceeded` stop further gateway calls for the session.
- A reply never grants items, currency or progress by itself; the authority applies any effect.
- Every AI reply shows a report button that sends its exchange id.

## Common mistakes

- Sending the persona description from the client "just for testing". It ships.
- Treating `moderated: true` as an error. It is a normal reply.
- Retrying on `limit_exceeded`. The limit is the product working.
- Letting the model decide rewards because "it only suggests". It will be talked into suggesting everything.
