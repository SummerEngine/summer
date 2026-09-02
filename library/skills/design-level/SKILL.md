---
name: design-level
description: Use when designing a single level — layout, pacing, encounters, secrets, reward gating. Outputs a level design doc and a concrete node-tree skeleton for `summer_create_scene`. Trigger on "design a level", "design level 1", "tutorial level", "boss arena", "design the encounter", "make a level layout".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: level-design
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_get_scene_tree summer_create_scene summer_open_scene summer_add_node summer_set_prop summer_save_scene summer_get_script_errors
paths: ["**/*.tscn", "**/*.gd", ".summer/**", "levels/**"]
---

# /design-level — Design One Level

## Overview

A level is a controlled sequence of player experiences in physical space. Layout, pacing, encounters, secrets, and reward gating must work together — a "fun layout" with a flat pacing curve still feels boring. This skill walks the six design beats of a single level and drops a node-tree skeleton ready for `summer_create_scene`.

**Core principle:** A level has a *pacing curve* and a *teaching arc*. If you can't draw the tension graph and name what the player learned by the end, the level isn't designed yet.

## Steps

### 1. Pin the level type

Ask exactly one question:

> What kind of level? Pick one: tutorial / hub / combat encounter / boss / exploration / puzzle / stealth / platforming-challenge / mixed.

Each type has different beats. Don't blend types in v1 — a "boss room with stealth and puzzles" is three levels poorly squeezed into one.

### 2. Read context

If `.summer/GameSoul.md` exists, read it. The level must serve the brief's core loop and the three mechanics.

```
Read .summer/GameSoul.md
```

If `.summer/mechanics/` exists, list the mechanics. Quote them back:

> Brief says mechanics are: dash, parry, double-jump. This level should *exercise* at least one and ideally combine two.

### 3. Define the teaching / experience goal

Ask plain:

> What does the player know by the end of this level that they didn't at the start?

Tutorial-level answer: "How to dash." Combat-encounter answer: "That parrying converts damage to mana, and that big enemies need parry, not dodge." Exploration answer: "That this region's secrets are hidden behind double-jumpable gaps."

If the user can't answer, the level has no purpose. Say it:

> If there's no answer to that question, the level is filler. Either give it a teaching goal, give it a *failure-state* goal (the player must die here to progress), or merge it into the next level.

### 4. Sketch the pacing curve

Draw it as text. Five beats, intensity 0-10:

```
Intro    Build    Peak    Release    Hook
 2  →    5    →   8   →    3      →   6
```

For a 5-minute encounter level:

| Beat | Duration | Intensity | Player feels | Designer plants |
|---|---|---|---|---|
| Intro | 30s | 2 | Calm, oriented | Visual landmark for the goal direction |
| Build | 90s | 5 | Tension rising, small pressure | First weak enemy / first puzzle clue |
| Peak | 60s | 8 | Stakes high, mistakes hurt | Main encounter / hardest fight |
| Release | 60s | 3 | Catharsis, loot | Reward + breath room |
| Hook | 30s | 6 | Curiosity for next | Visible-but-locked secret or path |

Show the curve. Ask:

> Pacing above. Does the peak land where you want, or does the level need a second wave?

### 5. List encounters and secrets

Encounters = explicit player tests (combat, puzzle, platforming). Secrets = optional rewards that respect the pacing curve.

State them flat. For a combat encounter level:

```
Encounters (in player-traversal order):
1. E1 — Tutorial enemy (1 weak grunt) at 0:30, in the open atrium. Teaches the basic attack.
2. E2 — Forced parry (mid-tier enemy with telegraphed wind-up) at 1:30, in a corridor with no dodge room. Teaches parry.
3. E3 — Mixed wave (2 grunts + 1 parry-required) at 3:00, in the peak arena. Tests both.
4. E4 — Mini-boss at 4:00 in the chamber. Combines.

Secrets (3 total — one per beat after intro):
- S1 (build beat): Behind a breakable wall in the corridor, holds 50 currency. Teaches "walls can break".
- S2 (peak beat): Visible from the arena, accessible only via parrying off an enemy. Rewards mastery.
- S3 (hook beat): Locked door, key in a future level. Plants curiosity for next level.
```

### 6. Define reward gating

What's behind which gate? Levels feel cheap when they hand out rewards without respecting the difficulty curve.

| Reward | Gate | Why |
|---|---|---|
| Heal pickup | After E2 | Player just learned parry; reward + safety net before the peak |
| New ability unlock | After mini-boss | Mastery-pinned; player demonstrates parry before getting upgrade |
| Currency cache | Behind S1 (breakable wall) | Optional; rewards observation |
| Story note | At the calm intro | Free; orients the player to the level's narrative |

Ask:

> Reward gating above. Anything missing or mis-placed?

### 7. Define the layout primitives

Every level is built from a small vocabulary of spaces. Name them. Most levels need 4-6 distinct spaces, no more.

For a combat-encounter level:

```
Spaces (node-tree skeleton):
World (Node3D)
├── Geometry (Node3D)
│   ├── IntroAtrium (Node3D)         # open, calm, well-lit
│   ├── Corridor (Node3D)            # tight, forces parry
│   ├── PeakArena (Node3D)           # large, multiple cover, exit visible
│   └── BossChamber (Node3D)         # contained, single exit, dramatic lighting
├── Spawns (Node3D)
│   ├── PlayerSpawn (Node3D)         # marker
│   ├── E1_Spawn (Node3D)
│   ├── E2_Spawn (Node3D)
│   ├── E3_Wave_Spawns (Node3D)
│   └── MiniBoss_Spawn (Node3D)
├── Triggers (Node3D)
│   ├── E2_GateTrigger (Area3D)      # locks door behind player on entry
│   ├── PeakWaveTrigger (Area3D)
│   └── BossDoorTrigger (Area3D)
├── Pickups (Node3D)
│   ├── HealAfterE2 (Node3D)
│   └── CurrencyS1 (Node3D)
├── Secrets (Node3D)
│   ├── S1_BreakableWall (StaticBody3D)
│   ├── S2_ParryLedge (StaticBody3D)
│   └── S3_LockedDoor (StaticBody3D)
└── Lighting (Node3D)                # WorldEnvironment + DirectionalLight3D
```

Show the skeleton. Ask:

> Tree above. May I create the level scene `levels/<level-name>.tscn` with this skeleton?

### 8. Scaffold via MCP

**Preferred (Summer MCP):**

`summer_create_scene` takes `path`, `rootName`, and a mandatory safety gate.
There is no `root_type` or `root_name` argument. The tool refuses to run unless
`allow_temporary_scene_mutation` is explicitly true, because of how it works: it
opens the currently-open scene (or the project's main scene) as a template,
removes every child, renames the root, saves-as to the new path, then reopens
the original. Ask the user before setting the flag.

The consequence to plan around: **the new scene's root node type is copied from
the template's root**, not chosen by you. Create levels from a scene whose root
is already `Node3D`, or fix the root afterwards in the editor.

```
summer_create_scene(path="res://levels/level_01.tscn", rootName="World", allow_temporary_scene_mutation=true)
summer_add_node(scenePath="res://levels/level_01.tscn", parent="./World", type="Node3D", name="Geometry")
summer_add_node(parent="./World/Geometry", type="Node3D", name="IntroAtrium")
summer_add_node(parent="./World/Geometry", type="Node3D", name="Corridor")
summer_add_node(parent="./World/Geometry", type="Node3D", name="PeakArena")
summer_add_node(parent="./World/Geometry", type="Node3D", name="BossChamber")
summer_add_node(parent="./World", type="Node3D", name="Spawns")
summer_add_node(parent="./World/Spawns", type="Node3D", name="PlayerSpawn")
summer_add_node(parent="./World/Spawns", type="Node3D", name="E1_Spawn")
# ... and so on
summer_add_node(parent="./World", type="Node3D", name="Triggers")
summer_add_node(parent="./World/Triggers", type="Area3D", name="E2_GateTrigger")
# ... etc.
summer_add_node(parent="./World", type="Node3D", name="Lighting")
summer_add_node(parent="./World/Lighting", type="WorldEnvironment", name="WorldEnvironment")
summer_add_node(parent="./World/Lighting", type="DirectionalLight3D", name="Sun")
summer_save_scene(scenePath="res://levels/level_01.tscn")
```

Every `summer_add_node` above takes the same required
`scenePath="res://levels/level_01.tscn"`; it is elided after the first line only
to keep the tree readable. A call without `scenePath` is rejected by the tool
schema. Better still, send the whole block as one `summer_batch(scenePath=...,
ops=[...])` so the user can undo the skeleton with a single Ctrl+Z.

This is a **skeleton, not playable geometry**. Markers and Area3Ds, no meshes, no enemy scripts. Implementation in subsequent sessions / templates.

**Fallback (no MCP):** Print the `.tscn` file contents for the user to save manually.

### 9. Save the level design doc

Always write the design doc — it's the artifact that drives implementation. Path: `.summer/levels/<level-name>.md`.

```markdown
# Level: <Name>

**Type:** combat encounter
**Duration target:** 5 min
**Teaching goal:** Player learns parry and that parrying mid-tier enemies is required, not optional.

**Pacing curve:** 2 → 5 → 8 → 3 → 6
**Beats:** Intro (30s) | Build (90s) | Peak (60s) | Release (60s) | Hook (30s)

## Encounters
- E1 — Tutorial grunt @ 0:30 (IntroAtrium)
- E2 — Forced parry @ 1:30 (Corridor)
- E3 — Mixed wave @ 3:00 (PeakArena)
- E4 — Mini-boss @ 4:00 (BossChamber)

## Secrets
- S1 — Breakable wall (Corridor) → 50 currency
- S2 — Parry-ledge (PeakArena) → cosmetic
- S3 — Locked door (BossChamber) → next level

## Reward Gating
- Heal pickup after E2
- Ability unlock after mini-boss

## Spaces
1. IntroAtrium — open, calm
2. Corridor — tight, forces parry
3. PeakArena — large with cover
4. BossChamber — contained, dramatic

## Open questions
<list anything the user couldn't answer>
```

Ask:

> May I create `.summer/levels/<level-name>.md` with this design doc?

### 10. Route to the next step

End with:

> Skeleton + design doc saved. Next:
> - `/design-mechanic` to design any mechanics this level requires that aren't designed yet.
> - `/design-npc` to design the enemies (E1-E4) in detail.
> - `/art-direction` if the visual style isn't pinned yet.
> - Or open `levels/<level-name>.tscn` and start blocking out geometry.

## Common mistakes

| Mistake | Fix |
|---|---|
| No teaching goal | Every level teaches something or fails. State it explicitly. |
| Flat pacing curve | If intensity stays at 5 the whole time, you have a hallway, not a level. |
| Too many spaces | 4-6 distinct spaces max. More fragments the player's mental map. |
| Encounters not tied to mechanics | E2 should *require* parry, not just allow it. Forced use teaches; optional use doesn't. |
| Secrets ignore the pacing curve | Don't put a major secret in the calm intro — players aren't curious yet. |
| Reward gating too generous | Free heals before the peak deflate the peak. Gate them after the test. |
| Blending level types | Stealth + puzzle + boss in one level = three half-baked levels. Pick one. |
| Building geometry before the skeleton | Skeleton-first lets you iterate on layout cheaply. Geometry comes after the design is locked. |
| Calling SetResourceProperty before the property holds a resource | Explicit `resource is null` error, not a silent drop. Assign the resource first (`summer_set_prop key="mesh" value="BoxMesh"`), then set its sub-properties. Scene-embedded sub_resources are fully supported targets. |

## Collaborative protocol

This skill creates a new scene file (`.tscn`) and a design doc (`.md`). Group writes per phase. Always ask before `summer_create_scene`.

## Want a working starter?

This is a workflow that produces a skeleton scene. For runnable level examples, see:

- `template-id: template-3d-fps` (https://github.com/SummerEngine/FPS-template-Summer-Engine) ships a sample arena.
- `template-id: template-3d-platformer` (TBD) for jump-based level samples.

The skeleton this skill produces is meant to be filled in via `/design-mechanic`, gridmap blockout, or a template merge.

## See also

- `scene-and-project/brainstorm-game/SKILL.md` — produces `.summer/GameSoul.md`
- `gameplay-mechanics/design-mechanic/SKILL.md` — designs the verbs the level exercises
- `ai-and-npcs/design-npc/SKILL.md` — designs the enemies the encounters reference
- `rendering-and-lighting/3d-lighting/SKILL.md` — sets the lighting in `WorldEnvironment` + lights
- `rendering-and-lighting/art-direction/SKILL.md` — defines the visual style the level expresses
