# summer_replace_node

Replace a node with a different scene/model or node type, keeping its parent, sibling index, name, transform and property overrides, and the children the scene added under it. Use it to swap a kit piece for another (a wall host for a door host), a placeholder for a prefab, or a StaticBody3D for a RigidBody3D.

Give exactly one of scene or type. The scenePath must be a .tscn.

PERSISTENCE IS VERIFIED: the tool saves, reads the saved .tscn back and checks that the node at path now instances the new scene (or has the new type), under the same parent, with every child present. persisted:true is proven from the file; a mismatch is an error with failure_reason not_persisted — never report that as done.

How: a scene swap runs as InstantiateScene (temporary name) -> SetProp each property override -> ReparentNode the children -> MoveNode to the old index -> RemoveNode the old node -> rename -> SaveScene, because the engine's own ReplaceNode keeps the OLD scene reference in the saved file. A type change of a plain node uses the engine's ReplaceNode. State that cannot travel (groups, signal connections, scene-local sub_resource values, overrides of nodes inside the old scene) is listed in not_carried_over. Undo takes one Ctrl+Z per step.
