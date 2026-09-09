---
name: generate-motion
description: Use when the user needs an animation clip on a rigged character — idle/walk/run/attack from the curated Meshy library. Picks the right curated motion, attaches the resulting clip to an AnimationPlayer. Trigger on "animation", "animate", "idle", "walk", "run", "attack animation", "motion", "mocap", "dance", "death animation".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: animation
user-invocable: false
allowed-tools: Read Grep summer_search_assets summer_list_my_assets summer_get_asset summer_get_asset_download_url summer_generate_motion summer_inspect_resource summer_get_scene_tree summer_add_node summer_set_prop summer_set_resource_property summer_save_scene
paths: ["**/*.tscn", "**/*.tres", "**/*.gd"]
---

# Generate Motion — Curated Meshy Library

Picks a clip from a **curated mocap library** by name and wires it onto a Meshy-rigged humanoid. Fast (~30s) and cheap (~$0.10) and looks great because it's real mocap. The five short aliases that always work are `idle`, `walk`, `run`, `jump`, `attack`; anything else must be an exact library name — see the Reference card before you invent one.

The target must be a **Meshy-rigged humanoid** — a `rigAssetId` from a prior `summer_generate_3d({ kind: "image-to-3d", imageUrl: "...", options: { rig: true } })` call. The result job includes `rigAssetId`. If the user points at a non-rigged mesh, stop and route to `asset-strategy` (or directly call `summer_generate_3d` with `options.rig: true`) before generating motion.

> **Custom prompt-driven motion** (e.g. "drops to one knee, draws bow") is on
> the roadmap but not shipped yet. For one-off signature moves not on the
> curated list, fall back to hand-authoring in Summer Engine or importing from
> Mixamo. See the Edge cases section.

## Web Chat / Public Orchestrator Equivalent

In PublicSummerEngine chat, the equivalent direct tools are:

```
rigModel({ modelAssetId })
generateAnimation({ rigAssetId, animationName })
meshyJobStatus({ jobId })
```

If the character came from `createCharacter`, it may already be rigged and have `metadata.meshyRigTaskId`; generate animations directly against that rig asset. Verified animation names from the recovered production flow are `idle`, `walk`, `run`, `jump`, and `attack`. `fall` returned `invalid_animation`, so do not present it as a default.

Before generating clips in PublicSummerEngine chat, confirm the rig asset listing/status exposes `hasMeshyRigTask` or `animationsReady:true`. If `generateAnimation` returns `animations_preparing`, wait, poll/list the rig again, and retry; this is the post-rig setup catching up, not a reason to send the user to Studio.

After animation jobs complete, import the rig plus child animation assets together and wire them through `import-character`. Do not hand off to Studio unless the user asked for Studio/manual control or the direct chat tools fail.

## When to use this skill

- "Add a walk animation to the goblin."
- "I need an idle, a run, and an attack on this character."
- "Death animation for the enemy when HP hits zero."
- The user has a rigged character and zero animations on it.

## When NOT to use this skill

- The user wants to apply an *existing* animation to a *new* model — use `retarget` instead. Don't regenerate.
- The user wants state-machine wiring (idle → walk → run blend) — generate the clips here, then hand off to `animation-tree`.
- The user wants facial / lipsync animation — that's `facial-and-lipsync`.
- The mesh isn't rigged. Rig first; never call `summer_generate_motion` on a static `.glb`.
- The user wants procedural look-at, IK, foot placement — that's `procedural-animation`.
- The user described a **custom signature move** that isn't on the curated list. Today, route to the manual-authoring fallback below.

## Steps

### 1. Verify the target is a rigged humanoid

```
summer_search_assets(query="<character name>", assetType="3d_model", source="my_assets")
```

The result must include `rigAssetId: <id>` on a Meshy rig. If it shows `rigAssetId: null`, the model isn't rigged — stop, propose `summer_generate_3d({ kind: "image-to-3d", imageUrl: "...", options: { rig: true } })` first (the result includes `rigAssetId`), or route to `asset-strategy`.

### 2. Confirm with the user before spending

> I'm about to generate a "run" animation on `goblin_rigged` via meshy-library — about 30s, ~$0.10. OK?

### 3. Call the tool

```
summer_generate_motion(
  rigAssetId: "<id>",
  backend: "meshy-library",   // only option today
  motionName: "run"           // exact name from the curated list — see Reference card
)
```

With the default `wait: true` the tool polls to completion and returns the job
result with `animationAssetId` in it. Don't assume any other field is present —
resolve the asset to get stable file/download metadata:

```
summer_get_asset(assetId="<animationAssetId>")
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

- **Before generation:** state the motion name and est. cost (~$0.10). Wait for OK.
- **Before attaching:** state which AnimationPlayer and which library slot. Wait for OK.
- **After generation:** if the user hasn't seen the preview, link `previewUrl` and ask "land or regenerate?" before wiring it into the scene.

## Reference card

### Curated motion library — what `motionName` actually accepts

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
`wave`, `dance`, `sit_idle`. They return `null` and the call errors. The tool's
own description uses `attack_sword` as an example — that example is wrong; use
`attack`.

So: if the user asks for something outside the five aliases, do not guess a
snake_case name. Either use one of the five, quote an exact raw library name you
have actually seen, or route to the manual-authoring fallback.

### Pitfalls

- **Invented `motionName` strings fail.** `"run_fast"`, `"attack_sword"`, `"death"` all resolve to nothing and the call errors. Name resolution is exact — five aliases, or a real library name / display name / numeric id. Do not extrapolate a naming scheme.
- **Locomotion clips have a forward bias.** Meshy's `run` translates the root forward by ~5m. Either the code drives movement (then the baked root translation causes a lunge-and-snap every loop — strip it) or the clip does via `root_motion_track` + `get_root_motion_position()` — never both. The full root-motion setup and its playtest verification live in `character-animation-wiring`.
- **Rig pose mismatch.** If your rig was rigged with a non-T-pose reference image, the limbs may bend wrong. Re-rig from a T-pose mannequin (see `asset-strategy`) before re-generating.
- **Rig still preparing.** New rigs need ~3 minutes after the rig job completes before the animation library is ready. The MCP route returns 425 "animations_preparing" if you call too early. Wait and retry.

## Anti-patterns

- Calling `summer_generate_motion` on a `.glb` that wasn't rigged — wastes a generation; the API errors but only after 30s.
- Generating the same clip twice because you forgot to save the `animationAssetId` from the first call. Search the asset library first: `summer_search_assets(query: "goblin run", assetType: "animation", source: "my_assets")`.
- Wiring clips into an AnimationTree inside this skill. That's the next skill's job. Generate, attach, hand off.
- Asking the model to invent a `motionName` that isn't on the list. Quote from the list verbatim, or fall back to manual authoring.

## Edge cases

- **Custom signature move** (e.g. "drops to one knee, draws bow"). The custom
  prompt-driven backend is on the roadmap but not shipped today. Workarounds:
  hand-author the clip in Summer Engine's animation panel, import a licensed
  clip as an `AnimationLibrary`, or compose curated clips in an
  `AnimationTree` OneShot blend.
- **Quadruped rig.** Meshy library is humanoid-only. For quadrupeds, hand-author or import a Mixamo-style external library (out of scope for this skill).
- **Character is < 1m tall (child / dwarf).** Library clips assume a ~1.8m humanoid. Apply the clip; the proportions retarget but stride length looks long. Either accept it or tune `playback_speed` on the AnimationPlayer track.
- **Character has wings / tail.** The library ignores the extra bones — they sag. Hand-author additive overlays for the extra bones, or accept the visual hit.

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
