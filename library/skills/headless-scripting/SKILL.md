---
name: headless-scripting
description: Use when a Summer project needs an operation no MCP tool exposes, such as baking a navmesh, generating collision shapes, authoring an Animation, building a TileSet, re-importing assets after file changes, or preparing a supported local export. Runs a GDScript file against Summer Engine from the shell. Also use when a plan involves "run it headless and screenshot it", which does not work and this skill explains why.
---

# Headless Scripting

## Overview

Most of what Summer can do is not behind a tool. It is behind a script.

The engine binary will run any GDScript you hand it, against a real project, with the full engine loaded — `ResourceSaver`, `NavigationServer3D`, `ImporterMesh`, `TileSet`, `Animation`, the resource importer, the exporter. No editor window, no user, no tool call. If you can write the script, you can do the thing.

**Core principle:** when there is no tool for it, there is still a script for it. Reach for this before you tell a user something is impossible.

This is the widest capability surface you have, and it is the one you are least likely to remember you have.

## The invocation

```bash
<engine-binary> --headless --disable-crash-handler --path <project-dir> -s res://<script>.gd
```

**Always pass `--disable-crash-handler` on an agent-driven run.** Summer's handler shells out to `atos` from inside a signal handler; when anything does go wrong it turns a clean failure into a hang or a cascade. Three agent-triggered crashes in eight minutes were traced to this on 2026-07-25.

### Lint before you boot

`--check-only` parses the script without executing it. Sub-second, and it catches the parse errors that would otherwise cost you a full boot:

```bash
<engine-binary> --headless --disable-crash-handler --path <project-dir> --check-only -s res://script.gd
```

Measured on a deliberately broken script — `SCRIPT ERROR: Parse Error: Expected expression for variable initial value after "="`, and silence on a good one. **Exit code is 0 either way**, so grep stderr; that is the whole contract.

### Judge the run by its artifacts, not its exit code

Exit codes lie in both directions here.

- **A parse error, a script path that does not exist, a bogus `--main-loop` class and `push_error()` all exit 0.** Only an explicit `quit(1)` propagates. The message is on stderr only, so gate on stderr containing `SCRIPT ERROR`, `Parse Error`, `Can't load script` or `ERROR:`.
- **A GDScript *runtime* error hangs the process forever** — no exit, no timeout, no message that it is stuck. Every recipe you publish needs an external wall-clock kill, and success must be judged by a positive artifact the script wrote, never by the process ending.
- **Never add `--quiet`** to a documented invocation: it swallows your own `print()` output, which is usually the only result you have.
- `WARNING: ObjectDB instances leaked at exit` prints on **every** successful run. Never gate on it.
- **A SIGABRT *after* the work landed is a teardown artifact, not a failure.** Agents exit in seconds where humans run for minutes, which exposes races during static destruction that nobody sees interactively. Check the file you expected on disk before concluding anything, and never blind-retry a crash — that is how one crash became three.

### Two invocations to never issue

- **`--write-movie` under `--headless` is a deterministic crash**, not a graceful failure. `MovieWriter::add_frame()` dereferences a null image from the dummy renderer on frame one. Headless has no pixels, so there is no safe form of this. Frame capture needs the windowed verify instance below.
- **`--quit-after 1`** hits the fast-exit path and aborts during static destruction. Use `--headless --quit-after 60` if you need a bounded editor run — with `--headless`, never without.

### Never put a window on the user's screen

<EXTREMELY-IMPORTANT>
**Every engine launch you make is `--headless`.** The user did not ask you to open anything. A window that appears unasked steals focus, interrupts whatever they were doing, and is indistinguishable from a crash or a bug from their side. This is a product rule, not a convenience.

The one exception is the verify instance, and it is safe precisely because it is not visible: `--summer-verify` opens a real rendering window that is **hidden, `NO_FOCUS`, and positioned at `(-32000,-32000)`** (`main/main.cpp:2363` and following). That is why it can produce real pixels without ever appearing. Never reproduce the "I need a renderer" reasoning by launching a plain windowed editor — use `--summer-verify`.

If you genuinely believe the user needs to see the editor, ask them first.
</EXTREMELY-IMPORTANT>

### Finding the binary — do not guess

Call `summer_get_project_context` and read **`engineBinaryPath`**. That is the running engine's own `OS.get_executable_path()`, already resolved through the macOS `.app` bundle to the real inner executable.

If you are inside a script that is already running in the engine, it is just `OS.get_executable_path()`.

If neither is available (an older engine build that predates `engineBinaryPath`, or no editor running), fall back to the install location for the platform:

| Platform | Path |
|---|---|
| macOS | `/Applications/Summer.app/Contents/MacOS/Summer` |
| Windows | `%LOCALAPPDATA%\Summer\current\Summer.exe` |
| Linux | `~/.summer/engine/summer-linux-x86_64`, or `$SUMMER_ENGINE_BINARY` (see `running-in-the-cloud`) |

<EXTREMELY-IMPORTANT>
There is no `godot` binary on a Summer user's machine. `godot --headless`, `godot4`, `/usr/local/bin/godot` — none of these exist. A command built on that name fails with "command not found" on every single user, and no amount of retrying changes it. This skill exists partly because that exact instruction shipped in our own docs for months.
</EXTREMELY-IMPORTANT>

### The script must extend `SceneTree` or `MainLoop`

`-s` does not load an arbitrary script. `main/main.cpp` instantiates it as the process's main loop, and rejects anything that is not one.

```gdscript
extends SceneTree

func _initialize():
    # your work here
    quit()          # or the process runs forever
```

`_initialize()` runs before the first frame. If you need frames to have elapsed — physics settled, nodes `_ready`-ed — `await process_frame` inside `_initialize()`, or use `_process(delta)` and `quit()` when done.

Always call `quit()`. There is no other exit.

**The trap:** a script extending `Node` (the reflex, since almost all GDScript does) is a wedge, not an error. The engine's rejection path calls `OS.alert()`, and on macOS that is an `NSAlert` `runModal` with **no headless guard** (`platform/macos/os_macos.mm:352-369`). The process blocks forever on a modal dialog that has no window to appear in. You get **no output at all** and a hung process that must be killed. Measured: five orphaned processes accumulated in one session before the cause was found.

If a headless run produces zero output and never returns, check the first line of your script before you check anything else.

## What this unlocks

Every one of these was run against the shipped binary. The result column is measured output, not expectation.

| Task | Result |
|---|---|
| Collision shape from a mesh | `create_trimesh_shape()` → 12 faces; `create_convex_shape()` → 8 points |
| Navmesh bake | `NavigationServer3D.bake_from_source_geometry_data()` → 2 polys / 4 verts, saved to `.tres` |
| LOD generation | `ImporterMesh` instantiable, `generate_lods()` callable |
| Animation authoring | value + bezier + method tracks saved and reloaded with all 3 intact |
| TileSet authoring | atlas source + per-tile collision polygon, saved to `.tres` |
| Asset re-import | `--import` produced the `.import` sidecar and the `.ctex` |
| Full export | hand-written `export_presets.cfg` + `--export-release` → a 144 MB runnable `.app` |

Themes, shaders, audio bus layouts, input maps and project settings are the same story: plain resources, authored and saved from a script.

### Bake a navmesh

```gdscript
extends SceneTree

func _initialize():
    var nav := NavigationMesh.new()
    nav.cell_size = 0.25
    nav.agent_radius = 0.5

    var geo := NavigationMeshSourceGeometryData3D.new()
    var ground := PlaneMesh.new()
    ground.size = Vector2(10, 10)
    geo.add_mesh(ground, Transform3D.IDENTITY)

    NavigationServer3D.bake_from_source_geometry_data(nav, geo)
    print("polys=", nav.get_polygon_count(), " verts=", nav.vertices.size())
    ResourceSaver.save(nav, "res://levels/level1_nav.tres")
    quit()
```

`ResourceSaver.save()` returns `0` (`OK`) on success. Check it — a silent non-zero is how you ship a level with no navmesh.

Prefer parsing collision shapes over visual meshes as source geometry. `add_mesh()` on a visual mesh pulls geometry back off the GPU and warns loudly about it.

### Generate a collision shape

```gdscript
var mesh: Mesh = load("res://models/rock.glb").instantiate().get_child(0).mesh
ResourceSaver.save(mesh.create_trimesh_shape(), "res://models/rock_col.tres")   # static
ResourceSaver.save(mesh.create_convex_shape(),  "res://models/rock_cvx.tres")   # dynamic
```

Trimesh for static geometry, convex for anything that moves — a `RigidBody3D` with a concave shape is a physics bug, not a modelling choice.

### Author an Animation

```gdscript
var anim := Animation.new()
anim.length = 2.0

var t := anim.add_track(Animation.TYPE_VALUE)
anim.track_set_path(t, "Player:position")
anim.track_insert_key(t, 0.0, Vector3.ZERO)
anim.track_insert_key(t, 2.0, Vector3(0, 5, 0))

var b := anim.add_track(Animation.TYPE_BEZIER)
anim.track_set_path(b, "Player:modulate:a")
anim.bezier_track_insert_key(b, 0.0, 1.0, Vector2(-0.2, 0), Vector2(0.2, 0))

var m := anim.add_track(Animation.TYPE_METHOD)
anim.track_set_path(m, "Player")
anim.track_insert_key(m, 1.0, {"method": "on_landed", "args": []})

ResourceSaver.save(anim, "res://animations/rise.tres")
```

Track paths are `NodePath:property` relative to the `AnimationPlayer`'s `root_node`. Getting that path wrong is the usual reason an animation loads fine and animates nothing.

### Build a TileSet with collision

```gdscript
var ts := TileSet.new()
ts.tile_size = Vector2i(16, 16)
ts.add_physics_layer()

var atlas := TileSetAtlasSource.new()
atlas.texture = load("res://art/tiles.png")
atlas.texture_region_size = Vector2i(16, 16)
atlas.create_tile(Vector2i(0, 0))
ts.add_source(atlas)

var tile := atlas.get_tile_data(Vector2i(0, 0), 0)
tile.add_collision_polygon(0)
tile.set_collision_polygon_points(0, 0, PackedVector2Array([
    Vector2(-8, -8), Vector2(8, -8), Vector2(8, 8), Vector2(-8, 8)
]))

ResourceSaver.save(ts, "res://levels/tiles.tres")
```

`add_physics_layer()` returns `void`, not the layer index. Layers are indexed in creation order from 0.

### Build a scene from script

`PackedScene.pack()` + `ResourceSaver.save()` is how you write a `.tscn` a script built. It has one trap that costs an entire run:

<EXTREMELY-IMPORTANT>
**`pack()` silently drops every node whose `owner` is not set**, and both `pack()` and `ResourceSaver.save()` return `0` anyway. You get two success codes and a scene missing most of its contents.

Measured — a root with one owned child, one unowned sibling, and an unowned grandchild under the owned one:

```
PACK err=0
SAVE err=0
RELOADED children=[&"Owned"]        <- both unowned nodes gone, no error anywhere
```

Note the grandchild vanished too: being a descendant of an owned node is **not** enough. Every node you want persisted needs `.owner` set to the scene root. The root itself does not need one.
</EXTREMELY-IMPORTANT>

```gdscript
var root := Node2D.new()

var layer := TileMapLayer.new()
layer.tile_set = ts
root.add_child(layer)
layer.owner = root              # omit this and the layer vanishes, silently

var ps := PackedScene.new()
ps.pack(root)
ResourceSaver.save(ps, "res://levels/level1.tscn")
```

This is also the answer for tilemaps specifically. A `TileMapLayer`'s cells serialise into `tile_map_data`, a `PackedByteArray` — so "just hand-write the `.tscn`" stops being true the moment there are cells in it. Use `set_cell()` and pack the scene; do not try to edit that field as text.

### Re-import assets you wrote to disk

**This is the single most common way an agent breaks a project.** A `.png` written directly to disk is not a resource yet:

```
ERROR: No loader found for resource: res://raw.png (expected type: unknown)
   at: _load (core/io/resource_loader.cpp:358)
```

The file exists. `FileAccess.file_exists()` returns `true`. `load()` fails anyway, because there is no `.import` sidecar and no imported `.ctex` in `.godot/imported/`.

### Prefer the routes that need no import at all

Reach for these before reaching for `--import`:

1. **`ResourceSaver.save()` to `.tres` / `.res`.** No import step, no editor, no `.godot/` race, and it ships correctly in an exported build. Round-trips for `ImageTexture`, `AudioStreamWAV`, `AudioStreamOggVorbis`, `AudioStreamMP3`, `FontFile`, `ArrayMesh`, `Translation`, `AudioBusLayout`. (One trap: `PortableCompressedTexture2D` saves with `err 0` and reloads **empty** — use `ImageTexture`.)
2. **`.dds` and `.po` load raw.** They are the only formats that need no `.import` and ship as-is. A DDS is a 128-byte header plus raw pixels, which a script can emit directly.
3. **`summer_import_from_url`** already does its own rescan-and-settle in-process, so assets that arrive that way are registered without any of this.

Only when none of those fit — you genuinely need a `.png` on disk to become a texture — run the import:

```bash
<engine-binary> --headless --disable-crash-handler --path <project-dir> --import
```

**Judge it by the `.import` sidecar and the file in `.godot/imported/`, not by the exit status.** If those exist the import succeeded, however the process died. Do not retry blindly. Measured 3/3 clean on 4.6.1; a wider sample put `--import` aborts at 2/12 against `--editor`'s 3/50, statistically the same background boot-abort rate rather than an `--import`-specific crash.

<EXTREMELY-IMPORTANT>
**On shipped builds up to 0.5.55, `--import` hijacks the user's editor connection.** It starts the local API server, which unconditionally overwrites `~/.summer/api-port` and mints a fresh `~/.summer/api-token` — machine-global, no project identity, last writer wins. When the import process exits, that pointer is left aimed at a **dead port with a dead token**, so the user's editor becomes unreachable and MCP reports "Summer Engine is not running" while their editor is plainly open.

Measured on 0.5.55: `port 6550 -> 6551`, new token, editor still alive on 6550 and now unreachable.

So on a shipped build: run `--import` against a throwaway copy where you can, warn the user before running it against their open project, and tell them to restart the editor afterwards if their agent connection drops.

**Fixed on `main` but not yet in any shipped binary** (`_should_publish_discovery`, commit `420222554e`; tracked as SUM-161): batch-mode invocations — `--import`, `--summer-verify`, `--export-*`, `-s`, `--headless`, `--quit-after` — no longer publish. Once that ships, this warning applies only to older builds. Plain `--headless -s` never started the server on any build, so everything else in this skill is unaffected.
</EXTREMELY-IMPORTANT>

Two lifecycle facts that decide the shape of every headless run:

- **There is a hard work-completion floor between 3 and 5 seconds.** Fresh project, 8 small PNGs, editor killed at N seconds: at **3s, 0/8 imports landed in 10/10 cycles** — it boots, gets killed mid-scan, and accomplishes nothing. At **5s, 8/8 landed every cycle.** Never give an import a 3-second budget.
- **`--headless --editor` is not a filesystem watcher.** It never notices files created after boot — 6 assets added 12s in, 45s wait, 0 imported. The rescan is driven by `NOTIFICATION_APPLICATION_FOCUS_IN` (`editor_node.cpp:1096`) and headless never fires a focus event. A long-lived headless editor serves a boot-time snapshot forever.

Both ends of the lifecycle are broken, differently: short runs do no work, long ones go stale. **Boot → act → exit is the only shape that works today.**

Measured before and after on the same file:

```
FILE_EXISTS=true   IMPORT_SIDECAR=false  → ERROR: No loader found for resource
FILE_EXISTS=true   IMPORT_SIDECAR=true   → LOAD_RESULT=<CompressedTexture2D>
```

Run `--import` after **any** batch of raw asset files you wrote yourself — textures, audio, models. The MCP's `summer_import_from_url` already does its own rescan-and-settle, so assets that arrive that way are fine; assets you wrote with `summer_write_file` or your own shell are not.

### Export a build

`export_presets.cfg` is plain text you can write. Then:

```bash
<engine-binary> --headless --path <project-dir> --export-release "macOS" <out-dir>/Game.app
```

Exit code 0 and a real bundle on disk are the success condition — check both. Export templates for the engine's exact version must be installed, or the export fails.

## The trap: `--headless` has no pixels

<EXTREMELY-IMPORTANT>
`--headless` loads the dummy rendering driver. `viewport.get_texture().get_image()` returns **null**:

```
ERROR: Parameter "t" is null.
   at: texture_2d_get (servers/rendering/dummy/storage/texture_storage.h:106)
GET_IMAGE=<Object#null>
```

**Any plan of the form "run the game headless and screenshot it" is dead on arrival.** It does not error usefully — it hands you a null and continues.

Performance is equally meaningless there, but **not in the way it first looks.** Sampled every 30 frames across a 401-frame headless run of the same scene:

```
fps=1.0    draw_calls=0.0  objects=0.0     <- first ~1s
fps=117.0  draw_calls=0.0  objects=0.0
fps=145.0  draw_calls=0.0  objects=0.0
```

Two separate traps in that table:

1. **`draw_calls` and `objects` are `0.0` at every sample, forever.** That is the real headless signature — there is no renderer to count. Those monitors never become meaningful.
2. **The FPS number is not 1.0, and it is not real either.** It settles high (145 here) precisely *because* nothing is being drawn. Quoting it as the game's frame rate is worse than quoting nothing.

And a third trap that is **not** headless-specific: `TIME_FPS` reads exactly `1.0` until it has about a second of history. A probe that samples too early reports 1 fps in a windowed instance too. A leading `1.0` is warm-up, not a stall — sample for at least a second before believing any frame rate.
</EXTREMELY-IMPORTANT>

The answer is not headless. The engine ships a second mode: an offscreen **windowed** instance with a real renderer, positioned far off-screen so the user never sees it. That is what `RunVerification` spawns, and you can spawn it directly:

```bash
<engine-binary> --path <project-dir> \
  --summer-verify <abs-path-to-probe.gd> \
  --summer-verify-out <abs-out-dir> \
  --summer-verify-max 30
```

Note: **no `--headless`**. That is the entire difference.

Measured in that instance, same project, same machine:

```
viewport_image_null : false          (1152x648, pixel(4,4) = the real rendered colour)
display_server      : macOS          (Metal 4.0 — Forward+)
draw_calls          : 1.0            (vs 0.0 headless, at every sample)
frames saved        : 00_start.jpg  01_after_walk.jpg  02_after_jump.jpg
```

So: **scripting and authoring go through `--headless`. Seeing and measuring go through the verify instance.** Choose on that axis and you will not get a null.

For writing probes — the `SummerProbeBase` API, the coroutine rules, what is and is not reproducible — see `playtesting-a-feature`.

## What a script genuinely cannot do

Short list, and it is short on purpose. Everything not on it is worth attempting.

- **Lightmap baking — headless specifically.** The binding exists on this build
  (Summer script-binds `LightmapGI.bake(from_node, image_data_path)`), but the GPU
  lightmapper needs a RenderingDevice, which a `--headless` process never has: the
  call returns `BAKE_ERROR_NO_LIGHTMAPPER`. Bake from `summer_run_script` in the
  **live editor** instead — a normal desktop editor works as-is; a cloud container
  needs the xvfb + GL renderer setup from `running-in-the-cloud`. Wrong
  reason kills the right fix: it is "no renderer in this process", not "no binding".
- **Occlusion culling bake.** `OccluderInstance3D.bake_single_node` is not
  script-callable at all. Editor-button only.
- **Anything needing `EditorInterface`.** Outside the editor, `ClassDB.can_instantiate("EditorScript")` is `false`.
  **Trap:** `Engine.has_singleton("EditorInterface")` returns **`true`** even in a plain headless script — it lies. Retrieving the singleton then fails with `Can't retrieve singleton 'EditorInterface' outside of editor`. Test with `ClassDB.can_instantiate("EditorScript")`, which tells the truth.

## Never verify a write by reading it back from the thing you wrote

This is the single highest-yield rule in this document, because it is the failure mode with no symptom. In-process read-back returns what you set, from memory, whether or not anything reached disk or took effect. The check passes, the work is gone.

Four measured instances of the same shape:

| What you did | What reading it back says | What is actually true |
|---|---|---|
| `PackedScene.pack()` with unset `owner`s | `pack` 0, `save` 0 | Those nodes are not in the file |
| `ProjectSettings.set_setting()` without `save()` | the new value | Nothing on disk; next boot has the old one |
| A setting with a feature-tag override | the base value | The engine is using the override |
| `PathFollow2D.progress = 50.0` | `50.0` | The node never moved |

**Verify from a second process, or by re-reading the file from disk.** Cheapest reliable form: finish the script, then run a second one-liner that `load()`s the artefact fresh and prints what it found — which is exactly what the measurements in this document do. `ResourceSaver.save()` returning `0` means "the write was attempted without error", not "the thing you meant is in there".

## Working pattern

1. Write the script with `summer_write_file` (or your own shell) into the project.
2. Get the binary from `summer_get_project_context` → `engineBinaryPath`.
3. Run it. **Read stdout** — GDScript errors go there, and a script that failed to parse still exits cleanly-looking.
4. Verify the artifact exists on disk and check the `ResourceSaver.save()` return value. "The script ran" is not "the resource was written".
5. If you wrote raw asset files, run `--import`.
6. Delete throwaway scripts. Do not leave `probe_temp_3.gd` in a user's project.

Keep scripts in the project (`res://` is required for `-s`), but name them so their purpose is obvious and clean up after yourself.

## Red Flags — STOP

| Red flag | Reality |
|---|---|
| `godot --headless ...` | That binary does not exist on any user machine. Use `engineBinaryPath`. |
| A `-s` script that `extends Node` | Silent hang on an invisible modal. Must be `SceneTree` or `MainLoop`. |
| Headless run returned nothing and never exited | You extended the wrong class. Kill it and fix line 1. |
| "Run it headless and screenshot" | Headless has no pixels. Use the verify instance, without `--headless`. |
| Profiling under `--headless` | `draw_calls`/`objects` are 0.0 forever; FPS is inflated by drawing nothing. Use the verify instance. |
| Quoting a frame rate sampled in the first second | `TIME_FPS` reads 1.0 until it warms up, in every mode. |
| Wrote a `.png`, then `load()`ed it | No loader found. Save a `.tres` instead, or run `--import`. |
| `--import` against the user's open project on a shipped build | Hijacks their editor binding. Warn first. |
| Killing an import at 3s | Measured 0/8 assets registered. The floor is ~5s. |
| A long-lived `--headless --editor` as a file watcher | It never rescans. Boot, act, exit. |
| Adding `--quiet` | Swallows your own print() output. |
| Launching the editor without `--headless` | Pops a window onto the user's screen unasked. |
| Ignoring `ResourceSaver.save()`'s return value | Non-zero is a silent failure that ships. |
| `pack()` without setting `.owner` on every node | Two success codes, nodes missing from the file. |
| Verifying a write by reading the object you just wrote | In-memory read-back passes whether or not it landed. |
| Script with no `quit()` | Runs forever. |
| "There's no tool for that, so it can't be done" | There is a script for it. Write the script. |

**Related skills:**
- `playtesting-a-feature` — the verify instance, probes, and proving gameplay behaviour.
- `export-and-ship` — the full release pipeline this skill's export example is one step of.
- `verification-before-completion` — checking the artifact before claiming done.
