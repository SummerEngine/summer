---
name: trailer-shot
description: "Generate trailer footage: slow-mo combat, establishing shots, hero beats, splash screens, 5-10 seconds."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: video
user-invocable: true
allowed-tools: Read Grep Glob Write Edit summer_assets_generate_video summer_jobs_wait summer_assets_generate_image summer_assets_search summer_import_from_url summer_add_node summer_set_prop summer_call
paths: ["assets/video/**", "trailers/**", "marketing/**"]
---

# trailer-shot — Loud, Confident, 5-10 Seconds of Punch

A trailer shot is not a cutscene and not a loop. It is a single, deliberately-composed beat designed to live inside an edit — Steam capsule video, social cut, pitch-deck reel, Discord teaser, Twitter promo. Every shot has to earn its slot in 5 seconds or less because viewer attention drops past that. This skill produces those shots one at a time, with strong composition references and trailer-grade prompting, then hands the user off to a non-linear editor (DaVinci Resolve, Premiere, CapCut) to chain them. **Studio doesn't ship a video editor** — generation is the part this skill owns; the cutting is yours.

If the user is generating a non-interactive narrative beat with dialogue, that's `cinematic-cutscene`. If they want a seamless background loop for a splash screen, that's `animated-loop`. This skill is for the punchy stuff — the kind of shot that ends up on the Steam page or in the first 10 seconds of a launch trailer.

## When to use

- "Generate a slow-mo combat shot for the trailer."
- "I need a hero shot of the boss for the Steam capsule."
- "Dramatic establishing shot of the kingdom for the pitch deck."
- "Make a splash-screen video for the title menu."
- "Some B-roll of the swamp environment."
- "Money shot — wide low-angle of the dragon roaring at sunset."

## When NOT to use

- Multi-shot story sequence with dialogue — `cinematic-cutscene`.
- Seamless looping background — `animated-loop`.
- Static marketing key art — `concept-art` then `character-portrait`.
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
assets.generate_image({
  prompt: "<subject>, <archetype-driven framing>, cinematic, dramatic lighting, film still, wide framing",
  model: "nano-banana-2",
  aspectRatio: "16:9"
})
```

Set `aspectRatio` to the platform's framing (`16:9`, `9:16` for vertical social, `1:1` for square). Since image-to-video inherits the reference's framing, a square reference gives you a square trailer shot.

For pure environment / abstract / VFX shots, you can skip this and prompt text-to-video directly — that also unlocks `aspectRatio`, `kling-turbo`, and `veo3`.

### 3. Pick the model

The available models depend on whether you pass `imageUrl`. With a reference image (step 2) the call goes to the image-to-video route; `kling-turbo` and `veo3` exist on the text-to-video route only, and pairing either with an `imageUrl` is a 400 `invalid_model`.

| Model | Text-to-video | Image-to-video | Speed | When |
|---|---|---|---|---|
| `kling` | yes | yes | 2-4 min | Default for trailer hero shots — best motion + composition |
| `ltx` | yes | yes | ~30s | Cheapest. B-roll, throwaway tests, blocking the composition before committing |
| `kling-turbo` | yes | **no** | 1-2 min | Same look as kling, faster, slight quality dip — but you lose `imageUrl` |
| `veo3` | yes | **no** | 3-5 min | Most expensive. Pitch deck for investors, the one shot that has to be perfect — but you lose `imageUrl` |

Default: **`ltx` first to block the composition, then `kling` for the final**. For the *one* hero shot that drives the Steam page, escalate to `veo3` only if `kling` failed twice.

### 4. Generate the shot

```
assets.generate_video({
  prompt: "<archetype framing>, <subject>, <action>, <camera move>, <lighting>, <film grain / lens / stylistic anchor>",
  model: "kling",
  imageUrl: "<optional reference URL from step 2>",
  duration: 5,
  aspectRatio: "16:9"
})
```

On `ltx` and `kling`, `duration` is 5 or 10 — anything else renders 5. `dryRun: true` returns the shot's `estimate` (credits, balance, enough) without rendering.

The call answers at once with `{ status: "running", job: { id } }` and **no URL**. Call `jobs.wait({ jobId: "<job.id>", timeoutSeconds: 50 })` until `finished` is true, before showing the user anything or claiming the shot is done.

`aspectRatio` (`16:9`, `9:16`, `1:1`, ...) is applied on the **text-to-video path only**. The moment you pass `imageUrl` it is ignored and the clip inherits the reference image's framing — so vertical social needs a genuinely 9:16 reference, and square needs a square one: generate the reference with that `aspectRatio`.

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

For shots that double as **in-engine** splash content, import the `.mp4` as it is. Summer Engine plays video only as Ogg Theora (`.ogv`), so the import converts it and saves it at the path with `.ogv`; the answer names it in `videoConversions`:

```
summer_import_from_url(url="<the shot's fileUrl>", path="res://assets/video/trailers/hero_boss_reveal.mp4")
→ res://assets/video/trailers/hero_boss_reveal.ogv
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
> Score it with the music from `music-track`. Add SFX hits on the cuts with `sound-effect`.

## Reference card — prompts that work

Pattern: `<archetype framing> + <subject> + <action verb> + <camera move> + <lighting / time of day> + <stylistic anchor>`. Keep under 50 words. Anchor with a reference image whenever a specific character or asset appears.

| Goal | Model | Prompt | Duration |
|---|---|---|---|
| Hero boss reveal | `kling` | `low-angle hero shot of an armored dragon turning toward camera, slow tilt-up, volcanic backlight, embers in air, cinematic, anamorphic flare, 16mm grain` | 5s |
| Slow-mo combat impact | `kling` | `mid shot of a swordsman striking a parry, sparks fly, time-dilation slow motion, dust and motion blur, dramatic side-light, cinematic` | 5s |
| Establishing kingdom wide | `kling` | `wide aerial of a clifftop fortress at golden hour, slow dolly forward, low sun raking the towers, cinematic, anamorphic, faint heat haze` | 5s |
| Splash screen card | `kling` | `static composition of a lone hooded figure on a windswept ridge, only the cloak and grass moving, dusk, painterly cinematic, room for title text upper third` | 5s |
| Whip pan reveal | `kling` | `whip pan from left to right across a battlefield at night, lands on the protagonist standing alone among bodies, torches flickering, cinematic` | 5s |
| Detail dolly-in | `kling` | `slow dolly-in on a glowing rune-etched sword embedded in stone, motes of magic rising, blue-cold key light, shallow depth of field, cinematic` | 5s |
| Vertical social hero | `kling` | `vertical close-up of a young witch raising hands, magical wind, hair flowing, candle-warm key, cinematic, framed for 9:16` | 5s |
| Pitch-deck premium shot | `veo3` | `wide cinematic of a fleet of airships emerging through cloud cover at dawn, slow truck forward, golden god-rays, soaring orchestral cinematic` | 5s |
| Cheap B-roll iteration | `ltx` | `mid shot of a knight walking through fog, slow truck backward, dawn light, cinematic` | 5s |
| Anime style hero | `kling` | `anime-style hero girl draws a katana in slow motion, sakura petals swirling, dramatic side-light, dynamic camera, Ghibli painterly` | 5s |

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
- **Using `veo3` for B-roll.** Use `ltx` for blocking and B-roll; reserve `veo3` for the one shot that has to be perfect.
- **Generating shots without composing the trailer first.** Make a 6-shot list before generating shot 1. Otherwise you'll generate shots that don't intercut.
- **Assuming `aspectRatio="9:16"` reframed an image-to-video call.** It is ignored whenever `imageUrl` is set — the reference image decides the framing. Pillarboxed 16:9 on TikTok / Reels / Shorts reads as a desktop YouTube embed and gets demoted by the algorithm, so fix the reference, not the argument.
- **Treating `assets.generate_video` as finished.** It answers `{ status: "running", job }` and no URL. Wait with `jobs.wait` before handing the user a link.
- **Forgetting that Studio doesn't cut video.** The user has to take the shots into an NLE. Tell them, don't pretend Studio can stitch.
- **Asking for "the camera does X then Y then Z".** Pick one camera move per shot.

## Edge cases

- **Steam capsule animated header (Steam asset).** Steam wants `.webm` at 616x353 or 1920x1080, ≤6s, 30fps, no audio, ≤4MB. Generate at 16:9, transcode in DaVinci, export `.webm` with VP9. The video model gives you the source; format conversion is on you.
- **Pitch deck for investors.** One shot, `veo3`, money composition (low-angle hero or wide establishing).
- **Vertical for TikTok / Shorts.** The reference image must genuinely be portrait — `aspectRatio` is ignored once `imageUrl` is set. Frame the subject in the upper-middle so titles can sit at the bottom.
- **Subject is a UGC environment the player built.** Take a screenshot of the in-engine view, run it through `assets.generate_image` as `referenceImageUrl` to "upgrade" the look, then use that as the video reference. The model can stylize a screenshot; it can't invent the user's level.
- **Logo splash with motion graphics.** Generate a static logo card with `assets.generate_image` (or use the user's existing logo PNG), then prompt video as `static composition of <logo>, only background particles drifting, cinematic, room for title text` — keep the foreground motionless.

## Without Summer Engine

In a session without Summer Engine tools (the assets profile; the `summer-assets` skill has the whole loop), do steps 1-5 and 7 and skip step 6 (import for archive). Save the file where the person asked with `out` (the `summer-assets` skill says how), and tell them the path and format. The MP4 goes straight into the person's video editor.

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
> - Score the trailer with `music-track` — a 60-second trailer cue with a swell and a cold ending.
> - Add hit SFX on the cuts with `sound-effect` (impact whooshes between shots).
> - For the title-card splash that ships in-engine, hand off to `animated-loop` with the established palette.
> - For a narrative beat inside the trailer (a 10s "story" segment), hand off to `cinematic-cutscene`.

## See also

- `cinematic-cutscene` — narrative beats with dialogue.
- `animated-loop` — seamless background clips for splash screens / title menus.
- `music-track` — trailer score.
- `sound-effect` — cut SFX (whooshes, impacts, stingers).
- `concept-art` — generate the reference image axis when no asset exists yet.
- `summer_docs_read` id `reference/mcp-tools-reference` — how to call `assets.generate_video`; `summer_search` returns its exact input.

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@latest` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `assets.generate_image`, `summer_assets_generate_image` | `summer assets generate-image` |
| `assets.generate_video`, `summer_assets_generate_video` | `summer assets generate-video` |
| `summer_assets_search` | `summer assets search` |
| `summer_docs_read` | `summer docs read` |
| `summer_add_node` | `summer engine add-node` |
| `summer_import_from_url` | `summer engine import-from-url` |
| `summer_set_prop` | `summer engine set-prop` |
| `jobs.wait`, `summer_jobs_wait` | `summer jobs wait` |
| `summer_search` | `summer ops search "<what you want>"` |
<!-- /shell-commands -->
