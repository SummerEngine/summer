---
name: summer-friends
description: "Summer friends in a game: a consented friends list, profile and chat screens, direct messages. Hosted only."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: multiplayer-and-networking
user-invocable: true
allowed-tools: Read Grep Edit Write summer_get_script_errors summer_project_setting summer_play summer_stop summer_get_diagnostics
paths: ["**/*.gd", "summer.build.json"]
---

# /summer-friends — friends, profiles and direct messages

## Overview

Friendships belong to the player's Summer account. The Summer app owns the
social graph itself:

- friend requests;
- blocking;
- the friends list screen;
- profiles;
- chat.

Your game gets two client-only facades.

**`Summer.client.friends`**
- Two screens need **no consent**: `show_friends()` and `show_chat(user_id)`. They ask the Summer app to show its own screen over the game.
- `show_profile(user_id)` is the same. The profile includes add friend, message, invite to party and report, so it is the social feature most games need.
- **With consent**, it reads the list: each friend's name, handle and whether they are `offline`, `online`, `in_this_game` or `in_other_game`. Another game is never named.

**`Summer.client.messages`**
- Reads and sends the player's direct messages, with a separate consent for each kind of access.
- Prefer `show_chat(user_id)` unless chat is central to your game.

Reading friends or messages needs two things:

1. **The Build declares the permission** in `summer.build.json`.
2. **The player grants it** in the Summer app's consent sheet, which your game asks for with `request_access`.

Declining never blocks play. A game must work without these permissions.

**Availability:**

- **Engine release.** This needs an engine that includes Summer Engine PR #508. On engines without it, `Summer.client.friends` does not exist and scripts that use it fail to parse. Check the class reference for `SummerClientFriends` before using this skill.
- **Hosted only.** `is_available()` is `false` in Local Play and editor runs, for guests, for accounts the platform keeps out of social features (`age_restricted`, under 13), and in Summer apps without `player.friends@1` (friends) or `player.messaging@1` (messages).
- **Overlays.** The screens need the Summer app to offer friends and parties; otherwise they fail with `capability_unavailable` or `ui_unavailable`.

## Steps

### 1. Declare the permissions you use

Add a top-level `permissions` array to `summer.build.json`, next to `schema`
and `gameId`. List only what the game uses; each entry is an upper bound on
what you may ask for.

```json
  "permissions": ["social.friends.read"],
```

| Permission | Allows |
| --- | --- |
| `social.friends.read` | `get_friends()`, statuses, the `changed` signal |
| `social.messages.read` | `list_conversations`, `list_messages`, `list_messages_after` |
| `social.messages.send` | `send` |
| `social.messages.read_state.write` | `mark_read` |

Unknown or duplicate entries are rejected when you publish. Without a
declaration, `get_access()` reports `undeclared`, and `request_access()` fails
at once with `permission_undeclared`.

### 2. The friends node

`client/friends.gd`, a child `Friends` of `Main`. In `client/main.gd`'s `_ready()`, call
`$Friends.start()` right after `Summer.initialize` succeeds:

```gdscript
extends Node
## The player's Summer friends, with their consent, and the Summer app's
## friend screens over the game.

signal friends_changed(rows: Array)   # [{user_id, name, status}]
signal status(text: String)

var friends: SummerClientFriends


## Main calls this right after Summer.initialize succeeds: a child's _ready
## runs before that, while Summer.client is still null.
func start() -> void:
	friends = Summer.client.friends
	friends.changed.connect(_render)
	friends.access_changed.connect(func(_state: StringName) -> void: _render())
	_render()


## The Friends button: asks for consent once, then shows the list.
func open() -> void:
	if not friends.is_available():
		status.emit("Friends are not available here.")
		return
	if friends.get_access() != &"granted":
		var decision: SummerResult = await friends.request_access().get_result_or_completed_signal()
		if not decision.ok:
			status.emit("Your friends list stays private.")
			return
	_render()


func _render() -> void:
	var rows := []
	for friend in friends.get_friends():
		rows.append({"user_id": friend.user_id, "name": friend.display_name, "status": friend.status})
	friends_changed.emit(rows)


## The Summer app's profile for any other player this game knows. No consent needed.
func show_profile(user_id: String) -> void:
	var shown: SummerResult = await friends.show_profile(user_id).get_result_or_completed_signal()
	if not shown.ok:
		status.emit("That screen is not available right now.")


## The Summer app's direct-message thread with a friend, over the game.
func show_chat(user_id: String) -> void:
	var shown: SummerResult = await friends.show_chat(user_id).get_result_or_completed_signal()
	if not shown.ok:
		status.emit("That screen is not available right now.")
```

How it behaves:

- **When the list is read again.** With a handler on `changed`, the engine re-reads the list on every change hint, after a consent decision, on `refresh()`, and about every 60 seconds while the game is in front. Never poll yourself.
- **Statuses.** Show `in_this_game` friends first. `unknown` means presence couldn't be read; it is not `offline`.
- **Rows.** Key them by `user_id`; each read replaces the `SummerFriend` objects.
- **Profiles of other players.** For the people in the current match, use the user ids your authority publishes (the `players` map in `skill/summer-world-chat`, step 1) and call `show_profile(user_id)`. Your own id fails with `invalid_argument`.
- **Inviting a friend into a match.** Use the party invite sheet (`skill/summer-parties`).

### 3. Direct messages (only if chat is central)

```gdscript
## Sends one direct message, asking for the send permission once.
func send_message(user_id: String, text: String) -> void:
	var messages := Summer.client.messages
	if not messages.is_available():
		return
	if messages.get_access(&"social.messages.send") != &"granted":
		var decision: SummerResult = await messages.request_access(PackedStringArray(["social.messages.send"])).get_result_or_completed_signal()
		if not decision.ok:
			return
	var sent := messages.send(user_id, text)
	var result: SummerResult = await sent.get_result_or_completed_signal()
	if result.ok:
		print("sent #%d" % sent.message.sequence)
	elif result.code == &"text_not_allowed":
		status.emit("That message was not sent.")
	elif result.code == &"target_unavailable":
		status.emit("You can't message this player.")
```

Reading a thread works the same way:

- **Read a page.** Ask for `social.messages.read`, then `messages.list_messages(user_id)`. Read `op.messages`, newest page first; pass `op.next_cursor` for older pages.
- **Catch up.** After `messages_changed`, call `list_messages_after(user_id, last_sequence)`. Today `messages_changed` fires only after a stream resync, so also reload when the chat screen opens.
- **Mark read.** `mark_read(user_id, sequence)` needs `social.messages.read_state.write`. It marks the thread read on every device.
- **Send rules.** `send` takes 1–4000 characters and no control characters except newline and tab. Each call is one message; the engine never sends it twice.

### 4. Failure codes

| Code | Meaning | Show |
| --- | --- | --- |
| `permission_not_requested`, `permission_declined`, `permission_revoked` | The player hasn't granted it | A "Show friends" button that calls `request_access()` again later |
| `permission_undeclared` | `summer.build.json` lacks it | Fix the declaration (step 1) |
| `capability_unavailable` | Local Play, guest or older Summer app | Hide the feature |
| `age_restricted` | Under-13 account | Hide the feature |
| `ui_unavailable` | The app can't show a sheet now | "Try again" |
| `operation_in_progress` (retryable) | Another Summer sheet (party or friends) is open | Wait |
| `text_not_allowed` | Filtered; nothing stored | "Not sent" |
| `target_unavailable` | Not a friend, blocked, or gone | "You can't message this player" |
| `rate_limited`, `unavailable` (retryable) | Busy, or the Player Host is unreachable | Retry later, never in a loop |

### 5. Test

Local Play has no accounts, so check the hidden path locally:

- `is_available()` is `false`;
- buttons are hidden;
- there are no script errors.

```
summer_project_setting name="summer/local_play/players" value=2
summer_play
summer_get_diagnostics
summer_stop
```

Then test on Summer staging with two accounts that are friends: grant, decline
and revoke access in the Summer app, and watch `access_changed`.

## Checklist

- [ ] The engine's class reference lists `SummerClientFriends` (Summer Engine PR #508 or later).
- [ ] `summer.build.json` declares exactly the permissions the code asks for.
- [ ] Local Play: friends features are hidden, with no script errors.
- [ ] Declining consent leaves the game fully playable, and the button can ask again later.
- [ ] Hosted: a friend playing the game shows `in_this_game`; `show_profile` opens for another player in the match.
- [ ] No polling timer: updates come from `changed`.

## Common mistakes

| Don't | Do | Why |
| --- | --- | --- |
| Ask for consent at startup | Ask when the player opens a friends feature | A consent sheet without context gets declined |
| Gate play on friends access | Treat it as optional | Declining must never block the game |
| Build friend requests, blocking or a profile screen | `show_friends()`, `show_profile()`, `show_chat()` | The Summer app owns them, with no consent needed |
| Treat `unknown` as `offline` | Show it as unknown | It means presence couldn't be read |
| Poll `refresh()` on a timer | Connect `changed` | The engine already re-reads while a handler is connected |
| Declare every permission "just in case" | Declare only what you use | The consent sheet lists each declared permission |
| Use friends to put players in one match | `skill/summer-parties` | Parties are how players play together |

## See also

- `skill/summer-parties`: playing together, the invite sheet
- `skill/summer-world-chat`: chat inside a match
- `skill/multiplayer-publish`: `summer.build.json` and publishing a Build
- `skill/multiplayer-testing`: what Local Play can and can't test
