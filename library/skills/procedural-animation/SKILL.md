---
name: procedural-animation
description: Use when the user needs runtime-driven bone modification on top of clips — head look-at, foot IK on uneven ground, hand-grabs-prop, additive lean, hit-direction recoil. Code-and-modifier patterns, not generation. Trigger on "look at", "IK", "foot placement", "foot IK", "lean", "additive layer", "feet floating", "hand penetration", "head tracks player", "ragdoll".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: animation
user-invocable: false
allowed-tools: Read Grep Edit Write summer_get_scene_tree summer_inspect_node summer_inspect_resource summer_run_script summer_add_node summer_set_prop summer_set_resource_property summer_save_scene summer_get_script_errors
paths: ["**/*.gd", "**/*.tscn", "**/*.tres"]
---

# Procedural Animation — Bones Driven by Code

Generated clips give you 80% of a character. The remaining 20% — the eye contact when an NPC speaks, feet that plant on slopes, hands that wrap a sword grip, the lean into a sprint, the recoil from a hit on the left shoulder — is procedural. In Summer Engine this is done via the `SkeletonModifier3D` family attached to the `Skeleton3D`, plus tween-driven additive blend layers on the `AnimationTree`. None of it is generative; this skill is a recipe set.

Honest limit: Summer Engine's current IK is good enough for look-at, foot-snap,
and simple two-bone arm/leg chains. It is not a full-body IK system with weight
redistribution. For combat-grappling or contact-heavy interactions, hand-author
the contact frame and accept some clipping.

## When to use this skill

- Feet clip into / float over uneven terrain.
- NPC head doesn't track the player during conversation — feels dead-eyed.
- Character's hand doesn't actually hold the sword — pen-through.
- Body doesn't lean into turns / aiming.
- Hit reactions need to come from the hit *direction* (recoil left when struck left), not just one canned animation.
- Ragdoll on death.

## When NOT to use this skill

- The clip already covers it. Don't IK what mocap already nailed — adds CPU cost and rounding error.
- The character is far from the camera (LOD2+). Procedural cost outpaces visual benefit. Disable modifiers past 15m.
- You need facial animation. That's `facial-and-lipsync`.
- You haven't generated base clips yet. Skeleton modifiers compose ON TOP of clips; without a base pose they'll stack on T-pose and look wrong.

## The three patterns

Almost every procedural request maps to one of these three. Pick the right one before writing code.

### Pattern A — SkeletonModifier3D (post-clip bone overrides)

Attached as a child of `Skeleton3D`. Runs after the AnimationTree writes the pose, modifies specific bones in-place. Includes `LookAtModifier3D`, `SkeletonIK3D` (legacy, still supported), and the new (4.4+) `LookAtModifier3D` chain. Cheap, deterministic, no animation graph dependency.

### Pattern B — Additive AnimationNodeAdd2 layer in the tree

A clip recorded as a *delta from base pose* (e.g., a "lean left" clip that's 0 at center, fully leaned at +1) added on top of locomotion. Driven by writing `parameters/Add/blend_amount` from script. Use for stylistic overlays — turning lean, aiming offset, breathing.

### Pattern C — PhysicalBoneSimulator3D (ragdoll)

The skeleton hands off to physics on death. Bones become `PhysicalBone3D` rigid bodies that fall under gravity and collide with the world. One-way: once ragdoll fires, you can't easily blend back to clip-driven without snapping.

## Pattern A recipes

### A1 — Head look-at the player

The bread-and-butter NPC liveliness fix.

**ctx lane (Wave G engines):** one `summer_run_script` call creates the owned modifier and sets the props — prefer it over the 10-call CRUD chain below:

```gdscript
func run(ctx):
    var skel = ctx.find("NPC").find_children("*", "Skeleton3D", true, false)[0]
    var mod := ctx.look_at_modifier(skel, ctx.find("Player"), {
        "bone_name": "Head", "forward_axis": 2, "primary_rotation_axis": 1,
        "use_secondary_rotation": true, "use_angle_limitation": true,
        "symmetry_limitation": true, "primary_limit_angle": 1.4, "secondary_limit_angle": 1.0,
    })
```

Unknown prop names land in the `prop_warnings` report entry instead of failing silently — read it. On an older engine the helper is a plain script error; fall back to the structured ops:

```
summer_inspect_node "./World/NPC/Skeleton3D"   # confirm bone names
summer_add_node parent="./World/NPC/Skeleton3D" type="LookAtModifier3D" name="HeadLookAt"
summer_set_prop "./World/NPC/Skeleton3D/HeadLookAt" key="bone_name" value="Head"
summer_set_prop "./World/NPC/Skeleton3D/HeadLookAt" key="forward_axis" value=2   # +Z forward (Meshy default)
summer_set_prop "./World/NPC/Skeleton3D/HeadLookAt" key="primary_rotation_axis" value=1   # Y-up
summer_set_prop "./World/NPC/Skeleton3D/HeadLookAt" key="use_secondary_rotation" value=true
summer_set_prop "./World/NPC/Skeleton3D/HeadLookAt" key="use_angle_limitation" value=true    # OFF by default — nothing clamps until you set this
summer_set_prop "./World/NPC/Skeleton3D/HeadLookAt" key="symmetry_limitation" value=true     # one angle drives both directions
summer_set_prop "./World/NPC/Skeleton3D/HeadLookAt" key="primary_limit_angle" value=1.4      # ~80°, prevents the Exorcist
summer_set_prop "./World/NPC/Skeleton3D/HeadLookAt" key="secondary_limit_angle" value=1.0
```

Every `summer_set_prop` above also needs the required `scenePath` (e.g.
`scenePath="res://main.tscn"`); the paths are shown bare here for readability.

There is no `symmetry_limit` and no `secondary_rotation_axis` property on
`LookAtModifier3D` — the real names are the ones above, and the secondary
rotation axis is derived, not set. Confirmed against the shipped 4.6.1 binary;
`ClassDB.class_get_property_list("LookAtModifier3D")` is the check if you're
unsure of a name.

Drive the target each frame:

```gdscript
@onready var head_look: LookAtModifier3D = $Skeleton3D/HeadLookAt

func _process(_delta: float) -> void:
    var player := get_tree().get_first_node_in_group("player")
    if player == null:
        head_look.influence = 0.0
        return
    var to_player := player.global_position - global_position
    var dist := to_player.length()
    # Disable look-at past 8m — feels uncanny at long range.
    head_look.target_node = player.get_path() if dist < 8.0 else NodePath("")
    head_look.influence = clamp(1.0 - (dist - 6.0) / 2.0, 0.0, 1.0)   # fade out 6→8m
```

`use_angle_limitation` is the production trick, and it defaults to **false** — a stock `LookAtModifier3D` does not clamp at all, so the head can rotate 180° and the model looks possessed. Turn it on and set `primary_limit_angle` to ~80° (1.4 rad), which matches a human's neck-only range; for a "whole-body turn" use it with the spine chain (next recipe). `primary_limit_angle` defaults to 2π, i.e. unlimited.

### A2 — Spine + head chain (look-at with body turn)

Multiple `LookAtModifier3D` nodes on the same chain — one for `Spine1` (`primary_limit_angle` 0.4 rad), one for `Spine2` (0.4 rad), one for `Head` (1.0 rad), each with `use_angle_limitation = true`. Total reach: ~110°, distributed naturally. Without the spine contribution, big angles look like the head detaches.

### A3 — Foot IK (slopes & uneven terrain)

The clip has the foot at Y=0; on a slope the ground is at Y=0.15. Without IK,
the foot floats. `SkeletonIK3D` remains available for two-bone chains in the
current Summer technical base; prefer the newer chain modifier for production:

```gdscript
@onready var skel: Skeleton3D = $Skeleton3D
@onready var ik_left: SkeletonIK3D = $Skeleton3D/IKLeft
@onready var ik_right: SkeletonIK3D = $Skeleton3D/IKRight
@onready var ray: RayCast3D = $FootRay   # cast straight down

func _physics_process(_delta: float) -> void:
    _solve_foot(ik_left, "LeftFoot")
    _solve_foot(ik_right, "RightFoot")

func _solve_foot(ik: SkeletonIK3D, bone_name: String) -> void:
    var bone_idx := skel.find_bone(bone_name)
    var foot_world := skel.get_bone_global_pose(bone_idx).origin
    ray.global_position = foot_world + Vector3.UP * 0.5
    ray.target_position = Vector3.DOWN * 1.0
    ray.force_raycast_update()
    if ray.is_colliding():
        var ground := ray.get_collision_point()
        if ground.y > foot_world.y - 0.05:   # only lift, never drop into the ground
            ik.target_node = NodePath("../IKTarget" + bone_name)
            (get_node("Skeleton3D/IKTarget" + bone_name) as Node3D).global_position = ground + Vector3.UP * 0.05
            ik.start()
        else:
            ik.stop()
    else:
        ik.stop()
```

The 0.5m up-offset on the ray prevents self-occlusion. The "only lift, never drop" rule is the production fix — letting IK push feet into the ground breaks knee bends.

Limits: this works for stairs and gentle slopes. On 45°+ slopes, use a pelvis lowering pass first (drop the root by `min(left_offset, right_offset)`) so the body squats and the legs don't over-extend.

### A4 — Hand grab on prop (sword grip, rifle stock)

`SkeletonIK3D` on the arm chain (Shoulder → UpperArm → LowerArm → Hand), with `target_node` set to a Marker3D parented to the prop. The clip drives the body; IK pins the hand to the grip. For a rifle held two-handed, do the right hand from clip and IK the left hand to a foregrip Marker3D — locks them together regardless of recoil.

## Pattern B — Additive layer

In the AnimationTree, wrap Locomotion in an `AnimationNodeAdd2`:

```
[parent: AnimationNodeStateMachine.Locomotion]
  AnimationNodeAdd2
    in: BlendSpace1D (idle/walk/run)   # the base
    add: AnimationNodeAnimation         # an additive clip — must be authored as delta
```

Drive `parameters/Locomotion/Add/blend_amount` (0..1) from script. Use cases: turn-lean (lean amount = clamp(turn_rate, -1, 1)), aim offset (lean while aiming up/down), breathing-while-idle. The "lean" clip must be exported with `track_type = additive` from Blender, or you'll see a 2x-pose stacked on the base.

## Pattern C — Ragdoll on death

```gdscript
@onready var sim: PhysicalBoneSimulator3D = $Skeleton3D/PhysicalBoneSimulator

func die(impulse_world: Vector3) -> void:
    $AnimationTree.active = false
    sim.physical_bones_start_simulation()
    var pelvis := $Skeleton3D/PhysicalBoneSimulator/PelvisPhysicalBone as PhysicalBone3D
    pelvis.apply_central_impulse(impulse_world * 4.0)
```

You need PhysicalBone3D children matching every major bone (set up once via the Skeleton3D context menu → "Create Physical Skeleton"). The impulse parameter sells the death — without directional impulse the body just collapses straight down.

## Confirmation gates

- **Before adding modifiers:** state which bones, which axes. Bone-name typos are a top failure.
- **Before driving from script:** confirm influence will fade out at distance and the target node is correct.
- **Before enabling ragdoll:** confirm physical bones exist; without them, simulation is a no-op.

## Reference card

### Bone names (Meshy humanoid skeleton, exact strings)

`Hips`, `Spine`, `Spine1`, `Spine2`, `Neck`, `Head`, `LeftShoulder`, `LeftArm`, `LeftForeArm`, `LeftHand`, `RightShoulder`, `RightArm`, `RightForeArm`, `RightHand`, `LeftUpLeg`, `LeftLeg`, `LeftFoot`, `LeftToeBase`, `RightUpLeg`, `RightLeg`, `RightFoot`, `RightToeBase`. (Meshy uses Mixamo-compatible naming with no `mixamorig:` prefix.)

### Axis conventions

| Setting | Value (Meshy default) |
|---|---|
| Forward axis (head/spine) | Z+ (`forward_axis`) |
| Up axis | Y+ |
| Right axis | X+ |
| Foot down | Y- |

### Influence fade-out distances (tuned defaults)

| Modifier | Disable past |
|---|---|
| Head look-at | 8m |
| Foot IK | 15m (snap-to-ground only matters when player can see) |
| Hand-on-prop IK | always on (cheap, breaks if disabled) |
| Additive lean | always on |
| Ragdoll | one-shot, never disabled |

### Pitfalls

- **LookAt rotates wildly / no clamp at all.** `use_angle_limitation` is false by default and `primary_limit_angle` defaults to 2π. Set both. ~80° (1.4 rad) for a head-only modifier; ~25° (0.4 rad) for a single spine bone.
- **IK pops on the first frame.** Solver hasn't been initialized. Call `ik.start()` after the AnimationTree's first tick, not in `_ready()` — the bone pose is identity until the tree runs.
- **Foot IK pushes the body up on stairs but the camera doesn't follow.** Camera is parented to the root, not the head. Either parent the camera to a chest bone via `BoneAttachment3D`, or accept that the camera doesn't bob with foot IK.
- **Additive layer doubles the clip.** The "additive" clip wasn't authored as a delta. Re-export from Blender with `Pose Mode → bake additive`.
- **Ragdoll just collapses, no spread.** Missing per-bone impulse + missing collision shapes on hands/feet PhysicalBone3D children. Auto-generate via Skeleton3D inspector → "Create Physical Skeleton" with the "Add collisions" option.
- **Modifiers run before the AnimationTree, not after.** Modifier order is set by tree-position in the scene. SkeletonModifier3D nodes must be CHILDREN of Skeleton3D and appear AFTER any nodes that drive the pose. AnimationTree itself doesn't sit under Skeleton3D — it sits at the character root and writes into Skeleton3D's pose every frame.
- **Look-at influence flickers at fade boundary.** Use `lerp(current_influence, target, 5 * delta)` instead of an instant assignment. Avoids the sub-pixel oscillation when the player walks the threshold.

### Performance budget

- Each `LookAtModifier3D`: ~5 µs/frame. Cheap; have many.
- Each `SkeletonIK3D` two-bone solve: ~30 µs/frame. ~30 active solves per frame on mid-range desktop is fine; budget more conservatively on Steam Deck.
- Ragdoll with full physical skeleton: ~200 µs/frame *while simulating*. Cap concurrent ragdolls at 5–8 before culling oldest.

## Anti-patterns

- Writing `skel.set_bone_pose_position(...)` in `_process`. Bypasses the AnimationTree, fights it next frame, results in jitter. Use modifiers instead — they integrate with the pipeline. (Edit-time STILL poses — a corpse, a statue — are the exception: no tree is running, so `ctx.bone_pose(skel, bone, {position/rotation/scale})` on Wave G engines, or `set_bone_pose_*` in a one-off `summer_run_script`, is exactly right. See `character-animation-wiring`.)
- Putting IK targets in worldspace and forgetting they don't follow the character. Parent IK targets under the character root or bone — IK target is in the modifier's local space.
- Procedural look-at without a fade-out at distance. Distant NPCs all snap to player every frame, looks like a hivemind.
- Foot IK on flying / floating characters. Disable when `is_on_floor() == false`.

## Edge cases

- **Character is mounted (riding a horse).** Disable foot IK on the rider; ride animation already sells the contact. Enable upper-body additive sway driven by horse acceleration.
- **First-person hands.** Same modifier set, but only the arm chain is visible — disable head/spine modifiers, keep hand-on-prop IK.
- **Character is a quadruped.** All four legs need foot IK. The bone names are different (`FrontLeftLeg`, `BackRightLeg`, etc.); inspect first.
- **Network-synced ragdoll.** Don't simulate on every client. Simulate on the host, send bone transforms via `MultiplayerSynchronizer`, blend on receivers. Out of scope; see `setup-multiplayer`.

## Fallback (no MCP)

Add modifiers in Summer Engine under Skeleton3D and set bone names from the
Inspector dropdown, which autocompletes from the rig. Hand-write the GDScript
driving them. Foot raycasts can be set up visually with a RayCast3D child.

## Handoff

- For the end-to-end rigged-character wiring these layers sit on top of (locomotion, method-track events, root motion), `character-animation-wiring`.
- For the AnimationTree these procedural layers compose with, `animation-tree`.
- For the source clips that procedural overlays modify, `generate-motion`.
- For face / lipsync (a different modifier family — BlendShapes, not bones), `facial-and-lipsync`.
- For NPC behavior triggering ragdoll on death, `design-npc`.
- For first-person aim sway / ADS, `fps-controller`.

## See also

- Upstream API reference matching the current Summer technical base:
  `SkeletonModifier3D`, `LookAtModifier3D`, `SkeletonIK3D`,
  `PhysicalBoneSimulator3D`.
