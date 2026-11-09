# summer_snap_to_surface

Move one exact 3D subject along a world-space ray until its support face sits at the requested gap from the first surface. This changes only the subject's global transform, saves the scene, and is one reversible editor undo.

Use the default downward direction to seat props on floors, ramps, tables, or shelves. Set alignUp only when the prop should tilt to match the support normal.

EVIDENCE BOUNDARY:
- physics means Godot swept the subject's enabled collider shapes against body colliders and refined the first-contact bracket.
- visual_aabb is the engine's broad-phase fallback for mesh-only geometry (no collider on the subject or the support): AABBs swept against AABBs. It does not prove triangle contact, and alignUp is not applied from that approximate normal.
- visual_mesh: whenever the engine answers with visual_aabb (overlap_recovery_exceeded, gap_exceeds_hit_travel, surface_not_found, or a seat), a read-only probe measures the move from visible triangles instead: the subject's vertices cast along the direction onto the triangles of the meshes below (a surface cutting through the subject counts as sunk), plus the support's vertices under it cast back. One SetProp places the subject, a second read verifies the gap (the move is undone if it disagrees by more than 5 mm), and the scene is saved. The receipt says evidence visual_mesh, the engine's own answer under engine, verify {final_gap, ok}, and evidenceDetails (samples, triangles, whether the subject and the support have colliders). Meshes whose shader writes POSITION (screen-space quads) are not surfaces. When the triangles find no support either, the engine's failure is returned with mesh_fallback saying why.
- initiallyOverlapping and backoffDistance expose bounded pre-sweep recovery. The tool fails instead of teleporting when the subject cannot be cleared within maxDistance.

SUNK PROPS: when the subject starts inside its support (gap_exceeds_hit_travel with a start overlap), the tool lifts it against the cast direction by the overlap depth plus 0.02 m (at most 0.5 m and the subject's own extent), snaps again from there, and keeps that only if it settles on a node it was sunk into; the receipt then carries recovery (lifted_by, original_local_position) and 'before' is the lifted pose. Otherwise the original position is restored.

FAILURES EXPLAIN THEMSELVES: after gap_exceeds_hit_travel or overlap_recovery_exceeded a read-only starcast at the current pose adds start_overlap, blocking (the nodes it touches or sits inside), below, and a concrete next_step.

The normal result is bounded below 5 KB and returns before/after transforms, supportPath, finalGap with an error bound, slopeDeg, evidence, and warnings. scenePath and subjectPath are always required; there is no editor-selection fallback. On an engine build that predates SnapToSurface the result is a structured engine_lacks_op failure naming the fallback.
