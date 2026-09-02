---
name: peer-to-peer-multiplayer
description: Use when starting a multiplayer Summer game from scratch with peer-to-peer host authority. Build the network architecture top-down so authoritative state, routing rules, and real-time rendering are not bolted on later. Use before writing game logic, not after. Trigger on "multiplayer", "peer-to-peer", "p2p", "co-op", "host", "multiplayer architecture", "add multiplayer".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: multiplayer-and-networking
user-invocable: true
allowed-tools: Read Grep Glob summer_get_scene_tree summer_inspect_node summer_create_scene summer_add_node summer_set_prop summer_connect_signal summer_save_scene summer_get_script_errors summer_project_setting
paths: ["**/*.gd", "**/*.tscn", "**/project.godot"]
---

# /peer-to-peer-multiplayer — Build a P2P Game From the Ground Up

## Overview

**Multiplayer is architecture, not a feature.** Bolting it onto a single-player game is 5× harder than starting multiplayer-first. This skill walks the four layers in order. Skip any of them and you'll spend the rest of development paying for it in cheat-vulnerable state, desync bugs, and "why is the other player teleporting" reports.

The four layers, top-down:

1. **NetworkManager** — the autoload that owns peer IDs, connection lifecycle, message routing.
2. **Authoritative state** — the decision matrix for *which fields the host owns vs. which the client renders*.
3. **Three routing patterns** — host→client, client→host, client→client. Each has different rules.
4. **Real-time rendering** — prediction + interpolation so the local player feels responsive while remote state catches up.

Build them in that order. Don't write a single piece of game logic until layers 1 + 2 exist.

## Step 0 — Should it be P2P at all?

Ask the user before anything else:

> Are players connecting through Steam friends / Epic friends / a private invite link, or do they need matchmaking at scale (1000s of concurrent matches)?

| Answer | Architecture |
|---|---|
| Friend-invite / small lobby (≤8 players) | **P2P with host authority.** This skill. |
| Matchmaking + anti-cheat + scale | **Dedicated client-server.** Different skill (`/host-authoritative-state`). |
| MMO / persistent world | **Custom server.** Out of scope for this skill. |

If P2P is right, continue. Otherwise, stop and route to the right skill.

## Layer 1 — NetworkManager

A single autoload that owns the network. Nothing else in the game touches `MultiplayerAPI` directly.

May I create `autoloads/network_manager.gd` and register it as a Summer Engine autoload?

```gdscript
class_name NetworkManager
extends Node

# ── Signals (all game systems listen here, not to MultiplayerAPI directly) ──
signal connection_succeeded
signal connection_failed(reason: String)
signal peer_joined(peer_id: int)
signal peer_left(peer_id: int)
signal session_ended

const DEFAULT_PORT := 7777
const MAX_PEERS := 8

var is_host: bool = false
var local_peer_id: int = 0
var peers: Dictionary = {}  # peer_id -> { name, ready, ... }

func host(port: int = DEFAULT_PORT) -> Error:
    var peer := ENetMultiplayerPeer.new()
    var err := peer.create_server(port, MAX_PEERS)
    if err != OK:
        connection_failed.emit("create_server failed: %s" % error_string(err))
        return err
    multiplayer.multiplayer_peer = peer
    is_host = true
    local_peer_id = 1
    _wire_signals()
    connection_succeeded.emit()
    return OK

func join(address: String, port: int = DEFAULT_PORT) -> Error:
    var peer := ENetMultiplayerPeer.new()
    var err := peer.create_client(address, port)
    if err != OK:
        connection_failed.emit("create_client failed: %s" % error_string(err))
        return err
    multiplayer.multiplayer_peer = peer
    is_host = false
    _wire_signals()
    return OK

func leave() -> void:
    if multiplayer.multiplayer_peer:
        multiplayer.multiplayer_peer.close()
        multiplayer.multiplayer_peer = null
    is_host = false
    local_peer_id = 0
    peers.clear()
    session_ended.emit()

func _wire_signals() -> void:
    multiplayer.peer_connected.connect(_on_peer_connected)
    multiplayer.peer_disconnected.connect(_on_peer_disconnected)
    multiplayer.connected_to_server.connect(_on_connected_to_server)
    multiplayer.connection_failed.connect(_on_connection_failed)
    multiplayer.server_disconnected.connect(_on_server_disconnected)

func _on_peer_connected(id: int) -> void:
    peers[id] = { "name": "Player %d" % id, "ready": false }
    peer_joined.emit(id)

func _on_peer_disconnected(id: int) -> void:
    peers.erase(id)
    peer_left.emit(id)

func _on_connected_to_server() -> void:
    local_peer_id = multiplayer.get_unique_id()
    connection_succeeded.emit()

func _on_connection_failed() -> void:
    connection_failed.emit("connection refused or timed out")

func _on_server_disconnected() -> void:
    leave()
```

Register as autoload: `summer_project_setting(key="autoload/NetworkManager", value="*res://autoloads/network_manager.gd")`. The leading `*` makes it a singleton.

**Why this shape:** every system in the game listens to `NetworkManager.peer_joined` / `peer_left`, never to `multiplayer.peer_connected` directly. When you swap transports (ENet → WebRTC → Steam P2P) later, you change one file.

## Layer 2 — Authoritative State

For every piece of state in your game, answer one question: **if a malicious client lies about this, does it break the game?**

- **Yes** → host owns it. Clients send intent; host decides. Replicated to clients read-only.
- **No** (cosmetic / pure local feel) → client owns it. Replicated for visual sync only.

The canonical decision matrix:

| State | Owner | Reasoning |
|---|---|---|
| health, mana, stamina | **host** | damage logic must not be cheatable |
| score, kills, objectives | **host** | competitive integrity |
| inventory contents | **host** | items would dupe |
| ability cooldowns | **host** | spam-cast attack vector |
| current weapon equipped | **host** | tied to inventory |
| position (player) | **client-predicted, host-reconciled** | input latency feels awful otherwise |
| velocity | **client-predicted, host-reconciled** | same |
| look direction (camera yaw/pitch) | **client** | cosmetic, host doesn't need it |
| animation state | **client** | visual; can lead the truth |
| footstep sounds | **client** | host doesn't care |
| muzzle flash, particles | **client** | host doesn't care |
| chat messages | **host-relayed** | for moderation hooks |

Build a State Layer that codifies this. May I create `autoloads/game_state.gd`?

```gdscript
class_name GameState
extends Node

# Host-authoritative dictionaries. Keyed by peer_id where applicable.
var health: Dictionary = {}      # peer_id -> int
var score: Dictionary = {}       # peer_id -> int
var inventory: Dictionary = {}   # peer_id -> Array[ItemData]

# Local-only mirrors (read for rendering; never written by clients).
var local_health_view: int = 100

func _ready() -> void:
    NetworkManager.peer_joined.connect(_on_peer_joined)
    NetworkManager.peer_left.connect(_on_peer_left)

# ── Host-only mutators (called via RPC from client requests) ──
func _host_apply_damage(target: int, amount: int) -> void:
    if not NetworkManager.is_host: return
    var new_hp = max(0, health.get(target, 100) - amount)
    health[target] = new_hp
    _broadcast_health(target, new_hp)
    if new_hp == 0:
        _broadcast_death(target)

@rpc("authority", "call_remote", "reliable")
func _broadcast_health(peer: int, hp: int) -> void:
    if peer == NetworkManager.local_peer_id:
        local_health_view = hp

@rpc("authority", "call_remote", "reliable")
func _broadcast_death(peer: int) -> void:
    pass  # play death anim, etc.

# ── Client-side request (intent only — host decides) ──
func client_request_damage(target: int, amount: int) -> void:
    rpc_id(1, "_host_handle_damage_request", target, amount)

@rpc("any_peer", "call_remote", "reliable")
func _host_handle_damage_request(target: int, amount: int) -> void:
    if not NetworkManager.is_host: return
    var sender := multiplayer.get_remote_sender_id()
    # validate: did sender's hitbox actually overlap target this frame?
    # if validation passes, apply. otherwise, drop silently.
    if _validate_hit(sender, target):
        _host_apply_damage(target, amount)

func _validate_hit(_attacker: int, _target: int) -> bool:
    return true  # implement: distance check, line-of-sight, cooldown, etc.

func _on_peer_joined(id: int) -> void:
    if NetworkManager.is_host:
        health[id] = 100
        score[id] = 0
        inventory[id] = []
        _broadcast_health(id, 100)

func _on_peer_left(id: int) -> void:
    if NetworkManager.is_host:
        health.erase(id)
        score.erase(id)
        inventory.erase(id)
```

**Key invariants enforced by this shape:**
- Every host-authoritative field has a single mutator function on the host.
- Clients call `client_request_*` to request a change; the host validates and broadcasts.
- Clients never directly modify `health` / `score` / `inventory` even on their own peer.
- `@rpc("authority", ...)` ensures only the host can call broadcast functions.
- `@rpc("any_peer", ...)` allows any client to call request functions, but the function checks `NetworkManager.is_host` and validates the request.

## Layer 3 — The Three Routing Patterns

Every networked function fits one of three patterns. Pick the right one or you'll have bugs.

### Pattern A: Host → Client (state broadcast)

State the host owns, replicated read-only to clients.

```gdscript
@rpc("authority", "call_remote", "reliable")
func _broadcast_score(peer: int, value: int) -> void:
    score[peer] = value
```

**Rules:**
- `authority` mode = only host can call this (anyone else's call is ignored).
- `call_remote` = doesn't run on the caller (host doesn't need to call its own update).
- `reliable` = must arrive (state corruption otherwise).

### Pattern B: Client → Host (intent / request)

Client wants something to happen. Host decides yes or no.

```gdscript
@rpc("any_peer", "call_remote", "reliable")
func _host_handle_use_item_request(item_id: String) -> void:
    if not NetworkManager.is_host: return
    var sender := multiplayer.get_remote_sender_id()
    if _can_use(sender, item_id):
        _host_apply_use_item(sender, item_id)
```

**Rules:**
- `any_peer` = any client can call.
- First line is always `if not NetworkManager.is_host: return`. Defensive.
- Always validate (`_can_use`). Trusting client input is the #1 multiplayer cheat vector.
- Use `multiplayer.get_remote_sender_id()` — clients can't lie about who sent the request.

### Pattern C: Client → Client (cosmetic relay)

Visual-only events. Host relays but doesn't validate.

```gdscript
@rpc("any_peer", "call_remote", "unreliable")
func _peer_play_emote(emote_id: String) -> void:
    # everyone plays the emote on the sender's player
    var sender := multiplayer.get_remote_sender_id()
    _play_emote_visual(sender, emote_id)
```

**Rules:**
- `unreliable` is fine for cosmetic stuff (animations, particles, footstep SFX).
- No validation needed — worst case is a player's emote desyncs by a frame.
- Save bandwidth: keep payloads tiny.

**Anti-pattern:** mixing patterns in one function. A function that broadcasts state AND handles client intent is going to have bugs. Split.

## Layer 4 — Real-time Rendering

The local player needs to feel instant. Remote players need to look smooth despite network jitter. Two techniques:

### Client-side prediction (for the local player's input)

```gdscript
# Local player runs movement immediately on input. Host runs the SAME function
# authoritatively. If they diverge, the client snaps to host state.

func _physics_process(delta: float) -> void:
    if not _is_local_authority(): return
    var input := _read_input()
    velocity = _compute_velocity(input, velocity, delta)
    move_and_slide()
    if NetworkManager.local_peer_id != 1:  # not the host
        _send_input_to_host(input)

@rpc("any_peer", "call_remote", "unreliable_ordered")
func _send_input_to_host(_input: InputState) -> void:
    if not NetworkManager.is_host: return
    # host runs the SAME _compute_velocity to validate + reconcile
    pass
```

### Interpolation (for remote players' positions)

Don't snap remote players to incoming positions — interpolate.

```gdscript
var _network_position_buffer: Array[Vector3] = []
var _network_position_timestamps: Array[float] = []

func _physics_process(_delta: float) -> void:
    if _is_local_authority(): return  # local handled by prediction
    _interpolate_to_buffer()

@rpc("authority", "call_remote", "unreliable_ordered")
func _receive_remote_position(pos: Vector3, t: float) -> void:
    _network_position_buffer.append(pos)
    _network_position_timestamps.append(t)
    while _network_position_buffer.size() > 4:
        _network_position_buffer.pop_front()
        _network_position_timestamps.pop_front()

func _interpolate_to_buffer() -> void:
    if _network_position_buffer.size() < 2: return
    var render_time := Time.get_ticks_msec() / 1000.0 - 0.1  # 100ms interp delay
    # find the two buffer entries that bracket render_time, lerp between them
    # (full impl: ~30 lines)
    pass
```

## Common mistakes (anti-patterns)

| Mistake | What goes wrong | Fix |
|---|---|---|
| Putting health on the client and trusting it | Trivial cheats: edit memory, infinite HP. | Move all damage logic to host. Client requests, host decides. |
| Calling `multiplayer.peer_connected.connect()` directly in 5 different scripts | Connection logic scattered. Refactor pain. | Always go through `NetworkManager` signals. |
| `@rpc("any_peer")` with no `is_host` check inside | Client can broadcast as if host. State corruption. | First line of every `any_peer` handler is `if not is_host: return`. |
| Reliable RPC for cosmetic stuff (footsteps, particles) | Bandwidth blowup. | Use `unreliable` for cosmetic. Reserve `reliable` for state. |
| Sending position 60×/sec via reliable RPC | Network spam, dropped packets cause stutters. | `unreliable_ordered` at 20–30 Hz + interpolation buffer on receivers. |
| Adding multiplayer after the game's built | Single-player code assumed direct state writes everywhere. Massive refactor. | Use this skill BEFORE writing game logic. |
| Forgetting host-leaves handling | Host disconnects → game freezes. | `multiplayer.server_disconnected` → graceful end-session in `NetworkManager.leave()`. |

## When to NOT use this skill

- **Single-player game with leaderboards.** No multiplayer needed.
- **Async multiplayer** (turn-based via REST API). This skill assumes real-time.
- **Dedicated server with anti-cheat.** Use `/host-authoritative-state`.
- **Already-shipped game getting multiplayer retrofit.** Sorry — you're in for a refactor. This skill helps for the redesign but not the migration.

## Collaborative protocol

This skill writes multiple new files (`autoloads/network_manager.gd`, `autoloads/game_state.gd`, plus updates to `project.godot` for the autoload registration). Always ask before each phase:

> May I create the NetworkManager autoload?
> May I create the GameState autoload and register both in project.godot?
> May I add the prediction/interpolation logic to your existing player scene?

Don't apply all four layers in one shot — checkpoint after each layer so the user can verify before adding the next.

## Want a working starter?

No template ships with this exact architecture yet — it's deliberately built fresh for each project because the State Layer's authority decisions are game-specific (a stealth game's "visibility" and a shooter's "ammo count" both want host authority but for different reasons). Run this skill from scratch.

When the `template-co-op-3d` template ships in the registry, this skill will reference it as a starter — for now it's hand-rolled.

## See also

- [`host-authoritative-state`](../host-authoritative-state/SKILL.md) — deeper dive on JUST the state ownership decision matrix
- [`setup-multiplayer`](../setup-multiplayer/SKILL.md) — lighter intro that just gets a session running (use that one if the user just wants 2 players to see each other; use this one if they want to ship a real game)
