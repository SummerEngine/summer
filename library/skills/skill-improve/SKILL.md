---
name: skill-improve
description: "Upgrade an underperforming Summer skill — run it against a behavioral spec with and without changes via a parallel-eval harness; ship the winner."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: workflow
allowed-tools: Read Write Edit Task
---

# /skill-improve — Iterate on a Skill With Eval Harness

Adapted from the `skill-creator` skill in `anthropics/skills`. Use when a skill's behavioral spec fails assertions or the skill produces low-quality output.

## When to use this vs. `/skill-test`

- `/skill-test spec` reasons over text. Cheap and fast, but lossy.
- `/skill-improve` runs the skill in parallel subagents, with and without the proposed changes. Slower and more expensive, but accurate.

Run this when `/skill-test spec` flags issues you can't fix by reading the skill alone.

## Steps

### 1. Pick the skill + the spec

Ask the user:
- **Skill slug.** Resolves to `library/skills/<slug>/SKILL.md`.
- **Test cases to focus on.** Default: all `## Case` blocks in `evals/skills/specs/<slug>.md`.

### 2. Establish a baseline

For each Case:

1. Spawn a subagent (`Task` tool, `general-purpose`) with the **current** skill body in context.
2. Give it the Case's Input + Fixture.
3. Capture the tool calls it makes and the diff it produces.
4. Score against the Case's Assertions.

Save outputs to `tests/runs/<skill-name>/baseline/case-<N>/`.

### 3. Propose changes

Read the failing Cases. Identify the gap between what the skill says and what the agent did. Common gaps:

- Skill names a tool but the agent picked a different one (clarify the trigger).
- Skill assumes a fixture detail the agent missed (add explicit step to confirm).
- Skill's "May I" wording is too generic for the agent to infer the right ask.

Draft a revised SKILL.md. May I write it to `tests/runs/<skill-name>/proposed/SKILL.md`?

### 4. Run the proposed version

Repeat step 2 with the proposed SKILL.md. Save to `tests/runs/<skill-name>/proposed/case-<N>/`.

### 5. Compare and decide

For each Case, score:

- Assertions passed (proposed vs. baseline).
- Tool-call efficiency (fewer tools = better, all else equal).
- Hallucination / unwanted ops (penalize).

Output:

```
Case 1 (Happy):     baseline 4/6  proposed 6/6  yes ship proposed
Case 2 (Failure):   baseline 3/4  proposed 4/4  yes ship proposed
Case 3 (Edge):      baseline 3/3  proposed 3/3  = no change
```

If proposed wins on net, prompt the user:

> Proposed version wins 2 cases, ties 1, loses 0. May I overwrite `library/skills/<slug>/SKILL.md` with the proposed version?

### 6. Ship

On user yes:
- Overwrite `SKILL.md` and bump `version` in `resource.yaml`.
- Commit with message `feat(skill): improve <name> — <one-line summary of change>`.

## Collaborative protocol

This skill writes files at multiple steps. Always ask before each write.

## See also

- `skill-test`
- `tests/runner.md`
- `evals/skills/specs/`
