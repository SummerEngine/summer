# Prompts and controls

## Prompts

- Describe one action as a verb phrase: "waves hello with the right arm", "nods happily",
  "bows politely", "jumps up and down excitedly", "looks around curiously".
  The service normalizes to its training style ("An object waves ...").
- Name the side and body part for asymmetric actions ("with the right arm", "raises the
  left leaf").
- Keep it to one action per clip; 2 seconds fits one gesture, not a sequence.
- Style words that map to motion work ("happily", "slowly", "tiredly"); story or
  appearance words do not.

## Controls (`summer_generate_motion`, `backend: "text-to-motion"`)

| Field | Default | Use |
| --- | --- | --- |
| `prompt` / `prompts` | - | One action, or 1-8 actions (each 1-300 chars); one clip each. Pass one of the two, not both |
| `takes` | 1 | 1-4; 2-3 when choosing a hero clip. Every take is billed |
| `cfgScale` | 3 | 1.5-8; 5 for bigger, clearer gestures on stylized rigs; above 6 gets unstable |
| `lockJoints` | none | Base bones of rooted characters (plants, turrets, statues), e.g. `["Hips","Spine"]` |
| `idempotencyKey` | none | Stable key so a retried request is not billed twice |
| `wait` | true | `false` returns the `jobId` at once; poll `summer_check_job` |

Clip count = prompts x takes; each clip is billed. The queued response reports
`clipCount` and `estimatedCost`.

## Judging results

- Good: the named body part does the action, the base stays put, no mesh tearing.
- Tipping over or collapsing on rooted rigs: add or extend `lockJoints`.
- Barely moving: rephrase with a clearer verb, raise `cfgScale` to 5, or rename bones to
  human names (see `rigging-for-text-motion.md`).
- Mesh warping at a joint: a weighting problem in the rig, not the motion; fix the rig.
