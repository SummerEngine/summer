---
name: godogen-visual-proof-game-generation
description: "Godogen-style game generation with a visual QC loop — capture frames from the running game, self-verify against the brief, bounded fix rounds, proof clip."
license: MIT
category: workflow
tags:
  - agentic
  - validation
  - visual-qc
  - asset-generation
  - godot4
  - automation
confidence: extracted
---


# Godogen-Style Game Generation with Visual Proof QC in Summer Engine

## Outcome

Take a **short game description** and produce a **runnable, visually verified game**. The method comes from the open-source Godogen project: *judge the result from the running game, never from a clean compile*. Every iteration ends with a screenshot or short proof clip from the running game, and the host coding agent reviews those frames against the brief itself. There is no separate verifier model.

## When to Use

- Building a complete small game or prototype from a natural-language brief (mechanics, art style, camera and HUD in one prompt).
- The agent says the game works but never looked at it running. You need an agent that *sees* the running game and reports concrete visual defects.
- Unattended generation runs where the deliverable must include proof (a 15–20s recording) instead of "it compiled, trust me."
- Asset generation for the game (references, textures, 3D models, animated sprites) as part of the same pipeline.

## When NOT to Use

- Hand-authored, large-scope production work. This is a generator loop, not a replacement for deliberate design iteration.
- No GPU capture path. The QC loop is worthless if frames come from a software renderer (see Failure Modes).
- Quick logic fixes with no visual component. Running and capturing is overhead there.

## Core Principles (from Godogen)

1. **Generator repo → game repo → game.** The generator itself is not a game. It publishes a thin scaffold into a fresh game repo; the agent then builds the actual game *inside* that repo from a short engine guide.
2. **Thin runtime, smart agent.** The published repo is minimal: one runtime manifest (`prompts/runtime.md`), a one-page engine guide, and one asset-generation skill (`asset-gen/`). The model plans, scaffolds and decomposes the work itself; there are no planner or architecture skill files.
3. **Proof over claims.** The agent judges results from the running game (a live build or a recorded clip), not from a clean compile, so visible defects drive the next iteration.
4. **The host agent verifies from captured frames.** Godogen dropped a separate verification model because it added no signal. One strong coding agent looking at real screenshots is enough.
5. **Two involvement modes, chosen by how the task is framed.** Watch the live game and steer at decision points, or run unattended and receive a 15–20s proof recording at the end, watched back before done.
6. **Engine-specific runtime traps live in the engine guide.** Defects that survive a compile but fail at runtime are written down where the agent reads them during the run.

## Mapping to Summer Engine

| Godogen concept | Summer Engine equivalent |
|---|---|
| Publish step that renders the agent files into a game repo | `summer create <template>` plus the installed Summer skills; `.summer/` holds the brief (`GameSoul.md`) and build plan |
| `prompts/runtime.md` manifest | `.summer/build-plan.md`: delivery contract and involvement mode |
| One-page engine guide | A project skill with capture recipes, runtime traps and scene conventions (`gameskill` captures new traps) |
| `asset-gen/` skill | `asset-strategy` and the Summer generation tools |
| Compile gate (`dotnet build` for C#) | `summer_get_script_errors` per file, then `summer_get_diagnostics` |
| Proof recording (ffmpeg + xvfb) | `summer_play`, `summer_screenshot target:"game"`, `summer_game_probe`; frame sequences from a `RunVerification` probe's `save_frame`; optional ffmpeg clip |

**Language note:** Godogen generates C# games because `dotnet build` is a cheap, reliable compile gate. Summer games use GDScript, so the gate is `summer_get_script_errors` on each changed file. The order is the point: compile gate first, *then* visual proof, never one instead of the other.

## Repo Shape

```
my-summer-game/
├── AGENTS.md                 # host-agent entry
├── .summer/
│   ├── GameSoul.md           # the brief
│   └── build-plan.md         # delivery contract + involvement mode
└── .agents/skills/
    └── <project-guide>/      # capture recipes, runtime traps, conventions
```

In-game capture harness, for runs outside the editor:

```
Main (Node)
├── Game ...                  # whatever the agent built
├── Camera3D / Camera2D
└── ProofCapture (Node, autoload or scene node)
    # listens to RenderingServer.frame_post_draw
    # saves PNGs to user://proof/ on trigger
```

## Capture Harness (GDScript)

Godogen's own capture code is not public; this is an adaptation. Inside a Summer session, prefer `summer_screenshot target:"game"` and `RunVerification` frames, and use this autoload for unattended runs outside the editor.

```gdscript
extends Node
## ProofCapture — saves viewport screenshots for the visual QC loop.
## Trigger via capture(tag) at meaningful moments: scene loaded,
## state changed, or on a timer during a proof recording.

const OUTPUT_DIR := "user://proof/"

var _shot_index: int = 0
var _recording := false
var _record_timer: float = 0.0
var _record_interval: float = 0.5   # 2 fps is plenty for a QC strip
var _record_remaining: float = 0.0

func _ready() -> void:
    DirAccess.make_dir_recursive_absolute(OUTPUT_DIR)
    RenderingServer.frame_post_draw.connect(_on_frame_post_draw)

func capture(tag: String) -> String:
    var img: Image = get_viewport().get_texture().get_image()
    var path := "%s%03d_%s.png" % [OUTPUT_DIR, _shot_index, tag.simplify_path()]
    img.save_png(path)
    _shot_index += 1
    return path

func start_recording(seconds: float = 18.0) -> void:
    _recording = true
    _record_remaining = seconds
    _record_timer = 0.0

func _process(delta: float) -> void:
    if not _recording:
        return
    _record_remaining -= delta
    _record_timer += delta
    if _record_timer >= _record_interval:
        _record_timer = 0.0
        capture("rec")
    if _record_remaining <= 0.0:
        _recording = false
        # hand the PNG sequence to ffmpeg for the 15–20s proof clip

func _on_frame_post_draw() -> void:
    pass  # hook if you need exact-frame capture timing
```

Encode the PNG sequence (resolve `user://` to its absolute path first):

```bash
ffmpeg -framerate 2 -i <user_dir>/proof/%03d_rec.png -c:v libx264 -pix_fmt yuv420p proof.mp4
```

Unattended Linux runs need a real display for real rendering: run the engine under `xvfb-run -a`.

## The Visual QC Loop

```
1. BUILD/EDIT   agent applies a change to the game
2. COMPILE GATE summer_get_script_errors on changed files, then summer_get_diagnostics
3. RUN + CAPTURE summer_play, then capture frames at defined triggers
4. SELF-REVIEW  host agent inspects captured frames against the brief
5. DEFECT LIST  structured findings: {location, expected, observed, severity}
6. DECIDE       no blocking defects → go to 7; else → back to 1 with the list
7. PROOF        15–20s recording, watched back before done
```

Rules that make it work:

- **Bounded.** Hard cap on rounds (see Tunables). The run closes with a proof recording; it does not iterate forever.
- **Same agent verifies.** Do not add a separate verifier model. Godogen tried it and dropped it.
- **Defects must be visible.** The review asks for concrete visual observations tied to the brief ("character sprite missing; brief asks for chunky iconic sprites"), not "looks wrong".
- **Engine traps belong in the guide.** Recurring "survives compile, fails at runtime" defects go into the project guide so the agent reads them before they happen again.

## Asset Generation

Godogen calls external image, video and image-to-3D providers with their own API keys, then cuts animated sprites from generated video (frame extraction, loop detection, background removal, imagemagick for resize and crop). In Summer, route asset work through `asset-strategy` and the Summer generation tools (`summer_generate_image`, `summer_generate_3d`, `summer_generate_video`) instead of wiring provider keys into the project.

## Implementation Steps

1. **Write the thin runtime**: the brief in `.summer/GameSoul.md`, the delivery contract and involvement mode in `.summer/build-plan.md`, and a one-page project guide (how to run, how to capture, known runtime traps). Grow the guide every time a defect survives the compile gate.
2. **Set up capture**: inside a Summer session, `summer_play` plus `summer_screenshot target:"game"`. For unattended Linux runs, add xvfb, ffmpeg and vulkan-tools, and check the GPU path with `vulkaninfo --summary`. A software-renderer fallback on a GPU host is a misconfiguration to fix before trusting any QC frame.
3. **Add `ProofCapture`** (GDScript above) as an autoload when capturing outside the editor; wire triggers to scene-loaded, state-changed and recording mode.
4. **Run the compile gate** before every capture round.
5. **Run the QC loop**: capture → self-review → structured defect list → fix → re-capture, capped at `max_qc_rounds`. The review receives the original brief plus the latest frames and outputs findings in a fixed JSON shape.
6. **Close with proof**: after the loop passes, record 15–20s, encode with ffmpeg, and have the agent watch the clip back before declaring done.
7. **Support both involvement modes**: for an open-ended task, show the live game early and checkpoint at taste, scope and cost decisions; for a finished brief, run unattended and close with proof.

## Tunables

| Parameter | Meaning | Reference value |
|---|---|---|
| `max_qc_rounds` | hard cap on capture→fix iterations | bounded, never open-ended |
| Proof clip length | recording at the end of a run | 15–20 s |
| Capture triggers | when screenshots fire (scene load / state change / timer) | defined in the project guide |
| Record fps | frame rate of the QC strip | 2 fps is enough for review |
| Verification model | which agent reviews frames | the host agent itself; no separate verifier |
| Involvement mode | live-steered vs unattended | chosen by task framing |

## Failure Modes & Gotchas

- **Trusting a clean compile.** The compile gate is necessary, never sufficient.
- **Software-renderer frames.** SwiftShader, llvmpipe and lavapipe output looks wrong and misleads the QC loop. On a GPU host it means the capture path is misconfigured.
- **Unbounded verification loops.** Without `max_qc_rounds` the agent iterates forever on taste-level nitpicks. Close with proof.
- **Adding a separate verifier model.** Godogen tried it and found no extra signal.
- **Capturing before the frame settles.** Grab the viewport after `frame_post_draw` or a short delay, or screenshots show half-rendered scenes and produce false defects.
- **Headless noise.** Headless runs can print harmless RID warnings on quit. Do not let the QC loop treat engine noise as defects.
- **An all-black screenshot** usually means the viewport had not redrawn. Recapture before calling it a defect.

## Verification

Not yet verified in Summer Engine. To validate an implementation:

1. Scaffold a project and confirm the agent builds a runnable game from the brief and the one-page guide alone.
2. Run a small brief end to end; confirm the pipeline produces a running build, not just code.
3. Introduce a visible defect (a broken sprite, a missing material); confirm the self-review finds it from captured frames and fixes it within the round cap.
4. Confirm the run closes with a 15–20s proof clip that the agent reviews before marking done.
5. Confirm the compile gate runs before every capture round and that frames come from hardware rendering.

## Confidence

`extracted`. The architecture (thin runtime, manifest, engine guide, asset-gen), proof over claims, self-verification from captured frames, the dropped verifier model, the C# rationale, the capture tooling and the two involvement modes come from Godogen's public README, CHANGELOG and setup notes. The `ProofCapture` script, the QC-loop JSON protocol and the Summer mapping are adaptations; Godogen's internal prompt and guide files are not public.
