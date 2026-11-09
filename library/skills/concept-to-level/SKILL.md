---
name: concept-to-level
description: "3D map from concept art to a shippable level: user questions, owned lanes, render checks, collision in step."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: level-design
user-invocable: true
allowed-tools: Read Grep Glob Write Edit Bash summer_assets_generate_image summer_assets_generate_3d summer_jobs_wait summer_call summer_screenshot summer_get_scene_tree summer_inspect_node summer_set_prop summer_save_scene summer_get_diagnostics summer_get_script_errors
paths: ["**/*.tscn", "**/*.gdshader", "**/*.gdshaderinc", "level/**", "levels/**", "docs/**", ".summer/**"]
---

# concept-to-level — from concept art to a polished level

Use this when a 3D map has to go from "here is the idea" to a level that
looks finished, plays right online and offline, and runs well. It is the
process and the judgment; the specialist skills it names do the leaf work.

Distilled from one long build of a 1v1 arena duel map (a white-marble drill
yard on a mountain peak above the clouds, with god hands that change the
map mid-match). Its mistakes are the reason most rules below exist.

**Core principle:** agree the look before you build it, build in lanes that
each own their files, and never call a lane done without a render you have
opened for the user.

## When to use

- "Turn this concept art into the real map." (3D, shipping quality)
- "Rework this level's theme, keep the layout."
- "Polish this map: materials, props, sky, effects."
- Several agents will work on one map at once.

## When NOT to use

- A 2D or quick playable scene from a reference image: `scene-to-level`.
- Designing layout, pacing and encounters on paper: `design-level`.
- One asset: `prop-model`, `environment-kit`, `organic-model`.
- Only picking a style: `concept-art`, `art-direction`.

## Ask these before you build

Ask in batches of two or three, not all at once. Record the answers in the
design doc. Each line says why it matters and what broke when it was not
asked.

**Theme and fantasy**
- [ ] What is this place, who owns it, what is the player there? *Drives every
  prop and material choice. "A drill yard where players are guests" gave
  the map its whole prop list.*
- [ ] Which reference frames are the bar? Show 3-4 generated options and get
  a pick. *A god power built from a text brief was rejected twice; three
  concept images got a clear pick in one reply.*

**Layout and gameplay**
- [ ] What layout stays, what may change? May colliders, spawns and zones
  move? *Decides whether you must recompile server collision and update
  tests.*
- [ ] Which surfaces are walkable, lethal, or "risky perches"? Where are the
  ring-outs? *Fall zones need their own checks.*
- [ ] Should dynamic events (moving hazards, raised platforms, collapsing
  walls) feel big and slow or quick? Should the warning show where it lands?
  *The first sliding-hazard warning drew the whole path on the floor; the
  user found it too easy to dodge.*
- [ ] What should the fight feel like? *"A battle for the high ground" turned
  a vague light platform into layered plates with jump routes.*

**Quality and readability**
- [ ] What is the quality bar for close-ups? *Users inspect props at arm's
  length: flat untextured parts, floating chains and sticks clipping
  surfaces all got flagged.*
- [ ] What must stay readable? Set a number (we used: player silhouettes keep
  at least 60% of clean brightness under every effect).
- [ ] How dark or saturated may effects get? *"Dark and evil, red only in thin
  veins" was a rule we had to learn after a too-red pass.*

**Platform and runtime**
- [ ] Target hardware and platforms (mobile? integrated laptops?) and frame
  budget. *Measure early; one decorative set cost a quarter of all triangles.*
- [ ] Does the map run online? What does the online build strip? *Our online
  map build removed particle nodes and ran no map scripts.*
- [ ] What must be baked versus procedural? (Baked = no CPU, cannot react;
  procedural = can aim and track.) *The floating statue had to be baked; the
  god hands had to aim procedurally.*

**Rules and process**
- [ ] Game rules that limit design (rewards, odds, trading, licences)? Which
  files are off-limits to you?
- [ ] Deadlines and demos? *Before a demo: stop background work, commit only
  verified lanes, keep fallbacks.*
- [ ] Commit, push and PR policy.

## The pipeline

### 1. Frames first

Generate several cheap options with `assets.generate_image` (see
`concept-art`): an aerial overview, eye level, one per hero element. Get a
pick. Save the picked frames in the repo next to the design doc and check
every lane's renders against them. When a lane stalls on taste, generate
three directions for that element and ask again; do not iterate blind.

### 2. Design doc

One markdown file per map: theme, layout and what is kept, floor, walls,
backdrop, props, materials rule, effects, dynamic events, performance
budget, open questions. Every user answer goes in. Lanes read it; you
update it when the user changes direction.

### 3. Blockout

Rough geometry for everything at final scale, with a visible "not final"
material. Remaining blockout material is the to-do list. Keep a stand-in
player capsule for scale in every render.

### 4. Lanes

Split by system, one owner each:

| Lane | Owns |
|---|---|
| Floor | ground materials, inlays, spawn floors |
| Walls / kit | modular kit, ring or room assembly, wall collision |
| Backdrop | sky, distant terrain, clouds, fog, kill height |
| Props | cover pieces, set dressing, shared material library |
| Cloth | banners and flags with sway |
| Lighting and effects | sun, fire, glows, corruption-style map states |
| Events | dynamic hazards, their visuals, spec for the server |

The map scene is shared: every lane edits it only through the live editor,
saves only its own changes, and reports what it touched. See "Running it
with parallel agents" below.

### 5. Materials rule

No flat, unshaded surface on any model. Every surface gets real PBR textures
or procedural detail. Specific rules that came from user feedback:

- Bake a cavity/edge mask per prop, and scale edge wear by part thickness:
  thin bars and chain links read as clean grey plastic otherwise.
- Wood: plank UVs at real scale, grain along each board's long axis, darker
  end grain, grime in the joints. Triplanar noise reads as cork.
- Forged iron near black, rough (0.6-0.8) so curved bands do not mirror the
  sky; rust only in recesses.
- Brass: dark tarnish base, polish only on high points and real wear.
- One shared material library for the map; props reuse it.

### 6. Verify every lane with renders

After each change, render fixed angles: the user's own angle if they sent a
screenshot, eye level from the play space, a far view, from above. Open the
images for the user. Compare to the frames. A lane is done when its renders
pass, not when its script ran.

### 7. Keep gameplay in step

After any collider, spawn or zone change: recompile the server collision
artifact, update tests that hard-code positions, run the covering tests,
and only then commit. Moving a structure means re-running everything placed
relative to it (see the reference file).

### 8. Commit per verified lane

Commit each lane when its renders and tests pass. Stage only that lane's
files. Never commit files the editor rewrites on its own unless you meant to
change them.

## Hard-won technical rules

Short list; details and reasons in
[references/technical-rules.md](references/technical-rules.md).

1. Never run heavy or reloading scripts in the live editor (recoding
   shaders, reloading scenes, instantiating or freeing what an open scene
   uses). It hung and crashed the editor. Build headless; import named files.
2. Render previews from a separate short-lived engine process that loads
   from disk; call `RenderingServer.force_draw()` before reading the image.
3. One heavy process at a time, at low priority. Stop everything for demos.
4. Online builds may strip particle nodes and map scripts. Make fire, sparks
   and motes from shader-driven meshes; bake map animation into vertex
   animation textures and set `custom_aabb`.
5. Edit an open scene only through the live editor; never text-edit it on
   disk while it is open.
6. The editor rewrites some project files on its own. Commit surgically.
7. Keep a fallback scene when swapping in an experimental asset.
8. Generated 3D models need cleanup and a notices entry; third-party
   textures need their source and licence recorded.
9. Modular kits: zero coplanar overlaps, sealed seams, no see-through holes.
10. Measure render cost early: triangles, draw calls, shadow casters, lights.

## Running it with parallel agents

- One lane per agent, with the files it owns written down. Shared files (the
  map scene, a shared material library) have one owner per change.
- Agents report with renders and exact file lists; the coordinator opens the
  renders, checks them against the frames, and commits per lane.
- Relay user feedback with concrete fixes ("thin parts read as grey plastic:
  scale edge wear by thickness"), not the raw complaint alone.
- When an agent cannot do something (a permission check blocked it), ask the
  user; do not route around it.
- Keep the machine cool: one heavy job at a time across all agents.
- Before a demo: tell every agent to stop, commit only verified work, and
  keep experiments out of the map.

See `dispatching-parallel-agents` for the general pattern.

## Definition of polished

- [ ] Every surface has a real material; no blockout material left.
- [ ] No floating, clipping or interpenetrating parts at close range
      (chains, cloth, props on floors, decals on walls).
- [ ] Renders from all fixed angles match the reference frames.
- [ ] Players stay readable under every effect and event.
- [ ] Spawns are centred, symmetric where the mode needs it, and face play.
- [ ] Collision matches the visuals (within a few cm); server collision
      recompiled; tests pass.
- [ ] Fall zones kill, safe zones are safe, nothing catches falling players.
- [ ] Works with the online build's limits (no particles or scripts if
      stripped).
- [ ] Render cost measured, biggest offenders known, low-end notes written.
- [ ] Third-party sources and generated assets recorded in the notices.
- [ ] Design doc matches what shipped.

## Common mistakes

- Building a hero effect before agreeing its look. Generate options first.
- Splitting or regenerating a kit piece and overwriting the repo copy before
  the scene that uses it is updated: parts vanish in the live map.
- Fixing one banner when all banners share the cause. Check the whole set.
- Calling a lane done from a headless log. Open a render.
- Moving a room and forgetting the decals, banners, rock and spawns placed
  around it.

## See also

- `concept-art`, `art-direction`, `design-level`, `scene-to-level`
- `environment-kit`, `fabricating-assets`, `prop-model`, `tileable-texture`
- `3d-lighting`, `vfx-fire`, `vfx-dissolve`, `procedural-animation`
- `headless-scripting`, `bounded-engine-runs`, `verifying-scenes`
- `tune-performance`, `dispatching-parallel-agents`

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@latest` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `summer_assets_generate_3d` | `summer assets generate-3d` |
| `assets.generate_image`, `summer_assets_generate_image` | `summer assets generate-image` |
| `summer_get_diagnostics` | `summer engine get-diagnostics` |
| `summer_get_scene_tree` | `summer engine get-scene-tree` |
| `summer_get_script_errors` | `summer engine get-script-errors` |
| `summer_inspect_node` | `summer engine inspect-node` |
| `summer_save_scene` | `summer engine save-scene` |
| `summer_screenshot` | `summer engine screenshot` |
| `summer_set_prop` | `summer engine set-prop` |
| `summer_jobs_wait` | `summer jobs wait` |
<!-- /shell-commands -->
