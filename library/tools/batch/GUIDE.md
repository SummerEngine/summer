# summer_batch

Execute multiple operations (a multi-node build) in a single call. Each op is forwarded to the engine VERBATIM: this is also how you reach engine ops without a dedicated tool.

UNDO: when nothing in the list forces a split (see SPLITS), the whole batch is ONE undo step (one Ctrl+Z). Single-only ops split the list into sequential requests, and EACH chunk is its own undo step (the receipt shows the chunks).

Ops use the individual tools' format:
- {"op": "AddNode", "parent": "/", "type": "MeshInstance3D", "name": "Floor"}
- {"op": "SetProp", "path": "Floor", "key": "position", "value": "Vector3(0, -1, 0)"}
- {"op": "SetProp", "path": "Floor", "key": "mesh", "value": "PlaneMesh"}
- {"op": "SetResourceProperty", "nodePath": "Floor", "resourceProperty": "mesh", "subProperty": "size", "value": "Vector2(20, 20)"}

SPLITS AND SAVE: scenePath selects every mutation target. Send OpenScene (a UI action) separately, never mixed with scene mutations. The tool appends one final SaveScene when the batch mutates a scene; a SaveScene you supply must appear exactly once, as the final op. The engine requires SaveScene, InstantiateScene, ReplaceNode, SimulateInput, the runtime reads (GetRuntimeSceneTree/GetRuntimeNode) and the Run*/Import* ops to travel alone, so the tool splits the list around them; if a later chunk fails, the receipt names the earlier ops that already applied.

RAW RUNTIME OPS (structured failure_reason passes through verbatim):
- RunVerification: a hidden, disposable game instance runs a GDScript probe and dies, never touching the editor: {"op": "RunVerification", "probe_source": "...", "max_seconds": 20} returns {ok, results, frames, out_dir}. Probe API: report(name, value) / save_frame(name) / press(action) / key(keycode) / finish(); save_frame() without a name is a script error. Mount scenes deferred (add_child.call_deferred) or the capture can be black; summer_get_agent_playbook has the probe rules.
- SimulateInput: inject an action/key/mouse/axis into the RUNNING game (summer_play first), sent ALONE: {"op": "SimulateInput", "type": "action", "action": "jump", "pressed": true}. failure_reason "not_running" = start the game first; "unsupported" = the game build predates the handler: use RunVerification or ask the user.

REFUSED: a raw ReplaceNode with scene (it saves the old scene reference; use summer_replace_node) and a raw ConnectSignal (no CONNECT_PERSIST, so the file never holds it; use summer_connect_signal).

REPARENTNODE KEEPS ITS SUBTREE AND IS VERIFIED: the engine op re-owns only the moved node and drops its descendants from the saved file, so the tool saves, sends each ReparentNode alone plus an in-place ReparentNode per scene-owned descendant, then reads the saved .tscn back: persisted:true / verified:true only when every moved node and descendant is at its new path, else failure_reason not_persisted. A move onto a parent with a same-named child is refused (name_collision). scenePath must be a .tscn; Undo cannot share the batch.

PLACED INSTANCES: an InstantiateScene op may carry position, rotation_degrees, scale ([x, y, z] or "Vector3(...)") or transform ("Transform3D(...)"), set on the created node; one op per piece. Each InstantiateScene is its own request and the transforms of a run follow together (up to 200 per request), so N pieces plus the save cost about N + 2 requests and undo steps. Later ops (SetProp, SnapToSurface, the save) see the pieces placed; if one fails, the pieces before it still get their transforms.

RECEIPTS: receipt "summary" returns only counts, failures [{index, op, error}] (index into your ops), created node paths and renames, under 5 KB with any cut declared. Use it for any batch over a few ops: a large full receipt overflows the tool-output limit.

scenePersistence.saved means the SaveScene ran, not what the file holds; verified:true is set only where the tool read the file back.
