---
name: facial-and-lipsync
description: Use when the user has a voice-over (or wants one) and needs the character's mouth to actually move with the words — phoneme extraction from audio, mapping to viseme blendshapes, plus emotional facial expressions (smile, frown, surprise). Trigger on "lipsync", "lip sync", "talking head", "phonemes", "viseme", "facial animation", "blendshapes", "make him talk", "dialogue animation".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: animation
user-invocable: false
allowed-tools: Read Grep Edit Write summer_search_assets summer_inspect_resource summer_inspect_node summer_generate_audio summer_generate_motion summer_run_script summer_add_node summer_set_prop summer_set_resource_property summer_save_scene summer_get_script_errors
paths: ["**/*.gd", "**/*.tscn", "**/*.tres"]
---

# Facial Animation & Lipsync

Half generative, half authored. The *generative* half: an audio file (TTS via `summer_generate_audio` with `capability: "text_to_speech"`) goes through a phoneme-extraction tool (Summer does NOT wrap one — you run it externally), out comes a viseme timeline — a list of `{ phoneme, start_time, duration }` triples. The *authored* half: the character's face mesh must have BlendShapes named for the standard viseme set, or the timeline has nothing to drive. Without both halves, you get a talking robot.

The 2026 production stack:

1. **Audio in** — `.wav`/`.mp3` from `summer_generate_audio({capability: "text_to_speech", ...})` or imported VO.
2. **Phoneme extraction** — done OUTSIDE Summer. Recommended: **Rhubarb Lip Sync** (open source, the industry standard for game-dev lipsync; outputs JSON with mouth-shape cues over time). Alternatives: gentle, allosaurus, or a Whisper-phoneme model on Replicate / Hugging Face. There is no `summer_*` MCP for this in the current engine.
3. **Viseme mapping** — phonemes / Rhubarb cues → Oculus / Apple ARKit viseme set (15 standard shapes covers English).
4. **BlendShape driver** — at runtime, lerp the mesh's BlendShape weights along the timeline, synced to audio playback.
5. **Optional emotional layer** — separate BlendShape track for `smile`, `brow_raise`, `eye_squint` etc., authored in code or at clip-edit time.

## When to use this skill

- NPC has voice lines and the mouth doesn't move.
- Cinematic with VO that needs lipsync.
- "Make him sing the lyrics."
- Animating expressions on a face that has BlendShapes. Never assume it does — step 1 below is the check, and generated characters frequently come back with zero.
- Reactive face: smile when player gives gold, scowl when attacked.

## When NOT to use this skill

- Character has no face / no BlendShapes (helmeted soldier, robot, mascot). Hard-skip to body language via `generate-motion`.
- The dialogue is written but not yet voiced — generate audio first via `summer_generate_audio({capability: "text_to_speech", ...})`. Lipsync without audio has nothing to sync to.
- Pre-rendered cinematic from external DCC. Lipsync is in the rendered video, not the engine.

## Steps

### 1. Confirm the head has BlendShapes

```
summer_inspect_node "./World/NPC/Head"     # or wherever the head MeshInstance3D lives
```

Look for `mesh.blend_shape_count` > 0 and a list of names. An ARKit-52 head has names like `jawOpen`, `mouthClose`, `mouthFunnel`, `mouthPucker`, `mouthLeft`, `mouthRight`, `mouthSmile_L`, `mouthSmile_R`, `mouthFrown_L`, `mouthFrown_R`, `browInnerUp`, `browOuterUp_L`, `browDown_L`, `eyeBlink_L`, `eyeWide_L`, `eyeSquint_L` (mirrored on R).

If the head has zero BlendShapes, stop. Tell the user: "This head mesh has no BlendShapes — facial animation needs shape keys on the mesh. Options: use an emotional body-language overlay instead, author shape keys in Blender and re-import, or hand the character to a 3D artist." Don't proceed.

Do **not** promise a `face_blendshapes` generation option. `summer_generate_3d`
has no such parameter and nothing in the Summer generation pipeline handles one
— `options` is an untyped passthrough, so a bogus key is accepted by the schema
and then silently ignored by the backend. Regenerating will not add BlendShapes.
Shape keys come from the mesh author (Blender / an ARKit-52 source mesh), not
from a rig pass.

### 2. Get the audio

If the user has VO already, use it. If not, generate via TTS. The `voiceId` is an ElevenLabs voice ID — the user has to pick one from the ElevenLabs voice library (https://elevenlabs.io/app/voice-library) or upload/clone their own. There is no "voice name" string; it's always an ID like `21m00Tcm4TlvDq8ikWAM` (Rachel) or a custom-cloned ID.

```
summer_generate_audio({
  capability: "text_to_speech",
  text: "Welcome to the village, traveler.",
  voiceId: "<elevenlabs_voice_id>"
})
// returns { jobId, ... } — poll with summer_check_job for the audio asset
```

If the user hasn't picked a voice yet, stop and ask: "Which ElevenLabs voice ID should I use? You can browse the library at elevenlabs.io/app/voice-library and copy the ID, or paste a custom-clone ID from your account."

### 3. Extract phonemes (the generative step — runs OUTSIDE Summer)

Summer does not wrap a phoneme-extraction MCP tool. Run it externally, then import the result. **Recommended: Rhubarb Lip Sync** — an open-source CLI built for game-dev lipsync. Mouth shapes A–H map cleanly to viseme shapes.

Install once:

```
# macOS
brew install rhubarb-lip-sync
# Windows / Linux: download release from https://github.com/DanielSWolf/rhubarb-lip-sync
```

Run per VO line:

```
rhubarb -f json -o welcome_traveler.json welcome_traveler.wav
```

Output JSON shape:

```json
{
  "metadata": { "duration": 2.34 },
  "mouthCues": [
    { "start": 0.00, "end": 0.08, "value": "B" },
    { "start": 0.08, "end": 0.18, "value": "C" },
    { "start": 0.18, "end": 0.25, "value": "D" },
    { "start": 0.25, "end": 0.30, "value": "B" },
    { "start": 0.30, "end": 0.42, "value": "A" },
    { "start": 0.42, "end": 0.50, "value": "B" },
    { "start": 2.30, "end": 2.34, "value": "X" }
  ]
}
```

Rhubarb mouth-shape → ARKit viseme cheat sheet (apply during the bake step):

| Rhubarb | ARKit viseme | Notes |
|---|---|---|
| A | `viseme_PP` | closed (P, B, M) |
| B | `viseme_kk` | slightly open, neutral |
| C | `viseme_E` | open, lips spread (EH, IH) |
| D | `viseme_aa` | wide open (AA, AH) |
| E | `viseme_O` | rounded (OW, ER) |
| F | `viseme_U` | small rounded (UW, OO) |
| G | `viseme_FF` | F, V (lower lip + teeth) |
| H | `viseme_RR` | L, R (tongue raised) |
| X | `viseme_sil` | silence / closed neutral |

**Manual fallback (no Rhubarb available):** for short lines you can hand-type a `mouthCues` array by listening to the clip and tagging vowel/consonant boundaries. Painful past ~3s of audio; use Rhubarb for anything longer.

**Cloud fallback:** a Whisper-phoneme model on Replicate or a Hugging Face inference endpoint will emit ARPAbet phonemes with timestamps. Then map ARPAbet → ARKit visemes via the table in the Reference card section. More accurate than Rhubarb on noisy audio; slower and costs cents per minute.

Cost: Rhubarb is free + ~5s CPU per 30s clip locally. Cloud fallback ~$0.02 / minute, ~5s wall-clock for a 30s clip.

### 4. Persist the viseme track as an AnimationLibrary entry

Convert Rhubarb's `mouthCues` into a Summer Engine Animation resource: one
track per BlendShape with keyframes at each viseme transition. This makes lip
sync replayable through the same AnimationPlayer/AnimationTree as body motion.

```gdscript
# scripts/lipsync_baker.gd — run once per VO line at edit time
const RHUBARB_TO_VISEME := {
    "A": "viseme_PP",  "B": "viseme_kk", "C": "viseme_E",
    "D": "viseme_aa",  "E": "viseme_O",  "F": "viseme_U",
    "G": "viseme_FF",  "H": "viseme_RR", "X": "viseme_sil",
}

static func bake_from_rhubarb(rhubarb_json_path: String, head_path: NodePath) -> Animation:
    var f := FileAccess.open(rhubarb_json_path, FileAccess.READ)
    var data: Dictionary = JSON.parse_string(f.get_as_text())
    var cues: Array = data["mouthCues"]
    var anim := Animation.new()
    anim.length = float(data["metadata"]["duration"])
    var visemes := ["viseme_aa", "viseme_E", "viseme_I", "viseme_O", "viseme_U",
                    "viseme_PP", "viseme_FF", "viseme_TH", "viseme_DD", "viseme_kk",
                    "viseme_CH", "viseme_SS", "viseme_nn", "viseme_RR", "viseme_sil"]
    var tracks := {}
    for v in visemes:
        var idx := anim.add_track(Animation.TYPE_BLEND_SHAPE)
        anim.track_set_path(idx, NodePath(str(head_path) + ":" + v))
        tracks[v] = idx
    # For each cue, set the active viseme to 1.0 and others to 0.0 at cue.start
    for cue in cues:
        var active_viseme: String = RHUBARB_TO_VISEME.get(cue["value"], "viseme_sil")
        for v in visemes:
            var weight: float = 1.0 if v == active_viseme else 0.0
            anim.track_insert_key(tracks[v], float(cue["start"]), weight)
    return anim
```

Bake once, save into the character's AnimationLibrary as `dialogue_<line_id>`, and play via the AnimationTree.

This is a plain `Animation` resource authored in code — no editor required.
`Animation.new()` + `add_track()` + `track_set_path()` + `track_insert_key()` +
`ResourceSaver.save()` works from a headless `-s` script and the resource
reloads with every track and track type intact (verified on the shipped 4.6.1
binary with value, blend-shape and method tracks in one resource). Any advice
that says animation tracks or keyframes can only be authored in the editor GUI
is wrong. The bake function also runs unchanged inside a `summer_run_script`
body against the live editor — often more convenient than the headless lane
because the result lands in the open scene's library and the run is
transactional.

For QUICK facial keys that don't need a viseme timeline (a roar, a wince, an
eyebrow raise), Wave G engines collapse the whole bake into `ctx.animate` with
a `"blend_shapes/<name>"` property path (value tracks, verified working) — one
call per shape, same `anim_name` appends tracks to one clip. Recipe in
`character-animation-wiring`. The Rhubarb bake loop above
stays the right tool for full audio-synced viseme timelines — 15 tracks with
per-cue keys is exactly what the loop is for.

If you used the Whisper/ARPAbet cloud fallback instead of Rhubarb, swap `bake_from_rhubarb` for a variant that consumes `{ phoneme, start, duration }` triples and applies the ARPAbet → viseme table from the Reference card.

### 5. Wire into the AnimationTree

Add a OneShot node `Lipsync` that overlays the viseme animation as an *additive* layer over the base face. Fire from the dialogue system:

```gdscript
@onready var tree: AnimationTree = $AnimationTree
@onready var audio: AudioStreamPlayer3D = $VoicePlayer

func say(line_id: String) -> void:
    var clip_id := "dialogue_" + line_id
    tree.set("parameters/Lipsync/animation", clip_id)
    audio.stream = load("res://audio/" + line_id + ".ogg")
    audio.play()
    tree.set("parameters/Lipsync/request", AnimationNodeOneShot.ONE_SHOT_REQUEST_FIRE)
```

Sync is preserved as long as both fire on the same frame. ~16ms drift is the threshold of perception; AnimationTree + AudioStreamPlayer3D are both sample-accurate, so drift only happens if the engine hitches mid-line.

### 6. Add the emotional layer (authored, not generative)

A second OneShot or persistent additive track for expressions. Key the relevant BlendShapes (`mouthSmile_L`, `mouthSmile_R`, `browInnerUp`, etc.) at design time:

```gdscript
func smile(intensity: float) -> void:
    var head: MeshInstance3D = $Head
    head.set_blend_shape_value(head.find_blend_shape_by_name("mouthSmile_L"), intensity)
    head.set_blend_shape_value(head.find_blend_shape_by_name("mouthSmile_R"), intensity)

func surprise(intensity: float) -> void:
    var head: MeshInstance3D = $Head
    head.set_blend_shape_value(head.find_blend_shape_by_name("browInnerUp"), intensity)
    head.set_blend_shape_value(head.find_blend_shape_by_name("browOuterUp_L"), intensity * 0.7)
    head.set_blend_shape_value(head.find_blend_shape_by_name("browOuterUp_R"), intensity * 0.7)
    head.set_blend_shape_value(head.find_blend_shape_by_name("eyeWide_L"), intensity)
    head.set_blend_shape_value(head.find_blend_shape_by_name("eyeWide_R"), intensity)
    head.set_blend_shape_value(head.find_blend_shape_by_name("jawOpen"), intensity * 0.3)
```

Driven from gameplay events; orthogonal to the lipsync layer.

## Confirmation gates

- **Before extracting:** show audio length, est. cost, est. wait. Wait for OK.
- **Before baking the Animation resource:** confirm the head's BlendShape names match the standard set. If they're custom-named, ask for the mapping.
- **Before saving the scene:** confirm the AnimationTree changes (added Lipsync OneShot, library entry).

## Reference card

### ARKit-52 viseme subset (the 15 that matter for English lipsync)

| Viseme | Triggered by phonemes (ARPAbet) | Mouth shape |
|---|---|---|
| `viseme_sil` | silence | closed neutral |
| `viseme_PP` | P, B, M | lips pressed |
| `viseme_FF` | F, V | lower lip + upper teeth |
| `viseme_TH` | TH, DH | tongue tip + teeth |
| `viseme_DD` | T, D, N, S, Z | tongue + alveolar |
| `viseme_kk` | K, G, NG | back-tongue, mouth slightly open |
| `viseme_CH` | CH, JH, SH, ZH | lips rounded forward |
| `viseme_SS` | S, Z (sometimes split from DD) | teeth nearly closed |
| `viseme_nn` | N, L | tongue-tip + open mouth |
| `viseme_RR` | R, ER | mouth slightly rounded |
| `viseme_aa` | AA, AH, AE | wide open |
| `viseme_E` | EH, EY, IH | mid open + lips spread |
| `viseme_I` | IY, IH | narrow + spread |
| `viseme_O` | OW, AO | rounded |
| `viseme_U` | UW, UH | rounded + small |

### Phoneme → viseme mapping (for hand-rolled extraction)

If the user has a CMUDict-style phoneme list and wants to map manually, this is the table to apply.

### Pitfalls

- **Mouth never closes between words.** No `viseme_sil` keyframes at silence intervals. The bake step must scan the audio for silence (RMS below threshold for 100ms+) and insert sil keys, OR the phoneme extractor must emit silence markers. Rhubarb emits `X` cues for silence (mapped above to `viseme_sil`); cloud Whisper-phoneme models often don't — add a silence-detection pass if you go that route.
- **Lipsync drifts behind audio.** Audio playback latency on some platforms is 30–60ms. Either delay the audio start by 1 frame, or pre-shift the animation by the platform's known latency. On desktop Linux audio output can be 60ms behind; on Steam Deck ~20ms.
- **Visemes pop on/off.** Crossfade between viseme keyframes — the constant is `Animation.INTERPOLATION_LINEAR` (there is no `TRACK_INTERPOLATION_LINEAR`; the real set is `INTERPOLATION_NEAREST` / `_LINEAR` / `_CUBIC` / `_LINEAR_ANGLE` / `_CUBIC_ANGLE`). Apply it per track with `anim.track_set_interpolation_type(idx, Animation.INTERPOLATION_LINEAR)` and ensure each viseme's weight ramps from previous to current. Default bake does this; if you wrote custom keyframes with NEAREST interp, switch.
- **Smile fights lipsync.** Both write to mouth BlendShapes. Solve by additive layering: lipsync layer outputs deltas from neutral, smile layer outputs deltas from neutral, sum them, clamp 0..1. ARKit shapes are sum-safe up to ~1.5; clamp prevents over-rotation.
- **Eyes look dead.** Lipsync is mouth-only; without blinks and saccades the face is uncanny. Add an idle blink track (every 4–8s, jittered) and a small saccade track (random eye movement up to 5°). Both can be one-shots fired by a `Timer`.
- **Phoneme extraction returns gibberish.** Audio is too noisy, mismatched language code, or compressed too aggressively. Re-export the source as 22kHz mono WAV before sending. Don't lipsync from a 64kbps MP3.
- **Custom rig has different BlendShape names.** The bake assumes ARKit-52. If the rig uses Preston Blair or a custom set, write a name-mapping `Dictionary` and apply it during bake. Only do this once per character.

### Quality bar

- ~12 phonemes/sec is normal English speech; the bake produces ~25 keyframes/sec across all tracks. Below 60fps playback on weak hardware: enable `BlendShape track interpolation = NEAREST` (loses smoothness, gains 30% perf). Reserve for mobile / very crowded crowd scenes.
- Lipsync alone is ~70% of "alive". Add idle blink + idle micro-head-bob (`procedural-animation`) and you're at ~95%. The remaining 5% is brow articulation tied to dialogue sentiment, which is bespoke per scene.

## Anti-patterns

- Driving BlendShape weights from `_process` with hand-coded curves. The Animation track is sample-accurate and re-uses the AnimationTree's interpolation; manual code drifts and stutters.
- Using a single "talking" loop instead of phoneme-driven lipsync. The 1990s look. Always extract phonemes; the cost is trivial.
- Forgetting to gate audio + animation on the same frame. If you `play()` audio in `_ready` and fire the OneShot in `_process`, you'll see ~16ms drift at line start. Both calls in the same function, same frame.
- Using lipsync for non-talking sounds (groans, screams). Lipsync needs phonemes; non-verbal vocals confuse the extractor. For grunts, drive `jawOpen` from the audio's RMS envelope instead — much simpler.

## Edge cases

- **Multilingual VO.** Rhubarb supports English best; for other languages, pass `--recognizer phonetic` (language-agnostic, less accurate) or use a multilingual Whisper-phoneme model on Replicate / HF. Cross-language lipsync (extract as English on Spanish audio) gives ~70% accuracy — bad enough that subtitles are needed regardless.
- **Singing.** Phoneme extractor handles sustained vowels well, but consonant timing is loose. For sung dialogue, manually keyframe consonants and let extracted vowels fill in.
- **Aside / muttering at low volume.** Phoneme extractor needs > -40 dB. Boost the source clip before extracting if the line is intentionally quiet, then play it at the original volume in-engine.
- **Stylized character with no jaw bone (e.g., a cartoon ball).** No bone, but BlendShapes can still drive a "morph open" shape. Same pipeline; skip the jaw-bone-track and only animate BlendShapes.

## Fallback (no Rhubarb)

If Rhubarb won't install on the user's platform, run a Whisper-phoneme model on Replicate (e.g., `cjwbw/whisper-phoneme`) or `aeneas-align` for forced alignment. Download the JSON, swap the bake function for one that consumes ARPAbet phonemes (table in Reference card). Same end result — replayable BlendShape Animation resource.

For projects that cannot use any cloud or third-party tool, Summer Engine's
`AudioStreamGenerator` with hand-rolled vowel/consonant detection from RMS and
zero-crossings gives only a rough stylized approximation. Do not present it as
production speech recognition or photoreal lip sync.

## Handoff

- For voice generation upstream, `voice-line` (which wraps `summer_generate_audio({capability: "text_to_speech", ...})`).
- For dialogue scripts and conversation flow, `design-npc`.
- For the AnimationTree this layer composes into, `animation-tree`.
- For idle blinks, saccades, and head-tracking that complement lipsync, `procedural-animation`.
- For full performance capture (face + body together), out of scope — see Meshy's mocap docs or external pipelines.

## See also

- `voice-line` — TTS upstream of this skill.
- `character-animation-wiring` — the blend-shape `ctx.animate` mechanism, plus the body wiring this face layer sits on.
- `animation-tree` — wire the lipsync OneShot into the character's tree.
- `procedural-animation` — eye blinks, saccades, head idle.
- Rhubarb Lip Sync — https://github.com/DanielSWolf/rhubarb-lip-sync (external tool; phoneme extraction).
