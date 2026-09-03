---
name: driving-the-editor-ui
description: Use when a task is an editor-workflow step a human would do with the mouse — open Project Settings or a dock, switch the 2D/3D/Script main screen, toggle a panel, clear a dialog that is blocking the editor, read what a dock shows — and when deciding whether a request is UI work or scene work. Drives the editor by NAME through summer_ui_actions, reads it as structure through summer_ui_tree, activates the long tail by path through summer_ui_activate, and treats summer_ui_screenshot as the pixels-last fallback. Preview — the ops ship with a follow-up engine build.
---

# Driving the Editor UI

## UI work vs scene work — decide first

The editor UI is **not** where scene work happens. Nodes, properties, placement, lighting, materials: `scene-scripting` (`summer_run_script`), the scene tools, `summer_world_snapshot` / `summer_snapshot_diff` / `summer_screenshot` (`verifying-scenes`). The Scene dock and the Inspector are *views* of that data; clicking through them to change a property is slower, less reliable, and unverifiable compared with `summer_set_prop`.

UI ops are for the steps a human does with the mouse that have no scene-level equivalent:

| Ask | Route |
|---|---|
| "Open Project Settings" / "open the Import dock" / "toggle the Animation panel" | `summer_ui_actions mode:"invoke"` by name |
| "Switch to the 3D view" / "go to the Script screen" | `summer_ui_activate path:"main_screen" action:"select_tab" value:"3D"` |
| "Something is blocking the editor" / tool calls return `modal_open` | the blocking-dialog pattern below |
| "What does the Inspector show right now?" | `summer_ui_tree root:"dock:inspector"` |
| "Change the main scene setting" | `summer_project_setting` — a dedicated tool wins over any UI op |
| "Move the player to (0, 1, 0)" | `summer_set_prop` / `summer_run_script` — scene work, never UI |

## The ladder

1. **Dedicated tool** (`summer_project_setting`, `summer_open_scene`, `summer_select_node`, `summer_save_scene`, …). If one exists, the UI ops are the wrong layer.
2. **Named action** — `summer_ui_actions mode:"list" filter:"<word>"` to find the exact `name`, then `mode:"invoke" action_name:"<name>"`. The event takes the same path the shortcut key would, so the editor's own handlers run.
3. **Tree + activate** — `summer_ui_tree` to find a control's `path`, `summer_ui_activate` to press / toggle / select a tab / set text / set a value through the control's own input path.
4. **Pixels** — `summer_ui_screenshot`, only to look. There is no coordinate click anywhere in this surface: if a thing is visible it is in the tree, and the tree is what activation takes.

Each rung costs more tokens and is less deterministic than the one above it. Do not start at 3 because it feels general.

## The blocking-dialog pattern

An exclusive dialog (Project Settings, a confirmation, an unsaved-changes prompt) makes the root window drop input; every mutating UI op then answers `modal_open` with the `blocking_dialog`, and other editor operations may stall as `still_queued`.

1. `summer_ui_tree root:"dialogs"` → read `blocking`, `blocking_dialog {title, path, class}`, and the dialog's `text` and `buttons` (`kind: ok | cancel | custom`, `enabled`).
2. Decide with the user in view. `button:"cancel"` is the safe close and the default; `"ok"` or a custom button text confirms whatever the dialog asks — only when that is what the user wants.
3. `summer_ui_activate action:"dismiss_dialog" path:"<blocking_dialog.path>"` (or `title:"<title>"`).
4. Read back: the result's `visible_after` must be `false`, and `summer_ui_tree root:"dialogs"` must show `blocking:false`. `visible_after:true` means the dialog re-validated and stayed up — read it again with `root:"dialog:<title>"` instead of retrying blindly.

A dialog the human would have to click through, you also have to click through — nothing here bypasses one.

## Main-screen switching

`spatial_editor/*` actions need the 3D screen; `canvas_item_editor/*` need 2D; the script editor's actions need Script. A `not_handled` result (`invoked:true, handled:false`) usually means the wrong screen is up.

```
summer_ui_activate path:"main_screen" action:"select_tab" value:"3D"
→ state.current_tab / state.text read back the selected editor
```

`value` is the editor name (`2D`, `3D`, `Script`, `Game`, `AssetLib`, case-insensitive) or `index`. `not_selected` means the switch was refused (scene change in progress, hidden editor button) — wait, retry, read back.

## Reading a dock's state

`summer_ui_tree root:"dock:<title|id>"` (`file_system`, `scene_tree`, `inspector`, or any dock title) returns the dock's controls with `text`, `tooltip` (icon-only buttons are named by it), `checked`, `enabled`, `tabs` + `current_tab`, `value/min/max`, `item_count/selected`. Go deeper on one subtree with `root:"path:<path>"` and a larger `depth`/`limit`; `children_truncated:true` plus the real `child_count` tells you where a cut happened.

Paths and auto-names (`@Panel@123`) are stable within a session only. Re-read the tree before activating; never persist a path across sessions.

## The deny-list

The engine refuses, with `denied_action`, anything that ends or replaces the session or deletes without the human's confirmation: `editor/file_quit`, `editor/quit_to_project_list`, `editor/reload_current_project`, `scene_tree/delete_no_confirm`, every `project_manager/*` name — and buttons or menu items whose label quits, reloads the project, or closes the editor. `summer_ui_actions mode:"list"` marks them `denied:true`. Do not attempt them and do not route around them by path; tell the user what was asked and leave that click to them. File-dialog paths that leave the project (`..`, `user://`, `~`, absolute paths outside `res://`) are refused as `denied_path`.

## Verification — read back, never assume

- An invoke succeeded when its **effect** is observable: a dialog appears in `root:"dialogs"`, a dock's `summer_ui_tree` changes, or — for anything scene-level — `summer_snapshot_diff` / `summer_get_scene_tree` show it. `invoked:true` alone proves the event was dispatched, not that anything happened.
- `summer_ui_activate` returns `state` **after** the action from the same node (`checked`, `current_tab`, `text`, `value`, `freed:true` if the action freed it). Cite it.
- A screenshot proves appearance only. A control's exact state is in the tree.
- `engine_lacks_op` means the build predates these ops: nothing was sent. Use the dedicated tools for the outcome, or ask the user to click, and say so.

## Failure taxonomy — what to do

| `failure_reason` | Means | Next |
|---|---|---|
| `unknown_action` (+`close_matches`) | no such name | pick one of the matches, or `mode:"list"` with a filter |
| `denied_action` | safety list | stop; hand the click to the user |
| `modal_open` (+`blocking_dialog`) | exclusive dialog eats input | blocking-dialog pattern |
| `not_handled` | dispatched, no receiver | switch main screen / reveal the owning panel, retry |
| `not_visible` / `disabled` / `obscured` | control exists but cannot take the event | reveal it, satisfy the precondition, or dismiss what covers it |
| `unsupported_control` (+`supported_actions`) | class not driven this way | use the listed action, or a named action (MenuBar) |
| `no_activation_path` | no hover and no focus reached the button | the named action instead |
| `tab_not_found` / `button_not_found` / `ambiguous_dialog` | wrong or ambiguous name | use the listed `tabs` / `buttons` / `candidates` verbatim |
| `no_renderer` | headless editor, no pixels | `summer_ui_tree`; pixels need a display |

**Related skills:** `scene-scripting` and `verifying-scenes` own the scene loop this skill deliberately stays out of; `verification-before-completion` carries the done-claiming rules; `headless-scripting` is the route when there is no editor UI at all.
