import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EngineUnavailableError,
  ToolDispatchError,
  dispatchTool,
  listToolDispatches,
  resolveToolDispatch,
  type ToolDispatchContext,
} from "./tool-dispatch.js";

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

describe("tool-dispatch registry", () => {
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
