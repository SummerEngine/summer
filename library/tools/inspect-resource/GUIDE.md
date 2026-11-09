# summer_inspect_resource

Read a resource: a material, mesh, shape, texture, environment, or a scene/model file.

Two forms, pass exactly one:
- path: a resource FILE ('res://materials/ground.tres', a mesh 'res://kit/meshes/wall_01.res', 'res://models/player.glb'), loaded read-only in the editor. A Mesh returns its AABB, surface_count and per surface the primitive, vertex and index counts, attributes, triangles and material (class, path or embedded, albedo for standard materials), plus the unique materials and blend shapes. A scene or model (.tscn/.glb/.gltf) returns its node count, the first 40 nodes with type, instanced scene and mesh, and its meshes; summer_inspect_asset measures it (AABB, planes, ports). Every other resource (and a mesh) returns its editor properties that differ from the class default (props), with props_at_default counting the rest.
- nodePath + property: a resource a node of the ACTIVE scene tab holds, e.g. nodePath 'Floor', property 'mesh'. For example, summer_inspect_node tells you a MeshInstance3D has a "StandardMaterial3D" material_override — this form returns its albedo_color, metallic, roughness, etc.
