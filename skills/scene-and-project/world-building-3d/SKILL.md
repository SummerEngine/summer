---
name: world-building-3d
description: Use when composing, placing, grounding, spacing, framing, or validating 3D objects in Summer Engine scenes. Trigger on "world building", "place props", "snap to floor", "align objects", "distribute objects", "frame camera", "camera visibility", "occlusion", or "navigation reachability".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: scene-and-project
allowed-tools: Read Grep summer_get_scene_tree summer_inspect_node summer_test_placement summer_snap_to_surface summer_align_distribute_3d summer_frame_camera summer_camera_visibility summer_navigation_probe summer_screenshot summer_play
---

# Build 3D Worlds with Spatial Evidence

Use exact scene and node paths, make one geometric decision at a time, and
verify the saved result. Spatial tools reduce guesswork but do not replace a
final rendered or gameplay check.

Read [references/spatial-tools.md](references/spatial-tools.md) before the first
spatial-tool call in a task. It defines the evidence boundaries and fields that
must not be overinterpreted.

## Choose the narrowest tool

| Need | Tool | Effect |
|---|---|---|
| Evaluate a proposed prop pose | `summer_test_placement` | Read-only ghost pose |
| Seat one object on a support | `summer_snap_to_surface` | Moves subject and saves |
| Align or evenly space 2-16 objects | `summer_align_distribute_3d` | Moves subjects and saves |
| Fit 1-8 subjects in a perspective camera | `summer_frame_camera` | Moves camera and saves |
| Check framing and coarse occlusion | `summer_camera_visibility` | Read-only |
| Check whether two positions share a navigation route | `summer_navigation_probe` | Read-only |

Use `summer_get_scene_tree` and `summer_inspect_node` first when paths,
hierarchy, transforms, collision layers, or camera settings are unknown.

## Follow the composition loop

1. Open the exact target scene and resolve exact `./`-relative paths.
2. Inspect the subject, visual/collider descendants, support or neighbors, and
   camera.
3. State the intended invariant: contact gap, clearance, spacing axis, screen
   padding, or reachable destination. If the support, ordering, camera, or
   destination is genuinely ambiguous, ask `Proceed?` with the concrete choice
   before a user-visible mutation.
4. Query before mutation when a read-only tool exists.
5. Apply the smallest mutation. Prefer a dedicated solver over hand-tuned
   transform loops.
6. Re-query the saved pose. A successful mutation receipt is not proof of
   visual quality.
7. Run a rendered or gameplay check when renderer visibility, transparent
   materials, concave silhouettes, navigation behavior, or perception matters.

Keep independent scenes independent. Never copy a solved world transform
between scenes unless their parents, bounds, and obstacles are proven identical.

There is no raw `.tscn` fallback for these evidence queries or solver mutations.
They depend on the running Summer Engine's live scene, physics, camera, and
navigation state. If a required tool is unavailable, explain that limitation
instead of hand-editing a scene around it.

## Place and ground props

For a candidate pose, call `summer_test_placement` before setting the transform.
Preserve global scale unless the user asked to resize the asset.

- Known overlap evidence means reject the pose.
- `fits: null` is unknown, never `true`.
- Require `grounded: true` and an acceptable absolute `floorGap`.
- `visual_aabb` is broad-phase evidence; irregular meshes can leave empty AABB
  corners.

For direct seating, use `summer_snap_to_surface` with a world-space direction.
Set `alignUp: true` only when exact physics support-normal alignment is intended.
After the call, require `evidence: physics`, resolved contact, the expected
`supportPath`, `alignApplied`, a plausible `slopeDeg`, and inspect the saved
`after.basis` plus a rendered view. The result does not return the raw support
normal or a heading residual. Keep `maxDistance` tight because the solver cannot
take an expected-support path and stops at the first surface.

On mixed-height or sloped supports, arrange subjects laterally first, then snap
each subject. A later alignment can lift or bury a grounded prop. Re-query the
exact saved global pose only when its basis can be represented confidently as
the placement tool's required global Euler degrees; never invent angles.

## Arrange groups

Pass subjects to `summer_align_distribute_3d` in intentional order and choose a
world axis explicitly. `align_min`, `align_center`, and `align_max` share one
projected anchor. `distribute_centers` equalizes centers; `distribute_gaps`
equalizes visible edge clearance while keeping endpoints fixed. Rerun placement
checks for dense groups because one-axis alignment does not prove 3D clearance.
Inspect `changedCount`; infer unchanged subjects as `subjectCount - changedCount`.

## Frame and verify cameras

Call `summer_frame_camera` with the real delivery aspect and explicit padding,
then `summer_camera_visibility` with the same aspect. Require critical subjects
to be framed and inspect occlusion separately. Projected rectangles are not
pixel-visible coverage; five physics rays cannot prove renderer visibility.

## Validate navigation placement

Use `summer_navigation_probe` before moving route-critical NPCs or anchors.
`ready: false` means unknown. `reachable: false` is meaningful only when ready.
Require a small requested-to-snapped endpoint distance, then probe the final
authored position again. Probe each destination separately from the intended
player/start point, using the final inspected global origin and the scene's
actual navigation-layer mask. Derive the allowed snap distance from the agent
radius or an explicit authored tolerance; otherwise report it without calling
it small. For iteration 0, allow one bounded sync wait and retry once.

## Fail closed

Do not guess around world-mismatch failures such as `subject_world_mismatch` or
`subject_geometry_world_mismatch`, non-finite transforms, hierarchy limits,
unavailable physics, or missing-bounds errors. Fix the scene structure or choose
a clearly labeled manual fallback, then verify it. Do not retry a mutation after
an oversized or ambiguous result unless it explicitly says retry-safe.
