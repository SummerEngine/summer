# A complete minimal Summer App

A working code app: shared notes for a playtest. Copy it, rename things, then grow it.
It shows every piece an app needs: the manifest, loading the SDK and kit, waiting for
the host, shared data (list, put, patch, live changes), the viewer, the page
declaration, an agent event, an agent tool, frame-move state, and empty and error
states.

Publish it with `summer_app_publish {appId, dir, manifest, note}` where `dir` holds
`index.html` and `app.js`, or pass the same two as `files`. The page, sections, inputs,
table, notice and empty text are kit components (`summer_app_guide` section `kit`, or
`/summer-ui/v1/catalog.json` on the app host); no app CSS is needed.

## The manifest (send it as `manifest`)

```json
{
  "name": "Playtest notes",
  "purpose": "Tester notes per level. Notes live in this app's shared data.",
  "permissions": ["data"],
  "collections": {
    "notes": {
      "description": "One remark from a playtest",
      "fields": {
        "text": { "type": "string", "required": true, "description": "What the tester said" },
        "level": { "type": "string", "description": "Level name, e.g. bridge" },
        "status": { "type": "string", "description": "open or fixed" },
        "author": { "type": "string", "description": "Who added it" }
      }
    }
  },
  "agentEvents": ["note.added"],
  "agentTools": [
    {
      "name": "add_note",
      "description": "Add a playtest note",
      "input": {
        "type": "object",
        "properties": { "text": { "type": "string" }, "level": { "type": "string" } },
        "required": ["text"]
      }
    }
  ]
}
```

## index.html

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Playtest notes</title>
<!-- Both are ES modules on the app's own host (apps.summerengine.app). Root paths, type="module". -->
<script type="module" src="/summer-sdk/v1.js"></script>
<script type="module" src="/summer-ui/v1/ui.js"></script>
</head>
<body>
<summer-page heading="Playtest notes" purpose="Tester notes per level, shared with your team.">
  <summer-button slot="actions" id="add" variant="primary" icon="plus">Add note</summer-button>
  <summer-section heading="New note">
    <summer-grid columns="2">
      <summer-text-input id="text" label="Note" placeholder="I fell through the bridge twice"></summer-text-input>
      <summer-text-input id="level" label="Level" placeholder="bridge"></summer-text-input>
    </summer-grid>
  </summer-section>
  <summer-section heading="Notes">
    <summer-notice id="error" tone="error" hidden></summer-notice>
    <summer-table id="table" row-key="id" sortable loading empty-text="No notes yet. Add the first one, or ask your agent to add the testers' notes."></summer-table>
  </summer-section>
</summer-page>
<!-- app.js runs after the SDK module (module scripts run in order). -->
<script type="module" src="app.js"></script>
</body>
</html>
```

## app.js

```js
const notes = summer.data.collection("notes");
const info = await summer.ready;            // the Studio host connected: info.viewer, info.params, info.restored
const viewer = await summer.app.viewer();   // { userId, name, role, canManage, ... }
let rows = [];

// Frame moves: Studio moves an idle app to a fresh frame every few minutes.
// Shared data survives on its own; keep only UI state here.
const draft = document.getElementById("text");
if (info.restored?.draft) draft.value = info.restored.draft;
summer.app.onSnapshot(() => ({ draft: draft.value }));

async function load() {
  try {
    const page = await notes.list({ limit: 500 });   // { revision, records: [{ recordId, data, revision, ... }], next }
    rows = page.records.map((r) => ({ id: r.recordId, ...r.data }));
    render();
  } catch (error) {
    showError(error.message);
  }
}

function render() {
  const table = document.getElementById("table");
  table.columns = [
    { key: "text", label: "Note" },
    { key: "level", label: "Level" },
    { key: "status", label: "Status" },
    { key: "author", label: "By" },
  ];
  table.rows = rows;
  table.removeAttribute("loading");
}

function showError(message) {
  const notice = document.getElementById("error");
  notice.setAttribute("text", `Could not load notes: ${message}`);
  notice.hidden = false;
}

async function addNote(text, level) {
  const id = crypto.randomUUID();
  await notes.put(id, { text, level: level || "", status: "open", author: viewer.name ?? "someone" });
  await summer.agent.send("note.added", { id, text, level });   // name must be in manifest.agentEvents
  return id;
}

document.getElementById("add").addEventListener("click", async () => {
  const text = draft.value.trim();
  if (!text) return;
  await addNote(text, document.getElementById("level").value.trim());
  draft.value = "";
  summerUI.toast("Note added");
});

// Live: every change by a teammate or an agent arrives here.
notes.subscribe((change) => {
  if (change.reset) return load();        // the log moved on: read everything again
  load();                                  // or apply change.ops ({ op, collection, recordId, data | patch }) in place
});

// Agent tool: summer_app_call { tool: "add_note", input: { text, level } } runs this while the app is open.
summer.agent.tool("add_note", async ({ text, level }) => ({ id: await addNote(text, level) }));

// What agents can read and use with summer_app_page.
summer.page.declare({
  fields: [{ id: "text", label: "Note", kind: "text", value: draft.value, set: (value) => (draft.value = String(value)) }],
  actions: [{ id: "add", label: "Add note", run: () => document.getElementById("add").click() }],
});

load();
```

Playing sound with Web Audio instead of `<audio>`? Wrap it so the frame is not moved
mid-sound: `summer.app.busy(true)` when it starts, `summer.app.busy(false)` in the
source's `onended`.

## The agent side of the same app

```json
{ "appId": "<id>", "ops": [{ "op": "put", "collection": "notes", "recordId": "n-1", "data": { "text": "Boss fight too long", "level": "boss", "status": "open", "author": "agent" } }] }
```

That is a `summer_app_data` write: it works with the app closed, and the open app shows it
through `notes.subscribe`. `summer_app_tools` and `summer_app_data` reads return the
`collections` above, so an agent knows the record shape.
