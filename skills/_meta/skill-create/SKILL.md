---
name: skill-create
description: Use when a contributor wants to add a new skill to the Summer library — bootstraps the canonical folder structure, frontmatter, and stub sections. Trigger on "create skill", "add skill", "new skill", "scaffold a skill".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: _meta
allowed-tools: Read Write Glob Grep
---

# /skill-create — Bootstrap a New Skill

## Steps

### 1. Get the basics

Ask the user:
- **Name** (kebab-case, ≤ 64 chars). Example: `state-machine-patterns`.
- **Category** (one of the 20 in `catalog.yaml`). Example: `scripting-patterns`.
- **One-sentence description** for the frontmatter.
- **Template-id** (optional). Lookup against `_shared/template-registry.md`.

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
template-id: <optional template-id from _shared/template-registry.md>
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
→ **Repo**: <github URL from _shared/template-registry.md>
→ **Bootstrap**: `summer template clone <template-id> my-game`

## See also

- `_shared/godot-version.md`
- `_shared/mcp-tools-reference.md`
- `_shared/gd-style.md`
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

### 5. Register in catalog.yaml

Append:

```yaml
  - name: <name>
    category: <category>
    status: NEXT  # or HAVE if shipping immediately
    template-id: <or omit>
    public: true
    recommended: false  # flip to true when status: HAVE and tested
```

### 6. Run /skill-test in static mode

Confirm the new skill passes the 7 structural checks before commit.

## Collaborative protocol

This skill writes files (the new skill folder + catalog update). Always ask before each write step.

## See also

- `_shared/collaborative-protocol.md`
- `_meta/skill-test/SKILL.md`
- `catalog.yaml`
