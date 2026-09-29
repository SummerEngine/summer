---
name: summer-multiplayer
description: "Build a GDScript multiplayer game on Summer: dedicated authority, typed state groups, validated Commands, player-data saves, Local Play bot tests."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: multiplayer
user-invocable: true
allowed-tools: Read Grep Glob Edit Write summer_project_setting summer_get_script_errors
paths: ["**/*.gd", "world.json", "summer.build.json", "project.godot"]
---

# Multiplayer on Summer (GDScript)

Use this for any game where players share a world through Summer (the Summer Games app, web, desktop).
Summer runs a **dedicated authority** for each World; clients send what they want to do, the authority
decides. Do not hand-build networking (a peer plus an IP address): it cannot use Summer hosting,
cross-play or verified identity. This skill is the path that worked end to end in a shipped-quality
co-op game; `reference.md` next to it has the complete code.

## 1. Declare the World

Two files at the project root:

- `world.json`: `lifetime` (`match_scoped` for drop-in servers), `topology: dedicated`, the
  `client_entry_point` scene, and one `headless_engine` component whose `entry_point` is the authority scene.
- `summer.build.json`: a queue that names the World definition, with `minPlayers`/`maxPlayers`.

Why: Local Play and hosting both start the authority from these; nothing is inferred from scenes.

## 2. One composition, built by both roles

Put the network setup in one shared script that both the client scene and the authority scene call. Build
a `SummerNetworkWorld`, an `Entities` node and an entity-free `SummerNetworkSpawner`
(`player_archetype = &""`) with a `SummerNetworkComposition`. Client and authority must build the same
streams, or they refuse each other.

Pick streams by who writes and who may read:

| Data | Stream | Why |
|---|---|---|
| Shared world state | authority-written, `SummerWorldAudience` | everyone sees it; only the authority changes it |
| One player's wallet/inventory | authority-written, `SummerTargetSessionAudience`, created with `target_session` | private without giving the player write access |
| Movement | owner-written (`WRITER_OWNER`), writer = that Session, with an acceptance policy | responsive, still bounded by the authority |
| Actions (buy, plant, trade) | Command stream (`COMMAND_SCOPE_WORLD`) with payload and result schemas | the authority validates every change |

Rules that prevent silent failure:
- **A network `String` holds at most 256 UTF-8 bytes.** Send documents (JSON) as `PackedByteArray`
  (`JSON.stringify(d).to_utf8_buffer()`); `max_state_bytes` defaults to 60000.
- **Audience bounds default to 0 (invalid).** Set `audience_policy.max_expansion` and
  `max_audience_count` to at least the player count, or the audience is empty.
- **Connect `state_group_created` before joining**, or late-join baselines arrive unseen.
- **Don't name your classes after engine classes** (`SummerSession`, `SummerWorld` exist). The parse
  error only says the class "hides a native class".

## 3. The authority validates, with the verified identity

In `command_received(request)`: identity is `request.get_session().player.user_id`, never a payload
field. Apply the action, then `request.accept({}, {"b": <result bytes>})` or
`request.refuse(&"reason")`. Refusal reasons are stable ids the client maps to friendly text.

Put a request id in every Command and keep the last results per player. A retry with the same id returns
the stored result instead of applying twice. Why: a timed-out Command may already have been applied; a
blind resend would double-spend.

## 4. Save players, not servers

For drop-in servers, keep progress in **player data** so it follows the player to any server:
`Summer.authority.player_data.load(session)` when the Session joins, `commit_secret(session, save_id, data)`
(one JSON object, 64 KiB, authority-only) while playing and when it leaves.

- Load on `session_joined`. The gameplay "join" Command answers `loading` until the load finishes, and the
  client retries **with the same request id**.
- A failed load is not an empty profile. Refuse the join; never start a fresh save over data you
  couldn't read.
- One commit in flight per player. Retry a failed commit with the **same** `save_id`. Stop on
  `player_data_superseded`: a newer Session owns that player now.
- Measure a maximal save against 64 KiB in a test. Refuse to save over the limit; never truncate.

## 5. Client

`await Summer.initialize(GAME_ID).get_result_or_completed_signal()`, then
`Summer.client.join(SummerJoinTarget.queue(&"<queue>"))`, then wait for `spawner.network_ready`, then send
your gameplay join Command. Turn installed state groups into your game's own model; only the authority's
documents change it.

- Keep a Command that couldn't be admitted (disconnected) and resend it later with the same id.
- Show "reconnecting" on `server_disconnected` and keep the scene running. End only on a terminal refusal.
- Bound the join wait. Without Local Play or hosting a join can't complete, so fall back to an offline
  in-process authority and the game stays playable.

## 6. Test with two clients and bots

```
<summer> --path . --summer-local-play 2 --summer-local-play-headless -- --bot={client}
```

Local Play starts the authority and the clients; arguments after `--` reach every process, with
`{client}` replaced per process. Give the game a bot mode that plays the real loop, prints one
`RESULT {...}` line and quits. Drop `--summer-local-play-headless` to watch the windows side by side.
`--summer-local-play-smoke` only proves that clients joined.

Headless clients have no real display: guard `DisplayServer` keyboard/window calls, or they log an error
every frame.

## Common mistakes

- JSON in a `String` field: creation fails with "network value string must contain 0..256 UTF-8 bytes".
- Trusting a player id sent in the payload instead of the Session.
- Godot `@rpc` / MultiplayerSpawner on top of Summer: sender ids are transport peers, not verified players.
- Saving the server instead of the player on drop-in servers: progress vanishes when the World ends.
- Retrying writes with a new id or save_id: duplicates.

## See also

- `reference.md` (complete composition, authority, client and bot code)
- `choose-where-players-play` (decide destinations and language first)
- `host-authoritative-state` (what the authority should own)
