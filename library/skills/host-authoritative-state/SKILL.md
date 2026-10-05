---
name: host-authoritative-state
description: "Design a Summer game's authoritative state: what the authority owns, Commands for intent, authority-written State groups for shared and private state."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: multiplayer-and-networking
user-invocable: true
allowed-tools: Read Grep Edit Write summer_get_scene_tree summer_inspect_node summer_save_scene summer_get_script_errors summer_project_setting summer_play summer_stop summer_get_diagnostics
paths: ["**/*.gd", "**/*.tscn", "world.json", "summer.build.json"]
---

# /host-authoritative-state — what the authority owns, and how clients ask

## Overview

In a Summer game the headless **authority** owns every fact that matters:

- score, health, inventory, doors, rounds, who won.
- **Clients never change shared state.** They send intent as a **Command**. The authority validates it against the sender's **verified Session** and changes the state.
- Every client then receives the result through an **authority-written State group**: shared with everyone, or private to one player.

Continuous player motion is different: it uses a predicted
`SummerNetworkBehavior` (`skill/setup-multiplayer`). This skill covers
everything else.

**Never use `@rpc`, `MultiplayerSynchronizer` or synced variables for this.**
Their sender ids are transport peers, not verified players. Late joiners miss
state, and none of it works with Summer hosting.

## Steps

### 1. List the state and decide who owns it

For each fact, ask: *if two players disagree, who is right?* On Summer the
answer is always the authority. Then pick the primitive:

| The fact | Primitive | Audience |
|---|---|---|
| Shared world state: score, round timer, door open, who's in the match | Authority-written State group | `SummerWorldAudience` |
| One player's private state: wallet, inventory, hand of cards | Authority-written State group created for that player's Session | `SummerTargetSessionAudience` |
| A player wants something: buy, open, use, ready up | Command, validated by the authority | (the sender) |
| A player's character moving | `SummerNetworkBehavior` entity | see `skill/setup-multiplayer` |
| A hitscan shot | Historical ray Command | see `skill/setup-multiplayer` |

Decide these before writing code. State the table back to the user.

### 2. Declare the streams once, for both roles

Put the network setup in one shared script that the client entry scene and the
authority scene both call. Client and authority must build the **same**
composition, or they refuse each other.

```gdscript
class_name GameNet
extends RefCounted

const GAME_ID := "your-game-id"
const SHARED := &"game.shared"   # world-visible document
const MINE := &"game.mine"       # private document, one group per player
const CMD := &"game.cmd"         # every player action
const MAX_PLAYERS := 8


static func _schema(id: StringName, fields: Dictionary) -> SummerNetworkSchema:
	var schema := SummerNetworkSchema.new()
	schema.schema_id = id
	var list: Array[SummerNetworkField] = []
	for key: String in fields:
		var field := SummerNetworkField.new()
		field.field_name = StringName(key)
		field.type = fields[key]
		list.append(field)
	schema.state_fields = list
	return schema


static func _stream(id: StringName, private: bool, keys: int) -> SummerNetworkStateStream:
	var stream := SummerNetworkStateStream.new()
	stream.stream_id = id
	stream.state_schema = _schema(StringName(String(id) + ".v1"), {"b": SummerNetworkField.TYPE_PACKED_BYTE_ARRAY})
	stream.writer_policy = SummerNetworkStateStream.WRITER_AUTHORITY
	stream.audience_policy = SummerTargetSessionAudience.new() if private else SummerWorldAudience.new()
	stream.audience_policy.max_expansion = 1 if private else MAX_PLAYERS   # 0, the default, reaches nobody
	stream.max_audience_count = 1 if private else MAX_PLAYERS
	stream.max_keys = keys
	stream.max_state_bytes = 4096
	stream.max_total_bytes = 4096 * keys
	return stream


static func build(parent: Node) -> SummerNetworkSpawner:
	var world := SummerNetworkWorld.new()
	world.name = "NetworkWorld"
	parent.add_child(world)
	var entities := Node.new()
	entities.name = "Entities"
	parent.add_child(entities)
	var composition := SummerNetworkComposition.new()
	composition.network_version = "1.0.0"
	var streams: Array[SummerNetworkStateStream] = [_stream(SHARED, false, 1), _stream(MINE, true, MAX_PLAYERS)]
	composition.state_streams = streams
	var cmd := SummerNetworkOccurrenceStream.new()
	cmd.stream_id = CMD
	cmd.command_scope = SummerNetworkOccurrenceStream.COMMAND_SCOPE_WORLD
	cmd.command_timeout_msec = 8000
	cmd.payload_schema = _schema(&"game.cmd.v1", {"b": SummerNetworkField.TYPE_PACKED_BYTE_ARRAY})
	cmd.result_schema = _schema(&"game.cmd.result.v1", {"b": SummerNetworkField.TYPE_PACKED_BYTE_ARRAY})
	composition.occurrence_streams = [cmd]
	var spawner := SummerNetworkSpawner.new()
	spawner.name = "Spawner"
	spawner.network_world_path = NodePath("../NetworkWorld")
	spawner.entities_root_path = NodePath("../Entities")
	spawner.network_composition = composition
	parent.add_child(spawner)
	return spawner


static func pack(document: Dictionary) -> Dictionary:
	return {"b": JSON.stringify(document).to_utf8_buffer()}


static func unpack(fields: Dictionary) -> Dictionary:
	var parsed: Variant = JSON.parse_string((fields.get("b", PackedByteArray()) as PackedByteArray).get_string_from_utf8())
	return parsed if parsed is Dictionary else {}
```

If the game also has player entities from `skill/setup-multiplayer`, add this
composition to that Spawner (`network_composition`) instead of building a
second one. This skill's own example uses an entity-free Spawner
(`player_archetype` left empty).

Documents travel as JSON bytes: a network `String` holds at most 256 UTF-8
bytes.

### 3. Validate on the authority, with the verified identity

```gdscript
extends Node

var spawner: SummerNetworkSpawner
var shared_group: SummerNetworkStateGroup
var mine_groups := {}    # user_id -> private group
var receipts := {}       # user_id -> {request_id: result}
var state := {"score": 0}
var wallets := {}        # user_id -> coins


func _ready() -> void:
	spawner = GameNet.build(self)
	spawner.command_received.connect(_on_command)
	var initialized: SummerResult = await Summer.initialize(GameNet.GAME_ID).get_result_or_completed_signal()
	if not initialized.ok:
		push_error(initialized.message)
		return
	var world: SummerNetworkWorld = $NetworkWorld
	if not world.is_ready():
		await world.binding_ready
	if not spawner.is_network_ready():
		await spawner.network_ready
	shared_group = spawner.create_state_group(GameNet.SHARED, &"shared", GameNet.pack(state))


func _on_command(request: SummerNetworkCommandRequest) -> void:
	var session := request.get_session()
	var uid := session.player.user_id               # verified; never read a player id from the payload
	var command := GameNet.unpack(request.get_payload())
	var rid := str(command.get("rid", ""))
	if receipts.get(uid, {}).has(rid):              # a retry: same answer, no second effect
		request.accept({}, GameNet.pack(receipts[uid][rid]))
		return
	match str(command.get("c", "")):
		"join":
			if not mine_groups.has(uid):
				wallets[uid] = 10
				# Positional arguments: stream, key, initial, writer, entity, target Session.
				mine_groups[uid] = spawner.create_state_group(GameNet.MINE, StringName("mine_" + uid.sha256_text().left(16)), GameNet.pack({"coins": wallets[uid]}), null, null, session)
		"score":
			if not mine_groups.has(uid):
				request.refuse(&"not_joined")
				return
			if int(wallets[uid]) < 1:
				request.refuse(&"no_coins")
				return
			wallets[uid] = int(wallets[uid]) - 1
			state["score"] = int(state["score"]) + 1
			shared_group.reset(GameNet.pack(state))
			(mine_groups[uid] as SummerNetworkStateGroup).reset(GameNet.pack({"coins": wallets[uid]}))
		_:
			request.refuse(&"unknown_command")
			return
	var result := {"ok": true, "rid": rid}
	receipts[uid] = receipts.get(uid, {})
	receipts[uid][rid] = result
	request.accept({}, GameNet.pack(result))
```

The validation rules that matter:

- **Identity comes from `request.get_session()`, never from the payload.**
- **Every action carries a request id.** Keep each player's recent results, and answer a retry with the stored result. A Command that timed out on the client may already have been applied, so a blind resend would double-spend.
- **Refuse with stable reason ids** (`&"no_coins"`); the client maps them to text.
- **Check every precondition before changing anything:** ownership, range, cooldown, cost.
- Change state only through the groups (`reset`), so every client, including late joiners, sees the same result.

### 4. Ask from the client, and render what the authority publishes

```gdscript
extends Node

var spawner: SummerNetworkSpawner
var shared := {}
var mine := {}


func _ready() -> void:
	spawner = GameNet.build(self)
	spawner.state_group_created.connect(_on_group)   # connect before joining, or late-join baselines arrive unseen
	var initialized: SummerResult = await Summer.initialize(GameNet.GAME_ID).get_result_or_completed_signal()
	if not initialized.ok:
		return
	var join := Summer.client.join(SummerJoinTarget.queue(&"casual"))
	join.acceptance_required.connect(func(proposal: SummerMatchmakingProposal) -> void: proposal.accept())
	var joined: SummerResult = await join.get_result_or_completed_signal()
	if not joined.ok:
		return
	if not spawner.is_network_ready():
		await spawner.network_ready
	await command({"c": "join", "rid": "join-%d" % Time.get_ticks_msec()})


func command(payload: Dictionary) -> Dictionary:
	var admission := spawner.enqueue_command(GameNet.CMD, GameNet.pack(payload))
	if not admission.is_enqueued():
		return {"ok": false, "error": "not_admitted"}   # keep it; resend later with the same rid
	var handle := admission.get_handle()
	if not handle.is_terminal():
		await handle.completed
	if handle.get_outcome() == SummerNetworkCommandHandle.OUTCOME_ACCEPTED:
		return {"ok": true, "error": "", "result": GameNet.unpack(handle.get_result())}
	return {"ok": false, "error": String(handle.get_reason())}


# The group's initial state is already installed when this fires, and
# state_installed reports only later changes, so read the baseline here.
func _on_group(group: SummerNetworkStateGroup) -> void:
	_apply(group, group.get_state())
	group.state_installed.connect(func(installed: Dictionary, _revision: int, _reset: bool) -> void: _apply(group, installed))


func _apply(group: SummerNetworkStateGroup, installed: Dictionary) -> void:
	if group.get_stream_id() == GameNet.SHARED:
		shared = GameNet.unpack(installed)
	elif group.get_stream_id() == GameNet.MINE:
		mine = GameNet.unpack(installed)
```

The client never edits `shared` or `mine` itself. It shows what the authority
installed. For instant feedback, show a pending state ("buying…") until the
Command resolves.

### 5. Declare the World and test

Use the same `summer.build.json`, `world.json` and authority scene as
`skill/setup-multiplayer` steps 5–6. Then run Local Play with two players:

```
summer_project_setting name="summer/local_play/players" value=2
summer_play
summer_get_diagnostics
summer_stop
```

Checklist:

- [ ] Both clients receive the shared group, and each receives only its own private group.
- [ ] An accepted Command changes the shared document on every client.
- [ ] A refused Command changes nothing and returns its reason id.
- [ ] Resending a Command with the same request id doesn't apply it twice.
- [ ] A client that joins late sees the current shared state immediately.

## Common mistakes

| Don't | Do | Why |
|---|---|---|
| `@rpc("any_peer")` handlers that change state | A Command validated on the authority | Peer ids aren't verified players |
| Trust `player_id` in a payload | `request.get_session().player.user_id` | Clients can send anything |
| JSON in a `String` field | `TYPE_PACKED_BYTE_ARRAY` documents | Strings cap at 256 UTF-8 bytes |
| Leave `max_expansion` / `max_audience_count` at 0 | At least the player count (1 for private streams) | 0 reaches nobody |
| Connect `state_group_created` after joining | Connect it before `Summer.client.join` | Late-join baselines arrive unseen |
| Wait for `state_installed` to get a group's first value | Read `group.get_state()` in the `state_group_created` handler | The baseline is installed before that signal; `state_installed` only reports later changes |
| Resend a timed-out Command with a new id | Resend with the same request id | It may already have been applied |
| Change shared state on the client "for responsiveness" | Show a pending state until the Command resolves | The authority is the only source of truth |
| Name your classes `SummerSession` or `SummerWorld` | Your own names | Those are engine classes; the parse error only says it "hides a native class" |

## See also

- `skill/setup-multiplayer` — players, movement, Local Play and hit checks
- `skill/peer-to-peer-multiplayer` — why there is no player host on Summer
