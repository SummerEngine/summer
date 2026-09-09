---
name: skintokens-auto-rigging
description: "Use when auto-rigging a static GLB mesh offline with skin-tokens.cpp (LocalAI's C++/GGML port of VAST-AI SkinTokens/TokenRig) in SummerEngine's art pipeline: generate a skeleton and skin weights on CPU/Vulkan, then import the rigged GLB into Godot 4."
license: MIT
category: art-pipeline
tags:
  - rigging
  - skinning
  - assets
  - glb
  - ai-tooling
  - godot4
confidence: extracted
source_refs:
  - sources/x/jichiep-skintokens-announce/source.md
  - sources/web/skin-tokens-cpp-github/source.md
  - sources/web/skintokens-gguf-modelcard/source.md
  - sources/web/vast-ai-skintokens-upstream/source.md
source_repo: SummerEngine/summer-gamedev-knowledge@cac7d50be8cfb3c0179c48e65438eb0d375b9fe9
---

# Auto-Rigging Static Meshes with skin-tokens.cpp (SkinTokens/TokenRig) in SummerEngine

## Tool review verdict (answering the Slack request)

Not a "slop tool made by a solodev": it is published under the **localai-org** GitHub organization by Richard Palethorpe (LocalAI maintainer), is an Apache-2.0 C++23/GGML port of VAST-AI's MIT-licensed **SkinTokens/TokenRig** research model (arXiv:2602.04805), ships a flat C11 API, an ASan/UBSan libFuzzer build, CPU/Vulkan numerical-parity test suites against the upstream reference, and a Go/WebGL demo. Weights are a verified, non-retrained GGUF conversion (~1.25 GB F16) on Hugging Face.

Honest limitations to plan around:

- The fully automatic `rig` command (unconstrained skeleton generation) is **explicitly experimental** — the policy can produce unsuitable bone topologies.
- The author's own demo shows **open issues combining the output with kimodo.cpp skeletal animations**.
- Generation recomputes the Qwen3 graph without a KV cache and **may take several minutes** per mesh; dense decoder queries are capped at 16K vertices per graph (chunked beyond that).
- Results are strongest on shapes resembling the training distribution (humanoids; trained on ArticulationXL 2.0, VRoid Hub, ModelsResource).

**Recommendation:** worth adopting as an *offline asset-prep* tool in the art pipeline, primarily the `skin` command (weights for an existing skeleton). Treat `rig`-generated skeletons as drafts that need artist review before animation use.

## Outcome

Static `.glb` meshes (e.g. AI-generated or scanned characters/creatures) become rigged, skinned `.glb` assets that Godot 4 imports natively as `Skeleton3D` + skinned `MeshInstance3D`, ready for `AnimationPlayer`/retargeted animation — without manual weight painting.

## When to Use

- You receive an unrigged character/creature mesh and need a fast first-pass rig or skin weights.
- You have an existing armature (e.g. a mocap/Kimodo-style skeleton GLB) and only need learned skin weights for a mesh (`skin` command — the reliable path).
- Batch-rigging many props/characters where hand-painting weights is not cost-effective.

## When NOT to Use

- Hero characters needing production-quality, art-directed deformation — plan for manual weight cleanup after auto-rigging.
- Non-triangle meshes (tool accepts arbitrary triangle meshes only; triangulate first).
- Shapes far from the training distribution (expect weaker results; run `--geometric` diagnostic to compare).
- Runtime/in-engine rigging — this is an offline CLI/library step, not a Godot plugin.

## Core Principle

TokenRig models the whole rig — skeleton hierarchy followed by discrete skin-weight tokens (SkinTokens, an FSQ-CVAE vocabulary) — as one autoregressive sequence generated from a Michelangelo point-cloud encoding of the mesh (Qwen3-0.6B backbone, GRPO-refined). skin-tokens.cpp re-runs this stack through GGML on CPU or Vulkan and exports a standard skinned glTF/GLB with a one-frame rest pose, so it opens as a conventional rigged asset in any engine.

## Pipeline shape (SummerEngine)

```
static character.glb
      │
      ▼
[skin-tokens-cli]  rig | skin   (offline, CPU or Vulkan, minutes per mesh)
      │
      ▼
character-rigged.glb   (skeleton + skin weights + rest pose, skinned glTF)
      │
      ▼
Godot 4 import  →  character-rigged.glb (scene)
      └── Skeleton3D
            └── MeshInstance3D (skinned, Skin resource)
      └── AnimationPlayer / retargeted animations
```

Keep raw static meshes and rigged outputs as separate files under the asset folder convention, e.g. `assets/chars/<name>/source.glb` and `assets/chars/<name>/rigged.glb`, so re-rigging never destroys source art.

## Setup (once)

1. Build the CLI (Linux; C++23 toolchain, CMake ≥ 3.25, Ninja, nlohmann-json, Vulkan unless disabled):
   ```bash
   git clone https://github.com/localai-org/skin-tokens.cpp
   cd skin-tokens.cpp
   git submodule update --init --recursive
   cmake -S . -B build/release -G Ninja -DCMAKE_BUILD_TYPE=Release   # add -DSKINTOKENS_ENABLE_VULKAN=OFF if no Vulkan
   cmake --build build/release -j
   cmake --install build/release --prefix ./dist
   ctest --test-dir build/release --output-on-failure
   ./build/release/bin/skintokens-cli inspect models/SkinTokens-GGUF/F16   # sanity check after weights download
   ```
2. Download the F16 GGUF bundle (keep the 3 files together; runtime checks their embedded identities):
   ```bash
   hf download LocalAI-io/SkinTokens-GGUF --include "F16/*" --local-dir models/SkinTokens-GGUF
   ```
   (~1.25 GB: mesh-encoder 57.8 MB + tokenrig 948.6 MB + skin-vae 244 MB. Use F32 only for numerical-parity work.)

## Implementation Steps

### 1. Auto-rig a static mesh (draft skeleton + weights)

```bash
./build/release/bin/skintokens-cli rig models/SkinTokens-GGUF/F16 \
  character.glb character-rigged.glb --device vulkan --postprocess
```

- `--postprocess` applies upstream's surface-locality heuristic (smoother, local influences); omit it only to preserve raw learned weights.
- Output stores a one-frame rest pose; inspect the skeleton topology before animating (experimental mode — see Failure Modes).
- Use `--geometric` as a non-learned baseline diagnostic when results look wrong.

### 2. Re-weight against an existing skeleton (preferred when an armature exists)

```bash
# One rigged GLB supplies both geometry and skeleton (old weights ignored):
./build/release/bin/skintokens-cli skin models/SkinTokens-GGUF/F16 \
  character-rigged.glb character-rigged.glb character-reweighted.glb \
  --device vulkan --fit none

# Or separate mesh + animated skeleton GLBs (e.g. Kimodo animation output):
./build/release/bin/skintokens-cli skin models/SkinTokens-GGUF/F16 \
  character.glb motion.glb animated.glb --device vulkan --fit global
```

Fit modes:

| `--fit` | When | Behavior |
|---|---|---|
| `global` (default) | Mesh and skeleton in different coordinates | One uniform scale + translation matching vertical extent and centre; preserves relative joint positions and bone-length ratios |
| `none` | Both files already share coordinates | No alignment transform |
| `articulated` | Recognized humanoid arm chains; **experimental** | Picks whichever of rest pose / first animation frame actually runs inside the arms (bind pose == frame zero → playback starts without warping); falls back to analytic two-bone IK toward conservative mesh targets, preserving arm segment lengths |

### 3. Import into Godot 4

Drop the rigged `.glb` into the project; Godot's glTF importer creates the scene automatically:

- `Skeleton3D` with bones and a skinned `MeshInstance3D` (Skin resource), rest pose included.
- Check in the Import dock: mesh, skeleton, and (if supplied) animations present.
- If the source GLB contains animations and the hierarchy matches, Godot imports them into `AnimationPlayer`; otherwise use Godot 4's retargeting (`SkeletonProfileHumanoid`) to map animations onto the generated skeleton.
- glTF round-trip note from upstream: on Blender export of results, a `glTF_not_exported` node may need removing (only relevant if the pipeline goes through Blender).

### 4. Optional editor tooling (typed GDScript)

An EditorScript/utility wrapper to rig assets from inside Godot:

```gdscript
@tool
extends EditorScript

const CLI := "/opt/skin-tokens.cpp/build/release/bin/skintokens-cli"
const MODEL_DIR := "/opt/skin-tokens.cpp/models/SkinTokens-GGUF/F16"

func _run() -> void:
	var src := "res://assets/chars/goblin/source.glb"
	var dst := "res://assets/chars/goblin/rigged.glb"
	var args: PackedStringArray = [
		"rig", MODEL_DIR,
		ProjectSettings.globalize_path(src),
		ProjectSettings.globalize_path(dst),
		"--device", "vulkan", "--postprocess",
	]
	var output: Array = []
	var err := OS.execute(CLI, args, output, true, false)
	if err != 0:
		push_error("skin-tokens-cli failed (%d): %s" % [err, "\n".join(output)))
		return
	print("Rigged: ", dst)
	# Reimport so the new GLB appears in the FileSystem dock.
	EditorInterface.get_resource_filesystem().scan()
```

For embedding in a tool/asset server, prefer the flat C11 API (`skintokens.h`): `st_model_load` → `st_rig_file` / `st_skin_files` / `st_inspect_glb_file`, with caller-owned error buffers; C++ exceptions never cross the ABI.

## Tunables

| Parameter | Meaning | Guidance |
|---|---|---|
| `--device` | `cpu` or `vulkan` | Vulkan if available; CPU works but slower. F16 for normal inference |
| `--postprocess` | Surface-locality weight smoothing | On for game characters; off only to keep raw weights |
| `--fit` | Skeleton↔mesh alignment (`global`, `none`, `articulated`) | `global` default for separate files; `none` when coordinates match; `articulated` experimental humanoid-arm fix |
| `--geometric` | Non-learned diagnostic rigging | Compare against learned output when results look wrong |
| F16 vs F32 bundle | Precision | F16 (~1.25 GB) normal; F32 parity work only |
| Vertex budget | Dense decoder queries capped at 16K verts/graph, chunked beyond | Very dense meshes are handled in chunks; expect longer runs |

## Failure Modes & Gotchas

- **Unsuitable skeleton topology** from `rig` (experimental policy) — always have an artist inspect bones before animating; re-run or fall back to a template skeleton + `skin`.
- **Animation combination issues**: the author reports unresolved problems combining skin-tokens.cpp rigs with kimodo.cpp skeletal animations (visible at the end of the demo video). Verify any animation transfer manually.
- **Warped first frame** when the supplied skeleton's pose doesn't match the mesh: use `--fit global` (or `articulated` for humanoid arms) so bind pose aligns with the mesh; `--fit none` only when coordinates already match.
- **Out-of-distribution shapes** degrade quality silently — no error is raised. Spot-check deformation visually.
- **Runtime**: several minutes per mesh (no KV cache); do not put this in a per-frame or hot-reload path — batch offline.
- **Bundle integrity**: the three GGUF files of a bundle must stay together; load fails identity checks otherwise.
- **Vulkan precision**: slightly looser numerics than CPU (7.1e-4 hidden state / 1.4e-3 logits relative L2 vs 8.1e-6 CPU F32); visually equivalent but use F32+CPU for parity debugging.
- **Upstream GPU path** (Python VAST-AI repo) needs an NVIDIA GPU ≥ 14 GB — use the C++ port instead for CPU/Vulkan machines.

## Verification

Not summerengine-verified. To validate in SummerEngine:

1. `skintokens-cli inspect models/SkinTokens-GGUF/F16` succeeds after build + weights download.
2. Rig a known test mesh (`rig … --postprocess`) and open the output in the Godot editor: `Skeleton3D` with sensible bone hierarchy + skinned `MeshInstance3D`, no import errors.
3. Pose one bone in the editor; confirm the surface deforms smoothly without bleeding across disconnected parts.
4. `skin` path: feed a mesh + animated skeleton GLB with `--fit global`; play the animation in Godot and confirm frame zero does not warp the mesh.
5. Re-run ctest / parity binaries if the CLI is rebuilt or GGML is updated.

## Confidence

`extracted` — All tool behavior, commands, flags, sizes, numerics, and caveats come from the retrieved GitHub README, Hugging Face model card, upstream VAST-AI repo, and the author's X announcement (including the self-reported kimodo.cpp animation issue). The Godot 4 import mapping and GDScript wrapper are adaptations, not from the sources.
