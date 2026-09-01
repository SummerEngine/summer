# Spatial tool evidence contract

Load this reference before using Summer's 3D world-building tools.

## Shared rules

- Pass exact `scenePath` and scene-root-relative node paths. Never rely on
  editor selection.
- Use one `World3D`; the tools fail closed across SubViewport-owned worlds.
- Keep subject counts bounded: placement/snap one, visibility five, framing
  eight, alignment sixteen.
- Normal model-visible results stay below 5 KiB.
- Placement, visibility, and navigation are read-only. Snap, align, and frame
  register undo and save the exact target scene.

## Placement

`summer_test_placement` evaluates a candidate global position and global Euler
rotation while preserving current global scale. Physics overlap counts are
lower bounds because Godot exposes no broadphase-completeness bit. Known
obstruction means `fits: false`; zero known physics overlaps can still mean
`fits: null`. Grounding and signed `floorGap` are independent evidence. Claim
physics-grounded only when `floorEvidence` is `physics` and
`supportQueryComplete` is true.

## Surface snap

`summer_snap_to_surface` sweeps enabled collider shapes along a normalized world
direction. `visual_aabb` is a mesh-only fallback and does not provide a trusted
surface normal. Require physics evidence, resolved contact, expected
`supportPath`, `alignApplied`, plausible `slopeDeg`, final gap/error bound, and
saved basis. The result does not expose the raw support normal or heading
residual, so independently verify the basis and rendered pose.

## Alignment

`summer_align_distribute_3d` uses visible descendant world AABBs, preserves
basis/scale, and translates only along the requested axis. It is one-dimensional
evidence and does not prove clearance on the other axes.

## Camera tools

`summer_frame_camera` analytically frames visible world AABBs for a requested
aspect. `summer_camera_visibility` projects those bounds and samples one to five
physics rays per subject. Use the same real delivery aspect for both. Shader
displacement, transparent silhouettes, and pixel visibility remain outside the
evidence boundary.

## Navigation

`summer_navigation_probe` treats map iteration 0 as unready and iteration 1+
as queryable. Require both reachable output and an acceptable requested-to-
snapped endpoint distance. Probe every destination separately and derive the
distance threshold from navigation-agent radius or an explicit authored
tolerance.
