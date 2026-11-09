# summer_starcast

Read a 3D spatial rundown for one exact node in an exact scene without moving it or saving the scene: 26 directional clearance casts (6 axes, 12 edges, 8 corners) from the subject's bounds, contact-or-overlap evidence, grounded state, and, in full detail, bounded nearby-object lists. Use it before and after placing an object to learn which side is blocked, by what, and at what distance.

detail 'summary' (default) is a placement report of at most 5 KB: subject position and size, grounded and contactStatus, deduplicated contact paths, one compact record per direction (status open|blocked, nearest distance, object, evidence, relationship), coverage, and warnings. detail 'full' adds per-direction hit geometry, an objects table, nearby lists, and the query echo, at most 12 KB; the engine downgrades to summary rather than exceed that (warning full_result_exceeded_12kb_returned_summary) and always reports requestedDetail vs returnedDetail.

EVIDENCE BOUNDARY:
- evidence 'physics' uses Godot's PhysicsDirectSpaceState3D against exact collider geometry on collisionMask. Shape intersections say contact_or_overlap because the query does not establish penetration depth; touching and anything within margin are included.
- evidence 'visual_aabb' uses visible world-axis-aligned bounding boxes: it catches meshes without colliders but is broad-phase only, never triangle-level contact.
- Lights, cameras, audio, navigation, scripts, and plain Nodes are not obstacles unless they own visual or collision geometry. One representative ray per direction can miss off-center geometry.

scenePath and path are exact; editor selection is never consulted. This tool is read-only: it never moves the node or saves the scene. On an engine build that predates Starcast3D the result is a structured engine_lacks_op failure naming the fallback.
