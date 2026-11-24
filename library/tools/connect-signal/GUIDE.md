# summer_connect_signal

Connect a signal between two nodes so the connection is SAVED in the scene. Signals are Godot's event system — they notify when something happens.

Common signals:
- "body_entered" / "body_exited" — Area3D/Area2D detects physics bodies
- "pressed" — Button clicked
- "timeout" — Timer finished
- "area_entered" — Area detects another area
- "input_event" — CollisionObject received input

The receiver should have the method (a script method, or a built-in such as queue_free); a missing one is saved anyway and reported in warnings. scenePath must be a .tscn.

PERSISTENCE IS VERIFIED: the engine's ConnectSignal op connects without CONNECT_PERSIST, so its connection never reached the file. This tool connects through a RunSceneScript probe with CONNECT_PERSIST (replacing a non-persistent connection of the same pair) and verifies the saved connection. A local connection includes its [connection] line. For an existing connection inherited from a base or instanced scene, Godot reads the saved scene and its dependencies and reports the declaring scene and flags. If the saved declaration is missing, the tool returns failure_reason not_persisted. The probe runs in the active tab: a scene in a background tab is brought forward and the user's tab restored (tab_switched). One Ctrl+Z reverts a newly created connection.
