---
name: summer-match-results
description: "End a Summer match: report each player's win, loss or draw, show results on clients, then close the World."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: multiplayer-and-networking
user-invocable: true
allowed-tools: Read Grep Edit Write summer_read_file summer_replace_text summer_write_file summer_get_script_errors summer_project_setting summer_play summer_stop summer_get_diagnostics
paths: ["authority/**/*.gd", "client/**/*.gd", "world.json"]
---

# /summer-match-results — who won, and closing the match

## Overview

A match ends when **the authority** says so. It decides the outcome for every
player, then:

1. **Concludes** the match: `Summer.authority.match.conclude(outcomes, reason)`.
   Summer settles it once and returns a settlement, including each player's
   rating change on a rated queue.
2. Summer delivers each player **their own** result on the client
   (`Summer.client.ratings.match_result`), and later their committed rating
   (`rating_committed`). The authority never relays results or ratings.
3. **Completes** the World: `Summer.authority.world.complete()` for a
   match-scoped World. Clients are disconnected and go back to your menu.

Where it works: all of this runs under Local Play with a deterministic
settlement, so the whole flow is testable locally. Rating values are real only
when hosted.

This skill extends the Courtyard game (`skill/multiplayer-project` and
`skill/multiplayer-state`): the first player to collect `WIN_COINS` coins wins.
With a team queue (`skill/summer-matchmaking`), their whole team wins.

## Steps

### 1. Track who is in the match

In `authority/main.gd`, keep every Session the engine admitted, and the
players who left. Add these variables:

```gdscript
const WIN_COINS := 1    # coins that win the match
var ended := false
var departed := {}      # session_id of players who left before the end
var sessions := {}      # session_id -> SummerSession
```

In `_ready()`, next to the other World signals (skip this line if
`skill/summer-player-data` already connected it):

```gdscript
	world.session_joined.connect(_on_session_joined)
```

```gdscript
## Every player admitted into this match, kept as the exact Session object
## the engine handed over: conclude accepts only these.
func _on_session_joined(session: SummerSession) -> void:
	sessions[session.session_id] = session
```

If the game already has `_on_session_joined` (`skill/summer-player-data`
adds one), put the line at its start instead of defining it twice.

At the top of `_on_session_left`:

```gdscript
	departed[session.session_id] = true
```

Keep a Session in `sessions` after it leaves: it stays on the match roster
until the match is delivered, and it still needs an outcome.

Presence signals on the authority's `SummerNetworkWorld`:

| Signal | Meaning | Typical response |
|---|---|---|
| `session_joined(session)` | First admission into this World | Nothing extra: clients send `join` when their network is ready |
| `session_disconnected(session)` | Transport lost; the seat is kept | Pause or freeze that player; don't end the match yet |
| `session_reconnected(session)` | Same Session is back | Resume them |
| `session_left(session, reason)` | The Session ended, exactly once | Count them as departed; retire their groups |

Hosted, a seat waits `lifecycle.reconnect_seconds` (`world.json`) before
Summer ends the Session. Under Local Play a quitting player only
disconnects; `session_left` arrives when the World ends.

### 2. Decide the outcome and conclude

At the end of `_collect`, after `request.accept(...)`:

```gdscript
	if wallets[session.session_id] >= WIN_COINS:
		_end_match(session)
```

Then add:

```gdscript
## Ends the match once: every player gets an outcome, Summer settles it, and
## the World closes after a short results screen.
func _end_match(winner: SummerSession) -> void:
	if ended:
		return
	ended = true
	var winner_team := Summer.authority.match.get_participant(winner).team
	var outcomes: Dictionary[SummerSession, SummerAuthorityMatch.MatchOutcome] = {}
	for id: String in sessions:
		var session: SummerSession = sessions[id]
		var participant := Summer.authority.match.get_participant(session)
		if participant == null or not participant.outcome_eligible:
			continue   # spectators get no outcome
		if departed.has(id):
			outcomes[session] = SummerAuthorityMatch.MATCH_OUTCOME_ABANDON
		elif (participant.team == winner_team) if winner_team >= 0 else (id == winner.session_id):
			outcomes[session] = SummerAuthorityMatch.MATCH_OUTCOME_WIN
		else:
			outcomes[session] = SummerAuthorityMatch.MATCH_OUTCOME_LOSS
	match_doc.winner = winner.player.display_name
	match_group.reset(Game.pack(match_doc))
	var settled := await _conclude(outcomes)
	# Let players read the results screen, then end the World.
	await get_tree().create_timer(3.0).timeout
	await Summer.authority.world.complete("match_complete").get_result_or_completed_signal()


## Commits the outcomes. A retryable failure is retried with the same
## arguments: Summer settles a match at most once.
func _conclude(outcomes: Dictionary[SummerSession, SummerAuthorityMatch.MatchOutcome]) -> SummerMatchSettlement:
	for attempt in 3:
		var concluding := Summer.authority.match.conclude(outcomes, "coins_collected")
		var concluded: SummerResult = await concluding.get_result_or_completed_signal()
		if concluded.ok:
			return concluding.settlement
		if not concluded.retryable:
			push_error("conclude: %s %s" % [concluded.code, concluded.message])
			return null
		await get_tree().create_timer(1.0 + attempt).timeout
	return null
```

Give `match_doc` a `"winner": ""` entry so clients can show the winner's name.

The rules `conclude` enforces:

- **One outcome for every outcome-eligible player admitted into the match**,
  including players who already left (`MATCH_OUTCOME_ABANDON`). A missing or
  extra player fails with `invalid_roster`; spectators are skipped.
- **Keys must be the exact `SummerSession` objects the engine delivered**
  (`session_joined`, or `request.get_session()` in a Command). Copies, such as
  the Sessions in `Summer.authority.context.participants`, fail with
  `invalid_roster`.
- Outcomes are `MATCH_OUTCOME_WIN`, `MATCH_OUTCOME_LOSS`, `MATCH_OUTCOME_DRAW`
  and `MATCH_OUTCOME_ABANDON`. On a team queue give every member of a team the
  same outcome; Summer scores the sides it formed.
- **It settles once.** Retrying with identical arguments replays the same
  settlement (`concluding.replayed` is true); different arguments are
  refused. A rejected conclusion (`invalid_request`) commits nothing, so you
  may conclude again with corrected arguments.
- `rating_deltas`, the third argument, is only for `authority_v1` queues
  (`skill/summer-leaderboards`).

The settlement lists each player's committed rating changes:

```gdscript
	if settled != null:
		for player: SummerPlayerSettlement in settled.players:
			for change: SummerRatingChange in player.ratings:
				print("%s %s %d -> %d" % [player.session.player.display_name, change.system, change.before.value, change.after.value])
```

Use it for authority logic (logs, rewards). Players get their own numbers
directly from Summer, step 3.

### 3. Show the result on each client

In `client/main.gd`'s `_ready()`, connect the result signals right after
`Summer.initialize` succeeds and before joining (`Summer.client` is null
until then), and handle the end of the World:

```gdscript
	Summer.client.ratings.match_result.connect(_on_match_result)
	Summer.client.ratings.rating_committed.connect(_on_rating_committed)
	$World.server_disconnected.connect(_on_server_disconnected)
```

```gdscript
func _on_match_result(result: SummerMatchResult) -> void:
	var words := {
		SummerMatchResult.OUTCOME_WIN: "You win!",
		SummerMatchResult.OUTCOME_LOSS: "You lose.",
		SummerMatchResult.OUTCOME_DRAW: "Draw.",
	}
	show_status(words.get(result.outcome, "Match over."))


## Arrives later, privately, once Summer committed this player's rating.
func _on_rating_committed(result: SummerMatchResult) -> void:
	var change := result.rating
	show_status("Rating %d (%+d)" % [change.after.value, change.delta])


func _on_server_disconnected(code: String, _detail: String) -> void:
	show_status("The match has ended.")
```

`show_status` and the `Hud/Status` label come from `skill/summer-matchmaking`.

- `match_result` arrives when the authority concludes. Its `rating_state` is
  `RATING_STATE_PENDING` on a rated queue, or `RATING_STATE_NONE`.
- `rating_committed` follows when Summer committed the rating, with
  `result.rating.before`, `after` and `delta`. Hosted only.
- `Summer.client.ratings.last_result` and `results` keep recent results, so a
  results screen opened later can read them.
- Drive the results screen from `match_result`, not from a disconnect. Give
  it a "Back to menu" button that awaits `Summer.client.leave()`, then offers
  "Play again" (`find_match` again).
- Hosted, completing the World ends every Session and Summer stops the server,
  so clients get `server_disconnected`. Under Local Play the World completes
  but clients stay connected until they leave or Local Play stops.

### 4. Close the World

- **Match-scoped World** (`"lifetime": "match_scoped"`, the project skill's
  default): conclude, then `Summer.authority.world.complete(reason)`. This
  permanently ends the World; Summer stops the server. Completing before a
  successful conclusion fails with `settlement_required`.
- **Persistent or multi-match World**: conclude, then
  `Summer.authority.match.complete_delivery()`. Match-bound Sessions end,
  World-bound Sessions stay, and the World keeps serving. Never call
  `world.complete()` on a World that should keep running.
- `draining(deadline_unix)` on the World means Summer is shutting the server
  down (maintenance). Conclude or save before the deadline
  (`skill/summer-world-saves`).

A match that never concludes holds its players until the World is stopped;
every match needs an ending, including "everyone else left".

### 5. Test it with Local Play

```
summer_project_setting name="summer/local_play/players" value=2
summer_play
summer_get_diagnostics
summer_stop
```

Make one player win. Expect, in order: the authority's conclusion succeeds,
with a settlement of deterministic test ratings (system `deterministic-v1`);
every client receives `match_result` with its own outcome and `rating_state`
`RATING_STATE_PENDING` on a rated queue; about 3 seconds later the authority
logs `session_left` with reason `match_complete` for each player and
`world.complete()` succeeds. `rating_committed` does not fire locally, and
clients stay connected until they leave.

## Checklist

- [ ] There is exactly one place that ends the match, guarded so it runs once.
- [ ] Outcomes cover every outcome-eligible participant, including those who left (`MATCH_OUTCOME_ABANDON`).
- [ ] Team queues give a whole team the same outcome.
- [ ] A retryable conclusion failure is retried with identical arguments.
- [ ] Clients show `match_result`, and `rating_committed` when it arrives.
- [ ] Match-scoped Worlds call `world.complete()` after concluding; persistent Worlds call `match.complete_delivery()`.
- [ ] Local Play shows the result on every client, and "Back to menu" leaves cleanly.

## Common mistakes

| Don't | Do | Why |
|---|---|---|
| Decide the winner on a client | Decide on the authority and conclude there | Only the authority's outcome is settled |
| Build outcomes from players still connected | Every Session from `session_joined`, leavers as `MATCH_OUTCOME_ABANDON` | Leavers stay on the roster; a missing one fails `invalid_roster` |
| Key outcomes by `Summer.authority.context.participants` sessions or copied ids | The exact Session objects from `session_joined` | Copies are rejected with `invalid_roster` |
| Wait for `server_disconnected` to show results | Show results on `match_result` | Local Play keeps clients connected after completion |
| Send results or ratings to clients yourself | Let `Summer.client.ratings` deliver them | Each player gets their own result privately; the authority never relays account data |
| Retry a conclusion with changed outcomes | Retry with identical arguments | A match settles once; divergent retries are refused |
| `world.complete()` in a persistent World | `match.complete_delivery()` | `complete()` ends the World for good |
| Call `world.complete()` before concluding | Conclude, show results, then complete | Completion ends every Session |
| End the match when one player disconnects | Wait for `session_left` | A disconnect keeps the seat for the reconnect window |

## See also

- `skill/summer-matchmaking` — queues and teams that the outcome refers to
- `skill/summer-leaderboards` — ratings and `authority_v1` rating moves
- `skill/summer-world-saves` — persistent Worlds that outlive a match
- `skill/multiplayer-testing` — running bots through a whole match
