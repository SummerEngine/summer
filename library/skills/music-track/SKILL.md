---
name: music-track
description: Use when generating a looped or cinematic music track. Loops are authored at >=30s with a marked loop point; cinematic tracks at >=60s linear. Trigger on "generate music", "make a calm track", "boss music", "title screen music", "main theme", "exploration loop", "combat track".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: audio
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_generate_audio summer_search_assets summer_import_from_url summer_add_node summer_set_prop summer_inspect_node
paths: ["audio/music/**", "scripts/**", "**/*.tscn"]
---

# /music-track — Generate a Loop or Cinematic Music Track

## Overview

ElevenLabs Music renders a track from a prompt. Summer clamps the requested length to **3–600 seconds** before sending it, so anything outside that range is silently pulled to the nearest bound. The output quality depends entirely on prompt specificity: tempo (BPM), key, instrumentation, mood, structural cue. "Epic orchestral" returns generic stock music. "85 BPM, D minor, solo cello and detuned upright piano, sparse, melancholic, no drums, 4/4" returns a usable score for a melancholic exploration scene.

This skill produces one track aligned with the audio bible's music style and dynamic music plan, then wires it as an `AudioStreamPlayer` on the `Music` bus with a marked loop point if it's a loop, or as a linear cinematic stream if it's a one-shot.

## When to use

- Looped track for a level, biome, menu, or game state (calm / tension / combat).
- Cinematic linear track for an intro, ending, boss reveal, or cutscene.
- Replacing a placeholder loop with on-bible music.

## When NOT to use

- Short stings / event punctuation (<5s) → use `audio/sound-effect` with class `Stinger`.
- Adaptive layered stems with state-driven crossfades → `audio/adaptive-music`.
- Ambient bed with no melody → `audio/ambient-bed`.

## Steps

### 1. Read the audio bible

```
Read .summer/audio-bible.md
```

The bible names the primary style, tempo range, key center, time signature, and the dynamic music model. This skill writes prompts that respect those numbers.

If no bible exists:

> No `.summer/audio-bible.md`. Music without an audio bible drifts into stock-library territory. Run `/audio-direction` first, or I can ship a one-off with explicit defaults — your call.

### 2. Identify the track's role

Ask if not obvious:

> Which slot in the dynamic music plan? Calm exploration, tension, combat, boss, victory, menu, ending, or one-off cutscene?

Each slot has different rules:

| Slot | Tempo | Energy | Instrumentation density | Loop or linear |
|---|---|---|---|---|
| Calm exploration | bible low end (e.g. 70–90) | Low | Sparse | Loop, ≥45s |
| Tension | mid (e.g. 90–110) | Medium, no drums or sparse pulse | Adds one instrument | Loop, ≥45s |
| Combat | high (e.g. 120–150) | High, full drums | Full | Loop, ≥45s |
| Boss | high or low-and-menacing | Distinct from combat | Distinct, named instrument | Loop, ≥60s |
| Victory sting | n/a | Resolution | n/a | Linear, 4–8s (use SFX skill instead) |
| Menu / title | bible mid | Atmospheric | Anchor instrument | Loop, ≥30s |
| Cutscene | varies | Linear arc | Varies | Linear, 60–180s |
| Ending | varies | Linear arc with resolution | Varies | Linear, 60–300s |

### 3. Build the prompt — tempo + key + instrumentation + mood + structural cue

Prompts that work:

```
85 BPM, D minor, 4/4, solo cello and detuned upright piano, sparse, melancholic
exploration loop, no drums, gentle reverb, even dynamics, 60s

128 BPM, D dorian, 4/4, full orchestral combat, low brass ostinato, taiko drums
on 1 and 3, strings tremolo, urgent, no melodic resolution, 60s loop

90 BPM, A minor, 6/8, lo-fi exploration, vintage Rhodes electric piano,
tape hiss, warm bass, soft brushed snare, no vocals, 45s loop

70 BPM, F minor, 4/4, ambient menu loop, pad layer, distant choir, single
piano motif every 8 bars, no drums, 30s loop with seamless return

110 BPM, C minor harmonic, 4/4, dark synthwave boss intro, gated reverb snare,
arpeggiated bass synth, lead saw on melody, builds to cymbal swell at 0:50,
linear 60s, ends on sustained pad
```

Prompts that DON'T work (and why):

| Bad prompt | Failure mode |
|---|---|
| `epic orchestral combat music` | No tempo, no key, no instrumentation. Generic stock. |
| `Hollow Knight style track` | The model can't reference IPs and won't try to clone style words. |
| `hopeful but sad menu music with strings and stuff` | "Strings and stuff" is vague; model picks the wrong section. |
| `something for the boss fight` | No tempo, no key, no mood vector. Random. |
| `loop` (just the word) | No structure. Returns 30s of music that doesn't loop. |

### 4. Tempo, key, instrumentation specifics that matter

**Tempo (BPM)** — name a single number, not a range. Music model interprets ranges as mid-point with drift. `85 BPM` is better than `80–90 BPM`.

**Key** — name mode (`D minor`, `D dorian`, `D natural minor`, `C minor harmonic`). The bible's modulation rules go here: combat tracks shift to dorian, calm tracks to natural minor.

**Instrumentation** — name 2–4 specific instruments, not sections. `solo cello` not `strings`. `upright piano` not `keys`. `Rhodes electric piano` not `electric piano`. The model's vocabulary is closer to a session musician's than a producer's.

**Mood** — concrete adjectives anchored to motion: `melancholic and slow`, `urgent and driving`, `triumphant and rising`. Avoid genre adjectives like `epic`, `chill`, `hype`.

**Structural cue** — for linear tracks, name the arc: `builds at 0:30 to a hit at 0:50, decays`. For loops, name the cell: `4-bar phrase repeats, instrument swap every 8 bars`.

### 5. Loop vs cinematic decision

| Choose loop when | Choose linear when |
|---|---|
| The slot plays for an unbounded time (level, menu, exploration) | The slot has a known length (cutscene, intro, ending) |
| Player attention is on gameplay | Player attention is on the music |
| You want to layer adaptive stems on top later | The arc is the point |

For loops: generate **≥30s, prefer 45–60s**. Shorter loops are recognized as repetition within 90s of play and become annoying. The bible's "no state stays >90s without variation" rule means even a 60s loop should contain internal variation (instrument swap on alternating cycles).

For linear: generate **≥60s for cutscenes, up to 300s for endings**. The model handles long arcs better than people expect; ask for one rendered piece rather than splicing.

### 6. Confirm and call

Show the prompt:

> Prompt:
> `85 BPM, D minor, 4/4, solo cello and detuned upright piano, sparse, melancholic exploration loop, no drums, gentle reverb, 60s loop`
> Duration 60s. Cost: ~12 credits. Generate?

The `music` capability reads the description from **`prompt`**, not `text` — the mirror image of `sound_effects`. Passing `text` here is a 400 `prompt_required`.

```
summer_generate_audio(
  capability: "music",
  prompt: "85 BPM, D minor, 4/4, solo cello and detuned upright piano, sparse, melancholic exploration loop, no drums, gentle reverb, 60s loop",
  durationSeconds: 60
)
// Then: summer_import_from_url(url: "<fileUrl>", path: "res://audio/music/calm_exploration.mp3")
```

`durationSeconds` is clamped to 3–600. Music comes back as MP3 (`audio/mpeg`), so a `.mp3` target path is correct.

### 7. Mark the loop point in Summer Engine

ElevenLabs Music does not return a loop-clean cut. You must mark the loop point
in Summer Engine's Import dock so playback returns to the loop point on
completion, not to 0:00.

The MP3 importer exposes exactly five options — `loop`, `loop_offset`, `bpm`, `beat_count`, `bar_beats`. There is **no `loop_mode`** on MP3 or OGG; `loop_mode` belongs to the WAV importer, where it is spelled `edit/loop_mode`.

In `audio/music/calm_exploration.mp3.import`:

```
[params]
loop = true
loop_offset = 0.0
```

If the start has a fade-in but the body is loopable, set `loop_offset = 4.0` (4 seconds of intro skipped on loop, plays full track first time). `bpm` + `beat_count` + `bar_beats` are what you set if you want beat-synced transitions later — see `audio/adaptive-music`.

For seamless looping, the cleaner option is to ask the model to generate a cell (one bar / one phrase) and concatenate; or generate at 60s and trust the model's structural cue. Crossfade looping in code is the practical fallback (see step 9).

### 8. Wire it as `AudioStreamPlayer` on the `Music` bus

Every scene-mutating tool takes an explicit `scenePath`, node paths are relative to the scene root (`./`), and the property argument is named `key`, not `property`:

```
summer_add_node(scenePath="res://main.tscn", parent=".", type="AudioStreamPlayer", name="MusicCalm")
summer_set_prop(scenePath="res://main.tscn", path="./MusicCalm", key="stream", value="res://audio/music/calm_exploration.mp3")
summer_set_prop(scenePath="res://main.tscn", path="./MusicCalm", key="bus", value="Music")
summer_set_prop(scenePath="res://main.tscn", path="./MusicCalm", key="volume_db", value=-8.0)
summer_set_prop(scenePath="res://main.tscn", path="./MusicCalm", key="autoplay", value=true)
```

Music is `AudioStreamPlayer` (not 2D / 3D) — non-positional. The bible's `Music -8 dB` mix sits the music behind SFX where it belongs.

### 9. Crossfade-loop pattern (no marked loop point)

If the loop click bothers the user, use a two-player crossfade:

```gdscript
# scripts/audio/MusicLoopCrossfade.gd
extends Node
@export var stream: AudioStream
@export var fade: float = 1.0
var _a: AudioStreamPlayer
var _b: AudioStreamPlayer
var _active: AudioStreamPlayer

func _ready() -> void:
	_a = _make_player()
	_b = _make_player()
	_active = _a
	_active.play()
	_active.finished.connect(_on_finished)

func _make_player() -> AudioStreamPlayer:
	var p := AudioStreamPlayer.new()
	p.stream = stream
	p.bus = "Music"
	p.volume_db = -8.0
	add_child(p)
	return p

func _on_finished() -> void:
	var next := _b if _active == _a else _a
	next.play()
	next.finished.connect(_on_finished, CONNECT_ONE_SHOT)
	_active = next
```

The next instance starts at 0:00 the moment the previous finishes — gapless.

## Reference card — prompts by slot

```
Calm explore (folk):    78 BPM, D minor, 6/8, fingerpicked acoustic guitar,
                        upright bass on 1, soft hand percussion, no melody on
                        first 8 bars, 60s loop

Tension (orchestral):   95 BPM, D dorian, 4/4, low strings sustained, single
                        timpani roll every 8 bars, sparse french horn motif,
                        no drums, 60s loop

Combat (orchestral):    140 BPM, D dorian, 4/4, taiko drums on 1 and 3,
                        ostinato low brass, strings tremolo, urgent and driving,
                        no melodic resolution, 60s loop

Boss (synthwave):       110 BPM, C minor harmonic, 4/4, gated snare, arpeggio
                        bass synth, lead saw on melody, builds at 0:50,
                        linear 60s

Menu (lo-fi):           70 BPM, F minor, 4/4, vintage Rhodes, tape hiss,
                        soft brushed snare, single piano motif every 8 bars,
                        45s loop

Cutscene (cinematic):   varies tempo, D minor, 4/4, solo piano opens,
                        strings enter at 0:20, full orchestra at 0:50,
                        decay to solo piano at 1:30, linear 120s
```

## Anti-patterns

- **Genre adjectives only.** `epic`, `chill`, `hype` — meaningless.
- **Naming a game or composer.** Model won't replicate; use ingredients.
- **Loop shorter than 30s.** Recognized as repetition fast.
- **Music on `Master` bus at 0 dB.** Buries SFX. Use `Music` bus at `-8 dB`.
- **Generating before reading the bible.** Style drift.
- **Skipping the loop-mark step.** Music returns to 0:00 with a click on every loop.

## Edge cases

- **Clip is 50s but you wanted 60s.** Either regenerate (cheaper than you think) or extend by overlap-crossfading the last 5s onto the start in an audio editor.
- **Loop click on every cycle.** Use the crossfade pattern in step 9.
- **Clip is too long.** Trim the tail in the import dock with `loop_offset`, or in an audio editor.
- **Track sounds nothing like the references.** Re-read the bible; the prompt may be missing the anchor instrument. Add it explicitly.
- **Track has unexpected vocals.** Add `no vocals, instrumental only` to the prompt.

## Fallback (no MCP)

Print the prompt and instruct the user to run via the Summer dashboard, then `summer_import_from_url` the rendered MP3.

## Handoff

> Track `calm_exploration.mp3` wired to `Game/MusicCalm` on the `Music` bus, autoplay on. Next:
> - Mark the loop point in the import dock if the bible calls for looped playback.
> - Generate the tension and combat counterparts with `/music-track` again.
> - To wire state-driven crossfades between calm / tension / combat, run `/adaptive-music`.

## See also

- `audio/audio-direction` — defines style, tempo, key, model
- `audio/adaptive-music` — wiring stems to game state
- `audio/sound-effect` — short stings
- `audio/ambient-bed` — non-melodic location bed
