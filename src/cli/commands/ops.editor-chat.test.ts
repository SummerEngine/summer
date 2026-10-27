import { afterEach, describe, expect, it, vi } from "vitest";
import { EDITOR_CHAT_REFUSAL } from "../../core/editor-chat.js";
import { formatAnswer, runOpFromCli, searchFromCli, type OpsCliDeps } from "./ops.js";
import { hostedCli, toolCommand } from "./tool.js";

const envelope = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

function deps(): OpsCliDeps & { out: string[]; err: string[]; hosted: ReturnType<typeof vi.fn> } {
  const out: string[] = [];
  const err: string[] = [];
  const hosted = vi.fn(async (_name: string, args: Record<string, unknown>) =>
    args.op === "jobs.wait"
      ? envelope({ ok: true, status: "done", result: { job: { id: "gen:1", state: "done", result: { assetId: "a1" } }, finished: true } })
      : envelope({ ok: true, status: "running", job: { id: "gen:1", state: "queued" } })
  );
  return { hosted, dispatch: vi.fn(async () => ({ ok: true })), print: (text) => out.push(text), printError: (text) => err.push(text), out, err };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("summer in the Summer editor chat (SUMMER_EDITOR_CHAT=1)", () => {
  it.each([
    ["jobs.wait", ["--job-id", "gen:5037aff5"]],
    ["jobs.get", ["--job-id", "gen:5037aff5"]],
    ["assets.generate_3d", ["--prompt", "a chest"]],
    ["assets.generate_image", ["--prompt", "a chest", "--json"]],
    ["makers.bankai_motion", []],
    ["games.list", ["--wait"]],
    ["store.status", ["--wait=true"]],
  ])("%s %j exits 1 at once with the refusal and never calls Summer's server", async (op, argv) => {
    vi.stubEnv("SUMMER_EDITOR_CHAT", "1");
    const d = deps();
    expect(await runOpFromCli(op, argv, d)).toBe(1);
    expect(d.hosted).not.toHaveBeenCalled();
    expect(d.dispatch).not.toHaveBeenCalled();
    expect(d.out).toEqual([]);
    expect(d.err.join("\n")).toContain(EDITOR_CHAT_REFUSAL);
    if (argv.includes("--json")) expect(JSON.parse(d.err[0])).toMatchObject({ ok: false, error: { code: "unsupported", details: { op, reason: "editor_chat" } } });
  });

  it("still runs everything else, and a started job names no wait command", async () => {
    vi.stubEnv("SUMMER_EDITOR_CHAT", "1");
    const d = deps();
    expect(await runOpFromCli("games.list", [], d)).toBe(0);
    expect(d.hosted).toHaveBeenCalledTimes(1);
    expect(d.out[0]).toBe("Started: job gen:1.");
    expect(formatAnswer({ ok: true, status: "running", job: { id: "gen:2", state: "queued" } })).not.toMatch(/jobs wait/);
  });

  it("ops search does not list those operations", async () => {
    vi.stubEnv("SUMMER_EDITOR_CHAT", "1");
    const d = deps();
    d.hosted.mockImplementation(async () => envelope({ ok: true, status: "done", result: { items: [] } }));
    for (const query of ["wait for a job", "generate a 3D model"]) {
      await searchFromCli(query, { limit: 20, json: true }, d);
      const names = (JSON.parse(d.out.pop() ?? "{}").result.items as Array<{ name: string }>).map((item) => item.name);
      expect(names.filter((name) => /^jobs\.(wait|get)$|^assets\.generate_|^makers\./.test(name))).toEqual([]);
    }
  });

  it("summer tool refuses the job and generation tools, local and hosted, without running them", async () => {
    vi.stubEnv("SUMMER_EDITOR_CHAT", "1");
    const call = vi.spyOn(hostedCli, "call");
    for (const [name, op] of [["summer_check_job", "jobs.get"], ["summer_generate_3d", "assets.generate_3d"], ["summer_jobs_wait", "jobs.wait"], ["summer_tool_bankai_motion", "makers.bankai_motion"]]) {
      const lines: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
      const previous = process.exitCode;
      process.exitCode = undefined;
      try {
        await toolCommand.parseAsync([name, "--args", '{"jobId":"gen:1","prompt":"a chest"}'], { from: "user" });
        expect(process.exitCode).toBe(1);
      } finally {
        process.exitCode = previous;
        log.mockRestore();
      }
      expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: false, error: { code: "unsupported", message: EDITOR_CHAT_REFUSAL, details: { op } } });
    }
    expect(call).not.toHaveBeenCalled();
  });
});

describe("summer outside the editor chat", () => {
  it("waits on a generation job with --wait, as before", async () => {
    const d = deps();
    expect(await runOpFromCli("assets.generate_3d", ["--input", '{"prompt":"a chest"}', "--wait", "--json"], d)).toBe(0);
    expect(d.hosted).toHaveBeenCalledWith("summer_call", expect.objectContaining({ op: "jobs.wait" }));
    expect(formatAnswer({ ok: true, status: "running", job: { id: "gen:2", state: "queued" } })).toContain("summer jobs wait --job-id gen:2");
  });
});
