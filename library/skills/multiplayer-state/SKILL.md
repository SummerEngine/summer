---
name: multiplayer-state
description: "Authority-owned game state in Summer multiplayer: shared and private State groups, validated Commands, and Events."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: multiplayer-and-networking
user-invocable: true
allowed-tools: Read Grep Glob Edit Write summer_read_file summer_write_file summer_get_script_errors summer_project_setting summer_play summer_stop summer_get_diagnostics
paths: ["network/**", "client/**", "authority/**"]
---

# /multiplayer-state — what the authority owns, and how players ask

Step 3 of the multiplayer sequence. It continues Courtyard from
`multiplayer-movement`: players walk to coins, collect them, and see a
shared scoreboard, a private wallet and a sparkle. [files.md](files.md) has
every file this step changes, complete, as it ran under Local Play.

## How it works

Except for each player's own pose, **the authority owns every fact**: score,
health, doors, inventories, rounds, who won. Clients never change shared
state. They **ask** with a Command; the authority checks the request against
the sender's verified Session and the current state, changes the state, and
answers.

| The fact | Primitive | Who sees it |
|---|---|---|
| Score, round timer, a door, who holds the flag | Authority-written State group | Everyone (`SummerWorldAudience`) |
| My wallet, my hand of cards, my inventory | Authority-written State group created for that player's Session | Only that player (`SummerTargetSessionAudience`) |
| "Collect this", "buy that", "open the door", "ready" | Command | The authority, which accepts or refuses |
| A sparkle, a sound, a hit flash | Event | Everyone, once, best-effort |
| A player's position | Owner-written pose (`multiplayer-movement`) | Everyone |

State is retained: a player who joins late receives the current value.
Events are not.

Before writing code, list the game's facts in this table and confirm it with
the user.

## 1. Declare the streams

Add three streams to `network/composition.tres`: `Match` (shared document),
`Mine` (private document) and `Fx` (an Event):

```ini
[sub_resource type="SummerNetworkField" id="MatchBytes"]
field_name = &"b"
type = 20

[sub_resource type="SummerNetworkSchema" id="MatchSchema"]
schema_id = &"courtyard.match.v1"
state_fields = Array[SummerNetworkField]([SubResource("MatchBytes")])

[sub_resource type="SummerWorldAudience" id="MatchAudience"]
max_expansion = 8

[sub_resource type="SummerNetworkStateStream" id="Match"]
stream_id = &"courtyard.match"
state_schema = SubResource("MatchSchema")
audience_policy = SubResource("MatchAudience")
max_audience_count = 8
max_keys = 1
max_state_bytes = 4096
max_total_bytes = 4096

[sub_resource type="SummerNetworkField" id="MineBytes"]
field_name = &"b"
type = 20

[sub_resource type="SummerNetworkSchema" id="MineSchema"]
schema_id = &"courtyard.mine.v1"
state_fields = Array[SummerNetworkField]([SubResource("MineBytes")])

[sub_resource type="SummerTargetSessionAudience" id="OnlyThatPlayer"]
max_expansion = 1

[sub_resource type="SummerNetworkStateStream" id="Mine"]
stream_id = &"courtyard.mine"
state_schema = SubResource("MineSchema")
audience_policy = SubResource("OnlyThatPlayer")
max_audience_count = 1
max_keys = 8
max_state_bytes = 1024
max_total_bytes = 8192

[sub_resource type="SummerNetworkField" id="FxPosition"]
field_name = &"position"
type = 9

[sub_resource type="SummerNetworkSchema" id="FxSchema"]
schema_id = &"courtyard.fx.v1"
state_fields = Array[SummerNetworkField]([SubResource("FxPosition")])

[sub_resource type="SummerWorldAudience" id="FxAudience"]
max_expansion = 8

[sub_resource type="SummerNetworkOccurrenceStream" id="Fx"]
stream_id = &"courtyard.fx"
kind = 2
command_scope = 0
event_scope = 2
event_delivery = 2
transient_ttl_ticks = 30
max_outcome_history = 0
command_timeout_msec = 0
audience_policy = SubResource("FxAudience")
max_audience_count = 8
payload_schema = SubResource("FxSchema")
```

and list them in the `[resource]`:

```ini
[resource]
network_version = "1.0.0"
state_streams = Array[SummerNetworkStateStream]([SubResource("Motion"), SubResource("Match"), SubResource("Mine")])
occurrence_streams = Array[SummerNetworkOccurrenceStream]([SubResource("Commands"), SubResource("Fx")])
```

Update `load_steps` in the first line. [files.md](files.md) has the complete
file.

- **Documents travel as JSON in a byte field** (`type = 20`). A network
  `String` holds at most 256 bytes, which a document outgrows fast.
- **Audiences:** `max_expansion` and `max_audience_count` default to 0,
  which reaches nobody. Use the player count for World audiences and 1 for
  a private one.
- **Event streams** set `kind = 2`, `command_scope = 0`, `event_scope = 2`
  (World), `event_delivery = 2` (Transient), a `transient_ttl_ticks`, and
  **`max_outcome_history = 0` and `command_timeout_msec = 0`**. Those two
  default to non-zero. With the defaults, the Spawner logs `cannot attach`
  and the whole network stays down.

Add the stream ids to `network/game.gd`:

```gdscript
const CMD := &"courtyard.cmd"
const MATCH := &"courtyard.match"   # one document every player sees
const MINE := &"courtyard.mine"     # one private document per player
const FX := &"courtyard.fx"         # one-off effects, never stored
```

## 2. The authority decides

`authority/main.gd`:

```gdscript
extends Node
## The match server. It runs headless and owns every rule.

const Game = preload("res://network/game.gd")
const PlayerArchetype = preload("res://authority/player_archetype.tres")
## How far a player may move in one burst after a network stall, in metres.
const BURST := Game.MAX_SPEED * 0.5
const REACH := 2.0      # how close a player must stand to collect a coin

var spawner: SummerNetworkSpawner
var world: SummerNetworkWorld
var seat_of := {}       # session_id -> seat, held until the Session leaves
var allowance := {}     # seat -> metres the player may still move
var refilled_at := {}   # seat -> msec of the last allowance refill

var match_group: SummerNetworkStateGroup
var match_doc := {"coins": {"0": [10.0, 0.5, 0.0], "1": [-10.0, 0.5, 0.0], "2": [0.0, 0.5, 10.0]}, "scores": {}}
var mine_groups := {}   # session_id -> private group
var wallets := {}       # session_id -> coins this player holds
var receipts := {}      # session_id -> {request id: result}


func _ready() -> void:
	spawner = Game.build_network(self, PlayerArchetype)
	world = $World
	spawner.entity_spawned.connect(_on_player_spawned)
	spawner.command_received.connect(_on_command)
	world.session_left.connect(_on_session_left)
	var initialized: SummerResult = await Summer.initialize(Game.GAME_ID).get_result_or_completed_signal()
	if not initialized.ok:
		push_error(initialized.message)
		return
	if not world.is_ready():
		await world.binding_ready
	if not spawner.is_network_ready():
		await spawner.network_ready
	match_group = spawner.create_state_group(Game.MATCH, &"match", Game.pack(match_doc))
	print("COURTYARD_AUTHORITY_READY")


## A seat is a player's place in this World for their whole stay, across
## reconnects. Returns -1 when the World is full.
func _seat(session: SummerSession) -> int:
	if seat_of.has(session.session_id):
		return seat_of[session.session_id]
	var taken := seat_of.values()
	for seat in Game.MAX_PLAYERS:
		if seat not in taken:
			seat_of[session.session_id] = seat
			return seat
	return -1


## The Spawner spawns one player entity per joined player, once that player's
## network is ready (and again after a reconnect). Its owner becomes the only
## writer of the pose; the group ends with the entity.
func _on_player_spawned(entity: SummerNetworkEntity) -> void:
	var seat := _seat(entity.session)
	if seat < 0:
		push_warning("no free seat")
		return
	allowance[seat] = BURST
	refilled_at[seat] = Time.get_ticks_msec()
	var group := spawner.create_state_group(Game.MOTION, Game.motion_key(seat), Game.spawn_pose(seat, entity.entity_id), entity.session, entity)
	group.set_acceptance_policy(_accept_motion.bind(seat))
	print("COURTYARD_PLAYER_SPAWNED seat=%d entity=%d" % [seat, entity.entity_id])


## Runs on every pose an owner submits. True accepts it unchanged; false
## refuses it, and the owner snaps back to the last accepted pose.
func _accept_motion(candidate: Dictionary, current: Dictionary, seat: int) -> bool:
	if candidate.entity != current.entity:
		return false   # a player can move, never become someone else
	var position: Vector3 = candidate.position
	if not Game.in_bounds(position) or not is_finite(candidate.yaw):
		return false
	# A distance allowance refilled at MAX_SPEED: bursts after a stall pass,
	# speed hacks and teleports do not.
	var now := Time.get_ticks_msec()
	var budget := minf(float(allowance[seat]) + Game.MAX_SPEED * (now - int(refilled_at[seat])) / 1000.0, BURST)
	refilled_at[seat] = now
	var distance := position.distance_to(current.position)
	if distance > budget:
		allowance[seat] = budget
		return false
	allowance[seat] = budget - distance
	return true


## Moves a player on purpose (respawn, portal). The owner snaps to it.
func teleport(seat: int, position: Vector3) -> void:
	var group := spawner.get_state_group(Game.MOTION, Game.motion_key(seat))
	if group != null and group.active:
		var pose := group.get_state()
		pose.position = position
		allowance[seat] = BURST
		group.reset(pose)


func _on_command(request: SummerNetworkCommandRequest) -> void:
	var command := Game.unpack(request.payload)
	var session := request.get_session()
	var rid := str(command.get("rid", ""))
	# A retry of a request already answered gets the same answer, applied once.
	var answered: Dictionary = receipts.get(session.session_id, {})
	if rid != "" and answered.has(rid):
		request.accept({}, Game.pack(answered[rid]))
		return
	match str(command.get("c", "")):
		"join":
			_join(request)
		"collect":
			_collect(request, rid, str(command.get("coin", "")))
		_:
			request.refuse(&"unknown_command")


## A client sends "join" once its network is ready: set up what the player
## owns besides their body.
func _join(request: SummerNetworkCommandRequest) -> void:
	var session := request.get_session()
	var seat := _seat(session)
	if seat < 0:
		request.refuse(&"match_full")
		return
	if not mine_groups.has(session.session_id):
		wallets[session.session_id] = 0
		# Private state: only this Session receives it, only the authority writes it.
		mine_groups[session.session_id] = spawner.create_state_group(Game.MINE, StringName("mine%d" % seat), Game.pack({"coins": 0}), null, null, session)
	request.accept({}, Game.pack({"seat": seat}))
	print("COURTYARD_PLAYER_JOINED seat=%d" % seat)


## Checks everything before changing anything, then changes state only
## through the groups so every client, late joiners included, agrees.
func _collect(request: SummerNetworkCommandRequest, rid: String, coin: String) -> void:
	var session := request.get_session()
	if rid == "":
		request.refuse(&"missing_request_id")
		return
	if not mine_groups.has(session.session_id):
		request.refuse(&"not_joined")
		return
	if not match_doc.coins.has(coin):
		request.refuse(&"coin_gone")
		return
	# The player's latest accepted pose, never a position from the payload.
	var body := spawner.get_state_group(Game.MOTION, Game.motion_key(seat_of[session.session_id]))
	if body == null or not body.active:
		request.refuse(&"not_spawned")
		return
	var at: Array = match_doc.coins[coin]
	if (body.get_state().position as Vector3).distance_to(Vector3(at[0], at[1], at[2])) > REACH:
		request.refuse(&"too_far")
		return
	match_doc.coins.erase(coin)
	var name := session.player.display_name
	match_doc.scores[name] = int(match_doc.scores.get(name, 0)) + 1
	match_group.reset(Game.pack(match_doc))
	wallets[session.session_id] += 1
	(mine_groups[session.session_id] as SummerNetworkStateGroup).reset(Game.pack({"coins": wallets[session.session_id]}))
	spawner.publish_event_by_policy(Game.FX, {"position": Vector3(at[0], at[1], at[2])})
	var result := {"coin": coin, "coins": wallets[session.session_id]}
	var answered: Dictionary = receipts.get(session.session_id, {})
	answered[rid] = result
	receipts[session.session_id] = answered
	request.accept({}, Game.pack(result))


## The Session ended for good: free the seat and everything the player had.
func _on_session_left(session: SummerSession, reason: String) -> void:
	var seat: int = seat_of.get(session.session_id, -1)
	seat_of.erase(session.session_id)
	var mine: SummerNetworkStateGroup = mine_groups.get(session.session_id)
	if mine != null and mine.active:
		mine.retire()
	mine_groups.erase(session.session_id)
	wallets.erase(session.session_id)
	receipts.erase(session.session_id)
	print("COURTYARD_PLAYER_LEFT seat=%d reason=%s" % [seat, reason])
```

The rules that matter:

- **Identity comes from `request.get_session()`**, never from the payload.
- **Positions come from the accepted pose group**, never from the payload.
  Commands set `command_tick_dispatch`, so the tick's poses are installed
  before the handler runs.
- **Check every precondition before changing anything:** joined, item still
  there, in reach, can afford it.
- **Refuse with a stable reason id** (`&"too_far"`). The client turns it into
  text.
- **Every action carries a request id.** Keep each player's answers, and
  answer a retry with the stored result. A Command that timed out on the
  client may already have been applied, and a blind resend would apply it
  twice.
- **Change state only through groups.** `reset(document)` replaces the value
  for everyone in its audience, late joiners included.
- **Retire a player's private group in `session_left`.** Authority-written
  groups outlive a disconnect, so a reconnecting player gets their wallet
  back.

## 3. The client asks and shows

`client/main.gd` keeps the documents the authority publishes and asks for
coins. Add the two documents:

```gdscript
var match_doc := {}   # what the authority published for everyone
var mine := {}        # what the authority published for this player only
```

connect Events with the other signals in `_ready()`:

```gdscript
	spawner.event_received.connect(_on_event)
```

route the two document streams in `_on_group_created`, and add the handlers:

```gdscript
func _on_group_created(group: SummerNetworkStateGroup) -> void:
	match group.get_stream_id():
		Game.MOTION:
			_attach_pose(group, int(group.get_state().entity))
		Game.MATCH, Game.MINE:
			# The baseline is already installed when this fires; later
			# changes arrive through state_installed.
			_on_document(group, group.get_state())
			group.state_installed.connect(func(state: Dictionary, _revision: int, _reset: bool) -> void: _on_document(group, state))
```

```gdscript
func _on_document(group: SummerNetworkStateGroup, state: Dictionary) -> void:
	if group.get_stream_id() == Game.MATCH:
		match_doc = Game.unpack(state)
	else:
		mine = Game.unpack(state)


func _on_event(event: SummerNetworkEvent) -> void:
	if event.stream_id == Game.FX:
		print("COURTYARD_SPARKLE at %s" % event.payload.position)


## Asks the authority for a coin. The request id makes a retry safe.
func collect(coin: String) -> Dictionary:
	return await command({"c": "collect", "coin": coin, "rid": "collect-%s-%d" % [coin, Time.get_ticks_usec()]})
```

- `state_group_created` fires with the group's first value already
  installed. Read it with `group.get_state()` right there; `state_installed`
  reports only later changes.
- The client never edits `match_doc` or `mine`. It shows what the authority
  published. For instant feedback, show a pending state ("collecting…")
  until the Command answers.
- JSON numbers come back as floats (`"coins": 1.0`). Convert with `int()`
  before showing or comparing.
- Use Events for effects only. A Transient Event can be lost on a bad
  network; anything that must arrive belongs in State.

## 4. Test it

Run Local Play with 2 players and network emulation (`multiplayer-testing`):

- [ ] Both clients receive the shared document; each receives only its own private document.
- [ ] An accepted Command changes the shared document on every client.
- [ ] A refused Command changes nothing and returns its reason id (`too_far`, `coin_gone`).
- [ ] Sending a Command again with the same request id returns the same answer and applies once.
- [ ] A client that joins late sees the current scores at once.

## Common mistakes

| Don't | Do | Why |
|---|---|---|
| Change shared state on the client "for responsiveness" | Show a pending state until the Command answers | The authority is the only source of truth |
| `@rpc("any_peer")` handlers | A Command checked on the authority | Peer ids are not verified players |
| Trust `player_id` or a position from the payload | `request.get_session()` and the accepted pose | Clients can send anything |
| JSON in a `String` field | A `PACKED_BYTE_ARRAY` field | Strings stop at 256 bytes |
| Leave `max_expansion` / `max_audience_count` at 0 | The player count, or 1 for private | 0 reaches nobody |
| Default bounds on an Event stream | `max_outcome_history = 0`, `command_timeout_msec = 0` | Otherwise `cannot attach`: no networking at all |
| Wait for `state_installed` to get the first value | `group.get_state()` in `state_group_created` | The first value is already installed |
| Resend a timed-out Command with a new request id | The same request id | It may already have been applied |
| Send something important as a Transient Event | Put it in State | Transient Events can be lost |
| Compare JSON numbers to ints directly | `int(value)` | JSON numbers come back as floats |
| Keep a private group after `session_left` | `retire()` it | Its key stays taken |

## Next

`multiplayer-testing`: bots and a bad network. Then `multiplayer-publish`.
