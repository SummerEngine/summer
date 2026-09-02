---
name: skill-improve
description: Use when a contributor wants to upgrade a Summer skill that is underperforming or to fix a regression — runs the skill against a behavioral spec with and without proposed changes via parallel-eval harness and ships the version that wins. Trigger on "improve skill", "iterate on skill", "make this skill better".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: workflow
allowed-tools: Read Write Edit Task
---

# /skill-improve — Iterate on a Skill With Eval Harness

Inspired by `anthropics/skills` `skill-creator/`. Use when a skill's behavioral spec is failing assertions or producing low-quality output.

## When to use this vs. `/skill-test`

- `/skill-test spec` reasons over text. Cheap, fast, lossy.
- `/skill-improve` actually runs the skill in parallel subagents with-vs-without proposed changes. Expensive, accurate.

Run this when `/skill-test spec` flags issues you can't fix by reading the skill alone.

## Steps

### 1. Pick the skill + the spec

Ask the user:
- **Skill name.** Resolves to `skills/<category>/<name>/SKILL.md`.
- **Test cases to focus on.** Default: all `## Case` blocks in `tests/specs/<name>.md`.

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

> Proposed version wins 2 cases, ties 1, loses 0. May I overwrite `skills/<category>/<name>/SKILL.md` with the proposed version?

### 6. Ship

On user yes:
- Overwrite `SKILL.md`.
- Commit with message `feat(skill): improve <name> — <one-line summary of change>`.

## Collaborative protocol

This skill writes files at multiple steps. Always ask before each write.

## See also

- `workflow/skill-test/SKILL.md`
- `tests/runner.md`
- `tests/specs/`
