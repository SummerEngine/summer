# summer_attach_to_surface

Mount a piece on a surface: turn it so its given LOCAL backAxis faces into the surface (opposite the hit normal) with its upAxis kept toward worldUp, then seat its measured back face (the extreme of its visible bounds along backAxis, not its origin) at standoff from the surface. Pipes, gutters, lamps, AC units, signs, fire escapes. Place the piece near its mount first (summer_instantiate_scene with position); this tool turns it and pushes it onto the surface.

Find the surface with surface (a node: the ray runs from the subject's origin to the nearest point of that node's bounds) or ray {origin, direction} (both: the ray, and hits on other nodes are skipped). The ray is physics first; if physics finds nothing it falls back to visual AABBs and says so (the normal is then an AABB face normal). Get backAxis from summer_inspect_asset (the piece's back plane normal), not from a guess.

placeAt "current" (default): the piece keeps its height and its place along the surface and only moves along the surface normal. placeAt "hit": it also slides so the centre of its back face lands on the ray hit point.

Steps (existing ops): a read-only probe (RunSceneScript) reads the piece's bounds in its own axes and casts the ray; one SetProp turns the piece and puts its back face 5 cm in front of the planned seat; SnapToSurface sweeps it along -normal (at most standoff + 0.3) and seats it at standoff (its own physics/visual_aabb evidence). Before saving, the seat is checked:
- with surface: the seat must be on that node (or inside it), else it is refused;
- with a ray only: a seat on another node is refused unless it lies on the hit plane (a coplanar neighbour module, warned);
- the piece must end within maxMove (default 2) of where it started; a longer planned move is refused before anything changes, and so is (with placeAt "current") a ray hit farther than maxMove along the surface from the piece (hit_far_from_piece: aim at the piece, or pass placeAt "hit").
A refused or failed seat puts the piece back where it started (restored: true), saves nothing, and names the cause: seated_on, the seat's failure_reason, blockers {overlapping, overlaps, first_contact} and a next_step.

Returns {seated_on, final_gap (collider gap from SnapToSurface), back_face_gap (visible back face to the hit plane), moved_by, surface_hit, orientation, back_face_offset, seat {evidence, supportPath, finalGap, gapErrorBound, initiallyOverlapping, ...}, saved, warnings}. A warning visible_back_X_into_surface means the piece's collider sits behind its visible back: add X to standoff.
