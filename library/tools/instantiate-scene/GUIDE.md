# summer_instantiate_scene

Add an existing scene or 3D model as a child node. Use this to:
- Add a .tscn prefab (reusable scene) as a child
- Add a .glb/.gltf 3D model into the scene
- Compose scenes from smaller scenes (e.g., add a "Player" scene into a "Level" scene)

The scene must already exist in the project. Use summer_import_from_url first if importing from external sources.

PASS target_size FOR IMPORTED MODELS. Downloaded/generated .glb assets arrive at arbitrary scale (a "chair" can be 40 units tall). target_size uniformly scales the instanced subtree so its largest world-AABB dimension equals that many units — commit to real-world size: chair 1.0, door 2.0, car 4.5, person 1.7, tree 6-10. The result then reports dimensions + scale_applied; verify placement afterwards (summer_world_snapshot AABBs, summer_screenshot). Older engine builds ignore target_size — when the result lacks scale_applied, this tool appends a note and you must scale the node yourself (summer_set_prop scale) and re-check.

PLACE IT IN THE SAME CALL: position, rotation_degrees and scale ([x, y, z], parent-local, like summer_set_prop), or transform (a "Transform3D(...)" string). The instance is created, then those properties are set on the exact node path the receipt reports (a name collision rename is followed), then the scene is saved: one call per piece, no window at the origin. The result adds placement {nodePath, applied, fields}. Do not combine transform with the others, or scale/transform with target_size. Measure a kit piece first with summer_inspect_asset.
