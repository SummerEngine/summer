---
name: release-checklist
description: "Pre-launch check for Summer Games: export, upload checks, store art, listing fields."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: deployment
user-invocable: true
allowed-tools: Read Grep Glob summer_export_game summer_publish_build summer_go_live summer_store_set_details
---

# /release-checklist: everything Summer Games needs before it goes live

Run this before you take a game live with `summer_go_live`, and again when
`summer_go_live` answers `blocked`. It has four parts, in the order of the
release:

1. the build exported properly;
2. the build uploaded and passed Summer's automated checks;
3. the store art is there and has the right shapes;
4. every required listing detail is filled in.

Each rule says how to check it with an MCP tool, what passes, how to fix a
failure, and where the rule comes from. "Platform" rules are enforced by
Summer's management API: a page or build that breaks one is refused. "Store"
rules are the publish checklist Studio and `store.publish` apply to every
page (`store.get_listing` returns it as `checklist` and `readyToPublish`); the
platform accepts a page without them, but it is a poor page. Follow both.

This checklist checks files and fields. Whether a player can actually play
the release (online join, saves, phones) is the `release-readiness` skill:
run it on the same `.zip` before you upload.

To have the agent make every failing rule pass (export and upload, capture
screenshots, make the art, write the listing, then go live with one
confirmation), use the `launch-ready` skill (`summer_docs_read` with id
`skill/launch-ready`).

## Going live has no staff wait

A game goes live as soon as Summer's automated checks pass: the malware scan,
the secrets scan, the per-platform checks and the publish pipeline. Summer's
staff review the game after it is live. So:

- Never tell the creator to wait for a review, and never say a game is "in
  review" as a step they must sit through.
- When `summer_go_live` answers `waiting` with `waitingOn: "summer"`, every
  check passed and the platform is still holding the launch on Summer's
  side. Say exactly that: nothing to fix, nothing to ask for, and the request
  goes live by itself. Call `summer_go_live` again to keep watching.
- When Summer sent the page back (`needs_changes`), report the decision and
  every line of its feedback, fix them, and go live again.

## How to report

Report one line per rule:

- **pass**, with the evidence (the tool and the field you read);
- **fail**, with what you saw and the fix;
- **not applicable**, with the reason (for example, no server);
- **not run**, with what is still needed.

A rule that was not run is not a pass. Show the list to the user before you
change anything; they decide what to fix. Ask before every upload and before
going live: `summer_publish_build` and `summer_go_live` both preview first
and need `confirm: true`.

## 1. The build exported properly

Export with `summer_export_game` (format `bundle`, the default) and read its
answer.

| Rule | Check | Pass | Fix | Source |
| --- | --- | --- | --- | --- |
| 1.1 The summer.games preset made it | `preset`, `format`, `debug` | `format` is `bundle`, `preset` is `summer.games` (or the `summer.games` preset the targets made), `debug` is false | Export again with `summer_export_game` and no `debug` | Engine `modules/1summer_engine/editor` (the summer.games export platform); platform `docs/build-publications.md` |
| 1.2 A released Summer version | `bundle.summerVersion` | A Summer release (`X.Y.Z`); for `ios` or `android`, the same MAJOR.MINOR as the current Summer release | Update Summer Engine to the current release, export again | Platform `internal/clientartifacts/template.go` (same MAJOR.MINOR, a template patch at least the pack's); refusal `engine_build_unreleased`; `release-readiness` check 9 |
| 1.3 The fixed export layout | `bundle.schema`, `bundle.paths` | `summer.bundle.v2` holds only these 6 paths: `summer-bundle.json`, `client.pck`, `config/summer.build.json` (always), `server.pck` (a game with a server only), `config/world-definitions.json` (only when the build declares queues), `config/world-support.json` (only when a World definition names a file). An older engine writes `summer.bundle.v1`, which the store still takes | Never add or rename a file in the `.zip`: upload it as Summer Engine wrote it. An extra path means the export is not from the summer.games preset; export again | Platform `docs/build-publications.md` "summer.games bundle layout", enforced by `internal/clientartifacts/bundle_layout.go` |
| 1.4 A server pack when the game has a server | `bundle.hosted`, `bundle.paths` | A game with a server (multiplayer on Summer's servers) has `hosted: true` and `server.pck`; a game without one has neither | Set up the server export (the `multiplayer-publish` skill), export again | Platform `internal/clientartifacts/exported_game.go` (manifest `server` and `compositionPath` together) |
| 1.5 The right platforms | `bundle.targetPlatforms`, `warnings` | No warning; a game without a server lists only `ios` and `android` (desktop and web ship as downloads, format `download`); a game with a server declares the same platforms in `summer.build.json` | `summer_export_game` with `targets` and, for a server game, `alignDeclaration: true` | Platform refusals `declaration_mismatch`, `template_execution_unsupported` (`api/management/openapi.yaml`, build-publications) |

For web and desktop downloads (`format: "download"`), check instead that the
`.zip` is under 500 MiB with `index.html` at its top (web), or the `.app` or
`.exe` for macOS or Windows; `summer_publish_build` refuses the rest before
it sends anything.

## 2. The build uploaded and passed the automated checks

Upload with `summer_publish_build` (preview first, then `confirm: true`). It
waits for Summer's checks and answers with each one.

| Rule | Check | Pass | Fix | Source |
| --- | --- | --- | --- | --- |
| 2.1 Summer made the Build | `status`, `state` | `status` is `uploaded` (or `published`); a refusal comes back as an error with `code` and `recovery` | Do what `recovery` says. A refused upload usually leaves the `clientVersion` free (`bundle_invalid`, `declaration_mismatch`); a new export needs a new one | Platform build-publication intake codes (`api/management/openapi.yaml`, `:source-complete`) |
| 2.2 The malware scan passed | intake error code | No `malware_detected` or `malware_scan_unsupported`. A scan still running is a wait, never a failure: the tool keeps waiting | Clean the project's files and plugins, export again on a clean machine | Platform `docs/build-publications.md` (GuardDuty tags) |
| 2.3 The secrets scan passed (game with a server) | intake error code | No `verifying_failed` | Remove the key or password from the project, revoke it, export again | Platform `docs/build-publications.md` (Trivy secrets in the server image) |
| 2.4 Every platform check passed | `checksState`, `checks[]` | `checksState` is `passed`: every platform `passed`. `checking` means call `summer_publish_build` again with the same file and version | Each failed check has `code`, `owner` and `fix`. `owner: "creator"`: apply the fix, export again, upload with a new `clientVersion`. `owner: "summer"`: nothing to change | Platform `docs/client-pack-publication.md`, `internal/management/client_verification.go` |
| 2.5 Web builds and downloads are checked | `summer_publish_build` answer for a download, or `store.status` uploads | Each is `ready` | `rejected` names its reason: fix it, export the download again, upload it | Platform store versions (`awaiting_upload`, `processing`, `ready`, `rejected`) |

A hosted game's `web` check fails with `client_platform_unavailable` while
its phone and desktop checks pass: that is expected, and `summer_go_live`
releases the platforms that passed. Ship web for such a game as a download.

## 3. The store art is there

Read the art with `store.get_listing`: `art` per slot, and the `checklist`
items for each slot.

| Rule | Slot | Pass | Kind | Source |
| --- | --- | --- | --- | --- |
| 3.1 Every image is verified | all | No checklist item names a refused or unchecked image | Platform: `store_page_incomplete` with `media` | Platform `internal/creatorcatalog/submission.go` |
| 3.2 Every filled slot fits its shape | all | No checklist item names a shape problem | Platform: `store_page_incomplete` with `mediaSlots`, sizes below | Platform `internal/storefront/slot_shapes.go` (within 2%) |
| 3.3 Desktop key art | `desktop.keyArt` | Present, 16:9, at least 1920x1080, no text | Store, desktop targets | PSE `src/lib/creator-store/store-slots.ts` |
| 3.4 Desktop screenshots | `desktop.screenshots` | 4 to 8, 16:9, at least 1920x1080, real play | Store, desktop targets | PSE `store-slots.ts`, `listing-spec.ts` |
| 3.5 Icons | `desktop.icon`, `mobile.icon` | Square, at least 512 (1024 is best), no words | Store; platform checks the shape | PSE `store-slots.ts`; platform `slot_shapes.go` |
| 3.6 Mobile key art | `mobile.keyArt` | 16:9, at least 1920x1080, no text | Store, phone targets; platform checks the shape | Same |
| 3.7 Mobile screenshots | `mobile.screenshots` | 3 to 8, 16:9 to 19.5:9 either way, short side at least 1080 | Store, phone targets; platform checks the shape | Same |
| 3.8 Tall cover | `mobile.tallCover` | 9:16 to 9:19.5, at least 1080x1920, no text | Store warning only (cropped from the key art when missing) | Same |
| 3.9 Capsules | `desktop.capsuleTall` 3:4 at least 600x800, `desktop.capsuleWide` 460:215 at least 920x430 | Optional (cropped from the key art at its focal point); the logo is allowed | Store, optional | Same |
| 3.10 At most 20 images and videos | all | 20 or fewer on the page | Store and platform (`mediaAssetIds` at most 20) | PSE `MEDIA_BUDGET`; platform `api/management/openapi.yaml` |

Fix: make or capture the image (the `store-art` skill; `summer_capture_gameplay`
for real screenshots) and put it in its slot with `store.set_art`. A trailer
is optional (`store.set_trailer`).

## 4. Every required listing detail is filled in

Read `store.get_listing` (text, `checklist`, `readyToPublish`) and, for price,
`pricing.get`.

| Rule | Field | Pass | Kind | Fix | Source |
| --- | --- | --- | --- | --- | --- |
| 4.1 Title | `title` | 1 to 60 characters | Platform requires one (max 120); store max 60 | `store.update_listing` title | Platform `internal/creatorcatalog/types.go`; PSE `listing-spec.ts` |
| 4.2 Tagline | desktop and mobile tagline | 1 to 80 characters | Store | `store.update_listing` desktop.tagline, mobile.tagline | PSE `listing-spec.ts`, `store-slots.ts` |
| 4.3 Short description | desktop and mobile description | Desktop 120 to 300 characters; mobile 120 to 170 | Platform requires one; store sets the lengths | `store.update_listing` desktop.description, mobile.description | Same |
| 4.4 Long description | `longDescription` | Optional; up to 12000 characters | Optional | `store.update_listing` longDescription | Platform `internal/storefront/listing_fields.go` |
| 4.5 Tags | `tags` | 3 to 8 from the store's tag list | Store | `store.update_listing` desktop.tags | PSE `listing-spec.ts` |
| 4.6 Genres and features | `genres`, `features` | Optional; 1 to 5 genre tags, features from the closed list | Optional (shown on the page) | `summer_store_set_details` | Platform `listing_fields.go`; openapi `GameGenres`, `GameFeatures` |
| 4.7 Supported platforms | `targets` | At least one, and every platform the build was exported for | Platform | `store.update_listing` targets | Platform `internal/gameplatforms/platforms.go` |
| 4.8 Age rating | `contentRating`, `contentDescriptors` | A rating (`everyone`, `everyone10Plus`, `teen`) and descriptors answered (an empty list when none apply) | Platform: `store_page_incomplete` | `store.update_listing` contentRating, contentDescriptors | Platform `internal/creatorcatalog/types.go`, `internal/contentrating/contentrating.go` |
| 4.9 Content questionnaire | `contentSurvey` | Answered in full when the game has any mature content, user content, online interaction or purchases | Optional on the platform; every answer is required once given | `summer_store_set_details` contentSurvey | Platform `internal/storefront/page_fields.go` |
| 4.10 AI disclosure | `aiDisclosure` | Says how AI made the game (`assets`, `code`, `generatedGameplay`, or `[]` for none); `generatedGameplay` has a description | Optional on the platform; always fill it, honestly | `summer_store_set_details` aiDisclosure | Platform `page_fields.go` |
| 4.11 Support contact | support link | An https or `mailto:` support link | Optional | `store.update_listing` support | Platform `listing_fields.go` (`externalLinks` kind support) |
| 4.12 Release stage | `release` | Chosen on purpose: `released` needs a playable build on a listed platform; `in_development` lists the game only on the In development page | Platform for released pages (`playable_release_required`) | `store.update_listing` release | Platform `internal/storefront/release.go`, `playable_page.go` |
| 4.13 Price | `pricing.get` | Free, or the price the owner chose | Not checked at publish. A price can be set only once the creator's Stripe seller account takes payments (`seller_setup_required` otherwise; the game stays free), and only the owner sets that up, in Studio | `pricing.set_base` | Platform `PUT /games/{gameId}/price` (`api/management/openapi.yaml`) |
| 4.14 Legal text | none | Nothing to fill: the store page has no EULA, terms or privacy field; players accept Summer's terms | Not applicable | None | Platform `api/management/openapi.yaml` (no such field) |

Never invent features, modes, player counts, awards or prices: the
`store-listing` skill has the writing rules.

## Then go live

When every rule passes (or the user accepted an open one), call
`summer_go_live` with the `gameId` and the `publicationId` from
`summer_publish_build`. Its first answer is the plan: show it to the user,
then call again with `confirm: true`. It releases the Build to the platforms
that passed, publishes the store page and watches until players get it:

- `live`: report it, and ask the user to check it as a player on summer.games
  and in the Summer Games apps;
- `blocked`: each failure has a fix; apply them and run the failed part of
  this checklist again;
- `waiting`: say what it waits on (above), call again to keep watching;
- `needs_permission`: the person's Agent permissions have Publish off: ask
  them to turn it on (Studio > Agent permissions), or use `store.publish`,
  which returns a link for the owner to approve;
- `needs_changes`: Summer sent the page back; fix every line of feedback.

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@latest` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `summer_docs_read` | `summer docs read` |
| `summer_capture_gameplay` | `summer engine capture-gameplay` |
| `summer_export_game` | `summer engine export-game` |
| `pricing.get` | `summer pricing get` |
| `pricing.set_base` | `summer pricing set-base` |
| `store.get_listing` | `summer store get-listing` |
| `summer_go_live` | `summer store go-live` |
| `store.publish` | `summer store publish` |
| `store.set_art` | `summer store set-art` |
| `summer_store_set_details` | `summer store set-details` |
| `store.set_trailer` | `summer store set-trailer` |
| `store.status` | `summer store status` |
| `store.update_listing` | `summer store update-listing` |
| `summer_publish_build` | `summer store upload-file` |
<!-- /shell-commands -->
