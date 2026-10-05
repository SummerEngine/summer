---
name: peer-to-peer-multiplayer
description: "Start a multiplayer Summer game the right way: no peer-to-peer or host migration, a headless authority instead, and which Summer skill to build it with."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: multiplayer-and-networking
user-invocable: true
allowed-tools: Read Grep Glob summer_get_scene_tree summer_inspect_node summer_get_script_errors
paths: ["**/*.gd", "**/*.tscn", "**/project.godot"]
---

# /peer-to-peer-multiplayer — Summer games have an authority, not peers

## Overview

Users ask for "peer-to-peer" or "one player hosts" because they want friends to
play together without paying for servers. On Summer that wish is met
differently.

Every Summer multiplayer game runs a **headless authority** that simulates the
match. Clients join it with `Summer.client.join(...)`:

- **Locally**, Local Play starts that authority on your machine.
- **Hosted**, Summer starts it for each match.

There is no peer-to-peer topology, no player-hosted listen server and no host
migration, so a player quitting never ends the match for everyone else.

**Never build an `ENetMultiplayerPeer` host/join flow, `@rpc` sync or
`MultiplayerSynchronizer` for a Summer game.** That path has no prediction or
reconciliation, so it rubberbands. It cannot use Summer hosting, matchmaking,
cross-play or verified identity. And sender ids are transport peers, not
verified players.

## Steps

### 1. Find out what they actually want

> 1. Who plays together: friends by invite, or strangers through matchmaking?
> 2. How many players per match? Summer's measured envelope is up to 16.
> 3. Is it an action game (players steer characters continuously) or state-driven (building, trading, turns, cozy co-op)?

Every answer leads to the same topology, an authority plus clients. The answers
only choose the skill and the queue sizes.

### 2. Route to the skill that builds it

| The game | Skill |
|---|---|
| Players steer characters, vehicles or projectiles continuously (shooters, brawlers, racers, platformers) | `skill/setup-multiplayer`: a predicted `SummerNetworkBehavior` per player |
| Shared world state, actions and inventories (builders, traders, cozy co-op, turn-based) | `skill/host-authoritative-state`: Commands plus authority-written State |
| Both (most games) | Start with `skill/setup-multiplayer` for the players, then add `skill/host-authoritative-state` for everything else on the same World |

Explain the change once:

> Summer runs the match on a headless authority instead of on one player's
> machine. You still need nothing but the editor to test with friends' clients
> locally (Local Play), and hosted matches don't depend on any player staying
> online. I'll set it up that way.

### 3. Map their peer-to-peer ideas onto Summer

| What they asked for | What Summer does instead |
|---|---|
| "One player hosts" | A headless authority, started by Local Play locally or by Summer when hosted |
| Host migration | Not needed: no player is the authority |
| Join by IP or invite code | A queue in `summer.build.json`, joined with `Summer.client.join(SummerJoinTarget.queue(...))` |
| Lobby | A queue with `minPlayers`/`maxPlayers`; hosted matchmaking proposes the match |
| "Sync the player's position" | A `SummerNetworkBehavior` entity: owner prediction, authority simulation, observer interpolation |
| "Tell everyone the door opened" | An authority-written State group that every client receives, late joiners included |
| "Client asks the host to buy an item" | A Command that the authority validates with the sender's verified Session |

## Common mistakes

| Don't | Do | Why |
|---|---|---|
| `ENetMultiplayerPeer.create_server` / `create_client` by IP | `Summer.client.join(SummerJoinTarget.queue(...))` | Raw peers can't use Summer hosting, identity or matchmaking |
| Pick a "host" player and run the game there | Let the authority run it | Host advantage, host quits end the match, no hosting |
| Write host migration | Nothing; the authority isn't a player | The problem doesn't exist on Summer |
| `@rpc` or `MultiplayerSynchronizer` for state | `SummerNetworkBehavior`, State groups and Commands | Prediction, ordering, late join and identity come for free |
| Trust a player id sent by a client | `request.get_session().player.user_id` on the authority | Only the Session is verified |

## See also

- `skill/setup-multiplayer` — players and movement
- `skill/host-authoritative-state` — what the authority owns and how clients ask for changes
