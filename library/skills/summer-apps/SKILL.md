---
name: summer-apps
description: "Build a Summer App, a team tool inside Summer Studio (balance table, quest editor, tracker, pick grid): build loop, Layout vs code, data as API, agent tools."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: tools
user-invocable: true
allowed-tools: Read Write Edit Glob summer_app_guide summer_app_list summer_app_create summer_app_publish summer_app_get summer_app_events summer_app_page summer_app_data summer_app_tools summer_app_call summer_app_dock summer_app_report_gap
---

# Summer Apps

A Summer App is a tool the person's team uses inside Summer Studio: shared with
the workspace, live on its assets, game data and engine, dockable in the editor.
You build it in minutes; the team keeps it.

## First: does Summer already do it?

A custom app is something the team has to maintain. Before you build one, check whether
Summer already does the job: Studio features (the asset library with its collections and
groups, Pick one and sound choices, Grow dashboards, Team) and the existing `summer_*` MCP
tools. If it does, use that and tell the person where it lives.

Build an app only when the need is real and Summer lacks it, or as a Scratch throwaway (a
quick asset review, a UI prototype) that you call throwaway when you make it. When
something is missing natively, report it with `summer_app_report_gap` (and
`summer_library_feedback` when a library entry fell short), so Summer can build it for
everyone.

| Ask | Do |
| --- | --- |
| "Let me pick from these 12 sword sounds" | Pick one: `summer_generate_sfx_choices`, or put the sounds in a library collection. No app. |
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
  copyable example) is `summer_app_guide` section `kit`, also at `/summer-ui/v1/catalog.json`
  on the app host. Copy its examples instead of inventing markup.

The app is served from its own host, apps.summerengine.app. Load the SDK and the kit as
ES modules with root paths: `<script type="module" src="/summer-sdk/v1.js">` and
`<script type="module" src="/summer-ui/v1/ui.js">`. Then `await summer.ready` before
the first call, and reach data only through `summer.data.collection(name)`.

## The loop

1. `summer_app_guide` (whole once per session; later one `section`). Load the
   `summer-apps-design` skill for how it must look.
2. `summer_app_create {name, purpose, format}`. The person's Studio tab opens it.
3. Write the files in a local folder, then `summer_app_publish {appId, dir, manifest, note}`
   (or `layout`). Each publish is an immutable version the tab boots. A publish
   error names the file or rule: fix it and publish again.
4. Seed data with `summer_app_data` (ops) when the app should start full.
5. `summer_app_events {appId, after}` waits for what the app sends you
   (`summer.agent.send`), errors and feedback. Act on them; pass the cursor on.
6. Change the app by publishing again; `summer_app_get` returns the current files.

## Data is the API

Read and write an app's shared collections with `summer_app_data`. It works with
no app open, and everyone in the app sees your edits live. "Nerf the bow in our
balance sheet" is a data write, not a click.

Declare each collection's record shape in the manifest `collections`; `summer_app_tools`
and `summer_app_data` reads return it, so any agent knows what a record looks like.

```json
{ "appId": "<id>", "ops": [
  { "op": "patch", "collection": "items", "recordId": "bow", "patch": { "damage": 36 }, "ifRevision": 4 },
  { "op": "put", "collection": "notes", "recordId": "n-17", "data": { "text": "Boss too long", "status": "open" } },
  { "op": "remove", "collection": "notes", "recordId": "n-3" }
] }
```

Without `ops`, `summer_app_data` reads (`collection`, `after`, `limit`). `patch` merges keys
(`null` removes one); `ifRevision` guards against overwriting a newer change.

## Agent tools

Logic that lives in the app (a balance formula, an export) can be exposed in the
manifest `agentTools` and implemented with `summer.agent.tool(name, handler)`.
`summer_app_tools` lists them; `summer_app_call` runs one inside the person's open
app and answers `app_not_open` otherwise. Prefer data for plain reads and edits.

## Rules

- Declare only the permissions the app uses; declare every `engineFiles` path and
  every `agentEvents` name. A missing one fails at runtime with `permission_missing`.
- The app runs sandboxed: no cookies, no `localStorage`, no network unless the
  workspace allows a domain. Keep state in `summer.data`.
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
  `summer_app_report_gap`.
- `summer_app_dock` docks an app in the editor; on engines without app docks it
  returns `engine_lacks_op`: open the app in the Studio tab instead.

## Done means

The app is published, opened once with real data, its states (loading, empty,
error) work, and the person knows what it does and where its data goes.
