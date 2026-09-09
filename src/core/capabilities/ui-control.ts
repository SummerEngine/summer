/**
 * Editor UI control (wave L) — op builders shared by the MCP tools
 * (src/mcp/tools/ui-tools.ts) and the CLI dispatcher (`summer tool ui-*`) so
 * both faces validate the same arguments, send the same op, and render the
 * engine's failure taxonomy the same way.
 *
 * Seven engine ops (modules/1summer_engine/editor/ops/ui_ops.cpp, frozen in
 * doc/SUMMER/SCENE_SCRIPTING_CONTRACTS.md "Wave L") behind four tools:
 *
 *   summer_ui_actions     mode:"list"   -> UiListActions   (read)
 *                         mode:"invoke" -> UiInvoke        (mutates)
 *   summer_ui_tree        root:<grammar>-> UiTree          (read)
 *                         root:"dialogs"-> UiDialogs       (read)
 *   summer_ui_activate    action:press|toggle|focus|select_tab|set_text|set_value
 *                                       -> UiActivate      (mutates)
 *                         action:"dismiss_dialog" -> UiDismissDialog (mutates)
 *   summer_ui_screenshot                -> UiScreenshot    (read)
 *
 * Doctrine (research/agent-platform/04-total-control.md §1): the agent drives
 * the editor BY NAME. Dedicated scene/perception tools first; a named action
 * (UiInvoke) second; the structured Control tree + activation third; pixels
 * last. There is no coordinate-click op anywhere in this surface.
 *
 * All seven ops are synchronous and batchable (none is single-only). The
 * three mutating ops travel identity-bound so a project switch under the
 * session is rejected before anything runs; the reads go out plain.
 */

import { z } from "zod";
import { ToolInputError } from "../tool-errors.js";

// ---------------------------------------------------------------------------
// Engine-side clamps, mirrored so the client never sends an out-of-range value
// and the two faces agree on what "default" means.
// ---------------------------------------------------------------------------

export const UI_LIST_ACTIONS_MAX_LIMIT = 2000;
export const UI_TREE_MAX_DEPTH = 32;
export const UI_TREE_MAX_LIMIT = 5000;
export const UI_SCREENSHOT_MIN_SIZE = 16;
export const UI_SCREENSHOT_MAX_SIZE = 4096;

export const UI_ACTIVATE_ACTIONS = [
  "press",
  "toggle",
  "focus",
  "select_tab",
  "set_text",
  "set_value",
  "dismiss_dialog",
] as const;
export type UiActivateAction = (typeof UI_ACTIVATE_ACTIONS)[number];

/** The synthetic UiActivate target for the 2D/3D/Script/Game/AssetLib switch. */
export const UI_MAIN_SCREEN_PATH = "main_screen";

/** The root value that turns summer_ui_tree into a UiDialogs read. */
export const UI_TREE_DIALOGS_ROOT = "dialogs";

/**
 * The engine's deny-list, verbatim from the frozen contract. NOT enforced
 * client-side — the engine is the authority and answers `denied_action` — but
 * named here so descriptions and the skill teach the agent what not to try.
 */
export const UI_DENIED_ACTIONS: readonly string[] = [
  "editor/file_quit",
  "editor/quit_to_project_list",
  "editor/reload_current_project",
  "scene_tree/delete_no_confirm",
  "project_manager/*",
];

// ---------------------------------------------------------------------------
// What each tool tells the model to do when the engine lacks its op.
// ---------------------------------------------------------------------------

export const UI_ACTIONS_FALLBACK =
  "use the dedicated tools for the same outcome (summer_project_setting for settings, summer_open_scene / summer_save_scene for scenes, summer_select_node for selection) or ask the user to click the menu item";
export const UI_TREE_FALLBACK =
  "ask the user what the editor shows, or read scene state with summer_get_scene_tree / summer_inspect_node instead";
export const UI_ACTIVATE_FALLBACK =
  "ask the user to click, switch, or dismiss it in the editor; scene changes still go through the scene tools and summer_run_editor_script";
export const UI_SCREENSHOT_FALLBACK =
  "use summer_screenshot for the viewport/scene/game frame, or ask the user for a screenshot of the editor window";

// ---------------------------------------------------------------------------
// Shared zod contracts (pass `.shape` to server.tool; parseToolArgs on the CLI)
// ---------------------------------------------------------------------------

export const uiActionsArgsSchema = z.object({
  mode: z
    .enum(["list", "invoke"])
    .describe(
      "'list' enumerates the editor's named actions (UiListActions, a read). 'invoke' runs ONE named action exactly as its menu item / shortcut would (UiInvoke, mutates editor state)."
    ),
  filter: z
    .string()
    .optional()
    .describe(
      "mode:'list' only. Case-insensitive substring over action name and label, e.g. 'project_settings', 'save', 'spatial_editor', 'bottom_panel'."
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "mode:'list' only. Maximum actions returned (engine default 200, max 2000). The result carries total + truncated — never assume a capped list is complete."
    ),
  action_name: z
    .string()
    .optional()
    .describe(
      "mode:'invoke' only (required there). The exact action name from a 'list' result — the stable shortcut path such as 'editor/project_settings', 'editor/save_scene', 'spatial_editor/focus_selection'. Palette-only commands are accepted too."
    ),
});

export const uiTreeArgsSchema = z.object({
  root: z
    .string()
    .optional()
    .describe(
      "Where to start. 'main' (default) = the whole editor chrome; 'window' = the SceneTree root incl. every sub-window; 'dock:<title|id>' = one dock (ids file_system | scene_tree | inspector, or any dock title, case-insensitive); 'dialog:<title>' = one visible window (exact wins, one substring match accepted); 'path:<node path>' = a path from an earlier result. 'dialogs' = list every visible dialog/popup with its blocking flag and buttons instead of a tree (UiDialogs)."
    ),
  depth: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Tree depth (engine default 4, max 32). Plain Nodes between Controls do not consume depth."),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum Control nodes emitted (engine default 500, max 5000). The result carries truncated + child_count so a cut is visible."),
  visible_only: z
    .boolean()
    .optional()
    .describe("Default true. false also emits hidden controls — readable, but summer_ui_activate refuses them with not_visible."),
});

export const uiActivateArgsSchema = z.object({
  action: z
    .enum(UI_ACTIVATE_ACTIONS)
    .optional()
    .describe(
      "Default 'press'. press = synthetic left click on a button / ItemList item / PopupMenu item (index); toggle = flip a toggle-mode button; focus = grab_focus on any control; select_tab = TabContainer/TabBar by value (title) or index — and the synthetic path 'main_screen' switches the 2D/3D/Script/Game/AssetLib editor by value or index; set_text = LineEdit/TextEdit text (submit:true also emits text_submitted); set_value = Range (SpinBox/Slider) number; dismiss_dialog = close a visible dialog by path or title (UiDismissDialog)."
    ),
  path: z
    .string()
    .optional()
    .describe(
      "A control `path` from summer_ui_tree (required for every action except dismiss_dialog, which may use title instead), or 'main_screen' with action:'select_tab'. Auto-named paths (@Panel@123) are stable within a session only — re-read the tree rather than persist them."
    ),
  value: z
    .union([z.string(), z.number()])
    .optional()
    .describe(
      "select_tab: tab title (or the main-screen editor name: '2D', '3D', 'Script', 'Game', 'AssetLib'); set_text: the text; set_value: the number."
    ),
  index: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("select_tab: tab index; press on an ItemList / PopupMenu: item index."),
  submit: z
    .boolean()
    .optional()
    .describe("set_text on a LineEdit only: also emit text_submitted (the Enter key), e.g. to run a search box."),
  title: z
    .string()
    .optional()
    .describe(
      "dismiss_dialog only: a visible window title (case-insensitive; exact wins, one substring match accepted, otherwise ambiguous_dialog) — from summer_ui_tree root:'dialogs'."
    ),
  button: z
    .string()
    .optional()
    .describe(
      "dismiss_dialog only. 'cancel' (default — the safe close: cancel button / hide / OS close request), 'ok', or the exact text of a button in the dialog's row. Buttons whose label quits or reloads the editor are denied by the engine."
    ),
});

export const uiScreenshotArgsSchema = z.object({
  root: z
    .string()
    .optional()
    .describe(
      "Same grammar as summer_ui_tree root — 'window' (default; the whole editor window), 'main', 'dock:<title|id>', 'dialog:<title>', 'path:<node path>'. A Control or embedded dialog is cropped out of the root viewport texture; a native OS sub-window is not in it (native_subwindow)."
    ),
  max_size: z
    .number()
    .int()
    .optional()
    .describe("Longest edge in pixels after downscale (engine default 1024, clamped 16-4096). Smaller is cheaper to look at; the result reports scale."),
});

export type UiActionsArgs = z.infer<typeof uiActionsArgsSchema>;
export type UiTreeArgs = z.infer<typeof uiTreeArgsSchema>;
export type UiActivateArgs = z.infer<typeof uiActivateArgsSchema>;
export type UiScreenshotArgs = z.infer<typeof uiScreenshotArgsSchema>;

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export interface BuiltUiOp {
  /** The op payload, ready for executeOps / executeIdentityBoundOps. */
  op: Record<string, unknown>;
  /** The engine op kind — what the capability pre-flight checks. */
  kind: string;
  /** What the engine_lacks_op result tells the model to do instead. */
  fallback: string;
  /** True for UiInvoke / UiActivate / UiDismissDialog: travel identity-bound. */
  mutates: boolean;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** summer_ui_actions -> UiListActions (mode:list) | UiInvoke (mode:invoke). */
export function buildUiActionsOp(args: UiActionsArgs): BuiltUiOp {
  if (args.mode === "list") {
    if (nonEmpty(args.action_name)) {
      throw new ToolInputError(
        `mode:'list' does not take action_name (got '${args.action_name.trim()}'). To run that action, call again with mode:'invoke'; to find its exact name, use mode:'list' with filter.`
      );
    }
    const op: Record<string, unknown> = { op: "UiListActions" };
    if (nonEmpty(args.filter)) op.filter = args.filter.trim();
    if (finite(args.limit)) op.limit = clampInt(args.limit, 1, UI_LIST_ACTIONS_MAX_LIMIT);
    return { op, kind: "UiListActions", fallback: UI_ACTIONS_FALLBACK, mutates: false };
  }
  if (args.mode === "invoke") {
    if (!nonEmpty(args.action_name)) {
      throw new ToolInputError(
        "mode:'invoke' requires action_name — the exact name from a mode:'list' result (e.g. 'editor/project_settings'). Nothing was sent."
      );
    }
    if (nonEmpty(args.filter) || finite(args.limit)) {
      throw new ToolInputError(
        "mode:'invoke' does not take filter or limit — those belong to mode:'list'. Pass only action_name."
      );
    }
    return {
      op: { op: "UiInvoke", action: args.action_name.trim() },
      kind: "UiInvoke",
      fallback: UI_ACTIONS_FALLBACK,
      mutates: true,
    };
  }
  throw new ToolInputError("mode must be 'list' or 'invoke'.");
}

/** summer_ui_tree -> UiTree | UiDialogs (root:"dialogs"). */
export function buildUiTreeOp(args: UiTreeArgs): BuiltUiOp {
  const root = nonEmpty(args.root) ? args.root.trim() : undefined;
  if (root !== undefined && root.toLowerCase() === UI_TREE_DIALOGS_ROOT) {
    // depth / limit / visible_only are tree filters; UiDialogs has none.
    return { op: { op: "UiDialogs" }, kind: "UiDialogs", fallback: UI_TREE_FALLBACK, mutates: false };
  }
  const op: Record<string, unknown> = { op: "UiTree" };
  if (root !== undefined) op.root = root;
  if (finite(args.depth)) op.depth = clampInt(args.depth, 1, UI_TREE_MAX_DEPTH);
  if (finite(args.limit)) op.limit = clampInt(args.limit, 1, UI_TREE_MAX_LIMIT);
  if (typeof args.visible_only === "boolean") op.visible_only = args.visible_only;
  return { op, kind: "UiTree", fallback: UI_TREE_FALLBACK, mutates: false };
}

/** summer_ui_activate -> UiActivate | UiDismissDialog (action:"dismiss_dialog"). */
export function buildUiActivateOp(args: UiActivateArgs): BuiltUiOp {
  const action: UiActivateAction = args.action ?? "press";
  if (!UI_ACTIVATE_ACTIONS.includes(action)) {
    throw new ToolInputError(`action must be one of ${UI_ACTIVATE_ACTIONS.join(", ")}.`);
  }

  if (action === "dismiss_dialog") {
    const path = nonEmpty(args.path) ? args.path.trim() : undefined;
    const title = nonEmpty(args.title) ? args.title.trim() : undefined;
    if (!path && !title) {
      throw new ToolInputError(
        "action:'dismiss_dialog' needs a target: path (from summer_ui_tree root:'dialogs') or title. Nothing was sent."
      );
    }
    const op: Record<string, unknown> = { op: "UiDismissDialog" };
    if (path) op.path = path;
    if (title) op.title = title;
    if (nonEmpty(args.button)) op.button = args.button.trim();
    return { op, kind: "UiDismissDialog", fallback: UI_ACTIVATE_FALLBACK, mutates: true };
  }

  if (nonEmpty(args.title) || nonEmpty(args.button)) {
    throw new ToolInputError(
      `title and button belong to action:'dismiss_dialog' (got action:'${action}'). To close a dialog, call again with action:'dismiss_dialog'; otherwise pass the control's path.`
    );
  }
  if (!nonEmpty(args.path)) {
    throw new ToolInputError(
      `action:'${action}' requires path — a control path from summer_ui_tree (or 'main_screen' with select_tab). Nothing was sent.`
    );
  }
  const path = args.path.trim();
  const op: Record<string, unknown> = { op: "UiActivate", path, action };

  // `value` provided at all (an explicit "" is a legitimate set_text — clear
  // the field); `value` usable as a tab/title lookup (non-empty).
  const provided = args.value !== undefined && args.value !== null;
  const hasValue = provided && !(typeof args.value === "string" && args.value.length === 0);
  const hasIndex = finite(args.index);

  switch (action) {
    case "select_tab":
      if (!hasValue && !hasIndex) {
        throw new ToolInputError(
          "action:'select_tab' needs value (tab title, or the main-screen editor name such as '3D') or index. Nothing was sent."
        );
      }
      break;
    case "set_text":
      if (!provided) {
        throw new ToolInputError("action:'set_text' needs value (the text to set; '' clears the field). Nothing was sent.");
      }
      // The engine takes a String; a number is stringified rather than refused.
      op.value = String(args.value);
      if (typeof args.submit === "boolean") op.submit = args.submit;
      break;
    case "set_value": {
      const numeric = typeof args.value === "number" ? args.value : Number(args.value);
      if (!hasValue || !Number.isFinite(numeric)) {
        throw new ToolInputError(
          `action:'set_value' needs a finite number in value (got ${JSON.stringify(args.value)}). Nothing was sent.`
        );
      }
      op.value = numeric;
      break;
    }
    default:
      break;
  }

  if (action !== "set_text" && action !== "set_value" && hasValue) op.value = args.value;
  if (hasIndex) op.index = clampInt(args.index as number, 0, Number.MAX_SAFE_INTEGER);

  return { op, kind: "UiActivate", fallback: UI_ACTIVATE_FALLBACK, mutates: true };
}

/** summer_ui_screenshot -> UiScreenshot. */
export function buildUiScreenshotOp(args: UiScreenshotArgs): BuiltUiOp {
  const op: Record<string, unknown> = { op: "UiScreenshot" };
  if (nonEmpty(args.root)) op.root = args.root.trim();
  if (finite(args.max_size)) op.max_size = clampInt(args.max_size, UI_SCREENSHOT_MIN_SIZE, UI_SCREENSHOT_MAX_SIZE);
  return { op, kind: "UiScreenshot", fallback: UI_SCREENSHOT_FALLBACK, mutates: false };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** The slice of EngineApiClient the UI ops need; structural so tests pass mocks. */
export interface UiOpClient {
  executeOps(ops: Record<string, unknown>[], options?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  executeIdentityBoundOps(
    ops: Record<string, unknown>[],
    options?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<unknown>;
}

/** Send one built UI op: mutating ops identity-bound, reads plain. */
export function executeUiOp(client: UiOpClient, built: BuiltUiOp): Promise<unknown> {
  return built.mutates ? client.executeIdentityBoundOps([built.op]) : client.executeOps([built.op]);
}

// ---------------------------------------------------------------------------
// Failure rendering — the engine's per-op detail fields (close_matches,
// blocking_dialog, available_docks, ...) are what make a UI failure
// actionable, and extractOpError only carries error + failure_reason. Fold
// the details and the next step into the envelope's error string so both
// faces show them; failure_reason stays intact for programmatic callers.
// ---------------------------------------------------------------------------

type FailedUiOp = Record<string, unknown> & {
  ok?: boolean;
  op?: string;
  error?: string;
  failure_reason?: string;
  failureReason?: string;
};

function names(value: unknown, keys: string[] = ["name", "title", "text", "path"]): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") out.push(entry);
    else if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      const hit = keys.map((key) => record[key]).find((candidate) => typeof candidate === "string" && candidate.length > 0);
      if (typeof hit === "string") out.push(hit);
    }
  }
  return out;
}

function windowRef(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title : "";
  const cls = typeof record.class === "string" ? record.class : "";
  const path = typeof record.path === "string" ? record.path : "";
  return `'${title}'${cls ? ` (${cls}` : ""}${path ? `${cls ? ", " : " ("}path ${path}` : ""}${cls || path ? ")" : ""}`;
}

function list(label: string, items: string[]): string {
  return items.length ? ` ${label}: ${items.join(", ")}.` : "";
}

const MODAL_OPEN_HINT =
  "Read it with summer_ui_tree root:'dialogs', then clear it with summer_ui_activate action:'dismiss_dialog' (path from that result; button 'cancel' unless the user asked to confirm) and retry.";

/** Per-failure_reason: the detail fields to surface and the next step. */
const UI_FAILURE_HINTS: Record<string, (failed: FailedUiOp) => string> = {
  unknown_action: (f) =>
    `Unknown action.${list("Close matches", names(f.close_matches))} Find the exact name with summer_ui_actions mode:'list' filter:'<part of the name or label>' and invoke that.`,
  denied_action: (f) =>
    `Denied by the editor's safety list (quit, quit to project list, reload project, delete without confirmation, project-manager actions)${typeof f.reason === "string" && f.reason ? ` — ${f.reason}` : ""}. Do not retry it and do not route around it through summer_ui_activate: the same names and button labels are denied there. Tell the user what you were asked to do and let them do it.`,
  modal_open: (f) => `A modal dialog is blocking editor input: ${windowRef(f.blocking_dialog)}. ${MODAL_OPEN_HINT}`,
  not_handled: () =>
    "invoked:true but handled:false — the event was dispatched and no live receiver took it (the owning editor or plugin is hidden, or the context does not apply: spatial_editor/* needs the 3D main screen). Switch context first (summer_ui_activate path:'main_screen' action:'select_tab' value:'3D'), read back current_tab, then retry.",
  editor_unavailable: () =>
    "The editor UI is not available on this engine instance (no editor node — a headless worker or a game-only process). UI ops need the desktop editor.",
  unknown_root: (f) =>
    `Unknown root.${list("Docks", names(f.available_docks))}${list("Dock ids", names(f.dock_ids))} Use 'main', 'window', 'dock:<title|id>', 'dialog:<title>', 'path:<node path>', or 'dialogs'.`,
  not_found: (f) =>
    `Target not found.${list("Visible windows", names(f.visible_titles))} Paths and auto-names are stable within a session only — re-read summer_ui_tree (root:'dialogs' for windows) and use the path it returns now.`,
  ambiguous_dialog: (f) =>
    `More than one visible window matches.${list("Candidates", names(f.candidates))} Pass the exact title, or the path from summer_ui_tree root:'dialogs'.`,
  not_visible: () =>
    "The control exists but is hidden — it appears in summer_ui_tree visible_only:false and cannot be activated. Reveal its dock/tab first (summer_ui_actions or select_tab), re-read the tree, then retry.",
  disabled: () =>
    "The control is disabled. Read its state (enabled:false) with summer_ui_tree and satisfy the precondition the editor is waiting for before retrying.",
  unsupported_control: (f) =>
    `That control class is not driven by this action.${list("Supported here", names(f.supported_actions))} A MenuBar is reached by name through summer_ui_actions mode:'invoke', not by pressing it.`,
  unsupported_action: () =>
    `action must be one of ${UI_ACTIVATE_ACTIONS.join(", ")}; the engine refused this one for the control's class (see supported_actions in unsupported_control).`,
  obscured: (f) =>
    `Another control is on top of the target at its centre${typeof f.hit_control === "string" ? `: ${f.hit_control}` : ""}${typeof f.hit_class === "string" ? ` (${f.hit_class})` : ""}. Usually a dialog or popup — check summer_ui_tree root:'dialogs' and dismiss it, or activate the covering control instead.`,
  no_activation_path: () =>
    "Neither hover nor keyboard focus reached this button (multi-window editor with the pointer over another window, and the button takes no focus). Invoke the equivalent named action with summer_ui_actions mode:'invoke' instead.",
  denied_path: () =>
    "File-dialog paths that leave the project are refused ('..', user://, ~, or an absolute path outside the project root). Use a res:// path or a bare file name.",
  tab_not_found: (f) => `No such tab.${list("Tabs", names(f.tabs))} Pass one of those as value, or an index.`,
  index_out_of_range: (f) =>
    `index is out of range${finite(f.item_count) ? ` (item_count ${f.item_count})` : ""}. Re-read the control with summer_ui_tree root:'path:<path>' and use an index it lists.`,
  missing_value: () => "This action needs value (select_tab title, set_text text, set_value number) — pass it and retry.",
  not_selected: () =>
    "The main-screen switch was refused (a scene change is in progress, or that editor's button is hidden). Wait a moment, retry, and read back state.current_tab — never assume the switch happened.",
  button_not_found: (f) =>
    `No such button in the dialog's row.${list("Buttons", names(f.buttons))} Pass 'ok', 'cancel', or one of those texts.`,
  missing_target: () => "Pass path (from summer_ui_tree root:'dialogs') or title to name the dialog.",
  no_renderer: () =>
    "This editor has no renderer (headless / dummy rendering driver), so no pixels exist to capture — nothing was drawn. Use summer_ui_tree for the structured view of the same UI; real pixels need the editor under a display (Linux: --xvfb).",
  texture_unavailable: () =>
    "The root viewport texture could not be read this frame. Retry once; if it persists, use summer_ui_tree for the structured view.",
  zero_size: () => "The target has a zero-sized rect (collapsed or not laid out yet). Screenshot root:'window' or read it with summer_ui_tree.",
  native_subwindow: () =>
    "That window is a native OS sub-window; the root viewport texture does not contain it. Screenshot root:'window' for the main editor, or read the dialog with summer_ui_tree root:'dialog:<title>'.",
  encode_failed: () => "PNG encoding failed on the engine side. Retry with a smaller max_size.",
};

/**
 * Fold the failed op's detail fields and the next step into the envelope's
 * error string. Leaves non-UI failures, successes, and old-engine "unknown
 * op" answers untouched (withOldEngineHint owns those).
 */
export function withUiFailureDetails(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const envelope = result as Record<string, unknown> & { results?: FailedUiOp[] };
  const failed = envelope.results?.find((entry) => entry && entry.ok === false);
  const reason =
    (typeof envelope.failure_reason === "string" && envelope.failure_reason) ||
    (typeof envelope.failureReason === "string" && envelope.failureReason) ||
    failed?.failure_reason ||
    failed?.failureReason;
  if (typeof reason !== "string") return result;
  const render = UI_FAILURE_HINTS[reason];
  if (!render) return result;
  const engineError =
    (typeof failed?.error === "string" && failed.error) ||
    (typeof envelope.error === "string" && envelope.error) ||
    reason;
  if (/unknown op/i.test(engineError)) return result;
  const detail = failed ?? {};
  return { ...envelope, error: `${render(detail)} Engine said: ${engineError}` };
}

// ---------------------------------------------------------------------------
// Screenshot receipt
// ---------------------------------------------------------------------------

export interface UiScreenshotImage {
  base64: string;
  mime: string;
  width?: number;
  height?: number;
  bytes?: number;
  scale?: number;
  root?: string;
  root_path?: string;
  renderer?: string;
  display_server?: string;
  source_rect?: { x?: number; y?: number; w?: number; h?: number };
  /** The op result minus the image payload — safe to print or log. */
  receipt: Record<string, unknown>;
}

/**
 * Pull the PNG out of a successful UiScreenshot envelope. Returns null when
 * the result carries no image (callers fall back to text — never emit a
 * broken image block).
 */
export function uiScreenshotImage(result: unknown): UiScreenshotImage | null {
  if (!result || typeof result !== "object") return null;
  const envelope = result as { results?: Array<Record<string, unknown>> };
  const entry = envelope.results?.find((candidate) => candidate && candidate.op === "UiScreenshot") ?? envelope.results?.[0];
  if (!entry || typeof entry.image_base64 !== "string" || entry.image_base64.length === 0) return null;
  const { image_base64, ...receipt } = entry;
  const num = (value: unknown): number | undefined => (finite(value) ? value : undefined);
  return {
    base64: image_base64,
    mime: typeof entry.mime === "string" && entry.mime ? entry.mime : "image/png",
    width: num(entry.width),
    height: num(entry.height),
    bytes: num(entry.bytes),
    scale: num(entry.scale),
    root: typeof entry.root === "string" ? entry.root : undefined,
    root_path: typeof entry.root_path === "string" ? entry.root_path : undefined,
    renderer: typeof entry.renderer === "string" ? entry.renderer : undefined,
    display_server: typeof entry.display_server === "string" ? entry.display_server : undefined,
    source_rect:
      entry.source_rect && typeof entry.source_rect === "object"
        ? (entry.source_rect as UiScreenshotImage["source_rect"])
        : undefined,
    receipt,
  };
}

/** The one-line caption both faces print under a captured frame. */
export function uiScreenshotCaption(image: UiScreenshotImage): string {
  const dims = image.width && image.height ? `${image.width}x${image.height} px` : "unknown size";
  const parts = [
    `root '${image.root ?? "window"}'${image.root_path ? ` (${image.root_path})` : ""}`,
    dims,
    image.scale !== undefined && image.scale !== 1 ? `scale ${image.scale}` : null,
    image.source_rect
      ? `source rect ${image.source_rect.x ?? 0},${image.source_rect.y ?? 0} ${image.source_rect.w ?? "?"}x${image.source_rect.h ?? "?"}`
      : null,
    image.renderer ? `renderer ${image.renderer}` : null,
  ].filter((part): part is string => typeof part === "string" && part.length > 0);
  return (
    `Editor UI screenshot — ${parts.join(", ")}. Captured from the editor's root viewport texture, never the OS screen. ` +
    "Review the image above and describe what you actually see. Pixels prove appearance only: for a control's exact state (checked, current_tab, text, enabled) read summer_ui_tree — and when a scene looks wrong, fix it with the scene tools, not by clicking."
  );
}
