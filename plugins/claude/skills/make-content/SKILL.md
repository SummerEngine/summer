---
name: make-content
description: "Make a finished, postable video of your game, cut per platform and saved for the team's review."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: video
user-invocable: true
allowed-tools: Read Grep Glob Write Edit Bash summer_docs_read summer_call summer_jobs_wait summer_capture_gameplay summer_assets_generate_video
paths: ["content/**"]
---

# make-content: a finished piece of content for your game

The person wants their game seen, not a content job. Be opinionated: pick the format, get the footage, edit it, cut one version per platform, check it like a harsh critic, and hand back a finished piece they only have to approve. Never hand back a plan, a draft list or questions you can answer yourself.

This is the method Summer learned over six months of making and measuring game content. Follow it; use your own editing skill for the rest.

## Hard rules (break one and it does not ship)

1. **Highest quality always.** Never downscale or re-encode below the master to get past an upload limit; a 4K master goes up in 4K. Use a path that carries the full file.
2. **No AI labels.** Never say or show that anything was made with AI: not in captions, titles, descriptions, on screen or in a voice-over.
3. **No reference audio.** Never post the sound of the clip you followed. Use the game's own audio, a score made for this piece (`makers.game_score`), or a trending sound the person adds inside the app.
4. **No credits to inspirations.** Never write "inspired by", never tag or name the creator or the game a format came from.
5. **Vertical is reframed, never stretched.** Crop or zoom each shot onto its subject. Never squeeze, never letterbox, never a blurred copy behind the video.

Also: real game footage only for gameplay (never generated gameplay or fake UI); never claim a feature that is not live; never name other games in public copy; fresh shots for every piece (never re-cut an old piece with new text); no labels, glows, shadows or overlays the kit did not ask for.

## 1. How to run it

1. **Run it in a background subagent.** The coding session never waits. The main agent says one line ("Cutting a TikTok of the new boss; the review link follows.") and goes back to work.
2. **Asked: make it. Noticed a visible change: offer once, in one line** ("Clip the new boss fight for TikTok?"). Never ask about format, length or caption: decide.
3. **Find the game.** `team.list` gives the `teamId`. `content.list_games` gives the `contentGameId` (`content.create_game` when it has none). Then read, in this order:
   - `content.get_kit`: characters with pictures, colours, fonts, style, voice, do and don't rules, the store slug, and the Learnings section. The kit wins over this skill.
   - `content.list_references`: what performs now and fits this game, best fit first, each with why it works and an idea for this game.
   - `content.search_library`: the team's raw clips, pictures and earlier pieces.
   - `content.list_pieces`: the last pieces, so you do not repeat them.
4. **Work in `content/pieces/<slug>/`** in the project. Add `content/` to `.gitignore` before the first file. Keep `raw/`, `work/` and `final/` apart.
5. **Deliver finished:** one render per platform, a cover, captions per platform, then `content.save_piece` and one line with the `reviewUrl`. That is the whole reply.

Reload this skill any time with `docs.read` (`skill/make-content`).

## 2. Pick the format

Look at the game first, then choose. A format picked before you have seen the footage overfits.

- **Start from the moment:** what changed or what is best in the game right now. A new boss, a rare drop, a clutch win, a funny physics bug, a new skin, a milestone.
- **Then the reference library.** Pick the reference whose `howGamesCanUseIt` fits the moment (`content.get_reference` for its clip). Copy its structure: beat order, timing, hook mechanism, loop, and length within 20%. Never copy its footage, first frame, caption or music. Skip expired references.
- **Choose by the viewer hook** (why a stranger stops scrolling), not by how it is made.
- **Vary:** never the same format twice in a row, and each piece differs from the last 5 on at least 2 of: format, hook type, opening frame, sound, length. A numbered series keeps its format and opener on purpose. Over a week, at least half the pieces are gameplay pieces.

## 3. Formats by viewer hook

Lengths are for vertical short-form unless noted. Each example is a real, measured post; copy its shape, never its words.

**Trend swap with a gameplay payoff.** Hook: viewers know the viral shape; your hero is the surprise. 7-15 s, the length of the source. Swap your hero into the trending clip (`content.make_video` for a library reference, or `makers.bankai_swap` with the source video and a picture of your character); this is the one format that keeps the source picture. Then end on the same hero doing the matching move in real gameplay. Example: a costume walk shot feet first in one 15 s take; the camera tilts up to the faces on the beat drop (54M views). For a game: your heroes walk in, feet only; the tilt-up on the drop shows their best skins; hard cut to the same heroes in the game.

**The reveal (the pull).** Hook: anticipation of a rarity. 6-10 s, or up to 50 s as a ranking. Name the payoff in the hook ("wait for the <rarest thing>."). Colours climb in rarity order, never down then up. In a short piece the top item lands by about 65% and is held, and the end loops into the first frame. Example: every reward of a secret drop ranked worst to best on a ladder of question marks, the top one last, 59 cuts in 49 s, word-by-word captions, a caption asking how rare it should be (649K views).

**Gameplay gag or fail.** Hook: a moment every player has lived, readable with the sound off. 5-15 s, loops. Let the game write the punchline (a death screen, a banner, a stat), on screen and big enough to read. Example: big text builds word by word over a live match ("you know you're a true player when..."), then the player lines up an open goal and misses: 3 shots, 14 s (583K views, 3x the account's usual).

**Clutch or big moment.** Hook: tension, then release. 8-35 s. Open at the tension point, show the result, then a slow-motion replay of the key half second. Example: a header promising a speedrun time, a big timer from 00:00, a face cam below with real stress and relief, everything but the attempts cut (5.7M views).

**Devlog with the dev's voice.** Hook: a person, a stance and visible progress. 20-55 s, voice at 0 s, one idea, proof on screen every 2-6 s, gameplay not menus. Example: a weekly Short opens on live gameplay with "This week I added <one behavior>", then the behavior plays out: 6 cuts in 51 s, 1.8-3.5M views a part. Other openers of this shape: "Day <N> making a <genre> game", "In my game there are no <standard feature>."

**WIP devlog (scuffed is fine).** Hook: real work, happening now. 20-40 s. A screen recording of the real dev session, the agent chat and the game changing, cut tight to the moments something changes. Voice-over of the conversation: the developer's own voice, or a voice-over that reads the key lines of the chat. Real footage only, no generated shots; captions burned in. The cheapest honest format: no capture mode needed, and a rough look is fine because it is real. The chat on screen is the session itself, not an AI label: add no "made with AI" text.

**Comment reply (viewer ideas).** Hook: the community's idea, tested. Number the episodes ("<series name> #3"). Example: each episode tests one viewer suggestion in a single 40 s screen recording with no cuts (2M views on an account with 2K followers). Variant: the dev joins a match of their own game and does what nobody else can (60 s, almost no cuts, live voice, no music, 12M views).

**Lore short.** Hook: a fact they half know. 20-60 s, up to 100 s for a solved mystery. The claim, spoken and on screen, over footage of the exact thing at 0 s; the stakes by 8 s; three new facts with a picture change every 2-3 s; the reveal, said slower; end on an open question. You made the world, so you are the source. Example: a solved mystery about one character, told through the in-game logs as evidence: 96 s, 4.2M views on a 196K channel.

**Hero, class or skin showcase.** Hook: choice and identity. 12-30 s. The best ability first, one hero per 1.5-2 s on the beat, end on a comment prompt ("which one are you maining?"). Example: the same moment recorded twice and stacked, the new weapon skin in first person on top and what the enemy sees on the bottom (419K views, 4x usual).

**Trailer cut with a hook.** Hook: a premise nobody has seen, in 12 words or fewer by 3 s, over the strongest frame. 20-22 s on Reels, 40-90 s as a YouTube upload. Then 2-3 clean gameplay segments on the game's own audio, then the name and one action line ("Play on summer.games/<slug>" from the kit; "coming soon" if it is not playable). Example: one tactile action in first person, then a pull back to a mountain of thousands of the same thing: 13 cuts in 40 s, the logo only in the last shot (1.3M views on a 638-subscriber channel).

**Techniques for any format:** animate a real screenshot into a shot (`makers.cinematic_shot`); before and after, both real, each half named; a build in steps where each step changes the silhouette and the last one changes category (still to playable, solo to multiplayer); a speed build with an honest, named clock; a one-sentence premise card over clean gameplay; a pause-and-screenshot dare on a short loop.

## 4. Footage

Real gameplay wins: on our accounts real footage got 2,500-6,200 views and memes or generated visuals 270-380. Every piece shows at least 2 s of real gameplay; trend swaps end on it.

**Choose the look before you capture.** This is where the first pieces failed. Pick the best map, time of day, camera and skins, and write that choice into the kit's style. Use the best-looking heroes (never the default placeholder), the best lighting (never a bright test level), and a chosen camera (never a blind one). If no scene looks good, build a filming scene from the game's own assets: a real sky, some fog, lower exposure and bloom, a rim light on the hero. Film with the HUD off whenever you will add text. Never cut menu, store or concept art next to gameplay that does not look like it.

**Reject these frames:** debug screens, blown-out bloom, empty white skies, T-poses, foot sliding, placeholder animations, pop-in, stutter, clipping cameras, missing textures, usernames, notifications, a cursor. No edit saves cheap footage; re-capture.

Sources, best first:
1. **The game's capture mode**, if it has one: HUD toggle, cinematic camera (orbit, follow, low hero angle, slow motion), bots for filming, forced results (a guaranteed legendary), every skin unlocked. If you own the code and it has none, add one behind a flag first; it pays back on every piece.
2. **A web build in headless Chrome with the GPU on** (`--ignore-gpu-blocklist`). Record the game canvas, not the page: `canvas.captureStream(60)` into a `MediaRecorder` (H.264 if offered, about 40 Mbps), with the game's audio tapped from its `AudioContext`. Set the viewport to 1080x1920 and to 1920x1080 for separate takes (device scale 2 for a 4K master), so neither orientation is a crop of the other. Drive inputs from a script and record 3-5 takes per beat. Playwright's own `recordVideo` is soft and silent: use it only to plan shots.
3. **A desktop run in movie mode:** start the game offscreen with `--write-movie shots/frame.png --fixed-fps 60` for lossless frames plus a WAV, frame-exact.
4. **The team's raw clips** from `content.search_library`. Upload what you capture too (`content.upload_begin`), with a one-line description of what happens in it.
5. **Stills:** `engine.capture_gameplay` saves real frames (up to 10) for covers, thumbnails and start frames; hide the HUD first if the game can. `engine.screenshot` and `engine.frame_shot` give a composed frame from the editor.
6. **Shots made from real game art:** `makers.cinematic_shot` (a real frame plus a prompt), `assets.generate_video`, `makers.camera_moves`, `makers.character_turnaround`. Start from a real screenshot or the kit's character pictures. Keep the game's style, never photoreal for a stylized game, and keep the hero on model. At most one such shot per piece, and end on real gameplay.

Capture at 30 fps or more (60 for action you will slow down), at the final aspect. To reframe 16:9 into 9:16, capture at 1440p or higher; never upscale more than 1.35x.

## 5. Edit recipes

You edit with your own tools (ffmpeg, scripts, Remotion if the project has it).

- **Frame 1 moves.** No idle start, no logo, no title card, no black. Something happens by 1 s.
- **Cut on the first changed frame.** Drop dead frames. No freeze over 0.5 s in the first 1.5 s, and none over 1 s anywhere except the held payoff.
- **Payoff before 70%** of the runtime, then hold it; short pieces loop, so the last frame leads back into the first. Rankings and timers are the exception: every step pays off and the last one ends the piece.
- **One idea per piece.** If a line or shot does not serve it, cut it. Never explain the joke.
- **Text:** big, pure white, bold sans (the kit's font, else Inter Bold), no shadow, no outline, no box behind it unless the kit says so. One text layer at a time (a fixed header, a premise card or a timer is that layer), 7 words or fewer, two sizes at most (title about 7% of the width on vertical). At least 40 px tall on a 1080-wide frame. Put it on a calm part of the frame, never over the game's HUD, a face or the action, and keep it in one place. Wrap a long line to two big lines; never shrink it.
- **Vertical:** per shot, `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:X:Y` with X and Y on the subject (use 2160x3840 when the source carries it). Move the crop at most once per shot, slowly.
- **Sound:** audio at 0 s and to the last frame; no dead air. The game's audio carries gameplay. Under a voice, music sits 18-22 LU lower or not at all. Build the audio track once for the whole cut, not per segment (per-segment audio drifts out of sync). Loudness -14 LUFS integrated, true peak -1 dBTP or lower.
- **Generated motion in a drawn style:** step it to 12 frames a second; smooth motion reads as fake.
- **Encode:** H.264 High, yuv420p, CRF 17, preset slow, 30 fps (keep 60 if the source has it), AAC 192k, `+faststart`. At least 4000 kbps at 1080p and about 16000 at 4K.

## 6. Per platform

Make a separate render when length, safe zones or aspect differ. One file copied to every platform is not a per-platform cut.

| Platform | Frame | Length | Notes |
|---|---|---|---|
| TikTok | 1080x1920 (a full-frame 16:9 trailer also works) | 5-15 s for gags and trends, 15-35 s otherwise | No end card: the action line goes over the last action. Link in bio and in the first comment. |
| Instagram Reels | 1080x1920 | 20-22 s, or the trend's length | The grid crops the cover to the centre 3:4 (y 240-1680): keep the cover text there. |
| YouTube Shorts | 1080x1920 or square | 5-15 s loops, 30-58 s otherwise | Anything wider than square counts as long-form and gets no Shorts reach. Title up to 100 characters, hook in the first 40. No end card. |
| X | 1920x1080 or 1080x1080 | 30-90 s best, 140 s at most | Vertical does badly. Burn in the captions (muted autoplay). Link in a reply, not the post. |
| YouTube long | 1920x1080 or 3840x2160 | 4-15 min | Devlogs and trailers. Title as a search phrase. Thumbnail 1280x720 or larger, 3 words at most. Chapters from 00:00. No music under a voice; ship an SRT. |

**Safe zones on vertical:** keep text and key action out of the top 14%, the bottom 25%, 7% at each side, and the right 13% between 30% and 80% of the height.

## 7. Hooks, captions, sound

**Hook shapes that work:** the maker's story with a number ("<N> people. <N> years."); one mystery; one detail, magnified (a second-person premise: "You start as <something tiny>"); a personal, lowercase discovery; naming the payoff. **Weak:** "X but Y" comparisons, "from the studio behind", a logo or title first, a slow establishing shot. On-screen hook: 7 words or fewer, readable in 1.5 s. Spoken hook: 12 words or fewer, finished by 3 s. Rotate openers outside a series.

**Captions:** one dry line, one question that invites an answer, and the words people search for. The game name in plain text. Use 3-5 hashtags on video platforms, the game's tag first, then 1-2 niche tags and at most one trend tag. No em dashes, no emojis, no numbers you cannot source. Avoid kill, blood, murder and death in captions, titles and tags: reach drops.

**First comment:** the play link from the kit. Check it opens on a phone first. If the game is not playable yet, say "coming soon", never "play now".

**Sound:** the game's own audio or a score made for the piece. For a trending sound, cut on its beat using its audio for timing only, strip it, export with game sound, and write the sound and its start time in `suggestedSound` ("<sound name>, start 0:34"); the person adds it in the app.

## 8. Taste bar and self-check

**Why the first pieces failed.** Summer's first five game clips passed a measured critic at 7-8 of 10, and the game's maker called them very bad. The footage looked cheap: a bright test map, the default placeholder hero, bloom blobs, menu art that did not match the gameplay, a debug-opened screen. Captions fought the HUD. Measured checks catch mistakes; they do not catch a cheap look. So taste comes first.

**The taste test.** Put your frame 1 and your best frame next to the game's best art (the kit's character pictures and references, the store art) and next to the reference clip, at phone size. If yours looks cheaper, emptier or smaller, re-capture before you polish. Would a stranger stop on frame 1 with the sound off? Would the team post this on their own account today? If not, it is not done.

**Measured checks (script them; all must pass):**
- A contact sheet every 0.5 s of every render, that you actually look at.
- Motion in frame 1: no freeze over 0.5 s in the first 1.5 s (`freezedetect`), none over 1 s anywhere except the held payoff.
- The payoff lands before 70% (rankings and timers excepted).
- Text at least 40 px on a 1080-wide frame, inside the safe zones, clear of the HUD and faces.
- Loudness -14 LUFS (plus or minus 1), true peak -1 dBTP or lower, no silence over 0.5 s (`silencedetect` at -50 dB), audio as long as the video.
- At least 2 s of real gameplay. Short side at least 1080 px. No stretched shot.
- Copy: no AI words, no other game named, nothing that is not live, the link works.
- Different from the last 5 pieces on at least 2 of format, hook, opening frame, sound, length.

**Fresh critic.** Spawn a new subagent with none of your context. Give it the renders, the captions, the reference clip and the game's best art. It answers first: does any frame look cheaper than that art (test map, placeholder hero, bloom blobs, empty sky, mismatched menu art, text on the HUD, a debug screen)? Any yes is a rebuild, whatever the score. Then it watches the first 1.5 s muted and the whole piece, and gives the one idea, whether it stops the scroll, what reads wrong, and a score from 1 to 10 with timestamps. Rebuild below 8, at most twice, and keep the better render. If it still scores under 8, save it with status `draft` and say in `notes` and in your reply line what blocks it. The final score goes in `selfScore`.

## 9. Upload and save

1. For each render and cover: `content.upload_begin` (`fileName`, `contentType`, `size` in bytes) gives an `uploadUrl`; PUT the file there with that content type; then `content.upload_complete` (`uploadId`, `title`, `description` of what happens in it, `tags`, `folder`) gives the item id.
2. `content.save_piece` with `contentGameId`, `title`, `format`, and `variants` (1-5, one per platform: `platform` of `tiktok`, `instagram`, `youtube`, `youtube_long` or `x`; `itemId`; `coverItemId`; `caption`; `title` for YouTube; `hashtags`; `firstComment`; `suggestedSound`). Add `sourceItemIds`, `referenceId`, `gameplaySeconds`, `selfScore`, and `notes` (what it is, why it should perform, any caveat). It lands on the team's Review tab.
3. Reply with one line and the `reviewUrl`.
4. Feedback arrives on the piece (`content.get_piece`). Revise with `content.update_piece` (pass `expectedRevision`; status `in_review` sends it back). When the team says it is posted, `content.mark_posted`.

## 10. Learnings

After every review, write what the person said into the kit: `content.update_kit`, a section titled "Learnings" (send the whole sections list back with `expectedRevision`). One line each, with the evidence: the piece and the person's words, or the numbers. A data rule stays a hypothesis until 3 pieces beat the account's median by 1.5x; the person's word is a rule at once and beats data. Read the Learnings section first on the next run.

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@4.3.0` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `assets.generate_video`, `summer_assets_generate_video` | `summer assets generate-video` |
| `content.get_kit` | `summer content get-kit` |
| `content.list_games` | `summer content list-games` |
| `content.list_references` | `summer content list-references` |
| `content.make_video` | `summer content make-video` |
| `content.mark_posted` | `summer content mark-posted` |
| `content.update_kit` | `summer content update-kit` |
| `docs.read`, `summer_docs_read` | `summer docs read` |
| `engine.capture_gameplay`, `summer_capture_gameplay` | `summer engine capture-gameplay` |
| `engine.frame_shot` | `summer engine frame-shot` |
| `engine.screenshot` | `summer engine screenshot` |
| `summer_jobs_wait` | `summer jobs wait` |
| `makers.bankai_swap` | `summer makers bankai-swap` |
| `makers.camera_moves` | `summer makers camera-moves` |
| `makers.character_turnaround` | `summer makers character-turnaround` |
| `makers.cinematic_shot` | `summer makers cinematic-shot` |
| `makers.game_score` | `summer makers game-score` |
| `team.list` | `summer team list` |
<!-- /shell-commands -->
