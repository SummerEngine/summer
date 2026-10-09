---
name: multiplayer-publish
description: "Ship a hosted Summer multiplayer game: the summer.games bundle, server preset, pre-upload checks, and a new Build."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: multiplayer-and-networking
user-invocable: true
allowed-tools: Read Grep Glob Edit Write summer_read_file summer_write_file summer_project_setting summer_open
paths: ["export_presets.cfg", "summer.build.json", "world.json", "source-domains.json", "runtime-manifest.json", "project.godot"]
---

# /multiplayer-publish — from project to a Build players can join

Step 5 of the multiplayer sequence. It assumes the layout from
`multiplayer-project`: `summer.build.json`, `world.json`,
`runtime-manifest.json`, `source-domains.json`, and the `client/`,
`authority/` and `network/` folders.

**Status:** the summer.games export is in Summer's editor. Bundle upload in
Studio is rolling out: if the game's Builds page doesn't accept a `.zip`
bundle yet, stop after step 4 and tell the user the bundle is ready to
upload.

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
"Left N server-only files" count covers your `authority/` files. Every
result message and every export error, with its fix, is in
[export-errors.md](export-errors.md).

## 4. Check before uploading

Do all three. Each catches problems the export doesn't.

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

Paths must be absolute. Pass: both reports say `"sceneLoaded": true`, and
their `compositionManifest` objects are identical. On failure the probe
writes `rejection.json`; its codes are in [export-errors.md](export-errors.md).

## 5. Upload the Build

1. The game must exist in Summer Studio, and `gameId` in
   `summer.build.json` and `GAME_ID` in `network/game.gd` must both be its
   id.
2. Open the game's Builds page: `summer_open` with target `game`,
   `gameId` and section `builds`, or summerengine.com → Studio → your game →
   Builds.
3. Upload the `.zip` as a new Build. Summer checks it again: unknown fields,
   queue rules, both packs, and the composition match. From an agent:
   `summer_export_game`, then `summer_publish_build` with `gameId` and
   `clientVersion`; it asks for confirmation first and needs
   `summer login --store`. If it answers `store_auth_refused`, upload in
   Studio.
4. Release the Build to an environment. Its queues go live there, and
   clients join them with `Summer.client.join(SummerJoinTarget.queue(...))`.
   The code is the same as in Local Play.

For a client-only fix to an existing Build, export to a `.pck` path instead
of `.zip`. That writes `client.pck` alone.

## Checklist

- [ ] `summer.build.json`: `gameId`, `targetPlatforms`, `server.exportPreset`, every WorldDefinition selected by a queue.
- [ ] `world.json`: every field from `multiplayer-project`, including `network_compositions` and `source_graph`.
- [ ] Two presets: summer.games (platforms ticked, no encryption) and the Linux dedicated server named in `server.exportPreset`.
- [ ] The export ends with `Publish uploads this one file as a new Build.`
- [ ] The analyzer prints `ok=true` twice.
- [ ] Both probes load their scene, with identical composition manifests.
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
| Upload after only exporting | Run Local Play, the analyzer and both probes first | Each catches what the others miss |
| Export a patch | Export Project, or Export PCK/ZIP without Export As Patch | summer.games takes complete bundles or packs |
