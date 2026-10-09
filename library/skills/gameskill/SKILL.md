---
name: gameskill
description: "Capture what a game-dev session just learned as a reusable skill (project, user or Summer library) so the next session starts smarter."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: workflow
allowed-tools: Read Write Edit Glob Grep Bash
---

# /gameskill: capture session learnings as a skill

You are being invoked at the end (or middle) of a game-development session. Turn what you just figured out into a durable skill so future agents start where you ended. This is the meta-skill: the loop that turns ad-hoc fixes into reusable expertise.

## Where a captured skill goes

Summer resolves skills in this order: the game project, then the user's agent skills directory, then the skills bundled with the Summer package. Pick the narrowest home that fits:

1. **The game project** (default). Write `SKILL.md` into the project-scoped skills directory of the agent you are running in: `.claude/skills/<slug>/` for Claude Code, `.agents/skills/<slug>/` for Codex, Cursor, Devin Desktop and the other agents that read the shared folder. `summer skills install --scope project` shows the exact path for the current agent. Commit it with the game.
2. **The user's agent skills directory** when the lesson applies to every project on this machine (`~/.claude/skills/<slug>/`, `~/.agents/skills/<slug>/`). Do not edit skills that Summer installed there; they are overwritten on the next `summer setup`.
3. **The Summer library** when the lesson is general enough for every Summer user. Only possible inside a checkout of the `summerengine/summer` repository: add `library/skills/<slug>/resource.yaml` and `library/skills/<slug>/SKILL.md` (flat slugs, no category folders), then run `npm run generate:registry` and `npm run validate:library`. Everything under `registry/generated/` and every plugin manifest is generated from `library/`; never hand-edit them. Outside that checkout, send the lesson through `summer_library_feedback` (or `summer tool library-feedback`) with the id of the closest existing skill so the maintainers can fold it in.

Read the current project as ground truth. Working code from the real project beats invented examples.

## What to do, in order

1. One short sentence to the user: "Capturing learnings from this session into a skill." No plan dump.

2. Probe. Check which skills directories exist for this agent and project, and search the bundled library first (`summer_search_library "<topic>"`, or `summer skills list`) so you extend an existing skill instead of duplicating it.

3. Recap the session. Pull out learnings that are non-obvious AND general, things a future agent could not derive from reading the codebase. Examples that count:
   - A working shader (the actual code)
   - A GDScript idiom that beat the obvious approach
   - A UI layout that survived the design pass
   - A bug, its root cause and the fix that was not in any docs
   - An engine quirk (type inference, signal gotchas, plugin configuration)
   - A spawning, AI or enemy pattern that worked
   - A performance fix with measured before and after
   - An asset workflow that beat the alternatives
   - A Summer tool that steered you wrong: report that with `summer_library_feedback` on the tool's id, in addition to any skill

   Examples that do NOT count: one-off code with no general lesson, things already documented in an existing skill or the project's agent instructions, personal preferences without reasoning, anything manufactured to fill space.

4. Decide placement for each learning: extend an existing skill (name the file, quote the section, draft the addition) or create a new one (pick the home from the list above, name the slug, draft the full skill). Match the format of the bundled skills: YAML frontmatter with `name` and a "Use when ..." `description`, then the body.

5. One tight pause for the user. Five to ten lines: what files you will touch, what each captures, what gets left out. Wait for OK or a redirect. Do not ask multiple questions.

6. Apply. Write the files, run `git status` so the diff is visible, and if you touched the Summer library run the generator and validator.

7. Report. One short message: files changed, the future-agent payoff in one sentence per skill, and what (if anything) is still uncaptured.

## Style rules

- Tight. No filler.
- Capture the why, not just the what. "Use X" rots. "Use X because Y breaks under Z" survives. Lead with the reason.
- Real working code from the active project beats invented examples.
- VFX is code: shaders, GDScript and node setup. Never an image-generation pipeline.
- No em dashes in skill text. Use periods or restructure.
- No dates inside skill bodies. Skills are timeless guidance; dates belong in commit messages.
- No specific game or project names inside skill bodies. The same skill may be installed by someone who never heard of your project.
- Verify before claiming. If a skill says "Summer Engine does X", check it against the tool result or the running engine first.

## When there is nothing worth capturing

Say so: "session was tactical, no durable learnings worth a skill." Better to ship nothing than to ship noise.
