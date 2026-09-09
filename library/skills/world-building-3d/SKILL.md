---
name: world-building-3d
description: Use when composing, placing, grounding, spacing, or validating 3D objects in Summer Engine scenes. Trigger on "world building", "place props", "snap to floor", "align objects", "distribute objects", "navigation reachability", or requests to make a 3D scene look deliberately arranged rather than roughly positioned.
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: scene-and-project
allowed-tools: Read Grep summer_open_scene summer_get_scene_tree summer_inspect_node summer_set_prop summer_test_placement summer_snap_to_surface summer_align_distribute_3d summer_navigation_probe summer_screenshot summer_play
---

# Build 3D Worlds with Spatial Evidence

Use exact scene and node paths, make one geometric decision at a time, and verify the saved result. Treat spatial tools as bounded evidence: they reduce guesswork but do not replace a final rendered or gameplay check.

Read [references/spatial-tools.md](references/spatial-tools.md) before the first spatial-tool call in a task. It defines each tool's evidence boundary and the result fields that must not be overinterpreted.

## Choose the narrowest tool

| Need | Tool | Effect |
|---|---|---|
| Evaluate a proposed prop pose | `summer_test_placement` | Read-only ghost pose |
| Seat one object on a floor, shelf, table, or ramp | `summer_snap_to_surface` | Moves subject and saves |
| Align or evenly space 2–16 objects | `summer_align_distribute_3d` | Moves subjects and saves |
| Check whether two positions share a navigation route | `summer_navigation_probe` | Read-only |

Use ordinary `summer_get_scene_tree` and `summer_inspect_node` first when paths, hierarchy, authored transforms, collision layers, or camera settings are unknown.

## Follow the composition loop

1. Open the exact target scene and resolve exact `./`-relative paths.
2. Inspect the subject, its visual/collider descendants, intended support or neighbors, and the camera.
3. State the intended invariant: contact gap, clearance, spacing axis, or reachable destination.
   If the support, ordering, or destination is genuinely ambiguous, ask
   `Proceed?` with the concrete choice before making a user-visible mutation.
4. Query before mutation when a read-only tool exists.
5. Apply the smallest mutation. Prefer the dedicated solver over hand-tuned transform loops.
6. Re-query the saved pose. Do not treat a successful mutation receipt as proof of visual quality.
7. Run a rendered or gameplay verification when renderer visibility, transparent materials, concave silhouettes, navigation behavior, or player perception matters.

Keep scene A and scene B independent. Never copy a solved world transform between scenes unless their relevant parents, bounds, and obstacles are proven identical.

There is no raw `.tscn` fallback for these evidence queries or solver mutations.
They depend on the running Summer Engine's live scene, physics, camera, and
navigation state. If the required tool is unavailable, inspect and explain the
limitation instead of hand-editing a scene around it.

## Place and ground props

For a known candidate pose, call `summer_test_placement` before setting the transform. Preserve the current global scale unless the user asked to resize the asset.

- `overlapCount > 0` or known overlap evidence means reject the pose.
- `fits: null` means the physics backend could not prove completeness; it is not `true`.
- Require `grounded: true` and an acceptable absolute `floorGap` for seated props.
- Treat `visual_aabb` as broad-phase evidence. Irregular meshes can have empty-looking AABB corners.

For a direct seat operation, call `summer_snap_to_surface` with a world-space direction. Use `alignUp: true` only when the object should inherit an exact physics support normal. After slope alignment, verify both up alignment and preserved heading. Do not infer a usable normal from `visual_aabb` fallback.

`SnapToSurface` does not return the raw support normal or a heading residual.
Require `evidence: physics`, `evidenceDetails.contactResolved: true`, the expected
`supportPath`, `alignApplied: true`, a plausible `slopeDeg`, and inspect the saved
`after.basis` plus a rendered view. Keep `maxDistance` tight because the current
solver cannot take an expected-support path and will stop at the first surface.

On mixed-height or sloped supports, arrange the subjects laterally first, then
snap each subject. A later alignment can lift a grounded prop or bury it in a
slope. For a final placement re-query, use the exact saved global pose; if the
post-alignment basis cannot be expressed confidently as global Euler degrees,
do not invent angles - use the snap receipt and an independent rendered or
physics check.

## Arrange groups

Pass subjects to `summer_align_distribute_3d` in intentional order. Choose a world axis explicitly.

- Use `align_min`, `align_center`, or `align_max` to share one projected anchor.
- Use `distribute_centers` when equal center spacing matters.
- Use `distribute_gaps` when visible edge clearance matters; endpoints remain fixed.

Inspect the result's residuals and `changedCount`; infer unchanged subjects only
as `subjectCount - changedCount`. Rerun placement checks for dense groups because
alignment solves one axis and does not prove full 3D clearance.

## Validate navigation placement

Use `summer_navigation_probe` before moving an NPC, pickup, portal, or encounter anchor whose route matters.

- `ready: false` means no trustworthy navigation evidence; wait or fix the navigation map.
- `reachable: false` is meaningful only when `ready: true`.
- Check requested-to-snapped endpoint distance. A route to a distant snapped point does not validate the requested placement.
- After moving the subject, probe the final authored position again.

Probe each destination separately from the intended player/start point. Use the
final inspected global origin and the scene's actual navigation-layer mask. Set
the acceptable snap distance from the navigation agent radius or the authored
placement tolerance; if neither is known, report the distance instead of
declaring it small. For iteration 0, allow one bounded navigation-sync wait and
retry once - never loop indefinitely.

## Fail closed

Do not work around world-mismatch failures such as `subject_world_mismatch` or
`subject_geometry_world_mismatch`, non-finite transforms, hierarchy limits,
unavailable physics, or missing bounds by guessing. Fix the scene structure or
choose a clearly labeled manual fallback, then verify it.

Do not retry a mutation after an oversized or ambiguous result unless the receipt explicitly says it is retry-safe; the first mutation may already have landed.
