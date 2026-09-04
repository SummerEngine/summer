---
name: navigate-summer
description: Use when the user wants to SEE, CHECK, or DECIDE something — "show me my billing", "where do I change my plan", "open my games", "let me look at the scene", "open the MCP guide for Cursor". Decides whether to open a Summer web page or editor surface for the user or to act through the API, and lands exactly there with summer_open.
license: MIT
compatibility: [Cursor, Claude Code, Codex, Windsurf, Gemini, OpenCode, Factory, Copilot]
category: _meta
user-invocable: true
allowed-tools: summer_open summer_get_project_context summer_is_running
paths: ["**/project.godot", "**/*.tscn", "**/.summer/**"]
---

# navigate-summer — land the user exactly where they want to look

## Overview

Summer has two surfaces the user looks at: **summerengine.com** (Studio, games, billing, templates, guides, docs) and the **Summer Engine editor** (scenes, nodes, docks). `summer_open` — the same behavior as `summer open <target>` in a shell — takes an intent ("billing", "my games", "the scene I'm editing", "res://player.gd") and opens the exact page or panel, or prints the URL / engine op so you can hand it over. The **product map** reference (`../../references/product-map/product-map.md`) is the full table of destinations with their intent phrases, required context, and what the user will see.

Rigid skill: follow the rules below exactly.

## The one decision: open a surface, or act?

| The user wants to… | Do |
|---|---|
| **see / check / decide** — plan and billing (money), their published games and releases, usage, pricing, the MCP setup guide for their agent, docs, the scene or node you just built ("show me") | **Open the surface** with `summer_open` |
| **get a result** — add a node, set a property, import an asset, run the game, publish | **Act through Summer tools** (mutation tools, `summer_play`, `summer_creator_publish`); do not open the editor to do by hand what a tool does |
| **both** ("add a camera and show me") | act first, then open the scene / select the node so the user sees the result |

Never open a browser or switch the editor's tab as a side effect of building. Opening is a user-visible action — do it because the user asked to look, and say what will open before it opens.

## How to call it

1. **Resolve first when unsure.** `summer_open({ target: "change my plan", open: false })` returns the matched target, the URL (and `login_url` if login is required), or the engine op — nothing opens. If `action` is `ambiguous`, pick from `matches` and call again with the `id`.
2. **Open.** `summer_open({ target: "billing" })` opens the browser at Studio → Billing. `summer_open({ target: "scene", params: { path: "res://levels/level_1.tscn" } })` opens the scene in the running editor. `summer_open({ target: "node", params: { node: "Player/Camera3D" } })` selects the node. `summer_open({ target: "res://player.gd" })` routes by extension.
3. **Fill the slots the target declares.** `game` needs `params.gameId` (and an optional `section` such as `builds`, `releases`, `store-page`, `analytics`); `mcp-guide` takes `params.guide` as an agent name (`cursor`, `claude-code`, `codex`, `gemini`, …); `profile` takes `username`; `changelog` takes `version`.
4. **List when you do not know the id.** `summer_open({})` returns every target with `surface`, `status`, and `requires`. In a shell: `summer open --list`.

## Read the result honestly

- `action: "opened"` — say what opened, in one line ("Opened Studio → Billing in your browser.").
- `logged_in: false` with `login_url` — the login page opened with `returnUrl` set; tell the user the destination loads after sign-in.
- `action: "engine_not_running"` — nothing opened. Tell the user to start Summer Engine (`summer run <project>`) or open the project in the desktop app, then offer to retry. Do not fall back to editing files.
- `action: "unsupported"` (`failure_reason: engine_lacks_op`) — this Summer Engine build cannot open that surface (it predates the `Navigate` op, or does not advertise that id). Say so plainly, tell the user to update Summer Engine, and describe what to open by hand. Never claim it opened.
- `action: "ambiguous"` — show the top matches by title and ask, or pick the obvious one and say which you picked.
- `action: "not_found"` — the intent is not a Summer destination. Do not invent a URL; the tool only opens summerengine.com and docs.summerengine.com.

## When to hand over a link instead

Use `open: false` (CLI: `--print`) and paste the `url` (or `login_url`) when the session has no browser (headless, remote, CI), when the user asked for a link, or when opening would interrupt what the user is doing. A link the user clicks is always acceptable; a browser window that appears unasked is not.

## Editor targets

The editor owns its own table of destinations (the `Navigate` op) and tells the tool which ids it can open. `summer_open({})` lists every editor id with `availability`: `available` (Navigate op), `legacy` (an older engine serving it through its original op), `unavailable` (update Summer Engine), `unknown` (engine not running). Ids: `scene` (default = the project's main scene), `main-scene`, `node`, `script` (with `line`), `file`, `files`, `scene-tree`, `inspector`, `import-dock`, `signals-dock`, `changes-dock`, `screen-2d/3d/script/game/assetlib`, `viewport-show/hide`, `assistant`, `project-settings`, `editor-settings`, `output`, `debugger`, `editor-window`. On a legacy engine, `script` opens without taking focus — mention it if the user does not see it.

## Anti-patterns

- Opening `billing` or `pricing` when the user asked about a **feature**, not money.
- Opening the scene in the editor **before** the change landed ("show me" comes after the mutation and its screenshot).
- Guessing a `gameId`. Open `my-games` and let the user pick, or read the id from a URL they gave you.
- Describing a page you did not open. If `ok` is false, the user saw nothing.
