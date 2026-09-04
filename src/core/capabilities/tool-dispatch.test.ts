import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
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

  it("api-docs is engine-free; a miss is the structured lookup result, surfaced as a failure like the MCP face's isError", async () => {
    const engine = async () => {
      throw new EngineUnavailableError("engine must not be needed");
    };
    // summer_api_docs sets isError when the lookup says ok:false (script-tools.ts),
    // so the CLI face prints the same structured result and exits 1.
    const failure = await dispatchTool("api-docs", { class_name: "NoSuchClassAnywhere" }, { engine }).catch(
      (err) => err
    );
    expect(failure).toBeInstanceOf(ToolResultError);
    const result = (failure as ToolResultError).result as { ok: boolean; error?: string; failure_reason?: string };
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
    // Deterministic: with the bundle installed a class miss carries no
    // failure_reason; without it the structured not-installed result does.
    expect(result.failure_reason).toBe(
      isApiDocsBundleInstalled() ? undefined : "api_docs_not_installed"
    );
    if (isApiDocsBundleInstalled()) {
      // A hit is data.
      const hit = (await dispatchTool("api-docs", { class_name: "Node3D" }, { engine })) as { ok: boolean };
      expect(hit.ok).toBe(true);
    }
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

describe("mesh fabrication dispatch entry", () => {
  const SCRIPT = "bpy.ops.mesh.primitive_cube_add(size=1)";

  it("is engine-required and refuses before sending when the advert lacks FabricateMesh", async () => {
    expect(resolveToolDispatch("fabricate-3d")?.engineRequired).toBe(true);
    const { ctx, calls } = fakeEngineContext({
      getEngineCapabilities: () => ({ opKinds: ["AddNode", "RunEditorScript"] }),
      getEngineVersion: () => "0.5.65",
    });
    const failure = await dispatchTool("fabricate-3d", { source: SCRIPT, name: "crate" }, ctx).catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(ToolResultError);
    const { result, message } = failure as ToolResultError;
    expect(result).toMatchObject({
      ok: false,
      op: "FabricateMesh",
      failure_reason: "engine_lacks_op",
      engine_version: "0.5.65",
    });
    expect(message).toContain("does not support the FabricateMesh op");
    expect(message).toContain("summer_generate_3d");
    expect(message).toContain("summer_search_assets");
    expect(calls).toEqual([]);
  });

  it("sends one identity-bound FabricateMesh op with the clamped budget and a 60 s client headroom", async () => {
    const { ctx, calls } = fakeEngineContext();
    await dispatchTool(
      "fabricate-3d",
      {
        source: SCRIPT,
        name: "crate",
        max_seconds: 5,
        import_to_scene: { parent: "./Props" },
        target_size: 1.5,
        checkpoint: true,
      },
      ctx
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("executeIdentityBoundOps");
    const [ops, options, timeoutMs] = calls[0]!.args as [Array<Record<string, unknown>>, unknown, number];
    expect(options).toBeUndefined();
    expect(ops).toEqual([
      {
        op: "FabricateMesh",
        script_source: SCRIPT,
        name: "crate",
        max_seconds: 15, // clamped up from 5
        import_to_scene: { parent: "./Props" },
        target_size: 1.5,
        checkpoint: true,
      },
    ]);
    expect(timeoutMs).toBe(15_000 + 60_000);
  });

  it("validates with the shared zod contract before touching the engine (same rejections as the MCP face)", async () => {
    const engine = async () => {
      throw new EngineUnavailableError("engine must not be needed for argument validation");
    };
    await expect(dispatchTool("fabricate-3d", { source: SCRIPT }, { engine })).rejects.toThrow(
      /Invalid arguments for fabricate-3d: name/
    );
    await expect(
      dispatchTool("fabricate-3d", { source: SCRIPT, name: "a", out_path: "res://../x.glb" }, { engine })
    ).rejects.toThrow(/out_path may not contain '\.\.'/);
    await expect(
      dispatchTool("fabricate-3d", { source: SCRIPT, name: "a", target_size: -1 }, { engine })
    ).rejects.toThrow(/target_size/);
    await expect(
      dispatchTool("fabricate-3d", { source: SCRIPT, name: "a", import_to_scene: { position: "Vector3(0,0,0)" } }, { engine })
    ).rejects.toThrow(/import_to_scene\.parent/);
  });

  it("rewrites an old engine's unknown-op answer into the structured engine_lacks_op receipt", async () => {
    const { ctx } = fakeEngineContext({
      executeIdentityBoundOps: async () => ({
        ok: false,
        results: [{ ok: false, op: "FabricateMesh", error: "unknown op: FabricateMesh" }],
      }),
    });
    const failure = await dispatchTool("fabricate-3d", { source: SCRIPT, name: "crate" }, ctx).catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(ToolResultError);
    const { result, message } = failure as ToolResultError;
    expect(result).toMatchObject({ op: "FabricateMesh", failure_reason: "engine_lacks_op" });
    expect(message).toContain("doesn't support FabricateMesh yet");
    expect(message).toContain("Engine said: unknown op: FabricateMesh");
  });

  it("surfaces the engine's fabrication failure taxonomy as the error instead of masking it", async () => {
    const { ctx } = fakeEngineContext({
      executeIdentityBoundOps: async () => ({
        ok: false,
        results: [
          {
            ok: false,
            op: "FabricateMesh",
            failure_reason: "blender_not_found",
            error: "No Blender executable was found on this machine (checked: /usr/bin/blender).",
          },
        ],
      }),
    });
    await expect(dispatchTool("fabricate-3d", { source: SCRIPT, name: "crate" }, ctx)).rejects.toThrow(
      /blender_not_found/
    );
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

describe("engine failures exit 1 on the CLI face exactly when the MCP face sets isError (E2E F-06)", () => {
  it("a read that the engine answers ok:false (inspect-node on a missing node) is a ToolResultError carrying the envelope", async () => {
    const { ctx } = fakeEngineContext({
      inspectNode: async () => ({ ok: false, error: "node not found: DoesNotExist", appliedThroughSeq: 12 }),
    });
    const failure = await dispatchTool("inspect-node", { path: "DoesNotExist" }, ctx).catch((err) => err);
    expect(failure).toBeInstanceOf(ToolResultError);
    expect((failure as ToolResultError).result).toMatchObject({
      ok: false,
      error: "node not found: DoesNotExist",
      appliedThroughSeq: 12,
    });
  });

  it("a failed scene-mutation receipt returned by the handler (no per-handler check) is a failure too", async () => {
    const { ctx } = fakeEngineContext({
      executeIdentityBoundOps: async () => ({
        ok: false,
        results: [{ ok: false, op: "AddNode", error: "parent not found: Nope" }],
        terminalState: "failed",
      }),
    });
    const failure = await dispatchTool(
      "add-node",
      { scenePath: "res://main.tscn", parent: "Nope", type: "Node3D", name: "X" },
      ctx
    ).catch((err) => err);
    expect(failure).toBeInstanceOf(ToolResultError);
    const result = (failure as ToolResultError).result;
    expect(result.ok).toBe(false);
    // The chunked-mutation envelope (engine-ops, shared by both faces) states
    // which op failed at the top level and keeps the engine's own text per op.
    expect(result.error).toBe("Engine request failed (AddNode).");
    expect((result.results as Array<{ error?: string }>)[0]?.error).toBe("parent not found: Nope");
  });

  it("a failure terminalState without an error string gets a plain top-level error and keeps the classifiers", async () => {
    const { ctx } = fakeEngineContext({
      executeOps: async () => ({ terminalState: "timed_out", errorClass: "transient", failure_reason: "no_progress" }),
    });
    const failure = await dispatchTool("is-running", {}, ctx).catch((err) => err);
    expect(failure).toBeInstanceOf(ToolResultError);
    const result = (failure as ToolResultError).result;
    expect(result).toMatchObject({ ok: false, terminalState: "timed_out", errorClass: "transient", failure_reason: "no_progress" });
    expect(typeof result.error).toBe("string");
    expect(String(result.error).startsWith("{")).toBe(false);
    expect(String(result.error)).toContain("timed out");
  });

  it("a genuine success passes through untouched", async () => {
    const { ctx } = fakeEngineContext({
      inspectNode: async () => ({ ok: true, node_name: "Player", node_type: "CharacterBody2D", props: [] }),
    });
    await expect(dispatchTool("inspect-node", { path: "Player" }, ctx)).resolves.toEqual({
      ok: true,
      node_name: "Player",
      node_type: "CharacterBody2D",
      props: [],
    });
  });
});

describe("events dispatch entries (wait-for-event, recent-events)", () => {
  const withChannel = {
    getEngineCapabilities: () => ({
      events: { kinds: ["op.applied", "op.failed", "script.error", "play.started", "scene.saved"] },
    }),
    getEngineVersion: () => "0.6.0",
  };

  it("registers both as engine-required with the canonical slugs", () => {
    expect(resolveToolDispatch("wait-for-event")?.name).toBe("summer_wait_for_event");
    expect(resolveToolDispatch("summer_recent_events")?.slug).toBe("recent-events");
    expect(resolveToolDispatch("wait-for-event")?.engineRequired).toBe(true);
    expect(resolveToolDispatch("recent-events")?.engineRequired).toBe(true);
  });

  it("refuses BEFORE sending with the structured engine_lacks_events receipt when the advert lacks events", async () => {
    const { ctx, calls } = fakeEngineContext({
      getEngineCapabilities: () => ({ opKinds: ["AddNode"], singleOnlyOps: ["SaveScene"] }),
      getEngineVersion: () => "0.5.70",
      pollEvents: async () => {
        throw new Error("must not be called");
      },
    });
    for (const slug of ["wait-for-event", "recent-events"]) {
      const failure = await dispatchTool(slug, {}, ctx).catch((error: unknown) => error);
      expect(failure, slug).toBeInstanceOf(ToolResultError);
      const { result, message } = failure as ToolResultError;
      expect(result).toMatchObject({ ok: false, failure_reason: "engine_lacks_events", engine_version: "0.5.70" });
      expect(result).not.toHaveProperty("op");
      expect(message).toContain("does not expose the events channel");
      expect(message).toContain("nothing was sent");
    }
    // A client with no capability getter at all (very old engine) is refused too.
    const bare = fakeEngineContext();
    await expect(dispatchTool("wait-for-event", {}, bare.ctx)).rejects.toBeInstanceOf(ToolResultError);
    expect(calls).toEqual([]);
  });

  it("wait-for-event long-polls through pollEvents, chains next_seq, and returns the matched event", async () => {
    const pages = [
      { ok: true, events: [], next_seq: 9, since: 9, timed_out: true },
      { ok: true, events: [{ seq: 10, kind: "play.started", ts: 1, data: { scene: "res://main.tscn" } }], next_seq: 10, timed_out: false },
    ];
    let index = 0;
    const { ctx, calls } = fakeEngineContext({
      ...withChannel,
      pollEvents: async (...args: unknown[]) => {
        calls.push({ method: "pollEvents", args });
        return pages[Math.min(index++, pages.length - 1)];
      },
    });
    const result = (await dispatchTool("wait-for-event", { kinds: ["play.started"], timeout_seconds: 30 }, ctx)) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, matched: true, next_seq: 10, since: 9, timed_out: false, polls: 2 });
    expect(calls.map((call) => call.method)).toEqual(["pollEvents", "pollEvents"]);
    expect(calls[0]!.args[0]).toMatchObject({ kinds: ["play.started"], limit: 20 });
    expect((calls[0]!.args[0] as { wait: number }).wait).toBeLessThanOrEqual(25_000);
    expect(calls[1]!.args[0]).toMatchObject({ since: 9 });
  });

  it("validates events arguments with the shared zod schema before touching the engine", async () => {
    const { ctx, calls } = fakeEngineContext(withChannel);
    await expect(dispatchTool("wait-for-event", { since: -1 }, ctx)).rejects.toThrow(/Invalid arguments for wait-for-event: since/);
    await expect(dispatchTool("wait-for-event", { kinds: "play.started" }, ctx)).rejects.toThrow(/Invalid arguments for wait-for-event: kinds/);
    await expect(dispatchTool("recent-events", { limit: 1.5 }, ctx)).rejects.toThrow(/Invalid arguments for recent-events: limit/);
    expect(calls).toEqual([]);
  });

  it("structured failures from the shared implementation are thrown as ToolResultError receipts", async () => {
    const unknownKind = fakeEngineContext({ ...withChannel, pollEvents: async () => ({ ok: true, events: [] }) });
    const failure = await dispatchTool("wait-for-event", { kinds: ["game.booted"] }, unknownKind.ctx).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ToolResultError);
    expect((failure as ToolResultError).result).toMatchObject({ failure_reason: "unknown_event_kind", unknown_kinds: ["game.booted"] });

    const mismatch = fakeEngineContext({
      ...withChannel,
      pollEvents: async () => ({ ok: false, http_status: 409, terminalState: "identity_mismatch", errorClass: "rejected_identity" }),
    });
    const rejected = await dispatchTool("recent-events", { since: 3 }, mismatch.ctx).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(ToolResultError);
    expect((rejected as ToolResultError).result).toMatchObject({ terminalState: "identity_mismatch" });
    expect((rejected as ToolResultError).message).toContain("identity_mismatch");
  });

  it("recent-events reads the newest window with two zero-wait polls when since is omitted", async () => {
    const pages = [
      { ok: true, events: [], next_seq: 100, last_seq: 100, since: 100 },
      { ok: true, events: [{ seq: 100, kind: "scene.saved", data: { path: "res://a.tscn", by: "human" } }], next_seq: 100, last_seq: 100, since: 95 },
    ];
    let index = 0;
    const { ctx, calls } = fakeEngineContext({
      ...withChannel,
      pollEvents: async (...args: unknown[]) => {
        calls.push({ method: "pollEvents", args });
        return pages[Math.min(index++, pages.length - 1)];
      },
    });
    const result = (await dispatchTool("recent-events", { limit: 5 }, ctx)) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, count: 1, next_seq: 100, since: 95, window: "newest" });
    expect(calls.map((call) => call.args[0])).toEqual([
      { wait: 0, limit: 1 },
      { since: 95, kinds: undefined, wait: 0, limit: 5 },
    ]);
  });
});

describe("wave I perception dispatch entries (camera bookmarks, fixed-pose screenshots, play determinism)", () => {
  it("camera-bookmark sends the op kind of the requested action", async () => {
    const { ctx, calls } = fakeEngineContext();
    await dispatchTool("camera-bookmark", { action: "save", name: "hero" }, ctx);
    await dispatchTool("camera-bookmark", { action: "save", name: "top", position: "Vector3(0, 20, 0)", look_at: "Vector3(0, 0, 0)", fov: 45 }, ctx);
    await dispatchTool("camera-bookmark", { action: "list" }, ctx);
    await dispatchTool("camera-bookmark", { action: "delete", name: "hero" }, ctx);
    expect(calls.map((call) => call.args[0])).toEqual([
      [{ op: "SaveCameraBookmark", name: "hero" }],
      [{ op: "SaveCameraBookmark", name: "top", position: "Vector3(0, 20, 0)", look_at: "Vector3(0, 0, 0)", fov: 45 }],
      [{ op: "ListCameraBookmarks" }],
      [{ op: "DeleteCameraBookmark", name: "hero" }],
    ]);
    expect(calls.every((call) => call.method === "executeOps")).toBe(true);
  });

  it("camera-bookmark validates before touching the engine and refuses per-action when the advert lacks that op", async () => {
    const { ctx, calls } = fakeEngineContext({
      getEngineCapabilities: () => ({ opKinds: ["ListCameraBookmarks"] }),
      getEngineVersion: () => "0.5.66",
    });
    await expect(dispatchTool("camera-bookmark", { action: "save" }, ctx)).rejects.toThrow(/needs a bookmark name/);
    await expect(dispatchTool("camera-bookmark", { action: "delete", name: "bad name" }, ctx)).rejects.toThrow(/is invalid/);
    await expect(dispatchTool("camera-bookmark", { action: "save", name: "x", position: "Vector3(0, 0, 0)" }, ctx)).rejects.toThrow(/go together/);
    await expect(dispatchTool("camera-bookmark", { action: "rename", name: "x" }, ctx)).rejects.toThrow(/action must be one of/);
    expect(calls).toEqual([]);

    await dispatchTool("camera-bookmark", { action: "list" }, ctx);
    expect(calls).toHaveLength(1);

    const failure = await dispatchTool("camera-bookmark", { action: "save", name: "hero" }, ctx).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ToolResultError);
    expect((failure as ToolResultError).result).toMatchObject({
      ok: false,
      op: "SaveCameraBookmark",
      failure_reason: "engine_lacks_op",
      engine_version: "0.5.66",
    });
    expect(calls).toHaveLength(1);
  });

  it("screenshot target:scene resolves framing bookmark + bookmark_name to the wire form and forwards pose/marks params", async () => {
    const scenePreview = vi.fn(async () => ({ ok: true, base64: Buffer.from("x").toString("base64"), mime: "image/jpeg", localPath: "/tmp/x.jpg" }));
    const { ctx } = fakeEngineContext({ scenePreview });
    await dispatchTool(
      "screenshot",
      { target: "scene", framing: "bookmark", bookmark_name: "hero", marks: true, max_marks: 16, fov: 50, camera_path: "Cam" },
      ctx
    );
    expect(scenePreview).toHaveBeenCalledWith({ framing: "bookmark:hero", cameraPath: "Cam", fov: 50, marks: true, maxMarks: 16 });

    await dispatchTool("screenshot", { target: "scene", camera_position: "Vector3(1, 2, 3)", camera_look_at: "Vector3(0, 0, 0)" }, ctx);
    expect(scenePreview).toHaveBeenLastCalledWith({
      framing: "free",
      cameraPosition: "Vector3(1, 2, 3)",
      cameraLookAt: "Vector3(0, 0, 0)",
    });
  });

  it("screenshot refuses contradictory or unknown framings with a readable error before capturing", async () => {
    const scenePreview = vi.fn();
    const { ctx } = fakeEngineContext({ scenePreview });
    await expect(dispatchTool("screenshot", { target: "scene", framing: "bookmark" }, ctx)).rejects.toThrow(/needs bookmark_name/);
    await expect(dispatchTool("screenshot", { target: "scene", framing: "free", camera_position: "Vector3(0, 0, 0)" }, ctx)).rejects.toThrow(/BOTH camera_position/);
    await expect(dispatchTool("screenshot", { target: "scene", framing: "bookmark:hero" }, ctx)).rejects.toThrow(/framing must be one of/);
    await expect(dispatchTool("screenshot", { target: "scene", marks: true, max_marks: 500 }, ctx)).rejects.toThrow(/max_marks/);
    expect(scenePreview).not.toHaveBeenCalled();
  });

  it("play forwards seed/fixed_fps/time_scale as the PlayGame op and flags an engine that returned no determinism block", async () => {
    const play = vi.fn(async () => ({ status: "ok", results: [{ ok: true, op: "PlayGame", playing: true }] }));
    const executeOps = vi.fn(async () => ({ status: "ok", results: [{ ok: true, op: "PlayGame", playing: true }] }));
    const { ctx } = fakeEngineContext({ play, executeOps });

    // focus:true without pins: the legacy /api/play route, byte-for-byte.
    const plain = (await dispatchTool("play", { scene: "res://a.tscn", focus: true }, ctx)) as Record<string, unknown>;
    expect(play).toHaveBeenLastCalledWith("res://a.tscn");
    expect(executeOps).not.toHaveBeenCalled();
    expect(plain).not.toHaveProperty("determinism_note");

    // The quiet default (and any pin) travels as the explicit op (the /api/play
    // rung copies only `scene`); quiet = agent:true. The fake echoes no
    // agent_quiet, so the posture note says the engine predates quiet play.
    const quiet = (await dispatchTool("play", { scene: "res://a.tscn" }, ctx)) as Record<string, unknown>;
    expect(executeOps).toHaveBeenLastCalledWith([{ op: "PlayGame", scene: "res://a.tscn", agent: true }], undefined, 60_000);
    expect(String(quiet.posture_note)).toContain("predates quiet play");

    const pinned = (await dispatchTool("play", { seed: 42, fixed_fps: 60, time_scale: 2, focus: true }, ctx)) as Record<string, unknown>;
    expect(executeOps).toHaveBeenLastCalledWith([{ op: "PlayGame", seed: 42, fixed_fps: 60, time_scale: 2 }], undefined, 60_000);
    expect(String(pinned.determinism_note)).toContain("engine predates determinism params");
    expect(pinned).not.toHaveProperty("posture_note");

    const engineSaid = vi.fn(async () => ({
      status: "ok",
      results: [{ ok: true, op: "PlayGame", playing: true, determinism: { seed: 42, applied: true, args: ["--summer-seed", "42"] } }],
    }));
    const modern = fakeEngineContext({ executeOps: engineSaid });
    const applied = (await dispatchTool("play", { seed: 42 }, modern.ctx)) as Record<string, unknown>;
    expect(applied).not.toHaveProperty("determinism_note");
  });

  it("play validates the pins before touching the engine", async () => {
    const { ctx, calls } = fakeEngineContext();
    await expect(dispatchTool("play", { seed: 1.5 }, ctx)).rejects.toThrow(/seed must be an integer/);
    await expect(dispatchTool("play", { fixed_fps: 0 }, ctx)).rejects.toThrow(/fixed_fps must be an integer > 0/);
    await expect(dispatchTool("play", { time_scale: -1 }, ctx)).rejects.toThrow(/time_scale must be > 0/);
    await expect(dispatchTool("play", { focus: "yes" }, ctx)).rejects.toThrow(/focus must be a boolean/);
    expect(calls).toEqual([]);
  });
});

describe("runtime control dispatch entries (engine Wave I)", () => {
  const runtimeSlugs = [
    "runtime-set",
    "runtime-call",
    "runtime-spawn",
    "runtime-animate",
    "game-control",
    "game-input",
    "game-probe",
  ];

  it("registers all seven runtime tools as engine-required", () => {
    for (const slug of runtimeSlugs) {
      expect(resolveToolDispatch(slug)?.engineRequired, slug).toBe(true);
    }
  });

  it("refuses before sending when the engine advert lacks the RESOLVED kind, as the structured engine_lacks_op receipt", async () => {
    const { ctx, calls } = fakeEngineContext({
      getEngineCapabilities: () => ({ opKinds: ["AddNode", "SpawnRuntimeScene"] }),
      getEngineVersion: () => "0.5.66",
    });
    const failure = await dispatchTool("runtime-spawn", { action: "free", path: "/root/Main/G" }, ctx).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ToolResultError);
    expect((failure as ToolResultError).result).toMatchObject({
      ok: false,
      op: "FreeRuntimeNode",
      failure_reason: "engine_lacks_op",
      engine_version: "0.5.66",
    });
    await expect(dispatchTool("game-control", { action: "pause" }, ctx)).rejects.toThrow(/does not support the GamePause op/);
    expect(calls).toEqual([]);
  });

  it("sends each op alone with instance passthrough and the op's own budget", async () => {
    const { ctx, calls } = fakeEngineContext();
    await dispatchTool("runtime-set", { path: "/root/Main/Player", property: "health", value: 1, instance: "b" }, ctx);
    await dispatchTool("runtime-call", { path: "/root/Main/Boss", method: "take_damage", args: [25] }, ctx);
    await dispatchTool("runtime-animate", { target: "tree", path: "/root/P/Tree", cmd: "travel", state: "Attack" }, ctx);
    await dispatchTool("game-control", { action: "step", frames: 600 }, ctx);
    await dispatchTool(
      "game-input",
      { action: "script", events: [{ at_frame: 0, type: "action", action: "jump", hold_ms: 50 }], wait: false, instance: "a" },
      ctx
    );
    expect(calls.map((call) => call.method)).toEqual(["executeOps", "executeOps", "executeOps", "executeOps", "executeOps"]);
    expect(calls.map((call) => call.args[0])).toEqual([
      [{ op: "SetRuntimeProp", path: "/root/Main/Player", property: "health", value: 1, instance: "b" }],
      [{ op: "CallRuntimeMethod", path: "/root/Main/Boss", method: "take_damage", args: [25] }],
      [{ op: "RuntimeAnimationTree", path: "/root/P/Tree", cmd: "travel", state: "Attack" }],
      [{ op: "GameStep", frames: 600, kind: "physics" }],
      [{ op: "SimulateInputScript", events: [{ at_frame: 0, type: "action", action: "jump", hold_ms: 50 }], clock: "frame", wait: false, instance: "a" }],
    ]);
    expect(calls.map((call) => call.args[2])).toEqual([25_000, 25_000, 25_000, 35_000, 25_000]);
  });

  it("validates with the shared zod contract and the builders before touching the engine", async () => {
    const { ctx, calls } = fakeEngineContext();
    await expect(dispatchTool("game-control", { action: "rewind" }, ctx)).rejects.toThrow(/Invalid arguments for game-control: action/);
    await expect(dispatchTool("game-input", { action: "script" }, ctx)).rejects.toThrow(/non-empty events/);
    await expect(dispatchTool("runtime-animate", { target: "player", path: "/root/A", cmd: "travel" }, ctx)).rejects.toThrow(
      /not an AnimationPlayer command/
    );
    await expect(dispatchTool("game-probe", { max_dim: 8 }, ctx)).rejects.toThrow(/16\.\.4096/);
    expect(calls).toEqual([]);
  });

  it("surfaces runtime gates with the prescriptive text", async () => {
    const { ctx } = fakeEngineContext({
      executeOps: async () => ({
        ok: false,
        results: [{ ok: false, op: "GameStep", failure_reason: "game_breaked", error: "stopped at breakpoint" }],
      }),
    });
    await expect(dispatchTool("game-control", { action: "step" }, ctx)).rejects.toThrow(/breakpoint.*Engine said: stopped at breakpoint/);

    const busy = fakeEngineContext({
      executeOps: async () => ({ ok: false, results: [{ ok: false, op: "SimulateInputScript", failure_reason: "busy", error: "in flight" }] }),
    });
    await expect(
      dispatchTool("game-input", { action: "script", events: [{ type: "action", action: "jump" }] }, busy.ctx)
    ).rejects.toThrow(/one per instance/);
  });

  it("rewrites an old engine's unknown-op answer into engine_lacks_op (no advert, so the pre-flight cannot refuse)", async () => {
    const { ctx } = fakeEngineContext({
      executeOps: async () => ({ ok: false, results: [{ ok: false, op: "GameProbe", error: "unknown op: GameProbe" }] }),
    });
    const failure = await dispatchTool("game-probe", {}, ctx).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ToolResultError);
    expect((failure as ToolResultError).result).toMatchObject({ op: "GameProbe", failure_reason: "engine_lacks_op" });
    expect((failure as ToolResultError).message).toContain("RunVerification probe");
  });

  it("game-probe writes the frame to a file and returns image_path + frame_stamp instead of base64", async () => {
    const { ctx, calls } = fakeEngineContext({
      executeOps: async () => ({
        ok: true,
        results: [
          {
            ok: true,
            op: "GameProbe",
            frame: { process_frames: 42, physics_frames: 40, frames_drawn: 41 },
            image_frame: 42,
            image_base64: Buffer.from("jpegbytes").toString("base64"),
            mime: "image/jpeg",
            width: 16,
            height: 9,
            values: {},
            missing: [],
          },
        ],
      }),
    });
    const result = (await dispatchTool("game-probe", { props: ["/root/Main/Player:position"], instance: "a" }, ctx)) as {
      image_path?: string;
      frame_stamp?: string;
      results: Array<Record<string, unknown>>;
    };
    // The executeOps override above replaces the recorder, so only the shaped result is asserted here;
    // the payload shape is covered by "sends each op alone ..." above.
    expect(calls).toEqual([]);
    expect(result.image_path).toMatch(/game-probe-\d+\.jpg$/);
    expect(result.frame_stamp).toBe("frame 42, physics 40, drawn 41, image_frame 42");
    expect(result.results[0]!.image_base64).toBeUndefined();
  });

  it("play: plain focus uses /api/play; quiet, seed/fixed_fps and instances travel as the PlayGame op; stop {instance} sends StopGame", async () => {
    const { ctx, calls } = fakeEngineContext();
    await dispatchTool("play", { scene: "res://a.tscn", focus: true }, ctx);
    expect(calls).toEqual([{ method: "play", args: ["res://a.tscn"] }]);

    await dispatchTool("play", { seed: 7, fixed_fps: 60 }, ctx);
    expect(calls[1]).toEqual({ method: "executeOps", args: [[{ op: "PlayGame", agent: true, seed: 7, fixed_fps: 60 }], undefined, 60_000] });

    await dispatchTool("play", { instance: "a", mode: "offscreen", deterministic: true }, ctx);
    expect(calls[2]!.args[0]).toEqual([{ op: "PlayGame", instance: "a", mode: "offscreen", deterministic: true }]);

    await dispatchTool("stop", {}, ctx);
    expect(calls[3]!.method).toBe("stop");
    await dispatchTool("stop", { instance: "a" }, ctx);
    expect(calls[4]).toEqual({ method: "executeOps", args: [[{ op: "StopGame", instance: "a" }], undefined, 15_000] });
  });

  it("play refuses an offscreen instance before sending on an engine that provably lacks the runtime-control wave", async () => {
    const { ctx, calls } = fakeEngineContext({
      getEngineCapabilities: () => ({ opKinds: ["PlayGame", "StopGame"] }),
      getEngineVersion: () => "0.5.66",
    });
    const failure = await dispatchTool("play", { instance: "a", mode: "offscreen" }, ctx).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ToolResultError);
    expect((failure as ToolResultError).result).toMatchObject({ op: "ListGameInstances", failure_reason: "engine_lacks_op" });
    // seed alone is fine on such an engine: PlayGame itself is advertised.
    await dispatchTool("play", { seed: 7 }, ctx);
    expect(calls).toHaveLength(1);
    await expect(dispatchTool("play", { mode: "offscreen" }, ctx)).rejects.toThrow(/other than 'main'/);
  });
});
