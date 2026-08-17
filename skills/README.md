# Summer Skill Library

The canonical agent-readable game-dev knowledge source for Claude Code, Cursor, Codex, and Windsurf.

When an agent is asked to make a game in Summer Engine, this is what it reads to learn how.

## Layout

```
summer-cli/
├── .claude-plugin/plugin.json    # the registry (skills: array). Sibling Codex/Cursor manifests mirror it.
├── references/                   # cross-skill shared docs (sibling of skills/)
│   ├── godot-version.md
│   ├── mcp-tools-reference.md
│   ├── collaborative-protocol.md
│   ├── template-registry.md
│   ├── summer-folder.md
│   └── gd-style.md
├── tests/
│   ├── runner.md                 # how /skill-test works
│   └── specs/                    # behavioral specs per skill
└── skills/
    ├── README.md                 # this file
    ├── workflow/                 # process skills (brainstorming, debugging, planning, etc.)
    │   ├── using-summer/
    │   ├── skill-create/
    │   ├── skill-improve/
    │   ├── skill-test/
    │   ├── brainstorming/
    │   ├── investigating-bugs/
    │   ├── verification-before-completion/
    │   ├── writing-plans/
    │   ├── dispatching-parallel-agents/
    │   ├── writing-skills/
    │   ├── playtesting-a-feature/
    │   ├── debugging-game-feel/
    │   └── diagnosing-perf-regressions/
    └── <category>/<skill>/       # gamedev domain skills
        ├── SKILL.md              # < 500 lines, frontmatter + body
        ├── reference.md          # optional, loaded on demand
        └── examples/             # optional, working snippets
```

## Categories (21)

`workflow` (process discipline) plus 20 gamedev domains: `character-controllers`, `gameplay-mechanics`, `scripting-patterns`, `scene-and-project`, `rendering-and-lighting`, `shaders`, `visual-effects`, `post-processing`, `animation`, `audio`, `physics`, `multiplayer-and-networking`, `ai-and-npcs`, `level-design`, `performance`, `ui-and-ux`, `asset-pipeline`, `input-and-controls`, `debugging`, `deployment`.

Folder structure is for humans only — Claude resolves skills as `summer:<skill-name>` regardless of category nesting.

## Standard

Adopts the **Anthropic Agent Skills open standard** (`agentskills.io`). Frontmatter:

```yaml
---
name: <kebab-case>
description: <when-to-use, key trigger phrases first>
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: <one of the 20>
template-id: <optional, resolved against references/template-registry.md>
allowed-tools: Read Grep summer_add_node summer_set_prop ...
paths: ["**/*.gd", "**/*.tscn"]
---
```

Cross-portable. Cursor / Codex / Windsurf understand the same SKILL.md.

## Authoring rules

1. **SKILL.md ≤ 500 lines.** Push detail into `references/`. Progressive disclosure.
2. **MCP-preferred + file-edit-fallback.** Every code-touching skill must show both paths so the skill works without Summer MCP installed.
3. **Collaborative protocol.** "May I write…?" before any user-visible mutation. See `../references/collaborative-protocol.md`.
4. **Template cross-link.** When a working starter exists, link via `template-id` and the section "Want a working starter?".
5. **Test spec.** Every non-`_meta` skill ships `tests/spec.md` with at least one Test Case.

## Adding a new skill

```
/skill-create
```

(See `workflow/skill-create/SKILL.md`.)

## Testing

```
/skill-test <name>           # static lint
/skill-test <name> spec      # behavioral spec runner
/skill-test audit            # whole-library audit
/skill-improve <name>        # parallel-eval harness for iteration
```

(See `workflow/skill-test/SKILL.md` and `tests/runner.md`.)

## What ships today

The `skills:` array in `.claude-plugin/plugin.json` is the registry — what ships, ships there. New skills are added via `/skill-create` (see `workflow/skill-create/SKILL.md`).

## See also

- [Architecture spec](../../../publicsummerengine/Docs/superpowers/specs/2026-05-05-skill-library-architecture.md) (lives in publicsummerengine for spec history)
- [Research notes](../../../publicsummerengine/Docs/superpowers/research/2026-05-05-skill-library-research.md)
