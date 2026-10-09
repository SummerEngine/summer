---
name: summer-analytics
description: "Send game events to Summer analytics from the authority or client: fire-and-forget, never blocking gameplay."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: multiplayer-and-networking
user-invocable: true
allowed-tools: Read Grep Edit Write summer_get_script_errors summer_play summer_stop summer_get_diagnostics summer_open
paths: ["**/*.gd"]
---

# /summer-analytics — game events you can chart later

## Overview

Summer analytics stores named events, such as `level_completed` or
`coin_collected`, for the creator to query in Studio. There are two ways in:

| Captured from | Call | What it means |
|---|---|---|
| The player's client | `Summer.client.analytics.capture(name, properties)` | An **untrusted** observation from that player's device. Summer attaches the player, game and build; you never pass ids. |
| The authority | `Summer.authority.analytics.capture(name, properties)` | An observation about this World's runtime. It describes the server, not a player or a match. |

Analytics is for **looking at** your game, never for running it:

- Capture returns immediately.
- Gameplay never waits for capture and never depends on its result.
- **Capture is never retried.** An `unavailable` result may already have stored the event, and capturing again records a second event.

**Where it works:** hosted only. Under Local Play both calls complete with
`ok == false` and code `unavailable`, and nothing is stored. Also print each
event while testing, so you can check it in the logs.

## Steps

### 1. Choose a small set of events

Name events after things that happened, in the past tense:
`match_started`, `coin_collected`, `tutorial_step_completed`.

- **Names**:
  - 1 to 64 characters, matching `^[A-Za-z][A-Za-z0-9_.:-]{0,63}$`.
  - Case-sensitive, and never starting with `summer.`.
- **Never put changing values in names** (`coin_7_collected`). Put them in properties: `{"coin": 7}`.
  - New event names are rate-limited per player and per game per day.
  - Known names keep working after that limit.
- **Properties** are a JSON `Dictionary`:
  - at most 64 scalar values;
  - nesting at most 4 deep;
  - property names up to 128 bytes;
  - one event at most 16 KiB.
- **Never send personal data or secrets.** Names such as `email`, `password`, `phone`, `address`, `ip_address` and `*_token` are rejected at any depth, as is anything starting with `$summer_`.

Capture authoritative facts on the authority, where the game decided them.
Capture interface facts on the client: menu opened, tutorial step shown,
settings changed.

### 2. Add a fire-and-forget helper

Authority, in `authority/main.gd`:

```gdscript
## Fire-and-forget: gameplay never waits on analytics, and a failure is
## logged once, never retried (a retry would count the event twice).
var _analytics_warned := false

func _track(event: String, properties: Dictionary = {}) -> void:
	print("ANALYTICS ", event, " ", JSON.stringify(properties))
	var capture := Summer.authority.analytics.capture(event, properties)
	var result: SummerResult = await capture.get_result_or_completed_signal()
	if not result.ok and not _analytics_warned:
		_analytics_warned = true
		push_warning("analytics unavailable: %s" % result.code)
```

Client, in `client/main.gd`, the same shape with the client facade:

```gdscript
var _analytics_warned := false

func _track(event: String, properties: Dictionary = {}) -> void:
	print("ANALYTICS ", event, " ", JSON.stringify(properties))
	var capture := Summer.client.analytics.capture(event, properties)
	var result: SummerResult = await capture.get_result_or_completed_signal()
	if not result.ok and not _analytics_warned:
		_analytics_warned = true
		push_warning("analytics unavailable: %s" % result.code)
```

### 3. Call it without awaiting

Call `_track(...)` as a statement and do **not** `await` it, so the caller
continues immediately. For example, in the authority's `_collect`, after the
coin is applied:

```gdscript
	_track("coin_collected", {"coin": coin, "players": seat_of.size()})
```

On the client, after a menu choice:

```gdscript
	_track("menu_opened", {"from": "pause"})
```

### 4. Read the results

Open the game's analytics in Studio: `summer_open` with target `game` and
params `gameId` (your game's id) and `section: "analytics"`. Events show up
there after a short delay.

## Result codes

| Code | Meaning | What to do |
|---|---|---|
| `unavailable` | No analytics service here (Local Play, an old Host), or a lost answer | Nothing. Do not capture again. |
| `capacity_exceeded` | More than 32 captures are pending | Capture less often; batch counts into one event |
| `analytics_storage_limit_exceeded` | The game's analytics quota is used up | Stop capturing this event type; final for now |
| `not_configured` | An older Supervisor without authority analytics | Nothing |

Every failure is final: none of them asks you to capture again.

## Checklist

- [ ] Every capture is a plain `_track(...)` call; no gameplay code awaits it.
- [ ] Event names are fixed strings; values live in properties.
- [ ] No personal data, tokens or free-typed player text in properties.
- [ ] Authority-decided facts (won, collected, bought) are captured on the authority.
- [ ] Under Local Play the game plays normally while captures report `unavailable`.

## Common mistakes

| Don't | Do | Why |
|---|---|---|
| `await _track(...)` in gameplay code | Call it and move on | A slow or failing capture would stall the game |
| Capture again after `unavailable` | Log once and drop it | It may already be stored; a second capture double-counts |
| `coin_%d_collected` names | `coin_collected` with `{"coin": 7}` | New names are rate-limited; values belong in properties |
| Trust client events for rewards or rankings | Decide on the authority; capture there too | Client events are untrusted observations |
| Put emails, ids or tokens in properties | Summer attaches player and game identity itself | Blocked names are rejected; personal data must not be collected |
| Make gameplay depend on analytics working | Treat it as optional | It is unavailable locally and may be unavailable hosted |
| Start names with `summer.` | Your own names | That namespace is reserved |

## See also

- `multiplayer` — where the client and the authority run
- `multiplayer-state` — the authority's Command handlers, where most events happen
- `summer-match-results` — results and ratings, which Summer records itself
