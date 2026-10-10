# Testing an unpublished build end to end

How to test a checkout of this repo on your own machine with the real Summer
Engine app and a real agent, without publishing to npm. Outputs shown are with
the engine not running unless said otherwise.

`summer …` below means `node dist/bin/summer.js …` run from the checkout.
`tsc` does not set the executable bit, so call it through `node`, or for the
session: `alias summer="node $PWD/dist/bin/summer.js"`.

## a. Prerequisites

- Node >= 20 (`node --version`). The registry/eval scripts run TypeScript
  natively and need >= 22.18.
- git.
- The Summer Engine app installed (`/Applications/Summer.app` on macOS —
  `summer install`, or [summerengine.com/download](https://summerengine.com/download))
  and a **project open** in it. Engine tools talk to the open editor over
  `127.0.0.1:<port>` using `~/.summer/api-token` + `api-port`, which the editor
  writes on launch. Without it, every `[engine]` tool prints
  "Summer Engine is not running (or no project is open)" and exits 1 — that is
  the expected engine-less result, not a bug.
- A checkout: `git clone https://github.com/summerengine/summer && cd summer && git checkout <branch under test>`.

## b. Build

```bash
npm ci && npm run build      # tsc -> dist/
```

## c. Point an agent at this checkout

```bash
node dist/bin/summer.js setup claude-code --local-dev --yes
```

What it prints:

```
  ✓  Linked to Claude Code  ~/.claude.json
  (local dev)  MCP server command: node /abs/path/summer/dist/bin/summer.js mcp
  ✓  Installed <N> skills (<N> new, 0 updated; <M> preview — labelled in each skill's guidance; use --stable-only to skip)  ~/.claude/skills/
Doctor …
```

- `~/.claude.json` gets `mcpServers.summer-engine = { command: "node", args: ["<abs>/dist/bin/summer.js", "mcp"] }` — the checkout, not `npx summer-engine@latest`. Any other `mcpServers` entries are kept.
- Skills land in `~/.claude/skills/<skill>/SKILL.md` (plus `~/.claude/commands/summer.md` and `gameskill.md`). Every skill installs by default, `status: preview` ones included. Preview is a label carried in each skill's guidance, not a gate. To install only `status: stable` skills:

  ```bash
  node dist/bin/summer.js setup claude-code --local-dev --yes --stable-only
  ```

- `--scope project` writes `.mcp.json` and `.claude/skills/` in the current directory instead of `~`.
- Restart Claude Code (or run `/mcp`) so it picks up the new server.
- `--print` shows the MCP entry without writing; `--dry-run` shows the whole plan without writing.
- To try the install itself without touching your real config, run it in a scratch HOME first: `HOME=$(mktemp -d) node dist/bin/summer.js setup claude-code --local-dev --yes` (this page was verified that way).

Same for other agents (paths from `--print`):

```bash
node dist/bin/summer.js setup codex --local-dev --yes     # ~/.codex/config.toml  [mcp_servers.summer-engine] command = "node" …
node dist/bin/summer.js setup cursor --local-dev --yes    # ~/.cursor/mcp.json    same JSON shape as Claude Code
```

`SUMMER_DEV=1` has the same effect as `--local-dev`. Revert to the published package:

```bash
npx -y summer-engine@latest setup claude-code --yes --force
```

That rewrites the MCP entry to `npx -y summer-engine@latest mcp` and re-copies the published skills (`--force` wipes the checkout's copies first). While a release soaks on the `next` dist-tag, `npx -y summer-engine@next setup claude-code --yes --force --channel next` — without `--channel next` the entry would run `@latest`, i.e. the previous release.

## d. Quick verification, no agent involved

Run these from any directory with the engine open on a project.

| Command | Expect |
|---|---|
| `summer doctor` | One line per check. `Local API` is OK when the engine is up; `MCP Tools` is OK when the registered tool count matches `registry/generated/counts.json`. Exit 0 with warnings; only failures make it exit 1. Not signed in is a warning — engine tools do not need login. Stale skills (`Skills up to date`) are a warning too, and on a `--local-dev` link the recommended refresh is `node <checkout>/dist/bin/summer.js setup <agent> --local-dev --yes --force`, which keeps the link — the `npx … --force` form is recommended only when the agent's MCP entry already points at the published package. `Project Memory` counts the template pin (`pin template/<id>@<version>`) next to the Markdown files. |
| `summer tool --list` | `Summer tools (<N>)` where N is `byKind.tool` in `registry/generated/counts.json`, one line each; `[engine]` marks the ones that need the editor. |
| `summer tool get-project-context` | JSON: project, open scene, engine version, capabilities, `projectMemory` (with `pin` = `.summer/project.json`), `guidance` — byte-identical to the MCP face (both call `buildProjectContext`). Settings are trimmed to the curated default groups and the trim is declared (`settingsTruncated`, `totalSettings`, `settingsPrefixesIncluded`, `settingsPrefixesExcluded`); `--args '{"settingsPrefixes":["audio/","layer_names/"]}'` reads other groups. Read `capabilitySkewWarning` if present — it names ops this CLI can send that the engine build does not advertise. |
| `summer tool get-scene-tree --args '{"depth":1}'` | JSON tree of the open scene, one level deep. |
| `summer tool screenshot` | Captures the editor viewport and prints the receipt JSON with `localPath` (`<tmpdir>/summer-cli/screenshot-<timestamp>.png`). Open the file. |
| `summer skills list` | One line per library skill (`recommended`/`optional`, `[preview]` tag on preview skills), footer naming `--stable-only`. |
| `summer tool api-docs --args '{"class_name":"MeshInstance3D","member":"mesh"}'` | Works without the engine (offline class reference) — a sanity check that the build itself is fine. |

Engine not running, each `[engine]` command prints exactly this and exits 1:

```
Summer Engine is not running (or no project is open).
Summer Engine is not running (no api-token found, no live editor registered in ~/.summer/instances). Open Summer Engine first.
Start it with 'summer run' or open the project in the Summer desktop app, then retry.
Engine-free tools (generate-*, asset search/list/get, creator, plan) work without it.
```

## e. From Claude Code

Open Claude Code in a directory (any), confirm `/mcp` lists `summer-engine`, then try, in order:

1. "Read the scene tree and describe the level." — expect `summer_get_project_context` then `summer_get_scene_tree`, and a description that matches what is open.
2. "Add a MeshInstance3D cube at (0, 1, 0) and screenshot it." — expect `summer_add_node` (+ `summer_set_prop` / `summer_set_resource_property` for the BoxMesh), `summer_save_scene`, `summer_screenshot`; the cube is in the editor and the scene is saved.
3. "Use the design-mechanic skill to plan a dash." — expect the skill to load (Claude names it) and a plan with the skill's structure, no engine mutation.
4. "Report feedback on the skill you used." — expect `summer_library_feedback` with `entry_id: skill/design-mechanic` and one outcome word. The first call on a machine returns the disclosure notice and sends nothing (see g); the second sends.
5. "Run an editor script that counts the nodes in the open scene and prints the total." — expect `summer_run_editor_script` and a printed count that matches `summer_get_scene_tree`.

## f. Expected to fail on older engines

Many `status: preview` tools need engine ops that older Summer Engine builds
lack. Each such descriptor says so in `do_not_use_when` ("requires an engine
build with … (Summer Engine 0.5.66 or newer)"):
`grep -l 'requires an engine build' library/tools/*/resource.yaml` lists them. Calling one on an older build returns a structured `engine_lacks_op`
result and exits 1, the same on the MCP face (`isError`) and the CLI face.
Every other engine failure follows the same rule: whatever the MCP face marks
`isError`, `summer tool` prints as JSON (`ok: false`, `error`, any
`failure_reason`) and exits 1 — `summer tool inspect-node --args
'{"path":"Nope"}'` is the smoke test. Two shapes, depending on what the engine
advertises:

- Engine advertises `capabilities.opKinds` without the op — refused **before** sending:

  ```json
  { "ok": false, "op": "GetWorldSnapshot", "failure_reason": "engine_lacks_op", "engine_version": "0.5.65",
    "error": "This Summer Engine build (engine version 0.5.65) does not support the GetWorldSnapshot op — nothing was sent. Update Summer Engine (restart it after updating). Until then: read structure with summer_get_scene_tree and verify visually with summer_screenshot. If your engine build implements this op but does not advertise it yet, set SUMMER_CAPABILITY_PREFLIGHT=off …",
    "hint": "…" }
  ```

- Engine advertises no `opKinds` (0.5.65 advertises `singleOnlyOps` only) — the op is sent, the engine answers `unknown op: <Kind>`, and the receipt is rewritten:

  ```json
  { "ok": false, "results": [ { "ok": false, "op": "GetWorldSnapshot", "error": "unknown op: GetWorldSnapshot" } ],
    "op": "GetWorldSnapshot", "failure_reason": "engine_lacks_op",
    "error": "This Summer Engine build doesn't support GetWorldSnapshot yet — read structure with summer_get_scene_tree and verify visually with summer_screenshot, or update Summer Engine (restart it after updating). Engine said: unknown op: GetWorldSnapshot" }
  ```

`SUMMER_CAPABILITY_PREFLIGHT=off` (in the shell for the CLI, in the MCP server's env for an agent) skips the pre-flight and lets the engine answer — for an engine build that implements an op it does not advertise yet. With it set, the first shape turns into the second.

The other two — `wait-for-event` and `recent-events` (and the `summer events` command) — need the engine **events channel** (`capabilities.events` in `/api/health`, `GET /api/events/poll`) rather than an op. Without it they return `failure_reason: "engine_lacks_events"` before sending anything, on both faces; with the same escape hatch set, the poll is sent and the engine's 404 is rewritten into the same shape.

On an engine that lacks the op, record `engine_lacks_op` as the expected result, not a failure.

`SUMMER_HEADLESS_ROUTING=1` (route tool calls to a headless worker when no editor has the project open) needs an engine build with worker mode. Without it the flag does nothing. With a worker binary: `SUMMER_ENGINE_BIN=/path/to/Summer npx vitest run src/core/headless/worker-integration.test.ts` (`docs/HEADLESS_ROUTING.md`).

## g. Feedback tool and telemetry

```bash
ARGS='{"reports":[{"entry_id":"skill/3d-lighting","outcome":"worked","note":"manual TESTING.md check"}],"engine_version":"0.5.65","agent_model":"manual-test"}'

SUMMER_NO_TELEMETRY=1 summer tool library-feedback --args "$ARGS"   # {"recorded": false, "disabled": true}  — nothing sent, ever (DO_NOT_TRACK=1 works too)
summer tool library-feedback --args "$ARGS"                         # first call on this machine: {"recorded": false, "first_run": true, "notice": "First use … NOTHING has been sent yet …"}
summer tool library-feedback --args "$ARGS"                         # second call: {"recorded": true} — this one lands in the live mailbox
```

- The first-run notice is the disclosure (what each report contains, opt-out); it is shown exactly once per machine, gated by `~/.summer/feedback-first-run`. Delete that file to see it again.
- To exercise the send path without posting to the real mailbox: `SUMMER_GATEWAY_URL=http://127.0.0.1:9 summer tool library-feedback --args "$ARGS"` → `{"recorded": false, "dropped": true, "reason": "network"}` (no retry, no queue; the batch is gone). A gateway that answers is reported with its `status` and a `reason`: `endpoint_missing` (404 — the route is not deployed), `rejected` (other 4xx), `server_error` (5xx). Nothing about the failure is sent anywhere; the report schema is unchanged.
- Logged in, the report carries the account bearer token; logged out, a random `install_id` from `~/.summer/`. Nothing about the project, files, or chat is in the schema.

## g2. Working in the background

An agent driving Summer must not take over the user's screen. Three launch postures exist on the engine side: **focus** (window appears and takes focus — what a human clicking Play or typing `summer run` expects), **background** (`--summer-background`, engine 0.5.66+: the window exists but never activates or takes focus until the user clicks it), and **offscreen** (`--summer-offscreen`, also implied by `--summer-verify`: never activates, never frontmost; on older engines an unfocusable window pushed off-screen where a sliver may stay visible; newer engines make it a no-Dock-icon accessory process). What each command does when an agent drives it:

| Command | Default when an agent drives | Opt in to focus |
|---|---|---|
| `summer run <path>` | **background** when stdout is not a TTY (Claude Code's Bash tool, MCP hosts, CI). Passes `--summer-background` only when the installed engine is known to honour it. Primary gate: `<binary> --help` lists the flag (exits headless before any window; cached per binary path + mtime in `~/.summer/launch-probe-cache.json`, so it runs once per install). The installed version (macOS Info.plist / Windows `sq.version`) is only the fallback when `--help` cannot run — never a pre-check, because dev and pre-release builds carry the flag while still stamped 0.5.65. Otherwise it launches with focus and prints one line saying this engine cannot launch without focus (or that it could not be probed — Linux has no version file). Always spawns the executable directly, never `open -a`, which would activate the app. Once up, `/api/health capabilities.launchPostures` is the authoritative advert. A human in a terminal gets **focus** by default. | `--focus` (and `--background` to force the other way) |
| `summer_play` / `summer tool play` | **quiet**: `PlayGame agent:true` — the editor does not switch to the Game tab, grab focus for the embedded game, or run the render-health self-check. The game still runs embedded and is visible to `summer_is_running`, `summer_screenshot target:'game'`, diagnostics. On background-posture engines (0.5.66+) the play child also gets `--summer-background`, so a separate-window game appears without focus too. The result echoes `agent_quiet:true`; an engine that predates quiet play (< 0.5.45) gets a `posture_note`. | `focus: true` |
| `summer_screenshot` | never launches or focuses anything: `viewport` reads the editor viewport back, `scene` renders offscreen in a SubViewport, `game` reads the running game's frame. | n/a |
| RunVerification probes (`summer_batch` / playbook `rawOpsViaBatch`) | the engine runs the probe child with the **offscreen** posture (`--summer-verify` implies it). | n/a |
| `summer_play {instance, mode:'offscreen'}` | a hidden child (offscreen posture) on runtime-control engine builds; `engine_lacks_op` on older engines. | n/a |

Engine side: `/api/health` advertises `capabilities.launchPostures: ["focus","background","offscreen"]` ("focus" always; the other two only where the build enforces them, so non-macOS builds say `["focus"]`; a missing key on older engines reads as `["focus"]`). The CLI reads it (camelCase or snake_case) for the post-launch note and `summer_get_project_context`. The pre-launch decision cannot use health (nothing is running yet), hence the `--help` probe.

## h. Gates

```bash
npx tsc --noEmit                        # types
npm test                                # vitest + validate:library
npm run validate:library                # schema + capability lint over library/
npm run generate:registry -- --check    # registry parity; "no drift" or a list of files. After changing any resource.yaml: npm run generate:registry, commit both.
npm run eval:routing                    # gated on evals/routing/baseline.json. A corpus-size change (new entries) fails it until `-- --update-baseline` is committed with those entries.
npm run eval:routing:heldout            # report-only; the honest index-quality number
```

Two tests skip loudly without a sibling engine checkout / worker build (`docs/DEVELOPMENT.md`). A skip is not a pass.

## i. Reporting findings

Nothing lives only in chat. For each finding:

1. Open a GitHub issue with one line per finding (P0 blocks publish / P1 wrong and user-visible / P2 debt).
2. Paste the exact command and output. "It didn't work" is not a finding.
