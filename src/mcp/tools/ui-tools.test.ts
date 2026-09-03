import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../server.js", () => ({
  getClient: vi.fn(),
  resetClient: vi.fn(),
}));

vi.mock("../../core/telemetry.js", () => ({
  recordMcpSession: vi.fn(),
}));

import { getClient } from "../server.js";
import { registerUiTools } from "./ui-tools.js";

type RegisteredTool = {
  name: string;
  description: string;
  shape: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

type Content = Array<{ type: string; text?: string; data?: string; mimeType?: string }>;

function tools(): RegisteredTool[] {
  const registered: RegisteredTool[] = [];
  registerUiTools({
    tool(
      name: string,
      description: string,
      shape: Record<string, unknown>,
      handler: (args: Record<string, unknown>) => Promise<unknown>
    ) {
      registered.push({ name, description, shape, handler });
      return { name };
    },
  } as never);
  return registered;
}

function tool(name: string): RegisteredTool {
  const found = tools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

function text(result: unknown): string {
  const envelope = result as { content?: Content };
  return envelope.content?.find((entry) => entry.type === "text")?.text ?? "";
}

function content(result: unknown): Content {
  return (result as { content?: Content }).content ?? [];
}

function isError(result: unknown): boolean | undefined {
  return (result as { isError?: boolean }).isError;
}

/** A client mock: `advertised` = the engine's opKinds advert (omit = no advert). */
function engine(overrides: Record<string, unknown> = {}, advertised?: string[]) {
  const client: Record<string, unknown> = {
    executeOps: vi.fn().mockResolvedValue({ ok: true, results: [{ ok: true }] }),
    executeIdentityBoundOps: vi.fn().mockResolvedValue({ ok: true, results: [{ ok: true }] }),
    ...overrides,
  };
  if (advertised) {
    client.getEngineCapabilities = () => ({ opKinds: advertised });
    client.getEngineVersion = () => "0.5.65";
  }
  vi.mocked(getClient).mockResolvedValue(client as never);
  // Return the spies the client actually carries (an override replaces the default).
  return {
    executeOps: client.executeOps as ReturnType<typeof vi.fn>,
    executeIdentityBoundOps: client.executeIdentityBoundOps as ReturnType<typeof vi.fn>,
  };
}

const failed = (entry: Record<string, unknown>) => ({ ok: false, results: [{ ok: false, ...entry }] });

afterEach(() => {
  vi.clearAllMocks();
});

describe("registration", () => {
  it("registers the four UI tools with exactly the op parameter surfaces", () => {
    const byName = new Map(tools().map((t) => [t.name, t]));
    expect([...byName.keys()]).toEqual(["summer_ui_actions", "summer_ui_tree", "summer_ui_activate", "summer_ui_screenshot"]);
    expect(Object.keys(byName.get("summer_ui_actions")!.shape).sort()).toEqual(["action_name", "filter", "limit", "mode"]);
    expect(Object.keys(byName.get("summer_ui_tree")!.shape).sort()).toEqual(["depth", "limit", "root", "visible_only"]);
    expect(Object.keys(byName.get("summer_ui_activate")!.shape).sort()).toEqual(
      ["action", "button", "index", "path", "submit", "title", "value"].sort()
    );
    expect(Object.keys(byName.get("summer_ui_screenshot")!.shape).sort()).toEqual(["max_size", "root"]);
  });

  it("every description teaches the doctrine: semantic-first, scene work elsewhere, deny-list, pixels last, engine_lacks_op", () => {
    for (const t of tools()) {
      expect(t.description, `${t.name} names the scene-scripting route`).toMatch(/summer_run_script|scene tools/);
      expect(t.description, `${t.name} confesses engine_lacks_op`).toContain("engine_lacks_op");
      expect(t.description, `${t.name} is labelled preview`).toContain("preview");
    }
    const actions = tool("summer_ui_actions").description;
    for (const phrase of ["editor/file_quit", "denied_action", "modal_open", "close_matches", "not_handled", "summer_ui_tree root:'dialogs'"]) {
      expect(actions, phrase).toContain(phrase);
    }
    const activate = tool("summer_ui_activate").description;
    for (const phrase of ["dismiss_dialog", "main_screen", "visible_after", "READ BACK", "no coordinate click", "denied_action"]) {
      expect(activate, phrase).toContain(phrase);
    }
    const tree = tool("summer_ui_tree").description;
    for (const phrase of ["root:'dialogs'", "blocking", "summer_get_scene_tree", "summer_ui_activate"]) {
      expect(tree, phrase).toContain(phrase);
    }
    const screenshot = tool("summer_ui_screenshot").description;
    for (const phrase of ["PIXELS-LAST", "no_renderer", "summer_screenshot", "never to pick click coordinates", "no_os_screen_capture"]) {
      expect(screenshot, phrase).toContain(phrase);
    }
  });
});

describe("summer_ui_actions", () => {
  it("mode:'list' sends one plain UiListActions op with the clamped limit and returns the engine's list", async () => {
    const { executeOps, executeIdentityBoundOps } = engine({
      executeOps: vi.fn().mockResolvedValue({
        ok: true,
        results: [
          {
            ok: true,
            op: "UiListActions",
            actions: [{ name: "editor/project_settings", label: "Project Settings", shortcut_text: "", category: "editor", source: "shortcut" }],
            total: 1,
            truncated: false,
          },
        ],
      }),
    });
    const result = await tool("summer_ui_actions").handler({ mode: "list", filter: "project", limit: 5000 });
    expect(isError(result)).toBeUndefined();
    expect(executeOps).toHaveBeenCalledWith([{ op: "UiListActions", filter: "project", limit: 2000 }]);
    expect(executeIdentityBoundOps).not.toHaveBeenCalled();
    expect(text(result)).toContain("editor/project_settings");
  });

  it("mode:'invoke' sends one identity-bound UiInvoke op and passes the invoke receipt through", async () => {
    const { executeOps, executeIdentityBoundOps } = engine({
      executeIdentityBoundOps: vi.fn().mockResolvedValue({
        ok: true,
        results: [
          {
            ok: true,
            op: "UiInvoke",
            action: "editor/project_settings",
            invoked: true,
            handled: true,
            via: "shortcut_event",
            opened_dialog: { title: "Project Settings", path: "@ProjectSettingsEditor@77", class: "ProjectSettingsEditor" },
            mutates: true,
          },
        ],
      }),
    });
    const result = await tool("summer_ui_actions").handler({ mode: "invoke", action_name: "editor/project_settings" });
    expect(isError(result)).toBeUndefined();
    expect(executeIdentityBoundOps).toHaveBeenCalledWith([{ op: "UiInvoke", action: "editor/project_settings" }]);
    expect(executeOps).not.toHaveBeenCalled();
    expect(text(result)).toContain('"opened_dialog"');
    expect(text(result)).toContain('"mutates": true');
  });

  it("mode:'invoke' without action_name is invalid_input with sent:false — nothing reaches the engine", async () => {
    const { executeOps, executeIdentityBoundOps } = engine();
    const result = await tool("summer_ui_actions").handler({ mode: "invoke" });
    expect(isError(result)).toBe(true);
    expect(executeOps).not.toHaveBeenCalled();
    expect(executeIdentityBoundOps).not.toHaveBeenCalled();
    expect(text(result)).toContain("invalid_input");
    expect(text(result)).toContain('"sent": false');
    expect(text(result)).toContain("requires action_name");
  });

  it("pre-flights the op kind the MODE resolved to: an advert with UiListActions but not UiInvoke lists fine and refuses invoke", async () => {
    const { executeOps, executeIdentityBoundOps } = engine({}, ["AddNode", "UiListActions"]);
    const listed = await tool("summer_ui_actions").handler({ mode: "list" });
    expect(isError(listed)).toBeUndefined();
    expect(executeOps).toHaveBeenCalledTimes(1);

    const invoked = await tool("summer_ui_actions").handler({ mode: "invoke", action_name: "editor/save_scene" });
    expect(isError(invoked)).toBe(true);
    expect(executeIdentityBoundOps).not.toHaveBeenCalled();
    const body = text(invoked);
    expect(body).toContain("engine_lacks_op");
    expect(body).toContain("UiInvoke");
    expect(body).toContain("0.5.65");
    expect(body).toContain("nothing was sent");
    expect(body).toContain("summer_project_setting");
  });

  it("refuses BEFORE sending when the advert lacks UiListActions", async () => {
    const { executeOps } = engine({}, ["AddNode", "RunSceneScript"]);
    const result = await tool("summer_ui_actions").handler({ mode: "list" });
    expect(isError(result)).toBe(true);
    expect(executeOps).not.toHaveBeenCalled();
    expect(text(result)).toContain("does not support the UiListActions op");
  });

  it("renders unknown_action with close_matches (passthrough of the engine's detail fields)", async () => {
    engine({
      executeIdentityBoundOps: vi.fn().mockResolvedValue(
        failed({
          op: "UiInvoke",
          failure_reason: "unknown_action",
          error: "unknown action 'editor/projct_settings'",
          close_matches: ["editor/project_settings"],
        })
      ),
    });
    const result = await tool("summer_ui_actions").handler({ mode: "invoke", action_name: "editor/projct_settings" });
    expect(isError(result)).toBe(true);
    const body = text(result);
    expect(body).toContain('"failure_reason": "unknown_action"');
    expect(body).toContain("Close matches: editor/project_settings");
    expect(body).toContain("mode:'list'");
  });

  it("renders denied_action as a stop — the engine's reason, no retry, no workaround", async () => {
    engine({
      executeIdentityBoundOps: vi.fn().mockResolvedValue(
        failed({
          op: "UiInvoke",
          failure_reason: "denied_action",
          error: "denied: editor/file_quit",
          reason: "editor/file_quit ends the editor session the agent is talking over",
        })
      ),
    });
    const result = await tool("summer_ui_actions").handler({ mode: "invoke", action_name: "editor/file_quit" });
    expect(isError(result)).toBe(true);
    const body = text(result);
    expect(body).toContain('"failure_reason": "denied_action"');
    expect(body).toContain("ends the editor session");
    expect(body).toContain("Do not retry it");
    expect(body).not.toContain("may have partially applied");
  });

  it("renders modal_open with the blocking dialog and the dialogs -> dismiss_dialog -> retry recipe", async () => {
    engine({
      executeIdentityBoundOps: vi.fn().mockResolvedValue(
        failed({
          op: "UiInvoke",
          failure_reason: "modal_open",
          error: "the exclusive dialog 'Project Settings' is blocking editor input; dismiss it first (UiDismissDialog)",
          blocking_dialog: { title: "Project Settings", path: "@ProjectSettingsEditor@77", class: "ProjectSettingsEditor" },
        })
      ),
    });
    const result = await tool("summer_ui_actions").handler({ mode: "invoke", action_name: "editor/save_scene" });
    expect(isError(result)).toBe(true);
    const body = text(result);
    expect(body).toContain('"failure_reason": "modal_open"');
    expect(body).toContain("'Project Settings' (ProjectSettingsEditor, path @ProjectSettingsEditor@77)");
    expect(body).toContain("summer_ui_tree root:'dialogs'");
    expect(body).toContain("action:'dismiss_dialog'");
  });

  it("renders not_handled with the switch-context hint", async () => {
    engine({
      executeIdentityBoundOps: vi.fn().mockResolvedValue(
        failed({ op: "UiInvoke", failure_reason: "not_handled", error: "'spatial_editor/focus_selection' was dispatched but no live receiver accepted it", invoked: true, handled: false })
      ),
    });
    const result = await tool("summer_ui_actions").handler({ mode: "invoke", action_name: "spatial_editor/focus_selection" });
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("path:'main_screen' action:'select_tab' value:'3D'");
  });

  it("maps an old engine's unknown-op answer (no capability advert) to the engine-too-old hint", async () => {
    engine({
      executeOps: vi.fn().mockResolvedValue(failed({ op: "UiListActions", error: "unknown op: UiListActions" })),
    });
    const result = await tool("summer_ui_actions").handler({ mode: "list" });
    expect(isError(result)).toBe(true);
    const body = text(result);
    expect(body).toContain("doesn't support UiListActions yet");
    expect(body).toContain("engine_lacks_op");
    expect(body).toContain("unknown op: UiListActions");
  });
});

describe("summer_ui_tree", () => {
  it("sends UiTree with the provided params (clamped) as a plain read", async () => {
    const { executeOps } = engine();
    const result = await tool("summer_ui_tree").handler({ root: "dock:inspector", depth: 99, limit: 20, visible_only: false });
    expect(isError(result)).toBeUndefined();
    expect(executeOps).toHaveBeenCalledWith([{ op: "UiTree", root: "dock:inspector", depth: 32, limit: 20, visible_only: false }]);
  });

  it("root:'dialogs' sends UiDialogs and returns the blocking flag verbatim", async () => {
    const { executeOps } = engine({
      executeOps: vi.fn().mockResolvedValue({
        ok: true,
        results: [
          {
            ok: true,
            op: "UiDialogs",
            count: 1,
            blocking: true,
            blocking_dialog: { title: "Project Settings", path: "@ProjectSettingsEditor@77", class: "ProjectSettingsEditor" },
            dialogs: [{ title: "Project Settings", path: "@ProjectSettingsEditor@77", kind: "accept_dialog", buttons: [{ text: "Close", kind: "ok", enabled: true }] }],
          },
        ],
      }),
    });
    const result = await tool("summer_ui_tree").handler({ root: "dialogs" });
    expect(isError(result)).toBeUndefined();
    expect(executeOps).toHaveBeenCalledWith([{ op: "UiDialogs" }]);
    expect(text(result)).toContain('"blocking": true');
  });

  it("pre-flights UiDialogs separately from UiTree", async () => {
    const { executeOps } = engine({}, ["UiTree"]);
    expect(isError(await tool("summer_ui_tree").handler({}))).toBeUndefined();
    const dialogs = await tool("summer_ui_tree").handler({ root: "dialogs" });
    expect(isError(dialogs)).toBe(true);
    expect(text(dialogs)).toContain("does not support the UiDialogs op");
    expect(executeOps).toHaveBeenCalledTimes(1);
  });

  it("renders unknown_root with the available docks", async () => {
    engine({
      executeOps: vi.fn().mockResolvedValue(
        failed({ op: "UiTree", failure_reason: "unknown_root", error: "unknown root 'dock:animations'", available_docks: ["Animation", "Inspector"], dock_ids: ["inspector"] })
      ),
    });
    const result = await tool("summer_ui_tree").handler({ root: "dock:animations" });
    expect(isError(result)).toBe(true);
    expect(text(result)).toContain("Docks: Animation, Inspector");
  });
});

describe("summer_ui_activate", () => {
  it("press by path is an identity-bound UiActivate whose read-back state passes through", async () => {
    const { executeIdentityBoundOps } = engine({
      executeIdentityBoundOps: vi.fn().mockResolvedValue({
        ok: true,
        results: [
          {
            ok: true,
            op: "UiActivate",
            path: "@Panel@3/Toolbar/Snap",
            class: "Button",
            action: "press",
            via: "click",
            pressed_emitted: true,
            state: { checked: true, enabled: true },
            mutates: true,
          },
        ],
      }),
    });
    const result = await tool("summer_ui_activate").handler({ path: "@Panel@3/Toolbar/Snap" });
    expect(isError(result)).toBeUndefined();
    expect(executeIdentityBoundOps).toHaveBeenCalledWith([{ op: "UiActivate", path: "@Panel@3/Toolbar/Snap", action: "press" }]);
    expect(text(result)).toContain('"pressed_emitted": true');
    expect(text(result)).toContain('"checked": true');
  });

  it("main_screen select_tab sends the value; set_value coerces a numeric string", async () => {
    const { executeIdentityBoundOps } = engine();
    await tool("summer_ui_activate").handler({ path: "main_screen", action: "select_tab", value: "3D" });
    await tool("summer_ui_activate").handler({ path: "@Spin@1", action: "set_value", value: "0.5" });
    expect(executeIdentityBoundOps.mock.calls.map((call) => call[0])).toEqual([
      [{ op: "UiActivate", path: "main_screen", action: "select_tab", value: "3D" }],
      [{ op: "UiActivate", path: "@Spin@1", action: "set_value", value: 0.5 }],
    ]);
  });

  it("action:'dismiss_dialog' sends UiDismissDialog and passes visible_after through", async () => {
    const { executeIdentityBoundOps } = engine({
      executeIdentityBoundOps: vi.fn().mockResolvedValue({
        ok: true,
        results: [{ ok: true, op: "UiDismissDialog", title: "Project Settings", class: "ProjectSettingsEditor", button: "cancel", via: "close_request", visible_after: false, mutates: true }],
      }),
    });
    const result = await tool("summer_ui_activate").handler({ action: "dismiss_dialog", title: "Project Settings" });
    expect(isError(result)).toBeUndefined();
    expect(executeIdentityBoundOps).toHaveBeenCalledWith([{ op: "UiDismissDialog", title: "Project Settings" }]);
    expect(text(result)).toContain('"visible_after": false');
  });

  it("validation failures are invalid_input with sent:false (no target, missing value)", async () => {
    const { executeIdentityBoundOps } = engine();
    const noTarget = await tool("summer_ui_activate").handler({ action: "dismiss_dialog" });
    expect(isError(noTarget)).toBe(true);
    expect(text(noTarget)).toContain("needs a target");
    const noValue = await tool("summer_ui_activate").handler({ path: "main_screen", action: "select_tab" });
    expect(text(noValue)).toContain('"sent": false');
    expect(executeIdentityBoundOps).not.toHaveBeenCalled();
  });

  it("pre-flights UiDismissDialog separately from UiActivate", async () => {
    const { executeIdentityBoundOps } = engine({}, ["UiActivate"]);
    expect(isError(await tool("summer_ui_activate").handler({ path: "x" }))).toBeUndefined();
    const dismiss = await tool("summer_ui_activate").handler({ action: "dismiss_dialog", title: "x" });
    expect(isError(dismiss)).toBe(true);
    expect(text(dismiss)).toContain("does not support the UiDismissDialog op");
    expect(executeIdentityBoundOps).toHaveBeenCalledTimes(1);
  });

  it("renders modal_open and obscured with their detail fields", async () => {
    engine({
      executeIdentityBoundOps: vi
        .fn()
        .mockResolvedValueOnce(
          failed({
            op: "UiActivate",
            failure_reason: "modal_open",
            error: "blocked",
            blocking_dialog: { title: "Unsaved changes", path: "@ConfirmationDialog@5", class: "ConfirmationDialog" },
          })
        )
        .mockResolvedValueOnce(failed({ op: "UiActivate", failure_reason: "obscured", error: "obscured", hit_control: "@Popup@9", hit_class: "PopupPanel" })),
    });
    const modal = await tool("summer_ui_activate").handler({ path: "x" });
    expect(isError(modal)).toBe(true);
    expect(text(modal)).toContain("'Unsaved changes' (ConfirmationDialog, path @ConfirmationDialog@5)");
    expect(text(modal)).toContain("action:'dismiss_dialog'");
    const obscured = await tool("summer_ui_activate").handler({ path: "x" });
    expect(text(obscured)).toContain("@Popup@9 (PopupPanel)");
  });
});

describe("summer_ui_screenshot", () => {
  const png = Buffer.from("png-bytes").toString("base64");

  it("returns the frame as an MCP image block plus a caption with root and size", async () => {
    const { executeOps } = engine({
      executeOps: vi.fn().mockResolvedValue({
        ok: true,
        results: [
          {
            ok: true,
            op: "UiScreenshot",
            image_base64: png,
            mime: "image/png",
            format: "png",
            width: 1024,
            height: 640,
            bytes: 9,
            scale: 0.5,
            root: "window",
            root_path: ".",
            renderer: "forward_plus",
            source_rect: { x: 0, y: 0, w: 2048, h: 1280 },
            safety_boundary: "no_os_screen_capture",
            os_screen_capture: false,
          },
        ],
      }),
    });
    const result = await tool("summer_ui_screenshot").handler({ max_size: 8 });
    expect(isError(result)).toBeUndefined();
    expect(executeOps).toHaveBeenCalledWith([{ op: "UiScreenshot", max_size: 16 }]);
    const blocks = content(result);
    expect(blocks[0]).toEqual({ type: "image", data: png, mimeType: "image/png" });
    expect(blocks[1]!.type).toBe("text");
    expect(blocks[1]!.text).toContain("root 'window' (.)");
    expect(blocks[1]!.text).toContain("1024x640 px");
    expect(blocks[1]!.text).toContain("scale 0.5");
    expect(blocks[1]!.text).toContain("summer_ui_tree");
  });

  it("is honest under a headless editor: no_renderer is an isError text naming the structured alternative, never an image", async () => {
    engine({
      executeOps: vi.fn().mockResolvedValue(
        failed({
          op: "UiScreenshot",
          failure_reason: "no_renderer",
          error: "no renderer: the headless editor's dummy RenderingServer does not draw the UI.",
        })
      ),
    });
    const result = await tool("summer_ui_screenshot").handler({});
    expect(isError(result)).toBe(true);
    expect(content(result).some((entry) => entry.type === "image")).toBe(false);
    const body = text(result);
    expect(body).toContain('"failure_reason": "no_renderer"');
    expect(body).toContain("no pixels exist");
    expect(body).toContain("summer_ui_tree");
    expect(body).toContain("Engine said: no renderer");
  });

  it("falls back to text when a success carries no image bytes", async () => {
    engine({ executeOps: vi.fn().mockResolvedValue({ ok: true, results: [{ ok: true, op: "UiScreenshot" }] }) });
    const result = await tool("summer_ui_screenshot").handler({});
    expect(isError(result)).toBeUndefined();
    expect(content(result)).toEqual([{ type: "text", text: expect.stringContaining("no image data") }]);
  });

  it("refuses BEFORE sending when the advert lacks UiScreenshot, naming summer_screenshot as the fallback", async () => {
    const { executeOps } = engine({}, ["UiTree", "ViewportSnapshot"]);
    const result = await tool("summer_ui_screenshot").handler({ root: "dock:inspector" });
    expect(isError(result)).toBe(true);
    expect(executeOps).not.toHaveBeenCalled();
    expect(text(result)).toContain("does not support the UiScreenshot op");
    expect(text(result)).toContain("summer_screenshot");
  });
});
