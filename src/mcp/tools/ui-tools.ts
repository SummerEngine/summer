import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withEngine, missingEngineOpResult, withOldEngineHint } from "./with-engine.js";
import {
  buildUiActionsOp,
  buildUiActivateOp,
  buildUiScreenshotOp,
  buildUiTreeOp,
  executeUiOp,
  uiActionsArgsSchema,
  uiActivateArgsSchema,
  uiScreenshotArgsSchema,
  uiScreenshotCaption,
  uiScreenshotImage,
  uiTreeArgsSchema,
  withUiFailureDetails,
  type BuiltUiOp,
  type UiOpClient,
} from "../../core/capabilities/ui-control.js";

/**
 * Editor UI control tools (wave L). The MCP face only — the op builders, the
 * shared zod contracts, and the failure rendering live in
 * core/capabilities/ui-control.ts and are used verbatim by the CLI dispatcher.
 *
 * Doctrine these descriptions teach (research/agent-platform/04-total-control
 * §1): SEMANTIC FIRST. Scene work goes through the scene and perception tools;
 * the UI ops are for editor-WORKFLOW steps a human would do with the mouse —
 * open Project Settings, switch the main screen, clear a blocking dialog, read
 * a dock. Within the UI ops: a named action beats a tree walk, a tree walk
 * beats pixels, and pixels never drive clicks (there is no coordinate-click
 * op). Quit / project-reload / delete-without-confirm actions are denied by
 * the engine and are never attempted.
 */

const DOCTRINE =
  "SCENE WORK IS NOT UI WORK: to add, move, retune, or read nodes use summer_run_script, the scene tools, summer_world_snapshot and summer_screenshot — never by clicking through the editor. UI ops are for editor-workflow steps a human would do with the mouse: open Project Settings or the Import dock, switch the 2D/3D/Script main screen, clear a dialog that is blocking input, read what a dock currently shows.";

const LADDER =
  "Order of preference: a dedicated tool -> summer_ui_actions mode:'invoke' by name -> summer_ui_tree + summer_ui_activate by control path -> summer_ui_screenshot (pixels, last, and only to LOOK — never to pick coordinates).";

const DENY =
  "Never try to quit the editor, quit to the project list, reload the project, or delete without confirmation (editor/file_quit, editor/quit_to_project_list, editor/reload_current_project, scene_tree/delete_no_confirm, project_manager/*): the engine refuses them with denied_action, and buttons/menu items with those labels are denied the same way. They end the session you are talking over.";

async function sendUiOp(client: UiOpClient, built: BuiltUiOp): Promise<unknown> {
  const missing = missingEngineOpResult(client as never, built.kind, built.fallback);
  if (missing) return missing;
  const result = await executeUiOp(client, built);
  return withOldEngineHint(withUiFailureDetails(result), built.kind, built.fallback);
}

export function registerUiTools(server: McpServer): void {
  server.tool(
    "summer_ui_actions",
    `List the editor's named actions, or invoke ONE by name exactly as its menu item / shortcut would — the primary way to drive the editor UI. (preview — needs an engine build with UiListActions/UiInvoke)

${DOCTRINE}

mode:'list' -> {actions:[{name, label, shortcut_text, category, source:'shortcut'|'command', denied?}], total, truncated, filter}. name is the stable shortcut path ('editor/save_scene', 'editor/project_settings', 'spatial_editor/focus_selection', 'summer/design_mode'); filter is a case-insensitive substring over name and label. denied:true marks names mode:'invoke' will refuse — read it and do not try them.
mode:'invoke' action_name:'<name>' -> {action, label, invoked:true, handled, via:'shortcut_event'|'command_palette', opened_dialog?, mutates:true}. The event runs through the same MenuBar/PopupMenu/EditorNode handlers the key would. opened_dialog is a window that appeared synchronously; a dialog shown deferred appears on the next summer_ui_tree root:'dialogs'.

${LADDER} Read back, never assume: after an invoke, confirm the effect with summer_ui_tree root:'dialogs' (a dialog opened), summer_ui_tree root:'dock:<name>' (a dock changed), or the scene/perception tools (the scene changed).

Failures carry failure_reason: unknown_action (+close_matches — pick the exact name) | denied_action (+reason — stop; do not route around it) | modal_open (+blocking_dialog — an exclusive dialog is eating input: summer_ui_tree root:'dialogs', then summer_ui_activate action:'dismiss_dialog', then retry) | not_handled (invoked but no live receiver — switch context first, e.g. summer_ui_activate path:'main_screen' action:'select_tab' value:'3D') | editor_unavailable. ${DENY} On an engine build without these ops the result is a structured engine_lacks_op failure (nothing is sent) naming the dedicated tools to use instead.`,
    uiActionsArgsSchema.shape,
    async (args) =>
      withEngine(async (client) => sendUiOp(client, buildUiActionsOp(args)))
  );

  server.tool(
    "summer_ui_tree",
    `Structured tree of the live editor UI — every visible Control with its class, path, rect, text/tooltip and state (checked, enabled, focused, tabs + current_tab, value/min/max, selected item) — or, with root:'dialogs', every visible dialog/popup and whether one is BLOCKING input. The structured alternative to a screenshot: the tree states outright what exists and what is clickable, at a fraction of the tokens, and its paths are what summer_ui_activate takes. (preview — needs an engine build with UiTree/UiDialogs)

${DOCTRINE} Use this tree to READ editor state (which main screen is active, what a dock shows, what a dialog says and which buttons it has) and to find a control's path when no named action covers the step; use summer_get_scene_tree / summer_world_snapshot for the SCENE — the editor's Scene dock is a view of that data, not the data.

root: 'main' (default; the editor chrome) | 'window' (incl. every sub-window) | 'dock:<title|id>' (file_system | scene_tree | inspector or any dock title) | 'dialog:<title>' | 'path:<node path>' (zoom into an earlier result) | 'dialogs' -> {count, blocking, blocking_dialog?, dialogs:[{title, path, class, kind, exclusive, popup, embedded, focused, text?, items?, buttons:[{text, path, kind:'ok'|'cancel'|'custom', enabled}]}]}.
Tree results: {root, root_path, total_emitted, truncated, tree:{name, class, path, visible, rect, text?, tooltip?, enabled?, checked?, focused?, tabs?, current_tab?, value?, child_count, children_truncated?, children}}. Strings clip at 200 chars; icon-only toolbar buttons are named by tooltip; child_count is always the real count, so a children_truncated node can be re-read with root:'path:<its path>' and a larger depth/limit.

Paths (@Panel@123) are stable within a session, not across builds — re-read instead of persisting them. The blocking-dialog pattern: root:'dialogs' -> blocking:true -> summer_ui_activate action:'dismiss_dialog' path:<blocking_dialog.path> -> root:'dialogs' again to confirm blocking:false. Failures: unknown_root (+available_docks, dock_ids) | not_found (+visible_titles) | ambiguous_dialog (+candidates) | editor_unavailable. Engine builds without these ops return a structured engine_lacks_op failure (nothing is sent).`,
    uiTreeArgsSchema.shape,
    async (args) => withEngine(async (client) => sendUiOp(client, buildUiTreeOp(args)))
  );

  server.tool(
    "summer_ui_activate",
    `Activate ONE editor control by its summer_ui_tree path through the control's own input path — a synthetic click for buttons, the public setter + signal for tabs, text fields and ranges — or dismiss a visible dialog (action:'dismiss_dialog'). Mutates editor state; the result's state is READ BACK from the control after the action, not echoed. (preview — needs an engine build with UiActivate/UiDismissDialog)

${DOCTRINE} Reach for this only when no named action covers the step (summer_ui_actions mode:'list' first). There is no coordinate click: if a thing is visible it is in the tree and this reaches it by path.

actions: press (BaseButton: hover+press+release at the rect centre — pressed_emitted is observed, not assumed; ItemList/PopupMenu item by index; MenuBar -> unsupported_control, use summer_ui_actions) | toggle (toggle-mode button) | focus (any control/window) | select_tab (TabContainer/TabBar by value title or index; path:'main_screen' switches the 2D/3D/Script/Game/AssetLib editor by value or index and reads back current_tab + text) | set_text (LineEdit/TextEdit; submit:true also presses Enter; value '' clears) | set_value (Range number) | dismiss_dialog (path or title from summer_ui_tree root:'dialogs'; button 'cancel' default = the safe close, 'ok' or a button text to confirm — only when the user asked for that).

Returns {path, class, action, via, state:{...the node's tree fields...}, mutates:true} plus clicked_at/hover_established/pressed_emitted for press, item_text for menus, submitted for set_text; dismiss_dialog returns {title, class, button, via, visible_after} — visible_after:true means the dialog re-validated and stayed up (read it: summer_ui_tree root:'dialog:<title>'). Verify with the read-back (state.checked, state.current_tab, state.text, visible_after), never by assumption.

Failures: not_found | not_visible (hidden — reveal the dock/tab first) | disabled | unsupported_control (+supported_actions) | obscured (+hit_control — something on top, usually a dialog) | modal_open (+blocking_dialog — dismiss it first) | no_activation_path (use the named action instead) | denied_action / denied_path (safety: quit/reload labels, file-dialog paths outside the project) | tab_not_found (+tabs) | index_out_of_range | missing_value | not_selected | button_not_found (+buttons) | ambiguous_dialog (+candidates). ${DENY} Engine builds without these ops return a structured engine_lacks_op failure (nothing is sent).`,
    uiActivateArgsSchema.shape,
    async (args) => withEngine(async (client) => sendUiOp(client, buildUiActivateOp(args)))
  );

  server.tool(
    "summer_ui_screenshot",
    `PNG of the editor window (or one dock / dialog / control's rect) returned as an image you can look at — the PIXELS-LAST fallback of the UI ladder: use it to see layout, an unfamiliar panel, or to sanity-check what the tree described, never to pick click coordinates (there is no coordinate click; summer_ui_activate takes paths). For the 3D/2D viewport, a scene render, or the running game use summer_screenshot instead — that is the visual-verification tool for scene work, and scene work itself goes through summer_run_script and the scene tools, never through the editor UI. (preview — needs an engine build with UiScreenshot)

${LADDER} Prefer summer_ui_tree for state: a control's checked/current_tab/text is exact there and costs a fraction of an image.

root: 'window' (default; the whole editor window incl. embedded dialogs) | 'main' | 'dock:<title|id>' | 'dialog:<title>' | 'path:<node path>' — a Control or embedded dialog is cropped out of the root viewport texture; a native OS sub-window is not in it (native_subwindow). max_size caps the longest edge (default 1024, 16-4096). Captured from the editor's own root viewport texture, never the OS screen (safety_boundary:'no_os_screen_capture').

Headless is honest: under a headless editor (dummy rendering driver) the result is failure_reason no_renderer — nothing was drawn, so there are no pixels; summer_ui_tree is the structured view of the same UI and a display (Linux: --xvfb) is needed for pixels. Other failures: texture_unavailable | zero_size | native_subwindow | unknown_root | not_found | encode_failed. Engine builds without the op return a structured engine_lacks_op failure (nothing is sent).`,
    uiScreenshotArgsSchema.shape,
    async (args) =>
      withEngine(
        async (client) => sendUiOp(client, buildUiScreenshotOp(args)),
        {
          // withEngine calls toContent only on genuine success (extractOpError
          // cleared): hand the frame back as an image block, or fall back to
          // text when a "success" carries no bytes rather than emit a broken
          // image.
          toContent: (result: unknown) => {
            const image = uiScreenshotImage(result);
            if (!image) {
              return [
                {
                  type: "text" as const,
                  text:
                    "UiScreenshot succeeded but returned no image data. Retry once; if it persists, read the UI structurally with summer_ui_tree.",
                },
              ];
            }
            return [
              { type: "image" as const, data: image.base64, mimeType: image.mime },
              { type: "text" as const, text: uiScreenshotCaption(image) },
            ];
          },
        }
      )
  );
}
