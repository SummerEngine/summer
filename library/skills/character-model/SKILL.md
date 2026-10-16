---
name: character-model
description: "Generate a rigged humanoid (player, NPC, enemy, boss) from a T-pose reference, previewed before rigging."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: 3d-assets
user-invocable: true
allowed-tools: Read Grep summer_assets_search summer_assets_get summer_import_asset_by_id summer_assets_generate_image summer_assets_generate_3d summer_import_from_url summer_add_node summer_set_prop summer_set_resource_property summer_inspect_node summer_inspect_resource summer_get_scene_tree summer_save_scene summer_jobs_wait summer_assets_generate_motion summer_call
paths: ["assets/characters/**", "assets/models/**", "**/*.tscn", "**/*.gd"]
---

# Character Model — T-Pose to Rigged Humanoid, Gated

This is the canonical auto-rig pipeline. It produces a humanoid `.glb` with a skeleton that `generate-motion` can drive directly. The work is two paid passes with a **mandatory user-review gate between them**: the rig pass costs more credits and locks the topology, so the user must see the un-rigged preview and approve it first.

The whole flow:

```
1. T-pose reference image    →  assets.generate_image                          (~10s)
2. Un-rigged 3D mesh         →  assets.generate_3d(image-to-3d)  → a job       (~60s)
3. ── USER REVIEW GATE ──
4. Rigged .glb               →  assets.generate_3d(image-to-3d, rig) → a job   (~90s)
5. Import → editor RESTART → wire as CharacterBody3D / Node3D
6. Hand off to generate-motion for clips
```

The animation skill (`generate-motion`) requires a rigged humanoid; a static `.glb` won't drive motion.

`assets.generate_3d` always answers at once with a job (`{ status: "running", job: { id } }`); `jobs.wait({ jobId, timeoutSeconds: 50 })` follows it, called again until `finished` is true. The finished job's `result` holds the asset ids. Both passes spend the person's credits: `dryRun: true` on any call returns the estimate (`credits`, `balance`, `enough`) and changes nothing.

## When to use

- "Make a knight character for the player to control."
- "I need a goblin enemy."
- "Generate an old wizard NPC for the tavern."
- "Create a boss — a four-armed demon."
- The user is about to ask for animations and has nothing rigged yet.

## When NOT to use

- Static statue / mannequin display piece (no rig needed) → `prop-model`.
- Vehicle with a "driver" silhouette but no skeleton needed → `vehicle-model`.
- Quadruped (wolf, horse, dragon) → Meshy auto-rig is humanoid-only. Generate the mesh here for visuals, but skip the rig step — animation will need a hand-authored skeleton or a quadruped-specific provider (out of scope for this skill).
- The user already has a rigged character and just wants a re-skin — that's a retexture pass, not this skill.
- Facial blendshapes / lipsync rig → `facial-and-lipsync`.

## Polycount targets

| Role | Tris | Pass via |
|---|---|---|
| Hero character (player, close camera) | 8k–15k | `targetPolycount: 12000` |
| Grunt enemy (mid-range, multiple onscreen) | 3k–6k | `targetPolycount: 5000` |
| Crowd / background NPC (LOD-able) | 1k–2k | `targetPolycount: 1500` |
| Mobile-game character | 1k–3k | `targetPolycount: 2000` |
| Cinematic hero (no realtime constraint) | 20k–40k | `targetPolycount: 30000` |

Pass at the **mesh-generation step** (step 2). The rig pass preserves the topology; you can't reduce polycount after rigging without breaking weights.

## Steps

### 1. Generate the T-pose reference image

The rig pass requires a **front-facing T-pose** with arms out and legs slightly apart. If the reference is in an action pose, the rig will bend wrong and locomotion clips will look broken (knees inverted, elbows snapped — common Meshy failure mode).

```
assets.generate_image({
  prompt: "A fantasy knight in full plate armor, red cape, T-pose, arms straight out horizontal, legs slightly apart, front-facing, neutral expression. Game character asset, stylized, clean white background, soft studio lighting, full body in frame, ready for 3D mesh generation.",
  model: "nano-banana-2",
  aspectRatio: "3:4"
})
```

The phrase `T-pose, arms straight out horizontal, legs slightly apart, front-facing` is load-bearing — drop any of those and the model will drift toward A-pose or a hero stance.

If the user already has a concept image in an action pose, re-pose it to T-pose via img2img without re-rolling the design:

```
assets.generate_image({
  referenceImageUrl: "<existing concept image>",
  prompt: "<character> in T-pose, arms extended horizontally, neutral facing camera, white background, clean lighting"
})
```

Show the image to the user:

> Generated the T-pose reference. [link]. Approve to proceed to mesh generation, or regenerate?

### 2. Generate the un-rigged 3D mesh

```
assets.generate_3d({
  kind: "image-to-3d",
  imageUrl: "<image url from step 1>",
  model: "hunyuan",
  targetPolycount: 12000
})
jobs.wait({ jobId: "<job.id>", timeoutSeconds: 50 })   // again until finished
```

The finished job's `result` has `assetId` and `fileUrl` — an un-rigged static `.glb`.
Use the asset ID as the stable handle. Import it for preview only:

```
assets.get({ assetId: "<assetId>" })
summer_import_asset_by_id(
  assetId="<assetId>",
  path="res://assets/characters/knight_unrigged.glb"
)
```

### 3. STOP: USER REVIEW GATE — DO NOT SKIP

Before paying for the rig pass, surface the un-rigged mesh:

> Un-rigged knight mesh ready: `res://assets/characters/knight_unrigged.glb` (~12k tris, [preview link]).
>
> Next step is the **rig pass** (uses credits, ~90s). It locks the topology and adds a skeleton compatible with `generate-motion`. Once you approve I'll run it.
>
> **Approve the mesh and proceed to rig?** Or regenerate the mesh first (different prompt, different polycount, different model)?

If the user wants changes, loop back to step 1 or 2. Do NOT silently run the rig pass — it spends more credits and locks the design.

### 4. Run the rig pass

```
assets.generate_3d({
  kind: "image-to-3d",
  imageUrl: "<image url from step 1>",
  rig: true,
  targetPolycount: 12000
})
jobs.wait({ jobId: "<job.id>", timeoutSeconds: 50 })   // again until finished
```

`rig` and `targetPolycount` are plain fields of `assets.generate_3d` (there is no `options` object and no `polyTarget`). Related fields worth knowing here: `riggingHeightMeters` for character height, and `animationNames` / `actionIds` to have the shared animated-character pipeline produce clips in the same job instead of a separate `assets.generate_motion` pass.

The finished job's `result` includes `assetId`, `fileUrl`, and `rigAssetId`. The
`rigAssetId` is the handle `generate-motion` needs — store it.
Resolve it before import so the agent has the viewer/download metadata:

Import the rigged version, replacing the un-rigged file:

```
assets.get({ assetId: "<rigAssetId>" })
summer_import_asset_by_id(
  assetId="<rigAssetId>",
  path="res://assets/characters/knight.glb"
)
```

### 5. WARNING: Restart the editor

**Known gotcha:** after importing a rigged `.glb`, the `Skeleton3D` node appears stale in the scene dock — bones are missing, `skeleton.get_bone_count()` returns 0, and `AnimationPlayer` libraries fail to bind. The fix:

> The rigged mesh is imported. Please restart the Summer Engine editor (close and reopen) so the Skeleton3D rebuilds correctly. Without the restart, animations will fail to bind.

No programmatic workaround is known. Tell the user, wait, then continue.

### 6. Wire as CharacterBody3D or Node3D — pick the right parent

| Use case | Parent type | Why |
|---|---|---|
| Player or enemy that moves with code, collides with walls, jumps | `CharacterBody3D` | `move_and_slide()` API, kinematic physics, slope handling |
| Cinematic NPC (talks, idles, never moves under physics) | `Node3D` | No physics overhead; cheaper for crowds |
| Pure-visual character (background extra, dialogue head) | `Node3D` | Same as above |
| Ragdoll-on-death enemy | `CharacterBody3D` while alive, swap to `RigidBody3D` skeleton on death | Two-mode rig; see `procedural-animation` |

Three things the call shapes below encode:

- **Every scene tool, `summer_run_script` included, takes an explicit `scenePath`**, and the scene need not be the active editor tab.
- **A character is several nodes: build it in one `summer_run_script`**, not a chain of single calls.
- **A `.glb` is instantiated, not assigned.** There is no `scene` property on `Node3D`, and an imported `.glb` is a scene rather than a `Mesh` — on the shipped 4.6.1 binary `ResourceLoader.get_recognized_extensions_for_type("Mesh")` returns `["tres", "mesh", "res"]`, with no `glb`. Use `ctx.instance_scene` in a script, or `summer_instantiate_scene` for one model.

**CharacterBody3D wiring (player / enemy):**

```
summer_run_script(scenePath="res://main.tscn", source="""
func run(ctx):
    var knight = ctx.add_node("CharacterBody3D", "Knight", ctx.find("World"), {"position": Vector3(0, 0, 0)})
    ctx.instance_scene("res://assets/characters/knight.glb", knight, "Mesh")
    var capsule := CapsuleShape3D.new()
    capsule.height = 1.7
    capsule.radius = 0.4
    ctx.add_node("CollisionShape3D", "Collider", knight, {"shape": capsule})
    ctx.save_scene()
""")
```

Build the shape as a real resource and size it before you assign it. Later, one size change on that shape is one `summer_set_resource_property` (`nodePath`, `resourceProperty="shape"`, `subProperty`, `value`, plus `scenePath`).

**Node3D wiring (cinematic NPC):**

```
summer_instantiate_scene(scenePath="res://main.tscn", parent="./World/Tavern", scene="res://assets/characters/wizard.glb", name="OldWizard")
summer_save_scene(scenePath="res://main.tscn")
```

The imported `.glb` includes its own `Skeleton3D` and `AnimationPlayer` (empty library). The animation skill writes into that AnimationPlayer.

### 7. Hand off to animation

> Knight is wired at `./World/Knight` with an auto-rigged skeleton. `rigAssetId` saved.
>
> Next: `generate-motion` to add idle / walk / run / attack
> clips. Example call: `assets.generate_motion({ rigAssetId: "<saved id>",
> backend: "meshy-library", motionNames: ["walk"] })`. For custom actions, use
> `text-to-motion` (`backend: "text-to-motion"`).

## Anti-patterns

- **Skipping the user-review gate.** Spends the rig credits, locks the design, and removes the user's chance to course-correct cheaply.
- **Generating the mesh from a non-T-pose image.** Locomotion will look broken (inverted knees, snapped elbows). Always re-pose first.
- **Forgetting the editor restart.** Animations will appear to bind successfully but play to a stale skeleton — the character T-poses motionless. The fix is always restart, never code.
- **Wrapping a cinematic NPC in CharacterBody3D.** Wastes physics ticks; use Node3D.
- **Wrapping the player in Node3D.** No `move_and_slide()`, no collision — the player walks through walls.
- **Picking the rig pass before approving the silhouette.** The mesh defines what the character looks like; once the rig is on, you can't cheaply iterate the design.
- **Using `meshy` model for the mesh step.** Legacy. `hunyuan` is the default and produces cleaner topology that Meshy's auto-rig handles better.

## Edge cases

- **Multiple characters share a silhouette.** Generate the rig once, then re-skin via texture swap (cheaper than re-rigging): generate a new albedo and assign it as a material override.
- **Character has wings, tail, extra limbs.** Meshy's humanoid rig only weights the standard skeleton — extras sag. Either prompt them as static (e.g. cape held by physics in-engine) or hand-rig in Blender post-export.
- **Child / dwarf / giant.** Generate at correct proportions in the T-pose; the rig retargets cleanly. Locomotion clips from `generate-motion` will retarget but stride length needs `playback_speed` tuning on the AnimationPlayer.
- **First-person hands-only character.** Generate just hands + forearms in T-pose; rig pass still works. See `fps-controller` for first-person wiring.
- **Stylized non-human (goblin, orc, halfling).** Works fine as long as the silhouette is bipedal with two arms, two legs, one head. Quadrupeds and centaurs do not.

## Without Summer Engine

In a session without Summer Engine tools (the assets profile; the `summer-assets` skill has the whole loop), do steps 1-4, including the review gate, and stop when the rig pass finishes. Skip steps 5-6 (editor restart, scene wiring). Save the rigged GLB (`rigAssetId`; the unrigged mesh is `assetId`) where the person asked with `out` on `jobs.wait` or `assets.get` (the `summer-assets` skill says how), and tell them the path. Step 7 still applies: `generate-motion` runs without the engine.

## Fallback (no MCP)

1. Generate the T-pose reference in the Summer dashboard.
2. Run image-to-3D with rigging enabled in the Summer dashboard.
3. Download the `.glb`.
4. Drop into `res://assets/characters/`; Summer Engine's Import dock picks it up.
5. Restart the editor.
6. Wire as CharacterBody3D / Node3D in Summer Engine manually.

The output matches the MCP path — same skeleton, same compatibility with `generate-motion` (which has its own dashboard fallback).

## Handoff

After the rigged character is wired:

> `Knight` is at `./World/Knight` with an auto-rigged skeleton. Next:
> - **Animations:** `generate-motion` for idle / walk / run / attack. Pass the `rigAssetId` returned in step 4.
> - **State machine:** after a few clips exist, `animation-tree` for idle → walk → run blends.
> - **Player input:** if this is the player, wire WASD + mouse via `fps-controller` or a third-person controller skill.
> - **NPC behavior:** if it's an NPC, `design-npc` for behavior trees and dialogue hooks.
> - **Re-skin variants** (palette swap, armor swap): retexture pass — generate new albedo, assign via material override. Avoid re-rigging.

## See also

- `generate-motion` — the next-step animation skill that consumes the `rigAssetId` produced here.
- `asset-strategy` — meta-router; this skill is the canonical drill-down of its "Image-to-3D for characters" path.
- `prop-model` — for non-character props.
- `scene-composition` — for the CharacterBody3D + Mesh + Collider parent pattern.
- `summer_docs_read` id `reference/mcp-tools-reference` — how to call `assets.generate_3d`, `assets.generate_image` and `assets.generate_motion`; `summer_search` returns each one's exact input.

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@latest` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `assets.generate_3d`, `summer_assets_generate_3d` | `summer assets generate-3d` |
| `assets.generate_image`, `summer_assets_generate_image` | `summer assets generate-image` |
| `assets.generate_motion`, `summer_assets_generate_motion` | `summer assets generate-motion` |
| `assets.get`, `summer_assets_get` | `summer assets get` |
| `summer_assets_search` | `summer assets search` |
| `summer_docs_read` | `summer docs read` |
| `summer_add_node` | `summer engine add-node` |
| `summer_get_scene_tree` | `summer engine get-scene-tree` |
| `summer_import_asset_by_id` | `summer engine import-asset-by-id` |
| `summer_import_from_url` | `summer engine import-from-url` |
| `summer_inspect_node` | `summer engine inspect-node` |
| `summer_inspect_resource` | `summer engine inspect-resource` |
| `summer_instantiate_scene` | `summer engine instantiate-scene` |
| `summer_run_script` | `summer engine run-script` |
| `summer_save_scene` | `summer engine save-scene` |
| `summer_set_prop` | `summer engine set-prop` |
| `summer_set_resource_property` | `summer engine set-resource-property` |
| `jobs.wait`, `summer_jobs_wait` | `summer jobs wait` |
| `summer_search` | `summer ops search "<what you want>"` |
<!-- /shell-commands -->
