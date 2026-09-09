---
name: mcpupdate
description: "Use when improving or maintaining the Summer Engine CLI, its MCP tools (summer_* / \"ops\"), or its prompt-engineering skills based on a real working session. Examples: the user types /mcpupdate, says \"mcpskillify this\", \"log this as a skill/example\", \"this <feature> feels great, capture it\", or notes that an agent went down a bad path with the Summer tools/skills and the prompts should be fixed. Works from ANY chat, not just inside the summer-cli repo."
---

# mcpupdate: turn a session into improvements to the Summer CLI / MCP / skills

## What this is
A bridge from *using* Summer Engine (in any game-project chat) back to *improving* it.
When a session reveals something, such as a pattern that worked beautifully or prompt-engineering
that sent the agent down a bad path, capture it into the CLI's tools, skills, or docs so the
next agent benefits. Invokable from any chat; it jumps to the right repo files directly.

## Where everything lives (skip the scanning)
This skill lives in the **summer-cli** repo (the CLI + MCP + skills), normally at
`<SummerEngine checkout>/tools/summer-cli/`. Paths below are relative to that repo root.

- `src/mcp/tools/*.ts`: the `summer_*` MCP tool definitions ("ops": scene/asset/project/etc.)
- `../../references/mcp-tools-reference/mcp-tools-reference.md`: human-readable tool reference
- `src/mcp/tools/project-tools.ts` + `docs/MCP_FRESH_CHAT_PLAYBOOK.md`: the **agent playbook** returned by `summer_get_agent_playbook` (startup flow / defaults that steer agents)
- `src/lib/skills-registry.ts`: how skills are discovered/surfaced to the agent
- `skills/<category>/<name>/SKILL.md`: the **prompt-engineering skills** (e.g. `character-controllers/fps-controller`, `scene-and-project/make-game`, `level-design/design-level`, `visual-effects/*`)
- `_persona/summer/SKILL.md`: the Summer persona
- `skills/workflow/{skill-create,skill-improve,skill-test,gameskill,writing-skills}/`: **use these** to author/edit Summer skills
- `commands/`, `hooks/`, `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`: slash commands, hooks, agent instructions
- `dist/` is built output: edit `src/` and `skills/`, not `dist/`

**Public docs (separate Mintlify repo, the org `docs` repo, often a sibling checkout):** `docs.json` (nav), `cli/overview.mdx`, `ai-tools/operations.mdx`, `ai-tools/rag-search.mdx`, plus `guides/`, `api-reference/`, `art-system/`.

> summer-cli changes are committed in **this repo** (the SummerEngine checkout), not in a game-project repo.

## Public surface sync checklist

Run this checklist when a tool, skill, setup target, license sentence, or count changes. Public trust is damaged more by obvious drift than by modest numbers.

1. Count MCP tools from source:

```bash
rg "server\\.tool\\(" src/mcp/tools -g '*.ts' -g '!*.test.ts' | wc -l
```

2. Count skill surfaces separately. Do not collapse them into one public claim unless the sentence explains which surface it means:

```bash
find skills -name SKILL.md | wc -l
npm run build
node -e "import('./dist/lib/skills-registry.js').then(m=>{const r=m.SKILL_REGISTRY||[]; console.log({registry:r.length,recommended:r.filter(s=>s.recommended).length})})"
```

3. Update the CLI repo surfaces that readers and agents scan:
   - `README.md`
   - `.claude-plugin/plugin.json`
   - `.codex-plugin/plugin.json`
   - `AGENTS.md`
   - `GEMINI.md`
   - `../../references/mcp-tools-reference/mcp-tools-reference.md`
   - `docs/DEVELOPMENT.md`
   - `docs/SKILLS.md`

4. Update sibling public docs and website surfaces when present:
   - `docs` Mintlify pages, especially `cli/overview.mdx`, `ai-tools/operations.mdx`, `api-reference/`, and setup guides
   - `PublicSummerEngine` guide data, `llms.txt` routes, README, and any blog post that mentions counts or openness
   - `summer-strategy` if the change affects positioning, licensing, or launch strategy

5. Prefer durable copy:
   - Say "Summer agent layer" for this repo in prose.
   - Say "`summer-engine` npm package" for the package.
   - Say "Summer Engine app" for the closed desktop engine.
   - Avoid brittle skill totals in public copy unless generated in the same change.
   - Avoid red-looking doctor payloads in public README examples. Explain remediation without showing a scary JSON blob.

## How to run it
1. **Confirm the target.** Restate in one line what should change and which bucket it is:
   1) **CLI / MCP tool behavior**, 2) **a skill (prompt-engineering)**, or 3) **logging a session learning** (good pattern to example, or bad path to fix). Ask only if genuinely ambiguous.
2. **Open the exact file from the map above**. Do not scan the tree.
3. **Make the change** using the existing maintenance skills:
   - New skill: `library/skills/skill-create`. Edit/append: `library/skills/skill-improve`. Game-dev win: `library/skills/gameskill`.
   - Tool behavior / playbook: edit `src/mcp/tools/*.ts` and/or `docs/MCP_FRESH_CHAT_PLAYBOOK.md`; keep `../../references/mcp-tools-reference/mcp-tools-reference.md` in sync. Check `src/mcp/tools/project-tools.test.ts` still passes.
   - Public-facing change: update the matching file in the `docs` repo.
4. **Keep it concrete**. Every captured pattern gets a real, runnable code block (below), not prose.
5. **Verify + commit.** If you touched `src/`, run `npm test`. Commit on a branch and summarize.

## "mcpskillify": capture a working pattern as an example
Trigger: *"this player movement feels great, mcpskillify it"*, *"log this as how to do X"*.

1. Identify the smallest self-contained code that produced the good result (the actual GDScript/C# from the session).
2. Find the matching skill via the map (movement to `character-controllers/fps-controller`; a mechanic to `gameplay-mechanics/design-mechanic`; none fits to `skill-create` a new one in the right category).
3. Append a focused example: what it does, the code, and *why it feels good* (the tunables). Shape:

````markdown
## Example: snappy first-person movement (proven)
WHY it feels good: instant accel + short coyote time + air control; no float.

```gdscript
const SPEED := 6.0
const ACCEL := 60.0          # high accel = snappy, no slide
const COYOTE := 0.12         # forgiving jump after leaving a ledge
func _physics_process(delta):
    var dir := (transform.basis * Vector3(input.x, 0, input.y)).normalized()
    velocity.x = move_toward(velocity.x, dir.x * SPEED, ACCEL * delta)
    velocity.z = move_toward(velocity.z, dir.z * SPEED, ACCEL * delta)
    move_and_slide()
```
````

Keep one excellent example per pattern. Port it, don't pile on variants.

## The behavior the skills/playbook should teach (the doctrine)
Target agent workflow for building in a Summer project. When `/mcpupdate` reviews the playbook
and skills, make them teach this, and flag where they don't:

1. **Understand** what the user wants (one pass, no tool spelunking first).
2. **Outline** the plan fast and briefly; proceed once it's clearly right.
3. **Execute through Summer's identity-bound tools**. Write GDScript by default (C# only if the project already uses it). Read and mutate `.gd`/`.tscn`/`.tres` with `summer_read_file`, `summer_replace_text`, or guarded `summer_write_file`.
4. **Play & auto-iterate**. Run the scene/game, read console + script/debugger errors, fix, repeat until clean. Crucially: **play the scene you just made first**, so boot/parse crashes surface immediately instead of after the user navigates to the feature.

## Known bad path to fix first (from real sessions)
The MCP playbook over-steered agents into **ops-first** scene editing (open/save-as/inspect/
instantiate) when plain **file editing** is simpler and safer for a headless agent, causing
wasted turns, scene "rename"/save-as churn, and editor-tab clobbering. Keep these fixed:

- **Guarded files for `.tscn`/`.tres`:** use identity-bound MCP text tools for complete-file work;
  use scene ops for live hierarchy/inspector changes, navmesh/light bake, play/observe, runtime
  inspection, or instancing. New files are create-only; overwrites require a read sha256.
- **External-host limitation:** host tools can still bypass these guards. Flag any doctrine that
  recommends doing so while MCP is available.
- **Constraint-based flow:** the playbook's flow is conditional (`buildFlow` for the default,
  `liveEngineFlow` only when you need the running engine), not a prescriptive always-open-the-editor loop.

## Red flags this skill is being skipped
- You started scanning the engine repo to find the CLI: use the map above.
- You captured a "great" pattern as prose with no runnable code: add the code block.
- You edited `dist/`: edit `src/`/`skills/` instead.
- You committed CLI changes in a game-project repo: commit in the SummerEngine checkout.
