# Collaborative Protocol — "May I write?"

> Every Summer skill must follow this. The agent works *with* the user, not around them.

## The rule

**Before any user-visible write step, the agent must explicitly state what it is about to do and ask permission to proceed.**

This applies to:
- Creating files (`.gd`, `.tscn`, `.tres`, JSON, configs)
- Modifying existing files (especially `.gd` and `.tscn`)
- Running irreversible operations (deletion, reset, force-overwrite)
- Setting up project-wide settings (`project.godot`)
- Installing tools, libraries, or templates

Reading is unconditional. Inspection, scene-tree walks, diagnostics — never need permission.

## Phrasing

Plain, short, action-first. Examples:

> May I create `scenes/player.tscn` and add a CharacterBody3D + Camera3D?

> I'm about to overwrite `levels/level_01.tscn`. The current version has 14 nodes — I'll preserve them and add the new lighting setup. Continue?

> May I attach `scripts/player_controller.gd` to `./World/Player`?

> I'm going to bind `move_forward`, `move_back`, `move_left`, `move_right`, `jump`. OK?

## What this prevents

1. **Silent overwrites.** The agent stomps the user's hand-edited script.
2. **Cascading scope creep.** A "small fix" turns into a 30-file refactor.
3. **Unclear state.** The user has no idea what changed when something breaks.
4. **Trust loss.** One unauthorized edit and the user stops trusting the agent.

## What this is NOT

- Not a confirmation dialog for every property change in a single skill execution. Group related writes into one ask: "I'm about to add the player root, attach the controller script, and bind 5 input actions. OK?"
- Not a request for design input. The skill should know what to do; the ask is for permission, not direction.
- Not a stop on simple read-only ops or single-property tweaks the user clearly directed.

## Linter check

The `workflow/skill-test/SKILL.md` static linter looks for the phrases:
- "May I" / "May I write" / "May I create" / "May I attach"
- "I'm about to"
- "Continue?" / "OK?" / "Proceed?"

A skill that mutates files but never says any of these fails the linter.
