---
name: generate-motion
description: "Attach a library animation clip (idle, walk, run, attack) to a rigged character via AnimationPlayer."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: animation
user-invocable: false
allowed-tools: Read Grep summer_assets_search summer_assets_get summer_assets_generate_motion summer_inspect_resource summer_get_scene_tree summer_add_node summer_set_prop summer_set_resource_property summer_save_scene summer_jobs_wait summer_call
paths: ["**/*.tscn", "**/*.tres", "**/*.gd"]
---

# Generate Motion — Curated Meshy Library

Picks a clip from a **curated mocap library** by name and wires it onto a Meshy-rigged humanoid. Fast (~30s), and it looks good because it is real mocap. The five short aliases that always work are `idle`, `walk`, `run`, `jump`, `attack`; anything else must be an exact library name — see the Reference card before you invent one.

The target must be a **Meshy-rigged humanoid** — a `rigAssetId` from a prior `assets.generate_3d({ kind: "image-to-3d", imageUrl: "...", rig: true })` call. The finished job's `result` includes `rigAssetId`. If the user points at a non-rigged mesh, stop and route to `asset-strategy` (or directly call `assets.generate_3d` with `rig: true`) before generating motion.

> **Custom or non-humanoid motion** (e.g. "drops to one knee, draws bow", a
> nodding flower, a creature) goes to the `text-to-motion` skill
> (`backend: "text-to-motion"`) when the server has it enabled; otherwise fall
> back to hand-authoring in Summer Engine or importing from Mixamo.

## When to use this skill

- "Add a walk animation to the goblin."
- "I need an idle, a run, and an attack on this character."
- "Death animation for the enemy when HP hits zero."
- The user has a rigged character and zero animations on it.

## When NOT to use this skill

- The user wants to apply an *existing* animation to a *new* model — use `retarget` instead. Don't regenerate.
- The user wants state-machine wiring (idle → walk → run blend) — generate the clips here, then hand off to `animation-tree`.
- The user wants facial / lipsync animation — that's `facial-and-lipsync`.
- The mesh isn't rigged. Rig first; never call `assets.generate_motion` on a static `.glb`.
- The user wants procedural look-at, IK, foot placement — that's `procedural-animation`.
- The user described a **custom signature move** that isn't on the curated list — use `text-to-motion`; if the server answers `backend_unavailable`, use the manual-authoring fallback below.

## Steps

### 1. Verify the target is a rigged humanoid

```
assets.search({ query: "<character name>", assetType: "3d_model", scope: "mine" })
```

The rigged model's `assetId` is its `rigAssetId` (the id the rig job's result named `rigAssetId`). Search results do not say whether a model is rigged: the dry run in step 2 checks it, and a model that is not rigged is refused there with `invalid_input` on `rigAssetId`. Then stop, propose `assets.generate_3d({ kind: "image-to-3d", imageUrl: "...", rig: true })` first (the finished job's result includes `rigAssetId`), or route to `asset-strategy`.

### 2. Confirm with the user before spending

> I'm about to generate a "run" animation on `goblin_rigged` via meshy-library — about 30s, and it uses credits. OK?

`dryRun: true` on the call below returns the credits (`estimate`) and checks the rig is the person's and rigged; clips the rig already has cost nothing, so the estimate is the most it can cost.

### 3. Call the operation

```
assets.generate_motion({
  rigAssetId: "<id>",
  backend: "meshy-library",   // curated library (default)
  motionNames: ["run"]        // exact names from the curated list — see Reference card
})
jobs.wait({ jobId: "<job.id>", timeoutSeconds: 50 })   // again until finished
```

`assets.generate_motion` answers at once with a job; `jobs.wait` follows it until
`finished` is true, and the finished job's `result` has `animationAssetId` in it.
When the rig already has every clip asked for, the answer is `done` at once with
`reused` (nothing new was made or charged). Don't assume any other field is
present — resolve the asset to get stable file/download metadata:

```
assets.get({ assetId: "<animationAssetId>" })
```

### 4. Attach to the character's AnimationPlayer

```
summer_inspect_node(path="./World/Goblin")        // confirm it has an AnimationPlayer child
summer_add_node(scenePath="res://main.tscn", parent="./World/Goblin", type="AnimationPlayer", name="AnimationPlayer")  // only if missing
summer_set_resource_property(
  scenePath="res://main.tscn",
  nodePath="./World/Goblin/AnimationPlayer",
  resourceProperty="libraries/default",
  subProperty="<motion_name>",
  value="<animationAssetId>"
)
summer_save_scene(scenePath="res://main.tscn")
```

`scenePath` is required on `summer_add_node`, `summer_set_resource_property` and
`summer_save_scene`. `summer_inspect_node` takes only `path` — it has no
`scenePath` and reads the currently-edited scene.

If the character will use multiple clips, leave the AnimationPlayer in place — every subsequent generation appends to the same library. State-machine wiring belongs to `animation-tree`, not here.

## Confirmation gates

- **Before generation:** state the motion name and that it uses credits. Wait for OK.
- **Before attaching:** state which AnimationPlayer and which library slot. Wait for OK.
- **After generation:** if the user hasn't seen the preview, link `previewUrl` and ask "land or regenerate?" before wiring it into the scene.

## Reference card

### Curated motion library — what `motionNames` actually accepts

There are **five** short canonical aliases, and only five:

`idle`, `walk`, `run`, `jump`, `attack`

Everything else must be an **exact raw Meshy library name** (or its display name,
or its numeric action id 0–696). The library is 678 entries, and its naming is
nothing like a tidy snake_case scheme — real names look like `Walking_Woman`,
`Jump_Run`, `Run_02`, `Hit_Reaction`, `Roll_Dodge`, `Block1`, `Dead`,
`Stand_Dodge`, `Triple_Combo_Attack`, `Wave_One_Hand`, `Chair_Sit_Idle_F`,
`Lean_Forward_Sprint`.

Plausible-looking names that do **not** resolve, verified against the resolver:
`attack_sword`, `hit_react`, `death`, `sprint`, `block`, `dodge_left`,
`crouch_idle`, `walk_back`, `run_strafe_left`, `jump_land`, `idle_combat`,
`wave`, `dance`, `sit_idle`. They resolve to nothing and the call errors. For a sword
attack, use `attack`.

So: if the user asks for something outside the five aliases, do not guess a
snake_case name. Either use one of the five, quote an exact raw library name you
have actually seen, or route to the manual-authoring fallback.

### Pitfalls

- **Invented `motionNames` entries fail.** `"run_fast"`, `"attack_sword"`, `"death"` all resolve to nothing and the call errors. Name resolution is exact — five aliases, or a real library name / display name / numeric id. Do not extrapolate a naming scheme.
- **Locomotion clips have a forward bias.** Meshy's `run` translates the root forward by ~5m. Either the code drives movement (then the baked root translation causes a lunge-and-snap every loop — strip it) or the clip does via `root_motion_track` + `get_root_motion_position()` — never both. The full root-motion setup and its playtest verification live in `character-animation-wiring`.
- **Rig pose mismatch.** If your rig was rigged with a non-T-pose reference image, the limbs may bend wrong. Re-rig from a T-pose mannequin (see `asset-strategy`) before re-generating.
- **Rig still preparing.** New rigs need ~3 minutes after the rig job completes before the animation library is ready. Called too early, `assets.generate_motion` answers `in_progress` with `retry: "after"` and `details.retryAfterSeconds` (about 180). Wait and retry.

## Anti-patterns

- Calling `assets.generate_motion` on a `.glb` that wasn't rigged — the call is refused; a dry run says so first.
- Generating the same clip twice because you forgot to save the `animationAssetId` from the first call. Search the asset library first: `assets.search({ query: "goblin run", assetType: "animation", scope: "mine" })`.
- Wiring clips into an AnimationTree inside this skill. That's the next skill's job. Generate, attach, hand off.
- Asking the model to invent a motion name that isn't on the list. Quote from the list verbatim, or fall back to manual authoring.

## Edge cases

- **Custom signature move** (e.g. "drops to one knee, draws bow"). The custom
  prompt-driven route is `text-to-motion`. If it is unavailable, workarounds:
  hand-author the clip in Summer Engine's animation panel, import a licensed
  clip as an `AnimationLibrary`, or compose curated clips in an
  `AnimationTree` OneShot blend.
- **Quadruped rig.** Meshy library is humanoid-only. For quadrupeds and other non-humanoid rigs use `text-to-motion`, or hand-author / import an external library.
- **Character is < 1m tall (child / dwarf).** Library clips assume a ~1.8m humanoid. Apply the clip; the proportions retarget but stride length looks long. Either accept it or tune `playback_speed` on the AnimationPlayer track.
- **Character has wings / tail.** The library ignores the extra bones — they sag. Hand-author additive overlays for the extra bones, or accept the visual hit.

## Without Summer Engine

In a session without Summer Engine tools (the assets profile; the `summer-assets` skill has the whole loop), do steps 1-3 and skip step 4 (the `AnimationPlayer`). Save the clip where the person asked with `out` on `jobs.wait` (the `summer-assets` skill says how), and tell them the path and format.

## Fallback (no MCP)

The user can upload to Meshy directly at meshy.ai, generate through the
dashboard, download `.glb`, and import it as an `AnimationLibrary` in Summer
Engine.

## Handoff

- After generating locomotion clips, suggest `character-animation-wiring` — the end-to-end wiring path (inspect what landed, idle/walk/run state machine with blend times, footstep method tracks, root motion, playtest proof). For blend spaces and attack/hit overlays on top, `animation-tree`.
- After generating a one-shot (death, hit-react), suggest `design-npc` to fire it from the behavior state machine.
- For first-person hand animations on a player, use this skill on a *hands-only rig* and then `fps-controller` for the wiring.
- If the user wants to apply these clips to a second character, hand off to `retarget`.

## See also

- `asset-strategy` — how to get a Meshy-rigged character in the first place.
- `animation-tree` — wire the generated clips into a state machine.
- `retarget` — re-use one library across many characters without regenerating.

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@4.9.0` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `assets.generate_3d` | `summer assets generate-3d` |
| `assets.generate_motion`, `summer_assets_generate_motion` | `summer assets generate-motion` |
| `summer_assets_get` | `summer assets get` |
| `assets.search`, `summer_assets_search` | `summer assets search` |
| `summer_add_node` | `summer engine add-node` |
| `summer_get_scene_tree` | `summer engine get-scene-tree` |
| `summer_inspect_node` | `summer engine inspect-node` |
| `summer_inspect_resource` | `summer engine inspect-resource` |
| `summer_save_scene` | `summer engine save-scene` |
| `summer_set_prop` | `summer engine set-prop` |
| `summer_set_resource_property` | `summer engine set-resource-property` |
| `jobs.wait`, `summer_jobs_wait` | `summer jobs wait` |
<!-- /shell-commands -->
