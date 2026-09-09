---
name: skill-create
description: Use when a contributor wants to add a new skill to the Summer library — bootstraps the canonical folder structure, frontmatter, and stub sections. Trigger on "create skill", "add skill", "new skill", "scaffold a skill".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: workflow
allowed-tools: Read Write Glob Grep
---

# /skill-create — Bootstrap a New Skill

## Steps

### 1. Get the basics

Ask the user:
- **Name** (kebab-case, ≤ 64 chars). Example: `state-machine-patterns`.
- **Category** (must be one of the values in the `SKILL_CATEGORIES` array at `src/lib/skills-registry.ts` — read it, do not guess). Example: `scripting-patterns`.
- **One-sentence description** for the frontmatter.
- **Template-id** (optional). Lookup against the template registry: `library/templates/<id>/resource.yaml` (see `library/templates/README.md`).

### 2. Create the folder

May I create `skills/<category>/<name>/` with this structure?

```
skills/<category>/<name>/
├── SKILL.md
├── references/        (empty, populate as needed)
├── examples/          (empty, populate as needed)
└── tests/spec.md
```

### 3. Write SKILL.md (template)

```markdown
---
name: <name>
description: <one-sentence what + when. Lead with key trigger phrases.>
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: <category>
template-id: <optional template-id from library/templates/<id>/resource.yaml>
allowed-tools: Read Grep <summer_* tools this skill uses>
paths: ["**/*.gd", "**/*.tscn"]
---

# <Title> for Summer Engine

<One-paragraph context. Why this exists, who needs it.>

## Steps

### 1. <First step>

**Preferred (Summer MCP):**

\`\`\`
summer_<tool>(...)
\`\`\`

**Fallback (no MCP — edit `<file>` directly):**

\`\`\`
<raw text/code>
\`\`\`

May I <action>?

### 2. <Second step>

...

## Common mistakes

- <mistake 1, with one-line fix>
- <mistake 2, with one-line fix>

## Want a working starter?

→ **template-id**: `<template-id>`
→ **Repo**: <github URL from library/templates/<id>/resource.yaml>
→ **Bootstrap**: `summer create <template-id> my-game` (see `summer list templates` for the slugs)

## See also

- `../../references/godot-version/godot-version.md`
- `../../references/mcp-tools-reference/mcp-tools-reference.md`
- `../../references/gd-style/gd-style.md`
- (other relevant skills)
```

### 4. Write tests/spec.md (template)

```markdown
# Skill Spec: /<name>

## Fixture
- <starting state of the project>
- <which tools are available — Summer MCP yes/no>

## Case 1: Happy Path
**Input:** "<typical user prompt>"
**Expected MCP tool sequence (in order):**
1. <first tool call>
2. <second>

**Assertions:**
- [ ] <observable outcome>
- [ ] <skill asks "May I" before any write step>

## Case 2: Failure / Edge
**Fixture:** <something different>
**Input:** "<edge prompt>"
**Expected:** <how the skill should adapt>
```

### 5. Register the skill

Two files to update, both required for the skill to load in Claude Code / Cursor / Codex AND to be installable via `summer skills install`:

**5a. `.claude-plugin/plugin.json`** (and sibling manifests `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`). Append to the `skills:` array:

```json
"./skills/<category>/<name>/",
```

**5b. `src/lib/skills-registry.ts`** `SKILL_REGISTRY` array. Append a typed entry:

```ts
{
  name: "<name>",
  category: "<category>",
  public: true,
  clients: ALL_CLIENTS,
  recommended: false,
  requiresMcpTools: ["summer_<tool>", ...],
  testScenario: "<one-line scenario the skill should handle end-to-end>",
},
```

### 6. Run /skill-test in static mode

Confirm the new skill passes the structural checks before commit. The `plugin-manifests.test.ts` test will fail the build if 5a or 5b is missing.

## Collaborative protocol

This skill writes files (the new skill folder + plugin manifest update + TS registry update). Always ask before each write step.

## See also

- `../../references/collaborative-protocol/collaborative-protocol.md`
- `workflow/skill-test/SKILL.md`
