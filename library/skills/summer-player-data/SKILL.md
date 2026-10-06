---
name: summer-player-data
description: "Save a player's progress so it follows them to every match: authority load and commit, autosave, safe retries."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: multiplayer-and-networking
user-invocable: true
allowed-tools: Read Grep Edit Write summer_get_script_errors summer_project_setting summer_play summer_stop summer_get_diagnostics
paths: ["**/*.gd", "world.json", "summer.build.json"]
---

# /summer-player-data — progress that follows the player

## Overview

Player data is what Summer remembers about **one player in one game**:
coins, unlocks, level, settings. It belongs to the player, not to a match.
A match World ends and its state is gone. The player's data comes back in
the next match, on any server and any device.

- **Only the authority writes it.** Clients never write player data.
- **Two slots per player**, written separately:
  - `public`: the authority reads and writes it. The player's own client can read it too, for example to show coins in the menu.
  - `secret`: only the authority reads or writes it, for hidden values such as anti-cheat counters or hidden ratings. It never reaches a client.
- Nobody else can read either slot.
- **Each slot is one JSON object of at most 64 KiB.**
  - Allowed values: `bool`, `int`, finite `float`, `String`, `Array` and `Dictionary` with `String` keys, nested at most 16 deep.
  - `Vector3`, `Color` and `null` fail before anything is sent.
  - Whole numbers load back as `int`.

**Where it works:**

| | Local Play | Hosted |
|---|---|---|
| Authority `load` / `commit_public` / `commit_secret` | Yes: a file store under `user://summer_local_player_data/<game id>/<persona>/` | Yes |
| Client `Summer.client.player_data.load()` (own public slot) | Yes, from the same files | Yes |

Local Play's store keeps the latest value plus five earlier revisions, with
the same validation and `save_id` rules as hosted. Delete a persona's folder
to start that player fresh. Only hosted play proves durability.

This skill extends the game from `skill/multiplayer-project` and
`skill/multiplayer-state`: the authority's `_join` Command handler, the
private `mine` State group, and the `wallets` it keeps.

## Steps

### 1. Decide what to save

Save only what must outlive the match, and save it as a plain document:

| Save it | Don't |
|---|---|
| Coins, unlocks, best score, cosmetics owned, settings | Positions, health, the round's score: that is match state |
| A secret anti-cheat counter (`commit_secret`) | Anything another player needs to see: that is a State group |

Keep values that must change together in **one** slot: there is no
transaction across the two slots.

### 2. Load when the player arrives

The authority starts loading on `session_joined`, before the client's
`join` Command arrives. Add to `authority/main.gd`:

```gdscript
const AUTOSAVE_SECONDS := 5.0
## session_id -> {"session", "state": loading|ready|failed|superseded, "data",
## "dirty", "saving", "saves", "save_prefix", "left"}
var profiles := {}
```

In `_ready()`, next to the other `world` signals, before `Summer.initialize`
(connect `session_joined` only once if `skill/summer-match-results` already
did):

```gdscript
	world.session_joined.connect(_on_session_joined)
	world.draining.connect(func(_deadline: int) -> void: _save_all())
	var autosave := Timer.new()
	autosave.wait_time = AUTOSAVE_SECONDS
	autosave.timeout.connect(_save_all)
	add_child(autosave)
	autosave.start()
```

If `_on_session_joined` already exists (`skill/summer-match-results` adds
one), put this body at its end instead of defining it twice.

```gdscript
## Reads the player's saved progress as soon as their Session arrives.
func _on_session_joined(session: SummerSession) -> void:
	# save_ids must never repeat for this player, in this World or any later one.
	var prefix := str(int(Time.get_unix_time_from_system() * 1000.0))
	var profile := {"session": session, "state": "loading", "data": {}, "dirty": false, "saving": false, "saves": 0, "save_prefix": prefix, "left": false}
	profiles[session.session_id] = profile
	for attempt in 3:
		var loaded := Summer.authority.player_data.load(session)
		var result: SummerResult = await loaded.get_result_or_completed_signal()
		if result.ok:
			profile.data = loaded.public_record.data
			profile.state = "ready"
			return
		if not result.retryable:
			break
		await get_tree().create_timer(1.0 + attempt).timeout
	# Unknown is not empty: never start a fresh save over data you could not read.
	profile.state = "failed"
	push_warning("player data load failed for %s" % session.session_id)
```

`loaded.secret_record.data` holds the secret slot. A slot that was never
written has `exists == false` and empty `data`.

### 3. Make `join` wait for the load

In `_join`, right after the seat check:

```gdscript
	# The client retries "join" while this player's saved progress loads.
	var profile: Dictionary = profiles.get(session.session_id, {"state": "loading"})
	if profile.state != "ready":
		request.refuse(&"loading" if profile.state == "loading" else &"profile_unavailable")
		return
```

Start the player from their saved values instead of zero, in the block that
creates their private group:

```gdscript
	if not mine_groups.has(session.session_id):
		wallets[session.session_id] = int(profile.data.get("coins", 0))
		mine_groups[session.session_id] = spawner.create_state_group(Game.MINE, StringName("mine%d" % seat), Game.pack({"coins": wallets[session.session_id]}), null, null, session)
```

On the client, in `client/main.gd`, retry `join` while the answer is
`loading`:

```gdscript
	var entered := await command({"c": "join"})
	while not entered.ok and entered.error == "loading":
		await get_tree().create_timer(0.5).timeout
		entered = await command({"c": "join"})
```

`profile_unavailable` means the load failed. Show "Couldn't load your
progress", and do **not** let the player play on a blank profile that would
overwrite their real one.

### 4. Mark changes, autosave, flush on leave

Wherever progress changes (here, after the wallet changes in `_collect`):

```gdscript
	_progress_changed(session.session_id, {"coins": wallets[session.session_id]})
```

At the top of `_on_session_left`:

```gdscript
	_player_left(session.session_id)
```

The saving code:

```gdscript
## Records new progress. The autosave writes it a few seconds later.
func _progress_changed(session_id: String, changes: Dictionary) -> void:
	var profile: Dictionary = profiles.get(session_id, {})
	if profile.get("state", "") == "ready":
		profile.data.merge(changes, true)
		profile.dirty = true


func _save_all() -> void:
	for session_id in profiles.keys():
		_save(session_id)


## One commit per player at a time. Each new save gets a new save_id; a retry
## of the same save reuses its id and data, so it is never applied twice.
func _save(session_id: String) -> void:
	var profile: Dictionary = profiles.get(session_id, {})
	if profile.is_empty() or profile.saving or not profile.dirty or profile.state != "ready":
		return
	profile.saving = true
	while profile.dirty and profile.state == "ready":
		profile.dirty = false
		profile.saves += 1
		var save_id := "%s-%d" % [profile.save_prefix, profile.saves]
		if not await _commit(profile, save_id, profile.data.duplicate(true)):
			break
	profile.saving = false
	if profile.left and not profile.dirty:
		profiles.erase(session_id)   # gone and fully saved


func _commit(profile: Dictionary, save_id: String, data: Dictionary) -> bool:
	for attempt in 4:
		var commit := Summer.authority.player_data.commit_public(profile.session, save_id, data)
		var result: SummerResult = await commit.get_result_or_completed_signal()
		if result.ok:
			return true
		if result.code == &"player_data_superseded":
			profile.state = "superseded"   # a newer Session owns this player now
			return false
		if not result.retryable:
			push_error("player data save %s failed: %s" % [save_id, result.code])
			return false
		await get_tree().create_timer(1.0 + attempt).timeout   # same save_id, same data
	profile.dirty = true   # still unsaved; the next autosave tries again
	return false


## Commits stay open after a player leaves, so flush their progress now.
func _player_left(session_id: String) -> void:
	var profile: Dictionary = profiles.get(session_id, {})
	if profile.is_empty():
		return
	profile.left = true
	if profile.dirty:
		_save(session_id)
	elif not profile.saving:
		profiles.erase(session_id)
```

Why it is shaped this way:

- **Autosave, not only save-on-leave.** A crash delivers no signal. With a 5 s autosave a crash loses at most 5 s.
- **One commit per player and slot at a time.** A second concurrent commit fails with `operation_in_progress`.
- **A new `save_id` for each new save, the same `save_id` for a retry.**
  - Resending a `save_id` with the same data returns the original revision (`commit.replayed`).
  - The same `save_id` with different data fails with `player_data_save_id_conflict`.
  - Build the id from the time the Session joined plus a counter. Session ids are not enough: Local Play reuses them on every run.
- **`player_data_superseded` is final.** The player joined a newer World, and only their newest Session may write.
- **`draining`** fires before the World shuts down. Commits are still accepted until the stop deadline, so flush everyone then.
- **Under Local Play a player who quits only disconnects.** Their seat is held and `session_left` arrives when the World ends, so the autosave is what saves them.

Use `commit_secret` in the same way for the secret slot. Each slot has its own
revisions and `save_id` space.

### 5. Show saved progress in the menu (optional)

The client reads its own public slot, even before joining a match:

```gdscript
## The client can read its own public slot, for example to show progress in
## the menu. It never writes player data.
func _show_saved_progress() -> void:
	var saved := Summer.client.player_data.load()
	var result: SummerResult = await saved.get_result_or_completed_signal()
	if result.ok:
		$Menu/Coins.text = "Coins: %d" % int(saved.public_record.data.get("coins", 0))
```

### 6. Keep the publish checks passing

The source-graph check in `skill/multiplayer-publish` (step 4b) flags every
call ending in `load(` without a string literal inside, so
`Summer.authority.player_data.load(session)` and
`Summer.client.player_data.load()` report
`SUMMER_COMPOSITION_DYNAMIC_PATH_UNDECLARED`. They load no file. Declare one
dependency edge per file that makes such a call, in `source-domains.json`:

```json
  "dependencies": [
    { "from": "authority/main.gd", "to": "network/game.gd" },
    { "from": "client/main.gd", "to": "network/game.gd" }
  ]
```

### 7. Test persistence: run Local Play twice

Run the same session twice. Local Play personas (`player-1`, `player-2`)
keep their files between runs, so run 2 must start where run 1 ended.

```
summer_project_setting name="summer/local_play/players" value=2
summer_play
summer_get_diagnostics
summer_stop
summer_play
summer_get_diagnostics
summer_stop
```

From a terminal: `<summer> --path . --summer-local-play 2 --summer-local-play-headless --summer-local-play-timeout 20 -- --bot={client}`,
twice (see `skill/multiplayer-testing` for bot mode). Print markers such as
`print("PROFILE_LOADED coins=", ...)` and `print("SAVED ", save_id, " revision=", commit.revision)` while testing, then check them.

Files: `~/Library/Application Support/Godot/app_userdata/<project name>/summer_local_player_data/<game id>/<persona>/public.json`
on macOS (the project's `user://` folder elsewhere). Delete a persona's
folder to start over.

## Checklist

- [ ] Run 1: a player earns something, and the authority logs a successful save within the autosave interval.
- [ ] Run 2: the authority loads the saved value at join; the client menu shows it.
- [ ] A load failure refuses `join` with `profile_unavailable`; nothing is written over the old data.
- [ ] No `player_data_save_id_conflict` in the logs, even on the second run.
- [ ] The saved document stays well under 64 KiB at its largest. Test the maximum.

## Common mistakes

| Don't | Do | Why |
|---|---|---|
| Write player data from the client | Commit on the authority | Clients have no write API; the authority is the trust boundary |
| Treat a failed load as a new player | Refuse `join` with `profile_unavailable` | The next save would wipe their real progress |
| Save only when the player leaves | Autosave dirty players every few seconds, and flush on `session_left` and `draining` | Crashes deliver no signal |
| Reuse one `save_id` for new data | A new id per save, the same id per retry | Same id plus different data is `player_data_save_id_conflict` |
| Build `save_id` from the session id alone | Join time plus a counter | Local Play reuses session ids across runs |
| Start a second commit while one is pending | One commit per player and slot at a time | The second fails with `operation_in_progress` |
| Keep retrying after `player_data_superseded` | Stop saving through that Session | A newer World owns the player now |
| Store `Vector3`, `Color` or `null` | Plain JSON: numbers, strings, arrays, dictionaries | Unsupported types fail with `player_data_unsupported_type` |
| Save the match (positions, round score) | Save only what outlives the match | The World ends; `skill/summer-world-saves` covers Worlds that persist |
| Truncate data that grew past 64 KiB | Refuse to grow; test the maximum size | `player_data_too_large` rejects the whole commit |

## See also

- `skill/multiplayer-state` — the wallet and private State group this skill saves
- `skill/summer-world-saves` — saving a whole persistent World instead of one player
- `skill/multiplayer-testing` — bots and repeated Local Play runs
- `skill/summer-leaderboards` — scores other players can see
