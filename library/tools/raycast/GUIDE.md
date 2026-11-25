# summer_raycast

Cast one ray from any point in an open scene, before anything is placed there: find the wall, floor or ceiling in front of a point and its normal. (summer_starcast casts from an existing node's bounds; this casts from an arbitrary origin.)

evidence auto (default): physics first (collider hit: exact point and normal); if physics hits nothing, the nearest visible-mesh AABB hit, declared with fallback:true and fallback_reason. Physics needs the scene to be the active editor tab (only that scene's bodies are in the editor's physics space); otherwise auto falls back to visual AABBs. When another visual bound is nearer than the physics hit, nearer_visual_only reports its AABB entry point and box-face normal. The hit collider's own mesh is skipped. Each drawn GridMap cell mesh or stored baked mesh supplies its own AABB. A visual bound can extend into empty space and can belong to an object with collision.

Returns {hit, evidence, path, point, normal, distance, origin, direction, physics_available, warnings}. Read-only (RunSceneScript probe, undo "none"); never saves.
