---
name: fabricating-assets
description: Use when an asset needs Blender's mesh tooling rather than generation or a library download — a modular kit with exact dimensions and snapping, VFX meshes (shatter fragments, curve sweeps, LOD chains), or decimating/UV-unwrapping/baking a generated model — and you are about to write a bpy script for summer_fabricate_3d. Covers the route decision (fabricate vs generate vs import), the bpy rules that survive glTF export, the script -> import -> snapshot -> screenshot loop, every failure_reason and what to do about it, and the licensing shape (the user's own Blender, never bundled).
---

# Fabricating Assets

## Overview

`summer_fabricate_3d` runs a Blender Python (bpy) script you write in the **user's own installed Blender**, headless and supervised by the engine, validates the `.glb` the script's objects were exported to, moves it under `res://`, waits for the import, and (optionally) instantiates it into the open scene with `target_size` normalization. One call: script → glb → import → scene.

It exists for a narrow slice of assets: the mesh-processing mid-tier that the engine does not have (exact booleans, bevels, UV unwrap, decimate, remesh, curve sweeps, fracture) and that generation and libraries serve badly. Everywhere else it is the wrong tool — route first.

Three facts shape every use:

1. **It is optional and detect-never-bundle.** Summer does not ship, download, or install Blender. If the machine has none, the result is a structured `blender_not_found` with the fix, and the decision to install belongs to the user.
2. **It is blind until import.** There is no viewport while the script runs. Perception comes back only through the result (`objects`, `dimensions`, `warnings`, `skipped`) and then through the normal scene loop (`summer_snapshot_diff` + `summer_screenshot`).
3. **One fabrication at a time per editor.** A second call while one is in flight fails with `busy`. Wait for the result; never fire in parallel.

## Route first — fabricate, generate, or import?

| Asset class | First route | Second | Why |
|---|---|---|---|
| Blockout / placeholder | `scene-scripting` primitives or CSG | fabricate | Must be instant and in-scene; no process spawn is justified |
| Generic hard-surface prop ("a barrel") | `summer_search_assets` → `summer_import_asset` (`prop-model`) | `summer_generate_3d` | The free library plus `target_size` beats paid generation and a 2-minute wait, in a consistent style |
| Bespoke prop ("the artifact from our GDD") | `summer_generate_3d` | fabricate | Image-to-3D is exactly what generation is for; fabricate when exact dimensions or parametric variants matter |
| **Modular kit** (walls, pipes, fences, rails that snap) | **fabricate** | library kit (`environment-kit`) | Generation cannot hold dimensions and style across 30 pieces; array + boolean + bevel + one material is the classic kit workflow |
| Characters (rigged, animated) | `summer_generate_3d` (`character-model`) | library | Scripted organic modelling is the documented failure mode; fabrication has no path to competitive organics blind |
| Environments / terrain | in-engine terrain + library set dressing | generation for landmarks | Terrain wants interactive tools; dressing wants scatter |
| Materials / textures / skies | library (`summer_import_hdri`, texture packs) | generation | Fabricate only to bake a procedural material to images |
| **VFX meshes** (shatter pieces, trails, sweeps, LOD chains) | **fabricate** | in-engine | Bisect/fracture, curve sweeps, decimate are one-liners in bpy and absent in the engine |
| **Post-processing a generated model** (decimate / UV / bake) | **fabricate** | — | The fix for generation's documented weaknesses; no other route exists |
| UI | library + 2D image generation | — | 3D tooling is irrelevant |

Fabricate wins in exactly three rows. If the request is not one of them, stop here and use `asset-strategy` to pick the specialist skill.

## Prerequisite — the user's Blender

The engine looks for Blender 4.2 LTS or newer in this order:

1. `blender_path` passed in the call (only when the user named a path — never guess one);
2. the `SUMMER_BLENDER_BIN` environment variable of the editor process;
3. Editor Settings → FileSystem → Import → Blender → Blender Path (`filesystem/import/blender/blender_path`, the same setting `.blend` import uses);
4. `PATH`, the platform's well-known install locations, and `~/.summer/tools/blender-<version>/`.

When none resolves, the result is `failure_reason: blender_not_found` with `tried` (every path checked) and a prescriptive `error`. Relay it as a one-line decision: "Fabrication needs Blender (4.2 LTS or newer) on this machine. Install it from the official Blender download page, or point `SUMMER_BLENDER_BIN` at an existing executable and restart the editor. Or I can generate the asset or import one from the free library instead." Then do what the user chooses. Do not install software on their behalf, and do not retry the call hoping the answer changes.

The `blender_version` in every successful result is a fact, not a suggestion: bpy APIs change across majors, and models skew toward older bpy from training data. When a `script_error` names a missing attribute or operator, check it against the version that actually ran.

## The script contract

`source` is plain bpy code. It runs in a factory-startup Blender (no user add-ons, no preferences, online access off) with an **empty** scene — no default cube, light, or camera — and these names already bound: `bpy`, `bmesh`, `mathutils`, `math`, `Vector`, `Matrix`, `Euler`.

The script must **create mesh objects and leave them linked in the scene**. Nothing else. The engine's bootstrap then collects, audits, exports, and validates:

- **Do not export, do not save, do not quit.** `bpy.ops.export_scene.gltf`, `bpy.ops.wm.save_mainfile`, `bpy.ops.wm.quit_blender` in your script break the contract and the run.
- **What exports:** `MESH`, `CURVE`, `SURFACE`, `META`, `FONT` objects become meshes; `EMPTY` and `ARMATURE` keep hierarchy and skins; cameras, lights, probes and speakers are dropped.
- **Hidden means helper.** An object hidden in the viewport or disabled for render is treated as a boolean cutter or guide: it is *not* exported and is listed in `skipped`. Use this deliberately for cutters; check `skipped` when a piece is missing.
- **Modifiers are applied at export** (`export_apply`), including Geometry Nodes — the scene stays non-destructive, so do not `modifier_apply` by hand unless you need the result for a later step (a boolean whose output feeds a second boolean, for instance). Consequence: **shape keys are dropped** when modifiers exist; a `warning` says so.
- **Only a Principled BSDF surface survives glTF.** Any other shader (Emission-only, Diffuse, custom node group) exports grey or black — a `warning` names the material. Build materials as Principled BSDF with constant values or Image Texture inputs.
- **Procedural Base Color is baked for you** (Cycles, 2K cap, capped material count; meshes without UVs get a Smart UV Project first) and reported in `baked`. **Procedural Metallic / Roughness / Normal / Emission / Alpha are NOT baked** — set constants, or bake them to an Image Texture in your script; the `warnings` list tells you which channel was left procedural.
- **Axis and units:** model in Blender's native Z-up, in metres; the export converts to the engine's +Y-up (`dimensions` in the result is already +Y-up). A 2 m wall segment is `dimensions.y ≈ 2`.
- **Naming:** object names become node names in the imported scene. Name every object and material (`obj.name = "Wall_2m_A"`). The `name` argument names the `.glb` (`res://assets/fabricated/<name>.glb` unless `out_path` says otherwise) and the instantiated node; it is sanitized to `[A-Za-z0-9_-]`.
- **Determinism:** seed anything random (`random.seed(7)`, noise textures with fixed seeds). A re-run must produce the same mesh so the loop below converges.
- **No network.** Blender's online access is off; scripts that fetch anything fail. Reference images and existing models come from the project on disk (below).

### Minimal template

```python
# Kit piece: 2 m wall segment with a door cutout, bevelled, one material.
import bmesh

def make_box(name, size, location):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = size
    bpy.ops.object.transform_apply(scale=True)
    return obj

wall = make_box("Wall_2m_Door", (2.0, 0.2, 3.0), (0, 0, 1.5))

cutter = make_box("DoorCutter", (1.0, 0.4, 2.1), (0, 0, 1.05))
cutter.hide_set(True)          # hidden = helper: used by the boolean, never exported
cutter.hide_render = True

cut = wall.modifiers.new("Door", "BOOLEAN")
cut.operation = "DIFFERENCE"
cut.object = cutter
cut.solver = "EXACT"

bevel = wall.modifiers.new("Bevel", "BEVEL")
bevel.width = 0.02
bevel.segments = 2

mat = bpy.data.materials.new("KitStone")
mat.use_nodes = True
bsdf = mat.node_tree.nodes["Principled BSDF"]
bsdf.inputs["Base Color"].default_value = (0.55, 0.52, 0.48, 1.0)
bsdf.inputs["Roughness"].default_value = 0.85
wall.data.materials.append(mat)
```

Call it with `name: "wall_2m_door"`, `import_to_scene: {parent: "./Kit"}`, no `target_size` (the piece is already modelled at 2 × 0.2 × 3 m — a kit that snaps must keep its authored dimensions).

## The loop

1. `summer_get_project_context` — confirm the engine is up and which project is bound; read `projectPath` if the script needs a file from the project.
2. `summer_world_snapshot` — the BEFORE baseline; keep `snapshot_id`.
3. `summer_fabricate_3d` — `source`, `name`, `import_to_scene: {parent, position?}`, and `target_size` only when the asset is *not* dimension-authored (a hero prop whose size you are normalizing, not a kit piece). Default `max_seconds` 120 covers boot + script + bake + export for ordinary pieces; raise it (up to 600) for exact booleans on dense meshes or several bakes.
4. **Read the result before looking at anything else.** `ok` and `ran`; `objects[]` (each with `vertices`, `faces`, `triangles`, `materials`, `modifiers`) against what you meant to build; `dimensions` in +Y-up metres against the spec; `skipped` for pieces that vanished because they were hidden; `warnings` for grey-material and unbaked-channel problems; `baked` for what the bootstrap did to your materials; `output` for your own `print()`s. A non-zero `exit_code` after a validated export is a warning, not a failure — the artifact is what was verified.
5. `summer_snapshot_diff from_id:<the id>` — the structural receipt: exactly one new subtree under `parent` named `<name>`, nothing else changed.
6. `summer_screenshot` — look at it. `target:"scene" framing:"camera"` when materials or lighting matter; a preset framing for silhouette and scale checks.
7. Iterate on the script and re-run with the same `name` — the `.glb` is overwritten in place (`overwrote_existing: true`), and the previously instantiated node is still in the scene: remove it with `summer_remove_node` before re-importing to scene, or import without `import_to_scene` and let the existing instance pick up the new file.
8. `summer_save_scene` once the piece is right. Instantiation is one undo action in the open scene, not a save — an unsaved instance is lost when the editor closes.

Never claim a visual result without step 6. The full perception discipline is `verifying-scenes`.

### Post-processing a generated model

Generation delivers dense triangulated geometry with poor UVs. Fabrication is the fix:

```python
import os
src = os.path.join(PROJECT_DIR, "assets", "generated", "goblin_statue.glb")   # PROJECT_DIR from summer_get_project_context.projectPath
bpy.ops.import_scene.gltf(filepath=src)
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
for o in meshes:
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    dec = o.modifiers.new("Decimate", "DECIMATE")
    dec.ratio = 0.25
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.02)
    bpy.ops.object.mode_set(mode="OBJECT")
```

Substitute the real absolute project path for `PROJECT_DIR` (a string literal built from `summer_get_project_context` → `projectPath`); scripts have no `res://`. Write the result to a *new* `out_path` (`res://assets/generated/goblin_statue_lod1.glb`) so the original stays for comparison, and compare `objects[].triangles` before and after in the result.

### Shatter fragments without add-ons

Factory startup disables add-ons, so cell-fracture operators are not available. Cut with `bmesh.ops.bisect_plane` in a loop over random planes, `bmesh.ops.split_edges` / separate by loose parts, and name each fragment `Shard_00`, `Shard_01`, … — the imported scene then carries one `MeshInstance3D` per shard, ready for a `RigidBody3D` wrap in a `summer_run_script` pass.

## Failure taxonomy — read `failure_reason`, then act

| `failure_reason` | What happened | Do |
|---|---|---|
| `engine_lacks_op` | This engine build predates FabricateMesh (nothing was sent) | Route to `summer_generate_3d`, `summer_search_assets` / `summer_import_asset`, or `summer_run_script` blockout geometry; tell the user an engine update enables fabrication |
| `blender_not_found` | No usable Blender executable (see `tried`) | Relay the one-line decision above; never guess a path or install anything |
| `blender_launch_failed` | The executable exists but did not start (permissions, broken install, wrong architecture) | Show the `error` and `output` tail to the user; a different `blender_path` or a reinstall is their call |
| `script_error` | Your bpy raised (`traceback_tail`, `script_line`, `blender_version`) | Fix the named line against the reported version; `script_line` maps to your `source` |
| `timeout` | The child exceeded `max_seconds` (echoed) and was killed; nothing was imported | Raise the budget (≤ 600), or split — one piece per call, fewer bakes, coarser booleans |
| `export_empty` | The script left no exportable object | Everything hidden? Not linked to a collection? Wrong type (a light, a camera)? Check `skipped` |
| `export_failed` / `export_missing` | The exporter failed or wrote nothing | Read `errors` — usually a material or modifier the exporter cannot handle; simplify |
| `bootstrap_error` | The engine's own bootstrap failed (not your script) | Report it verbatim as a bug; do not work around it |
| `import_failed` | The `.glb` is at `out_path` but the editor did not import it | Read the importer's message with `summer_get_console`; often a zero-face mesh or an oversized texture. Fix and re-run, or `summer_instantiate_scene` the file after a manual rescan |
| `instantiate_failed` | Imported fine; instantiation into the open scene failed (bad `parent`, no scene open) | The asset is in the project — open the right scene and `summer_instantiate_scene` it with `target_size` |
| `busy` | Another fabrication is in flight | Wait for that result; never parallelize |
| `cancelled` / `shutdown` | The run was cancelled or the editor closed | Re-run when the editor is back |
| `rejected_identity` | The engine switched projects mid-run | `summer_get_project_context` to rebind, then decide whether to re-run |
| `bad_args` | Malformed `out_path`, `target_size`, or empty `source` | Fix the argument; nothing was sent |

Every failure leaves the project untouched except `import_failed` / `instantiate_failed`, which are honest about the `.glb` they did write. A `no_rewind_point: true` on any result means no SummerGit checkpoint exists for the run — say so before doing more destructive work.

## Licensing and attribution

- **Blender is the user's.** Summer runs the executable they installed as a separate process and talks to it only through arguments, files, and the exit code. Nothing in Summer links against Blender or imports bpy; the small export bootstrap the engine writes to a scratch directory is a separately licensed GPL file precisely because it does. Do not move project logic into bpy scripts expecting it to stay proprietary.
- **Output is unencumbered.** Meshes made with Blender belong to the user; the `.glb` in their project carries no Blender licence obligation.
- **Scripts you write here are created on the user's machine and never distributed by Summer.** If you adapt a bpy snippet from elsewhere, respect its licence — prefer your own code or CC0 sources, and record the origin in `.summer/memory/decisions/` when it matters for the project.
- **Trademark.** "Blender" is a trademark of the Blender Foundation. Refer to it factually as the dependency ("requires Blender"); never describe the feature as powered by, built on, or branded with Blender, and never use its logo. Summer's name for this capability is *mesh fabrication*.
- Imported library assets keep their own licences (`summer_search_assets` results carry `licenseType`); fabrication does not change that.

## Red Flags — STOP

| Red flag | Reality |
|---|---|
| Fabricating a barrel, a crate, a chair | Library first, generation second. Fabricate is for kits, VFX meshes, and post-processing |
| Fabricating a character or creature | Scripted organic modelling is the documented failure mode; `summer_generate_3d` with rigging |
| A script that calls `export_scene.gltf`, saves, or quits | Breaks the contract; the bootstrap exports |
| A material that is not a Principled BSDF | Exports grey; the `warnings` list said so |
| Procedural roughness or normal maps left unbaked | Not baked automatically — set constants or bake in the script |
| `target_size` on a kit piece | Destroys the authored dimensions the kit snaps on |
| Two fabrications in flight | `busy`; one at a time per editor |
| Guessing a `blender_path` | Only the user knows where their Blender is; use the resolution order |
| Installing Blender for the user | Never. Relay the decision |
| Claiming the piece looks right without a screenshot | The fabricator is blind; only step 6 sees |
| A hidden object that was supposed to export | Hidden means helper; unhide it or check `skipped` |
| Retrying the same script after `timeout` | Raise the budget or split the job; the same oversized script times out again |

**Related skills:**
- `asset-strategy` — the route decision for every "I need a [thing]".
- `environment-kit`, `prop-model`, `character-model` — the generation and library specialists fabrication defers to.
- `scene-scripting` — in-scene geometry, placement loops, and wrapping fabricated pieces in bodies and collisions.
- `verifying-scenes` and `verification-before-completion` — the evidence discipline after import.
