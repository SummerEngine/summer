---
name: skill-test
description: "Lint a Summer skill before commit, audit the whole library, or check a behavioral spec assertion — static structural rules plus behavioral specs."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: workflow
allowed-tools: Read Glob Grep
---

# /skill-test — Validate a Summer Skill

Three modes. Pick by the user's intent.

## Mode: `static` — Structural lint (default for "test this skill")

For a single skill at `library/skills/<slug>/`, run these checks:

1. **Frontmatter completeness.** `name`, `description`, `license`, `compatibility`, `category` present. `name` matches the directory name.
2. **SKILL.md length.** ≤ 500 lines (progressive disclosure: push detail into references).
3. **MCP-preferred + file-edit-fallback.** If the skill mutates scenes or resources, body must show both:
   - At least one `summer_*` MCP tool example.
   - At least one file-edit fallback block (e.g., raw `.tscn` snippet) OR an explicit "no fallback for this — Summer MCP required" note.
4. **Collaborative protocol.** If the skill triggers user-visible writes, body must contain at least one of: `May I`, `I'm about to`, `Continue?`, `OK?`, `Proceed?`. Skills that only inspect/read are exempt.
5. **Template-id resolved.** If the skill's frontmatter declares `template-id: <id>`, that id must exist in the template registry: `library/templates/<id>/resource.yaml` (see `library/templates/README.md`).
6. **Behavioral spec.** If the skill has a spec (`evals/skills/specs/<slug>.md` or `tests/spec.md` in the skill folder), it has at least one `## Case` heading. A missing spec is a WARN, not a FAIL.
7. **Links stay inside the skill folder.** Every relative link (`](./references/...)`, `](./examples/...)`) must point at an existing file in the skill's own folder (FAIL if broken). `summer setup` copies each skill folder alone, so a path that climbs out of it (`../`) breaks after install: name a shared reference by its library id (`summer_docs_read` id `reference/<slug>`) and another skill by its bare slug (`design-mechanic`).

Output:

```
skill: <slug>
  PASS  (1) frontmatter complete
  PASS  (2) length 217 / 500 lines
  FAIL  (3) no MCP-preferred example found in body
  PASS  (4) collaborative protocol present
  PASS  (5) template-id resolved
  PASS  (6) behavioral spec has cases
  PASS  (7) all relative links resolve

6 PASS / 1 FAIL — fix item 3 before commit.
```

## Mode: `spec` — Behavioral spec runner

For a single skill, read both `library/skills/<slug>/SKILL.md` and `evals/skills/specs/<slug>.md`. For each `## Case` in the spec:

1. Lay out the **Fixture** (starting state, available tools).
2. Read the **Input** (user prompt).
3. Reason: given the skill's instructions and this fixture, would the agent follow the **Expected MCP tool sequence**?
4. For each assertion under `**Assertions:**`, mark `[x]` if the skill's instructions would satisfy it, `[ ]` if not, with a one-line reason.

Output: an annotated copy of the spec with assertions filled in, plus a pass-rate.

No code execution; this mode reasons over text only.

## Mode: `audit` — Whole library report

List `library/skills/*/SKILL.md`. For each skill:

1. Run `static` mode on the skill.
2. Note any `last-tested:` field in the SKILL.md frontmatter (optional).
3. Flag skills failing static checks.

Output: a table with PASS / FAIL counts and a punch list of skills needing attention.

## When to use which mode

| User said | Mode |
|---|---|
| "test the fps-controller skill" | static |
| "lint this skill" | static |
| "does this skill actually do what it should?" | spec |
| "run the behavioral check" | spec |
| "audit the skill library" | audit |
| "what skills need work" | audit |

## Collaborative protocol

This skill is **read-only**. It never writes. No "May I" needed.

## See also

- `summer_docs_read` id `reference/collaborative-protocol`
- the template registry: `library/templates/<id>/resource.yaml` (see `library/templates/README.md`)
- `tests/runner.md`
- `evals/skills/specs/` — per-skill behavioral specs

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@latest` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `summer_docs_read` | `summer docs read` |
<!-- /shell-commands -->
