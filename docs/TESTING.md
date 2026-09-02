# Testing this branch end to end (nothing published)

How a human tests `v3-foundation` on their own machine with the real Summer
Engine app and a real agent, without publishing to npm. Every command below was
run while writing this page; the outputs shown are what it printed (engine not
running unless said otherwise).

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
- A checkout: `git clone https://github.com/SummerEngine/summer-engine-agent && cd summer-engine-agent && git checkout v3-foundation`.

## b. Build

```bash
npm ci && npm run build      # ~155 packages, then tsc -> dist/
```

## c. Point an agent at this checkout

```bash
node dist/bin/summer.js setup claude-code --local-dev --yes
```

What it does (verified output at the time of writing; counts move as the library does):

```
  ✓  Linked to Claude Code  ~/.claude.json
  (local dev)  MCP server command: node /abs/path/summer-engine-agent/dist/bin/summer.js mcp
  ✓  Installed every stable skill (preview skills are skipped unless `--include-preview`) (80 new, 0 updated; 10 preview skipped — use --include-preview)  ~/.claude/skills/
Doctor …
```

- `~/.claude.json` gets `mcpServers.summer-engine = { command: "node", args: ["<abs>/dist/bin/summer.js", "mcp"] }` — the checkout, not `npx summer-engine@latest`. Any other `mcpServers` entries are kept.
- Skills land in `~/.claude/skills/<skill>/SKILL.md` (plus `~/.claude/commands/summer.md` and `gameskill.md`). Only `status: stable` skills install by default; the `status: preview` ones (the intake skills plus `scene-scripting`, `verifying-scenes`, `world-building-3d`) need `--include-preview`:

  ```bash
  node dist/bin/summer.js setup claude-code --local-dev --yes --include-preview
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

That rewrites the MCP entry to `npx -y summer-engine@latest mcp` and re-copies the published skills (`--force` wipes the checkout's copies first).

## d. Quick verification, no agent involved

Run these from any directory with the engine open on a project.

| Command | Expect |
|---|---|
| `summer doctor` | 10 checks. `Local API` and `MCP Tools 69 tools registered` OK when the engine is up. Exit 0 with warnings; only failures make it exit 1. Not signed in is a warning — engine tools do not need login. |
| `summer tool --list` | `Summer tools (69)`, one line each; `[engine]` marks the ones that need the editor. |
| `summer tool get-project-context` | JSON: project, open scene, engine version, capabilities. Read `capabilitySkewWarning` if present — it names ops this CLI can send that the engine build does not advertise. |
| `summer tool get-scene-tree --args '{"depth":1}'` | JSON tree of the open scene, one level deep. |
| `summer tool screenshot` | Captures the editor viewport and prints the receipt JSON with `localPath` (`<tmpdir>/summer-cli/screenshot-<timestamp>.png`). Open the file. |
| `summer skills list` | One line per library skill (`recommended`/`optional`, `[preview]` tag on preview skills), footer naming `--include-preview`. |
| `summer tool api-docs --args '{"class_name":"MeshInstance3D","member":"mesh"}'` | Works without the engine (offline class reference) — a sanity check that the build itself is fine. |

Engine not running, each `[engine]` command prints exactly this and exits 1:

```
Summer Engine is not running (or no project is open).
Summer Engine is not running (no api-token found). Open Summer Engine first.
Start it with 'summer run' or open the project in the Summer desktop app, then retry.
Engine-free tools (generate-*, asset search/list/get, creator, plan) work without it.
```

## e. From Claude Code

Open Claude Code in a directory (any), confirm `/mcp` lists `summer-engine`, then try, in order:

1. "Read the scene tree and describe the level." — expect `summer_get_project_context` then `summer_get_scene_tree`, and a description that matches what is open.
2. "Add a MeshInstance3D cube at (0, 1, 0) and screenshot it." — expect `summer_add_node` (+ `summer_set_prop` / `summer_set_resource_property` for the BoxMesh), `summer_save_scene`, `summer_screenshot`; the cube is in the editor and the scene is saved.
3. "Use the design-mechanic skill to plan a dash." — expect the skill to load (Claude names it) and a plan with the skill's structure, no engine mutation.
4. "Report feedback on the skill you used." — expect `summer_library_feedback` with `entry_id: skill/design-mechanic` and one outcome word. The first call on a machine returns the disclosure notice and sends nothing (see g); the second sends.

## f. Expected to fail on the shipped engine

The 12 `status: preview` tools depend on engine ops no shipped build has:
`run-script`, `run-editor-script`, `world-snapshot`, `snapshot-diff`,
`get-runtime-tree`, `inspect-runtime-node`, `test-placement`, `snap-to-surface`,
`align-distribute-3d`, `frame-camera`, `camera-visibility`, `navigation-probe`
(`grep -l 'status: preview' library/tools/*/resource.yaml`). Calling one returns a
structured `engine_lacks_op` result and exits 1 — the same on the MCP face
(`isError`) and the CLI face. Two shapes, depending on what the engine advertises:

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

Unblocked by engine PRs **SummerEngine/SummerEngine #155** (headless worker) and **#156** (scene scripting); the six spatial tools additionally need the world-tool engine half (`docs/design/ROADMAP.md`). Until those merge, a `worked` outcome for any of these is impossible — record `engine_lacks_op` as the expected result, not a failure.

`SUMMER_HEADLESS_ROUTING=1` (route tool calls to a headless worker when no editor has the project open) needs the worker build from #155. Without it the flag does nothing. With a worker binary: `SUMMER_ENGINE_BIN=/path/to/Summer npx vitest run src/core/headless/worker-integration.test.ts` (`docs/HEADLESS_ROUTING.md`).

## g. Feedback tool and telemetry

```bash
ARGS='{"reports":[{"entry_id":"skill/3d-lighting","outcome":"worked","note":"manual TESTING.md check"}],"engine_version":"0.5.65","agent_model":"manual-test"}'

SUMMER_NO_TELEMETRY=1 summer tool library-feedback --args "$ARGS"   # {"recorded": false, "disabled": true}  — nothing sent, ever (DO_NOT_TRACK=1 works too)
summer tool library-feedback --args "$ARGS"                         # first call on this machine: {"recorded": false, "first_run": true, "notice": "First use … NOTHING has been sent yet …"}
summer tool library-feedback --args "$ARGS"                         # second call: {"recorded": true} — this one lands in the live mailbox
```

- The first-run notice is the disclosure (what each report contains, opt-out); it is shown exactly once per machine, gated by `~/.summer/feedback-first-run`. Delete that file to see it again.
- To exercise the send path without posting to the real mailbox: `SUMMER_GATEWAY_URL=http://127.0.0.1:9 summer tool library-feedback --args "$ARGS"` → `{"recorded": false, "dropped": true}` (no retry, no queue; the batch is gone).
- Logged in, the report carries the account bearer token; logged out, a random `install_id` from `~/.summer/`. Nothing about the project, files, or chat is in the schema.

## h. Gates

```bash
npx tsc --noEmit                        # types
npm test                                # vitest (~860 tests) + validate:library
npm run validate:library                # schema + capability lint over library/
npm run generate:registry -- --check    # registry parity; "no drift" or a list of files. After changing any resource.yaml: npm run generate:registry, commit both.
npm run eval:routing                    # gated on evals/routing/baseline.json. A corpus-size change (new entries) fails it until `-- --update-baseline` is committed with those entries.
npm run eval:routing:heldout            # report-only; the honest index-quality number
```

Two tests skip loudly without a sibling engine checkout / worker build (`docs/DEVELOPMENT.md`). A skip is not a pass.

## i. Reporting findings

Nothing lives only in chat. For each finding:

1. One row in the current review ledger, `docs/design/REVIEW-<date>.md` (P0 blocks publish / P1 wrong and user-visible / P2 debt; one line; an owner). Start a new dated file for a new review.
2. Flip the matching row in `docs/design/STATUS.md` — "If it isn't here, it isn't real." Verified rows say *how* they were verified.
3. Paste the exact command and output. "It didn't work" is not a finding.
