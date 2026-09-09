import { describe, expect, it } from "vitest";
import { ToolInputError } from "../tool-errors.js";
import {
  UI_ACTIVATE_ACTIONS,
  UI_DENIED_ACTIONS,
  UI_LIST_ACTIONS_MAX_LIMIT,
  UI_SCREENSHOT_MAX_SIZE,
  UI_SCREENSHOT_MIN_SIZE,
  UI_TREE_MAX_DEPTH,
  UI_TREE_MAX_LIMIT,
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
} from "./ui-control.js";

describe("buildUiActionsOp", () => {
  it("mode:list -> UiListActions with only the provided params, limit clamped to the engine ceiling", () => {
    expect(buildUiActionsOp({ mode: "list" })).toEqual({
      op: { op: "UiListActions" },
      kind: "UiListActions",
      fallback: expect.stringContaining("summer_project_setting"),
      mutates: false,
    });
    const filtered = buildUiActionsOp({ mode: "list", filter: " project ", limit: 99_999 });
    expect(filtered.op).toEqual({ op: "UiListActions", filter: "project", limit: UI_LIST_ACTIONS_MAX_LIMIT });
    expect(buildUiActionsOp({ mode: "list", limit: 0 }).op.limit).toBe(1);
  });

  it("mode:invoke -> UiInvoke (mutates) with the trimmed action name", () => {
    const built = buildUiActionsOp({ mode: "invoke", action_name: " editor/project_settings " });
    expect(built).toMatchObject({
      op: { op: "UiInvoke", action: "editor/project_settings" },
      kind: "UiInvoke",
      mutates: true,
    });
  });

  it("refuses the wrong-mode argument mixes BEFORE anything is sent", () => {
    expect(() => buildUiActionsOp({ mode: "invoke" })).toThrow(ToolInputError);
    expect(() => buildUiActionsOp({ mode: "invoke" })).toThrow(/requires action_name/);
    expect(() => buildUiActionsOp({ mode: "invoke", action_name: "editor/save_scene", filter: "x" })).toThrow(
      /does not take filter or limit/
    );
    expect(() => buildUiActionsOp({ mode: "list", action_name: "editor/save_scene" })).toThrow(
      /did you mean|mode:'invoke'/
    );
  });
});

describe("buildUiTreeOp", () => {
  it("defaults to UiTree with no params — the engine owns the defaults (main, depth 4, limit 500, visible_only)", () => {
    expect(buildUiTreeOp({})).toEqual({
      op: { op: "UiTree" },
      kind: "UiTree",
      fallback: expect.stringContaining("summer_get_scene_tree"),
      mutates: false,
    });
  });

  it("passes the root grammar through and clamps depth/limit", () => {
    const built = buildUiTreeOp({ root: "dock:inspector", depth: 100, limit: 1, visible_only: false });
    expect(built.op).toEqual({
      op: "UiTree",
      root: "dock:inspector",
      depth: UI_TREE_MAX_DEPTH,
      limit: 1,
      visible_only: false,
    });
    expect(buildUiTreeOp({ limit: 10 ** 9 }).op.limit).toBe(UI_TREE_MAX_LIMIT);
  });

  it("root:'dialogs' (any case) becomes a UiDialogs read and drops the tree-only filters", () => {
    expect(buildUiTreeOp({ root: "Dialogs", depth: 2, limit: 7 })).toEqual({
      op: { op: "UiDialogs" },
      kind: "UiDialogs",
      fallback: expect.any(String),
      mutates: false,
    });
    // 'dialog:<title>' is still a tree root — the sentinel is exactly 'dialogs'.
    expect(buildUiTreeOp({ root: "dialog:Project Settings" }).op).toEqual({ op: "UiTree", root: "dialog:Project Settings" });
  });
});

describe("buildUiActivateOp", () => {
  it("press is the default and travels identity-bound", () => {
    expect(buildUiActivateOp({ path: "@Panel@12/Button" })).toEqual({
      op: { op: "UiActivate", path: "@Panel@12/Button", action: "press" },
      kind: "UiActivate",
      fallback: expect.stringContaining("summer_run_editor_script"),
      mutates: true,
    });
  });

  it("select_tab on main_screen accepts a value or an index", () => {
    expect(buildUiActivateOp({ path: "main_screen", action: "select_tab", value: "3D" }).op).toEqual({
      op: "UiActivate",
      path: "main_screen",
      action: "select_tab",
      value: "3D",
    });
    expect(buildUiActivateOp({ path: "main_screen", action: "select_tab", index: 1 }).op).toEqual({
      op: "UiActivate",
      path: "main_screen",
      action: "select_tab",
      index: 1,
    });
    expect(() => buildUiActivateOp({ path: "main_screen", action: "select_tab" })).toThrow(/needs value/);
  });

  it("set_text stringifies value, allows '' to clear, and forwards submit", () => {
    expect(buildUiActivateOp({ path: "Search", action: "set_text", value: "player", submit: true }).op).toEqual({
      op: "UiActivate",
      path: "Search",
      action: "set_text",
      value: "player",
      submit: true,
    });
    expect(buildUiActivateOp({ path: "Search", action: "set_text", value: "" }).op.value).toBe("");
    expect(buildUiActivateOp({ path: "Search", action: "set_text", value: 12 }).op.value).toBe("12");
    expect(() => buildUiActivateOp({ path: "Search", action: "set_text" })).toThrow(/needs value/);
  });

  it("set_value coerces a numeric string and refuses anything non-finite", () => {
    expect(buildUiActivateOp({ path: "Spin", action: "set_value", value: "0.5" }).op.value).toBe(0.5);
    expect(buildUiActivateOp({ path: "Spin", action: "set_value", value: 3 }).op.value).toBe(3);
    expect(() => buildUiActivateOp({ path: "Spin", action: "set_value", value: "half" })).toThrow(/finite number/);
    expect(() => buildUiActivateOp({ path: "Spin", action: "set_value" })).toThrow(/finite number/);
  });

  it("dismiss_dialog -> UiDismissDialog by path or title, button passthrough (engine default cancel)", () => {
    expect(buildUiActivateOp({ action: "dismiss_dialog", title: "Project Settings" })).toEqual({
      op: { op: "UiDismissDialog", title: "Project Settings" },
      kind: "UiDismissDialog",
      fallback: expect.any(String),
      mutates: true,
    });
    expect(buildUiActivateOp({ action: "dismiss_dialog", path: "@ConfirmationDialog@44", button: "ok" }).op).toEqual({
      op: "UiDismissDialog",
      path: "@ConfirmationDialog@44",
      button: "ok",
    });
    expect(() => buildUiActivateOp({ action: "dismiss_dialog" })).toThrow(/needs a target/);
  });

  it("refuses a missing path and dismiss-only arguments on other actions", () => {
    expect(() => buildUiActivateOp({ action: "toggle" })).toThrow(/requires path/);
    expect(() => buildUiActivateOp({ path: "x", action: "press", title: "Save" })).toThrow(/belong to action:'dismiss_dialog'/);
    expect(() => buildUiActivateOp({ path: "x", button: "ok" })).toThrow(/belong to action:'dismiss_dialog'/);
  });

  it("names every action the engine contract supports, dismiss_dialog included", () => {
    expect([...UI_ACTIVATE_ACTIONS]).toEqual(["press", "toggle", "focus", "select_tab", "set_text", "set_value", "dismiss_dialog"]);
  });
});

describe("buildUiScreenshotOp", () => {
  it("defaults to the engine's window/1024 and clamps max_size to 16..4096", () => {
    expect(buildUiScreenshotOp({})).toEqual({
      op: { op: "UiScreenshot" },
      kind: "UiScreenshot",
      fallback: expect.stringContaining("summer_screenshot"),
      mutates: false,
    });
    expect(buildUiScreenshotOp({ root: "dock:inspector", max_size: 4 }).op).toEqual({
      op: "UiScreenshot",
      root: "dock:inspector",
      max_size: UI_SCREENSHOT_MIN_SIZE,
    });
    expect(buildUiScreenshotOp({ max_size: 99_999 }).op.max_size).toBe(UI_SCREENSHOT_MAX_SIZE);
  });
});

describe("executeUiOp", () => {
  it("sends mutating kinds identity-bound and reads plain", async () => {
    const calls: string[] = [];
    const client = {
      executeOps: async () => {
        calls.push("executeOps");
        return { ok: true };
      },
      executeIdentityBoundOps: async () => {
        calls.push("executeIdentityBoundOps");
        return { ok: true };
      },
    };
    await executeUiOp(client, buildUiTreeOp({}));
    await executeUiOp(client, buildUiActionsOp({ mode: "list" }));
    await executeUiOp(client, buildUiScreenshotOp({}));
    await executeUiOp(client, buildUiActionsOp({ mode: "invoke", action_name: "editor/save_scene" }));
    await executeUiOp(client, buildUiActivateOp({ path: "x" }));
    await executeUiOp(client, buildUiActivateOp({ action: "dismiss_dialog", title: "x" }));
    expect(calls).toEqual([
      "executeOps",
      "executeOps",
      "executeOps",
      "executeIdentityBoundOps",
      "executeIdentityBoundOps",
      "executeIdentityBoundOps",
    ]);
  });
});

describe("withUiFailureDetails", () => {
  const failed = (entry: Record<string, unknown>) => ({ ok: false, results: [{ ok: false, ...entry }] });

  it("renders unknown_action with its close_matches and the list-first next step", () => {
    const out = withUiFailureDetails(
      failed({ op: "UiInvoke", failure_reason: "unknown_action", error: "unknown action 'editor/projct_settings'", close_matches: ["editor/project_settings", "editor/settings"] })
    ) as { error: string; results: unknown[] };
    expect(out.error).toContain("Close matches: editor/project_settings, editor/settings");
    expect(out.error).toContain("summer_ui_actions mode:'list'");
    expect(out.error).toContain("Engine said: unknown action 'editor/projct_settings'");
    expect(out.results).toHaveLength(1); // the per-op detail is preserved for programmatic callers
  });

  it("renders denied_action as a stop, with the engine's reason and no workaround", () => {
    const out = withUiFailureDetails(
      failed({ op: "UiInvoke", failure_reason: "denied_action", error: "denied", reason: "editor/file_quit ends the editor session" })
    ) as { error: string };
    expect(out.error).toContain("editor/file_quit ends the editor session");
    expect(out.error).toContain("Do not retry it");
    expect(out.error).toContain("summer_ui_activate");
  });

  it("renders modal_open with the blocking dialog and the dialogs -> dismiss -> retry recipe", () => {
    const out = withUiFailureDetails(
      failed({
        op: "UiActivate",
        failure_reason: "modal_open",
        error: "blocked by the exclusive dialog 'Project Settings'",
        blocking_dialog: { title: "Project Settings", path: "@ProjectSettingsEditor@77", class: "ProjectSettingsEditor" },
      })
    ) as { error: string };
    expect(out.error).toContain("'Project Settings' (ProjectSettingsEditor, path @ProjectSettingsEditor@77)");
    expect(out.error).toContain("summer_ui_tree root:'dialogs'");
    expect(out.error).toContain("action:'dismiss_dialog'");
  });

  it("renders the list-bearing failures with their lists (docks, titles, candidates, tabs, buttons, supported actions)", () => {
    const render = (entry: Record<string, unknown>) => (withUiFailureDetails(failed(entry)) as { error: string }).error;
    expect(render({ failure_reason: "unknown_root", error: "x", available_docks: ["Inspector", "FileSystem"], dock_ids: ["inspector", "file_system"] })).toContain(
      "Docks: Inspector, FileSystem. Dock ids: inspector, file_system."
    );
    expect(render({ failure_reason: "not_found", error: "x", visible_titles: ["Project Settings"] })).toContain("Visible windows: Project Settings");
    expect(render({ failure_reason: "ambiguous_dialog", error: "x", candidates: [{ title: "Save", path: "a" }, { title: "Save As", path: "b" }] })).toContain(
      "Candidates: Save, Save As"
    );
    expect(render({ failure_reason: "tab_not_found", error: "x", tabs: ["2D", "3D"] })).toContain("Tabs: 2D, 3D");
    expect(render({ failure_reason: "button_not_found", error: "x", buttons: [{ text: "OK", kind: "ok" }, { text: "Cancel", kind: "cancel" }] })).toContain(
      "Buttons: OK, Cancel"
    );
    expect(render({ failure_reason: "unsupported_control", error: "x", supported_actions: ["focus"] })).toContain("Supported here: focus");
    expect(render({ failure_reason: "obscured", error: "x", hit_control: "@Popup@9/Panel", hit_class: "PanelContainer" })).toContain(
      "@Popup@9/Panel (PanelContainer)"
    );
  });

  it("renders no_renderer as the honest headless answer pointing at summer_ui_tree", () => {
    const out = withUiFailureDetails(failed({ op: "UiScreenshot", failure_reason: "no_renderer", error: "no renderer: dummy RenderingServer" })) as {
      error: string;
    };
    expect(out.error).toContain("no pixels exist");
    expect(out.error).toContain("summer_ui_tree");
    expect(out.error).toContain("Engine said: no renderer: dummy RenderingServer");
  });

  it("leaves successes, unrelated failures, and old-engine unknown-op answers untouched", () => {
    const success = { ok: true, results: [{ ok: true, op: "UiTree" }] };
    expect(withUiFailureDetails(success)).toBe(success);
    const other = failed({ op: "UiInvoke", failure_reason: "identity_mismatch", error: "wrong project" });
    expect(withUiFailureDetails(other)).toBe(other);
    const unknownOp = failed({ op: "UiInvoke", failure_reason: "unknown_action", error: "unknown op: UiInvoke" });
    expect(withUiFailureDetails(unknownOp)).toBe(unknownOp);
    expect(withUiFailureDetails(null)).toBeNull();
  });
});

describe("uiScreenshotImage / uiScreenshotCaption", () => {
  const png = Buffer.from("not really a png").toString("base64");

  it("extracts the frame and a receipt without the payload", () => {
    const image = uiScreenshotImage({
      ok: true,
      results: [
        {
          ok: true,
          op: "UiScreenshot",
          image_base64: png,
          mime: "image/png",
          width: 800,
          height: 600,
          bytes: 1234,
          scale: 0.5,
          root: "dock:inspector",
          root_path: "@Panel@3/Inspector",
          renderer: "forward_plus",
          source_rect: { x: 10, y: 20, w: 1600, h: 1200 },
        },
      ],
    });
    expect(image).not.toBeNull();
    expect(image!.base64).toBe(png);
    expect(image!.receipt).not.toHaveProperty("image_base64");
    expect(image!.receipt).toMatchObject({ width: 800, height: 600, root: "dock:inspector" });
    const caption = uiScreenshotCaption(image!);
    expect(caption).toContain("root 'dock:inspector' (@Panel@3/Inspector)");
    expect(caption).toContain("800x600 px");
    expect(caption).toContain("scale 0.5");
    expect(caption).toContain("source rect 10,20 1600x1200");
    expect(caption).toContain("never the OS screen");
    expect(caption).toContain("summer_ui_tree");
  });

  it("returns null when a success carries no bytes", () => {
    expect(uiScreenshotImage({ ok: true, results: [{ ok: true, op: "UiScreenshot" }] })).toBeNull();
    expect(uiScreenshotImage({ ok: true, results: [] })).toBeNull();
    expect(uiScreenshotImage(undefined)).toBeNull();
  });
});

describe("shared zod contracts", () => {
  it("accept the full documented surface", () => {
    expect(uiActionsArgsSchema.safeParse({ mode: "list", filter: "save", limit: 50 }).success).toBe(true);
    expect(uiActionsArgsSchema.safeParse({ mode: "invoke", action_name: "editor/save_scene" }).success).toBe(true);
    expect(uiTreeArgsSchema.safeParse({ root: "dialogs" }).success).toBe(true);
    expect(uiTreeArgsSchema.safeParse({ root: "dock:inspector", depth: 6, limit: 1000, visible_only: false }).success).toBe(true);
    expect(
      uiActivateArgsSchema.safeParse({ path: "main_screen", action: "select_tab", value: "3D", index: 0, submit: false }).success
    ).toBe(true);
    expect(uiActivateArgsSchema.safeParse({ action: "dismiss_dialog", title: "Project Settings", button: "cancel" }).success).toBe(true);
    expect(uiActivateArgsSchema.safeParse({ path: "Spin", action: "set_value", value: 0.25 }).success).toBe(true);
    expect(uiScreenshotArgsSchema.safeParse({ root: "window", max_size: 512 }).success).toBe(true);
  });

  it("reject the shapes the descriptor forbids (mode enum, negative index, fractional limits, unknown actions)", () => {
    expect(uiActionsArgsSchema.safeParse({}).success).toBe(false);
    expect(uiActionsArgsSchema.safeParse({ mode: "run" }).success).toBe(false);
    expect(uiActionsArgsSchema.safeParse({ mode: "list", limit: 2.5 }).success).toBe(false);
    expect(uiTreeArgsSchema.safeParse({ depth: 0 }).success).toBe(false);
    expect(uiActivateArgsSchema.safeParse({ path: "x", action: "click" }).success).toBe(false);
    expect(uiActivateArgsSchema.safeParse({ path: "x", index: -1 }).success).toBe(false);
    expect(uiScreenshotArgsSchema.safeParse({ max_size: 100.5 }).success).toBe(false);
  });
});

describe("deny-list mirror (documentation only, engine enforces)", () => {
  it("names the frozen contract's denied actions", () => {
    expect(UI_DENIED_ACTIONS).toEqual([
      "editor/file_quit",
      "editor/quit_to_project_list",
      "editor/reload_current_project",
      "scene_tree/delete_no_confirm",
      "project_manager/*",
    ]);
  });
});
