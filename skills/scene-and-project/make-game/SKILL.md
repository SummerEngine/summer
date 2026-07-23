---
name: make-game
description: Use when the user asks Summer to make, build, create, or prototype a game. Routes vague ideas through brainstorm-game, sends concrete briefs directly into an uninterrupted playable build, brings requested characters and animations into the MVP, and verifies the result before handoff.
license: MIT
compatibility: [Cursor, Claude Code, Codex, Windsurf, Gemini, OpenCode]
category: scene-and-project
user-invocable: true
allowed-tools: Read Edit Write Bash Skill summer_start_game_task summer_get_agent_playbook summer_get_project_context summer_get_scene_tree summer_create_scene summer_add_node summer_set_prop summer_save_scene summer_search_assets summer_list_my_assets summer_get_asset summer_import_asset_by_id summer_generate_image summer_generate_3d summer_generate_motion summer_check_job summer_clear_console summer_play summer_stop summer_get_diagnostics summer_get_script_errors summer_get_debugger_errors summer_screenshot
paths: [".summer/**", "project.godot", "**/*.gd", "**/*.tscn"]
---

# Make Game — Idea to Playable Result

Build the smallest complete version of the game the user described. Internal
setup is not a deliverable. Continue until the requested core loop is playable
and verified, or until a real material blocker requires the user.

## Route the conversation once

When the user has connected Summer but has not described a game, ask exactly one
ordinary-text routing question and wait:

> Do you already know what game you want to make, or should we brainstorm it together?

Do not render a menu or call a request-user-input tool.

### Vague idea path

If the user does not know what to make, invoke `summer:brainstorm-game`. Its
genre, core-loop, mechanics, art-direction, and scope questions are appropriate
for this path. Resume this skill after the brief exists.

### Concrete brief fast path

If the user already described the game, do not run the onboarding interview.
Extract the genre, dimension, player action, failure/restart rule, requested
character, requested assets, and visible acceptance criteria from their words.
Write a concise internal brief and build plan if useful, then proceed.

Do not ask the user about:

- file or folder architecture;
- script, scene, or component organization;
- programming patterns;
- sky, lighting, or other reversible defaults they did not emphasize;
- approval of the internal plan, scaffold, or phase transitions.

Choose the simplest sound implementation defaults yourself.

## Ask only material questions

Ask only when the answer changes the visible product, spends credits, or is
required to continue safely. Ask one compact ordinary-text question at a time.

For a requested 3D player character whose source is unspecified, ask:

> Should I use an existing/Asset Store character, generate a custom character, or use a temporary prototype?

Do not start paid generation until the relevant cost gate is satisfied. When a
custom character is chosen, use `summer:character-model` before final gameplay
wiring. When the user requested animation, or the game clearly needs humanoid
locomotion, use this default set unless they specified another set:

- idle;
- run;
- jump;
- fall;
- landing.

An explicitly requested character and animations are MVP requirements, not a
later art pass. Do not silently replace them with a permanent placeholder.

If an MCP generation result returns `status="needs_user_input"`, ask its
provided question in ordinary text, present candidates as ordinary text, and
resume the supplied request with the same `idempotencyKey`.

## Internal build sequence

### 1. Orient

Call `summer_start_game_task`, `summer_get_project_context`, and
`summer_get_agent_playbook`. Read only relevant `.summer` memory. Do not inspect
unrelated files or ask the user to make internal implementation choices.

### 2. Define the playable contract

Turn the request into observable completion criteria. A minimum game normally
requires:

- a visible controllable player;
- the primary movement/action;
- a level or challenge that exercises it;
- collision and camera behavior;
- a failure/restart or win loop where the idea calls for one;
- requested character, animation, or asset behavior;
- a clean launch and runtime verification.

For 3D parkour, the minimum playable contract is:

- movement and jumping work;
- multiple reachable platforms exist;
- procedural generation works if requested;
- falling respawns the player at the last valid platform or requested checkpoint;
- the camera follows the player;
- requested locomotion animations change with gameplay state.

### 3. Create the project as an internal step

Invoke `summer:new-project` only if no project exists. Pick the reversible
project name and starter internally when the brief already supplies enough
context.

**Scaffold is internal.** A root scene, floor, camera, light, or clean launch is
only a setup checkpoint for the agent. Do not stop after creating or opening it.
Do not show an empty scaffold as a minimum game or ask what to build next.

### 4. Resolve required assets early

Do not postpone a requested main character to a generic polish phase.

1. Search reusable/user assets first unless the user explicitly chose custom generation.
2. For a custom humanoid, run `summer:character-model` with the complete
   locomotion set.
3. Import the complete character package by exact returned ID.
4. Connect its stable wrapper, collider, controller, and animation state logic.
5. Verify the imported clips actually play on the character.

Temporary primitives are acceptable only when the user chose a prototype or
while an approved final asset is still processing. They are not the final
handoff when a specific character was requested.

### 5. Build the complete core loop

Implement mechanics in dependency order, checking each before stacking the
next:

1. player controller and camera;
2. level/challenge and collision;
3. primary action;
4. failure, respawn, restart, or win state;
5. requested character/animation integration;
6. minimum feedback needed to understand the loop.

Send brief progress updates if useful, but do not require approval between
these internal steps.

### 6. Verify before handoff

Use real engine evidence:

1. compile changed scripts with `summer_get_script_errors`;
2. clear the console;
3. run the main scene with `summer_play`;
4. inspect diagnostics and debugger errors;
5. capture the running game when supported;
6. stop the game;
7. fix failures and repeat.

For behavior requiring controls that public MCP cannot inject, verify everything
observable through the engine and ask the user for one honest manual play check.
Never infer controls or animation from a static first frame.

## Legitimate stopping conditions

Stop and ask only for:

- the initial vague-versus-concrete route;
- missing character source when it materially changes the result;
- approval before paid generation or topology-locking preview gates;
- authentication, credits, provider failure, or unavailable required input;
- contradictory requirements that cannot be resolved safely;
- destructive changes not already authorized.

Do not stop for internal scaffolding, file organization, phase boundaries, or a
clean but non-interactive scene.

## Completion rule

Do not say the game is complete merely because it compiles or renders a frame.
Handoff only after the requested playable acceptance criteria are implemented
and the available verification ladder is clean. State what was actually tested,
what still needs a manual control check, and any deliberate MVP cuts.
