# A complete minimal Summer App

A working code app: shared notes for a playtest. Copy it, rename things, then grow it.
It shows every piece an app needs: the manifest, loading the SDK and kit, waiting for
the host, shared data (list, put, live changes), who changed a row (person or agent),
an edit flow (dialog + form with setValues), status badges, an error with Try again, the
page declaration, an agent event, an agent tool and frame-move state.

Publish it with `apps.publish({ appId, files, manifest, note })` where `files` holds
`index.html` and `app.js` as `{ path, content }`. The page, sections, inputs,
table, notice and empty text are kit components (`apps.guide({ section: "kit" })`, or
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
<summer-page heading="Playtest notes" purpose="Tester notes per level, shared with your team and your agent.">
  <summer-button slot="actions" id="add" variant="primary" icon="plus">Add note</summer-button>
  <summer-section heading="Notes">
    <summer-notice id="error" tone="error" action="Try again" action-icon="refresh-cw" hidden></summer-notice>
    <summer-table id="table" row-key="id" sortable clickable loading
      empty-text="No notes yet. Add the first one, or ask your agent to add the testers' notes."></summer-table>
  </summer-section>
  <summer-dialog id="dialog" heading="Note" description="Shared with your team and your agent.">
    <summer-form id="form" submit-label="Save note">
      <summer-text-input label="Note" name="text" multiline required></summer-text-input>
      <summer-grid columns="2">
        <summer-text-input label="Level" name="level" placeholder="bridge"></summer-text-input>
        <summer-select label="Status" name="status" options='[{"value":"open","label":"Open"},{"value":"fixed","label":"Fixed"}]'></summer-select>
      </summer-grid>
    </summer-form>
  </summer-dialog>
</summer-page>
<!-- app.js runs after the SDK module (module scripts run in order). -->
<script type="module" src="app.js"></script>
</body>
</html>
```

## app.js

```js
const notes = summer.data.collection("notes");
const info = await summer.ready;   // { viewer: { userId, name }, params, restored, ... }
const $ = (id) => document.getElementById(id);
const table = $("table"), dialog = $("dialog"), form = $("form"), error = $("error");
let editing = null;                 // the note id being edited, or null for a new one

table.columns = [
  { key: "text", label: "Note", priority: "primary" },
  { key: "level", label: "Level" },
  { key: "status", label: "Status", badges: { open: "warn", fixed: "ok" } },   // one badge tone per value
  { key: "by", label: "By", type: "muted" },
];

async function load() {
  table.setAttribute("loading", "");
  try {
    const page = await notes.list({ limit: 500 });   // removed notes are never listed
    table.rows = page.records.map((r) => ({
      id: r.recordId,
      ...r.data,
      // createdBy: who made the row ({ userId, kind: "person" | "agent" | "seed", agent?, via? });
      // later edits do not change it (actor is the last writer). Seed rows have no author.
      by: r.createdBy?.kind === "agent" ? `${r.createdBy.agent ?? "Agent"} (agent)` : r.data.author ?? "",
    }));
    error.hidden = true;
  } catch (e) {
    error.setAttribute("text", `Could not load notes: ${e.message}`);
    error.hidden = false;
  } finally {
    table.removeAttribute("loading");
  }
}
error.addEventListener("action", load);   // the notice's "Try again" button

function openEditor(row) {
  editing = row?.id ?? null;
  form.setValues(row ?? { text: "", level: "", status: "open" });
  dialog.show();
}
$("add").addEventListener("click", () => openEditor(null));
table.addEventListener("summer-row", (event) => openEditor(event.detail.row));   // click a row to edit

form.addEventListener("submit", async (event) => {
  const { text, level, status } = event.detail.values;   // numbers come as numbers, empty as null
  form.setAttribute("busy", "");
  try {
    const id = editing ?? crypto.randomUUID();
    await notes.put(id, { text, level: level ?? "", status: status ?? "open", author: info.viewer.name ?? "someone" });
    if (!editing) await summer.agent.send("note.added", { id, text, level });   // name is in manifest.agentEvents
    dialog.close();
    summerUI.toast("Note saved");
  } catch (e) {
    form.setAttribute("error", e.message);
  } finally {
    form.removeAttribute("busy");
  }
});

// Live: every change by a teammate or an agent arrives as { revision, actor, ops } (or { reset: true }).
notes.subscribe(() => load());

// Agent tool: apps.call({ appId, tool: "add_note", input: { text, level } }) runs this while the app is open.
// Its writes are recorded as the calling agent's (actor.kind "agent", via "agent-tool").
summer.agent.tool("add_note", async ({ text, level }, { agent }) => {
  const id = crypto.randomUUID();
  await notes.put(id, { text, level: level ?? "", status: "open", author: agent });
  return { id };
});

// What agents can read with apps.page and use with apps.use_page.
summer.page.declare({ actions: [{ id: "add", label: "Add note", run: () => openEditor(null) }] });

// Frame moves: Studio moves an idle app to a fresh frame every few minutes. Shared data survives on
// its own; keep only UI state, such as an open editor.
summer.app.onSnapshot(() => (dialog.hasAttribute("open") ? { editing, values: form.values } : null));
if (info.restored?.values) {
  editing = info.restored.editing;
  form.setValues(info.restored.values);
  dialog.show();
}

load();
```

Playing sound with Web Audio instead of `<audio>`? Wrap it so the frame is not moved
mid-sound: `summer.app.busy(true)` when it starts, `summer.app.busy(false)` in the
source's `onended`.

## The agent side of the same app

```json
{ "appId": "<id>", "ops": [{ "op": "put", "collection": "notes", "recordId": "n-1", "data": { "text": "Boss fight too long", "level": "boss", "status": "open", "author": "agent" } }] }
```

That is an `apps.write_data` input: it works with the app closed, and the open app shows it
through `notes.subscribe`. `apps.tools` and `apps.read_data` return the
`collections` above, so an agent knows the record shape.
