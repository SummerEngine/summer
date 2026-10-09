# multiplayer-state: complete files after this step

Every file below ran as shown under Local Play. Compare against your project, or copy a file whole.

## `authority/main.gd`

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

## `client/bot.gd`

```gdscript
extends Node
## Test bot for Local Play, enabled with `-- --bot={client}`. It presses the
## real input actions. Bot 1 walks to the first coin and collects it; every
## bot prints what it sees, for the test run to check.

const COIN := "0"

var number := 0
var main: Node
var elapsed := 0.0
var step := 0


func _process(delta: float) -> void:
	elapsed += delta
	var me := _own_player()
	if me == null:
		return
	if number == 1 and step == 0:
		var at: Array = main.match_doc.get("coins", {}).get(COIN, [])
		if at.is_empty():
			return
		var to_coin := Vector2(at[0] - me.global_position.x, at[2] - me.global_position.z)
		if to_coin.length() > 0.5:
			_steer(to_coin.normalized())
			return
		_steer(Vector2.ZERO)
		step = 1
		print("BOT_MOVED %s" % me.global_position)
		var collected: Dictionary = await main.collect(COIN)
		print("BOT_COLLECT %s" % JSON.stringify(collected))
	if elapsed > 6.0 and step < 2:
		step = 2
		for node in main.get_node("Entities").get_children():
			if node != me:
				print("BOT_SAW %s" % node.global_position)
		print("BOT_SCORES %s" % JSON.stringify(main.match_doc.get("scores", {})))


func _own_player() -> Node3D:
	for node in main.get_node("Entities").get_children():
		if node.get_script() == preload("res://client/player_owner.gd"):
			return node
	return null


func _steer(direction: Vector2) -> void:
	for action in [&"ui_left", &"ui_right", &"ui_up", &"ui_down"]:
		Input.action_release(action)
	if direction.x > 0.0: Input.action_press(&"ui_right", direction.x)
	if direction.x < 0.0: Input.action_press(&"ui_left", -direction.x)
	if direction.y > 0.0: Input.action_press(&"ui_down", direction.y)
	if direction.y < 0.0: Input.action_press(&"ui_up", -direction.y)
```

## `client/main.gd`

```gdscript
extends Node
## What each player runs: joins the match and shows every player.

const Game = preload("res://network/game.gd")
const PlayerArchetype = preload("res://client/player_archetype.tres")

var spawner: SummerNetworkSpawner
var waiting := {}     # entity id -> pose group that arrived before its entity
var match_doc := {}   # what the authority published for everyone
var mine := {}        # what the authority published for this player only


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
	var join := Summer.client.join(SummerJoinTarget.queue(Game.QUEUE))
	# Hosted matchmaking may ask the player to accept a match.
	join.acceptance_required.connect(func(proposal: SummerMatchmakingProposal) -> void: proposal.accept())
	var joined: SummerResult = await join.get_result_or_completed_signal()
	if not joined.ok:
		push_error("join failed: %s %s" % [joined.code, joined.message])
		return
	if not spawner.is_network_ready():
		await spawner.network_ready
	var entered := await command({"c": "join"})
	if not entered.ok:
		push_error("could not enter the match: %s" % entered.error)
		return
	print("COURTYARD_CLIENT_JOINED")
	# Local Play test bot: `-- --bot={client}` (see multiplayer-testing).
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--bot="):
			var bot := preload("res://client/bot.gd").new()
			bot.number = int(arg.trim_prefix("--bot="))
			bot.main = self
			add_child(bot)


## Sends one Command and waits for the authority's answer.
func command(payload: Dictionary) -> Dictionary:
	var admission := spawner.enqueue_command(Game.CMD, Game.pack(payload))
	if not admission.is_enqueued():
		return {"ok": false, "error": String(admission.get_code())}
	var handle := admission.get_handle()
	if not handle.is_terminal():
		await handle.completed
	if handle.get_outcome() == SummerNetworkCommandHandle.OUTCOME_ACCEPTED:
		return {"ok": true, "error": "", "result": Game.unpack(handle.get_result())}
	return {"ok": false, "error": String(handle.get_reason())}


func _on_group_created(group: SummerNetworkStateGroup) -> void:
	match group.get_stream_id():
		Game.MOTION:
			_attach_pose(group, int(group.get_state().entity))
		Game.MATCH, Game.MINE:
			# The baseline is already installed when this fires; later
			# changes arrive through state_installed.
			_on_document(group, group.get_state())
			group.state_installed.connect(func(state: Dictionary, _revision: int, _reset: bool) -> void: _on_document(group, state))


## The pose group and the player's entity can arrive in either order.
func _attach_pose(group: SummerNetworkStateGroup, entity_id: int) -> void:
	var entity := spawner.get_entity(entity_id)
	if entity == null or entity.root == null:
		waiting[entity_id] = group
		return
	entity.root.bind(group)


func _on_entity_spawned(entity: SummerNetworkEntity) -> void:
	if waiting.has(entity.entity_id):
		_attach_pose(waiting[entity.entity_id], entity.entity_id)
		waiting.erase(entity.entity_id)


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

## `export_presets.cfg`

```ini
[preset.0]

name="summer.games"
platform="summer.games"
runnable=false
dedicated_server=false
custom_features="summer_client"
export_filter="all_resources"
include_filter=""
exclude_filter=""
export_path=""
encrypt_pck=false
encrypt_directory=false
script_export_mode=2

[preset.0.options]

platforms/ios=true
platforms/macos=true
platforms/windows=false

[preset.1]

name="Courtyard Authority"
platform="Linux"
runnable=false
dedicated_server=true
custom_features="summer_authority"
export_filter="all_resources"
include_filter=""
exclude_filter="client/*"
export_path=""
encrypt_pck=false
encrypt_directory=false
script_export_mode=2

[preset.1.options]

binary_format/architecture="x86_64"
```

## `network/composition.tres`

```ini
[gd_resource type="SummerNetworkComposition" load_steps=22 format=3]

[sub_resource type="SummerNetworkField" id="MotionPosition"]
field_name = &"position"
type = 9

[sub_resource type="SummerNetworkField" id="MotionYaw"]
field_name = &"yaw"
type = 2

[sub_resource type="SummerNetworkField" id="MotionEntity"]
field_name = &"entity"
type = 1

[sub_resource type="SummerNetworkSchema" id="MotionSchema"]
schema_id = &"courtyard.motion.v1"
state_fields = Array[SummerNetworkField]([SubResource("MotionEntity"), SubResource("MotionPosition"), SubResource("MotionYaw")])

[sub_resource type="SummerWorldAudience" id="Everyone"]
max_expansion = 8

[sub_resource type="SummerNetworkStateStream" id="Motion"]
stream_id = &"courtyard.motion"
writer_policy = 1
skip_writer_echo = true
state_schema = SubResource("MotionSchema")
audience_policy = SubResource("Everyone")
max_audience_count = 8
max_keys = 8
max_state_bytes = 1024
max_total_bytes = 8192

[sub_resource type="SummerNetworkField" id="CommandBytes"]
field_name = &"b"
type = 20

[sub_resource type="SummerNetworkSchema" id="CommandSchema"]
schema_id = &"courtyard.cmd.v1"
state_fields = Array[SummerNetworkField]([SubResource("CommandBytes")])

[sub_resource type="SummerNetworkField" id="ResultBytes"]
field_name = &"b"
type = 20

[sub_resource type="SummerNetworkSchema" id="ResultSchema"]
schema_id = &"courtyard.cmd.result.v1"
state_fields = Array[SummerNetworkField]([SubResource("ResultBytes")])

[sub_resource type="SummerNetworkOccurrenceStream" id="Commands"]
stream_id = &"courtyard.cmd"
command_scope = 2
command_tick_dispatch = true
command_timeout_msec = 8000
payload_schema = SubResource("CommandSchema")
result_schema = SubResource("ResultSchema")

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

[resource]
network_version = "1.0.0"
state_streams = Array[SummerNetworkStateStream]([SubResource("Motion"), SubResource("Match"), SubResource("Mine")])
occurrence_streams = Array[SummerNetworkOccurrenceStream]([SubResource("Commands"), SubResource("Fx")])
```

## `network/game.gd`

```gdscript
extends RefCounted
## Shared by the client and the authority: ids, streams and shared rules.

const GAME_ID := "game_courtyard"
const QUEUE := &"courtyard"
const MOTION := &"courtyard.motion"
const CMD := &"courtyard.cmd"
const MATCH := &"courtyard.match"   # one document every player sees
const MINE := &"courtyard.mine"     # one private document per player
const FX := &"courtyard.fx"         # one-off effects, never stored
const MAX_PLAYERS := 8
const COMPOSITION := preload("res://network/composition.tres")

## The authority's sanity bound on movement, in metres per second. Keep it
## above the fastest legitimate speed (walking, jumping, falling).
const MAX_SPEED := 15.0
const ARENA_RADIUS := 40.0


## Adds the World, an Entities root and the Spawner under `parent`. Both sides
## pass their own player archetype; the composition is the same file.
static func build_network(parent: Node, player: SummerEntityArchetype) -> SummerNetworkSpawner:
	var world := SummerNetworkWorld.new()
	world.name = "World"
	parent.add_child(world)
	var entities := Node3D.new()
	entities.name = "Entities"
	parent.add_child(entities)
	var spawner := SummerNetworkSpawner.new()
	spawner.name = "Spawner"
	spawner.network_world_path = NodePath("../World")
	spawner.entities_root_path = NodePath("../Entities")
	spawner.archetypes = [player]
	spawner.player_archetype = &"player"   # one entity per joined player
	spawner.network_composition = COMPOSITION
	parent.add_child(spawner)
	return spawner


## Pose groups are keyed by seat, so a stream needs at most MAX_PLAYERS keys.
static func motion_key(seat: int) -> StringName:
	return StringName("p%d" % seat)


## Seats spawn on a circle. `entity` ties the pose to the player's entity.
static func spawn_pose(seat: int, entity_id: int) -> Dictionary:
	var angle := TAU * float(seat) / MAX_PLAYERS
	return {"entity": entity_id, "position": Vector3(cos(angle) * 4.0, 1.0, sin(angle) * 4.0), "yaw": 0.0}


static func in_bounds(position: Vector3) -> bool:
	return position.is_finite() and Vector2(position.x, position.z).length() <= ARENA_RADIUS \
		and position.y > -10.0 and position.y < 30.0


## Commands and results travel as JSON bytes: a network String holds at most
## 256 bytes.
static func pack(document: Dictionary) -> Dictionary:
	return {"b": JSON.stringify(document).to_utf8_buffer()}


static func unpack(fields: Dictionary) -> Dictionary:
	var parsed: Variant = JSON.parse_string((fields.get("b", PackedByteArray()) as PackedByteArray).get_string_from_utf8())
	return parsed if parsed is Dictionary else {}
```
