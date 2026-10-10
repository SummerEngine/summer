---
name: summer-leaderboards
description: "Leaderboards in a Summer game: queue ratings from matches, and Game rankings your authority scores."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: multiplayer-and-networking
user-invocable: true
allowed-tools: Read Grep Edit Write summer_read_file summer_replace_text summer_write_file summer_get_script_errors summer_play summer_stop summer_get_diagnostics
paths: ["summer.build.json", "client/**/*.gd", "authority/**/*.gd"]
---

# /summer-leaderboards — ratings, rankings and the top 50

## Overview

Summer keeps two kinds of score board. Pick by where the number comes from:

| Board | The number is | Declared as | Written by | Read with |
|---|---|---|---|---|
| **Queue rating** | A skill rating (Elo, MMR) that moves with every match in a rated queue | A queue with `"policy": "rating"` | Summer, when the authority concludes a match | `Summer.client.ratings`, `Summer.authority.ratings` |
| **Game ranking** | Any score your game defines: total coins, best time, levels cleared | `runtime.rankings` | Your authority, with compare-and-set | `Summer.client.rankings`, `Summer.authority.rankings` |

Players only ever read their **own** rating and score, plus the public top 50,
which shows display names, never account ids. Nobody can write a score from a
client.

Where it works: leaderboards, standings and rankings are read through the
Summer app that hosts the player, so they work in **hosted** games only.
Under Local Play they fail with a typed code (step 5); the authority's
`ratings.load` returns a deterministic test value. Build the screens so they
degrade gracefully, and check the real numbers on a hosted staging build.

This skill extends the Courtyard game: its authority concludes matches as in
`summer-match-results`.

## Steps

### 1. Declare the boards

In `summer.build.json`, a rated queue gets a rating, and `runtime.rankings`
declares Game rankings:

```json
"queues": [
  {
    "name": "duel",
    "minPlayers": 2,
    "maxPlayers": 2,
    "worldDefinition": "courtyard",
    "policy": "rating",
    "ratingSystemRef": "elo_v1",
    "teams": { "count": 2, "size": 1 },
    "transport": "enet"
  }
],
"rankings": [
  { "name": "coins", "initialRating": 0 }
]
```

- `ratingSystemRef`: `elo_v1` lets Summer compute rating moves from win, loss
  and draw. `authority_v1` makes your authority report each player's move
  (step 4). Optional `initialRating` is a newcomer's rating (default 1200).
- A ranking `name` is lower-case letters and digits separated by single `.`,
  `_` or `-`, at most 64 characters; at most 32 rankings. `initialRating`
  defaults to 0.
- To make a rated queue and a ranking one board, give the queue
  `"rankingRef": "<ranking name>"` and drop the queue's `initialRating`. A
  queue and a ranking may not share a name without `rankingRef`.

### 2. Show a queue's top 50 and the player's standing

On a client, after Summer is initialized (no match needed):

```gdscript
## Fills a leaderboard screen for a rated queue. Hosted games only.
func show_queue_board(queue: StringName) -> void:
	var board := Summer.client.ratings.leaderboard(queue)
	var read: SummerResult = await board.get_result_or_completed_signal()
	if not read.ok:
		show_board_unavailable(read)
		return
	for entry: SummerLeaderboardEntry in board.entries:
		add_board_row(entry.rank, entry.display_name, entry.value, entry.you)
	var standing := Summer.client.ratings.standing(queue)
	if (await standing.get_result_or_completed_signal()).ok:
		if standing.rank > 0:
			show_place("#%d of %d" % [standing.rank, standing.players])
		elif standing.rated:
			show_place("Top %.1f%%" % (100.0 - standing.percentile))
		else:
			show_place("Play a rated match to get a rank")
```

- `entries` holds up to 50 rows, best first; `you` marks the player's own row.
- `standing.rank` is set only inside the top 1000; otherwise show the
  percentile. Before the first rated match `rated` is false and `value` is the
  queue's `initialRating`.
- `Summer.client.ratings.get_current(queue)` returns the last known
  `SummerRatingSnapshot` (`value`, `games`, `version`) without a network read,
  or `null`. `refresh(queue)` reads it again; `rating_changed(queue)` fires
  when it moves.
- One read of each kind is in flight at a time; calling again while one is
  pending returns the same operation.

After a match, `Summer.client.ratings.rating_committed` delivers the
player's own before-and-after rating (see `summer-match-results`).

### 3. Write a Game ranking from the authority

Only the authority writes rankings, by the player's stable id, with
**compare-and-set**: read the score and its version, write the new absolute
value against that version, and read again if someone else wrote first. In
`authority/main.gd`, after the match concluded:

```gdscript
## Adds this match's coins to each player's Game ranking "coins".
## Compare-and-set: read the version, write against it, re-read on conflict.
func _record_coins() -> void:
	for session_id: String in wallets:
		var player: SummerPlayer = sessions[session_id].player
		await _add_score(&"coins", player.user_id, int(wallets[session_id]))


func _add_score(ranking: StringName, player_id: String, points: int) -> void:
	for attempt in 3:
		var before := Summer.authority.rankings.get_score(ranking, player_id)
		var read: SummerResult = await before.get_result_or_completed_signal()
		if not read.ok:
			return   # hosted only: Local Play has no ranking service
		var write := Summer.authority.rankings.set_score(ranking, player_id, before.rating.version, before.rating.value + points, before.rating.games + 1)
		var wrote: SummerResult = await write.get_result_or_completed_signal()
		if wrote.ok or wrote.code != &"ranking_version_conflict":
			return
		# Someone else wrote first: read again and recompute.
```

`sessions` maps each `session_id` to the `SummerSession` the authority keeps
in `_on_session_joined` (`summer-match-results`, step 1). The engine never
retries a write. After a failure other than a conflict, read the score before
deciding to write again: the first write may have committed.

Clients read their own ranking with `Summer.client.rankings.get_score("coins")`,
`standing("coins")` (full rank and player count; rank 0 before the first
score) and `leaderboard("coins")` (top 50, zero-score players included). These
work in a standalone game too, before any match.

### 4. Own a co-op queue's rating (`authority_v1`)

Elo rates two sides against each other. A co-op mode, where a group plays
against the content, declares `"ratingSystemRef": "authority_v1"` and reports
every player's move when the match concludes:

```gdscript
## A co-op run against content rated `content_rating`; `cleared` says whether
## the group made it. Moves each player's rating like Elo against the content.
func conclude_run(players: Array[SummerSession], content_rating: int, cleared: bool) -> void:
	var outcomes: Dictionary[SummerSession, SummerAuthorityMatch.MatchOutcome] = {}
	var deltas: Dictionary[SummerSession, int] = {}
	for session in players:
		var read := Summer.authority.ratings.load(session)
		if not (await read.get_result_or_completed_signal()).ok:
			return   # rating_unavailable: this queue keeps no rating
		var expected := 1.0 / (1.0 + pow(10.0, (content_rating - read.rating.value) / 400.0))
		deltas[session] = roundi(32 * ((1.0 if cleared else 0.0) - expected))
		outcomes[session] = SummerAuthorityMatch.MATCH_OUTCOME_WIN if cleared else SummerAuthorityMatch.MATCH_OUTCOME_LOSS
	var concluded: SummerResult = await Summer.authority.match.conclude(outcomes, "run_complete", deltas).get_result_or_completed_signal()
```

- Each delta is an `int` within ±1000, one for **every** participant.
  Deltas on a non-`authority_v1` queue, or a missing one, fail the
  conclusion with `invalid_request` and commit nothing; conclude again with
  corrected arguments.
- `Summer.authority.ratings.load(session)` is for the authority's own logic.
  Never show one player's rating to other players; the leaderboard is the
  public view.
- `Summer.authority.ratings.leaderboard("dungeon")` reads the same top 50,
  unmarked, for an in-World trophy wall.

### 5. Degrade gracefully where boards aren't available

```gdscript
func show_board_unavailable(result: SummerResult) -> void:
	match String(result.code):
		"rating_unavailable":
			show_place("This mode has no ranking")
		_:
			show_place("Leaderboard unavailable right now" if result.retryable else "Leaderboards appear in the Summer app")
```

Under Local Play these calls fail without a Summer account behind them:

| Call | Under Local Play |
|---|---|
| `Summer.client.ratings.leaderboard`, `standing`, `refresh` | Fails with `unavailable` (retryable) |
| `Summer.client.ratings.get_current` | `null` |
| `Summer.client.rankings.get_score`, `standing`, `leaderboard` | Fails with `unavailable` (not retryable) |
| `Summer.authority.rankings.get_score`, `set_score` | Fails with `service_error` |
| `Summer.authority.ratings.load` | Works: a deterministic test rating (system `deterministic-v1`) |
| `Summer.authority.ratings.leaderboard` | Works: an empty list |
| `Summer.authority.match.conclude` | Works: a deterministic settlement with test rating changes |

Hide or grey out leaderboard buttons when a read fails; never block the game
on them.

## Checklist

- [ ] Every board is declared: rated queues with `ratingSystemRef`, rankings under `runtime.rankings`.
- [ ] The leaderboard screen marks the player's own row and shows rank or percentile.
- [ ] Ranking writes happen only on the authority, by `player.user_id`, with compare-and-set and a conflict re-read.
- [ ] `authority_v1` queues conclude with a delta for every participant; other queues send none.
- [ ] Every read handles failure, and the game stays playable without boards.
- [ ] Real numbers checked on a hosted staging build.

## Common mistakes

| Don't | Do | Why |
|---|---|---|
| Write scores from the client | `Summer.authority.rankings.set_score` | Clients can only read their own score; the authority is trusted |
| `set_score` without the version you read | Read with `get_score`, pass `before.rating.version` | It is compare-and-set; a stale version fails `ranking_version_conflict` |
| Blindly retry a failed write | Read again, then decide | The first write may have committed; the engine doesn't replay it |
| Send rating deltas on an `elo_v1` or `fifo` queue | Deltas only on `authority_v1`, one per participant | Otherwise the conclusion fails `invalid_request` |
| Show other players' ratings from `authority.ratings.load` | Show the leaderboard | Ratings are private to each player |
| Name a ranking like a queue without `rankingRef` | Distinct names, or `rankingRef` to share one board | Summer rejects the manifest |
| Treat a Local Play failure as a bug | Expect `unavailable` or `service_error` locally; test boards hosted | Boards are read through the hosting Summer app |

## See also

- `summer-match-results` — concluding matches, which moves ratings
- `summer-matchmaking` — declaring rated queues and teams
- `summer-player-data` — saving per-player progress that isn't a ranking
