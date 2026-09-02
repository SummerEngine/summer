---
name: spatial-placement
description: Use when positioning or verifying 3D objects with surrounding-scene evidence — floor and shelf support, wall gaps, collider or mesh overlap, directional clearance, alcoves, rotated props, and post-placement checks. Trigger on "place", "position", "align", "sit on", "against the wall", "inside", "overlap", "clearance", "grounded", "flush", "spatial", "Starcast".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: scene-and-project
user-invocable: false
allowed-tools: Read Grep summer_get_scene_tree summer_inspect_node summer_set_prop summer_batch summer_starcast
paths: ["**/*.tscn"]
---

# Spatial Placement in Summer Engine

Use Starcast as spatial evidence, not as an automatic placement solver. Make a
reasonable transform from scene intent, inspect the result, then correct only
the axes that the evidence shows are wrong.

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
