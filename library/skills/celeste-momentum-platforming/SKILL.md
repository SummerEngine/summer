---
name: celeste-momentum-platforming
description: "Use when building or tuning Celeste-style momentum-based precision platformer movement in SummerEngine (Godot 4): tuned gravity/fall, run acceleration, variable-height jumps with coyote time, dashes, wall jumps/slides, climb stamina, and pixel-scale corner correction, using the exact tuning constants extracted from Celeste's open-source Player class."
license: MIT
category: game-feel
tags:
  - platformer
  - movement
  - game-feel
  - controller
  - godot4
confidence: extracted
source_refs:
  - sources/web/celeste-player-cs/source.md
  - sources/x/valigo-celeste-movement/source.md
source_repo: SummerEngine/summer-gamedev-knowledge@cac7d50be8cfb3c0179c48e65438eb0d375b9fe9
---

# Celeste-Style Momentum Platforming (Movement System)

## Outcome

A 2D character controller for SummerEngine that reproduces the tuning architecture and forgiveness mechanics of Celeste's player movement: momentum-based running with distinct ground/air acceleration, variable-height jumping with coyote time, a multi-directional dash with cooldown and residual speed, wall interaction (jump, slide, climb with stamina), and pixel-scale corner corrections that make near-miss inputs succeed instead of fail.

## When to Use

- Building a precision 2D platformer in SummerEngine where movement feel is the core gameplay.
- Porting or prototyping Celeste-style mechanics (dash, wall jump, climb stamina).
- Tuning an existing platformer controller that feels "unfair" or unresponsive — the forgiveness systems below are the primary fix.

Do not use for: 3D character controllers, physics-driven (RigidBody) movement, or games where floaty/arcade jump physics are desired over momentum precision.

## Core Principle

Celeste's movement is a **single controller class driven by an explicit integer state machine**, with all feel-critical numbers as a **flat compile-time constants table** at the top of the class. The retrieved source (Player.cs, 5,471 lines) defines states `Normal=0, Climb=1, Dash=2, Swim=3, Boost=4, RedDash=5, HitSquash=6, Launch=7, Pickup=8, DreamDash=9` (+ a Summit state), each with Begin/Update/End callbacks. State transitions are direct integer assignments.

The second principle: **forgiveness at the pixel and millisecond scale**. The code repeatedly nudges the player 2–6 pixels or grants 50–200 ms windows so that inputs which are *almost* correct still succeed. This is the source of the "tightest" feel described in the originating post.

## Tuning Constants (verbatim from Player.cs)

Celeste's units are pixels/second for speeds and pixels/second² for accelerations at its native resolution; times in seconds. When porting, preserve the ratios more than the absolute numbers if your pixels-per-meter differs.

### Gravity & Falling
| Constant | Value | Feel role |
|---|---|---|
| Gravity | 900 | Base downward acceleration |
| MaxFall | 160 | Terminal fall speed (normal) |
| HalfGravThreshold | 40 | Below this vertical speed, gravity is halved (floaty apex) |
| FastMaxFall | 240 | Terminal fall speed when fast-falling (hold down) |
| FastMaxAccel | 300 | Acceleration toward FastMaxFall |

### Running
| Constant | Value | Feel role |
|---|---|---|
| MaxRun | 90 | Top ground speed |
| RunAccel | 1000 | Ground acceleration (~11× MaxRun — near-instant response) |
| RunReduce | 400 | Deceleration when input stops |
| AirMult | 0.65 | Air control multiplier on acceleration |
| HoldingMaxRun | 70 | Reduced top speed while carrying objects |
| HoldMinTime | 0.35 | Min time before hold-reduction applies |
| WalkSpeed | 64 | Slow-walk speed |
| DuckFriction | 500 | Friction while crouched |

### Jumping
| Constant | Value | Feel role |
|---|---|---|
| JumpGraceTime | 0.1 | **Coyote time** — jump input valid 100 ms after leaving ground |
| JumpSpeed | -105 | Initial jump velocity |
| JumpHBoost | 40 | Horizontal boost added on jump |
| VarJumpTime | 0.2 | **Variable jump** — held jump sustains/boosts for up to 200 ms |
| CeilingVarJumpGrace | 0.05 | Grace before ceiling cancels variable jump |
| UpwardCornerCorrection | 4 | px nudge to slip past near-miss ceiling corners while rising |
| WallSpeedRetentionTime | 0.06 | Horizontal speed retained briefly after wall interactions |
| BounceAutoJumpTime | 0.1 | Auto-jump window off bouncy surfaces |

### Wall Interaction
| Constant | Value | Feel role |
|---|---|---|
| WallJumpCheckDist | 3 | px probe distance for wall detection |
| WallJumpForceTime | 0.16 | Duration of forced horizontal speed after wall jump |
| WallJumpHSpeed | 130 | = MaxRun + JumpHBoost; forced away-from-wall speed |
| WallSlideStartMax | 20 | Initial wall slide speed cap |
| WallSlideTime | 1.2 | Time over which wall slide behavior ramps |
| ClimbGrabYMult | 0.2 | Vertical speed multiplied by 0.2 on grab |

### Super Variants
| Constant | Value |
|---|---|
| SuperJumpH | 260 |
| SuperWallJumpSpeed | -160 |
| SuperWallJumpH | 170 (= MaxRun + JumpHBoost×2) |
| SuperWallJumpForceTime | 0.2 |
| SuperWallJumpVarTime | 0.25 |
| BounceSpeed / SuperBounceSpeed | -140 / -185 |
| DuckSuperJumpXMult / YMult | 1.25 / 0.5 |

### Dash
| Constant | Value | Feel role |
|---|---|---|
| DashSpeed | 240 | Speed during dash |
| DashTime | 0.15 | Dash duration |
| EndDashSpeed | 160 | Residual speed after dash ends (2/3 of dash speed) |
| EndDashUpMult | 0.75 | Residual multiplier for upward dashes |
| DashCooldown | 0.2 | Time before dash input re-accepted |
| DashRefillCooldown | 0.1 | Refill timing after landing |
| DashAttackTime | 0.3 | Active dash collision window |
| DashCornerCorrection | 4 | px nudge on dash near-misses |
| DashHJumpThruNudge | 6 | px nudge for horizontal dashes through one-way platforms |
| DashVFloorSnapDist | 3 | px snap to floor after downward dash |

### Climb / Stamina
| Constant | Value | Feel role |
|---|---|---|
| ClimbMaxStamina | 110 | Total stamina pool |
| ClimbUpCost | ~45.5/s (100/2.2) | Climbing upward drains ~2.4 s of pool |
| ClimbStillCost | 10/s (100/10) | Hanging drains ~11 s of pool |
| ClimbJumpCost | 27.5 (110/4) | Flat cost per climb-jump |
| ClimbTiredThreshold | 20 | Below this, climb behavior degrades |
| ClimbUpSpeed | -45 | Climb ascent speed |
| ClimbDownSpeed | 80 | Climb descent speed |
| ClimbSlipSpeed | 30 | Slip speed when exhausted |
| ClimbAccel | 900 | Climb velocity acceleration |
| ClimbCheckDist / UpCheckDist | 2 / 2 | px probe for grab detection |
| ClimbHopX / HopY | 100 / -120 | Wall-hop impulse |
| ClimbHopForceTime | 0.2 | Forced duration of hop impulse |
| ClimbGrabYMult | 0.2 | Vertical damp on grab |

### Other
| Constant | Value |
|---|---|
| LaunchSpeed / LaunchCancelThreshold | 280 / 220 |
| LiftYCap / LiftXCap | -130 / 250 |
| JumpThruAssistSpeed | -40 (upward assist through one-way platforms) |
| ReboundSpeedX / Y | 120 / -120 |
| ReflectBoundSpeed | 220 |
| ThrowRecoil | 80 |
| DuckWindMult | 0 (ducking negates wind) |
| SpacePhysicsMult | 0.6 (low-gravity zones) |

## Scene / Node Shape (Godot 4)

```
Player (CharacterBody2D)
├── CollisionShape2D          # compact rectangle; Celeste probes at 2–6 px, so shape must be tight
├── WallProbeLeft (Area2D)    # or use move_and_collide probes at WallJumpCheckDist
├── WallProbeRight (Area2D)
├── StateMachine (ref in script)
└── (AnimatedSprite2D / hair, particles optional)

World
├── TileMapLayer (static solids)
├── OneWayPlatforms (TileMapLayer or StaticBody2D with one-way collision)
└── JumpThru zones
```

## Reference Implementation Skeleton (GDScript)

```gdscript
extends CharacterBody2D

# === Tuning table (values from Celeste Player.cs; rescale px if needed) ===
const GRAVITY := 900.0
const MAX_FALL := 160.0
const HALF_GRAV_THRESHOLD := 40.0
const FAST_MAX_FALL := 240.0
const FAST_MAX_ACCEL := 300.0
const MAX_RUN := 90.0
const RUN_ACCEL := 1000.0
const RUN_REDUCE := 400.0
const AIR_MULT := 0.65
const JUMP_GRACE_TIME := 0.1
const JUMP_SPEED := -105.0
const JUMP_H_BOOST := 40.0
const VAR_JUMP_TIME := 0.2
const UPWARD_CORNER_CORRECTION := 4
const WALL_SPEED_RETENTION_TIME := 0.06
const WALL_JUMP_CHECK_DIST := 3
const WALL_JUMP_FORCE_TIME := 0.16
const WALL_JUMP_H_SPEED := MAX_RUN + JUMP_H_BOOST  # 130
const DASH_SPEED := 240.0
const DASH_TIME := 0.15
const END_DASH_SPEED := 160.0
const END_DASH_UP_MULT := 0.75
const DASH_COOLDOWN := 0.2
const DASH_CORNER_CORRECTION := 4
const CLIMB_MAX_STAMINA := 110.0
const CLIMB_UP_COST := 100.0 / 2.2
const CLIMB_STILL_COST := 100.0 / 10.0
const CLIMB_JUMP_COST := 110.0 / 4.0
const CLIMB_UP_SPEED := -45.0
const CLIMB_DOWN_SPEED := 80.0
const CLIMB_SLIP_SPEED := 30.0
const CLIMB_CHECK_DIST := 2

enum St { NORMAL, CLIMB, DASH, SWIM, BOOST, RED_DASH, HIT_SQUASH, LAUNCH, PICKUP, DREAM_DASH }

var state: int = St.NORMAL
var var_jump_timer: float = 0.0
var jump_grace_timer: float = 0.0        # coyote time
var dash_cooldown_timer: float = 0.0
var dash_timer: float = 0.0
var dash_dir: Vector2 = Vector2.ZERO
var wall_jump_force_timer: float = 0.0
var wall_speed_retention_timer: float = 0.0
var stamina: float = CLIMB_MAX_STAMINA

func _physics_process(delta: float) -> void:
    match state:
        St.NORMAL: _normal_update(delta)
        St.DASH:   _dash_update(delta)
        St.CLIMB:  _climb_update(delta)
        # ... remaining states
    move_and_slide()

func _normal_update(delta: float) -> void:
    # --- Gravity with apex float and fast-fall ---
    var max_fall := MAX_FALL
    if Input.is_action_pressed("ui_down") and not is_on_floor():
        max_fall = FAST_MAX_FALL
    var grav := GRAVITY
    if absf(velocity.y) < HALF_GRAV_THRESHOLD and velocity.y < 0.0:
        grav *= 0.5
    velocity.y = minf(velocity.y + grav * delta, max_fall)

    # --- Run acceleration, reduced in air ---
    var input_x := Input.get_axis("ui_left", "ui_right")
    var accel := RUN_ACCEL if is_on_floor() else RUN_ACCEL * AIR_MULT
    if input_x != 0.0:
        velocity.x = move_toward(velocity.x, input_x * MAX_RUN, accel * delta)
    else:
        velocity.x = move_toward(velocity.x, 0.0, RUN_REDUCE * delta)

    # --- Coyote time bookkeeping ---
    if is_on_floor():
        jump_grace_timer = JUMP_GRACE_TIME
    else:
        jump_grace_timer -= delta

    # --- Jump with variable height ---
    if Input.is_action_just_pressed("ui_accept") and jump_grace_timer > 0.0:
        velocity.y = JUMP_SPEED
        velocity.x += signf(input_x) * JUMP_H_BOOST if input_x != 0.0 else 0.0
        var_jump_timer = VAR_JUMP_TIME
        jump_grace_timer = 0.0
    if var_jump_timer > 0.0 and Input.is_action_pressed("ui_accept"):
        var_jump_timer -= delta
        # hold sustains upward velocity; release cuts it
    elif var_jump_timer > 0.0:
        var_jump_timer = 0.0
        if velocity.y < 0.0:
            velocity.y *= 0.5  # jump cut on release (standard platformer pattern)

    # --- Wall probe and wall jump ---
    var wall_dir := _probe_wall()  # raycast WALL_JUMP_CHECK_DIST px each side
    if wall_dir != 0 and Input.is_action_just_pressed("ui_accept"):
        velocity.x = -wall_dir * WALL_JUMP_H_SPEED
        wall_jump_force_timer = WALL_JUMP_FORCE_TIME
        velocity.y = JUMP_SPEED
        var_jump_timer = VAR_JUMP_TIME

    if wall_jump_force_timer > 0.0:
        wall_jump_force_timer -= delta  # lock horizontal input during forced push

    # --- Dash entry ---
    if dash_cooldown_timer <= 0.0 and Input.is_action_just_pressed("dash"):
        state = St.DASH
        dash_dir = _aim_direction()  # 8-way from input axes
        dash_timer = DASH_TIME
        dash_cooldown_timer = DASH_COOLDOWN
        velocity = dash_dir * DASH_SPEED

func _dash_update(delta: float) -> void:
    dash_timer -= delta
    velocity = dash_dir * DASH_SPEED  # no gravity during dash
    if dash_timer <= 0.0 or _collided_during_dash():
        state = St.NORMAL
        # Residual speed: keep EndDashSpeed, reduced for upward dashes
        var residual := END_DASH_SPEED
        if dash_dir.y < 0.0:
            residual *= END_DASH_UP_MULT
        velocity = dash_dir.normalized() * minf(velocity.length(), residual)

func _climb_update(delta: float) -> void:
    var input_y := Input.get_axis("ui_up", "ui_down")
    if input_y < 0.0:
        velocity.y = CLIMB_UP_SPEED
        stamina -= CLIMB_UP_COST * delta
    elif input_y > 0.0:
        velocity.y = CLIMB_DOWN_SPEED
    else:
        velocity.y = minf(velocity.y + GRAVITY * delta * 0.1, CLIMB_SLIP_SPEED)
        stamina -= CLIMB_STILL_COST * delta
    velocity.x = 0.0
    if stamina <= 0.0 or not _touching_wall():
        state = St.NORMAL
    if Input.is_action_just_pressed("ui_accept"):
        stamina -= CLIMB_JUMP_COST
        state = St.NORMAL
        velocity.y = JUMP_SPEED

func _probe_wall() -> int:
    # Space-aware probe: returns -1 (wall left), 1 (wall right), 0 (none)
    # Use move_and_collide or a WALL_JUMP_CHECK_DIST raycast against solids.
    return 0
```

The skeleton above is a structural translation for Godot; the exact per-frame update bodies from Player.cs were not fully retrievable (see evidence limitations). The constants, state IDs, and confirmed behaviors (corner correction loops, variable-jump window logic, forced wall-jump timers, stamina costs, squish safety) are extracted directly from the source.

## Confirmed Behavioral Patterns to Replicate

1. **Corner correction:** on near-miss collisions (rising jump, dash), loop through ±4 px perpendicular offsets, test for clearance, and shift the player to the first clear position. Do not fail the move; nudge it through.
2. **Variable-jump window:** `varJumpTimer` runs up to 0.2 s; a ceiling grace of 0.05 s prevents premature cancellation at the apex. The window zeroes on specific collision conditions, not on a raw timer expiry alone.
3. **Forced wall-jump time:** for 0.16 s after a wall jump, horizontal input does not override the forced 130 px/s push. This prevents immediate re-stick to the wall.
4. **Wall speed retention:** a 0.06 s timer retains horizontal speed across wall interactions; `NormalEnd` resets it along with `wallBoostTimer` and `hopWaitX`.
5. **Squish safety:** if crushed, try (in order) ducking, repositioning to target, wiggle-nudging; only kill the player if all fail. Never instakill on a recoverable geometric overlap.
6. **Jump-through assist:** one-way platforms apply a -40 (gentle upward) assist speed during pass-through.
7. **Dash floor snap / jump-thru nudge:** after downward dashes, snap up to 3 px to the floor; horizontal dashes nudge up to 6 px through jump-throughs.

## Implementation Steps

1. Create the constants table first, exactly as listed. Keep it at the top of the player script as the single tuning surface (mirroring Player.cs structure).
2. Implement the state machine as an enum + match, with per-state begin/update/end functions. Start with NORMAL, DASH, CLIMB; add BOOST, HIT_SQUASH, LAUNCH as encounters require.
3. Implement gravity/fall tuning (apex float via HalfGravThreshold, fast-fall, MaxFall clamp) and run acceleration (RunAccel/RunReduce/AirMult).
4. Implement jump + coyote time + variable jump height + jump cut on release.
5. Implement wall probing (3 px), wall jump with forced-time lock, and wall slide.
6. Implement dash with 8-way aim, cooldown, residual EndDashSpeed, and corner correction.
7. Implement climb stamina with the three cost rates and tired threshold.
8. Add forgiveness pass: upward corner correction on jump, dash nudges, jump-through assist, wall speed retention, squish-safety cascade.
9. Rescale units if SummerEngine's pixels-per-meter differs from Celeste's native resolution: preserve ratios (e.g., DashSpeed ≈ 2.67× MaxRun; RunAccel ≈ 11× MaxRun).

## Tunables

All constants in the tables above. The highest-leverage feel knobs, in order:
1. `JUMP_GRACE_TIME` (coyote) and `VAR_JUMP_TIME` — responsiveness.
2. `RUN_ACCEL` vs `AIR_MULT` — ground crispness vs air drift.
3. `DASH_SPEED` / `DASH_TIME` / `END_DASH_SPEED` — dash punch and recovery.
4. `WALL_JUMP_FORCE_TIME` and `WALL_JUMP_H_SPEED` — wall jump commitment.
5. `HALF_GRAV_THRESHOLD` — apex float amount.

## Failure Modes & Gotchas

- **Skipping coyote time or variable jump** makes the controller feel unfair even if every other value matches. These two forgiveness systems carry most of the "tight" perception.
- **Letting horizontal input override the wall-jump force window** causes players to snap back onto the wall immediately.
- **Applying RunAccel in the air without AirMult** gives full ground control mid-air and destroys momentum feel.
- **Hard-failing near-miss collisions** instead of corner-correcting (±2–6 px probes) turns visual grazes into deaths.
- **Instakilling on squish** — the source cascades duck → reposition → wiggle → die. Replicate the cascade.
- **Treating stamina costs as per-frame instead of per-second** drains the pool ~60× faster.
- **Copying pixel values without rescaling** if your game's world scale differs — use ratios.
- **Over-abstracting the controller.** The source is deliberately one flat class with a constants table; splitting it into many components before the feel is dialed makes tuning iterations slow.

## Verification

After implementing, test each forgiveness system explicitly:
1. Walk off a ledge and press jump up to ~100 ms later — should still jump (coyote).
2. Tap vs. hold jump — distinct short and full arc heights (variable jump).
3. Jump diagonally into a ceiling corner within ~4 px of clearance — should slip past, not bonk (corner correction).
4. Wall jump and hold toward the wall — should still be pushed away for ~0.16 s.
5. Dash into a wall edge within ~4 px — should correct rather than stop dead.
6. Climb until stamina hits 0 — transition to slip/fall, not instant drop.
7. Land from a dash — residual speed ≈ 160 px/s (or ×0.75 for upward), not zero.
8. Get crushed by a moving platform — duck/wiggle recovery before any death.

## Confidence

`extracted` — All tuning values, state IDs, and confirmed behavioral patterns are taken directly from the retrieved Player.cs source. Per-state update-loop bodies from the middle of the 182 KB file were not retrievable (tool truncation); where the skeleton fills standard platformer patterns (e.g., jump-cut-on-release), this is noted as structural translation, not extracted code. Not yet verified inside SummerEngine.

## Evidence

- sources/web/celeste-player-cs/source.md — primary source record: constants tables, state machine, confirmed behavioral snippets, retrieval limitations.
- sources/x/valigo-celeste-movement/source.md — originating post and primary-source identification.
