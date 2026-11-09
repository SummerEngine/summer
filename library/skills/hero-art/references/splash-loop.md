# Splash loop: a living painting

**Goal:** the hero's splash, alive: hair and cloth sway, magic glows and drifts, the camera never moves, and after 15 s it
returns to the exact painting, so the loop has no visible seam. On the select screen it must cost nothing until it is
seen: the still shows at once and the video takes over without a jump.

Start from an approved still (`splash-art.md`). This step never changes the design; it only adds motion.

## 1. Generate: the splash is the first AND the last frame

`assets.generate_video` with `model: "seedance-2"`, `imageUrl` and `endImageUrl` both the splash, `duration: 15` (the
longest; longer loops repeat less), `resolution: "720p"`, `aspectRatio` matching the splash. Wait with `jobs.wait`.
`summer ops describe assets.generate_video` shows the exact input; `dryRun: true` shows the credit cost first. Run every
hero in parallel; each clip takes a few minutes. A splash that is only on disk needs a URL first: `assets.upload_begin`,
POST the file, `assets.upload_complete`, then `assets.get`.

If the server you reach has no `endImageUrl` field, generate with the start frame only and the same prompt, then make the
loop a ping-pong in step 3. Sway-only motion (step 2) reads naturally played forward then backward.

## 2. Prompt: hover and sway, never cycle

This is the rule that decides whether the loop works. Anything that has to complete a cycle (a clock hand turning, a
vortex spinning, clouds travelling across the sky, a cape blowing one way) cannot finish in 15 s, so it slides back at
the loop point and the seam shows. Everything moves back and forth around where it started:

> A living painting. The exact same image throughout: same character, same pose, same framing, same background. Static
> locked-off camera: no camera movement, no zoom, no pan. <Hero> holds the exact pose and only breathes slowly; <hair,
> cloth> sway gently back and forth. <The magic, flames, particles> pulse, flicker and drift, then return. Objects hover
> and sway in place. No spinning, no rotation, no travel. No new objects, no new characters, no pose change, no text.
> The final frame returns exactly to the starting image for a seamless loop.

Name the hero's actual moving parts (twin tails, a fur collar, a glowing staff head). Generic prompts give generic motion.

## 3. Check the seam before anyone sees it

Numbers first, then eyes:

```bash
n=$(ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames -of csv=p=0 master.mp4)
ffmpeg -v error -i master.mp4 -vf "select=eq(n\,0)+eq(n\,1)+eq(n\,$((n-2)))" -fps_mode passthrough f_%d.png
compare -metric RMSE f_1.png f_2.png null:   # a normal step between two frames
compare -metric RMSE f_3.png f_1.png null:   # the wrap: second-to-last frame -> first frame
```

The wrap should sit inside the range of normal steps (check a few pairs: busy moments step more). A wrap several times
the usual step is a visible pop: regenerate with a stricter prompt, or use the ping-pong below. Then watch the last 2 s into the first 2 s yourself: no jump, no slide,
nothing spinning, no face or hand change. The video model frames slightly tighter than the painting (about 7 % on 16:9): compare frame 1 with the splash and note
the zoom; the still poster must be shown at the same zoom or the hand-off jumps.

No end frame (step 1 fallback): build the ping-pong master, which has a clean seam by construction:

```bash
ffmpeg -i clip.mp4 -filter_complex "[0:v]split[a][b];[b]reverse,trim=start_frame=1,setpts=PTS-STARTPTS[r];[a][r]concat=n=2:v=1[v]" -map "[v]" -an -c:v libx264 -crf 14 master.mp4
```

Show the person the master, looped, with one line of what to look for ("loop point at 0:15: no jump, nothing spins").

## 4. Encode for the engine

Summer Engine plays Ogg Theora (`.ogv`), not MP4. Drop the last frame (it repeats the first and stutters the loop) and
make two copies, a desktop one and a small one for phones:

```bash
ffmpeg -i master.mp4 -frames:v $((n-1)) -an -c:v libtheora -q:v 7 -g 240 hero_loop.ogv
ffmpeg -i master.mp4 -frames:v $((n-1)) -an -vf scale=640:-2 -c:v libtheora -q:v 6 -g 240 hero_loop_mobile.ogv
```

Expect about 3-4 MB (desktop) and under 1 MB (mobile) for 15 s. Many ffmpeg builds ship without `libtheora`
(`ffmpeg -encoders | grep theora` prints nothing). Then pipe the frames into libtheora's reference encoder
(`encoder_example`, built from the libtheora source if the person agrees):

```bash
ffmpeg -v error -i master.mp4 -frames:v $((n-1)) -vf "format=yuv420p" -f yuv4mpegpipe -strict -1 - \
  | encoder_example -v 6 -k 240 -o hero_loop.ogv -
```

Ship each export preset only its own copy.

## 5. Play it in the game

The rules, each learned from lag or a visible jump:

- **The still is the poster.** Show the splash at once (zoomed to the video's framing). The video fades in over it only
  after its first frame has decoded, so nobody sees a black frame or a jump.
- **Load async and late.** Start loading the loop about 0.7 s after a pick (`ResourceLoader.load_threaded_request`), so
  browsing quickly through heroes never opens a decoder.
- **Only the hero on screen plays.** A new pick fades the old loop out and frees its stream (`stop()`, `stream = null`).
  A hidden screen or a paused app stops at once and shows the poster again; showing again resumes.
- **Phones play the mobile copy.** Nothing preloads, ever.

A `VideoStreamPlayer` with `loop = true`, `expand = true`, no audio, sized to cover the screen like the poster (keep
aspect, cover) does the playing. Write it as one small script on the select screen (`summer_run_script` or a `.gd`
file), then verify headless: it starts after the delay, decodes frames, loops past 15 s, frees the stream when hidden,
and the frame rate holds while decoding. Finish with `summer_play`, a quick browse through every hero, and
`summer_get_debugger_errors`.

## Done means

Every hero with an approved splash has a loop whose seam passed the numbers and your eyes, desktop and mobile `.ogv`
files in the project, a player that loads late and frees early, and the person has watched at least one loop on the real
select screen. Record the prompt and the encode settings in `.summer/art-bible.md`.
