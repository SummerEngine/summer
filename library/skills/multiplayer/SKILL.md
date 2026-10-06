---
name: multiplayer
description: "Start here for Summer multiplayer: how the authority, clients, Worlds and Sessions fit, and which skill comes next."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: multiplayer-and-networking
user-invocable: true
allowed-tools: Read Grep Glob summer_get_scene_tree summer_get_script_errors summer_project_setting
paths: ["**/*.gd", "**/*.tscn", "project.godot", "summer.build.json", "world.json"]
---

# /multiplayer — how Summer multiplayer works

Read this first, whatever the user asked for: "multiplayer", "co-op", "PvP",
"online", "play with friends", "lobby", "peer-to-peer", "host a game",
"netcode", "sync players". It explains the model in one page and sends you to
the skill that builds the next piece.

## The picture

A Summer multiplayer game is **one project with two entry scenes**:

- the **client** scene, which every player runs: input, camera, visuals, UI;
- the **authority** scene, which runs headless as the match server and owns
  the rules.

```text
   each player's device                   Summer hosting (or Local Play)
  ┌──────────────────────┐  my pose       ┌──────────────────────────────┐
  │ client scene         │ ─────────────► │ authority scene = one World  │
  │ moves its own player │  "collect"     │ checks every pose and request│
  │ draws everyone else  │ ─────────────► │ owns score, doors, items...  │
  │                      │ ◄───────────── │                              │
  └──────────────────────┘  state, events └──────────────────────────────┘
```

- A running match is a **World**. Summer starts one authority for it; the game
  declares what a World is in `world.json` (a **WorldDefinition**).
- A player joins with `Summer.client.join(...)` and gets a verified
  **Session**: their seat in that World, with a verified player identity.
- Players find a World through a **queue** in `summer.build.json`. Hosted,
  Summer's matchmaking fills it; locally, **Local Play** starts the authority
  and N clients on your machine.
- The same code runs locally and hosted. No `if server`, no local-only
  branches, no IP addresses.

There is no player-hosted server, so there is no host migration, and a player
quitting never ends the match for the others.

## How data moves

Both sides load one **network composition** (`network/composition.tres`). It
declares every stream the game uses, and a **Spawner** node attaches it to the
World:

| You want | Use | Who writes it | Skill |
|---|---|---|---|
| My character moves | Owner-written State group, one per player | that player's client; the authority checks each pose | `multiplayer-movement` |
| Everyone sees the score, a door, the round timer | Authority-written State group, World audience | the authority | `multiplayer-state` |
| Only I see my wallet, hand, inventory | Authority-written State group, target-Session audience | the authority | `multiplayer-state` |
| A player wants to buy, open, collect, ready up | Command | client asks, authority accepts or refuses | `multiplayer-state` |
| A one-off effect (sparkle, sound, hit flash) | Event | the authority | `multiplayer-state` |

State is retained, so a late joiner gets the current value. Commands carry
the sender's verified Session. Events are fire-and-forget.

## The rules

1. **Each client moves its own character.** Movement feels instant on every
   connection. The authority accepts or refuses each pose, and a refused pose
   snaps the player back.
2. **The authority owns every other fact.** Clients never change shared
   state; they send a Command and show the result.
3. **Identity comes from the Session**, never from a field a client sent.
4. **Never use the stock high-level multiplayer API in a Summer game:** no
   `@rpc`, `MultiplayerSynchronizer`, `MultiplayerSpawner`,
   `ENetMultiplayerPeer`, `multiplayer.is_server()` or peer-ID branches. Their
   sender ids are transport peers, not verified players. Late joiners miss
   state, and the game cannot use Summer hosting, matchmaking or identity.
5. **Test under a bad network before calling anything done:** Local Play
   with latency, jitter and loss (`multiplayer-testing`).

## Words

| Word | Meaning |
|---|---|
| Game | Your game on Summer; its id is `gameId` in `summer.build.json` and the argument to `Summer.initialize` |
| World | One running match or shared place, simulated by one authority |
| WorldDefinition | `world.json`: which scenes run the client and the authority, lifetime, persistence |
| Queue | How players find a World; declared in `summer.build.json` |
| Session | One player's verified seat in a World |
| Composition | The network contract both sides load: State streams, Command and Event streams |
| State group | One retained value (a pose, a scoreboard); one writer, an audience |
| Command | A request from a client, answered by the authority |
| Event | A one-off message from the authority |
| Local Play | Runs the authority and N clients locally, with optional network emulation |

## Build it in this order

Each skill continues the same small game, so their code fits together:

1. **`multiplayer-project`**: the files, both entry scenes, joining, and a
   first Local Play run.
2. **`multiplayer-movement`**: each player moves their own character; others
   see it smoothly; the authority checks every pose.
3. **`multiplayer-state`**: score, doors, private inventories, Commands and
   Events.
4. **`multiplayer-testing`**: Local Play under latency and loss, bots, and
   what a passing run must show.
5. **`multiplayer-publish`**: export the summer.games bundle and upload it as
   a Build.

## Add Summer services

| Skill | What it adds | Works in Local Play? |
|---|---|---|
| `summer-matchmaking` | Queues, match sizes, teams, the accept prompt, join failures | Yes, without the accept prompt |
| `summer-match-results` | Ending a match: winners, losers, rating changes | Yes |
| `summer-leaderboards` | Ratings and Game-wide leaderboards | Partly; reading boards needs hosting |
| `summer-parties` | Friends queue together as a party | No, hosted only |
| `summer-friends` | The player's Summer friends and direct messages | No, hosted only |
| `summer-player-data` | Progress that follows the player to any World | Yes, stored on disk |
| `summer-world-saves` | Worlds that persist between sessions | Yes, in memory |
| `summer-world-chat` | Text chat inside a World | No, hosted only |
| `summer-store` | Selling items for Sparks, owned items | Items yes; the store is hosted only |
| `summer-analytics` | Game events for your analytics dashboard | No, hosted only |

## What people ask for, and what Summer does

| They ask for | On Summer |
|---|---|
| "One player hosts", peer-to-peer | A headless authority per match, started by Summer or by Local Play |
| Host migration | Not needed: no player is the authority |
| Join by IP, invite code, server browser | Not available. Players join a queue; friends join as a party (`summer-parties`) |
| A lobby | A queue with `minPlayers`/`maxPlayers` and an accept prompt (`summer-matchmaking`) |
| "Sync the player's position" | An owner-written pose group (`multiplayer-movement`) |
| "Tell everyone the door opened" | An authority-written State group (`multiplayer-state`) |
| "The client asks the host to buy something" | A Command validated with the verified Session (`multiplayer-state`) |
| Save progress | Player data for the player, World saves for the place (`summer-player-data`, `summer-world-saves`) |

## Start

Check what exists: `summer.build.json`, `world.json`, `network/`,
`authority/`, `client/`.

- **None of them:** start with `multiplayer-project`.
- **They exist:** pick the skill for the piece you need from the tables above.
- **The game already uses `@rpc` or `MultiplayerSynchronizer`:** tell the user
  it needs moving to Summer's networking. Then follow `multiplayer-project`
  and port one system at a time: movement first, then state.
