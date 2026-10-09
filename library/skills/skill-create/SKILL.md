---
name: skill-create
description: "Bootstrap a new Summer library skill (library/skills/<slug>/ with resource.yaml and SKILL.md), frontmatter, and stub sections."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: workflow
allowed-tools: Read Write Glob Grep Bash
---

# /skill-create: bootstrap a new library skill

Works inside a checkout of the Summer repository, `summerengine/summer` (the one with `library/` and `registry/`). Outside it, capture the lesson with `gameskill` in the game project instead.

## Steps

### 1. Get the basics

Ask the user:
- **Slug** (kebab-case, 64 chars or fewer, flat: no category folders). Example: `state-machine-patterns`.
- **Domain facets**: pick from the vocabulary in `registry/schemas/domains.json` (read it, do not guess). Example: `scripting`, `gameplay`.
- **One-sentence summary** and a "Use when ..." description for the frontmatter.
- **Template-id** (optional). Look it up in `library/templates/<id>/resource.yaml`.

### 2. Create the folder

May I create `library/skills/<slug>/` with this structure?

```
library/skills/<slug>/
  resource.yaml      routing metadata (schema: registry/schemas/resource.schema.json + skill.schema.json)
  SKILL.md           the skill body
  references/        optional, populate as needed
```

### 3. Write resource.yaml (template)

```yaml
id: skill/<slug>
kind: skill
version: 1.0.0
summary: <one sentence, what and when>
use_when:
  - <situation the router should match>
  - <second situation>
do_not_use_when:
  - <situation that belongs to a neighbouring skill>
facets:
  lifecycle: [build]
  domains: [<domain>]
  modalities: [<scripts | scenes | assets | docs>]
compatibility:
  engine: ">=4.6"
related:
  skills: [skill/<neighbour>]
source: official
license: MIT
status: preview
recommended: false
```

`status: preview` until the skill has been exercised against a live engine; flip to `stable` in the same change as the evidence.

### 4. Write SKILL.md (template)

```markdown
---
name: <slug>
description: Use when <situation>. Lead with the trigger phrases.
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: <domain>
template-id: <optional>
allowed-tools: Read Grep <summer_* tools this skill uses>
paths: ["**/*.gd", "**/*.tscn"]
---

# <Title> for Summer Engine

<One paragraph: why this exists, who needs it.>

## Steps

### 1. <First step>

**Preferred (Summer MCP):**

\`\`\`
summer_<tool>(...)
\`\`\`

**Fallback (no MCP, edit `<file>` directly):**

\`\`\`
<raw text/code>
\`\`\`

May I <action>?

## Common mistakes

- <mistake, with a one-line fix>

## Want a working starter?

`summer create <template-id> my-game` (see `summer list templates` for the slugs)

## See also

- `godot-version` and `gd-style` in `library/references/`
- (related skills by bare slug)
```

Keep SKILL.md under 500 lines; push shared detail into `library/references/`. Cross-reference other skills by bare slug, never by path or `@` link.

### 5. Generate and validate

Nothing is registered by hand. Run:

```bash
npm run generate:registry
npm run validate:library
npm test
```

`generate:registry` rewrites `registry/generated/` and every plugin manifest from `library/`; `validate:library` checks the schema, facets, related links and capability lint; the test suite checks manifest parity. Commit the generated files with the skill.

### 6. Run /skill-test

Confirm the structural checks pass and, if the skill drives tools, that the routing eval still finds it (`npm run eval:routing`).

## Collaborative protocol

This skill writes files. Always ask before each write step.

## See also

- `collaborative-protocol` in `library/references/`
- `skill-test`, `skill-improve`, `gameskill`
