---
name: host-authoritative-state
description: "Use when designing the state layer of a multiplayer Summer game: deciding what the host owns, how clients request changes, and how the host validates and broadcasts. Pairs with `/peer-to-peer-multiplayer`. Trigger on \"host authority\", \"authoritative state\", \"state ownership\", \"MP cheating\", \"client validation\", \"RPC patterns\"."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: multiplayer-and-networking
user-invocable: true
allowed-tools: Read Grep summer_get_scene_tree summer_inspect_node summer_save_scene summer_get_script_errors
---

# /host-authoritative-state — Designing the State Layer

## Overview

This is **Layer 2** of multiplayer architecture. `/peer-to-peer-multiplayer` covers all four layers; this skill zooms in on the one that produces 90% of shipping-quality MP bugs. For every piece of state in your game, decide: **does the host own it, or does the client own it?** Get this wrong and you ship a cheat-vulnerable, desync-prone game where players "teleport," items dupe, and hit-detection lies. Get it right and the rest of multiplayer falls into place.

## The fundamental question

For every state field, ask one question:

> **If a malicious client lies about this, does it break the game?**

| Answer | Owner | Notes |
|---|---|---|
| Yes | **Host-authoritative.** | Clients send intent (RPC request); host validates and broadcasts. |
| No | **Client-owned.** | Cosmetic. Replicated for visual sync only. |
| Sometimes | **Host-authoritative with client prediction.** | Position is the canonical example: client predicts to feel responsive; host reconciles to prevent teleport-cheats. |

This question is the entire decision tree. Apply it to every field, no exceptions.

## The decision matrix

The canonical state-ownership table for a typical 3D action game. Use this as your starting point and extend per game.

| State field | Owner | Why | What an attacker could do if you got it wrong |
|---|---|---|---|
| `health` | host | core combat integrity | edit memory → infinite HP, ignore damage |
| `mana` / `stamina` | host | gates ability/sprint use | infinite-cast spam, infinite-sprint |
| `score` / `kills` / `objectives` | host | competitive integrity | self-award kills, fake leaderboard |
| `inventory` contents | host | items must not dupe | broadcast "I picked it up" twice → duped item |
| `currency` (gold, gems) | host | trade exploits | mint currency on the client |
| `ability_cooldowns` | host | gates damage rate | spam-cast every frame |
| `current_weapon` equipped | host | tied to inventory and damage tables | swap to "best gun" without owning it |
| `team_assignment` | host | balance + friendly fire | switch sides mid-match |
| `ready_state` (lobby) | host | match-start gating | force-start with one player |
| `chat_messages` | host-relayed | moderation hooks, profanity filter | bypass mute, broadcast to muted peers |
| `position` | client-predicted, host-reconciled | input latency feels awful otherwise | speed-hack, teleport — reconciliation catches both |
| `velocity` | client-predicted, host-reconciled | same as position | same as position |
| `look_direction` (yaw/pitch) | **client** | cosmetic; host doesn't need it for hit-reg if you raycast on host | cheating here doesn't help |
| `animation_state` | **client** | visual; can lead the truth | wrong anim = visual glitch, not exploit |
| `footstep_audio` | **client** | host doesn't care | spam → mild annoyance, not exploit |
| `particle_fx` / `muzzle_flash` | **client** | host doesn't care | same |
| `aim_assist_target` | **client** | local UX | spoofing it only hurts the spoofer |

If a row is missing, run the fundamental question on it. When in doubt, host-own it — false positives are cheap, false negatives ship cheats.

## The Manager pattern

Every host-authoritative state field lives in a Manager autoload. Naming convention: `{Domain}Manager` — `HealthManager`, `ScoreManager`, `InventoryManager`, `CooldownManager`. This is the canonical state-ownership pattern across shipping-quality MP architectures.

Each Manager has a fixed shape:

```gdscript
class_name HealthManager
extends Node

# ── Signals (UI / floating bars / scoreboard listen here) ──
signal player_health_updated(peer_id: int, hp: int, max_hp: int)
signal player_died(peer_id: int, killer_id: int)

const DEFAULT_MAX_HEALTH := 100

# Host-authoritative dictionary, keyed by peer_id.
var _player_health: Dictionary = {}  # peer_id -> { hp, max_hp, is_dead }

func _ready() -> void:
    NetworkManager.peer_joined.connect(_on_peer_joined)
    NetworkManager.peer_left.connect(_on_peer_left)

# ── HOST-ONLY MUTATORS (state writes) ──────────────────────────
func _host_apply_damage(target: int, amount: int, attacker: int) -> void:
    if not NetworkManager.is_host: return
    var entry = _player_health.get(target)
    if entry == null or entry.is_dead: return
    var new_hp = max(0, entry.hp - amount)
    entry.hp = new_hp
    _broadcast_health(target, new_hp, entry.max_hp)
    if new_hp == 0:
        entry.is_dead = true
        _broadcast_death(target, attacker)

# ── CLIENT REQUEST HANDLERS (validate then mutate) ─────────────
@rpc("any_peer", "call_remote", "reliable")
func _client_request_damage(target: int, amount: int) -> void:
    if not NetworkManager.is_host: return
    var sender := multiplayer.get_remote_sender_id()
    if not _validate_damage_request(sender, target, amount): return
    _host_apply_damage(target, amount, sender)

# ── HOST-TO-CLIENT BROADCASTS (state reads) ────────────────────
@rpc("authority", "call_remote", "reliable")
func _broadcast_health(peer_id: int, hp: int, max_hp: int) -> void:
    var entry = _player_health.get(peer_id, { "hp": hp, "max_hp": max_hp, "is_dead": false })
    entry.hp = hp
    entry.max_hp = max_hp
    _player_health[peer_id] = entry
    player_health_updated.emit(peer_id, hp, max_hp)

@rpc("authority", "call_remote", "reliable")
func _broadcast_death(peer_id: int, killer_id: int) -> void:
    player_died.emit(peer_id, killer_id)
```

The shape:

1. **Data** lives in a private `Dictionary` keyed by `peer_id`.
2. **`_host_apply_*()` mutators** are the *only* functions that write the dictionary. First line: `if not NetworkManager.is_host: return`.
3. **`_client_request_*()` RPC handlers** validate, then call the mutator. Never write directly.
4. **`_broadcast_*()` RPC functions** push state to clients (`@rpc("authority", ...)`) so only host can call.
5. **Lifecycle** via `NetworkManager.peer_joined` / `peer_left` — host registers and cleans up entries.

Build one Manager per state domain. Don't put health and inventory in the same autoload — when one needs a refactor the other gets dragged along.

## The four RPC flavors

`/peer-to-peer-multiplayer` covers three; this skill goes deeper on a fourth (query/response). Every networked function maps to one of these. Pick the wrong one and you'll see the bug listed.

### Flavor 1: Host → Client broadcast

```gdscript
@rpc("authority", "call_remote", "reliable")
func _broadcast_score(peer: int, value: int) -> void:
    _scores[peer] = value
    score_updated.emit(peer, value)
```

- `authority` = only the host can call this. Summer Engine drops other calls.
- `call_remote` = doesn't run on the caller. Host already wrote the dictionary; no need to re-run locally.
- `reliable` = state must arrive. Lost packets retry.
- **Bug if wrong:** if you mark this `any_peer`, a client can fake a score broadcast → desync.

### Flavor 2: Client → Host request

```gdscript
@rpc("any_peer", "call_remote", "reliable")
func _client_request_use_item(item_id: String) -> void:
    if not NetworkManager.is_host: return
    var sender := multiplayer.get_remote_sender_id()
    if not _validate_item_use(sender, item_id): return
    _host_apply_item_use(sender, item_id)
```

- `any_peer` = any client can call.
- First line is **always** `if not NetworkManager.is_host: return`. Summer
  Engine already routes correctly; this also guards against misconfiguration.
- `multiplayer.get_remote_sender_id()` is trustworthy — clients can't lie about who sent the request.
- **Bug if wrong:** missing the `is_host` guard means peers process each other's requests and corrupt local state.

### Flavor 3: Client → Client cosmetic relay

```gdscript
@rpc("any_peer", "call_remote", "unreliable")
func _peer_play_emote(emote_id: String) -> void:
    var sender := multiplayer.get_remote_sender_id()
    _play_emote_visual(sender, emote_id)
```

- `unreliable` = fire-and-forget, lossy is fine for cosmetics.
- No validation — worst case a player's emote desyncs by a frame.
- **Bug if wrong:** marking this `reliable` for high-frequency cosmetic events (footsteps, particle spawns) blows up bandwidth.

### Flavor 4: Query / response (the late-join flavor)

The flavor not covered in `/peer-to-peer-multiplayer`. When one specific client needs the host to send them state — e.g. a peer just joined and needs the full game state — use `rpc_id` to target a single peer.

```gdscript
# Client side — peer asks the host for current state
func client_request_full_state() -> void:
    rpc_id(1, "_host_send_full_state_to_caller")

@rpc("any_peer", "call_remote", "reliable")
func _host_send_full_state_to_caller() -> void:
    if not NetworkManager.is_host: return
    var caller := multiplayer.get_remote_sender_id()
    # send state ONLY to the caller, not all peers
    for peer_id in _player_health:
        var entry = _player_health[peer_id]
        rpc_id(caller, "_broadcast_health", peer_id, entry.hp, entry.max_hp)

# Host side — actually a flavor 1 broadcast, but targeted via rpc_id
@rpc("authority", "call_remote", "reliable")
func _broadcast_health(peer_id: int, hp: int, max_hp: int) -> void:
    # same handler as flavor 1, but called via rpc_id(caller, ...) for targeting
    pass
```

Use this for: late-join state replay, lobby info on connect, post-respawn loadout. **Always reliable** — partial state replay is worse than no replay.

## Validation patterns

Every `_client_request_*()` must validate **before** applying. The validation is the only thing standing between you and a cheat.

```gdscript
func _validate_damage_request(attacker: int, target: int, amount: int) -> bool:
    # 1. Authority check — does this client own the attacker?
    if attacker != target_attacker_owner(attacker): return false

    # 2. Existence check
    if not _player_health.has(target): return false
    if _player_health[target].is_dead: return false

    # 3. Resource check — does attacker have a weapon equipped?
    if not InventoryManager.has_weapon_equipped(attacker): return false

    # 4. Range check — within weapon's max range?
    var weapon := InventoryManager.get_equipped_weapon(attacker)
    var dist := _get_player_distance(attacker, target)
    if dist > weapon.max_range + 0.5:  # epsilon for float compare
        return false

    # 5. Line-of-sight check — physics raycast on the host
    if not _has_line_of_sight(attacker, target): return false

    # 6. Cooldown check — is the weapon off cooldown?
    if not CooldownManager.is_ready(attacker, weapon.id): return false

    # 7. Damage cap — clamp `amount` to weapon.max_damage to defeat magnitude inflation
    if amount > weapon.max_damage: return false

    return true
```

Six common validators, in priority order:

1. **Authority** — does this client own the entity they're modifying? (You can attack other players, but you can only modify your *own* inventory.)
2. **Existence** — does the target still exist on the host? (Race vs. peer disconnect.)
3. **Resource** — does the requester have the resources? (Mana, ammo, weapon.)
4. **Range / distance** — physics-plausible? (Prevents shooting across the map.)
5. **Line-of-sight** — raycast on the host. (Prevents shooting through walls.)
6. **Cooldown** — within rate limits? (Prevents spam-cast.)
7. **Magnitude** — is the requested amount within game-defined max? (Prevents inflation: clamp damage to weapon's `max_damage`, etc.)

When validation fails: **drop silently or log + drop**. Never tell the client they tried to cheat — that just lets them probe. No error response, no friendly "you can't do that" message. The request simply has no effect.

**Float epsilon:** range / distance / cooldown checks involve floats. Always allow a small epsilon (`+ 0.5` for distance, `> -0.05` for cooldown remaining). Strict equality on floats fails for legitimate clients due to physics jitter.

## Late-join state sync

When a peer joins mid-session, the host must replay current state to them. Without this, the new peer's HUD shows zeros and they think they have full HP.

The pattern: every Manager exposes a `_send_full_state(peer_id)` method. Connect it to `NetworkManager.peer_joined`.

```gdscript
# In each Manager
func _on_peer_joined(id: int) -> void:
    if not NetworkManager.is_host: return
    # Register the new peer
    _player_health[id] = { "hp": DEFAULT_MAX_HEALTH, "max_hp": DEFAULT_MAX_HEALTH, "is_dead": false }
    # Replay all existing state to them
    _send_full_state(id)

func _send_full_state(target_peer: int) -> void:
    for peer_id in _player_health:
        var entry = _player_health[peer_id]
        rpc_id(target_peer, "_broadcast_health", peer_id, entry.hp, entry.max_hp)
        if entry.is_dead:
            rpc_id(target_peer, "_broadcast_death", peer_id, 0)
```

Use flavor 4 (`rpc_id`) so only the joining peer gets the replay. Broadcasting to all peers re-confirms state they already have — wastes bandwidth and may trigger "received update" hooks on UIs.

**Idempotency:** `_send_full_state` may run a fraction of a second after `_broadcast_health` for the same peer. Make sure your Manager's broadcast handlers are idempotent — receiving the same state twice should be a no-op.

## Common mistakes

| Mistake | What goes wrong | Fix |
|---|---|---|
| Trusting client-supplied damage values | Client edits memory → 99999 damage one-shots everyone | Host computes damage from weapon resource; client supplies only `target` and `weapon_id`. |
| Validating *after* applying instead of before | Cheat already took effect for a frame; reverting causes visual rubber-banding | Validate first, then mutate. The mutator never runs if validation fails. |
| Broadcasting state changes via `signal.emit()` on host | Signals fire only on the emitter — clients never see the update | Use `@rpc("authority", ...)` broadcast functions. Signals are for *local* listeners (UI on the host). |
| Forgetting `peer_left` cleanup | Dictionaries grow forever as players cycle through; eventual memory leak + ghost entries | Every Manager listens to `NetworkManager.peer_left` and `erase()`s its entry. |
| Using `reliable` for high-frequency cosmetic state (footsteps, particles) | Bandwidth blowup; reliable retransmits on packet loss | `unreliable` for cosmetic; `reliable` only for state that *must* arrive. |
| Comparing floats without epsilon in validation | Legitimate clients fail validation due to physics-step jitter; their hits get silently dropped | `dist > max_range + 0.5`, never `dist > max_range`. |
| Writing to host dictionary from a non-host code path | One peer accidentally becomes "second host" → desyncs | First line of every mutator: `if not NetworkManager.is_host: return`. Treat as boilerplate. |

## Anti-pattern: the "synced var" temptation

Summer Engine ships a `MultiplayerSynchronizer` node that automatically
replicates a list of properties across the network. It is tempting because it
removes RPC boilerplate. **It is wrong for anything game-logic-relevant.**

`MultiplayerSynchronizer`:
- Has no validation hook. Writes go through unconditionally.
- Has no concept of "host owns this, client requests changes."
- Replicates whatever value the configured authority node sets — and the authority is per-node, not per-property.
- Provides no audit trail when a value changes (compared to a Manager method you can breakpoint).

It is the right tool for **cosmetic state only**:
- Animation node parameters (`AnimationTree` blend values).
- Look direction / camera yaw on remote peer's visuals.
- Particle emission state on a non-gameplay decoration.

Game-logic state — health, score, inventory, cooldowns, position-of-truth — goes through Managers with explicit validate-mutate-broadcast. The five extra lines of boilerplate per field are what keeps the game shippable.

## Putting it together

When you start a new MP game, the order is:

1. Build `NetworkManager` (covered by `/peer-to-peer-multiplayer` Layer 1).
2. List every piece of game state on a sheet.
3. Run "if a malicious client lies, does it break?" on each.
4. Group host-owned fields by domain → one Manager per domain.
5. For each Manager: data dict, `_host_apply_*()` mutators, `_client_request_*()` RPCs with validators, `_broadcast_*()` RPCs, `peer_joined` / `peer_left` lifecycle, `_send_full_state()` for late-join.
6. Cosmetic state goes through `MultiplayerSynchronizer` or a flavor-3 RPC.
7. Position/velocity get host-reconciled prediction (covered by `/peer-to-peer-multiplayer` Layer 4).

## Collaborative protocol

This skill writes new autoload files (one per Manager). Always ask before each:

> May I create `autoloads/HealthManager.gd` and register it as an autoload?
> May I add the validation function to HealthManager? Here's what I'll check: [list].
> May I wire HealthManager's `peer_joined` lifecycle?

Don't bulk-create five Managers in one shot. Walk one Manager end-to-end (data → mutators → requests → broadcasts → lifecycle) so the user can verify the shape, then repeat for the next domain.

After each Manager file lands, call `summer_get_script_errors` to confirm clean compile.

## See also

- [`peer-to-peer-multiplayer`](../peer-to-peer-multiplayer/SKILL.md) — the four-layer architecture overview. Read this first if you haven't.
- [`setup-multiplayer`](../setup-multiplayer/SKILL.md) — lighter intro that just gets a session running. Use that one if the user just wants two players to see each other.
