---
name: save-load
description: "Save and load game state: user:// paths, JSON progress vs ConfigFile settings, versioned saves, autosave."
license: MIT
compatibility: [Cursor, Claude Code, Codex, Windsurf, Gemini, OpenCode]
category: scripting-patterns
user-invocable: false
allowed-tools: Read Grep summer_read_file summer_write_file summer_replace_text summer_project_setting summer_get_script_errors summer_get_diagnostics
paths: ["**/*.gd", "project.godot"]
---

# Save / Load

Trigger phrases: "save progress", "settings menu should remember", "high scores",
"checkpoints", "save slots", "JSON or ConfigFile?", "saves broke after the update".

Save what the player would be angry to lose, and nothing else. Persist DATA
(numbers, ids, flags), never live nodes or scene references.

## Where saves go

Always `user://` - a writable per-user dir (`res://` is read-only in an export).

- `user://save_0.json` - progress
- `user://settings.cfg` - options

Never write gameplay saves to `res://`; it fails in the shipped game.

## JSON vs ConfigFile

| Use JSON when | Use ConfigFile when |
|---------------|---------------------|
| Nested/structured game state (inventory, quests, world) | Flat key/value settings |
| One document you load whole | Sectioned options (audio, video, controls) |
| You want a schema + version field | You want human-editable ini-style |

Default to JSON for game progress, ConfigFile for settings.

## Save schema (version it from day one)

A top-level `version` field is the difference between "old saves still load after
an update" and "everyone loses their progress on patch day".

```gdscript
const SAVE_PATH := "user://save_0.json"
const SAVE_VERSION := 1

func build_save() -> Dictionary:
	return {
		"version": SAVE_VERSION,
		"level": GameManager.current_level,
		"player": {
			"hp": GameManager.player_health,
			"gold": GameManager.player_gold,
			"pos": var_to_str(player.global_position),  # Vector serialized as string
		},
		"inventory": GameManager.inventory,   # array of item ids, not item nodes
		"flags": GameManager.story_flags,
	}
```

Serialize Vectors/Colors with `var_to_str()` and restore with `str_to_var()` -
JSON has no native Vector2/3.

## Write and read

```gdscript
func save_game() -> void:
	var f := FileAccess.open(SAVE_PATH, FileAccess.WRITE)
	if f == null:
		push_error("save failed: %s" % FileAccess.get_open_error())
		return
	f.store_string(JSON.stringify(build_save(), "\t"))   # tab-indented, readable
	f.close()

func load_game() -> bool:
	if not FileAccess.file_exists(SAVE_PATH):
		return false
	var f := FileAccess.open(SAVE_PATH, FileAccess.READ)
	var data: Variant = JSON.parse_string(f.get_as_text())
	f.close()
	if typeof(data) != TYPE_DICTIONARY:
		return false                       # corrupt/partial file
	data = _migrate(data)                  # bring old versions up to current
	_apply_save(data)
	return true
```

## Migration (do not skip)

When the schema changes, bump `SAVE_VERSION` and upgrade old saves instead of
rejecting them.

```gdscript
func _migrate(data: Dictionary) -> Dictionary:
	var v: int = data.get("version", 0)
	if v < 1:
		data["flags"] = data.get("flags", {})   # field added in v1
		data["version"] = 1
	return data
```

## Settings with ConfigFile

```gdscript
func save_settings() -> void:
	var cfg := ConfigFile.new()
	cfg.set_value("audio", "master", master_volume)
	cfg.set_value("video", "fullscreen", is_fullscreen)
	cfg.save("user://settings.cfg")

func load_settings() -> void:
	var cfg := ConfigFile.new()
	if cfg.load("user://settings.cfg") != OK:
		return                              # first run, use defaults
	master_volume = cfg.get_value("audio", "master", 1.0)
```

Always pass a default to `get_value` so a missing key never crashes.

## Autosave hooks

- Save on meaningful checkpoints (level end, area transition, shop close), not
  every frame. Disk writes stutter.
- Save on quit via `_notification`:

```gdscript
func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_CLOSE_REQUEST:
		save_game()
		get_tree().quit()
```

Set `get_tree().set_auto_accept_quit(false)` so you control the quit.

## Traps

- Storing a node/`PackedScene`/callable in the save = unserializable or huge.
  Store ids and rebuild.
- Writing to `res://` - read-only in exports; silently fails or errors.
- No `version` field - the first schema change wipes every player's save.
- `JSON.parse_string` returns `null` on bad input; type-check before using it.
- Floats round-trip fine; ints may load back as floats from JSON - cast on read
  (`int(data["gold"])`).

## Applying it in Summer Engine

- The save code is a script, usually an autoload (`res://scripts/autoloads/save_manager.gd`):
  create it with `summer_write_file(path=..., content=..., create_only=true)`,
  then register it with `summer_project_setting(key="autoload/SaveManager", value="*res://scripts/autoloads/save_manager.gd")`
  (the leading `*` makes it a singleton). Check it with `summer_get_script_errors`.
- `user://` is the per-user data dir, outside the project, so do not expect
  `summer_read_file` (a project-file reader) to show a save file. Prove a round trip from inside the game
  instead: a `RunVerification` probe (see `playtesting-a-feature`) that calls
  `save_game()`, changes a value, calls `load_game()`, and `report()`s the
  restored value.

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@4.9.0` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `summer_get_diagnostics` | `summer engine get-diagnostics` |
| `summer_get_script_errors` | `summer engine get-script-errors` |
| `summer_project_setting` | `summer engine project-setting` |
| `summer_read_file` | `summer engine read-file` |
| `summer_replace_text` | `summer engine replace-text` |
| `summer_write_file` | `summer engine write-file` |
<!-- /shell-commands -->
