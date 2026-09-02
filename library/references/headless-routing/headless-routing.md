# Headless per-project routing

> Full protocol contract: `docs/HEADLESS_ROUTING.md` in the Summer repo (implementation in `src/core/headless/`). This page is the agent-facing summary.

## What it is

An opt-in routing layer for Summer MCP tool calls. When a call targets a project, it is served by, in fixed order:

1. **A live editor** that has the project open — always wins. Behavior is identical to routing being off.
2. **A live headless worker** already registered for the project (engine-owned process registry, dead processes pruned on read).
3. **A worker spawned on demand** — the engine binary launched in `--summer-worker` mode for that project, detached so it outlives the MCP session.

Only file, import, scene-read, and game run/stop/logs/screenshot operations work on a worker. Editor-only tools (inspector, viewport snapshots, scene preview, project state) fail with a clear "not supported by the headless worker" result instead of faking an answer.

## Ships dark

- Enabled by `SUMMER_HEADLESS_ROUTING=1`. Unset, the module is not loaded at all and nothing changes.
- Requires an engine build that ships the worker mode and process registry (Summer 4.7.x line). On older builds, leave the flag off.
- With the flag on and an editor open, the editor path is used unchanged — caching, credential-drift reconnects, and identity binding all behave as before.

## What an agent should expect

- Errors from this layer are prefixed `[headless:<stage>]` where stage is one of `connect`, `auth`, `op`, `spawn`, so you can tell "could not reach the worker" from "the worker went quiet mid-import".
- A first call with no editor and no worker can take up to two minutes while the worker starts and imports the project. Later calls are fast.
- **No blind retries.** If a mutating operation (write, import, run, stop) times out or the worker connection drops, the outcome is reported as UNKNOWN and the connection is quarantined. Inspect the target (read the file, check the scene) before retrying. There is deliberately no automatic reconnect or replay.
- Worker error strings start with a snake_case classifier (`sha256_mismatch`, `already_exists`, `needs_display`). `needs_display` on a screenshot means the machine has no display; open the project in the editor for screenshots.

## Environment knobs

| Variable | Purpose | Default |
| --- | --- | --- |
| `SUMMER_HEADLESS_ROUTING` | `1` enables the layer | unset (off) |
| `SUMMER_ENGINE_BIN` | Engine binary to spawn workers from; this layer's own override, checked first (set but missing = no binary) | discovered |
| `SUMMER_ENGINE_BINARY` | The shared engine-install override, honored next along with the standard install locations | discovered |
| `SUMMER_CACHE_DIR` | Override the registry directory (test seam; both sides must honor it) | OS cache dir |
| `SUMMER_WORKER_CONNECT_TIMEOUT_MS` | TCP connect budget | 5000 |
| `SUMMER_WORKER_HELLO_TIMEOUT_MS` | Handshake budget | 3000 |
| `SUMMER_WORKER_OP_TIMEOUT_MS` | Per-request inactivity budget | 30000 |
| `SUMMER_WORKER_LONG_OP_TIMEOUT_MS` | Inactivity budget for import and game run | 300000 |
| `SUMMER_WORKER_SPAWN_TIMEOUT_MS` | How long a spawned worker may take to register | 120000 |

Timeouts are inactivity-based: an import that keeps reporting progress never times out; a silent hang still does.

## Security posture (why you never see a token)

The worker and the client authenticate each other with hashes over a per-connection nonce; the registry token never crosses the wire and never appears in any error or log. The registry file is trusted only if it is a regular file under 512KiB, and every entry is verified against the live process before use.
