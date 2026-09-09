---
name: animation-tree
description: Use when the user has clips on a character and needs them to play in response to gameplay — idle/walk/run blend, attacks that interrupt locomotion, hit reactions that override everything. Designs and wires Summer Engine AnimationTree state machines and blend trees. Trigger on "AnimationTree", "state machine", "blend tree", "transition", "play animation when", "character keeps T-posing", "wire animations".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: animation
user-invocable: false
allowed-tools: Read Grep Edit Write summer_get_scene_tree summer_inspect_node summer_inspect_resource summer_run_script summer_add_node summer_set_prop summer_set_resource_property summer_connect_signal summer_save_scene summer_get_script_errors summer_play summer_stop
paths: ["**/*.gd", "**/*.tscn", "**/*.tres"]
---

# AnimationTree — Wire Clips Into Behavior

Generation gives you clips. The AnimationTree gives the character life. This skill is **not generative** — no FAL, no MCP AI calls. It composes existing clips on an `AnimationPlayer` into an `AnimationTree` with a `StateMachine` for distinct states (idle / attack / hit / dead) and `BlendSpace` nodes for continuous parameters (walk-run blend by speed). Done right, the character moves like a shipped game; done wrong, you get T-poses, snapping, or animations that "eat" each other.

The canonical Summer Engine stack:

```
Character (CharacterBody3D)
├── Skeleton3D (from the Meshy rig)
├── AnimationPlayer            # holds the raw clips (idle, walk, run, attack_sword, ...)
└── AnimationTree              # references AnimationPlayer, drives behavior
```

Before adding the tree, prove direct `AnimationPlayer.play()` visibly moves the rig. Godot may import animation GLBs as `AnimationLibrary` resources or as `PackedScene`s with embedded `AnimationPlayer`s. If a copied clip appears in the list but the mesh T-poses, its tracks probably target a different root/skeleton path. Use the embedded player that came with the matching GLB, or remap/copy tracks only after confirming they target the active `Skeleton3D`. An inactive AnimationTree is also a no-op, so always set `AnimationTree.active = true`.

## When to use this skill

- Character has 3+ clips and switching between them via `AnimationPlayer.play("walk")` is causing pops, T-poses, or "starts halfway through".
- Need a walk → run blend that's continuous, not boolean.
- Need attack to interrupt locomotion but only on the upper body, while feet keep walking.
- Need hit-react one-shot that returns to whatever state was playing before.
- Building any non-trivial NPC or player character past the prototype phase.

## When NOT to use this skill

- Single-clip looping background prop (banner waving, water surface). Just `AnimationPlayer.play("loop")` is fine.
- Cinematic with hand-authored timing. Use `AnimationPlayer` directly with `play_with_capture`; AnimationTree is overkill.
- Character has zero clips — generate first via `generate-motion`.
- Procedural-only animation (no clips, all IK). That's `procedural-animation`.

## Canonical state machine

This is the production-default for a humanoid character that can move, attack, take a hit, and die. Start here, prune what you don't need, extend with named states for specials.

```
                     ┌─────────┐
              ┌─────►│  Dead   │  (terminal — no exit)
              │      └─────────┘
              │           ▲
              │           │ on_death
   ┌──────────┴───────────┴──────────┐
   │              Hit                │  (one-shot, returns to prev)
   └──────────▲──────────────────────┘
              │ on_damaged                  ┌──────────┐
   ┌──────────┴──────────┐                  │  Attack  │  (one-shot)
   │     Locomotion      │ on_attack ──────►└──────────┘
   │   (BlendSpace1D)    │ ◄────── on_attack_done
   │   idle ↔ walk ↔ run │
   └─────────────────────┘
```

- **Locomotion** is a single AnimationNodeBlendSpace1D parameterized by `move_speed` (0..max). Three points on the line: idle (0), walk (~3), run (~6). Crossfades for free.
- **Attack** is an AnimationNodeOneShot wrapping `attack_sword` (or whichever clip). Fires from the script via `parameters/attack/request = ONE_SHOT_REQUEST_FIRE`. Auto-returns to Locomotion when the clip ends.
- **Hit** same pattern, higher priority — interrupts attack. Fires on `damaged` signal.
- **Dead** is a transition-target with no exit. Trigger via `state_machine.travel("dead")`.

## The fast lane: script the wiring (preferred)

Before walking the CRUD steps below, check the ctx lane — one `summer_run_script` call replaces the add-node/set-prop chain AND the hand-written `.tres`:

- **Wave G engines:** `ctx.anim_state_machine(character, {states: {...}, transitions: [[from, to, {blend_s: 0.2}], ...], start: "idle"})` gets-or-creates the AnimationTree, wires it to the player, builds the state machine, sets `active = true`. Unknown clip names come back as a report entry listing the player's REAL clips — never wire against guessed names. Full recipe (inspect clips/bones first, method-track events, root motion, playtest verification): `character-animation-wiring`.
- **Any engine (raw fallback):** the same classes are fully script-bound — `AnimationNodeStateMachine.add_node(name, AnimationNodeAnimation)`, `add_transition(from, to, AnimationNodeStateMachineTransition)` (one transition resource each, `xfade_time` on it), then `tree.anim_player = tree.get_path_to(player)`, `tree.tree_root = sm`, `tree.active = true`, and `ctx.set_owner_recursive(tree)`. The raw script is quoted in `character-animation-wiring`.

Note the helper's scope honestly: `anim_state_machine` builds clip states + transitions only. The canonical machine below — BlendSpace1D locomotion, OneShot attack/hit — still needs the `.tres` (or raw-script) lane for those node types. Discrete idle/walk/run backbones don't.

## Steps via MCP

### 1. Inspect the current character

```
summer_get_scene_tree
summer_inspect_node "./World/Goblin"
```

Confirm there's a `Skeleton3D` and an `AnimationPlayer` with at least `idle` + `walk` + `run` populated. If clips are missing, route to `generate-motion`.

### 2. Add the AnimationTree

```
summer_add_node(scenePath: "res://main.tscn", parent: "./World/Goblin", type: "AnimationTree", name: "AnimationTree")
summer_set_prop(scenePath: "res://main.tscn", path: "./World/Goblin/AnimationTree", key: "anim_player", value: "../AnimationPlayer")
summer_set_prop(scenePath: "res://main.tscn", path: "./World/Goblin/AnimationTree", key: "active", value: "true")
```

`scenePath` is a **required** argument on every scene-mutating tool
(`summer_add_node`, `summer_set_prop`, `summer_set_resource_property`,
`summer_connect_signal`, `summer_save_scene`, `summer_instantiate_scene`,
`summer_remove_node`, `summer_replace_node`). Omit it and the call is rejected
before it reaches the engine. Get the path from `summer_get_project_context`.

`anim_player` must be a relative NodePath; `../AnimationPlayer` from a sibling. Don't use absolute paths — breaks scene reuse.

### 3. Build the tree resource

The `tree_root` is a single `AnimationNodeStateMachine`. Inside it, a `Locomotion` node which is itself an `AnimationNodeBlendSpace1D`, plus `Attack`, `Hit`, `Dead` nodes.

Three ways to build it, in preference order: (1) a `summer_run_script` GDScript
constructing the node graph via the script-bound API — transactional, no
hand-parsed text format (see the fast-lane section above; BlendSpace1D and
OneShot nodes are `AnimationNodeBlendSpace1D.new()` + `add_blend_point(...)`
and `AnimationNodeOneShot.new()` with `fadein_time`/`fadeout_time`, composed
with the same `add_node`/`add_transition` calls); (2) hand-writing the `.tres`
below and importing it; (3) `summer_set_resource_property` node-by-node — the
most verbose, use only for touch-ups. The `.tres` skeleton, for the read/write
fallback lane:

```
[gd_resource type="AnimationNodeStateMachine" load_steps=8 format=3]

[sub_resource type="AnimationNodeBlendSpace1D" id="locomotion"]
blend_point_0/node = SubResource("idle_clip")
blend_point_0/pos = 0.0
blend_point_1/node = SubResource("walk_clip")
blend_point_1/pos = 3.0
blend_point_2/node = SubResource("run_clip")
blend_point_2/pos = 6.0
min_space = 0.0
max_space = 6.0

[sub_resource type="AnimationNodeOneShot" id="attack_oneshot"]
fadein_time = 0.05
fadeout_time = 0.10
mix_mode = 0   # 0=BLEND, 1=ADD

[sub_resource type="AnimationNodeOneShot" id="hit_oneshot"]
fadein_time = 0.0    # snap in — hit reactions are immediate
fadeout_time = 0.15

# ... AnimationNodeAnimation sub_resources point at clip names ...

[resource]
states/Locomotion/node = SubResource("locomotion")
states/Attack/node = SubResource("attack_oneshot")
states/Hit/node = SubResource("hit_oneshot")
states/Dead/node = SubResource("dead_clip")
transitions = [
  "Locomotion", "Attack",   SubResource("trans_to_attack"),
  "Attack",     "Locomotion", SubResource("trans_back"),
  "Locomotion", "Hit",      SubResource("trans_to_hit"),
  "Attack",     "Hit",      SubResource("trans_to_hit"),
  "Hit",        "Locomotion", SubResource("trans_back"),
  "Locomotion", "Dead",     SubResource("trans_to_dead"),
  "Attack",     "Dead",     SubResource("trans_to_dead"),
  "Hit",        "Dead",     SubResource("trans_to_dead")
]
graph_offset = Vector2(0, 0)
```

Each `AnimationNodeStateMachineTransition` carries `xfade_time` (0.15 default), `switch_mode` (Immediate / Sync / At End), and `advance_mode` (Auto / Enabled / Disabled).

Ask before writing the `.tres`: "May I write `res://characters/goblin/animation_tree.tres` with the canonical 4-state machine + Locomotion blendspace?"

### 4. Drive it from the controller script

```gdscript
@onready var tree: AnimationTree = $AnimationTree
@onready var sm: AnimationNodeStateMachinePlayback = tree["parameters/playback"]

func _physics_process(delta: float) -> void:
    var horiz_speed: float = Vector2(velocity.x, velocity.z).length()
    tree.set("parameters/Locomotion/blend_position", horiz_speed)

func attack() -> void:
    tree.set("parameters/Attack/request", AnimationNodeOneShot.ONE_SHOT_REQUEST_FIRE)

func take_hit() -> void:
    tree.set("parameters/Hit/request", AnimationNodeOneShot.ONE_SHOT_REQUEST_FIRE)

func die() -> void:
    sm.travel("Dead")
```

`tree.set(...)` writes a parameter path. `sm.travel(...)` switches state.

### 5. Connect signals

```
summer_connect_signal(
  scenePath: "res://main.tscn",
  emitter: "./World/Goblin",
  signal: "damaged",
  receiver: "./World/Goblin",
  method: "take_hit"
)
```

The parameters are `emitter` and `receiver` — not `source`/`target`, not
`from`/`to`. Those spellings fail schema validation.

If the goblin has an HP component emitting `died`, connect that to `die`.

### 6. Save & verify

```
summer_save_scene(scenePath: "res://main.tscn")
summer_get_script_errors(path: "res://scripts/goblin.gd")
```

`summer_get_script_errors` checks **one** file and requires `path`; there is no
"check everything" form. For a project-wide sweep use `summer_get_diagnostics`.

Then `summer_play` and watch — the goblin should idle in place, blend up to walk/run as it moves, fire attack on input/AI, snap to hit on damage, end in Dead.

## Confirmation gates

- **Before writing the `.tres`:** show the state list and transition table.
- **Before connecting signals:** show source → target → method.
- **Before pressing play:** state which behaviors should be visible (idle plays, walk crossfades, attack interrupts).

## Reference card

### Parameter paths cheat-sheet

| Goal | Path |
|---|---|
| Set blendspace1D position | `parameters/Locomotion/blend_position` |
| Fire a OneShot | `parameters/<NodeName>/request` (set to `ONE_SHOT_REQUEST_FIRE`) |
| Abort a OneShot | `parameters/<NodeName>/request = ONE_SHOT_REQUEST_ABORT` |
| Read OneShot active state | `parameters/<NodeName>/active` |
| Get StateMachine playback | `parameters/playback` (returns `AnimationNodeStateMachinePlayback`) |
| Switch state | `state_machine.travel("StateName")` |
| Read current state | `state_machine.get_current_node()` |
| Force state without transition | `state_machine.start("StateName")` |

### Transition `switch_mode` decision

- **Immediate (0):** snap to new state at xfade. Use for hit reactions, deaths.
- **Sync (1):** match current play position. Use for walk ↔ run (avoids foot-pop mid-stride).
- **At End (2):** finish current clip first. Use for attack-string combos (`attack_1` → `attack_2` only at end of `attack_1`).

### Pitfalls

- **Character T-poses on play.** `AnimationTree.active = true` was missed. Set it in `_ready()` or via inspector.
- **Locomotion blendspace stuck on idle even when moving.** The `blend_position` parameter isn't being written — confirm `tree.set("parameters/Locomotion/blend_position", speed)` runs every frame in `_physics_process`. Also confirm the path matches your state name exactly (case-sensitive).
- **Walk-to-run pops.** Transition `switch_mode` is `Immediate`. Set to `Sync` so the cycle phase matches across the crossfade.
- **Attack one-shot fires every frame as long as input is held.** Use `Input.is_action_just_pressed`, not `is_action_pressed`. Or store a `_can_attack` flag with cooldown.
- **Hit reaction interrupts itself when hit twice in 100ms.** Set `fadein_time = 0.0` and gate from script: `if sm.get_current_node() == "Hit": return`.
- **Attack plays but locomotion is invisible (lower body T-pose).** OneShot's
  `mix_mode` is `BLEND` (full body). For upper-body-only attacks, set
  `mix_mode = ADD` and use an additive clip, or drive the lower body from a
  second `AnimationTree` branch and blend by bone with an
  `AnimationNodeBlend2` plus filters. `SkeletonModification3D` is an old
  upstream class name and `ClassDB.class_exists("SkeletonModification3D")`
  returns false on the current Summer build.
- **Dead state replays from start every time HP < 0.** Add a guard in the controller: `if is_dead: return`.

### One-shot vs StateMachine — which to use

- **OneShot:** the action is a *temporary override* of an underlying state (attack while running, hit-react while attacking). The base keeps playing.
- **StateMachine state:** the action is a *replacement* (dead, stunned, ragdoll). Nothing else plays.
- Combat in 2026-feel games is almost always OneShot for attacks + StateMachine state for "dead". Don't model attacks as StateMachine states unless you need precise transition control between attack-string variants.

### BlendSpace1D vs BlendSpace2D

- 1D for speed-only locomotion (idle / walk / run).
- 2D for omnidirectional movement (idle / forward / strafe-left / strafe-right / back). Eight or nine clips arranged on a unit circle. Necessary for top-down or strafing third-person; overkill for FPS hands.

## Anti-patterns

- Skipping AnimationTree and calling `AnimationPlayer.play("walk")` from script. Works for one clip; breaks the moment you need a crossfade.
- Modeling every attack as a StateMachine state. The transition matrix explodes (N states × N transitions). Use one OneShot per attack and switch its inner clip via `parameters/Attack/animation`.
- Writing the `.tres` by hand without using sub_resource IDs — Godot loses references and the inspector is unhappy. Always use `[sub_resource id="..."]` blocks.
- Driving `blend_position` from raw input (`Input.get_axis(...)`). Drive from actual velocity — that way the blend matches the body's real motion, including knockback and slope-slide.

## Edge cases

- **Player rotates 180° instantly while sprinting.** The blendspace doesn't know about turning — locomotion looks like the character moonwalks for one frame. Add a small additive turn-lean clip layered on top, or add a brief "turn" state with switch_mode=AtEnd.
- **Animation library uses root motion.** Set `root_motion_track` on the AnimationTree (path to the root bone), then in `_physics_process` use `tree.get_root_motion_position()` and apply to the CharacterBody3D. Don't combine with input-driven velocity — pick one.
- **Character has no AnimationPlayer.** Add one first. AnimationTree without anim_player target is a no-op.

## Fallback (no MCP)

Open the scene in Summer Engine, add an `AnimationTree` node, set `Anim Player`
to the AnimationPlayer, set `Active = on`, double-click `Tree Root`, and edit
visually. Drag `AnimationNodeStateMachine` as the root, drop nodes inside, draw
transitions by Shift-dragging, and save the scene. The visual editor produces
the same `.tres`; it is slower but discoverable.

## Handoff

- For NPC behavior firing these states (decide-when-to-attack), hand off to `design-npc`.
- For first-person hand animations on the player rig, the same pattern applies — hand off to `fps-controller` for the state inputs.
- For procedural overlays on top of the tree (look-at the player while idling), hand off to `procedural-animation`.
- For lipsync layered on the face during dialogue states, hand off to `facial-and-lipsync`.

## See also

- `character-animation-wiring` — the end-to-end rigged-GLB path: inspect real clip/bone names, `ctx.anim_state_machine`, method tracks, root motion, playtest verification.
- `generate-motion` — produce the clips this tree references.
- `retarget` — share one tree across many characters.
