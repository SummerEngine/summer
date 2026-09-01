You are capturing what we just learned in this game-development session into Summer Engine's skill library, so the next agent (and every Summer user) gets to start where we ended.

This is the meta-skill: the loop that turns ad-hoc fixes into durable, reusable expertise.

## What "Summer Engine" is, so you're grounded

Three repos, one ecosystem:

1. **`~/development/SummerEngine`** — the Summer Engine desktop source and the
   canonical CLI. The C++ engine is maintained against the upstream Godot
   Engine codebase; the Summer-owned module lives at `modules/1summer_engine/`.
   The Summer CLI lives at `tools/summer-cli/` and is normally invoked with
   `npx -y summer-engine@latest`. It installs, signs in, creates, and runs Summer
   projects and can install the current Summer skill bundle for supported
   agents.
2. **`~/development/PublicSummerEngine`** — the web app at summerengine.com. Has its own AI skill stores at `src/lib/ai/skills/bundled/` and `public/knowledge/summer/skills/` for the in-browser chat agent. ALSO has its own MCP-style consumers of the engine API (`src/lib/bridge/direct-executor.ts`, `src/lib/ai/tools/run-and-verify.ts`) which call the same engine endpoints the CLI does.
3. **The active Summer game project** — usually
   `~/development/<game-name>` or whatever game we were just working on. The
   live compatibility line comes from Summer Engine, not this prompt. Real
   working code in this repo is the gold standard for examples.

The skill system is the value flywheel: every game we ship teaches lessons → the lessons become skills → the next user (or AI) starts smarter. Your job here is to close that loop for what we just did.

## Cross-repo change awareness — read this before any non-trivial fix

When the lesson is "the engine should expose more / behave differently," the change usually crosses repo boundaries. Map the layers before you edit:

```
[active game] → calls MCP / web app
                       ↓
[summer-cli MCP server (TypeScript)] → calls /api/ops + /api/state/* on the engine
                       ↓
[Summer Engine binary (C++ in SummerEngine repo)] — source of truth for what the API can return

[PublicSummerEngine web app (TypeScript)] → also calls the same engine endpoints via direct-executor or Redis bridge
```

Implications:

- **A C++ change in `SummerEngine/modules/1summer_engine/` or `SummerEngine/editor/` reaches everyone** (CLI MCP, web app, future tools). Most powerful, also highest blast radius.
- **A TypeScript change in `tools/summer-cli/src/mcp/`** only changes what the CLI exposes. The web app has its own TypeScript layer in `PublicSummerEngine/src/lib/bridge/` — same engine endpoints, different glue. Don't assume your CLI tool change is web-app-aware.
- **A skill update in `library/skills/`** affects every agent that runs `summer skills install`. The web app's skill store is separate (`PublicSummerEngine/src/lib/ai/skills/bundled/`) and currently uses a different format (template wizards, not Markdown discipline guides). Don't try to mirror skills there blindly.

When you change an engine endpoint's response shape (add fields, rename fields, change semantics):

1. Grep both `tools/summer-cli/src/` and `PublicSummerEngine/src/lib/` for consumers of that endpoint.
2. Confirm the change is **additive** (new fields, no removed/renamed) so existing consumers still work without modification.
3. If the change is breaking, update both consumers in the same logical commit set.
4. Note in TOOLING-TODO.md what's now possible that wasn't before.

Engine binary changes ship via a rebuild + new release. The user has to pull the new engine for the change to take effect. CLI/web TypeScript changes ship via npm publish or web deploy. State this delivery cost in your report so the user knows what they're getting today vs after a release.

## The four skill stores (probe each before doing anything)

1. **Canonical source** — `library/skills/<slug>/` in the summer-engine agent repo (flat slugs, no category folders).
   - Single source of truth. Each skill is a directory with `resource.yaml` (id, summary, facets, recommended) + `SKILL.md`.
   - `registry/generated/skills-registry.json` and the `skills:` arrays in `.claude-plugin/plugin.json` (+ sibling manifests) are GENERATED from the library — run `npm run generate:registry` after editing; never hand-edit them. Shared agent-facing docs live in `library/references/`; test specs at top-level `tests/`.
2. **Claude auto-discovery** — `~/.claude/skills/` (currently 7 skills, written here by `summer skills install --as-claude-skill`).
3. **Web-app stores** — `~/development/PublicSummerEngine/src/lib/ai/skills/` and `public/knowledge/summer/skills/`. Mirror only if the learning applies to the web chat agent too — check what's there before assuming.
4. **The active game** — read it as ground truth. Working code from the real project beats invented examples.

## What to do, in order

1. **One short sentence to the user.** "Capturing learnings from this session into the skill library." That's it. No plan dump.

2. **Probe the stores.** Glob each path above. Note what exists and what's empty. Print a tight summary (one line per domain with skill count).

3. **Recap the session.** Look back over the conversation. Pull out the learnings that are non-obvious AND general — things a future agent or user would benefit from but couldn't derive from reading the codebase. Examples that count:
   - A working shader (the actual code) → `visual-effects`
   - A GDScript idiom that beat the obvious approach → `scripting-patterns`
   - A UI layout that survived the design pass → `ui-and-ux`
   - A bug + root cause + fix that wasn't in any docs → `debugging`
   - A Godot 4.6 quirk (type inference, `.keys()` weirdness, signal gotchas) → `scripting-patterns`
   - A spawning/AI/enemy pattern that worked → `ai-and-npcs` or `gameplay-mechanics`
   - A perf fix with measured before/after → `performance`
   - An asset-creation workflow that beat alternatives → `asset-pipeline`

   Examples that DON'T count:
   - One-off code with no general lesson
   - Stuff already documented in `CLAUDE.md` or an existing skill
   - Personal preference with no reasoning behind it
   - Anything you have to manufacture to fill space

4. **Decide placement.** For each learning:
   - **Update existing skill** — name the file, quote the section, draft the addition.
   - **Create new skill** — pick the domain, name the file, draft the full skill markdown.
   Match the format of existing skills in the same domain exactly. Read one if you're unsure.

5. **One tight pause for the user.** Five-to-ten lines max: what files you'll touch, what each one captures, what gets left out. Wait for OK or redirect. Don't ask multiple questions.

6. **Apply.**
   - Write/edit skills under `library/skills/<slug>/` (`resource.yaml` + `SKILL.md`).
   - Then run `npm run generate:registry` — it regenerates `registry/generated/` and every plugin manifest (`.claude-plugin/`, `.codex-plugin/`, `.cursor-plugin/`, …). Do not hand-edit manifests or generated registry files.
   - If the skill belongs in the curated Claude set, also write it to `~/.claude/skills/<name>/` so it's live in the current session — and tell the user to consider adding it to the CLI's default install set.
   - If the learning applies to the web chat agent, mirror to `PublicSummerEngine` skill stores too.
   - Run `git status` in `~/development/SummerEngine` (and `PublicSummerEngine` if touched) so the diff is visible.

7. **Report.** One short message. Files changed, the future-agent payoff in one sentence per skill, and what (if anything) is still uncaptured.

## Style rules — non-negotiable

- **Tight. No slop. No glazing.** Mathias hates filler.
- **Capture the why, not just the what.** "Use X" rots. "Use X because Y breaks under Z (we hit this in PRUT chest reveal, 2026-05)" survives. Always lead skill updates with the reason.
- **Real working code from the active project beats invented examples.** Lift from PRUT or whatever we were in.
- **VFX is code** — shaders + GDScript + node setup. Never image-generation pipelines or Meshy prompts.
- **No em dashes** (—) in any user-facing copy you write into skills. Use periods or restructure the sentence.
- **`[SUMMER]` markers on core Godot engine file edits** — but skill `.md` files don't need them.
- **Verify before claiming.** If a skill says "Summer Engine does X" or "Stripe is configured Y way", verify in the actual code/DB before writing it down.

## When there's nothing worth capturing

It's totally fine to come back with "session was tactical, no durable learnings worth a skill update." Don't manufacture skills from thin air. Better to ship nothing into the skill library than ship noise.
