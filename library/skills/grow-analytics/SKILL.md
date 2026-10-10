---
name: grow-analytics
description: "Read and analyse a creator's Summer Grow numbers: store page views, launches, play sessions, play time; compare windows, flag drops."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: deployment
user-invocable: true
allowed-tools: summer_read_library
---

# /grow-analytics — grow analytics

This skill covers how to read a creator's Summer Grow numbers (store page views, launches, play sessions, play time) and analyse them: compare windows, walk the funnel, flag drops, give one next step.

Its current text lives on the hosted Summer Engine MCP, the same text the Studio agent reads, so it changes with the store and is never stale here. Load it before you act:

1. `summer_read_library` with id `skill/grow-analytics` returns the current text when this machine has a store sign-in (`summer login --store`).
2. A host that shows MCP prompts or resources has it as the `grow-analytics` prompt and the resource `summer://skills/grow-analytics`.
3. Without a store sign-in: https://docs.summerengine.com/llms.txt lists every docs page; fetch any page as .md.

The one rule to keep even before you load it: Report what the numbers show; do not guess causes the data cannot support.
