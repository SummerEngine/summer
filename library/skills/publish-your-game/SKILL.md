---
name: publish-your-game
description: "Publish a game on Summer Games through MCP: store page, art, build upload, submit, owner approval link."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: deployment
user-invocable: true
allowed-tools: summer_docs_read
---

# /publish-your-game — publish your game

This skill covers the whole publishing journey: find the game, make its store page, write the text, set the art, export and upload the build, submit, and hand the owner the approval link.

Its current text lives on the hosted Summer Engine MCP, the same text the Studio agent reads, so it changes with the store and is never stale here. Load it before you act:

1. `summer_docs_read` with id `skill/publish-your-game` returns the current text when this machine is signed in (`summer login`).
2. A host that shows MCP prompts or resources has it as the `publish-your-game` prompt and the resource `summer://skills/publish-your-game`.
3. Without a store sign-in: https://docs.summerengine.com/llms.txt lists every docs page; fetch any page as .md.

## The journey in operations

A call written `area.action({...})` is the tool `summer_area_action` when your client lists it, else `summer_call({ op: "area.action", input: {...} })`; `summer_search` finds any operation and its exact input. Engine tools keep their `summer_*` names.

1. `games.list()` finds the game; `games.create({ title, targets })` makes a new one with its first store page draft. Include `web` in `targets` so it plays in the browser. Keep the `gameId`.
2. `store.get_listing({ gameId })` reads the page: text per store, art per slot, the publish checklist and the tags a page can pick.
3. `store.update_listing`, `store.set_art`, `store.set_trailer` and `store.set_sound` fill it until `readyToPublish` is true. Editing never publishes.
4. Export with `summer_export_game`, run `release-readiness` on the exact `.zip`, and report each check to the owner; a hosted game's upload checks can pass while every online join fails. Then upload it: `store.upload_file({ gameId, clientVersion, confirm: true })` from this machine once the owner approved the exact file and version, or `store.upload_begin` (`kind` bundle, web or download), `store.upload_sign_parts` and `store.upload_complete` with the bytes. Finishing answers a job: `jobs.wait({ jobId })` until Summer's checks are done.
5. `store.publish({ gameId, price, note, idempotencyKey })` asks the owner; `price` is `{ currency: "USD", amountMinor }` in cents (0 is free), omitted it keeps the current price. It answers `needs_approval` with the owner's link and a job. Give the owner the link; `jobs.wait({ jobId })` returns once they answer.
6. `store.status({ gameId })` shows Summer's review decision and feedback, every upload, what players get now, and one next step.
7. A store bundle goes to players with `store.release({ gameId, idempotencyKey })` once Summer approved the game: it releases only the build the owner approved, and answers a job. Web builds and downloads need no release.

The one rule to keep even before you load it: Asking does not publish. `store.publish` returns an approval link; only the owner's click sends the game to review, and review comes before live.

After the review: when `store.status` says `review.needsChanges`, fix every point in `review.feedback`, then call `store.publish` again with a new `idempotencyKey`; the owner approves the resubmission. If there is no written feedback, say so and ask the owner instead of guessing. The game is not live until Summer approves it.

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@latest` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `summer_docs_read` | `summer docs read` |
| `summer_export_game` | `summer engine export-game` |
| `games.create` | `summer games create` |
| `games.list` | `summer games list` |
| `jobs.wait` | `summer jobs wait` |
| `summer_search` | `summer ops search "<what you want>"` |
| `store.get_listing` | `summer store get-listing` |
| `store.publish` | `summer store publish` |
| `store.release` | `summer store release` |
| `store.set_art` | `summer store set-art` |
| `store.set_sound` | `summer store set-sound` |
| `store.set_trailer` | `summer store set-trailer` |
| `store.status` | `summer store status` |
| `store.update_listing` | `summer store update-listing` |
| `store.upload_begin` | `summer store upload-begin` |
| `store.upload_complete` | `summer store upload-complete` |
| `store.upload_file` | `summer store upload-file` |
| `store.upload_sign_parts` | `summer store upload-sign-parts` |
<!-- /shell-commands -->
