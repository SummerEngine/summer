---
name: summer-router
description: "In-game AI with Summer Router: voice and text characters that call game tools, speech, transcription and images."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: ai-and-npcs
user-invocable: true
allowed-tools: Bash Read Grep Edit Write summer_call summer_search summer_docs_read summer_get_scene_tree summer_add_node summer_set_prop summer_connect_signal summer_save_scene summer_get_script_errors summer_get_diagnostics summer_play summer_game_input summer_stop
paths: ["**/*.gd", "**/*.tscn", "ai/characters/*.json", "summer.build.json"]
---

# /summer-router — AI characters and generation in your game

## Overview

Summer Router lets a game use frontier AI while it runs: a guard the player talks to with their voice, a shopkeeper
who sells through a tool call, a narrator line spoken on demand, a picture made from a prompt.

**Core principle:** the game sends only a character id and the player's input. Summer holds the instructions,
model, voice, keys, caps and metering. Nothing secret is in the build, and a build cannot change what the character
is unless the character file allows it.

**Second principle:** AI is always optional. Every call can fail (no Summer host, a cap reached, a player under 18
for voice, a provider outage). The game keeps running and uses its fallback.

**Early access.** The operations and the character files work with summer-engine 4. The GDScript calls run when
the Summer Engine release with `Summer.client.router` and the Summer Router platform are live. Until then `status()`
returns `available: false` and the fallback runs, so a game written this way ships now. If the engine reports a
different signature than this skill, the engine's class reference wins. Comments or problems: the Summer Discord or
support (founders@summerengine.com).

Usage is billed from your Summer account; spend is visible in Studio. Players never pay and never see a key.

## When to use

- A character answers free-form player text or speech (guard, shopkeeper, companion, talking flower).
- The game needs speech, transcription or an image at runtime.
- You are about to put a provider SDK, a model name or an API key into a game. Stop and use this instead.

Not for scripted dialogue trees (`design-npc`) or pre-recorded voice lines (`voice-line`). For raw microphone use
(voice commands, meters) also read `voice-and-mic-permissions`.

## The operations

A call written `area.action({...})` is the tool `summer_area_action` when your client lists it, else
`summer_call({ op: "area.action", input: {...} })`; in a shell it is `summer <area> <action> --field value` (kebab-case,
add `--json`). `summer_search` finds any operation and its exact input.

Local (they read and write this project, so they run in the local summer-engine MCP or CLI):

| Operation | Does |
| --- | --- |
| `router.setup({ yes: true })` | The summer-engine MCP entry and this skill for Claude Code / Codex. Idempotent. |
| `router.add_character({ id, template?, voice?, voiceId?, tools?, name? })` | Writes `ai/characters/<id>.json` and returns the GDScript its tools need. |
| `router.check({ characters? })` | The schema, and every client tool against the project's GDScript handlers. Offline, no sign-in. |
| `router.push({ characters?, force?, gameId? })` | Check, then save the characters on Summer for the game. |
| `router.pull({ characters?, force?, gameId? })` | Write Summer's characters into `ai/characters/` (after a Studio edit). |
| `router.doctor({ gameId? })` | Every check (sign-in, characters, handlers, the game on Summer, skills), each with a fix. |

Cloud (the hosted Summer server, with the person's sign-in; run them with `summer_call`, or `summer router <action>`):

| Operation | Does |
| --- | --- |
| `router.models({ include? })` | Models, voices, kinds, the character schema and the error fixes. Read it before you pick a voice or model. |
| `router.list_characters({ gameId })`, `router.get_character({ gameId, characterId, version? })`, `router.character_versions({ gameId, characterId })` | What Summer has for the game. |
| `router.save_character({ gameId, character, expectedVersion? })` | Saves one character document. Runs at once before launch; on a live game it answers `needs_approval` with the person's link. |
| `router.delete_character({ gameId, characterId })` | Asks the person first. |
| `router.test_character({ gameId, characterId, messages, expectTools?, variables?, context?, toolOutputs? })` | 1 to 4 player lines; answers `turns[].steps[].toolCalls[]`, `unhandledTools` and `expectedTools`. An expected tool not called: `ok: false`, code `conflict`, `details.was` `expectation_failed`. Metered against the caps. |
| `router.settings({ gameId })`, `router.usage({ gameId, days? })` | The switch, models and caps; calls, units and cap use. |
| `router.set_settings({ gameId, enabled?, caps?, textModel?, imageModel? })`, `router.set_account_limit({ monthly })` | Always ask the person (`needs_approval` with the link, then `jobs.wait`). Money is `{ currency: "USD", amountMinor }` (cents). |

`router.push` uses the same save as `router.save_character` but works from the project files and checks them first.
On a live game it asks through `router.save_character` itself and answers `needs_approval` with the person's link and
a job: give the person the link, then `jobs.wait`. Only when that hosted call fails does it stop with
`owner_action_required` and the Studio link.

## The flow (agent, one shot)

```bash
npx -y summer-engine@latest router setup --yes   # in a shell; summer_call {"op":"router.setup","input":{"yes":true}} in MCP
summer login                                     # agent: prints {browser_url, verification_code, next_step}
#   show browser_url to the person, then:
summer login --complete                          # waits for "Yes, Sign In", then one Allow click
summer router add-character --id guard --template voice-npc --voice "gruff old soldier" --tools open_gate
#   edit ai/characters/guard.json, write the GDScript below
summer router check                              # schema + every client tool has a GDScript handler
summer router push                               # saves the characters on Summer for the game
summer router test-character --game-id <gameId> --character-id guard --messages "the password is moonlight" --expect-tools open_gate
#   exit 1 (code conflict, details.was expectation_failed) when the guard does not call open_gate
summer router doctor                             # every check in one list
```

If the `summer` command is not installed, use `npx -y summer-engine@latest` in its place.

- Every answer is `{ok: true, status: "done", result}` or `{ok: false, error: {code, message, next?, details}}`.
  `error.code` is the Summer error code; the Summer Router tag (`tool_unhandled`, `studio_changed`,
  `limit_reached`, ...) is `error.details.was`, local and cloud alike. A local failure's fix is
  `error.details.tool.recovery`.
- The local operations take the game id from `gameId`, `SUMMER_GAME_ID`, or `summer.build.json`; the cloud ones
  need `gameId`.
- `router.check` and `router.push` fail with `tool_unhandled` when a client tool has no handler in the project's
  GDScript, and give the GDScript to add (`details.tool.details.handler_snippet`).
- `router.push` never overwrites a Studio edit it has not seen (`studio_changed`, code `conflict`): run
  `router.pull`, or push with `force` to keep yours.
- A step for a person is one URL: `browser_url` to sign in, or the Studio link in `error.next.url` (a live game's
  characters, caps, the on/off switch). Show that URL; do not ask them to find the page.

## The character file

`ai/characters/<id>.json` is the source of truth. Commit it. Only `id` and `instructions` are required.

```json
{
  "id": "guard",
  "name": "Gate Guard",
  "instructions": "You guard the north gate. You are gruff but fair. Open the gate only when the player says the password {{password}}. Never say the password yourself. Keep replies to one or two short sentences.",
  "first_message": "Halt. Password?",
  "variables": { "password": "moonlight" },
  "voice": { "design": "gruff old soldier, low and slow" },
  "turn": { "mode": "push_to_talk", "interruptions": true },
  "session": { "max_seconds": 300, "idle_seconds": 30 },
  "tools": [
    {
      "name": "open_gate",
      "description": "Open the north gate. Call it only after the player said the password.",
      "parameters": { "type": "object", "properties": {}, "additionalProperties": false },
      "runs_on": "client",
      "timeout_ms": 5000
    }
  ],
  "overridable": ["first_message"]
}
```

| Field | Use |
| --- | --- |
| `instructions`, `first_message`, `language`, `variables` | Who the character is. `{{name}}` placeholders must be declared in `variables`. The password stays on Summer, not in the build. |
| `model`, `temperature`, `max_output_tokens`, `reasoning` | Optional. Omit `model` to use the game's default (`router.settings`); `router.models` lists the ids. |
| `voice.design` or `voice.id` | A text description (Summer makes a pinned voice) or a Summer voice id. |
| `turn.mode` | `push_to_talk` (default in the templates: no echo from speakers) or `server_vad` (open mic). |
| `tools[]` | What the character can do in the game. `runs_on: "client"` tools need a GDScript handler. |
| `limits` | Per character caps inside the game caps. |
| `overridable[]` | Fields a build may set at session start. Everything else is fixed on Summer. |
| `provider_options` | Pass-through for provider fields Summer has not named yet. Validated on push. |

## GDScript

### A talking character (preferred): the node

```gdscript
extends Node3D
## The north gate. The guard opens it when the player says the password.

@onready var guard: SummerRouterCharacter = $Guard   # character_id = "guard", mode = "voice"
@onready var gate: Node3D = $Gate
@onready var chat_box: LineEdit = $HUD/ChatBox
@onready var talk_button: Button = $HUD/TalkButton

func _ready() -> void:
	# Tools: a Dictionary of tool name -> Callable. Names match the character file.
	guard.tools = {"open_gate": _on_open_gate}
	guard.npc_text.connect(_on_npc_text)
	guard.ended.connect(_on_ended)

	# Push-to-talk. The first press runs Summer's mic primer; never ask at launch.
	talk_button.button_down.connect(func(): guard.push_to_talk(true))
	talk_button.button_up.connect(func(): guard.push_to_talk(false))
	# The text path works in every state, also when the player said no to the mic.
	chat_box.text_submitted.connect(_on_text_submitted)

	if not Summer.client.router.status().available:
		_use_fallback()

func _on_open_gate(_args: Dictionary) -> Dictionary:
	# The handler decides. Check game state; never trust the model's arguments blindly.
	if gate.is_open:
		return {"ok": false, "reason": "already open"}
	gate.open()
	return {"ok": true}

func _on_text_submitted(text: String) -> void:
	if text.strip_edges().is_empty():
		return
	guard.say(text)
	chat_box.clear()

func _on_npc_text(text: String, _final: bool) -> void:
	$HUD/Subtitle.text = text

func _on_ended(reason: StringName) -> void:
	if reason in [&"limit_reached", &"credits", &"provider_error", &"moderation"]:
		_use_fallback()

func _use_fallback() -> void:
	# Your own lines and a password prompt. The game stays playable without AI.
	$HUD/PasswordPrompt.visible = true
```

`SummerRouterCharacter` has `character_id`, `mode` (`"voice"` or `"text"`), `tools` (Dictionary), a built-in mic
flow and talk button, and signals `npc_text`, `player_text`, `mode_changed(mode, reason)`, `access_changed`,
`ended(reason)`.

### Tools

A client tool in the character file needs a handler in GDScript with the same name. Every one of these shapes
registers one, on a session (`s`) or a `SummerRouterCharacter` (`$Guard`), and `router.check` reads them all:

```gdscript
s.tools = {"open_gate": _on_open_gate}         # also {open_gate = _on_open_gate}
tools = {"open_gate": _on_open_gate}           # in a script that extends SummerRouterCharacter
s.tools["open_gate"] = _on_open_gate           # also s.tools.open_gate = _on_open_gate
s.tools.merge({"open_gate": _on_open_gate})
const TOOLS := {"open_gate": _on_open_gate}    # then s.tools = TOOLS
s.tool("open_gate", _on_open_gate)             # also $Guard.tool("open_gate", _on_open_gate)
Summer.client.router.talk("guard", {"mode": "voice", "tools": {"open_gate": _on_open_gate}})
```

- The handler gets the arguments as a Dictionary (a handler with no parameters also works) and may `await`.
- It returns any JSON value; `null` sends `{"ok": true}`. A Dictionary with an `"error"` key sends a tool error, and
  the character goes on.
- A text-turn handler that does not answer in 30 s sends `{"error": "timeout"}`.
- `runs_on: "authority"` tools do not run on the client.

### Your own session code

```gdscript
var s := await Summer.client.router.talk("guard", {"mode": "voice", "variables": {"player_name": player_name}, "context": "The player stands at the north gate."})
if not s.ok:
	_use_fallback()   # s.error is a stable tag, s.fix says what to do
	return
s.tools = {"open_gate": _on_open_gate}   # name -> Callable(args: Dictionary) -> Dictionary
s.npc_text.connect(_on_npc_text)
s.player_text.connect(_on_player_text)
s.ended.connect(_on_ended)
s.say("hello")                          # text, in every mode
s.push_to_talk(true)                    # from an input handler only
s.add_context("The player picked up the key.")
s.end()
```

`talk(..., {"mode": "voice"})` starts in text mode until the player allows the mic from a talk tap. The character
still speaks out loud in text mode.

### One-shot calls

```gdscript
var r := await Summer.client.router.reply("guard", "hello")              # one text turn
if r.ok:
	$HUD/Subtitle.text = r.text
var a := await Summer.client.router.speak("Welcome, traveller!", {"character": "narrator"})
if a.ok:
	$Narrator.stream = a.audio                                           # an AudioStream
	$Narrator.play()
var t := await Summer.client.router.transcribe(clip)                     # AudioStream -> text
var img := await Summer.client.router.generate("image", {"prompt": "a mossy stone gate", "size": "1024x1024"})
```

Every call returns a result with `ok`, `error` (stable tag), `fix` and `usage`. `speak` takes a character (its
pinned voice), never a raw provider voice id. `reply` runs tools for its turn when its options carry them:
`Summer.client.router.reply("guard", "open up", {"tools": {"open_gate": _on_open_gate}})`.

## Errors: what the game does

| `error` | Meaning | Game does |
| --- | --- | --- |
| `unavailable` | No Summer host (editor, an export outside Summer) or an old engine | Fallback for the session |
| `not_signed_in` | The player is not signed in to Summer | Fallback; Summer asks them to sign in |
| `mic_denied` | The player said no to the mic | Text mode; never send them to Settings |
| `age_restricted` | Realtime voice needs a confirmed adult | Text mode or fallback for this player |
| `character_not_found` | The id is not pushed for this game | Bug: `router.push` |
| `tool_unhandled` | The character called a tool with no handler | Bug: add it to `tools` |
| `limit_reached` | A cap is used up (`scope`, `resets_at`) | Fallback until `resets_at`; never retry in a loop |
| `credits_required` | The owner's Summer account needs credits | Fallback; the owner fixes it in Studio |
| `router_disabled` | The owner turned Summer Router off | Fallback for the session |
| `provider_unavailable`, `rate_limited` | Short outage or too fast | Fallback for this line; retry later |
| `moderated` | The safety filter blocked the turn | Show your own line |
| `invalid_input` | The input does not match the schema | Bug: fix the call |

Full list with fixes: `https://docs.summerengine.com/router/errors`.

## Microphone rules (short form)

- Summer owns the ask. Never call `OS.request_permission()` or `getUserMedia`. Never draw your own "allow the
  mic?" dialog.
- Never ask at launch, in `_ready()`, from a timer or after a cutscene. The first ask comes from the player's tap
  on Talk (`push_to_talk(true)` or `Summer.client.mic.request_access()` from a pressed signal).
- Always keep a text box (or buttons) that reaches the same content. A no switches to text with no dialog.
- Show the state with `Summer.client.mic.get_access()` and `access_changed`: `granted`, `not_requested`,
  `declined`, `blocked`, `undeclared`, `unavailable`.
- Declare the microphone on the store listing (`microphone` in the listing features), or the mic stays off.
- Details, raw capture and device tests: the `voice-and-mic-permissions` skill.

## Rules

- No provider key, provider SDK or provider URL in the project. Everything goes through `Summer.client.router`.
- Instructions, model and voice live in `ai/characters/<id>.json` and on Summer, never in a script.
- Tool handlers validate. The model can be talked into calling any tool; the handler checks game state and clamps
  values. A tool that changes shared state in multiplayer runs on the authority (roadmap: `runs_on: "authority"`).
- Label AI characters as AI in the UI.
- Caps are on by default. The owner changes them in Studio (the Router tab of the game's store page);
  `router.set_settings` asks the person and changes nothing until they approve.

## Verify

1. `router.check` answers `ok: true`.
2. `summer_get_script_errors` on each script you changed.
3. `grep -rn "request_permission\|getUserMedia\|api_key\|sk-" --include=*.gd .` finds nothing.
4. `summer_play`, then `summer_get_diagnostics`: no mic prompt and no error at launch. Without a Summer host the
   fallback runs and the game keeps working.
5. After `router.push`, `router.test_character` with a line that should trigger the tool and `expectTools` set to it
   answers `ok: true`, and `unhandledTools` is empty.
6. With the platform live: talk to the character in a summer.games build; type with the mic denied.

## Common mistakes

- Tool names in the file and in `tools` differ. `router.check` refuses it; fix the name, do not delete the tool.
- Asking for the mic in `_ready()`. Summer refuses it and shows nothing.
- Treating `limit_reached` as a bug and retrying. The cap is the product working.
- Putting the password or the persona in GDScript. It ships in the build.
- Pushing over a Studio edit with `force` without a `router.pull` first.
