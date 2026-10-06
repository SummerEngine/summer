---
name: multiplayer-movement
description: "Client-side movement in Summer multiplayer: owners move instantly, others glide, the authority checks each pose."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: multiplayer-and-networking
user-invocable: true
allowed-tools: Read Grep Glob Edit Write summer_read_file summer_write_file summer_get_scene_tree summer_inspect_node summer_get_script_errors summer_project_setting summer_play summer_stop summer_get_diagnostics
paths: ["network/**", "client/**", "authority/**"]
---

# /multiplayer-movement — each player moves their own character

Step 2 of the multiplayer sequence. It continues the Courtyard game from
`multiplayer-project`; read that first if `network/game.gd` does not exist.
[files.md](files.md) has every file this step changes, complete, as it ran
under Local Play.

## How it works

Summer games use **client-side movement**:

- **The owner** runs the whole character controller locally: input, walking,
  gravity, jumping, collision. Its camera follows instantly, at any latency.
  About 20 times a second it **publishes its pose** (position, facing) to an
  owner-written State group.
- **The authority** runs no movement. It **checks every pose** with an
  acceptance policy: inside the level, no faster than the game allows, still
  the same player. A refused pose snaps the owner back to the last accepted
  one. The authority can also move a player on purpose (respawn, portal).
- **Everyone else** receives each accepted pose and draws it 100 ms in the
  past, gliding between poses, so remote players move smoothly through
  jitter and lost packets.

```text
 owner client                 authority                     other clients
 input → controller ──pose──► acceptance policy ──pose──► glide between poses
 camera follows instantly     refuses: owner snaps back    (100 ms behind)
```

Game rules on the authority (pickups, melee, triggers) read the latest
accepted pose (`multiplayer-state`).

The pose is bound to the player's **entity**, which the Spawner creates for
every joined player. The authority creates the pose group when that entity
spawns, which is after the player's network is ready and again after a
reconnect. The group ends with the entity.

## 1. Declare the pose stream

Add a `Motion` State stream to `network/composition.tres`, before the
Command stream's sub-resources:

```ini
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
```

and list it in the `[resource]`:

```ini
[resource]
network_version = "1.0.0"
state_streams = Array[SummerNetworkStateStream]([SubResource("Motion")])
occurrence_streams = Array[SummerNetworkOccurrenceStream]([SubResource("Commands")])
```

Update `load_steps` in the first line to the number of sub-resources plus
one. [files.md](files.md) has the complete file.

| Setting | Why |
|---|---|
| `writer_policy = 1` | `WRITER_OWNER`: a Session writes it, not the authority |
| `skip_writer_echo = true` | The owner is not sent its own accepted poses, only refusals and the authority's moves |
| `audience_policy` World, `max_expansion = 8`, `max_audience_count = 8` | Everyone sees every pose. Set both to at least the player count: 0 reaches nobody |
| `max_keys = 8` | One key per seat |
| `max_state_bytes = 1024` | Room for the encoded pose. Too tight and every submission fails as `invalid_state` |
| fields `entity` (`1`, INT), `position` (`9`, VECTOR3), `yaw` (`2`, FLOAT) | Exactly what others need to draw the player |

Field `type` values are `SummerNetworkField.TYPE_*`: BOOL 0, INT 1, FLOAT 2,
STRING 3, VECTOR2 5, VECTOR3 9, QUATERNION 15, COLOR 19, PACKED_BYTE_ARRAY
20. A pose Dictionary must have **exactly** the declared fields with exactly
those types: no extras, no missing keys, no ints for floats. To send more
(an animation state, a carried item), add a field to the schema and to every
pose.

## 2. Shared rules

`network/game.gd` gains the stream id, the speed limit and the level
bounds, after `const QUEUE`:

```gdscript
const MOTION := &"courtyard.motion"
```

```gdscript
## The authority's sanity bound on movement, in metres per second. Keep it
## above the fastest legitimate speed (walking, jumping, falling).
const MAX_SPEED := 15.0
const ARENA_RADIUS := 40.0
```

and the seat key, the spawn pose and the bounds check, after
`build_network`:

```gdscript
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
```

`MAX_SPEED` must stay above the fastest legitimate speed, falling included.
The authority enforces it; the client never reads it.

## 3. The authority checks every pose

`authority/main.gd`:

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

- `create_state_group(stream, key, initial, writer_session, entity)` makes
  that Session the only writer, and ties the group's life to the entity.
- `set_acceptance_policy` runs synchronously on each pose. Return `true` to
  accept it unchanged and `false` to refuse it. It cannot edit a pose; to
  move a player, call `reset()` as `teleport()` does.
- The distance allowance refills at `MAX_SPEED` and holds at most half a
  second of movement. Poses bunched together after a lag spike pass;
  teleports and speed hacks don't. A flat per-pose distance check would
  refuse honest players after every hiccup and still let a cheat move fast in
  small steps.
- A **seat** is the player's place in the World until `session_left`. Pose
  groups are keyed by seat, so a stream needs at most `MAX_PLAYERS` keys.

## 4. The client: own player and everyone else

`client/main.gd` pairs each pose group with its entity. Either can arrive
first. Add a `waiting` dictionary:

```gdscript
var waiting := {}     # entity id -> pose group that arrived before its entity
```

connect both signals in `_ready()` before joining:

```gdscript
	# Connect before joining, or the first values arrive unseen.
	spawner.state_group_created.connect(_on_group_created)
	spawner.entity_spawned.connect(_on_entity_spawned)
```

and add the handlers at the end:

```gdscript
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

The client archetype from `multiplayer-project` already gives each player an
owner scene and an observer scene. Give them scripts.

`client/player_owner.gd`, your own player:

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

Attach it to `client/player_owner.tscn` (`script = ExtResource(...)` on the
root, as in [files.md](files.md)).

`client/player_observer.gd`, everyone else:

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

Attach it to `client/player_observer.tscn` the same way.

- The owner ignores ordinary installs: with `skip_writer_echo` it is not sent
  its own accepted poses. A `reset` install is the authority moving it:
  spawn, `teleport()`, or a refused pose.
- The owner publishes only changed poses, 20 times a second. The engine
  keeps only the newest pending pose per player, so a faster rate adds
  traffic, not smoothness.
- The observer orders poses by when the authority accepted them
  (`get_timing().state_authority_usec`), so a burst of late packets still
  plays back evenly. A `reset` is a cut, not a slide.
- Observer scenes have no collision. Other players are drawings on your
  screen; their owners decide where they are.

## 5. Test it under latency

Run Local Play with 2 players at 100 ms round trip, 10 ms jitter and 1 %
loss (`multiplayer-testing` shows how):

- [ ] Your own player responds instantly and never snaps back while moving normally.
- [ ] The other window's copy of your player moves smoothly and stops exactly where you stopped.
- [ ] Jumping and falling look the same on both screens.
- [ ] No `SCRIPT ERROR`, no `cannot attach`, and every process has `"script_errors":0`.

To check the anti-cheat, move the owner by 30 m in one frame from a test
script. The authority refuses the pose, the owner snaps back, and the other
client never sees the jump.

## Common mistakes

| Don't | Do | Why |
|---|---|---|
| Move other players' characters locally | Draw others from their published poses | Each player's client is the only source of their position |
| Create the pose group on `session_joined` | Create it in `entity_spawned` | At `session_joined` the player's network is not ready yet, and creation fails |
| Trust poses unchecked | An acceptance policy with a refilling distance allowance | Otherwise any client can teleport |
| A flat "max distance per pose" check | An allowance refilled at `MAX_SPEED` | Bunched poses after lag get refused, and cheats still move fast |
| Snap observers to each pose as it arrives | Glide 100 ms behind, ordered by acceptance time | Poses arrive unevenly; snapping looks like stutter |
| Add a key to the pose Dictionary without the schema | Add the field to the schema too | Undeclared or missing fields fail the submission |
| `max_state_bytes = 256` | 1024 or more | The bound covers the encoded pose; too tight fails as `invalid_state` |
| Collide with observer bodies | Leave observer scenes without collision | Another player's body is only a drawing on your screen |

## Next

`multiplayer-state`: scores, doors, private inventories, and actions the
authority checks against these poses.
