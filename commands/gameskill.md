---
description: Capture what this game-development session taught into Summer's canonical skill library (library/skills/<slug>/) so the next agent and every Summer user start where you ended.
allowed-tools: Read Write Edit Glob Grep Bash Skill
---

# /gameskill — capture session learnings

Activate the library skill `summer:gameskill` and follow it exactly; this command is only the entry point. If the `Skill` tool cannot find it, read `library/skills/gameskill/SKILL.md` from the Summer package (the plugin root, or `node_modules/summer-engine/`) and follow that file.

Ground rules the skill enforces, so you do not drift while it loads:

- The single source of truth is `library/skills/<slug>/` in the summer-engine agent repo (`resource.yaml` + `SKILL.md`, flat slugs, no category folders). Everything in `registry/generated/` and every plugin manifest (`.claude-plugin/`, `.codex-plugin/`, `.cursor-plugin/`, `.factory-plugin/`, `gemini-extension.json`) is GENERATED from it — run `npm run generate:registry` after editing and never hand-edit those files.
- Capture only learnings that are non-obvious AND general. Lead with the why. Real working code from the active project beats invented examples. VFX is shader + GDScript + node setup, never an image-generation pipeline.
- It is fine to report "session was tactical, no durable learnings." Do not manufacture skills.
