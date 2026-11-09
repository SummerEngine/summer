# summer_measure

Measure placement between specific nodes from their visible-mesh bounds (evidence visual_aabb). Read-only, never saves. Complements summer_starcast (which reports clearance around ONE node in 26 directions).

mode pair (a, b): per axis {gap (> 0 clearance, < 0 overlap depth), relation gap|touching|overlap, a/b intervals, delta_min/max/center (b minus a)} and boxes_overlap. Catches facade gaps and modules that overlap.
mode plane (nodes, face): whether that face of every node lies on one plane: {coplanar, plane (median), spread, nodes [{path, face, deviation, off_plane: proud|recessed}]}. Catches modules standing proud of a facade line. face '+z' = the face pointing along +z.

space "local" measures along the axes of a (pair) or nodes[0] (plane), for rotated facades. tolerance (default 5 mm) decides touching / coplanar.
