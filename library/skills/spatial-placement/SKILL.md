---
name: spatial-placement
description: "Place 3D objects and modular kit pieces from measured geometry — inspect, place, starcast, measure, correct; wall, facade, pipe, shelf and alcove recipes."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: scene-and-project
user-invocable: false
allowed-tools: Read Grep summer_get_scene_tree summer_inspect_node summer_set_prop summer_batch summer_starcast summer_inspect_asset summer_instantiate_scene summer_place_adjacent summer_attach_to_surface summer_repeat_along summer_connect_ports summer_raycast summer_measure summer_test_placement summer_snap_to_surface summer_align_distribute_3d summer_world_snapshot summer_snapshot_diff summer_screenshot
paths: ["**/*.tscn"]
---

# Spatial Placement in Summer Engine

Place from measured geometry, never from guesses about size or facing. Use
Starcast as spatial evidence, not as an automatic placement solver. Make a
reasonable transform from scene intent, inspect the result, then correct only
the axes that the evidence shows are wrong.

Every tool below is already shipped. Arguments, result shapes, limits and the
engine ops behind them: [references/kit-placement-tools.md](references/kit-placement-tools.md).

## Choose the tool

| Question | Tool |
|---|---|
| Size, origin, front/back plane, pipe ends of a piece not yet placed? | `summer_inspect_asset` |
| Place one piece at an exact pose | `summer_instantiate_scene` with `position`, `rotation_degrees` |
| Place many pieces, read the receipt | `summer_batch`, placed `InstantiateScene` ops, `receipt: "summary"` |
| Next module edge to edge, next storey on top | `summer_place_adjacent` |
| Pipe, lamp, AC unit or sign on a wall | `summer_attach_to_surface` |
| Clamps, braces, posts or windows along a line | `summer_repeat_along` |
| Pipe or duct end to end | `summer_connect_ports` |
| Surface and normal in front of a point | `summer_raycast` |
| Gap or overlap between two pieces; fronts flush? | `summer_measure` |
| What surrounds a placed piece, which side is blocked? | `summer_starcast` |
| Will this pose fit in a tight spot? | `summer_test_placement` before committing |
| Seat a prop on a floor, table or shelf | `summer_snap_to_surface` |
| Line up or space 2-16 placed pieces on one axis | `summer_align_distribute_3d` |
| Did exactly that change, does it look right? | `summer_world_snapshot` + `summer_snapshot_diff`, `summer_screenshot` |

## Placement loop

1. Call `summer_get_scene_tree` and inspect the subject and intended anchor.
   Never guess paths, transforms, or dimensions.
2. Place the subject approximately with `summer_set_prop` or `summer_batch`.
3. Call `summer_starcast(scenePath, path, detail="summary")`.
4. Correct position or rotation from the smallest relevant set of facts.
5. Call summary again. Stop when the intended support/contact and clearances are
   satisfied. Do not keep recasting a placement that already meets the brief.

Use `detail="full"` only when summary identifies an ambiguous blocker, several
nearby candidates, or a complex overlap. Full output is capped at 12 KB and may
return summary automatically. Keep `directionSpace="world"` unless placement is
defined relative to a rotated subject; then use `directionSpace="local"`.

## Read the result

- `subject.position` and `subject.size` describe the queried object.
- `grounded: true` means downward support was detected. It does not mean the
  object is centered or otherwise well placed.
- `contactStatus` and `contacts` identify touching or overlapping colliders.
  Godot's shape query cannot distinguish touching from penetration here.
- `directions.<label>.status` is `blocked` when clearance is below the tool's
  threshold; `distance` is measured from the subject bounds.
- `evidence: "physics"` is exact collider-query evidence.
- `evidence: "visual_aabb"` includes visible meshes without colliders, but is a
  world-axis-aligned broad-phase approximation. Do not infer exact surface
  contact from it.
- Warnings about missing collision shapes or visual bounds mean coverage is
  partial; state that limitation rather than inventing certainty.

## Modular kit placement

1. `summer_inspect_asset` every piece type once and read its `summary` first:
   size, where the origin sits (`origin.label`), the two largest opposite plane
   pairs (a large `+z` plane at the max z offset means the visible face looks
   along +z and the back is `-z`; a `one_sided` sheet with no opposite plane
   is invisible from behind), port-like loops (pipe and duct ends), anchors
   and colliders. Read pieces.json or the pack notes too, but trust the
   measurement.
2. `summer_world_snapshot`; keep the `snapshot_id`.
3. Place the first piece of a line with `summer_instantiate_scene` and its
   `position` / `rotation_degrees`. Place the rest relative to it:
   `summer_place_adjacent` along the line, again along `y` for the next storey.
   For many pieces at known poses use one `summer_batch` with
   `receipt: "summary"`.
4. Mount wall pieces with `summer_attach_to_surface`, using the back axis from
   step 1. Instance each at its mount height first: the tool keeps the height
   and pushes the piece's back face onto the wall, and refuses (putting the
   piece back) when the seat lands on another node. Join pipe and duct runs
   with `summer_connect_ports`; its `other_ports` says where a bend's free end
   now points. Add clamps and braces with `summer_repeat_along`.
5. Check: `summer_measure` plane mode on each facade line (every front on one
   plane), pair mode on joints you doubt, `summer_starcast` with
   `directionSpace: "local"` on mounted pieces, `summer_test_placement` before
   committing a piece in a tight spot. Starcast's local names follow Godot:
   `forward` is -Z, `back` is +Z. A piece with a -Z back should read
   `forward` blocked by the wall at about the standoff (or the wall in
   `contacts` when flush) and `back` open.
6. `summer_snapshot_diff` against the id from step 2, then `summer_screenshot`
   and look at it. Fix facing from the measurement, not by eye.

### Worked example: two-storey facade wall with a downpipe and a lamp

Pieces (measured in step 1): `wall_double` is 2 x 3 x 0.2 m, origin bottom
centre, front `+z`; `window_double` the same size; `gutter_section` is 1 m tall
with its back `-z` and open loops at both ends; `wall_lamp` has its back `-z`;
`wall_clamp` is small with its back `-z`. Scene `res://facade_test.tscn` with a
`Facade` Node3D at the origin.

```text
summer_instantiate_scene {scenePath:"res://facade_test.tscn", parent:"./Facade",
  scene:"res://kit/wall_double.tscn", name:"G1", position:[0,0,0]}
summer_instantiate_scene {..., scene:"res://kit/window_double.tscn", name:"G2", position:[2,0,0]}
summer_place_adjacent {scenePath:"res://facade_test.tscn", subject:"./Facade/G2",
  reference:"./Facade/G1", axis:"x", side:"max", alignOtherAxes:{y:"min", z:"max"}}
    -> verify {gap:0, residuals:{y:0, z:0}}
summer_instantiate_scene {..., scene:"res://kit/window_double.tscn", name:"U1", position:[0,3,0]}
summer_place_adjacent {..., subject:"./Facade/U1", reference:"./Facade/G1",
  axis:"y", side:"max", alignOtherAxes:{x:"min", z:"max"}}
summer_instantiate_scene {..., scene:"res://kit/window_double.tscn", name:"U2", position:[2,3,0]}
summer_place_adjacent {..., subject:"./Facade/U2", reference:"./Facade/U1",
  axis:"x", side:"max", alignOtherAxes:{y:"min", z:"max"}}
summer_measure {scenePath:"res://facade_test.tscn", mode:"plane",
  nodes:["./Facade/G1","./Facade/G2","./Facade/U1","./Facade/U2"], face:"+z"}
    -> coplanar:true, spread 0

summer_raycast {scenePath:"res://facade_test.tscn", origin:[2.15,0.5,1], direction:[0,0,-1]}
    -> hit ./Facade/G2, normal [0,0,1]: the wall front, by physics
summer_instantiate_scene {..., scene:"res://kit/gutter_section.tscn", name:"Pipe_1", position:[2.15,0.1,0.5]}
summer_attach_to_surface {scenePath:"res://facade_test.tscn", subject:"./Facade/Pipe_1",
  ray:{origin:[2.15,0.5,1], direction:[0,0,-1]}, backAxis:"-z", upAxis:"+y", standoff:0.02}
    -> seated_on "Facade/G2", final_gap 0.02, back_face_gap 0.02; the pipe keeps y 0.1
summer_instantiate_scene {..., scene:"res://kit/gutter_section.tscn", name:"Pipe_2", position:[2.15,1.1,0.1]}
summer_connect_ports {scenePath:"res://facade_test.tscn", subject:"./Facade/Pipe_2", subjectPort:"-Y",
  target:"./Facade/Pipe_1", targetPort:"+Y"}
    -> tilt_degrees 0, verify {distance:0, angle_degrees:0}, other_ports [{id:"+Y", direction:[0,1,0]}]
summer_repeat_along {scenePath:"res://facade_test.tscn", template:"res://kit/wall_clamp.tscn",
  parent:"./Facade", start:[2.15,0.3,0.02], end:[2.15,1.9,0.02], spacing:0.45}
    -> count 4, created ["Facade/wall_clamp_1", ...]

summer_instantiate_scene {..., scene:"res://kit/wall_lamp.tscn", name:"Lamp", position:[1,2.6,0.5]}
summer_attach_to_surface {scenePath:"res://facade_test.tscn", subject:"./Facade/Lamp",
  surface:"./Facade/G1", backAxis:"-z", standoff:0}
summer_starcast {scenePath:"res://facade_test.tscn", path:"./Facade/Lamp", directionSpace:"local"}
    -> contacts ["Facade/G1"], forward (-Z, the lamp's back) blocked at 0, back (+Z) open
summer_snapshot_diff {from_id:"<id>"}  then  summer_screenshot
```

Loop ids come from the section's `open_loops` in step 1 (its
`summary.port_like_loops`): `+Y` is the outermost loop facing +Y in the
piece's own axes (here the top end), `-Y` the bottom; a second loop facing the
same way is `+Y#2`. The ids do not depend on radius or pose.
On the target pick the loop whose `direction` points where the run continues;
on the subject, the one that points back at the target. A join that would tilt
the piece more than 5 degrees is refused and lists the ports that fit; pass
`allowTilt: true` only for an intended tilt. With packs that ship Marker3D
anchors, pass their names instead.

## Placement recipes

- **Floor/platform:** require downward support, no unintended contacts, and open
  movement/access directions. Correct vertical position first.
- **Shelf:** require shelf support, no back/side overlap, and enough forward
  clearance to remain visible and reachable.
- **Wall:** use the intended horizontal direction as the anchor, preserve a
  small gap unless contact is requested, and verify the opposite side is open.
- **Alcove:** check back, both sides, up, down, and relevant diagonals. Request
  full only if summary cannot identify which surface blocks the subject.
- **Rotated object:** use local directions only when "front", "side", or "up"
  refers to the object's orientation; use world directions for level axes.
- **Overlap repair:** move along the clearest axis with the shortest correction,
  then rerun. Do not resize the asset unless the user asked for that.
- **Facade line:** modules edge to edge with `summer_place_adjacent`
  (`alignOtherAxes` `{y: "min", z: "max"}` for a +z front), then
  `summer_measure` plane mode on the fronts. A module reported `proud` or
  `recessed` is moved along the face axis by its `deviation`.
- **Pipes and gutters:** back on the wall's front plane (`summer_attach_to_surface`
  with the measured back axis), runs joined with `summer_connect_ports`, clamps
  with `summer_repeat_along`. Starcast in local space: the back-axis direction
  (`forward` for a -Z back) blocked at about the standoff.
- **Wall fixtures (lamps, AC units, signs):** `summer_raycast` to find the
  wall point, `summer_test_placement` if the spot is crowded, then
  `summer_attach_to_surface`.

## Guardrails

- Always provide exact `scenePath` and `path`; selection fallback is not
  deterministic agent behavior.
- Starcast is read-only and never moves or saves the subject.
- One representative ray per direction can miss off-center geometry. Combine
  directional results with contacts, nearby evidence, hierarchy, and rendered
  verification for high-consequence placements.
- Cameras, lights, audio, navigation nodes, scripts, and plain Nodes are not
  obstacles unless they own collision or renderable geometry.
- Prefer two useful summary calls around one correction over repeated full calls.
- Never infer a piece's facing from its file name or a screenshot alone.
  Measure it (`summer_inspect_asset`), place it, then confirm with Starcast
  (local) and a screenshot.
- Batch receipts over a few ops: always `receipt: "summary"`.
- `visual_aabb` measurements (measure, place_adjacent) are box bounds: an
  overhang or a lip sets the face. Say so when it matters.
- A piece seated flush against a single-sided wall can read `open` in the
  wall's direction while `contacts` lists the wall: Starcast's one ray per
  direction starts at the touching face. Read `contacts` too.
