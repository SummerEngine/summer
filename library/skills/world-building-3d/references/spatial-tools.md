# Spatial tool evidence contract

Load this reference before using Summer's 3D world-building tools.

## Shared rules

- Pass exact `scenePath` and exact scene-root-relative node paths. Do not rely on editor selection.
- Use one `World3D`. The tools fail closed across SubViewport-owned worlds.
- Keep subjects bounded: placement/snap one subject, alignment sixteen.
- Normal model-visible results stay below 5 KiB. Prefer targeted calls over collecting an entire scene.
- Read-only tools never save: placement test, navigation probe.
- Mutation tools register undo and save the exact target scene: snap, align/distribute.

## `summer_test_placement`

Input is a candidate global position and global Euler rotation. The subject's current global scale is preserved, and the scene is not mutated.

Interpretation:

- Physics overlap counts are lower bounds because Godot exposes no broadphase-completeness bit.
- Any known obstruction makes `fits: false`.
- Zero known physics overlaps can still yield `fits: null`; never coerce it to success.
- `grounded`, signed `floorGap`, and support evidence are independent of overlap certainty. Claim physics-grounded only when `floorEvidence` is `physics` and `supportQueryComplete` is true; otherwise label the evidence approximate or incomplete.
- `visual_aabb` includes visible mesh-only obstacles but is conservative.

## `summer_snap_to_surface`

The subject sweeps along a normalized world direction. Physics evidence uses enabled collider shapes; `visual_aabb` is a mesh-only fallback.

Use `alignUp` only when an exact collider support is intended. After the call,
require `evidence: physics`, resolved contact, the expected `supportPath`,
`alignApplied`, plausible `slopeDeg`, final gap/error bound, and the saved basis.
The result does not expose the raw support normal or a heading residual, so use
the saved basis plus an independent rendered/physics check. If overlap recovery
fails, do not teleport manually through the obstruction.

## `summer_align_distribute_3d`

Anchors and extents come from visible descendant world AABBs. The solver translates only along the requested axis and preserves basis/scale. Distribution preserves caller order and fixed endpoints.

This is one-dimensional arrangement evidence. It does not prove clearance on the other two axes.

## `summer_navigation_probe`

Iteration 0 is unready; iteration 1 and later can be queried. Layer-filtered snapped endpoints and the reported snap distances define what Godot actually tested. `ready: false` means unknown, not unreachable.

Require both a reachable path and a small endpoint snap distance appropriate to the authored target.
Probe every independent destination; one reachable subject does not validate the
others. Derive the snap-distance threshold from the navigation agent radius or
an explicit authored tolerance.
