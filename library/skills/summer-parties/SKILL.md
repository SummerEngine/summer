---
name: summer-parties
description: "Let a Summer party play together: the leader presses Play, members follow into the same match. Hosted only."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: multiplayer-and-networking
user-invocable: true
allowed-tools: Read Grep Edit Write summer_get_script_errors summer_project_setting summer_play summer_stop summer_get_diagnostics
paths: ["**/*.gd", "summer.build.json"]
---

# /summer-parties — play together with a Summer party

## Overview

A Summer party belongs to the player's Summer account, not to your game. The
Summer app creates parties, sends invites, kicks, transfers leadership and runs
party chat. Your game sees a read-only view through `Summer.client.party`:

- who is in the party, who leads, and which members have **this** game open;
- small text data your game shares with the party;
- whether the leader started a search in one of your queues.

To bring the party into a match, the **leader** joins
`SummerJoinTarget.party_queue(queue)`. Every other member joins the **same
target** when `search_started` fires. Summer puts them all in one match, each
with their own Session. The match itself is ordinary: the authority sees
normal `join` Commands and Sessions.

**Hosted only.** `is_available()` is `false` and every call fails with
`capability_unavailable`:

- in Local Play and editor runs;
- for guests;
- for accounts the platform keeps out of social features (`age_restricted`, under 13);
- in Summer apps without the `player.party@1` capability.

Outside a party, or when parties are unavailable, getters are empty and
`is_in_party()` is `false`. So the same Play button works everywhere: no party
means an ordinary `SummerJoinTarget.queue(...)` join. Build that path first.

This skill extends the Courtyard game from `skill/multiplayer-project`
(`network/game.gd` as `Game`, `client/main.gd` with `command()`).

## Steps

### 1. Join from a Play button, not from `_ready`

A party member must not join on their own the moment the game starts. Move the
join out of `client/main.gd`'s `_ready` into `enter(target)`, and keep every
signal connection from `skill/multiplayer-movement` and `skill/multiplayer-state`:

```gdscript
func _ready() -> void:
	spawner = Game.build_network(self, PlayerArchetype)
	# Connect before joining, or the first values arrive unseen.
	spawner.state_group_created.connect(_on_group_created)
	spawner.entity_spawned.connect(_on_entity_spawned)
	spawner.event_received.connect(_on_event)
	var initialized: SummerResult = await Summer.initialize(Game.GAME_ID).get_result_or_completed_signal()
	if not initialized.ok:
		push_error(initialized.message)
		return
	$Party.start()
	# With parties, the Play button calls $Party.play(). Without them (Local
	# Play, guests, apps without parties) the player plays solo right away.
	if not Summer.client.party.is_available():
		await enter(SummerJoinTarget.queue(Game.QUEUE))


## Joins a match through `target`, then enters it. True once the player is in.
func enter(target: SummerJoinTarget) -> bool:
	var join := Summer.client.join(target)
	# Hosted matchmaking may ask the player to accept a match.
	join.acceptance_required.connect(func(proposal: SummerMatchmakingProposal) -> void: proposal.accept())
	var joined: SummerResult = await join.get_result_or_completed_signal()
	if not joined.ok:
		push_warning("join failed: %s %s" % [joined.code, joined.message])
		return false
	if not spawner.is_network_ready():
		await spawner.network_ready
	var entered := await command({"c": "join"})
	if not entered.ok:
		push_error("could not enter the match: %s" % entered.error)
		return false
	print("COURTYARD_CLIENT_JOINED")
	return true
```

Move the Local Play bot hook from `skill/multiplayer-testing` into `enter()`,
after the joined line.

### 2. Add the party node

`client/party.gd`, added as a child `Party` of `Main` in `client/main.tscn`.
It is client-only: authority scenes never touch `Summer.client`.

```gdscript
extends Node
## Plays with the player's Summer party. The leader presses Play; every member
## follows into the same match. Without a party, Play joins the queue alone.

const Game = preload("res://network/game.gd")

signal roster_changed(lines: PackedStringArray)
signal status(text: String)


## Main calls this right after Summer.initialize succeeds: a child's _ready
## runs before that, while Summer.client is still null.
func start() -> void:
	var party := Summer.client.party
	party.search_started.connect(_on_search_started)
	party.changed.connect(_render)
	_render()


## The Play button.
func play() -> void:
	var party := Summer.client.party
	if not party.is_in_party():
		await get_parent().enter(SummerJoinTarget.queue(Game.QUEUE))
	elif party.is_leader():
		await get_parent().enter(SummerJoinTarget.party_queue(Game.QUEUE))
	else:
		status.emit("Waiting for %s to press Play." % party.get_leader().display_name)


## The leader started a search: members follow with the same target.
func _on_search_started(queue: StringName) -> void:
	if not Summer.client.party.is_leader():
		await get_parent().enter(SummerJoinTarget.party_queue(queue))


func _render() -> void:
	var lines := PackedStringArray()
	for member in Summer.client.party.get_members():
		var tags := []
		if member.leader:
			tags.append("leader")
		if not member.in_game:
			tags.append("not in game")
		if member.get_data("ready") == "yes":
			tags.append("ready")
		lines.append("%s %s" % [member.display_name, ", ".join(tags)])
	roster_changed.emit(lines)


## The Invite button: show it only when the Summer app offers parties.
func invite() -> void:
	var shown: SummerResult = await Summer.client.party.show_invite_dialog().get_result_or_completed_signal()
	if not shown.ok:
		status.emit("Invites are not available right now.")


## A member's Ready toggle, visible to the whole party.
func set_ready(ready: bool) -> void:
	var saved: SummerResult = await Summer.client.party.set_member_data("ready", "yes" if ready else "").get_result_or_completed_signal()
	if not saved.ok:
		status.emit("Could not update ready: %s" % saved.code)
```

Connect `roster_changed` to a `Label` or `ItemList`, and `status` to a status
line. Show the buttons by state:

| Button | Show when |
| --- | --- |
| Play | not in a party, or leader. A member sees "waiting for the leader" instead |
| Invite friends | `Summer.client.party.is_available()` |
| Party | `is_available()` and `is_in_party()`: `show_party_dialog()` opens leave, kick and leadership in the Summer app |
| Ready | a member in a party |

### 3. Share choices with party data

Party data is plain text that your game reads from every member's copy of the
party. Use it for lobby-style choices before the match starts:

- **Leader's choices** (map, mode): `party.set_data(key, value)`, read with `party.get_data(key)`. Only the leader can write it; a member gets `not_party_leader`.
- **Each member's own choices** (ready, character): `party.set_member_data(key, value)`, read with `member.get_data(key)`.

Limits:

| What | Limit |
| --- | --- |
| Keys | 1–32 characters from `a-z 0-9 _ . -` |
| Values | at most 256 UTF-8 bytes of text, no control characters; an empty value deletes the key |
| Leader keys | 16 per game |
| Member keys | 8 per member per game |

Values pass the Summer chat text filter, so `text_not_allowed` is possible.
Writes return `SummerOperation`. A conflict is retried once by the engine, then
fails with retryable `party_version_conflict`. React to `data_changed(key)` and
`member_data_changed(member, key)`, or just re-render on `changed`.

Party data is a lobby convenience, not game state. Once the match starts, the
authority owns everything (`skill/multiplayer-state`). It never sees party data;
send choices that matter in your `join` Command and validate them there.

### 4. Handle join failures

`enter()` returns `false` with the code in the warning. For a party join:

| Code | Who | What to show |
| --- | --- | --- |
| `party_member_offline` (retryable) | leader | "Everyone in your party needs the game open." `member.in_game` tells you who |
| `party_not_searching` (retryable) | member | Nothing; wait for the next `search_started` |
| `party_not_found` | anyone | The party ended; fall back to a solo Play |
| `capability_unavailable` | anyone | Parties aren't offered here; use the solo path |

A member can follow only while the leader's search is running: from
`search_started` until `search_ended`.

### 5. Test

Local Play cannot create a party, so `is_available()` is `false` and each
client joins solo from `_ready`. Test that path locally, then the party path
on Summer staging with real accounts.

```
summer_project_setting name="summer/local_play/players" value=2
summer_play
summer_get_diagnostics
summer_stop
```

## Checklist

- [ ] Local Play: `Summer.client.party.is_available()` is `false`, Play joins through the plain queue, and no script errors appear.
- [ ] Invite and Party buttons are hidden when `is_available()` is `false`.
- [ ] A member's Play button doesn't join on its own.
- [ ] Hosted: the leader presses Play, and every member with the game open lands in the same match.
- [ ] A member who closes the game makes the leader's Play fail with `party_member_offline`, and the message names who is missing.
- [ ] Ready and leader choices appear on every member's screen.

## Common mistakes

| Don't | Do | Why |
| --- | --- | --- |
| Join in `_ready` while parties are available | Join from Play via `enter(target)` | A member joining alone splits the party |
| Members join `SummerJoinTarget.queue(...)` | Members join `party_queue(queue)` on `search_started` | Only the party target attaches them to the leader's search |
| Show Invite when `is_available()` is false | Hide it | Local Play, guests and under-13 accounts have no parties |
| Build your own invite list or party chat | `show_invite_dialog()` / `show_party_dialog()` | The Summer app owns invites, kicks, leadership and chat |
| Hold `SummerPartyMember` objects | Key UI by `member.user_id` and re-read on `changed` | Each snapshot replaces the member objects |
| Trust party data on the authority | Send choices in the `join` Command and validate | The authority never sees party data |
| Put secrets or long text in party data | Short public choices (`map`, `ready`) | 256 bytes, filtered, visible to every member |
| `await op.completed` | `await op.get_result_or_completed_signal()` | Fast failures complete before you can connect |

## See also

- `skill/summer-matchmaking`: queues, sizes, teams and the accept prompt
- `skill/summer-friends`: friends list, profiles and messages
- `skill/multiplayer-project`: the client entry scene this extends
- `skill/multiplayer-testing`: Local Play, and what needs staging
