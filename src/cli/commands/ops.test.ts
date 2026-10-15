import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EngineUnavailableError, ToolResultError } from "../../core/capabilities/tool-dispatch.js";
import { formatAnswer, parseCallFlags, runOpFromCli, type OpsCliDeps } from "./ops.js";
import { FileSaver } from "../../core/ops/save-files.js";

const envelope = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

function deps(hosted: OpsCliDeps["hosted"] = vi.fn(async () => envelope({ ok: true, status: "done", result: { items: [] } }))): OpsCliDeps & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { hosted, dispatch: vi.fn(async () => ({ ok: true })), print: (text) => out.push(text), printError: (text) => err.push(text), out, err };
}

describe("flags to input", () => {
  const schema = { type: "object", properties: { limit: { type: "integer" }, query: { type: "string" }, loop: { type: "boolean" }, tags: { type: "array", items: { type: "string" } } } };

  it("types fields by the operation's schema", () => {
    expect(parseCallFlags(["--limit", "5", "--query", "123", "--no-loop", "--tags", "a", "--tags", "b"], schema).input).toEqual({ limit: 5, query: "123", loop: false, tags: ["a", "b"] });
  });

  it("finds a snake_case field from its kebab-case flag", () => {
    const snake = { type: "object", properties: { look_at: { type: "string" }, max_seconds: { type: "number" }, scenePath: { type: "string" } } };
    expect(parseCallFlags(["--look-at", "Vector3(0, 1, 0)", "--max-seconds", "30", "--scene-path", "res://a.tscn"], snake).input).toEqual({ look_at: "Vector3(0, 1, 0)", max_seconds: 30, scenePath: "res://a.tscn" });
  });

  it("takes kebab-case, --name=value and a JSON --input", () => {
    expect(parseCallFlags(["--max-items=3", "--input", '{"gameId":"g1"}'], null).input).toEqual({ gameId: "g1", maxItems: 3 });
  });

  it("keeps the view flags out of the input", () => {
    expect(parseCallFlags(["--json", "--dry-run", "--wait", "--idempotency-key", "k1"], null)).toEqual({ input: {}, json: true, dryRun: true, wait: true, idempotencyKey: "k1" });
  });

  it("refuses a bare word", () => {
    expect(() => parseCallFlags(["tree"], null)).toThrow(/--name value/);
  });
});

describe("summer <area> <action>", () => {
  it("runs a cloud operation through the hosted summer_call and prints the envelope with --json", async () => {
    const d = deps(vi.fn(async (name: string, args: Record<string, unknown>) =>
      name === "summer_call" && args.op === "ops.describe"
        ? envelope({ ok: true, status: "done", result: { operation: { input: { type: "object", properties: { limit: { type: "integer" } } } } } })
        : envelope({ ok: true, status: "done", result: { items: [{ gameId: "g1" }], nextCursor: null } })
    ));
    expect(await runOpFromCli("games.list", ["--limit", "3", "--json"], d)).toBe(0);
    expect(d.hosted).toHaveBeenLastCalledWith("summer_call", { op: "games.list", input: { limit: 3 } });
    expect(JSON.parse(d.out[0])).toMatchObject({ ok: true, result: { items: [{ gameId: "g1" }] } });
  });

  it("runs a local operation in process", async () => {
    const d = deps();
    expect(await runOpFromCli("docs.search", ["--query", "lobby"], d)).toBe(0);
    expect(d.dispatch).toHaveBeenCalledWith("summer_search_library", { query: "lobby" });
    expect(d.hosted).not.toHaveBeenCalled();
  });

  it("prints the approval link and exits 0: waiting for a person is not an error", async () => {
    const d = deps(vi.fn(async () => envelope({ ok: true, status: "needs_approval", approval: { id: "a1", url: "https://www.summerengine.com/studio/approvals/a1", who: "owner", summary: "Lower the price" }, job: { id: "apr:a1", state: "awaiting_approval" } })));
    expect(await runOpFromCli("pricing.set_base", ["--input", '{"gameId":"g1"}'], d)).toBe(0);
    expect(d.out[0]).toContain("https://www.summerengine.com/studio/approvals/a1");
  });

  it("prints an error with its one next step and exits 1", async () => {
    const d = deps(vi.fn(async () => envelope({ ok: false, error: { code: "no_credits", message: "Not enough credits.", next: { url: "https://www.summerengine.com/studio/credits", label: "Add credits" }, retry: "no" } })));
    expect(await runOpFromCli("assets.generate_3d", ["--input", '{"prompt":"tree"}'], d)).toBe(1);
    expect(d.err[0]).toBe("Error (no_credits): Not enough credits.\nNext: Add credits: https://www.summerengine.com/studio/credits");
  });

  it("follows a job to the end with --wait", async () => {
    const hosted = vi
      .fn()
      .mockResolvedValueOnce(envelope({ ok: true, status: "running", job: { id: "gen:7", state: "queued" } }))
      .mockResolvedValueOnce(envelope({ ok: true, status: "done", result: { job: { state: "done", result: { assetId: "a9" } }, finished: true } }));
    const d = deps(hosted);
    expect(await runOpFromCli("assets.generate_3d", ["--input", '{"prompt":"tree"}', "--wait", "--json"], d)).toBe(0);
    expect(hosted).toHaveBeenLastCalledWith("summer_call", { op: "jobs.wait", input: { jobId: "gen:7", timeoutSeconds: 50 } });
    expect(JSON.parse(d.out[0])).toEqual({ ok: true, status: "done", result: { assetId: "a9" } });
  });

  it("says when the hosted catalog is not switched on", async () => {
    const d = deps(vi.fn(async () => ({ content: [{ type: "text", text: "MCP error -32602: Tool summer_call not found" }], isError: true })));
    expect(await runOpFromCli("games.list", [], d)).toBe(1);
    expect(d.err[0]).toContain("unavailable");
  });

  it("refuses a name that is not an operation", async () => {
    const d = deps();
    expect(await runOpFromCli("Games.List", [], d)).toBe(1);
  });
});

describe("summer engine <action>", () => {
  it("runs a split operation as its 3.x tool with the action fixed", async () => {
    const d = deps();
    expect(await runOpFromCli("engine.save_camera_bookmark", ["--name", "hero", "--json"], d)).toBe(0);
    expect(d.dispatch).toHaveBeenCalledWith("summer_camera_bookmark", { name: "hero", action: "save" });
  });

  it("checks required fields before anything runs, and points at the tool's guide", async () => {
    const d = deps();
    expect(await runOpFromCli("engine.save_camera_bookmark", ["--json"], d)).toBe(1);
    expect(d.dispatch).not.toHaveBeenCalled();
    expect(JSON.parse(d.err[0])).toMatchObject({ ok: false, error: { code: "invalid_input", message: "name: required.", next: { op: "docs.read", input: { id: "tool/camera-bookmark" } } } });
  });

  it("dry-runs without the engine", async () => {
    const d = deps();
    expect(await runOpFromCli("engine.add_node", ["--scene-path", "res://main.tscn", "--parent", ".", "--type", "Node3D", "--name", "A", "--dry-run", "--json"], d)).toBe(0);
    expect(d.dispatch).not.toHaveBeenCalled();
    expect(JSON.parse(d.out[0])).toMatchObject({ ok: true, status: "dry_run", preview: { valid: true } });
  });

  it("says engine_not_running with one next step, and maps the engine's failures", async () => {
    const down = deps();
    down.dispatch = vi.fn(async () => {
      throw new EngineUnavailableError("Summer Engine is not running.");
    });
    expect(await runOpFromCli("engine.get_scene_tree", ["--json"], down)).toBe(1);
    expect(JSON.parse(down.err[0])).toMatchObject({ ok: false, error: { code: "engine_not_running", next: { say: expect.stringContaining("Open the project") }, retry: "safe" } });

    const lacks = deps();
    lacks.dispatch = vi.fn(async () => {
      throw new ToolResultError({ ok: false, failure_reason: "engine_lacks_op", error: "This engine build lacks RunSceneScript." }, "lacks");
    });
    expect(await runOpFromCli("engine.run_script", ["--source", "func run(ctx): pass", "--json"], lacks)).toBe(1);
    expect(JSON.parse(lacks.err[0])).toMatchObject({ ok: false, error: { code: "engine_lacks_op", next: { say: "Update Summer Engine." } } });
  });
});

describe("human output", () => {
  it("says how to follow a running job", () => {
    expect(formatAnswer({ ok: true, status: "running", job: { id: "gen:1", state: "queued" } })).toBe("Started: job gen:1. Wait for it: summer jobs wait --job-id gen:1");
  });
});

describe("generated files", () => {
  it("saves a waited job's files where --out says, and never sends --out", async () => {
    const root = await mkdtemp(join(tmpdir(), "summer-ops-cli-out-"));
    try {
      const hosted = vi
        .fn()
        .mockResolvedValueOnce(envelope({ ok: true, status: "done", result: { operation: { name: "assets.generate_3d", input: { type: "object", properties: { prompt: { type: "string" } } } } } }))
        .mockResolvedValueOnce(envelope({ ok: true, status: "running", job: { id: "gen:7", state: "queued" } }))
        .mockResolvedValueOnce(envelope({ ok: true, status: "done", result: { job: { id: "gen:7", kind: "gen", state: "done", result: { assetId: "m1", fileUrl: "https://cdn.example.com/m1.glb" } }, finished: true } }));
      const fetch = vi.fn(async () => new Response("glb bytes", { status: 200 })) as unknown as typeof globalThis.fetch;
      const d = { ...deps(hosted), files: new FileSaver({ saveByDefault: false, cwd: () => root, fetch }) };
      expect(await runOpFromCli("assets.generate_3d", ["--prompt", "tree", "--out", "models", "--wait", "--json"], d)).toBe(0);
      expect(hosted).toHaveBeenNthCalledWith(2, "summer_call", { op: "assets.generate_3d", input: { prompt: "tree" } });
      expect(JSON.parse(d.out[0]).result.localPath).toBe(join(root, "models", "m1.glb"));
      expect(await readFile(join(root, "models", "m1.glb"), "utf8")).toBe("glb bytes");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
