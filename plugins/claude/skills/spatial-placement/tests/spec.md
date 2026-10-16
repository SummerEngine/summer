# Skill Spec: /spatial-placement

## Fixture

- A 3D scene with a floor, a shelf unit with a back panel, a wall, a rotated
  crate prop that owns a collider, and one visible mesh-only obstacle without
  a collider.
- `summer_starcast` is available on an engine build with `Starcast3D`, plus
  `summer_get_scene_tree`, `summer_inspect_node`, `summer_set_prop`, and
  `summer_batch`.

## Case 1: Rotated prop on a shelf

**Input:** "Put the crate on the middle shelf, flush against the back panel but
not clipping it."

**Expected MCP tool sequence (in order):**

1. `summer_get_scene_tree`
2. `summer_inspect_node` for the crate and the shelf
3. `summer_set_prop` (approximate placement from scene intent)
4. `summer_starcast` with `detail="summary"`
5. `summer_set_prop` (one correction on only the axes the evidence names)
6. `summer_starcast` with `detail="summary"`

**Assertions:**

- [ ] Every `summer_starcast` call passes exact `scenePath` and `path`; no
  editor-selection fallback.
- [ ] `grounded: true` with the shelf as the downward object; `contactStatus`
  shows no unintended `contact_or_overlap`.
- [ ] The back direction reports `blocked` at a small positive distance (or the
  requested contact); the forward direction is `open`.
- [ ] `directionSpace="local"` is used only because the crate is rotated;
  `world` otherwise.
- [ ] At most two summary calls around one correction; `detail="full"` is not
  requested unless summary was ambiguous.

## Case 2: Overlap repair with partial coverage

**Input:** "The barrel is clipping into the wall, fix it."

**Expected MCP tool sequence (in order):**

1. `summer_starcast` with `detail="summary"`
2. `summer_set_prop` along the clearest axis with the shortest correction
3. `summer_starcast` with `detail="summary"`

**Assertions:**

- [ ] The correction moves along one axis only and does not resize the asset.
- [ ] A `subject_has_no_collision_shapes` or `physics_unavailable` warning is
  reported to the user as partial coverage, never silently ignored.
- [ ] `evidence: "visual_aabb"` is never described as exact contact.

## Case 3: Engine without Starcast3D

**Input:** Case 1 on an engine build that predates `Starcast3D`.

**Assertions:**

- [ ] `summer_starcast` returns `failure_reason: engine_lacks_op`; the agent
  does not retry blindly.
- [ ] The agent falls back to `summer_test_placement` and `summer_inspect_node`
  evidence and states which evidence it used.
