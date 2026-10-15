# summer_create_scene

Create a new empty scene file. Writes a minimal .tscn through the identity-bound engine with a create-only guard: it fails if the path already exists, and it never touches the currently open scene.

The new scene is on disk but NOT opened. Call summer_open_scene to start editing it, then summer_add_node to build it out.

Recommended workflow:
1) Call summer_get_project_context
2) Call summer_create_scene with a new res:// path
3) Call summer_open_scene with that path
