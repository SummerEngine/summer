---
name: summer-apps
description: "Build a Summer App, a team tool inside Summer Studio (balance table, quest editor, tracker), data and tools."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: tools
user-invocable: true
allowed-tools: Read Write Edit Glob summer_apps_guide summer_apps_list summer_apps_create summer_apps_publish summer_apps_get summer_apps_update summer_apps_events summer_apps_page summer_apps_use_page summer_apps_screenshot summer_apps_read_data summer_apps_write_data summer_apps_tools summer_apps_call summer_apps_report_gap summer_call
---

# Summer Apps

A Summer App is a tool the person's team uses inside Summer Studio: shared with
the workspace, live on its assets, game data and engine, dockable in the editor.
You build it in minutes; the team keeps it.

A call written `area.action({...})` is one operation: use the tool `summer_area_action` when
your client lists it, else `summer_call({ op: "area.action", input: {...} })`.
`summer_search` finds any operation and its exact input.

## First: does Summer already do it?

A custom app is something the team has to maintain. Before you build one, check whether
Summer already does the job: Studio features (the asset library with its collections and
groups, Pick one and sound choices, Grow dashboards, Team) and the existing Summer
operations (`summer_search` finds them). If it does, use that and tell the person where it lives.

Build an app only when the need is real and Summer lacks it, or as a Scratch throwaway (a
quick asset review, a UI prototype) that you call throwaway when you make it, and archive
when it is done (`apps.update({ appId, status: "archived" })`). When
something is missing natively, report it with `apps.report_gap` (and
`summer_call` with `docs.feedback` when a library entry fell short), so Summer can build it for
everyone.

| Ask | Do |
| --- | --- |
| "Let me pick from these 12 sword sounds" | Pick one: `assets.generate_sfx_choices`, or put the sounds in a library collection. No app. |
| "Group our Studio assets into a moodboard for the forest level" | Organize them with the asset library's collections and groups. No app. |
| "A weapon balance table that writes res://data/weapons.json" | Build an app: nothing in Summer edits game data with the team's balance rules. |

## When to build one

- The person asks for a tool ("build us a loot balance tool", "track every creature
  from concept to in-engine", "a board to review playtest clips").
- They need a UI to decide or edit something they will come back to.
- Not for a one-off answer: reply in chat instead.
- Not when Summer already does it (above).

## Layout or code

- **Layout** (`format: "layout"`): a JSON layout of kit nodes. Quick, throwaway,
  always on brand. Use it to ask the person to pick, rate or fill something now.
- **Code** (default): `index.html` + JS/CSS with the Summer SDK and UI kit. Use it
  for state, editing, shared data, generation or engine access.

## Start from the working app

Read these before writing code; they are exact:

- [minimal-app.md](minimal-app.md): a complete working app (manifest, `index.html`,
  `app.js`) built from kit components, using shared data, live changes, the viewer, `page.declare`, an
  agent event, an agent tool and frame-move state. Copy it and change it.
- [sdk-reference.md](sdk-reference.md): every SDK call with its exact arguments and
  return shape.
- [manifest.md](manifest.md): every manifest field.
- The kit's component catalog (every `<summer-*>` element with attributes, events and a
  copyable example) is `apps.guide({ section: "kit" })`, also at `/summer-ui/v1/catalog.json`
  on the app host. Copy its examples instead of inventing markup.

To see an app, publish it and call `apps.screenshot({ appId })`: Summer renders it headless
with the person's data and returns the picture plus the console, uncaught errors, refused calls
and the fields and buttons it declared. No Studio tab needed; the person sees it at
`/studio/apps/<appId>` (`apps.create` opens it for them). Opening `index.html` on its own
never connects. There is no offline host: do not build one or mock the SDK.

The app is served from its own host, apps.summerengine.app. Load the SDK and the kit as
ES modules with root paths: `<script type="module" src="/summer-sdk/v1.js">` and
`<script type="module" src="/summer-ui/v1/ui.js">`. Then `await summer.ready` before
the first call, and reach data only through `summer.data.collection(name)`.

## The loop

1. `apps.guide({ section: "overview" })` first, then `examples` and the sections the app needs.
   Load the `summer-apps-design` skill for how it must look.
2. `apps.create({ name, purpose, format })`. The person's Studio tab opens it.
3. Write the files in a local folder, then `apps.publish({ appId, files, manifest, note })` with
   every file as `{ path, content, encoding }` (`index.html` at the root; or `layout` for a layout
   app). Each publish is an immutable version the tab boots. A publish error names the file or
   rule: fix it and publish again.
4. Seed starter data with `apps.write_data({ appId, ops, as: "seed" })` when the app should
   start full. Seed rows belong to the team and show no author.
5. Look at it: `apps.screenshot({ appId })`, then `width: 390` (phone) and `theme: "dark"`;
   `steps: [{click: "#edit"}]` or `[{press: "<action id>"}]` shows a dialog or a second state.
   Fix the publish `warnings` too.
   Fix every error and console line it reports, publish again, look again. It is read-only:
   writes, sends and paid calls are refused there and work in Studio.
6. `apps.events({ appId, after })` waits for what the app sends you
   (`summer.agent.send`), errors (uncaught and `console.error`) and feedback. Act on them;
   pass the cursor on.
7. Change the app by publishing again; `apps.get({ appId })` returns the current files.

## Data is the API

Read an app's shared collections with `apps.read_data` and write them with `apps.write_data`. Both work with
no app open, and everyone in the app sees your edits live. "Nerf the bow in our
balance sheet" is a data write, not a click.

Declare each collection's record shape in the manifest `collections`; `apps.tools`
and `apps.read_data` return it, so any agent knows what a record looks like.

```json
{ "appId": "<id>", "ops": [
  { "op": "patch", "collection": "items", "recordId": "bow", "patch": { "damage": 36 }, "ifRevision": 4 },
  { "op": "put", "collection": "notes", "recordId": "n-17", "data": { "text": "Boss too long", "status": "open" } },
  { "op": "remove", "collection": "notes", "recordId": "n-3" }
] }
```

That is the input of `apps.write_data`: up to 100 ops per call. Send an `idempotencyKey` and reuse it
only to retry the same write, so it applies once. `apps.read_data({ appId, collection, limit, cursor })`
reads records (`items`, then `nextCursor` for the next page); removed records are not returned. Your writes are recorded as `actor { kind: "agent" }` (and
as `createdBy` on records you create), so the app can show which rows an agent made. Add
`"as": "seed"` for starter data that belongs to the team (`kind: "seed"`, no author). `patch` merges keys
(`null` removes one); `ifRevision` guards against overwriting a newer change.

## Agent tools

Logic that lives in the app (a balance formula, an export) can be exposed in the
manifest `agentTools` and implemented with `summer.agent.tool(name, handler)`.
`apps.tools` lists them; `apps.call({ appId, tool, input })` runs one inside the person's open
app and answers a `conflict` error when the app is not open (its `next` is the app's link for the
person). Prefer data for plain reads and edits. `apps.page` reads the fields and buttons an open app
declared, and `apps.use_page({ appId, fill, press })` fills and presses them; the ones the app marks
critical are the person's to press.

## Rules

- Declare only the permissions the app uses; declare every `engineFiles` path and
  every `agentEvents` name. A missing one fails at runtime with `permission_missing`.
- The app runs sandboxed (`allow-scripts allow-forms allow-popups allow-modals
  allow-downloads`, never `allow-same-origin`): no cookies, no `localStorage`, no network
  unless the workspace allows a domain. Keep state in `summer.data`.
- Paid SDK calls spend the credits of the person using the app. Say so before
  building an app that generates.
- Use real data (`summer.data`, `summer.assets`, `summer.engine.readFile`), never
  placeholder numbers.
- Studio moves an idle app to a fresh frame every few minutes. Keep UI state you care
  about in shared data, or return it from `summer.app.onSnapshot(() => state)` (up to
  256 KB) and read it back from `(await summer.ready).restored`. Wrap Web Audio playback
  in `summer.app.busy(true)` / `summer.app.busy(false)` so a long sound is not cut;
  `<audio>` and `<video>` count on their own.
- Call `summer.page.declare` so agents can read and use the UI; mark delete,
  publish, pay and send actions `critical`.
- When the SDK cannot do what the app needs, say so and call
  `apps.report_gap`.
- `apps.dock` docks an app in the editor (it runs in the Summer MCP on this computer); on engines
  without app docks it returns `engine_lacks_op`: open the app in the Studio tab instead.
- Keep, archive, restore, rename and pin with `apps.update` (`status`, `name`, `folder`, `pinned`);
  copy one with `apps.duplicate`; add a starter app with `apps.add_starter`; send the makers a note
  with `apps.feedback`. `apps.delete` asks the person, and `apps.rollback` (an older version goes
  live) and `apps.update_starter` ask the app's owner: each answers `needs_approval` with a link to
  give them, and nothing changes until they approve (`jobs.wait` on the job).

## Done means

The app is published; `apps.screenshot` shows it with real data in light, dark and at
390 px with no errors; its states (loading, empty, error) work; and the person knows what it
does and where its data goes.

<!-- shell-commands: generated from the operation catalog by npm run generate:registry; do not edit by hand -->
## From a shell

No Summer MCP tools in this session? Run each one as a command; when `summer --version` is missing or below 4.0, use `npx -y summer-engine@latest` in place of `summer`. Fields are flags in kebab-case (`--scene-path res://main.tscn`) or one `--input '<json>'`, and `summer ops describe <op>` prints the exact input. The `summer-cli` skill has the rest.

| In this skill | Command |
|---|---|
| `apps.call`, `summer_apps_call` | `summer apps call` |
| `apps.create`, `summer_apps_create` | `summer apps create` |
| `apps.dock` | `summer apps dock` |
| `apps.events`, `summer_apps_events` | `summer apps events` |
| `apps.get`, `summer_apps_get` | `summer apps get` |
| `apps.guide`, `summer_apps_guide` | `summer apps guide` |
| `summer_apps_list` | `summer apps list` |
| `apps.page`, `summer_apps_page` | `summer apps page` |
| `apps.publish`, `summer_apps_publish` | `summer apps publish` |
| `apps.read_data`, `summer_apps_read_data` | `summer apps read-data` |
| `apps.report_gap`, `summer_apps_report_gap` | `summer apps report-gap` |
| `apps.screenshot`, `summer_apps_screenshot` | `summer apps screenshot` |
| `apps.tools`, `summer_apps_tools` | `summer apps tools` |
| `apps.update`, `summer_apps_update` | `summer apps update` |
| `apps.use_page`, `summer_apps_use_page` | `summer apps use-page` |
| `apps.write_data`, `summer_apps_write_data` | `summer apps write-data` |
| `assets.generate_sfx_choices` | `summer assets generate-sfx-choices` |
| `docs.feedback` | `summer docs feedback` |
| `jobs.wait` | `summer jobs wait` |
| `summer_search` | `summer ops search "<what you want>"` |
<!-- /shell-commands -->
