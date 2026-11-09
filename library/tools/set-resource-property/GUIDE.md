# summer_set_resource_property

Set a nested property on a resource attached to a node.

Use when you need to modify a sub-property of a resource, like:
- CollisionShape3D shape size: nodePath="./Player/CollisionShape3D", resourceProperty="shape", subProperty="size", value="Vector3(1, 2, 1)"
- Material albedo color: nodePath="./Floor", resourceProperty="material_override", subProperty="albedo_color", value="Color(0.2, 0.5, 0.2, 1)"
- Mesh size: nodePath="./Box", resourceProperty="mesh", subProperty="size", value="Vector3(2, 2, 2)"
