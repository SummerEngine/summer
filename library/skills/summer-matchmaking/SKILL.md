---
name: summer-matchmaking
description: "Get players into matches with Summer matchmaking: queues, teams, accept prompts, join progress and failures."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: multiplayer-and-networking
user-invocable: true
allowed-tools: Read Grep Edit Write summer_read_file summer_replace_text summer_write_file summer_get_script_errors summer_project_setting summer_play summer_stop summer_get_diagnostics
paths: ["summer.build.json", "client/**/*.gd", "authority/**/*.gd", "client/**/*.tscn"]
---

# /summer-matchmaking — queues, teams and the way into a match

## Overview

A **queue** is a game mode players search in: "casual 2–8", "duel 1v1",
"ranked 2v2". You declare queues in `summer.build.json`; Summer matchmaking
groups searching players, reserves a server for them, and every player's
`Summer.client.join(SummerJoinTarget.queue(...))` completes in the same World.
The authority then reads each player's team from the verified Session.

There is no lobby object, invite code or server browser. Friends who want to
play together use a party (`summer-parties`), which enters a queue as one group.

Where it works:

| Piece | Local Play | Hosted |
|---|---|---|
| Joining a queue, progress, failures | Yes: players are placed at once | Yes |
| Teams (`get_participant(session).team`) | Yes: round-robin in roster order | Yes: balanced by rating, parties kept together |
| Accept/Decline prompt | No: no proposal happens | Yes, when the queue declares `acceptance` |
| Rating-based grouping | No | Yes |

This skill extends the Courtyard game from `multiplayer-project` and
`multiplayer-state`. Its client already joins `Game.QUEUE` and sends a
`join` Command; its authority publishes `match_doc`.

## Steps

### 1. Declare the queues

Each queue in `runtime.queues` of `summer.build.json` names the
WorldDefinition its matches run. A casual mode and a 1v1 rated duel:

```json
"queues": [
  { "name": "courtyard", "minPlayers": 2, "maxPlayers": 8, "worldDefinition": "courtyard", "policy": "fifo", "transport": "enet" },
  {
    "name": "duel", "minPlayers": 2, "maxPlayers": 2, "worldDefinition": "courtyard",
    "policy": "rating", "ratingSystemRef": "elo_v1",
    "teams": { "count": 2, "size": 1 },
    "acceptance": { "mode": "all", "ttl": "20s" },
    "searchTtl": { "min": "30s", "default": "2m", "max": "5m" },
    "transport": "enet"
  }
]
```

The fields Summer accepts, and their rules:

| Field | Meaning | Rules |
|---|---|---|
| `name` | The id clients join | Unique; ASCII letters, digits, `_ . : -` |
| `minPlayers` / `maxPlayers` | Players per match | `minPlayers` ≥ 1, `maxPlayers` ≥ `minPlayers`. Measured support is up to 16 per match |
| `worldDefinition` | The WorldDefinition's `definition_id` | Required; every WorldDefinition must be used by a queue |
| `policy` | `fifo` (first come) or `rating` (group by skill) | `rating` needs `ratingSystemRef`; `fifo` must not declare one |
| `ratingSystemRef` | `elo_v1` (Summer rates two sides) or `authority_v1` (your authority reports rating moves) | See `summer-leaderboards` |
| `teams` | `{count, size}`: fixed sides, such as 2v2 = `{2, 2}` | `count` 2..64, `size` 1..16, `minPlayers` = `maxPlayers` = count × size; `elo_v1` needs exactly 2 teams |
| `acceptance` | `{"mode": "all", "ttl": "20s"}` asks every player to accept; `{"mode": "none"}` skips it | `ttl` required with `all`, forbidden with `none` |
| `searchTtl` | `{min, default, max}` search lifetime | Go durations (`30s`, `2m`); min ≤ default ≤ max |
| `regions` | Regions this queue may use | Omit to allow all |
| `transport` | `enet` (UDP, default) or `ws` (WebSocket) | |

Don't add `lobby` fields or `backfill`: Summer rejects both when you publish.
Teams and acceptance need `runtime.interfaces.multiplayer` 5 or higher; the
project skill's `summer.build.json` declares 6.

### 2. Search, with progress the player can see

Add a status label and two hidden buttons to the client scene,
`client/main.tscn` (position them in the editor as you like):

```
[node name="Hud" type="CanvasLayer" parent="."]

[node name="Status" type="Label" parent="Hud"]

[node name="Accept" type="Button" parent="Hud"]
visible = false
text = "Accept"

[node name="Decline" type="Button" parent="Hud"]
visible = false
text = "Decline"

[connection signal="pressed" from="Hud/Accept" to="." method="_on_accept_pressed"]
[connection signal="pressed" from="Hud/Decline" to="." method="_on_decline_pressed"]
```

In `client/main.gd`, replace the join in `_ready()`, from `var join :=`
through the `if not joined.ok:` block, with a call to `find_match`:

```gdscript
	var joined := await find_match(Game.QUEUE)
	if not joined.ok:
		return
```

and add the matchmaking functions:

```gdscript
var proposal: SummerMatchmakingProposal   # a found match waiting for Accept/Decline


## Searches `queue` until the player is in a match, showing progress.
func find_match(queue: StringName) -> SummerResult:
	var join := Summer.client.join(SummerJoinTarget.queue(queue))
	join.progress_changed.connect(_on_progress)
	join.acceptance_required.connect(_on_match_found)
	var joined: SummerResult = await join.get_result_or_completed_signal()
	proposal = null
	$Hud/Accept.hide()
	$Hud/Decline.hide()
	show_status("" if joined.ok else join_failure_text(joined))
	return joined


## Stages carry no tickets or addresses, so they are safe to show.
func _on_progress(progress: SummerJoinProgress) -> void:
	match progress.stage:
		SummerJoinProgress.STAGE_RESOLVING:
			show_status("Searching for players… %ds" % (progress.elapsed_msec / 1000))
		SummerJoinProgress.STAGE_RESERVED, SummerJoinProgress.STAGE_PROPOSED:
			show_status("Match found")
		SummerJoinProgress.STAGE_LAUNCHING, SummerJoinProgress.STAGE_CONNECTING, SummerJoinProgress.STAGE_ADMITTING:
			show_status("Joining the match…")
		SummerJoinProgress.STAGE_RECONNECTING:
			show_status("Reconnecting…")


func show_status(text: String) -> void:
	$Hud/Status.text = text
```

### 3. Accept or decline a found match

With `"acceptance": {"mode": "all"}`, Summer reserves a server first, then asks
every player. The match starts only when all accept before the deadline. The
engine never decides for the player: connect `acceptance_required`, or the
join waits until the proposal expires.

```gdscript
## Summer reserved a server for these players. The match starts only when
## everyone accepts before the deadline.
func _on_match_found(found: SummerMatchmakingProposal) -> void:
	proposal = found
	var seconds_left := maxi(0, (found.accept_by_unix_msec - int(Time.get_unix_time_from_system() * 1000.0)) / 1000)
	show_status("Match found! Accept within %ds" % seconds_left)
	$Hud/Accept.show()
	$Hud/Decline.show()


func _on_accept_pressed() -> void: _decide(true)
func _on_decline_pressed() -> void: _decide(false)


func _decide(accept: bool) -> void:
	if proposal == null or proposal.is_decided():
		return
	var decided: SummerResult = proposal.accept() if accept else proposal.decline()
	if not decided.ok:
		show_status(join_failure_text(decided))
	$Hud/Accept.hide()
	$Hud/Decline.hide()
```

After an accept, `find_match` keeps waiting until everyone accepted. A
decline ends it with `proposal_declined`. A game that always accepts (one
"Play" button) connects `acceptance_required` straight to `proposal.accept()`.

### 4. Tell players what went wrong

Every failure is a `SummerResult` with a stable `code` and `retryable`:

```gdscript
## Turns a typed failure into words for the player. `retryable` says whether
## offering "Try again" makes sense.
func join_failure_text(result: SummerResult) -> String:
	match String(result.code):
		"proposal_declined":
			return "You declined the match."
		"proposal_expired":
			return "The match wasn't accepted in time."
		"queue_not_found", "queue_closed":
			return "This mode isn't available right now."
		"capacity_exhausted", "world_full", "world_start_timeout", "region_unavailable":
			return "Servers are busy. Try again in a moment."
		"rate_limited":
			return "Too many tries. Wait a moment."
		"cancelled":
			return ""
	return "Couldn't join. Try again." if result.retryable else "Couldn't join: %s" % result.message
```

Other codes: `proposal_stale` and `proposal_already_decided` (a second
decision), `world_waking` (a persistent World is restoring), `qos_stale`,
`platform_error`, and `unavailable` (Local Play hosts a different queue).

### 5. Cancel the search, or leave

`Summer.client.leave()` cancels a search in flight, or leaves the current
match. Await it before quitting the game, so the platform knows the player is
gone and doesn't hold a seat for them:

```gdscript
## Stops searching, or leaves the current match. Await it before quitting.
func leave_match() -> void:
	var left: SummerResult = await Summer.client.leave().get_result_or_completed_signal()
	if not left.ok:
		push_warning("leave: %s" % left.code)
```

To offer "Play online" only when it can work, read
`Summer.client.matchmaking.availability.hosted_sessions_available` (and
`hosted_unavailable_reason`) before showing the button.

### 6. Read teams and the queue on the authority

The authority learns each player's team from the verified Session. In
`authority/main.gd`, give `match_doc` a `"teams": {}` entry and add this to
`_join` just before `request.accept(...)`:

```gdscript
	# The team matchmaking seated this player on: 0..count-1, or -1 without teams.
	var participant := Summer.authority.match.get_participant(session)
	var team := participant.team if participant != null else -1
	match_doc.teams[session.player.display_name] = team
	match_group.reset(Game.pack(match_doc))
```

Players learn teams only from what the authority publishes, here the shared
match document. `Summer.get_world().queue` on the authority names the queue
this match came from, so one authority scene can serve several modes.

### 7. Test it with Local Play

Local Play stands in for one queue at a time: the first one declared, or the
one you name. In the editor and with `summer_play`, name it with the
`summer/local_play/queue` project setting:

```
summer_project_setting key="summer/local_play/queue" value="duel"
summer_project_setting key="summer/local_play/players" value=2
summer_play
summer_get_diagnostics
summer_stop
```

A terminal run ignores that setting; pass the queue instead:
`<summer> --path . --summer-local-play 2 --summer-local-play-queue duel --summer-local-play-smoke`.

- The client must join the queue Local Play stands in for. Another queue
  fails with `unavailable`: "Local Play is hosting queue 'courtyard'. Start
  Local Play with queue 'duel' to test that queue."
- Players are placed at once: progress goes straight to `STAGE_CONNECTED`,
  with no search and no Accept/Decline.
- A team queue seats players round-robin in roster order (player-1 on team 0,
  player-2 on team 1, and so on), whatever order they connect in.
- `Summer.client.matchmaking.availability` reports hosted sessions as
  available.

Test the accept prompt and rating-based grouping on a hosted staging build.

## Checklist

- [ ] Every queue names a WorldDefinition; teams queues have `minPlayers` = `maxPlayers` = count × size.
- [ ] The client shows search progress and a readable message for each failure code.
- [ ] Queues with `acceptance` show Accept/Decline with the deadline; nothing auto-accepts unless the game means to.
- [ ] Cancel and quit both await `Summer.client.leave()`.
- [ ] The authority reads `get_participant(session).team` and publishes teams to players.
- [ ] Local Play with `summer/local_play/queue` set runs each queue you declared.

## Common mistakes

| Don't | Do | Why |
|---|---|---|
| Build a lobby, invite codes or join-by-IP | Queues, plus parties for friends | Summer has no lobby object; invite, follow, portal and resume joins return `unsupported_placement` |
| Ignore `acceptance_required` on a queue with `acceptance` | Show Accept/Decline, or connect it to `proposal.accept()` | The engine never accepts for the player; the join waits until `proposal_expired` |
| `teams` with `minPlayers` ≠ count × size | Equal sizes: 2v2 is 4 and 4 | Summer rejects the queue when you publish |
| Read the team on the client from matchmaking | Publish it from the authority | Clients only learn teams through the game's own state |
| Join `courtyard` while Local Play stands in for `duel` | Set `summer/local_play/queue` to the queue the client joins | Local Play hosts one queue per run; the other fails `unavailable` |
| Quit right after "Cancel" | Await `Summer.client.leave()` first | The search may keep holding a ticket for the player |
| Show raw `result.message` for known codes | Map codes to your own words | Codes are stable; messages are diagnostics |

## See also

- `multiplayer` — how Summer multiplayer fits together
- `summer-match-results` — ending a match and reporting who won
- `summer-leaderboards` — ratings and leaderboards for rated queues
- `summer-parties` — friends entering a queue together
- `multiplayer-testing` — Local Play options and bots
