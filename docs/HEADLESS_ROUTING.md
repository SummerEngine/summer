# Headless per-project routing (`src/core/headless/`) — protocol v1.1

Contract doc for the headless routing layer. It is an isolated, adoptable
routing layer inside `src/core/`: when a tool call targets a project, it is
served by (1) a live editor that has the project open, else (2) a live
headless worker from the process registry, else (3) a worker spawned on
demand. It ships dark — everything below is inert unless
`SUMMER_HEADLESS_ROUTING=1`.

Protocol version: **v1.1** (mutual auth — the raw token never crosses the
wire; byte-exact framing with an 8MiB frame cap; pid verification against the
registry). v1.0's plaintext `{"token":...}` first line is gone.

**Activation dependency.** This is the CLI/MCP half only. The engine half —
`--summer-worker` mode, the `summer_processes.cfg` registry, the v1.1
handshake — lives on the `summerengine` branch `feature/headless-worker` and
must merge and be rebased over 4.7.x before the flag does anything against a
shipped build. Until then the flag stays off and nothing in this repo changes
behavior (see `docs/design/ROADMAP.md` §3).

## Files

All under `src/core/headless/`. It is engine-connection plumbing, so it sits
in the `core` layer per `docs/design/CONTRACT.md` §2 (cli → core, mcp → core,
never core → cli/mcp). Its only in-repo dependencies are `src/core/api-client.ts`
(`EngineApiClient`), `src/core/engine.ts` (`findProjectRoot`, editor
discovery via `EngineApiClient.connect`), and node builtins.

| File | What it is |
| --- | --- |
| `src/core/headless/connection.ts` | `ProjectConnection` interface (`kind: 'editor' \| 'worker'`, uniform `call(op, params, {timeoutMs, onProgress})`, `isAlive()`, `close()`), canonical worker-op list |
| `src/core/headless/registry.ts` | Reader for `<editor cache dir>/summer_processes.cfg` with dead-pid pruning; cache-dir resolution |
| `src/core/headless/worker-connection.ts` | `WorkerConnection` — TCP NDJSON client (v1.1 mutual auth, byte-exact framing + frame cap, id correlation, progress events, mutation quarantine, fail-clean on drop) |
| `src/core/headless/editor-connection.ts` | `EditorConnection` — adapter presenting the EXISTING `EngineApiClient` HTTP transport (untouched) through `ProjectConnection` |
| `src/core/headless/spawn.ts` | `spawnWorker()` — launch `<engine> --summer-worker --path <project>`, poll registry up to 120s; `findEngineBinary()` with `SUMMER_ENGINE_BIN` override |
| `src/core/headless/resolve.ts` | `resolveProjectConnection(projectPath)` — the editor-beats-worker-beats-spawn decision, every step injectable |
| `src/core/headless/worker-engine-client.ts` | `WorkerEngineClient` — EngineApiClient-shaped facade over a worker so existing MCP tools run unmodified |
| `src/core/headless/mcp-routing.ts` | `getHeadlessRoutedClient(selection)` — the single hook `src/mcp/server.ts` calls behind the flag |
| `src/core/headless/*.test.ts`, `src/core/headless/test-helpers/fake-worker.ts` | Vitest coverage with an in-process fake worker TCP server (the fake server is committed and enforces the v1.1 handshake + integer-id contract; run everything with `npm test`, or just this module with `npx vitest run src/core/headless`) |
| `src/core/headless/worker-integration.test.ts` | REAL end-to-end test against the actual worker binary — skipped unless `SUMMER_ENGINE_BIN` is set (so it never fails CI). Run: `SUMMER_ENGINE_BIN=/path/to/Summer npx vitest run src/core/headless/worker-integration.test.ts` |

## Registry schema

`<editor cache dir>/summer_processes.cfg`, ConfigFile/INI format. One section
per process; the section name is the absolute project path:

```ini
["/Users/dev/MyGame"]
role="worker"
pid=12345
port=6600
token="hex-token"
started_ts=1756700000
```

- Trust boundary: the registry path must be a REGULAR file — a symlink
  planted there is refused (`lstat`, no follow), as is a file over 512KiB.
  The registry alone is never sufficient to trust a socket: the v1.1
  handshake additionally proves the peer holds the token and is the
  registered pid.
- Sections whose `pid` is dead (`process.kill(pid, 0)` throws non-EPERM) are
  pruned from reads. The CLI never rewrites the file — the engine/worker owns
  it; pruning is in-memory filtering only.
- Entries missing `token`, with a non-integer `pid`, or an out-of-range
  `port` are skipped without hiding other sections. Unknown keys are ignored
  (forward-compatible). A corrupt or partially-written file parses to an
  empty registry, never a crash — same meaning as "no workers".
- Section matching normalizes paths (`normalizeProjectPath`): resolve +
  **realpath** (the engine canonicalizes — macOS `/var` → `/private/var`;
  non-existent paths fall back to the resolved form), trailing separators
  stripped; on Windows case-insensitive with `\` → `/`. Applied consistently
  to registry lookups AND single-flight keys.
- Editor cache dir = OS cache path + engine dir name:
  - macOS: `~/Library/Caches/Summer` (platform/macos/os_macos.mm:503 + :561;
    verified on disk — shipped builds are branded `Summer`; unrebranded dev
    builds use the upstream `Godot` name, which the reader probes as a
    fallback when the registry file exists there)
  - Windows: `%LOCALAPPDATA%/Summer`
  - Linux: `$XDG_CACHE_HOME`-or-`~/.cache` `/summer`
  - `SUMMER_CACHE_DIR` env overrides everything — **pairing requirement**:
    the override only works when BOTH sides honor it. The CLI reads the
    registry from it AND passes it through to the spawned worker's env
    (spawn.ts does this explicitly); engine-side support for honoring it is
    landing with the worker. Until the engine honors it, leave
    `SUMMER_CACHE_DIR` unset in production — it is primarily a test seam.

Editors keep registering in the existing editor-instance registry
(`~/.summer/instances/*.json`, `src/core/engine.ts listEngineInstances`);
workers register in `summer_processes.cfg`. As of the engine-side fix,
worker processes NO LONGER write `~/.summer/instances` entries — the
instance registry is editors-only, so editor discovery can never mistake a
worker for an editor. `summer_processes.cfg` is the single source of truth
for workers.

## Worker wire protocol (v1.1)

TCP `127.0.0.1:<port>`, newline-delimited JSON, one document per line:

1. **Mutual auth.** The WORKER sends first, within 3s of accept:
   `{"hello":{"pid":<int>,"nonce":"<32 hex>","proof":"<hex sha256(nonce + ':' + token)>"}}`
   The client verifies `proof` against the REGISTRY token (the worker proves
   possession without the token crossing the wire) and `hello.pid` against
   the REGISTRY pid (pid-reuse / port-squat detection), then answers:
   `{"auth":"<hex sha256('client:' + nonce + ':' + token)>"}`
   The raw token never crosses the wire in either direction. Any mismatch,
   malformed hello, or hello timeout → the client destroys the socket and
   surfaces a FIXED `[headless:auth]` message (never worker-supplied text,
   never token material). The worker likewise destroys the socket on a bad
   client `auth` line.
2. Requests: `{"id": "...", "op": "...", "params": {...}}`
3. Responses: `{"id": "...", "ok": true, "result": ...}` or
   `{"id": "...", "ok": false, "error": "..."}` — the error string SHOULD
   start with a snake_case classifier (`sha256_mismatch: ...`,
   `already_exists`, `needs_display`) which the client exposes as
   `WorkerOpError.code`, distinguishable from transport throws.
4. Interim progress: `{"id": "...", "event": "progress", "progress": ...}`
   (zero or more per request, surfaced via `CallOptions.onProgress`).

Framing: split on `\n` BYTES before utf-8 decoding — a multibyte codepoint
split across TCP chunks is reassembled, never corrupted. An un-terminated
frame is capped at **8MiB** (`MAX_FRAME_BYTES`); beyond that the connection
is destroyed with a clear error. The hello line is capped at 64KiB.

Worker ops: `ping`, `status`, `import`, `fs.list`, `fs.read`, `fs.write`,
`uid.resolve`, `scene.read`, `game.run`, `game.stop`, `game.logs`,
`game.screenshot` (may fail with error `needs_display` on a headless box).

Client behavior (`WorkerConnection`):

- **ID contract (pinned)**: request ids are POSITIVE JSON INTEGERS, minted
  monotonically per connection by the client. Never strings — the worker's
  engine-side String→int coercion turns a string id into `-1` and every op
  would time out. Responses/progress echo the integer id; out-of-order
  responses are fine.
- Write backpressure: the per-op inactivity timer STARTS only once the
  request has flushed to the socket (write-callback), so a slow send never
  eats the op budget. A write error rejects with "Nothing was submitted."
- **Mutation quarantine**: when an op in `MUTATING_OPS` (`import`,
  `fs.write`, `game.run`, `game.stop`) times out, the outcome is UNKNOWN —
  the connection is destroyed, `credentialsChanged()` reports drift so
  caches evict it, and the surfaced error states the outcome is unknown and
  instructs inspection before retry. Read-only timeouts leave the channel
  usable. This is the v1 stand-in for receipts (see v2 below).
- A dropped socket rejects ALL pending calls with a clean "final state is
  unknown; do not retry blindly" error and marks the connection permanently
  dead. There is deliberately NO transparent reconnect: the worker sends no
  idempotency keys, so a blind retry could double-apply — the same reasoning
  as `withEngine`'s narrow retry policy. Callers evict the dead connection
  (see `credentialsChanged` below) and re-resolve instead.
- `connect()` verifies the channel with a `ping` after the handshake
  (fail-fast if the worker rejected the client auth) — disable with
  `verifyWithPing: false`.

### Timeouts (all env-overridable; every timeout is a `HeadlessTimeoutError` naming its stage)

| Stage | Env override | Default | Notes |
| --- | --- | --- | --- |
| `connect` | `SUMMER_WORKER_CONNECT_TIMEOUT_MS` | 5s | TCP connect to the worker port |
| `auth` | `SUMMER_WORKER_HELLO_TIMEOUT_MS` | 3s | worker hello + handshake + ping verification |
| `op` | `SUMMER_WORKER_OP_TIMEOUT_MS` | 30s | per-request INACTIVITY: starts at flush, restarts on every progress line |
| `op` (long) | `SUMMER_WORKER_LONG_OP_TIMEOUT_MS` | 300s | for `import` and `game.run` (`LONG_RUNNING_OPS`) |
| `spawn` | `SUMMER_WORKER_SPAWN_TIMEOUT_MS` | 120s | spawned worker never appeared in the registry |

Per-op timeouts are inactivity-based: a long import that keeps emitting
progress lines never times out spuriously, while a silent hang still fails.
Error messages are prefixed `[headless:<stage>]` and carry a `.stage` field.

### Security hygiene

- v1.1 mutual auth: the raw token NEVER crosses the wire — both sides prove
  possession via sha256 over a per-connection nonce. The worker additionally
  proves it is the registered pid.
- No token material ever appears in an error message, log line, or thrown
  value. Auth-phase failures are FIXED strings (never worker-supplied text);
  worker op errors and spawn stderr tails are additionally passed through
  `scrubSecrets()` (token → `[redacted]`) as defense in depth. Covered by
  tests asserting connect/auth/op failures do not contain the token.
- Registry trust: regular-file check (`lstat`, symlinks refused) + 512KiB
  size cap before parsing; entries are validated field-by-field.
- Spawning uses an argv array (`spawn(binary, [...])`, no shell) — the
  project path is never interpolated into a shell string.
- Spawn stderr logs are `0600` in a `0700` directory (worker stderr can quote
  project content); only the last 4KB is ever read back (open + seek, never
  the whole file).

### Spawn process model (zombie hygiene)

- The worker is spawned DETACHED (own process group) and `unref()`ed: it
  deliberately outlives the CLI, since an MCP session ending must not kill a
  worker other sessions may use. It stays discoverable via the registry, and
  dead entries are pruned by pid-liveness on every read.
- While the CLI lives, node reaps the child on exit (no zombies) and the exit
  is used to fail fast: if the worker exits before its registry entry
  appears, the error surfaces the exit code and the tail (last 4KB) of its
  stderr, which is captured to a per-spawn log FILE under
  `<tmpdir>/summer-engine/worker-logs/` — a file, not a pipe, so a CLI exit
  can never EPIPE a healthy worker.
- Single-flight: concurrent spawn requests for the same canonical project
  path share ONE spawn attempt (module-level in-flight promise map in
  `spawn.ts`); the first caller's options win for the shared attempt.
- **Baseline snapshot (stale-entry defense)**: before launching, the current
  registry entry for the project (if any) is snapshotted. The post-spawn poll
  only accepts an entry that DIFFERS from that baseline (new pid/port/token
  or newer `started_ts`) — a stale entry whose pid probe still answers can
  never satisfy the poll, and the connect-fail-then-spawn path can never
  re-adopt the very entry it just failed to connect to.
- **No leaked children**: when a spawn attempt is abandoned (registry-poll
  timeout without adopting an entry), the just-spawned child is terminated
  via the launch handle (SIGTERM, escalating to SIGKILL after a 5s grace) —
  a worker nobody adopted never runs forever.

### Engine-binary discovery

`findEngineBinary()` in `spawn.ts`: `SUMMER_ENGINE_BIN` env first — this
layer's documented override; set-but-missing means "no binary" (null), never
a silent fallback — then the canonical resolver `findEngineBinary(os, env)`
from `src/core/engine-install.ts`, which honors its own `SUMMER_ENGINE_BINARY`
override and the platform install locations shared with `summer install`,
`summer run`, and `summer doctor` (macOS `/Applications/Summer.app/...`,
Windows `%LOCALAPPDATA%\SummerEngine\current\` etc., Linux
`~/.summer/engine/summer-linux-x86_64`). No install-path list is duplicated
in this module (the source's private MAC/WIN/LINUX lists were dropped at the
port). The real-binary integration test accepts either env name as its gate.

## Resolution order (`resolveProjectConnection`)

1. **Editor** — `EngineApiClient.connect({ projectPath })`, i.e. the existing
   instance-registry discovery in `src/core/engine.ts`. Any live editor with
   the project open wins, always. **Narrow fall-through**: only errors that
   positively mean "no editor has this project" (`isNoEditorForProjectError`:
   "No running Summer editor matches …" / legacy "no api-token found") fall
   through to the worker path. Ambiguity ("more than one editor matches"),
   identity changes, an unresponsive editor, auth failures, or a
   missing-project error RETHROW — a worker must never write while an
   editor's presence is uncertain.
2. **Live worker** — `findWorkerEntry(projectPath)` from
   `summer_processes.cfg` (live pid, `role="worker"`, normalized-path match:
   trailing slashes stripped; on Windows case-insensitive with separators
   normalized — `normalizeProjectPath`). If the entry exists but the socket
   is unreachable, fall through.
3. **Spawn** — `<engine binary> --summer-worker --path <project>` (argv
   array, detached, single-flight per project), then poll the registry until
   the worker's section appears (`SUMMER_WORKER_SPAWN_TIMEOUT_MS`, default
   120s; 500ms interval; progress surfaced via `onProgress`; early exit
   fails fast with the worker's stderr tail). Binary discovery:
   `SUMMER_ENGINE_BIN` env, then the same install locations `summer run`
   checks.

## The opt-in MCP hook (the ONLY existing-code change)

`src/mcp/server.ts getClient()` gained one guarded block at the top:

```ts
if (process.env.SUMMER_HEADLESS_ROUTING === "1") {
  const { getHeadlessRoutedClient } = await import(
    "../core/headless/mcp-routing.js"
  );
  const routed = await getHeadlessRoutedClient(engineSelection);
  if (routed) return routed;
}
```

Flag-off safety: with the env var unset the condition is false, the dynamic
import never runs (`src/core/headless/` is not even loaded — nothing else in
`src/` imports it statically), and `getClient()` is byte-identical in
behavior to before. Flag ON, `getHeadlessRoutedClient` returns `null` —
falling through to the untouched path — whenever (a) the session has no
project context (no `projectPath`, `cwd` not inside a project), or (b) a live
editor has the project open. The editor path therefore behaves identically
with the flag on or off, including client caching, credential-drift
reconnects, and identity binding. Only when no editor has the project does
the hook return a `WorkerEngineClient`.

`WorkerEngineClient` presents the same TypeScript surface as `EngineApiClient`
so the registered tools run unmodified — but only the methods in the table
below are *implemented* against the worker: `health`, `readFile` /
`readProjectFile`, `getFsTree`, `getSceneState`, `play`, `stop`,
`gameSnapshot`, and `executeOps` for the `WriteFile`, `GetConsoleOutput`,
and `IsGameRunning` ops, plus the identity/lifecycle getters
(`isAlive`, `close`, `getEngineCapabilities`, `getEngineVersion`,
`getBoundProjectIdHash`, `rebind`, `getPort`, `credentialsChanged`). Every
other method — `getProjectState`, `getDiagnostics`, `inspectNode`,
`inspectResource`, `getScriptErrors`, `getSelection`, `viewportSnapshot`,
`scenePreview`, and any other `executeOps` op — throws a typed
`UnsupportedOperationError` before anything is sent
(`src/core/headless/worker-engine-client.ts`). Verified param mapping for the
implemented set (integration-tested against a fake worker; the real-binary
test skips until an engine build ships worker mode):

All paths are sent PROJECT-RELATIVE: a leading `res://` is stripped
client-side before any path crosses the wire (the worker also tolerates
`res://` — both sides accept both forms).

| Facade method / editor op | Worker op | Params sent | Dropped / shifted client-side |
| --- | --- | --- | --- |
| `health()` | `status` | `{}` | — |
| `readFile(path, maxBytes)` | `fs.read` | `{path, maxBytes}` | `res://` stripped; `maxBytes` clamped to 8MiB |
| `getFsTree(root, limit)` | `fs.list` | `{dir}` | `res://` stripped — default root sends `{dir:""}`; `limit` dropped (unimplemented worker-side) |
| `getSceneState(scenePath, opts)` | `scene.read` | `{path}` | `res://` stripped; `depth`/`limit` dropped (not in the worker contract) |
| `play(scene)` | `game.run` | `{scene}` | `res://` stripped |
| `stop()` | `game.stop` | `{}` | — |
| `gameSnapshot()` | `game.screenshot` | `{}` | `needs_display` → honest `{ok:false, failureReason}` |
| `WriteFile` (executeOps) | `fs.write` | `{path, content, expectedSha256?, mustNotExist?}` | `res://` stripped from path |
| `GetConsoleOutput` (executeOps) | `game.logs` | `{tail: max_lines}` | `filter` applied CLIENT-side on `result.lines`; `type` dropped |
| `IsGameRunning` (executeOps) | `game.logs` | `{tail: 0}` | reads `result.running` — `status` has NO running field. No-game state maps to `running:false` and never throws: new workers answer `{running:false}` pre-first-run, old workers error — a `WorkerOpError` is treated as "not running" (transport failures still propagate) |

- executeOps batches containing any other op fail loudly BEFORE anything in
  the batch is applied. Editor-only methods (`inspectNode`, `scenePreview`,
  …) throw a clean "not supported by the headless worker … open the project
  in the Summer editor" error, which `withEngine` surfaces verbatim as an
  isError result. Nothing is silently faked.
- `credentialsChanged()` reports `true` once the worker socket drops or a
  mutating op is quarantined, so `getClient()`'s existing cache-invalidation
  drops it and the next call re-resolves (an editor opened meanwhile then
  wins).

## Layering notes (v3)

- `ProjectConnection` / `EditorConnection` / `WorkerConnection` /
  `resolveProjectConnection` are the adoptable core. They have no
  dependencies on MCP server state — only on `src/core/api-client.ts`,
  `src/core/engine.ts` (editor discovery), and node builtins. That is why the
  whole layer lives in `src/core/` and the import-direction test
  (`src/import-direction.test.ts`) passes with the `mcp → core` dynamic
  import as the only edge into it.
- `WorkerEngineClient` + `mcp-routing.ts` are the compatibility shim for the
  CURRENT tool layer (typed methods on `EngineApiClient`). If the tool layer
  ever gets a `call(op, params)`-shaped client, delete the shim and hand
  tools a `ProjectConnection` directly — the op vocabulary is already the
  worker's.
- The per-session single-worker cache in `mcp-routing.ts` assumes today's
  one-project-per-MCP-session model (`engineSelection`). If per-call project
  targeting arrives, replace it with a `Map<projectPath, connection>` —
  everything below the hook already keys by explicit `projectPath`.

## Blast radius (what the layer touches)

- The layer lives entirely in `src/core/headless/`; the only edge into it is
  the guarded dynamic import in `src/mcp/server.ts` `getClient()` quoted
  above. Nothing else in `src/` imports it statically
  (`src/import-direction.test.ts`).
- `src/core/api-client.ts` and `src/core/engine.ts` (editor transport and
  discovery) are consumed, not modified, by the layer. Engine-binary
  discovery is shared: `SUMMER_ENGINE_BIN` is checked first by this layer,
  then the common resolver (`SUMMER_ENGINE_BINARY`, install locations) from
  `src/core/engine-install.ts`.
- Tool registrations (`src/mcp/tools/*`, `with-engine.ts`) and
  `library/tools/` descriptors are unaware of the layer; the
  `UnsupportedOperationError` it throws is what `withEngine` already
  classifies as `unsupported`. No tool-surface change.
- With `SUMMER_HEADLESS_ROUTING` unset there is no behavior change anywhere.

(The original "what was NOT touched" list described the port commit
`4b1c61f`; later commits — `b9c03a0` capability getters and spawn env,
`54dc82e` shared resolver — changed the shared files, so the blast radius
above replaces it.)

## v2: receipts (planned — NOT in v1.1)

v1.1 has no idempotency keys and no accepted/terminal op lifecycle: a
mutating op whose response is lost is an UNKNOWN outcome, and the v1
mitigation is the quarantine described above (destroy the connection, evict
it from every cache, surface an explicit "outcome UNKNOWN — inspect before
retrying" error). v2 should add:

- client-minted idempotency keys on mutating ops, so a retry after a lost
  response can be deduped worker-side instead of quarantined,
- an accepted/terminal receipt lifecycle (mirroring the editor's Block E
  202+poll design in `src/core/async-op-lifecycle.ts`), so "accepted but
  final receipt lost" is reconcilable by requestId,
- structured error codes as a closed enum. In v1.1 the convention is a
  leading snake_case classifier on the error string (`sha256_mismatch: …`,
  `already_exists`, `needs_display`), which the client already surfaces as
  `WorkerOpError.code` — guard failures are therefore distinguishable from
  transport throws today, but the code list is not yet pinned.

## Open questions

1. `uid.resolve` has no editor-transport equivalent — should the editor grow
   one, or is it worker-only by design?
2. Worker `status` result shape: `WorkerEngineClient.health()` returns it
   verbatim. If tools start reading `instanceId`/`projectIdHash` off health
   on the worker path, the worker should report compatible fields.
3. Does the worker prune its own dead registry sections, or is a compactor
   needed eventually? (The reader tolerates garbage indefinitely.)
4. `fs.write` param names (`expectedSha256`, `mustNotExist`) mirror the
   editor's WriteFile op — confirm the worker enforces the same guards (the
   error codes `sha256_mismatch` / `already_exists` are expected back).
5. Pin the v2 receipt design (idempotency keys + accepted/terminal
   lifecycle) before any tool starts auto-retrying mutating worker ops.
