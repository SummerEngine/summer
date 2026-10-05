# Kit placement tools

Reference for the tools that place modular kit pieces from measured geometry.
Read it before the first call in a task. The workflow that uses them is in
[`SKILL.md`](../SKILL.md).

## Shared rules

- **Exact paths.** `scenePath` is an exact `res://...tscn`; node paths are
  relative to the scene root (`./Facade/Wall_01` or `Facade/Wall_01`). Editor
  selection is never used.
- **The scene must be open** in the editor (any tab). A scene mutation with
  `scenePath` opens it; `summer_open_scene` does too. A closed scene answers
  `scene_not_open`.
- **Physics needs the active tab.** Only the active scene's bodies are in the
  editor's physics space. Ray queries on another tab fall back to visual AABBs
  and say so.
- **Scene space.** Points, normals and bounds in results are in the scene
  root's frame (world space in the editor). `position` / `start` / `end` that
  you pass for new instances are parent-local, like `summer_set_prop`.
- **Evidence** is named in every result:
  - `visual_aabb`: bounds of visible `GeometryInstance3D` nodes (the definition
    `summer_align_distribute_3d` uses). In `space: "local"` the mesh boxes are
    projected onto the node's own axes, so a rotated facade measures tightly.
    Never triangle contact.
  - `physics`: a collider query (exact shapes, needs the active tab).
  - `mesh_triangles`: computed from the mesh triangles themselves.
  - `markers`: Marker3D anchors shipped with the kit.
- **Compact results.** Every result is under 5 KB. A list cut to fit is
  declared in `truncated: {list: {shown, total}}`.
- **No silent fallback.** A missing op answers `engine_lacks_op`; a measurement
  that cannot be made answers a named `failure_reason`.
- **Engine ops.** No new engine op. Reads run one read-only GDScript probe
  through `RunSceneScript` (the op behind `summer_run_script`: in-process, no
  child editor, `undo: "none"`, no checkpoint). Mutations are ordinary
  `SetProp`, `SnapToSurface` and `InstantiateScene` ops: one undo step per
  request and one final `SaveScene`.
- **Side effects of the probe.** It blocks the editor for the few milliseconds
  it runs, and the engine marks the *active* tab as unsaved after any
  `RunSceneScript`, even a read-only one. Nothing in the scene changes.

## Which tool answers which question

| Question | Tool |
|---|---|
| How big is this piece, where is its origin, which face is its back, where are its pipe ends? | `summer_inspect_asset` |
| Place a piece at an exact pose in one call | `summer_instantiate_scene` with `position` / `rotation_degrees` / `scale` / `transform` |
| Place many pieces in one call and read the receipt | `summer_batch` with placed `InstantiateScene` ops and `receipt: "summary"` |
| Next facade module edge to edge, next storey on top | `summer_place_adjacent` |
| Downpipe, lamp, AC unit or sign on the wall | `summer_attach_to_surface` |
| Clamps every 0.45 m, a row of posts or windows | `summer_repeat_along` |
| Pipe or duct end to end | `summer_connect_ports` |
| What is in front of this point, and its normal? | `summer_raycast` |
| Gap or overlap between two pieces; is the facade front flat? | `summer_measure` |
| What surrounds a placed piece, which side is blocked? | `summer_starcast` (existing) |
| Will a pose fit before I commit it in a tight spot? | `summer_test_placement` (existing) |
| Seat a prop on a floor, table or ledge | `summer_snap_to_surface` (existing) |
| Line up or equally space 2-16 placed pieces on one axis | `summer_align_distribute_3d` (existing) |
| Did exactly that change, and does it look right? | `summer_world_snapshot` + `summer_snapshot_diff`, then `summer_screenshot` (existing) |

## `summer_inspect_asset`

Measure an asset file without adding it to a scene. The probe loads the file,
instances it off the scene tree, measures, and frees it.

- **Use when:** before placing any kit piece you have not measured.
- **Arguments:** `path` (`res://` `.tscn` `.scn` `.glb` `.gltf` `.res`
  `.tres` `.mesh` `.obj`), `maxTriangles` (100-300000, default 60000) for the
  face and loop analysis, `detail` (`summary`, the default, or `full`).
- **Result:** `{ok, tool, detail, summary {aabb, origin, plane_pairs,
  port_like_loops, triangles, mesh_count, anchor_count, collision_count,
  warnings?}, frame: "asset_root", root_class, root_transform_identity,
  aabb {min, max, size}, origin {fraction [x,y,z], label}, mesh_count,
  meshes [{path, tris, min, max, hidden?}], triangles,
  planes [{normal, offset, area, tris, cull_back, one_sided}] (top 6 by area),
  open_loop_count, open_loops [{index, mesh, center, direction, radius,
  vertices, max_dev, direction_ambiguous?}], open_loops_listed?,
  open_loops_omitted?, open_chains, anchor_count, anchors [{name, path,
  position, forward, up}], collision_count, collision [{path, shape,
  size|radius|height|faces|points, center, min, max, disabled?}], analysis
  {triangles_analyzed, triangle_budget, truncated, weld_m, plane_bin},
  evidence: "mesh_triangles"}`.
- **The summary block** comes first and holds the facing evidence:
  - `plane_pairs`: the two largest pairs of opposite planes (a pair under 1% of
    the largest one's area is left out), each `{larger, opposite, separation}`.
    `opposite` is `null` for a single sheet. Every plane is `{axis?, normal,
    offset, area, one_sided}`; `axis` (such as `+z`) is given only when the
    normal is within about 1 degree of it, so a baked yaw or a 45-degree corner
    face shows its exact normal with no label. `separation` is the distance
    between the two planes (the thickness; 0 for a sheet modelled with both
    faces).
  - `one_sided: true` means the plane's material culls back faces: it is
    invisible from behind its normal. A one-sided sheet with no opposite plane
    faces along its normal, and its back is the opposite axis.
  - `port_like_loops`: indices of the open loops that look like pipe or duct
    ends (radius over 2 cm, a decided direction, and a partner loop of similar
    radius facing more than 60 degrees away: the other end of a straight run or
    a bend).
  - `warnings`: says when the triangle budget cut the analysis and which
    `maxTriangles` covers the whole mesh.
- **`detail`:** `summary` lists in `open_loops` only the port-like loops (with
  their original indices, which `summer_connect_ports` accepts) and says how
  many it omitted. `full` lists every loop, including the outline and holes of
  flat sheets.
- **Reading it:** the asset frame is the root's own frame (its own transform
  excluded), the frame `position` and `rotation_degrees` apply in. `origin.label`
  such as `x:center y:min z:center` means bottom centre. Plane normals follow
  triangle winding, so they point out of the visible side. The largest planes
  with normals along one axis are usually the front and back: a wall with a
  large `+z` plane at the max z offset faces +z and its back is `-z`. The tool
  reports planes; you decide which is the front. Open loops are holes in the
  mesh: pipe and duct ends (`direction` points out of the piece), and also the
  open edge of single-sided geometry. `max_dev` is how far the loop is from
  flat.
- **Limits:** planes are binned at about 1.4 degrees and 1 cm. Vertices are
  welded at 0.1 mm, so UV seams do not count as holes; double-sided or capped
  ends have no loop. Hidden meshes are listed but not analysed. `one_sided`
  reads `cull_mode` of a `BaseMaterial3D`, or `cull_disabled` / `cull_front`
  in a shader's code; a mesh with no material counts as one-sided (the default
  material culls back faces).
- **Ops:** `RunSceneScript` (read-only probe).

## `summer_instantiate_scene` (placed)

- **Arguments added:** `position`, `rotation_degrees`, `scale` (`[x, y, z]`,
  parent-local) or `transform` (`"Transform3D(xx, xy, xz, yx, yy, yz, zx, zy,
  zz, ox, oy, oz)"`). Not `transform` with the others; not `scale` or
  `transform` with `target_size`.
- **Behaviour:** `InstantiateScene` (its own request, as the engine requires),
  then one `SetProp` request on the node path the receipt reports (a name
  collision rename is followed), then `SaveScene`. Without the new fields it is
  unchanged.
- **Result:** the merged receipt (`results` holds every op; the per-request
  `receipts` copies are kept only when something failed) plus
  `placement {nodePath, applied, fields, space: "parent_local"}`.
- **Ops:** `InstantiateScene`, `SetProp`, `SaveScene`.

## `summer_batch` additions

- `InstantiateScene` ops may carry the same placement fields (arrays or
  `"Vector3(...)"` strings). Each piece is one op; its `SetProp`s are sent right
  after it is created. Other ops are forwarded verbatim.
- `receipt: "summary"` returns `{ok, receipt, ops, requests, applied, failed,
  not_sent, saved, error?, failures [{index, op, step?, failure_reason?,
  error}], created_total, created [paths], renamed [{index, requested,
  actual}]}`. `index` is the position in your `ops` list. Use it for every batch
  over a few ops: a full receipt for about 30 or more ops overflows the tool
  output limit.
- **Cost:** the engine runs each `InstantiateScene` as its own request. The
  transforms of a run of `InstantiateScene` ops are held back and sent
  together (up to 200 `SetProp`s per request) just before the next op that is
  not an `InstantiateScene`, riding along with it when it can. A batch of N
  placed pieces is therefore about N + 2 requests and N + 2 undo steps (it was
  2N + 1). Every later op in the list (a `SetProp`, `SnapToSurface`, a query,
  the save) runs after the transforms land. If an `InstantiateScene` fails,
  the pieces created before it still get their transforms; nothing is saved.

## `summer_place_adjacent`

- **Use when:** facade modules edge to edge, a storey on the storey below, a
  cornice on a wall, a pier beside a bay.
- **Arguments:** `subject` (moves), `reference` (stays), `axis` (`x|y|z`),
  `side` (`max`: subject on the reference's +axis side; `min`: the -axis side),
  `gap` (default 0; negative overlaps), `alignOtherAxes` (`min|center|max|none`
  for both other axes, or per axis `{y: "min", z: "max"}`), `space`
  (`world`, or `local` for the reference's own axes).
- **Result:** `{subject, reference, evidence: "visual_aabb", space, moved,
  moved_by [world], position [parent-local], saved, reference_excludes_subject?,
  verify {gap, residuals}}`. `verify` is a fresh read after the move.
- **Limits:** bounds are visible-mesh AABBs; a piece with an overhang (a
  cornice lip) meets at its outermost point. If the subject is inside the
  reference, its geometry is left out of the reference's bounds. A reference
  inside the subject is refused.
- **Ops:** `RunSceneScript` (read, verify), `SetProp` (position),
  `SaveScene`.

## `summer_attach_to_surface`

- **Use when:** mounting downpipes, gutters, lamps, AC units, signs, fire
  escapes on a wall (or anything on a ceiling or floor) with the right side
  against it.
- **Arguments:** `subject`; `surface` (node: the ray runs from the subject's
  origin to the nearest point of the node's bounds) and/or `ray {origin,
  direction}` (with both, hits on other nodes are skipped); `backAxis` (the
  subject's local axis that faces into the surface, default `-z`); `upAxis`
  (default `+y`); `worldUp` (default `[0,1,0]`); `standoff` (default 0);
  `placeAt` (`current`, the default, or `hit`); `maxMove` (default 2);
  `maxDistance` (ray length, default 20); `collisionMask`.
- **Place the piece near its mount first** (`summer_instantiate_scene` with
  `position`): this tool turns it and pushes it onto the surface.
- **Behaviour:** the probe reads the piece's visible bounds along its own axes
  and casts the ray (physics first, visual AABB fallback declared). The piece is
  turned so `backAxis` points along -normal and `upAxis` follows `worldUp`
  projected onto the surface (on a floor or ceiling, where that is undefined,
  the current up is kept and a warning says so). The planned seat puts its
  **back face** (the extreme of its visible bounds along `backAxis`, not its
  origin) at `standoff` in front of the plane through the hit point:
  - `placeAt: "current"`: the piece keeps its height and its place along the
    surface and moves only along the surface normal.
  - `placeAt: "hit"`: it also slides so the centre of its back face lands on
    the hit point (its height then follows the ray).
  One `SetProp` turns it and puts its back face 5 cm in front of the planned
  seat; `SnapToSurface` sweeps it along -normal (at most `standoff` + 0.3) and
  seats it at `standoff` by its own evidence.
- **Checked before saving:**
  - a planned move longer than `maxMove` is refused before anything changes
    (`move_exceeds_max_move`, `mutationApplied: false`), and so is, with
    `placeAt: "current"`, a ray hit farther than `maxMove` along the surface
    from the piece's back face (`hit_far_from_piece`: aim the ray at the piece,
    or pass `placeAt: "hit"` to move it there);
  - with `surface`, the seat must be on that node or inside it; with a ray
    only, a seat on another node is accepted only when it lies on the hit plane
    (a coplanar neighbour module, warned `seated_on_coplanar_<path>`). Anything
    else is refused as `seated_on_other_node`;
  - a failed seat (`overlap_recovery_exceeded`, `gap_exceeds_hit_travel`,
    `surface_not_found`, `subject_not_ready`) is reported with `blockers
    {evidence, overlapping, overlaps, first_contact {path, distance}}`, read
    where the seat started, and a `next_step`.

  A refusal or failure puts the piece back exactly where it started
  (`restored: true`), saves nothing and answers `ok: false` with `seated_on`,
  `intended_surface`, `in_front_of_plan` (how far in front of the planned seat
  it stopped) and `next_step`.
- **Result:** `{subject, placed_at, seated_on, final_gap (the collider gap
  from SnapToSurface), back_face_gap (visible back face to the hit plane),
  moved_by, surface_hit {evidence, path, point, normal, distance}, orientation
  {backAxis, upAxis, world_back, world_up}, back_face_offset (origin to back
  face along backAxis), seat {ok, evidence, supportPath, finalGap,
  gapErrorBound, initiallyOverlapping, backoffDistance, hitTravel, origin,
  warnings}, standoff, saved, warnings}`.
- **Warnings worth acting on:** `visible_back_X_into_surface` (the collider
  sits X behind the visible back face, so the mesh pokes into the wall: add X
  to `standoff`); `surface_not_flat_under_piece` (it seated on the surface but
  in front of the hit plane); `hit_normal_pointed_away_from_the_ray_flipped`
  (the ray hit a back face; the piece still mounts on the ray's side).
- **Check after:** `summer_starcast` with `directionSpace: "local"`. Its local
  names follow Godot (`forward` = -Z, `back` = +Z), so a -Z back reads
  `forward` blocked (or the surface in `contacts` when seated flush) and `back`
  open.
- **Limits:** the back face is the visible-mesh AABB in the piece's own axes;
  the seat itself is collider-exact when the piece has colliders. A mesh-only
  wall gives an AABB face normal (axis-aligned), and SnapToSurface's own
  evidence is then `visual_aabb`. A mirrored (negative-scale) piece is refused.
  Pass `backAxis` from `summer_inspect_asset`, never a guess.
- **Ops:** `RunSceneScript` (bounds and ray; the blockers read after a failed
  seat), `SetProp` (transform; the restore), `SnapToSurface`, `SaveScene`.

## `summer_repeat_along`

- **Use when:** clamps every 0.45 m up a pipe, braces every 0.8 m along a duct,
  fence posts, bollards, a row of window modules.
- **Arguments:** `template` (scene), `parent`, `start`; then `end` with
  `spacing` (as many as fit) or `count` (spread start to end), or `direction`
  with `count` and `spacing`. `align` (`start|center|end`) places the leftover
  length with `end` + `spacing`. `rotationDegrees`, `scale`, `namePrefix`
  (copies are `<prefix>_<n>`, default the template file name). Coordinates are
  parent-local. At most 64 copies per call.
- **Result:** the batch summary plus `{template, parent, count, spacing,
  direction, first, last}`.
- **Ops:** `InstantiateScene` (one request per copy), `SetProp` (every copy's
  transform in one request), `SaveScene`: N copies cost N + 2 requests.

## `summer_connect_ports`

- **Use when:** pipe to pipe, duct to duct, gutter section to funnel or outlet,
  any two pieces with named anchors.
- **Arguments:** `subject` (moves), `subjectPort`, `target` (stays),
  `targetPort`, `gap` (default 0), `rollDegrees` (default 0), `maxTriangles`.
  A port is a Marker3D (or any Node3D) name under the node, whose -Z axis
  points out of the port, or an open-loop index from `summer_inspect_asset` on
  that node's scene.
- **Behaviour:** the subject turns by the shortest rotation that makes its port
  direction the opposite of the target's, then by `rollDegrees` about the
  joined axis, then moves so the ports meet, `gap` apart along the target port
  direction.
- **`rollDegrees` exactly:**
  - axis: the target port's direction reversed, pointing from the joint into
    the target (`roll_axis` in the receipt);
  - sign: right-hand rule about that axis; positive turns counter-clockwise
    when you look back along the axis from inside the target toward the
    subject;
  - zero: the shortest turn from the subject's current orientation, so the same
    value gives different results from different start poses. Once the ports
    are joined, a second call turns by exactly `rollDegrees` about the joint:
    180 flips a bend's free end to the other side.
- **Result:** `{evidence (markers|mesh_triangles), subject_port, target_port,
  roll_axis, roll_degrees, rotated_degrees, moved_by, other_ports [{kind,
  name|index, position, direction, radius?, direction_ambiguous?}],
  other_ports_total?, other_ports_predicted?, saved, verify {distance,
  angle_degrees}, warnings}`.
- **`other_ports`:** every other port of the subject (its other Marker3D
  anchors for a marker port, its other open loops for an open-loop port, up to
  8) with world position and outward direction after the move, measured by the
  verify read (`other_ports_predicted: true` when that read failed and they
  were computed from the move). Read where a bend's free end now points
  instead of measuring it; if it points the wrong way, call again with the
  `rollDegrees` that turns it about `roll_axis`.
- **Limits:** open-loop ports are only as exact as the mesh; an end whose
  direction cannot be decided is flagged `direction_ambiguous`.
- **Ops:** `RunSceneScript` (read, verify), `SetProp` (transform),
  `SaveScene`.

## `summer_raycast`

- **Use when:** you need a surface and its normal at an arbitrary point before
  anything is placed. (`summer_starcast` casts from an existing node.)
- **Arguments:** `origin`, `direction`, `maxDistance` (default 100),
  `collisionMask`, `collideWithAreas`, `evidence` (`auto|physics|visual_aabb`),
  `exclude` (up to 16 nodes).
- **Result:** `{hit, evidence, path, point, normal, distance, fallback?,
  fallback_reason?, nearer_visual_only?, origin, direction, physics_available,
  physics_unavailable_reason?, warnings}`.
- **Limits:** visual AABB hits ignore boxes that contain the origin (counted in
  `warnings`); their normal is a box face normal.
- **Ops:** `RunSceneScript` (read-only).

## `summer_measure`

- **Use when:** checking a placement numerically: facade gaps, overlaps,
  modules standing proud. (`summer_starcast` reports clearance around one node
  in 26 directions; this compares named nodes.)
- **Arguments:** `mode` (`pair` with `a`, `b`, optional `axis`; `plane` with
  `nodes` (2-32) and `face` such as `+z`), `space` (`world`, or `local` for the
  axes of `a` / `nodes[0]`), `tolerance` (default 0.005).
- **Result, pair:** `{axes {x|y|z: {gap, relation: gap|touching|overlap, a,
  b, delta_min, delta_max, delta_center}}, boxes_overlap}`; `gap < 0` is the
  overlap depth, `delta_*` is b minus a.
- **Result, plane:** `{coplanar, plane, spread, off_plane_count, nodes [{path,
  face, deviation, off_plane: proud|recessed}], no_geometry?}`.
- **Ops:** `RunSceneScript` (read-only).

## What belongs in the engine later

These tools compose existing ops. Natively they would be faster and exact:
an `InstantiateScene` that takes a transform (one request, one undo step per
piece), a compact `summer_batch` receipt mode in the ops executor, a raycast and
a measure op that need no script and do not mark the active tab unsaved, an
asset-geometry op that reads the import cache without instancing, and an
oriented-bounds (OBB) query so rotated pieces stop needing `space: "local"`.
