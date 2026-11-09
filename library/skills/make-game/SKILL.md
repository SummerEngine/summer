---
name: make-game
description: "Orchestrate 'make me a game': brainstorm, plan, scaffold, mechanics, art, audio, polish, verify, ship."
license: MIT
compatibility: [Cursor, Claude Code, Codex, Windsurf, Gemini, OpenCode]
category: scene-and-project
user-invocable: true
allowed-tools: Read Edit Write Bash Skill summer_get_project_context summer_get_scene_tree summer_create_scene summer_run_script summer_add_node summer_set_prop summer_save_scene summer_play summer_stop summer_get_diagnostics summer_get_script_errors
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

## Genre playbooks (`references/`)

Distilled blueprints for common genres live in this skill's `references/` folder: architecture, scene tree, collision layers, core-loop code, build order, traps. Each genre is two files — a core file and a systems/polish file. Read the core file during Phase 2 (Plan) so the build plan follows its architecture and build order; read the systems file only when Phase 4 reaches those mechanics. Never load more than the one genre you are building.

| Game | Core | Systems | Root / player / camera |
|---|---|---|---|
| Side-scrolling platformer | `references/2d-platformer.md` | `references/2d-platformer-polish.md` | Node2D / CharacterBody2D / Camera2D follow |
| Horde survivors / bullet heaven | `references/2d-survivors.md` | `references/2d-survivors-progression.md` | Node2D / CharacterBody2D / Camera2D on player |
| Top-down action RPG (also the base for puzzle, grid, tower defense) | `references/2d-rpg.md` | `references/2d-rpg-content.md` | Node2D / CharacterBody2D / Camera2D |
| First-person shooter | `references/3d-fps.md` | `references/3d-fps-systems.md` | Node3D / CharacterBody3D / Camera3D on Head |
| Third-person action / 3D platformer | `references/3d-third-person.md` | `references/3d-third-person-systems.md` | Node3D / CharacterBody3D / SpringArm3D |
| First-person horror | `references/3d-horror.md` | `references/3d-horror-systems.md` | Node3D / CharacterBody3D / Camera3D on Head |

**2D and 2.5D games look painted.** For any 2D or 2.5D request (top-down, RPG, cozy, side-scroller, platformer look), build the world with the `painted-25d-world` skill: a 3D blockout under one fixed orthographic camera, an AI paint-over projected onto the blocks, sprite characters (Node3D / CharacterBody3D / translate-only Camera3D). Use the 2D playbooks above for the core loop, mechanics and build order only, not for the scene tree or art. Do not start a 2D game from a 2D template unless the user asks for that template.

No playbook (racing, sandbox, sim): build fresh through the phases below. The playbooks lean on these system skills — load one when its mechanic comes up: `character-movement`, `camera-rigs`, `combat-basics`, `save-load`, `ui-basics`, `multiplayer-project`.

These rules from the playbooks apply to every genre:

- **2D scales to the viewport.** Set `display/window/stretch/mode = canvas_items` and `stretch/aspect = expand`; UI uses Control anchors; code-positioned nodes compute from `get_viewport_rect().size`. Never hardcode 1920x1080.
- **Playable slice, not tech demo.** Name the core loop in one sentence; every input gets feedback (tween, sound, particle, flash, shake); progression is visible; a restart exists. The bar is "feels good for 30 seconds".
- **The first playable already looks good.** People judge Summer by the first frame of their first game, so the first version looks finished even when they ask for a quick prototype: keep the features they asked for and raise the look. Sky and sun with shadows, tonemapping and a little fog; a texture on every surface; real models for the player, characters and main props from the starter project or the Summer asset library (`summer_assets_search`), never capsules or boxes as final art; one colour palette; a styled UI font. Generation takes minutes, so it never blocks the first play: use starter and library art first, plus at most one or two generated assets the person asked for, and generate the rest in later passes. Before you say it is ready, play it and look at a screenshot of the running game, not the editor (the editor shows a preview sky and sun that the game does not have).
- **A way back to the title.** From inside play, a pause menu or a **Leave** button returns to the title screen without quitting the app.
- **Text the default font can show.** No emoji or symbols (▲ ◀ ★ ♥ ✓) in UI text: they render as boxes with hex codes. Use words or icons; see `ui-basics`.

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

If the game has online play, the plan also fixes three product defaults; each one was missed by a real release:

- **Online play is reachable by default.** A new player gets to it from the title without changing a setting. Hiding it behind a setting or a grown-ups gate is the owner's explicit decision, recorded in the plan, and it means someone joins online before every release.
- **Progress is saved by the server.** Online progress goes through authority player data (`summer-player-data`), not only the player's local files.
- **A way back to the title** from inside an online and an offline session.

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

Build that hierarchy in one `summer_run_script` with the scene's `scenePath` (see `scene-scripting`), not node by node, and end the script with `ctx.save_scene()`. Run `summer_play` once to verify the empty scaffold opens cleanly. If it crashes, run `debug` immediately — do NOT continue building on a broken base.

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
   - Add the nodes: 3 or more scene edits are one `summer_run_script` with `scenePath` (snapshot, script, diff, screenshot); a single tweak is one `summer_set_prop`. Use `scene-composition` if the structure is non-trivial.
   - For movement-class mechanics, prefer the matching pre-built skill: `character-movement`, `fps-controller`, `multiplayer-movement`, etc. Follow the genre playbook's build order when one applies.
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

**Goal**: deepen the look and add sound. The first playable already looks good (see "The first playable already looks good" above); this phase writes the art bible, replaces the remaining stand-in art and adds audio.

```
Skill: art-direction
```

That writes `.summer/art-bible.md` if it doesn't exist, then guides the lighting / material / palette pass. Use `3d-lighting` for the actual scene work. For the web, check the target first. A summer.games web build (`summer_export_game` with `targets:["web"]`) runs on Summer's WebGPU template, which needs the Forward+ or Mobile renderer. A WebGL 2 target runs the Compatibility renderer only: follow `web-compatibility-look` there, avoid Forward+-only features (SDFGI, SSAO, SSR, volumetric fog), and keep `rendering/renderer/rendering_method` on `gl_compatibility`.

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
4. Return to the title from inside play, then start again.
5. Online games: run Local Play (`multiplayer-testing`) and reach online play from the title as a new player, with default settings.
6. `summer_get_diagnostics` clean.
7. `debug` until clean if not.

**Don't skip this even if every mechanic worked individually.** Integration bugs hide between mechanics.

## Phase 8: Ship

```
Skill: export-and-ship
```

Pre-flight checklist (icon, store banners, build config) before producing release builds for the targets in the brief.

Before any version reaches players, run:

```
Skill: release-readiness
```

It checks the file you upload, not the editor: a hosted game's `server.pck` starts its authority scene, `Summer.initialize` passes no hard-coded Game ID, online play is reachable, progress is saved by the server, and players can get back to the title. Then, after publishing, the user joins online with the released version. Report each check as pass, fail, not applicable or not run. Hosted games publish through `multiplayer-publish`; store pages through `publish-your-game`.

If the brief said "jam" or "prototype", skip this phase. If the brief said "game I want to release", run it.

## Anti-Patterns

| Don't | Why |
|---|---|
| Skip the brainstorm because the user said "FPS" | Even with the genre named, you need the scope cut list. Otherwise mechanic 4 quietly sneaks in and the game never ships. |
| Let mechanic 2 start before mechanic 1 is verified clean | Compounding bugs. You'll spend the rest of the session debugging which mechanic broke what. |
| Change the art style while mechanics are unfinished | Art changes are reversible only if the underlying scene structure is stable. Get mechanics done before a new style; the first playable still starts good-looking. |
| Treat "polish" as required | If the brief says "jam in 2 days", polish is a cut item. Respect the brief. |
| Run all phases without confirming | The user owns scope. Stop at every checkpoint. |
| Ship online play behind a setting nobody changes | Hosted join is never exercised, so it breaks without anyone noticing. Reachable by default, or the owner joins online before every release. |
| Hard-code a Game ID in `Summer.initialize` | The summer.games bundle has no `gameId`; a different ID fails on the hosted server and every online join times out. Pass no ID. |
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

## Closing line

When all phases are done:

> "<Game name> is in. <N> mechanics, <playable from main scene to win condition>. <Brief summary of the build>. Want me to package a build (`export-and-ship`) or iterate?"

That's the handoff back to the user.

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@latest` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `assets.search`, `summer_assets_search` | `summer assets search` |
| `summer_docs_read` | `summer docs read` |
| `summer_add_node` | `summer engine add-node` |
| `summer_batch` | `summer engine batch` |
| `summer_create_scene` | `summer engine create-scene` |
| `summer_export_game` | `summer engine export-game` |
| `summer_get_diagnostics` | `summer engine get-diagnostics` |
| `summer_get_project_context` | `summer engine get-project-context` |
| `summer_get_scene_tree` | `summer engine get-scene-tree` |
| `summer_get_script_errors` | `summer engine get-script-errors` |
| `summer_import_asset` | `summer engine import-asset` |
| `summer_import_asset_by_id` | `summer engine import-asset-by-id` |
| `summer_play` | `summer engine play` |
| `summer_replace_text` | `summer engine replace-text` |
| `summer_run_script` | `summer engine run-script` |
| `summer_save_scene` | `summer engine save-scene` |
| `summer_set_prop` | `summer engine set-prop` |
| `summer_set_resource_property` | `summer engine set-resource-property` |
| `summer_stop` | `summer engine stop` |
| `summer_write_file` | `summer engine write-file` |
<!-- /shell-commands -->
