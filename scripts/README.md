# summer-cli scripts

- `smoke-test.sh` — CLI-level smoke tests (unit tests, command basics, template creation). Engine optional; engine-dependent checks are skipped when no editor is running.
- `build-api-docs.mjs` — compiles the engine's class-reference XML into `assets/api-docs.json.gz` (served offline by the `summer_api_docs` MCP tool). Needs an engine checkout: `node scripts/build-api-docs.mjs /path/to/summerengine` (or `SUMMER_ENGINE_ROOT`). The asset is committed; rerun after engine API changes.
- `compat-smoke.sh` (+ `compat-smoke.mjs` helper) — latest-MCP x candidate-engine compatibility gate. Engine REQUIRED. See below.

## Release gate: compat-smoke

```
bash tools/summer-cli/scripts/compat-smoke.sh [--project <path>]
```

**Run it before every engine release AND before every npm publish of summer-engine.** Both sides of the MCP <-> engine HTTP contract are unit-tested only against mocks (MCP tests mock the engine; engine tests mock the client), so a contract drift between them is invisible to CI. That is exactly how MCP 2.7.0-2.8.0 shipped appending `SaveScene` into multi-op batches while engine 0.5.60+ rejects such batches wholesale (`failure_reason: "unsupported_transport"`) — every scene mutation via MCP was broken for weeks with all tests green.

What it does:

1. Builds the local CLI (`npm run build`) and starts the REAL built MCP server (`dist/bin/summer.js mcp`) over stdio, driving the actual `summer_*` tool handlers — including the scene-tools op-splitting logic — against the running engine. No hand-rolled HTTP.
2. Exercises: `summer_get_project_context`; `summer_add_node` verified via scene state; `summer_batch` with a mixed op list including an `InstantiateScene` (asserts the single-op split lands as 3 sequential requests against the real engine); a `RunVerification` probe using `save_frame("compat")`; `SimulateInput` as a single op (`failure_reason: "not_running"` counts as a pass when no game is running).
3. Any `unsupported_transport` on a mutation path exits 1 with a loud message naming the incompatible CLI x engine version pair.
4. Cleans up the nodes and the throwaway prefab scene it created. Completes in well under 2 minutes.

Precondition: a running Summer editor with a **scratch** project open (it mutates the open/main scene). Auto-detected via the `~/.summer/instances` registry, falling back to the legacy `~/.summer/api-port`/`api-token` files. `--project <path>` is required only when several editors are running.

Exit codes: `0` compatible, `1` incompatibility or failure, `2` precondition not met (no running editor / no scene).

Env: `SUMMER_COMPAT_SKIP_BUILD=1` reuses an existing `dist/` build; `SUMMER_COMPAT_TIMEOUT_MS` overrides the global watchdog (default 115000 ms).
