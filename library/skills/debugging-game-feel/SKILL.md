---
name: debugging-game-feel
description: Use when a gameplay feature works correctly but feels wrong — floaty jumps, mushy combat, sluggish camera, weightless impacts. Different from logical bug debugging; the bug is subjective and lives in tuning, timing, and feedback layers.
---

# Debugging Game Feel

## Overview

"Works but feels wrong" is its own debugging discipline. The code is correct. No diagnostic flags it. The unit tests pass. And yet the jump is floaty, the sword has no weight, the camera lags the player, the dash is unsatisfying.

**Core principle:** Game-feel bugs are tuning bugs, not logic bugs. Treat them with discipline — isolate one variable, compare to a reference, measure what you can, feel what you can't.

This skill is for the diagnostic phase. The polish-and-juice layer (screen shake, hit-stop, particles, sound design) is `game-feel` — go there once you've identified WHICH variable is wrong.

## When To Use

- The user says: "feels floaty", "feels mushy", "feels off", "feels sluggish", "doesn't feel right", "lacks impact", "lacks weight", "doesn't feel satisfying".
- The feature passes `playtesting-a-feature` (no errors, golden path runs) but still doesn't feel right.
- You're tuning movement, combat, camera, or any interaction with frame-level timing.

## When NOT To Use

- The feature has a **concrete reproducible bug** — go to `investigating-bugs`.
- The feature **crashes or throws** — go to `debug`.
- The feature **hasn't been built yet** — design it via `brainstorming` first.

## The Iron Law

```
ONE VARIABLE AT A TIME. ALWAYS.
```

Game-feel debugging is the place where engineers most often violate this rule, because each variable is a small tweak. "Let me bump acceleration AND friction AND max speed all together" produces a result you cannot reason about. You learn nothing. The bug returns.

## The Loop

```
  Anchor → Isolate → Tweak one variable → Compare → Decide → Repeat
```

### 1. Anchor: name the reference

Before touching any value, decide what "right" feels like. Game feel is subjective; without an anchor, you are debugging air.

Two ways to anchor:

| Anchor type | When to use | Example |
|---|---|---|
| **Reference game footage** | The user has a target in mind (Hollow Knight jumps, Dark Souls weight, Hades dashes) | "Match the Hollow Knight jump arc — peak in ~0.25s, fall ~0.35s, terminal velocity around frame 30" |
| **Internal known-good** | An older build / a sibling feature in the same game already feels right | "The pistol fires snappy. Make the rifle feel as snappy as the pistol minus the recovery frames." |

Write the anchor down in one sentence. If the user can't articulate it, ask. "What game does this remind you of when it's working?" is a fast way to extract the reference.

### 2. Isolate: name the suspect variable

Game-feel bugs almost always live in one of a small set of axes. Pick the most likely one first.

| Domain | Common suspect variables |
|---|---|
| Jump | gravity, jump velocity, terminal velocity, coyote-time window, jump-buffer window, variable-jump cutoff, apex hang time |
| Run | acceleration, max speed, friction (ground vs air), deceleration on input release, turn-around speed |
| Combat hit | hit-stop duration (attacker), hit-stop duration (target), screen shake amplitude + duration, knockback velocity + decay, recovery frames |
| Camera | follow lag (lerp factor or spring stiffness), lookahead distance, deadzone size, snap-vs-smooth on direction change |
| Dash | distance, duration, ease curve, cooldown, i-frame window, end-lag |
| UI feedback | input-to-response frame count, tween duration, easing function, sound onset delay |

If you cannot pick one suspect: state the top two, pick the one you think is most likely (say which), tweak it, see if it moved the feel. Do not tweak both.

### 3. Tweak one variable

- Read the current value via `summer_inspect_node` or open the relevant `.tres` / `.gd` file.
- Change ONE value. Save.
- Trigger `summer_play` and walk the feature.
- Ask: did the feel move toward or away from the anchor?

### 4. Compare

Two compare modes:

**Feel:** subjective. The user (or you, if you have eyes on the screen) reports "warmer" or "colder." This is fine. Most game-feel work is felt, not measured.

**Measure:** objective. When the feel is ambiguous, drop down to frame counts — and take them yourself with a `RunVerification` probe rather than asking the user to eyeball anything. The probe presses the input, samples per frame, and hands back an array.

| Question | Measurement |
|---|---|
| "Does the jump peak too fast?" | Probe: `press("jump")`, sample `player.velocity.y` every `process_frame`, count frames to the sign flip |
| "Is the camera too laggy?" | Probe: sample `camera.global_position - target.global_position` per frame while driving movement |
| "Is the input dead?" | Probe: report the frame input was injected and the frame the state machine changed; subtract |
| "Is the hit-stop too short?" | Probe: report frame at hit and frame at unfreeze |

Sketch:

```gdscript
extends SummerProbeBase
func _ready() -> void:
    await super._ready()
    await get_tree().process_frame
    var p := get_tree().root.find_child("Player", true, false)
    var trace: Array = []
    await press("jump", 100)
    for i in 40:
        await get_tree().process_frame
        trace.append(p.velocity.y)
    report("vel_y_per_frame", trace)
    save_frame("apex")
    finish()
```

Send it with `summer_batch ops:[{"op":"RunVerification","probe_source":"<the probe>","max_seconds":20}]`.

The point of measurement is to ground the conversation in numbers when "feels off" stops being useful. You do not need to measure most tweaks — only the ambiguous ones. **The verdict on whether it now feels right stays with the user** — that part is genuinely subjective, and it is the only part of this loop you hand over.

### 5. Decide

After the tweak:

- **Felt closer to the anchor** → commit the change, move to the next suspect variable if the feel still isn't right.
- **Felt further** → revert the change, pick a different suspect variable.
- **No change in feel** → revert the change, you tweaked the wrong variable.

Never leave a tweak in the codebase that you couldn't tell did anything. It will compound with the next tweak and you will lose the thread.

## The Compounding Tweaks Trap

The most common failure mode in game-feel work:

```
  Jump feels floaty.
  Bump gravity from 980 → 1200. Still floaty.
  Bump it to 1500. A bit better.
  Also reduce jump velocity from 500 → 450.
  Also tweak terminal velocity 1500 → 2000.
  Also add a 3-frame coyote window because why not.
  Now it feels... different. But the dash that used to feel great no longer does.
  Try to undo? You don't remember the starting point.
```

**Antidote:**

1. Note the starting values before you begin.
2. One variable at a time.
3. After every tweak, ask: anchor closer or farther? If unsure, revert.
4. Commit small revertible changes — one variable per commit during a feel-tuning session. Easy to bisect.

## Feel Principles (Briefly)

Game feel rests on three small ideas. Most "feels wrong" bugs trace to one of these being undertuned:

| Principle | What it means | What it looks like when broken |
|---|---|---|
| **Anticipation** | A small wind-up before a big action | Sword swings feel like they "appear" instead of being thrown |
| **Follow-through** | The action continues past the input | Player snaps to a stop on input release — feels robotic |
| **Weight** | Visible cost to changing direction or stopping | Player turns on a dime at full speed — feels weightless |

These are diagnostic tools, not lecture material. When the user says "feels weightless," your suspect-variable shortlist is: deceleration on input release, friction, turn-around speed, animation cross-fade time.

## Red Flags — STOP

| Red flag | Reality |
|---|---|
| Tweaking 2+ variables in one play session without reverting between | You will lose the signal. |
| "Let me just feel it out without an anchor" | You will tune in circles. Name the reference. |
| "The user said floaty so I'm jacking gravity" | "Floaty" can also mean weak air control, slow terminal velocity, or too-long apex hang. Confirm before tweaking. |
| Skipping the play step ("I'll just bump the number and trust the feel") | Game feel is felt, not predicted. Play every tweak. |
| Adding "while I'm here" tweaks to unrelated features | Game feel debugging is a focused activity. Stay on the one feature. |
| Going to `game-feel` before identifying the broken variable | Juice on top of a broken tuning makes the bug louder. Fix tuning first. |
| Spending >30 minutes on one variable without progress | The anchor is wrong, or the variable is wrong. Step back, re-anchor. |

## Rationalization Prevention

| Excuse | Reality |
|---|---|
| "It's subjective — I'll just iterate fast" | Fast iteration without isolation is thrashing, not iteration. |
| "I know game feel, I don't need an anchor" | Even pros anchor. Especially pros anchor. |
| "Two variables are coupled, I have to tune them together" | Then tune one, ship that delta, tune the other separately. |
| "The user can't articulate the anchor" | "What game does this remind you of when it works?" — one question, anchor obtained. |
| "Adding juice will hide the bad tuning" | It won't. It amplifies it. |

## When To Escalate

After diagnosis pins down which variable(s) are wrong, the tuning is done — but the feature may still want polish. Hand off to:

- `game-feel` — for the screen-shake, hit-stop, particle, sound layer once tuning is locked.
- `debug` — if mid-debug you discover an actual error (signal not firing, node freed) hiding under the feel issue.

## The Bottom Line

Feel bugs are tuning bugs. Tuning is a one-variable-at-a-time discipline. Anchor to a reference. Tweak one number. Play it. Decide. Repeat.

**Related skills:**
- `investigating-bugs` — for logical bugs with concrete repros, not feel.
- `playtesting-a-feature` — the playtest discipline this skill plugs into.
- `debug` — when the feel investigation surfaces an actual error.
