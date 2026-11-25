/** Rendered GridMap transforms and meshes in the grid node's frame. */
export const GRIDMAP_GEOMETRY_GDSCRIPT = String.raw`
func _gridmap_geometry(grid):
	# get_bake_meshes() would manufacture a bake on an unbaked grid.
	var stored = grid.get("baked_meshes")
	if stored.is_empty():
		return {"pairs": grid.get_meshes(), "index_field": "grid_entry"}
	var pairs = []
	for mesh in stored:
		pairs.append(Transform3D.IDENTITY)
		pairs.append(mesh)
	return {"pairs": pairs, "index_field": "baked_mesh_index"}
`;
