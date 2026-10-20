---
name: launch-ready
description: "Get a game ready to launch on Summer Games and take it live: upload, real screenshots, store art and listing, gathered and filled in."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: deployment
user-invocable: true
allowed-tools: Read Grep Glob Bash summer_get_project_context summer_read_file summer_export_game summer_publish_build summer_capture_gameplay summer_play summer_game_input summer_screenshot summer_stop summer_get_diagnostics summer_store_set_details summer_go_live summer_docs_read summer_call
---

# /launch-ready: gather everything the game needs, then take it live

The `release-checklist` skill checks a game before launch and reports what is
missing. This skill makes it pass: it exports and uploads the build, captures
real gameplay screenshots, makes the key art and icons, writes the store page
from the project, fills in every listing detail, shows the creator the result
and takes the game live with one confirmation.

The checklist is the source of the rules. Read it first
(`summer_docs_read` with id `skill/release-checklist`); this skill names its
rules by number (1.1 to 4.14) and says how to make each one pass.

A call written `area.action` is the tool `summer_area_action` when your client
lists it, else `summer_call` with `op: "area.action"`. Engine tools keep their
`summer_*` names.

## Rules that never bend

- **Never invent a fact.** Every feature, mode, player count, language,
  rating answer and AI answer comes from something you saw in the project or
  in play, or from the creator. When you can't tell, ask.
- **Screenshots are real gameplay.** Frames from the running game, unedited:
  no captions, no overlays, no mockups, no AI edits. The game's own HUD may
  show.
- **Key art may be generated, but it shows this game:** its characters, its
  world, its art style, and nothing it doesn't have. Start from a real
  capture.
- **Tags, genres and features describe the game.** They are not keywords for
  reach. Pick only what is true; never add a popular tag the game doesn't
  earn.
- **The content rating, the content questionnaire and the AI disclosure are
  statements the creator makes.** Draft them from evidence, show the
  evidence, and have the creator confirm them. Parents' controls use the
  rating, so when in doubt pick the stricter answer.
- **Ask the creator** for what the project can't tell you: the price, the
  support contact, the developer name, the release stage, and anything legal
  or factual you could not see.
- **Say what you will generate before you spend credits.** Every generation
  call takes `dryRun: true` for the estimate.
- **Nothing goes live before the creator's yes** to the summary in step 6.

## The flow

1. Find the game and run the checklist, changing nothing.
2. Gather the facts from the project.
3. Ask the creator once: the questions and the plan.
4. Fix each failure: build, screenshots, art, listing.
5. Run the checklist again until it passes.
6. Show the creator everything and get one confirmation.
7. Go live, and report live or the exact blocker.

## 1. Find the game and run the checklist

1. `summer_get_project_context`: binds the project and returns the main
   scene and project memory (GameSoul, decisions).
2. `games.list` finds the store game by name. When there is none, plan
   `games.create` with the title and targets (it makes a draft; nothing is
   published).
3. Read the state: `store.get_listing` with `previews: true` (text, art per
   slot, `checklist`, `readyToPublish`, `availableTags`), `store.status`
   (every upload, its version, state and checks, and what is live) and
   `pricing.get`.
4. Mark every checklist rule pass, fail, not applicable or not run. Rules 1.x
   and 2.x stay not run until step 4 exports and uploads.

## 2. Gather the facts from the project

Read before you write. Keep each fact with where you found it; the summary
in step 6 shows the source.

| Fact | Where |
| --- | --- |
| What the game is, its genre, its core loop, its look | `.summer/GameSoul.md`, `.summer/memory/`, `.summer/build-plan.md`, `README.md`, `project.godot` (`application/config/name`, `description`) |
| The gameplay scene and how to reach it | The main scene, the title screen's buttons, the game's command-line flags (`OS.get_cmdline_user_args`) |
| Online play | `summer.build.json` names a server; `Summer.client` matchmaking or join code |
| Saves that follow the player | `Summer.authority.player_data` commits |
| Purchases | `summer.items.json`, `Summer.client.store` calls |
| Controller support | Joypad events in the InputMap: every action (full) or some (partial) |
| Languages | `internationalization/locale/translations`, `.po` or `.csv` files; voiced lines and their subtitles |
| Renderer and size | `rendering/renderer/rendering_method`; the export's file size |
| Phone orientation | `display/window/handheld/orientation` |
| Mature content | What you see in play, the dialogue and text files, the art |
| AI use | Assets generated with Summer (`assets.get` says `aiGenerated`), `.summer/` generation records, code an agent wrote (git history, `.summer/` records, and you if you wrote any), AI that runs inside the game |

Then **play it**: `summer_play`, reach the gameplay with `summer_game_input`,
and look with `summer_screenshot` (`target: "game"`). Note the good moments
for screenshots (below) and the inputs that reach them, and anything a
rating answer depends on: violence, blood, language, flashing lights, other
players. `summer_get_diagnostics`, then `summer_stop`.

## 3. Ask the creator once

One message, before anything changes or anything is spent:

- **What is missing:** each failed rule, one line.
- **What you will do:** export and upload version `vX.Y.Z`; capture N
  screenshots; generate key art, icons, tall cover and capsules (with the
  `dryRun` credit estimate); write the store text. Their yes approves these;
  none of it makes the game live.
- **What only they can answer**, as choices with your recommendation first:
  - Price: free, or a price. A paid game needs their seller account set up
    in Studio first; until then it stays free.
  - Support contact: an email address or an https page.
  - Developer name, and the publisher if there is one.
  - Release stage: released, early access, or in development (listed only on
    the In development page).
  - Anything the evidence did not settle: chat with strangers, content made
    by players, flashing lights, real-world brands or people.

Wait for the answers.

## 4. Fix each failure

### Build (rules 1.1 to 2.5)

What to upload (rule 1.5): a game with a server, or one for iPhone or
Android, needs a store bundle (format `bundle`). A game without a server
ships web and desktop as downloads (format `download`), one per platform.

An upload is missing when `store.status` has none for a target, and stale
when the newest one is older than the project's last change (`git log -1
--format=%cI`, or the newest file outside `.godot/` and `.summer/`), failed,
failed a check the creator owns, or carries a Summer version line older than
the current release (rule 1.2).

1. `summer_export_game`: format `bundle` (a game with a server passes its
   `targets` and `alignDeclaration: true`), or format `download` with one
   target. Read rules 1.1 to 1.5 from the answer.
2. Run the `release-readiness` checks an agent can run on a bundle `.zip`
   (1, 6, 7, 8 steps 1 to 4, 9). A failure there is a game change: show it
   to the creator and fix it with their OK before uploading.
3. `summer_publish_build` with the `gameId`, the next `clientVersion` (one
   past the newest in `store.status`), the `platform` for a download, and
   `confirm: true` (step 3 approved it). For a bundle, read `checksState`
   and every `checks` entry: `owner: "creator"` means fix, export again and
   upload a new version; `owner: "summer"` means nothing to change;
   `checking` means call again. Keep the `publicationId`. A download is
   ready when `store.status` says so (rule 2.5).

### Screenshots (rules 3.4 and 3.7)

1. **Pick the moments** from your play in step 2. Good moments show the
   core action, different places, enemies or characters, and a reward or
   upgrade screen. Skip menus, loading, pause, empty rooms, debug text and
   near-duplicates.
2. **Capture them full size** with `summer_capture_gameplay`: the gameplay
   `scene`, or the game's `args` or `steps` to get past the title, one
   `shot` step per moment, up to 10 frames. Use `resolution` `1920x1080` for
   desktop. Phones take the same 1920x1080 frames when the game is
   landscape, and `1080x1920` when it is portrait.
3. **Look at every frame** before you use it. Drop black, blurred, title,
   paused or repeated ones. A warning that frames are not the size you asked
   for comes from the project's stretch settings: never upscale; tell the
   creator and ask before changing the game.
4. **Keep the best:** 4 to 8 for desktop, 3 to 8 for phones, the strongest
   first.
5. **Upload each one:** `assets.upload_begin`, run its `example` command
   with the file path, then `assets.upload_complete` with `publicId`,
   `version` and `uploadSignature` (`public_id`, `version` and `signature` in
   that command's answer) and `format` `png`. You get an `assetId` and a
   `fileUrl`.
6. `store.set_art` with slot `desktop.screenshots` or `mobile.screenshots`
   and the asset ids. Use `mode: "append"` to keep good screenshots already
   on the page. Read `placed` and `checklist` in the answer.

### Key art, icons, tall cover and capsules (rules 3.3, 3.5, 3.6, 3.8, 3.9)

Load the `store-art` skill first (`summer_docs_read` with id
`skill/store-art`) and follow it: it has each slot's current rules. Where it
and this table differ, it wins.

Start from the strongest capture: `assets.edit_image` with its `fileUrl` as
`imageUrl`, the size below, and a prompt that keeps the game's characters,
world, colours and art style, recomposes the scene for the slot, removes the
HUD and adds no text. When the edit loses the game's look,
`assets.generate_image` with the capture as `referenceImageUrl`.

| Slot | Size to ask for | Text |
| --- | --- | --- |
| `desktop.keyArt`, `mobile.keyArt` | 2048x1152 (16:9) | None |
| `mobile.tallCover` | 1152x2048 (9:16) | None |
| `desktop.icon`, `mobile.icon` | 1024x1024 | None; one clear subject that reads small |
| `desktop.capsuleTall` | 1200x1600 (3:4) | Only the game's own logo, when the project has one |
| `desktop.capsuleWide` | 1472x688 (460:215) | Only the game's own logo, when the project has one |

Each size is a multiple of 16 (what `assets.edit_image` takes) and above the
slot's minimum. Both key art slots may use the same image, and both icons
too. Never invent a logo.

Look at every result (`assets.get`, then open its file). It must show this
game. Make at most two tries per slot; when neither shows the game, ask the
creator. Put each into its slot with `store.set_art`, with a `focalPoint` on
key art and covers so the store's crops keep the subject. A shape refusal
names the slot's rule: make it again at the right size. The page holds at
most 20 images and videos (rule 3.10).

### Listing details (rules 4.1 to 4.13)

Load the `store-listing` skill (`summer_docs_read` with id
`skill/store-listing`) for the writing rules. Then fill:

| Field | From | With |
| --- | --- | --- |
| Title (4.1) | The current title; else the project's name | `store.update_listing` |
| Tagline (4.2), short descriptions (4.3), long description (4.4) | GameSoul, README, what you saw in play: what the player does, the modes, the controls | `store.update_listing` |
| Tags (4.5) | 3 to 8 that are true, from `availableTags` only | `store.update_listing` |
| Targets (4.7) | The platforms the build was exported for | `store.update_listing` |
| Support (4.11), release stage (4.12) | The creator's answers | `store.update_listing` |
| Content rating and descriptors (4.8) | The questionnaire below, confirmed by the creator | `store.update_listing` |
| Genres, features (4.6) | Genres from `availableTags` (category genre); features only the project proves | `summer_store_set_details` |
| Credits, languages, system requirements | The creator's names; the languages the game ships; for requirements only what you know (operating systems from the targets, graphics from the renderer, storage from the export size, network when it plays online) | `summer_store_set_details` |
| Content questionnaire (4.9) | Below | `summer_store_set_details` |
| AI disclosure (4.10) | Below | `summer_store_set_details` |
| Price (4.13) | The creator's answer | `pricing.set_base`, only for a price they chose |

**The content questionnaire.** Answer each question from what you saw:
violence (none, fantasy, realistic), blood, sexual content, nudity, strong
language, substances, gambling (simulated or real money), content players
make that others see, playing with others online, and purchases. `none` is
an answer only after you looked. The content rating is the lowest of
`everyone`, `everyone10Plus` and `teen` that honestly covers those answers,
with every descriptor that applies (`[]` when none does). If no rating on
the list covers the content, stop and ask the creator; never pick a milder
one to fit.

**The AI disclosure.** `assets` when any image, model, sound or video in the
game or on its store page was generated (the art step above counts), `code`
when an AI agent wrote code for it (you count, if you wrote any),
`generatedGameplay` when the running game generates content with AI
(describe what it generates and its guardrails). `[]` only when the creator
confirms no AI was used.

These drafts go on the page draft, which players don't see; the creator
confirms them in step 6, before anything goes live.

`pricing.set_base` may answer `needs_approval` (give the creator the link)
or `seller_setup_required` (the game stays free until they set up selling in
Studio; say so). Record the creator's answers and what you made in
`.summer/build-plan.md`.

## 5. Run the checklist again

Read `store.get_listing` (`checklist`, `readyToPublish`) and `store.status`,
and go through every rule. Fix what still fails and read again. Stop after
three rounds that change nothing: report the rule, what you saw and who must
act. A rule only the creator can clear (a seller account, a Studio setting)
is reported, not retried.

## 6. Show the creator everything, and get one confirmation

1. `summer_go_live` with the `gameId`, the bundle's `publicationId` (when
   there is one) and no `confirm`: it answers the plan (the platforms, the
   version, the page).
2. `store.preview_link` with the `gameId`: a private link to the page as
   players will see it.
3. One message:
   - the preview link;
   - every image with its slot: the local file path of each capture, and the
     preview URLs from `store.get_listing` with `previews: true`, as images
     where the chat shows them;
   - all text, word for word: title, tagline, descriptions, tags, genres,
     features, languages, requirements, support, release stage, price;
   - the content questionnaire, the rating and the AI disclosure, each answer
     with its evidence;
   - the build version and its checks, and the release-readiness checks only
     a player can run, marked not run;
   - the credits spent;
   - the go-live plan.
4. Ask one question: take it live? A change request: make it, run the
   affected part of the checklist again, show what changed and ask again.

## 7. Go live

`summer_go_live` with the `gameId`, the bundle's `publicationId` (when there
is one) and `confirm: true`. Report its answer:

- `live`: the store URL. Ask the creator to open it as a player on
  summer.games and in the Summer Games apps, and to run the release-readiness
  player checks (2, 8 step 5, 9 step 3, 10).
- `blocked`: each failure with its fix. Fix them (step 4) and go live again;
  a fix that changes what the creator saw needs their yes again.
- `waiting` with `waitingOn: "summer"`: every check passed and Summer holds
  the launch on its side. Nothing to fix; it goes live by itself. Call again
  to keep watching. Never tell the creator to wait for a review.
- `needs_permission`: their Agent permissions have Publish off. Ask them to
  turn it on (Studio > Agent permissions), or use `store.publish`, which
  returns a link for them to approve.
- `needs_changes`: Summer sent the page back; fix every line of its feedback
  and go live again.

End with one line: **Live** with the store URL, or **Not live** with the
exact blocker, who must act, and the next step.

## Checklist

- [ ] Read `release-checklist`, `store-art` and `store-listing` before acting.
- [ ] Asked the creator once, before any spend or upload: price, support, developer, release stage, open facts.
- [ ] The build is current, uploaded and every platform check is read.
- [ ] Screenshots are unedited frames of real play, at slot size, looked at one by one.
- [ ] Key art, icons, cover and capsules start from a real capture, carry no text (a capsule at most the game's own logo) and show this game.
- [ ] Every listing fact has a source; tags, genres and features are true.
- [ ] The rating, questionnaire and AI disclosure were confirmed by the creator.
- [ ] The checklist passes, or the remaining blocker is named.
- [ ] The creator saw the preview link, every image and all text, and said yes.
- [ ] `summer_go_live` with `confirm: true` ran only after that yes; reported live or the exact blocker.

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@latest` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `assets.generate_image` | `summer assets generate-image` |
| `assets.get` | `summer assets get` |
| `assets.upload_begin` | `summer assets upload-begin` |
| `assets.upload_complete` | `summer assets upload-complete` |
| `summer_docs_read` | `summer docs read` |
| `summer_capture_gameplay` | `summer engine capture-gameplay` |
| `summer_export_game` | `summer engine export-game` |
| `summer_game_input` | `summer engine game-input` |
| `summer_get_diagnostics` | `summer engine get-diagnostics` |
| `summer_get_project_context` | `summer engine get-project-context` |
| `summer_play` | `summer engine play` |
| `summer_read_file` | `summer engine read-file` |
| `summer_screenshot` | `summer engine screenshot` |
| `summer_stop` | `summer engine stop` |
| `games.create` | `summer games create` |
| `games.list` | `summer games list` |
| `pricing.get` | `summer pricing get` |
| `pricing.set_base` | `summer pricing set-base` |
| `store.get_listing` | `summer store get-listing` |
| `summer_go_live` | `summer store go-live` |
| `store.preview_link` | `summer store preview-link` |
| `store.publish` | `summer store publish` |
| `store.set_art` | `summer store set-art` |
| `summer_store_set_details` | `summer store set-details` |
| `store.status` | `summer store status` |
| `store.update_listing` | `summer store update-listing` |
| `summer_publish_build` | `summer store upload-file` |
<!-- /shell-commands -->
