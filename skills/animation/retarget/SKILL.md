---
name: retarget
description: Use when the user wants to apply existing animation clips from one rigged character to a different rigged character — same library, multiple models, no regeneration. Trigger on "retarget", "reuse animation", "apply to other character", "same animations on different model", "share animation library".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: animation
user-invocable: false
allowed-tools: Read Grep summer_search_assets summer_inspect_resource summer_retarget_motion summer_get_scene_tree summer_set_resource_property summer_save_scene
paths: ["**/*.tscn", "**/*.tres"]
---

# Retarget Motion — One Library, Many Characters

Generating a "run" clip costs ~$0.10 and 30s. If you have ten enemies, regenerating ten runs is ten generations of wasted money and clock time when one Meshy retarget call would cost ~$0.05 and take ~10s. Retarget is the right answer the moment a project has more than one rigged humanoid character.

The Meshy retarget pipeline takes a source `animationAssetId` and a target `rigAssetId`, both of which must be **Meshy-rigged humanoids**. It re-projects the animation onto the target's bone hierarchy, preserves timing and root motion, and emits a new `animationAssetId` against the target rig. The source clip is unchanged.

## When to use this skill

- "I bought (or generated) one animation library — apply all clips to my five enemies."
- "Goblin and orc have the same combat moves — share the library."
- "I have 30 NPCs with the same idle / walk / talk loop."
- The user generated motion on character A and now needs it on character B.

## When NOT to use this skill

- Source and target are not both Meshy-rigged humanoids — retarget will fail. Route to `summer:animation/generate-motion` to regenerate, or to `summer:asset-pipeline/asset-strategy` to re-rig.
- Target is a quadruped or non-humanoid (wings-only, mech, blob). Meshy retarget is humanoid-skeleton-locked. Hand-author or regenerate.
- The user wants ONE new clip on ONE character — just call `summer:animation/generate-motion`. Retarget is for fan-out.
- The user wants to retime, edit, or layer the animation — that's `summer:animation/animation-tree` and the `summer:animation/procedural-animation` additive layers.

## The compatibility check (do this BEFORE calling retarget)

The dominant failure mode is retargeting between rigs that look humanoid but have different bone counts, names, or hierarchies. Meshy auto-rigs use a fixed 52-bone humanoid skeleton — every Meshy rig is interchangeable. Mixamo / VRoid / hand-rigged FBX imports are NOT — even if they're "humanoid", the bone names differ and the retarget call rejects them.

Before calling `summer_retarget_motion`, verify:

```
summer_inspect_resource(<source_rigAssetId>)
summer_inspect_resource(<target_rigAssetId>)
```

Both responses should include `rig_provider: "meshy"` and `bone_count: 52`. If either is missing those fields or shows a different provider, **stop**. Tell the user: "Target rig isn't Meshy-rigged — retarget will fail. Either re-rig the target via `summer_generate_3d({ kind: \"image-to-3d\", imageUrl: \"...\", options: { rig: true } })` or regenerate motion directly on it via `summer:animation/generate-motion`. Which?"

If both are Meshy-rigged but the target's mesh has wildly different proportions (e.g., source is a 1.8m human, target is a 2.5m ogre with arms-down-to-knees), retarget will succeed but the *result* will look wrong — clipping, foot-floating, or limb-twisting. Warn the user before spending: "Proportions differ a lot — retarget will run but you'll likely need procedural foot IK on the result. Continue?" Hand off to `summer:animation/procedural-animation` after.

## Steps

### 1. Find the source library

```
summer_search_assets(query: "<source character>", kind: "animation")
```

Returns a list of `{ animationAssetId, name, durationSeconds }`. Cache the IDs.

### 2. Find the target rig

```
summer_search_assets(query: "<target character>", kind: "model")
```

Confirm `rigAssetId` is present and Meshy-provider.

### 3. Confirm with user before spending

Always batch-ask. Retargets are cheap individually but $0.05 × 30 clips × 5 enemies = $7.50, which deserves consent.

> I'm about to retarget 12 clips (idle, walk, run, attack, ...) from `goblin_rigged` onto `orc_rigged` — about 12 × $0.05 = $0.60, ~2 minutes total. OK?

### 4. Loop the retarget calls

```
for clip in source_clips:
  summer_retarget_motion(
    sourceAnimationAssetId: clip.animationAssetId,
    targetRigAssetId: <target_rigAssetId>,
    name: clip.name              // preserve the slot name (idle, walk, run...)
  )
  // returns { animationAssetId, durationSeconds }
```

Save the returned IDs as a map `{ name: animationAssetId }` for the target.

### 5. Attach to the target's AnimationPlayer

Same pattern as `summer:animation/generate-motion`: ensure an `AnimationPlayer` child exists, then write each clip into `libraries/default`.

```
summer_set_resource_property(
  nodePath: "./World/Orc/AnimationPlayer",
  resourceProperty: "libraries/default",
  subProperty: "<clip_name>",
  value: "<retargeted_animationAssetId>"
)
```

`summer_save_scene` once at the end, not per clip.

## Confirmation gates

- **Before any retarget call:** show the full list and total cost.
- **After the first retarget:** preview the result. If it looks wrong, stop the loop and re-evaluate (proportions, T-pose, missing bones).
- **Before saving the scene:** confirm the AnimationPlayer additions you're about to write.

## Reference card

### When retarget fails — the 5 common causes

| Symptom | Cause | Fix |
|---|---|---|
| API returns `incompatible_rig` | Target isn't Meshy-rigged | Re-rig target via `summer_generate_3d({ kind: "image-to-3d", options: { rig: true } })` |
| API returns `bone_mismatch` | Source rigged with custom bones (extra wings, etc.) | Strip extras or regenerate motion natively on target |
| Clip plays but limbs twist 180° | T-pose vs A-pose mismatch | Re-rig source from T-pose reference |
| Feet float / clip into ground | Target is much taller/shorter | Apply foot IK — see `summer:animation/procedural-animation` |
| Root motion drifts | Source had baked root translation, target scale differs | Strip root track in AnimationPlayer or scale `playback_speed` |

### Cost math (decision rule)

| Scenario | Generate fresh | Retarget |
|---|---|---|
| 1 character, 1 clip | $0.10 | n/a |
| 1 character, 12 clips | $1.20 | n/a |
| 5 characters, same 12 clips | $6.00 (5 × $1.20) | $1.80 ($1.20 + 4 × $0.60 retarget) |
| 30 NPCs, same 8-clip set | $24.00 | $6.40 ($0.80 + 29 × $0.40) |

The break-even is two characters. Past that, retarget is always cheaper.

### Pitfalls

- **Not preserving clip names.** If you don't pass `name:` to `summer_retarget_motion`, the target gets clips named `retargeted_001`, `retargeted_002` and your AnimationTree state machine breaks. Always pass the source name.
- **Retargeting one clip at a time interactively.** Batch the loop; each call has a few seconds of overhead. Sequential is fine; parallel via `summer_batch` is faster if the project supports it.
- **Forgetting the source library still owns the clips.** Source character's AnimationPlayer is unchanged. Don't accidentally re-attach the *source* IDs to the target.
- **Retargeting then regenerating "to clean it up".** If retarget produced bad output, the fix is procedural foot IK or a bone-correction modifier — not regeneration. Regeneration only makes sense if the source itself is bad.
- **Mixing Meshy and Mixamo libraries on the same character.** They have different bone-naming conventions; the AnimationPlayer tries to play tracks against bones that don't exist. Pick one rig provider per character and stick with it.

### Quality bar

- Library was originally generated on a 1.8m humanoid → target between 1.5m and 2.2m: retarget is production-ready.
- Target is 2.2m–3m: retarget runs, expect foot-clipping; layer foot IK.
- Target is < 1.5m or has cartoon proportions (big head, short limbs): retarget runs, expect noticeable limb-pop; consider regenerating natively.

## Anti-patterns

- Calling `summer_retarget_motion` without first verifying both rigs are Meshy-provider.
- Retargeting from a hand-authored animation library (Mixamo `.fbx`, etc.). The MCP wraps Meshy's retarget, which only accepts Meshy-rig source clips. For external libraries, use Godot's built-in `BoneMap` retargeting in the editor — out of scope for this skill.
- Retargeting on every gameplay session. Retarget once, persist the resulting `animationAssetId`, and reference from the scene file. The asset library survives session restarts.
- Generating motion on each enemy separately because you forgot retarget existed. The first time the project has two rigged characters, point at this skill.

## Edge cases

- **Source library uses additive blend tracks.** Additive clips (e.g., a "lean left" overlay) retarget but the additive flag is preserved only on Meshy-native rigs. Verify the `track_type` survived: `summer_inspect_resource(<retargeted_animationAssetId>)`.
- **Source has facial blendshape tracks.** Meshy retarget only handles skeleton. Facial tracks are stripped. Hand off to `summer:animation/facial-and-lipsync` to re-author per character.
- **Target rig was generated months ago and Meshy updated their skeleton schema.** Rare but happens. Symptom: bone-count mismatch even though both rigs are Meshy. Re-rig the target with a fresh `summer_generate_3d({ kind: "image-to-3d", options: { rig: true } })` call.
- **The user wants to retarget *to* the source rig as a sanity test.** Allowed and useful — round-trips should be near-identical.

## Fallback (no MCP)

Open the source `.glb` in Blender, export the animation, then in Summer Engine use the BoneMap-based humanoid retargeting workflow (Project → Tools → Bone Map). Set both source and target as humanoid profile, configure the bone mapping if names differ, save the retargeted clip into the target's `AnimationLibrary`. ~5 minutes per clip vs ~10 seconds via MCP. Documented in the Summer Engine character animation docs.

## Handoff

- After retarget, the wiring is identical to a freshly-generated clip — hand off to `summer:animation/animation-tree` for state-machine integration.
- If retarget produced foot-clipping or hand-pen-through-prop issues, hand off to `summer:animation/procedural-animation` for IK correction.
- For NPC behavior driving these clips, hand off to `summer:ai-and-npcs/design-npc`.

## See also

- `summer:animation/generate-motion` — to create the source library.
- `summer:asset-pipeline/asset-strategy` — to ensure all characters are Meshy-rigged before retargeting.
- `summer:animation/animation-tree` — wire the retargeted clips into a state machine.
- `summer:animation/procedural-animation` — fix proportional mismatches with foot IK after retarget.
