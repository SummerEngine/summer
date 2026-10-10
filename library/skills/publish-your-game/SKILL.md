---
name: publish-your-game
description: "Publish a Summer game on Summer Games through MCP: store page, art, build upload, submit, and one approval link for the owner."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: deployment
user-invocable: true
allowed-tools: summer_read_library
---

# /publish-your-game — publish your game

This skill covers the whole publishing journey: find the game, make its store page, write the text, set the art, export and upload the build, submit, and hand the owner the approval link.

Its current text lives on the hosted Summer Engine MCP, the same text the Studio agent reads, so it changes with the store and is never stale here. Load it before you act:

1. `summer_read_library` with id `skill/publish-your-game` returns the current text when this machine has a store sign-in (`summer login --store`).
2. A host that shows MCP prompts or resources has it as the `publish-your-game` prompt and the resource `summer://skills/publish-your-game`.
3. Without a store sign-in: https://docs.summerengine.com/llms.txt lists every docs page; fetch any page as .md.

The one rule to keep even before you load it: Submitting does not publish. `summer_store_submit` returns an approval link; only the owner's click sends the game to review, and review comes before live.
