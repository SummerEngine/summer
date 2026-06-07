---
name: character-model
description: Use when generating a humanoid character ready for animation — player avatar, NPC, enemy, boss, companion. Generates a T-pose reference image, gates an un-rigged preview past the user, then runs the Meshy auto-rig pass and wires the result as a CharacterBody3D (movement) or Node3D (cinematic). Trigger on "make a character", "generate the player", "I need an enemy model", "create an NPC", "rigged humanoid", "character with a skeleton", "model for animation".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: 3d-assets
user-invocable: true
allowed-tools: Read Grep summer_search_assets summer_list_my_assets summer_get_asset summer_import_asset_by_id summer_generate_image summer_generate_3d summer_import_from_url summer_add_node summer_set_prop summer_set_resource_property summer_inspect_node summer_inspect_resource summer_get_scene_tree summer_save_scene summer_check_job summer_generate_motion
paths: ["assets/characters/**", "assets/models/**", "**/*.tscn", "**/*.gd"]
---

# Character Model — T-Pose to Rigged Humanoid, Gated

This is the **canonical Meshy auto-rig pipeline**. It produces a humanoid `.glb` with a Meshy-compatible skeleton that `summer:animation/generate-motion` can drive directly. The work is split into two paid passes with a **mandatory user-review gate between them** — the rig pass is more expensive and locks the topology, so the user must see the un-rigged preview and approve before you spend on the rig.

The whole flow:

```
1. T-pose reference image    →  summer_generate_image                          (~$0.05, ~10s)
2. Un-rigged 3D mesh         →  summer_generate_3d(image-to-3d)                (~$0.50, ~60s)
3. ── USER REVIEW GATE ──
4. Rigged .glb               →  summer_generate_3d(image-to-3d, rig: true)     (~$1.00, ~90s)
5. Import → editor RESTART → wire as CharacterBody3D / Node3D
6. Hand off to summer:animation/generate-motion for clips
```

The animation skill (`summer:animation/generate-motion`) requires a rigged humanoid; a static `.glb` won't drive motion.

## Web Chat / Public Orchestrator Equivalent

When this skill is running inside the PublicSummerEngine chat orchestrator, use the chat-native tools directly instead of sending the user to Studio:

```
generateImage -> createCharacter -> checkGenerationStatus/meshyJobStatus -> listUserAssets readiness -> rigModel if needed -> generateAnimation -> meshyJobStatus -> importAssets -> import-character
```

Use Studio only when the user explicitly asks for visual/manual picking or when chat-side generation fails. The recovered working flow used `createCharacter`, confirmed the rig had `hasMeshyRigTask` or `animationsReady:true`, then generated `idle`, `walk`, `run`, `jump`, and `attack`, imported the rig plus child animation GLBs into `res://characters/<slug>/`, then wired playback from the imported GLB AnimationPlayers/libraries. If `generateAnimation` returns `animations_preparing`, wait, poll/list the rig asset again, and retry instead of routing to Studio. Keep this path repeatable for "animated character", "3D character with animations", "walking enemy", and similar prompts.

## When to use

- "Make a knight character for the player to control."
- "I need a goblin enemy."
- "Generate an old wizard NPC for the tavern."
- "Create a boss — a four-armed demon."
- The user is about to ask for animations and has nothing rigged yet.

## When NOT to use

- Static statue / mannequin display piece (no rig needed) → `summer:3d-assets/prop-model`.
- Vehicle with a "driver" silhouette but no skeleton needed → `summer:3d-assets/vehicle-model`.
- Quadruped (wolf, horse, dragon) → Meshy auto-rig is humanoid-only. Generate the mesh here for visuals, but skip the rig step — animation will need a hand-authored skeleton or a quadruped-specific provider (out of scope for this skill).
- The user already has a rigged character and just wants a re-skin — that's a retexture pass, not this skill.
- Facial blendshapes / lipsync rig → `summer:animation/facial-and-lipsync`.

## Polycount targets

| Role | Tris | Pass via |
|---|---|---|
| Hero character (player, close camera) | 8k–15k | `target_polycount: 12000` |
| Grunt enemy (mid-range, multiple onscreen) | 3k–6k | `target_polycount: 5000` |
| Crowd / background NPC (LOD-able) | 1k–2k | `target_polycount: 1500` |
| Mobile-game character | 1k–3k | `target_polycount: 2000` |
| Cinematic hero (no realtime constraint) | 20k–40k | `target_polycount: 30000` |

Pass at the **mesh-generation step** (step 2). The rig pass preserves the topology; you can't reduce polycount after rigging without breaking weights.

## Steps

### 1. Generate the T-pose reference image

The rig pass requires a **front-facing T-pose** with arms out and legs slightly apart. If the reference is in an action pose, the rig will bend wrong and locomotion clips will look broken (knees inverted, elbows snapped — common Meshy failure mode).

```
summer_generate_image(
  prompt="A fantasy knight in full plate armor, red cape, T-pose, arms straight out horizontal, legs slightly apart, front-facing, neutral expression. Game character asset, stylized, clean white background, soft studio lighting, full body in frame, ready for 3D mesh generation.",
  model="nano-banana-2"
)
```

The phrase `T-pose, arms straight out horizontal, legs slightly apart, front-facing` is load-bearing — drop any of those and the model will drift toward A-pose or a hero stance.

If the user already has a concept image in an action pose, re-pose it to T-pose via img2img without re-rolling the design:

```
summer_generate_image({
  referenceImageUrl: "<existing concept image>",
  prompt: "<character> in T-pose, arms extended horizontally, neutral facing camera, white background, clean lighting"
})
```

Show the image to the user:

> Generated the T-pose reference. [link]. Approve to proceed to mesh generation, or regenerate?

### 2. Generate the un-rigged 3D mesh

```
summer_generate_3d(
  kind="image-to-3d",
  imageUrl="<image url from step 1>",
  model="hunyuan",
  options={ target_polycount: 12000 },
  wait=true
)
```

Returns a job result with `assetId` and `fileUrl` — an un-rigged static `.glb`.
Use the asset ID as the stable handle. Import it for preview only:

```
summer_get_asset(assetId="<assetId>")
summer_import_asset_by_id(
  assetId="<assetId>",
  path="res://assets/characters/knight_unrigged.glb"
)
```

### 3. ⛔ USER REVIEW GATE — DO NOT SKIP

Before paying for the rig pass, surface the un-rigged mesh:

> Un-rigged knight mesh ready: `res://assets/characters/knight_unrigged.glb` (~12k tris, [preview link]).
>
> Next step is the **rig pass** (~$1.00, ~90s, Meshy auto-rig). It locks the topology and adds a skeleton compatible with `summer:animation/generate-motion`. Once you approve I'll run it.
>
> **Approve the mesh and proceed to rig?** Or regenerate the mesh first (different prompt, different polycount, different model)?

If the user wants changes, loop back to step 1 or 2. Do NOT silently run the rig pass — it doubles the cost and locks the design.

### 4. Run the rig pass

```
summer_generate_3d({
  kind: "image-to-3d",
  imageUrl: "<image url from step 1>",
  options: { rig: true, polyTarget: 12000 }   // polyTarget is best-effort; backend may use options.target_polycount
})
```

Returns a job whose result includes `assetId`, `fileUrl`, and `rigAssetId`.
If you ran with `wait: false`, poll via `summer_check_job(jobId)`. The
`rigAssetId` is the handle `summer:animation/generate-motion` needs — store it.
Resolve it before import so the agent has the viewer/download metadata:

Import the rigged version, replacing the un-rigged file:

```
summer_get_asset(assetId="<rigAssetId>")
summer_import_asset_by_id(
  assetId="<rigAssetId>",
  path="res://assets/characters/knight.glb"
)
```

### 5. ⚠️ Restart the editor

**Known Godot 4.5 gotcha:** after importing a rigged `.glb`, the `Skeleton3D` node appears stale in the scene dock — bones are missing, `skeleton.get_bone_count()` returns 0, and `AnimationPlayer` libraries fail to bind. The fix:

> The rigged mesh is imported. Please restart the Summer Engine editor (close and reopen) so the Skeleton3D rebuilds correctly. Without the restart, animations will fail to bind.

There is no programmatic workaround as of Godot 4.5.x. Tell the user, wait, then continue.

### 6. Wire as CharacterBody3D or Node3D — pick the right parent

| Use case | Parent type | Why |
|---|---|---|
| Player or enemy that moves with code, collides with walls, jumps | `CharacterBody3D` | `move_and_slide()` API, kinematic physics, slope handling |
| Cinematic NPC (talks, idles, never moves under physics) | `Node3D` | No physics overhead; cheaper for crowds |
| Pure-visual character (background extra, dialogue head) | `Node3D` | Same as above |
| Ragdoll-on-death enemy | `CharacterBody3D` while alive, swap to `RigidBody3D` skeleton on death | Two-mode rig; see `summer:animation/procedural-animation` |

**CharacterBody3D wiring (player / enemy):**

```
summer_add_node(parent="./World", type="CharacterBody3D", name="Knight")
summer_set_prop(path="./World/Knight", property="position", value="Vector3(0, 0, 0)")
summer_add_node(parent="./World/Knight", type="Node3D", name="Mesh")
# Instantiate the imported scene as a child of the Mesh node
summer_set_prop(path="./World/Knight/Mesh", property="scene", value="res://assets/characters/knight.glb")
summer_add_node(parent="./World/Knight", type="CollisionShape3D", name="Collider")
# Add a CapsuleShape3D resource (height ~1.7m, radius ~0.4m) to the collider
summer_save_scene
```

**Node3D wiring (cinematic NPC):**

```
summer_add_node(parent="./World/Tavern", type="Node3D", name="OldWizard")
summer_set_prop(path="./World/Tavern/OldWizard", property="scene", value="res://assets/characters/wizard.glb")
summer_save_scene
```

The imported `.glb` includes its own `Skeleton3D` and `AnimationPlayer` (empty library). The animation skill writes into that AnimationPlayer.

### 7. Hand off to animation

> Knight is wired at `./World/Knight` with a Meshy-rigged skeleton. `rigAssetId` saved.
>
> Next: `summer:animation/generate-motion` to add idle / walk / run / attack clips. Example call: `summer_generate_motion(rigAssetId: "<saved id>", backend: "meshy-library", motionName: "walk")`. The animation skill uses Meshy's curated mocap library (~70 standard motions). Custom prompt-driven motion is on the roadmap; for one-off signature moves not on the curated list, fall back to hand-authoring in the Godot editor or importing from Mixamo.

## Anti-patterns

- **Skipping the user-review gate.** Doubles cost, locks the design, and removes the user's chance to course-correct cheaply.
- **Generating the mesh from a non-T-pose image.** Locomotion will look broken (inverted knees, snapped elbows). Always re-pose first.
- **Forgetting the editor restart.** Animations will appear to bind successfully but play to a stale skeleton — the character T-poses motionless. The fix is always restart, never code.
- **Wrapping a cinematic NPC in CharacterBody3D.** Wastes physics ticks; use Node3D.
- **Wrapping the player in Node3D.** No `move_and_slide()`, no collision — the player walks through walls.
- **Picking the rig pass before approving the silhouette.** The mesh defines what the character looks like; once the rig is on, you can't cheaply iterate the design.
- **Using `meshy` model for the mesh step.** Legacy. `hunyuan` is the default and produces cleaner topology that Meshy's auto-rig handles better.

## Edge cases

- **Multiple characters share a silhouette.** Generate the rig once, then re-skin via texture swap (cheaper than re-rigging). See `summer:3d-assets/character-model` retexture flow (TBD) — for now, route to `summer:asset-pipeline/asset-strategy`.
- **Character has wings, tail, extra limbs.** Meshy's humanoid rig only weights the standard skeleton — extras sag. Either prompt them as static (e.g. cape held by physics in-engine) or hand-rig in Blender post-export.
- **Child / dwarf / giant.** Generate at correct proportions in the T-pose; the rig retargets cleanly. Locomotion clips from `summer:animation/generate-motion` will retarget but stride length needs `playback_speed` tuning on the AnimationPlayer.
- **First-person hands-only character.** Generate just hands + forearms in T-pose; rig pass still works. See `summer:character-controllers/fps-controller` for first-person wiring.
- **Stylized non-human (goblin, orc, halfling).** Works fine as long as the silhouette is bipedal with two arms, two legs, one head. Quadrupeds and centaurs do not.

## Fallback (no MCP)

1. Generate the T-pose reference at the Summer dashboard (or any image gen — Midjourney, nano-banana web, DALL-E).
2. Upload to Meshy at meshy.ai → Image to 3D → enable rigging.
3. Download the `.glb`.
4. Drop into `res://assets/characters/` — Godot's import dock picks it up.
5. Restart the editor.
6. Wire as CharacterBody3D / Node3D in the Godot editor manually.

The output is identical to the MCP path — same Meshy skeleton, same compatibility with `summer:animation/generate-motion` (which has its own dashboard fallback).

## Handoff

After the rigged character is wired:

> `Knight` is at `./World/Knight` with a Meshy-rigged skeleton. Next:
> - **Animations:** `summer:animation/generate-motion` for idle / walk / run / attack. Pass the `rigAssetId` returned in step 4.
> - **State machine:** after a few clips exist, `summer:animation/animation-tree` for idle → walk → run blends.
> - **Player input:** if this is the player, wire WASD + mouse via `summer:character-controllers/fps-controller` or a third-person controller skill.
> - **NPC behavior:** if it's an NPC, `summer:ai-and-npcs/design-npc` for behavior trees and dialogue hooks.
> - **Re-skin variants** (palette swap, armor swap): retexture pass — generate new albedo, assign via material override. Avoid re-rigging.

## See also

- `summer:animation/generate-motion` — the next-step animation skill that consumes the `rigAssetId` produced here.
- `summer:asset-pipeline/asset-strategy` — meta-router; this skill is the canonical drill-down of its "Image-to-3D for characters" path.
- `summer:3d-assets/prop-model` — for non-character props.
- `summer:scene-composition` — for the CharacterBody3D + Mesh + Collider parent pattern.
- `references/mcp-tools-reference.md` — full parameter schemas for `summer_generate_3d`, `summer_generate_image`, and `summer_generate_motion`.
