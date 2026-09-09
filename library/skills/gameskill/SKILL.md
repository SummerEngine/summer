---
name: gameskill
description: Use when finishing a game-development session and you want to capture what you just learned into Summer's canonical skill library so the next session and every Summer user start smarter. Trigger on "gameskill", "/gameskill", "capture learnings", "save to skills".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: workflow
allowed-tools: Read Write Edit Glob Grep Bash
---

# /gameskill — Capture Session Learnings into the Skill Library

You're being invoked at the end (or middle) of a game-development session. Your job is to turn what you just figured out into a durable skill update so future agents and Summer users get to start where you ended.

This is the meta-skill: the loop that turns ad-hoc fixes into reusable expertise.

## What "Summer Engine" is, so you're grounded

Three repos, one ecosystem:

1. **SummerEngine repo** — the Summer Engine desktop source plus the canonical
   CLI. The C++ engine is maintained against the upstream Godot Engine codebase;
   the Summer-owned module lives at `modules/1summer_engine/`. CLI source lives
   at `tools/summer-cli/` and is normally invoked with
   `npx -y summer-engine@latest`. It installs, signs in, creates, and runs Summer
   projects and can install the current Summer skill bundle for supported
   agents.
2. **PublicSummerEngine repo** — the web app at summerengine.com. Has its own AI skill stores at `src/lib/ai/skills/bundled/` and `public/knowledge/summer/skills/` for the in-browser chat agent. Also has its own consumers of the engine API in `src/lib/bridge/direct-executor.ts` and `src/lib/ai/tools/run-and-verify.ts` which call the same engine endpoints the CLI does.
3. **The active Summer game project** — usually
   `~/development/<game-name>` or whatever game you were just working on. The
   live compatibility line comes from Summer Engine, not this prompt. Real
   working code in this repo is the gold standard for examples.

The skill system is the value flywheel. Every game shipped teaches lessons. Lessons become skills. Next user starts smarter. Your job here is to close that loop for what you just did.

## Cross-repo change awareness — read before any non-trivial fix

When the lesson is "the engine should expose more / behave differently," the change usually crosses repo boundaries. Map the layers before you edit:

```
[active game] -> calls MCP / web app
                       v
[summer-cli MCP server (TypeScript)] -> calls /api/ops + /api/state/* on the engine
                       v
[Summer Engine binary (C++ in SummerEngine repo)] - source of truth for what the API returns

[PublicSummerEngine web app (TypeScript)] -> also calls the same engine endpoints via direct-executor or Redis bridge
```

Implications:

- A C++ change in `SummerEngine/modules/1summer_engine/` or `SummerEngine/editor/` reaches everyone (CLI MCP, web app, future tools). Most powerful, also highest blast radius.
- A TypeScript change in `tools/summer-cli/src/mcp/` only changes what the CLI exposes. The web app has its own TypeScript layer at `PublicSummerEngine/src/lib/bridge/`. Same engine endpoints, different glue. Don't assume your CLI tool change is web-app-aware.
- A skill update in `tools/summer-cli/skills/` affects every agent that runs `summer skills install`. The web app's skill store is separate (`PublicSummerEngine/src/lib/ai/skills/bundled/`) and currently uses a different format (template wizards, not Markdown discipline guides). Don't try to mirror skills there blindly.

When you change an engine endpoint's response shape:

1. Grep both `tools/summer-cli/src/` and `PublicSummerEngine/src/lib/` for consumers of that endpoint.
2. Confirm the change is additive (new fields, no removed/renamed) so existing consumers still work without modification.
3. If the change is breaking, update both consumers in the same logical commit set.
4. Note in `tools/summer-cli/TOOLING-TODO.md` what's now possible that wasn't before.

Engine binary changes ship via a rebuild + new release. CLI/web TypeScript changes ship via npm publish or web deploy. State this delivery cost in your report so the user knows what they get today vs after a release.

## The four skill stores (probe each before doing anything)

1. **Canonical source** — `~/development/SummerEngine/tools/summer-cli/skills/`. Single source of truth. Domains: `ui-and-ux`, `gameplay-mechanics`, `character-controllers`, `scripting-patterns`, `visual-effects`, `debugging`, `rendering-and-lighting`, `scene-and-project`, `level-design`, `audio`, `ai-and-npcs`, `asset-pipeline`, `performance`, `deployment`, `multiplayer-and-networking`, plus `workflow` for process skills. The `skills:` array in `.claude-plugin/plugin.json` is the registry. Sibling references live at top-level `references/` and `tests/`.
2. **Claude auto-discovery** — `~/.claude/skills/`. Where `summer skills install --agent claude-code` writes copies. Auto-discovered by Claude Code in any session.
3. **Web-app stores** — `PublicSummerEngine/src/lib/ai/skills/bundled/` (template wizards, different format) and `PublicSummerEngine/public/knowledge/summer/skills/` (JSON knowledge files). Mirror only when the lesson genuinely fits their format. Most discipline-guide skills don't.
4. **The active game** — read it as ground truth. Working code from the real project beats invented examples.

## What to do, in order

1. One short sentence to the user. "Capturing learnings from this session into the skill library." That's it. No plan dump.

2. Probe the stores. Glob each path above. Note what exists and what's empty. Print a tight summary.

3. Recap the session. Look back over the conversation. Pull out learnings that are non-obvious AND general — things a future agent or user would benefit from but couldn't derive from reading the codebase. Examples that count:
   - A working shader (the actual code) -> `visual-effects`
   - A GDScript idiom that beat the obvious approach -> `scripting-patterns`
   - A UI layout that survived the design pass -> `ui-and-ux`
   - A bug + root cause + fix that wasn't in any docs -> `debugging`
   - A Godot 4.x quirk (type inference, signal gotchas, plugin layer config) -> `scripting-patterns`
   - A spawning/AI/enemy pattern that worked -> `ai-and-npcs` or `gameplay-mechanics`
   - A perf fix with measured before/after -> `performance`
   - An asset workflow that beat alternatives -> `asset-pipeline`
   - An MCP gap that needed an engine-side fix -> `tools/summer-cli/TOOLING-TODO.md` AND the relevant skill

   Examples that DON'T count: one-off code with no general lesson, things already documented in CLAUDE.md or an existing skill, personal preferences without reasoning, anything you have to manufacture to fill space.

4. Decide placement. For each learning:
   - Update existing skill: name the file, quote the section, draft the addition.
   - Create new skill: pick the domain, name the file, draft the full skill markdown.
   Match the format of existing skills in the same domain exactly. Read one if you're unsure.

5. One tight pause for the user. Five-to-ten lines max: what files you'll touch, what each one captures, what gets left out. Wait for OK or redirect. Don't ask multiple questions.

6. Apply.
   - Write/edit `.md` files under `tools/summer-cli/skills/<domain>/`.
   - Register a new skill in `.claude-plugin/plugin.json` (and sibling `.codex-plugin/`, `.cursor-plugin/` manifests) AND in `src/lib/skills-registry.ts` `SKILL_REGISTRY` array. Both are required — `plugin-manifests.test.ts` fails the build if either is missing.
   - If the skill belongs in the curated Claude set, also write it to `~/.claude/skills/<name>/` so it's live in the current session. Tell the user to consider adding it to the CLI's default install set.
   - If the learning applies to the web chat agent, mirror to `PublicSummerEngine` skill stores too.
   - Run `git status` in the SummerEngine repo (and `PublicSummerEngine` if touched) so the diff is visible.

7. Report. One short message. Files changed, the future-agent payoff in one sentence per skill, and what (if anything) is still uncaptured.

## Style rules

- Tight. No slop. No glazing.
- Capture the why, not just the what. "Use X" rots. "Use X because Y breaks under Z" survives. Always lead skill updates with the reason.
- Real working code from the active project beats invented examples. Lift from the active codebase.
- VFX is code. Shaders + GDScript + node setup. Never image-generation pipelines or Meshy prompts.
- No em dashes (—) in any user-facing copy you write into skills. Use periods or restructure.
- No date references inside skill bodies. Skills are timeless guidance. Dates belong in commit messages and changelogs, not in `.md` skill content.
- No specific game / project names inside skill bodies. Skills are universal. The same skill might be installed by a future user who never heard of your current project.
- `[SUMMER]` markers on core Godot engine file edits in C++ changes. Skill `.md` files don't need them.
- Verify before claiming. If a skill says "Summer Engine does X," verify in the actual code before writing it down.

## When there's nothing worth capturing

It's totally fine to come back with "session was tactical, no durable learnings worth a skill update." Don't manufacture skills from thin air. Better to ship nothing than ship noise.
