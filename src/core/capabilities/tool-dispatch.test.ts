import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EngineUnavailableError,
  ToolDispatchError,
  ToolResultError,
  dispatchTool,
  listToolDispatches,
  resolveToolDispatch,
  type ToolDispatchContext,
} from "./tool-dispatch.js";
import { buildAgentPlaybook } from "./agent-playbook.js";
import { isApiDocsBundleInstalled } from "./api-docs.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function fakeEngineContext(overrides: Record<string, unknown> = {}): {
  ctx: ToolDispatchContext;
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const ok = { ok: true, results: [{ ok: true }] };
  const record =
    (method: string, result: unknown = ok) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return result;
    };
  const client = {
    executeOps: record("executeOps"),
    executeIdentityBoundOps: record("executeIdentityBoundOps"),
    getDiagnostics: record("getDiagnostics"),
    getSceneState: record("getSceneState"),
    getProjectState: record("getProjectState"),
    getScriptErrors: record("getScriptErrors"),
    inspectNode: record("inspectNode"),
    inspectResource: record("inspectResource"),
    readProjectFile: record("readProjectFile"),
    play: record("play"),
    stop: record("stop"),
    rebind: record("rebind", "hash"),
    health: record("health", { ok: true }),
    ...overrides,
  };
  return { ctx: { engine: async () => client as never }, calls };
}

describe("repo-lint: tool-dispatch registry", () => {
  it("has one dispatch entry per library/tools descriptor, and no extras", () => {
    const slugs = new Set(listToolDispatches().map((entry) => entry.slug));
    const descriptorSlugs = new Set(
      readdirSync(join(repoRoot, "library", "tools"), { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name)
    );
    expect([...slugs].sort()).toEqual([...descriptorSlugs].sort());
  });

  it("every entry has a slug, summary, and canonical summer_ name", () => {
    for (const entry of listToolDispatches()) {
      expect(entry.name).toMatch(/^summer_[a-z0-9_]+$/);
      expect(entry.slug).toBe(entry.name.replace(/^summer_/, "").replace(/_/g, "-"));
      expect(entry.summary.length).toBeGreaterThan(0);
    }
  });

  it("resolves slugs, summer_ aliases, and mixed separators to the same entry", () => {
    const bySlug = resolveToolDispatch("add-node");
    expect(bySlug?.name).toBe("summer_add_node");
    expect(resolveToolDispatch("summer_add_node")).toBe(bySlug);
    expect(resolveToolDispatch("add_node")).toBe(bySlug);
    expect(resolveToolDispatch("tool/add-node")).toBe(bySlug);
    expect(resolveToolDispatch("no-such-tool")).toBeNull();
  });

  it("rejects unknown tools with a clear error", async () => {
    await expect(dispatchTool("does-not-exist", {})).rejects.toThrow(
      /Unknown tool "does-not-exist"/
    );
  });

  it("dispatches a pure capability tool without any engine", async () => {
    const engine = async () => {
      throw new EngineUnavailableError("engine must not be needed");
    };
    const plan = (await dispatchTool(
      "start-game-task",
      { goal: "build a small arena shooter" },
      { engine }
    )) as { goal?: string };
    expect(plan).toBeTruthy();
    expect(JSON.stringify(plan)).toContain("arena shooter");
  });

  it("dispatches an engine tool through the provided client", async () => {
    const { ctx, calls } = fakeEngineContext();
    await dispatchTool("is-running", {}, ctx);
    expect(calls).toEqual([
      { method: "executeOps", args: [[{ op: "IsGameRunning" }]] },
    ]);
  });

  it("appends SaveScene to scene mutations and dispatches it as its own request", async () => {
    const { ctx, calls } = fakeEngineContext();
    await dispatchTool(
      "add-node",
      { scenePath: "res://main.tscn", parent: "/", type: "Node3D", name: "World" },
      ctx
    );
    expect(calls.map((call) => call.method)).toEqual([
      "executeIdentityBoundOps",
      "executeIdentityBoundOps",
    ]);
    const [mutation, save] = calls.map((call) => call.args[0] as Array<Record<string, unknown>>);
    expect(mutation).toEqual([
      { op: "AddNode", parent: "/", type: "Node3D", name: "World" },
    ]);
    expect(save).toEqual([{ op: "SaveScene" }]);
    for (const call of calls) {
      expect((call.args[1] as Record<string, unknown>).scenePath).toBe("res://main.tscn");
    }
  });

  it("surfaces engine op failures as errors instead of masking them", async () => {
    const { ctx } = fakeEngineContext({
      executeOps: async () => ({ ok: false, error: "no scene open" }),
    });
    await expect(dispatchTool("is-running", {}, ctx)).rejects.toThrow("no scene open");
  });

  it("propagates the clean engine-unavailable error for engine tools", async () => {
    const engine = async () => {
      throw new EngineUnavailableError("Summer Engine is not running (or no project is open).");
    };
    await expect(dispatchTool("get-diagnostics", {}, { engine })).rejects.toThrow(
      /Summer Engine is not running/
    );
  });

  it("write-file fails closed without exactly one guard", async () => {
    const { ctx, calls } = fakeEngineContext();
    await expect(
      dispatchTool("write-file", { path: "res://a.gd", content: "x" }, ctx)
    ).rejects.toThrow(/exactly one guard/);
    await expect(
      dispatchTool(
        "write-file",
        { path: "res://a.gd", content: "x", create_only: true, expected_sha256: "a".repeat(64) },
        ctx
      )
    ).rejects.toThrow(/exactly one guard/);
    expect(calls).toEqual([]);
  });

  it("batch rejects raw file mutations and missing scenePath", async () => {
    const { ctx } = fakeEngineContext();
    await expect(
      dispatchTool("batch", { ops: [{ op: "WriteFile", path: "res://a.gd" }] }, ctx)
    ).rejects.toThrow(/does not accept raw WriteFile/);
    await expect(
      dispatchTool("batch", { ops: [{ op: "AddNode", parent: "/", type: "Node3D" }] }, ctx)
    ).rejects.toThrow(/requires scenePath/);
  });

  it("engineRequired flags match the descriptor expectations for known tools", () => {
    expect(resolveToolDispatch("generate-image")?.engineRequired).toBe(false);
    expect(resolveToolDispatch("creator-releases")?.engineRequired).toBe(false);
    expect(resolveToolDispatch("add-node")?.engineRequired).toBe(true);
    expect(resolveToolDispatch("screenshot")?.engineRequired).toBe(true);
    expect(resolveToolDispatch("import-asset")?.engineRequired).toBe(true);
  });

  it("uses ToolDispatchError for argument validation failures", async () => {
    const { ctx } = fakeEngineContext();
    await expect(dispatchTool("add-node", { scenePath: "res://a.tscn" }, ctx)).rejects.toBeInstanceOf(
      ToolDispatchError
    );
  });
});

describe("agent playbook dispatch entry", () => {
  it("serves the real playbook from the shared core module, not a redirect", async () => {
    const playbook = (await dispatchTool("get-agent-playbook", {})) as Record<string, unknown>;
    expect(Object.keys(playbook)).toEqual(Object.keys(buildAgentPlaybook()));
    expect(Array.isArray(playbook.verificationRitual)).toBe(true);
    expect(playbook.summerUpdateNotice).toBeNull();
  });
});

describe("scene-scripting and perception dispatch entries", () => {
  it("run-script refuses before sending when the engine advert lacks RunSceneScript", async () => {
    const { ctx, calls } = fakeEngineContext({
      getEngineCapabilities: () => ({ opKinds: ["AddNode"] }),
      getEngineVersion: () => "0.5.61",
    });
    await expect(
      dispatchTool("run-script", { source: "func run(ctx):\n\tpass" }, ctx)
    ).rejects.toThrow(/does not support the RunSceneScript op/);
    expect(calls).toEqual([]);
  });

  it("run-script sends a clamped RunSceneScript op with an identity-bound call and a longer client budget", async () => {
    const { ctx, calls } = fakeEngineContext();
    await dispatchTool("run-script", { source: "func run(ctx):\n\tpass", max_seconds: 999 }, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("executeIdentityBoundOps");
    const [ops, , timeoutMs] = calls[0]!.args as [Array<Record<string, unknown>>, unknown, number];
    expect(ops[0]).toMatchObject({ op: "RunSceneScript", max_seconds: 120, checkpoint: true });
    expect(timeoutMs).toBeGreaterThan(120_000);
  });

  it("rewrites an old engine's per-op unknown-op answer into the structured engine_lacks_op result (advert without opKinds, so the pre-flight cannot refuse)", async () => {
    const { ctx } = fakeEngineContext({
      getEngineCapabilities: () => ({ singleOnlyOps: ["SaveScene"] }),
      executeOps: async () => ({
        ok: false,
        results: [{ ok: false, op: "GetWorldSnapshot", error: "unknown op: GetWorldSnapshot" }],
      }),
    });
    const failure = await dispatchTool("world-snapshot", {}, ctx).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ToolResultError);
    const { result, message } = failure as ToolResultError;
    expect(result).toMatchObject({ ok: false, op: "GetWorldSnapshot", failure_reason: "engine_lacks_op" });
    expect(message).toContain("doesn't support GetWorldSnapshot yet");
    expect(message).toContain("summer_get_scene_tree");
    expect(message).toContain("Engine said: unknown op: GetWorldSnapshot");
    expect(message).not.toContain("nothing was sent");
  });

  it("pre-flight refusals carry the same structured result", async () => {
    const { ctx } = fakeEngineContext({
      getEngineCapabilities: () => ({ opKinds: ["AddNode"] }),
      getEngineVersion: () => "0.5.61",
    });
    const failure = await dispatchTool("world-snapshot", {}, ctx).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ToolResultError);
    expect((failure as ToolResultError).result).toMatchObject({
      ok: false,
      op: "GetWorldSnapshot",
      failure_reason: "engine_lacks_op",
      engine_version: "0.5.61",
    });
  });

  it("world-snapshot and snapshot-diff dispatch single ops and surface failures", async () => {
    const { ctx, calls } = fakeEngineContext();
    await dispatchTool("world-snapshot", { max_nodes: 100 }, ctx);
    await dispatchTool("snapshot-diff", { from_id: "snap-1" }, ctx);
    expect(calls.map((call) => call.args[0])).toEqual([
      [{ op: "GetWorldSnapshot", max_nodes: 100 }],
      [{ op: "DiffWorldSnapshot", from_id: "snap-1" }],
    ]);
    const failing = fakeEngineContext({
      executeOps: async () => ({ ok: false, results: [{ ok: false, failure_reason: "game_not_running", error: "no running game" }] }),
    });
    await expect(dispatchTool("get-runtime-tree", {}, failing.ctx)).rejects.toThrow("no running game");
  });

  it("api-docs is engine-free and returns the lookup result as data (misses included)", async () => {
    const engine = async () => {
      throw new EngineUnavailableError("engine must not be needed");
    };
    const result = (await dispatchTool("api-docs", { class_name: "NoSuchClassAnywhere" }, { engine })) as {
      ok: boolean;
      failure_reason?: string;
    };
    expect(result.ok).toBe(false);
    // Deterministic: with the bundle installed a class miss carries no
    // failure_reason; without it the structured not-installed result does.
    expect(result.failure_reason).toBe(
      isApiDocsBundleInstalled() ? undefined : "api_docs_not_installed"
    );
  });

  it("start-game-task validates mode/target with the shared zod schema instead of casting", async () => {
    await expect(
      dispatchTool("start-game-task", { goal: "Ship it", mode: "shipp" })
    ).rejects.toThrow(/Invalid arguments for start-game-task: mode:/);
    await expect(
      dispatchTool("start-game-task", { goal: "Ship it", target: "4d" })
    ).rejects.toThrow(/target:/);
    await expect(dispatchTool("start-game-task", { goal: "   " })).rejects.toThrow(/goal/);
    const plan = (await dispatchTool("start-game-task", { goal: "Export the game", mode: "ship" })) as {
      mode: string;
    };
    expect(plan.mode).toBe("ship");
  });

  it("import-hdri rejects an off-ladder resolution before touching the network", async () => {
    const { ctx, calls } = fakeEngineContext();
    await expect(
      dispatchTool("import-hdri", { query: "sunset", resolution: "8k" }, ctx)
    ).rejects.toThrow(/Invalid arguments for import-hdri: resolution:/);
    expect(calls).toEqual([]);
  });

  it("import-hdri rejects a call with neither query nor assetId before touching the network", async () => {
    const { ctx, calls } = fakeEngineContext();
    await expect(dispatchTool("import-hdri", {}, ctx)).rejects.toThrow(/Pass query/);
    expect(calls).toEqual([]);
  });
});

describe("editor UI control dispatch entries (wave L)", () => {
  const uiSlugs = ["ui-actions", "ui-tree", "ui-activate", "ui-screenshot"];

  it("are engine-required and resolve by slug and summer_ name", () => {
    for (const slug of uiSlugs) {
      const entry = resolveToolDispatch(slug);
      expect(entry?.engineRequired, slug).toBe(true);
      expect(resolveToolDispatch(`summer_${slug.replace(/-/g, "_")}`)).toBe(entry);
    }
  });

  it("validates with the shared zod contract before touching the engine (same rejections as the MCP face)", async () => {
    const engine = async () => {
      throw new EngineUnavailableError("engine must not be needed for argument validation");
    };
    await expect(dispatchTool("ui-actions", {}, { engine })).rejects.toThrow(/Invalid arguments for ui-actions: mode/);
    await expect(dispatchTool("ui-actions", { mode: "invoke" }, { engine })).rejects.toThrow(/requires action_name/);
    await expect(dispatchTool("ui-activate", { action: "dismiss_dialog" }, { engine })).rejects.toThrow(/needs a target/);
    await expect(dispatchTool("ui-activate", { path: "main_screen", action: "select_tab" }, { engine })).rejects.toThrow(
      /needs value/
    );
    await expect(dispatchTool("ui-activate", { path: "x", action: "click" }, { engine })).rejects.toThrow(
      /Invalid arguments for ui-activate: action/
    );
    await expect(dispatchTool("ui-tree", { depth: 0 }, { engine })).rejects.toThrow(/Invalid arguments for ui-tree: depth/);
  });

  it("refuses before sending when the advert lacks the op kind the arguments resolved to", async () => {
    const { ctx, calls } = fakeEngineContext({
      getEngineCapabilities: () => ({ opKinds: ["AddNode", "UiListActions", "UiTree", "UiActivate"] }),
      getEngineVersion: () => "0.5.65",
    });
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["ui-actions", { mode: "invoke", action_name: "editor/save_scene" }, "UiInvoke"],
      ["ui-tree", { root: "dialogs" }, "UiDialogs"],
      ["ui-activate", { action: "dismiss_dialog", title: "Save" }, "UiDismissDialog"],
      ["ui-screenshot", {}, "UiScreenshot"],
    ];
    for (const [slug, args, op] of cases) {
      const failure = await dispatchTool(slug, args, ctx).catch((error: unknown) => error);
      expect(failure, slug).toBeInstanceOf(ToolResultError);
      const { result, message } = failure as ToolResultError;
      expect(result).toMatchObject({ ok: false, op, failure_reason: "engine_lacks_op", engine_version: "0.5.65" });
      expect(message).toContain(`does not support the ${op} op`);
    }
    expect(calls).toEqual([]);
    // The kinds the advert DOES carry go through.
    await dispatchTool("ui-actions", { mode: "list", filter: "save" }, ctx);
    await dispatchTool("ui-tree", { root: "dock:inspector" }, ctx);
    await dispatchTool("ui-activate", { path: "main_screen", action: "select_tab", value: "3D" }, ctx);
    expect(calls.map((call) => call.method)).toEqual(["executeOps", "executeOps", "executeIdentityBoundOps"]);
  });

  it("sends reads plain and mutations identity-bound, with the exact op payloads", async () => {
    const { ctx, calls } = fakeEngineContext();
    await dispatchTool("ui-actions", { mode: "list", filter: "project", limit: 9999 }, ctx);
    await dispatchTool("ui-actions", { mode: "invoke", action_name: "editor/project_settings" }, ctx);
    await dispatchTool("ui-tree", { root: "dialogs" }, ctx);
    await dispatchTool("ui-tree", { depth: 2, limit: 50, visible_only: false }, ctx);
    await dispatchTool("ui-activate", { action: "dismiss_dialog", path: "@ProjectSettingsEditor@77", button: "cancel" }, ctx);
    await dispatchTool("ui-activate", { path: "@Spin@1", action: "set_value", value: "0.25" }, ctx);
    expect(calls).toEqual([
      { method: "executeOps", args: [[{ op: "UiListActions", filter: "project", limit: 2000 }]] },
      { method: "executeIdentityBoundOps", args: [[{ op: "UiInvoke", action: "editor/project_settings" }]] },
      { method: "executeOps", args: [[{ op: "UiDialogs" }]] },
      { method: "executeOps", args: [[{ op: "UiTree", depth: 2, limit: 50, visible_only: false }]] },
      {
        method: "executeIdentityBoundOps",
        args: [[{ op: "UiDismissDialog", path: "@ProjectSettingsEditor@77", button: "cancel" }]],
      },
      { method: "executeIdentityBoundOps", args: [[{ op: "UiActivate", path: "@Spin@1", action: "set_value", value: 0.25 }]] },
    ]);
  });

  it("surfaces the engine's UI failure taxonomy with its detail fields (denied_action, modal_open) instead of masking it", async () => {
    const { ctx } = fakeEngineContext({
      executeIdentityBoundOps: async (ops: Array<Record<string, unknown>>) =>
        ops[0]!.action === "editor/file_quit"
          ? {
              ok: false,
              results: [{ ok: false, op: "UiInvoke", failure_reason: "denied_action", error: "denied", reason: "editor/file_quit ends the editor session" }],
            }
          : {
              ok: false,
              results: [
                {
                  ok: false,
                  op: "UiInvoke",
                  failure_reason: "modal_open",
                  error: "blocked",
                  blocking_dialog: { title: "Project Settings", path: "@ProjectSettingsEditor@77", class: "ProjectSettingsEditor" },
                },
              ],
            },
    });
    const denied = await dispatchTool("ui-actions", { mode: "invoke", action_name: "editor/file_quit" }, ctx).catch(
      (error: unknown) => error
    );
    expect(denied).toBeInstanceOf(ToolDispatchError);
    expect((denied as Error).message).toContain('"failure_reason": "denied_action"');
    expect((denied as Error).message).toContain("ends the editor session");
    expect((denied as Error).message).toContain("Do not retry it");

    const modal = await dispatchTool("ui-actions", { mode: "invoke", action_name: "editor/save_scene" }, ctx).catch(
      (error: unknown) => error
    );
    expect((modal as Error).message).toContain('"failure_reason": "modal_open"');
    expect((modal as Error).message).toContain("path @ProjectSettingsEditor@77");
    expect((modal as Error).message).toContain("action:'dismiss_dialog'");
  });

  it("rewrites an old engine's unknown-op answer into the structured engine_lacks_op receipt", async () => {
    const { ctx } = fakeEngineContext({
      executeOps: async () => ({ ok: false, results: [{ ok: false, op: "UiTree", error: "unknown op: UiTree" }] }),
    });
    const failure = await dispatchTool("ui-tree", {}, ctx).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ToolResultError);
    const { result, message } = failure as ToolResultError;
    expect(result).toMatchObject({ op: "UiTree", failure_reason: "engine_lacks_op" });
    expect(message).toContain("doesn't support UiTree yet");
    expect(message).toContain("Engine said: unknown op: UiTree");
  });

  it("ui-screenshot writes the PNG to a temp file and returns the receipt without the payload", async () => {
    const bytes = Buffer.from("png-bytes");
    const { ctx } = fakeEngineContext({
      executeOps: async () => ({
        ok: true,
        results: [
          { ok: true, op: "UiScreenshot", image_base64: bytes.toString("base64"), mime: "image/png", width: 64, height: 32, root: "window", root_path: ".", scale: 1 },
        ],
      }),
    });
    const receipt = (await dispatchTool("ui-screenshot", { max_size: 64 }, ctx)) as Record<string, unknown>;
    expect(receipt).not.toHaveProperty("image_base64");
    expect(receipt).toMatchObject({ width: 64, height: 32, root: "window" });
    expect(String(receipt.caption)).toContain("64x32 px");
    const localPath = String(receipt.local_path);
    try {
      expect(existsSync(localPath)).toBe(true);
      expect(readFileSync(localPath)).toEqual(bytes);
    } finally {
      rmSync(localPath, { force: true });
    }
  });

  it("ui-screenshot is honest under a headless editor: no_renderer surfaces with the structured alternative", async () => {
    const { ctx } = fakeEngineContext({
      executeOps: async () => ({
        ok: false,
        results: [{ ok: false, op: "UiScreenshot", failure_reason: "no_renderer", error: "no renderer: dummy RenderingServer" }],
      }),
    });
    const failure = await dispatchTool("ui-screenshot", {}, ctx).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ToolDispatchError);
    const message = (failure as Error).message;
    expect(message).toContain('"failure_reason": "no_renderer"');
    expect(message).toContain("no pixels exist");
    expect(message).toContain("summer_ui_tree");
    expect(message).toContain("Engine said: no renderer: dummy RenderingServer");
  });
});

describe("spatial dispatch entries", () => {
  const spatialSlugs = [
    "test-placement",
    "snap-to-surface",
    "align-distribute-3d",
    "navigation-probe",
    "starcast",
  ];

  it("registers all five spatial tools as engine-required", () => {
    for (const slug of spatialSlugs) {
      expect(resolveToolDispatch(slug)?.engineRequired, slug).toBe(true);
    }
  });

  it("refuses before sending when the engine advert lacks the op", async () => {
    const { ctx, calls } = fakeEngineContext({
      getEngineCapabilities: () => ({ opKinds: ["AddNode", "SaveScene"] }),
      getEngineVersion: () => "0.5.61",
    });
    await expect(
      dispatchTool("snap-to-surface", { scenePath: "res://a.tscn", subjectPath: "./Crate" }, ctx)
    ).rejects.toThrow(/does not support the SnapToSurface op/);
    await expect(
      dispatchTool(
        "test-placement",
        {
          scenePath: "res://a.tscn",
          subjectPath: "./Crate",
          candidateGlobalPosition: [0, 0, 0],
          candidateGlobalRotationDegrees: [0, 0, 0],
        },
        ctx
      )
    ).rejects.toThrow(/does not support the TestPlacement3D op/);
    expect(calls).toEqual([]);
  });

  it("snap-to-surface sends the mutation then SaveScene, identity-bound to the exact scene", async () => {
    const { ctx, calls } = fakeEngineContext();
    await dispatchTool("snap-to-surface", { scenePath: "res://a.tscn", subjectPath: " ./Crate " }, ctx);
    expect(calls.map((call) => call.method)).toEqual(["executeIdentityBoundOps", "executeIdentityBoundOps"]);
    expect(calls[0]!.args[0]).toEqual([
      { op: "SnapToSurface", subject_path: "./Crate", direction: [0, -1, 0], max_distance: 20, gap: 0, align_up: false },
    ]);
    expect(calls[1]!.args[0]).toEqual([{ op: "SaveScene" }]);
    for (const call of calls) {
      expect((call.args[1] as Record<string, unknown>).scenePath).toBe("res://a.tscn");
    }
  });

  it("read-only spatial queries send exactly one identity-bound op and never save", async () => {
    const { ctx, calls } = fakeEngineContext();
    await dispatchTool(
      "test-placement",
      {
        scenePath: "res://a.tscn",
        subjectPath: "./Hero",
        candidateGlobalPosition: [0, 0, 0],
        candidateGlobalRotationDegrees: [0, 0, 0],
      },
      ctx
    );
    await dispatchTool("navigation-probe", { scenePath: "res://a.tscn", start: [0, 0, 0], end: [1, 0, 0] }, ctx);
    expect(calls.map((call) => call.method)).toEqual(["executeIdentityBoundOps", "executeIdentityBoundOps"]);
    expect(calls[0]!.args[0]).toEqual([
      {
        op: "TestPlacement3D",
        subject_path: "./Hero",
        candidate_global_position: [0, 0, 0],
        candidate_global_rotation_degrees: [0, 0, 0],
        collision_mask: 0xffffffff,
        collide_with_areas: true,
        max_floor_distance: 5,
        ground_tolerance: 0.05,
        margin: 0.001,
      },
    ]);
    expect(calls[1]!.args[0]).toEqual([
      { op: "NavigationProbe3D", start: [0, 0, 0], end: [1, 0, 0], navigation_layers: 1, optimize: true },
    ]);
  });

  it("validates spatial arguments before touching the engine", async () => {
    const { ctx, calls } = fakeEngineContext();
    await expect(
      dispatchTool("align-distribute-3d", { scenePath: "res://a.tscn", subjectPaths: ["./A"], axis: [1, 0, 0], mode: "align_min" }, ctx)
    ).rejects.toThrow(/2\.\.16/);
    await expect(
      dispatchTool("align-distribute-3d", { scenePath: "res://a.tscn", subjectPaths: ["./A", "./B"], axis: [0, 0, 0], mode: "align_min" }, ctx)
    ).rejects.toThrow(/axis must be non-zero/);
    await expect(
      dispatchTool("snap-to-surface", { scenePath: "res://a.tscn", subjectPath: "./A", gap: 30, maxDistance: 20 }, ctx)
    ).rejects.toThrow(/gap/);
    expect(calls).toEqual([]);
  });

  it("starcast pre-flight refusal is the structured engine_lacks_op receipt `summer tool` prints (nothing sent)", async () => {
    const { ctx, calls } = fakeEngineContext({
      getEngineCapabilities: () => ({ opKinds: ["AddNode", "SaveScene"] }),
      getEngineVersion: () => "0.5.61",
    });
    const failure = await dispatchTool("starcast", { scenePath: "res://a.tscn", path: "./Crate" }, ctx).catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(ToolResultError);
    const { result } = failure as ToolResultError;
    expect(result).toMatchObject({
      ok: false,
      op: "Starcast3D",
      failure_reason: "engine_lacks_op",
      engine_version: "0.5.61",
    });
    expect(String(result.error)).toContain("does not support the Starcast3D op");
    expect(String(result.error)).toContain("summer_inspect_node");
    expect(calls).toEqual([]);
  });

  it("starcast on an engine with no capability advert rewrites the per-op unknown-op error into engine_lacks_op", async () => {
    const { ctx } = fakeEngineContext({
      executeIdentityBoundOps: async () => ({
        ok: false,
        results: [{ ok: false, op: "Starcast3D", error: "unknown op: Starcast3D" }],
      }),
    });
    const failure = await dispatchTool("starcast", { scenePath: "res://a.tscn", path: "./Crate" }, ctx).catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(ToolResultError);
    const { result } = failure as ToolResultError;
    expect(result).toMatchObject({ op: "Starcast3D", failure_reason: "engine_lacks_op" });
    expect(String(result.error)).toContain("doesn't support Starcast3D yet");
    expect(String(result.error)).toContain("unknown op: Starcast3D");
  });

  it("starcast sends exactly one identity-bound op with the engine defaults and never saves", async () => {
    const { ctx, calls } = fakeEngineContext();
    await dispatchTool("starcast", { scenePath: "res://a.tscn", path: " ./Crate " }, ctx);
    expect(calls).toEqual([
      {
        method: "executeIdentityBoundOps",
        args: [
          [
            {
              op: "Starcast3D",
              path: "./Crate",
              detail: "summary",
              max_distance: 20,
              nearby_radius: 10,
              direction_space: "world",
              collision_mask: 0xffffffff,
              collide_with_areas: true,
              max_hits_per_direction: 3,
              max_results: 64,
              margin: 0.001,
            },
          ],
          { scenePath: "res://a.tscn" },
        ],
      },
    ]);
  });

  it("starcast validates detail, directionSpace, path, and integer bounds before touching the engine", async () => {
    const { ctx, calls } = fakeEngineContext();
    const base = { scenePath: "res://a.tscn", path: "./Crate" };
    await expect(dispatchTool("starcast", { ...base, detail: "verbose" }, ctx)).rejects.toThrow(/detail must be one of summary, full/);
    await expect(dispatchTool("starcast", { ...base, directionSpace: "camera" }, ctx)).rejects.toThrow(/directionSpace must be one of world, local/);
    await expect(dispatchTool("starcast", { ...base, maxHitsPerDirection: 9 }, ctx)).rejects.toThrow(/maxHitsPerDirection/);
    await expect(dispatchTool("starcast", { ...base, maxResults: 0 }, ctx)).rejects.toThrow(/maxResults/);
    await expect(dispatchTool("starcast", { ...base, maxDistance: 0 }, ctx)).rejects.toThrow(/maxDistance/);
    await expect(dispatchTool("starcast", { scenePath: "res://a.tscn" }, ctx)).rejects.toThrow(/path/);
    expect(calls).toEqual([]);
  });

  it("batch identity-binds a raw Starcast3D op to the exact scene and never appends SaveScene", async () => {
    const { ctx, calls } = fakeEngineContext();
    await dispatchTool("batch", { scenePath: "res://a.tscn", ops: [{ op: "Starcast3D", path: "./Crate" }] }, ctx);
    expect(calls.map((call) => call.method)).toEqual(["executeIdentityBoundOps"]);
    expect(calls[0]!.args[0]).toEqual([{ op: "Starcast3D", path: "./Crate" }]);
    await expect(dispatchTool("batch", { ops: [{ op: "Starcast3D" }] }, ctx)).rejects.toThrow(/requires scenePath/);
  });

  it("batch identity-binds a read-only spatial query and treats a spatial mutation as a scene mutation", async () => {
    const { ctx, calls } = fakeEngineContext();
    await dispatchTool("batch", { scenePath: "res://a.tscn", ops: [{ op: "TestPlacement3D" }] }, ctx);
    expect(calls.map((call) => call.method)).toEqual(["executeIdentityBoundOps"]);
    expect(calls[0]!.args[0]).toEqual([{ op: "TestPlacement3D" }]);

    const second = fakeEngineContext();
    await dispatchTool("batch", { scenePath: "res://a.tscn", ops: [{ op: "AlignDistribute3D" }] }, second.ctx);
    expect(second.calls.map((call) => call.args[0])).toEqual([[{ op: "AlignDistribute3D" }], [{ op: "SaveScene" }]]);

    await expect(dispatchTool("batch", { ops: [{ op: "NavigationProbe3D" }] }, ctx)).rejects.toThrow(/requires scenePath/);
  });
});
