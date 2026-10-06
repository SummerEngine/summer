# multiplayer-movement: complete files after this step

Every file below ran as shown under Local Play. Compare against your project, or copy a file whole.

## `authority/main.gd`

```gdscript
extends Node
## The match server. It runs headless and owns every rule.

const Game = preload("res://network/game.gd")
const PlayerArchetype = preload("res://authority/player_archetype.tres")
## How far a player may move in one burst after a network stall, in metres.
const BURST := Game.MAX_SPEED * 0.5

var spawner: SummerNetworkSpawner
var world: SummerNetworkWorld
var seat_of := {}       # session_id -> seat, held until the Session leaves
var allowance := {}     # seat -> metres the player may still move
var refilled_at := {}   # seat -> msec of the last allowance refill


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
	match str(command.get("c", "")):
		"join":
			_join(request)
		_:
			request.refuse(&"unknown_command")


## A client sends "join" once its network is ready.
func _join(request: SummerNetworkCommandRequest) -> void:
	var seat := _seat(request.get_session())
	if seat < 0:
		request.refuse(&"match_full")
		return
	request.accept({}, Game.pack({"seat": seat}))
	print("COURTYARD_PLAYER_JOINED seat=%d" % seat)


## The Session ended for good: free the seat. (Its pose group already ended
## with the player's entity.)
func _on_session_left(session: SummerSession, reason: String) -> void:
	var seat: int = seat_of.get(session.session_id, -1)
	seat_of.erase(session.session_id)
	print("COURTYARD_PLAYER_LEFT seat=%d reason=%s" % [seat, reason])
```

## `client/main.gd`

```gdscript
extends Node
## What each player runs: joins the match and shows every player.

const Game = preload("res://network/game.gd")
const PlayerArchetype = preload("res://client/player_archetype.tres")

var spawner: SummerNetworkSpawner
var waiting := {}     # entity id -> pose group that arrived before its entity


func _ready() -> void:
	spawner = Game.build_network(self, PlayerArchetype)
	# Connect before joining, or the first values arrive unseen.
	spawner.state_group_created.connect(_on_group_created)
	spawner.entity_spawned.connect(_on_entity_spawned)
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
	if group.get_stream_id() == Game.MOTION:
		_attach_pose(group, int(group.get_state().entity))


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
```

## `client/player_observer.gd`

```gdscript
extends Node3D
## Someone else's player. It glides between the poses its owner published,
## drawn VIEW_DELAY in the past so there is always a newer pose to glide to.

const VIEW_DELAY := 0.1

var group: SummerNetworkStateGroup
var _samples: Array = []    # [time, position, yaw] per received pose
var _offsets: Array = []    # recent arrival minus authority acceptance, seconds


func bind(motion: SummerNetworkStateGroup) -> void:
	group = motion
	group.state_installed.connect(_on_installed)
	_on_installed(group.get_state(), group.get_revision(), true)


func _on_installed(state: Dictionary, _revision: int, reset: bool) -> void:
	if state.is_empty():
		return
	var now := Time.get_ticks_usec() / 1000000.0
	if reset:
		_samples.clear()   # a spawn or teleport is a cut, not a slide
		global_position = state.position
		rotation.y = state.yaw
	_samples.append([_pose_time(now), state.position, state.yaw])
	if _samples.size() > 20:
		_samples.pop_front()


func _process(_delta: float) -> void:
	if _samples.is_empty():
		return
	var at := Time.get_ticks_usec() / 1000000.0 - VIEW_DELAY
	var newest: Array = _samples[-1]
	if at >= newest[0] or _samples.size() == 1:
		global_position = newest[1]
		rotation.y = newest[2]
		return
	for i in range(_samples.size() - 1, 0, -1):
		var a: Array = _samples[i - 1]
		var b: Array = _samples[i]
		if at >= a[0]:
			var t := clampf((at - a[0]) / maxf(b[0] - a[0], 0.0001), 0.0, 1.0)
			global_position = (a[1] as Vector3).lerp(b[1], t)
			rotation.y = lerp_angle(a[2], b[2], t)
			return
	global_position = _samples[0][1]


## Places a pose on the local timeline by when the authority accepted it, so
## poses that arrive bunched together still play back evenly.
func _pose_time(now: float) -> float:
	var timing := group.get_timing()
	if timing == null or timing.state_authority_usec < 0:
		return now
	var accepted := timing.state_authority_usec / 1000000.0
	_offsets.append(now - accepted)
	if _offsets.size() > 40:
		_offsets.pop_front()
	return minf(accepted + float(_offsets.min()), now)
```

## `client/player_observer.tscn`

```ini
[gd_scene load_steps=3 format=3]

[ext_resource type="Script" path="res://client/player_observer.gd" id="1"]

[sub_resource type="CapsuleMesh" id="Mesh"]

[node name="PlayerObserver" type="Node3D"]
script = ExtResource("1")

[node name="Body" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0)
mesh = SubResource("Mesh")
```

## `client/player_owner.gd`

```gdscript
extends CharacterBody3D
## Your own player. You move it locally and publish where it is; the
## authority only snaps you somewhere on spawn, teleport or a refused pose.

const WALK_SPEED := 6.0
const JUMP_VELOCITY := 5.0
const SEND_INTERVAL := 1.0 / 20.0

var group: SummerNetworkStateGroup
var _pose := {}          # the full pose; only position and yaw change
var _sent := {}
var _send_elapsed := 0.0


func bind(motion: SummerNetworkStateGroup) -> void:
	group = motion
	group.state_installed.connect(_on_installed)
	_on_installed(group.get_state(), group.get_revision(), true)


func _on_installed(state: Dictionary, _revision: int, reset: bool) -> void:
	# Accepted poses are not echoed back to you (skip_writer_echo). A reset is
	# the authority moving you: spawn, teleport, or a pose it refused.
	if not reset or state.is_empty():
		return
	_pose = state.duplicate()
	_sent = state.duplicate()
	global_position = state.position
	rotation.y = state.yaw
	velocity = Vector3.ZERO


func _physics_process(delta: float) -> void:
	if group == null or not group.active:
		return
	if not is_on_floor():
		velocity += get_gravity() * delta
	if Input.is_action_just_pressed(&"ui_accept") and is_on_floor():
		velocity.y = JUMP_VELOCITY
	var input := Input.get_vector(&"ui_left", &"ui_right", &"ui_up", &"ui_down")
	velocity.x = input.x * WALK_SPEED
	velocity.z = input.y * WALK_SPEED
	if input != Vector2.ZERO:
		rotation.y = atan2(-input.x, -input.y)
	move_and_slide()
	_publish(delta)


## Publishes the pose 20 times a second, and only when it changed.
func _publish(delta: float) -> void:
	_send_elapsed += delta
	if _send_elapsed < SEND_INTERVAL:
		return
	_send_elapsed = 0.0
	_pose.position = global_position
	_pose.yaw = rotation.y
	if _pose == _sent:
		return
	group.submit(_pose)
	_sent = _pose.duplicate()
```

## `client/player_owner.tscn`

```ini
[gd_scene load_steps=5 format=3]

[ext_resource type="Script" path="res://client/player_owner.gd" id="1"]

[sub_resource type="CapsuleShape3D" id="Shape"]

[sub_resource type="CapsuleMesh" id="Mesh"]

[node name="PlayerOwner" type="CharacterBody3D"]
script = ExtResource("1")

[node name="Shape" type="CollisionShape3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0)
shape = SubResource("Shape")

[node name="Body" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0)
mesh = SubResource("Mesh")

[node name="Camera3D" type="Camera3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 0.8, 0.6, 0, -0.6, 0.8, 0, 6, 8)
current = true
```

## `network/composition.tres`

```ini
[gd_resource type="SummerNetworkComposition" load_steps=12 format=3]

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

[resource]
network_version = "1.0.0"
state_streams = Array[SummerNetworkStateStream]([SubResource("Motion")])
occurrence_streams = Array[SummerNetworkOccurrenceStream]([SubResource("Commands")])
```

## `network/game.gd`

```gdscript
extends RefCounted
## Shared by the client and the authority: ids, streams and shared rules.

const GAME_ID := "game_courtyard"
const QUEUE := &"courtyard"
const MOTION := &"courtyard.motion"
const CMD := &"courtyard.cmd"
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
