---
name: character-model
description: Use when the user has chosen to generate a custom humanoid player, NPC, enemy, boss, or companion. Creates or accepts a T-pose reference, submits one typed Meshy rig-and-animation request, handles ordinary-text animation selection, imports the complete character package, and connects it to the game build.
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex, Gemini, OpenCode]
category: 3d-assets
user-invocable: true
allowed-tools: Read Grep Edit Write Skill summer_generate_image summer_generate_3d summer_check_job summer_get_asset summer_import_asset_by_id summer_get_scene_tree summer_add_node summer_set_prop summer_save_scene summer_get_script_errors summer_play summer_get_debugger_errors summer_screenshot summer_stop
paths: ["assets/characters/**", "characters/**", "**/*.tscn", "**/*.gd"]
---

# Character Model — Complete Animated Humanoid

Use the canonical Summer/Meshy character pipeline. The result is not a loose
mesh followed by a promise to animate it later. Produce and import one complete
character package containing the rig, requested clips, stable wrapper scene,
and manifest.

## Preconditions

Run this skill after the user chose custom generation. If the game request only
says "an anime girl" or "a knight" without choosing a source, return to
`summer:make-game` and ask whether to use an existing/Asset Store character,
generate a custom character, or use a temporary prototype.

Custom generation is metered. Before calling `summer_generate_image` or
`summer_generate_3d`, state that the reference plus complete
mesh/rig/animation pipeline consumes credits and get one explicit approval.
Do not repeatedly ask about provider names, topology, polycount, or technical
model selection unless the user made those details part of the request.

## 1. Lock the visible character

Create or reuse one front-facing full-body T-pose reference:

- arms straight out horizontally;
- legs slightly apart;
- neutral pose and expression;
- entire silhouette visible;
- simple background;
- requested clothing, hair, carried props, and proportions visible.

If the user supplied an image, preserve the design and re-pose only when needed.
If no image exists, call `summer_generate_image` once with the user's visual
description and the T-pose constraints.

Show the reference and ask one visible-product approval:

> This is the character design I will turn into the rigged game model. Should I proceed with this version?

Do not ask unrelated questions while waiting.

## 2. Resolve the animation set before generation

Use the movements the user named. For a standard third-person playable
character, default to:

- idle;
- run;
- jump;
- fall;
- landing.

Add walk, attack, interact, or other clips only when the game needs them. Do not
omit explicitly requested animation and do not defer it to a later polish phase.

## 3. Submit one typed character request

Use the approved reference with the top-level character fields:

```text
summer_generate_3d(
  kind="image-to-3d",
  imageUrl="<approved reference URL>",
  title="<character name>",
  rig=true,
  animationNames=["Idle", "Run", "Jump", "Fall", "Landing"],
  targetHeightMeters=<game-appropriate height>,
  wait=false
)
```

For the initial request, use top-level `rig`, `animationNames`, and `actionIds`
instead of legacy `options`. Capture the returned `jobId` and
`idempotencyKey`.

If the response has `status="needs_user_input"`:

1. ask the supplied `question` in ordinary text;
2. list the supplied candidates as ordinary text;
3. accept the user's name or number;
4. append the exact selected `actionId` at the supplied resume path, including
   `options.actionIds` when that is the path returned by the server;
5. resubmit `resume.request` unchanged with the same `idempotencyKey`.

There is no menu, card, or request-user-input MCP tool. Repeat only when another
animation name is genuinely ambiguous.

Poll async work with `summer_check_job(jobId)`. Reuse the returned
`idempotencyKey` for transport retries. Do not submit a second paid character
job because a poll or client response timed out.

## 4. Import the complete character package

When the job is complete:

1. resolve the exact returned character asset with `summer_get_asset`;
2. confirm `asset.metadata.characterPackage.status` is `ready`;
3. call `summer_import_asset_by_id` with that exact asset ID;
4. pass `parent` and `name` when the current game scene is ready for placement.

A ready package imports to:

- `res://characters/<directoryName>/character.tscn`;
- `res://characters/<directoryName>/character.json`;
- its rig and every requested animation clip.

Use the returned `primaryPath`, `manifestPath`, and `packageRevision`. Do not
download one GLB by URL and leave the rest of the package behind. Do not search
by title after generation.

## 5. Connect the package to gameplay

For a playable character:

1. wrap or place the imported character under the game's `CharacterBody3D`;
2. add the collider and controller required by the game;
3. connect the imported animation player/library to the locomotion state logic;
4. map grounded idle/run, upward jump, downward fall, and landing;
5. keep the visual wrapper stable so character regeneration does not rewrite the
   controller.

For a non-moving cinematic NPC, a `Node3D` parent is enough. Do not wrap a
playable player in a visual-only `Node3D`.

When this skill was invoked by `summer:make-game`, return control immediately
after package import so the orchestrator can finish controller, level, respawn,
and runtime integration. The overall game task is not complete until the
requested clips respond to gameplay state.

## 6. Verify

Before reporting the character ready:

1. compile changed controller/state scripts;
2. run the scene;
3. read debugger errors;
4. verify the imported character is visible and correctly scaled;
5. verify every required animation exists;
6. exercise all observable state transitions available through the verification
   path;
7. stop the game.

If public MCP cannot inject controls, state that limitation and ask for one
manual movement/jump check. Never claim animation works from a T-pose preview or
static screenshot.

## Do not

- generate a static humanoid when animation is required;
- split a normal character into unrelated rig and per-clip paid jobs;
- omit explicit animation requests from the MVP;
- finish after importing only the mesh;
- invent a request-user-input menu;
- retry paid work with a new idempotency key;
- claim success before the package is imported and connected.
