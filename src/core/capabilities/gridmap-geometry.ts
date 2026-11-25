/** Rendered GridMap transforms and meshes in the grid node's frame. */
export const GRIDMAP_GEOMETRY_GDSCRIPT = String.raw`
func _gridmap_geometry(grid):
	# get_bake_meshes() would manufacture a bake on an unbaked grid.
	var stored = grid.get("baked_meshes")
	if stored.is_empty():
		var pairs = grid.get_meshes()
		return {"pairs": pairs, "index_field": "grid_entry", "shadows_only": _gridmap_shadow_entries(grid, pairs)}
	var pairs = []
	for mesh in stored:
		pairs.append(Transform3D.IDENTITY)
		pairs.append(mesh)
	return {"pairs": pairs, "index_field": "baked_mesh_index", "shadows_only": {}}


func _gridmap_shadow_entries(grid, pairs):
	var shadow_entries = {}
	if pairs.is_empty():
		return shadow_entries
	var library = grid.mesh_library
	var shadow_meshes = {}
	var known_items = {}
	for id in library.get_item_list():
		known_items[id] = true
		if library.get_item_mesh_cast_shadow(id) == RenderingServer.SHADOW_CASTING_SETTING_SHADOWS_ONLY:
			var mesh = library.get_item_mesh(id)
			if mesh != null:
				shadow_meshes[mesh] = true
	if shadow_meshes.is_empty():
		return shadow_entries

	# get_meshes() exposes the actual poses but omits item IDs and meshless cells.
	# Match only affected mesh resources by their poses. Two library items can
	# share a mesh with different shadow settings, including at a coincident pose.
	var placements = {}
	for cell in grid.get_used_cells():
		var id = grid.get_cell_item(cell)
		if not known_items.has(id):
			continue
		var mesh = library.get_item_mesh(id)
		if not shadow_meshes.has(mesh):
			continue
		var basis = grid.get_cell_item_basis(cell).scaled(Vector3.ONE * grid.cell_scale)
		var pose = Transform3D(basis, grid.map_to_local(cell)) * library.get_item_mesh_transform(id)
		var key = [mesh, pose]
		if not placements.has(key):
			placements[key] = []
		placements[key].append(library.get_item_mesh_cast_shadow(id))
	for matches in placements.values():
		matches.reverse()
	for i in range(0, pairs.size(), 2):
		var key = [pairs[i + 1], pairs[i]]
		if placements.has(key) and not placements[key].is_empty():
			if placements[key].pop_back() == RenderingServer.SHADOW_CASTING_SETTING_SHADOWS_ONLY:
				shadow_entries[int(i / 2)] = true
	return shadow_entries
`;
