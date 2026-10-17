---
name: make-content
description: "Make a finished, postable video of your game, cut per platform and saved for review."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: video
user-invocable: true
allowed-tools: Read Grep Glob Write Edit Bash summer_docs_read summer_call summer_jobs_wait summer_capture_gameplay summer_assets_generate_video
paths: ["content/**"]
---

# make-content: a finished piece of content for your game

The person wants their game seen, not a content job. Decide everything and hand back a finished piece they only have to approve. Never hand back a plan, a draft list or questions you can answer yourself.

## The method: copy one real video, beat for beat

You do not freestyle. Real creators already found what works: copy their format one to one, beat for beat, with this game in it. Every piece starts from ONE reference video: a post from `content.list_references` (its clip from `content.get_reference`), or a real creator's video the person sends you.

1. **Study the reference first**, before you capture anything:
   - a frame-exact cut list: `ffmpeg -i ref.mp4 -vf "select='gt(scene,0.3)',showinfo" -f null -` (each `pts_time` is a cut; check by eye, lower the threshold for soft cuts);
   - a transcript of any voice, with times;
   - the text of every beat: its wording pattern ("POV: you...", "Day 12 making..."), where it sits, its size, when it comes and goes;
   - the sound (where the beat drops, where the voice sits) and the total length.
2. **Write a beat map** in `work/beats.md`: one row per reference beat with start, end, what happens, the text, the voice line, and which of our shots fills it. Every beat gets a shot; no beat is added or dropped.
3. **Cut to the same timings** (each cut within 2 frames), the same text pattern in our words, the same voice structure (as many lines, the same rhythm, the same places) and the same length.
4. **Check side by side before saving:** the reference and your cut next to each other (ffmpeg `hstack`), cut by cut. A beat that is off, missing or extra is a rebuild.

Never invent a structure. If no reference fits, pick another moment, not your own structure. Copy the shape, never the material: no reference footage (a trend swap's swapped clip is the one exception), audio or caption text in the piece.

## Hard rules (break one and it does not ship)

1. **Highest quality always.** Never downscale or re-encode below the master to get past an upload limit; a 4K master goes up in 4K. Use a path that carries the full file.
2. **No AI labels.** Never say or show that anything was made with AI: not in captions, titles, descriptions, on screen or in a voice-over.
3. **No reference audio.** Never post the sound of the clip you followed. Use the game's own audio, a score made for this piece (`makers.game_score`), or a trending sound the person adds inside the app.
4. **No credits to inspirations.** Never write "inspired by", never tag or name the creator or the game a format came from.
5. **Vertical is reframed, never stretched.** Crop or zoom each shot onto its subject. Never squeeze, never letterbox, never a blurred copy behind the video.
6. **No static end card on TikTok, Reels or Shorts.** The last beat is action; the play line goes over it.

Also: real game footage only for gameplay (never generated gameplay or fake UI); never claim a feature that is not live; never name other games in public copy; fresh shots for every piece (never re-cut an old piece with new text); no labels, glows, shadows or overlays the kit did not ask for.

## 1. How to run it

1. **Run it in a background subagent.** The coding session never waits. The main agent says one line ("Cutting a TikTok of the new boss; the review link follows.") and goes back to work.
2. **Asked: make it. Noticed a visible change: offer once, in one line** ("Clip the new boss fight for TikTok?"). Never ask about format, length or caption: decide.
3. **Find the game.** `team.list` gives the `teamId`. `content.list_games` gives the `contentGameId` (`content.create_game` when it has none). Then read, in this order:
   - `content.get_kit`: characters with pictures, colours, fonts, style, voice, do and don't rules, the store slug, and the Learnings section. The kit wins over this skill.
   - `content.list_references`: what performs now and fits this game, best fit first, each with why it works and an idea for this game. Your reference comes from here.
   - `content.search_library`: the team's raw clips, pictures and earlier pieces.
   - `content.list_pieces`: the last pieces, so you do not repeat them.
4. **Feedback first, without being asked.** At session start and after every `content.save_piece`, call `content.list_pieces` with the game and status `changes_requested`. A piece with `needsWork: true` comes before anything new: `whatToChange` says what the team wants. Fix it on the same reference and beat map, then `content.update_piece` with status `in_review` and `expectedRevision`. Nobody should have to tell you twice.
5. **Work in `content/pieces/<slug>/`** in the project. Add `content/` to `.gitignore` before the first file. Keep `raw/`, `work/` and `final/` apart.
6. **Deliver finished:** one render per platform, a cover, captions per platform, then `content.save_piece` and one line with the `reviewUrl`. That is the whole reply.
7. **Keep watching.** While the session lives, read each piece you saved with `content.get_piece` every few minutes. When `needsWork` turns true, act on it at once and say in one line what you changed.

Reload this skill any time with `docs.read` (`skill/make-content`).

## 2. Pick the moment, then the reference

- **Start from the moment:** what changed or what is best in the game right now. A new boss, a rare drop, a clutch win, a funny physics bug, a new skin, a milestone.
- **Then ONE reference** whose `howGamesCanUseIt` fits that moment. Skip expired ones. Choose by the viewer hook (why a stranger stops scrolling), not by how it is made.
- **Vary:** never the same reference format twice in a row; each piece differs from the last 5 on at least 2 of format, hook, opening frame, sound, length. A numbered series keeps its format on purpose. Over a week, at least half the pieces are gameplay pieces.

## 3. Reference shapes by viewer hook

What each kind of reference looks like, to choose which one to copy. The reference's own beats win over these notes. Lengths are vertical short-form unless noted; each example is a real, measured post.

**Trend swap with a gameplay payoff.** Hook: the viral shape, your hero as the surprise. 7-15 s, the source's length. Swap your hero into the trending clip (`content.make_video` for a library reference, or `makers.bankai_swap` with the source video and a picture of your character): the one shape that keeps the source picture. End on the same hero doing the matching move in real gameplay. Example: a costume walk shot feet first in one 15 s take, the camera tilting up to the faces on the drop (54M views).

**The reveal (the pull).** Hook: a rarity is coming. 6-10 s, or up to 50 s as a ranking. Name the payoff in the hook ("wait for the <rarest thing>."); rarity only climbs. Example: every reward of a secret drop ranked worst to best on a ladder of question marks, 59 cuts in 49 s, word-by-word captions (649K views).

**Gameplay gag or fail.** Hook: a moment every player has lived, readable muted. 5-15 s, loops; the game writes the punchline (a death screen, a banner, a stat). Example: text builds word by word over a match ("you know you're a true player when..."), then an open goal missed: 3 shots, 14 s (583K views, 3x usual).

**Clutch or big moment.** Hook: tension, then release. 8-35 s: the tension point, the result, a slow-motion replay of the key half second. Example: a speedrun time promised in the header, a big timer, a face cam with real stress, only the attempts kept (5.7M views).

**Devlog with the dev's voice.** Hook: a person, a stance, visible progress. 20-55 s, voice at 0 s, proof on screen every 2-6 s, gameplay not menus. Example: a weekly Short opens on gameplay with "This week I added <one behavior>", then it plays out: 6 cuts in 51 s, 1.8-3.5M views a part. Also "Day <N> making a <genre> game".

**WIP devlog (scuffed is fine).** Hook: real work, happening now. 20-40 s. Copy a real devlog's beats (a "this week I added..." Short is a good one) with a screen recording of the real dev session: the agent chat and the game changing, each reference beat filled by a moment something changes. Voice-over in the reference's line structure: the developer's own voice, or one that reads the key lines of the chat. Real footage only, captions burned in, no capture mode needed; rough is fine because it is real. The chat on screen is the session, not an AI label: add no "made with AI" text.

**Comment reply (viewer ideas).** Hook: the community's idea, tested, as a numbered series. Example: one viewer suggestion per episode in a single 40 s screen recording, no cuts (2M views on a 2K-follower account).

**Lore short.** Hook: a fact they half know. 20-60 s (100 s for a solved mystery): the claim over the exact thing at 0 s, the stakes by 8 s, a picture change every 2-3 s, the reveal said slower, an open question at the end. Example: a mystery solved through in-game logs, 96 s, 4.2M views on a 196K channel.

**Hero, class or skin showcase.** Hook: choice and identity. 12-30 s, the best ability first, one hero per 1.5-2 s on the beat, a comment prompt at the end. Example: one moment recorded twice and stacked, the new skin in first person on top, the enemy's view below (419K views, 4x usual).

**Trailer cut with a hook.** Hook: a premise nobody has seen, 12 words or fewer by 3 s. 20-22 s on Reels, 40-90 s on YouTube: 2-3 clean gameplay segments on the game's audio, then the name and "Play on summer.games/<slug>" from the kit ("coming soon" if not playable). Example: one tactile action in first person, then a pull back to thousands of the same thing, 13 cuts in 40 s (1.3M views on a 638-subscriber channel).

**Shots that fill a beat:** a real screenshot animated (`makers.cinematic_shot`); before and after, both real; a build in steps, each changing the silhouette; a speed build with an honest clock; a premise card over clean gameplay.

## 4. Footage

Real gameplay wins: on our accounts real footage got 2,500-6,200 views and memes or generated visuals 270-380. Every piece shows at least 2 s of real gameplay; trend swaps end on it.

**Capture to the beat map:** each beat needs its shot, at the beat's length plus a little to trim.

**Choose the look before you capture.** This is where the first pieces failed. Pick the best map, time of day, camera and skins (never the placeholder hero or a bright test level), and write that choice into the kit's style. If no scene looks good, build a filming scene from the game's own assets: a real sky, some fog, lower exposure and bloom, a rim light on the hero. Film with the HUD off whenever you will add text. Never cut menu, store or concept art next to gameplay that does not look like it.

**Reject these frames:** debug screens, blown-out bloom, empty white skies, T-poses, foot sliding, placeholder animations, pop-in, stutter, clipping cameras, missing textures, usernames, notifications, a cursor. No edit saves cheap footage; re-capture.

Sources, best first:
1. **The game's capture mode**, if it has one: HUD toggle, cinematic camera (orbit, follow, low hero angle, slow motion), bots for filming, forced results (a guaranteed legendary), every skin unlocked. If you own the code and it has none, add one behind a flag first; it pays back on every piece.
2. **A web build in headless Chrome with the GPU on** (`--ignore-gpu-blocklist`). Record the game canvas, not the page: `canvas.captureStream(60)` into a `MediaRecorder` (H.264 if offered, about 40 Mbps), with the game's audio tapped from its `AudioContext`. Set the viewport to 1080x1920 and to 1920x1080 for separate takes (device scale 2 for a 4K master), so neither orientation is a crop of the other. Drive inputs from a script and record 3-5 takes per beat. Playwright's own `recordVideo` is soft and silent: use it only to plan shots.
3. **A desktop run in movie mode:** start the game offscreen with `--write-movie shots/frame.png --fixed-fps 60` for lossless frames plus a WAV, frame-exact.
4. **The team's raw clips** from `content.search_library`. Upload what you capture too (`content.upload_begin`), with a one-line description of what happens in it.
5. **Stills:** `engine.capture_gameplay` saves real frames (up to 10) for covers, thumbnails and start frames; hide the HUD first if the game can. `engine.screenshot` and `engine.frame_shot` give a composed frame from the editor.
6. **Shots made from real game art:** `makers.cinematic_shot` (a real frame plus a prompt), `assets.generate_video`, `makers.camera_moves`, `makers.character_turnaround`, from a real screenshot or the kit's pictures, in the game's style, hero on model. At most one per piece, and end on real gameplay.

Capture at 30 fps or more (60 for action you will slow down), at the final aspect. To reframe 16:9 into 9:16, capture at 1440p or higher; never upscale more than 1.35x.

## 5. Edit recipes

You edit with your own tools (ffmpeg, scripts, Remotion if the project has it). The reference's timings, text and voice win; these are the defaults inside each beat.

- **Frame 1 moves.** No idle start, no logo, no title card, no black. Something happens by 1 s.
- **Cut on the first changed frame.** Drop dead frames. No freeze over 0.5 s in the first 1.5 s, and none over 1 s anywhere except the held payoff.
- **Payoff where the reference has it** (usually before 70%), then hold it; short pieces loop, so the last frame leads back into the first.
- **One idea per piece.** Never explain the joke.
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
| Instagram Reels | 1080x1920 | 20-22 s, or the trend's length | No end card. The grid crops the cover to the centre 3:4 (y 240-1680): keep the cover text there. |
| YouTube Shorts | 1080x1920 or square | 5-15 s loops, 30-58 s otherwise | Anything wider than square counts as long-form and gets no Shorts reach. Title up to 100 characters, hook in the first 40. No end card. |
| X | 1920x1080 or 1080x1080 | 30-90 s best, 140 s at most | Vertical does badly. Burn in the captions (muted autoplay). Link in a reply, not the post. |
| YouTube long | 1920x1080 or 3840x2160 | 4-15 min | Devlogs and trailers. Title as a search phrase. Thumbnail 1280x720 or larger, 3 words at most. Chapters from 00:00. No music under a voice; ship an SRT. |

**Safe zones on vertical:** keep text and key action out of the top 14%, the bottom 25%, 7% at each side, and the right 13% between 30% and 80% of the height.

## 7. Hooks, captions, sound

**Hooks:** use the reference's hook pattern in our words. Shapes that work: the maker's story with a number ("<N> people. <N> years."); one mystery; one detail, magnified (a second-person premise: "You start as <something tiny>"); a personal, lowercase discovery; naming the payoff. **Weak:** "X but Y" comparisons, "from the studio behind", a logo or title first, a slow establishing shot. On-screen hook: 7 words or fewer, readable in 1.5 s. Spoken hook: 12 words or fewer, finished by 3 s. Rotate openers outside a series.

**Captions:** one dry line, one question that invites an answer, and the words people search for. The game name in plain text. Use 3-5 hashtags on video platforms, the game's tag first, then 1-2 niche tags and at most one trend tag. No em dashes, no emojis, no numbers you cannot source. Avoid kill, blood, murder and death in captions, titles and tags: reach drops.

**First comment:** the play link from the kit. Check it opens on a phone first. If the game is not playable yet, say "coming soon", never "play now".

**Sound:** the game's own audio or a score made for the piece. For a trending sound, cut on its beat using its audio for timing only, strip it, export with game sound, and write the sound and its start time in `suggestedSound` ("<sound name>, start 0:34"); the person adds it in the app.

## 8. Taste bar and self-check

**Why the first pieces failed.** Summer's first game clips passed a measured critic at 7-8 of 10, and the game's maker called them very bad: a bright test map, the placeholder hero, bloom blobs, mismatched menu art, captions on the HUD. Checks catch mistakes, not a cheap look. Taste comes first.

**The taste test.** Put your frame 1 and your best frame next to the game's best art (the kit's character pictures and references, the store art) and next to the reference clip, at phone size. If yours looks cheaper, emptier or smaller, re-capture before you polish. Would a stranger stop on frame 1 with the sound off? Would the team post this on their own account today? If not, it is not done.

**Measured checks (script them; all must pass):**
- Side by side with the reference: every cut within 2 frames, the same text pattern and voice structure, the same length.
- A contact sheet every 0.5 s of every render, that you actually look at.
- Motion in frame 1: no freeze over 0.5 s in the first 1.5 s (`freezedetect`), none over 1 s anywhere except the held payoff.
- Text at least 40 px on a 1080-wide frame, inside the safe zones, clear of the HUD and faces.
- Loudness -14 LUFS (plus or minus 1), true peak -1 dBTP or lower, no silence over 0.5 s (`silencedetect` at -50 dB), audio as long as the video.
- At least 2 s of real gameplay. Short side at least 1080 px. No stretched shot.
- Copy: no AI words, no other game named, nothing that is not live, the link works.
- Different from the last 5 pieces on at least 2 of format, hook, opening frame, sound, length.

**Fresh critic.** Spawn a new subagent with none of your context. Give it the renders, the captions, the reference clip, your beat map and the game's best art. It answers first: does any frame look cheaper than that art (test map, placeholder hero, bloom blobs, empty sky, mismatched menu art, text on the HUD, a debug screen)? Any yes is a rebuild, whatever the score. Then it plays the reference and the piece side by side, beat by beat, watches the first 1.5 s muted, and gives the one idea, whether it stops the scroll, what reads wrong, and a score from 1 to 10 with timestamps. Rebuild below 8, at most twice, and keep the better render. If it still scores under 8, save it with status `draft` and say in `notes` and in your reply line what blocks it. The final score goes in `selfScore`.

## 9. Upload and save

1. For each render and cover: `content.upload_begin` (`fileName`, `contentType`, `size` in bytes) gives an `uploadUrl`; PUT the file there with that content type; then `content.upload_complete` (`uploadId`, `title`, `description` of what happens in it, `tags`, `folder`) gives the item id.
2. `content.save_piece` with `contentGameId`, `title`, `format`, and `variants` (1-5, one per platform: `platform` of `tiktok`, `instagram`, `youtube`, `youtube_long` or `x`; `itemId`; `coverItemId`; `caption`; `title` for YouTube; `hashtags`; `firstComment`; `suggestedSound`). Add `referenceId` (always: the reference you copied), `sourceItemIds`, `gameplaySeconds`, `selfScore`, `notes`, and what Today shows under the player: `why` (`referenceId`, `fitReason`: one line on why it fits today, like the commit you saw, `refStats` with `views`, `likes`, `breakoutRatio`, `postedAt`), `checks` (`hook_seconds`, `min_shot_motion`, `safe_zone`, `loudness_lufs`, `true_peak_db`, `length_seconds`, `gameplay_seconds`, each with the measured `value` and `pass`; never a predicted score), `sideBySideItemId` (a library video: the reference left, yours right, synced), `contactSheetItemId`, `learningIds` (the kit learnings you applied) and `tomorrow` (what you make next). `summer content make` does all of this and reports each stage to its make request (`content.make`, `content.claim_make`, `content.update_make`; `jobs.wait` on `make:<requestId>`). It lands on the team's Today view.
3. Reply with one line and the `reviewUrl`.
4. Keep watching it (section 1, step 7). Feedback arrives on the piece: `needsWork` and `whatToChange`. Revise with `content.update_piece` (pass `expectedRevision`; status `in_review` sends it back). When the team says it is posted, `content.mark_posted`.

## 10. Learnings

Every Change note and Skip reason becomes a learning in the kit by itself (`content.get_kit` `learnings`, with the piece it came from). Read them first on every run, follow each one, and list the ones you applied in `learningIds`. The team removes one with `content.delete_learning`. A data rule you find yourself stays a hypothesis until 3 pieces beat the account's median by 1.5x.

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@latest` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `assets.generate_video`, `summer_assets_generate_video` | `summer assets generate-video` |
| `content.get_kit` | `summer content get-kit` |
| `content.list_games` | `summer content list-games` |
| `content.list_references` | `summer content list-references` |
| `content.make` | `summer content make` |
| `content.make_video` | `summer content make-video` |
| `content.mark_posted` | `summer content mark-posted` |
| `docs.read`, `summer_docs_read` | `summer docs read` |
| `engine.capture_gameplay`, `summer_capture_gameplay` | `summer engine capture-gameplay` |
| `engine.frame_shot` | `summer engine frame-shot` |
| `engine.screenshot` | `summer engine screenshot` |
| `jobs.wait`, `summer_jobs_wait` | `summer jobs wait` |
| `makers.bankai_swap` | `summer makers bankai-swap` |
| `makers.camera_moves` | `summer makers camera-moves` |
| `makers.character_turnaround` | `summer makers character-turnaround` |
| `makers.cinematic_shot` | `summer makers cinematic-shot` |
| `makers.game_score` | `summer makers game-score` |
| `team.list` | `summer team list` |
<!-- /shell-commands -->
