---
name: summer-world-saves
description: "Keep a persistent Summer World between restarts: checkpoint saves, restore before join, the final save."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: multiplayer-and-networking
user-invocable: true
allowed-tools: Read Grep Edit Write summer_get_script_errors summer_project_setting summer_play summer_stop summer_get_diagnostics
paths: ["**/*.gd", "world.json", "summer.build.json"]
---

# /summer-world-saves — a World that is still there tomorrow

> **Preview.**
> - Verified in Local Play: restore of a new World, commit and receipt.
> - **Not** verified: restoring after a real restart. Local Play keeps saves in memory only, so only hosted play proves it.
> - Persistent Worlds need hosting support for your game. Check that it is available before you promise it to players.

## Overview

Most Summer Worlds are **match-scoped**: the match ends and its state is gone.
A **persistent** World is a place players come back to, such as a shared
base, a farm or a realm. Its authority can stop for maintenance, a crash or
a move. A new authority then restores the World from its last save.

| Keep | Use |
|---|---|
| What belongs to the place: built walls, chests, the coins left on the ground | **World save** (this skill) |
| What belongs to a player: their coins, unlocks, level | **Player data** (`skill/summer-player-data`) |

The engine never serializes nodes for you. The game decides what one save
holds. It must be **one consistent cut**: if an item moves from a chest into
an inventory, both sides go in the same save.

This skill extends the Courtyard game from `skill/multiplayer-state`: its
`match_doc` (the coins still on the ground, and the scoreboard) becomes the
World's saved state.

## Steps

### 1. Declare a persistent World

In `world.json`, change these fields and keep everything else:

```json
{
  "lifetime": "persistent",
  "settlement": { "mode": "none" },
  "persistence": {
    "mode": "checkpoint",
    "recovery_point_seconds": 60,
    "snapshot_schemas": ["courtyard.v1"],
    "migration_ids": []
  },
  "lifecycle": {
    "reconnect_seconds": 30,
    "drain_seconds": 120,
    "transfer": "disabled",
    "completion_owner": "world"
  }
}
```

- `recovery_point_seconds` (1 to 3600) is the most play you accept losing in a crash. Commit at least that often.
- `snapshot_schemas`: exactly one name for your save format in this release. There are no migrations.
- `drain_seconds`: 60 to 300.
- A save holds at most **16 MiB**.

### 2. Restore before anyone joins

Restore runs right after `Summer.initialize`, **before** waiting for
`binding_ready`. Players are admitted only after `finish_restore` succeeds,
so restore is part of becoming ready. Add to `authority/main.gd`:

```gdscript
const SAVE_SCHEMA := "courtyard.v1"      # the WorldDefinition's snapshot_schemas entry
const CHECKPOINT_SECONDS := 30.0         # at most the WorldDefinition's recovery_point_seconds
var saves: SummerAuthorityWorld          # Summer.authority.world: this World's save slot
var save_revision := "0"
var save_sequence := 0
var save_op: SummerWorldSaveOperation    # the commit in flight, if any
var restored := false
var world_dirty := false
var acknowledged: Array[String] = []
```

In `_ready()`, between `Summer.initialize` and the `binding_ready` wait:

```gdscript
	# Restore before waiting for binding_ready: players are admitted only
	# after the World confirms its restore.
	if not await _restore_world():
		push_error("could not restore this World; not starting")
		return
	var checkpoints := Timer.new()
	checkpoints.wait_time = CHECKPOINT_SECONDS
	checkpoints.timeout.connect(_on_checkpoint_timer)
	add_child(checkpoints)
	checkpoints.start()
	if not world.is_ready():
		await world.binding_ready
```

Create the shared `match` State group **after** the restore, so it starts
from the restored document.

```gdscript
## Loads the World's last checkpoint, or starts fresh when it has none.
func _restore_world() -> bool:
	saves = Summer.authority.world
	saves.save_requested.connect(_on_save_requested)
	# Local Play binds the World on the frame after initialize; let that
	# frame pass before loading.
	await get_tree().process_frame
	var loading := saves.load_save()
	var result: SummerResult = await loading.get_result_or_completed_signal()
	if not result.ok:
		return false   # never treat a failed load as an empty World
	var saved := loading.get_save()
	if saved.has_save():
		var doc: Variant = JSON.parse_string(saved.get_data().get_string_from_utf8())
		if not doc is Dictionary or not doc.has_all(["coins", "scores"]):
			return false
		match_doc = doc
	save_revision = saved.get_revision()
	save_sequence = int(saved.get_state_sequence())
	result = await saves.finish_restore(saved).get_result_or_completed_signal()
	if not result.ok:
		return false
	restored = true
	# A save request may have arrived before this point.
	var pending := saves.get_snapshot_request_id()
	if not pending.is_empty():
		_on_save_requested(pending, saves.get_snapshot_deadline_unix_msec())
	return true
```

**A failed or corrupt load must stop the World.** Starting fresh instead
would overwrite the players' place with an empty one on the next save.

### 3. Checkpoint while playing

Mark the World dirty wherever saved state changes. Here that is after
`match_group.reset(...)` in `_collect`:

```gdscript
	world_dirty = true
```

```gdscript
func _on_checkpoint_timer() -> void:
	if world_dirty:
		_checkpoint()


## Commits one consistent copy of the World. One save at a time; a retry
## resends exactly the same five arguments.
func _checkpoint() -> SummerWorldSaveReceipt:
	while save_op != null:
		await save_op.get_result_or_completed_signal()
	world_dirty = false
	save_sequence += 1
	var sequence := str(save_sequence)
	var save_id := "cut-" + sequence
	var bytes := JSON.stringify(match_doc).to_utf8_buffer()
	var expected := save_revision
	for attempt in 3:
		save_op = saves.commit_save(expected, save_id, SAVE_SCHEMA, bytes, sequence)
		var result: SummerResult = await save_op.get_result_or_completed_signal()
		var receipt := save_op.get_receipt()
		save_op = null
		if result.ok:
			save_revision = receipt.get_revision()
			return receipt
		if not result.retryable:
			# Conflict, corrupt, incompatible or fenced: stop, never overwrite.
			push_error("world save failed: %s" % result.code)
			break
	world_dirty = true
	return null
```

The rules behind it:

- **One save at a time.** `commit_save` takes the revision you expect to replace, so two overlapping saves would conflict.
- **Capture once, retry exactly.**
  - On retryable `world_save_unavailable`, resend the same expected revision, `save_id`, schema, bytes and sequence.
  - A lost reply may hide a commit that already succeeded.
- **The sequence only grows.** It continues from the restored save's `state_sequence`, so `save_id`s never repeat across restarts.
- **Stop on non-retryable codes.** `world_save_conflict`, `world_save_corrupt`, `world_save_incompatible`, `world_restore_required` and `runtime_fenced` mean this authority must not keep writing.

### 4. Answer the final save request

Before Summer stops, restarts or moves the World, it emits `save_requested`
with a deadline. Commit a fresh cut, then acknowledge it with that receipt:

```gdscript
## The platform asks for a final save before it stops or moves this World.
## Commit a fresh cut, then acknowledge it. Never wait for timers or frames
## here: gameplay is frozen while the final save runs.
func _on_save_requested(request_id: String, _deadline_unix_msec: int) -> void:
	if not restored or request_id in acknowledged:
		return
	acknowledged.append(request_id)
	var receipt := await _checkpoint()
	if receipt == null:
		return   # never acknowledge a save that did not commit
	await saves.finish_snapshot(request_id, receipt).get_result_or_completed_signal()
	# This runtime may stop right here. Put nothing important after it.
```

- During the final save, scene processing and timers are frozen; only save operations complete. Never `await` a timer or a frame in this path.
- A crash delivers no request, so periodic checkpoints are still required.
- For a planned shutdown, `saves.shutdown_notice_changed` gives advance notice; a `null` notice means it was cancelled. Use it to warn players ("Server restarts in 5 minutes") and to finish events that are in progress.

### 5. Bring players back to the same World

A player returns to a persistent World by its id:

```gdscript
var join := Summer.client.join(SummerJoinTarget.world(world_id))
var joined: SummerResult = await join.get_result_or_completed_signal()
```

Read the id with `Summer.get_world().world_id` after the first join, and keep
it, for example in the player's public player data. A sleeping World wakes
and restores before the player is admitted.

Never call `saves.complete()` to "save and stop". It ends the World
permanently.

### 6. Test in Local Play

Local Play runs a persistent World with an **in-memory** save store:

- Every run starts with no save, so `has_save()` is false.
- Commits succeed and return receipts.
- Nothing survives the run.

```
summer_project_setting name="summer/local_play/players" value=2
summer_play
summer_get_diagnostics
summer_stop
```

Add a marker after restore, such as `print("WORLD_RESTORED has_save=", saved.has_save())`,
and one after each successful commit. Then check:

- the restore marker appears before any player joins;
- a checkpoint commits after state changes;
- there are no `world_save_*` errors.

Restoring after a real restart can only be proven hosted.

## Checklist

- [ ] `world.json` declares `lifetime: persistent` and a `checkpoint` persistence block with one schema.
- [ ] The authority restores before awaiting `binding_ready`, and a failed load stops it.
- [ ] Checkpoints run at least every `recovery_point_seconds` while the World changes.
- [ ] Only one `commit_save` is in flight; retries reuse all five arguments.
- [ ] `save_requested` commits a fresh cut, then calls `finish_snapshot` with that receipt, without awaiting timers.
- [ ] Player progress lives in player data, not in the World save.

## Common mistakes

| Don't | Do | Why |
|---|---|---|
| Await `binding_ready` before restoring | Restore first, then await `binding_ready` | Readiness waits for the restore, so the World never becomes ready |
| Call `load_save()` in the same frame as `initialize` | Await one `process_frame` first | Local Play binds the World a frame later; the load fails with `world_save_unavailable` ("no active SummerNetworkWorld binding") |
| Start an empty World when the load fails | Stop and report | The next checkpoint would overwrite the real World |
| Save only on shutdown | Checkpoint every `recovery_point_seconds` | Crashes deliver no save request |
| Start a second save while one is pending | Serialize saves | Both expect the same revision; one conflicts |
| Recapture or mint a new `save_id` after a lost reply | Retry the same five arguments | The first commit may have succeeded |
| Await a timer inside the final save | Await only save operations | Timers are frozen during final saving |
| Put player progress in the World save | Player data | It must follow the player to other Worlds |
| Call `complete()` to sleep the World | Let the platform stop it after the final save | `complete()` ends the World forever |

## See also

- `skill/summer-player-data` — progress that follows a player
- `skill/multiplayer-state` — the shared document this skill saves
- `skill/multiplayer-project` — `world.json` and the authority scene
- `skill/multiplayer-testing` — Local Play runs and markers
