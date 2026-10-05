---
name: setup-multiplayer
description: "Add multiplayer with Summer's netcode: a predicted SummerNetworkBehavior per player, a Spawner and Local Play tests. No Godot RPCs or MultiplayerSynchronizer."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: multiplayer-and-networking
user-invocable: true
allowed-tools: Read Grep Edit Write summer_get_scene_tree summer_inspect_node summer_add_node summer_set_prop summer_save_scene summer_get_script_errors summer_project_setting summer_play summer_stop summer_get_diagnostics summer_get_console
paths: ["**/*.gd", "**/*.tscn", "**/*.tres", "project.godot", "summer.build.json", "world.json"]
---

# /setup-multiplayer — Summer's authoritative netcode, not hand-rolled RPCs

## Overview

Summer Engine ships its own multiplayer runtime. A headless **authority**
simulates the game. Each player's own character is **predicted** locally and
corrected from authority snapshots, with corrections smoothed out. Everyone
else's characters are **interpolated** from snapshots. The engine owns
spawning, timing, input delivery, ordering, reconciliation, lag compensation
and hosting.

You write **one role-free domain script** per networked thing, plus visuals.

**Core rule:** in a Summer game, never build gameplay networking from Godot's
high-level `MultiplayerAPI`. That means no `@rpc`, no `MultiplayerSpawner`, no
`MultiplayerSynchronizer`, and no `multiplayer.get_unique_id()` or
`is_server()` branches. Hand-rolled RPC sync has no prediction or
reconciliation and no tick-ordered input. Agents' games built that way
rubberband, and they cannot be hosted on Summer.

## Steps

### 1. Ask three questions, then decide

> 1. What is multiplayer for: co-op, versus, or a shared world?
> 2. How many players per match? Summer's measured envelope is up to 16 per match.
> 3. Which things move continuously under a player's control (characters, vehicles), and which change in discrete steps (health, score, pickups, rounds)?

The answers map onto three engine primitives:

| What it is | Engine primitive | Skill |
|---|---|---|
| Continuously controlled motion (a player's character) | `SummerNetworkBehavior` entity per player: input → shared simulation → State | this skill |
| Discrete game state and events (health, score, hits, inventory) | State streams, Commands and Events on the same World | `skill/host-authoritative-state` |
| Lag-compensated shots (hitscan) | Historical ray Commands with `SummerNetworkHitHistory3D` | this skill, step 8 |

The authority is always the headless server. There is no peer-to-peer or
host-migration mode; a host's own "client" is just another client (see
`skill/peer-to-peer-multiplayer`).

State the plan before writing files:

> Adding multiplayer with Summer's netcode: a `player` entity per connected
> player. It has one domain script (input → simulation → position) and is
> predicted on its owner and interpolated for others. There is a headless
> authority scene, a `casual` queue for 2–4 players, and Local Play for
> testing. No RPCs. OK?

### 2. Read the existing player

```
summer_get_scene_tree
summer_inspect_node "./World/Player"
```

Separate the player's **simulation** (how input changes position, velocity
and facing) from its **presentation** (meshes, animation, camera, sound). The
simulation moves into the domain script. Presentation stays in the projection
scenes. The authority scene gets no visuals.

### 3. Initialize Summer at the real entry point

Every process (client and authority) initializes once:

```gdscript
const GAME_ID := "your-game-id"

func _ready() -> void:
	var initialized: SummerResult = await Summer.initialize(GAME_ID).get_result_or_completed_signal()
	if not initialized.ok:
		push_error(initialized.message)
		return
```

### 4. Write the player component

Put it under `res://components/multiplayer/player/`. This is the engine's
reference shape (stdlib `authoritative_mover_2d`), shown here in 3D.

`player_domain.gd`: one script, used unchanged by the authority, the owner's
prediction and observers. The engine calls `_summer_collect_input` only on the
owner, `_summer_simulate` on authority and owner, and `_summer_present` on
clients. **No role branches.**

```gdscript
extends SummerNetworkBehavior

const SPEED := 5.0


func _summer_initial_state(_entity: SummerNetworkEntity) -> Dictionary:
	return {"position": Vector3(0, 1, 0)}


func _summer_collect_input(_entity: SummerNetworkEntity, _tick: int) -> Dictionary:
	return {"move": Input.get_vector(&"ui_left", &"ui_right", &"ui_up", &"ui_down")}


func _summer_neutral_input(_entity: SummerNetworkEntity, _tick: int) -> Dictionary:
	return {"move": Vector2.ZERO}


# Runs on the owner before prediction and again on the authority at the trust
# boundary. Keep it deterministic and idempotent; clamp everything a client
# could exaggerate.
func _summer_normalize_input(_entity: SummerNetworkEntity, _tick: int, input: Dictionary) -> Dictionary:
	var move: Vector2 = input.move
	return {"move": move.limit_length(1.0)}


# Pure fixed-step transition: same input and state give the same result
# everywhere. Read only `input`, `state` and `delta`.
func _summer_simulate(_entity: SummerNetworkEntity, _tick: int, delta: float, input: Dictionary, state: Dictionary) -> Dictionary:
	var move: Vector2 = input.move
	var at: Vector3 = state.position
	return {"position": at + Vector3(move.x, 0, move.y) * SPEED * delta}


# Required by the contract on clients. Projections present through their
# presenter Resource instead, so this direct path stays a no-op.
func _summer_present(_entity: SummerNetworkEntity, _previous_state: Dictionary, _current_state: Dictionary, _alpha: float) -> void:
	pass
```

`player_presenter.gd` is a client-only presenter Resource that moves the
spawned root to the presented State:

```gdscript
extends SummerNetworkStatePresenterV1


func _summer_present(entity: SummerNetworkEntity, current: Dictionary, _alpha: float) -> void:
	var root := entity.root as Node3D
	if root != null:
		root.position = current.position
```

There are three scenes, each with the same domain script:

- **`authority_model.tscn`:** root `SummerNetworkBehavior` with `player_domain.gd`. No meshes, cameras, audio, input nodes or presenter.
- **`owner_projection.tscn`:** root `Node3D` with the visible mesh, the local camera, and a child `Domain` (`SummerNetworkBehavior` with `player_domain.gd`).
- **`observer_projection.tscn`:** the same as the owner scene without the camera.

On both projections' `Domain` node, set two Resources:

- `interpolator`: a `SummerNetworkMotionInterpolator` with `fields = PackedStringArray("position")`;
- `presenter`: `player_presenter.gd`.

Snapshots then interpolate smoothly, and owner corrections blend out over
`correction_smoothing_msec` (100 ms) instead of snapping. The interpolator
**requires** the presenter. With an interpolator alone, the entity fails with
`stock motion interpolation requires a presenter Resource` and the client is
disconnected. Keep the presenter out of the authority scene and the domain
script, because dedicated authority builds don't have presenter classes.

The owner projection, in full:

```
[gd_scene load_steps=6 format=3]

[ext_resource type="Script" path="res://components/multiplayer/player/player_domain.gd" id="1_domain"]
[ext_resource type="Script" path="res://components/multiplayer/player/player_presenter.gd" id="2_presenter"]

[sub_resource type="CapsuleMesh" id="CapsuleMesh_body"]

[sub_resource type="SummerNetworkMotionInterpolator" id="SummerNetworkMotionInterpolator_position"]
fields = PackedStringArray("position")

[sub_resource type="SummerNetworkStatePresenterV1" id="SummerNetworkStatePresenterV1_player"]
script = ExtResource("2_presenter")

[node name="OwnerProjection" type="Node3D"]

[node name="Body" type="MeshInstance3D" parent="."]
mesh = SubResource("CapsuleMesh_body")

[node name="Camera3D" type="Camera3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 0.8, 0.6, 0, -0.6, 0.8, 0, 6, 8)
current = true

[node name="Domain" type="SummerNetworkBehavior" parent="."]
script = ExtResource("1_domain")
interpolator = SubResource("SummerNetworkMotionInterpolator_position")
presenter = SubResource("SummerNetworkStatePresenterV1_player")
```

`player_archetype.tres` declares the exact wire contract:

```
[gd_resource type="SummerEntityArchetype" load_steps=7 format=3]

[ext_resource type="PackedScene" path="res://components/multiplayer/player/authority_model.tscn" id="1_authority"]
[ext_resource type="PackedScene" path="res://components/multiplayer/player/owner_projection.tscn" id="2_owner"]
[ext_resource type="PackedScene" path="res://components/multiplayer/player/observer_projection.tscn" id="3_observer"]

[sub_resource type="SummerNetworkField" id="SummerNetworkField_move"]
field_name = &"move"
type = 5
description = "Movement direction, length at most one."

[sub_resource type="SummerNetworkField" id="SummerNetworkField_position"]
field_name = &"position"
type = 9
description = "Authoritative world position."

[sub_resource type="SummerNetworkSchema" id="SummerNetworkSchema_player"]
schema_id = &"your_game.player"
schema_version = "1.0.0"
input_fields = Array[SummerNetworkField]([SubResource("SummerNetworkField_move")])
state_fields = Array[SummerNetworkField]([SubResource("SummerNetworkField_position")])

[resource]
archetype_id = &"player"
network_schema = SubResource("SummerNetworkSchema_player")
authority_model_scene = ExtResource("1_authority")
owner_projection_scene = ExtResource("2_owner")
observer_projection_scene = ExtResource("3_observer")
```

Field `type` values are `SummerNetworkField.TYPE_*`:

| Type | Value |
|---|---|
| BOOL | 0 |
| INT | 1 |
| FLOAT | 2 |
| VECTOR2 | 5 |
| VECTOR3 | 9 |
| QUATERNION | 15 |

Check the class reference before using any other type. Input and State
Dictionaries are **exact**: every declared field, no extras, no implicit
conversions. Add the field to the schema before returning it, and bump
`schema_version` when simulation meaning changes.

### 5. Wire the network scene

Build `res://network/network_root.tscn`, which both the client entry scene and
the authority scene instance:

- `SummerNetworkWorld`
- `Entities` (empty `Node3D`) for spawned players
- `SummerNetworkSpawner`, with:
  - `network_world_path` → the World;
  - `entities_root_path` → `Entities`;
  - `archetypes` = `[player_archetype.tres]`;
  - `player_archetype` = `player`.

An empty `simulation_config` means a 60 Hz tick, 20 Hz snapshots and 100 ms
interpolation. The Spawner spawns and despawns one player entity per joined
player. **Never spawn players yourself.**

The authority scene, `res://authority/main.tscn`, holds the network root and
this script:

```gdscript
extends Node

const GAME_ID := "your-game-id"

func _ready() -> void:
	var initialized: SummerResult = await Summer.initialize(GAME_ID).get_result_or_completed_signal()
	if not initialized.ok:
		push_error(initialized.message)
		return
	var world: SummerNetworkWorld = $NetworkRoot/SummerNetworkWorld
	if not world.is_ready():
		await world.binding_ready
```

The client entry scene initializes (step 3), then joins a queue:

```gdscript
	var join := Summer.client.join(SummerJoinTarget.queue(&"casual"))
	# Hosted matchmaking proposes a match; every proposal needs a decision.
	join.acceptance_required.connect(func(proposal: SummerMatchmakingProposal) -> void: proposal.accept())
	var joined: SummerResult = await join.get_result_or_completed_signal()
	if not joined.ok:
		push_error(joined.message)
```

The same code runs locally and hosted. There is no local-only branch.

### 6. Declare the World and queue

`summer.build.json` at the project root:

```json
{
  "schema": "summer.build.v2",
  "runtime": {
    "worldDefinitions": ["world.json"],
    "queues": [{"name": "casual", "worldDefinition": "main-world", "minPlayers": 2, "maxPlayers": 4}]
  }
}
```

`world.json`:

```json
{
  "schema": "summer.world-definition.v1",
  "definition_id": "main-world",
  "lifetime": "match_scoped",
  "topology": "dedicated",
  "client_entry_point": "res://main.tscn",
  "components": [
    {"component_id": "match", "profile": "headless_engine", "entry_point": "authority/main.tscn", "owns": ["match"]}
  ]
}
```

### 7. Test with Local Play, over a bad network

Local Play starts the headless authority and N clients from the editor, and
each joins through the game's own `Summer.client.join`. No account or tools
are needed.

```
summer_project_setting name="summer/local_play/players" value=2
summer_project_setting name="summer/local_play/network/round_trip_msec" value=100
summer_project_setting name="summer/local_play/network/jitter_msec" value=10
summer_project_setting name="summer/local_play/network/loss_percent" value=1
summer_play
summer_get_diagnostics
summer_stop
```

Loopback hides latency, so always test once with the network settings above.
That is where rubberbanding would show. A players value of `-1` uses the
queue's `minPlayers`; `0` turns Local Play off. Without an editor, the
terminal smoke test is `<engine> --path . --summer-local-play --summer-local-play-smoke`.
It exits 0 once every client has joined and stayed joined, and its last line is
`SUMMER_LOCAL_PLAY_RESULT {...}`.

Checklist:

- [ ] Every client logs a successful join; diagnostics show no script errors on any process.
- [ ] Each client controls its own player; other players move smoothly.
- [ ] At 100 ms round trip with jitter and loss, your own player responds immediately and never snaps back while moving steadily. `get_prediction_status().get_correction_count()` on the owner's `Domain` may tick up when input starts or stops under loss, and smoothing hides those; it must stay flat during steady movement.
- [ ] Each client shows the other players where their owners show them.
- [ ] Removing a client despawns its player everywhere.

### 8. Shots and hits (if the game has them)

Don't raycast on the client or trust client hit reports. Use the engine's
history:

- Give the player archetype a `SummerNetworkHitbox3D` on its `position` field.
- Assign a `SummerNetworkHitHistory3D` to the Spawner's `hit_history`, with
  `max_view_age_msec = 250`. That reaches players up to about 170 ms round
  trip; 200 ms stops near 120 ms.
- Set `retention_msec = 350` too, for at least 100 ms of history beyond the
  view age. Released engines still default to 250: a shot near the view-age
  cap then has no time to wait behind queued input and fails as
  `historical_history_unavailable`. An explicit value works on every engine.
- Keep `interpolation_delay_msec` at 100. Lowering it makes presentation hold,
  so views get older and more shots go stale.
- Declare an entity-scoped `fire` Command stream, as for any Command (see
  `skill/host-authoritative-state`).

Fire from inside `_summer_collect_input`, so the shot rides in order with that
tick's movement:

```gdscript
if Input.is_action_just_pressed(&"fire"):
	var admission := enqueue_ray_command(&"fire", {"weapon": 1}, aim_direction, 100.0)
	if not admission.is_enqueued():
		push_warning("shot not admitted")
```

The authority rewinds every hitbox to what the shooter saw and resolves the
Command; the shooter supplies only aim and range. On newer engines, a startup
warning `HIT_HISTORY_DISPATCH_BUDGET` means the retention is too tight for the
view age.

## Common mistakes

| Don't | Do | Why |
|---|---|---|
| `@rpc`, `MultiplayerSynchronizer`, `MultiplayerSpawner` | `SummerNetworkBehavior` + `SummerNetworkSpawner` | No prediction or ordered input means rubberbanding, and it can't be hosted |
| `if multiplayer.is_server()` or peer-ID branches | One role-free domain script | The engine picks the role per scene; branches diverge prediction from authority |
| Moving the player in `_physics_process` | Return new State from `_summer_simulate` | Only simulated State is predicted, reconciled and replicated |
| Reading nodes, time or randomness in `_summer_simulate` | Read only `input`, `state`, `delta` | Owner and authority must compute the same result |
| Extra or missing Dictionary keys | Exactly the schema's fields | Undeclared fields fail closed |
| `type = 6` for a Vector3 field | `type = 9` (`TYPE_VECTOR3`) | 6 is `TYPE_VECTOR2I`, and the schema rejects every Vector3 |
| Visuals in the authority scene | Visuals only in projection scenes | The authority runs headless |
| An `interpolator` without a `presenter` | Both, on the projections' `Domain` node | The motion interpolator requires a presenter, or the client is disconnected |
| Camera in the observer scene | Camera only in `owner_projection.tscn` | Each client sees through its own player |
| Testing only on loopback | Local Play with `round_trip_msec`, `jitter_msec`, `loss_percent` | Loopback hides every latency bug |
| Spawning players by hand on join | The Spawner's `player_archetype` | One entity per player, with owner and observer projections chosen for you |
| Client-side raycasts for hits | `enqueue_ray_command` in `_summer_collect_input` | The authority rewinds to the shooter's view; clients can't fake hits |

## Collaborative protocol

This rewires the project. State the plan (step 1), then group the writes:
"I'm about to add the player component (domain + presenter + archetype + 3
scenes), the network root, the authority scene, and `summer.build.json` +
`world.json`. OK?"

## See also

- `skill/host-authoritative-state` — health, score, inventory and match events on the same World
- `skill/peer-to-peer-multiplayer` — why Summer games use an authority instead
