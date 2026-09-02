---
name: lumera-single-image-scene-reconstruction
description: "Use when building a Lumera-style single-image → editable-engine-scene pipeline in SummerEngine: VLM-parsed object boxes and parametric lights, per-object meshes, HDR environment probe, engine-native assembly, and a bounded dual-agent refinement loop."
license: MIT
category: art-pipeline
tags:
  - image-to-3d
  - scene-reconstruction
  - lighting
  - vlm
  - procedural-content
  - godot4
confidence: extracted
source_refs:
  - sources/x/haozhao-lumera-announce/source.md
  - sources/web/lumera-arxiv-paper/source.md
source_repo: SummerEngine/summer-gamedev-knowledge@cac7d50be8cfb3c0179c48e65438eb0d375b9fe9
---

# Single-Image → Editable Scene Reconstruction (Lumera-style) in SummerEngine

## Outcome

Turn one reference image into an **editable, engine-native scene** in SummerEngine: individual `MeshInstance3D` objects with transforms, countable parametric light nodes, and an HDR environment probe — not a fused point cloud, Gaussian splat, or baked texture. This is the adaptation of the Lumera pipeline (arXiv:2607.20889, Tsinghua AIRSUN lab) from UE5 to SummerEngine.

**Honesty caveat:** Lumera itself is UE5-only with no public code as of retrieval (2026-08-30); the paper explicitly lists Godot/engine-portable extraction as future work. This skill documents the architecture and the parts an agent can build in SummerEngine today (assembly, scene representation, refinement loop, evaluation), and flags the parts that require external model components (VLM box/light parsers, per-object mesh generator, HDR estimator).

## When to Use

- Bootstrapping a level/blockout from concept art or a screenshot, where artists need movable objects and re-tunable lights afterward.
- Producing 3D scene conditions for 3D-conditioned video generation (a use case the paper calls out).
- You specifically need **editable entities** (instances, lights, probes) rather than a render-able blob.

## When NOT to Use

- You only need a visual backdrop: a Gaussian-splat or depth-mesh bake is cheaper and looks as good or better.
- Large unbounded outdoor scenes: the paper reports ~17 m Chamfer-L2 drift outdoors — geometry is unreliable at that scale.
- Exact light counts/positions are critical: individual-light localization F1 is 0.209 at 0.5 m; intensity error is ~2.7× (log-MAE 0.431). Expect hand-tuning.

## Core Principle

Treat image-to-3D as **game-engine structured parsing**: engines already store exactly the entities downstream tools need — object components, transforms, cameras, materials, environment probes, and countable parametric lights. The pipeline therefore parses those entities directly instead of reconstructing geometry first and deriving entities later.

Lumera's stages (from paper abstract + appendices):

1. **Lumera-Box** — VLM parses object-level 3D boxes (position, size, yaw) from the image.
2. **Lumera-Light** — VLM parses parametric light tuples `(x, y, z, r, g, b, I)`.
3. **Per-object mesh reconstruction** — a mesh per parsed box.
4. **HDR environment estimation** — environment probe (IntrinsicHDR partially compensates for SkyLight/unseen near-camera lights).
5. **Bounded agentic refinement loop** — dual-agent (geometry stage, then light stage) edits + verifies against the reference image.
6. **Assembly** — emit engine-native scene (Blender/UE5 in the paper; `.tscn` in SummerEngine).

Dataset backing it: Lumera-2K, 2,513 UE5 projects → 3.73M components, 63M object instances, 102.6K parametric lights, 95.1K camera views.

## Scene / Node Shape (SummerEngine target)

The assembly stage should emit this node tree so output stays inspectable/editable:

```
ReconstructedScene (Node3D)
├── Camera3D                    # recovered viewpoint (intrinsics from parsing stage)
├── WorldEnvironment
│   └── Environment
│       └── Sky (HDR panorama from stage 4) + ambient light settings
├── Objects (Node3D)
│   └── MeshInstance3D × N      # one per parsed box; transform = box center/yaw
│       └── unique material per object (so meshes are replaceable/refinable)
└── Lights (Node3D)
    ├── OmniLight3D / SpotLight3D / DirectionalLight3D × M
    │     # position/rotation from (x,y,z); color from (r,g,b);
    │     # light_energy from I (mind log-scale calibration, see Tunables)
    └── (SkyLight-equivalent is carried by WorldEnvironment in Godot)
```

Keep objects and lights as **separate siblings under named containers** — this mirrors UE5's component structure and is what makes the scene "editable" rather than "looks 3D".

## Implementation Steps

### 1. Define the intermediate scene schema

Before touching models, define the serializable tuple set the pipeline passes between stages (this is the engine-native contract):

```gdscript
# object record parsed by the box stage
class_name ParsedObject
var box_center: Vector3
var box_size: Vector3      # must be > 0; validate (paper strips non-positive sizes)
var yaw: float             # watch 0 vs ±π/2 symmetry for near-square objects
var label: String
var id: int                # unique; duplicates are a known model failure mode

# light record parsed by the light stage
class_name ParsedLight
var position: Vector3
var color: Color           # r,g,b
var intensity: float       # I, log-scale calibration needed (~2.7x error typical)
var kind: String           # point / spot / directional mapping
```

Add a **repair layer** on ingest: drop/fix invalid labels, non-positive sizes, duplicate IDs. The paper notes sanitized evaluation silently removed these, and recommends constrained decoding or a repair layer in the inference path.

### 2. Box + light parsing (external VLM components)

Lumera-Box/Lumera-Light are VLMs SFT'd on Lumera-2K; there is no public checkpoint. Options: use a hosted VLM prompted to emit the JSON tuples above, or fine-tune an open VLM on your own engine-exported scenes (Godot scenes are text `.tscn` and trivially exportable — this is the "build Lumera-2K for your engine" step the paper identifies as missing for non-UE5 engines).

### 3. Per-object mesh generation + HDR environment estimation

Also external model components in Lumera (per-object mesh reconstruction; IntrinsicHDR-style environment estimation). For a SummerEngine blockout you can substitute: box mesh (`BoxMesh` sized to the parsed box) per object and a generated/estimated panorama `Sky`. Swap in real reconstructed meshes later without changing the schema.

### 4. Assembly: write a `.tscn`

Deterministic GDScript/tool script: instantiate the node shape above from the repaired records. Godot's `.tscn` is text — generating it directly keeps the output diffable and versionable. Save with `PackedScene.pack()` / `ResourceSaver.save()` from an editor tool.

### 5. Bounded dual-agent refinement loop

The paper's Algorithm 1 (Appendix H.7), adapted:

- **Two stages in order:** geometry (objects/boxes), then lights. Switch the agent scope and prompt head per stage, but **inherit scene state `s` and conversation history `M`** across the switch — this avoids a cold start and lets the light-stage verifier refer to object identities already confirmed in the geometry stage.
- **Each round:** agent proposes an action `a_t` (move/resize/add/remove an entity) given the history, reference image, and current scene state; the executor applies it to the scene; a verifier renders the result and reports `r_t` against the reference image.
- **Sliding-window history:** keep only the system prompt + most recent `L` action/report pairs (`M_{t+1} = Tail_L(M_t ∪ {a_t, r_t})`, per VIGA). Skip records adjacent to rolled-back steps. This keeps 30+ rounds inside the VLM context window.
- **Bounded:** hard round limits `T_g` (geometry) and `T_l` (light), plus early termination when the verifier report triggers it. Never run unbounded — that is what keeps this agentic loop "bounded" and cheap.

### 6. Evaluation harness

Reproduce the paper's metrics on held-out scenes so improvements are measurable:

| Target | Metric |
|---|---|
| Boxes | 3D mAP, IoU-B, F-score (Lumera-Box reference: mAP 0.1141, IoU-B 0.2472, F 0.2762) |
| Lights (scene-level) | non-empty-scene recall (reference: 0.998) |
| Lights (per-light) | F1 @ 0.5 m (reference: 0.209 — weak; expect hand-tuning) |
| Matched lights | median position error (0.261 m), median ΔE2000 color error (4.59), intensity Pearson r (0.628), log-intensity MAE (0.431) |
| Geometry (scene) | Chamfer-L2 (outdoor reference ≈ 17 m — large unbounded scenes drift) |
| Relations | SRF / anchor recall (known weak point; WildDet3D beats Lumera-Box here) |

## Tunables

| Parameter | Meaning | Notes |
|---|---|---|
| `T_g`, `T_l` | max refinement rounds per stage | paper keeps 30+ rounds total inside context; bound them |
| `L` | history window size (action/report pairs) | trade context use vs. verifier memory of confirmed objects |
| Light intensity calibration | map predicted `I` to `light_energy` | ~2.7× brightness error typical; log-scale loss recommended by authors |
| Yaw symmetry handling | treat 0 and ±π/2 as equivalent for near-square footprints | explicit paper limitation; add symmetry classes or snap checks |
| Supervision scope (if fine-tuning) | lights whose influence intersects the view frustum, not just visible sources | authors' recommended fix for missing SkyLight/carriers |

## Failure Modes & Gotchas

- **Merged/baked outputs defeat the point.** If assembly emits one combined mesh or a splat, you've built an image-to-3D renderer, not Lumera. Keep per-object nodes + parametric lights.
- **Invalid model outputs are common:** non-positive box sizes, duplicate IDs, ID fallbacks. Validate and repair before assembly; the paper's benchmark silently sanitized these.
- **Yaw ambiguity** on near-square objects (0 vs ±π/2 look identical) — single-token yaw serialization in prior work does not handle symmetry.
- **Relation structure is unsolved** (object-to-object spatial relations): anchor recall/SRF are Lumera's weakest scores. Don't promise correct relative layouts.
- **Per-light localization is weak** (F1 0.209 @ 0.5 m) while scene-level light *count* recall is strong (0.998). Frame the output as "right number of lights, roughly right places."
- **SkyLight / near-camera lights whose source is off-screen** are not supervised; the environment probe (IntrinsicHDR) only partially compensates.
- **Large outdoor scenes drift geometrically** (~17 m Chamfer-L2); consider joint camera+geometry calibration if you need metric outdoor consistency.
- **Engine conventions don't transfer for free** — the dataset and light conventions are UE5's; Godot's light units/probes differ, so recalibrate intensity and validate the representation on Godot-native scenes.

## Verification

Not summerengine-verified. To validate an implementation in SummerEngine:

1. Assemble a scene from a test image; confirm the `.tscn` contains separate, selectable `MeshInstance3D`s and light nodes (editability check).
2. Move/replace one mesh and re-tune one light in the editor without breaking the scene.
3. Run the evaluation harness (§6) against a held-out set of known Godot scenes and compare to the reference numbers above.
4. Confirm the refinement loop terminates within `T_g`/`T_l` and the history window never exceeds the VLM context budget.

## Confidence

`extracted` — Architecture, metrics, refinement-loop design, and limitations are drawn directly from the arXiv paper (abstract, intro, appendices H.7–I as retrieved; middle method sections were truncated and are not documented here) and the author's announcement post. The SummerEngine node mapping and GDScript schema are adaptations, not from the sources; no public Lumera code exists to reference.
