# Canary: blind A/B gateway for tool-suite trials

A stdio MCP **proxy** that sits between an agent under test and the real
`summer mcp` server and makes the agent blind to which arm it is in. It exists
to answer one question honestly: *does giving an agent a specific new tool
change what it does?* — without the agent knowing the tool is the thing being
measured.

## What it does

- **Catalog policy.** Five tools are "canaries" (`CANARY_TOOL_NAMES` in
  `canary-gateway-core.ts`): `summer_starcast`, `summer_test_placement`,
  `summer_snap_to_surface`, `summer_align_distribute_3d`,
  `summer_navigation_probe`. The **control** arm hides all five; the
  **treatment** arm reveals exactly one (`--canary <tool>`). Everything else in
  the real catalog is passed through unchanged, so the two arms differ by one
  tool and nothing else (pinned by the unit test).
- **Fixed call budget.** `--max-calls <n>` per trial. Every attempted call
  consumes budget — including a call to a hidden tool — so a control agent
  cannot probe for hidden canaries for free. The budget is persisted in the
  artifacts directory and fails closed once exhausted.
- **No raw-op escape.** `summer_batch` is a raw engine-op hatch; the gateway
  refuses any batch containing a canary op (`Starcast3D`, `TestPlacement3D`,
  …, `CANARY_RAW_OP_NAMES`) so a hidden tool cannot be reconstructed by
  guessing its op name.
- **Evidence, not scores.** Every startup and call is appended to
  `calls.jsonl` with latencies, byte sizes, an input hash, and whether the tool
  reported an error. Image/audio blocks are written to `media/` and replaced
  in the recorded result by path + size + sha256, so the log stays readable.
- **Auditable arms.** `catalog.json` + `catalog.sha256` pin the exact filtered
  catalog the agent saw; `trial.json` pins project, server entry, policy,
  budget, timeout. A second invocation against the same artifacts directory
  must reproduce the same catalog hash or it refuses.

It does **not** score anything. For the placement A/B it was built for, you
compute the measures (grounded state, contact/overlap, target-center error,
per-side clearances, number of corrections, two same-camera renders) from the
trial's `calls.jsonl` results and captures.

## Running an A/B

Requires Node >= 22.18 (it runs unbuilt, like the rest of `evals/` and
`scripts/`) and a built CLI — the default server entry is this checkout's
`dist/bin/summer.js`:

```bash
npm run build
```

Pick a Godot project for the fixture (`--project` must contain
`project.godot`). One artifacts directory per arm, never reused across arms.

```bash
# Arm A — control: canaries hidden.
npm run eval:canary -- --project ./fixture --artifacts /tmp/trial-A --policy control --max-calls 12 list

# Arm B — treatment: exactly one canary revealed.
npm run eval:canary -- --project ./fixture --artifacts /tmp/trial-B --policy treatment --canary summer_starcast --max-calls 12 list
```

The agent under test talks **only** to the gateway (give it the command line,
never the server or the artifacts directory — `trial.json` names the arm):

```bash
npm run eval:canary -- <arm flags> describe summer_starcast
npm run eval:canary -- <arm flags> call summer_starcast '{"scenePath":"res://main.tscn","path":"./World/Crate"}'
npm run eval:canary -- <arm flags> call summer_batch '{"scenePath":"res://main.tscn","ops":[{"op":"SetProp","path":"./World/Crate","prop":"position","value":"Vector3(1, 0.5, -1)"}]}'
```

Every call is one gateway process that boots a fresh MCP server, forwards one
request, and exits; `startupLatencyMs` is recorded so cold-start cost is
visible rather than hidden in tool latency.

**Two tool-suite builds.** To compare suites rather than arms of one suite,
point each arm at its own build with `--server-entry <path>/dist/bin/summer.js`
(the host loads `../mcp/server.js` beside it and calls `startMcpServer`). The
entry is recorded in `trial.json`.

Calling engine-backed tools needs Summer Engine running with that project
open; `list`/`describe` and the gating paths do not.

## Outputs (per artifacts directory)

| File | Contents |
|---|---|
| `catalog.json`, `catalog.sha256` | The filtered catalog the agent saw (canonical JSON, sorted) and its hash |
| `trial.json` | project, server entry, host entry, policy, canary list, max calls, timeout, catalog hash |
| `budget.json` | `{version, maxCalls, usedCalls}` — the fail-closed budget (`budget.lock` exists only during an update) |
| `calls.jsonl` | one event per line: `startup`, `mcp_call`, `mcp_call_error`, `gateway_error`, `startup_error` — latencies, byte sizes, input sha256, `toolReportedError`, media file list, error code |
| `media/` | image/audio blocks stripped from results, named `call-NNN-block-MM.<ext>` |
| `mcp-server.stderr.log` | the real server's diagnostics (its stdout is the MCP transport) |

Gateway errors are structured: `{"ok":false,"error":{"code":…,"message":…}}`
with codes such as `tool_not_visible`, `canary_raw_op_denied`,
`call_budget_exhausted`, `canary_not_registered`, `mcp_startup_failed`.

## Tests

`npm test` runs `canary-gateway-core.test.ts`: the arms differ by exactly one
canary; a hidden call is denied before invoke and still consumes budget; every
canary raw op is denied through `summer_batch`; the budget fails closed; the
catalog hash is order-independent; media blocks are sanitized.

The scripts run unbuilt under Node type stripping. Only the CLI they proxy
needs `npm run build`. Dependencies: `@modelcontextprotocol/sdk` and the built
server's `startMcpServer({ projectPath, cwd })`.
