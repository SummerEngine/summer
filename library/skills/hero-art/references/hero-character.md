# Hero character: from approved art to a hero that plays well

**Goal:** a playable hero whose model matches the approved art, deforms cleanly in every animation, holds its weapon,
reads well at game distance and on phones, and loads without a hitch. Hero characters sell a game; a model that is "fine
in a still" but tears, warps or looks low-poly in motion is not done.

This is the quality path for player heroes, champions and named leads. For a quick NPC or enemy, `character-model` is
enough. Rigging, weight and animation work happens in Blender, so this part is for an agent with a shell and Blender on
the machine (Claude Code, Codex and similar, using the Summer MCP or CLI). The agent inside the Summer Engine editor cannot
run Blender; it can do the import and the in-engine steps.

**The person approves by eye, at each gate.** Show finished results (a sheet or a short motion video) with one line of
what to look for, and wait for their words. Your own check comes first, but their eye is the gate.

## The pipeline and its gates

| # | Step | Gate |
|---|---|---|
| 1 | Concept from references (`splash-art.md` method) | the person names the exact image |
| 2 | Rig-ready T-pose sheet, front + side | face unchanged; fingers spread; hair clear; the person approves |
| 3 | Image-to-3D, high detail | raw-mesh gate: 5 + 5 fingers, no fused or floating parts |
| 4 | Skeleton fit (if reusing clips) | every major joint within about 3 cm |
| 5 | Rig, weights, clips | motion QA on a video, not stills |
| 6 | Secondary motion (hair, cloth, body) | rest pose unchanged; reads at game distance |
| 7 | Export per platform | smooth normals, 4 weights, tri budgets checked in the build |
| 8 | Into the game | async load, plays, ships visible |

## 1-2. Fix everything you can in 2D, at the source

Hands and hair decide whether a model can be rigged, and they are cheap to fix in an image and nearly impossible to fix
in a mesh. From the approved concept, make a model sheet with `assets.generate_image` (reference = the approved image):

- **Strict T-pose**, arms exactly horizontal, legs straight and slightly apart, front view, plain white background, every
  prop removed (weapons are separate models).
- **Open hands, five straight fingers spread with clear gaps**, palms down, thumbs out. Touching fingers fuse into mittens.
- **Hair and tails hang clear of the body**, with white space between them and the shoulders, arms and back. Hair fully
  inside a helmet, never poking out of it.
- **No long skirts, capes, tabards or loose cloth sheets.** They tear or read as a diaper in motion. Use short or
  form-fitting clothing, or make the piece rigid. Never add cloth sheets to a finished body afterwards.
- A matching **left side view** of the same pose, so the image-to-3D model sees the depth of hair and gear.

Edit only the region you are fixing and paste it back onto the approved pixels (the paste-edit in `splash-art.md`); check
the face crop did not change. An approved design is locked: fix only the named defect, compare every edit side by side.

## 3. Generate the mesh, then gate the raw mesh

`assets.generate_3d` with `kind: "image-to-3d"`, `model: "meshy-7.1"`, `imageUrls: [front, side]`, `poseMode: "t-pose"`,
a high `targetPolycount` (about 200k-300k for a hero master; you reduce per platform later, step 7). Keep `rig: false`
here: rig only a mesh that passed the gate.

**Raw-mesh gate, before any rigging.** Count the fingers on each hand (exactly 5, separate, thumb opposed), look for
fused parts (hair grown into the shoulders, fingers joined, a weapon fused to a hand) and floating islands. Any fail:
discard the mesh and generate a fresh one (new seed, or fix the source image). Never repair a raw mesh: six fingers or a
fused tail cost hours of rigging and never come out clean.

## 4. Skeleton fit: the body must fit the bones

If you reuse a skeleton and its animation set (licensed clips, your own library, a shared rig across heroes), overlay
that skeleton on the new mesh, front and side, at the best uniform scale, and measure hips, knees, ankles, shoulders,
elbows, wrists and neck. All within about 3 cm, or it will warp in motion.

- Never move, stretch or refit the bones of a skeleton whose clips you reuse. Its clips were made for those bone
  lengths; changing them collapses chests and crushes hands.
- No fit: try the other skeletons you have. Still none: repaint the concept over that skeleton's exact bind-pose
  silhouette (render it, paint the design over it with the same proportions and joints), then generate again. The body
  is then born on the bones.
- Building a new skeleton for the mesh is fine: place the joints at the mesh's own joints, then retarget clips onto it
  (`retarget`).

## 5. Rig, weights and clips

Two honest routes:

- **Auto-rig** (`assets.rig`, or `assets.generate_3d` with `rig: true`) plus library clips (`assets.generate_motion`).
  Fast, good for a first playable version. Check it with the same motion QA.
- **Blender rig** for the hero bar: your own skeleton at the mesh's joints, or a fitting reused one (step 4); weights
  smoothed over the welded mesh; clips you own or licensed, retargeted. Keep the mesh's own hands; never paste hands from
  another model onto it. Where a clip closes the hand on a weapon, bake a closed grip on the mesh's own fingers and seat
  the weapon on a bone at the palm.

**Motion QA, on a rendered video of every clip** (Blender headless render or the engine), close-ups of hands, shoulders,
hips and neck, plus the real gameplay camera at phone size. Look for: holes or torn edges, limbs that thin out (elbows,
shoulders, knees keep their volume), feet sliding or sinking, the weapon leaving the palm, and the **neck gap test**: the
head turns and the big casts open no gap or stretch at the neck, and the hair shows no gap to the skull from the side (a
hair-coloured inner cap on the head fixes a cropped hair mesh). Stills hide all of these.

## 6. Secondary motion

Two kinds, one parameters file per character so it re-applies after any mesh change:

- **Body (baked into the clips):** helper bones that take a smooth share of only their parent bone's weight, driven by a
  damped spring (chest about 4.5 Hz, damping 0.4, at most 2 cm and 10 degrees; hips about 5.5 Hz, damping 0.5, pitch
  only), scaled per clip type (idle low, run and jump high). Gate: with the spring at zero the mesh moves less than
  0.1 cm from the original in every clip, so nothing else changed.
- **Hair, ears, tassels (runtime):** 2-bone chains from the scalp, run by `SpringBoneSimulator3D` in the engine with head,
  neck and collar colliders. Stiffness too low flips short hair off the head; start around stiffness 2.5, drag 0.5,
  gravity 0.2 and tune at game speed.
- Rigid armour, crowns and plate get nothing. Show the result at gameplay distance: hair reads, body motion is subtle.

## 7. Export per platform

- **Smooth normals** on every generated mesh: area-weighted per welded position, UV-seam copies sharing them. Split
  normals from image-to-3D read as "low poly" at any triangle count.
- **At most 4 bone weights per vertex**, normalised, before export, so the engine plays what Blender showed.
- **Triangle budgets per target**, checked on the file the game actually loads, not the source: keep the 200k-300k master
  as source; desktop about 100k; phones about 30k-40k. Reduce with a shape-preserving decimation that keeps UV seams;
  never ship a visibly low-poly look. No unused vertices in the exported file.
- Never overwrite a working or shipped model. Write a new versioned file and repoint, so the old one stays playable.

## 8. Into Summer Engine

Import the GLB (`summer_import_from_url` or copy it in), instantiate it under the hero scene with `summer_run_script`,
and check the clip names on its `AnimationPlayer` with `summer_inspect_resource`. Wire states with `animation-tree` /
`character-animation-wiring`. Jumps: pick rise or fall from vertical velocity, never play the rise clip past the top of
the arc. Load heavy heroes asynchronously (`ResourceLoader.load_threaded_request`) with the splash or a placeholder
showing, so picking a hero never freezes a frame. Verify with `summer_play`, `summer_screenshot` and
`summer_get_debugger_errors`.

**Ship it visible.** A finished hero hidden behind a flag gets no feedback. Put it in the roster, let the person play
it, fix forward.

## Done means

The person approved the concept, the T-pose sheet and the motion video; the raw-mesh gate and motion QA passed; desktop
and phone files exist within budget; the hero plays in the game with no debugger errors. Record the generator, seeds,
skeleton, clip set and budgets in `.summer/memory/` so the next hero follows the same recipe.
