---
name: store-art
description: "Make Summer Games store art per slot and flow: key art, covers, icons, screenshots, trailer: size, shape, text rules, fallbacks."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: deployment
user-invocable: true
allowed-tools: summer_read_library
---

# /store-art — store art

This skill covers every store art slot per flow (desktop and mobile): size, shape, text rules, fallbacks, and why each one matters.

Its current text lives on the hosted Summer Engine MCP, the same text the Studio agent reads, so it changes with the store and is never stale here. Load it before you act:

1. `summer_read_library` with id `skill/store-art` returns the current text when this machine has a store sign-in (`summer login --store`).
2. A host that shows MCP prompts or resources has it as the `store-art` prompt and the resource `summer://skills/store-art`.
3. Without a store sign-in: https://docs.summerengine.com/llms.txt lists every docs page; fetch any page as .md.

Screenshots: `summer_capture_gameplay` takes them offscreen. Get past the title screen with the game's own flags in `args` or with `steps`, e.g. `{"args":["--autostart"],"steps":[{"wait":3000},{"shot":true},{"key":"Space"},{"wait":800},{"shot":true}]}`.

The one rule to keep even before you load it: Key art, covers and icons carry no text: the stores draw the title over them. Screenshots are real play.
