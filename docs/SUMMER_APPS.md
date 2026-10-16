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

- Cloud tools (`summer_app_guide`, `list`, `create`, `publish`, `get`, `update`, `events`, `page`, `screenshot`, `data`, `tools`,
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

## In the 4.0 operation catalog

With the v4 surface (the default since 4.0; `summer mcp --surface v3` keeps the 3.x tools), agents reach Summer Apps as the
`apps.*` operations of the hosted catalog, through `summer_call` (or `summer_apps_<action>` where a client
lists it): `apps.guide`, `apps.list`, `apps.create`, `apps.publish`, `apps.get`, `apps.update` (also
`pinned`), `apps.events`, `apps.page` (read) and `apps.use_page` (fill and press), `apps.read_data` and
`apps.write_data`, `apps.tools`, `apps.call`, `apps.report_gap`, `apps.screenshot`, and the Studio-button
operations `apps.add_starter`, `apps.duplicate`, `apps.delete`, `apps.rollback`, `apps.update_starter` and
`apps.feedback`. `apps.dock` stays local (the `summer_app_dock` tool above). The hosted `apps.publish`
takes `files` or a `layout`; it has no `dir`, so read the folder and send its files. The hosted Studio
tools (`summer_studio_*`) are `studio.map`, `studio.page`, `studio.read_form`, `studio.submit_form` and
`studio.use_page`; a Studio button that is an operation answers `moved` from the last two, with the
operation to call. `studio.open` called through the local `summer_call` runs `summer_open` here.

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

### Switching between staging and production

The machine keeps one store sign-in (`~/.summer/oauth-token`), made for one hosted MCP. The store
and publishing tools that run here (`summer_publish_build`, `summer_sync_items`) and the mounted
hosted tools all use it. To switch between staging and production, change both settings, then sign
in again:

1. `SUMMER_GATEWAY_URL` (or `summer config set gateway.url`): the web host the store calls go to.
2. `SUMMER_MCP_RESOURCE_URL`: that environment's hosted MCP (its MCP host and `/mcp`).
3. `summer login --store --force`: replaces the sign-in with one for that hosted MCP.

Until step 3, the store refuses the old sign-in. `summer_sync_items` stops before reading or sending
anything with `store_login_other_environment`. Game ids differ between staging and production, so
pass the gameId from that environment's `summer_store_list_games`. `summer.items.json` is the same
file in both: items are matched by slug.

## More

- Product and agent docs: the Summer Apps pages on the Summer docs site.
- Web architecture (request flows, data model, security, gates, debugging): Summer's internal
  `Docs/2026-10-13-summer-apps/ARCHITECTURE.md` in the web repository.
- Engine side: `doc/SUMMER/SUMMER_APPS.md` in the engine repository.
