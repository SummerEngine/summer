# summer_test_placement

Ghost-test one 3D node at an explicit candidate global pose without moving it or saving the scene.

Use this before placing a prop in a shelf, cubby, doorway, platform, or dense set. The compact result reports known overlap evidence, grounded state, signed floor gap, and at most eight overlapping object paths. Physics evidence uses enabled collider shapes; because Godot exposes no query-completeness bit, its overlap count is labeled a lower bound and an otherwise-clear physics result reports fits:null rather than claiming proof. visual_aabb evidence is a broad-phase fallback that also catches visible mesh-only obstacles.

The pose is always global/world-space: position and Euler rotation in degrees are both required, while the subject's current global scale is preserved. scenePath and subjectPath are exact; this tool never falls back to editor selection. The normal result is below 5 KB and the scene is never mutated. On an engine build that predates TestPlacement3D the result is a structured engine_lacks_op failure naming the fallback.
