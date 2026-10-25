---
name: scene-scripting
description: "Build scenes, levels, HUDs and wiring with one editor GDScript (summer_run_script) instead of call chains."
---

# Scene Scripting

## Overview

`summer_run_script` runs one GDScript **inside the live editor, against the scene named by `scenePath`**. When that scene is not the edited one, it is opened first (a request of its own) and the person's tab comes back after the run; if it cannot be opened, the script does not run. One script replaces a chain of `summer_add_node` / `summer_set_prop` calls, and it does what single calls cannot: loops, randomness, math, procedural geometry, reading existing nodes before deciding.

**The rule: 3 or more related scene edits, or ANY computed placement → one script.** A single property tweak → `summer_set_prop`. A cold project-wide batch job → `summer_run_editor_script` (below).

## The contract

```
summer_run_script(scenePath="res://levels/level_01.tscn", source="""
func run(ctx):
    var root = ctx.get_scene_root()
    var node := MeshInstance3D.new()
    node.mesh = BoxMesh.new()
    root.add_child(node)
    ctx.set_owner_recursive(node)   # REQUIRED: see owner rules
    ctx.report("added", node.name)
    ctx.save_scene()
""")
```

- `scenePath` — the exact `res://` scene the script changes (from `summer_get_project_context` or the scene tree). Always pass it; without it the script runs against whichever tab happens to be open. The result's `scene_target` says whether the scene was opened and which tab came back.
- `source` — just the function: no `extends`, no `@tool` (missing ones are added and reported in `normalizations`).
- `ctx.get_scene_root()` — root node of that scene. `ctx.set_owner_recursive(node)` — stamp a created subtree with the scene-root owner. `ctx.report(key, value)` — structured results back (`reports`). `print(...)` — captured into `output`.
- Values are real GDScript: `Vector3(0, 10, 0)`, `Color(1, 0, 0, 1)`. The quoted variant-string convention (`"Vector3(0, 10, 0)"`) belongs to `summer_set_prop`, not to script code.
- `ctx` is untyped, so its results are untyped: write `var wall = ctx.add_mesh(...)`. `var wall := ctx.add_mesh(...)` does not compile ("Cannot infer the type").
- Saving: `ctx.save_scene()` writes the scene (after an ownership audit). Without it the change stays in the editor, unsaved.
- Budget: `max_seconds` default 20, clamp 5–120. The script blocks the editor between frames; on newer engines the budget is a HARD deadline (`"Summer script budget exceeded (Ns)"`, `budget_enforced: true`). Split the work into smaller scripts — never resubmit the same oversized one.
- Transactions: newer engines wrap the run in ONE named undo action (`undo: "action"`, the default) and roll it back on a mid-script runtime error — the result carries `rolled_back: true` and the scene is untouched. `undo: "none"` keeps partial mutations. Older engines ignore the param; treat any `errors` there as a possible half-applied mutation.

## The core ctx API

Creation helpers **set the owner for you** and return the created node — prefer them over `new()` + `add_child` + `set_owner_recursive`. Frozen signatures:

```gdscript
add_node(type: String, name: String, parent: Node = null, props: Dictionary = {}) -> Node
find(name: String) -> Node                    # recursive in edited scene; null on miss
get_or_create(type: String, name: String, parent: Node = null) -> Node
instance_scene(res_path: String, parent: Node = null, name: String = "") -> Node
add_mesh(shape: String, name: String, parent: Node = null, props: Dictionary = {}) -> MeshInstance3D
    # shape: box|sphere|capsule|cylinder|plane
add_mesh_with_collision(shape, name, parent = null, props = {}) -> MeshInstance3D
    # + StaticBody3D/CollisionShape3D child matching the mesh
mesh_from_arrays(vertices: PackedVector3Array, indices: PackedInt32Array,
                 uvs: PackedVector2Array = [], name: String = "Mesh",
                 parent: Node = null) -> MeshInstance3D
make_material(props: Dictionary) -> StandardMaterial3D
apply_material(node: Node, material: Material) -> bool
grid(count_x: int, count_z: int, spacing: Vector3, maker: Callable) -> Array
    # maker(i: int, pos: Vector3) -> Node
scatter(area: AABB, count: int, maker: Callable, seed: int = 0) -> Array
add_light_rig(target: Node = null) -> Node3D   # key/fill/rim under one Node3D
ensure_environment(props: Dictionary = {}) -> WorldEnvironment
add_camera(position: Vector3, look_at: Vector3 = Vector3.ZERO,
           make_current: bool = false) -> Camera3D
summary() -> Dictionary                        # counts by class, lights, cameras, scene AABB
save_scene(path: String = "") -> bool          # ownership audit first; false + report on audit failure
frames_budget_exceeded() -> bool
```

`props` apply via `set()` per key; unknown keys are collected into a `prop_warnings` report entry, never silently dropped — read it. On an **older engine** a missing helper is a plain GDScript error (`Invalid call to method 'add_mesh'…`): fall back to the manual form, which works everywhere.

Newer engines add three more tiers. Their frozen signatures, conventions and fallbacks are in `references/ctx-api.md` (read it with `summer_docs_read` id `skill/scene-scripting/references/ctx-api.md`):

- **Geometry:** `boolean`, `extrude_polygon`, `lathe`, `sweep`, `terrain`, `set_smooth`, `decimate`, `convex_collision`, `uv_planar` / `uv_box`, `mirror`, `animate`, `make_shader`; `add_mesh` also takes `torus` and `text`.
- **Animation:** `animate_method`, `anim_state_machine`, `bone_pose`, `look_at_modifier` (the full recipe lives in `character-animation-wiring`).
- **Game completeness (2D, UI, gameplay code):** `add_sprite`, `add_animated_sprite`, `add_tilemap`, `paint_tiles` / `paint_rect`, `add_body_2d`, `add_camera_2d`, `add_parallax`, `add_ui`, `add_canvas_layer`, `set_theme_overrides`, `connect_signal`, `attach_script`, `make_prefab`, `add_autoload`, `add_input_action`, `set_main_scene`.

**Engine posture.** Not every engine build exposes every tier. On an engine with RunSceneScript that predates a tier, a missing helper is a plain GDScript error and, under the default `undo: "action"`, the whole run rolls back. `references/ctx-api.md` has the table of what works on every engine.

## Owner rules

**Every node you create must be owned by the scene root, or it silently vanishes when the scene saves.** Descendants too — being under an owned node is NOT enough. `add_child` succeeds, the screenshot even shows it, and the saved `.tscn` is missing it.

```gdscript
root.add_child(node)
ctx.set_owner_recursive(node)   # node + every descendant
```

The ctx creation helpers own what they create. For anything you build with `new()`, call `ctx.set_owner_recursive(node)` (or set `node.owner = root` on the node AND each descendant) AFTER `add_child` — owner assignment fails on a node not yet in the tree. Re-stamp the owner after any `reparent`.

## The loop

1. `summer_world_snapshot` — the structured BEFORE baseline; keep its `snapshot_id`.
2. `summer_api_docs` — verify every property/method name you are not certain of.
3. `summer_run_script` with `scenePath` — run the script.
4. Read `errors`, `reports`, `rolled_back` and `scene_target` in the result — `rolled_back: true` means a runtime error undid everything (fix and re-run); on older engines / `undo: "none"`, an error can leave a partial mutation.
5. `summer_snapshot_diff from_id:<the id>` — the structural receipt: exactly the nodes you meant to add were added, nothing else changed, nothing vanished (an unowned node dropping on save shows up HERE).
6. `summer_screenshot` — LOOK at it. Use `target:"scene" framing:"camera"` when the change touched lighting, environment, or emissive materials — the preset framings render a flat substitute environment and cannot show those.
7. Iterate. Never claim visual success without steps 5–6 (a capture is a fact; describing an unseen frame is fabrication). The full perception discipline lives in `verifying-scenes`.

## Verify names with summer_api_docs — never guess

Wrong property names fail silently or throw mid-script after half the mutation applied. Before using an unfamiliar class:

```
summer_api_docs(class_name="CylinderMesh")              # all properties/methods
summer_api_docs(class_name="BoxShape3D", member="size") # {type:"Vector3", default:"Vector3(1, 1, 1)"}
```

Entries list only members **declared on that class** — `position` lives on `Node3D`, not `MeshInstance3D`. Walk `inherits` upward when a member seems missing.

## Two examples

Scatter 40 trees with deterministic randomness:

```
summer_run_script(scenePath="res://levels/forest.tscn", source="""
func run(ctx):
    var rng := RandomNumberGenerator.new()
    rng.seed = 12345                       # same seed, same forest on a re-run
    for i in range(40):
        var tree = ctx.instance_scene("res://props/tree.tscn", null, "Tree%d" % i)
        tree.position = Vector3(rng.randf_range(-20, 20), 0, rng.randf_range(-20, 20))
        tree.rotation.y = rng.randf_range(0, TAU)
        var s := rng.randf_range(0.8, 1.3)
        tree.scale = Vector3(s, s, s)
    ctx.report("scattered", 40)
    ctx.save_scene()
""")
```

A key/fill/rim lighting rig:

```
summer_run_script(scenePath="res://main.tscn", source="""
func run(ctx):
    var rig = ctx.add_node("Node3D", "LightRig")
    ctx.add_node("DirectionalLight3D", "KeyLight", rig, {"light_energy": 1.2, "shadow_enabled": true, "rotation_degrees": Vector3(-45, -30, 0)})
    ctx.add_node("OmniLight3D", "FillLight", rig, {"light_energy": 0.4, "position": Vector3(-4, 2, 4)})
    ctx.add_node("SpotLight3D", "RimLight", rig, {"light_energy": 0.8, "position": Vector3(0, 3, -5), "rotation_degrees": Vector3(-20, 180, 0)})
    ctx.save_scene()
""")
```

Then `summer_screenshot` — lighting is exactly the kind of change you cannot judge without pixels.

More recipes, each the `source` of one call:

- `references/recipes-3d.md` (`skill/scene-scripting/references/recipes-3d.md`): procedural meshes, CSG and boolean blockouts, lathe, sweep, terrain, text signage, decimate and convex collision, mirror, keyframe animation, `make_shader`, GridMap fills.
- `references/recipes-2d-ui.md` (`skill/scene-scripting/references/recipes-2d-ui.md`): a 2D platformer level, animated sprites, a HUD, a persisted button connection, `attach_script`, `make_prefab`, input actions, autoloads and the main scene, and how to verify 2D and UI work.

## Which tool

| Job | Tool |
|---|---|
| One property on one node | `summer_set_prop` |
| One signal, one input binding, one project setting | `summer_connect_signal`, `summer_input_map_bind`, `summer_project_setting` |
| 3+ related scene edits, or anything computed | `summer_run_script` with `scenePath` |
| Many kit pieces at exact poses, read back as one receipt | `summer_batch` with placed `InstantiateScene` ops (`spatial-placement`) |
| Project-wide batch work on files on disk | `summer_run_editor_script` |

## summer_run_editor_script — the cold path

A different tool for a different job: it boots a **fresh headless child editor against the ON-DISK project**, runs one `EditorScript` (`func _run():`), and exits.

- Unsaved live edits are INVISIBLE to it; the live editor may need a file reload to show its output.
- Use for batch/project-wide work: re-saving every scene, sweeping resources, mass fixes, generating `.tres` assets.
- Budget default 120s, clamp 15–600 — include boot time (30s+ on large projects).
- It confesses `no_rewind_point:true` when no pre-run checkpoint could be taken — surface that to the user before more destructive work.
- No renderer: it can never screenshot. Judge it by artifacts on disk (see `headless-scripting`).

If `summer_run_script` answers `engine_lacks_op`, the engine build predates RunSceneScript (Summer Engine 0.5.66 or newer has it): update Summer Engine, or use `summer_run_editor_script` for the same work.

## Pitfalls

| Pitfall | Reality |
|---|---|
| Ten `summer_add_node`/`summer_set_prop` calls in a row | That is one script. Write the script. |
| A script without `scenePath` | It runs against whatever tab is open. Name the scene. |
| `add_child` without `ctx.set_owner_recursive(node)` (or manual `.owner`) | The saved scene silently loses the node. |
| `var node := ctx.add_node(...)` | Does not compile: `ctx` results are untyped. `var node = ctx.add_node(...)`. |
| Guessing a property name ("it's probably `color`") | `summer_api_docs` answers in one call. Wrong names fail after half the mutation applied. |
| Claiming "the forest looks great" without a screenshot | Describe only frames you received. Run `summer_screenshot`. |
| Heavy batch loop in `summer_run_script` | It blocks the live editor. Move it to `summer_run_editor_script`. |
| Using `summer_run_editor_script` to edit the OPEN scene | It sees only the on-disk file; live edits are invisible and collisions likely. Use `summer_run_script`. |
| `"Vector3(0,10,0)"` (quoted) inside script source | That is the `summer_set_prop` wire convention. In GDScript write `Vector3(0, 10, 0)`. |
| Ignoring `errors` because `ok` was true | A partially-failed script may have half-mutated the scene. Read them. |

**Related skills:**
- `verifying-scenes` — the perception discipline: snapshot/diff/screenshot before-and-after, runtime reads, honest claims.
- `headless-scripting` — shell-launched engine scripts, imports, exports.
- `scene-composition` — what a well-structured scene looks like before you generate one.
- `ui-basics` — Control hierarchy, containers, anchors, theme vs inline styling.
- `character-animation-wiring` — the animation tier end to end.
- `gdscript-patterns` — idioms for the scripts `attach_script` writes.
- `verification-before-completion` — proving the result before claiming done.

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@4.9.0` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `assets.slice_sheet` | `summer assets slice-sheet` |
| `summer_api_docs` | `summer docs engine-api` |
| `summer_docs_read` | `summer docs read` |
| `summer_add_node` | `summer engine add-node` |
| `summer_batch` | `summer engine batch` |
| `summer_connect_signal` | `summer engine connect-signal` |
| `summer_get_project_context` | `summer engine get-project-context` |
| `summer_get_runtime_tree` | `summer engine get-runtime-tree` |
| `summer_get_script_errors` | `summer engine get-script-errors` |
| `summer_input_map_bind` | `summer engine input-map-bind` |
| `summer_instantiate_scene` | `summer engine instantiate-scene` |
| `summer_play` | `summer engine play` |
| `summer_project_setting` | `summer engine project-setting` |
| `summer_run_editor_script` | `summer engine run-editor-script` |
| `summer_run_script` | `summer engine run-script` |
| `summer_screenshot` | `summer engine screenshot` |
| `summer_set_prop` | `summer engine set-prop` |
| `summer_snapshot_diff` | `summer engine snapshot-diff` |
| `summer_stop` | `summer engine stop` |
| `summer_world_snapshot` | `summer engine world-snapshot` |
| `summer_write_file` | `summer engine write-file` |
<!-- /shell-commands -->
