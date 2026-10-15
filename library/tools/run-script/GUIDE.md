# summer_run_script

Run a GDScript snippet INSIDE the live editor, against the scene named by scenePath (opened first when it is not the edited one; the person's tab comes back after the run). Without scenePath it runs against the currently OPEN scene. This is the scene-scripting workhorse: one script replaces long chains of add-node/set-prop calls, and it can compute (loops, randomness, math, procedural meshes) what individual CRUD ops cannot.

SCRIPT CONTRACT — write ONLY the body below; do not add extends/@tool lines (missing ones are prepended and reported in 'normalizations'):

  func run(ctx):
      var root = ctx.get_scene_root()    # root node of the open scene
      for i in range(10):
          var m := MeshInstance3D.new()
          m.mesh = BoxMesh.new()
          m.position = Vector3(i * 2, 0, 0)
          root.add_child(m)
          ctx.set_owner_recursive(m)     # REQUIRED or the node is NOT saved
      ctx.report("count", 10)            # structured value back to you

- ctx.get_scene_root() — the open scene's root node. Full editor API access.
- ctx.set_owner_recursive(node) — stamps node AND its descendants with the scene-root owner (equivalent to node.owner = root on each). Call it after add_child on every created subtree.
- ctx.report(key, value) — return structured results (comes back in 'reports').
- print(...) — captured and returned in 'output'.
- OWNERSHIP: a created node whose owner is never set silently vanishes when the scene saves — descendants too. ctx.set_owner_recursive covers both.
- Values here are real GDScript — Vector3(0,10,0), Color(1,0,0,1) — NOT the quoted variant strings used by summer_set_prop.

Newer ctx builds also carry creation helpers that set the owner FOR you and return the node — prefer them: ctx.add_node(type, name, parent, props), ctx.find(name), ctx.get_or_create(type, name, parent), ctx.instance_scene(res_path, parent, name), ctx.add_mesh(shape, name, parent, props) / ctx.add_mesh_with_collision(...), ctx.mesh_from_arrays(...), ctx.make_material(props) / ctx.apply_material(node, material), ctx.grid(count_x, count_z, spacing, maker) / ctx.scatter(area, count, maker, seed), ctx.add_light_rig(target), ctx.ensure_environment(props), ctx.add_camera(position, look_at, make_current), ctx.summary(), ctx.save_scene(path). Unknown props keys are reported in 'prop_warnings', never silently dropped. On an older engine a missing helper is a plain GDScript error — fall back to the manual form above.

WHEN TO USE: 3+ related ops, anything with computed placement (scatter, grids, rings), procedural geometry (SurfaceTool/ArrayMesh), bulk renames/retunes. For a single property tweak, summer_set_prop is cheaper. Use summer_api_docs to verify property/method names instead of guessing.

THE LOOP: summer_world_snapshot (keep snapshot_id) -> summer_run_script -> summer_snapshot_diff + summer_screenshot -> inspect -> iterate. Never claim visual success without the screenshot.

Returns {ok, ran, result, reports, output, errors, duration_ms, checkpoint} — newer engines add rolled_back (a runtime error rolled the whole undo action back; the scene is untouched) and budget_enforced (max_seconds was a HARD deadline; when the budget hits, the script errors with "Summer script budget exceeded" — split the work into smaller scripts, never resubmit the same oversized one). Read 'errors' even when ok — with undo:'none', a partially-failed script may have mutated the scene. If this engine build predates RunSceneScript, the result is a structured engine_lacks_op failure (nothing is sent): use summer_run_editor_script or update Summer Engine.
