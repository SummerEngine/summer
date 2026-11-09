# summer_navigation_probe

Inspect whether two explicit world-space points are connected by the targeted 3D scene's built-in Godot navigation map without changing or saving the scene.

Returns navigation readiness and its reason, map iteration and region counts, requested and layer-filtered snapped endpoints, snap distances, conservative reachability, full route length, and at most 16 deterministic route points. A path is reachable only when it terminates at both snapped endpoints within the reported tolerance.

ready:false means navigation evidence is unavailable, not that the route is unreachable. In particular, map iteration 0 precedes the first usable synchronization and can return silently empty paths; iteration 1 and later are usable. evidence is always navigation. Normal results are capped below 5 KB.

Always pass an exact scenePath and finite world-space start/end points. This read-only tool never uses editor selection, creates undo history, or calls SaveScene. On an engine build that predates NavigationProbe3D the result is a structured engine_lacks_op failure naming the fallback.
