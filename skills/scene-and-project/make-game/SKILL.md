---
name: make-game
description: End-to-end game creation workflow that orchestrates project setup, asset creation, scene building, scripting, and testing. Use when the user wants to build a complete game from scratch or says "make me a game". Trigger on "make a game", "build me a game", "create a new game".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: scene-and-project
user-invocable: false
allowed-tools: Read Grep Glob Write Edit summer_get_project_context summer_get_agent_playbook summer_create_scene summer_open_scene summer_save_scene summer_add_node summer_set_prop summer_set_resource_property summer_instantiate_scene summer_play summer_stop summer_get_diagnostics
paths: ["**/*.gd", "**/*.tscn", "**/project.godot"]
---

# Make a Game with Summer Engine

Step-by-step workflow for building a complete game. Follow phases 0-6 in order. Each phase must complete before moving to the next.

**Rule**: Scene operations (.tscn) use Summer MCP tools. Script files (.gd) use the host agent's normal file-editing tools. Never cross the streams.

---

## Phase 0: Gather Requirements

Before touching any tools, ask the user:
1. **What kind of game?** (platformer, FPS, top-down, puzzle, racing, etc.)
2. **2D or 3D?**
3. **Art style?** (realistic, low-poly, cartoon, pixel art)
4. **Core mechanic?** One sentence. ("player jumps between platforms collecting coins")
5. **Scope?** (1 level prototype, or multi-level)

Use this decision matrix:

| Genre | Root Type | Camera | Player Body | Dimension |
|-------|-----------|--------|-------------|-----------|
| FPS | Node3D | Camera3D on player | CharacterBody3D | 3D |
| Platformer 2D | Node2D | Camera2D following | CharacterBody2D | 2D |
| Platformer 3D | Node3D | Camera3D following | CharacterBody3D | 3D |
| Top-down | Node2D | Camera2D | CharacterBody2D | 2D |
| Puzzle | Node2D or Control | Camera2D or none | varies | 2D |
| Racing | Node3D | Camera3D behind car | VehicleBody3D | 3D |

---

## Phase 1: Project Bootstrap

### 1a. Get context

```
summer_get_agent_playbook()
summer_get_project_context()
```

If a scene is open: `summer_get_scene_tree()` to see what exists.

### 1b. Configure project

```
summer_project_setting(key="application/config/name", value="<game name>")
summer_project_setting(key="display/window/size/viewport_width", value=1280)
summer_project_setting(key="display/window/size/viewport_height", value=720)
summer_project_setting(key="application/run/main_scene", value="res://scenes/main_level.tscn")
```

For 2D pixel art, add:
```
summer_project_setting(key="rendering/textures/canvas_textures/default_texture_filter", value=0)
```

### 1c. Create scenes

```
summer_create_scene(path="res://scenes/main_level.tscn", rootName="World", allow_temporary_scene_mutation=true)
summer_create_scene(path="res://scenes/player.tscn", rootName="Player", allow_temporary_scene_mutation=true)
```

### 1d. Folder conventions

- `res://scenes/` -- .tscn files
- `res://scripts/` -- .gd files
- `res://assets/models/` -- 3D models
- `res://assets/textures/` -- images, sprites
- `res://assets/audio/` -- sounds, music

---

## Phase 2: Asset Pipeline

Pick the right strategy per asset. Prefer this order: Library > Generate > Primitives.

### Strategy A: Asset Library (fastest, 25k+ free models)

For environment props, furniture, nature, vehicles:

```
summer_search_assets(query="low-poly tree", assetType="3d_model", limit=5)
summer_import_asset(query="wooden barrel", parent="./World/Props", assetType="3d_model")
```

### Strategy B: AI Generation (custom assets)

**Images** (textures, sprites, UI art) -- sync, returns immediately:
```
summer_generate_image(prompt="top-down grass tileset, seamless, 512x512", style="cartoon")
```
Returns `localPath` -- use Read tool to show the user for approval.
Then import:
```
summer_import_from_url(url="<asset.fileUrl>", path="res://assets/textures/grass.png")
```

**3D models** -- async, waits up to 5 min by default:
```
summer_generate_3d(prompt="low-poly treasure chest with gold coins", kind="text-to-3d")
```
Returns completed result directly. Then import the model URL.

**Image-to-3D** -- generate concept art first, then convert:
```
summer_generate_image(prompt="medieval sword, ornate handle, game asset, white background")
# Show to user, get approval
summer_generate_3d(kind="image-to-3d", imageUrl="<asset.fileUrl>")
```

**Audio** -- sync:
```
summer_generate_audio(capability="sound_effects", text="sword swing whoosh")
summer_generate_audio(capability="music", prompt="upbeat adventure theme", durationSeconds=30)
summer_generate_audio(capability="text_to_speech", text="Welcome, adventurer!", voiceId="<id>")
```

**Parallel generation**: Start multiple 3D jobs with `wait=false`, work on scene setup, then check later:
```
summer_generate_3d(prompt="...", wait=false)  -> jobId: "abc"
summer_generate_3d(prompt="...", wait=false)  -> jobId: "def"
# ... do scene work ...
summer_check_job(jobId="abc")
summer_check_job(jobId="def")
```

### Strategy C: Primitive Meshes (instant, offline)

For prototyping or blocking out levels:
```
summer_add_node(parent="./World", type="MeshInstance3D", name="Floor")
summer_set_prop(path="./World/Floor", key="mesh", value="BoxMesh")
summer_set_resource_property(nodePath="./World/Floor", resourceProperty="mesh", subProperty="size", value="Vector3(20, 0.2, 20)")
```

---

## Phase 3: Scene Construction

### 3a. Build environment with batch

Use `summer_batch` for multi-step setup in one undo step:

```
summer_batch(ops=[
  {"op":"AddNode","parent":"./","type":"Node3D","name":"Level"},
  {"op":"AddNode","parent":"./Level","type":"MeshInstance3D","name":"Ground"},
  {"op":"SetProp","path":"./Level/Ground","key":"mesh","value":"PlaneMesh"},
  {"op":"SetResourceProperty","nodePath":"./Level/Ground","resourceProperty":"mesh","subProperty":"size","value":"Vector2(50,50)"},
  {"op":"AddNode","parent":"./","type":"DirectionalLight3D","name":"Sun"},
  {"op":"SetProp","path":"./Sun","key":"rotation_degrees","value":"Vector3(-45,30,0)"},
  {"op":"SetProp","path":"./Sun","key":"shadow_enabled","value":"true"},
  {"op":"AddNode","parent":"./","type":"WorldEnvironment","name":"Env"}
])
```

### 3b. Build player

**3D FPS/Third-person:**
```
summer_open_scene(path="res://scenes/player.tscn")
summer_batch(ops=[
  {"op":"AddNode","parent":"./","type":"CollisionShape3D","name":"Collision"},
  {"op":"SetProp","path":"./Collision","key":"shape","value":"CapsuleShape3D"},
  {"op":"AddNode","parent":"./","type":"Camera3D","name":"Camera"},
  {"op":"SetProp","path":"./Camera","key":"position","value":"Vector3(0,1.6,0)"}
])
```

**2D Platformer:**
```
summer_open_scene(path="res://scenes/player.tscn")
summer_batch(ops=[
  {"op":"AddNode","parent":"./","type":"CollisionShape2D","name":"Collision"},
  {"op":"SetProp","path":"./Collision","key":"shape","value":"RectangleShape2D"},
  {"op":"AddNode","parent":"./","type":"Sprite2D","name":"Sprite"},
  {"op":"AddNode","parent":"./","type":"Camera2D","name":"Camera"}
])
```

### 3c. Input bindings

```
summer_input_map_bind(name="move_forward", events=[{"type":"key","key":"W"}])
summer_input_map_bind(name="move_back", events=[{"type":"key","key":"S"}])
summer_input_map_bind(name="move_left", events=[{"type":"key","key":"A"}])
summer_input_map_bind(name="move_right", events=[{"type":"key","key":"D"}])
summer_input_map_bind(name="jump", events=[{"type":"key","key":"Space"}])
summer_input_map_bind(name="interact", events=[{"type":"key","key":"E"}])
```

### 3d. Place assets in scene

```
summer_open_scene(path="res://scenes/main_level.tscn")
summer_instantiate_scene(parent="./Level", scene="res://scenes/player.tscn", name="Player")
summer_instantiate_scene(parent="./Level", scene="res://assets/models/tree.glb", name="Tree1")
summer_set_prop(path="./Level/Tree1", key="position", value="Vector3(5, 0, 3)")
```

### 3e. Save

```
summer_save_scene()
```

---

## Phase 4: Scripting

**Write .gd files with the host agent's normal file-editing tools. Attach via MCP.**

Workflow:
1. Write the script file to disk
2. Attach: `summer_set_prop(path="./Player", key="script", value="res://scripts/player.gd")`
3. Check: `summer_get_script_errors(path="res://scripts/player.gd")`
4. Wire signals: `summer_connect_signal(emitter="./Coin", signal="body_entered", receiver="./Coin", method="_on_body_entered")`

### 3D Player Controller (FPS)

Write to `res://scripts/player.gd`:

```gdscript
extends CharacterBody3D

@export var speed: float = 5.0
@export var jump_velocity: float = 4.5
@export var mouse_sensitivity: float = 0.002

var gravity: float = ProjectSettings.get_setting("physics/3d/default_gravity")

func _ready() -> void:
    Input.mouse_mode = Input.MOUSE_MODE_CAPTURED

func _unhandled_input(event: InputEvent) -> void:
    if event is InputEventMouseMotion:
        rotate_y(-event.relative.x * mouse_sensitivity)
        $Camera.rotate_x(-event.relative.y * mouse_sensitivity)
        $Camera.rotation.x = clampf($Camera.rotation.x, -PI/2, PI/2)
    if event.is_action_pressed("ui_cancel"):
        Input.mouse_mode = Input.MOUSE_MODE_VISIBLE

func _physics_process(delta: float) -> void:
    if not is_on_floor():
        velocity.y -= gravity * delta

    if Input.is_action_just_pressed("jump") and is_on_floor():
        velocity.y = jump_velocity

    var input_dir := Input.get_vector("move_left", "move_right", "move_forward", "move_back")
    var direction := (transform.basis * Vector3(input_dir.x, 0, input_dir.y)).normalized()

    if direction:
        velocity.x = direction.x * speed
        velocity.z = direction.z * speed
    else:
        velocity.x = move_toward(velocity.x, 0, speed)
        velocity.z = move_toward(velocity.z, 0, speed)

    move_and_slide()
```

### 2D Platformer Controller

Write to `res://scripts/player.gd`:

```gdscript
extends CharacterBody2D

@export var speed: float = 200.0
@export var jump_velocity: float = -350.0

var gravity: float = ProjectSettings.get_setting("physics/2d/default_gravity")

func _physics_process(delta: float) -> void:
    if not is_on_floor():
        velocity.y += gravity * delta

    if Input.is_action_just_pressed("jump") and is_on_floor():
        velocity.y = jump_velocity

    var direction := Input.get_axis("move_left", "move_right")
    velocity.x = direction * speed if direction else move_toward(velocity.x, 0, speed)

    move_and_slide()
```

### Collectible Pickup

Write to `res://scripts/collectible.gd`:

```gdscript
extends Area3D

signal collected

func _ready() -> void:
    body_entered.connect(_on_body_entered)

func _on_body_entered(body: Node3D) -> void:
    if body.is_in_group("player"):
        collected.emit()
        queue_free()
```

### Simple Enemy Patrol

Write to `res://scripts/enemy_patrol.gd`:

```gdscript
extends CharacterBody3D

@export var speed: float = 2.0
@export var patrol_distance: float = 5.0

var start_pos: Vector3
var direction: float = 1.0
var gravity: float = ProjectSettings.get_setting("physics/3d/default_gravity")

func _ready() -> void:
    start_pos = global_position

func _physics_process(delta: float) -> void:
    if not is_on_floor():
        velocity.y -= gravity * delta

    velocity.x = direction * speed
    move_and_slide()

    if global_position.distance_to(start_pos) > patrol_distance:
        direction *= -1
```

---

## Phase 5: Test and Debug

```
summer_clear_console()
summer_play()
```

After a few seconds:
```
summer_get_diagnostics()
```

If errors:
```
summer_get_console(type="error")
summer_get_script_errors(path="res://scripts/player.gd")
```

Fix, then:
```
summer_stop()
# apply fix
summer_play()
```

### Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| "Node not found" | Bad $NodePath | Check path with `summer_get_scene_tree()` |
| "Invalid call" on move_and_slide | Wrong base class | Script must extend CharacterBody3D/2D |
| Falling through floor | No collision | Add StaticBody3D + CollisionShape3D to ground |
| "No main scene" | Not configured | `summer_project_setting(key="application/run/main_scene", ...)` |
| Mouse not captured | Missing in _ready | Add `Input.mouse_mode = Input.MOUSE_MODE_CAPTURED` |

---

## Phase 6: Iterate

After first playable, ask the user what to improve. Common next steps:

- **More levels**: Create new .tscn, instantiate player, add to scene list
- **Enemies**: New scene + patrol script + spawn in level
- **UI/HUD**: Add CanvasLayer + Control nodes (see ui-basics skill)
- **Sound**: Generate with `summer_generate_audio`, attach AudioStreamPlayer3D
- **Lighting**: Set up WorldEnvironment + lights (see 3d-lighting skill)
- **Game states**: Main menu > gameplay > game over flow via SceneTree.change_scene_to_file()

---

## Anti-Patterns

- Never write .tscn files with host agent file tools -- always use Summer MCP scene tools
- Never guess node paths -- call `summer_get_scene_tree()` first
- Never edit scenes while game is running -- call `summer_stop()` first
- Never skip `summer_save_scene()` -- unsaved changes are editor-only
- Script .gd files must exist on disk BEFORE attaching via `summer_set_prop`
- `summer_create_scene` requires `allow_temporary_scene_mutation=true`
- Node paths use `./` prefix. File paths use `res://` prefix. Never mix them.

---

## Tool Quick Reference

| Category | Tool | Purpose |
|----------|------|---------|
| Setup | `summer_get_agent_playbook` | Safe workflow guide |
| Setup | `summer_get_project_context` | Project name, paths, status |
| Setup | `summer_project_setting` | Set project.godot values |
| Scene | `summer_create_scene` | New scene file |
| Scene | `summer_open_scene` | Switch to scene |
| Scene | `summer_get_scene_tree` | Read scene structure |
| Scene | `summer_save_scene` | Save to disk |
| Nodes | `summer_add_node` | Add node |
| Nodes | `summer_set_prop` | Set property |
| Nodes | `summer_set_resource_property` | Set sub-resource prop |
| Nodes | `summer_remove_node` | Delete node |
| Nodes | `summer_instantiate_scene` | Place .tscn/.glb |
| Nodes | `summer_batch` | Multi-op, one undo |
| Nodes | `summer_connect_signal` | Wire signals |
| Nodes | `summer_inspect_node` | Read node details |
| Input | `summer_input_map_bind` | Bind keys to actions |
| Assets | `summer_search_assets` | Search 25k+ library |
| Assets | `summer_import_asset` | Search + import + place |
| Assets | `summer_import_from_url` | Import from URL |
| Generate | `summer_generate_image` | AI image gen |
| Generate | `summer_generate_audio` | AI audio/SFX/music |
| Generate | `summer_generate_3d` | AI 3D model gen |
| Generate | `summer_generate_video` | AI video gen |
| Generate | `summer_check_job` | Poll async jobs |
| Debug | `summer_play` | Run game |
| Debug | `summer_stop` | Stop game |
| Debug | `summer_get_diagnostics` | Error overview |
| Debug | `summer_get_console` | Read output |
| Debug | `summer_get_script_errors` | Check .gd compile |
| Debug | `summer_clear_console` | Clear output |

---

## Collaborative protocol

This skill orchestrates a full game build — many writes across scenes, scripts, and project settings. Always ask before each phase: "May I bootstrap the project (scenes, project.godot, folders)?", "May I generate the assets (image + 3D) for X, Y, Z?", "May I scaffold the player scene + attach `player.gd`?". Group related writes into one ask per phase, never bulk-write across phases. See `../../_shared/collaborative-protocol.md`.

## Fallback

No fallback for this — Summer MCP required. The whole point of `make-game` is the orchestration layer over `summer_*` tools. If MCP isn't connected, fall back to running the individual sub-skills (`fps-controller`, `3d-lighting`, etc.) which each document their own MCP-or-`.tscn` fallback paths.
