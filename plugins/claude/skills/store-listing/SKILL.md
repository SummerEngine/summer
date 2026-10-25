---
name: store-listing
description: "Write a Summer Games store page: title, tagline, descriptions, tags, what never to write."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: deployment
user-invocable: true
allowed-tools: summer_docs_read
---

# /store-listing — store listing

This skill covers the store page text per flow (desktop and mobile): targets, title, tagline, descriptions, tags, and what never to write.

Its current text lives on the hosted Summer Engine MCP, the same text the Studio agent reads, so it changes with the store and is never stale here. Load it before you act:

1. `summer_docs_read` with id `skill/store-listing` returns the current text when this machine is signed in (`summer login`).
2. A host that shows MCP prompts or resources has it as the `store-listing` prompt and the resource `summer://skills/store-listing`.
3. Without a store sign-in: https://docs.summerengine.com/llms.txt lists every docs page; fetch any page as .md.

The one rule to keep even before you load it: Never invent features, modes, player counts, awards or prices.

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@4.9.0` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `summer_docs_read` | `summer docs read` |
<!-- /shell-commands -->
