---
description: Capture what this game-development session taught as a reusable skill (project, user or Summer library) so the next agent starts where you ended.
allowed-tools: Read Write Edit Glob Grep Bash Skill
---

# /gameskill — capture session learnings

Activate the library skill `gameskill` and follow it exactly; this command is only the entry point. If the `Skill` tool cannot find it, read `library/skills/gameskill/SKILL.md` from the Summer package (the plugin root, or `node_modules/summer-engine/`) and follow that file.

Ground rules the skill enforces, so you do not drift while it loads:

- Default home is the game project's own skills directory for the agent you are in (`.claude/skills/<slug>/`, `.agents/skills/<slug>/`). Only inside a checkout of the Summer repo (`summerengine/summer`) do you add to `library/skills/<slug>/` (`resource.yaml` + `SKILL.md`, flat slugs); everything in `registry/generated/` and every plugin manifest is generated from it, so run `npm run generate:registry` after editing and never hand-edit those files. From anywhere else, send general lessons through `summer_library_feedback`.
- Capture only learnings that are non-obvious AND general. Lead with the why. Real working code from the active project beats invented examples. VFX is shader + GDScript + node setup, never an image-generation pipeline.
- It is fine to report "session was tactical, no durable learnings." Do not manufacture skills.
