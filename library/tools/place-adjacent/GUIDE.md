# summer_place_adjacent

Move one node so its bounds face sits against another node's bounds face along one axis: facade modules edge to edge, a storey stacked on the one below, a cornice on a wall. Optionally line up the other two axes (min, center or max), per axis.

Example: next module to the right, same base height, same front plane: {axis:"x", side:"max", gap:0, alignOtherAxes:{y:"min", z:"max"}}.

Bounds come from visible GeometryInstance3D surfaces (evidence visual_aabb). The scan skips shadows-only casters and includes their separately drawn children. Use summer_align_distribute_3d for group alignment. space "local" uses the reference's own axes for rotated facades. When the subject is inside the reference, its geometry is left out of the reference's bounds. One SetProp on position, one undo step, then the scene is saved; a fresh read verifies the achieved gap and residuals (verify). A measured result includes verify:{gap, residuals}. If either node loses its visible bounds after the save, saved stays true and verify reports {ok:false, error}. The scene must be open in the editor (any tab).
