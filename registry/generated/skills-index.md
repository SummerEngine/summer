# Summer skills

> 95 skills, grouped by their primary domain. **Generated** by `npm run generate:registry` from each skill's `resource.yaml`; `--check` fails when this file and the library disagree. Do not edit by hand.

The folder is flat on purpose (`docs/design/DECISIONS.md`, D3): a skill usually belongs to several domains, so categories live in each skill's `facets.domains` and this index is rendered from them. The first domain listed is the primary one. `summer skills list --by-domain` prints the same grouping; `summer skills info <slug>` shows one skill.

Status: **stable** unless marked; *preview* = not yet exercised in-engine by the Summer team; ~~deprecated~~ installs only by name. ★ = installed by `--recommended`.

## Domains

- [2d](#2d) (10)
- [3d](#3d) (6)
- [agent-workflow](#agent-workflow) (17)
- [ai](#ai) (1)
- [animation](#animation) (7)
- [assets](#assets) (3)
- [audio](#audio) (6)
- [character-controller](#character-controller) (1)
- [debug](#debug) (1)
- [deployment](#deployment) (2)
- [editor](#editor) (1)
- [gameplay](#gameplay) (3)
- [level-design](#level-design) (2)
- [multiplayer](#multiplayer) (3)
- [navigation](#navigation) (1)
- [performance](#performance) (1)
- [rendering](#rendering) (4)
- [runtime](#runtime) (1)
- [scenes](#scenes) (11)
- [scripting](#scripting) (1)
- [ui](#ui) (1)
- [vfx](#vfx) (9)
- [video](#video) (3)

## 2d

| skill | when to use | also |
|---|---|---|
| [character-portrait](./character-portrait/SKILL.md) ★ | Generate a single polished character bust for dialogue UI, character select, lore cards, or codex entries. One character, locked composition, VN-style. | assets |
| [concept-art](./concept-art/SKILL.md) ★ | Explore art direction with 3-4 rough concept variants of a character, environment, or prop to pick a vibe before committing to a final asset. | assets |
| [create-asset-sheet](./create-asset-sheet/SKILL.md) | Generate a pack of 2D game assets from one prompt — tile sheet, UI kit, character pack, or biome set — sliced, classified, and saved as one pack ArtAsset. | assets |
| [instantiate-asset-pack](./instantiate-asset-pack/SKILL.md) | Import a whole create-asset-sheet pack into the scene: groups composites, sorts paint order, emits Sprite2D/Node2D/NinePatchRect ops to lay it out. | assets |
| [pixel-art](./pixel-art/SKILL.md) ★ | Generate pixel-art assets — sprites, items, tiles, portraits — at a specific resolution with pixel-perfect grid, limited palette, retro feel. | assets |
| [skybox-panorama](./skybox-panorama/SKILL.md) | Generate a 360-degree equirectangular sky panorama and wire it as a PanoramaSkyMaterial Sky resource on WorldEnvironment in a 3D scene. | assets |
| [sprite-sheet](./sprite-sheet/SKILL.md) | Generate animated 2D character sprites laid out as a sprite sheet — walk cycle, attack, idle, death — wired into AnimatedSprite2D / SpriteFrames. | assets |
| [tileable-texture](./tileable-texture/SKILL.md) | Generate a seamless tileable texture for walls, floors, or terrain — repeats cleanly on all four edges, wired as a StandardMaterial3D albedo. | assets |
| [ui-graphics](./ui-graphics/SKILL.md) | Generate game-UI elements — icons, buttons, panels, frames, HUD widgets, badges — flat design, transparent background, wired via TextureRect/NinePatchRect. | assets |
| [use-widget-asset](./use-widget-asset/SKILL.md) | Wire a widget slice from a create-asset-sheet pack (panel, button, slider, bar, toggle) into NinePatchRect, TextureProgressBar, or TextureRect via sliceMeta. | assets |

## 3d

| skill | when to use | also |
|---|---|---|
| [character-model](./character-model/SKILL.md) ★ | Generate a rigged humanoid — player, NPC, enemy, boss — via T-pose reference, user-gated preview, and Meshy auto-rig, wired as CharacterBody3D or Node3D. | assets |
| [environment-kit](./environment-kit/SKILL.md) | Generate a modular environment kit — wall pieces, floor tiles, pillars, doors, arches, corners — snap-together meshes sharing one visual style. | assets |
| [*fabricating-assets*](./fabricating-assets/SKILL.md) (preview) | Fabricate meshes with a bpy script in the user's own Blender (summer_fabricate_3d) — kits with exact dimensions, VFX meshes, post-processing generated models. | assets, scripting, agent-workflow |
| [organic-model](./organic-model/SKILL.md) | Generate organic 3D shapes — trees, rocks, mushrooms, coral, plants, vines, crystals — where AI artifacts read as natural irregularity. | assets |
| [prop-model](./prop-model/SKILL.md) ★ | Generate a single static 3D prop — sword, barrel, chest, lantern, throne, statue — one isolated object, no rigging, wired as a MeshInstance3D. | assets |
| [vehicle-model](./vehicle-model/SKILL.md) | Generate a hard-surface vehicle — car, spaceship, mech, boat, tank — static mesh with optional detail-texture pass, wired as Vehicle3D or MeshInstance3D. | assets |

## agent-workflow

| skill | when to use | also |
|---|---|---|
| [brainstorming](./brainstorming/SKILL.md) ★ | Explore user intent, requirements, and design before implementation — must run before any creative work: features, components, mechanics, behavior. | game-design |
| [debugging-game-feel](./debugging-game-feel/SKILL.md) | Debug features that work but feel wrong — floaty jumps, mushy combat, sluggish camera — subjective bugs living in tuning, timing, and feedback layers. | gameplay |
| [diagnosing-perf-regressions](./diagnosing-perf-regressions/SKILL.md) | Find why frame rate, frame time, or load time got worse since a known-good state — regression hunting, not general performance tuning. | performance |
| [dispatching-parallel-agents](./dispatching-parallel-agents/SKILL.md) | Work 2+ independent tasks in parallel when they share no state and have no sequential dependencies. | meta |
| [gameskill](./gameskill/SKILL.md) | Capture what a game-dev session just learned as a reusable skill (project, user or Summer library) so the next session starts smarter. | meta |
| [*godogen-visual-proof-game-generation*](./godogen-visual-proof-game-generation/SKILL.md) (preview) | Godogen-style game generation with a visual QC loop — capture frames from the running game, self-verify against the brief, bounded fix rounds, proof clip. | verification |
| [headless-scripting](./headless-scripting/SKILL.md) ★ | Run a GDScript file against Summer Engine from the shell for operations no MCP tool exposes — navmesh baking, collision shapes, TileSets, re-imports. | headless |
| [investigating-bugs](./investigating-bugs/SKILL.md) ★ | Systematic investigation of any bug, test failure, or unexpected behavior before proposing fixes. | debug |
| [playtesting-a-feature](./playtesting-a-feature/SKILL.md) ★ | Before claiming a gameplay feature done: actually run the game and walk through the feature. Static diagnostics and type checks do not count. | verification |
| [running-in-the-cloud](./running-in-the-cloud/SKILL.md) | Run Summer Engine on a Linux box with no display — install it, launch headless, know when xvfb + software GL are needed, authenticate without a browser. | project |
| [skill-create](./skill-create/SKILL.md) | Bootstrap a new Summer library skill (library/skills/<slug>/ with resource.yaml and SKILL.md), frontmatter, and stub sections. | meta |
| [skill-improve](./skill-improve/SKILL.md) | Upgrade an underperforming Summer skill — run it against a behavioral spec with and without changes via a parallel-eval harness; ship the winner. | meta |
| [skill-test](./skill-test/SKILL.md) | Lint a Summer skill before commit, audit the whole library, or check a behavioral spec assertion — static structural rules plus behavioral specs. | meta |
| [using-summer](./using-summer/SKILL.md) | Session bootstrap for Summer projects — establishes how to find and use Summer skills and the summer-engine MCP before any response. | meta |
| [verification-before-completion](./verification-before-completion/SKILL.md) ★ | Run verification commands and confirm output before claiming work complete, fixed, or passing — evidence before assertions, always. | verification |
| [writing-plans](./writing-plans/SKILL.md) | Turn a spec or requirements for a multi-step task into a written implementation plan before touching code. | meta |
| [writing-skills](./writing-skills/SKILL.md) | Create, edit, and verify agent skills — format, structure, testing with subagents, and best practices. | meta |

## ai

| skill | when to use | also |
|---|---|---|
| [design-npc](./design-npc/SKILL.md) ★ | Design enemy/NPC/boss/companion behavior — perception, personality, intent, action state machine, telegraphs — outputs a GDScript stub plus node tree. | npc |

## animation

| skill | when to use | also |
|---|---|---|
| [animation-tree](./animation-tree/SKILL.md) | Design and wire AnimationTree state machines and blend trees so clips respond to gameplay — locomotion blends, attack interrupts, hit reactions. | 3d |
| [character-animation-wiring](./character-animation-wiring/SKILL.md) | Wire a rigged, animated character end to end — inspect real clips and bones, locomotion state machine, method-track events, poses, blend shapes, root motion. | 3d |
| [facial-and-lipsync](./facial-and-lipsync/SKILL.md) | Make a character's mouth move with a voice-over — phoneme extraction from audio, viseme blendshape mapping, and emotional facial expressions. | 3d |
| [generate-motion](./generate-motion/SKILL.md) ★ | Attach an animation clip to a rigged character from the curated Meshy motion library — idle, walk, run, attack — wired via AnimationPlayer. | 3d |
| [procedural-animation](./procedural-animation/SKILL.md) | Runtime bone modification on top of clips — head look-at, foot IK, hand-grabs-prop, additive lean, recoil. Code-and-modifier patterns, not generation. | 3d |
| [retarget](./retarget/SKILL.md) | Apply existing animation clips from one rigged character to a different rigged character — same library, multiple models, no regeneration. | 3d |
| [*text-to-motion*](./text-to-motion/SKILL.md) (preview) | Custom 2-second animation clips from text prompts on any of the user's own rigged models — humanoids, animals, creatures, cartoon plants, props. | generate, 3d |

## assets

| skill | when to use | also |
|---|---|---|
| [asset-strategy](./asset-strategy/SKILL.md) ★ | Route any 'I need a [thing]' asset request to the right specialist skill — disambiguates 2D / 3D / audio / video / VFX / animation pipelines. | pipeline |
| [*lumera-single-image-scene-reconstruction*](./lumera-single-image-scene-reconstruction/SKILL.md) (preview) | Lumera-style single image to editable 3D scene — VLM-parsed object boxes and parametric lights, per-object meshes, HDR probe, .tscn assembly, refinement loop. | pipeline, 3d, scenes |
| [*skintokens-auto-rigging*](./skintokens-auto-rigging/SKILL.md) (preview) | Offline auto-rigging with skin-tokens.cpp (GGML SkinTokens/TokenRig port) — skeleton and skin weights from a static GLB mesh on CPU/Vulkan, into Godot 4. | pipeline, 3d, animation |

## audio

| skill | when to use | also |
|---|---|---|
| [adaptive-music](./adaptive-music/SKILL.md) | Wire music stems to game state — combat/explore/boss/tension crossfades on a shared bus, paired with a state machine and AudioBus structure. | gameplay |
| [ambient-bed](./ambient-bed/SKILL.md) | Generate a long looping location ambience — forest, dungeon, city, spaceship, cave — a looping AudioStreamPlayer on the Ambient bus with a seamless loop. | assets |
| [audio-direction](./audio-direction/SKILL.md) ★ | Define the game's sonic identity — music style, instruments, SFX vocabulary, dynamic music plan — output as an audio bible at .summer/audio-bible.md. | game-design |
| [music-track](./music-track/SKILL.md) ★ | Generate a looped or cinematic music track — loops authored at >=30s with a marked loop point, cinematic tracks at >=60s linear. | assets |
| [sound-effect](./sound-effect/SKILL.md) ★ | Generate short SFX one-shots — footsteps, weapon swings, UI clicks, hit impacts — wired as AudioStreamPlayer/2D/3D that auto-frees on finished. | assets |
| [voice-line](./voice-line/SKILL.md) ★ | Generate TTS voice lines — NPC barks, narrator, dialogue — with voice-id sourcing, a character-to-voice decision tree, and multi-line dialogue support. | assets |

## character-controller

| skill | when to use | also |
|---|---|---|
| [fps-controller](./fps-controller/SKILL.md) ★ | Production-quality first-person controller — WASD, mouse look, jump, coyote time, jump buffering, air control, and external-velocity handling. | gameplay |

## debug

| skill | when to use | also |
|---|---|---|
| [debug](./debug/SKILL.md) ★ | Disciplined bug/crash/error loop for Summer projects — script errors, console, debugger, hypothesis, fix, verify — before making code or scene changes. | verification |

## deployment

| skill | when to use | also |
|---|---|---|
| [export-and-ship](./export-and-ship/SKILL.md) ★ | Assess and prepare a game export: inventory installed templates and targets, validate release assets and config, produce supported builds after approval. | project |
| [remote-deploy](./remote-deploy/SKILL.md) ★ | Run or test the game on a real device — phone, tablet, another computer — via the Remote Deploy button, runnable export presets, and on-device debugging. | project |

## editor

| skill | when to use | also |
|---|---|---|
| [*driving-the-editor-ui*](./driving-the-editor-ui/SKILL.md) (preview) | Drive the editor UI by name: invoke actions, clear blocking dialogs, switch the main screen, read a dock — and route scene work to the scene tools instead. | agent-workflow, verification |

## gameplay

| skill | when to use | also |
|---|---|---|
| [auto-fire-targeting](./auto-fire-targeting/SKILL.md) | Design or fix auto-fire weapon targeting (survivors, top-down ARPG, tower defense) — the pending-damage pattern that prevents over-commit and overkill. | game-design |
| [*celeste-momentum-platforming*](./celeste-momentum-platforming/SKILL.md) (preview) | Celeste-style 2D precision platformer movement — momentum running, coyote time, variable jumps, dash, wall jump/slide, climb stamina, pixel corner correction. | character-controller, game-design |
| [design-mechanic](./design-mechanic/SKILL.md) ★ | Design one game mechanic in detail — input, response, feedback, failure modes, depth, tunables — outputs a design doc, node-graph sketch, GDScript stub. | game-design |

## level-design

| skill | when to use | also |
|---|---|---|
| [design-level](./design-level/SKILL.md) ★ | Design a single level — layout, pacing, encounters, secrets, reward gating — outputs a level design doc and a node-tree skeleton for summer_create_scene. | game-design |
| [scene-to-level](./scene-to-level/SKILL.md) | Go from a scene reference image or concept art to a playable scene — orchestrates concept, asset pack, terrain, composition, and scene assembly. | game-design |

## multiplayer

| skill | when to use | also |
|---|---|---|
| [host-authoritative-state](./host-authoritative-state/SKILL.md) ★ | Design a Summer game's authoritative state: what the authority owns, Commands for intent, authority-written State groups for shared and private state. | game-design |
| [peer-to-peer-multiplayer](./peer-to-peer-multiplayer/SKILL.md) ★ | Start a multiplayer Summer game the right way: no peer-to-peer or host migration, a headless authority instead, and which Summer skill to build it with. | project |
| [setup-multiplayer](./setup-multiplayer/SKILL.md) ★ | Add multiplayer with Summer's netcode: a predicted SummerNetworkBehavior per player, a Spawner and Local Play tests. No Godot RPCs or MultiplayerSynchronizer. | scripting |

## navigation

| skill | when to use | also |
|---|---|---|
| [navigate-summer](./navigate-summer/SKILL.md) ★ | When to open a Summer web page or editor surface FOR the user (billing, their games, the scene just built) versus acting through the API, using summer_open. | agent-workflow, meta |

## performance

| skill | when to use | also |
|---|---|---|
| [tune-performance](./tune-performance/SKILL.md) ★ | Profile a slow game via summer_get_diagnostics, identify rendering/physics/scripting hotspots, propose fixes with before/after metric expectations. | debug |

## rendering

| skill | when to use | also |
|---|---|---|
| [3d-lighting](./3d-lighting/SKILL.md) ★ | Set up 3D scene lighting — DirectionalLight3D vs Omni vs Spot, WorldEnvironment, sky, shadow tuning, ambient — per current Summer conventions. | lighting |
| [art-direction](./art-direction/SKILL.md) ★ | Define the game's visual style — references, palette, mood, lighting plan, post-processing, do/don't list — output as an art bible at .summer/art-bible.md. | lighting |
| [*psx-retro-rendering*](./psx-retro-rendering/SKILL.md) (preview) | Hardware-informed PlayStation 1 rendering in Godot 4 — low-res output, RGB5 and exact dither, affine textures, vertex snapping, blend modes, fog; limits named. | 3d |
| [*realtime-wet-surfaces*](./realtime-wet-surfaces/SKILL.md) (preview) | Real-time wetness on existing Godot 4 materials without losing their values — value-copying wet shader, geometry-driven wet mask, instance-uniform wet amount. | vfx |

## runtime

| skill | when to use | also |
|---|---|---|
| [*agent-playtesting*](./agent-playtesting/SKILL.md) ★ (preview) | Playtest by driving the LIVE game — deterministic launch, frame-stamped probes before/after each action, exact frame steps, scripted or recorded input. | playtest, verification, agent-workflow |

## scenes

| skill | when to use | also |
|---|---|---|
| [brainstorm-game](./brainstorm-game/SKILL.md) ★ | Turn a vague idea into a buildable plan — genre, scope, core loop, mechanics, art direction — written as a 1-page brief to .summer/GameSoul.md. | project |
| [browse-templates](./browse-templates/SKILL.md) ★ | List available Summer Engine project templates, present the choices, and create a project from the chosen one via summer create. | project |
| [make-game](./make-game/SKILL.md) ★ | Orchestration spine for 'make me a game': brainstorm, plan, scaffold, mechanics, art, audio, polish, verify, ship — delegates to specialist skills. | project |
| [new-project](./new-project/SKILL.md) ★ | Create a fresh blank Summer Engine project — asks one question (project name) and runs summer create empty. | project |
| [play](./play/SKILL.md) ★ | Run the project in Summer Engine, wait briefly, then report what's happening — clean run, errors, or warnings. | project |
| [scene-composition](./scene-composition/SKILL.md) ★ | Scene structure conventions — node hierarchy, when to extract sub-scenes, reusable prefab patterns, and instance-versus-add-node decisions. | project |
| [*scene-hierarchy-design*](./scene-hierarchy-design/SKILL.md) (preview) | Structure Summer Engine scenes by access pattern — asset vs live hierarchies, wrapper nodes per operation, sub-scenes for reuse, path-agnostic logic. | project, agent-workflow |
| [*scene-scripting*](./scene-scripting/SKILL.md) ★ (preview) | One GDScript in the live editor (summer_run_script) builds scenes, 2D levels, HUDs and gameplay wiring instead of CRUD chains; verify with diff + screenshot. | scripting, 2d, ui, agent-workflow |
| [*spatial-placement*](./spatial-placement/SKILL.md) ★ (preview) | Place and verify 3D objects with Starcast evidence — inspect, place, starcast, correct, verify; floor, shelf, wall, alcove recipes and overlap repair. | 3d, world-building, level-design, verification |
| [*verifying-scenes*](./verifying-scenes/SKILL.md) ★ (preview) | Prove scene work landed — snapshot before, diff + screenshot after (bookmarked viewpoint, labels), live runtime reads during playtests — then claim. | verification, agent-workflow |
| [*world-building-3d*](./world-building-3d/SKILL.md) ★ (preview) | Compose, ground, space, and validate 3D scenes with Summer's four bounded spatial tools — exact paths, one geometric decision at a time, verified. | 3d, world-building, level-design, verification |

## scripting

| skill | when to use | also |
|---|---|---|
| [gdscript-patterns](./gdscript-patterns/SKILL.md) ★ | GDScript conventions — type hints, signals, exports, onready, lifecycle methods, get_node vs $NodePath, naming. | conventions |

## ui

| skill | when to use | also |
|---|---|---|
| [ui-basics](./ui-basics/SKILL.md) ★ | Build Summer Engine UI — HUDs, menus, health bars, dialogue boxes, Control trees — anchors, containers, responsive layout, theme vs inline styling. | ux |

## vfx

| skill | when to use | also |
|---|---|---|
| [game-feel](./game-feel/SKILL.md) ★ | Add juice: hit-flash, trauma-based camera shake, and audio ducking wired so one hit fires all three — for games that feel flat or lack impact. | gameplay |
| [vfx-dissolve](./vfx-dissolve/SKILL.md) | Dissolve effect — a mesh disintegrating with a glowing burning edge, driven by a noise-threshold ShaderMaterial overriding the target's material. | rendering |
| [vfx-fire](./vfx-fire/SKILL.md) ★ | Fire effect — animated flames built with a particle shader, GPUParticles3D, and a noise-based color ramp — torches, campfires, candles. | rendering |
| [vfx-hit-spark](./vfx-hit-spark/SKILL.md) | Hit-spark effect — a one-shot burst of additive billboard particles oriented to a surface normal, fired on impact. | rendering |
| [vfx-lightning](./vfx-lightning/SKILL.md) | Lightning bolt effect — procedural jagged path drawn via ImmediateMesh, glow shader, sparks at endpoints, screen shake. | rendering |
| [vfx-magic-glow](./vfx-magic-glow/SKILL.md) | Magic-glow effect — a pulsing OmniLight3D plus drifting additive motes plus optional emission shader on the source mesh. | rendering |
| [vfx-muzzle-flash](./vfx-muzzle-flash/SKILL.md) ★ | Muzzle-flash effect — a one-shot ~80 ms burst at a gun barrel built with a particle one-shot or a flashing quad with a star-burst shader. | rendering |
| [vfx-smoke](./vfx-smoke/SKILL.md) | Smoke effect — a slow-rising column or puff of soft particles built with a noise + density falloff shader on a quad mesh, GPUParticles3D. | rendering |
| [vfx-water-ripple](./vfx-water-ripple/SKILL.md) | Water-ripple effect — animated normal-distortion ripples on a water plane (or as a Decal) triggered by impacts. | rendering |

## video

| skill | when to use | also |
|---|---|---|
| [animated-loop](./animated-loop/SKILL.md) | Generate a short seamlessly-looping video clip — splash background, animated logo backdrop, idle title-screen footage — wired as a looping VideoStreamPlayer. | assets |
| [cinematic-cutscene](./cinematic-cutscene/SKILL.md) ★ | Generate a non-interactive cutscene — reference-locked look, a 5-10s image-to-video shot, optional TTS dialogue — wired as a fading VideoStreamPlayer. | assets |
| [trailer-shot](./trailer-shot/SKILL.md) | Generate marketing or trailer footage — slow-mo combat, establishing shots, hero beats, splash screens, pitch-deck B-roll — max punch in 5-10 seconds. | assets |
