---
name: generate-motion
description: Use when the user needs an animation clip on a rigged character — idle/walk/run/attack from the curated Meshy library OR a unique custom motion via Hunyuan-Motion. Picks the right backend, writes the right prompt, attaches the resulting clip to an AnimationPlayer. Trigger on "animation", "animate", "idle", "walk", "run", "attack animation", "make him do X", "motion", "mocap", "dance", "death animation".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: animation
user-invocable: false
allowed-tools: Read Grep summer_search_assets summer_list_models summer_generate_motion summer_inspect_resource summer_get_scene_tree summer_add_node summer_set_prop summer_set_resource_property summer_save_scene
paths: ["**/*.tscn", "**/*.tres", "**/*.gd"]
---

# Generate Motion — Library or Custom

Two backends, one decision. **Meshy library** picks a clip from a curated mocap set by name (`idle`, `walk`, `run`, `attack_sword`, ~70 standard names). **Hunyuan-Motion** generates a never-before-seen clip from a text prompt. The library is fast (~30s) and cheap (~$0.10) and looks great because it's real mocap. Hunyuan is slower (1–3 min) and pricier (~$0.40) and is the only option when the action isn't on the list. Pick correctly the first time or you waste the user's money and clock.

Both backends require a **Meshy-rigged humanoid** as the target. That means a `rigAssetId` from a prior `summer_generate_3d({ kind: "image-to-3d", imageUrl: "...", options: { rig: true } })` call. The result job includes `rigAssetId`. If the user points at a non-rigged mesh, stop and route to `summer:asset-pipeline/asset-strategy` (or directly call `summer_generate_3d` with `options.rig: true`) before generating motion.

## When to use this skill

- "Add a walk animation to the goblin."
- "I need an idle, a run, and an attack on this character."
- "The boss does a 360-spin axe slam — generate that."
- "Death animation for the enemy when HP hits zero."
- The user has a rigged character and zero animations on it.

## When NOT to use this skill

- The user wants to apply an *existing* animation to a *new* model — use `summer:animation/retarget` instead. Don't regenerate.
- The user wants state-machine wiring (idle → walk → run blend) — generate the clips here, then hand off to `summer:animation/animation-tree`.
- The user wants facial / lipsync animation — that's `summer:animation/facial-and-lipsync`.
- The mesh isn't rigged. Rig first; never call `summer_generate_motion` on a static `.glb`.
- The user wants procedural look-at, IK, foot placement — that's `summer:animation/procedural-animation`.

## Decision tree — library vs custom

Ask one question, then decide:

> Standard action (walk, run, attack, idle, etc.) or something specific to this character?

| Signal | Backend |
|---|---|
| "Walk", "run", "idle", "jump", "attack", "die", "dance", "wave", "sit" | `meshy-library` |
| Generic verb that fits the curated list (see Reference card) | `meshy-library` |
| Locomotion (any speed, any style — they're all in the library) | `meshy-library` |
| "She drops to one knee, draws a bow, and looses three arrows in a fan" | `hunyuan-custom` |
| "The boss does a 360-spin axe slam" | `hunyuan-custom` |
| Game-specific signature move | `hunyuan-custom` |
| Anything where direction, prop, or staging matters | `hunyuan-custom` |

If the request is ambiguous, default to `meshy-library` — try the closest curated name first; only escalate to `hunyuan-custom` if the result clearly misses the intent. Saves the user $0.30 per attempt.

## Steps

### 1. Verify the target is a rigged humanoid

```
summer_search_assets(query="<character name>", kind="model")
```

The result must include `rigAssetId: <id>` on a Meshy rig. If it shows `rigAssetId: null`, the model isn't rigged — stop, propose `summer_generate_3d({ kind: "image-to-3d", imageUrl: "...", options: { rig: true } })` first (the result includes `rigAssetId`), or route to `summer:asset-pipeline/asset-strategy`.

### 2. Confirm with the user before spending

> I'm about to generate a "run" animation on `goblin_rigged` via meshy-library — about 30s, ~$0.10. OK?

For Hunyuan custom:

> I'm about to generate "drops to one knee, draws bow, looses three arrows" via hunyuan-custom — 1–3 min, ~$0.40. The output is non-deterministic; first take might miss. OK?

### 3. Call the right backend

**Library:**
```
summer_generate_motion(
  rigAssetId: "<id>",
  backend: "meshy-library",
  motionName: "run"   // exact name from the curated list — see Reference card
)
```

**Custom:**
```
summer_generate_motion(
  rigAssetId: "<id>",
  backend: "hunyuan-custom",
  prompt: "humanoid character drops to one knee, draws a bow, looses three arrows in a fan, smooth motion, 4 seconds",
  duration: 4.0
)
```

Both return `{ animationAssetId, durationSeconds, previewUrl }`.

### 4. Attach to the character's AnimationPlayer

```
summer_inspect_node("./World/Goblin")             // confirm it has an AnimationPlayer child
summer_add_node(parent="./World/Goblin", type="AnimationPlayer", name="AnimationPlayer")  // only if missing
summer_set_resource_property(
  nodePath="./World/Goblin/AnimationPlayer",
  resourceProperty="libraries/default",
  subProperty="<motion_name>",
  value="<animationAssetId>"
)
summer_save_scene
```

If the character will use multiple clips, leave the AnimationPlayer in place — every subsequent generation appends to the same library. State-machine wiring belongs to `summer:animation/animation-tree`, not here.

## Confirmation gates

- **Before generation:** state backend, prompt/name, duration, est. cost. Wait for OK.
- **Before attaching:** state which AnimationPlayer and which library slot. Wait for OK.
- **After generation:** if the user hasn't seen the preview, link `previewUrl` and ask "land or regenerate?" before wiring it into the scene.

## Reference card

### Curated motion library — top 30 names (Meshy, exact strings)

`idle`, `idle_alert`, `idle_combat`, `walk`, `walk_strafe_left`, `walk_strafe_right`, `walk_back`, `run`, `run_strafe_left`, `run_strafe_right`, `sprint`, `jump`, `jump_loop`, `jump_land`, `crouch_idle`, `crouch_walk`, `attack_sword`, `attack_punch`, `attack_kick`, `attack_bow`, `attack_cast`, `block`, `dodge_left`, `dodge_right`, `hit_react`, `death`, `death_back`, `wave`, `dance`, `sit_idle`.

Full list: `summer_list_models(family: "motion-library")` — only call this if the user asks for something not on the top-30. The full list is ~70 names.

### Hunyuan prompt patterns

The Hunyuan model wants `subject + action verb + style + duration + camera-static cue`. Keep it under 40 words; longer prompts dilute the action.

| Goal | Prompt |
|---|---|
| Boss spin attack | "humanoid warrior performs a full 360 degree spin slam with a two-handed axe, heavy impact at the end, slow start fast finish, 3 seconds" |
| Stealth takedown | "humanoid assassin sneaks behind, grabs target's neck, pulls down silently, 2.5 seconds, low and grounded" |
| Spell cast | "humanoid mage raises both arms above head, channels glowing energy for 1 second, releases a burst forward, 3 seconds total" |
| Stagger / hit react big | "humanoid character takes heavy hit to chest, stumbles backward 3 steps, regains balance, 2 seconds" |
| Cinematic death | "humanoid character clutches chest, drops to knees, falls forward face-down, 4 seconds, dramatic" |

### Pitfalls

- **`motionName` typos silently match nothing.** `"run_fast"` is not on the list — the call returns an error or picks `"run"`. Always check the curated list first. Use exact strings from the table above.
- **Hunyuan ignores camera direction.** Don't say "the camera pans". The clip is in character-local space; the camera is the player's camera in your scene.
- **Hunyuan struggles with props.** "Holds a sword and slashes" works; "draws sword from sheath, slashes, sheathes" fails ~50% — split into two clips.
- **Locomotion clips have a forward bias.** Meshy's `run` translates the root forward by ~5m. If you're driving root motion in code, set `root_motion_track` correctly or strip the translation in an AnimationPlayer Edit. See the Godot 4.5 root motion docs.
- **Generated clips have inconsistent loop points.** Library clips loop cleanly. Hunyuan clips usually don't — wrap them in an AnimationNodeOneShot and crossfade back to idle, never set `loop_mode = LOOP`.
- **Rig pose mismatch.** If your rig was rigged with a non-T-pose reference image, the limbs may bend wrong. Re-rig from a T-pose mannequin (see `summer:asset-pipeline/asset-strategy`) before re-generating.

### Backend picker (one line)

`meshy-library` if the action name is in the curated list. `hunyuan-custom` if the user described a specific staged action. When unsure, try library first; you'll save 90% of the time.

## Anti-patterns

- Calling `summer_generate_motion` on a `.glb` that wasn't rigged — wastes a generation; the API errors but only after 30s.
- Generating the same clip twice because you forgot to save the `animationAssetId` from the first call. Search the asset library first: `summer_search_assets(query: "goblin run", kind: "animation")`.
- Wiring clips into an AnimationTree inside this skill. That's the next skill's job. Generate, attach, hand off.
- Picking `hunyuan-custom` for "walk". You'll get a worse, slower, more expensive walk than the library's mocap.

## Edge cases

- **Quadruped rig.** Meshy library is humanoid-only. Hunyuan can do quadrupeds with explicit prompts ("four-legged wolf"), but quality drops 30%. For quadrupeds, prefer hand-authored clips or import a Mixamo-style external library (out of scope for this skill).
- **Character is < 1m tall (child / dwarf).** Library clips assume a ~1.8m humanoid. Apply the clip; the proportions retarget but stride length looks long. Either accept it or tune `playback_speed` on the AnimationPlayer track.
- **Character has wings / tail.** The library ignores the extra bones — they sag. Hunyuan, prompted explicitly ("with wings folded back"), handles them in ~70% of takes.

## Fallback (no MCP)

The user can upload to Meshy directly at meshy.ai, generate via the dashboard, download `.glb`, and import as an AnimationLibrary in the Godot editor. Slower, but identical output. Hunyuan-Motion's web playground works the same way.

## Handoff

- After generating locomotion clips, suggest `summer:animation/animation-tree` to wire idle → walk → run.
- After generating a custom one-shot (death, hit-react), suggest `summer:ai-and-npcs/design-npc` to fire it from the behavior state machine.
- For first-person hand animations on a player, use this skill on a *hands-only rig* and then `summer:character-controllers/fps-controller` for the wiring.
- If the user wants to apply these clips to a second character, hand off to `summer:animation/retarget`.

## See also

- `_shared/mcp-tools-reference.md` — `summer_generate_motion` parameter schema, error codes.
- `summer:asset-pipeline/asset-strategy` — how to get a Meshy-rigged character in the first place.
- `summer:animation/animation-tree` — wire the generated clips into a state machine.
- `summer:animation/retarget` — re-use one library across many characters without regenerating.
