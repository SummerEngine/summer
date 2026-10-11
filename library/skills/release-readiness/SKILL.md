---
name: release-readiness
description: "Before releasing a Summer game version, prove players can play it: server starts its authority scene, online join works, progress saves, no fixed Game ID."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: deployment
user-invocable: true
allowed-tools: Read Grep Glob Bash summer_read_file summer_get_diagnostics
paths: ["export_presets.cfg", "project.godot", "summer.build.json", "world.json", "**/*.gd"]
---

# /release-readiness: prove players can play it

Summer checks every upload: platforms, packs, and the files they name. Those
checks prove the export is well formed. They can't prove that a player who
presses **Play online** gets into a game. Each check below exists because a
real release passed every upload check and still failed for its players.

The creator docs have the same checklist, with the same numbers:
https://docs.summerengine.com/publishing/release-readiness (fetch it as `.md`).

## When to run it

- Before you upload a new Build of a game that will go to players.
- Before you promote or release a version.
- After a release fails for players, to find the cause, and then to add the
  check that would have caught it (see the last section).

For a jam build or a prototype nobody else plays, skip it.

## How to report

Run every check that applies. Each check needs **evidence**: a command's
output or something you saw in the running game. Reading the project and
deciding it looks right is not evidence.

Report one line per check:

- **pass**, with the evidence;
- **fail**, with what you saw;
- **not applicable**, with the reason (for example, no server);
- **not run**, with what is still needed (for example, "needs a real online
  join after publishing").

A check that was not run is not a pass. Show the list to the user before you
change anything; the user decides what to fix and whether to release with a
check still open.

## Test the file you upload

Run the checks on the summer.games `.zip`, not on something close to it.
Export the bundle (in the editor: **Project > Export**, preset
**summer.games**, **Export Project**; from an agent: `summer_export_game`; or
from a terminal), then take the server pack and the packaged build file out
of it:

```sh
<summer> --headless --path . --import
<summer> --headless --path . --export-release "summer.games" build/<game>.summer.zip
mkdir -p build/bundle
unzip -o build/<game>.summer.zip server.pck config/summer.build.json -d build/bundle
```

`<summer>` is the Summer Engine executable. Two look-alikes hide real
failures:

- **A server pack exported on its own** with your server preset
  (`--export-pack`) is not the bundle's `server.pck`. For example, it keeps
  `gameId`, which the bundle leaves out, so it can pass check 6 while the
  uploaded `.zip` fails it.
- **Local Play** always starts the authority scene by name, so it can't catch
  check 1. It also runs without a hosted identity, so it can't catch check 6.

## The checks

Checks 1 and 2 apply to every game with a server (`summer.build.json` names
a `server.exportPreset`). Checks 3 and 4 apply to every game with online
play. Checks 5 and 6 apply to every game.

### 1. The server pack starts the authority scene

**Why.** Summer starts a hosted World's `server.pck` with no scene argument,
so the pack's own main scene decides what runs. The server preset must carry
the custom feature `summer_authority`, and `project.godot` must set that
feature's main scene:

```ini
[application]

run/main_scene="res://client/main.tscn"
run/main_scene.summer_client="res://client/main.tscn"
run/main_scene.summer_authority="res://authority/main.tscn"
```

```ini
# export_presets.cfg, the server preset
platform="Linux"
dedicated_server=true
custom_features="summer_authority"
```

Without the feature, `run/main_scene.summer_authority` never applies and
the server starts the players' main scene, usually the title screen. That
scene never restores the World or tells Summer it is ready, so **every
online join fails with `world_start_timeout`**. The bundle manifest still
names the authority scene as the server's main scene, so reading the
manifest proves nothing.

**Check it.** Start the bundle's `server.pck` the way Summer does, with no
scene argument, and stop it after a few seconds:

```sh
perl -e 'alarm shift; exec @ARGV' 15 <summer> --headless --verbose --main-pack build/bundle/server.pck
```

Find the first `Completed load for: 'res://….tscn'` line. It must be the
authority scene: the `entry_point` of the `headless_engine` component in
`world.json`. Later lines may complain that there is no hosted World; that
is expected in a local run. Then confirm the source too: the server preset in
`export_presets.cfg` has `summer_authority` in `custom_features`, and
`project.godot` sets `run/main_scene.summer_authority`.

**Fix.** Add `summer_authority` to the server preset's **Features > Custom**,
set `application/run/main_scene.summer_authority` to the authority scene,
export again and rerun the check. If your Summer version's export refuses a
server pack that starts the wrong scene, that refusal is this check failing;
run the check anyway, because older versions don't refuse it.

### 2. Join online with the version you release

**Why.** Check 1 runs on your computer. Players use a hosted server, and some
failures, such as check 6, only show up there.

**Check it.** Right after you publish or promote the version, open the game
in a Summer Games app as a player, join online and play until you are in the
game. Do it before you tell players about the update. An agent can't do this
step; report it as **not run** and ask the user to do it, then record what
they saw. If the join fails, see [Troubleshooting](#troubleshooting).

### 3. Players can find online play

**Why.** If nobody, including you, reaches online play, nobody notices when
it breaks. A game hid online play behind a grown-ups setting, so its hosted
join was never tried before release, and it failed for every player who
found it.

**Check it.** Start the client as a new player and follow the default path
to online play. List every gate on that path: settings, parental or age
gates, debug toggles. A new player should reach online play without
changing a setting. If online play is off by default on purpose, the user
must confirm that decision, and then check 2 must run before every release.

### 4. The server saves online progress

**Why.** Progress kept only in the player's local files is lost on
reinstall or a new device, and players can edit it.

**Check it.** In code, the authority loads each player's progress when they
join (`Summer.authority.player_data.load(session)`) and saves it with
`commit_public` or `commit_secret` (`summer-player-data`). Then play online,
earn something, leave, and join again from a fresh install or another
device. The progress must still be there. Local Play stores player data on
disk; only hosted play proves it lasts.

### 5. Players can get back to the title

**Why.** A player with no way out of a session has to kill the app.

**Check it.** Play into a session, online and offline, and find the way
back: a pause menu or a **Leave** button. Use it, then start a new session
from the title. In online play, leaving should call
`Summer.client.leave()` before the title loads.

### 6. The game doesn't hard-code its Game ID

**Why.** The summer.games export is portable: the bundle's
`summer.build.json` has no `gameId`. Summer takes the game's identity from
wherever it runs: the Summer Games app, the hosted server or Local Play.
Any other ID fails on the hosted server with `game_identity_mismatch`, "The
initialized Game ID does not match hosted runtime context." The authority
then stops before it restores the World or reports ready, and every online
join ends in `world_start_timeout`, even though check 1 passes. The Summer
Games app refuses a mismatched ID the same way.

**Check it.**

1. Find every call: `grep -rn "Summer.initialize" --include=*.gd .`
2. For each, trace the argument back to where it comes from. It must be
   nothing (`Summer.initialize()`) or an ID the game got from Summer. It must
   never be a literal, a placeholder, or a fallback such as
   `"game.my-game"` used when `gameId` is missing.
3. `cat build/bundle/config/summer.build.json`: it has no `gameId`, so
   anything the game reads from this file at run time comes back empty.

Local Play and the local run in check 1 have no hosted identity, so a wrong
ID passes there. Only check 2 proves this one.

**Fix.** Call `Summer.initialize()` with no ID (Summer 0.7.1 and later), on
the client and on the authority.

## Troubleshooting

### Every online join fails with `world_start_timeout`, but Local Play works

Most likely, in this order:

1. The server pack starts the wrong scene. Run check 1.
2. The game passes a fixed Game ID. Run check 6.

After the fix, export a new `.zip`, upload it, promote it and run check 2.

### The game server's log is empty

An empty server log is not proof that the server hung or never started. A
release server holds back what the game prints until it exits when it isn't
attached to a terminal, so its log can look empty while the title scene
runs. Don't debug from the empty log; run check 1 on your own computer to
see which scene starts.

## Add a check after every incident

The list grows from real failures. When a release fails in a way no check
here would have caught:

1. Fix the game, and record the cause in the project's `.summer/memory/`.
2. Write the check that would have caught it: **Why**, **Check it** (a
   command to run or something to observe, against the real summer.games
   `.zip`), and **Fix**.
3. Propose it for this skill and for the docs page
   (`/publishing/release-readiness`), with the same number in both, through
   a pull request to summerengine/summer and to the docs. Until it lands,
   keep it in the project's memory so the next release runs it.

## Checklist

- [ ] Ran the checks on the summer.games `.zip` you upload, not a separately exported pack.
- [ ] 1. The bundle's `server.pck`, run with no scene, loads the authority scene first.
- [ ] 2. A real online join with the released version reaches the game (or is reported as not run).
- [ ] 3. A new player reaches online play without changing a setting, or the user confirmed it is off on purpose.
- [ ] 4. Online progress is loaded and committed through authority player data, and survives a fresh install.
- [ ] 5. Players can get back to the title from inside a session, online and offline.
- [ ] 6. Every `Summer.initialize` passes no ID, or an ID the game got from Summer.
- [ ] One line per check reported to the user before anything is changed.
