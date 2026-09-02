---
name: make-game
description: "Use when the user says \"make me a game\", \"build me a game\", \"I want to make a [genre] game\", \"let's build something\" \u2014 the orchestration spine that runs the full game-dev pipeline: brainstorm \u2192 plan \u2192 scaffold \u2192 build core mechanics \u2192 art direction \u2192 audio \u2192 polish/VFX \u2192 verify \u2192 ship. Delegates to specialist skills with explicit checkpoints between phases. Trigger on \"make a game\", \"build me a game\", \"create a new game\", \"make me a game\", \"let's build a game\", \"I want to build [game shape]\"."
license: MIT
compatibility: [Cursor, Claude Code, Codex, Windsurf, Gemini, OpenCode]
category: scene-and-project
user-invocable: true
allowed-tools: Read Edit Write Bash Skill summer_get_project_context summer_get_scene_tree summer_create_scene summer_add_node summer_set_prop summer_save_scene summer_play summer_stop summer_get_diagnostics summer_get_script_errors
paths: [".summer/**", "project.godot", "**/*.gd", "**/*.tscn"]
---

# /make-game — The orchestration spine

This is the skill that runs end-to-end when a user says "make me a game." It does **not** try to do everything itself. It runs the right specialist skills in the right order with explicit handoffs and a checkpoint between every phase.

**Core principle:** structure beats vibes. A guided pipeline that delegates to focused specialists produces a real game. Off-the-cuff "let me think about it" loops produce three half-finished prototypes. Follow the phases. Don't skip.

## When to use this skill

- User says: "make me a game", "build me a game", "I want to make a [genre]", "let's build a game", "build me a [shape]".
- User has nothing yet and wants the full path from idea → playable.
- User has a vague idea and wants the agent to drive the whole arc.

## When NOT to use this skill

- User has a specific narrow ask ("add jump", "fix this bug", "design the inventory") → use the specific skill, not this orchestrator.
- User already has a working scaffold and wants to iterate → start at the relevant phase below, don't re-run the whole pipeline.
- User says "I want to use a template" → run `browse-templates` first; come back here only if they decide they want a custom build instead.

## The Pipeline

```
  Brainstorm → Plan → Scaffold → Build → Layer → Polish → Verify → Ship
       │        │        │        │        │        │       │       │
       ▼        ▼        ▼        ▼        ▼        ▼       ▼       ▼
  brainstorm  plan   new-project  build-loop   art      vfx    play  export
   -game     (this   browse-      (this skill)  audio          debug -and-
              skill) templates                                       ship
                                                                     
                                  ↓
                         (one mechanic at a time:
                          design-mechanic + scene-composition
                          + gdscript-patterns + play check)
```

Run the phases in order. Between every phase, **stop and confirm with the user before continuing.** The user owns scope decisions; the agent owns execution discipline.

## Phase 1: Brainstorm

**Goal**: turn a vague idea into a 1-page brief.

```
Skill: brainstorm-game
```

That skill asks one question, scopes mechanics, picks an art direction, and writes `.summer/GameSoul.md`. Don't skip this. **The brief is what every later phase reads.**

If the user already has `.summer/GameSoul.md` (check via Read), skip the brainstorm and confirm:

> "Found `.summer/GameSoul.md` — should I build from this brief, or do you want to start over?"

**Checkpoint before continuing:**

> "Brief saved at `.summer/GameSoul.md`. Want me to plan the build?"

## Phase 2: Plan

**Goal**: turn the brief into a concrete checklist of scenes, mechanics, and assets, in priority order.

This phase doesn't have a dedicated skill yet — do it inline. Read `.summer/GameSoul.md` and produce a plan with three sections:

1. **Core scenes** — main scene, level/menu scenes, prefabs the game needs
2. **Core mechanics** — ranked, max 3 (the brief enforces this; respect it)
3. **Cut list** — what's explicitly NOT in scope

Save the plan to `.summer/build-plan.md`. Format:

```markdown
# Build plan — <game name>

Source: .summer/GameSoul.md (date)

## Core scenes
- [ ] main.tscn — World + Player + Camera + Light + Floor
- [ ] level_01.tscn — first playable level
- [ ] hud.tscn — health, score
- [ ] (more)

## Core mechanics (in build order)
1. [ ] Movement (FPS / TPS / 2D platformer / etc.)
2. [ ] Primary action (shoot / jump / interact)
3. [ ] Win/lose state

## Cut list (NOT in scope this pass)
- Multiplayer
- Save/load
- Settings menu
- ...
```

**Checkpoint before continuing:**

> "Plan saved. Three core mechanics: movement, primary action, win condition. Anything you want to add or cut before I start building?"

## Phase 3: Scaffold

**Goal**: working project on disk, scene opens in the engine.

If the user said "I want to use a template" earlier, this is just `browse-templates`.

If from scratch:

```
Skill: new-project
```

That picks `empty` vs `3d-basic` based on the GameSoul brief. After the project is created and `summer run` succeeds:

```
Skill: scene-composition
```

To set up the canonical hierarchy for the genre. For 3D action games:

```
World (Node3D)
├── Player (CharacterBody3D)
├── Level (Node3D)
├── Lighting (Node3D)
│   ├── Sun (DirectionalLight3D)
│   └── Environment (WorldEnvironment)
├── HUD (CanvasLayer)
└── GameManager (Node)  # autoload-style, holds win/lose state
```

Save the scene. Run `summer_play` once to verify the empty scaffold opens cleanly. If it crashes, run `debug` immediately — do NOT continue building on a broken base.

**Checkpoint before continuing:**

> "Scaffold is in. Empty scene plays clean. Building mechanic 1 of N: <name>. OK?"

## Phase 4: Build (one mechanic at a time)

**Goal**: each mechanic from the plan, fully working, before moving to the next.

For each mechanic in the plan, **in order**:

1. **Design pass**:
   ```
   Skill: design-mechanic
   ```
   Outputs the mechanic spec: input, response, feedback, failure modes, depth, tunables, GDScript stub.

2. **Implement**:
   - Add the nodes via `summer_add_node` / `summer_set_prop`. Use `scene-composition` if the structure is non-trivial.
   - For movement-class mechanics, prefer the matching pre-built skill: `fps-controller`, `peer-to-peer-multiplayer`, etc.
   - Write GDScript with `gdscript-patterns` open.

3. **Verify**:
   ```
   Skill: play
   ```
   Then `summer_get_diagnostics`. Clean? Move on. Errors? `debug` until clean. **Do not stack mechanic 2 on top of a broken mechanic 1.**

4. **Checkpoint**:

   > "Mechanic 1 of N working: <name>. <One-line proof: 'WASD moves the player, jump works'>. Building mechanic 2 of N: <name>. OK?"

Repeat until every mechanic in the plan is implemented OR the user calls cut.

## Phase 5: Layer (look + sound)

**Goal**: the game stops looking like a programmer art prototype.

```
Skill: art-direction
```

That writes `.summer/art-bible.md` if it doesn't exist, then guides the lighting / material / palette pass. Use `3d-lighting` for the actual scene work.

```
Skill: audio-direction
```

Writes `.summer/audio-bible.md` and sets up the audio bus structure. Wires SFX hooks into the mechanics from Phase 4.

Use `asset-strategy` to decide whether to generate assets, search the library, or use primitives. **Public asset library search is free** — encourage it before generation, which costs credits.

**Checkpoint before continuing:**

> "Art and audio direction set. Want me to add a polish pass (juice / VFX / camera shake / hit feedback)?"

## Phase 6: Polish (skip if user wants to ship raw)

**Goal**: the game *feels* good. Hit-flash, screen shake, audio ducking, weight.

```
Skill: game-feel
```

Walks the canonical Summer Engine game-feel stack: hit flash, trauma camera
shake, and audio ducking wired so a single hit fires all three.

```
Skill: tune-performance
```

Only if `summer_get_diagnostics` flags rendering or physics hotspots. Don't optimize prematurely.

## Phase 7: Verify (final QA pass)

**Goal**: the full game runs end-to-end without errors, and the win condition can actually be reached.

1. `play` from main scene.
2. Walk every mechanic from the plan.
3. Hit the win condition (or lose condition).
4. `summer_get_diagnostics` clean.
5. `debug` until clean if not.

**Don't skip this even if every mechanic worked individually.** Integration bugs hide between mechanics.

## Phase 8: Ship

```
Skill: export-and-ship
```

Pre-flight checklist (icon, store banners, build config) before producing release builds for the targets in the brief.

If the brief said "jam" or "prototype", skip this phase. If the brief said "game I want to release", run it.

## Anti-Patterns

| Don't | Why |
|---|---|
| Skip the brainstorm because the user said "FPS" | Even with the genre named, you need the scope cut list. Otherwise mechanic 4 quietly sneaks in and the game never ships. |
| Let mechanic 2 start before mechanic 1 is verified clean | Compounding bugs. You'll spend the rest of the session debugging which mechanic broke what. |
| Stack art direction on top of unfinished mechanics | Art changes are reversible only if the underlying scene structure is stable. Get mechanics done first. |
| Treat "polish" as required | If the brief says "jam in 2 days", polish is a cut item. Respect the brief. |
| Run all phases without confirming | The user owns scope. Stop at every checkpoint. |
| Build a fully featured menu before there's a playable mechanic | Menu work is endless polish; player-loop work is the actual game. Mechanics first. |
| Fall back to "let me try a few things" mid-pipeline | If you don't know what to do, name the phase and ask the user, don't improvise around the structure. |

## What this skill produces (artifacts on disk)

By the end of a successful run, the user has:

- `project.godot` — Summer Engine project
- `main.tscn` — playable main scene
- `.summer/GameSoul.md` — the brief
- `.summer/build-plan.md` — the checklist
- `.summer/art-bible.md` — visual direction
- `.summer/audio-bible.md` — sonic direction
- One `.gd` file per mechanic
- `summer_get_diagnostics` returns clean
- `summer_play` runs end-to-end and the win condition is reachable

That's a real game. Not a half-finished prototype.

## Closing line

When all phases are done:

> "<Game name> is in. <N> mechanics, <playable from main scene to win condition>. <Brief summary of the build>. Want me to package a build (`export-and-ship`) or iterate?"

That's the handoff back to the user.
