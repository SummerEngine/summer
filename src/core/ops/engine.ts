/**
 * The `engine` area of the operation catalog: every operation that runs in
 * Summer Engine on the person's computer. The 3.x tools stay the
 * implementation and keep their MCP names (summer_set_prop is
 * engine.set_prop); their input schemas stay in
 * library/tools/<slug>/resource.yaml. This file adds what the catalog needs
 * on top: a title, a short summary (what it does, what it returns, the next
 * operation), the effect, and one real example.
 *
 * The long how-to text of each 3.x description lives in
 * library/tools/<slug>/GUIDE.md (docs.read tool/<slug>), so a summary stays
 * at or under 300 characters.
 *
 * Effects follow the 3.x annotations: a tool that only reads or renders
 * evidence is `read` (render baselines and audit notes under res://.summer/
 * do not change the game); everything else is `write`. Scene edits are
 * undoable and checkpointed, so no engine operation is `destructive`, and
 * none needs an approval.
 *
 * Two 3.x tools mixed a read with a change; their operations are split here
 * (SPEC §3.1 rule 5) and run the same tool with its action fixed:
 * summer_camera_bookmark (list, save, delete) and summer_ui_actions (list,
 * invoke).
 */

export interface EngineOpDef {
  title: string;
  summary: string;
  effect: "read" | "write";
  example: { input: Record<string, unknown>; note: string };
  /** Needs the Summer sign-in (imports from the Summer library). */
  auth?: "account";
}

/** An operation cut out of a mixed 3.x tool: that tool, with its action fixed and only these fields. */
export interface EngineSplitDef extends EngineOpDef {
  tool: string;
  fixed: Record<string, string>;
  fields: readonly string[];
  required?: readonly string[];
}

const MAIN = "res://main.tscn";

export const ENGINE_OPS: Readonly<Record<string, EngineOpDef>> = {
  // ── Project and reads ─────────────────────────────────────────────────────
  "engine.get_project_context": {
    title: "Read the project context",
    summary:
      "Bind this session to the project open in Summer Engine and read it: project, current and main scene, engine health, project memory and warnings. Call it first in every chat; the scene tree and settings come on request (include). Next: engine.get_scene_tree.",
    effect: "read",
    example: { input: {}, note: "First call of a chat." },
  },
  "engine.get_scene_tree": {
    title: "Read a scene's node tree",
    summary:
      "Read the node tree of a scene: names, types and paths. Pass scenePath for an exact scene and depth for deep trees; the engine stops at depth 2 and 200 nodes by default and says truncated. Next: engine.inspect_node.",
    effect: "read",
    example: { input: { scenePath: MAIN, depth: 10 }, note: "The whole tree of the main scene." },
  },
  "engine.inspect_node": {
    title: "Read a node's properties",
    summary:
      "Read one node of the open scene: every editable property with its value and type, or only the fields you name (transform, global_transform, scene_file_path, aabb). Next: engine.set_prop.",
    effect: "read",
    example: { input: { path: "Player", fields: ["transform", "global_transform"] }, note: "Where the player stands." },
  },
  "engine.inspect_resource": {
    title: "Read a resource",
    summary:
      "Read a resource file (a mesh's bounds and surfaces, a scene's nodes, any resource's non-default properties) or a resource a node holds (nodePath and property). Next: engine.set_resource_property.",
    effect: "read",
    example: { input: { nodePath: "Floor", property: "material_override" }, note: "The floor material's colour and roughness." },
  },
  "engine.inspect_asset": {
    title: "Measure a 3D asset file",
    summary:
      "Measure a 3D asset file without placing it: bounds, origin, meshes, largest flat faces, open pipe ends, Marker3D anchors and collision shapes. Measure each kit piece once before placing it. Next: engine.instantiate_scene.",
    effect: "read",
    example: { input: { path: "res://kit/wall_01.glb" }, note: "Size and facing of a wall piece." },
  },
  "engine.world_snapshot": {
    title: "Take a scene snapshot",
    summary:
      "Take a structured snapshot of the edited scene: node paths, transforms, world bounds, fingerprints and counts, filtered by subtree, class or field. Returns snapshot_id, the baseline to diff after a change. Next: engine.snapshot_diff.",
    effect: "read",
    example: { input: { path_prefix: "Level" }, note: "Baseline before a change to the level." },
  },
  "engine.snapshot_diff": {
    title: "Compare two scene snapshots",
    summary:
      "Compare two scene snapshots: added, removed and changed nodes and count changes. The proof that a change did what you meant; an empty diff after a change means it did not land. Next: engine.screenshot.",
    effect: "read",
    example: { input: { from_id: "snap_3" }, note: "What changed since the baseline." },
  },
  "engine.get_script_errors": {
    title: "Check a script for errors",
    summary:
      "Check one GDScript file for parse and compile errors without running the game: line, message and severity of each. The first check after writing a script.",
    effect: "read",
    example: { input: { path: "res://player.gd" }, note: "Does the new player script compile?" },
  },
  "engine.get_diagnostics": {
    title: "Read errors and warnings",
    summary:
      "Read the editor console, the runtime debugger and script errors together, with complete counts and errors first. The first read after a change and after play. Next: engine.get_debugger_errors or engine.get_console for the details.",
    effect: "read",
    example: { input: {}, note: "Did the play session log errors?" },
  },
  "engine.get_console": {
    title: "Read the editor console",
    summary:
      "Read recent editor Output messages, collapsed and filtered (errors and warnings by default; errors_only false for print output). A played game's runtime errors are not here: read engine.get_diagnostics first.",
    effect: "read",
    example: { input: { errors_only: false, filter: "spawn" }, note: "What the spawner printed." },
  },
  "engine.clear_console": {
    title: "Clear the editor console",
    summary: "Clear the editor's Output panel, for a clean slate before the game runs.",
    effect: "write",
    example: { input: {}, note: "Clean slate before play." },
  },
  "engine.get_debugger_errors": {
    title: "Read runtime errors",
    summary:
      "Read the played game's runtime errors from the debugger (null references, missing nodes, physics errors), collapsed, with call stacks on request. After a fix, read engine.get_diagnostics again.",
    effect: "read",
    example: { input: { include_stack: true }, note: "The crash after play, with its stack." },
  },
  "engine.get_debugger_warnings": {
    title: "Read runtime warnings",
    summary: "Read the played game's runtime warnings from the debugger, with file, line and call stack.",
    effect: "read",
    example: { input: { max_warnings: 20 }, note: "The warnings diagnostics counted." },
  },
  "engine.read_file": {
    title: "Read a project file",
    summary:
      "Read a text file of the project (res://), a line or byte window of it, or parts of a .json, with the whole file's sha256. Pass that sha256 to engine.write_file or engine.replace_text to change the file safely.",
    effect: "read",
    example: { input: { path: "res://player.gd", offset: 1, limit: 80 }, note: "The first 80 lines." },
  },
  "engine.grep": {
    title: "Search project files",
    summary:
      "Search project files with a regular expression: file, line and text of each match, with optional context lines and a result cap. Then read the part you need with engine.read_file.",
    effect: "read",
    example: { input: { pattern: "func take_damage", glob: "*.gd" }, note: "Where damage is handled." },
  },
  "engine.is_running": {
    title: "Check whether the game runs",
    summary: "Check whether the game is running, and which scene it runs.",
    effect: "read",
    example: { input: {}, note: "Did play boot?" },
  },

  // ── Scene edits ───────────────────────────────────────────────────────────
  "engine.create_scene": {
    title: "Create a scene file",
    summary:
      "Create a new, minimal .tscn file with the root type you name. It fails when the file exists and never touches the open scene. Build it out with engine.run_script and that scenePath.",
    effect: "write",
    example: { input: { path: "res://levels/level_02.tscn", rootType: "Node3D", rootName: "Level02" }, note: "A new empty level." },
  },
  "engine.run_script": {
    title: "Run a script on a scene",
    summary:
      "Run one GDScript func run(ctx) in the live editor on the scene at scenePath: the way to make 3 or more scene edits, loops, grids and procedural meshes. Returns reports, output and errors. Loop: engine.world_snapshot, this, engine.snapshot_diff, engine.screenshot.",
    effect: "write",
    example: {
      input: {
        scenePath: MAIN,
        source:
          'func run(ctx):\n\tvar root = ctx.get_scene_root()\n\tfor i in range(5):\n\t\tctx.add_mesh("box", "Crate%d" % i, root, {"position": Vector3(i * 2, 0.5, 0)})\n\tctx.save_scene()\n',
      },
      note: "Five crates in a row, saved.",
    },
  },
  "engine.run_editor_script": {
    title: "Run a script in a headless editor",
    summary:
      "Run an EditorScript func _run() in a fresh headless editor against the project on disk: batch and project-wide jobs such as re-saving many scenes. It cannot see unsaved edits. For the open scene use engine.run_script.",
    effect: "write",
    example: { input: { source: 'func _run():\n\tprint(DirAccess.get_files_at("res://levels"))\n' }, note: "List the level files." },
  },
  "engine.add_node": {
    title: "Add a node",
    summary:
      "Add one node of any type to the scene at scenePath (it need not be the open tab) and save it. For 3 or more edits, write one engine.run_script instead. Next: engine.set_prop.",
    effect: "write",
    example: { input: { scenePath: MAIN, parent: ".", type: "OmniLight3D", name: "Lamp" }, note: "One light." },
  },
  "engine.set_prop": {
    title: "Set a node property",
    summary:
      'Set one property of a node in the scene at scenePath and save it. Values use Godot syntax: "Vector3(0, 1, 0)", "Color(1, 0, 0, 1)", or a resource class such as "BoxMesh". For 3 or more edits, write one engine.run_script.',
    effect: "write",
    example: { input: { scenePath: MAIN, path: "Lamp", key: "light_energy", value: 2 }, note: "Brighter lamp." },
  },
  "engine.set_resource_property": {
    title: "Set a property of a node's resource",
    summary:
      "Set a property inside a resource a node holds, such as a collision shape's size or a material's albedo_color, and save the scene. The resource must exist first: assign it with engine.set_prop.",
    effect: "write",
    example: {
      input: { scenePath: MAIN, nodePath: "Floor", resourceProperty: "material_override", subProperty: "albedo_color", value: "Color(0.2, 0.5, 0.2, 1)" },
      note: "Green floor.",
    },
  },
  "engine.remove_node": {
    title: "Remove a node",
    summary:
      "Remove a node and all its children from the scene at scenePath and save it. The root cannot be removed. One undo step. Remove top-level nodes only when the person asked for it.",
    effect: "write",
    example: { input: { scenePath: MAIN, path: "OldLamp" }, note: "Drop a leftover light." },
  },
  "engine.save_scene": {
    title: "Save a scene",
    summary: "Save the scene at scenePath, or save it under a new path. Scene edits already save once; use this for a standalone save or a save-as.",
    effect: "write",
    example: { input: { scenePath: MAIN }, note: "Save after a script that did not save." },
  },
  "engine.open_scene": {
    title: "Open a scene in the editor",
    summary:
      "Open a scene file in the editor and show its tab. A visible tab change for the person, not a target for edits: edits take scenePath. Take paths from engine.get_project_context; never guess them.",
    effect: "write",
    example: { input: { path: "res://levels/level_02.tscn" }, note: "Show the person level 2." },
  },
  "engine.open_main_scene": {
    title: "Open the main scene",
    summary: "Open the project's main scene (from project settings) in the editor, instead of guessing a scene file name.",
    effect: "write",
    example: { input: {}, note: "Nothing is open yet." },
  },
  "engine.instantiate_scene": {
    title: "Add a scene or model as a node",
    summary:
      "Add an existing .tscn, .glb or .gltf as a child node in the scene at scenePath, placed in the same call (position, rotation_degrees, scale or transform). Pass target_size for imported models. Next: engine.screenshot.",
    effect: "write",
    example: {
      input: { scenePath: MAIN, parent: ".", scene: "res://models/barrel.glb", target_size: 1, position: [2, 0, -3] },
      note: "A one-metre barrel by the door.",
    },
  },
  "engine.replace_node": {
    title: "Replace a node",
    summary:
      "Replace a node with another scene or node type, keeping its parent, index, name, transform and children; the saved file is read back to prove it. Next: engine.get_scene_tree.",
    effect: "write",
    example: { input: { scenePath: MAIN, path: "Walls/Wall_03", scene: "res://kit/wall_door.tscn" }, note: "Put a door in a wall." },
  },
  "engine.connect_signal": {
    title: "Connect a signal",
    summary:
      "Connect a signal of one node to a method of another so the saved scene keeps it, verified from the saved .tscn. The receiver should define the method. Then test it with engine.play.",
    effect: "write",
    example: {
      input: { scenePath: "res://ui/menu.tscn", emitter: "Start", signal: "pressed", receiver: ".", method: "_on_start_pressed" },
      note: "Wire the start button.",
    },
  },
  "engine.select_node": {
    title: "Select a node in the editor",
    summary: "Select a node in the editor's scene tree and show it in the inspector, so the person sees it. The scene does not change.",
    effect: "write",
    example: { input: { nodePath: "Player" }, note: "Show the person the player node." },
  },
  "engine.view_set": {
    title: "Show the person a view",
    summary:
      "Switch what the person sees while you work: the view (3d, 2d, script, game, chat, home, studio), the right rail, the node or file in focus and the nodes to frame. Only the screen changes. Which view when: the navigate-summer skill.",
    effect: "write",
    example: { input: { view: "3d", rail: "scene", focus: "Track/Trees", frame: ["Track/Trees"] }, note: "Watch the level while you place trees." },
  },
  "engine.batch": {
    title: "Run engine ops in one call",
    summary:
      "Send a list of raw engine ops (AddNode, SetProp, RunVerification...) in one call: one undo step unless an op must travel alone, and one save at the end. Ask for receipt summary on long lists. For computed edits, engine.run_script is simpler.",
    effect: "write",
    example: {
      input: {
        scenePath: MAIN,
        ops: [
          { op: "AddNode", parent: ".", type: "MeshInstance3D", name: "Floor" },
          { op: "SetProp", path: "Floor", key: "mesh", value: "PlaneMesh" },
        ],
        receipt: "summary",
      },
      note: "A floor in one undo step.",
    },
  },
  "engine.project_setting": {
    title: "Set a project setting",
    summary: "Set one project.godot setting, such as application/run/main_scene, the window size, the renderer or the default gravity.",
    effect: "write",
    example: { input: { key: "application/run/main_scene", value: "res://levels/level_01.tscn" }, note: "Start in level 1." },
  },
  "engine.input_map_bind": {
    title: "Bind input to an action",
    summary: "Create an input action when it is missing and bind keys or mouse buttons to it, for example jump to Space. Then try it with engine.play.",
    effect: "write",
    example: { input: { name: "jump", events: [{ type: "key", key: "Space" }] }, note: "Jump on Space." },
  },
  "engine.enable_plugin": {
    title: "Enable an editor plugin",
    summary:
      "Enable an editor plugin in res://addons/<name>/ and return the real result: enabled with its autoloads, or why it failed. Older engines only queue it (queued true); then check engine.get_debugger_errors.",
    effect: "write",
    example: { input: { plugin: "summer_quests" }, note: "Turn on the quest addon." },
  },
  "engine.write_file": {
    title: "Write a project file",
    summary:
      "Create a text file (create_only true) or overwrite one (expected_sha256 from engine.read_file); exactly one guard is required, so a stale write fails. Scripts, scenes, resources, JSON. Then check scripts with engine.get_script_errors.",
    effect: "write",
    example: { input: { path: "res://scripts/coin.gd", content: "extends Area3D\n", create_only: true }, note: "A new script." },
  },
  "engine.replace_text": {
    title: "Replace text in a project file",
    summary:
      "Replace text in an existing project file. The text must match exactly once unless replace_all is set; the write is guarded by the file's sha256. Then check scripts with engine.get_script_errors.",
    effect: "write",
    example: { input: { path: "res://player.gd", old_text: "const SPEED = 5.0", new_text: "const SPEED = 7.0" }, note: "A faster player." },
  },

  // ── Play, stop, runtime ───────────────────────────────────────────────────
  "engine.play": {
    title: "Play the game",
    summary:
      "Play the game in the editor's real window (agents may; quiet: the editor keeps its tab and focus): main scene or a given one, embedded or a hidden offscreen instance, optional seed and fixed frame rate, or local multiplayer (players). Next: engine.is_running, engine.get_diagnostics.",
    effect: "write",
    example: { input: { instance: "a", mode: "offscreen", deterministic: true, seed: 7 }, note: "A hidden, repeatable test run." },
  },
  "engine.stop": {
    title: "Stop the game",
    summary: "Stop the running game, or one offscreen instance by name. Scene edits stay as they are; nothing is undone or saved.",
    effect: "write",
    example: { input: {}, note: "End the play session." },
  },
  "engine.get_runtime_tree": {
    title: "Read the running game's tree",
    summary:
      "Read the node tree of the RUNNING game: spawned enemies, autoloads and pooled nodes that editor reads never show. Needs a running game. Next: engine.inspect_runtime_node.",
    effect: "read",
    example: { input: { path: "/root/Main/Enemies", depth: 3 }, note: "Which enemies spawned." },
  },
  "engine.inspect_runtime_node": {
    title: "Read a node in the running game",
    summary:
      "Read the live properties of one node in the RUNNING game (transform, visibility, physics state...) without stopping it. Paths are absolute; take them from engine.get_runtime_tree.",
    effect: "read",
    example: { input: { path: "/root/Main/Player" }, note: "Where the player really is." },
  },
  "engine.runtime_set": {
    title: "Set a property in the running game",
    summary:
      "Set one property on a node in the RUNNING game (the live object, never the scene file) and read back whether it applied: move the player, set health, flip a flag. Then check with engine.game_probe.",
    effect: "write",
    example: { input: { path: "/root/Main/Player", property: "position", value: "Vector3(0, 2, 0)" }, note: "Put the player at the start." },
  },
  "engine.runtime_call": {
    title: "Call a method in the running game",
    summary:
      "Call one method on a node in the RUNNING game and return its result, to trigger gameplay code directly. A call is an action, not proof: check what it did with engine.game_probe.",
    effect: "write",
    example: { input: { path: "/root/Main/Player", method: "take_damage", args: [25] }, note: "Hurt the player." },
  },
  "engine.runtime_spawn": {
    title: "Spawn or free in the running game",
    summary:
      "Spawn a scene into the RUNNING game (action spawn) or free a live node (action free) to set up a test. The scene file is not touched. Then check with engine.game_probe.",
    effect: "write",
    example: {
      input: { action: "spawn", parent: "/root/Main/Enemies", scene: "res://enemies/goblin.tscn", props: { position: "Vector3(4, 0, -2)" } },
      note: "One goblin to test combat.",
    },
  },
  "engine.runtime_animate": {
    title: "Drive animation in the running game",
    summary:
      "Read and drive animation in the RUNNING game: AnimationPlayer clips, AnimationTree states and Skeleton3D bone poses. cmd state only reads. Prove motion with two reads around engine.game_control step.",
    effect: "write",
    example: { input: { target: "player", path: "/root/Main/Player/AnimationPlayer", cmd: "state" }, note: "Which clip plays now." },
  },
  "engine.game_control": {
    title: "Control the game clock",
    summary:
      "Pause or resume the RUNNING game, step exactly N frames, set the time scale, or list the live game instances. Step between two engine.game_probe reads for exact checks.",
    effect: "write",
    example: { input: { action: "step", frames: 1 }, note: "Advance one physics frame." },
  },
  "engine.game_input": {
    title: "Send input to the running game",
    summary:
      "Drive the RUNNING game's input: a script of timed actions, keys and clicks, or record real input and replay it on a seeded instance. Input is an action: prove its effect with engine.game_probe.",
    effect: "write",
    example: { input: { action: "script", events: [{ at_frame: 0, type: "action", action: "jump", hold_ms: 50 }] }, note: "Press jump once." },
  },
  "engine.game_probe": {
    title: "Probe the running game",
    summary:
      "Read state and pixels of one frame of the RUNNING game together: the live tree, property values and a screenshot stamped with the same frame numbers. The evidence read of a playtest.",
    effect: "read",
    example: { input: { props: ["/root/Main/Player:position"], screenshot: true }, note: "Before and after a jump." },
  },
  "engine.wait_for_event": {
    title: "Wait for an engine event",
    summary:
      "Wait for an engine event (game started, op applied or failed, script error, scene saved) instead of sleeping; it says so honestly at the timeout. Take a cursor with engine.recent_events first.",
    effect: "read",
    example: { input: { kinds: ["play.started"], since: 120, timeout_seconds: 30 }, note: "Wait for the game to boot." },
  },
  "engine.recent_events": {
    title: "Read recent engine events",
    summary:
      "Read the newest engine events (saves, plays, op results, script errors, imports) at once, and next_seq, the cursor to pass to engine.wait_for_event.",
    effect: "read",
    example: { input: { limit: 20 }, note: "Take a cursor before play." },
  },

  // ── Seeing ────────────────────────────────────────────────────────────────
  "engine.screenshot": {
    title: "Take a screenshot",
    summary:
      "Return a frame as an image you see, to check your work by eye: the editor viewport, an offscreen render of a scene (preset, camera, bookmark or free pose, numbered marks) or the running game. A blank viewport frame means no redraw yet: capture again.",
    effect: "read",
    example: { input: { target: "scene", scenePath: MAIN, framing: "camera" }, note: "The level through its own camera and lights." },
  },
  "engine.frame_nodes": {
    title: "Frame nodes and render them",
    summary:
      "Fit a camera to the world bounds of some nodes and render them with the scene's real environment and lights; bookmark_name also saves the pose. Returns the image and a caption with the pose and bounds.",
    effect: "write",
    example: { input: { scenePath: MAIN, nodes: ["House1"], direction: "front", bookmark_name: "house_front" }, note: "The house, front on." },
  },
  "engine.shot_sheet": {
    title: "Render a sheet of views",
    summary:
      "Render several bookmarks or poses into one labelled grid with real lighting, and compare each bookmark with its last render (difference map). The quick look at every hero view after a change.",
    effect: "read",
    example: {
      input: { scenePath: MAIN, shots: [{ bookmark_name: "house_front" }, { bookmark_name: "street" }], compare_previous: true },
      note: "Before and after a lighting change.",
    },
  },
  "engine.debug_views": {
    title: "Render debug views of a pose",
    summary:
      "Render one pose as a grid of debug views next to the beauty pass: lighting only, albedo, world normals, overdraw and wireframe. Shows why a shot looks wrong.",
    effect: "read",
    example: { input: { scenePath: MAIN, bookmark_name: "street" }, note: "Why the street looks flat." },
  },
  "engine.zoom": {
    title: "Zoom into part of a frame",
    summary: "Render a close-up of part of a frame (a region, or mark N of a marks render) at full resolution: real detail, seams and gaps, not enlarged pixels.",
    effect: "read",
    example: { input: { scenePath: MAIN, bookmark_name: "street", region: [0.4, 0.5, 0.2, 0.2] }, note: "The gap by the door." },
  },
  "engine.frame_shot": {
    title: "Find camera poses for a shot",
    summary:
      "Find, score and save camera poses for a shot type (establishing, eye level, low angle, detail, corridor), tested against the real geometry in the open editor. Returns the best 3 poses and a sheet to look at, and saves the best as a bookmark.",
    effect: "write",
    example: { input: { scenePath: MAIN, shot: "establishing", subject: ["Town"] }, note: "A wide shot of the town." },
  },
  "engine.scene_audit": {
    title: "Audit a 3D scene",
    summary:
      "Check a saved 3D scene for visual and placement problems: holes, exposed edges, floor gaps, floating or sunken props, overlaps, z-fighting, light limits. Returns issues by severity, each with the next tool. Changes nothing.",
    effect: "read",
    example: { input: { scenePath: MAIN, min_severity: "warn" }, note: "What looks broken in the level." },
  },
  "engine.capture_gameplay": {
    title: "Capture gameplay screenshots",
    summary:
      "Capture real gameplay frames (HUD included) from a hidden game window, no editor needed; game flags and player steps get past the title screen. Returns each frame's path and size: look at them before use.",
    effect: "read",
    example: { input: { resolution: "1920x1080", frames: 3, steps: [{ press: "Play" }, { wait: 3000 }, { shot: true }] }, note: "Store screenshots." },
  },

  // ── Placement ─────────────────────────────────────────────────────────────
  "engine.test_placement": {
    title: "Test a placement without moving",
    summary:
      "Test one 3D node at a candidate world position and rotation without moving it: overlaps, grounded state and the gap to the floor. Changes nothing. Then place it with engine.set_prop or engine.snap_to_surface.",
    effect: "read",
    example: {
      input: { scenePath: MAIN, subjectPath: "Props/Vase", candidateGlobalPosition: [1, 0.9, -2], candidateGlobalRotationDegrees: [0, 0, 0] },
      note: "Does the vase fit on the shelf?",
    },
  },
  "engine.snap_to_surface": {
    title: "Snap a node onto a surface",
    summary:
      "Move one 3D node along a ray until it sits at the given gap on the first surface (floor, ramp, shelf, table), then save the scene. Returns before and after transforms and the evidence.",
    effect: "write",
    example: { input: { scenePath: MAIN, subjectPath: "Props/Crate_02" }, note: "Seat a floating crate on the floor." },
  },
  "engine.align_distribute_3d": {
    title: "Align or space 3D nodes",
    summary:
      "Align 2 to 16 3D nodes on one world axis (min, center, max) or space them equally (centers or gaps) from their visible bounds, then save the scene. One undo step.",
    effect: "write",
    example: { input: { scenePath: MAIN, subjectPaths: ["Lamp1", "Lamp2", "Lamp3"], axis: [1, 0, 0], mode: "distribute_centers" }, note: "Even lamp spacing." },
  },
  "engine.place_adjacent": {
    title: "Place a node against another",
    summary:
      "Move one node so its bounds face sits against another node's, lining up the other axes: modules edge to edge, storeys stacked. Saves the scene and verifies the gap.",
    effect: "write",
    example: { input: { scenePath: MAIN, subject: "Facade/Module_2", reference: "Facade/Module_1", axis: "x", side: "max" }, note: "Next module to the right." },
  },
  "engine.attach_to_surface": {
    title: "Mount a piece on a surface",
    summary:
      "Turn a piece so its measured back faces a wall, ceiling or floor found by a ray, keep it upright and seat it at a standoff: pipes, lamps, signs. Saves the scene; a refused seat puts the piece back.",
    effect: "write",
    example: { input: { scenePath: MAIN, subject: "Props/Sign", surface: "Walls/Wall_01", backAxis: "-z" }, note: "Hang the sign on the wall." },
  },
  "engine.repeat_along": {
    title: "Repeat a scene along a line",
    summary:
      "Place copies of one scene along a line in one call: fence posts, clamps, a row of windows (at most 64). Returns the created node paths and saves the scene once.",
    effect: "write",
    example: {
      input: { scenePath: MAIN, template: "res://kit/fence_post.tscn", parent: "Fence", start: [0, 0, 0], end: [10, 0, 0], spacing: 2 },
      note: "Six fence posts.",
    },
  },
  "engine.connect_ports": {
    title: "Join two pieces at their ports",
    summary:
      "Move and turn one piece so its port (a Marker3D, or an open pipe end such as +Y) meets another piece's port: pipe to pipe, duct to duct. Refuses joins that tilt the piece. Saves the scene.",
    effect: "write",
    example: { input: { scenePath: MAIN, subject: "Pipes/Bend_1", subjectPort: "-Y", target: "Pipes/Run_1", targetPort: "+Y" }, note: "A bend on top of a pipe." },
  },
  "engine.raycast": {
    title: "Cast a ray in a scene",
    summary: "Cast one ray from any point in a scene: the node it hits, the point and the normal. Physics first, visible bounds as a declared fallback. Changes nothing.",
    effect: "read",
    example: { input: { scenePath: MAIN, origin: [0, 2, 0], direction: [0, 0, -1] }, note: "How far is the wall?" },
  },
  "engine.measure": {
    title: "Measure between nodes",
    summary:
      "Measure the gap or overlap on each axis between two placed nodes, or check that one face of many nodes lies on one plane. Finds facade gaps and modules that stand out. Changes nothing.",
    effect: "read",
    example: { input: { scenePath: MAIN, mode: "pair", a: "Facade/Module_1", b: "Facade/Module_2" }, note: "Is there a gap between modules?" },
  },
  "engine.starcast": {
    title: "Read the space around a node",
    summary:
      "Read the clearance around one 3D node in 26 directions: what blocks each side and how far, contact, grounding and nearby objects. Changes nothing. Use it before and after placing.",
    effect: "read",
    example: { input: { scenePath: MAIN, path: "Props/Table" }, note: "What is the table touching?" },
  },
  "engine.navigation_probe": {
    title: "Check a navigation route",
    summary:
      "Check whether two world points are connected on the scene's navigation map: readiness, snapped end points, route length and route points. ready false means no evidence, not no route.",
    effect: "read",
    example: { input: { scenePath: MAIN, start: [0, 0, 0], end: [20, 0, 15] }, note: "Can enemies reach the gate?" },
  },

  // ── Imports and assets ────────────────────────────────────────────────────
  "engine.import_from_url": {
    title: "Import a file from a URL",
    summary: "Download one file (model, texture, audio) from a URL into the project and run the import, so it is ready to use. For a model, next: engine.instantiate_scene.",
    effect: "write",
    example: { input: { url: "https://example.com/models/lamp.glb", path: "res://models/lamp.glb" }, note: "A lamp model." },
  },
  "engine.import_from_url_batch": {
    title: "Import files from URLs",
    summary: "Download several files from URLs into the project in one call, with one import scan at the end.",
    effect: "write",
    example: {
      input: {
        imports: [
          { url: "https://example.com/a.png", path: "res://textures/a.png" },
          { url: "https://example.com/b.png", path: "res://textures/b.png" },
        ],
      },
      note: "Two textures.",
    },
  },
  "engine.import_asset": {
    title: "Find and import a Summer asset",
    summary:
      "Search the Summer asset library, import the best match into the project and, for a 3D model, add it to a scene. Needs the Summer sign-in. For an exact asset use engine.import_asset_by_id.",
    effect: "write",
    auth: "account",
    example: { input: { query: "wooden barrel", parent: ".", scenePath: MAIN }, note: "A barrel in the level." },
  },
  "engine.import_asset_by_id": {
    title: "Import a Summer asset by id",
    summary:
      "Import one Summer asset by its id (from a search, the person's assets or a generation) into the project; a 3D model can go straight into the scene at scenePath. Needs the Summer sign-in.",
    effect: "write",
    auth: "account",
    example: { input: { assetId: "a_8f2c", parent: ".", scenePath: MAIN }, note: "The model just generated." },
  },
  "engine.import_hdri": {
    title: "Import an HDRI sky",
    summary:
      "Find a CC0 HDRI sky on Poly Haven (or take an exact id) and import it into res://sky/ for environment light. Returns a ready engine.run_script snippet that wires it into the WorldEnvironment.",
    effect: "write",
    example: { input: { query: "sunset beach", resolution: "2k" }, note: "A warm evening sky." },
  },
  "engine.fabricate_3d": {
    title: "Make a mesh with Blender",
    summary:
      "Make a mesh with a bpy script in the person's own Blender (4.2 or newer, headless), import the .glb into the project and optionally place it. For exact modular kits and effect meshes, not characters or props.",
    effect: "write",
    example: {
      input: { name: "pipe_straight", source: "import bpy\nbpy.ops.mesh.primitive_cylinder_add(radius=0.1, depth=2)\n" },
      note: "A straight pipe piece.",
    },
  },

  // ── Export and support ────────────────────────────────────────────────────
  "engine.export_game": {
    title: "Export the game",
    summary:
      "Export the game headless as the file the Summer Games store takes: a bundle for iPhone, Android, macOS and Windows, a web build or a desktop download. Returns path, sha256 and size. Upload it with store.upload_file.",
    effect: "write",
    example: { input: { format: "bundle", targets: ["ios", "android"] }, note: "A phone bundle for the store." },
  },
  "engine.export_templates": {
    title: "List or install export templates",
    summary:
      "List or install Summer Engine export templates (web, macOS, Windows) from Summer's CDN, each sha256-checked. Needed only for engine.export_game with format download.",
    effect: "write",
    example: { input: { action: "install", platforms: ["web"] }, note: "Before a web export." },
  },
  "engine.create_debug_report": {
    title: "Write a debug report",
    summary:
      "Write a support-ready Markdown report: doctor checks, engine health, diagnostics, console and debugger output, and a hand-off prompt. No tokens or file contents; the person should still read it before sending it.",
    effect: "write",
    example: { input: { issue: "The player falls through the floor after the first jump." }, note: "For a bug report." },
  },

  // ── Editor UI ─────────────────────────────────────────────────────────────
  "engine.ui_tree": {
    title: "Read the editor UI",
    summary:
      "Read the live editor UI as a tree (controls, paths, text, state), or every visible dialog and whether one blocks input. Its paths are what engine.ui_activate takes.",
    effect: "read",
    example: { input: { root: "dialogs" }, note: "Is a dialog in the way?" },
  },
  "engine.ui_activate": {
    title: "Use an editor control",
    summary:
      "Use one editor control by its tree path (press, toggle, focus, select a tab, type text, set a value) or dismiss a dialog; the control's state is read back. Only when no named action fits.",
    effect: "write",
    example: { input: { action: "select_tab", path: "main_screen", value: "3D" }, note: "Switch to the 3D view." },
  },
  "engine.ui_screenshot": {
    title: "Screenshot the editor UI",
    summary:
      "Return an image of the editor window, or of one dock, dialog or control: the last resort to look at the UI, never to pick click points. For scene views use engine.screenshot.",
    effect: "read",
    example: { input: { root: "dock:inspector" }, note: "What the inspector shows." },
  },
};

export const ENGINE_SPLIT_OPS: Readonly<Record<string, EngineSplitDef>> = {
  "engine.list_camera_bookmarks": {
    title: "List camera bookmarks",
    summary:
      "List the camera viewpoints saved in this project: names, poses and dates. A bookmark gives screenshots that line up before and after a change: engine.screenshot with framing bookmark.",
    effect: "read",
    tool: "summer_camera_bookmark",
    fixed: { action: "list" },
    fields: [],
    example: { input: {}, note: "Which views are saved?" },
  },
  "engine.save_camera_bookmark": {
    title: "Save a camera bookmark",
    summary:
      "Save a named camera viewpoint in the project (res://.summer/camera_bookmarks.json): position and look_at as Vector3 literals, or neither to take the editor's 3D camera. The scene file is not touched. Next: engine.screenshot.",
    effect: "write",
    tool: "summer_camera_bookmark",
    fixed: { action: "save" },
    fields: ["name", "position", "look_at", "fov"],
    required: ["name"],
    example: { input: { name: "hero_closeup", position: "Vector3(0, 2, 6)", look_at: "Vector3(0, 1, 0)" }, note: "A close-up to compare against." },
  },
  "engine.delete_camera_bookmark": {
    title: "Delete a camera bookmark",
    summary: "Delete one saved camera viewpoint by name. Returns the names that remain.",
    effect: "write",
    tool: "summer_camera_bookmark",
    fixed: { action: "delete" },
    fields: ["name"],
    required: ["name"],
    example: { input: { name: "old_view" }, note: "Drop a view nobody uses." },
  },
  "engine.list_ui_actions": {
    title: "List editor actions",
    summary:
      "List the editor's named actions (menu items and shortcuts) with labels and shortcuts, filtered by text. Actions marked denied are refused. Next: engine.invoke_ui_action.",
    effect: "read",
    tool: "summer_ui_actions",
    fixed: { mode: "list" },
    fields: ["filter", "limit"],
    example: { input: { filter: "project_settings" }, note: "Find the Project Settings action." },
  },
  "engine.invoke_ui_action": {
    title: "Run an editor action",
    summary:
      "Run one named editor action exactly as its menu item or shortcut would: open Project Settings, switch the main screen, toggle a panel. Editor work only; scene work is engine.run_script. Read the effect back with engine.ui_tree.",
    effect: "write",
    tool: "summer_ui_actions",
    fixed: { mode: "invoke" },
    fields: ["action_name"],
    required: ["action_name"],
    example: { input: { action_name: "editor/project_settings" }, note: "Open Project Settings." },
  },
};

/** The catalog fields of an engine operation, split or not; null for anything else. */
export function engineOpDef(op: string): EngineOpDef | EngineSplitDef | null {
  return ENGINE_OPS[op] ?? ENGINE_SPLIT_OPS[op] ?? null;
}

export function isSplitOp(op: string): boolean {
  return Object.hasOwn(ENGINE_SPLIT_OPS, op);
}

/** A split operation's input as its 3.x tool takes it: only its fields, plus its fixed action. */
export function splitToolArgs(def: EngineSplitDef, input: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const field of def.fields) if (input[field] !== undefined) args[field] = input[field];
  return { ...args, ...def.fixed };
}

/** A split operation's input JSON Schema, cut from its 3.x tool's schema. */
export function splitInputSchema(def: EngineSplitDef, toolSchema: Record<string, unknown> | null): Record<string, unknown> {
  const properties = ((toolSchema?.properties ?? {}) as Record<string, unknown>);
  return {
    type: "object",
    properties: Object.fromEntries(def.fields.filter((field) => field in properties).map((field) => [field, properties[field]])),
    ...(def.required?.length ? { required: [...def.required] } : {}),
    additionalProperties: false,
  };
}

const OP_REF = /\b(engine|docs|store|projects)\.[a-z][a-z0-9_]*\b/g;

/** Every operation a summary names (`engine.snapshot_diff`, `docs.read`). */
export function opsNamedIn(text: string): string[] {
  return [...new Set(text.match(OP_REF) ?? [])];
}

/** A summary with each operation it names written as the tool that runs it in this view. */
export function renderOpRefs(text: string, toolOf: (op: string) => string | undefined): string {
  return text.replace(OP_REF, (op) => toolOf(op) ?? op);
}
