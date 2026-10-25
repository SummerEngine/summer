# Summer skills

> 137 skills, grouped by their primary domain. **Generated** by `npm run generate:registry` from each skill's `resource.yaml`; `--check` fails when this file and the library disagree. Do not edit by hand.

The folder is flat on purpose (`docs/design/DECISIONS.md`, D3): a skill usually belongs to several domains, so categories live in each skill's `facets.domains` and this index is rendered from them. The first domain listed is the primary one. `summer skills list --by-domain` prints the same grouping; `summer skills info <slug>` shows one skill.

Status: **stable** unless marked; *preview* = not yet exercised in-engine by the Summer team; ~~deprecated~~ installs only by name. ★ = installed by `--recommended`. (library only) = not installed in bulk or by the plugins; read it with `summer_read_library` or install it by name.

## Domains

- [2d](#2d) (11)
- [3d](#3d) (6)
- [agent-workflow](#agent-workflow) (23)
- [ai](#ai) (2)
- [animation](#animation) (7)
- [assets](#assets) (5)
- [audio](#audio) (6)
- [character-controller](#character-controller) (2)
- [creator](#creator) (7)
- [debug](#debug) (1)
- [deployment](#deployment) (3)
- [editor](#editor) (1)
- [gameplay](#gameplay) (6)
- [level-design](#level-design) (3)
- [multiplayer](#multiplayer) (16)
- [navigation](#navigation) (1)
- [performance](#performance) (1)
- [rendering](#rendering) (6)
- [runtime](#runtime) (1)
- [scenes](#scenes) (12)
- [scripting](#scripting) (2)
- [tools](#tools) (1)
- [ui](#ui) (2)
- [vfx](#vfx) (9)
- [video](#video) (3)

## 2d

| skill | when to use | also |
|---|---|---|
| [character-portrait](./character-portrait/SKILL.md) ★ | Generate one polished character bust for dialogue UI, character select, lore cards or codex entries. | assets |
| [concept-art](./concept-art/SKILL.md) ★ | Explore art direction with 3-4 rough concept variants of a character, environment or prop. | assets |
| [create-asset-sheet](./create-asset-sheet/SKILL.md) | Generate a pack of 2D assets from one prompt (tile sheet, UI kit, character pack, biome), sliced. | assets |
| [instantiate-asset-pack](./instantiate-asset-pack/SKILL.md) | Lay out a whole create-asset-sheet pack in the scene: composites, paint order, Sprite2D and NinePatch. | assets |
| [*painted-25d-world*](./painted-25d-world/SKILL.md) (preview) (library only) | Build a 2D or 2.5D game as a painted world: a 3D blockout under one fixed camera, an AI paint-over projected onto it, sprite characters. | level-design, rendering, assets |
| [pixel-art](./pixel-art/SKILL.md) ★ | Generate pixel-art sprites, items, tiles and portraits at a set resolution with a limited palette. | assets |
| [skybox-panorama](./skybox-panorama/SKILL.md) | Generate a 360-degree sky panorama and wire it as a PanoramaSkyMaterial Sky resource on WorldEnvironment. | assets |
| [sprite-sheet](./sprite-sheet/SKILL.md) | Generate animated 2D character sprite sheets (walk, attack, idle, death) for AnimatedSprite2D. | assets |
| [tileable-texture](./tileable-texture/SKILL.md) | Generate a seamless tileable texture for walls, floors or terrain, wired as a StandardMaterial3D albedo. | assets |
| [ui-graphics](./ui-graphics/SKILL.md) | Generate game UI art (icons, buttons, panels, frames, HUD widgets) flat, on a transparent background. | assets |
| [use-widget-asset](./use-widget-asset/SKILL.md) | Wire a widget slice from an asset pack (panel, button, bar, toggle) into NinePatchRect or TextureRect. | assets |

## 3d

| skill | when to use | also |
|---|---|---|
| [character-model](./character-model/SKILL.md) ★ | Generate a rigged humanoid (player, NPC, enemy, boss) from a T-pose reference, previewed before rigging. | assets |
| [environment-kit](./environment-kit/SKILL.md) | Generate a modular environment kit: walls, floor tiles, pillars, doors, arches in one visual style. | assets |
| [*fabricating-assets*](./fabricating-assets/SKILL.md) (preview) | Fabricate meshes with a Blender script (summer_fabricate_3d): exact-size kits, VFX meshes, post-processing. | assets, scripting, agent-workflow |
| [organic-model](./organic-model/SKILL.md) | Generate organic 3D shapes (trees, rocks, mushrooms, plants, crystals) where irregularity looks natural. | assets |
| [prop-model](./prop-model/SKILL.md) ★ | Generate one static 3D prop (sword, barrel, chest, lantern, statue): one object, no rig, a MeshInstance3D. | assets |
| [vehicle-model](./vehicle-model/SKILL.md) | Generate a hard-surface vehicle (car, spaceship, mech, boat, tank) as a static or VehicleBody3D mesh. | assets |

## agent-workflow

| skill | when to use | also |
|---|---|---|
| [*bounded-engine-runs*](./bounded-engine-runs/SKILL.md) ★ (preview) | Run Summer headless or offscreen safely: time limits, one engine per project, import passes, crash checks. | headless, verification |
| [brainstorming](./brainstorming/SKILL.md) ★ | Explore user intent, requirements and design before any creative work: features, mechanics, behavior. | game-design |
| [debugging-game-feel](./debugging-game-feel/SKILL.md) | Debug features that work but feel wrong: floaty jumps, mushy combat, sluggish camera. | gameplay |
| [diagnosing-perf-regressions](./diagnosing-perf-regressions/SKILL.md) | Find why frame rate, frame time or load time got worse since a known-good state. | performance |
| [dispatching-parallel-agents](./dispatching-parallel-agents/SKILL.md) | Work 2+ independent tasks in parallel when they share no state and have no sequential dependencies. | meta |
| [gameskill](./gameskill/SKILL.md) | Capture what a game-dev session learned as a reusable skill (project, user or Summer library) for next time. | meta |
| [*godogen-visual-proof-game-generation*](./godogen-visual-proof-game-generation/SKILL.md) (preview) (library only) | Godogen-style game generation with a visual QC loop — capture frames from the running game, self-verify against the brief, bounded fix rounds, proof clip. | verification |
| [headless-scripting](./headless-scripting/SKILL.md) ★ | Run a GDScript file against Summer Engine from the shell for what no MCP tool does: navmesh, TileSets. | headless |
| [investigating-bugs](./investigating-bugs/SKILL.md) ★ | Systematic investigation of any bug, test failure, or unexpected behavior before proposing fixes. | debug |
| [playtesting-a-feature](./playtesting-a-feature/SKILL.md) ★ | Before calling a gameplay feature done, run the game and walk through it. Static checks do not count. | verification |
| [running-in-the-cloud](./running-in-the-cloud/SKILL.md) | Run Summer Engine on a Linux box with no display: install, launch headless, xvfb, sign in without a browser. | project |
| [skill-create](./skill-create/SKILL.md) (library only) | Bootstrap a new Summer library skill (library/skills/<slug>/ with resource.yaml and SKILL.md), frontmatter, and stub sections. | meta |
| [skill-improve](./skill-improve/SKILL.md) (library only) | Upgrade an underperforming Summer skill — run it against a behavioral spec with and without changes via a parallel-eval harness; ship the winner. | meta |
| [skill-test](./skill-test/SKILL.md) (library only) | Lint a Summer skill before commit, audit the whole library, or check a behavioral spec assertion — static structural rules plus behavioral specs. | meta |
| [*summer-board*](./summer-board/SKILL.md) (preview) | Summer Board co-op: tasks, claims, files, card frames. | game-design |
| [*summer-board-modeling*](./summer-board-modeling/SKILL.md) (preview) (library only) | How granular to model a game on its Summer Board: what earns a type, what stays a note or a field, and starter type sets per genre. | game-design |
| [*summer-board-to-game*](./summer-board-to-game/SKILL.md) (preview) (library only) | Bring a Summer Board's typed cards into the game as Godot Resources, load them through BoardData, and keep board and game in step. | game-design, gameplay |
| [*summer-board-types*](./summer-board-types/SKILL.md) (preview) (library only) | Define and reuse types on a Summer Board (Character, Level, Item) so ideas become typed cards: read the board's types first, reuse before you define. | game-design |
| [*summer-cli*](./summer-cli/SKILL.md) ★ (preview) | Summer as shell commands, no MCP: sign in, run operations, follow jobs, save files, drive the engine. | assets, tools |
| [using-summer](./using-summer/SKILL.md) | Session bootstrap: how to find and use Summer skills and the summer-engine MCP before any response. | meta |
| [verification-before-completion](./verification-before-completion/SKILL.md) ★ | Run verification and read its output before claiming work done, fixed or passing: evidence first. | verification |
| [writing-plans](./writing-plans/SKILL.md) | Turn a spec or requirements for a multi-step task into a written implementation plan before touching code. | meta |
| [writing-skills](./writing-skills/SKILL.md) (library only) | Create, edit, and verify agent skills — format, structure, testing with subagents, and best practices. | meta |

## ai

| skill | when to use | also |
|---|---|---|
| [design-npc](./design-npc/SKILL.md) ★ | Design enemy, NPC, boss or companion behavior: perception, state machine, telegraphs, script stub. | npc |
| [*summer-router*](./summer-router/SKILL.md) (preview) | AI characters for games on Summer Games: Summer Router replies, tools, speech, images. | npc, multiplayer |

## animation

| skill | when to use | also |
|---|---|---|
| [animation-tree](./animation-tree/SKILL.md) | Wire AnimationTree state machines and blend trees: locomotion blends, attack interrupts, hit reactions. | 3d |
| [character-animation-wiring](./character-animation-wiring/SKILL.md) | Wire a rigged character end to end: real clips and bones, locomotion states, method tracks, root motion. | 3d |
| [facial-and-lipsync](./facial-and-lipsync/SKILL.md) | Make a character's mouth move with a voice-over: phonemes, viseme blendshapes, facial expressions. | 3d |
| [generate-motion](./generate-motion/SKILL.md) ★ | Attach a library animation clip (idle, walk, run, attack) to a rigged character via AnimationPlayer. | 3d |
| [procedural-animation](./procedural-animation/SKILL.md) | Runtime bone changes on top of clips: head look-at, foot IK, hand grabs a prop, lean, recoil. | 3d |
| [retarget](./retarget/SKILL.md) | Apply animation clips from one rigged character to another: one clip library, many models. | 3d |
| [*text-to-motion*](./text-to-motion/SKILL.md) (preview) | Make custom 2-second animation clips from text on the user's own rigged models: people, animals, props. | generate, 3d |

## assets

| skill | when to use | also |
|---|---|---|
| [asset-strategy](./asset-strategy/SKILL.md) ★ | Route any 'I need a [thing]' asset request to the right skill: 2D, 3D, audio, video, VFX or animation. | pipeline |
| [*lumera-single-image-scene-reconstruction*](./lumera-single-image-scene-reconstruction/SKILL.md) (preview) (library only) | Lumera-style single image to editable 3D scene — VLM-parsed object boxes and parametric lights, per-object meshes, HDR probe, .tscn assembly, refinement loop. | pipeline, 3d, scenes |
| [*skintokens-auto-rigging*](./skintokens-auto-rigging/SKILL.md) (preview) (library only) | Offline auto-rigging with skin-tokens.cpp (GGML SkinTokens/TokenRig port) — skeleton and skin weights from a static GLB mesh on CPU/Vulkan, into Summer Engine. | pipeline, 3d, animation |
| [*summer-api*](./summer-api/SKILL.md) (preview) | Summer API game assets: models, estimate, one job or a batch, download the files. | agent-workflow |
| [summer-assets](./summer-assets/SKILL.md) | Game assets for any engine, no Summer Engine: find, generate and download them. | agent-workflow |

## audio

| skill | when to use | also |
|---|---|---|
| [adaptive-music](./adaptive-music/SKILL.md) | Wire music stems to game state: combat, explore, boss and tension crossfades on a shared bus. | gameplay |
| [ambient-bed](./ambient-bed/SKILL.md) | Generate a long looping location ambience (forest, dungeon, city, cave) on the Ambient bus. | assets |
| [audio-direction](./audio-direction/SKILL.md) ★ | Define the game's sound (music style, SFX vocabulary, dynamic music) as .summer/audio-bible.md. | game-design |
| [music-track](./music-track/SKILL.md) ★ | Generate a music track: game loops of 30s or more with a loop point, or linear cinematic cues. | assets |
| [sound-effect](./sound-effect/SKILL.md) ★ | Make sound effects (swings, hits, whooshes, reloads, UI): three versions to pick from, then wire them. | assets |
| [voice-line](./voice-line/SKILL.md) ★ | Generate voice lines (NPC barks, narrator, dialogue) with a character-to-voice choice and multi-line support. | assets |

## character-controller

| skill | when to use | also |
|---|---|---|
| [*character-movement*](./character-movement/SKILL.md) (preview) | Player controllers for 2D and 3D, plus the standard third-person controller for Summer humanoids. | gameplay, 2d, 3d |
| [fps-controller](./fps-controller/SKILL.md) ★ | First-person controller: WASD, mouse look, jump, coyote time, jump buffering, air control. | gameplay |

## creator

| skill | when to use | also |
|---|---|---|
| [grow-analytics](./grow-analytics/SKILL.md) | Read a creator's Summer Grow numbers (page views, launches, sessions, play time), compare windows. | deployment |
| [*launch-ready*](./launch-ready/SKILL.md) (preview) (library only) | Get a game ready to launch on Summer Games and take it live: upload, real screenshots, store art and listing, gathered and filled in. | deployment, assets |
| [make-content](./make-content/SKILL.md) | Make a finished, postable video of your game, cut per platform and saved for review. | video |
| [publish-your-game](./publish-your-game/SKILL.md) | Publish a game on Summer Games over MCP: store page, art, build upload, go live. | deployment |
| [*release-checklist*](./release-checklist/SKILL.md) (preview) | Pre-launch check for Summer Games: export, upload checks, store art, listing fields. | deployment |
| [store-art](./store-art/SKILL.md) | Make Summer Games store art per slot: key art, icons, screenshots, trailer, sizes. | assets |
| [store-listing](./store-listing/SKILL.md) | Write a Summer Games store page: title, tagline, descriptions, tags, what never to write. | product-language |

## debug

| skill | when to use | also |
|---|---|---|
| [debug](./debug/SKILL.md) ★ | Disciplined bug, crash and error loop: script errors, console, debugger, hypothesis, fix, verify. | verification |

## deployment

| skill | when to use | also |
|---|---|---|
| [export-and-ship](./export-and-ship/SKILL.md) ★ | Prepare a game export: check templates and targets, validate release assets, build after approval. | project |
| [*release-readiness*](./release-readiness/SKILL.md) (preview) | Prove players can play a Summer release: server, online join, progress, files. | multiplayer, playtest |
| [remote-deploy](./remote-deploy/SKILL.md) ★ | Run or test the game on a real phone, tablet or computer with Remote Deploy and on-device debugging. | project |

## editor

| skill | when to use | also |
|---|---|---|
| [*driving-the-editor-ui*](./driving-the-editor-ui/SKILL.md) (preview) | Drive the editor UI by name: run actions, clear blocking dialogs, switch screens, read a dock. | agent-workflow, verification |

## gameplay

| skill | when to use | also |
|---|---|---|
| [auto-fire-targeting](./auto-fire-targeting/SKILL.md) | Fix auto-fire targeting (survivors, ARPG, tower defense) with pending damage to stop overkill. | game-design |
| [*celeste-momentum-platforming*](./celeste-momentum-platforming/SKILL.md) (preview) (library only) | Celeste-style 2D precision platformer movement — momentum running, coyote time, variable jumps, dash, wall jump/slide, climb stamina, pixel corner correction. | character-controller, game-design |
| [*combat-basics*](./combat-basics/SKILL.md) (preview) | Damage: hitbox and hurtbox Areas, a reusable Health component, damage signals, knockback, projectiles. | scripting, game-design |
| [design-mechanic](./design-mechanic/SKILL.md) ★ | Design one mechanic in detail (input, feedback, failure modes, tunables) as a doc plus a script stub. | game-design |
| [*in-game-purchases*](./in-game-purchases/SKILL.md) (preview) | Sell items for Sparks via the Summer purchase sheet: checkout, not enough Sparks, unlocks, grants. | scripting, game-design |
| [*web-and-touch-input*](./web-and-touch-input/SKILL.md) ★ (preview) | Browser and phone input: the first-click rule for sound and mouse capture, focus, touch buttons, a stick. | ui |

## level-design

| skill | when to use | also |
|---|---|---|
| [*concept-to-level*](./concept-to-level/SKILL.md) (preview) | 3D map from concept art to a shippable level: user questions, owned lanes, render checks, collision in step. | 3d, world-building, agent-workflow |
| [design-level](./design-level/SKILL.md) ★ | Design one level (layout, pacing, encounters, secrets) as a design doc plus a node-tree skeleton. | game-design |
| [scene-to-level](./scene-to-level/SKILL.md) | Turn a reference image or concept art into a playable scene: concept, asset pack, terrain, assembly. | game-design |

## multiplayer

| skill | when to use | also |
|---|---|---|
| [multiplayer](./multiplayer/SKILL.md) ★ | Start here for Summer multiplayer: how authority, clients, Worlds and Sessions fit, and what comes next. | project |
| [multiplayer-movement](./multiplayer-movement/SKILL.md) | Movement in Summer multiplayer: owners move instantly, others glide, the authority checks each pose. | character-controller, scripting |
| [multiplayer-project](./multiplayer-project/SKILL.md) | Set up a Summer multiplayer project: entry scenes, World and queue files, joining, a first Local Play. | project, scripting |
| [multiplayer-publish](./multiplayer-publish/SKILL.md) | Ship a hosted Summer multiplayer game: the bundle, server preset, pre-upload checks, a new Build. | deployment |
| [multiplayer-state](./multiplayer-state/SKILL.md) | Authority-owned state in Summer multiplayer: shared and private State groups, Commands, Events. | game-design, scripting |
| [multiplayer-testing](./multiplayer-testing/SKILL.md) | Test a Summer multiplayer game with Local Play: several players, bad network, bots, a passing run. | playtest, verification |
| [summer-analytics](./summer-analytics/SKILL.md) | Send game events to Summer analytics from the authority or client: fire-and-forget, never blocking gameplay. | scripting |
| [*summer-friends*](./summer-friends/SKILL.md) (preview) | Summer friends in a game: a consented friends list, profile and chat screens, direct messages. Hosted only. | ui |
| [*summer-leaderboards*](./summer-leaderboards/SKILL.md) (preview) | Leaderboards in a Summer game: queue ratings from matches, and Game rankings your authority scores. | ui |
| [summer-match-results](./summer-match-results/SKILL.md) | End a Summer match: report each player's win, loss or draw, show results on clients, then close the World. | gameplay |
| [*summer-matchmaking*](./summer-matchmaking/SKILL.md) (preview) | Get players into matches with Summer matchmaking: queues, teams, accept prompts, join progress and failures. | ux |
| [*summer-parties*](./summer-parties/SKILL.md) (preview) | Let a Summer party play together: the leader presses Play, members follow into the same match. Hosted only. | ui |
| [summer-player-data](./summer-player-data/SKILL.md) | Save a player's progress so it follows them to every match: authority load and commit, autosave, safe retries. | scripting |
| [*summer-store*](./summer-store/SKILL.md) (preview) | Sell Summer items for Sparks: shop, checkout, slugs, bundles, sales, owned items, summer.items.json sync. | gameplay |
| [*summer-world-chat*](./summer-world-chat/SKILL.md) (preview) | Add match chat to a Summer game: one World channel shared by everyone in the match. Hosted only. | ui |
| [*summer-world-saves*](./summer-world-saves/SKILL.md) (preview) | Keep a persistent Summer World between restarts: checkpoint saves, restore before join, the final save. | scripting |

## navigation

| skill | when to use | also |
|---|---|---|
| [navigate-summer](./navigate-summer/SKILL.md) ★ | Open a Summer page or editor view for the person: studio.open, and engine.view_set while you work. | agent-workflow, meta |

## performance

| skill | when to use | also |
|---|---|---|
| [tune-performance](./tune-performance/SKILL.md) ★ | Profile a slow game, find rendering, physics or script hotspots, and propose fixes with expected gains. | debug |

## rendering

| skill | when to use | also |
|---|---|---|
| [3d-lighting](./3d-lighting/SKILL.md) ★ | Light a 3D scene: sun, omni and spot lights, WorldEnvironment, sky, shadows and ambient. | lighting |
| [art-direction](./art-direction/SKILL.md) ★ | Define the game's visual style (palette, mood, lighting, post) as an art bible in .summer/art-bible.md. | lighting |
| [*compatibility-renderer-traps*](./compatibility-renderer-traps/SKILL.md) ★ (preview) | Make a Forward+ game look right on the Compatibility renderer: instance uniforms, MultiMesh, vertex colors. | performance |
| [*psx-retro-rendering*](./psx-retro-rendering/SKILL.md) (preview) (library only) | PlayStation 1 rendering in Summer Engine — low-res output, RGB5 and exact dither, affine textures, vertex snapping, blend modes, fog; limits named. | 3d |
| [*realtime-wet-surfaces*](./realtime-wet-surfaces/SKILL.md) (preview) (library only) | Real-time wetness on existing materials without losing their values — value-copying wet shader, geometry-driven wet mask, instance-uniform wet amount. | vfx |
| [*web-compatibility-look*](./web-compatibility-look/SKILL.md) ★ (preview) | Make a browser game look high-end in the Compatibility renderer (WebGL 2): what works, recipes, speed. | 2d, 3d |

## runtime

| skill | when to use | also |
|---|---|---|
| [*agent-playtesting*](./agent-playtesting/SKILL.md) ★ (preview) | Playtest by driving the live game: deterministic launch, frame-stamped probes, scripted or recorded input. | playtest, verification, agent-workflow |

## scenes

| skill | when to use | also |
|---|---|---|
| [brainstorm-game](./brainstorm-game/SKILL.md) ★ | Turn a vague game idea into a 1-page brief (genre, scope, core loop, mechanics) in .summer/GameSoul.md. | project |
| [browse-templates](./browse-templates/SKILL.md) ★ | List Summer Engine project templates, present the choices, and create a project from the chosen one. | project |
| [*camera-rigs*](./camera-rigs/SKILL.md) (preview) | Camera rigs: Camera2D follow with limits, first-person head, SpringArm3D third-person, top-down, FOV. | 3d, 2d |
| [make-game](./make-game/SKILL.md) ★ | Orchestrate 'make me a game': brainstorm, plan, scaffold, mechanics, art, audio, polish, verify, ship. | project |
| [new-project](./new-project/SKILL.md) ★ | Create a blank Summer Engine project: ask for the project name and run summer create empty. | project |
| [play](./play/SKILL.md) ★ | Run the project in Summer Engine, wait briefly, then report a clean run, errors or warnings. | project |
| [scene-composition](./scene-composition/SKILL.md) ★ | Scene structure: node hierarchy, when to extract sub-scenes, reusable prefabs, instance vs add node. | project |
| [*scene-hierarchy-design*](./scene-hierarchy-design/SKILL.md) (preview) | Structure scenes by access pattern: asset vs live hierarchies, wrapper nodes, sub-scenes, path-agnostic code. | project, agent-workflow |
| [scene-scripting](./scene-scripting/SKILL.md) ★ | Build scenes, levels, HUDs and wiring with one editor GDScript (summer_run_script) instead of call chains. | scripting, 2d, ui, agent-workflow |
| [*spatial-placement*](./spatial-placement/SKILL.md) ★ (preview) | Place 3D objects and modular kit pieces from measured geometry: floors, walls, facades, pipes, alcoves. | 3d, world-building, level-design, verification |
| [*verifying-scenes*](./verifying-scenes/SKILL.md) ★ (preview) | Prove scene work landed: snapshot, diff, screenshots, runtime reads, 3D audits, shot sheets and zooms. | verification, agent-workflow |
| [*world-building-3d*](./world-building-3d/SKILL.md) ★ (preview) | Compose, ground and space 3D scenes with Summer's four spatial tools, one geometric decision at a time. | 3d, world-building, level-design, verification |

## scripting

| skill | when to use | also |
|---|---|---|
| [gdscript-patterns](./gdscript-patterns/SKILL.md) ★ | GDScript conventions: type hints, signals, exports, onready, lifecycle methods, node paths, naming. | conventions |
| [*save-load*](./save-load/SKILL.md) (preview) | Save and load game state: user:// paths, JSON progress vs ConfigFile settings, versioned saves, autosave. | gameplay |

## tools

| skill | when to use | also |
|---|---|---|
| [*summer-apps*](./summer-apps/SKILL.md) ★ (preview) | Build a Summer App, a team tool inside Summer Studio (balance table, quest editor, tracker), data and tools. | ui, agent-workflow |

## ui

| skill | when to use | also |
|---|---|---|
| [*summer-apps-design*](./summer-apps-design/SKILL.md) ★ (preview) | How a Summer App should look: layout, Summer UI kit components, tables, charts, states, pre-ship check. | tools |
| [ui-basics](./ui-basics/SKILL.md) ★ | Build UI: HUDs, menus, health bars, dialogue boxes, Control trees, anchors, containers and themes. | ux |

## vfx

| skill | when to use | also |
|---|---|---|
| [game-feel](./game-feel/SKILL.md) ★ | Add juice: hit-flash, trauma camera shake and audio ducking, one hit fires all three. | gameplay |
| [vfx-dissolve](./vfx-dissolve/SKILL.md) | Dissolve effect: a mesh burns away with a glowing edge, from a noise-threshold ShaderMaterial. | rendering |
| [vfx-fire](./vfx-fire/SKILL.md) ★ | Fire effect: animated flames from GPUParticles3D, a particle shader and a noise color ramp. | rendering |
| [vfx-hit-spark](./vfx-hit-spark/SKILL.md) | Hit-spark effect: a one-shot burst of additive particles oriented to the surface, fired on impact. | rendering |
| [vfx-lightning](./vfx-lightning/SKILL.md) | Lightning bolt effect: a jagged procedural path with a glow shader, end sparks and screen shake. | rendering |
| [vfx-magic-glow](./vfx-magic-glow/SKILL.md) | Magic-glow effect: a pulsing OmniLight3D, drifting additive motes and an optional emission shader. | rendering |
| [vfx-muzzle-flash](./vfx-muzzle-flash/SKILL.md) ★ | Muzzle-flash effect: a one-shot ~80 ms burst at a gun barrel, from particles or a star-burst quad. | rendering |
| [vfx-smoke](./vfx-smoke/SKILL.md) | Smoke effect: a rising column or puff of soft particles with a noise and density falloff shader. | rendering |
| [vfx-water-ripple](./vfx-water-ripple/SKILL.md) | Water-ripple effect: animated normal-distortion ripples on a water plane or Decal, set off by impacts. | rendering |

## video

| skill | when to use | also |
|---|---|---|
| [animated-loop](./animated-loop/SKILL.md) | Generate a short seamless video loop: splash background, animated logo backdrop, idle title screen. | assets |
| [cinematic-cutscene](./cinematic-cutscene/SKILL.md) ★ | Generate a non-interactive cutscene: a reference-locked 5-10s video shot with optional voiced dialogue. | assets |
| [trailer-shot](./trailer-shot/SKILL.md) | Generate trailer footage: slow-mo combat, establishing shots, hero beats, splash screens, 5-10 seconds. | assets |
