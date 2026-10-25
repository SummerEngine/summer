---
name: grow-analytics
description: "Read a creator's Summer Grow numbers (page views, launches, sessions, play time), compare windows."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: deployment
user-invocable: true
allowed-tools: summer_docs_read
---

# /grow-analytics — grow analytics

This skill covers how to read a creator's Summer Grow numbers (store page views, launches, play sessions, play time) and analyse them: compare windows, walk the funnel, flag drops, give one next step.

Its current text lives on the hosted Summer Engine MCP, the same text the Studio agent reads, so it changes with the store and is never stale here. Load it before you act:

1. `summer_docs_read` with id `skill/grow-analytics` returns the current text when this machine is signed in (`summer login`).
2. A host that shows MCP prompts or resources has it as the `grow-analytics` prompt and the resource `summer://skills/grow-analytics`.
3. Without a store sign-in: https://docs.summerengine.com/llms.txt lists every docs page; fetch any page as .md.

The one rule to keep even before you load it: Report what the numbers show; do not guess causes the data cannot support.

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@4.9.0` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `summer_docs_read` | `summer docs read` |
<!-- /shell-commands -->
