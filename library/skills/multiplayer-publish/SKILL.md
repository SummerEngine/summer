---
name: multiplayer-publish
description: "Ship a hosted Summer multiplayer game: the bundle, server preset, pre-upload checks, a new Build."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: multiplayer-and-networking
user-invocable: true
allowed-tools: Read Grep Glob Edit Write summer_read_file summer_write_file summer_project_setting summer_call
paths: ["export_presets.cfg", "summer.build.json", "world.json", "source-domains.json", "runtime-manifest.json", "project.godot"]
---

# /multiplayer-publish — from project to a Build players can join

Step 5 of the multiplayer sequence. It assumes the layout from
`multiplayer-project`: `summer.build.json`, `world.json`,
`runtime-manifest.json`, `source-domains.json`, and the `client/`,
`authority/` and `network/` folders.

## 1. What gets built

**Project > Export**, preset **summer.games**, **Export Project** to a `.zip`
gives one file, the bundle, which becomes one Build:

| Entry | What it is |
|---|---|
| `client.pck` | What players run, without anything the source graph marks server-only |
| `server.pck` | What the authority runs, exported with the server preset |
| `config/` | `summer.build.json` and every file it names (WorldDefinitions, runtime descriptor, source graph) |
| `summer-bundle.json` | The Summer version, both packs' main scenes, the composition, and every entry's SHA-256 |

Players get `client.pck` on iOS, macOS or Windows (`targetPlatforms` in
`summer.build.json`). Summer runs `server.pck` on Linux for every World.

## 2. The two export presets

Every project has a built-in **summer.games** preset. The server needs a
second, Linux dedicated-server preset, named exactly as
`server.exportPreset` in `summer.build.json`. `export_presets.cfg`:

```ini
[preset.0]

name="summer.games"
platform="summer.games"
runnable=false
dedicated_server=false
custom_features="summer_client"
export_filter="all_resources"
include_filter=""
exclude_filter=""
export_path=""
encrypt_pck=false
encrypt_directory=false
script_export_mode=2

[preset.0.options]

platforms/ios=true
platforms/macos=true
platforms/windows=false

[preset.1]

name="Courtyard Authority"
platform="Linux"
runnable=false
dedicated_server=true
custom_features="summer_authority"
export_filter="all_resources"
include_filter=""
exclude_filter="client/*"
export_path=""
encrypt_pck=false
encrypt_directory=false
script_export_mode=2

[preset.1.options]

binary_format/architecture="x86_64"
```

To make the same in the Export dialog:

- **summer.games:** tick the platforms the game supports; leave encryption
  off. It needs no exclude filters, because the source graph decides what
  stays out of `client.pck`.
- **Server:** **Add... > Linux**, named exactly as `server.exportPreset`.
  **Resources:** Export Mode **Export as dedicated server**, and exclude the
  client folder (`client/*`). **Features:** Custom `summer_authority`.

Both presets must include the composition; each must include its entry
scene.

The `summer_authority` custom feature is what makes the server start the
authority. Summer starts `server.pck` with no scene argument, so the pack's
own main scene decides what runs: `run/main_scene.summer_authority` from
`project.godot` (`multiplayer-project`), which applies only to a pack whose
preset carries that feature. Without it, the server runs the client's main
scene, usually the title. It never restores the World or reports ready, and
every online join fails with `world_start_timeout`. Local Play and the upload
checks name the scene themselves, so they can't catch this; step 4d can.

Textures: iOS and macOS read ETC2/ASTC (`textures/vram_compression/import_etc2_astc=true`
in `project.godot`), and Windows reads S3TC/BPTC (`import_s3tc_bptc=true`).
Enable the ones for the platforms you tick. The exporter's **Fix Import**
button does it.

## 3. Export

In the editor: **Project > Export**, select **summer.games**, **Export
Project**, save as `build/<game>.summer.zip`. Or from a terminal (`<summer>`
is the Summer editor executable):

```sh
<summer> --headless --path . --import
<summer> --headless --path . --export-release "summer.games" build/courtyard.summer.zip
```

On Windows, in PowerShell. `Run-Summer` bounds a run and keeps its output,
because Summer.exe writes it to `--log-file`; step 4 uses it again:

```powershell
$summer = "$env:LOCALAPPDATA\SummerEngine\current\Summer.exe"
function Run-Summer([int]$seconds, [string]$log, [string[]]$engineArgs) {
  $quoted = ($engineArgs + @('--log-file', $log) | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $p = Start-Process $summer -ArgumentList $quoted -PassThru -NoNewWindow
  if (-not $p.WaitForExit($seconds * 1000)) { $p | Stop-Process }
}
Run-Summer 600 build\import.log '--headless','--path','.','--import'
Run-Summer 600 build\export.log '--headless','--path','.','--export-release','summer.games','build\courtyard.summer.zip'
Get-Content build\export.log -Tail 12
```

A good export ends like this:

```text
summer.games: Left 4 server-only files out of client.pck, as source-domains.json declares.
summer.games: summer.games bundle for iOS, macOS with ETC2/ASTC textures: build/courtyard.summer.zip
summer.games: Entries: summer-bundle.json, client.pck (...), config/runtime-manifest.json (...), config/source-domains.json (...), config/summer.build.json (...), config/world.json (...), server.pck (...)
summer.games: Server: server.pck from preset "Courtyard Authority", mainScene res://authority/main.tscn
summer.games: mainScene: res://client/main.tscn
summer.games: compositionPath: res://network/composition.tres
summer.games: Exported by Summer 0.6.0 (engine ...). Summer runs it on a template set with the same MAJOR.MINOR and a patch at least this one.
summer.games: Publish uploads this one file as a new Build.
```

Check that `server.pck` and your `config/` files are listed, and that the
"Left N server-only files" count covers your `authority/` files. The
`Server: … mainScene …` line names the scene the Build declares, not the
scene the pack will start; step 4d checks that. The `Exported by Summer`
line must name a released Summer: export with the released editor from the
download page, never a development build, and export again after you update
Summer. Players' apps run the packs on the released Summer of that version;
step 4e checks it. The Summer Games apps for iPhone and Android start only
exports on their own MAJOR.MINOR, so export with the current Summer release
(`release-readiness` check 9). Every
result message and every export error, with its fix, is in
[export-errors.md](export-errors.md).

## 4. Check before uploading

Do all five. Each catches problems the export doesn't. Run them on the
`.zip` you will upload, not on a pack exported separately with the server
preset (`--export-pack`): that pack differs from the bundle's `server.pck`,
for example it keeps `gameId`, and can pass where the upload fails.

**a. Local Play passes** (`multiplayer-testing`): every process has
`script_errors` 0, there's no `cannot attach`, and your ready lines appear.

**b. The source graph is clean.** Save this script **outside** the project,
for example as `~/check_graph.gd`:

```gdscript
extends SceneTree

func _init() -> void:
	var analyzer := SummerWorldCompositionAnalyzer.new()
	for profile in [SummerWorldCompositionAnalyzer.PROFILE_CLIENT, SummerWorldCompositionAnalyzer.PROFILE_AUTHORITY_ENGINE]:
		var analysis := analyzer.analyze_project(ProjectSettings.globalize_path("res://"), "world.json", profile)
		print(analysis.profile, " ok=", analysis.ok)
		for diagnostic in analysis.diagnostics:
			print("  ", diagnostic.code, " ", diagnostic.path, ": ", diagnostic.message, " ", diagnostic.dependency_path)
	quit()
```

```sh
<summer> --headless --path . --script ~/check_graph.gd
```

```powershell
Run-Summer 120 build\graph.log '--headless','--path','.','--script',"$HOME\check_graph.gd"
Select-String -Path build\graph.log -Pattern 'ok=|SUMMER_COMPOSITION'
```

Both lines must say `ok=true`. `SUMMER_COMPOSITION_DOMAIN_LEAK` means a
client file loads a server file; move the shared part into `network/`.
`SUMMER_COMPOSITION_DYNAMIC_PATH_UNDECLARED` flags any call whose name ends
in `load(` without a string literal inside. That includes
`request.get_payload()`: read `request.payload` instead. For a file that
really loads a computed path, add a
`{ "from": "<file>", "to": "<loaded file>" }` entry to `dependencies` in
`source-domains.json`.

**c. Both packs load the way Summer loads them.** In a scratch folder
outside the project:

```sh
P="$HOME/summer-probe"
mkdir -p "$P/probe" "$P/out"
printf 'config_version=5\n\n[application]\nconfig/name="Summer Native Upload Probe"\n\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n' > "$P/probe/project.godot"
unzip -o build/courtyard.summer.zip client.pck server.pck -d "$P/out"
<summer> --headless --path "$P/probe" --summer-native-upload-probe "$P/out/client.pck" \
  --summer-native-probe-scene res://client/main.tscn \
  --summer-native-probe-composition res://network/composition.tres \
  --summer-native-probe-output "$P/out/client-report.json"
<summer> --headless --path "$P/probe" --summer-native-upload-probe "$P/out/server.pck" \
  --summer-native-probe-scene res://authority/main.tscn \
  --summer-native-probe-composition res://network/composition.tres \
  --summer-native-probe-output "$P/out/server-report.json"
```

```powershell
$P = "$HOME\summer-probe"
New-Item -ItemType Directory -Force "$P\probe", "$P\out" | Out-Null
Set-Content "$P\probe\project.godot" "config_version=5`n`n[application]`nconfig/name=`"Summer Native Upload Probe`"`n`n[rendering]`nrenderer/rendering_method=`"gl_compatibility`"`n"
Expand-Archive build\courtyard.summer.zip -DestinationPath "$P\out" -Force
foreach ($side in @(@('client', 'res://client/main.tscn'), @('server', 'res://authority/main.tscn'))) {
  Run-Summer 120 "$P\out\$($side[0])-probe.log" '--headless', '--path', "$P\probe", '--summer-native-upload-probe', "$P\out\$($side[0]).pck", '--summer-native-probe-scene', $side[1], '--summer-native-probe-composition', 'res://network/composition.tres', '--summer-native-probe-output', "$P\out\$($side[0])-report.json"
}
```

Paths must be absolute. Pass: both reports say `"sceneLoaded": true`, and
their `compositionManifest` objects are identical. On failure the probe
writes `rejection.json`; its codes are in [export-errors.md](export-errors.md).
The probe names the scene to load, so it does not show which scene the
server starts on its own.

**d. The server pack starts the authority scene.** Start the bundle's
`server.pck` the way Summer does, with no scene argument, and stop it after
a few seconds:

```sh
perl -e 'alarm shift; exec @ARGV' 15 <summer> --headless --verbose --main-pack "$P/out/server.pck"
```

```powershell
Run-Summer 15 "$P\out\server-run.log" '--headless', '--verbose', '--main-pack', "$P\out\server.pck"
Select-String -Path "$P\out\server-run.log" -Pattern "Completed load for: 'res://.*tscn'" | Select-Object -First 1
```

The first `Completed load for: 'res://….tscn'` line must be the authority
scene (`res://authority/main.tscn` here). If it is the client or title
scene, add `summer_authority` to the server preset's custom features and
export again. Later lines may complain that there is no hosted World; that
is expected locally.

**e. The client compiles on the released Summer.** Run the bundle's
`client.pck` with the released Summer of the version the export names (see
`release-readiness` check 7 for how to confirm the stamp), and fail on any
compile error:

```sh
perl -e 'alarm shift; exec @ARGV' 60 <released-summer> --headless --verbose --main-pack "$P/out/client.pck" --quit-after 600 > "$P/out/client-run.log" 2>&1
grep -E 'SCRIPT ERROR|Parse Error|Failed to load script' "$P/out/client-run.log"
```

```powershell
Run-Summer 60 "$P\out\client-run.log" '--headless', '--verbose', '--main-pack', "$P\out\client.pck", '--quit-after', '600'
Select-String -Path "$P\out\client-run.log" -Pattern 'SCRIPT ERROR|Parse Error|Failed to load script'
```

On Windows, `$summer` must be the released Summer of the stamped version for
this check; the default install path is the current release.

The grep must print nothing; the run itself exits normally even when a
script fails. A failure here, such as `Static function "party_queue()" not
found`, means the scripts use an API the released version lacks, usually
because a development build made the export. Every player would see an
empty window. Re-export with the current Summer release.

## 5. Upload the Build

1. The game must exist in Summer Studio, and `gameId` in
   `summer.build.json` must be its id. The export leaves `gameId` out of the
   bundle, and the game code calls `Summer.initialize()` with no ID: a
   literal or fallback ID fails hosted with `game_identity_mismatch`.
2. Open the game's Builds page: `studio.open` with target `game`,
   `gameId` and section `builds`, or summerengine.com → Studio → your game →
   Builds.
3. Upload the `.zip` as a new Build. Summer checks it again: unknown fields,
   queue rules, both packs, and the composition match. From an agent:
   `summer_export_game`, then `store.upload_file` with `gameId` and
   `clientVersion`; it asks for confirmation first and needs
   `summer login --store`. If the store refuses this machine's sign-in,
   upload in Studio.
4. Release the Build to an environment (`store.release` releases the Build
   the owner approved with `store.publish`). Its queues go live there, and
   clients join them with `Summer.client.join(SummerJoinTarget.queue(...))`.
   The code is the same as in Local Play.

For a client-only fix to an existing Build, export to a `.pck` path instead
of `.zip`. That writes `client.pck` alone.

## 6. Join it for real

Right after the Build is released, open the game in a Summer Games app,
join online and play until you are in the game, before players hear about
the update. A wrong Game ID only fails under a real hosted launch, so
nothing before this step catches it. Keep playing, signed in, for at least 3
minutes: the game must not close and the player must stay signed in
(`release-readiness` check 10). An agent can't do this; ask the user and
record the result. The whole list of checks before a release is
`release-readiness`, and the creator docs have it at
https://docs.summerengine.com/publishing/release-readiness.

## When online joins fail

Every join ends in `world_start_timeout`, but Local Play works:

1. The server starts the wrong scene: run step 4d.
2. The game passes a fixed Game ID to `Summer.initialize`: pass none.

Then export, upload and release a new Build, and join again. An empty game
server log is not proof that the server hung: a release server holds back
what the game prints until it exits when it isn't attached to a terminal.
Use step 4d to see which scene runs.

## Checklist

- [ ] `summer.build.json`: `gameId`, `targetPlatforms`, `server.exportPreset`, every WorldDefinition selected by a queue.
- [ ] `world.json`: every field from `multiplayer-project`, including `network_compositions` and `source_graph`.
- [ ] Two presets: summer.games (platforms ticked, no encryption) and the Linux dedicated server named in `server.exportPreset`.
- [ ] The export ends with `Publish uploads this one file as a new Build.`
- [ ] The analyzer prints `ok=true` twice.
- [ ] Both probes load their scene, with identical composition manifests.
- [ ] The bundle's `server.pck`, run with no scene, loads the authority scene first.
- [ ] `Exported by Summer` names a released Summer, and the bundle's `client.pck` run on that release prints no `SCRIPT ERROR`, `Parse Error` or `Failed to load script`.
- [ ] Every `Summer.initialize` call passes no Game ID.
- [ ] After release: a real online join reaches the game, and a signed-in player keeps playing for 3 minutes (`release-readiness` checks 2 and 10).
- [ ] Local Play passed with the same project.

## Common mistakes

| Don't | Do | Why |
|---|---|---|
| Export the summer.games preset as a dedicated server | Dedicated server only on the Linux preset | The client pack would lose its visuals |
| Name the server preset differently from `server.exportPreset` | Copy the exact name | The export can't find it |
| Encrypt the client pack | Leave encryption off | Summer's client templates can't decrypt packs |
| Ship C#, `.gdextension` or native libraries in the client | GDScript only | Summer Games runs GDScript client packs only |
| Skip the source graph | Keep `source-domains.json` complete | Without it the server code ships to players (export warns) |
| Load an `authority/` file from client code | Move shared code into `network/` | The export stops: the client would load a missing file |
| Upload after only exporting | Run Local Play, the analyzer, both probes and the server start check first | Each catches what the others miss |
| Server preset without the `summer_authority` feature | `custom_features="summer_authority"` | The hosted server starts the title and every join times out |
| Test a server pack exported on its own | Test the `server.pck` inside the `.zip` | The separate pack keeps `gameId` and hides a wrong Game ID |
| Export with a development build of Summer | Export with the released editor from the download page, again after every update | Players run the pack on the released Summer of the stamped version; newer APIs fail to compile and the game opens to an empty window |
| Read an empty server log as a hang | Run step 4d | A release server holds back its output until it exits |
| Export a patch | Export Project, or Export PCK/ZIP without Export As Patch | summer.games takes complete bundles or packs |

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@latest` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `summer_export_game` | `summer engine export-game` |
| `summer_project_setting` | `summer engine project-setting` |
| `summer_read_file` | `summer engine read-file` |
| `summer_write_file` | `summer engine write-file` |
| `store.publish` | `summer store publish` |
| `store.release` | `summer store release` |
| `store.upload_file` | `summer store upload-file` |
| `studio.open` | `summer studio open` |
<!-- /shell-commands -->
