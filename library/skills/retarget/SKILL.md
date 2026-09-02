---
name: retarget
description: Use when the user wants to apply existing animation clips from one rigged character to a different rigged character — same library, multiple models, no regeneration. Trigger on "retarget", "reuse animation", "apply to other character", "same animations on different model", "share animation library".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: animation
user-invocable: false
allowed-tools: Read Grep summer_search_assets summer_inspect_resource summer_generate_motion summer_get_scene_tree summer_set_resource_property summer_save_scene
paths: ["**/*.tscn", "**/*.tres"]
---

# Retarget Motion — One Library, Many Characters

## There is no retarget MCP tool. Read this before promising one.

Summer ships **no** `summer_retarget_motion` tool, and no other MCP tool that
re-projects an existing animation asset onto a second rig. Verify it yourself:
`grep -rn 'summer_' tools/summer-cli/src/mcp/tools/*.ts` lists every registered
tool and there is no retarget entry. Never call one — the MCP server rejects
unknown tool names outright, and inventing a cost table for it ("$0.05 a clip")
is worse than saying nothing.

Two real paths exist. Pick by whether the target rig is Meshy-rigged.

| Situation | Path |
|---|---|
| Target is Meshy-rigged and the clip name is on the curated list | Re-run `summer_generate_motion` against the target's `rigAssetId`. Same clip, ~$0.10, ~30s. |
| Target is not Meshy-rigged, or the clip is hand-authored / Mixamo / bought | In-engine retargeting: `BoneMap` + `SkeletonProfileHumanoid` + `RetargetModifier3D`. No credits, no network, but you configure the bone mapping. |

The rest of this skill covers both. The cost math that used to live here assumed a
retarget API that does not exist; the honest math is below.

## When to use this skill

- "I bought (or generated) one animation library — apply all clips to my five enemies."
- "Goblin and orc have the same combat moves — share the library."
- "I have 30 NPCs with the same idle / walk / talk loop."
- The user generated motion on character A and now needs it on character B.

## When NOT to use this skill

- The user wants ONE new clip on ONE character — just call `generate-motion`.
- The user wants to retime, edit, or layer the animation — that's `animation-tree` and the `procedural-animation` additive layers.
- Target is a quadruped or non-humanoid (wings-only, mech, blob). The curated Meshy
  library is humanoid-only and `SkeletonProfileHumanoid` is a humanoid profile.
  Hand-author instead.

## Path A — regenerate on the target rig (Meshy-rigged targets)

This is the path for the common case: several characters that all came out of
`summer_generate_3d(... rig: true)`.

### 1. Find the source clip names

```
summer_search_assets(query: "<source character>", assetType: "animation", source: "my_assets")
```

You want the *names* (`idle`, `walk`, `run`, ...), not the asset IDs — the IDs
belong to the source rig and cannot be transplanted.

### 2. Find the target rig

```
summer_search_assets(query: "<target character>", assetType: "3d_model", source: "my_assets")
```

Confirm a `rigAssetId` is present. If it is null the model was never rigged —
stop and propose `summer_generate_3d({ kind: "image-to-3d", imageUrl: "...", options: { rig: true } })`
first, or route to `asset-strategy`.

### 3. Confirm with user before spending

Regeneration is a real generation per clip per character. Say the total.

> I'm about to generate 12 clips (idle, walk, run, attack, ...) on `orc_rigged` —
> 12 × ~$0.10 = ~$1.20, a few minutes total. OK?

### 4. Loop the generation calls

```
for name in source_clip_names:
  summer_generate_motion(
    rigAssetId: "<target_rigAssetId>",
    backend: "meshy-library",
    motionName: name          // exact curated name — see generate-motion's list
  )
  // returns animationAssetId in the job result
```

Save the returned IDs as a map `{ name: animationAssetId }` for the target.

### 5. Attach to the target's AnimationPlayer

`summer_set_resource_property` requires the target scene path — it is not optional.

```
summer_set_resource_property(
  scenePath: "res://main.tscn",
  nodePath: "./World/Orc/AnimationPlayer",
  resourceProperty: "libraries/default",
  subProperty: "<clip_name>",
  value: "<animationAssetId>"
)
```

`summer_save_scene(scenePath: "res://main.tscn")` once at the end, not per clip.

## Path B — in-engine retargeting (non-Meshy rigs, bought or hand-authored clips)

The current Summer Engine build ships the retargeting stack that the MCP layer
does not wrap. Verified
instantiable on the shipped binary: `BoneMap`, `SkeletonProfileHumanoid`
(56 bones), `RetargetModifier3D`.

The shape:

1. Create a `BoneMap` resource per rig, with `profile` set to a
   `SkeletonProfileHumanoid`. Map each profile bone name to that rig's actual
   bone name. Save as `.tres` — one per distinct skeleton, reused forever.
2. On import, set the source `.glb`'s import options to use the source rig's
   `BoneMap` so its animation tracks are expressed against the humanoid profile.
3. On the target character, add a `RetargetModifier3D` under the `Skeleton3D`
   and set its `profile` to the same `SkeletonProfileHumanoid`. It re-projects
   the profile-space pose onto the target's bones each frame.

This costs no credits and works with any humanoid skeleton, including Mixamo and
hand-rigged FBX. The cost is the bone-mapping pass: a few minutes per distinct
skeleton, once.

## Confirmation gates

- **Before any generation call:** show the full clip list and total cost.
- **After the first clip:** preview the result. If it looks wrong, stop the loop
  and re-evaluate (proportions, T-pose, missing bones).
- **Before saving the scene:** confirm the AnimationPlayer additions you're about to write.

## Reference card

### Cost math (decision rule)

There is no cheaper "retarget" rate to compare against, so the real decision is
generate-per-character versus spend the time on a `BoneMap`.

| Scenario | Regenerate (Path A) | In-engine BoneMap (Path B) |
|---|---|---|
| 1 character, 12 clips | ~$1.20 | n/a — nothing to share yet |
| 5 characters, same 12 clips | ~$6.00 | $0, plus ~1 bone-map pass per distinct skeleton |
| 30 NPCs sharing one skeleton | ~$36.00 | $0 — same rig, so the clips already play on all of them |

Note the case that makes most of this moot: **NPCs that share one rig share one
animation library already.** If the user's 30 enemies are 30 instances of the
same rigged `.glb`, nothing needs retargeting — instance the scene.

### Pitfalls

- **Assuming a retarget tool exists.** It does not. Check the tool list before
  promising a capability; a hallucinated tool name fails the call outright.
- **Reusing the source `animationAssetId` on the target.** Animation assets are
  bound to the rig they were generated against. Generate against the target's own
  `rigAssetId` (Path A) or go through a `BoneMap` (Path B).
- **Omitting `scenePath`.** `summer_set_resource_property`, `summer_save_scene`,
  `summer_add_node`, and `summer_set_prop` all take a required `scenePath`.
- **Mixing Meshy and Mixamo libraries on one character without a BoneMap.** The
  bone-naming conventions differ; the AnimationPlayer plays tracks against bones
  that don't exist. One rig provider per character, or map both through the
  humanoid profile.
- **Proportion mismatch.** A library authored on a 1.8m humanoid on a 2.5m ogre
  runs, but you get foot-float and limb-twist. Layer foot IK afterwards — see
  `procedural-animation`.

### Quality bar

- Library authored on a 1.8m humanoid → target between 1.5m and 2.2m: production-ready.
- Target 2.2m–3m: expect foot-clipping; layer foot IK.
- Target < 1.5m or cartoon proportions (big head, short limbs): expect limb-pop.

## Anti-patterns

- Calling a `summer_retarget_motion` / `summer_retarget_*` tool. None exists.
- Quoting a retarget price. There is no retarget SKU to price.
- Passing an asset ID to `summer_inspect_resource`. That tool takes a `res://`
  **path** to a resource in the project, not a cloud asset ID. Use
  `summer_get_asset(assetId: ...)` for asset metadata.
- Generating motion on each enemy separately when they are instances of the same
  rig. Instance the scene; the library comes with it.

## Edge cases

- **Source has facial blendshape tracks.** Skeleton retargeting only handles
  bones. Facial tracks do not transfer. Hand off to `facial-and-lipsync`
  to re-author per character.
- **Target rig is a different Meshy skeleton generation.** Symptom: bone-count
  mismatch even though both are Meshy. Re-rig the target with a fresh
  `summer_generate_3d({ kind: "image-to-3d", options: { rig: true } })` call.
- **The clip the user wants is not on the curated list.** Path A cannot produce
  it. Either hand-author it, or import a Mixamo clip and take Path B.

## Fallback (no MCP)

Path B is the fallback and does not need MCP at all. In Summer Engine: select
the source `.glb` in the FileSystem dock, open the Import tab, create/assign a
`BoneMap` with a `SkeletonProfileHumanoid` profile, re-import. On the target
character add a `RetargetModifier3D` under `Skeleton3D` with the same profile.
Documented in the Godot 4.x "Retargeting 3D Skeletons" docs.

## Handoff

- After the clips are on the target, the wiring is identical to a freshly-generated
  clip — hand off to `character-animation-wiring` for the end-to-end
  path (inspect the target's real clip/bone names first — retargeted imports rename
  things), or `animation-tree` for blend-space/overlay graph design.
- If the result shows foot-clipping or hand-pen-through-prop issues, hand off to
  `procedural-animation` for IK correction.
- For NPC behavior driving these clips, hand off to `design-npc`.

## See also

- `generate-motion` — the tool that actually produces clips, and the curated name list.
- `asset-strategy` — getting characters rigged in the first place.
- `animation-tree` — wire the clips into a state machine.
- `procedural-animation` — fix proportional mismatches with foot IK.
