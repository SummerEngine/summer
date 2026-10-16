---
name: summer-apps-design
description: "How a Summer App should look: layout, Summer UI kit components, tables, charts, states, pre-ship check."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: tools
user-invocable: false
---

# Summer Apps design

A Summer App is a tool a game team uses every day inside Summer Studio. It should
feel like a calm, precise studio instrument around colourful game content. The
chrome is ink on paper; colour comes from the game (art, renders, waveforms) and
from data that means something. You have freedom inside the app. Use it for the
task, not for decoration.

## The catalog is the API

The kit ships `summer-ui/v1/catalog.json` next to `ui.js` on the kit origin (the
summer-apps skill says how to load the kit). It lists every component's
attributes with value shapes, events with their `detail`, slots, methods, a working
example, the icon names and the tokens. **Read the entry before you use a
component** and copy its example. Never guess an attribute.

- JSON attributes take a JSON string, or set the same-named property:
  `table.rows = rows`. Prefer properties for data.
- Events bubble out of the components; read `event.detail`.
- Icons: only names in `icons.names` (lucide: `plus`, `check`, `pencil`,
  `trash-2`, `search`, `sparkles`, `download`, `ellipsis`, ...). Never draw SVG.
- Colours: only the tokens in `tokens` (`var(--se-text)`, ...). No hex.

## Do this

1. Write one line: what the person came to do, and the one action that finishes
   it. That action is the primary button.
2. Build the page from the recipe below. Every part is a kit component; write your
   own CSS only for layout glue (a grid, a gap), from tokens, under 30 lines.
3. Read real data through the SDK. No lorem ipsum, no invented numbers.
4. Wire `loading`, empty and error for every data component.
5. Run the checklist. Look at light and dark, 390px and 1440px.

## Page recipe

```html
<summer-page heading="Playtest results" purpose="How each level played in the latest playtest. Notes are shared with your team and your agent.">
  <summer-avatar-stack slot="actions" people='[{"name":"Mia"},{"name":"Tom"}]'></summer-avatar-stack>
  <span slot="actions" class="summer-meta">Playtest 12 Oct</span>
  <summer-button slot="actions" variant="primary" icon="plus">Add note</summer-button>

  <summer-stats loading>…3-5 summer-stat…</summer-stats>
  <summer-chart heading="Where players stop" loading …></summer-chart>
  <summer-section heading="Levels">
    <summer-select slot="aside" label="Sort" options='…'></summer-select>
    <summer-table loading …></summer-table>
  </summer-section>
</summer-page>
```

- `summer-page` gives the canvas, width (1280px; forms 640px), padding and spacing,
  and the header. The purpose line says what the tool does and where data goes.
  Header actions, in order: avatars, one meta (`.summer-meta` or
  `summer-progress`), secondary buttons, the primary.
- One `summer-section` per part, with a short noun heading. Extras for the title row
  (a select, a count) go in `slot="aside"`; a select there turns compact by itself.
- A chart gets its own `heading` (its legend then sits in the title row). A chart
  without a heading as the first thing in a section moves its legend into the
  section's title row.
- A page with one part needs no section heading and no card around it.
- Tables and lists are always framed; charts never. Do not set `frame="false"` on
  a page.

## Pick the component

| Job | Use (exact names; shapes in the catalog) |
| --- | --- |
| Key numbers | `summer-stats` > 3-5 `summer-stat label value delta hint tone`. Delta is text like "+12 this week"; the kit colours the number |
| A comparison or trend | `summer-chart kind x y heading highlight reference`. `y` is a JSON array of keys; `highlight` `{key, above, below, equals, tone, label, otherLabel}` (`key` tests another field, e.g. colour `lines` bars where `redo` is above 3; `equals` takes a value or a list); counts get whole-number gridlines by themselves; `reference` `{value, label, tone}`. One question per chart |
| Records you scan, sort, edit | `summer-table columns rows row-key`. Column `{key, label, format, digits, type: bar/badge/muted, over, tone, badges, priority: "secondary", thumb, editable, badge, badgeTone, width, minWidth, wrap}`. Text columns wrap to 2 lines by themselves; `width` takes pixels, a CSS length, "narrow" or "wide" (e.g. `"wide"` for a notes column). `badges` maps each value to a tone or `{tone, label}` for a status column (`{"draft": "quiet", "review": {"tone": "info", "label": "In review"}, "done": "ok"}`; unlabelled values show in sentence case); `badge` names a row key shown as a small badge inside a cell (e.g. "+3:01" over target). Under 640px badge columns fold under the name, and rows stack only if the columns still do not fit. `clickable` gives `summer-row`; `selectable="single"` or `"multi"` gives `summer-select-rows` |
| Unsaved table edits | `summer-save-bar count save-label` (`save` and `discard` events; then `table.commit()` or `table.discard()`) |
| Notes, tasks, comments | `summer-list items checkable action menu`. Item `{id, title, meta, checked, badge: {text, tone}, action}`; `action` `{id, label, icon}` is the one quiet button per row; `menu` items `{id, label, icon, tone: "danger"}`; events `summer-check`, `summer-action`, `summer-item` |
| Pipeline stages | `summer-board` > `summer-lane heading lane-id add-label` > `summer-board-card heading card-id art meta person comments done`; `summer-move` event |
| Pick between versions | `summer-choice-grid items` (`layout="row" heading meta` for one row per need). Item `{id, label, src, kind}` |
| Filters above a list | `summer-toolbar` > `summer-search`, `summer-segmented options value` (`{value, label, count}`; scrolls inside its own track when it does not fit), `summer-select` in `slot="end"` (compact by itself) |
| Add or edit something | `summer-dialog heading description` > `summer-form submit-label` > named inputs |
| Inputs | `summer-text-input name label hint required multiline`, `summer-select name label options`, `summer-slider`, `summer-toggle`. Every field sends `input` and `change` with `event.detail.value` |
| Media | `summer-audio`, `summer-video`, `summer-image aspect`, `summer-model-viewer`. Never `<audio controls>` or `<video controls>` |
| A repeated object | `summer-card variant="object" media selected` |
| Status in words | `summer-badge tone` (ok, warn, bad, info, quiet, count) |
| Buttons | `summer-button variant icon size`, `summer-icon-button icon label` |
| Messages | `summer-notice tone text action` in place (`action="Try again"` adds a button; listen for `action`); `summerUI.toast(text)` after an action |
| Nothing yet | `summer-empty-state heading body` with one button inside |

If you play Web Audio yourself, call `summer.app.busy(true)` while it plays and
`busy(false)` after.

## Patterns

**Dashboard (numbers, chart, table).** Stats, then one chart answering the main
question with the problem bars highlighted and a reference line for the target,
then the table with a bar column for the value that matters. Columns a phone can do
without get `priority: "secondary"`.

**Badges in tables.** Two kinds, one rule each:
- A workflow status column (draft, in review, done, needs art) shows every value as
  a badge with `badges`. Neutral steps are `quiet`, work in progress `info`, done
  `ok`; only values that need someone to act get `warn` or `bad`.
- A health column (balance, over target, errors) shows a badge only on the rows
  that need attention and stays empty on the rest. Never "OK" on every row.

**Edit flow.** A row click (`summer-row`) or the header's primary opens a
`summer-dialog` holding a `summer-form`. For an edit, call
`form.setValues(record)` before `dialog.show()`; for a new item, show it empty.
Listen for `submit` (`detail.values`; number fields give numbers, empty gives
null); set `busy` while saving and `error` if it fails; close the dialog on success and toast the result ("Note saved"). The rule is one
primary per region: the page header, an open dialog, a form that is the whole page,
and the save bar are separate regions. A page whose job is the form puts Save in the
form and no primary in the header.

**Empty page and the header.** One primary on screen. When the whole page is empty,
the empty state holds the primary ("Add note" or "Ask your agent") and the header
shows no primary until there is data. When only one section is empty, its
empty-state button is `secondary` and the header keeps its primary.

**List with row actions.** `summer-list` with `checkable` for done or fixed, one
`action` for the most common step (`{id: "fix", label: "Mark fixed", icon:
"check"}`: a quiet button that shows on hover and on touch), and `menu` for the rest
(Edit, Copy, Delete with `tone: "danger"`). Never a bordered button on every row.
Delete asks first in a `summer-dialog` with `summer-form destructive`.

**Data your agent fills in.** When the app waits on an agent (an import, an
analysis), the empty state says what is missing and offers the request:
`summer-empty-state heading="No playtest data yet" body="Your agent can import
last night's playtest."` with a `summer-button icon="sparkles"` "Ask your agent"
(primary or secondary per the empty-page rule above). On click call `summer.agent.send("playtest.import", {})`, swap the button
for `summer-notice tone="info"` "Your agent was asked. This fills in when it
answers.", and subscribe so rows appear live:
`summer.data.collection("levels").subscribe(render)` (there is no
`summer.data.list(name)`).

**Who added it, who changed it.** People and agents edit the same data. Every
record carries `createdBy` (set once, when it was added) and `actor` (the last
writer), both `{userId, kind: "person" | "agent" | "seed", agent, via}` or null on
old records. A "By"
column or list meta shows `createdBy`: the person's name, or the agent's name
("Claude Code") with an "Agent" badge when `createdBy.kind` is "agent". Show
nothing for "seed" (starter data) or null. Add "Last changed by" from `actor` only when it
helps the task. Say "You" when the `userId` is `info.viewer.userId`. Flash a row or
card that someone else just changed. Changes from `subscribe` carry `actor` but not
`createdBy`: read the record again (`get(id)`) to show who added it.

**Board.** Lanes per stage, art on cards from the asset, owner initial and comment
count. Move cards with `summer-move`; write the new stage to data at once.

**Pick grid.** One `summer-choice-grid layout="row"` per need; the header shows
`summer-progress` and the primary sends the picks ("Send 7 to game").

## States

- Loading: set `loading` on stats, chart, table, list and select until the data
  arrives. Never show "No data yet" or "-" while loading.
- Empty: `empty-text`, or `empty-heading` + `empty-body`, on the component, or
  `summer-empty-state` for a whole page. Say what to do next.
- Error: `summer-notice tone="error" text="The notes could not load." action="Try again"`
  in place of the part that failed; retry on its `action` event. The rest keeps
  working.
- Saving: `busy` on the form or save bar, `loading` on a button.

## Type, colour, copy

- The kit sets type. In your own glue use 14px body, 12px muted meta, weights 400,
  500, 600, `tabular-nums` for numbers. Never 700, never all caps.
- Colour means something: quiet by default, ink or a status tone for what needs
  attention, always with words.
- Plain words, sentence case, no full stop on labels. Name actions by result ("Save
  note", "Write to game"). Errors do not apologise. Never "AI-generated".

## Never

Grey boxes around numbers. Cards around every section, cards inside cards. Native
audio, video, select or range controls. Two primaries in one region. A labelled
button on every row. A health badge on every row that only says all is well. Hand-drawn icons, emoji. Hex
colours, gradients, glows, shadows on cards. Mono font for numbers. "No data yet"
while loading.

## Checklist

- [ ] The purpose line says what the tool does; one primary per region finishes it.
- [ ] Every component and attribute matches its catalog entry.
- [ ] Numbers line up; long text wraps; on a phone nothing scrolls off.
- [ ] Loading, empty (including "waiting for your agent") and error states exist
      and keep the layout in place.
- [ ] Subtract: remove each badge, icon, helper line and frame; keep it only if the
      task gets worse without it.
- [ ] Works by keyboard; icon buttons have labels.
- [ ] Looked at light and dark, 390px and 1440px; nothing scrolls sideways except a
      board or a wide table inside its frame.
