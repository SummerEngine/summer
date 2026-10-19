---
name: hero-art
description: "Hero splash art, seamless splash loops and rigged animated heroes, gated."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: 3d-assets
user-invocable: true
allowed-tools: Read Grep Glob Write Edit Bash summer_assets_generate_image summer_assets_generate_video summer_assets_generate_3d summer_assets_generate_motion summer_jobs_wait summer_call summer_docs_read summer_import_from_url summer_run_script summer_inspect_resource summer_screenshot summer_play summer_stop summer_get_debugger_errors
paths: ["ui/**", "art/**", "assets/**", "characters/**", "**/*.glb", "**/*.tscn", "**/*.gd"]
---

# hero-art: heroes people want to pick

Playable heroes (champions, classes, named leads) sell a game twice: on the select screen and in play. This skill covers
the whole path, in three parts. Read the part for the job in front of you; each one stands alone.

| Job | Read |
|---|---|
| A painted splash for each hero, in one house style; inventing a new hero's look | `references/splash-art.md` |
| The splash, alive: a 15 s seamless loop on the select screen | `references/splash-loop.md` |
| The approved design as a rigged, animated, game-ready 3D hero | `references/hero-character.md` |

Order for a new hero: concept (splash-art method) -> the person picks -> 3D hero -> splash -> loop. A redo of a weak
splash or a loop for an existing splash can start at its own part.

## When NOT to use

- A quick NPC or enemy where an auto-rig is enough: `character-model`.
- A square dialogue or codex bust: `character-portrait`. Rough direction exploration: `concept-art`.
- Store key art, covers and icons: `store-art`. A title-screen loop with no character: `animated-loop`.

## Without Summer Engine

In a session without Summer Engine tools (the assets profile; the `summer-assets` skill has the whole loop), every
generation step still works: the splash, its loop and the 3D hero up to the exported desktop and phone files. Skip the
in-engine steps (import, the select-screen player, the scene wiring). Save each file where the person asked with `out`
(the `summer-assets` skill says how) and tell them the paths and formats: the loop's `.ogv` copies play in Summer Engine
and Godot; a plain looping muted MP4 suits the web.

## Rules for all three parts

- **The person's eye is the gate.** Make options, show them full size (images beside their references; motion as a video
  with one line of what to look for), and wait for the person to name the exact one. Never build on an image or a model
  they have not approved.
- **An approved design is locked.** Fix only the defect they named; compare every edit side by side with the approved
  version. Edits drift toward plainer, stockier, younger; reject drift.
- **Fix at the source.** Hands, hair, weapons and framing are cheap to fix in an image and expensive in a mesh or a
  video. When a method fails once, change the method, not its parameters.
- **Adults, attractive, on-model**, in the game's own art style.
- **No text, logos, frames or watermarks** in generated art, and no caption about how it was made.
- **Spend is the person's.** Generation uses their credits: `dryRun: true` shows the cost; say what a batch costs before
  a large one. Long jobs answer with a job id: `jobs.wait`, never a second call.
- **Never overwrite approved or shipped files.** New versioned files, then repoint.
- **Record the recipe** (references, prompts, models, seeds, settings) in `.summer/art-bible.md` or `.summer/memory/`, so
  the next hero comes out the same.

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@latest` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `assets.generate_3d`, `summer_assets_generate_3d` | `summer assets generate-3d` |
| `assets.generate_image`, `summer_assets_generate_image` | `summer assets generate-image` |
| `assets.generate_motion`, `summer_assets_generate_motion` | `summer assets generate-motion` |
| `assets.generate_video`, `summer_assets_generate_video` | `summer assets generate-video` |
| `assets.get` | `summer assets get` |
| `assets.upload_begin` | `summer assets upload-begin` |
| `assets.upload_complete` | `summer assets upload-complete` |
| `summer_docs_read` | `summer docs read` |
| `summer_get_debugger_errors` | `summer engine get-debugger-errors` |
| `summer_import_from_url` | `summer engine import-from-url` |
| `summer_inspect_resource` | `summer engine inspect-resource` |
| `summer_play` | `summer engine play` |
| `summer_run_script` | `summer engine run-script` |
| `summer_screenshot` | `summer engine screenshot` |
| `summer_stop` | `summer engine stop` |
| `jobs.wait`, `summer_jobs_wait` | `summer jobs wait` |
<!-- /shell-commands -->
