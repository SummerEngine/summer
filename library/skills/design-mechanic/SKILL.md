---
name: design-mechanic
description: Use when designing one specific game mechanic in detail — input, response, feedback, failure modes, depth, tunables. Outputs a design doc and a scaffolding-ready node-graph sketch + GDScript stub. Trigger on "design a mechanic", "how should X work", "design the parry", "design the dash", "design the inventory", "the loop is broken".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: gameplay-mechanics
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_get_scene_tree summer_inspect_node summer_add_node summer_set_prop summer_input_map_bind summer_save_scene summer_get_script_errors
paths: ["**/*.gd", "**/*.tscn", ".summer/**"]
---

# /design-mechanic — Design One Mechanic in Detail

## Overview

A "mechanic" is a verb the player performs that produces a meaningful response from the world. Not a system. Not a feature. A verb with feedback. This skill walks the five layers of a real mechanic: **input → response → feedback → failure modes → depth** — then drops a node-graph sketch + GDScript stub into the project so the next session can implement it.

**Core principle:** a mechanic is only as good as its weakest feedback layer. A perfect parry with no audio cue is broken. A great audio cue with floaty input is broken. Walk all five layers before scaffolding.

## Steps

### 1. Pin which mechanic

Ask exactly one question and wait:

> Which mechanic? (e.g., "double-jump", "parry", "stamina-dash", "pickup", "lock-on", "crafting-recipe-craft").

If the user gives a system name ("inventory", "combat"), push back:

> Inventory is a system, not a mechanic. The mechanics inside it are: pickup, equip, drop, use, swap. Which one?

### 2. Read context if available

If `.summer/GameSoul.md` exists, read it. The mechanic should fit the game brief, not exist in isolation.

```
Read .summer/GameSoul.md
```

Quote the relevant constraint back at the user:

> Brief says core loop is "see obstacle, attempt, fail, learn, retry". A double-jump only matters if it changes which obstacles are reachable. Confirm that's what we're solving.

### 3. Walk the five layers — one at a time

**Layer 1: Input.** Exactly what does the player press, hold, release, time?

State a candidate, ask for refinement:

> Input candidate: tap Space mid-air. Or: hold-and-release for variable height? Or: requires direction + Space? Pick one.

**Layer 2: Response.** What changes in the world the moment the input fires?

State the deltas. For double-jump:

> Response: vertical velocity set to (jump_velocity * 0.85). `_can_double_jump` flag flips false. Visual rig plays "jump_2" anim. Audio cue. Particle burst at feet.

**Layer 3: Feedback** — and this is where most amateur designs collapse. Three sub-channels, all required:

| Channel | Question to answer | Bad example | Good example |
|---|---|---|---|
| Visual | Can a player who can't hear tell it worked? | "It just jumps." | "GPUParticles3D burst at feet, 0.1s slow-mo on apex, after-image trail behind." |
| Audio | Can a player who can't see tell it worked? | "Plays jump.wav." | "Layered: short whoosh on input, ambient pitch-up while airborne, soft thud on second jump start." |
| Mechanical | Does the input feel different from a single-jump? | "Same jump, just twice." | "Second jump has tighter air control, slightly lower height, different particle color." |

Force the user to answer all three. If they hand-wave one, name it:

> You named visual and audio. Mechanical-feel is missing — what makes the second jump feel different from the first beyond just being a second one?

**Layer 4: Failure modes.** What happens when the input fires but conditions aren't met?

For double-jump:

- Already used? → no input registered? Or denied with a UI shake? Or a small audio cue?
- During wall-slide? → does it count as airborne or grounded?
- During cutscene? → is input gated entirely?
- Spammed input? → buffered or ignored?

State the rules, ask:

> Failure rules: (a) already-used → silent ignore. (b) during wall-slide → counts as airborne, can double-jump off wall. (c) cutscene → input fully gated. (d) spam → input buffer of 0.1s. OK?

**Layer 5: Depth.** What makes this mechanic interesting after 5 minutes of play?

This is the hardest layer. State the depth-vector explicitly:

> Depth: double-jump becomes interesting when level design forces a *choice* — jump now to clear obstacle A, or save it to escape enemy B coming at you. Without that choice, it's just a longer jump. The level-design implication: every double-jump gap should pair with a near-future threat that also wants the resource.

If the user can't articulate depth, the mechanic might not be needed. Say it:

> If the only purpose is "can reach higher platforms", that's just a higher-jumping single-jump. Either change the input shape (give it a cost), or cut it.

### 4. List the tunables

Every mechanic has 3-7 numbers a designer will tweak. Name them. For double-jump:

```
@export var double_jump_velocity: float = 4.0      # vertical speed of second jump
@export var double_jump_air_control: float = 0.7   # multiplier vs ground control
@export var input_buffer_time: float = 0.1         # window to register early input
@export var ground_grace_period: float = 0.05      # coyote time before lockout
@export var slow_mo_on_apex: float = 0.0           # 0 = off, 0.05 = brief
```

These become `@export` vars in the stub. The user tunes in the inspector, no recompile.

### 5. Sketch the node graph

Describe what nodes the mechanic touches in the existing scene. Don't add yet — sketch first.

```
World/Player (CharacterBody3D)               # existing
├── CollisionShape3D                          # existing
├── Camera3D                                  # existing
├── DoubleJumpFX (GPUParticles3D)             # NEW — particles on second jump
├── JumpAudio (AudioStreamPlayer3D)           # NEW — input + apex cues
└── (script: player_controller.gd, modify)    # MODIFY — add _can_double_jump state
```

Show this to the user. Ask:

> Node-graph plan above. May I add `DoubleJumpFX` and `JumpAudio` to `./World/Player`, and modify `player_controller.gd` to add the double-jump logic?

### 6. Scaffold via MCP

**Preferred (Summer MCP):**

```
summer_get_scene_tree()                     # confirm Player exists where expected
summer_add_node(scenePath="res://main.tscn", parent="./World/Player", type="GPUParticles3D", name="DoubleJumpFX")
summer_set_prop(scenePath="res://main.tscn", path="./World/Player/DoubleJumpFX", key="emitting", value="false")
summer_add_node(scenePath="res://main.tscn", parent="./World/Player", type="AudioStreamPlayer3D", name="JumpAudio")
summer_input_map_bind(name="jump", events=[{"type": "key", "key": "Space"}])   # idempotent
summer_save_scene(scenePath="res://main.tscn")
summer_get_script_errors(path="res://scripts/player_controller.gd")
```

Argument notes, all of which the tool schema enforces:

- `scenePath` is required on `summer_add_node`, `summer_set_prop` and
  `summer_save_scene`. It names the exact `res://` scene; there is no
  "current scene" default.
- `summer_set_prop` takes named `path` / `key` / `value` — not positional.
- `summer_input_map_bind` events are dicts. `{"type": "key", "key": "Space"}`
  works; key names go through Godot's keycode table, so `W`, `Space`, `Shift`,
  `Escape` resolve and typos silently produce no event.
- `summer_get_script_errors` checks one file and requires `path`. Use
  `summer_get_diagnostics()` (no args) for a project-wide check.

**Fallback (no MCP):** Print the `.tscn` snippet for the user to paste:

```
[node name="DoubleJumpFX" type="GPUParticles3D" parent="Player"]
emitting = false
amount = 16
lifetime = 0.4

[node name="JumpAudio" type="AudioStreamPlayer3D" parent="Player"]
```

### 7. Write the GDScript stub

Stub only — implementation is the next session. Typed GDScript throughout (see `gdscript-patterns`). For double-jump:

```gdscript
class_name PlayerController
extends CharacterBody3D

# Tunables
@export var jump_velocity: float = 4.5
@export var double_jump_velocity: float = 4.0
@export var double_jump_air_control: float = 0.7
@export var input_buffer_time: float = 0.1

# State
var _can_double_jump: bool = false
var _input_buffer_t: float = 0.0

@onready var fx: GPUParticles3D = $DoubleJumpFX
@onready var audio: AudioStreamPlayer3D = $JumpAudio

signal jumped
signal double_jumped

func _physics_process(delta: float) -> void:
    _input_buffer_t = max(0.0, _input_buffer_t - delta)

    if Input.is_action_just_pressed("jump"):
        _input_buffer_t = input_buffer_time

    if _input_buffer_t > 0.0:
        if is_on_floor():
            velocity.y = jump_velocity
            _can_double_jump = true
            _input_buffer_t = 0.0
            jumped.emit()
        elif _can_double_jump:
            velocity.y = double_jump_velocity
            _can_double_jump = false
            _input_buffer_t = 0.0
            fx.emitting = true
            audio.play()
            double_jumped.emit()

    move_and_slide()
```

Ask:

> May I write `scripts/player_controller.gd` (or merge into the existing script if one is attached)?

### 8. Save the design doc

Always write the design doc — it's the artifact the next session reads. Path: `.summer/mechanics/<mechanic-name>.md`.

```markdown
# Mechanic: Double-Jump

**Input:** Tap Space mid-air. Buffered 0.1s before ground.
**Response:** velocity.y = double_jump_velocity. `_can_double_jump` flag false.
**Feedback:**
- Visual: GPUParticles3D burst, 0.1s slow-mo on apex
- Audio: short whoosh on input
- Mechanical: 70% air control on second jump
**Failure modes:**
- Already used → silent ignore
- During wall-slide → counts as airborne
- Cutscene → input gated
- Spam → buffered (0.1s window)
**Depth:**
- Resource the player chooses when to spend
- Level design pairs every gap with a near-future threat
**Tunables:** see @export vars in player_controller.gd
**Open questions:** <list any the user couldn't answer>
```

Ask:

> May I create `.summer/mechanics/double-jump.md` with this design doc?

## Common mistakes

| Mistake | Fix |
|---|---|
| Designing the system, not the verb | "Combat" is a system. "Parry" is a mechanic. Pick the verb. |
| Skipping mechanical-feel in feedback | Visual + audio alone produce hollow mechanics. Mechanical difference is required. |
| No failure modes | Players spam, edge into states you didn't plan for, and find the hole. Plan the failure cases up front. |
| Hand-wave depth | "Players will use it strategically" is not depth. Name the choice the player makes. |
| Tunables hard-coded as `const` | Use `@export` so designers tune in the inspector. |
| Adding the mechanic without the FX/audio nodes | Without nodes for feedback, the mechanic ships feeling cheap. Scaffold the nodes alongside the script. |
| Setting `position` for movement instead of `velocity` | Physics objects use `velocity` in `_physics_process`. |
| Calling SetResourceProperty before the property holds a resource | Explicit `resource is null` error, not a silent drop. Assign the resource first (`summer_set_prop key="mesh" value="BoxMesh"`), then set its sub-properties. Scene-embedded sub_resources are fully supported targets. |

## Collaborative protocol

This skill writes scene nodes and one or more files (`.gd`, `.summer/mechanics/<name>.md`). Group writes into one ask per phase.

## Want a working starter?

For full character mechanics in a runnable starter:

- FPS variant → `template-id: template-3d-fps` (https://github.com/SummerEngine/FPS-template-Summer-Engine)
- Platformer → `template-id: template-3d-platformer` (TBD)

This skill is a workflow that designs and scaffolds — the templates are runnable bases the mechanic plugs into.

## See also

- `scene-and-project/brainstorm-game/SKILL.md` — produces `.summer/GameSoul.md` this skill reads
- `level-design/design-level/SKILL.md` — design the levels that exercise the mechanic
- `character-controllers/fps-controller/SKILL.md` — FPS movement scaffolding
- `scripting-patterns/state-machine-patterns/SKILL.md` — state machines for complex mechanics
- `audio/audio-direction/SKILL.md` — defines the SFX vocabulary the mechanic draws from
