---
name: facial-and-lipsync
description: Use when the user has a voice-over (or wants one) and needs the character's mouth to actually move with the words — phoneme extraction from audio, mapping to viseme blendshapes, plus emotional facial expressions (smile, frown, surprise). Trigger on "lipsync", "lip sync", "talking head", "phonemes", "viseme", "facial animation", "blendshapes", "make him talk", "dialogue animation".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: animation
user-invocable: false
allowed-tools: Read Grep Edit Write summer_search_assets summer_inspect_resource summer_inspect_node summer_generate_voice summer_generate_motion summer_add_node summer_set_prop summer_set_resource_property summer_save_scene summer_get_script_errors
paths: ["**/*.gd", "**/*.tscn", "**/*.tres"]
---

# Facial Animation & Lipsync

Half generative, half authored. The *generative* half: an audio file (usually from `summer_generate_voice`) goes through a phoneme-extraction service (FAL hosts several), out comes a viseme timeline — a list of `{ phoneme, start_time, duration }` triples. The *authored* half: the character's face mesh must have BlendShapes named for the standard viseme set, or the timeline has nothing to drive. Without both halves, you get a talking robot.

The 2026 production stack:

1. **Audio in** — `.wav`/`.mp3` from `summer_generate_voice` or imported VO.
2. **Phoneme extraction** — FAL's `whisper-phoneme` or equivalent (wrapped via Summer's MCP). Output: timeline of phonemes with timestamps.
3. **Viseme mapping** — phonemes → Oculus / Apple ARKit viseme set (15 standard shapes covers English).
4. **BlendShape driver** — at runtime, lerp the mesh's BlendShape weights along the timeline, synced to audio playback.
5. **Optional emotional layer** — separate BlendShape track for `smile`, `brow_raise`, `eye_squint` etc., authored in code or at clip-edit time.

## When to use this skill

- NPC has voice lines and the mouth doesn't move.
- Cinematic with VO that needs lipsync.
- "Make him sing the lyrics."
- Animating expressions on a face that has BlendShapes (Meshy character heads ship with the ARKit-52 set by default).
- Reactive face: smile when player gives gold, scowl when attacked.

## When NOT to use this skill

- Character has no face / no BlendShapes (helmeted soldier, robot, mascot). Hard-skip to body language via `summer:animation/generate-motion`.
- The dialogue is written but not yet voiced — generate audio first via `summer_generate_voice`. Lipsync without audio has nothing to sync to.
- Pre-rendered cinematic from external DCC. Lipsync is in the rendered video, not the engine.

## Steps

### 1. Confirm the head has BlendShapes

```
summer_inspect_node "./World/NPC/Head"     # or wherever the head MeshInstance3D lives
```

Look for `mesh.blend_shape_count` > 0 and a list of names. The Meshy ARKit-52 set (default for Meshy character heads) has names like `jawOpen`, `mouthClose`, `mouthFunnel`, `mouthPucker`, `mouthLeft`, `mouthRight`, `mouthSmile_L`, `mouthSmile_R`, `mouthFrown_L`, `mouthFrown_R`, `browInnerUp`, `browOuterUp_L`, `browDown_L`, `eyeBlink_L`, `eyeWide_L`, `eyeSquint_L` (mirrored on R).

If the head has zero BlendShapes, stop. Tell the user: "This head mesh has no BlendShapes — facial animation is impossible without re-meshing. Options: regenerate the character with the 'face_blendshapes: arkit' flag (`summer_image_to_3d`), use an emotional body-language overlay instead, or hand off the character to a 3D artist for shape-key authoring." Don't proceed.

### 2. Get the audio

If the user has VO already, use it. If not, generate:

```
summer_generate_voice(
  text: "Welcome to the village, traveler.",
  voice: "warm_male_low",
  speed: 1.0
)
// returns { audioAssetId, durationSeconds, url }
```

### 3. Extract phonemes (the generative step)

The MCP wrapper for FAL phoneme-extraction. (Summer Engine wave 1B exposes this; if your installed CLI version is earlier, use the fallback in the next section.)

```
summer_extract_phonemes(
  audioAssetId: "<id>",
  language: "en"
)
// returns:
// {
//   phonemes: [
//     { phoneme: "W", start: 0.00, duration: 0.08 },
//     { phoneme: "EH", start: 0.08, duration: 0.10 },
//     { phoneme: "L", start: 0.18, duration: 0.07 },
//     { phoneme: "K", start: 0.25, duration: 0.05 },
//     { phoneme: "AH", start: 0.30, duration: 0.12 },
//     { phoneme: "M", start: 0.42, duration: 0.08 },
//     ...
//   ],
//   visemeTimeline: [   // pre-mapped to ARKit viseme set
//     { viseme: "viseme_aa", weight: 0.3, time: 0.00 },
//     { viseme: "viseme_E",  weight: 0.7, time: 0.08 },
//     ...
//   ]
// }
```

Cost: ~$0.02 per minute of audio. Latency: ~5s for a 30s clip.

### 4. Persist the viseme track as an AnimationLibrary entry

Convert the timeline into a Godot Animation resource — one track per BlendShape, keyframes at each viseme transition. This makes lipsync replayable via the same AnimationPlayer/AnimationTree as body motion.

```gdscript
# scripts/lipsync_baker.gd — run once per VO line at edit time
static func bake(viseme_timeline: Array, head_path: NodePath) -> Animation:
    var anim := Animation.new()
    anim.length = viseme_timeline[-1].time + 0.1
    var visemes := ["viseme_aa", "viseme_E", "viseme_I", "viseme_O", "viseme_U",
                    "viseme_PP", "viseme_FF", "viseme_TH", "viseme_DD", "viseme_kk",
                    "viseme_CH", "viseme_SS", "viseme_nn", "viseme_RR", "viseme_sil"]
    var tracks := {}
    for v in visemes:
        var idx := anim.add_track(Animation.TYPE_BLEND_SHAPE)
        anim.track_set_path(idx, NodePath(str(head_path) + ":" + v))
        tracks[v] = idx
    for entry in viseme_timeline:
        for v in visemes:
            var weight: float = entry.weight if entry.viseme == v else 0.0
            anim.track_insert_key(tracks[v], entry.time, weight)
    return anim
```

Bake once, save into the character's AnimationLibrary as `dialogue_<line_id>`, and play via the AnimationTree.

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

- **Mouth never closes between words.** No `viseme_sil` keyframes at silence intervals. The bake step must scan the audio for silence (RMS below threshold for 100ms+) and insert sil keys, OR the phoneme extractor must emit silence markers. Default `summer_extract_phonemes` does emit them.
- **Lipsync drifts behind audio.** Audio playback latency on some platforms is 30–60ms. Either delay the audio start by 1 frame, or pre-shift the animation by the platform's known latency. On desktop Linux audio output can be 60ms behind; on Steam Deck ~20ms.
- **Visemes pop on/off.** Crossfade between viseme keyframes — set `Animation.TRACK_INTERPOLATION_LINEAR` (default) and ensure each viseme's weight ramps from previous to current. Default bake does this; if you wrote custom keyframes with NEAREST interp, switch.
- **Smile fights lipsync.** Both write to mouth BlendShapes. Solve by additive layering: lipsync layer outputs deltas from neutral, smile layer outputs deltas from neutral, sum them, clamp 0..1. ARKit shapes are sum-safe up to ~1.5; clamp prevents over-rotation.
- **Eyes look dead.** Lipsync is mouth-only; without blinks and saccades the face is uncanny. Add an idle blink track (every 4–8s, jittered) and a small saccade track (random eye movement up to 5°). Both can be one-shots fired by a `Timer`.
- **Phoneme extraction returns gibberish.** Audio is too noisy, mismatched language code, or compressed too aggressively. Re-export the source as 22kHz mono WAV before sending. Don't lipsync from a 64kbps MP3.
- **Custom rig has different BlendShape names.** The bake assumes ARKit-52. If the rig uses Preston Blair or a custom set, write a name-mapping `Dictionary` and apply it during bake. Only do this once per character.

### Quality bar

- ~12 phonemes/sec is normal English speech; the bake produces ~25 keyframes/sec across all tracks. Below 60fps playback on weak hardware: enable `BlendShape track interpolation = NEAREST` (loses smoothness, gains 30% perf). Reserve for mobile / very crowded crowd scenes.
- Lipsync alone is ~70% of "alive". Add idle blink + idle micro-head-bob (`summer:animation/procedural-animation`) and you're at ~95%. The remaining 5% is brow articulation tied to dialogue sentiment, which is bespoke per scene.

## Anti-patterns

- Driving BlendShape weights from `_process` with hand-coded curves. The Animation track is sample-accurate and re-uses the AnimationTree's interpolation; manual code drifts and stutters.
- Using a single "talking" loop instead of phoneme-driven lipsync. The 1990s look. Always extract phonemes; the cost is trivial.
- Forgetting to gate audio + animation on the same frame. If you `play()` audio in `_ready` and fire the OneShot in `_process`, you'll see ~16ms drift at line start. Both calls in the same function, same frame.
- Using lipsync for non-talking sounds (groans, screams). Lipsync needs phonemes; non-verbal vocals confuse the extractor. For grunts, drive `jawOpen` from the audio's RMS envelope instead — much simpler.

## Edge cases

- **Multilingual VO.** `summer_extract_phonemes` supports `language` parameter; pass the right ISO code. Cross-language lipsync (extract as English on Spanish audio) gives ~70% accuracy — bad enough that subtitles are needed regardless.
- **Singing.** Phoneme extractor handles sustained vowels well, but consonant timing is loose. For sung dialogue, manually keyframe consonants and let extracted vowels fill in.
- **Aside / muttering at low volume.** Phoneme extractor needs > -40 dB. Boost the source clip before extracting if the line is intentionally quiet, then play it at the original volume in-engine.
- **Stylized character with no jaw bone (e.g., a cartoon ball).** No bone, but BlendShapes can still drive a "morph open" shape. Same pipeline; skip the jaw-bone-track and only animate BlendShapes.

## Fallback (no MCP)

Run FAL's `whisper-phoneme` (or `aeneas-align` for forced alignment) directly via web upload, download the JSON, hand-write the bake step in `scripts/lipsync_baker.gd`. Same output. Slower per-line but works offline-of-Summer.

For projects that can't use cloud services, Godot 4.5's `AudioStreamGenerator` with hand-rolled vowel/consonant detection from RMS + zero-crossings gives ~50% accuracy — enough for a stylized character but not photoreal.

## Handoff

- For voice generation upstream, `summer:audio/generate-voice` (or call `summer_generate_voice` directly).
- For dialogue scripts and conversation flow, `summer:ai-and-npcs/design-npc`.
- For the AnimationTree this layer composes into, `summer:animation/animation-tree`.
- For idle blinks, saccades, and head-tracking that complement lipsync, `summer:animation/procedural-animation`.
- For full performance capture (face + body together), out of scope — see Meshy's mocap docs or external pipelines.

## See also

- `summer:audio/generate-voice` — TTS upstream of this skill.
- `summer:animation/animation-tree` — wire the lipsync OneShot into the character's tree.
- `summer:animation/procedural-animation` — eye blinks, saccades, head idle.
- `_shared/mcp-tools-reference.md` — `summer_generate_voice`, `summer_extract_phonemes` schemas.
