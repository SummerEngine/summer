---
name: trailer-shot
description: Use when generating marketing or trailer footage — slow-mo combat, dramatic establishing shots, hero beats, splash screens, pitch-deck B-roll. Optimizes for maximum visual punch in 5-10 seconds. Trigger on "trailer", "marketing footage", "Steam capsule video", "splash screen", "hero shot", "pitch deck clip", "promo clip", "money shot", "B-roll".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: video
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_generate_video summer_check_job summer_generate_image summer_search_assets summer_import_from_url summer_add_node summer_set_prop
paths: ["assets/video/**", "trailers/**", "marketing/**"]
---

# trailer-shot — Loud, Confident, 5-10 Seconds of Punch

A trailer shot is not a cutscene and not a loop. It is a single, deliberately-composed beat designed to live inside an edit — Steam capsule video, social cut, pitch-deck reel, Discord teaser, Twitter promo. Every shot has to earn its slot in 5 seconds or less because viewer attention drops past that. This skill produces those shots one at a time, with strong composition references and trailer-grade prompting, then hands the user off to a non-linear editor (DaVinci Resolve, Premiere, CapCut) to chain them. **Studio doesn't ship a video editor** — generation is the part this skill owns; the cutting is yours.

If the user is generating a non-interactive narrative beat with dialogue, that's `video/cinematic-cutscene`. If they want a seamless background loop for a splash screen, that's `video/animated-loop`. This skill is for the punchy stuff — the kind of shot that ends up on the Steam page or in the first 10 seconds of a launch trailer.

## When to use

- "Generate a slow-mo combat shot for the trailer."
- "I need a hero shot of the boss for the Steam capsule."
- "Dramatic establishing shot of the kingdom for the pitch deck."
- "Make a splash-screen video for the title menu."
- "Some B-roll of the swamp environment."
- "Money shot — wide low-angle of the dragon roaring at sunset."

## When NOT to use

- Multi-shot story sequence with dialogue — `video/cinematic-cutscene`.
- Seamless looping background — `video/animated-loop`.
- Static marketing key art — `2d-assets/concept-art` then `2d-assets/character-portrait`.
- Animated GIF of UI — that's a screen recording, not a generated video.
- A literal Steam trailer (the assembled cut) — generate the shots here, then take them to your NLE.

## Steps

### 1. Pick the shot

Trailer shots fall into a small number of archetypes. Pick one before prompting:

| Archetype | Composition | When |
|---|---|---|
| **Hero close-up** | Tight on the protagonist or boss, low angle | Reveal a character |
| **Slow-mo combat** | Mid shot, time dilation, frozen impact | Action sells |
| **Establishing wide** | Wide landscape, slow dolly-in | Sell a world |
| **Dolly-in on detail** | Push toward a key prop or face | Build tension |
| **Whip pan reveal** | Fast pan, lands on a beat | Reveal a turn |
| **Low-angle hero** | Looking up at the subject, sky framing | Make the subject feel large |
| **Splash card** | Static composition, atmospheric motion only | Title cards, logos |

State the archetype and composition out loud before generating: "I'll do a low-angle hero shot of the boss, slow tilt-up, golden hour. OK?"

### 2. Lock the look with a reference image (when subject identity matters)

For shots featuring a specific character, weapon, or environment, generate a reference still first and pass it as `imageUrl`. Without it, the boss in your trailer looks different from the boss in the game.

```
summer_generate_image(
  prompt="<subject>, <archetype-driven framing>, cinematic, dramatic lighting, film still, wide 16:9 framing",
  model="nano-banana-2"
)
```

`summer_generate_image` has no size or aspect argument — `options.image_size` is dropped without an error and every MCP image comes back at the server's 1:1 default. Ask for the framing in the prompt, or build the reference in the Summer dashboard (which exposes aspect ratio) and pass its URL. Since image-to-video inherits the reference's framing, a square reference gives you a square trailer shot.

For pure environment / abstract / VFX shots, you can skip this and prompt text-to-video directly — that also unlocks `aspectRatio`, `kling-turbo`, and `veo3`.

### 3. Pick the model

The available models depend on whether you pass `imageUrl`. With a reference image (step 2) the call goes to the image-to-video route, which accepts only `ltx`, `kling`, and `minimax`; `kling-turbo` and `veo3` exist on the text-to-video route only, and pairing either with an `imageUrl` is a 400 `invalid_model`.

| Model | Text-to-video | Image-to-video | Cost | Speed | When |
|---|---|---|---|---|---|
| `kling` | yes | yes | $0.50 | 2-4 min | Default for trailer hero shots — best motion + composition |
| `ltx` | yes | yes | $0.10 | ~30s | B-roll, throwaway tests, blocking the composition before committing |
| `minimax` | yes | yes | $0.25 | 2-3 min | Anime / stylized trailer looks |
| `kling-turbo` | yes | **no** | $0.30 | 1-2 min | Same look as kling, faster, slight quality dip — but you lose `imageUrl` |
| `veo3` | yes | **no** | $1.00 | 3-5 min | Pitch deck for investors, the one shot that has to be perfect — but you lose `imageUrl` |

Default: **`ltx` first to block the composition, then `kling` for the final**. For the *one* hero shot that drives the Steam page, escalate to `veo3` only if `kling` failed twice.

### 4. Generate the shot

```
summer_generate_video(
  prompt="<archetype framing>, <subject>, <action>, <camera move>, <lighting>, <film grain / lens / stylistic anchor>",
  model="kling",
  imageUrl="<optional reference URL from step 2>",
  duration=5,
  aspectRatio="16:9"
)
```

`duration` accepts **only 5 or 10** — anything else is coerced to 5.

The call is **asynchronous**: it returns `{ success, queued: true, jobId, model, resolvedModel, estimatedCost, duration }` and **no URL**. Poll `summer_check_job(jobId="<jobId>")` until it reports `completed` before showing the user anything or claiming the shot is done.

`aspectRatio` (`16:9`, `9:16`, `1:1`, ...) is applied on the **text-to-video path only**. The moment you pass `imageUrl` it is ignored and the clip inherits the reference image's framing — so vertical social needs a genuinely 9:16 reference, and square needs a square one. MCP image generation is square-only, so build non-square references in the Summer dashboard (which exposes aspect ratio) or crop them before use.

### 5. Review against trailer logic

Show the user the result and ask the trailer-specific questions:

> Shot delivered. Three checks:
> 1. Does it read in 2 seconds with the sound off? (Trailer viewers are scrubbing.)
> 2. Is the subject in the frame's golden zone or buried in noise?
> 3. Would this shot survive being preceded by a hard cut and followed by a hard cut?
>
> Land or regenerate?

If "regenerate", revise *one* axis (camera move, lighting, or framing) — don't rewrite the whole prompt. Iteration converges.

### 6. Import for archive (optional)

Trailer footage usually lives on the user's local disk and goes straight into the NLE, where the generated `.mp4` is exactly what you want.

For shots that double as **in-engine** splash content, transcode first — Summer Engine has no MP4 or WebM loader, and `.ogv` (Ogg Theora) is the only video container it can open. `summer_import_from_url` runs Godot's import pipeline and rejects the file if it never becomes a loadable resource, so importing the `.mp4` fails outright rather than half-working.

```
ffmpeg -i hero_boss_reveal.mp4 -c:v libtheora -q:v 8 -an hero_boss_reveal.ogv
summer_import_from_url(url="<hosted .ogv url>", path="res://assets/video/trailers/hero_boss_reveal.ogv")
```

For pure trailer use (DaVinci / Premiere), the user can grab the `fileUrl` and download directly.

### 7. Hand off to the NLE

Studio does not ship a video editor. After all the shots land, tell the user:

> All 6 shots are at these URLs. Studio doesn't cut video. Drop these into DaVinci Resolve (free), Premiere, or CapCut. Recommended order based on what we generated:
> 1. Establishing wide (cold open)
> 2. Hero close-up (subject reveal)
> 3-5. Action beats (slow-mo combat, environmental destruction)
> 6. Money shot (low-angle hero, ends on logo card)
>
> Score it with the music from `audio/music-track`. Add SFX hits on the cuts with `audio/sound-effect`.

## Reference card — prompts that work

Pattern: `<archetype framing> + <subject> + <action verb> + <camera move> + <lighting / time of day> + <stylistic anchor>`. Keep under 50 words. Anchor with a reference image whenever a specific character or asset appears.

| Goal | Model | Prompt | Cost | Duration |
|---|---|---|---|---|
| Hero boss reveal | `kling` | `low-angle hero shot of an armored dragon turning toward camera, slow tilt-up, volcanic backlight, embers in air, cinematic, anamorphic flare, 16mm grain` | $0.50 | 5s |
| Slow-mo combat impact | `kling` | `mid shot of a swordsman striking a parry, sparks fly, time-dilation slow motion, dust and motion blur, dramatic side-light, cinematic` | $0.50 | 5s |
| Establishing kingdom wide | `kling` | `wide aerial of a clifftop fortress at golden hour, slow dolly forward, low sun raking the towers, cinematic, anamorphic, faint heat haze` | $0.50 | 5s |
| Splash screen card | `kling` | `static composition of a lone hooded figure on a windswept ridge, only the cloak and grass moving, dusk, painterly cinematic, room for title text upper third` | $0.50 | 5s |
| Whip pan reveal | `kling` | `whip pan from left to right across a battlefield at night, lands on the protagonist standing alone among bodies, torches flickering, cinematic` | $0.50 | 5s |
| Detail dolly-in | `kling` | `slow dolly-in on a glowing rune-etched sword embedded in stone, motes of magic rising, blue-cold key light, shallow depth of field, cinematic` | $0.50 | 5s |
| Vertical social hero | `kling` | `vertical close-up of a young witch raising hands, magical wind, hair flowing, candle-warm key, cinematic, framed for 9:16` | $0.50 | 5s |
| Pitch-deck premium shot | `veo3` | `wide cinematic of a fleet of airships emerging through cloud cover at dawn, slow truck forward, golden god-rays, soaring orchestral cinematic` | $1.00 | 5s |
| Cheap B-roll iteration | `ltx` | `mid shot of a knight walking through fog, slow truck backward, dawn light, cinematic` | $0.10 | 5s |
| Anime style hero | `minimax` | `anime-style hero girl draws a katana in slow motion, sakura petals swirling, dramatic side-light, dynamic camera, Ghibli painterly` | $0.25 | 5s |

### Bad prompts and why

| Bad | Why it fails |
|---|---|
| `epic trailer shot of the boss` | No framing, no action, no camera. Returns a generic montage. |
| `the camera flies through the entire battlefield, sees the king, then the dragon, then the hero` | Three shots in one prompt. The model picks one badly. Generate three shots. |
| `cool cinematic with lots of explosions and combat` | Adjective stew. Pick one beat: "wide shot of a barricade exploding, debris arc into camera, slow-mo, side-lit". |
| `realistic 4k 60fps trending on artstation` | Trash modifiers. The model knows "cinematic" already; the rest is noise. |
| `the dragon roars at the hero and the hero strikes back` | Two characters interacting reliably fails — the model loses identity on the second one. Generate them in separate shots and intercut. |

## Anti-patterns

- **Trying to chain shots inside one video generation.** Each clip is one beat. The cut between shots is the editor's job, not the model's. A 10s prompt with three actions returns mush.
- **Skipping the reference image for the hero shot.** The boss in the Steam capsule must look like the boss in the game. Always lock identity with `imageUrl`.
- **Using `veo3` for B-roll.** Burn $0.10 on `ltx` for blocking and B-roll; reserve `veo3` for the one shot that has to be perfect.
- **Generating shots without composing the trailer first.** Make a 6-shot list before generating shot 1. Otherwise you'll generate shots that don't intercut.
- **Assuming `aspectRatio="9:16"` reframed an image-to-video call.** It is ignored whenever `imageUrl` is set — the reference image decides the framing. Pillarboxed 16:9 on TikTok / Reels / Shorts reads as a desktop YouTube embed and gets demoted by the algorithm, so fix the reference, not the argument.
- **Treating `summer_generate_video` as synchronous.** It returns `{ queued: true, jobId }` and no URL. Poll `summer_check_job` before handing the user a link.
- **Forgetting that Studio doesn't cut video.** The user has to take the shots into an NLE. Tell them, don't pretend Studio can stitch.
- **Asking for "the camera does X then Y then Z".** Pick one camera move per shot.

## Edge cases

- **Steam capsule animated header (Steam asset).** Steam wants `.webm` at 616x353 or 1920x1080, ≤6s, 30fps, no audio, ≤4MB. Generate at 16:9, transcode in DaVinci, export `.webm` with VP9. The video model gives you the source; format conversion is on you.
- **Pitch deck for investors.** One shot, `veo3`, money composition (low-angle hero or wide establishing). Worth the $1.00.
- **Vertical for TikTok / Shorts.** The reference image must genuinely be portrait — `aspectRatio` is ignored once `imageUrl` is set. Frame the subject in the upper-middle so titles can sit at the bottom.
- **Subject is a UGC environment the player built.** Take a screenshot of the in-engine view, run it through `summer_generate_image` as `referenceImageUrl` to "upgrade" the look, then use that as the video reference. The model can stylize a screenshot; it can't invent the user's level.
- **Logo splash with motion graphics.** Generate a static logo card in `summer_generate_image` (or use the user's existing logo PNG), then prompt video as `static composition of <logo>, only background particles drifting, cinematic, room for title text` — keep the foreground motionless.

## Fallback (no MCP)

If the Studio MCP server isn't running, route the user to the Studio web dashboard:

1. Image tab → generate the reference still.
2. Video tab → image-to-video with the reference URL, model `kling`, duration 5s, aspect ratio per platform.
3. Download the `.mp4` directly into the user's editing project (DaVinci / Premiere / CapCut). No transcode needed for an NLE — only in-engine playback requires `.ogv`.

Print the exact prompt + model + duration + aspect ratio so the user can paste it into the dashboard verbatim.

## Handoff

Once the shots are generated:

> Generated 6 shots, ready for the cut. Next:
> - Take them into DaVinci Resolve (free) or Premiere. Studio doesn't cut video.
> - Score the trailer with `audio/music-track` — a 60-second trailer cue with a swell and a cold ending.
> - Add hit SFX on the cuts with `audio/sound-effect` (impact whooshes between shots).
> - For the title-card splash that ships in-engine, hand off to `video/animated-loop` with the established palette.
> - For a narrative beat inside the trailer (a 10s "story" segment), hand off to `video/cinematic-cutscene`.

## See also

- `video/cinematic-cutscene` — narrative beats with dialogue.
- `video/animated-loop` — seamless background clips for splash screens / title menus.
- `audio/music-track` — trailer score.
- `audio/sound-effect` — cut SFX (whooshes, impacts, stingers).
- `2d-assets/concept-art` — generate the reference image axis when no asset exists yet.
- `../../references/mcp-tools-reference/mcp-tools-reference.md` — `summer_generate_video` parameter schema and error codes.
