---
name: summer-world-chat
description: "Add match chat to a Summer game: one World channel shared by everyone in the match. Hosted only."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: multiplayer-and-networking
user-invocable: true
allowed-tools: Read Grep Edit Write summer_get_script_errors summer_project_setting summer_play summer_stop summer_get_diagnostics
paths: ["**/*.gd", "**/*.tscn"]
---

# /summer-world-chat — chat with everyone in the match

## Overview

A **World channel** is a text channel for the World (match) the player has
joined. Every player in that World can open the same channel by key, such as
`"match"`. The platform owns everything that matters about it:

- who may read it;
- the text filter;
- rate limits;
- 24-hour retention;
- blocks between players.

Your game owns only the chat UI. Messages never travel through your network
composition, and the authority neither sees nor writes them.

| Fact | Value |
| --- | --- |
| Text | Plain Unicode, 1 to 4000 characters. Always render it as plain text, never as markup |
| Channel keys | 1–64 of `A-Z a-z 0-9 _ . -`, starting with a letter or digit; at most 64 channels per World |
| History | Best effort, not a full log. A new handle shows the newest 2 messages; `load_older()` grows the window to at most 16 |
| Lifetime | A handle belongs to one World admission. After leaving or joining another World, open a new one |
| Not included | Direct messages (`skill/summer-friends`), party chat (the Summer app) and messages written by your server |

**Hosted only.** Chat needs a joined hosted World and a Summer app whose Player
Host offers `player.channels`. A queue reservation is not enough: open the
channel after `enter()` succeeds. In Local Play and editor runs,
`check_open_readiness()` and `open_world_channel()` fail with `unavailable`.
Build the "chat hidden" path first.

This skill extends the Courtyard game from `skill/multiplayer-project` and
`skill/multiplayer-state`.

## Steps

### 1. Publish player names

Messages carry the author's Summer user id (`player_id`), not a name. The
authority already knows every verified name. Publish them in the shared match
document (`skill/multiplayer-state`): in `authority/main.gd`'s `_join`, before
accepting, add

```gdscript
	var players: Dictionary = match_doc.get("players", {})
	players[session.player.user_id] = session.player.display_name
	match_doc["players"] = players
	match_group.reset(Game.pack(match_doc))
```

On the client, copy `match_doc.get("players", {})` into the chat node's
`names` whenever the match document changes.

### 2. Add the chat node

`client/chat.gd`, added as a child `Chat` of `Main` in `client/main.tscn`:

```gdscript
extends Node
## Match chat: one World channel that every player in this match shares.

signal lines_changed(lines: PackedStringArray)
signal status(text: String)

var chat: SummerWorldChannel
var names := {}   # player user id -> display name, from your match state


## Call after the player has entered the match.
func open() -> void:
	var channels := Summer.client.channels
	var ready := channels.check_open_readiness()
	if not ready.ok:
		status.emit("Chat is not available here.")   # hide the chat box
		return
	var opened := channels.open_world_channel("match")
	var result: SummerResult = await opened.get_result_or_completed_signal()
	if not result.ok:
		status.emit("Chat is not available here.")
		return
	chat = opened.get_channel()
	if chat == null:
		return   # the player already left this World
	chat.history_changed.connect(_render)
	chat.history_failed.connect(func(_failure: SummerResult) -> void: status.emit("Chat history is unavailable. Tap to retry."))
	chat.closed.connect(func(_reason: String) -> void:
		chat = null
		_render())
	_render()   # the first history may already be here


## The Retry tap after history_failed.
func retry_history() -> void:
	if chat != null:
		chat.refresh()


func send(text: String) -> void:
	if chat == null or text.strip_edges().is_empty():
		return
	var sent := chat.send_message(text)
	var result: SummerResult = await sent.get_result_or_completed_signal()
	if not result.ok and result.retryable and result.code != &"rate_limited":
		# An ambiguous failure may have been accepted. Retry the same send,
		# never send_message again: that would be a second message.
		sent = sent.retry()
		result = await sent.get_result_or_completed_signal()
	if result.ok:
		return
	match result.code:
		&"text_not_allowed":
			status.emit("That message was not sent.")
		&"rate_limited":
			status.emit("You are sending messages too fast.")
		_:
			status.emit("Message not sent.")


## The visible window always comes from get_messages(), never from appending.
func _render() -> void:
	var lines := PackedStringArray()
	if chat != null and chat.is_history_current():
		for message in chat.get_messages():
			var author := "Game" if message.author_kind == &"creator_system" else String(names.get(message.player_id, "Player"))
			lines.append("%s: %s" % [author, message.text])
	lines_changed.emit(lines)
```

Call `$Chat.open()` after `enter()` returns `true`. Wire it into the UI:

- **Messages:** a `Label` or `RichTextLabel` with `bbcode_enabled = false`, refilled from `lines_changed`.
- **Input:** a `LineEdit` whose `text_submitted` calls `$Chat.send(text)` and clears itself.
- **Status:** `status` feeds a status line; hide the whole box when chat is unavailable.

### 3. Rules the code above follows

- **Render, don't append.** `history_changed` means "replace the view from `get_messages()`". It also fires when a block or expiry removes messages, which must disappear from the screen.
- **`message_received` is for sounds and badges only.** It fires for newly seen messages, not for the initial or older history. Display still comes from `get_messages()`.
- **One `send_message` call is one message.** For an ambiguous retryable failure, call `retry()` on the same operation; it reuses the original idempotency key. A second `send_message` would post twice.
- **`text_not_allowed` stored nothing.** The filter refused it, and resending the same text fails again.
- **`rate_limited`.** About 120 messages a minute per player; tell them to slow down, don't loop.
- **Sequence gaps are normal.** Blocks, other recipients and expiry hide messages; never treat a gap as an error.
- **`creator_system` messages are from the game**, never from a player or from Summer staff.

### 4. Test

Locally, check that the hidden path works and nothing errors:

```
summer_project_setting name="summer/local_play/players" value=2
summer_play
summer_get_diagnostics
summer_stop
```

Then test real chat on Summer staging with two accounts in one match.

## Checklist

- [ ] Local Play: `open()` reports chat unavailable, the chat box is hidden, and there are no script errors.
- [ ] The channel opens only after the player entered the World.
- [ ] Hosted: a message from one player appears for the other, with the right name.
- [ ] A filtered message shows "not sent" and never appears.
- [ ] After leaving and joining another match, chat reopens on a new handle.
- [ ] Text is shown as plain text: `[b]hi[/b]` appears literally.

## Common mistakes

| Don't | Do | Why |
| --- | --- | --- |
| Send chat through your own Commands or State | `Summer.client.channels` | Summer filters, rate-limits, applies blocks and expires text; your State does none of that |
| Open the channel right after `Summer.initialize` | Open after `enter()` succeeds | Only a joined World admission can open it |
| Append each message to a log | Re-render from `get_messages()` on `history_changed` | Blocked and expired text must disappear |
| Call `send_message` again after a timeout | `operation.retry()` | A new call is a second message |
| Render with BBCode enabled | Plain `Label`, or `bbcode_enabled = false` | Player text is never markup |
| Keep a handle across matches | Open a new channel per World | Handles never follow the player to another World |
| Show `player_id` | Map it to a name your authority publishes | Ids are not names |

## See also

- `skill/multiplayer-state`: the match document that carries player names
- `skill/summer-friends`: direct messages with friends
- `skill/summer-parties`: party chat lives in the Summer app
- `skill/multiplayer-testing`: what Local Play can and can't test
