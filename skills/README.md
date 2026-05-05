# Summer Skill Library

The canonical agent-readable game-dev knowledge source for Claude Code, Cursor, Codex, and Windsurf.

When an agent is asked to make a game in Godot, this is what it reads to learn how.

## Layout

```
skills/
├── README.md                  # this file
├── catalog.yaml               # canonical registry (name, category, status, template-id)
├── _shared/                   # cross-skill references every skill can link
│   ├── godot-version.md
│   ├── mcp-tools-reference.md
│   ├── collaborative-protocol.md
│   ├── template-registry.md
│   └── gd-style.md
├── _meta/
│   ├── skill-test/            # static + behavioral linter
│   ├── skill-create/          # bootstrap a new skill
│   └── skill-improve/         # eval-harness iteration
├── _tests/
│   ├── runner.md              # how /skill-test works
│   └── specs/                 # behavioral specs per skill
└── <category>/<skill>/
    ├── SKILL.md               # < 500 lines, frontmatter + body
    ├── references/            # loaded on demand
    ├── examples/              # working snippets
    └── tests/spec.md          # behavioral spec
```

## Categories (20)

`character-controllers`, `gameplay-mechanics`, `scripting-patterns`, `scene-and-project`, `rendering-and-lighting`, `shaders`, `visual-effects`, `post-processing`, `animation`, `audio`, `physics`, `multiplayer-and-networking`, `ai-and-npcs`, `level-design`, `performance`, `ui-and-ux`, `asset-pipeline`, `input-and-controls`, `debugging`, `deployment`.

## Standard

Adopts the **Anthropic Agent Skills open standard** (`agentskills.io`). Frontmatter:

```yaml
---
name: <kebab-case>
description: <when-to-use, key trigger phrases first>
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: <one of the 20>
template-id: <optional, resolved against _shared/template-registry.md>
allowed-tools: Read Grep summer_add_node summer_set_prop ...
paths: ["**/*.gd", "**/*.tscn"]
---
```

Cross-portable. Cursor / Codex / Windsurf understand the same SKILL.md.

## Authoring rules

1. **SKILL.md ≤ 500 lines.** Push detail into `references/`. Progressive disclosure.
2. **MCP-preferred + file-edit-fallback.** Every code-touching skill must show both paths so the skill works without Summer MCP installed.
3. **Collaborative protocol.** "May I write…?" before any user-visible mutation. See `_shared/collaborative-protocol.md`.
4. **Template cross-link.** When a working starter exists, link via `template-id` and the section "Want a working starter?".
5. **Test spec.** Every non-`_meta` skill ships `tests/spec.md` with at least one Test Case.

## Adding a new skill

```
/skill-create
```

(See `_meta/skill-create/SKILL.md`.)

## Testing

```
/skill-test <name>           # static lint
/skill-test <name> spec      # behavioral spec runner
/skill-test audit            # whole-library audit
/skill-improve <name>        # parallel-eval harness for iteration
```

(See `_meta/skill-test/SKILL.md` and `_tests/runner.md`.)

## Roadmap

Status legend in `catalog.yaml`:

- **HAVE** — ships today.
- **NEXT** — next wave, in active development.
- **LATER** — on roadmap.

Currently: **7 HAVE / ~50 NEXT / ~30 LATER ≈ 85 skills across 20 categories**. Subagents fill content category by category.

## See also

- [Architecture spec](../../../publicsummerengine/Docs/superpowers/specs/2026-05-05-skill-library-architecture.md) (lives in publicsummerengine for spec history)
- [Research notes](../../../publicsummerengine/Docs/superpowers/research/2026-05-05-skill-library-research.md)
