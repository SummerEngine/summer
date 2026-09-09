---
name: setup-multiplayer
description: "Use when the user wants to add multiplayer to an existing Summer game: co-op LAN, co-op online, competitive PvP, or a lobby. Start with Summer Engine's high-level MultiplayerAPI plus MultiplayerSpawner and MultiplayerSynchronizer; use custom networking only with a justified reason. Walks peer authority, RPC patterns, replication, and irreversible architecture decisions. It does not claim that managed matchmaking or hosting is live. Trigger on \"multiplayer\", \"co-op\", \"PvP\", \"online\", \"netcode\", \"rollback\", \"MultiplayerAPI\", \"host migration\", \"matchmaking\"."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: multiplayer-and-networking
user-invocable: true
allowed-tools: Read Grep Edit Write summer_get_scene_tree summer_inspect_node summer_add_node summer_set_prop summer_connect_signal summer_save_scene summer_get_script_errors summer_project_setting summer_play summer_stop
paths: ["**/*.gd", "**/*.tscn", "**/*.tres", "project.godot"]
---

# /setup-multiplayer — Add Multiplayer Without Repainting the Project

## Overview

Multiplayer is a one-way door. Pick the wrong authority model and refactoring
later is brutal. Start with **Summer Engine's high-level MultiplayerAPI +
MultiplayerSpawner + MultiplayerSynchronizer + ENet**. Do not roll custom
networking without a measured reason.

**Core principle:** the architecture decision (peer authority vs server authority) is harder than the code. Lock it before touching a single RPC.

## Steps

### 1. Ask the four blocking questions

Before any code:

> 1. What kind of multiplayer? co-op LAN / co-op online / competitive PvP / lobbies + matchmaking
> 2. How many players? 2 / 2–4 / 8+
> 3. Who runs the simulation? host (one of the players) / dedicated server / authoritative peer-to-peer
> 4. What's the network you're targeting? same Wi-Fi / public internet with ~80ms RTT / mobile

Wait. Each answer flips an irreversible knob.

### 2. Pick the authority model — irreversible decision

**Lock it now.** Refactoring authority is a project-killer.

| Model | Best for | Pros | Cons |
|---|---|---|---|
| **Host authority** (one player runs the sim) | Co-op (2–4 players), casual PvP, friends-only | Cheapest. No server bill. Host migration possible. | Host advantage (no lag for them). Cheating possible. |
| **Dedicated server authority** | Competitive PvP, matchmaking, > 4 players | Fair. Anti-cheat possible. Stable. | Server bill. Need a deploy story. Higher complexity. |
| **Peer-to-peer with shared authority** | Lock-step strategy / RTS, fighting games (rollback) | Symmetric latency. No "host advantage". | Determinism is a project on its own. Hard to debug. |

**Default recommendation:** host authority for co-op (2–4 players), dedicated server for everything else. If user says "competitive PvP" + "lobbies": dedicated.

State the choice explicitly:

> Going with **host authority** for 2–4 player co-op. The first player to start a game is the host. Their scene tree is the source of truth; clients receive replicated state and send input RPCs. Host migration is hard with this model — if the host quits, the game ends. Confirm?

### 3. Pick the transport

Almost always: **ENetMultiplayerPeer**. It is UDP with reliability layers and
ships with Summer Engine. Validate the actual game topology and player count;
this is local netcode, not managed hosting or matchmaking.

When to switch:
- **WebSocketMultiplayerPeer**: if you need the game to run in the browser (HTML5 export). ENet doesn't work in browsers.
- **WebRTCMultiplayerPeer**: if you need browser AND P2P (no central server). Higher complexity.
- **Custom transport**: never, unless you've shipped multiplayer before.

### 4. Pick what to replicate — the replication graph

Replicate the *minimum*. Every replicated field is bandwidth + bug surface.

For a typical co-op shooter:

| Object | Replicated state | Replication frequency | Authority |
|---|---|---|---|
| Player position / rotation | x, y, z, yaw | 20 Hz | Owner peer |
| Player health | int | On change | Server/host |
| Player input intent | move_dir, jump, fire | 30 Hz | Owner peer (sends to host) |
| Enemy state | position, hp, FSM state | 10 Hz | Host only |
| World items (pickups) | spawn / despawn events | On change | Host only |
| UI / menus | nothing | nothing | Local only |
| Particles, decorative VFX | nothing | nothing | Local only (each peer plays its own) |

**Don't replicate:**
- Local UI state.
- Cosmetic-only VFX (each peer simulates locally).
- Camera / view position (each peer has their own camera).
- Audio (use 3D audio with replicated positions, not replicate the AudioStreamPlayer).

### 5. Read the scene to find what changes

```
summer_get_scene_tree
summer_inspect_node "./World/Player"
```

Note: the existing single-player Player needs to become a per-peer Player. The path is to spawn one Player per connected peer.

### 6. Propose the change set

> I'm about to:
> - Add a `Network` autoload (`scripts/network.gd`) that owns peer setup + spawn lifecycle.
> - Convert `./World/Player` from a static scene node into a `MultiplayerSpawner`-managed instance, spawned per peer on join.
> - Add a `MultiplayerSynchronizer` to the player scene replicating `position`, `rotation.y`, `health`.
> - Convert player input from local → input intent RPC sent to the authority.
> - Add a basic host/join UI on the main menu.
>
> Authority model: host. Transport: ENet. Tick: 30 Hz input, 20 Hz position. Confirm before I touch anything?

### 7. Build it

#### a) Network autoload

`scripts/network.gd`:

```gdscript
class_name Network
extends Node

const PORT := 7000
const MAX_PLAYERS := 4

signal player_joined(peer_id: int)
signal player_left(peer_id: int)

@export var player_scene: PackedScene

var _peer: MultiplayerPeer

func host_game() -> Error:
    var enet := ENetMultiplayerPeer.new()
    var err := enet.create_server(PORT, MAX_PLAYERS - 1)
    if err != OK:
        return err
    _peer = enet
    multiplayer.multiplayer_peer = _peer
    multiplayer.peer_connected.connect(_on_peer_connected)
    multiplayer.peer_disconnected.connect(_on_peer_disconnected)
    # Host spawns its own player at id=1 (server id)
    _spawn_player(1)
    return OK

func join_game(address: String) -> Error:
    var enet := ENetMultiplayerPeer.new()
    var err := enet.create_client(address, PORT)
    if err != OK:
        return err
    _peer = enet
    multiplayer.multiplayer_peer = _peer
    return OK

func _on_peer_connected(peer_id: int) -> void:
    # Only the host spawns players. Clients receive via MultiplayerSpawner.
    if multiplayer.is_server():
        _spawn_player(peer_id)
    player_joined.emit(peer_id)

func _on_peer_disconnected(peer_id: int) -> void:
    var node_name := str(peer_id)
    var players := get_tree().get_first_node_in_group("players_root")
    if players != null and players.has_node(node_name):
        players.get_node(node_name).queue_free()
    player_left.emit(peer_id)

func _spawn_player(peer_id: int) -> void:
    var player: Node = player_scene.instantiate()
    player.name = str(peer_id)        # name = peer id; sync by name
    player.set_multiplayer_authority(peer_id)
    var players_root := get_tree().get_first_node_in_group("players_root")
    players_root.add_child(player, true)
```

Register as autoload in `project.godot`:

```
summer_project_setting(key="autoload/Network", value="*res://scripts/network.gd")
```

#### b) Player scene with MultiplayerSynchronizer

In the player scene, add:

```
Player (CharacterBody3D)
├── CollisionShape3D
├── Camera3D                         # local-only, attach in script if peer is local
├── MeshInstance3D
└── MultiplayerSynchronizer
```

```
summer_add_node(scenePath="res://scenes/player.tscn", parent="./World/Players/Player", type="MultiplayerSynchronizer", name="Sync")
```

`scenePath` is required on `summer_add_node`, `summer_set_prop`,
`summer_connect_signal` and `summer_save_scene`; it names the exact `res://`
scene to mutate and does not default to the open tab.

Configure the synchronizer to replicate `position`, `rotation.y`, `health`. A standalone `SceneReplicationConfig.tres` is worth it here because the same config is shared by every player instance — not because embedded sub_resources fail (they don't):

```gdscript
# scripts/player_net.gd
extends CharacterBody3D

@export var move_speed: float = 5.0
@export var max_health: int = 100

@onready var camera: Camera3D = $Camera3D
@onready var sync: MultiplayerSynchronizer = $Sync

var health: int = 100

func _ready() -> void:
    health = max_health
    var auth := get_multiplayer_authority()
    var is_local := auth == multiplayer.get_unique_id()
    camera.current = is_local
    set_physics_process(is_local)        # only the owner runs movement
    set_process_input(is_local)

func _physics_process(delta: float) -> void:
    var input_dir := Input.get_vector("move_left", "move_right", "move_forward", "move_back")
    var direction := (transform.basis * Vector3(input_dir.x, 0, input_dir.y)).normalized()
    if direction:
        velocity.x = direction.x * move_speed
        velocity.z = direction.z * move_speed
    else:
        velocity.x = move_toward(velocity.x, 0, move_speed)
        velocity.z = move_toward(velocity.z, 0, move_speed)
    if not is_on_floor():
        velocity.y -= 9.8 * delta
    move_and_slide()
    # position is replicated automatically via MultiplayerSynchronizer

@rpc("any_peer", "call_local", "reliable")
func take_damage(amount: int) -> void:
    if not multiplayer.is_server():
        return                                          # only host applies damage
    health = max(0, health - amount)
    if health == 0:
        rpc("on_died")

@rpc("authority", "call_local", "reliable")
func on_died() -> void:
    queue_free()
```

#### c) RPC patterns — the four flavors

Lock the conventions:

| RPC config | Use case |
|---|---|
| `@rpc("authority", "call_local", "reliable")` | Host tells everyone something happened (health change result, death) |
| `@rpc("any_peer", "call_remote", "unreliable")` | Frequent input intent (movement, look) — drop is OK |
| `@rpc("any_peer", "call_remote", "reliable")` | Rare input event (fire weapon, pick up item) — drop NOT OK |
| `@rpc("any_peer", "call_local", "reliable")` | Player asks host to do something (request damage) |

**Authority validation is mandatory.** Inside any `any_peer` RPC, check `multiplayer.get_remote_sender_id()` and validate the sender owns the action.

```gdscript
@rpc("any_peer", "call_local", "reliable")
func request_fire() -> void:
    var sender := multiplayer.get_remote_sender_id()
    if sender != get_multiplayer_authority():
        return                       # someone else is trying to control this player; drop
    # ... actually fire
```

#### d) Lag compensation outline

Defer to a specialist skill, but flag the basics:

- For projectiles: spawn locally on owner's machine at fire time, replicate the spawn event with a timestamp. Other peers fast-forward the projectile by their RTT.
- For hit detection: server-authoritative + simple latency tolerance (host accepts hits within ~100ms past server time).
- For movement: client-side prediction plus server reconciliation is the
  standard model. Summer Engine does not provide this game-specific layer; you
  write it. Competitive PvP requires specialist lag-compensation work.

### 8. Save and verify

```
summer_save_scene(scenePath="res://scenes/player.tscn")
summer_get_script_errors(path="res://scripts/player_net.gd")   # one file per call; path required
summer_play
# user tests by running two instances locally (Debug → Customize Run Instances → 2)
summer_stop
```

Test checklist:
- [ ] Two instances connect (one hosts, one joins).
- [ ] Each instance sees its own player as local (camera attached, can move).
- [ ] Each instance sees the other player move smoothly (sync at 20 Hz).
- [ ] Damage RPC routes through host (not double-applied on each peer).
- [ ] Disconnect cleans up the disconnected player's node.

## Common mistakes

| Don't | Do | Why |
|---|---|---|
| Decide authority model halfway through | Lock it in step 2 before touching code | Refactoring authority is a project-killer |
| Replicate every property | Replicate position, rotation, health, that's it | Bandwidth + bug surface |
| Run physics on every peer for every player | Physics on owner only, others receive transform | Otherwise jitter and divergence |
| Trust the client | Validate `get_remote_sender_id()` in every `any_peer` RPC | Cheaters route through the wrong RPC |
| Copy-pasting a `SceneReplicationConfig` per player scene | One standalone `.tres`, referenced everywhere | Replication config must match on every peer; duplicated copies drift |
| Roll custom transport | ENet (or WebSocket for browser) | You will hit edge cases ENet already solved |
| Skip authority check in damage RPC | `if not multiplayer.is_server(): return` at the top of damage handlers | Otherwise damage applied N times |
| Spawn players on every peer | MultiplayerSpawner — host spawns, clients receive | Otherwise N copies of each player |
| `@rpc("any_peer")` everything | Use `authority` for server→clients, `any_peer` only for client→server | Mismatched flow = exploits |
| Camera replicated | Camera is local-only, set `current = is_local` on spawn | Each peer needs their own camera |

## Anti-patterns

- **"Let's also have rollback netcode for our co-op shooter."** Rollback is a 6-month project on its own. Use it for fighting games and lock-step RTS, not co-op.
- **NAT punchthrough on day one.** Use Steam Networking or a relay; don't write punchthrough yourself for v1.
- **Dedicated servers without a deploy story.** If you can't redeploy in < 5 min, the dedicated path isn't ready.
- **Custom serialization.** Summer Engine's variant serialization is fine. Do
  not write your own packing until you measure bandwidth.
- **Host migration in v1.** It's a feature, not a primitive. Ship without it; add later if churn data demands.

## Collaborative protocol

This skill rewires the project at the architectural level. Always ask before each block of changes. Group writes — "I'm about to add the autoload + 2 scenes + 3 scripts + InputMap entries. OK?".

## Want a working starter?

For a known-good multiplayer scaffold (host + join UI, ENet transport, MultiplayerSpawner, replicated player), point users at:

→ **template-id**: none ships today. Run `summer list templates` for the live list rather than naming one from memory.

For now: this skill produces the scaffold inline. When the template lands, link from here.

## See also

- `multiplayer-and-networking/multiplayerapi-basics/SKILL.md` — deeper MultiplayerAPI patterns
- `multiplayer-and-networking/client-server-pattern/SKILL.md` — dedicated server architecture
- `multiplayer-and-networking/peer-replication/SKILL.md` — synchronizer config patterns
- `multiplayer-and-networking/enet-vs-websocket/SKILL.md` — transport choice
- `multiplayer-and-networking/lag-compensation/SKILL.md` — deeper netcode for competitive (when shipped)
- `multiplayer-and-networking/state-sync/SKILL.md` — selective replication patterns
- `multiplayer-and-networking/lobby-and-matchmaking/SKILL.md` — lobby UI + Steam matchmaking
