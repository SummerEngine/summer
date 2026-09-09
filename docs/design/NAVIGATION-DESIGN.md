# Summer navigation — design

Decisions for `summer open` / `summer_open`, the product map, and the `navigate-summer` skill. Follows `NAVIGATION-RESEARCH.md` (why) and obeys `CONTRACT.md` (one behavior, two faces; descriptors; capability lint). Written 2026-09-03.

**Revised 2026-09-04 — see `NAVIGATION-PLAN.md`.** §2.1 and §2.2 below described a hand-written map with a hardcoded `planned` flag. That was replaced: web rows are generated from summerengine.com's `/agent-routes.json` (vendored at `assets/navigation/web-routes.json`), editor rows are ids of the engine's one navigation table (`Navigate` op) whose availability the running engine advertises, and the three legacy scene tools stay as build-workflow tools. The tool contract in §3 (targets, params, `open: false`, ambiguity, login deep-link, result shape) still holds, with `planned` replaced by `unsupported` / `failure_reason: engine_lacks_op`. Status of each part is marked **implemented** or **planned**; every web route was checked against `publicsummerengine` route files and every editor target against the engine's `op_registry.json` that day.

## 1. What it is

An agent or a human says *where* — "billing", "my games", "the scene I'm editing", "res://levels/1.tscn", "how do I set up Cursor" — and lands *there*: the browser opens the exact summerengine.com page (through login if needed), or the running Summer Engine editor opens the scene, selects the node, focuses the dock. One flat table of destinations (the **product map**) is the single source of truth for both.

Three library entries, one implementation:

| Entry | Kind | Role |
|---|---|---|
| `tool/open` | tool | `summer_open` (MCP) and `summer open <target>` (CLI, also `summer tool open`). Resolves a target, opens it, or prints what it would open. |
| `reference/product-map` | reference | The agent-readable table of every destination: intent phrases, URL or engine op, required context, what the user sees, implemented vs planned. |
| `skill/navigate-summer` | skill | When to open a surface *for the user* vs act through the API, and how to use the tool and the map. |

## 2. The product map

Source of truth is code — `src/core/capabilities/navigation/targets.ts` — because the tool must load it and tests must check it. The reference body `library/references/product-map/product-map.md` is the same table rendered for agents; a test (`navigation.test.ts`) fails when a target id is in one and not the other, so the two cannot drift (same discipline as the count guards).

Each target:

```ts
{
  id: "billing",                     // stable, kebab-case; the thing you type
  surface: "web" | "editor",
  title: "Billing & plan",
  description: "Studio billing tab: current plan, upgrade, Stripe portal, invoices.",
  intents: ["change my plan", "upgrade", "billing", "invoices", "cancel subscription"],
  status: "implemented" | "planned",
  requires: { login?: true, engine?: true, project?: true },
  web?:    { path: "/studio?tab=billing" },                        // template, {param} slots
  editor?: { op: "FocusDock", params: { dock: "inspector" } },     // engine op + fixed params
  params?: [{ name: "gameId", required: true, description: "…" }], // slots used by the template/op
  engineChange?: "…",                                             // planned editor targets only
}
```

Design rules, each traceable to the research:
- **Flat table keyed by intent id, colon-free** (Firebase `LINKS[]`, Stripe `open`). `summer open --list` prints it (Stripe `--list`).
- **Developer-authored phrases, one slot per template** (Siri App Shortcuts, Android `shortcuts.xml`). Slots are `{gameId}`, `{username}`, `{version}`, `{guide}`, `{section}` on the web; `path`, `node`, `scene` in the editor.
- **Context resolved at the destination**: web targets that require login are opened as `/login?returnUrl=<path>` when the CLI is not logged in — the web repo's own validated redirect (`src/lib/auth/return-url.ts`), Summer's equivalent of Cloudflare's `?to=/:account/...`.
- **Task vocabulary, not paths** (Roblox `task:EditPlace`): `scene`, `node`, `script`, `file`, `files`, `scene-tree`, `inspector`; raw `res://…` paths are accepted as shorthand and routed by extension the way the engine's `OpenResource` does.
- **Planned is a first-class status**, never silently missing (Windows `ms-settings:` version caveats): a planned target resolves, prints, and says exactly which engine op is missing; it never pretends to open.

### 2.1 Web destinations (implemented — verified against `publicsummerengine`)

Base URL is `resolveGatewayUrl()` (`https://www.summerengine.com` unless `SUMMER_GATEWAY_URL` / `gateway.url` override it) so a staging gateway navigates to staging. Docs targets use `https://docs.summerengine.com` (separate origin, verified in `src/lib/public-creator-journey.ts`).

| id | path | login | intents (excerpt) |
|---|---|---|---|
| `home` | `/` | | "summer website", "homepage" |
| `pricing` | `/pricing` | | "how much does it cost", "plans", "pricing" |
| `download` | `/download` | | "download the app", "install summer engine" |
| `cli-guide` | `/cli` | | "cli install page", "how do I install the cli" |
| `mcp-guide` | `/mcp` · `/mcp/{guide}` | | "set up the mcp", "connect cursor/claude code/codex…" — `guide` accepts the 13 slugs of `src/lib/data/agent-guides.ts` or an agent name (`cursor` → `how-to-make-games-in-cursor`) |
| `templates` · `templates-start` | `/templates` · `/templates/start` | | "browse templates", "start a new game on the web" |
| `asset-store` | `/asset-store` | | "asset store", "find assets" |
| `plugins` | `/plugins` | | "plugins", "skills catalog" |
| `changelog` | `/changelog` · `/changelog/{version}` | | "what's new", "release notes" |
| `blog` · `roadmap` · `games` | `/blog` · `/roadmap` · `/games` | | "blog", "roadmap", "games gallery / jams" |
| `docs` · `docs-mcp` · `docs-install` · `docs-quickstart` · `docs-sdk` | docs origin: `/` · `/mcp/overview` · `/essentials/installation` · `/quickstarts/fresh-project` · `/api-reference/summer-sdk` | | "documentation", "mcp docs", "sdk reference" |
| `login` · `signup` | `/login` · `/signup` | | "sign in", "create an account" |
| `studio` | `/studio` | | "open studio", "summer studio" |
| `my-games` | `/studio/games` | ✓ | "my games", "my projects", "my published games", "releases" |
| `game` | `/studio/games/{gameId}` · `/studio/games/{gameId}/{section}` | ✓ | "open game X", "builds/releases/store page/analytics for X" — `section` ∈ the 18 real segments (`builds releases store-page passport products achievements players community liveops safety analytics economy developers access audit danger-zone settings`) |
| `billing` | `/studio?tab=billing` | ✓ | "change my plan", "upgrade", "billing", "invoices", "cancel" |
| `usage` | `/studio?tab=billing&section=usage` | ✓ | "usage", "how many credits", "spending" |
| `account` · `settings` · `team` | `/studio?tab=account` · `?tab=settings` · `?tab=team` | ✓ | "my account", "account settings", "team / members / invite" |
| `cloud` | `/studio?tab=cloud` | ✓ | "project cloud", "cloud storage" |
| `my-assets` | `/studio?tab=assets` | | "my assets", "generated assets" |
| `workflows` · `story-builder` · `board` · `studio-plugins` · `studio-store` | `/studio?tab=workflows` · `storyBuilder` · `board` · `plugins` · `store` | board/storyBuilder ✓ | "guided workflows", "story builder", "board" |
| `generate-image` · `generate-3d` · `generate-audio` · `generate-video` · `generate-animation` | `/studio?tab=image` · `3d` · `audio` · `video` · `animation` | | "image generator", "3d generator", … |
| `chat` · `skills` · `profile` · `edit-profile` · `submit-game` | `/chat` · `/skills` · `/{username}` · `/profile/edit` · `/games/create` | chat/skills/edit/submit ✓ | "web chat", "my skills", "my public profile", "submit my game to the gallery" |

Login requirement per Studio tab is the web repo's `AUTHENTICATED_STUDIO_TABS` (`account billing board cloud settings storyBuilder team`); `/studio/games*`, `/chat/*`, `/skills`, `/profile/edit`, `/games/create`, `/asset-store/library` guard themselves with `loginPathForReturn`. Legacy `/dashboard/*` is deliberately not in the map (the web repo redirects it to the tabs above).

Not in the map because it does not exist on the web today (verified): a public play URL for a published game (`/games` is a curated gallery; distribution runs through `/studio/games/<id>/builds|releases|store-page`), and an API-token / MCP-credential page (CLI login is a device-code flow). "Show me my published games" therefore resolves to `my-games`.

### 2.2 Editor destinations

Executed through the token-authenticated local API (`EngineApiClient`), never a URL scheme (research §4). Ops verified in `op_registry.json` 2026-09-03.

| id | op | params | status | what the user sees |
|---|---|---|---|---|
| `scene` | `OpenScene` | `path` (`res://…tscn`); omitted → the project's `application/run/main_scene` | implemented | the scene becomes the current tab |
| `main-scene` | `OpenScene` | main scene from project state | implemented | same |
| `node` | `SelectNode` | `node`, optional `scene` | implemented | node highlighted in the Scene tree, properties in the Inspector |
| `script` | `OpenResource` | `path` (`.gd`) | implemented | script opens in the Script editor **without stealing focus** (engine hard-codes `grab_focus=false`); `line` is a planned param (`OpenScript{path,line,col}`) |
| `file` | `RevealInFileSystem` | `path` | implemented | FileSystem dock focused and scrolled to the file |
| `files` · `scene-tree` · `inspector` | `FocusDock` | `dock: file_system` · `scene_tree` · `inspector` | implemented | the dock's tab comes to the front |
| `screen-2d` · `screen-3d` · `screen-script` · `screen-game` | `SetMainScreen` | `screen` | **planned** — new op calling `EditorInterface::set_main_screen_editor` (exists only behind the chat webview bridge `editor:show-viewport`) | main editor switches to 2D / 3D / Script / Game |
| `assistant` | `FocusChat` | optional `path` | **planned** — new op over `ChatDock::open_chat_path` (exists as the `chat:open` bridge message) | the Summer assistant dock opens |
| `project-settings` | `OpenProjectSettings` | optional `tab` | **planned** — new op over `ProjectSettingsEditor::popup_project_settings` (needs an `EditorNode` accessor) | Project Settings dialog |
| `editor-settings` | `OpenEditorSettings` | | **planned** — `EditorSettingsDialog::popup_edit_settings` | Editor Settings dialog |
| `output` · `debugger` | `ShowBottomPanel` | `panel` | **planned** — `EditorBottomPanel::make_item_visible` + a name resolver | Output / Debugger panel |
| `editor-window` | `FocusEditorWindow` | | **planned** — `DisplayServer::window_move_to_foreground(MAIN_WINDOW_ID)`; the fork never calls it today | the editor window comes to the front |
| `import` · `signals` · `groups` · `changes` docks | `FocusDock` | new dock ids | **planned** — extend `_se_resolve_dock` (`ops_executor.cpp:9808`) | dock tab comes to the front |

Every planned row is an engine PR of one dispatch branch plus a handler; the C++ it wraps already exists (research §7). Until the op lands, `summer open <planned-target>` returns `status: "planned"` with the engine change named and, where one exists, the nearest implemented fallback (e.g. `assistant` → none; `screen-script` → `script` opens the file without switching).

## 3. The tool: `summer_open` / `summer open`

**One behavior** in `src/core/capabilities/navigation/open.ts` (`runOpen`), called by the dispatch entry (CLI face, `summer tool open` and the dedicated `summer open`) and by `src/mcp/tools/navigation-tools.ts` (MCP face). The descriptor `library/tools/open/resource.yaml` declares `surfaces.mcp.tool_name: summer_open`, `remote: false` (it opens things on *this* machine), `surfaces.cli.command: summer open`, and `authority: { filesystem: false, editor_mutation: false, network: false, credentials: false, publish: false }` — it reads the login token to decide the URL but never sends it; it launches the browser and sends UI ops, neither of which mutates the project.

Input (`input_schema`, mirrored by the zod shape, parity-tested):

| field | type | meaning |
|---|---|---|
| `target` | string | id (`billing`), intent phrase (`"change my plan"`), `res://` path (routed by extension), or a summerengine.com path (`/pricing`). Omitted → list every target. |
| `params` | object of strings | slot values: `gameId`, `section`, `username`, `version`, `guide`, `path`, `node`, `scene`. |
| `surface` | `auto` \| `web` \| `editor` | restrict matching; `auto` prefers the editor when the phrase is scene-shaped and the web otherwise. |
| `print` | boolean | resolve only — return the URL / op and do not open anything (`gh browse -n`). |

Result (JSON on both faces):

```json
{ "ok": true, "action": "opened" | "printed" | "listed" | "ambiguous" | "planned" | "engine_not_running" | "not_found",
  "target": { "id", "surface", "title", "description", "status", "requires" },
  "url": "https://www.summerengine.com/studio?tab=billing",
  "login_url": "https://www.summerengine.com/login?returnUrl=%2Fstudio%3Ftab%3Dbilling",
  "logged_in": false, "opened_url": "…the one actually launched…",
  "op": { "op": "OpenScene", "path": "res://main.tscn" }, "engine": { "running": true, "version": "0.5.65" },
  "matches": [ { "id", "surface", "title", "score" } ], "hint": "…" }
```

Rules:
- **Resolution**: exact id or alias → one match; `res://…` → `scene` / `script` / `file` by extension; `/path` → the web target with that path (or a raw gateway URL when the path is unknown but same-origin, marked `unmapped: true`); otherwise phrase scoring over id, title and intents (token overlap, substring bonus). One clear winner opens; several → `action: "ambiguous"`, `ok: false`, the top five listed with ids, nothing opened. `--list` / no target → every target with status and surface.
- **Web**: if the target requires login and `getAuthToken()` is null, the *login* URL (with `returnUrl`) is what opens; the result carries both. Logged-in state is a hint from the CLI token, not a session check — the browser may still ask.
- **Editor**: engine reachable → send the op via the shared engine client, return the op receipt; engine not reachable → `action: "engine_not_running"`, `ok: false`, with the op that would have been sent and the instruction (`summer run <project>` / open the project in Summer Engine). Planned target → `action: "planned"`, `ok: false`, engine change named.
- **`print`** never opens and never needs the engine (`ok: true` for implemented targets, the op/URL in the result).
- **Browser launch** goes through the `open` package (the same dependency `summer login` uses); the MCP face launches too — that is the point of the tool — but the skill tells agents to do so only when the user asked to *see* something.
- **CLI exit codes**: `ok: false` results print the JSON and exit 1 (the `ToolResultError` path `summer tool` already uses).

**Backward compatibility of `summer open`.** `summer open <path-to-project>` (opens a project in the engine, `src/cli/commands/open.ts`) keeps working: an argument that is an existing directory, or that looks like a filesystem path (`/`, `./`, `../`, `~`), takes the legacy branch with its existing messages; everything else is a navigation target. Options: `--print`, `--list`, `--web`, `--editor`, `--param key=value` (repeatable), `--path`, `--node`, `--scene`. Decision: extend rather than add a second verb — `open` is the verb every CLI in the research uses, and a project directory is just one more kind of target.

**Not built, by decision**: a `summer://`/`summerengine://` navigation scheme (v2; requires the engine to forward to the running instance — research §4), engine ops (listed as planned above), any web-repo change (§5).

## 4. The skill: `navigate-summer`

`library/skills/navigate-summer/SKILL.md`, installed with every skill set. It teaches:
- **Open a surface for the user when the user wants to see or decide something** — billing and plan changes (money), the games list / releases (their published work), the pricing page, the MCP setup guide for their agent, the scene or node just built ("show me"). **Act through the API instead** when the user wants a result (add the node, set the property, publish with confirmation) — never open the editor to do by hand what a tool does.
- Always `print` first when unsure, hand the user the URL when the session cannot open a browser (headless, remote), and say what will open before opening.
- Read the product map for intents and required context; when a target is `planned`, say so and offer the fallback instead of pretending.
- Never open a URL that is not on summerengine.com / docs.summerengine.com from this tool (the tool refuses off-origin paths).

## 5. Web-side alignment (PR list for `publicsummerengine` — proposals, not edits)

1. **Publish a machine-readable route/intent catalog** next to `agent-catalog.json`: `/agent-routes.json` (or a `routes` key in the existing catalog) generated from one TS module that also drives the internal `ask-summer-registry.ts` — id, path template, `requiresAuth`, intents, description, `params`. Then the toolkit's `targets.ts` can be generated/checked against it in CI instead of hand-verified.
2. **Add the catalog and the Studio tab addressing to `llms.txt`** (one section: "Navigating summerengine.com") and add `<link rel="alternate" type="application/json" href="/agent-routes.json">` on `/for-ai`.
3. **Validate `next` on `/auth/callback`** through `resolveReturnPath` (today it is string-concatenated; `?next=//host` is a protocol-relative open redirect). Found while verifying the login deep link.
4. **Make `/dashboard/settings` actually redirect** to `/studio?tab=settings` (declared `redirect` in `dashboard-compatibility.ts`, but neither the proxy nor the page does it).
5. **Derive `toolsNumber` and `lastModified`** in `agent-catalog.ts` from the toolkit's `counts.json` / a build stamp instead of hardcoded `44` / `'2026-07-30'`.
6. **Optional, v2**: a `/open?to=<target-id>&…` router on the web that resolves the same catalog server-side (Cloudflare `?to=` / AWS `go/view` pattern) so links in chat and docs stay valid when Studio routes move.

## 6. Engine-side follow-ups (for the engine owners — recorded in ROADMAP, not built)

One PR, one dispatch branch each, all wrapping C++ that already exists: `SetMainScreen`, `FocusChat`, `ChatInjectMessage`, `OpenProjectSettings`, `OpenEditorSettings`, `ShowBottomPanel`, `FocusEditorWindow`, `OpenScript{path,line,col,grab_focus}`, extend `_se_resolve_dock` (chat, changes, import, signals, groups). Second PR (v2): make the existing `summerengine://` handler forward navigation verbs to the running instance instead of spawning a second editor, and implement the Windows registration stub.
