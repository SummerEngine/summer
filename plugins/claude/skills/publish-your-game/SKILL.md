---
name: publish-your-game
description: "Publish a game on Summer Games over MCP: store page, art, build upload, go live."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: deployment
user-invocable: true
allowed-tools: summer_docs_read
---

# /publish-your-game — publish your game

This skill covers the whole publishing journey: find the game, make its store page, write the text, set the art, export and upload the build, and take it live.

Its current text lives on the hosted Summer Engine MCP, the same text the Studio agent reads, so it changes with the store and is never stale here. Load it before you act:

1. `summer_docs_read` with id `skill/publish-your-game` returns the current text when this machine is signed in (`summer login`).
2. A host that shows MCP prompts or resources has it as the `publish-your-game` prompt and the resource `summer://skills/publish-your-game`.
3. Without a store sign-in: https://docs.summerengine.com/llms.txt lists every docs page; fetch any page as .md.

## The journey in operations

A call written `area.action({...})` is the tool `summer_area_action` when your client lists it, else `summer_call({ op: "area.action", input: {...} })`; `summer_search` finds any operation and its exact input. Engine tools keep their `summer_*` names.

1. `games.list()` finds the game; `games.create({ title, targets })` makes a new one with its first store page draft. Include `web` in `targets` so it plays in the browser. Keep the `gameId`.
2. `store.get_listing({ gameId })` reads the page: text per store, art per slot, the publish checklist and the tags a page can pick.
3. `store.update_listing`, `store.set_art`, `store.set_trailer` and `store.set_sound` fill it until `readyToPublish` is true. Editing never publishes.
4. Export with `summer_export_game`, run `release-readiness` on the exact `.zip`, and report each check to the owner; a hosted game's upload checks can pass while every online join fails. Then upload it with `summer_publish_build({ gameId, clientVersion, confirm: true })` once the owner approved the exact file and version. It waits for Summer's automated checks and answers each platform's result (`checks`), with the fix for a failed one.
5. Run the `release-checklist` skill: the export, the upload's checks, the store art and every listing detail. `summer_store_set_details` fills the sections `store.update_listing` does not edit: the content questionnaire, the AI disclosure, genres, features, credits, languages and system requirements.
6. `summer_go_live({ gameId, publicationId })` shows the plan; after the owner approves going live, call it again with `confirm: true`. It releases the Build to the platforms that passed, publishes the store page and watches until players get it, or names the failing check and its fix. Web builds and downloads go live with the page. It needs no owner approval link while the person's Agent permissions allow Publish (the default); with Publish off it answers `needs_permission`, and `store.publish` returns a link for the owner instead.
7. `store.status({ gameId })` shows every upload, what players get now on each platform, and Summer's decision when there is one.

To have the agent gather everything from the project and do these steps itself (export and upload, real screenshots, store art, listing text and details), with one confirmation before going live, use the `launch-ready` skill (`summer_docs_read` with id `skill/launch-ready`).

The one rule to keep even before you load it: a game goes live as soon as Summer's automated checks pass. Summer's staff review it after it is live, so never tell the creator to wait for a review. When `summer_go_live` answers `waiting` with `waitingOn: "summer"`, every check passed and the platform is still holding the launch on Summer's side: nothing to fix, and it goes live by itself; call again to keep watching.

When the automatic checks reject the store page (`needs_changes`), fix what `store.status` says failed with `store.update_listing`, then call `summer_go_live` again. When Summer's staff, reviewing the live game afterwards, put it on hold (`summer_go_live` answers `on_hold`, or `store.status` says the review is `rejected`), make the changes in their message with `store.update_listing` and call `summer_go_live` again: publishing the newer store page lifts the hold, and a new build alone does not. If there is no written message, say so and ask the owner instead of guessing. A game taken down (`taken_down`) needs Summer support.

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@4.9.0` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `summer_docs_read` | `summer docs read` |
| `summer_export_game` | `summer engine export-game` |
| `games.create` | `summer games create` |
| `games.list` | `summer games list` |
| `summer_search` | `summer ops search "<what you want>"` |
| `store.get_listing` | `summer store get-listing` |
| `summer_go_live` | `summer store go-live` |
| `store.publish` | `summer store publish` |
| `store.set_art` | `summer store set-art` |
| `summer_store_set_details` | `summer store set-details` |
| `store.set_sound` | `summer store set-sound` |
| `store.set_trailer` | `summer store set-trailer` |
| `store.status` | `summer store status` |
| `store.update_listing` | `summer store update-listing` |
| `summer_publish_build` | `summer store upload-file` |
<!-- /shell-commands -->
