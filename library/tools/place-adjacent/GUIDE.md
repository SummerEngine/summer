# summer_place_adjacent

Move one node so its bounds face sits against another node's bounds face along one axis: facade modules edge to edge, a storey stacked on the one below, a cornice on a wall. Optionally line up the other two axes (min, center or max), per axis.

Example: next module to the right, same base height, same front plane: {axis:"x", side:"max", gap:0, alignOtherAxes:{y:"min", z:"max"}}.

Bounds are the visible GeometryInstance3D AABBs (the definition summer_align_distribute_3d uses; evidence visual_aabb). space "local" uses the reference's own axes for rotated facades. When the subject is inside the reference, its geometry is left out of the reference's bounds. One SetProp on position, one undo step, then the scene is saved; a fresh read verifies the achieved gap and residuals (verify). Returns {moved_by, position, verify:{gap, residuals}}. The scene must be open in the editor (any tab).
