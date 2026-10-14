# Summer Apps in this package

Summer Apps are tools a game team uses inside Summer Studio (a balance table, a quest editor, an asset
tracker, a pick-one grid), built by agents and live on the team's data and engine. This package gives local
agents the `summer_app_*` tools and the `summer-apps` and `summer-apps-design` skills. The hosted Summer
Engine MCP offers the same cloud tools under the same names.

## Where things are

| Part | Here |
| --- | --- |
| Shared implementation (schemas, web calls, dock op) | `src/core/capabilities/apps.ts` |
| MCP registration | `src/mcp/tools/app-tools.ts` |
| CLI face (`summer tool app-*`) | `src/core/capabilities/tool-dispatch.ts` |
| Tool descriptors | `library/tools/app-*/resource.yaml` |
| Skills | `library/skills/summer-apps/`, `library/skills/summer-apps-design/` |
| Tool reference | `library/references/mcp-tools-reference/mcp-tools-reference.md`, section "Summer Apps" |

## How the tools work

- Cloud tools (`summer_app_guide`, `list`, `create`, `publish`, `get`, `events`, `page`, `screenshot`, `data`, `tools`,
  `call`, `report_gap`) call the Summer web API under `/api/mcp/apps` with the signed-in account (`summer login`).
  They work without the engine running.
- The server answers errors as `{error: {code, message}}`; the tools return them flat as
  `{ok: false, code, error, hint?}`. Codes agents meet most: `unauthorized` (log in), `not_found` (no access, or
  Summer Apps is not open for this account yet), `invalid` (fix what the message names), `app_not_open`
  (`summer_app_call` and `summer_app_page` need the app open in the person's Studio tab or an editor dock),
  `permission_missing`, `rate_limited`, `spend_cap_reached`.
- `summer_app_publish` takes a local folder (`dir`): every file under it, dotfiles and `node_modules`
  skipped, text as UTF-8 and the rest base64, checked against the limits (10 MB, 300 files, 5 MB per file)
  before upload.
- `summer_app_events` long-polls up to 50 s; pass the returned `cursor` as `after` next time.
- `summer_app_screenshot` asks the server to render the app headless (read-only, as the person) and returns
  the PNG as MCP image content plus the report; `summer tool app-screenshot` writes the PNG to `out`
  (default `./summer-app-screenshot.png`).
- `summer_app_dock` is the one engine tool: it sends `OpenAppDock {appId, slot}`, `CloseAppDock {appId}` or
  `ListAppDocks` to the running editor and returns `engine_lacks_op` on engine builds without app docks.

## Testing against a local or staging web server

Two settings, two different servers:

- `SUMMER_GATEWAY_URL` moves the `summer_app_*` cloud tools (they call `/api/mcp/apps` there).
- The tools mounted from the hosted Summer Engine MCP (`summer_studio_*`, store, board, Grow) come
  from `SUMMER_MCP_RESOURCE_URL`, which defaults to production (`mcp.summerengine.com/mcp`).
  `SUMMER_GATEWAY_URL` does not move them, because the web host itself does not serve the hosted
  MCP; only its MCP host does.

So with a local gateway, `summer_studio_page` still talks to the production Studio bridge and
answers `no_tab` for a local Studio tab. To test both locally, also point
`SUMMER_MCP_RESOURCE_URL` at a hosted MCP your local server answers (its MCP host and `/mcp`),
and sign in to it with `summer login --store`. Otherwise use the `summer_app_*` tools and open
the app in your local Studio by hand.

## More

- Product and agent docs: the Summer Apps pages on the Summer docs site.
- Web architecture (request flows, data model, security, gates, debugging): Summer's internal
  `Docs/2026-10-13-summer-apps/ARCHITECTURE.md` in the web repository.
- Engine side: `doc/SUMMER/SUMMER_APPS.md` in the engine repository.
