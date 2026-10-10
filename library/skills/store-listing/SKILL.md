---
name: store-listing
description: "Write a Summer Games store page per flow (desktop, mobile): targets, title, tagline, descriptions, tags, and what never to write."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: deployment
user-invocable: true
allowed-tools: summer_read_library
---

# /store-listing — store listing

This skill covers the store page text per flow (desktop and mobile): targets, title, tagline, descriptions, tags, and what never to write.

Its current text lives on the hosted Summer Engine MCP, the same text the Studio agent reads, so it changes with the store and is never stale here. Load it before you act:

1. `summer_read_library` with id `skill/store-listing` returns the current text when this machine has a store sign-in (`summer login --store`).
2. A host that shows MCP prompts or resources has it as the `store-listing` prompt and the resource `summer://skills/store-listing`.
3. Without a store sign-in: https://docs.summerengine.com/llms.txt lists every docs page; fetch any page as .md.

The one rule to keep even before you load it: Never invent features, modes, player counts, awards or prices.
