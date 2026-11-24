# summer_create_scene

Create a new empty scene file. Writes a minimal .tscn through the identity-bound engine with a create-only guard: it fails if the path already exists, and it never touches the currently open scene.

The new scene is on disk but NOT opened. Call summer_open_scene to start editing it, then summer_add_node to build it out.

Recommended workflow:
1) Call summer_get_project_context
2) Call summer_create_scene with a new res:// path
3) Call summer_open_scene with that path

Pass a concrete native Node class such as `Camera3D`. For a registered GDScript class, open its script in the selected editor and save any edits before calling this tool. The script’s constructor must accept zero arguments, including when it inherits a constructor. The scene stores the native Node base and attaches the registered script.

If the editor has no current constructor metadata, the tool returns `class_verification_unavailable` and leaves the destination free. Other scripting languages currently lack verified constructor support. Unknown, abstract and non-Node classes fail before creation. On editors that use an offscreen preview for class lookup, stop a running game if it blocks the preview.
