# summer_raycast

Cast one ray from any point in an open scene, before anything is placed there: find the wall, floor or ceiling in front of a point and its normal. (summer_starcast casts from an existing node's bounds; this casts from an arbitrary origin.)

evidence auto (default): physics first (collider hit: exact point and normal); if physics hits nothing, the nearest visible-mesh AABB hit, declared with fallback:true and fallback_reason. Physics needs the scene to be the active editor tab (only that scene's bodies are in the editor's physics space); otherwise auto falls back to visual AABBs. When physics hits but a mesh-only object is nearer, nearer_visual_only names it.

Returns {hit, evidence, path, point, normal, distance, origin, direction, physics_available, warnings}. Read-only (RunSceneScript probe, undo "none"); never saves.
