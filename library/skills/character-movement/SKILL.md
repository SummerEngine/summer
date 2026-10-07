---
name: character-movement
description: "Player controllers for 2D and 3D, plus the canonical third-person controller for Summer humanoid packages: movement owns translation, clips follow state."
license: MIT
compatibility: [Cursor, Claude Code, Codex, Windsurf, Gemini, OpenCode]
category: character-controllers
user-invocable: false
allowed-tools: Read Grep summer_read_file summer_write_file summer_replace_text summer_get_scene_tree summer_add_node summer_set_prop summer_batch summer_input_map_bind summer_save_scene summer_get_script_errors summer_get_diagnostics summer_play summer_stop
paths: ["**/*.gd", "**/*.tscn"]
---

# Character Movement

The player controller is the first thing you build and the thing the user feels
in the first 3 seconds. Ship the smallest correct controller, then tune feel.

Trigger phrases: "add player movement", "the player can't move / falls through
the floor", "wire my imported character as the player", "walk/run/jump
animations", "mouse look", "make the jump feel better".

Supporting files live in this skill's `references/` folder, next to this
SKILL.md. Open only the one the task needs:

| File | Read when |
|------|-----------|
| `references/default-third-person-controller.gd` | standard playable third-person Summer humanoid package; copy this exact controller instead of rewriting it |
| `references/default-third-person-verification-probe.gd` | runtime proof for that controller; pass it unchanged as a `RunVerification` `probe_source` |
| `references/platformer-feel.md` | jump feels bad, coyote time, jump buffering, variable jump height, one-way platforms |
| `references/movement-3d.md` | FPS/third-person controllers, mouse look, sprint, crouch, spring-arm camera |

## Default playable Summer character

For a standard playable third-person Summer humanoid package, install this
skill's `references/default-third-person-controller.gd` unchanged as the player
script. Do not rewrite or reconstruct it from the snippets below. Customize the
installed file only when the user explicitly asks for different controls or
behavior.

Install it byte-exact:

1. Take the full text of `references/default-third-person-controller.gd` from
   this skill's folder, unchanged (tabs, comments and all).
2. New destination:
   `summer_write_file(path="res://scripts/player.gd", content=<that text>, create_only=true)`.
   Existing destination: `summer_read_file(path="res://scripts/player.gd")`
   first, then `summer_write_file(path=..., content=<that text>, expected_sha256=<sha256 from the read>)`.
3. Confirm the copy is exact: the write receipt's sha256 must equal the sha256
   of the source file (hash it locally when you have a shell; otherwise
   `summer_read_file` the result and compare it to the source text).

Do not edit the installed file, add roles, or add an `AnimationTree` merely
because the user selected more package clips: choosing clips is not a request
to customize controls or behavior. When the user does explicitly request
different controls or behavior, install the exact canonical source first, then
`summer_read_file` the installed project file and change it with
`summer_replace_text`. Configure the manifest path and node paths on the scene
instance.

Required main-scene shape:

```text
Main (Node3D)
  Player (CharacterBody3D)               # template script
    CollisionShape3D                     # capsule
    CharacterRotationRoot (Node3D)       # only this node turns
      Character                          # imported character.tscn instance
    CameraYaw (Node3D)
      CameraPitch (Node3D)
        SpringArm3D
          Camera3D                       # current = true
  Ground / level geometry                # world siblings of Player
  DirectionalLight3D / WorldEnvironment
```

When authoring a new main scene as `.tscn` text (written whole with
`summer_write_file`, never a hand edit of a scene open in the editor), use this
exact serialization pattern. Replace only the imported package paths when they
differ:

```text
[gd_scene load_steps=7 format=3]

[ext_resource type="Script" path="res://scripts/player.gd" id="1_controller"]
[ext_resource type="PackedScene" path="res://characters/imported/character.tscn" id="2_character"]

[sub_resource type="CapsuleShape3D" id="PlayerCapsule"]
radius = 0.45
height = 1.8

[sub_resource type="BoxShape3D" id="GroundShape"]
size = Vector3(20, 0.5, 20)

[sub_resource type="BoxMesh" id="GroundMesh"]
size = Vector3(20, 0.5, 20)

[sub_resource type="Environment" id="WorldEnvironment"]
background_mode = 1
background_color = Color(0.12, 0.18, 0.3, 1)
ambient_light_energy = 0.6

[node name="Main" type="Node3D"]

[node name="Player" type="CharacterBody3D" parent="."]
position = Vector3(0, 1, 0)
script = ExtResource("1_controller")
character_manifest_path = "res://characters/imported/character.json"

[node name="CollisionShape3D" type="CollisionShape3D" parent="Player"]
shape = SubResource("PlayerCapsule")

[node name="CharacterRotationRoot" type="Node3D" parent="Player"]

[node name="Character" parent="Player/CharacterRotationRoot" instance=ExtResource("2_character")]

[node name="CameraYaw" type="Node3D" parent="Player"]

[node name="CameraPitch" type="Node3D" parent="Player/CameraYaw"]
rotation = Vector3(-0.349066, 0, 0)

[node name="SpringArm3D" type="SpringArm3D" parent="Player/CameraYaw/CameraPitch"]
spring_length = 5.0

[node name="Camera3D" type="Camera3D" parent="Player/CameraYaw/CameraPitch/SpringArm3D"]
current = true

[node name="Ground" type="StaticBody3D" parent="."]
position = Vector3(0, -0.25, 0)

[node name="MeshInstance3D" type="MeshInstance3D" parent="Ground"]
mesh = SubResource("GroundMesh")

[node name="CollisionShape3D" type="CollisionShape3D" parent="Ground"]
shape = SubResource("GroundShape")

[node name="DirectionalLight3D" type="DirectionalLight3D" parent="."]
rotation_degrees = Vector3(-55, -30, 0)
shadow_enabled = true

[node name="WorldEnvironment" type="WorldEnvironment" parent="."]
environment = SubResource("WorldEnvironment")
```

Every nested `parent` is the complete path from the scene root, excluding the
root node's own name. Never shorten
`parent="Player/CameraYaw/CameraPitch"` to `parent="CameraPitch"`. A
`PackedScene` instance belongs in the `[node ...]` header and has no `type`;
never write a typed `Node3D` followed by `instance = ExtResource(...)` in the
node body. The playable body is a child of the world root. Ground, level
geometry, lights, and environment remain siblings of `Player`, never children
of it, so they do not move with the player.

Set `character_manifest_path` to the imported package's `character.json`. Bind
`move_left`, `move_right`, `move_forward`, `move_back`, `jump`, and `sprint`
before running, one `summer_input_map_bind` per action (e.g.
`summer_input_map_bind(name="move_forward", events=[{"type": "key", "key": "W"}])`);
`ui_cancel` is a built-in action — confirm it is still bound. The controller
asserts every one of them at `_ready`. Do not attach this template during generic import or
to an NPC unless the user explicitly asks for player-style control.

The default camera has horizontal mouse orbit only. `CameraPitch` is set once to
a modest downward angle and vertical mouse motion does not change it. The
controller keeps a short floor snap plus a small downward grounded velocity so
ordinary horizontal movement does not create a false airborne `Jump` state. It
also records the spawn point and respawns after falling below `respawn_below_y`.

A bind T/A-pose survives every static check: the AnimationPlayer is wired, the
clip is named `Idle`, and the files on disk all read correctly. Only a running
frame separates that from a character actually at rest.

**Runtime proof.** Read this skill's
`references/default-third-person-verification-probe.gd` and pass its full text
unchanged as the `probe_source` of a `RunVerification` op, which runs it in a
hidden, disposable game instance that never touches the editor:

```
summer_batch(ops=[{"op": "RunVerification", "max_seconds": 30, "probe_source": "<the probe file, unchanged>"}])
```

The probe samples the live Skeleton3D after
the player reaches the floor, requires the real resting clip to be named `Idle`,
verifies that its pose actually changes, rejects an idle whose hands remain level
with the upper arms like a bind T/A-pose, saves separate idle and moving frames,
verifies W moves toward world `-Z`, and verifies vertical mouse input leaves
camera pitch unchanged. Every boolean in `results` must be `true`; open the saved
idle and moving frames listed in `frames` before you describe them. A `false` is
a finding to fix, not a flaky probe.

**If the probe cannot run** (the op returns `ok: false` with a `failure_reason`
such as `spawn_failed`, or the engine build lacks the op), the runtime question
belongs to the user. Do not paste the probe into the project. Finish on the
saved state: the manifest path written into the
Player node, the four semantic roles present, CameraYaw at identity and
CameraPitch at its fixed angle in the `.tscn` text, the InputMap actions bound,
and clean diagnostics. Then tell the user which idle clip should be playing at
rest, so it is the first thing they look at on Play. That is a complete
integration handed off for a playtest, not an incomplete one.

## Order of operations

1. Root node must be `CharacterBody2D` or `CharacterBody3D`. `move_and_slide()`
   only exists on these. RigidBody is for physics props, not players.
2. Give it a `CollisionShape2D/3D` with a real shape (CapsuleShape for 3D humans,
   RectangleShape/CapsuleShape2D for 2D). No shape = falls through everything.
3. Read gravity from project settings, never hardcode it, so tuning one value
   fixes the whole game: `ProjectSettings.get_setting("physics/2d/default_gravity")`.
4. Bind input actions BEFORE the script references them (`move_left`, `jump`, ...).
   Referencing an unbound action is a silent no-op that reads as "controls dead".
5. Compile-check, then run and watch it move. Feel is a user call, not a still frame.

## 2D side-scroller controller (the 40% every 2D game shares)

```gdscript
extends CharacterBody2D

@export var speed: float = 200.0
@export var jump_velocity: float = -350.0   # negative = up in 2D

var gravity: float = ProjectSettings.get_setting("physics/2d/default_gravity")

func _physics_process(delta: float) -> void:
	if not is_on_floor():
		velocity.y += gravity * delta
	if Input.is_action_just_pressed("jump") and is_on_floor():
		velocity.y = jump_velocity
	var dir := Input.get_axis("move_left", "move_right")
	velocity.x = dir * speed if dir else move_toward(velocity.x, 0.0, speed)
	move_and_slide()
```

Flip the sprite with `$Sprite2D.flip_h = velocity.x < 0` only when `velocity.x != 0`.
For real platformer feel (coyote time, jump buffer, variable height) load
`references/platformer-feel.md`.

## Top-down controller (RPG / twin-stick / survivors)

No gravity. 8-directional, normalize so diagonals are not faster.

```gdscript
extends CharacterBody2D

@export var speed: float = 220.0

func _physics_process(_delta: float) -> void:
	var dir := Input.get_vector("move_left", "move_right", "move_up", "move_down")
	velocity = dir * speed
	move_and_slide()
```

Survivors-style games with 200+ agents: enemies are `Area2D` moved with
`position += dir * speed * delta`, NOT physics bodies. See the `make-game`
skill's `../make-game/references/2d-survivors.md`. The PLAYER stays a CharacterBody2D.

## 3D controller (first + third person)

Both share the same body + gravity + `Input.get_vector` floor logic. The only
difference is where the camera lives and how look rotation is applied. Full
first-person and third-person controllers, mouse look, sprint, crouch, and
spring-arm setup are in `references/movement-3d.md` - load it for any 3D player.

Minimal 3D walk (no look yet):

```gdscript
extends CharacterBody3D

@export var speed: float = 5.0
@export var jump_velocity: float = 4.5
var gravity: float = ProjectSettings.get_setting("physics/3d/default_gravity")

func _physics_process(delta: float) -> void:
	if not is_on_floor():
		velocity.y -= gravity * delta
	if Input.is_action_just_pressed("jump") and is_on_floor():
		velocity.y = jump_velocity
	var input_dir := Input.get_vector("move_left", "move_right", "move_forward", "move_back")
	var direction := (transform.basis * Vector3(input_dir.x, 0.0, input_dir.y)).normalized()
	if direction:
		velocity.x = direction.x * speed
		velocity.z = direction.z * speed
	else:
		velocity.x = move_toward(velocity.x, 0.0, speed)
		velocity.z = move_toward(velocity.z, 0.0, speed)
	move_and_slide()
```

## Summer humanoid package

When the player visual is a Summer character package:

1. Produce or import the package first — it comes from the shared character
   pipeline (`character-model`; `summer_generate_3d` with rigging and animations)
   and carries `character.tscn` plus its `character.json` manifest. Instantiate
   `character.tscn`; for clip wiring without this controller see
   `character-animation-wiring`.
2. Put the normalized wrapper under a `CharacterBody3D`; do not modify the package or
   scale the body.
3. Let controller velocity and `move_and_slide()` own all scene translation. Idle, Walk,
   Run, and Jump are in-place visual clips; never add their root motion to velocity.
4. Resolve the four clips from `character.json` semantic roles instead of guessing names.
   Require every requested role; never substitute one role for another.
5. Select one state from physics: airborne -> Jump, stopped -> Idle, moving -> Walk,
   sprinting -> Run. Airborne Jump has highest priority and never falls back to Walk/Run.
   Change clips only when the state changes, so Jump plays once per takeoff.
6. Rotate the visual child toward non-zero movement while preserving the normalized
   `-Z` forward axis. Turn only visual yaw; do not rotate the collision body merely to
   turn the mesh. Keep the third-person camera behind the visual on local `+Z`.

Do not put player controls into the generation pipeline or generic character importer.

## Camera-follow basics

- 2D: add a `Camera2D` as a CHILD of the player (it is active while `enabled`,
  the default), `position_smoothing_enabled = true`, speed 5-8. Add
  `limit_left/right/top/bottom` so it never shows past the level edge. Full rigs
  in the `camera-rigs` skill.
- 3D first-person: camera is a child of a `Head` node; yaw rotates the body,
  pitch rotates the Head (never the body) to avoid gimbal lock.
- 3D third-person: camera on a `SpringArm3D` so walls push it in. See `camera-rigs`.

## Traps

- Scaling the CharacterBody node breaks collision + velocity. Scale the MESH/Sprite
  child instead. In 3D, 1 unit = 1 meter; a human is ~1.0-2.0 tall.
- `is_on_floor()` is only valid AFTER `move_and_slide()` ran once this frame.
- Diagonal speed-up = you forgot to normalize the input vector.
- Mouse captured with no release traps the user. Always pair
  `Input.MOUSE_MODE_CAPTURED` with a `ui_cancel` handler that sets it VISIBLE.
