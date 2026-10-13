---
name: persistent-world-save-migrations
description: "Change a persistent World's save format without losing progress: save versions, migration steps, fixtures and upgrades."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: multiplayer-and-networking
user-invocable: true
allowed-tools: Read Grep Edit Write summer_get_script_errors summer_play summer_stop summer_get_diagnostics
paths: ["summer/save_fixtures/**", "world.json", "**/*save*.gd", "**/*migration*.gd"]
---

# /persistent-world-save-migrations — change the save, keep every World

> **Coming with Engine interface v7.**
> - `register_save_migration`, `get_save_version`, `get_readable_save_versions`, the fixture check and World upgrades ship with Summer Engine's `multiplayer` interface v7 and the matching platform release. Before that, a Build with two or more `snapshot_schemas` entries fails publication.
> - **Check first:** `Summer.authority.world.has_method("register_save_migration")`. If it is false, follow "Before v7" below and do not change the save format of a published persistent World.
> - Not verified in-engine yet. The design is summer-platform ADR 0035.

## Overview

A persistent World's save is opaque bytes your game writes, tagged with a
**save version** such as `courtyard.v1` (the `schema` argument of
`commit_save`). Summer never changes those bytes. When the format changes,
your game turns old saves into the new format with **migration steps**.

| Concept | Meaning |
|---|---|
| Save version | The name of one save format. Never reuse a name for a different format. |
| Readable list | `persistence.snapshot_schemas` in `world.json`, oldest first. The **last** entry is the version this Build writes; the whole list is what it reads. |
| Migration step | One function per older entry. The step for X turns X bytes into bytes of the **next** entry. The Engine chains them: v1 → v2 → v3. |
| World upgrade | A sleeping World moves to a newer Build. The new Build loads the head, migrates it and commits the result before any player is admitted. Any failure rolls the World back to its old Build and save, untouched. |

Every World keeps working on the Build that wrote its save. Upgrading is how
it moves forward, and the creator chooses when (see "Publish and operate").

## Change the save format

Example: the Courtyard World from `summer-world-saves` saves
`{"coins": [...], "scores": {...}}` as `courtyard.v1`. Version 2 adds a day
counter and renames `scores` to `score_by_player`.

### 1. Keep a fixture of the current version first

Before touching the format, save real bytes of the current version (see
"Test locally") under `res://summer/save_fixtures/courtyard.v1/`. Without one,
nothing proves the old saves still load.

### 2. Append the new version

In `world.json`, append; never remove, rename or reorder entries:

```json
"persistence": {
  "mode": "checkpoint",
  "recovery_point_seconds": 60,
  "snapshot_schemas": ["courtyard.v1", "courtyard.v2"],
  "migration_ids": []
}
```

`migration_ids` stays `[]`: the list order is the chain.

### 3. Register one step per older version

In the authority script, register every step **before** `load_save()`:

```gdscript
func _restore_world() -> bool:
	saves = Summer.authority.world
	saves.register_save_migration("courtyard.v1", _courtyard_v1_to_v2)
	saves.save_requested.connect(_on_save_requested)
	# ... the rest of _restore_world from summer-world-saves

## courtyard.v1 -> courtyard.v2: add the day, rename scores.
func _courtyard_v1_to_v2(data: PackedByteArray) -> Variant:
	var doc: Variant = JSON.parse_string(data.get_string_from_utf8())
	if not doc is Dictionary or not doc.has("scores"):
		return "courtyard.v1 save is not a dictionary with scores"
	doc["score_by_player"] = doc["scores"]
	doc.erase("scores")
	doc["day"] = 1
	return JSON.stringify(doc).to_utf8_buffer()
```

### 4. Read only the current version, write only the current version

- After a migrated load, `get_save().get_data()` holds current-version bytes,
  and `get_schema()` returns the current version. `get_stored_save_version()`
  is the version the head was written in; `is_migrated()` says a chain ran.
- Validate the restored document against the **new** shape. A failed
  validation stops the World, exactly as before.
- Commit with `saves.get_save_version()`, not a hard-coded constant. A commit
  in any other version is refused.
- Call `finish_restore(saved)` as before. After a migration it also commits
  the migrated bytes as the upgrade save (`upgrade-<trialId>`); players are
  admitted only after that. Do not call `commit_save` before it completes
  (`world_restore_required`).

## Step rules

- **Synchronous and pure.** `func(data: PackedByteArray) -> Variant`. No
  `await`, timers, signals, network, files, Summer services or scene changes.
  The same step runs in trials, retries and the publish-time check on player
  saves, so the same input must give the same output.
- **Return bytes or a reason.** A `PackedByteArray` (at most 16 MiB) succeeds.
  A `String` (at most 256 UTF-8 bytes) fails the upgrade and is shown to the
  creator, never to players. Anything else fails as "invalid step result".
- **One hop.** The step registered for X produces the next list entry, never
  the current version directly.
- **Fast.** Steps run on the main thread. The whole trial has a 300-second
  deadline, including startup and the upgrade save.
- **Never edit a step's output after Worlds used it.** If a released step
  wrote wrong data, add a new version whose step repairs it.
- **Change the format, change the name.** Any change an older Build could
  misread needs a new save version.
- **Dropping the oldest entry** is allowed unless strict compatibility is on.
  Worlds on a dropped version stay on the Build that wrote them.

## Don't

| Don't | Do | Why |
|---|---|---|
| Edit `snapshot_schemas` entries in place | Append a new name | Worlds and fixtures are tagged with the old name |
| Register steps after `load_save()` | Register before | The chain is built at load; a missing step fails the upgrade |
| `await` inside a step | Synchronous code only | An await is an invalid step result |
| Start an empty World when migration fails | Return the reason and let the trial roll back | The rollback keeps the old save; an empty World would overwrite it |
| Fill `migration_ids` | Leave it `[]` | Reserved; publication rejects it |
| Hard-code the save version in `commit_save` | `get_save_version()` | The written version is the last list entry |
| Rename the save version of shared Worlds before v7 | Add optional fields under the same version | A new shared World adopts the old save only on an exact version match |

## Test locally

Local Play starts every run with an empty World, so it can never show a
migration. Use fixtures instead:

1. **Capture a fixture.** While the current version is still the one written,
   add a temporary debug line where the authority commits:
   `FileAccess.open("user://fixture.save", FileAccess.WRITE).store_buffer(data)`.
   Play a few minutes with `summer_play`, `summer_stop`, then copy the file to
   `res://summer/save_fixtures/<version>/<name>.save`. Remove the debug line.
   Keep one fixture per version, ideally a large or unusual World.
2. **Run the chain.** Interface v7 adds an editor/CLI check that runs every
   fixture through this Build's chain and the game's restore validation; its
   command name is not final. Until it ships, call the step functions directly
   from a headless script (`headless-scripting`): load each fixture with
   `FileAccess.get_file_as_bytes`, apply the steps in list order, and run the
   restore validation on the result.
3. **Check:** every fixture reaches the current version, each step returns
   bytes, and restore validation accepts the result. Then `summer_play` once
   and read `summer_get_diagnostics` for script errors.

## Publish and operate

- **Publication** checks the list (1 to 64 unique names; two or more need
  interface v7) and then runs the same check hosted, on the fixtures plus up to
  20 recent player saves per older version. Per version: `passed`, `failed`
  (with the step's message) or `not_checked`. A failure only takes the Build out
  of automatic upgrades for Worlds on that version; it never blocks publishing.
- **Upgrade policy**, per Game: `on_next_wake` (default; an empty sleeping
  World moves to the newest published Build when it reads the World's save),
  `manual` (per World or "Upgrade all now") or `pinned` (never). Any World can
  be pinned on its own. Only the newest Build is chosen automatically.
- **Strict compatibility** (opt-in) rejects a Build that stops reading a save
  version an earlier Build wrote, or whose own fixtures fail.
- **Saved Worlds** in the creator console shows each World as *Up to date*,
  *Upgrades on next visit*, *Upgrading…*, *Upgrade failed*, *Pinned* or
  *Can't upgrade*. A failed World offers *Retry*, *Pin this World*, *Run on
  another version* (only versions that read its save) and *Start fresh*
  (typed name; old saves kept).
- **Joins during an upgrade** answer `world_waking`; the client retries the
  same join and lands on the new Build after the upgrade save.
- **No loops.** A failure caused by the game marks that Build failed for that
  World until the creator retries or publishes a newer Build. Platform faults,
  drains and bans do not count; the next wake tries again.

## Troubleshooting

| Code or reason | Meaning | Fix |
|---|---|---|
| `world_save_migration_failed` / `migration_failed` | A step returned a `String`, or an invalid result (await, wrong type, over 16 MiB). The reason names the version. | Fix the step, test the fixture, then Retry. |
| `world_save_migration_missing` / `migration_missing` | No step registered for a version in the chain. | Register it before `load_save()`, spelled exactly as the list entry. |
| `world_save_incompatible` / `save_incompatible` | The head's version is not in this Build's list, or a migration was needed outside an upgrade trial. | Add the version and its step, or leave the World on its Build. |
| `world_upgrade_timeout` / `timed_out` | The chain or the upgrade save finished after the 300-second deadline. | Make steps cheaper or the save smaller; Retry. |
| `crashed_before_first_save` | The new Build exited before the upgrade save. | Read the authority logs; usually restore validation or a script error on the new shape. |
| `interrupted` | Platform fault, drain or ban. | Nothing; it does not count against the Build. |
| `world_restore_required` | `commit_save` ran before `finish_restore` completed. | Wait for `finish_restore`. |

## Before v7

Until the Engine reports interface v7, a Build reads exactly one save
version, and an existing World keeps running the Build it started on, so a
new format reaches only new Worlds. The exception is shared Worlds
(`open_world_first`): a new shared World takes over the newest save of its
predecessor only when the save version matches exactly; otherwise it starts
empty and players no longer see the old one (it is kept). That exact match
stays after v7 until a follow-up covers it.

So, for shared Worlds, keep the save version and only **add** optional
fields, read with defaults (`doc.get("day", 1)`); never rename or remove
one. Anything bigger waits for v7.

## Checklist

- [ ] A fixture of every version still in the list sits in `res://summer/save_fixtures/<version>/`.
- [ ] The new version is appended to `snapshot_schemas`; `migration_ids` is `[]`.
- [ ] One synchronous, pure step per older version, registered before `load_save()`.
- [ ] Restore validates the new shape; commits use `get_save_version()`.
- [ ] Every fixture migrates and passes restore validation.
- [ ] The creator knows the Game's upgrade policy and whether strict mode is on.

## See also

- `summer-world-saves` — restore, checkpoints and the final save
- `multiplayer-project` — `world.json` and the authority scene
- `multiplayer-publish` — publishing the Build that carries the new version
- `headless-scripting` — running a GDScript check without the editor
