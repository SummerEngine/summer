---
name: text-to-motion
description: "Make custom 2-second animation clips from text on the user's own rigged models: people, animals, props."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: animation
user-invocable: false
allowed-tools: Read summer_assets_search summer_assets_generate_motion summer_jobs_wait summer_assets_get summer_import_asset_by_id summer_call
---

# Text to Motion

Summer-hosted text-to-motion turns a text prompt into a 2-second (60 frames) skeletal
clip for the user's **own** rigged model. One model covers every skeleton with 5-70 bones:
humanoids, animals, creatures, cartoon plants, turrets, props.

The operation is `assets.generate_motion` with `backend: "text-to-motion"`. It answers at
once with a job; `jobs.wait` follows it. The finished job's `result.assets` lists one `animation`
asset per prompt x take (`id`, `fileUrl`, `animationName`, `prompt`, `take`); each is a GLB
of the whole model carrying one animation named after its prompt.

Trigger on: "make the flower nod", "animate my creature", "custom animation from text",
"a bow / shrug / wave with the right arm", "animate this uploaded rig", "the library
doesn't have that move", any animation request for a non-humanoid rig.

## Choose the right route

| Situation | Use |
| --- | --- |
| Summer-rigged humanoid needs idle / walk / run / jump / attack | `generate-motion` (`backend: "meshy-library"`) |
| Custom action, specific arm or side, emotional gesture | this skill |
| Non-humanoid rig: flower, animal, creature, turret, prop | this skill |
| Uploaded or custom-rigged GLB/FBX | this skill |
| Existing clips onto a second character | `retarget` |
| Unrigged mesh | rig first (`rigging-for-text-motion.md`; humanoids via `character-model`), then this skill |

## The order

1. **Confirm the rig.** The asset must be the user's own `3d_model` GLB/FBX with one
   skinned armature and 5-70 bones (`assets.search({ scope: "mine", assetType: "3d_model" })` / `assets.get`). If it
   is unrigged or has odd bone names, read `rigging-for-text-motion.md` in this directory.
2. **Agree the clip list and cost.** Each prompt x take is one billed clip. Run the call
   below with `dryRun: true` first: it checks the rig and returns `estimate.credits`. Show
   the list and the credits and wait for the user's OK before submitting.
3. **Submit once.** Up to 8 prompts per call, `takes` 1-4. For rooted characters pass
   `lockJoints` with the base bones:

   ```
   assets.generate_motion({
     rigAssetId: "<id>",
     backend: "text-to-motion",
     prompts: ["nods happily", "waves hello with the right leaf"],
     lockJoints: ["Hips", "Spine"],   // rooted flower; omit for characters that move
     cfgScale: 5                      // default 3; 5 for clearer gestures on stylized rigs
   })
   ```

   Pass a stable `idempotencyKey` if you might retry the same request. Prompt writing and
   every control: `prompts-and-controls.md` in this directory.
4. **Wait for the job.** `jobs.wait({ jobId: "<job.id>", timeoutSeconds: 50 })`, again until
   `finished` is true. A job takes about 1-2 minutes. Do not resubmit while it runs.
5. **Review, then import.** Import the chosen clip assets with
   `summer_import_asset_by_id(assetId, parent, scenePath)`. Offer to regenerate weak takes
   with a rephrased prompt or a higher `cfgScale`; keep the good ones.

## Hard rules

- **Only the user's own rigged models.** Never animate assets owned by someone else.
- **Clips are 2 seconds and not guaranteed to loop.** For longer actions chain several
  prompts ("raises both arms", "holds the pose", "lowers the arms") or loop a good take.
- **Locomotion moves the root.** Walk/run/jump clips may translate the character; gameplay
  code owns movement, so strip or ignore root translation for in-place controllers.
- **Never lock joints on characters that walk or jump**; the root would be pinned.
- **Report failures with their code.** Job failures starting `text_motion:` (no skinned
  armature, too many or too few joints, multiple armatures, unknown lock joint) are input
  problems and the charge is refunded. Fix the rig or the request; do not retry unchanged.
- **A `backend` without `text-to-motion` means it is not enabled on this server yet.** Fall
  back to `generate-motion` (meshy-library) for humanoid clips and say so; do not retry.
- **Do not promise facial animation, finger detail or lip sync.** The model animates the
  skeleton only; blendshapes stay untouched (`facial-and-lipsync` covers faces).

## Request errors

Refusals answer the one error shape: `error.code` with one `next` step, and
`error.details.was` naming the reason below.

| `code` / `details.was` | Meaning | Do |
| --- | --- | --- |
| `invalid_input` on `backend` | Text-to-motion is off on this server (`backend` lists only `meshy-library`) | Use `generate-motion`; do not retry |
| `invalid_input` on `prompts` | No prompt | Pass `prompts` (1-8, each 1-300 chars) |
| `invalid_input` / `invalid_takes` | `takes` outside 1-4 | Fix and resubmit |
| `invalid_input` / `invalid_cfg_scale` | `cfgScale` outside 1.5-8 | Fix and resubmit |
| `invalid_input` / `invalid_lock_joints` | Bone names wrong | Use bone names that exist in the rig |
| `not_found` / `rig_asset_not_found` | Not the caller's asset | Find the user's own asset id |
| `invalid_input` / `rig_asset_invalid` | Not a rigged GLB/FBX `3d_model` | Rig it first |
| `no_credits` | Not enough credits | Fewer prompts/takes, or the person adds credits (`next` has the link) |

## Without Summer Engine

In a session without Summer Engine tools (the assets profile; the `summer-assets` skill has the whole loop), follow the order up to the review in step 5 and skip the import. Save the file where the person asked with `out` (the `summer-assets` skill says how), and tell them the path and format. Keep the good takes and name each file after its prompt.

## Do not stop early

Done means the chosen clips are imported and playing on the model in the scene. For a
playable character continue with `character-animation-wiring`; for state machines,
`animation-tree`.

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@4.9.0` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `assets.generate_3d` | `summer assets generate-3d` |
| `assets.generate_motion`, `summer_assets_generate_motion` | `summer assets generate-motion` |
| `assets.get`, `summer_assets_get` | `summer assets get` |
| `assets.search`, `summer_assets_search` | `summer assets search` |
| `summer_import_asset_by_id` | `summer engine import-asset-by-id` |
| `jobs.wait`, `summer_jobs_wait` | `summer jobs wait` |
<!-- /shell-commands -->
