# Summer Apps SDK quick reference

`window.summer`, loaded with `<script type="module" src="/summer-sdk/v1.js">` (the app's own
host, apps.summerengine.app). The UI kit is `<script type="module" src="/summer-ui/v1/ui.js">`
(stylesheet alone: `/summer-ui/v1/ui.css`). Use `type="module"` (a classic script still works but warns); other paths do not work. Calling `summer.data.list(name)` and the like rejects with `invalid` and says to use `summer.data.collection(name)`.

The app runs in a sandboxed frame on that host:
`sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"`, never
`allow-same-origin`. So it is an opaque origin (no cookies, no `localStorage`), with no network
unless the workspace allows a domain; the kit and SDK are served with CORS so the module
scripts load. It only works inside Summer Studio. To preview, publish to a Scratch app and open
it there (`/studio/apps/<appId>`). There is no offline or local host; do not build one or mock
the SDK. Opening `index.html` on its own never connects, so `summer.ready` waits forever.

Every call returns a promise and runs as the person using the app. Failures reject with
`SummerError { code, message }`. Methods need the manifest permission in brackets.

## Start

| Call | Returns |
|---|---|
| `await summer.ready` | `{ app: { id, name, version, surface, format }, viewer: { userId, name }, permissions: string[], params: { [k]: string }, theme: "light"\|"dark", restored?: any }` |
| `summer.app.viewer()` | `{ userId, name, image, role: "owner"\|"admin"\|"member", canManage, spentTodayMicro, dailyCapMicro }` |
| `summer.app.info({ params })` | `{ app, version, manifest, params }` |
| `summer.app.setTitle(title)`, `summer.app.notify(text)`, `summer.app.needsYou(count)`, `summer.app.open("/studio/...")` | `void` |
| `summer.app.theme()` / `summer.app.onTheme(fn)` | `"light"\|"dark"` / stop function |
| `summer.app.onSnapshot(() => state)` | stop function. `state` (JSON, up to 256 KB) comes back as `(await summer.ready).restored` after Studio moves the app to a fresh frame. |
| `summer.app.busy(on)` | `void`. Wrap Web Audio playback in `busy(true)` / `busy(false)`; `<audio>` and `<video>` count on their own. |

Use `(await summer.ready).viewer` for who is using the app; `summer.app.viewer()` is the same
person plus role and spend. The kit applies Studio's light or dark theme by itself
(`html.dark`): apps never toggle it. `theme()` / `onTheme` are only for your own drawing (canvas).

## Shared data [data]

There is no `summer.data.list(name)`. Always go through `summer.data.collection(name)`.

```js
const notes = summer.data.collection("notes");   // name: lowercase a-z 0-9 _ . - (max 48)
```

| Call | Returns |
|---|---|
| `notes.list({ limit = 200, after })` | `{ revision, records: Record[], next: string\|null, collections: [{ name, count }] }`. Removed records are never listed. Pass `next` as `after` for the next page (max 500 per page). |
| `notes.get(id)` | `Record`, or `null` (also for a removed record) |
| `notes.put(id, data, { ifRevision })` | `Write` (creates or replaces) |
| `notes.patch(id, partial, { ifRevision })` | `Write` (shallow merge; `null` removes a key; creates if missing) |
| `notes.remove(id, { ifRevision })` | `Write` |
| `notes.subscribe((change) => …)` | stop function |
| `summer.data.subscribe((change) => …)` | every collection |
| `summer.data.commands({ requestId, baseRevision, ops })` | `Write`: up to 100 ops in one revision |

```ts
Record = { collection, recordId, data, revision, actor, createdBy, createdAt, updatedAt, deleted }
Write  = { revision, operation: { revision, requestId, actor, ops, createdAt }, records: Record[], replayed }
change = { revision, actor, ops: Op[] } | { revision, reset: true }      // on reset, list again
actor  = { userId, kind: "person" | "agent" | "seed", agent?: "claude-code" | ..., via?: "agent-tool" }
Op     = { op: "put", collection, recordId, data, ifRevision? }
       | { op: "patch", collection, recordId, patch, ifRevision? }
       | { op: "remove", collection, recordId, ifRevision? }
```

`ifRevision: n` applies only if the record is still at revision `n` (`0`: only if it does not
exist); otherwise the call rejects with `conflict`. Record ids: letters, digits, `_ . : -`
(max 128). Records are JSON up to 64 KB, 10,000 per collection, 50 collections.

### Who changed it

`actor.userId` is the account the write ran as, the same id as `ready.viewer.userId` and
`app.viewer().userId`. `kind: "agent"` marks writes an agent made with `apps.write_data`, and
writes your own code made while running an agent tool for `apps.call` (those also have
`via: "agent-tool"`). Show agent-made rows (a small "by agent" label) so people know.

`actor` is the last writer. `createdBy` (same shape) is who created the record and does not
change on later edits, so take the "by agent" label from `createdBy.kind === "agent"`: it
survives a person's edit. `kind: "seed"` is starter data an agent wrote for the team
(`apps.write_data` with `as: "seed"`): show no author for it.

## Agents

| Call | Returns |
|---|---|
| `summer.agent.send(name, payload)` | `{ seq }`. `name` must be in `manifest.agentEvents`. Agents read it with `apps.events`. |
| `summer.agent.tool(name, async (input, { agent }) => result)` | stop function. `name` must be in `manifest.agentTools`; `agent` is the calling agent's name. Data writes the handler makes are recorded as that agent's (`via: "agent-tool"`). `apps.call` runs it; return JSON (under 100 KB); a throw becomes `tool_failed` (the agent sees an `unavailable` error). |
| `summer.agent.onMessage((message) => …)` | stop function |
| `summer.page.declare({ fields, actions })` | promise. `fields: [{ id, label, kind: "text"\|"long-text"\|"number"\|"toggle"\|"choice", value, options?: [{ value, label }] (for choice), max?, hint?, set(value) }]`, `actions: [{ id, label, description?, critical?, run() }]`. Call it again when values change. Critical actions are pressed only by the person. |

## Assets, generation, AI

| Call | Permission | Returns |
|---|---|---|
| `summer.assets.search(q, { filters, limit })` | assets:read | matching assets |
| `summer.assets.get(id)` | assets:read | one asset (`fileUrl`/`url`, `kind`, `title`, ...) |
| `summer.assets.upload({ name, contentType, base64 })` | assets:write | the new asset |
| `summer.assets.saveToLibrary(id, { name })` | assets:write | the saved asset |
| `summer.generate.image({ prompt })`, `.sfx({ prompt, durationSeconds })`, `.sfxChoices({ prompt })`, `.music({ prompt, durationSeconds })`, `.voice({ text, voiceId })` | generate | the result with its asset |
| `summer.generate.model3d({ prompt })`, `.video({ prompt })`, then `summer.generate.job(jobId)` | generate | a job, then its status |
| `summer.ai.complete({ prompt, system, json })` | ai | the model's answer |

Paid calls spend the viewer's credits; `spend_cap_reached` when the app's daily cap is hit.

## Team, projects, analytics

| Call | Permission |
|---|---|
| `summer.team.members()` → `{ members: [{ userId, role, name, image }] }` (never emails) | team:read |
| `summer.team.presence()` → `{ presence: [{ userId, name, image, surface, seenAt }] }` | none |
| `summer.projects.list()`, `summer.projects.get(id)` | projects:read |
| `summer.grow.portfolio({ range: 7\|28\|90 })` (totals and per-game rows each carry `previous`: the same-length window before, or null), `summer.grow.game(id)`, `summer.grow.earnings()` | grow:read |

## Engine [engine:read / engine:write]

| Call | Notes |
|---|---|
| `summer.engine.status()` | Is an engine connected for this person |
| `summer.engine.readFile(path)` / `writeFile(path, content)` | Only `manifest.engineFiles` paths (and `res://addons/<plugin>/`) |
| `summer.engine.ops([{ op: "AddNode", ... }])` | App op allowlist only; values are Godot strings (`"Vector3(0, 10, 0)"`) |
| `summer.engine.play(scene)`, `stop()`, `screenshot("viewport"\|"game")`, `state(kind)` | |
| `summer.engine.onEvent(fn)`, `summer.engine.plugin.send(msg)`, `summer.engine.plugin.onMessage(fn)` | |

`engine_offline`: no Summer Engine connected; show an "Open in Summer Engine" hint.

## Kit values

`<summer-form>` gives its fields' values by `name` (fields anywhere inside it count, also
inside `summer-grid`); `form.values = {...}` or `form.setValues({...})` loads a record into it
for editing. `<summer-text-input type="number">` and `<summer-slider>` give numbers in form
values and change events (an empty number field gives `null`); the input's `.value` property
stays text. A `<summer-toggle>` is a boolean.

## Errors

`permission_missing` (add it to the manifest), `invalid` (arguments; the message says which),
`unknown_method`, `conflict`, `rate_limited` (600 calls a minute, 60 paid), `spend_cap_reached`,
`engine_offline`, `not_implemented`, `unavailable`.
