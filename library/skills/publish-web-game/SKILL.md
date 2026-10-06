---
name: publish-web-game
description: "Export a browser build from Godot, Unity, Phaser/Vite, plain HTML5 or Construct and publish it to summer.games in one confirmed step with summer publish-web."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: deployment
user-invocable: true
allowed-tools: Read Glob Bash summer_publish_web_game
paths: ["index.html", "export_presets.cfg", "vite.config.*", "package.json"]
---

# /publish-web-game — Put a Web Game on summer.games

## Overview

summer.games hosts HTML5 games. You give it one folder (or `.zip`) with
`index.html` at the root; the Summer CLI checks it with the store's own rules,
uploads it, waits for the server to process it, and submits the listing for
review. New games appear after review; an update to an already published game
is what players get as soon as the new build is ready.

**Core principle:** export a correct web build first, then publish it once,
with the user's explicit approval of the exact folder and game.

## 1. Export the web build

The build folder must contain `index.html` at its root and load everything with
**relative paths**. Limits: 500 MiB total, 2,000 files, 200 MiB per file.

| Engine | Export | Check before publishing |
|---|---|---|
| Godot 4 / Summer Engine | Project > Export > add a **Web** preset > Export Project into an empty folder, file name `index.html`. | **Thread Support off** (threaded builds cannot play on summer.games yet). Web export needs installed web export templates and a GDScript-only project; C# projects cannot export to the web. |
| Unity | File > Build Settings > **WebGL** > Build into an empty folder. | Player Settings > Publishing Settings: Compression Format Gzip, Brotli or Disabled; Decompression Fallback off. |
| Phaser / Vite / any bundler | Run the project's build script (for example `npm run build`) and use its output folder (`dist/`). | Vite: set `base: './'` in the Vite config. A root path such as `src="/assets/x.js"` is refused. |
| Plain HTML5 | The folder that holds `index.html`, scripts and assets. | Name the main page `index.html`; use relative links. |
| Construct 3 | Menu > Project > Export > **Web (HTML5)** > download the zip. | Pass the zip directly; one top-level folder inside it is fine. |

Serve the folder from a local static server once and check that the game
starts before publishing.

## 2. One-time sign-in (the user, in a terminal)

```bash
summer login --games
```

It opens the browser; the user signs in to their Summer Engine account and
clicks **Connect**. The CLI refreshes the sign-in afterwards. An agent cannot
do this step for the user.

## 3. Publish

Always do a dry run first and show the plan to the user:

- MCP: `summer_publish_web_game` with `path`, `name`, `contentRating`, `confirm: false`.
- Shell: `summer publish-web ./build --name "Space Cats" --content-rating everyone` (asks y/N in a terminal; add `--json` for scripts).

The dry run validates the build and returns the exact source, file count,
size, sha256 and target game. Only after the user approves, repeat with
`confirm: true` (shell: `--confirm`).

- First publish of a game: pass `name` and `contentRating` (`everyone`,
  `everyone10Plus`, or `teen`). The CLI reuses the user's game with that exact
  name, otherwise it creates one, and remembers the game for that build folder.
- Updates: pass the same folder again, or `gameId` (`game_...`).

## 4. Read the result

| Field | Meaning |
|---|---|
| `versionStatus: ready` | The build passed the server checks; `playUrl` is the hosted build. |
| `versionStatus: rejected` | Read `rejectionReason`, fix the export, publish again. |
| `versionStatus: processing` | Still processing after the wait; run the same command again later to submit. |
| `review.outcome: submitted_for_review` | New game sent to review; it appears on its store page after approval. |
| `review.outcome: live` | The game is already published; the new build is what players get. |
| `review.outcome: needs_content_rating` | Run again with `contentRating`. |
| `storeUrl` | The public page, summer.games/games/(gameId). |

## Common failures

| Code | Fix |
|---|---|
| `games_login_required`, `not_signed_in` | The user runs `summer login --games` (add `--force` to sign in again). |
| `web_build_missing_index` | Pass the folder that directly contains `index.html`. |
| `web_build_root_absolute_path` | Rebuild with relative paths (Vite `base: './'`). |
| `web_build_threads_unsupported` | Godot: export again with Thread Support off. |
| `web_build_too_large`, `web_build_too_many_files` | Compress or pack assets. |
| `games_store_unavailable` | Web uploads are not enabled on that server yet; nothing to fix locally. |
| `games_token_audience_mismatch` | Server configuration problem; report it, signing in again will not help. |

Never say the game is live until the result says `live`, and never publish
without the user's approval of the exact plan.
