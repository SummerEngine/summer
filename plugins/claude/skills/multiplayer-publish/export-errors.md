# summer.games export: messages, probe codes and errors

Reference for `multiplayer-publish`. The messages are the summer.games
exporter's own, word for word; `%s` stands for the value it names. Headless,
the checks that run before exporting follow `Cannot export project with
preset "summer.games" due to configuration errors:`, and server pack messages
start with `Server pack (<preset>):`.

## Result messages

| Message | Meaning |
| --- | --- |
| `summer.games bundle for iOS, macOS with ETC2/ASTC textures: <path>` | The file to publish, and the platforms and texture formats in `client.pck`. |
| `bundleSha256: sha256:…, bundleSize: …` | The identity of the file you upload. |
| `Entries: summer-bundle.json, client.pck (… bytes), config/…, server.pck (… bytes)` | What the bundle holds. Check that `server.pck` and your `config/` files are listed. |
| `clientSha256: sha256:…, clientSize: …` | The identity of `client.pck` inside the bundle. |
| `Server: server.pck from preset "…", mainScene …` | The server pack and the scene it starts. `Server: none, the game has no host` means there is no `summer.build.json`. |
| `mainScene: …` and `compositionPath: …` | What `client.pck` starts, and the composition both packs are checked against. |
| `Exported by Summer X.Y.Z (engine …). Summer runs it on a template set with the same MAJOR.MINOR and a patch at least this one.` | The Summer version recorded in the bundle. |
| `The Build also accepts: …` | Other client scene + composition pairs your WorldDefinitions name. Only the first is checked here. |
| `The Build also declares …, which no client pack serves.` | `targetPlatforms` lists a platform, such as `web`, that the summer.games client pack does not cover. |
| `Left N server-only files out of client.pck, as <graph> declares.` | The authority and debug files the source graph names stayed out of the client. They ship only in `server.pck`. |
| `Publish uploads this one file as a new Build.` | Done. |

Two warnings also matter: `summer.build.json declares <platform>, but this pack
is not for it. …` (tick that platform), and `The pack starts <scene>, but the
Build's mainScene is <scene>. Set application/run/main_scene, or its
summer_client override, to the Build's scene.`

## Upload probe rejection codes

On failure the probe writes `rejection.json` next to the report instead:

| `code` | Fix |
| --- | --- |
| `invalid_paths` | Use absolute pack and output paths, and `res://` `.tscn` and `.tres` paths. |
| `pack_load_failed` | The pack file is missing or is not a pack. |
| `scene_load_failed` | The scene, or a resource it loads, is not in that pack. Fix that preset's filters. |
| `composition_load_failed` | The composition is missing from that pack, is not a `SummerNetworkComposition`, or has a script. |
| `composition_invalid` | The composition fails its own validation, for example a state stream without a schema or audience policy. |
| `manifest_invalid` | The composition's manifest is not `summer.network.composition.v1`. Probe with the Summer version you exported with. |

## Export errors and fixes

| Message | Fix |
| --- | --- |
| `summer.build.json must list the Build's targetPlatforms, for example ["ios", "macos", "windows"].` | Add a `targetPlatforms` array. |
| `summer.build.json's targetPlatforms [%s] name no platform a client pack runs on: ios, macos or windows.` | List at least one of `ios`, `macos`, `windows`. |
| `summer.build.json's executionMode is '%s'; it must be hosted or standalone.` | Use `hosted` for a multiplayer game. |
| `A game without a host (executionMode standalone) names its client.entryPoint in summer.build.json: it is the pack's mainScene.` | For multiplayer, set `executionMode` to `hosted`. For a single-player game, delete `summer.build.json`. |
| `summer.build.json lists an invalid WorldDefinition path: %s.` | Use a project-relative path with no `..`, backslash or leading `/`. |
| `Cannot read %s.` or `%s is not a JSON object: %s (line %d).` | Fix that file's location or its JSON. |
| `A hosted Build's pack starts a WorldDefinition's client_entry_point with one of its network_compositions, and no WorldDefinition in summer.build.json's runtime.worldDefinitions names both.` | Give a WorldDefinition both `client_entry_point` and `network_compositions`. |
| `Tick the platforms the game supports.` | Tick iOS, macOS or Windows on the summer.games preset. |
| `The project has no main scene for the pack to start.` | Set `client_entry_point` (or, without `summer.build.json`, the project's main scene). |
| `The pack's mainScene %s does not exist in this project.` | Create the scene, or fix `client_entry_point`. |
| `The pack's compositionPath %s does not exist in this project.` | Create the composition, or fix `network_compositions`. |
| `iOS and macOS read ETC2/ASTC textures. Enable Import ETC2 ASTC in Project Settings > Rendering > Textures > VRAM Compression (Fix Import does this).` | Do that, or set `textures/vram_compression/import_etc2_astc=true`. |
| `Windows reads S3TC/BPTC textures. Enable Import S3TC BPTC in Project Settings > Rendering > Textures > VRAM Compression (Fix Import does this).` | Do that, or set `textures/vram_compression/import_s3tc_bptc=true`. |
| `Summer's client templates cannot decrypt a pack. Turn off encryption in this preset.` | Turn off encryption on the summer.games preset. |
| `A client pack cannot be exported as a dedicated server. Use Export Mode "Export all resources" or a selection.` | Dedicated-server mode belongs on the server preset only. |
| `%s is a symbolic link or junction, and the bundle carries only files inside the project. Replace the link with the file itself.` | Replace the link with a real file. |
| `%s resolves to %s, outside the project. The bundle carries only files inside the project.` | Move the file into the project. |
| `%s names an invalid %s path: %s. Name a file inside the project, without .. or backslashes.` | Fix that path in `summer.build.json` or the WorldDefinition. |
| `%s names %s %s, which does not exist in this project.` | Create the file, or fix the path. |
| `%s names %s %s: %s` | The named WorldDefinition, runtime descriptor or source graph is a link, is outside the project, or is not a JSON object. |
| `summer.build.json names no server.exportPreset. A hosted game's bundle carries server.pck, exported with that preset (normally a Linux dedicated server).` | Add `"server": { "exportPreset": "<name>" }`. |
| `summer.build.json names server preset "%s", which this project doesn't have. Its export presets are: %s.` | Create the preset, or fix the name. Names must match exactly. |
| `summer.build.json's server preset "%s" exports for %s. server.pck needs the game's dedicated-server preset, normally Linux.` | Point `server.exportPreset` at a Linux preset, not at summer.games. |
| `The Build's WorldDefinition names no headless_engine component entry_point, the scene server.pck starts.` | Add a `headless_engine` component with an `entry_point`. |
| `The server pack's mainScene %s does not exist in this project.` | Create the server scene, or fix `entry_point`. |
| `No source graph: server code may ship in client.pck. Name one in the WorldDefinition (source_graph) or exclude server files in the preset.` | A warning. Add `source_graph` to the WorldDefinition and write `source-domains.json`. |
| `%s names source graph %s, which is not a valid summer.source-domain-graph.v1 (%s at %s: %s), so the export cannot tell which files to leave out of the client pack.` | Fix the field the message names. The rules are under "source-domains.json" in section 3. |
| `The client pack keeps %s, which depends on %s, but the source graph leaves %s out of the client pack. Move what the client needs under a shared or client root, or remove the reference.` | A client or shared file loads a server-only file. Move the part both sides need into a `shared` path, or remove the reference. |
| `The pack's %s %s is in the source graph's %s domain, which the client pack leaves out. Put the scenes and resources the client starts under a shared or client root.` | The client entry scene or the composition sits under an authority or debug root. Move it to a `client` or `shared` path. |
| `Server preset "%s" is not a dedicated server export, so server.pck keeps the game's visuals. Set its Export Mode to Dedicated Server.` | A warning. Set the server preset's Export Mode to **Export as dedicated server**. |
| `Summer's client templates run GDScript only, so the Platform rejects a pack with native code, C# or a .gdextension. Exclude these from the preset's resources: %s.` | Exclude the listed `.gdextension`, `.dll`, `.dylib`, `.so`, `.a`, `.wasm`, `.cs` and `.csproj` files from the summer.games preset. |
| `The Platform starts the pack's mainScene with its compositionPath, but the preset's resource filters leave out %s.` | The summer.games preset's filters drop the client scene or the composition. Stop excluding it. |
| `The server pack starts %s with %s, but the server preset's resource filters leave out %s.` | The server preset's filters drop the server scene or the composition. Stop excluding it. |
| `The server preset "%s" could not export server.pck.` | Read the `Server pack (<preset>): …` messages before it. |
| `The summer.games bundle is one .zip file, not %s. Export a .pck with Export PCK/ZIP for a client-only update.` | Export Project to a `.zip`. |
| `The client pack is one .pck file, not %s. Export a .zip for the summer.games bundle.` | Use a `.pck` path for a client-only pack, or a `.zip` for the bundle. |
| `summer.games takes a complete bundle or pack, not a patch. Export it with Export Project, or with Export PCK/ZIP without Export As Patch.` | Untick Export As Patch. |

The exporter uses the source graph only to keep server files out of
`client.pck` and to stop when the client needs one of them. It does not run
the full source graph analyzer (step 4b of `multiplayer-publish`), the queue
rules, or the other `summer.build.json` rules (`multiplayer-project`). Summer
checks those when you upload, so follow them exactly.
