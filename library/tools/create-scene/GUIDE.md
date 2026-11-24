# summer_create_scene

Create a new empty scene file. Writes a minimal .tscn through the identity-bound engine with a create-only guard: it fails if the path already exists, and it never touches the currently open scene.

The new scene is on disk but NOT opened. Call summer_open_scene to start editing it, then summer_add_node to build it out.

rootType must be a concrete native Node class. Node3D, Node2D, Control and Node work on older editors; other roots need an editor advertising GetClassInfo. Unknown names, Resources and abstract classes are refused before writing a file. For a project class_name, create its native base and attach the script. verified:true confirms both the validated root class and the exact root name/type in the file read back. Class checks do not open, instantiate or modify a scene.

Recommended workflow:
1) Call summer_get_project_context
2) Call summer_create_scene with a new res:// path
3) Call summer_open_scene with that path
