---
name: text-to-motion
description: "Custom 2-second animation clips from text prompts on any of the user's own rigged models — humanoids, animals, creatures, cartoon plants, props."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: animation
user-invocable: false
allowed-tools: Read summer_list_my_assets summer_generate_motion summer_check_job summer_get_asset summer_import_asset_by_id
---

# Text to Motion

Summer-hosted text-to-motion turns a text prompt into a 2-second (60 frames) skeletal
clip for the user's **own** rigged model. One model covers every skeleton with 5-70 bones:
humanoids, animals, creatures, cartoon plants, turrets, props.

The tool is `summer_generate_motion` with `backend: "text-to-motion"`. It returns a
`jobId`; poll `summer_check_job`. The finished job's `result.assets` lists one `animation`
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
   skinned armature and 5-70 bones (`summer_list_my_assets` / `summer_get_asset`). If it
   is unrigged or has odd bone names, read `rigging-for-text-motion.md` in this directory.
2. **Agree the clip list and cost.** Each prompt x take is one billed clip. Show the list
   and the estimated cost and wait for the user's OK before submitting.
3. **Submit once.** Up to 8 prompts per call, `takes` 1-4. For rooted characters pass
   `lockJoints` with the base bones:

   ```
   summer_generate_motion(
     rigAssetId: "<id>",
     backend: "text-to-motion",
     prompts: ["nods happily", "waves hello with the right leaf"],
     lockJoints: ["Hips", "Spine"],   // rooted flower; omit for characters that move
     cfgScale: 5,                     // default 3; 5 for clearer gestures on stylized rigs
     wait: false
   )
   ```

   Pass a stable `idempotencyKey` if you might retry the same request. Prompt writing and
   every control: `prompts-and-controls.md` in this directory.
4. **Poll to completion.** `summer_check_job(jobId)`. A job takes about 1-2 minutes. Do not
   resubmit while it runs. (With the default `wait: true` the tool polls for you.)
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
- **`backend_unavailable` means text-to-motion is not enabled on this server yet.** Fall
  back to `generate-motion` (meshy-library) for humanoid clips and say so; do not retry.
- **Do not promise facial animation, finger detail or lip sync.** The model animates the
  skeleton only; blendshapes stay untouched (`facial-and-lipsync` covers faces).

## Request errors

| Code | Meaning | Do |
| --- | --- | --- |
| `backend_unavailable` | Server flag off | Use `generate-motion`; do not retry |
| `prompt_required` | No prompt | Pass `prompt` or `prompts` (1-8, each 1-300 chars) |
| `invalid_takes` | `takes` outside 1-4 | Fix and resubmit |
| `invalid_cfg_scale` | `cfgScale` outside 1.5-8 | Fix and resubmit |
| `invalid_lock_joints` | Bone names wrong | Use bone names that exist in the rig |
| `rig_asset_not_found` | Not the caller's asset | Find the user's own asset id |
| `rig_asset_invalid` | Not a rigged GLB/FBX `3d_model` | Rig it first |
| `insufficient_credits` (402) | Not enough credits | Fewer prompts/takes, or the user tops up |

## Do not stop early

Done means the chosen clips are imported and playing on the model in the scene. For a
playable character continue with `character-animation-wiring`; for state machines,
`animation-tree`.
