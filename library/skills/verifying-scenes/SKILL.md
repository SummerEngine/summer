---
name: verifying-scenes
description: "Prove scene work landed (snapshot, diff, screenshots, runtime reads), audit 3D scenes for holes and misplacement, review them with shot sheets and zooms."
---

# Verifying Scenes

## Two signals, two jobs

- **Structured state** (`summer_world_snapshot`, `summer_snapshot_diff`, `summer_get_scene_tree`, runtime reads) proves **facts**: paths, classes, transforms, world AABBs, counts, what changed.
- **Pixels** (`summer_screenshot`) prove **appearance**: composition, scale-to-the-eye, lighting, "does it read as a forest".

Neither substitutes for the other. A diff can say "40 trees added at plausible positions" while the screenshot shows them all untextured magenta; a screenshot can look right while the diff reveals half the trees are unowned and will vanish on save. Run both.

## The before/after discipline

Around **every** mutation batch (script, scene tools, import):

1. **BEFORE**: `summer_world_snapshot` — keep `snapshot_id`. First time in a session, also screenshot so you know the starting state.
2. Mutate.
3. **AFTER**: `summer_snapshot_diff from_id:<id>` (omit `to_id` — the engine snapshots now). Check the receipt against your INTENT:
   - `added` = exactly what you meant to add — no more, no less.
   - `removed` = empty unless you deleted on purpose. A node you created appearing here (or missing from `added` after a save) is the ownership bug — see `scene-scripting`.
   - `changed` = only nodes you touched. Unexpected entries mean your script had side effects.
4. **AFTER**: `summer_screenshot` — and LOOK at it.
5. Fix before stacking more work on a broken base. An empty diff after a "successful" mutation is a red flag, not a success.

Snapshot ids: the engine retains the last 8 per session; `unknown_snapshot` means the baseline expired — take a fresh one and redo the pair.

## Physical plausibility — check AABBs

`summer_world_snapshot` carries a world AABB per 3D visual. After placing or importing anything:

- Nothing clips that shouldn't (compare AABBs of neighbors).
- Nothing floats above or sinks into its support.
- Sizes are real-world plausible: door ≈ 2 units, person ≈ 1.7, car ≈ 4.5. An AABB of 40 on a "chair" is an import-scale bug — pass `target_size` to `summer_instantiate_scene` and re-check.

## Audit the scene after each build stage

A screenshot only shows what its camera points at. Problems behind a wall, under a prop or across the street slip past it: a door insert narrower than its frame (you see the street through the gap), a bench turned 90 degrees against the wall, a floor tile with holes over an underlay. `summer_scene_audit` walks every node in one read-only call and lists where to look.

1. **After each build stage** (a facade, a street, a dressing pass): save, then `summer_scene_audit scenePath:"res://..."`. It reads the SAVED file in a private offscreen copy, so the open tab never becomes unsaved and nothing is saved. Use `root:"Alley3"` to audit only what you just built (the rest still counts as surroundings) and `checks:[...]` to rerun one check after a fix.
2. **Read the page, not just the counts.** Issues come sorted `error`, `warn`, `look`, each with a node path, a world position, a reason, the evidence numbers (sizes, gaps, angles, the ray that reproduces it) and the next tool. The result is at most 5 KB; follow `next_offset` with `offset` for the next page, or narrow with `min_severity:"warn"`.
   - A check with `partial` in its counts ran out of editor time (`budget_ms`, default 3000) and covered only that share. It is not clean: rerun it alone (`checks:["floor_gap"]`) or with a larger `budget_ms` before you call that check clean.
3. **Frame every error and look item up close before calling the scene done.** `render:"sheet"` returns one image of the page's first 6 issues framed from their open side (tiles labelled `#n`); otherwise `summer_frame_nodes` on the path and `summer_zoom` into it. A look item (`orientation`, a facing or mounting question) is never an answer: decide the facing yourself from the asset (`summer_inspect_asset`) and the pack's metadata.
4. **Classify each item as real or a false positive** in your notes. Fix the real ones with the placement tools, then audit again: the same check must come back clean (or the remaining items must be ones you have looked at and accepted).
5. **Accept the look items you judged fine, once.** Pass `accept:[{key, reason}]` with each item's `key` from the page (a warn can be accepted too, an error never). The audit writes them to `res://.summer/audit-accept.json`; later audits count them (`counts.<check>.accepted`) but hide them. An accepted item comes back, marked `accept_stale`, when its evidence changes materially (its severity rises or its measured size moves by over 25%), so a fix that made it worse is not hidden. `show_accepted:true` lists them again.

What the checks mean:
- `through_hole`: rays pass the wall and reach the far side of the building.
- `floor_gap`: what a down ray hits FIRST.
  - "falls to the void" or "holes in its own mesh": the floor really is open.
  - "covers the floor": an underlay plane sits above the floor's own drain or dip. Lower the underlay; the tile is not holed.
  - "bare strip ... between <tile> and <wall>": the tile row stops short of the wall.
  - Areas are measured (a 4 cm seam is a fraction of a square metre). When the pack documents a ground material (PACK.json or ASSEMBLY.md), `next` names it.
- `floating` / `sunken`: props 2 cm above or 3 cm into their support. Sunken names the surface the prop is buried in, seen from above.
- `interpenetration`: over 3 cm, with every piece it cuts (up to 3). Clear all of them, not only the first.
- Pack metadata: pieces.json is read in both formats, with no adapter file. v1.3 `parts` packs give the insert hosts (`fits_into.host`), the measured fronts (`facing.front_axis`) and the wall mounts: pieces the artists hung on a wall, with `facing.wall_axis` as the mount side (or the side facing the nearest wall when their placements disagree) and the largest `facing.wall_gap_m` as the standoff.
- `insert_host`: a pieces.json `fits_into` insert in the wrong host, or off its offset.
- `mount_gap`: a mounted piece off its wall, measured at its centre and sides.
  - Over 5 cm is reported, or over the pack's documented standoff + 5 cm (pieces.json `standoff_m` or `facing.wall_gap_m`, or ASSEMBLY.md "0.1 m off the wall").
  - A pipe that a wall-touching bracket or clamp holds is not reported (also when its samples hit the bracket's ring first), and neither is the rest of its run.
  - A gap that opens onto a recessed window or door while the piece is on the wall plane is a look item.
- `band_continuity`: facade bands (base / dado / plinth, cornice, crown, trim, band, sill) per facade, height and facing.
  - A missing run over 5 cm, unless a door, gate or shutter (or the kit's corner, end or pier piece) covers 80% of it over half the band height.
  - A short end over 5 cm, when the band covers at least half its own block's facade (a lower neighbour's wall top is not this facade).
  - An outside corner whose square (this band's depth x the return band's depth) is under 70% covered. Two bands that only touch at the corner's edge leave it empty: add the kit's corner piece for that band, or wrap one band past the corner by its depth. Inside corners are never flagged.
  - A band facing into the wall, only when `exposed_edge` sees its open back.
  - An **error** when `exposed_edge` or `depth_step` confirms the spot (the evidence says `confirmed_by`), otherwise a warning. Only spots walkable space sees.
- `exposed_edge`: open outline edges of wall, band and pier pieces that nothing covers within 4-7 mm, seen from walkable space, with the reveal behind them: a 2-60 cm step (an open band end, a module out of line), a seam (the next sheet within 4 cm) or a gap to the next sheet (within 35 cm). A warning on band pieces (and on walls when `depth_step` agrees), a look item on walls. Repeats group per piece type.
- `open_fixture_end`: an open end of a pipe, duct or gutter piece that nothing joins within 2.5 cm, seen from walkable space: a missing elbow, coupler, section or outlet. Terminal pieces (outlets, funnels, vents, caps) are open by design.
- `depth_step` (look): ray rows across each facade at its band levels and every 1.25 m: band recesses, seams, modules standing proud, holes with something behind them. A hole next to a `through_hole` confirms it (that issue becomes an error). Runs a door or shutter covers are skipped.
- `orientation`: front-back symmetric pieces (duct runs, strap braces) are never flagged for pointing away.
- `uv_stretch`: stretched or collapsed texture an instance shows. A face that inserts normally cover is a warning where it shows.
- `duplicate`: the same scene at the same transform.
- `z_fight`: coplanar overlapping faces anywhere, including two surfaces of one mesh.
  - "Coplanar" means closer than twice the 24-bit depth step at the view distance, for the main camera's near and far. `ev` shows the gap, the tolerance and the viewpoint.
  - `ev.normal` is the shared plane's normal and `ev.nudge` the axis to move along, in the world and in the piece's own frame. A window insert can share its head or a jamb with its host, not its front: nudge along `nudge.local`, not along the facade normal.
  - Decals, overlays, `render_priority` and depth offsets come back as look items with the reason. Check that they actually render on top.
- `lights`: more lights on a mesh than the renderer's per-object limit, and hard spot rims.
- `transform`: NaN, mirrored, non-uniform scale, far out of bounds, and pieces left at the origin: only an identity LOCAL transform under an identity parent that touches nothing and is not one of a row of siblings. Several pieces sharing that identity transform are a warning each; one alone is a look item. A module whose corner is the world origin is not flagged.
- `resource`.
- `budget_ms`: the gap detectors run last on the time the other checks leave. On a 900-instance town the default 3000 ms covers `band_continuity` and `open_fixture_end` fully and `exposed_edge` / `depth_step` partly (band pieces and band rows first). Before calling a facade done, rerun `checks:["exposed_edge","depth_step"]` (or with `budget_ms:6000`) when they show `partial`.

## Choosing the right screenshot

| Question | Call |
|---|---|
| How does the open tab look right now? | `target:"viewport"` (default) |
| Is the composition/scale of a scene file right? | `target:"scene"` (+ `scenePath`, preset framing) |
| Is the **lighting / mood / environment** right? | `target:"scene" framing:"camera"` — renders through the scene's OWN camera with its REAL WorldEnvironment. Preset framings substitute a flat environment and CANNOT answer this. |
| Did **this change** move/add/break something — before vs after from the SAME viewpoint? | `target:"scene" framing:"bookmark" bookmark_name:"<name>"` (+ `marks:true` for numbered labels mapped to node paths) — see Stable viewpoints below |
| What does the running game show? | `target:"game"` (`summer_play` first; needs the desktop bridge) |
| Is a **2D scene or UI layout** right? | `target:"scene"` on a 2D scene synthesizes a `Camera2D` and auto-fits the `CanvasItem` bounds (3D presets and `framing:"camera"` do not apply); `nodePath` frames one node, `size` sets the resolution anchors resolve against. A `CanvasLayer` HUD or anything input-driven: `summer_play` + `target:"game"`. |

Read the confession warnings in every capture (no camera, no light, synthetic camera, project mismatch, "engine predates camera framing"). They are part of the result.

### Stable viewpoints (newer engines)

A preset framing re-fits the scene bounds on every capture, so a before/after pair drifts whenever anything moves. For comparisons that line up, fix the pose:

- **Bookmark once, reuse forever.** `summer_camera_bookmark action:"save" name:"hero"` (omit `position`/`look_at` to capture the current editor 3D viewport camera, or pass both as `"Vector3(x, y, z)"` literals). Then every capture is `summer_screenshot target:"scene" framing:"bookmark" bookmark_name:"hero"` — same pose, real WorldEnvironment, project-persisted (`res://.summer/camera_bookmarks.json`), so it survives sessions and machines. `action:"list"` / `"delete"` manage them.
- **One-off pose:** `framing:"free"` with `camera_position` + `camera_look_at` (+ `fov`).
- **Name what you see:** add `marks:true` (cap with `max_marks`) and the caption lists `label -> node path` for the numbered tags drawn over the largest visible 3D nodes. Cite the label AND the path in your claim: "label 3 (`Props/Crate_02`) floats above the floor" — then fix it by that exact path. Every labelled node gets an occlusion test from the rendered camera; a label noted `(hidden behind <path>)` sits over whatever is in front of its node, so never cite it. 2D scenes come back `marks_unsupported`, not annotated.
- **Read the confession.** An engine that predates these framings echoes the preset it fell back to, and the caption says the frame is NOT pose-stable; `marks:true` on such a build draws nothing. Do not compare, and do not read labels, across that warning.

## Environment review: see it like a player and an artist

For "make this place beautiful", one screenshot is not enough evidence. Preview tools; every image comes back inline (one grid per call), rendered from the SAVED scene with its REAL WorldEnvironment and lights, and nothing in the scene changes. Save the scene before each look.

| Need | Call |
|---|---|
| Good views you do not have yet | `summer_frame_shot` with `shot` = `establishing`, `eye_level`, `low_angle`, `detail` or `corridor` (+ `subject`, or `spawn` for eye level). Returns the top 3 with score breakdowns, saves the best as a bookmark, renders the 3 as one sheet. |
| One node group, lit for real | `summer_frame_nodes nodes:[...] direction:"front"` (+ `bookmark_name` to keep the pose, `marks:true` for labels). An explicit `from` is checked: a caption that opens with WARNING means walls block the view or the camera stands behind a one-sided wall and looks THROUGH it; use the nearest valid `from` it offers. |
| All hero views at once | `summer_shot_sheet shots:[{bookmark_name:"..."}, ...]`. |
| What changed since last time | `summer_shot_sheet ... compare_previous:true` (or `summer_screenshot framing:"bookmark" compare_previous:true`): previous / now / difference map per bookmark, with the changed-pixel share and where. |
| Keep or reset the baseline | Plain sheets, debug views and bookmark screenshots never overwrite a bookmark's previous image (they create it when missing). Only `compare_previous:true` (the compared render becomes the next baseline), `update_previous:true`, or re-saving the bookmark's pose with `summer_frame_nodes` / `summer_frame_shot` replaces it. |
| Why a view reads badly | `summer_debug_views bookmark_name:"..."`: beauty, lighting only, unshaded (albedo), normals, overdraw, wireframe. |
| A suspicious spot up close | `summer_zoom` with `region:[x, y, w, h]` (rendered exactly, at the region's own aspect) or `mark:N` (from a `marks:true` render of the same pose; pad 0.15, and a warning when that node is hidden): the exact sub-frustum at full resolution. Read the real zoom and any `widened_because` in the caption. |

### The review loop

1. **Bookmark the hero views** once: `summer_frame_shot` for each shot type that matters (an establishing wide, the player's eye at spawn, a corridor per alley or street, a low-angle hero of the landmark, a detail of the best prop). Read the score breakdown and the rejection counts; a pose a wall blocks never ranks, and neither does a camera behind or inside a one-sided wall (`behind_surface`, `inside_volume`: the renderer does not draw a wall's back, so that image would look through it). The top 3 are three different views (one per side while the score allows); the light term prefers side or front-side key light, the edge term penalises sky or void below the horizon.
2. **After each change** (save first): one `summer_shot_sheet` of all hero bookmarks, `compare_previous:true` when judging a change. Each bookmark keeps exactly ONE previous render in `res://.summer/shots/<bookmark>.jpg`: the compare baseline. A `compare_previous:true` render replaces it after comparing; plain sheets, debug views and screenshots in between leave it alone (pass `update_previous:true` to reset it on purpose).
3. **Take the weakest shot** to `summer_debug_views`: lighting shows dead-dark areas and missing pools, unshaded shows flat texture and value clashes, wireframe shows floating or duplicated pieces.
4. **Zoom into each problem** with `summer_zoom` before fixing it, and again after. Cite the mark or region in the claim.
5. **Find new views** with `summer_frame_shot` whenever the layout changes; bookmark the winners so the sheet stays pose-stable.

### Beauty rubric (judge every sheet against it)

- **Clear focal point**: one subject reads first; the eye has somewhere to go.
- **Value contrast near versus far**: darker, richer foreground; lighter, hazier distance. A flat-grey frame fails.
- **Light direction and pools**: a readable key direction, and pools of light where the player should look (doors, lamps, paths); lighting view shows them.
- **Dressing density at bases and corners**: where walls meet the ground, at corners and doorways, props and grime break the hard line. Empty bases read as unfinished.
- **No empty frame areas**: no void below the horizon, no blank wall or sky filling a third of the frame without purpose (the frame_shot `void` and `clear` terms flag these).
- **A level horizon**: no accidental roll; the horizon off the dead center for wide shots.
- **Foreground framing**: something soft in front (foliage, a fence, a pipe, a doorframe) for depth, never covering the subject.

Disk stays bounded: nothing is written except one previous-image slot per bookmark (created on its first clean render, replaced only as above) and explicit `save_to` copies; JPEG at most 1024 px, at most 20 MB under `res://.summer/shots/` (oldest evicted first); every file there is safe to delete.

## Runtime reads during playtests

The edited scene is not the running game. While the game runs:

- `summer_get_runtime_tree` — what ACTUALLY spawned (enemies, projectiles, autoloads, pooled nodes). Runtime paths often differ from edited-scene paths.
- `summer_inspect_runtime_node path:"/root/..."` — one node's live properties: actual stats, actual position, actual flags.

Inspect live instead of stopping the game — stopping usually resets the bug you are chasing. `game_not_running` means exactly that: `summer_play`, then re-run. For input-driven proof, climb to a RunVerification probe (see the playbook's `rawOpsViaBatch`).

### Waiting for engine moments

When the next step depends on the engine reaching a moment — the game booting after `summer_play`, a long import finishing, a save landing — wait for the event instead of sleeping and re-polling:

1. `summer_recent_events` first: note its `next_seq`. Events are delivered live from a cursor, so one taken BEFORE the trigger is the only way not to miss a moment that arrives immediately.
2. Trigger (`summer_play`, the import, the save).
3. `summer_wait_for_event since:<next_seq> kinds:["play.started"]` — or `["import.completed"]`, `["scene.saved"]`, `["op.applied","op.failed"]` with `match:{requestId}`. During a playtest, wait on `script.error` to catch runtime script errors as they fire.

`timed_out: true` means no matching event arrived — not that the thing did not happen. Verify with `summer_is_running` / diagnostics, and never claim an event you did not receive. Engines without the events channel return `engine_lacks_events`; fall back to the reads above.

## Honest-claim rules

- Claim only what a diff, frame, or diagnostics call **proved**, and cite it: "the diff shows 40 trees added; the camera-framing screenshot shows them lit on the terrain."
- NEVER describe an image you did not receive. A failed capture is a result — report it and climb down (scene → viewport) or ask the user.
- Preset-framing scene renders are static (t=0), synthetic-camera, flat-environment: no claims about animation, particles, lighting, or mood from them.
- Pass structured failures (`failure_reason`, `terminalState`) through verbatim — never soften them into "it didn't work".
- After the result is verified, record the outcome with `summer_library_feedback` (worked / worked with fixes / wrong / outdated / incomplete + a short note). Optional and fire-and-forget; if telemetry is off, move on.

## Red Flags — STOP

| Red flag | Reality |
|---|---|
| "The environment looks good" from one screenshot | Judge a shot sheet of the hero bookmarks against the beauty rubric, then debug-view the weakest. |
| "The scene is done" without a scene audit | Run `summer_scene_audit`, frame every error and look item up close, fix or accept each one, audit again. |
| Rotating a piece because an orientation look item said so | The audit never says which way to face. Measure the asset (`summer_inspect_asset`), read the pack's metadata, then decide. |
| Mutating twice in a row without a diff or screenshot between | You are compounding on an unverified base. Verify, then continue. |
| "The diff is probably fine, the script said ok" | `ok:true` scripts still drop unowned nodes on save. Read the diff. |
| Judging lighting from an iso/top framing | Flat substitute environment. Use `framing:"camera"`, boot the game, or a probe. |
| Stopping the game to inspect a runtime bug | The stop resets the state. Use the runtime reads first. |
| Sleeping a guessed delay after `summer_play` or a long op | Boot and import times vary. Wait for `play.started` / `op.applied` with `summer_wait_for_event`, or confirm with `summer_is_running`. |
| "Looks great!" with no capture in the transcript | Fabrication. Capture, look, then claim. |

**Related skills:** `scene-scripting` carries the mutation loop and ctx API this discipline wraps; `playtesting-a-feature` and `verification-before-completion` carry the broader done-claiming rules.
