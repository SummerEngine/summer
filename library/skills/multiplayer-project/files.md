# multiplayer-project: complete files

Every file below ran as shown under Local Play. Compare against your project, or copy a file whole.

## `authority/main.gd`

```gdscript
extends Node
## The match server. It runs headless and owns every rule.

const Game = preload("res://network/game.gd")
const PlayerArchetype = preload("res://authority/player_archetype.tres")

var spawner: SummerNetworkSpawner
var world: SummerNetworkWorld
var seat_of := {}       # session_id -> seat, held until the Session leaves


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
## network is ready (and again after a reconnect).
func _on_player_spawned(entity: SummerNetworkEntity) -> void:
	print("COURTYARD_PLAYER_SPAWNED seat=%d entity=%d" % [_seat(entity.session), entity.entity_id])


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


## The Session ended for good: free the seat and everything the player had.
func _on_session_left(session: SummerSession, reason: String) -> void:
	var seat: int = seat_of.get(session.session_id, -1)
	seat_of.erase(session.session_id)
	print("COURTYARD_PLAYER_LEFT seat=%d reason=%s" % [seat, reason])
```

## `authority/main.tscn`

```ini
[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://authority/main.gd" id="1"]

[node name="Authority" type="Node"]
script = ExtResource("1")
```

## `authority/player_archetype.tres`

```ini
[gd_resource type="SummerEntityArchetype" load_steps=3 format=3]

[ext_resource type="SummerNetworkSchema" path="res://network/player_schema.tres" id="1"]
[ext_resource type="PackedScene" path="res://authority/player_model.tscn" id="2"]

[resource]
archetype_id = &"player"
network_schema = ExtResource("1")
authority_model_scene = ExtResource("2")
```

## `authority/player_model.tscn`

```ini
[gd_scene format=3]

[node name="PlayerModel" type="Node3D"]
```

## `client/main.gd`

```gdscript
extends Node
## What each player runs: joins the match and shows every player.

const Game = preload("res://network/game.gd")
const PlayerArchetype = preload("res://client/player_archetype.tres")

var spawner: SummerNetworkSpawner


func _ready() -> void:
	spawner = Game.build_network(self, PlayerArchetype)
	# Connect signals like state_group_created here, before joining, or values
	# that arrive during the join go unseen (multiplayer-movement adds them).
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
```

## `client/main.tscn`

```ini
[gd_scene load_steps=5 format=3]

[ext_resource type="Script" path="res://client/main.gd" id="1"]

[sub_resource type="BoxShape3D" id="FloorShape"]
size = Vector3(80, 1, 80)

[sub_resource type="BoxMesh" id="FloorMesh"]
size = Vector3(80, 1, 80)

[node name="Main" type="Node"]
script = ExtResource("1")

[node name="Floor" type="StaticBody3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, -0.5, 0)

[node name="Shape" type="CollisionShape3D" parent="Floor"]
shape = SubResource("FloorShape")

[node name="Mesh" type="MeshInstance3D" parent="Floor"]
mesh = SubResource("FloorMesh")

[node name="Sun" type="DirectionalLight3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 0.5, 0.866, 0, -0.866, 0.5, 0, 10, 0)
```

## `client/player_archetype.tres`

```ini
[gd_resource type="SummerEntityArchetype" load_steps=4 format=3]

[ext_resource type="SummerNetworkSchema" path="res://network/player_schema.tres" id="1"]
[ext_resource type="PackedScene" path="res://client/player_owner.tscn" id="2"]
[ext_resource type="PackedScene" path="res://client/player_observer.tscn" id="3"]

[resource]
archetype_id = &"player"
network_schema = ExtResource("1")
owner_projection_scene = ExtResource("2")
observer_projection_scene = ExtResource("3")
```

## `client/player_observer.tscn`

```ini
[gd_scene load_steps=2 format=3]

[sub_resource type="CapsuleMesh" id="Mesh"]

[node name="PlayerObserver" type="Node3D"]

[node name="Body" type="MeshInstance3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0)
mesh = SubResource("Mesh")
```

## `client/player_owner.tscn`

```ini
[gd_scene load_steps=3 format=3]

[sub_resource type="CapsuleShape3D" id="Shape"]

[sub_resource type="CapsuleMesh" id="Mesh"]

[node name="PlayerOwner" type="CharacterBody3D"]

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
[gd_resource type="SummerNetworkComposition" load_steps=6 format=3]

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
occurrence_streams = Array[SummerNetworkOccurrenceStream]([SubResource("Commands")])
```

## `network/game.gd`

```gdscript
extends RefCounted
## Shared by the client and the authority: ids, streams and shared rules.

const GAME_ID := "game_courtyard"
const QUEUE := &"courtyard"
const CMD := &"courtyard.cmd"
const MAX_PLAYERS := 8
const COMPOSITION := preload("res://network/composition.tres")


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


## Commands and results travel as JSON bytes: a network String holds at most
## 256 bytes.
static func pack(document: Dictionary) -> Dictionary:
	return {"b": JSON.stringify(document).to_utf8_buffer()}


static func unpack(fields: Dictionary) -> Dictionary:
	var parsed: Variant = JSON.parse_string((fields.get("b", PackedByteArray()) as PackedByteArray).get_string_from_utf8())
	return parsed if parsed is Dictionary else {}
```

## `network/player_schema.tres`

```ini
[gd_resource type="SummerNetworkSchema" format=3]

[resource]
schema_id = &"courtyard.player.v1"
```

## `project.godot`

```ini
config_version=5

[application]

config/name="Courtyard"
run/main_scene="res://client/main.tscn"
run/main_scene.summer_client="res://client/main.tscn"
run/main_scene.summer_authority="res://authority/main.tscn"

[rendering]

textures/vram_compression/import_etc2_astc=true
```

## `runtime-manifest.json`

```json
{
  "profile": "headless_engine",
  "entry_point": "authority/main.tscn",
  "export_preset": "Courtyard Authority"
}
```

## `source-domains.json`

```json
{
  "schema": "summer.source-domain-graph.v1",
  "roots": [
    { "domain": "shared", "paths": ["project.godot", "network", "world.json", "runtime-manifest.json"] },
    { "domain": "client", "paths": ["client"] },
    { "domain": "authority_engine", "paths": ["authority"] }
  ],
  "dependencies": []
}
```

## `summer.build.json`

```json
{
  "schema": "summer.build.v2",
  "gameId": "game_courtyard",
  "executionMode": "hosted",
  "targetPlatforms": ["ios", "macos"],
  "project": { "directory": "." },
  "server": { "exportPreset": "Courtyard Authority" },
  "runtime": {
    "protocolVersion": "1.0.0",
    "interfaces": {
      "multiplayer": 6, "session": 3, "lobby": 3, "presence": 3,
      "config": 3, "party": 1, "matchSearch": 1
    },
    "scenes": ["res://client/main.tscn"],
    "worldDefinitions": ["world.json"],
    "queues": [
      {
        "name": "courtyard",
        "minPlayers": 2,
        "maxPlayers": 8,
        "worldDefinition": "courtyard",
        "policy": "fifo",
        "transport": "enet"
      }
    ],
    "tickRate": 60,
    "config": { "keys": {} },
    "presence": { "tokens": {} },
    "lobby": { "fields": {} },
    "server": { "tier": "small" }
  }
}
```

## `world.json`

```json
{
  "schema": "summer.world-definition.v1",
  "definition_id": "courtyard",
  "lifetime": "match_scoped",
  "topology": "dedicated",
  "client_entry_point": "res://client/main.tscn",
  "components": [
    {
      "component_id": "match",
      "profile": "headless_engine",
      "runtime_descriptor": "runtime-manifest.json",
      "entry_point": "authority/main.tscn",
      "owns": ["match"]
    }
  ],
  "source_graph": "source-domains.json",
  "network_compositions": ["res://network/composition.tres"],
  "services": { "required": [], "optional": [] },
  "settlement": { "mode": "required", "version": 1 },
  "persistence": {
    "mode": "none",
    "recovery_point_seconds": 0,
    "snapshot_schemas": [],
    "migration_ids": []
  },
  "lifecycle": {
    "reconnect_seconds": 30,
    "drain_seconds": 5,
    "transfer": "disabled",
    "completion_owner": "world"
  },
  "placement": { "region_policy": "nearest" },
  "limits_profile": "default"
}
```
