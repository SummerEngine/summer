# Navigation — execution plan across the three repos

Follows `NAVIGATION-RESEARCH.md` (why) and `NAVIGATION-DESIGN.md` (what). This is the *how*, decided 2026-09-04 after review with Mathias: the first cut duplicated existing tools and hardcoded editor destinations in the toolkit; the layout of the desktop editor is about to change (agent layout rework), so destinations must live in ONE place per product and the toolkit must stop being a third copy.

## Principle

Each product owns its own map of "where things are", in one file, and advertises it. The toolkit forwards ids; it does not know the layout.

| Product | Owner file | Advertised at | Consumer |
|---|---|---|---|
| Summer Engine (editor) | `modules/1summer_engine/editor/ops/navigate_ops.cpp` — one table, one op `Navigate` | `GET /api/health` → `capabilities.navigation.targets[]` | `summer_open` forwards `Navigate {target, …}`; the in-editor chat webview bridge calls the same table |
| summerengine.com | `src/lib/navigation/routes.ts` — one list of user-facing destinations | `GET /agent-routes.json` (+ a section in `llms.txt`, link in `agent-catalog.json`) | `summer_open` web rows are generated from it (vendored snapshot, drift-checked against the web repo when present) |
| Toolkit | `src/core/capabilities/navigation/` | — | one verb, two faces; no hand-written destination rows |

Status of a destination is **runtime truth**, not a hardcoded `planned` flag: an editor id is available iff the running engine advertises it (or a legacy op can serve it on an older engine); a web id is available iff the catalog lists it.

## 1. Engine — `Navigate` op (repo `summerengine`, branch `feat/navigate-op`)

**One file:** `modules/1summer_engine/editor/ops/navigate_ops.{h,cpp}`, class `NavigateOps` with:

- `static Dictionary navigate(const Dictionary &op)` — `op.target` (string id) + optional args; returns `{ok, target, …}` or `{ok:false, error, failure_reason: "unknown_target" | "unavailable" | "missing_arg"}`.
- `static Array list_targets()` — static data only (ids, titles, arg names), safe to call from the off-main health responder.
- A single `static const NavTargetDef TARGETS[]` table: `{ id, title, args, apply(args, result) }`. Every row wraps C++ that already exists (research §7):

| id | wraps | args |
|---|---|---|
| `editor-window` | `DisplayServer::window_move_to_foreground(MAIN_WINDOW_ID)` (+ `window_set_mode(WINDOWED)` if minimized) | — |
| `screen-2d` `screen-3d` `screen-script` `screen-game` `screen-assetlib` | `EditorInterface::set_main_screen_editor` (prefer the fork's `EditorMainScreen::force_select_by_name`) | — |
| `viewport-show` / `viewport-hide` | `EditorNode::ensure_viewport_column_visible()` / `hide_viewport_column()` (agent layout) | — |
| `assistant` | `ChatDock::get_singleton()->open_chat_path(path)` | `path?` |
| `project-settings` | `ProjectSettingsEditor::popup_project_settings()` via a new `EditorNode` accessor | `tab?` (best effort) |
| `editor-settings` | `EditorSettingsDialog::popup_edit_settings()` via accessor | — |
| `panel` | `EditorNode::get_bottom_panel()->make_item_visible(control, true)` with a name resolver (`output`, `debugger`, `animation`, `shader`, `audio`) | `name` |
| `dock` | `EditorDockManager::focus_dock` — extend the resolver: `file_system scene_tree inspector import node/signals groups history changes chat` | `name` |
| `scene` | `EditorNode::load_scene` (same as `OpenScene`) | `path` |
| `node` | `SelectNode` behavior | `path`, `scene?` |
| `script` | `set_main_screen_editor("Script")` + `EditorInterface::edit_script(script, line, col, /*grab_focus*/ true)` — the focusing variant `OpenResource` deliberately lacks | `path`, `line?`, `col?` |
| `file` | `RevealInFileSystem` behavior | `path` |

**Dispatch:** one branch in `ops_executor.cpp`: `else if (kind == "Navigate") { r = NavigateOps::navigate(op); }`. Non-mutating; batchable; editor-process-only.

**Advert:** `tool_net_thread.cpp` health builder adds `capabilities.navigation = { version: 1, targets: NavigateOps::list_targets() }` (static data — no editor singletons touched off-main).

**Bridge refactor (the dedup that matters for the layout rework):** `editor/docks/chat_dock.cpp::_on_webview_message` cases `editor:show-viewport`, `editor:hide-viewport`, `editor:open` (script branch) and the design-mode `chat:open` path call `NavigateOps` rows instead of inlining `set_main_screen_editor` / `edit_script`. Behavior identical; one table to edit when the layout changes.

**Registry:** `python3 modules/1summer_engine/dev/op_registry/generate_op_registry.py` then `--check`; `Navigate` appears with its params.

**Not built on this machine** (rule). PR text says so; owner builds + smokes with `summer tool open --args '{"target":"editor-window"}'` against the built editor.

## 2. Web — route/intent catalog (repo `publicsummerengine`, branch `feat/agent-routes-catalog`)

- `src/lib/navigation/routes.ts` — the one list: `{ id, path (template: "/studio/games/{gameId}[/{section}]"), title, description, intents[], auth: "public" | "signed-in", params?: [{name, required, values?}] }`. Seeded from the verified toolkit map (web rows) and the Studio `?tab=` list; `AUTHENTICATED_STUDIO_TABS` is the auth source for tabs. `ask-summer-registry.ts` routes must exist in it (test), so the internal registry and the public catalog cannot diverge.
- `app/agent-routes.json/route.ts` — `{ schemaVersion: "1.0", base, login: { path: "/login", returnParam: "returnUrl" }, routes: [...] }`, `force-static`, revalidate like `agent-catalog.json`.
- `agent-catalog.json`: add `navigation: { catalogUrl }` and list the new route in `crawlGuidance.preferredEntryPoints`.
- `llms.txt`: a "Navigating summerengine.com" section linking the catalog and the six destinations agents ask for most (billing, usage, my games, MCP guide, pricing, download).
- Test: every `routes.ts` path template resolves to a page file under `app/` (strip route groups, `[locale]`, map `{slot}` → `[slot]`); every `ask-summer-registry` route is in `routes.ts`.
- Not in scope here: the `/auth/callback?next=` fix (in progress on `fix/auth-callback-open-redirect`), a public play URL (product gap), the `/open?to=` router (v2).

## 3. Toolkit (repo `summer-engine-agent-v3`, branch `v3-foundation`)

- **Editor half → forwarder.** `summer_open` for an editor id sends `Navigate {target, ...params}` when the engine advertises `capabilities.navigation`; on an engine without it (0.5.65 today) it maps the five ids the old ops can serve (`scene`→OpenScene, `node`→SelectNode, `script`→OpenResource, `file`→RevealInFileSystem, `dock`→FocusDock for the 3 ids) and answers `engine_lacks_op` for the rest, naming the update. `targets.ts` keeps editor **metadata** (titles, intents, arg names) but no `implemented/planned` flag; `summer open --list` shows availability from the connected engine (or "engine not running — availability unknown").
- **Web half → generated.** `scripts/sync-web-routes.ts` reads the catalog (`--from-url https://www.summerengine.com/agent-routes.json` or `--from-repo <path to publicsummerengine>` via its `routes.ts`) and writes `src/core/capabilities/navigation/web-routes.json`; `targets.ts` builds web rows from it. A drift test (skips loudly without a sibling web checkout, like `op-registry-drift.test.ts`) fails when the vendored snapshot differs from the web repo.
- **Reference regenerated, not hand-written.** `product-map.md` is rendered by `scripts/navigation/render-product-map.ts` from the same data; the parity test stays.
- `CLI_KNOWN_OP_NEEDS += Navigate`. The three legacy scene tools (`summer_open_scene`, `summer_select_node`, `summer_open_main_scene`) stay untouched — build-workflow tools, referenced across skills.

## Order

1. Engine PR and web PR in parallel (branches, not built/deployed by us).
2. Toolkit forwarder + fallback (works on the shipped engine today), web snapshot synced from the web branch's `routes.ts`, generated reference, gates, commit on `v3-foundation`.
3. When the engine PR is built and merged: nothing to change in the toolkit — `--list` starts showing the new ids. When the web PR deploys: `npm run sync:web-routes` refreshes the snapshot.

## Gates

Engine: `generate_op_registry.py --check`, `git diff` limited to `navigate_ops.*`, `ops_executor.{cpp,h}`, `tool_net_thread.cpp`, `chat_dock.cpp`, `editor_node.{h,cpp}` accessors, `op_registry.json`, `SCsub` if needed. Web: `pnpm typecheck`, `pnpm test` (or the repo's vitest), no deploy. Toolkit: the usual six (tsc, test, validate, generate --check, eval, smoke under scratch HOME).
