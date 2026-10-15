# summer_get_scene_tree

Get a scene tree. Pass scenePath to read that exact in-memory/open scene;
omit it only when you intentionally want the currently visible editor scene.
Scene mutations load their explicit target, so a follow-up targeted read does
not require OpenScene.

The engine defaults to depth 2 and limit 200 nodes and SILENTLY truncates
deeper hierarchies (the response then carries truncated: true and a visited
count lower than the real node count). Pass an explicit depth (e.g. 10) to
read a full tree — a 102-node scene returns only 61 nodes at the defaults.
