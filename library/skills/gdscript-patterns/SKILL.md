---
name: gdscript-patterns
description: Use when writing or refactoring GDScript — type hints, signals, exports, onready, lifecycle methods (`_ready` vs `_process` vs `_physics_process`), `get_node` vs `$NodePath`, naming conventions. Trigger on "GDScript", "script", "signals", "exports", "onready", "_ready", "_process".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: scripting-patterns
user-invocable: false
allowed-tools: Read Grep summer_get_script_errors
paths: ["**/*.gd"]
---

# GDScript Patterns for Summer Engine

When writing GDScript for Summer Engine projects, follow these patterns. They align with Godot 4.x conventions and work well with MCP scene operations.

## Type Hints

Always use type hints for clarity and editor support:

```gdscript
var health: int = 100
var speed: float = 5.0
var player_name: String = ""
var velocity: Vector3 = Vector3.ZERO
var is_alive: bool = true
```

For nodes, use typed references:

```gdscript
@onready var collision_shape: CollisionShape3D = $CollisionShape3D
@onready var camera: Camera3D = $Camera3D
```

## Signals

Define signals at the top of the script, then emit them:

```gdscript
signal died
signal health_changed(new_health: int)
signal item_collected(item_name: String)

func take_damage(amount: int) -> void:
    health -= amount
    health_changed.emit(health)
    if health <= 0:
        died.emit()
```

When connecting via MCP, use `summer_connect_signal` with the emitter path, signal name, receiver path, and method name. The receiver script must have the method defined.

## Exports

Use `@export` for inspector-editable properties:

```gdscript
@export var move_speed: float = 5.0
@export var jump_force: float = 10.0
@export var max_health: int = 100
@export var can_double_jump: bool = false
```

Exports appear in the inspector. MCP can set initial values via `summer_set_prop` after the node exists, but exports are best for values the designer tweaks.

## Lifecycle Methods

| Method | When it runs | Use for |
|--------|--------------|---------|
| `_ready()` | Once when node enters tree | Initialization, getting node references |
| `_process(delta: float)` | Every frame | UI, non-physics logic |
| `_physics_process(delta: float)` | Every physics frame (fixed) | Movement, physics, collision |

For character movement, use `_physics_process` and `move_and_slide()`.

## Node Access

```gdscript
# Prefer $ for direct children
var camera = $Camera3D

# get_node() for dynamic paths
var target = get_node("../Enemy/HealthBar")

# get_parent() / get_children() when needed
var siblings = get_parent().get_children()
```

## Common Patterns

For health systems, input handling, and state machines, see [reference.md](reference.md).

## Anti-patterns — introspection traps

Godot's introspection API has Object-instance methods that look like they should work on script-class references. They don't. Calling them on a `const ScriptName = preload(...)` reference is a parse error, not a runtime no-op.

| Wrong | Right | Why |
|---|---|---|
| `if SomeScript.has_static_method("play"): SomeScript.play(...)` | Just call `SomeScript.play(...)` directly. If the method exists in the script, it parses; if not, the parser catches it. | `has_static_method()` is an `Object` instance method. `SomeScript` here is a `Script` reference. It has no `has_static_method` member, so the parser rejects the call. |
| `if SomeScript.has_method("foo")` (on a script-class ref) | Same. Call `foo()` directly, or check `is_instance_of()` after instancing. | Same trap. |
| Defensive guards "in case the script ships in parallel" | Don't ship in parallel agents that depend on each other's APIs without one of them landing first. The compiler will catch missing methods at parse time. | Guards that don't compile aren't guards. |

**Rule of thumb:** if you're tempted to write `Klass.has_*("name")` on a `const Klass = preload(...)` reference, you're confusing class-level introspection (compile-time, automatic) with instance-level introspection (`Object` method, runtime). GDScript's parser already does the compile-time check for free.

**Side note on `has_method` vs `has_static_method`:** `has_method` works on a node/instance to check if the *instance* has a method. `has_static_method` works on an *Object* instance to check if its *class* has a static method. Neither is callable on a bare `Script` reference (`preload(...)` result). To check static-method presence at runtime, call the method inside a `try`-equivalent. In practice if your code paths are well-typed you don't need to.

## Anti-pattern — `@onready var = $Path` on nodes that don't exist on every variant

Godot resolves `$Path` (the `get_node` shorthand) at `@implicit_ready` time. If the node is missing from the current scene, you get `Node not found: "X" (relative to "Y")` errors before any of your `_ready()` runtime guards can run.

Common case: a script is shared by multiple scene variants where some variants have an optional child. Even if every code path that touches the variable has a `if inventory_ui:` guard, the `@onready` line itself errors at scene load.

| Wrong | Right |
|---|---|
| `@onready var inventory_ui: CanvasLayer = $InventoryUI` | `@onready var inventory_ui: CanvasLayer = get_node_or_null("InventoryUI")` |
| `@onready var hp_bar: ProgressBar = $HUD/HPBar` (HUD optional) | `@onready var hp_bar: ProgressBar = get_node_or_null("HUD/HPBar")` |

**Rule of thumb:** if the node is required for the script to function at all, use `$Path` and rely on the parse-time error. If the node may be missing in some scene variants the script is reused across, use `get_node_or_null` and guard at every read site.

## Anti-pattern — `Label3D.label_settings` (it doesn't exist)

`LabelSettings` is a resource type used by `Label` (the 2D Control node) to bundle font + size + outline + colors. `Label3D` does NOT accept it. Assigning `LabelSettings` to `label_settings` on a `Label3D` raises `Invalid assignment of property or key 'label_settings' with value of type 'LabelSettings' on a base object of type 'Label3D'.`

`Label3D` exposes the same styling fields as direct properties:

```gdscript
# WRONG - parses but errors at runtime when label is a Label3D.
var settings := LabelSettings.new()
settings.font = my_font
settings.font_size = 24
settings.outline_size = 2
settings.outline_color = my_outline
my_label_3d.label_settings = settings  # <-- runtime error

# RIGHT - set the styling directly on the Label3D.
my_label_3d.font = my_font
my_label_3d.font_size = 24
my_label_3d.outline_size = 2
my_label_3d.outline_modulate = my_outline
```

Note the field name difference too: `LabelSettings.outline_color` (Label 2D) vs `Label3D.outline_modulate` (Label3D). Easy to miss in copy-paste.

**Rule of thumb:** `LabelSettings` is for `Label` only. For `Label3D` use direct properties. For `RichTextLabel`, neither — it has its own theme overrides.

## Scene Integration

When the AI adds a node with Summer MCP tools and attaches a script, the script path is set via `summer_set_prop(path, "script", "res://path/to/script.gd")`. The script file must exist first. Create it with guarded `summer_write_file` or edit it with `summer_replace_text`, then attach the script and connect scene signals.

For signal connections, the receiver must have the handler method. Create the script with the method stub before calling `summer_connect_signal`.
