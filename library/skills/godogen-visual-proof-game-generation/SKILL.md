---
name: godogen-visual-proof-game-generation
description: "Use when adopting Godogen's thin-runtime autonomous game generation and its 'proof over claims' visual QC loop for SummerEngine: capture frames from the running engine, let the host agent self-verify against the brief, and drive bounded fix iterations until a proof recording closes the run."
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
source_refs:
  - sources/x/axichuhai-godogen/source.md
  - sources/web/htdt-godogen/source.md
  - sources/web/htdt-godogen-changelog/source.md
  - sources/web/htdt-godogen-setup/source.md
source_repo: SummerEngine/summer-gamedev-knowledge@cac7d50be8cfb3c0179c48e65438eb0d375b9fe9
---

# Godogen-Style Autonomous Game Generation + Visual Proof QC in SummerEngine

## Outcome

Give SummerEngine an agent workflow that takes a **short game description** and produces a **runnable, visually verified game**, using Godogen's core insight: *judge the result from the running game, never from a clean compile*. The visible output of every iteration is a screenshot or short proof clip from the actual engine, and the host coding agent itself reviews those frames against the brief — no separate verifier model.

This directly targets the studio pain point Velizar named in Slack: SummerEngine already has a "validation of the game" step, but it doesn't currently work. Godogen's visual QC loop is the reference design to rebuild it.

## When to Use

- Building complete small games or prototypes from a natural-language brief (mechanics + art style + camera + HUD in one prompt, like Godogen's demo prompts).
- Fixing SummerEngine's broken game-validation step: you need an agent that can *see* the running game and report concrete visual defects.
- Unattended generation runs where the deliverable must include proof (15–20s recording) instead of "it compiled, trust me."
- Asset generation for the game (references, textures, 3D models, animated sprites) as part of the same pipeline.

## When NOT to Use

- Hand-authored, large-scope production work — this is a generator loop, not a replacement for deliberate design iteration.
- When no headless/GPU capture environment exists — the QC loop is worthless if frames come from a software renderer (see Failure Modes).
- Quick code fixes with no visual component — running the engine and capturing is overhead if the change is purely logic.

## Core Principles (extracted)

1. **godogen → game repo → game.** The generator itself is not a game. You publish a thin scaffold into a fresh game repo; the agent then builds the actual game *inside* that repo from a short engine guide.

2. **Thin runtime, smart agent.** The published repo is intentionally minimal: one engine-agnostic runtime manifest (`prompts/runtime.md`), a one-page per-engine guide (`engines/godot.md`), and a single cross-engine asset-generation skill (`asset-gen/`). The model plans, scaffolds, and decomposes the work itself — there are no planner/decomposer/architecture skill files anymore (dropped 2026-07-02).

3. **Proof over claims.** "The agent judges results from the running game (a live URL or a recorded clip), not from a clean compile, so visible defects drive the next iteration."

4. **Host agent self-verifies from captured frames.** Godogen dropped a separate Gemini verification pass on 2026-04-26: "Opus 4.7 / GPT 5.5 self-verify from captured frames; external pass added no signal." One strong coding agent looking at real screenshots is enough.

5. **Two involvement modes, chosen by how the task is framed.** Watch the live game and steer at decision points, or run unattended and receive a 15–20s proof recording at the end, "watched back before done."

6. **Engine-specific runtime traps live in the engine guide** — the defects that "survive a compile but fail at runtime" are documented where the agent will read them during the run.

## SummerEngine Architecture Mapping

| Godogen concept | SummerEngine adaptation |
|---|---|
| `publish.sh --engine godot --agent codex` | A SummerEngine publish step that renders `AGENTS.md` + skills into the target game repo |
| `prompts/runtime.md` manifest | One SummerEngine runtime manifest describing delivery contract + involvement modes |
| `engines/godot.md` one-page guide | SummerEngine engine guide: capture recipes, runtime traps, scene conventions |
| `asset-gen/` skill | SummerEngine asset-generation skill (Gemini/Grok/Tripo3D stack below) |
| Proof recording (ffmpeg + xvfb) | Godot viewport screenshot capture + optional ffmpeg clip |
| C#/.NET + `dotnet build` as compile gate | See note below — Godogen migrated to C# specifically so `dotnet build` replaces per-file validation loops |

**Language note:** Godogen generates Godot games in **C#/.NET** (migrated from GDScript on 2026-04-06) because `dotnet build` gives a cheap, reliable compile gate. If SummerEngine stays GDScript, you need an equivalent cheap gate — e.g. `godot --headless --check-only` script parsing — before the visual stage, since the whole point is: compile gate first, *then* visual proof, never one instead of the other.

## Scene / Repo Shape (SummerEngine target)

Published game repo (thin, everything else recreated by the agent):

```
my-summer-game/
├── AGENTS.md                 # host-agent entry (Codex flavor)
├── prompts/runtime.md        # delivery manifest + involvement modes
├── engines/summerengine.md   # one-page guide: capture, traps, conventions
└── .agents/skills/
    └── asset-gen/            # sole published skill (asset generation)
```

In-engine capture harness (Godot 4 node shape):

```
Main (Node)
├── Game ...                  # whatever the agent built
├── Camera3D / Camera2D
└── ProofCapture (Node, autoload or scene node)
    # listens to RenderingServer.frame_post_draw
    # saves PNGs to user://proof/ on trigger
```

## Capture Harness (GDScript, adaptation)

The source says *that* Godogen captures (xvfb + engine screenshots + ffmpeg proof video) but the repo internals were not retrievable. Below is a SummerEngine-facing adaptation, not extracted code:

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

The ffmpeg step (from setup.md, `ffmpeg — MP4 encoding of proof videos`):

```bash
ffmpeg -framerate 2 -i user://proof/%03d_rec.png -c:v libx264 -pix_fmt yuv420p proof.mp4
```

Headless run on Linux uses xvfb so rendering is real: `xvfb-run -a godot --headless ...` (setup.md: xvfb is explicitly for "headless Godot/Bevy runs and capture").

## The Visual QC Loop (the core deliverable)

This is the piece SummerEngine's validation should adopt:

```
1. BUILD/EDIT   agent applies a change to the game
2. COMPILE GATE cheap syntax/build check (dotnet build OR godot script check)
3. RUN + CAPTURE launch game under xvfb, capture screenshots at defined triggers
4. SELF-REVIEW  host agent inspects captured frames against the brief
5. DEFECT LIST  structured findings: {location, expected, observed, severity}
6. DECIDE       no blocking defects → go to 7; else → back to 1 with the list
7. PROOF        15–20s recording, "watched back before done"
```

Rules that make it work:

- **Bounded.** Hard cap on rounds (see Tunables). Godogen's delivery manifest frames this as closing with a proof recording, not iterating forever.
- **Same agent verifies.** Do not add a separate verifier model — Godogen tested that (Gemini verification) and dropped it: no extra signal.
- **Defects must be visible.** The review prompt asks for concrete visual observations tied to the brief ("character sprite missing against brief's 'chunky iconic sprites'", not "looks wrong").
- **Engine traps belong in the guide.** Recurring "survives compile, fails at runtime" defects get written into `engines/summerengine.md` so the agent reads them before they happen again.

## Asset Generation Pipeline (extracted)

| Need | Tool | Notes |
|---|---|---|
| Precise references & characters | Gemini (`GOOGLE_API_KEY`, google-genai) | high-fidelity image generation |
| Textures & simple objects | xAI Grok (`XAI_API_KEY`) | image/video generation |
| Image-to-3D, rigged biped animation | Tripo3D (`TRIPO3D_API_KEY`) | 3D conversion |
| Animated sprites | Grok video → frame extraction (ffmpeg) → loop detection → background removal | BiRefNet multi-signal matting (since 2026-03-25); imagemagick for resize/flip/crop |

asset-gen is the **sole published skill** in a godogen game repo — everything else the agent recreates from the engine guide.

## Implementation Steps

1. **Write the thin runtime for SummerEngine**: `prompts/runtime.md` (delivery manifest + the two involvement modes), `engines/summerengine.md` (one page: how to run, how to capture, known runtime traps), and the asset-gen skill. Engine guide content comes from actual SummerEngine run failures — start it now, grow it every time a defect "survives compile."
2. **Set up headless capture**: Godot 4 (.NET build if following Godogen's C# choice) on PATH, xvfb, ffmpeg, imagemagick, vulkan-tools. Verify GPU path with `vulkaninfo --summary`; a software-renderer fallback on a GPU host is a misconfiguration to fix before trusting any QC frame.
3. **Implement `ProofCapture`** (GDScript above) as an autoload; wire capture triggers to scene-loaded, state-changed, and recording mode.
4. **Define the compile gate**: `dotnet build` (C#) or `godot --headless --check-only` (GDScript). Gate must run before every capture round.
5. **Implement the QC loop protocol**: capture → self-review → structured defect list → fix → re-capture, capped at `max_qc_rounds`. The reviewing prompt receives the original brief + latest frames and must output findings in a fixed JSON shape.
6. **Add the proof-recording close**: after the loop passes, record 15–20s, encode with ffmpeg, and have the agent watch the clip back before declaring done.
7. **Support both involvement modes**: if the task is framed open-ended, surface the live game early and checkpoint at taste/scope/cost decisions; if it's a finished brief, run unattended and close with proof.
8. **Optionally move runs to a server**: tmux/screen for long sessions, GPU instance for faster render+capture, remote-control interface to steer mid-run.

## Tunables

| Parameter | Meaning | Godogen reference |
|---|---|---|
| `max_qc_rounds` | hard cap on capture→fix iterations | bounded delivery, not infinite |
| Proof clip length | recording at the end of a run | 15–20 s |
| Capture triggers | when screenshots fire (scene load / state change / timer) | engine-guide defined |
| Record fps | frame rate of the QC strip | 2 fps is enough for review; ffmpeg re-encodes |
| Verification model | which agent reviews frames | host agent itself (Claude Code / Codex); no separate verifier |
| Involvement mode | live-steered vs unattended | chosen by task framing |

## Failure Modes & Gotchas

- **Trusting a clean compile.** The whole anti-pattern Godogen exists to kill. Compile gate is necessary, never sufficient.
- **Software-renderer frames.** SwiftShader/llvmpipe/lavapipe output looks wrong and misleads the QC loop; on a GPU host it means the capture path is misconfigured (setup.md warns explicitly).
- **Unbounded verification loops.** Without `max_qc_rounds` the agent iterates forever on taste-level nitpicks. Close with proof, don't chase perfection.
- **Adding a separate verifier model.** Godogen tried Gemini verification and dropped it — "external pass added no signal." Don't repeat the experiment.
- **Capturing before the frame settles.** Grab the viewport after `frame_post_draw`/a short delay, or screenshots show half-rendered scenes and generate false defects.
- **Harmless headless noise.** `godot --headless --quit` may show RID warnings (setup.md calls them harmless) — don't let the QC loop treat engine noise as defects.
- **GDScript vs C# trade-off.** Godogen's C# migration was driven by `dotnet build` replacing per-file validation loops. Staying GDScript is fine, but you must provide an equally cheap compile gate or the loop loses its fast first stage.
- **Stale claims.** The X post mentions "850+ GDScript classes" language reference, but the project migrated to C# in April 2026 — verify current repo state before copying specifics.

## Verification

Not summerengine-verified. To validate an implementation:

1. Publish a thin SummerEngine game repo from the runtime manifest; confirm the agent scaffolds a runnable project from the one-page guide alone.
2. Run a small game brief end-to-end; confirm the pipeline produces a running build, not just code.
3. Intentionally introduce a visible defect (e.g., broken sprite, missing material); confirm the QC loop's self-review detects it from captured frames and fixes it within the round cap.
4. Confirm the run closes with a 15–20s proof clip that the agent reviews before marking done.
5. Confirm the compile gate runs before every capture round and that frames come from hardware rendering (check with vulkaninfo).

## Confidence

`extracted` — Architecture (thin runtime, manifest + engine guide + asset-gen), the proof-over-claims principle, self-verification from captured frames, the dropped Gemini verification, C# migration rationale, capture tooling (xvfb/ffmpeg/imagemagick/vulkan-tools), asset-generation stack, and the two involvement modes are drawn directly from the GitHub README, CHANGELOG.md, and setup.md. The `ProofCapture` GDScript, the QC-loop JSON protocol, and the SummerEngine repo mapping are librarian adaptations — the repository's internal files (`prompts/runtime.md`, `engines/godot.md`, `asset-gen/` contents) could not be retrieved and are referenced only by their README-described roles.
