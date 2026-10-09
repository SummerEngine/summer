# Rigging for text-to-motion

The motion model reads the skeleton's rest pose, hierarchy **and bone names**. Names carry
meaning: a bone called `LeftArm` borrows everything the model learned from human arms.
Rigs named like a human skeleton therefore animate far better than freeform names, even
on non-humans. Measured on cartoon flowers: with plant names (`Stem1`,
`LeafL1`) most prompts barely moved; the same rig with human names nodded, bowed,
gestured and looked around on cue.

## Limits the service enforces

- One skinned armature driving the mesh; GLB or FBX; at most 100 MB.
- 5-70 bones total (helper, twist and finger bones count). Remove extras before submitting.
- Existing animations are ignored; the service adds its own reference clip.
- Facing is detected from a left/right limb pair (`RightUpLeg`/`LeftUpLeg`, else arms).

## Humanoids

Meshy, Mixamo-style (`mixamorig:*`) and Summer auto-rig skeletons work as-is.
Summer character packages (`character-model`) can use text-to-motion for extra custom
clips; keep the package's canonical idle/walk/run/jump from `generate-motion`.

## Non-humanoids: map the body plan to human bone names

| Body part | Bone names |
| --- | --- |
| Base / pelvis / root of a plant | `Hips` |
| Torso, stem, trunk, neck chain (bottom to top) | `Spine`, `Spine1`, `Spine2`, `Neck` |
| Head, bloom, face | `Head`, then `HeadTop_End` |
| Arms, leaves, fins, wings | `LeftShoulder` > `LeftArm` > `LeftForeArm` > `LeftHand` (and `Right*`) |
| Legs, roots, lower fins | `LeftUpLeg` > `LeftLeg` > `LeftFoot` (and `Right*`) |
| Petals, ears, antennae, tails | own names (`Petal0`, `Tail1`), parented to the nearest body bone |

## Talking-flower recipe (validated)

- Stem = `Hips` > `Spine` > `Spine1` > `Spine2` > `Neck` > `Head`; petals parented to `Head`.
- Leaf-arms on the upper-middle stem, parented to `Spine1`/`Spine2`, pointing sideways.
- **Keep the arms clear of the petals and face.** Hands that touch the lower petals get
  their weights mixed and the mesh warps when the arm moves; arms lower on the stem
  deform cleanly.
- Submit with `lockJoints: ["Hips","Spine"]` so the flower stays planted, and
  `cfgScale: 5` for readable gestures.

## Rigging an unrigged mesh

- Humanoid: the Summer auto-rig (`character-model`, `summer_generate_3d` with
  `options.rig: true`).
- Other body plans: rig in the user's own Blender (`fabricating-assets`) or offline
  (`skintokens-auto-rigging`), using the human bone names above where the body plan allows
  (stem as spine, leaves as arms).

Check the weights around every joint that will move before animating. A rig with bad
weights produces bad clips regardless of the motion; mesh warping at a joint is a rig
problem, not a motion problem.
