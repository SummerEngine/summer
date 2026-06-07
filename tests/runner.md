# Skill Test Runner

> How `/skill-test` and `/skill-improve` actually work in this repo. Read this if you're authoring a behavioral spec or trying to understand the test pipeline.

## Architecture

```
skills/
├── workflow/skill-test/SKILL.md        # the linter + spec runner (3 modes)
├── workflow/skill-improve/SKILL.md     # the eval harness for iteration
└── tests/
    ├── runner.md                    # this file
    ├── specs/
    │   └── <skill-name>.md          # behavioral specs, one per non-_meta skill
    └── runs/                        # generated, gitignored
        └── <skill-name>/
            ├── baseline/
            └── proposed/
```

## What a spec looks like

Every spec at `tests/specs/<skill-name>.md` has:

- A `## Fixture` block describing the starting state and tool availability.
- One or more `## Case <N>: <Happy | Failure | Edge>` blocks.
- Each Case has `**Input:**`, `**Expected MCP tool sequence:**`, and `**Assertions:**` (markdown checkboxes).

Reference: `tests/specs/fps-controller.md` (canonical example).

## Static linter (cheap, every commit)

Run by `/skill-test <name>` in `static` mode. Pure markdown reasoning — no subagents, no tool calls.

The 7 checks live in `workflow/skill-test/SKILL.md` § "Mode: static". Re-read that for the canonical list.

## Spec runner (medium, weekly)

Run by `/skill-test <name>` in `spec` mode. Reads SKILL.md and the matching spec, reasons over the assertions. No execution.

This catches drift between what the skill says and what its spec demands. It does not catch agent variation — for that, use `/skill-improve`.

## Eval harness (expensive, on-demand)

Run by `/skill-improve <name>`. Spawns parallel `Task` subagents with the current SKILL.md vs. proposed SKILL.md. Compares outputs against assertions. Decides which wins. Writes results to `tests/runs/<name>/`.

Use this when:
- A skill consistently fails its spec but you can't tell why from reading it.
- You're rewriting a skill and want a regression baseline.
- A skill is critical (in the `--recommended` install set) and overdue for an audit.

## Authoring a spec

Five-minute job per skill. Copy this template:

```markdown
# Skill Spec: /<skill-name>

## Fixture
- <starting state of the project / scene>
- Available tools: Summer MCP <yes|no>, host file edits <yes|no>

## Case 1: Happy Path
**Input:** "<the most common user prompt that should trigger this skill>"

**Expected MCP tool sequence (in order):**
1. summer_<tool>(...)
2. summer_<tool>(...)

**Assertions:**
- [ ] <observable outcome 1>
- [ ] <skill asks "May I" before any user-visible write>
- [ ] <skill never calls the silent-fail anti-pattern>

## Case 2: Failure Path
**Fixture:** <something missing or already present that should change behavior>
**Input:** "<edge prompt>"
**Expected:** <how the skill should adapt — clarify, defer, fail-safe>

## Case 3: Edge Case
**Fixture:** ...
**Input:** "<unusual prompt>"
**Expected:** ...
```

Aim for 2–4 cases per skill. More than 4 = the skill is doing too much and should be split.

## After a successful run

A successful `/skill-improve` ships the new version directly to the SKILL.md. Manifest drift is caught on every CI run by `plugin-manifests.test.ts`.
