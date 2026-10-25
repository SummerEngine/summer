---
name: navigate-summer
description: "Open a Summer page or editor view for the person: studio.open, and engine.view_set while you work."
license: MIT
compatibility: [Cursor, Claude Code, Codex, Windsurf, Gemini, OpenCode, Factory, Copilot]
category: _meta
user-invocable: true
allowed-tools: summer_call summer_get_project_context summer_is_running summer_view_set summer_frame_shot
paths: ["**/project.godot", "**/*.tscn", "**/.summer/**"]
---

# navigate-summer — land the user exactly where they want to look

## Overview

Summer has two surfaces the user looks at: **summerengine.com** (Studio, games, billing, templates, guides, docs) and the **Summer Engine editor** (scenes, nodes, docks). `studio.open` — the same behavior as `summer open <target>` in a shell, run by the Summer MCP on this computer — takes an intent ("billing", "my games", "the scene I'm editing", "res://player.gd") and opens the exact page or panel, or prints the URL / engine op so you can hand it over. The **product map** reference (`summer_docs_read` id `reference/product-map`) is the full table of destinations with their intent phrases, required context, and what the user will see.

A call written `studio.open({...})` is `summer_call({ op: "studio.open", input: {...} })` (3.x name: `summer_open`). The fields below are in the answer's `result`.

Rigid skill: follow the rules below exactly.

## The one decision: open a surface, or act?

| The user wants to… | Do |
|---|---|
| **see / check / decide** — plan and billing (money), their published games and releases, usage, pricing, the MCP setup guide for their agent, docs, the scene or node you just built ("show me") | **Open the surface** with `studio.open` |
| **get a result** — add a node, set a property, import an asset, run the game, publish | **Act through Summer tools** (mutation tools, `summer_play`, `store.publish`); do not click through the editor by hand to do what a tool does |
| **both** ("add a camera and show me") | act first, then open the scene / select the node so the user sees the result |

Never open a browser or switch the editor's tab as a side effect of building. Opening a page or panel is a user-visible action — do it because the user asked to look, and say what will open before it opens. Playing the game and taking screenshots to check your own work is different: that is allowed and expected (`summer_play`, then `summer_screenshot` or `summer_frame_shot`).

## How to call it

1. **Resolve first when unsure.** `studio.open({ target: "change my plan", open: false })` returns the matched target, the URL (and `login_url` if login is required), or the engine op — nothing opens. If `action` is `ambiguous`, pick from `matches` and call again with the `id`.
2. **Open.** `studio.open({ target: "billing" })` opens the browser at Studio → Billing. `studio.open({ target: "scene", params: { path: "res://levels/level_1.tscn" } })` opens the scene in the running editor. `studio.open({ target: "node", params: { node: "Player/Camera3D" } })` selects the node. `studio.open({ target: "res://player.gd" })` routes by extension.
3. **Fill the slots the target declares.** `game` needs `params.gameId` (and an optional `section` such as `builds`, `releases`, `store-page`, `analytics`); `mcp-guide` takes `params.guide` as an agent name (`cursor`, `claude-code`, `codex`, `gemini`, …); `profile` takes `username`; `changelog` takes `version`.
4. **List when you do not know the id.** `studio.open({})` returns every target with `surface`, `status`, and `requires`. In a shell: `summer open --list`.

## Read the result honestly

- `action: "opened"` — say what opened, in one line ("Opened Studio → Billing in your browser.").
- `logged_in: false` with `login_url` — the login page opened with `returnUrl` set; tell the user the destination loads after sign-in.
- `action: "engine_not_running"` — nothing opened. Tell the user to start Summer Engine (`summer run <project>`) or open the project in the desktop app, then offer to retry. Do not fall back to editing files.
- `action: "unsupported"` (`failure_reason: engine_lacks_op`) — this Summer Engine build cannot open that surface (it predates the `Navigate` op, or does not advertise that id). Say so plainly, tell the user to update Summer Engine, and describe what to open by hand. Never claim it opened.
- `action: "ambiguous"` — show the top matches by title and ask, or pick the obvious one and say which you picked.
- `action: "not_found"` — the intent is not a Summer destination (or a `res://` path tried to escape the project). Do not invent a URL; the tool only opens summerengine.com and its subdomains.
- `action: "open_failed"` — this machine could not launch a browser (headless, no display). Nothing opened; paste the `url` for the user.
- `action: "blocked_origin"` — the configured gateway is not a Summer origin; nothing opened. Tell the user to check `gateway.url` / `SUMMER_GATEWAY_URL`.

## When to hand over a link instead

Use `open: false` (CLI: `--print`) and paste the `url` (or `login_url`) when the session has no browser (headless, remote, CI), when the user asked for a link, or when opening would interrupt what the user is doing. A link the user clicks is always acceptable; a browser window that appears unasked is not.

## Editor targets

The editor owns its own table of destinations (the `Navigate` op) and tells the tool which ids it can open. `studio.open({})` lists every editor id with `availability`: `available` (Navigate op), `legacy` (an older engine serving it through its original op), `unavailable` (update Summer Engine), `unknown` (engine not running). Ids: `scene` (default = the project's main scene), `main-scene`, `node`, `script` (with `line`), `file`, `files`, `scene-tree`, `inspector`, `import-dock`, `signals-dock`, `changes-dock`, `screen-2d/3d/script/game/assetlib`, `viewport-show/hide`, `assistant`, `project-settings`, `editor-settings`, `output`, `debugger`, `editor-window`. On a legacy engine, `script` opens without taking focus — mention it if the user does not see it.

## While you work: what to open when

When you drive Summer Engine from outside (Claude Code, Codex, Cursor, the `summer` CLI), the person is not using the in-app chat. The editor is their window onto your work. A line at the bottom of it names your app and says what you are doing ("Claude Code · Placing 12 trees"). You choose what they see with `engine.view_set` (3.x `summer_view_set`): `view` (`3d`, `2d`, `script`, `game`, `chat`, `home`, `studio`), optional `rail` (`scene`, `inspector`, `files`, `output`, `none`), optional `focus` and optional `frame`. A node path in `focus` selects that node; a `res://` script or scene opens. `frame` lists the nodes to frame the camera on. Switching is instant and changes nothing in the game.

| You are about to… | Show |
|---|---|
| Edit a scene (place, move, remove nodes) | `{"view": "3d", "rail": "scene", "focus": "<the node or group you edit>", "frame": ["<it>"]}`; a 2D game uses `"2d"` |
| Write or fix a script | `{"view": "script", "focus": "res://<the script>.gd"}` |
| Tune one node's properties | `{"view": "3d", "rail": "inspector", "focus": "<that node>"}` |
| Playtest | `{"view": "game"}`, then play the game |
| Review how it looks | a `summer_frame_shot` of the result |
| Read errors or logs with the person | `{"view": "3d", "rail": "output"}` |
| Finish | the best view of the result: the game in `game` for gameplay work, the framed scene in `3d` or `2d` for level and art work, the script for code-only changes |

- Open the view before the first edit of a step, so the person watches the change happen.
- Focus what you change, not the scene root; for a group, focus its parent.
- Make one call when the kind of work changes, not one per edit.
- End on the result, never on an empty or unrelated view.
- When the person is using the in-app chat, let them choose the view.

## Anti-patterns

- Opening `billing` or `pricing` when the user asked about a **feature**, not money.
- Opening the scene in the editor **before** the change landed ("show me" comes after the mutation and its screenshot).
- Guessing a `gameId`. Open `my-games` and let the user pick, or read the id from a URL they gave you.
- Describing a page you did not open. If `ok` is false, the user saw nothing.

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@4.9.0` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `summer_docs_read` | `summer docs read` |
| `summer_frame_shot` | `summer engine frame-shot` |
| `summer_get_project_context` | `summer engine get-project-context` |
| `summer_is_running` | `summer engine is-running` |
| `summer_play` | `summer engine play` |
| `summer_screenshot` | `summer engine screenshot` |
| `engine.view_set`, `summer_view_set` | `summer engine view-set` |
| `store.publish` | `summer store publish` |
| `studio.open`, `summer_open` | `summer studio open` |
<!-- /shell-commands -->
