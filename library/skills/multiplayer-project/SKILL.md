---
name: multiplayer-project
description: "Set up a Summer multiplayer project: both entry scenes, World and queue files, joining, and a first Local Play run."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: multiplayer-and-networking
user-invocable: true
allowed-tools: Read Grep Glob Edit Write summer_read_file summer_write_file summer_get_scene_tree summer_get_script_errors summer_project_setting summer_play summer_stop summer_get_diagnostics
paths: ["project.godot", "summer.build.json", "world.json", "source-domains.json", "runtime-manifest.json", "network/**", "client/**", "authority/**"]
---

# /multiplayer-project — the files every Summer multiplayer game needs

Step 1 of the multiplayer sequence (`multiplayer` explains the model). By the
end, Local Play starts a headless authority and two clients. Each client joins
through the game's own `Summer.client.join`, and every client sees one player
per joined player.

The example game is **Courtyard**. The later skills (`multiplayer-movement`,
`multiplayer-state`) continue it, so keep its names until the user's own game
replaces them. Every file below was run as shown with Local Play;
[files.md](files.md) has all of them complete, scenes included.

## 1. Ask, then state the plan

> 1. What is the game called? Its id is `game_<name>`: lowercase letters, digits, `_`, `.` or `-`.
> 2. How many players per match? Summer measures up to 16.
> 3. Which platforms: iOS, macOS, Windows?

State the plan before writing anything:

> I'll add Summer multiplayer: a client scene and a headless authority scene,
> a World and a queue for 2–8 players, a network composition, and Local Play
> to test it. Each folder holds one side: `client/`, `authority/`,
> `network/` (shared). OK?

For an existing single-player game, get this skeleton running first, then
move its gameplay under `client/`.

## 2. The layout

```text
project.godot            shared
summer.build.json        the Build: game id, queues, Worlds, server preset
world.json               the WorldDefinition: which scenes run where
runtime-manifest.json    the server component's runtime descriptor
source-domains.json      which folders are client, server or shared
network/                 shared by both sides: composition, schemas, game.gd
client/                  what players run: main scene, player scenes, UI
authority/               what the server runs: main scene, rules
```

Client code and shared code must never load a file from `authority/`. The
summer.games export leaves `authority/` out of the players' pack. The
authority may load shared files.

## 3. project.godot

Add to the project's `project.godot`:

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

The `.summer_client` and `.summer_authority` overrides tell each exported pack
which scene to start. Leave the `[summer] version` line the editor writes.

## 4. The declarations

`summer.build.json`: the game id, the queue players join, and the World it
starts. Summer rejects unknown fields, so copy the shape exactly.

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

- `queues[].minPlayers` / `maxPlayers` bound a match. `worldDefinition` names
  the `definition_id` in `world.json`.
- `server.exportPreset` names the server export preset (`multiplayer-publish`).
- `runtime.interfaces`, `config`, `presence` and `lobby` are required. Copy
  them as shown.

`world.json`: what one World is. Keep every field; Local Play accepts less,
but publishing needs all of them.

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

`runtime-manifest.json` describes the server component:

```json
{
  "profile": "headless_engine",
  "entry_point": "authority/main.tscn",
  "export_preset": "Courtyard Authority"
}
```

`source-domains.json` marks the folders. The export uses it to keep server
code off players' devices:

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

## 5. The network composition

Both sides load the same composition. It declares every stream the game
sends, and client and authority refuse each other when theirs differ. Start
with one Command stream; later skills add more. `network/composition.tres`:

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

- A Command's payload and result travel as JSON in a byte field (`type = 20`,
  `TYPE_PACKED_BYTE_ARRAY`): a network `String` holds at most 256 bytes.
- `command_scope = 2` is `COMMAND_SCOPE_WORLD`.
- `command_tick_dispatch = true` makes the authority handle a Command after
  the tick's player poses are installed, so its checks use current positions.

The player entity's schema is empty, because players move through State
groups (`multiplayer-movement`). `network/player_schema.tres`:

```ini
[gd_resource type="SummerNetworkSchema" format=3]

[resource]
schema_id = &"courtyard.player.v1"
```

## 6. Shared code

`network/game.gd` holds every id and builds the network nodes the same way
on both sides:

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

Each side passes its own **player archetype**: the scenes the Spawner spawns
for every joined player. The authority gets a model with no visuals. Clients
get an owner scene for their own player and an observer scene for everyone
else. Splitting them keeps client scenes out of the server and server scenes
out of the client.

## 7. The authority

The authority's player archetype, `authority/player_archetype.tres`, names
only an `authority_model_scene`: `authority/player_model.tscn`, a bare
`Node3D`. Both are in [files.md](files.md).

`authority/main.gd` initializes Summer, waits for its World, and answers the
`join` Command:

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

`authority/main.tscn` is a plain `Node` with that script ([files.md](files.md)).

- **Never** read who sent a Command from its payload: `request.get_session()`
  is verified. Don't name your own classes `SummerSession`, `SummerWorld` or
  other engine class names.
- `session_disconnected` means the player's connection dropped and their seat
  is held. `session_left` means they are gone for good. Free their things in
  `session_left` only. Under Local Play it arrives when the World ends.

## 8. The client

The client's player archetype, `client/player_archetype.tres`, names an
`owner_projection_scene` and an `observer_projection_scene`:

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

`client/player_owner.tscn` is a `CharacterBody3D` with a capsule and the
camera. `client/player_observer.tscn` is a `Node3D` with a capsule and no
collision. Both are in [files.md](files.md).

`client/main.gd` joins the queue, waits until the network is ready, then
tells the authority it has arrived:

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

`client/main.tscn` holds the level (a floor and a light) and that script
([files.md](files.md)).

- Connect `state_group_created` and `entity_spawned` **before** joining, or
  values that arrive during the join go unseen.
- `Summer.client.join` succeeding means the player has a seat. Send Commands
  only after `spawner.network_ready`.
- Hosted, matchmaking may ask the player to accept a match. This skeleton
  accepts it right away; `summer-matchmaking` shows a real prompt.

## 9. Run it with Local Play

Import once so new scripts register, then start two players.

With the Summer MCP tools:

```
summer_project_setting key="summer/local_play/players" value=2
summer_play
summer_get_diagnostics
summer_stop
```

In the editor, **Debug > Local Multiplayer** sets the same player count; then
press Play. From a terminal (`<summer>` is the Summer editor executable):

```sh
<summer> --headless --path . --import
<summer> --path . --summer-local-play 2 --summer-local-play-headless --summer-local-play-timeout 15
```

Read the processes' output. Each line is prefixed with `[authority]`,
`[player-1]` or `[player-2]`:

- [ ] `[authority] COURTYARD_AUTHORITY_READY`
- [ ] `[authority] COURTYARD_PLAYER_SPAWNED` twice and `COURTYARD_PLAYER_JOINED` twice
- [ ] `COURTYARD_CLIENT_JOINED` from each player
- [ ] No `SCRIPT ERROR`, and no `[SummerNetworkSpawner] cannot attach` warning
- [ ] The last line, `SUMMER_LOCAL_PLAY_RESULT {...}`, has `"ok":true` and `"script_errors":0` for every process

`cannot attach` means the composition is invalid, and nothing networked will
work. Local Play still reports every client as joined, so look for the
warning yourself.

## Common mistakes

| Don't | Do | Why |
|---|---|---|
| `@rpc`, `MultiplayerSynchronizer`, `ENetMultiplayerPeer` | The Spawner, State groups and Commands | Unverified peers, no late join, no Summer hosting |
| `if multiplayer.is_server()` in one shared scene | Separate `client/` and `authority/` scenes | The engine starts the right scene on each side |
| Load an `authority/` file from client or shared code | Move what both sides need into `network/` | The export leaves `authority/` out of the players' pack |
| Build the composition differently on each side | One `network/composition.tres`, loaded by both | Different compositions refuse each other |
| Send a Command right after `join` succeeds | Await `spawner.network_ready` first | The authority does not know the client's network until then |
| Free a player's things on `session_disconnected` | Free them on `session_left` | A disconnected player keeps their seat and may reconnect |
| Trust "every client joined" alone | Also check for `cannot attach` and your own ready lines | A broken composition still joins |

## Next

`multiplayer-movement`: each player moves their own character, and everyone
else sees it move smoothly.
