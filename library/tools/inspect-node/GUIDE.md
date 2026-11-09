# summer_inspect_node

Get all editable properties of a node with their current values, types, and resource info.

Call this before modifying a node to understand its current state. Returns every property the Godot inspector would show. Each prop carries the engine's raw Variant.Type integer as "type" plus its name as "type_name" (e.g. type 5 = TYPE_VECTOR2, 20 = TYPE_COLOR, 24 = TYPE_OBJECT); resource-valued props also carry resource_type / resource_path.

Reads the currently OPEN scene — "path" is relative to its root (there is no scenePath argument; open the scene first if needed).

Example: inspect a light to see its energy, color, shadow settings before changing them.

The full read is about 5 KB. To read only what you need, pass fields: property names or globs ('position', 'surface_material_override/*'), plus derived fields: transform (local position / rotation_degrees / scale, and a Transform3D literal for 3D nodes), global_transform (world origin + Transform3D, composed from the world snapshot), scene_file_path (the scene this node instances), aabb (world bounds), warnings. Example: fields:['transform','global_transform','scene_file_path'] is a few hundred bytes. missing_fields and unavailable say what could not be read.
