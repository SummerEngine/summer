# summer_create_scene

Create a new empty .tscn in the selected project. Pass a new res:// path. An existing file stays intact and the current editor scene stays open.

rootType accepts a concrete native Node class such as Camera3D. To use a registered GDScript class, open its script in the selected editor and save any edits first. Its constructor must accept zero arguments, including when inherited. The scene stores the concrete native Node base with that script attached.

Unknown, abstract and non-Node roots fail before writing. If the editor lacks current constructor metadata, the tool returns class_verification_unavailable and leaves the destination free. Other scripting languages currently lack verified constructor support. On editors that use an offscreen preview for class lookup, stop a running game if it blocks the preview.

A verified result confirms that the editor read back the expected scene text. Call summer_open_scene with the new path to edit it, then summer_add_node to add children.
