---
name: release-readiness
description: "Prove players can play a Summer release: server, online join, progress, files."
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
unzip -o build/<game>.summer.zip server.pck client.pck summer-bundle.json config/summer.build.json -d build/bundle
```

```powershell
# Windows PowerShell: the same steps. Summer.exe writes its output to --log-file.
$summer = "$env:LOCALAPPDATA\SummerEngine\current\Summer.exe"
function Run-Summer([int]$seconds, [string]$log, [string[]]$engineArgs) {
  $quoted = ($engineArgs + @('--log-file', $log) | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $p = Start-Process $summer -ArgumentList $quoted -PassThru -NoNewWindow
  if (-not $p.WaitForExit($seconds * 1000)) { $p | Stop-Process }
}
Run-Summer 600 build\import.log '--headless','--path','.','--import'
Run-Summer 600 build\export.log '--headless','--path','.','--export-release','summer.games','build\<game>.summer.zip'
Expand-Archive build\<game>.summer.zip -DestinationPath build\bundle -Force
```

Each check below gives a `sh` form and a PowerShell form for Windows, which
runs the engine through `Run-Summer` and searches its log with `Select-String`.

A game without a server has no `server.pck` or `config/`; `unzip` then
warns about the missing names and extracts the rest.

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
play. Checks 5 to 8 and 10 apply to every game. Check 9 applies to every
bundle for iPhone or Android.

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

```powershell
Run-Summer 15 build\server.log '--headless','--verbose','--main-pack','build\bundle\server.pck'
Select-String -Path build\server.log -Pattern "Completed load for: 'res://.*tscn'" | Select-Object -First 1
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

### 7. Export with a released Summer, and its scripts compile on the players' runtime

**Why.** The export records which Summer made it, in the client pack's
`.summer/export.json` and under `export` in the bundle's
`summer-bundle.json`: `summerVersion` and `engineSha`. Players' apps run the
game on a released Summer runtime with the same MAJOR.MINOR and a patch at
least the stamped one. A development build of Summer
can stamp a version that is already released while it has APIs that release
lacks. Scripts that use them then fail to compile on every player's device,
and the game opens to an empty or black window. Summer doesn't compile
scripts when you upload, so every upload check passes.

**Check it.**

1. Read the stamp: `cat build/bundle/summer-bundle.json`. The export log
   shows it too: `Exported by Summer <version> (engine <sha>)`.
2. `summerVersion` must be a released Summer version, and `engineSha` must
   equal that release's `engineSha` in
   `downloads.summer.games/engine-templates/<summerVersion>/manifest.json`
   (published for Summer 0.7.1 and later). If it differs, or that address has
   nothing for the version, a development build made the export.
3. Run the client pack on that released Summer, and fail on any compile
   error. The run exits normally even when a script fails, so the grep is the
   check:

   ```sh
   perl -e 'alarm shift; exec @ARGV' 60 <released-summer> --headless --verbose --main-pack build/bundle/client.pck --quit-after 600 > build/client-run.log 2>&1
   grep -E 'SCRIPT ERROR|Parse Error|Failed to load script' build/client-run.log
   ```

   ```powershell
   Run-Summer 60 build\client-run.log '--headless','--verbose','--main-pack','build\bundle\client.pck','--quit-after','600'
   Select-String -Path build\client-run.log -Pattern 'SCRIPT ERROR|Parse Error|Failed to load script'
   ```

   `<released-summer>` is the Summer executable of the stamped version from
   the download page, not the development build that made the export. The
   grep must print nothing. The run compiles the scripts that the main
   scene and autoloads load; a script that loads only later in play compiles
   when play reaches it, so check 2 still matters for online games.

**Fix.** Ask the user to install the current Summer release from
https://summerengine.com/download (or, with their OK, run
`summer install --yes`). Export again with it, and rerun this check on the
new `.zip` before you upload it.

### 8. Every file the game reads at run time is in the pack

**Why.** The export packs scenes, scripts and imported assets. A file the
game opens itself by path (`FileAccess`, `DirAccess`, `load_from_file`,
`FontFile.load_dynamic_font`, `ConfigFile.load`) that has no `.import`
beside it, such as a `.bin`, `.json` or `.txt`, is a non-resource file. It
goes into the pack only when the preset's `include_filter` (**Resources >
Filters to export non-resource files/folders**) matches it and
`exclude_filter` doesn't. Each preset has its own filters: the summer.games
preset doesn't inherit one set on another preset. A file left out is not an
export error; on players' devices `FileAccess` just returns nothing and the
game's fallback runs. Fonts show it first: in the Summer Games app on iPhone
a `SystemFont` has no system fonts to use, so every glyph draws as a box,
while the editor, Local Play and desktop find a system font and look right.
A real release shipped this way: its font file was missing from the
uploaded pack, and every letter on iPhone was a box.

**Check it.**

1. Find every read by path:
   `grep -rn -E 'FileAccess\.|DirAccess\.|load_from_file|load_dynamic_font|ConfigFile' --include=*.gd .`
   Note each `res://` file or folder they read; skip `user://` (saves). A
   file is raw when no `<file>.import` sits beside it.
2. Check the filters:
   `grep -n -E '^name=|^include_filter=|^exclude_filter=' export_presets.cfg`.
   The summer.games preset's `include_filter` must match each raw file the
   client reads, and its `exclude_filter` must not. Do the same on the
   server preset for files the authority reads.
3. List the pack. Save this script **outside** the project, for example as
   `~/list_pack.gd`:

   ```gdscript
   extends SceneTree
   # Prints one "PACK res://..." line per file in the pack mounted with --main-pack.
   func _init() -> void:
       _walk("res://")
       quit()

   func _walk(dir: String) -> void:
       var d := DirAccess.open(dir)
       if d == null:
           return
       d.include_hidden = true
       for f in d.get_files():
           print("PACK ", dir.path_join(f))
       for s in d.get_directories():
           _walk(dir.path_join(s))
   ```

   ```sh
   perl -e 'alarm shift; exec @ARGV' 60 <summer> --headless --main-pack build/bundle/client.pck --script ~/list_pack.gd > build/client-pack.txt 2>&1
   grep -Fx 'PACK res://fonts/MyFont.bin' build/client-pack.txt   # once per raw file from step 1
   ```

   ```powershell
   Run-Summer 60 build\client-pack.txt '--headless','--main-pack','build\bundle\client.pck','--script',"$HOME\list_pack.gd"
   Select-String -Path build\client-pack.txt -SimpleMatch -Pattern 'PACK res://fonts/MyFont.bin'   # once per raw file from step 1
   ```

   Every raw file must print its line. No line means the file is not in the
   pack, whatever the preset says. List `server.pck` the same way for files
   the authority reads.
4. `grep -rn SystemFont --include=*.gd --include=*.tscn --include=*.tres .`
   must find nothing on a path phone players reach, fallbacks included.
5. After publishing, open the game on an iPhone in the Summer Games app and
   look at the title and one menu: letters, not boxes. An agent can't do
   this step; report it as **not run** and ask the user.

**Fix.** Add each missing file to the summer.games preset's non-resource
filter (for example `fonts/*.bin`), or import it as a resource instead.
Ship the font in the project (an imported `.ttf`/`.otf`, or raw bytes that
step 3 proves are packed) and fall back to `ThemeDB.fallback_font`, Summer's
built-in font, never to `SystemFont`. Export again and rerun steps 3 and 5.

### 9. Export with the Summer version line the Summer Games apps run

**Why.** The Summer Games apps for iPhone and Android carry Summer inside
the app and download none. An app starts a game only when the export's
`summerVersion` has the app's MAJOR.MINOR (for example `0.7`) and a patch no
newer than the app's. A `0.6.x` export doesn't start in an app that carries
`0.7`: the player sees **The game could not start**. The desktop app fetches
the right Summer for each game, so the game can run on Mac and Windows and
still fail on every phone. The upload checks don't catch it.

**Check it.**

1. Read the stamp and platforms:
   `python3 -c 'import json; b=json.load(open("build/bundle/summer-bundle.json")); print(b["export"]["summerVersion"], b["client"]["targetPlatforms"])'`
2. If `targetPlatforms` lists `ios` or `android`, the first two numbers of
   `summerVersion` must match the current Summer release, shown on
   https://summerengine.com/download and in Help > About after updating.
3. After publishing, open the game on a phone in the Summer Games app, as in
   check 2. "The game could not start" there, while desktop works, is this
   check failing.

**Fix.** Ask the user to update Summer to the current release (or, with
their OK, run `summer install --yes`). Export again, upload it as a new
version and promote it. Do this again after every Summer minor update
(0.6 to 0.7), because the apps move to the new line.

### 10. A signed-in player keeps playing for three minutes

**Why.** While the game runs, it calls Summer services for the signed-in
player: analytics, player data, the store. A short test can end before the
first of those calls. A real release closed for every player about a minute
in, with "That link can't be opened", and left them signed out: a Summer
service refused the player's sign-in, and the app ended play. The fault was
Summer's, not the game's, and no check on the game's files could see it.

**Check it.** After publishing, sign in to a Summer Games app on a phone,
open the released version and play it for at least 3 minutes, through at
least one analytics event. The game must not close, and the player must
still be signed in afterwards. Do it in each Summer Games app the game
targets. An agent can't do this step; report it as **not run** and ask the
user, then record what they saw.

**Fix.** Nothing in the game. Ask the user to report it to Summer with the
game's name, the app and the time it happened.

## Troubleshooting

### Every online join fails with `world_start_timeout`, but Local Play works

Most likely, in this order:

1. The server pack starts the wrong scene. Run check 1.
2. The game passes a fixed Game ID. Run check 6.

After the fix, export a new `.zip`, upload it, promote it and run check 2.

### The game opens to a blank window for every player

The game works in your editor, but every player sees an empty or black
window. Running the client pack as in check 7 prints
`Parse Error: Static function "…" not found` and
`Failed to load script "res://…"`. A development build of Summer made the
export, and the scripts use something the released version doesn't have.
Re-export with the current Summer release, upload the new version and
promote it.

### Text shows as boxes on iPhone

Every letter draws as an empty box in the Summer Games app on iPhone, while
the game looks right on desktop. The game most likely reads a font file that
isn't in the pack and falls back to `SystemFont`. Run check 8.

### "The game could not start" on iPhone or Android

The game works on desktop, but the phone app says "The game could not
start". The `.zip` most likely comes from a Summer version line the app
doesn't carry. Run check 9, then export again with the current Summer
release, upload and promote.

### The game closes after about a minute and the player is signed out

The Summer Games app closes the game 20 to 60 seconds into play with "Play
paused" or "That link can't be opened", and the player finds they are signed
out. A Summer service refused the player's sign-in while the game played.
This is Summer's fault, not the game's: see check 10, and ask the user to
report it with the time it happened.

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
- [ ] 7. The export stamp names a released Summer and its `engineSha`, and `client.pck` run on that released Summer prints no `SCRIPT ERROR`, `Parse Error` or `Failed to load script`.
- [ ] 8. Every file the game reads by path has a `PACK res://…` line in the listing of `client.pck` (or `server.pck`), no phone text uses `SystemFont`, and text shows as letters on an iPhone (or is reported as not run).
- [ ] 9. For an iPhone or Android bundle, `summerVersion` has the current Summer release's MAJOR.MINOR.
- [ ] 10. A signed-in player played the released version for 3 minutes in each Summer Games app, through an analytics event, without the game closing or being signed out (or it is reported as not run).
- [ ] One line per check reported to the user before anything is changed.

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@latest` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `summer_export_game` | `summer engine export-game` |
| `summer_get_diagnostics` | `summer engine get-diagnostics` |
| `summer_read_file` | `summer engine read-file` |
<!-- /shell-commands -->
