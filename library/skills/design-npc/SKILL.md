---
name: design-npc
description: Use when the user wants to design an enemy, NPC, boss, companion, civilian, or wave-spawned mob's behavior. Walks perception, personality knobs, intent layer, action state machine, telegraphs, defeat handling, and group emergence — outputs a state-machine GDScript stub plus the recommended node tree. Trigger on "enemy", "NPC", "boss", "companion", "AI", "behavior", "mob", "perception", "design enemy".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: ai-and-npcs
user-invocable: true
allowed-tools: Read Grep Edit Write summer_get_scene_tree summer_inspect_node summer_add_node summer_set_prop summer_set_resource_property summer_connect_signal summer_save_scene summer_get_script_errors summer_input_map_bind
paths: ["**/*.gd", "**/*.tscn"]
---

# /design-npc — Design an NPC's Behavior End-to-End

## Overview

A good NPC is legible and *alive*. The player can read its mood, predict its next move, and feel the consequence of theirs — and the four enemies in a patrol squad don't all behave like clones of one designer-authored script. This skill walks the canonical NPC AI pattern from the inside out: what the NPC perceives, what it *wants* (intent), what it *does* (action), what tells signal each state, and how it dies.

**Core principle:** behavior is what the player *sees*. Two layers separate doing from wanting: an action state machine the body runs, and an intent layer above it that reads perception + personality and tells the action SM what to aim at.

**Second principle:** identical NPCs are predictable, and predictable is boring. Every spawned instance jitters its personality knobs so a squad of four grunts produces emergent variety with zero designer authoring.

## Steps

### 1. Pick the NPC archetype

Open with the question. Wait.

> What's the NPC for? Pick the closest:
> - **Basic enemy** (melee/ranged grunt, dies in 1–3 hits)
> - **Boss** (named, scripted phases, 30–120 sec fight)
> - **Quest-giver** (talks, gives objectives, doesn't fight)
> - **Friendly companion** (follows player, helps in combat)
> - **Civilian / ambient** (reacts to events, no combat AI)
> - **Wave-spawned mob** (cheap, many at once, simple behavior)

Each archetype maps to a different complexity budget:

| Archetype | Action states | Intents | Perception | Personality range |
|---|---|---|---|---|
| Basic enemy | 4 (calm / alert / aggressive / defeated) | 5 (idle / investigate / hunt / kill / retreat) | Sight cone + LOS raycast | Wide |
| Boss | 6–10 (per phase) | 5–7 incl. `RESCUE_ALLY` | Sight + hearing + scripted | Narrow, biased high |
| Quest-giver | 2 (idle / talking) | 1 (idle) | Trigger area | None — fixed |
| Companion | 5 | 4 (follow / support / engage / retreat) | Sight + group | Narrow, biased low aggression |
| Civilian | 3 (wander / panic / dead) | 2 (idle / retreat) | Hearing | Caution biased high |
| Wave mob | 2 (charge / dead) | 1 (kill) | Direct line to player | None |

### 2. Walk the design pillars

Walk them in order. Don't skip. The pillars are **Perception → Personality → Intent → Action → Telegraph → Defeat**.

#### a) Perception — what does this NPC sense?

Pick the minimum. Over-perception = unfair AI.

| Sensor | Node | Cost | Use case |
|---|---|---|---|
| Sight cone | RayCast3D + dot product check | Cheap | Standard enemy |
| Sphere proximity | Area3D with sphere shape | Cheap | "Felt your presence" / aggro range |
| Hearing event | Signal from world events | Cheapest | Alert nearby NPCs |
| Group awareness | Shared signal bus (autoload) | Cheap | Pack tactics, rescue intent |

Recommended setup for a basic enemy:

```
Enemy (CharacterBody3D)
├── MeshInstance3D
├── CollisionShape3D
├── Vision (Area3D)        # sphere shape, radius = sight range
│   └── CollisionShape3D
└── Sight (RayCast3D)      # confirms LOS for candidates inside Vision
```

Two-step (Area3D filter, then RayCast LOS) is the right default. Don't raycast to every potential target every frame.

#### b) Personality — four floats that make this NPC *not* a clone

Every NPC instance gets **four knobs**, each in `[0.0, 1.0]`, declared as `@export_range` so designers can tune the *base* per archetype, then **randomized per-instance at `_ready`** so spawned siblings differ.

| Knob | What it controls | High value reads as | Low value reads as |
|---|---|---|---|
| `aggression` | How fast the intent layer escalates to `KILL`; shorter pre-attack hesitation | Berserker that closes distance | Cautious skirmisher that waits |
| `patience` | How long the NPC stays in `INVESTIGATE` before giving up; tolerance for circling without attacking | Will hunt the player across the level | Loses interest quickly, returns to patrol |
| `caution` | How eagerly it breaks line-of-sight when hurt; how often it backs off after a hit trade | Kites and uses cover | Trades blows recklessly |
| `punishment` | Probability of swapping intent to `KILL` when the player is recovering, reloading, healing | Punishes whiffs and animation locks | Lets the player breathe |

**Threshold mapping** (used inside the intent layer): `engage_threshold = 2.0 - aggression` (higher aggression = engage faster), `search_duration = 4.0 + patience * 6.0` (patient NPC searches up to 10s), `break_los_chance = caution * (1 - hp_ratio)` (cautious AND hurt = break LOS), and `should_punish() = randf() < punishment` (rolled when the player is recovering / reloading).

Declare the knobs as `@export_range(0.0, 1.0)` so each archetype scene tunes them per-instance, and jitter them by `+/- personality_jitter` (default 0.15) inside `_ready` — same script + same archetype scene produces NPCs whose feel is shaped by four numbers alone. Full example in the script stub at step 7.

#### c) Intent layer — what the NPC is *trying* to do

The intent layer sits **above** the action SM. It runs each tick, reads perception + personality + group state, and writes a single `current_intent`. The action SM reads `current_intent` to pick its transitions; it never sets intent itself. See `_decide_intent` in the stub (step 7) for the canonical priority order: `RESCUE_ALLY` > `RETREAT` (low HP + caution) > `KILL` (pressure built) > `INVESTIGATE` (lost LOS, within memory) > `HUNT` (LOS, out of range) > `PATROL` / `IDLE`.

Five-to-seven intents is the sweet spot:

| Intent | When | Effect on action SM |
|---|---|---|
| `IDLE` | No target, no patrol route | Action SM stays in `Calm` |
| `PATROL` | No target, route exists | `Calm`, walks the path |
| `INVESTIGATE` | Lost LOS, within memory window | `Alert`, moves to last-known position |
| `HUNT` | LOS, out of attack range | `Alert/Aggressive`, closes distance |
| `KILL` | LOS, in attack range, pressure built | `Aggressive`, executes attack |
| `RETREAT` | Low HP and high caution, OR over-extended | `Alert`, moves away, breaks LOS |
| `RESCUE_ALLY` | Allied NPC emitted `needs_help` | `Alert`, moves to ally |

The action SM's job is now narrow: given an intent, what locomotion + animation + hitbox state matches?

#### d) Action SM — what the body is *currently doing*

Four states is plenty for a basic enemy. They are the visible mood, not the goal.

```gdscript
enum State { CALM, ALERT, AGGRESSIVE, DEFEATED }
```

| State | Reads intent | Animation | Audio | VFX |
|---|---|---|---|---|
| `CALM` | `IDLE`, `PATROL` | Breathing loop, look-around | Ambient | None |
| `ALERT` | `INVESTIGATE`, `HUNT`, `RETREAT`, `RESCUE_ALLY` | Posture up, head tracks target | "Huh?" / radio | Eye glow |
| `AGGRESSIVE` | `KILL` | Combat pose, weapon raised, swing windup | Battle cry | Muzzle flash / windup glow |
| `DEFEATED` | (terminal) | Death anim → ragdoll | Death sound | Loot drop / dissolve |

Action transitions are computed from `current_intent` and a few action-local conditions (HP, animation locks). The intent layer does not transition action states directly — it sets the *goal*, action follows.

#### e) Telegraph — every aggressive action has a tell

**Telegraph is non-negotiable for any attack.** 0.3–0.7 sec of windup the player can react to. Faster than 0.3 = "unfair"; slower than 0.7 = "boring". Personality bleeds into telegraph length:

```gdscript
func attack_windup_time() -> float:
    # high aggression = shorter hesitation, but never below 0.25
    return maxf(0.25, attack_telegraph * (1.5 - aggression))
```

Every aggressive action has at least one of: animation windup, audio cue, VFX glow, particle trail, hitbox preview. Cheap mobs can collapse all three into one anim — but the windup *must* exist.

#### f) Defeat — what happens when it dies

Plan it. "It just disappears" is bad. Choices:

- **Death animation** plays, body stays for N sec, then `queue_free`.
- **Ragdoll**: switch CollisionShape from CharacterBody3D to RigidBody3D for weight.
- **Loot drop**: spawn pickup at death position.
- **Cleanup**: leave any group, disconnect signals, free children.
- **Score / quest hook**: emit `died(global_position)` for the gameplay layer.
- **Group signal**: emit `ally_defeated` so squadmates can update their `RESCUE_ALLY` checks (or panic).

### 3. Group emergence — varied personality across a squad

When you spawn a squad of four with the same archetype but personality jittered per-instance, you get behavioral roles for free.

Worked example — four basic_grunts with `aggression` after jitter at `0.3 / 0.5 / 0.7 / 0.9`:

| Instance | aggression | Emergent role | Why |
|---|---|---|---|
| 1 | 0.3 | Sniper | Slow to engage, stays at range, builds pressure slowly |
| 2 | 0.5 | Anchor | Holds the line, neither rushes nor retreats |
| 3 | 0.7 | Flanker | Closes mid-fight, looks for openings |
| 4 | 0.9 | Berserker | Rushes immediately, short windups |

No designer authored "the sniper". The jitter on a single knob produced a four-role squad. Stack `caution` and `patience` on top and you get richer roles (a high-caution / low-aggression NPC reads as "the careful one who hangs back and supports"). The squad feels coordinated even though each NPC is making local decisions.

**Implementation note:** spawners should call `randomize()` once at `_ready` and let each NPC's own `_ready` handle the jitter. Don't try to author roles centrally — the variation *is* the design.

### 4. Read the scene to find an attach point

```
summer_get_scene_tree
summer_inspect_node "./World"
```

Identify where the NPC will live (an `Enemies` parent, or directly under World). Confirm the player exists for line-of-sight.

### 5. Propose the bundle

> I'm about to design a basic patrol-and-chase enemy with the personality + intent layer. Scene tree: Enemy (CharacterBody3D) + Vision Area3D + Sight RayCast3D + CollisionShape3D + MeshInstance3D. Script `scripts/enemy_ai.gd` with personality knobs (aggression / patience / caution / punishment), intent enum (IDLE / PATROL / INVESTIGATE / HUNT / KILL / RETREAT / RESCUE_ALLY), action SM (Calm / Alert / Aggressive / Defeated). Telegraph 0.3–0.7 sec, scaled by aggression. Drop loot on death, emit `died` signal. May I create the scene + script?

### 6. Build it

**Preferred (Summer MCP):**

Every tool below takes a required `scenePath` naming the exact `res://` scene;
it is written out on the first line and elided after for readability. Better
still, send the whole block as one `summer_batch(scenePath=..., ops=[...])` so
the user can undo the enemy with a single Ctrl+Z.

```
summer_add_node(scenePath="res://main.tscn", parent="./World/Enemies", type="CharacterBody3D", name="Enemy")
summer_add_node(parent="./World/Enemies/Enemy", type="CollisionShape3D", name="Body")
summer_add_node(parent="./World/Enemies/Enemy", type="MeshInstance3D", name="Mesh")
summer_add_node(parent="./World/Enemies/Enemy", type="Area3D", name="Vision")
summer_add_node(parent="./World/Enemies/Enemy/Vision", type="CollisionShape3D", name="VisionShape")
summer_add_node(parent="./World/Enemies/Enemy", type="RayCast3D", name="Sight")
summer_set_prop(path="./World/Enemies/Enemy/Sight", key="enabled", value="true")
summer_set_prop(path="./World/Enemies/Enemy/Sight", key="target_position", value="Vector3(0, 0, -12)")
```

Give the Vision area its sphere. Either form works — a class-name string embeds
the resource in the scene, a `res://` path reuses a shared one. Prefer the shared
`.tres` when several enemy archetypes want the same sight radius:

```
summer_set_prop(scenePath="res://main.tscn", path="./World/Enemies/Enemy/Vision/VisionShape", key="shape", value="res://shapes/vision_sphere.tres")
# or, embedded, then tune it:
summer_set_prop(scenePath="res://main.tscn", path="./World/Enemies/Enemy/Vision/VisionShape", key="shape", value="SphereShape3D")
summer_set_resource_property(scenePath="res://main.tscn", nodePath="./World/Enemies/Enemy/Vision/VisionShape", resourceProperty="shape", subProperty="radius", value="12.0")
```

`summer_set_resource_property` works against scene-embedded (`[sub_resource]`)
resources exactly as it does against external `.tres` files — it reads the
property off the node and writes the sub-property onto whatever Resource is
there. Structural failures are explicit errors (`node not found`, `property is
not a resource`, `resource is null`); a bad value shape is not — a JSON object
instead of a Godot literal string, a misspelled `subProperty`, or a wrong-typed
value returns `ok:true` yet silently no-ops or coerces destructively on current
engines. Pass class names and literal strings (`"12.0"`, `"Color(r, g, b, a)"`)
and confirm the result in the saved `.tscn`, never from `ok` alone. The order
that matters is: assign the resource first, then set sub-properties.

Connect signals:

```
summer_connect_signal(scenePath="res://main.tscn", emitter="./World/Enemies/Enemy/Vision", signal="body_entered", receiver="./World/Enemies/Enemy", method="_on_body_entered")
```

The parameters are `scenePath`, `emitter`, `signal`, `receiver`, `method`. There
is no `from` / `to`; those spellings fail schema validation. The same required
`scenePath` applies to `summer_add_node`, `summer_set_prop` and
`summer_save_scene` in the block above.

**Fallback (no MCP):** write the scene as `.tscn` text. Ask the user to paste their existing scene first, then propose a unified diff.

### 7. Drop the script

`scripts/enemy_ai.gd`:

```gdscript
class_name EnemyAI
extends CharacterBody3D

enum State { CALM, ALERT, AGGRESSIVE, DEFEATED }
enum Intent { IDLE, PATROL, INVESTIGATE, HUNT, KILL, RETREAT, RESCUE_ALLY }

# Tuning
@export var move_speed: float = 3.5
@export var attack_range: float = 2.0
@export var attack_telegraph: float = 0.5
@export var attack_damage: int = 10
@export var max_health: int = 30
@export var memory_duration: float = 8.0

# Personality (base, jittered at spawn)
@export_range(0.0, 1.0) var aggression: float = 0.5
@export_range(0.0, 1.0) var patience: float = 0.5
@export_range(0.0, 1.0) var caution: float = 0.3
@export_range(0.0, 1.0) var punishment: float = 0.5
@export var personality_jitter: float = 0.15

@onready var sight: RayCast3D = $Sight
@onready var vision: Area3D = $Vision
@onready var anim: AnimationPlayer = $AnimationPlayer

signal died(position: Vector3)
signal needs_help(who: Node3D)
signal ally_defeated(who: Node3D)

var _state: State = State.CALM
var current_intent: Intent = Intent.IDLE
var _target: Node3D = null
var _last_seen_pos: Vector3 = Vector3.ZERO
var _memory_timer: float = 0.0
var _intent_timer: float = 0.0
var _aggression_buildup: float = 0.0
var _retreat_desire: float = 0.0
var _health: int = 30

func _ready() -> void:
    _health = max_health
    aggression = clampf(aggression + randf_range(-personality_jitter, personality_jitter), 0.0, 1.0)
    patience   = clampf(patience   + randf_range(-personality_jitter, personality_jitter), 0.0, 1.0)
    caution    = clampf(caution    + randf_range(-personality_jitter, personality_jitter), 0.0, 1.0)
    punishment = clampf(punishment + randf_range(-personality_jitter, personality_jitter), 0.0, 1.0)
    vision.body_entered.connect(_on_body_entered)

func _physics_process(delta: float) -> void:
    if _state == State.DEFEATED:
        return
    _update_memory(delta)
    _update_intent(delta)
    _update_action(delta)
    move_and_slide()

# --- Intent layer (above action SM) -----------------------------------------

func _update_intent(delta: float) -> void:
    _intent_timer += delta
    if _state == State.AGGRESSIVE:
        _aggression_buildup += delta * (1.0 - patience) * 0.5
    else:
        _aggression_buildup = maxf(_aggression_buildup - delta * 0.3, 0.0)
    _retreat_desire = maxf(_retreat_desire - delta * 0.4, 0.0)

    var prev: Intent = current_intent
    current_intent = _decide_intent()
    if current_intent != prev:
        _intent_timer = 0.0

func _decide_intent() -> Intent:
    if _target == null:
        return Intent.IDLE
    var dist: float = global_position.distance_squared_to(_target.global_position)
    var attack_sq: float = attack_range * attack_range
    if _retreat_desire > 0.5:
        return Intent.RETREAT
    if _aggression_buildup > (2.0 - aggression) and dist < attack_sq:
        return Intent.KILL
    if not _has_line_of_sight(_target):
        return Intent.INVESTIGATE if _intent_timer < (4.0 + patience * 6.0) else Intent.IDLE
    if dist < attack_sq * 4.0:
        return Intent.HUNT
    return Intent.HUNT

# --- Action SM (reads intent) -----------------------------------------------

func _update_action(delta: float) -> void:
    match current_intent:
        Intent.IDLE, Intent.PATROL:
            _enter_state(State.CALM)
            velocity = Vector3.ZERO
        Intent.INVESTIGATE:
            _enter_state(State.ALERT)
            _move_toward(_last_seen_pos, delta)
        Intent.HUNT:
            _enter_state(State.ALERT)
            if _target != null:
                _move_toward(_target.global_position, delta)
        Intent.KILL:
            _enter_state(State.AGGRESSIVE)
            velocity = Vector3.ZERO
            _try_attack()
        Intent.RETREAT:
            _enter_state(State.ALERT)
            if _target != null:
                _move_toward(global_position * 2.0 - _target.global_position, delta)
        Intent.RESCUE_ALLY:
            _enter_state(State.ALERT)
            # locomotion handled by ally-position lookup elsewhere

func _enter_state(new_state: State) -> void:
    if _state == new_state:
        return
    _state = new_state
    match new_state:
        State.CALM:
            anim.play("idle")
        State.ALERT:
            anim.play("alert")
        State.AGGRESSIVE:
            anim.play("ready")
        State.DEFEATED:
            anim.play("death")
            died.emit(global_position)
            ally_defeated.emit(self)

# --- Helpers ----------------------------------------------------------------

func _move_toward(target_pos: Vector3, _delta: float) -> void:
    var dir: Vector3 = (target_pos - global_position).normalized()
    velocity = dir * move_speed
    look_at(target_pos, Vector3.UP)

func _try_attack() -> void:
    if _state != State.AGGRESSIVE or _target == null:
        return
    anim.play("attack_windup")
    var windup: float = maxf(0.25, attack_telegraph * (1.5 - aggression))
    await get_tree().create_timer(windup).timeout
    if _state != State.AGGRESSIVE or _target == null:
        return
    if global_position.distance_squared_to(_target.global_position) < (attack_range * 1.2) * (attack_range * 1.2):
        if _target.has_method("take_damage"):
            _target.take_damage(attack_damage)
    anim.play("attack_recover")

func _update_memory(delta: float) -> void:
    if _target != null and _has_line_of_sight(_target):
        _last_seen_pos = _target.global_position
        _memory_timer = memory_duration
    else:
        _memory_timer = maxf(_memory_timer - delta, 0.0)
        if _memory_timer <= 0.0:
            _target = null

func _has_line_of_sight(target: Node3D) -> bool:
    sight.target_position = sight.to_local(target.global_position)
    sight.force_raycast_update()
    if not sight.is_colliding():
        return true
    return sight.get_collider() == target

func _on_body_entered(body: Node3D) -> void:
    if body.is_in_group("player") and _state == State.CALM:
        _target = body
        _last_seen_pos = body.global_position
        _memory_timer = memory_duration

func take_damage(amount: int) -> void:
    if _state == State.DEFEATED:
        return
    _health -= amount
    var hp_ratio: float = float(_health) / float(max_health)
    if randf() < caution * (1.0 - hp_ratio):
        _retreat_desire = 1.0
    if _health <= 0:
        _enter_state(State.DEFEATED)
        await get_tree().create_timer(2.0).timeout
        queue_free()
```

Key design notes embedded above:
- `aggression`, `patience`, `caution`, `punishment` are tuned per-archetype and jittered per-instance.
- Intent SM (`_update_intent` / `_decide_intent`) sits above the action SM (`_update_action`).
- Action SM reads `current_intent`. It does not write intent.
- Telegraph length scales with aggression — angrier NPCs swing faster.
- Damage triggers a `caution * (1 - hp_ratio)` chance to set `_retreat_desire`, so cautious + hurt = back off.
- `died` signal is the gameplay-layer hook; `ally_defeated` is the squad hook.

### 8. Tunable matrices — concrete ranges per archetype

These are the *base* values; the spawn-time `personality_jitter` (default 0.15) widens them further.

| Archetype | aggression | patience | caution | punishment | Notes |
|---|---|---|---|---|---|
| `basic_grunt` | 0.5–0.7 | 0.3–0.5 | 0.2–0.4 | 0.4–0.6 | Wants to engage; not too smart |
| `ranged_skirmisher` | 0.3–0.5 | 0.5–0.7 | 0.6–0.8 | 0.5–0.7 | Kites, breaks LOS, punishes reload |
| `heavy_brute` | 0.7–0.9 | 0.2–0.4 | 0.1–0.3 | 0.6–0.8 | Closes fast, low retreat |
| `boss` | 0.7–0.9 | 0.7–0.9 | 0.5–0.7 | 0.8–1.0 | Patient, punishing, never panics |
| `wave_mob` | 0.9–1.0 | 0.0–0.1 | 0.0 | 0.0 | Single intent: KILL |
| `civilian` | 0.0 | 0.8–1.0 | 0.7–0.9 | 0.0 | Retreat-only |
| `companion` | 0.4–0.6 | 0.6–0.8 | 0.5–0.7 | 0.3–0.5 | Supports, doesn't over-commit |

Set base values via `@export` in the scene's inspector, not hard-coded in script. That keeps the same `enemy_ai.gd` reusable across archetypes.

### 9. Verify

```
summer_save_scene(scenePath="res://main.tscn")
summer_get_script_errors(path="res://scripts/enemy_ai.gd")   # one file per call; path required
summer_play
# user tests
summer_stop
```

If the enemy doesn't aggro, common causes:
- Player isn't in `player` group.
- Vision Area3D's `shape` was never assigned, so its radius writes errored with `resource is null`.
- Sight RayCast3D `enabled = false` or `collide_with_areas = true` blocking on its own Vision area.
- Personality jitter pushed `aggression` close to 0 — check inspector values.

## Common mistakes

| Don't | Do | Why |
|---|---|---|
| 360° perception | Sight cone or sphere with raycast LOS | "Sees through walls" feels unfair |
| Instant attack | 0.3–0.7 sec telegraph, scaled by aggression | Player needs to read the swing |
| All NPCs identical at spawn | Jitter personality knobs in `_ready` | Identical NPCs are predictable; predictable is boring |
| Action SM writes intent | Intent layer writes intent, action reads | Tangled SMs are unmaintainable |
| One enum for action + intent | Two enums, two SMs | Different time scales, different inputs |
| Hard-coded role per spawn ("this is the sniper") | Let personality variation produce roles | Squad emergence comes for free; authored roles fight the system |
| Behavior tree for a grunt | Action SM with 4 states + intent layer | BT overhead unjustified at this complexity |
| Per-frame group lookup | Cache target on aggro, listen for `ally_defeated` | Tree walks aren't free |
| `distance_to` in `_physics_process` | `distance_squared_to` for comparisons | Square root costs at scale |
| Same animation in all states | Distinct anim per action state | The state machine is invisible; animation makes it visible |
| `queue_free()` instantly on death | Death anim → 2 sec → free | Instant despawn breaks immersion + skips loot drops |
| Setting `shape`'s radius before `shape` holds a resource | Assign the shape, then set sub-properties | `SetResourceProperty` errors with `resource is null` when the property is empty |
| 100+ enemies with full FSM | Wave-mob archetype (no intent layer, single KILL intent) | Cheap mobs need cheap brains |
| No `died` / `ally_defeated` signals | Emit both | Gameplay + squad logic both need hooks |

## Anti-patterns

- **"AI that dodges everything."** Enemies that 100% dodge feel cheap. A `caution` knob plus randomized reaction time (50–250 ms) reads as skill, not aimbot.
- **Boss with 12 unique mechanics.** Cap at 4–6 distinct mechanics across phases. Players can't track more.
- **Companion that walks through doors.** NavigationAgent3D with proper navmesh. Don't fake it with raw `move_toward`.
- **Civilian that screams forever.** Add a calm-down state on a 5–10 sec timer.
- **Setting `current_intent` from inside an action callback.** Intent is computed by the intent layer from inputs (perception + personality + group). Letting action callbacks write intent inverts the architecture.

## Collaborative protocol

This skill writes scenes and scripts. Always ask before each step. Group related writes into one ask.

## Want a working starter?

For a fully-rigged enemy with anim controller + loot drop:

→ **template-id**: `template-3d-fps` — ships with a sample patrol enemy
→ For higher-complexity AI (boss with phases, behavior trees), defer to `ai-and-npcs/behavior-trees/SKILL.md`.

## See also

- `ai-and-npcs/state-machine-npc/SKILL.md` — FSM pattern deep dive
- `ai-and-npcs/behavior-trees/SKILL.md` — when complexity demands a BT
- `ai-and-npcs/perception-sight-and-hearing/SKILL.md` — sensor patterns
- `ai-and-npcs/navmesh-pathfinding/SKILL.md` — NavigationAgent3D for movement
- `ai-and-npcs/llm-driven-dialogue/SKILL.md` — Summer's wedge for talking NPCs
- `ai-and-npcs/boss-patterns/SKILL.md` — phase transitions, mechanics
- `visual-effects/recipes/hit-spark/SKILL.md` — hit flash recipe
- `visual-effects/recipes/dissolve/SKILL.md` — death dissolve recipe
- `visual-effects/game-feel/SKILL.md` — screen-feel discipline (camera shake, hit-stop)
- `scripting-patterns/state-machine-patterns/SKILL.md` — generic FSM patterns
