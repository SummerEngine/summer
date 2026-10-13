---
name: summer-apps-design
description: "How a Summer App should look - page layout, Summer UI kit components, tables, charts, media, boards, states and a pre-ship checklist."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: tools
user-invocable: false
---

# Summer Apps design

A Summer App is a tool a game team uses every day inside Summer Studio. It should
feel like a calm, precise studio instrument around colourful game content. The
chrome is ink on paper; the colour comes from the game (art, renders, waveforms)
and from data that means something.

You have freedom inside the app. Use it for the task, not for decoration.

## Do this

1. **Start from the task.** Write down in one line what the person came to do and
   the one action that finishes it. That action is the only primary button.
2. **Use the kit.** `<script type="module" src="/summer-ui/v1/ui.js">` gives you the
   tokens, Geist and the `summer-*` components, and follows Studio light/dark.
   Never restyle a kit component's colours. Build a missing pattern from the
   tokens in a small scoped `<style>`.
3. **Lay out the page** (section "Page").
4. **Show real data.** Read it from the SDK (`data`, `assets`, `engine.readFile`).
   No lorem ipsum, no fake numbers when real ones exist.
5. **Design every state** the app can reach (section "States").
6. **Run the checklist**, then look at it light and dark, at 390px and 1440px.

## Page

- Wrap the app in `<summer-page heading="…" purpose="…">`. It paints the canvas,
  centres content (max 1280px; forms 640px), sets padding and section spacing,
  and renders the header: title 22/600 plus one 13px muted purpose line that says
  what the tool does and where data goes ("Edits write to res://data/weapons.json").
  Put avatars, one meta (`<span class="summer-meta">Synced 2 min ago</span>` or
  `<summer-progress>`), secondary actions and the one primary in `slot="actions"`.
- Each part of the page is a `<summer-section heading="…">`: 15/500 title row,
  legend or meta in `slot="aside"`, content 12px below. No frame unless the content
  needs a boundary. A page with one section needs no section title and no card.
- 4px grid. 8-12px inside a group, 16-24px between groups.
- Layout-format apps: the `page` node takes `{title, purpose, meta}` and puts its
  button children in the header.

## Type and colour

- Geist only. Sizes: 22 title, 28 metric, 15 section, 14 body, 13 table and
  buttons, 12 labels and meta, 11 badges. Weights 400, 500, 600. Never bold 700,
  never all caps. Numbers, money and times use `font-variant-numeric: tabular-nums`.
- Colours are CSS variables only: `--se-bg`, `--se-bg-input`, `--se-bg-muted`,
  `--se-bg-hover`, `--se-text`, `--se-text-secondary`, `--se-text-muted`,
  `--se-border`, `--se-border-subtle`, `--se-border-focus`, `--se-cta-bg`,
  `--se-cta-fg`, and status `--success`, `--warning`, `--destructive`, `--info`.
  No hex values, no Tailwind palette colours.
- Data colour carries meaning: normal marks are quiet, the thing to notice is
  ink or a status colour. A status colour always comes with words.

## Components to reach for

| Need | Use |
| --- | --- |
| Key numbers | `<summer-stats>` of 3-5 `<summer-stat label value delta hint tone>`: unboxed, split by hairlines |
| Records | `summer-table`: columns with `type` (bar, badge, muted), `priority="secondary"` to hide on phone, `thumb`, `digits`; badge only for exceptions. `<summer-save-bar count>` for unsaved edits |
| Trends, comparisons | `summer-chart` with `title`, `highlight` (the bars that matter) and `reference` (a target line). One question per chart. Frame only if asked |
| Sound | `summer-audio`: our play button and waveform. Never `<audio controls>` |
| Video | `summer-video`: our controls. Never `<video controls>` |
| Pick one version | `summer-choice-grid` (`layout="rows"` for one row per need): the whole tile is the choice |
| Boards | `<summer-board>` > `<summer-lane heading add-label>` > `<summer-board-card heading art meta person comments done>` |
| A repeated object | `<summer-card variant="object" media selected>` |
| Images, 3D | `summer-image`, `summer-model-viewer` |
| Filters | `<summer-toolbar>`: `<summer-search>`, `<summer-segmented options value>`, extras in `slot="end"` |
| Settings | `summer-select`, `summer-slider`, `summer-toggle`, `summer-text-input` |
| Actions | `<summer-button variant icon>` (primary once per view), `<summer-icon-button icon label>` |
| Status | `<summer-badge tone>` (ok, warn, bad, info, quiet, count) with words, `<summer-progress value>` |
| Icons | `<summer-icon name>` (lucide set). Do not draw your own glyphs |
| Who is here | `summer-avatar-stack` in the page actions |
| Loading, errors | `<summer-skeleton width height radius>`, `<summer-notice tone text>`, `summer-empty-state` |
| Feedback | `summerUI.toast(text)` for a finished action |
| Phone | `hide-sm` attribute hides a secondary element under 640px |

## Layout recipes

**Balance table + chart.** Header, metric strip, a chart section answering one
question ("DPS by weapon", over-budget bars red, dashed budget line), a toolbar
(search, class filter, "3 over budget" badge), a framed table with art thumbs,
editable numbers and an inline bar on the value that matters, then a sticky save
bar "2 unsaved changes", Discard, "Write to game".

**Pipeline board.** Header with "5 of 14 done" and primary "Add creature". Toolbar
(search, Everyone/Mine, Board/List). Four lanes with a name, count and add button;
no lane fill. Cards: 4:3 art (none in early stages), name 14/500, a 12px meta row
with owner avatar, status text and comment count. On phone, lanes scroll sideways.

**Pick grid.** Header with "7 of 12 picked" + progress and primary "Send 7 to
game". Filter Needs a pick / Picked. One row per need: name, meta and status on
the left (220px), three choice tiles on the right. Playing tile: ink pause button
and ink played bars. Picked tile: ink border and check. On phone, each tile is one
48px row.

## States

- Loading: skeletons in `--se-bg-muted` with the result's shape. A spinner only
  inside a busy button.
- Empty: centred, a 15/500 title, one muted line that says what to do, one button.
- Error: a notice in place of the failed part, plain words, a retry. The rest of
  the app keeps working.
- Live change from a teammate or agent: flash the changed row or card
  `--se-bg-hover` for 600ms. No toast.

## Never

Grey filled boxes around numbers. Cards around every section, cards inside cards.
Native audio, video, select or range controls. Two primary buttons. Huge charts
with centred legends. Coloured left borders, accent lines, gradients, glows,
shadows on cards. All-caps labels. A status badge on every row. Emoji. Mono font
for numbers. "AI-generated" or "made with AI" anywhere.

## Checklist

- [ ] One line says what the tool does; one primary action finishes it.
- [ ] Every component is a kit component or built from the tokens above.
- [ ] Numbers line up (tabular, right-aligned); rows keep fixed slots.
- [ ] Subtract: remove each badge, icon, helper line and frame; keep it only if the
      task gets worse without it.
- [ ] Loading, empty and error states exist and keep the layout in place.
- [ ] Works by keyboard; icon-only buttons have labels.
- [ ] Looked at light and dark, 390px and 1440px. Nothing scrolls sideways except
      a board or a wide table inside its own frame.
