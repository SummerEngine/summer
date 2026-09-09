---
name: character-animation-wiring
description: Use when a rigged, animated character is in the scene (Meshy rig + generated clips, or an imported GLB) and needs to be wired end to end — inspect the clips and bones that actually arrived, build idle/walk/run locomotion with blend times, method-track footsteps and attack frames, still poses and head tracking, blend-shape facial keys, root motion. Trigger on "wire the character", "hook up the animations", "make it walk around", "the GLB has animations", "footstep events", "attack frame", "root motion", "character slides while walking".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: animation
user-invocable: false
allowed-tools: Read Grep Edit Write summer_run_script summer_api_docs summer_get_scene_tree summer_inspect_node summer_world_snapshot summer_snapshot_diff summer_screenshot summer_play summer_stop summer_get_runtime_tree summer_inspect_runtime_node summer_save_scene summer_get_script_errors
paths: ["**/*.gd", "**/*.tscn", "**/*.glb"]
---

# Character Animation Wiring — Rigged GLB to Living Character

The game-critical path: a rigged, animated character lands in the scene — from `summer_generate_3d({options:{rig:true}})` + `summer_generate_motion`, or an imported GLB — and nothing moves yet. This skill wires it end to end: inspect what actually arrived, build locomotion, fire gameplay events off animation frames, add poses and head tracking, key the face, and handle root motion. Then **prove it in a playtest** — a wired tree that was never played is a claim, not a result.

Two lanes throughout:

- **ctx lane (Wave G engines):** the Wave G ctx helpers on `summer_run_script` — `anim_state_machine`, `animate_method`, `bone_pose`, `look_at_modifier`, plus the `animate()` v2 extensions. One script per step, owner handled, failures come back as report entries.
- **raw lane (any engine):** the same wiring through plain GDScript in `summer_run_script` — the Animation/AnimationTree classes are fully script-bound, just verbose. On an older engine a missing ctx helper is a plain `Invalid call to method ...` script error; fall back to the raw lane, which works everywhere.

Frozen Wave G signatures (see `scene-scripting` for the full stdlib):

```gdscript
anim_state_machine(target: Node, spec: Dictionary, player: AnimationPlayer = null) -> AnimationTree
    # spec: { states: {name: clip_name}, transitions: [[from, to, {auto?: bool,
    #   blend_s?: float}], ...], start: name }
animate_method(node: Node, calls: Array, anim_name: String = "",
               loop: bool = false, player: AnimationPlayer = null) -> AnimationPlayer
    # calls: [[time_s, method_name, args_array], ...] -> one method-call track
bone_pose(skeleton: Node, bone: String, pose: Dictionary) -> bool
    # pose keys position/rotation/scale; unknown bone -> false + report listing bone names
look_at_modifier(node: Node, target: Node, props: Dictionary = {}) -> Node
    # LookAtModifier3D under the skeleton/node, owned
animate(...) v2: keys entries also accept {time, value, interpolation: "nearest"|"linear"|"cubic"};
    # property may target bones ("<skeleton_node>:<bone_name>/position|rotation|scale")
    # and blend shapes ("blend_shapes/<name>")
```

## When to use this skill

- A rigged GLB with clips is instanced and the character T-poses or slides.
- "Make the goblin idle, walk when moving, run when sprinting."
- Footstep sounds / attack hit-frames need to fire at exact animation times.
- A corpse/statue/mannequin needs a still pose; an NPC head should track the player.
- The character visibly moonwalks — the clip translates the root but the body stays put (root motion).

## When NOT to use this skill

- No clips yet — generate first via `generate-motion` (rigged Meshy target) or import them.
- Continuous walk↔run blending by speed, upper-body attack overlays, OneShot hit reactions — that graph design lives in `animation-tree`; this skill's state machine is the discrete idle/walk/run backbone.
- Foot IK, additive lean, ragdoll — `procedural-animation`.
- Full viseme lipsync from audio — `facial-and-lipsync` (this skill covers the blend-shape keying mechanism it builds on).

## Step 1 — Inspect what actually came in

Never wire against assumed clip names or bone names. Imports differ: the AnimationPlayer may be nested inside the instance, clips may be namespaced (`walk` vs `Walking_Woman` vs `mixamo_com`), bone names vary by rig source. The instance's internals are not owned by the edited scene, so pass `owned: false` when searching:

```gdscript
func run(ctx):
    var character = ctx.find("Goblin")
    if character == null:
        ctx.report("error", "Goblin not found — check summer_get_scene_tree")
        return
    for p in character.find_children("*", "AnimationPlayer", true, false):
        ctx.report("player:" + str(character.get_path_to(p)), p.get_animation_list())
    for s in character.find_children("*", "Skeleton3D", true, false):
        var bones := []
        for i in s.get_bone_count():
            bones.append(s.get_bone_name(i))
        ctx.report("skeleton:" + str(character.get_path_to(s)), bones)
    for m in character.find_children("*", "MeshInstance3D", true, false):
        if m.mesh and m.mesh.get_blend_shape_count() > 0:
            var shapes := []
            for i in m.mesh.get_blend_shape_count():
                shapes.append(m.mesh.get_blend_shape_name(i))
            ctx.report("blend_shapes:" + str(character.get_path_to(m)), shapes)
```

Read the reports. Every later step quotes these exact strings. If the clip list is empty, the GLB imported without animations (or they landed as a separate AnimationLibrary asset) — route back to `generate-motion` / `retarget` before wiring anything.

## Step 2 — Locomotion state machine (ctx lane)

`ctx.anim_state_machine` gets-or-creates the AnimationTree, wires it to the found (or given) AnimationPlayer, builds the AnimationNodeStateMachine, and sets `active = true`:

```gdscript
func run(ctx):
    var character = ctx.find("Goblin")
    var tree := ctx.anim_state_machine(character, {
        "states": {"idle": "idle", "walk": "walk", "run": "run"},
        "transitions": [
            ["idle", "walk", {"blend_s": 0.2}],
            ["walk", "idle", {"blend_s": 0.2}],
            ["walk", "run",  {"blend_s": 0.15}],
            ["run",  "walk", {"blend_s": 0.15}],
        ],
        "start": "idle",
    })
    if tree == null:
        return          # the report names the failure — read it
    ctx.report("tree", str(tree.get_path()))
```

State names are yours; **clip names must be the exact strings from Step 1**. An unknown clip name produces a report entry listing the player's actual clips — never silent. Fix the spelling from that list; do not guess again.

Drive it from the controller script (host-edits the `.gd`):

```gdscript
@onready var tree: AnimationTree = $AnimationTree
@onready var sm: AnimationNodeStateMachinePlayback = tree["parameters/playback"]

func _physics_process(_delta: float) -> void:
    var speed := Vector2(velocity.x, velocity.z).length()
    if speed < 0.1: sm.travel("idle")
    elif speed < 4.0: sm.travel("walk")
    else: sm.travel("run")
```

Thresholded `travel()` is the discrete backbone. When the user wants a continuous speed blend or attack/hit overlays, extend the tree per `animation-tree` — those node types are beyond the `anim_state_machine` spec dict.

## Step 3 — Method tracks: footsteps and attack frames

Gameplay events that must land on an animation frame (footstep audio at heel-strike, damage at the blade's contact frame) belong in a method-call track, not a timer:

```gdscript
func run(ctx):
    var character = ctx.find("Goblin")
    ctx.animate_method(character, [
        [0.32, "play_footstep", []],
        [0.84, "play_footstep", []],
    ], "walk_events", true)          # loop matches the walk clip's loop
    ctx.animate_method(character, [
        [0.45, "deal_attack_damage", [25]],
    ], "attack_events")
```

The methods must exist on the target node's script — write them there first and check with `summer_get_script_errors`. Play the event clip alongside its motion clip (same timings) from the same tree. **Method tracks fire during playback in the running game; a successful script result proves the track exists, not that the method fires** — verification is a playtest where the footstep actually sounds.

## Step 4 — Still poses and head tracking

A corpse over a railing, a statue mid-swing, a mannequin — edit-time poses, no clip needed:

```gdscript
func run(ctx):
    var skel = ctx.find("Goblin").find_children("*", "Skeleton3D", true, false)[0]
    if not ctx.bone_pose(skel, "RightArm", {"rotation": Quaternion(Vector3.FORWARD, 1.2)}):
        return          # false -> the report lists the skeleton's real bone names (capped 64)
    ctx.bone_pose(skel, "Head", {"rotation": Quaternion(Vector3.RIGHT, -0.4)})
```

Head tracking — one call creates the owned `LookAtModifier3D` under the skeleton:

```gdscript
    var mod := ctx.look_at_modifier(skel, ctx.find("Player"), {"bone_name": "Head"})
```

Unknown props land in `prop_warnings` — read them. Angle limits, influence fade-out by distance, and spine-chain distribution are the difference between alive and possessed: tune per `procedural-animation` (A1/A2).

## Step 5 — Facial keys via blend shapes

`animate()` accepts `"blend_shapes/<name>"` property paths (value tracks, weights 0..1) against the MeshInstance3D that owns the shapes — names come from Step 1's report:

```gdscript
func run(ctx):
    var head = ctx.find("Goblin").find_children("*", "MeshInstance3D", true, false)[0]
    ctx.animate(head, "blend_shapes/jawOpen", [
        {"time": 0.0, "value": 0.0, "interpolation": "linear"},
        {"time": 0.15, "value": 1.0},
        {"time": 0.4, "value": 0.0},
    ], "roar")
    ctx.animate(head, "blend_shapes/browDown_L", [[0.0, 0.0], [0.2, 1.0]], "roar")  # same clip — track appended
```

That is the mechanism; a full audio-synced viseme timeline is `facial-and-lipsync`. Bone-track keyframes work the same way through `animate()` v2 — `ctx.animate(character, "Skeleton3D:Head/rotation", keys, "nod")` creates a proper bone rotation track (the helper owns the quaternion conversion; never hand-build quaternion tracks).

## Step 6 — Root motion, honestly

Meshy/mocap locomotion clips translate the root bone forward (Meshy `run` moves ~5m per cycle). Two valid setups — **pick one, never both**:

1. **In-place movement (default):** code drives `velocity`, the clip should NOT translate the root. If the character lunges forward and snaps back every loop, the clip has baked root translation — strip it or switch to setup 2.
2. **Root motion:** the clip drives movement. Requires, on the AnimationTree: `root_motion_track` set to the root bone's track path (e.g. `"Skeleton3D:Hips"` — the skeleton node path from Step 1, colon, the root bone name), then in `_physics_process` apply `tree.get_root_motion_position()` / `get_root_motion_rotation()` to the CharacterBody3D instead of input-driven velocity. A `RootMotionView` node visualizes the extracted motion in the editor (editor-only helper; it is invisible in the shipped game).

Symptoms map: sliding feet = setup 1 with speed thresholds mismatched to the clip's stride; lunge-and-snap = baked root translation under setup 1; character animates but never moves = setup 2 without the `get_root_motion_*` application code.

Root motion CANNOT be judged from the editor state. Playtest it: `summer_play`, then `summer_get_runtime_tree` + `summer_inspect_runtime_node` on the character — its live `global_position` must advance while walking — plus `summer_screenshot target:"game"` for the pixels. Claim only what those reads show.

## Raw lane — the same wiring on older engines

Every class above is script-bound; `ctx.anim_state_machine` is convenience, not capability. The raw locomotion wiring, verbatim the calls that matter:

```gdscript
func run(ctx):
    var character = ctx.get_scene_root().find_child("Goblin", true, false)
    var player: AnimationPlayer = character.find_children("*", "AnimationPlayer", true, false)[0]

    var sm := AnimationNodeStateMachine.new()
    for clip in ["idle", "walk", "run"]:          # exact names from Step 1
        var anim_node := AnimationNodeAnimation.new()
        anim_node.animation = clip
        sm.add_node(clip, anim_node)
    for pair in [["idle", "walk", 0.2], ["walk", "idle", 0.2], ["walk", "run", 0.15], ["run", "walk", 0.15]]:
        var t := AnimationNodeStateMachineTransition.new()   # one resource PER transition
        t.xfade_time = pair[2]
        sm.add_transition(pair[0], pair[1], t)

    var tree := AnimationTree.new()
    tree.name = "AnimationTree"
    character.add_child(tree)
    ctx.set_owner_recursive(tree)                 # BEFORE save, or it vanishes
    tree.anim_player = tree.get_path_to(player)   # relative NodePath
    tree.tree_root = sm
    tree.active = true
    ctx.report("tree", str(tree.get_path()))
```

Method tracks raw: `anim.add_track(Animation.TYPE_METHOD)` + `track_set_path(idx, path_to_node)` + `track_insert_key(idx, t, {"method": "play_footstep", "args": []})`, then `player.get_animation_library("").add_animation(name, anim)` (get-or-create the library — `add_animation_library("", AnimationLibrary.new())` when missing; this library step is the one agents get wrong). Still poses raw: `skel.set_bone_pose_rotation(skel.find_bone("Head"), quat)`. Verify unfamiliar members with `summer_api_docs` first — never guess.

## The verification loop (every step)

1. `summer_world_snapshot` before; keep the `snapshot_id`.
2. Run the script; read `errors`, `reports`, `prop_warnings`, `rolled_back`.
3. `summer_snapshot_diff from_id:<id>` — exactly the nodes you meant (AnimationTree added, nothing vanished).
4. `summer_save_scene`, then behavior: `summer_play` → `summer_get_runtime_tree` / `summer_inspect_runtime_node` for live state, `summer_screenshot target:"game"` for pixels → `summer_stop`.
5. Claim only what the capture and the runtime reads show. "The script succeeded" is not "the character walks." Full discipline: `verifying-scenes`.

## Red Flags — STOP

| Red flag | Reality |
|---|---|
| Wiring clip names you never read from the engine | Step 1 exists because imports rename things. Inspect, then quote. |
| `find_children(...)` returns nothing inside the instance | You left `owned` at its default `true`. Instance internals are unowned — pass `false`. |
| Retrying `anim_state_machine` with another guessed clip name | The failure report lists the player's actual clips. Use one of those. |
| Timer-based footsteps/damage synced "by eye" | Method tracks are frame-accurate and survive clip retimes. |
| `set_bone_pose_*` every frame from `_process` for tracking | That fights the tree. Runtime tracking is `look_at_modifier` / modifiers; `bone_pose` is for edit-time stills. |
| Root motion AND input velocity applied together | Double movement. Pick one lane (Step 6). |
| Raw lane: `add_child` without `ctx.set_owner_recursive(tree)` | The saved scene silently loses the AnimationTree. |
| "Locomotion works" without a playtest | Run it. Read the runtime tree. Look at the frame. Silence is not evidence. |

## Handoff

- Blend spaces, OneShot attacks/hit-reacts, upper-body filters — `animation-tree`.
- Foot IK, additive lean, ragdoll — `procedural-animation`.
- Audio-synced lipsync on the blend shapes — `facial-and-lipsync`.
- Clips missing or on the wrong rig — `generate-motion`, `retarget`.
- NPC behavior deciding when to travel/fire states — `design-npc`.

## See also

- `scene-scripting` — the ctx stdlib contract, owner rules, budgets, undo/rollback.
- `verifying-scenes` — snapshot/diff/screenshot/runtime-read discipline this skill leans on.
