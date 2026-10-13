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

## When to build one

- The person asks for a tool ("build us a loot balance tool", "track every creature
  from concept to in-engine", "a board to review playtest clips").
- They need a UI to decide or edit something they will come back to.
- Not for a one-off answer: reply in chat instead.

## Layout or code

- **Layout** (`format: "layout"`): a JSON layout of kit nodes. Quick, throwaway,
  always on brand. Use it to ask the person to pick, rate or fill something now.
- **Code** (default): `index.html` + JS/CSS with the Summer SDK and UI kit. Use it
  for state, editing, shared data, generation or engine access.

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
- Call `summer.page.declare` so agents can read and use the UI; mark delete,
  publish, pay and send actions `critical`.
- When the SDK cannot do what the app needs, say so and call
  `summer_app_report_gap`.
- `summer_app_dock` docks an app in the editor; on engines without app docks it
  returns `engine_lacks_op`: open the app in the Studio tab instead.

## Done means

The app is published, opened once with real data, its states (loading, empty,
error) work, and the person knows what it does and where its data goes.
