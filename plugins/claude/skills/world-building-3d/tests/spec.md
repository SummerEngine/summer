# Skill Spec: /world-building-3d

## Fixture

- A 3D scene contains props, flat and sloped supports, a perspective camera,
  colliders, and a synchronized navigation map.
- All four Summer spatial tools and ordinary inspection/screenshot tools are
  available.

## Case 1: Ground mixed props

**Input:** "Seat these crates on the floor, shelf, and ramp without collisions."

**Expected MCP tool sequence (in order):**

1. `summer_get_scene_tree`
2. `summer_inspect_node` for subjects and supports
3. `summer_test_placement` for uncertain candidate poses
4. `summer_snap_to_surface` per subject
5. `summer_test_placement` at each saved pose
6. `summer_screenshot`

**Assertions:**

- [ ] Exact scene and node paths are used.
- [ ] `fits: null` is not treated as proof of clearance.
- [ ] Slope alignment requires physics evidence, resolved contact, the expected
  support, plausible slope, saved-basis inspection, and an independent heading
  or rendered check.
- [ ] Ambiguous support choices are confirmed before mutation.

## Case 2: Arrange a navigable encounter

**Input:** "Evenly space these stalls and make sure each merchant is reachable
from spawn."

**Expected MCP tool sequence (in order):**

1. `summer_align_distribute_3d`
2. `summer_test_placement` for dense-spacing clearance
3. `summer_navigation_probe` for each final merchant position
4. `summer_screenshot` or `summer_play`

**Assertions:**

- [ ] Subject ordering and world axis are explicit.
- [ ] Reachability requires `ready: true` and an acceptable snap distance.
- [ ] Every mutation is followed by a saved-pose query or rendered check.
