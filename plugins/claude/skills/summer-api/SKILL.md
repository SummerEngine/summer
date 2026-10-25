---
name: summer-api
description: "Summer API game assets: models, estimate, one job or a batch, download the files."
license: MIT
compatibility: [Cursor, Claude Code, Codex, Windsurf, Gemini, OpenCode, Factory, Copilot]
category: _meta
user-invocable: false
allowed-tools: Bash Read Write summer_api_models summer_api_estimate summer_api_run summer_api_batch summer_api_job
---

# Summer API: game assets for any agent

The Summer API makes game assets from curated models tested for games: 3D models (GLB), images, video, voice lines, dialogue, sound effects and music. Each finished file is saved to the person's Summer library and downloads into their project. Every model runs at the provider's list price, with no markup on assets.

Use this skill when the person asks for the Summer API, or wants asset files for any engine, app or pipeline from a script, a batch or a coding agent. Inside a running Summer Engine project, the asset skills (`prop-model`, `character-model`, `sound-effect`, ...) import the asset into the scene for you; use them there.

Two ways in, with the same calls and the same answers:

| You have | Use |
|---|---|
| A shell | `summer api ...` commands. If `summer --version` is missing or below 4.8, write `npx -y summer-engine@4.9.0` in place of `summer`. |
| Summer's local MCP server | The tools `summer_api_models`, `summer_api_estimate`, `summer_api_run`, `summer_api_batch` and `summer_api_job` |

Your own code calls the same API over HTTP. The HTTP guide, the OpenAPI document and copy-paste code are on docs.summerengine.com/api (quickstart, jobs, errors).

## 1. Sign in once

```bash
summer login
```

The browser opens the Summer sign-in page. The person signs in, picks a spend limit for this app and chooses **Allow**. Tell them the browser opens, and wait for them. The sign-in renews itself; do it once per computer. There are no API keys.

- `summer token` prints a one-hour access token from the same sign-in, for the person's own HTTP code. Keep tokens out of game code, builds and commits.
- Listing models and estimating need no sign-in. Running a job does.
- The person sees and changes each app's spend limit, or revokes it, in Settings > Connected apps on summerengine.com.

## 2. Pick a model

```bash
summer api models --capability 3d
summer api models 3d/default
```

MCP: `summer_api_models({ capability: "3d" })`, `summer_api_models({ model: "3d/default" })`.

- Capabilities: `image`, `3d`, `video`, `voice`, `dialogue`, `sound`, `music`.
- `<capability>/default` (such as `3d/default`) runs the model Summer tests first for that job. A job answer names the model that ran in `model`, so you can run the same model again.
- Each model lists its `inputSchema` (the exact fields), `outputFormats`, typical time and `price`. Read prices from this list every time, never from memory.
- Voice and dialogue models list `voices` (`voiceId` and `name`). Use one of those ids.

## 3. Price it, then ask

```bash
summer api estimate 3d/default --input '{"kind": "text-to-3d", "prompt": "a stylized treasure chest, game prop"}'
```

MCP: `summer_api_estimate({ model: "3d/default", input: { kind: "text-to-3d", prompt: "a stylized treasure chest, game prop" } })`.

The answer has `price` (US dollars as a decimal string), `atMost` (`true`: the most it can cost, the charge can be lower), a `breakdown`, and a `quoteId` that holds the price for 15 minutes. Estimates are free.

Before you spend: tell the person what you will make, how many, and the total. Wait for a yes. Jobs spend their paid Summer credits (plan credits and top-ups).

## 4. Run one job

```bash
summer api run 3d/default \
  --input '{"kind": "text-to-3d", "prompt": "a stylized treasure chest, game prop"}' \
  --quote <quoteId> --download assets/props
```

MCP: `summer_api_run({ model: "3d/default", input: { kind: "text-to-3d", prompt: "a stylized treasure chest, game prop" }, quoteId: "<quoteId>", out: "assets/props" })`.

- `--download <dir>` (MCP `out`) follows the job to the end and saves every file as `<assetId>.<ext>`. `--wait` (MCP `wait: true`) follows it without saving.
- `--quote` (MCP `quoteId`): Summer refuses to charge more than the quote. If the price went up, the job does not start and nothing is charged (`conflict`): estimate again.
- Images, voice and sound usually finish inside the call. 3D and video take minutes: one MCP call follows a job for about a minute, then answers `next`. Call `summer_api_job({ jobId, wait: true })` until the job finishes. The CLI follows it to the end by itself.
- In Windows PowerShell or cmd, write the input to a file and pass `--input "@input.json"`: those shells break quotes inside `'{...}'`.
- Each run sends its own idempotency key, so a retried request never runs twice. To retry the same run by hand, pass the same `--idempotency-key` (MCP `idempotencyKey`).

## 5. Run many: a batch

For a set of assets (props for a level, every UI icon, a sound pack), send one batch instead of many runs. One batch takes up to 500 jobs, all or none.

```jsonl
{"model": "3d/default", "input": {"kind": "text-to-3d", "prompt": "a wooden barrel with iron bands, game prop"}}
{"model": "3d/default", "input": {"kind": "text-to-3d", "prompt": "a mossy stone well, game prop"}}
{"model": "image/default", "input": {"prompt": "a red health potion icon, flat fantasy style, centered", "removeBackground": true}}
{"model": "sound/default", "input": {"text": "glass potion bottle uncorked, short pop", "durationSeconds": 1}}
```

```bash
summer api run --batch jobs.jsonl --download assets
```

MCP: `summer_api_batch({ jobs: [{ model: "3d/default", input: { kind: "text-to-3d", prompt: "a wooden barrel with iron bands, game prop" } }], out: "assets" })`. Read it again with `summer_api_batch({ batchId: "<id>", wait: true, out: "assets" })`.

- Every job is priced when the batch arrives. When the paid credits and the app's limit cover all of them, all are accepted at once and run in order; each holds its price (`estimatedPrice` on the job, the total on the batch). When they do not, nothing runs: the error's `details` say how many fit (`fits`) and how much more is needed (`shortUsd`).
- The batch answers its jobs in the order you sent them. Give each job a `title` where the model takes one (3D and image models do): it names the asset in the person's library.
- A batch takes no `quoteId`. Estimate each distinct request first (same model and input, same price), add them up, and give the person the total for the whole batch.
- Each line may carry its own `idempotencyKey`; the batch has one too (`--idempotency-key`). To pick up a batch after the terminal closed, run the same command with the same `--idempotency-key`: it answers the batch it already made and follows it. MCP: `summer_api_batch({ batchId, wait: true })`.

## 6. Follow and read

```bash
summer api jobs <jobId> --download assets   # follow it and save its files
```

MCP: `summer_api_job({ jobId: "<jobId>", out: "assets" })`.

A Summer API job runs to the end once it is accepted, queued or running: it cannot be cancelled. A job that fails costs nothing. So confirm the list with the person before you send it.

| `state` | Means | Do |
|---|---|---|
| `queued` | Waiting for one of the account's running slots; its price is held | Keep following; it starts in order |
| `running` | Working; `progress` 0 to 100 when known | Keep following |
| `done` | Finished; `result.assets` has the files | Download them |
| `failed` | It did not work; nothing is charged | Show `error.message`; change the input or the model |
| `cancelled`, `expired`, `stale`, `declined` | Stopped without a result | Start a new job if the person still wants it |

A finished job has `result.assets`: one entry per file, each with `assetId`, `fileUrl` and `thumbnailUrl`. The file type is the extension of `fileUrl` (the model's `outputFormats` lists them). Job ids may hold a colon (`gen:...`, `q:...`); send them as they are.

With `--json`, or when its output is piped, every command prints the API's own answer: `{"job": {...}}` for a run or a job (plus `"files"` with `--download`), `{"batch": {...}}` for a batch, the estimate's fields at the top level, and `{"ok": false, "error": {"code", "message", "details"}}` on an error. In a terminal it prints a short summary.

## Limits: money only

- **No rate limits on paid usage.** Send as much work as the person agrees to pay for.
- **Running slots.** Each account runs 10 jobs at once at the start, and up to 40 as it buys more credits. Jobs past the slots answer `queued` (their id starts with `q:`) and start in order as slots free up. Queued work is not an error; do not resend it.
- **Two money limits**, both checked before any work starts: the person's paid balance and this app's own spend limit. Queued and running jobs hold their price against both until they are charged.
- **A failed job costs nothing.** A retry with the same idempotency key never charges twice.

## Errors

Every error has a stable `code` and a `message` written for the person. Branch on the code; show the message.

| Code | Means | Do |
|---|---|---|
| `not_signed_in` | No sign-in, the app was revoked, or a `summer token` older than an hour | CLI and MCP: run `summer login`, then retry. Own HTTP code: get a new `summer token` |
| `no_credits` | The paid balance cannot cover the job or the batch | Show the message: it links where to add credits. Do not retry until the person tops up |
| `over_limit` | This app's own spend limit is reached | Show the message: the person raises the limit in Connected apps, or waits for it to reset |
| `invalid_input` | The input does not match the model, or the `quoteId` expired | Fix the field the message names (`param`); read the model's `inputSchema`. An expired quote: estimate again |
| `not_found` | No such model, job or batch | Model ids come from `summer api models` |
| `conflict` | The price went up since your quote | Estimate again; nothing was charged |
| `idempotency_conflict` | The key was used for a different request | Use a new key for a new job |
| `in_progress` | The first request with this key is still running | Send the same request again shortly |
| `outcome_unknown` | Summer could not tell if the work started | Send the same request with the same key; never start a new job |
| `unavailable` | A model or service is down for a moment | Retry with backoff, or pick another model for the same job |
| `unsupported` | The job cannot do that (a cancel) | Let the job finish |

`no_credits` and `over_limit` are answers about money, not failures: stop, show the person the message and its link, and continue when they say so.

## Prompts that work, per asset type

Write prompts as plain descriptions of the thing itself. Put the style in every prompt of a set, word for word, so the assets match.

| Asset | Model | Input that works |
|---|---|---|
| Prop | `3d/default` | `{"kind": "text-to-3d", "prompt": "a wooden treasure chest with iron trim, stylized low-poly, game prop"}`. One object per job. Add `"targetPolycount": 3000` for a light mesh. |
| Character | `3d/default` | `{"kind": "text-to-3d", "assetIntent": "character", "poseMode": "a-pose", "rig": true, "animationNames": ["Idle", "Walk", "Run"], "prompt": "a dwarf blacksmith, full body, stylized"}`. Full body, one character, neutral pose. |
| 3D from concept art | `3d/default` | `{"kind": "image-to-3d", "imageUrl": "<public URL>"}`. A clean picture of one object on a plain background. |
| Concept art, key art | `image/default` | `{"prompt": "...", "aspectRatio": "16:9"}`. Name the subject, the setting, the light and the style. |
| Icon, sprite, item | `image/default` | `{"prompt": "a red health potion, centered, flat fantasy style", "removeBackground": true}`. One object, centered; a transparent PNG comes back. |
| Matching set | `image/default` | Send the first image's `fileUrl` as `referenceImageUrl` in the next jobs, and keep the same `seed` and style words. |
| Sound effect | `sound/default` | `{"text": "heavy wooden door creaks open, stone hall echo", "durationSeconds": 2}`. Source, action, material, space. `"loop": true` for ambience. |
| Voice line | `voice/default` | `{"text": "Halt! Who goes there?", "voiceId": "<from the model's voices>"}`. Punctuation sets the delivery. |
| Conversation | `dialogue/default` | `{"inputs": [{"text": "...", "voiceId": "..."}, {"text": "...", "voiceId": "..."}]}`. One entry per line, up to 40. |
| Music | `music/default` | `{"prompt": "calm medieval village theme, lute and flute, 90 bpm, loopable", "durationSeconds": 60}`. Genre, mood, instruments, tempo. |
| Video | `video/default` | `{"prompt": "slow camera push toward a castle at dawn", "duration": 5}`, or `imageUrl` to animate key art. One shot per job. |

A picture input (`imageUrl`, `referenceImageUrl`) is a public URL, such as the `fileUrl` of an earlier job. For a file on the person's computer, the docs' jobs page shows the upload (`/v1/files`).

## Without Summer Engine

This whole skill runs without Summer Engine: the CLI, the MCP tools and the HTTP API need only the Summer sign-in. The files work in any engine or app. Stop at the files; skip any step that imports into a Summer project.

## Use the files

- Save files inside the project (`--download assets/...`), and keep each `assetId`: in Summer Engine, an asset imports by its id.
- GLB files are Y up and not at real-world size. Scale them in the engine (a door about 2 m, a person about 1.7 m).
- Assets made through the API are private to the person's Summer library. A `fileUrl` downloads without a sign-in, so share it only where the file may be seen.

## Pitfalls

| Pitfall | Do this instead |
|---|---|
| Typing a price from memory | Read `summer api models`, then `summer api estimate` |
| Spending before the person agreed | Estimate, say the total, wait for a yes |
| Many single runs for a set of assets | One batch: all or none, priced up front |
| Resending a job that answered `queued` | It is accepted and its price is held. Follow it. |
| Treating `no_credits` or `over_limit` as a bug to retry | Show the message and its link; wait for the person |
| A new idempotency key on a retry after a timeout | The same key: it returns the first job, never a second charge |
| A token or a sign-in in game code | Only the developer's tools sign in. A shipped game uses Summer Router (the `summer-router` skill). |
| Several objects in one 3D prompt | One object per job; place them in the engine |

## Done means

- Every job you started is `done`, or you told the person which failed and why.
- The files are in the folder the person asked for, and you told them the paths and formats.
- You told the person what it cost (`price` on each job, or the batch's `estimatedPrice`).
