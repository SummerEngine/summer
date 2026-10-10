---
name: bounded-engine-runs
description: "Run Summer headless or offscreen safely from an agent: time limits, one engine per project, muted runs, import passes, tests that fail on crashes."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: workflow
user-invocable: true
allowed-tools: Read Grep Glob Edit Write Bash
paths: ["project.godot", "tests/**/*.gd", "tools/**/*.gd"]
---

# Bounded engine runs for agents

Agents verify games by running the engine many times: imports, tests, captures, multiplayer bots. A run
that hangs, overlaps another, makes noise or hides an error costs time. These rules keep runs safe when
several agents share one project on one machine.

## 1. Every run is bounded, muted and alone

- **Bound it.** macOS has no `timeout`. Wrap runs so the engine itself gets killed:
  ```sh
  perl -e 'alarm shift; exec @ARGV' 180 <summer> --headless --path . -s res://tests/run_tests.gd
  ```
  `alarm` survives `exec`; exit code 142 means the limit hit.
- **One engine per project at a time.** Two engines writing the same `.godot/` import cache corrupt it or
  freeze each other's captures. Serialize with a lock file held by the engine process:
  ```sh
  perl -e 'use Fcntl qw(:flock); $^F=255; open(my $l,">>",shift) or die; flock($l,LOCK_EX); alarm shift; exec @ARGV' \
    <project>/.engine.lock 180 <summer> ...
  ```
  Put this in one wrapper script and make every agent use it.
- **Cap its memory.** A time limit does not stop a run from eating all memory first; several engine runs plus a
  browser loading a large web export can exhaust memory and crash the machine. The wrapper should run the command as a child, sum the resident
  memory of its whole process tree (browsers spawn GPU/renderer helpers), kill the tree past a cap (e.g.
  3 GB), and also stop when system free memory falls low (`sysctl -n kern.memorystatus_level` < 15 on macOS),
  because GPU memory on Apple Silicon is system memory but is not counted in RSS. Refuse to start when the
  system is already short (< 35).
- **Mute it.** `--audio-driver Dummy`.
- **Render only when you must, and offscreen.** `--headless` for logic (no pixels). For visual checks use
  `--summer-offscreen` with a fixed `--resolution` and a capture script that saves PNGs and quits. Visible
  windows only when a human asked to watch.

## 2. Imports and parse errors

- New `class_name` scripts are unknown to `-s` scripts until an import pass registers them:
  `<summer> --headless --audio-driver Dummy --path . --import`.
- The first import may rewrite `project.godot` (reorder keys, add a `[summer]` section; one trial saw a
  hand-written `[rendering]` section dropped). Check `git diff project.godot` after it, and pass renderer
  choices on the command line (`--rendering-method ...`) when a run depends on them.
- One broken `class_name` script cascades into "Could not parse global class" and dozens of unrelated
  "cannot infer type" errors. Get the real line with:
  `<summer> --headless --path . --check-only -s res://path/to/file.gd`
- Compile every script before booting the game: a tiny `SceneTree` script that `load()`s each `.gd` under
  a folder and reports `can_instantiate()` failures, exit code = failures.

## 3. Tests that can't lie

- A runtime script error inside a test does not fail it by default; the test just stops and counts as
  passed. Register a logger and fail the test when its error count rises:
  ```gdscript
  class ErrorCounter extends Logger:
  	var script_errors := 0
  	func _log_error(_f: String, file: String, _line: int, _c: String, _r: String, _n: bool, type: int, _bt: Array[ScriptBacktrace]) -> void:
  		if type == Logger.ERROR_TYPE_SCRIPT or file.ends_with(".gd"):
  			script_errors += 1
  	func _log_message(_m: String, _e: bool) -> void:
  		pass
  # in the runner: OS.add_logger(counter); compare counter.script_errors before and after each test
  ```
- Exit 0 is not success. Always grep the log for `SCRIPT ERROR`, `Parse Error` and `ERROR:`, and print
  one explicit success line (`TESTS passed=N failed=0`) you can check for.

## 4. Typed GDScript traps agents hit repeatedly

- `var x := dict["k"]` cannot infer a type (Dictionary values are Variant). Write `var x: int = dict["k"]`.
- A loop variable that shadows an outer variable is a parse error that takes the whole class down.
- Don't name a class after an engine class (`SummerSession`); the error only says it "hides a native class".

## 5. Web exports on a dev machine

- Check the `.pck` size before opening it in a browser; the browser holds all of it in memory. A project that
  exports every imported asset of a large scene can pass 250 MB. Ship only what the game uses first.
- Load it in a browser only under the same memory-capped wrapper, one at a time, never next to other engine runs.

## 6. Captures you can trust

- Read every PNG you produce. If several files are identical (`md5 -r *.png`), the run froze; rerun alone.
- Keep evidence outside the project (logs, PNGs) so imports never pick it up. If it must live inside, put an
  empty `.gdignore` file in that folder so the editor and imports skip it.

## See also

- `headless-scripting` (writing the SceneTree scripts these runs execute)
- `multiplayer-testing` (Local Play bot runs)
- `compatibility-renderer-traps` (dual-renderer captures)
