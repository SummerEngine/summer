---
name: verifying-scenes
description: Use when verifying that scene work actually landed — after any mutation batch, asset import, lighting change, or during a playtest — and before claiming any visual or structural result. Runs the before/after discipline (summer_world_snapshot → mutate → summer_snapshot_diff + summer_screenshot), reads live runtime state with summer_get_runtime_tree / summer_inspect_runtime_node instead of stopping the game, and enforces honest-claim rules.
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
- **Name what you see:** add `marks:true` (cap with `max_marks`) and the caption lists `label -> node path` for the numbered tags drawn over the largest visible 3D nodes. Cite the label AND the path in your claim: "label 3 (`Props/Crate_02`) floats above the floor" — then fix it by that exact path. 2D scenes come back `marks_unsupported`, not annotated.
- **Read the confession.** An engine that predates these framings echoes the preset it fell back to, and the caption says the frame is NOT pose-stable; `marks:true` on such a build draws nothing. Do not compare, and do not read labels, across that warning.

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
| Mutating twice in a row without a diff or screenshot between | You are compounding on an unverified base. Verify, then continue. |
| "The diff is probably fine, the script said ok" | `ok:true` scripts still drop unowned nodes on save. Read the diff. |
| Judging lighting from an iso/top framing | Flat substitute environment. Use `framing:"camera"`, boot the game, or a probe. |
| Stopping the game to inspect a runtime bug | The stop resets the state. Use the runtime reads first. |
| Sleeping a guessed delay after `summer_play` or a long op | Boot and import times vary. Wait for `play.started` / `op.applied` with `summer_wait_for_event`, or confirm with `summer_is_running`. |
| "Looks great!" with no capture in the transcript | Fabrication. Capture, look, then claim. |

**Related skills:** `scene-scripting` carries the mutation loop and ctx API this discipline wraps; `playtesting-a-feature` and `verification-before-completion` carry the broader done-claiming rules.
