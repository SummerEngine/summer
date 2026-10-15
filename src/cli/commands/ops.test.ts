import { describe, expect, it, vi } from "vitest";
import { formatAnswer, parseCallFlags, runOpFromCli, type OpsCliDeps } from "./ops.js";

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

describe("human output", () => {
  it("says how to follow a running job", () => {
    expect(formatAnswer({ ok: true, status: "running", job: { id: "gen:1", state: "queued" } })).toBe("Started: job gen:1. Wait for it: summer jobs wait --job-id gen:1");
  });
});
