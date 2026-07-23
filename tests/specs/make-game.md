# Skill Spec: /make-game

## Fixture

- A disposable blank Summer Engine project is open.
- Summer MCP and host file edits are available.
- No character asset has been selected.
- Paid generation is not authorized.

## Case 1: Concrete 3D parkour brief

**Input:** "Make a 3D parkour game where an anime girl jumps across procedurally generated platforms and respawns on the last valid platform after falling."

**Expected interaction and MCP sequence:**

1. `summer_start_game_task(...)`
2. Ask one ordinary-text question: existing/Asset Store character, generated custom character, or temporary prototype.
3. User answers: "Use a temporary prototype. Do not use paid generation."
4. `summer_get_project_context()`
5. Build the player/controller, camera, platforms, procedural extension, and respawn loop.
6. Compile changed scripts.
7. `summer_play(...)`
8. Read diagnostics and debugger errors.
9. Capture the running game when supported.
10. `summer_stop()`

**Assertions:**

- [ ] Does not invoke `brainstorm-game`.
- [ ] Does not ask about file/folder architecture, scene organization, programming patterns, sky, or lighting.
- [ ] Does not render a menu or call a request-user-input tool.
- [ ] Does not expose or hand off an empty scaffold.
- [ ] Does not call paid `summer_generate_*` tools after the prototype answer.
- [ ] Produces a visible controllable player with movement and jump.
- [ ] Produces multiple reachable platforms and procedural continuation.
- [ ] Falling respawns at the last valid platform.
- [ ] Camera follows the player.
- [ ] Prototype visibly supports idle, run, jump, fall, and landing states.
- [ ] Does not claim completion from compile success or a static frame alone.
- [ ] Final report distinguishes engine-verified evidence from any manual control check still required.

## Case 2: Vague game request

**Input:** "I want to make a game, but I do not know what kind."

**Expected:**

1. Ask in ordinary text whether the user knows the game or wants to brainstorm.
2. Invoke `summer:brainstorm-game` after the user chooses brainstorming.
3. Resume `summer:make-game` after the brief is defined.

**Assertions:**

- [ ] Game-design onboarding is used only on this vague path.
- [ ] The interview never asks about file/folder architecture.
- [ ] "Minimum game" is explained as a playable loop, not an empty scene.

## Case 3: Generated animated character

**Input:** "Build the same parkour game, but generate the anime witch and include the animations."

**Expected:**

1. Confirm the metered custom-character request.
2. Use `summer:character-model`.
3. Approve one T-pose reference.
4. Submit one typed rig-plus-animation request with idle, run, jump, fall, and landing.
5. Handle any `needs_user_input` result with an ordinary-text question and the same idempotency key.
6. Import the complete character package by exact ID.
7. Connect the package to controller and locomotion state logic before completing the game.

**Assertions:**

- [ ] Requested model and animations remain MVP acceptance criteria.
- [ ] Does not permanently substitute a primitive placeholder.
- [ ] Does not split the normal character into unrelated rig and per-clip paid jobs.
- [ ] Does not finish after importing only the mesh.
