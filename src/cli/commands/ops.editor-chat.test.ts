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
    ["jobs.wait", ["--job-id", "aj_native-job"]],
    ["jobs.get", ["--job-id", "aj_native-job"]],
    ["assets.generate_3d", ["--prompt", "a chest"]],
    ["assets.generate_image", ["--prompt", "a chest", "--json"]],
    ["jobs.wait", ["--input", '{"jobId":"gen:aj_native-job"}', "--json"]],
    ["jobs.get", ["--job-id=aj_native-job"]],
    ["jobs.wait", ["--input", '{"jobId":"build:1"}', "--job-id", "aj_native-job"]],
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

  it("retains wait instructions for ordinary jobs and omits them only for native assets", async () => {
    vi.stubEnv("SUMMER_EDITOR_CHAT", "1");
    const d = deps();
    expect(await runOpFromCli("games.list", [], d)).toBe(0);
    expect(d.hosted).toHaveBeenCalledTimes(1);
    expect(d.out[0]).toContain("summer jobs wait --job-id gen:1");
    expect(formatAnswer({ ok: true, status: "running", job: { id: "aj_native-job", state: "queued" } })).not.toMatch(/jobs wait/);
  });

  it.each(["build:1", "upload:1", "apr:1", "gen:existing-cli-job", "legacy-generation-id"])("keeps explicit reads and waits for %s", async (jobId) => {
    vi.stubEnv("SUMMER_EDITOR_CHAT", "1");
    for (const op of ["jobs.get", "jobs.wait"]) {
      const d = deps();
      expect(await runOpFromCli(op, ["--input", JSON.stringify({ jobId }), "--json"], d)).toBe(0);
      expect(d.hosted).toHaveBeenCalledWith("summer_call", expect.objectContaining({ op, input: { jobId } }));
    }
  });

  it("honors a job-id flag overriding --input before deciding whether to block", async () => {
    vi.stubEnv("SUMMER_EDITOR_CHAT", "1");
    const d = deps();
    expect(await runOpFromCli("jobs.wait", ["--input", '{"jobId":"aj_native-job"}', "--job-id", "build:1"], d)).toBe(0);
    expect(d.hosted).toHaveBeenCalledWith("summer_call", expect.objectContaining({ op: "jobs.wait", input: { jobId: "build:1" } }));
  });

  it.each([
    ["projects.build", "build:1"],
    ["store.publish", "apr:1"],
    ["makers.bankai_motion", "gen:maker-job"],
    ["assets.generate_video", "gen:video-job"],
  ])("follows %s to completion with --wait", async (op, jobId) => {
    vi.stubEnv("SUMMER_EDITOR_CHAT", "1");
    const d = deps();
    const approval = { id: "a1", who: "owner" as const, summary: "Publish game", url: "https://example.com/approval" };
    const started = op === "store.publish"
      ? { ok: true as const, status: "needs_approval" as const, approval, job: { id: jobId, state: "awaiting_approval" as const } }
      : { ok: true as const, status: "running" as const, job: { id: jobId, state: "queued" as const } };
    d.hosted.mockImplementation(async (_name, args) => envelope(args.op === "jobs.wait"
      ? { ok: true, status: "done", result: { job: { id: jobId, state: "done", result: { completed: true } }, finished: true } }
      : started));

    expect(formatAnswer(started)).toContain(`summer jobs wait --job-id ${jobId}`);
    expect(await runOpFromCli(op, ["--input", "{}", "--wait", "--json"], d)).toBe(0);
    expect(JSON.parse(d.out.at(-1)!)).toMatchObject({ ok: true, status: "done", result: { completed: true } });
    expect(d.hosted.mock.calls.map(([, args]) => args.op)).toEqual([op, "jobs.wait"]);
    expect(d.hosted).toHaveBeenLastCalledWith("summer_call", expect.objectContaining({ op: "jobs.wait", input: { jobId, timeoutSeconds: 50 } }));
  });

  it("stops automatic waiting when an approval hands off to a native asset delivery", async () => {
    vi.stubEnv("SUMMER_EDITOR_CHAT", "1");
    const d = deps();
    d.hosted.mockImplementation(async (_name, args) => envelope(args.op === "jobs.wait"
      ? { ok: true, status: "done", result: { job: { id: "apr:1", state: "done", result: { status: "running", job: { id: "aj_native-job", state: "queued" } } }, finished: true } }
      : { ok: true, status: "needs_approval", approval: { id: "a1", who: "owner", summary: "Approve", url: "https://example.com/approval" }, job: { id: "apr:1", state: "awaiting_approval" } }));
    expect(await runOpFromCli("makers.bankai_motion", ["--input", "{}", "--wait"], d)).toBe(0);
    expect(d.out.at(-1)).toContain("The editor will deliver its result");
    expect(d.out.at(-1)).not.toContain("summer jobs wait");
    expect(d.hosted.mock.calls.filter(([, args]) => args.op === "jobs.wait")).toHaveLength(1);
  });

  it("returns a native job immediately even if an allowed operation was called with --wait", async () => {
    vi.stubEnv("SUMMER_EDITOR_CHAT", "1");
    const d = deps();
    d.hosted.mockResolvedValue(envelope({ ok: true, status: "running", job: { id: "aj_native-job", state: "queued" } }));
    expect(await runOpFromCli("makers.bankai_motion", ["--input", "{}", "--wait", "--json"], d)).toBe(0);
    expect(d.hosted).toHaveBeenCalledTimes(1);
    expect(JSON.parse(d.out[0])).toMatchObject({ ok: true, status: "running", job: { id: "aj_native-job" } });
  });

  it("ops search does not list those operations", async () => {
    vi.stubEnv("SUMMER_EDITOR_CHAT", "1");
    const d = deps();
    d.hosted.mockImplementation(async () => envelope({ ok: true, status: "done", result: { items: [] } }));
    for (const query of ["wait for a job", "generate a 3D model"]) {
      await searchFromCli(query, { limit: 20, json: true }, d);
      const names = (JSON.parse(d.out.pop() ?? "{}").result.items as Array<{ name: string }>).map((item) => item.name);
      expect(names.filter((name) => /^assets\.generate_(3d|image|audio|motion)$/.test(name))).toEqual([]);
    }
    for (const op of ["jobs.wait", "jobs.get", "makers.bankai_motion", "assets.generate_video"]) {
      await searchFromCli(op, { limit: 20, json: true }, d);
      const names = JSON.parse(d.out.pop()!).result.items.map((item: { name: string }) => item.name);
      expect(names).toContain(op);
    }
  });

  it("summer tool refuses the job and generation tools, local and hosted, without running them", async () => {
    vi.stubEnv("SUMMER_EDITOR_CHAT", "1");
    const call = vi.spyOn(hostedCli, "call");
    for (const [name, op] of [["summer_check_job", "jobs.get"], ["summer_generate_3d", "assets.generate_3d"], ["summer_jobs_wait", "jobs.wait"]]) {
      const lines: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
      const previous = process.exitCode;
      process.exitCode = undefined;
      try {
        await toolCommand.parseAsync([name, "--args", '{"jobId":"aj_native-job","prompt":"a chest"}'], { from: "user" });
        expect(process.exitCode).toBe(1);
      } finally {
        process.exitCode = previous;
        log.mockRestore();
      }
      expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: false, error: { code: "unsupported", message: EDITOR_CHAT_REFUSAL, details: { op } } });
    }
    expect(call).not.toHaveBeenCalled();
  });

  it("summer tool forwards build and approval waits and maker operations", async () => {
    vi.stubEnv("SUMMER_EDITOR_CHAT", "1");
    const call = vi.spyOn(hostedCli, "call").mockImplementation(async (name) => ({
      status: "called", tool: name, result: envelope({ ok: true, status: "done", result: {} }),
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    for (const [name, args] of [["summer_jobs_wait", { jobId: "build:1" }], ["summer_jobs_wait", { jobId: "apr:1" }], ["summer_tool_bankai_motion", {}]] as const) {
      await toolCommand.parseAsync([name, "--args", JSON.stringify(args)], { from: "user" });
      expect(call).toHaveBeenLastCalledWith(name, args);
    }
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
