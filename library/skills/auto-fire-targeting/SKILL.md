---
name: auto-fire-targeting
description: Use when designing or fixing the targeting system for an auto-fire weapon (survivors-genre, top-down ARPG, tower-defense). Covers the pending-damage pattern that prevents over-commit when bullet flight time is longer than fire rate. Trigger on "auto-fire", "auto-aim", "weapon targeting", "targeting", "wasted bullets", "overkill", "damage prediction", "survivors weapon".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: gameplay-mechanics
allowed-tools: Read Edit Grep
paths: ["**/*.gd"]
---

# Auto-Fire Weapon Targeting — pending-damage pattern

A survivors-genre auto-fire weapon picks a target each fire frame. Naive nearest-enemy targeting wastes bullets when fire rate exceeds bullet flight time. This skill encodes the pending-damage pattern that fixes it.

## The problem

Auto-fire weapon. Bullet speed 22 m/s. Target 10m away. Bullet takes ~0.45s to arrive. With high attack speed the player fires several bullets per second. By the time the first bullet arrives and kills the target, several more bullets are already in flight toward where the target was. They miss into empty space. The player sees bullets "fan out in a cone past the dead enemy" while other enemies stand around untouched.

This is not a re-targeting bug. The weapon's `_fire()` correctly re-runs `find_nearest_enemy()` each shot. The issue is that the target is alive at fire-time and dead at arrival-time. All shots fired in that window aim at it because none of them know about the kill in flight.

## The fix — pending damage commitment

Each enemy carries a counter of damage that is in flight toward it. Targeting de-prefers (but does not exclude) enemies whose pending damage already exceeds their current HP.

### 1. Add the counter to the enemy base class

```gdscript
# enemy_base_3d.gd

var pending_damage: float = 0.0


func commit_pending(amount: float) -> void:
    pending_damage += amount


func release_pending(amount: float) -> void:
    pending_damage = maxf(0.0, pending_damage - amount)


## True if enough damage is already in flight to kill this enemy.
func is_saturated() -> bool:
    return pending_damage >= health
```

### 2. Update the targeting helper

The selector keeps the saturated set as a fallback. If every enemy is saturated, the player must still be able to fire on someone — fall through to a normal nearest pick across saturated enemies. Otherwise prefer non-saturated.

```gdscript
# targeting.gd

static func pick(origin: Vector3, mode: int, max_range: float, ...) -> Node3D:
    var enemies: Array = GameManager.get_enemies()
    var best: Node3D = null
    var best_score: float = -INF
    var fallback: Node3D = null
    var fallback_score: float = -INF
    for enemy in enemies:
        # ... existing range + LoS filters ...
        var score := _score(enemy, d_sq, mode)
        var saturated: bool = "is_saturated" in enemy and enemy.is_saturated()
        if saturated:
            if score > fallback_score:
                fallback_score = score
                fallback = enemy
        else:
            if score > best_score:
                best_score = score
                best = enemy
    if best != null:
        return best
    return fallback  # everyone is saturated; fire on the next-best anyway
```

### 3. Commit at fire time

```gdscript
# projectile_weapon.gd

func _spawn_projectile(dir: Vector3, target: Node3D) -> void:
    var dmg: float = base_damage * GameManager.player_damage_mult
    # Commit expected damage. No crit factor — we don't gamble on RNG. If crit
    # over-kills the target, the next-frame release refunds the difference.
    var commit_amount: float = dmg
    if target != null and target.has_method("commit_pending"):
        target.commit_pending(commit_amount)
    var proj: Node3D = _projectile_scene.instantiate()
    # ... add_child, position, etc ...
    proj.setup(dir * PROJECTILE_SPEED, dmg, ..., target, commit_amount)
```

### 4. Release at bullet death (catch-all)

The bullet must release the commitment exactly once when it leaves the tree, regardless of how. Hit, pierce-out, range-expire, or any other free path. Use `tree_exiting` so the release is guaranteed without each free-site having to remember.

```gdscript
# bullet.gd

var _committed_target: Node = null
var _committed_amount: float = 0.0
var _committed_released: bool = false


func setup(..., commit_target: Node = null, commit_amount: float = 0.0) -> void:
    # ... other setup ...
    _committed_target = commit_target
    _committed_amount = commit_amount


func _ready() -> void:
    # ... other wiring ...
    tree_exiting.connect(_release_committed)


## Idempotent so multiple call paths can't double-release.
func _release_committed() -> void:
    if _committed_released:
        return
    _committed_released = true
    if _committed_amount <= 0.0:
        return
    if _committed_target != null and is_instance_valid(_committed_target) \
            and _committed_target.has_method("release_pending"):
        _committed_target.release_pending(_committed_amount)
```

## Bonus — spread fan across multiple enemies

When the weapon fires N projectiles per shot (extra-projectiles upgrade, multishot), pick a fresh target per projectile instead of fanning all N at the primary target. Combined with the saturation filter this drains follow-on shots toward fresh enemies.

```gdscript
# projectile_weapon.gd, multishot path

for i in total_projectiles:
    var per_shot_target := Targeting.pick(global_position, mode, range)
    if per_shot_target == null:
        per_shot_target = primary_target  # fall back if nothing else in range
    _spawn_projectile(dir.rotated(Vector3.UP, fan_angle), per_shot_target)
```

## Bonus — bump projectile speed

The over-commit window is `attack_speed * bullet_travel_time`. Faster bullets shrink it for free. 22 m/s up to 35 m/s halves the window without affecting balance much. Cheap fix to bundle with the pattern.

## What this does NOT solve

- **Pierce > 1 weapons.** The committed amount is reserved on the first target only. Subsequent pierces are bonus damage to whoever happens to be in line. That is fine — pierce already feels random by design.
- **AOE / nova / orbital weapons.** They hit everyone in radius regardless of "target," so single-target pending-damage doesn't apply. Skip them.
- **Slow-but-massive weapons.** A single shot that one-shots multiple enemies in sequence (rocket launcher, railgun) doesn't benefit much. The window where the over-commit happens is too short to matter.

## Why this beats alternatives

| Alternative | Why we didn't pick it |
|---|---|
| In-flight bullet retargeting (each bullet seeks the nearest live enemy mid-flight) | Per-bullet logic is expensive and the homing visual reads as a different weapon archetype. Pending-damage is fire-and-forget. |
| Predict the kill (fire only enough bullets to kill) | Requires knowing exact damage including crit and item modifiers. Edge cases multiply. |
| Just bump bullet speed | Helps but doesn't eliminate the issue at very high attack-speed builds. |
| Shoot-through-enemies (everyone gets free pierce) | Changes weapon identity. AOE bleed. |

Pending-damage is local to the targeting query, requires no per-bullet ticking, and keeps each weapon archetype's identity intact.

## Verification

Test scenario: spawn a single weak enemy directly in front of the player at point-blank range. Equip the auto-fire weapon and the highest-attack-speed item. Watch the bullet fan when the enemy dies.

Before: 5-15 bullets continue past the corpse over the next ~0.5s.
After: 1-2 bullets continue (the ones that were already past the half-flight point), the rest of the fire pool redirects to whatever target Targeting picks next, or stops if there's none in range.

Use `summer_get_diagnostics` to confirm no new errors.

`summer_inspect_node` will **not** show you `pending_damage` mid-fight. It reads
the edited scene in the editor — the response even tags itself
`provenance: editor_scene` — so it reports the saved node, not the live
instance. Runtime values need a runtime probe.

The route that works from MCP is the `RunVerification` op, sent through
`summer_batch`. It spins up a hidden, disposable game instance that runs a
GDScript probe and exits; it never touches the editor:

```
summer_batch(ops=[{
  "op": "RunVerification",
  "max_seconds": 20,
  "probe_source": "extends SummerProbeBase\nfunc _ready():\n\tawait super._ready()\n\t# spawn one enemy, fire at it, then:\n\treport('pending_damage', enemy.pending_damage)\n\tfinish()"
}])
```

Probe API: `report()`, `save_frame()`, `press()`, `key()`, `finish()`. Returns
`{ok, results, frames, out_dir}`.

Do **not** reach for `SimulateInput` here. It is only reachable from the
in-editor chat bridge; an MCP or CLI caller gets
`{ok: false, failure_reason: "unsupported_transport"}` back. Drive input from
inside the probe with `press()` / `key()` instead.
