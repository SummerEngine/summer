import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Imported BEFORE any config is written: the gateway must be resolved when the
// beacon fires, not captured at module load.
import { _resetTelemetryPingedForTests, noteFirstRun, recordLocalToolCall, recordMcpSession, TELEMETRY_NOTICE, toolErrorCode } from "./telemetry.js";
import { readStoreText } from "./store.js";
import { saveAuthToken } from "./auth.js";
import { setConfigValue } from "./config.js";
import { setSummerDirForTests } from "./store.js";

let root = "";
const originalGateway = process.env.SUMMER_GATEWAY_URL;
const originalToken = process.env.SUMMER_TOKEN;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-telemetry-test-"));
  setSummerDirForTests(join(root, ".summer"));
  delete process.env.SUMMER_GATEWAY_URL;
  delete process.env.SUMMER_TOKEN;
  _resetTelemetryPingedForTests();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  setSummerDirForTests(null);
  if (originalGateway === undefined) delete process.env.SUMMER_GATEWAY_URL;
  else process.env.SUMMER_GATEWAY_URL = originalGateway;
  if (originalToken === undefined) delete process.env.SUMMER_TOKEN;
  else process.env.SUMMER_TOKEN = originalToken;
  await rm(root, { recursive: true, force: true });
});

/** The beacon is fire-and-forget (two store reads + fetch); wait for it. */
async function flush(seen: string[]): Promise<void> {
  const deadline = Date.now() + 2000;
  while (seen.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("recordMcpSession gateway resolution", () => {
  it("posts to the configured gateway.url, resolved at call time", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown) => {
      seen.push(String(input));
      return new Response("{}", { status: 200 });
    });
    await saveAuthToken("file-token");
    await setConfigValue("gateway.url", "https://staging.example");

    recordMcpSession();
    await flush(seen);

    expect(seen).toEqual(["https://staging.example/api/mcp/log-local-call"]);
  });

  it("lets SUMMER_GATEWAY_URL win over config", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown) => {
      seen.push(String(input));
      return new Response("{}", { status: 200 });
    });
    await saveAuthToken("file-token");
    await setConfigValue("gateway.url", "https://staging.example");
    process.env.SUMMER_GATEWAY_URL = "https://gateway.example/";

    recordMcpSession();
    await flush(seen);

    expect(seen).toEqual(["https://gateway.example/api/mcp/log-local-call"]);
  });
});

describe("telemetry opt-out", () => {
  it("sends no session ping under SUMMER_NO_TELEMETRY=1", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown) => {
      seen.push(String(input));
      return new Response("{}", { status: 200 });
    });
    await saveAuthToken("file-token");
    process.env.SUMMER_NO_TELEMETRY = "1";
    try {
      recordMcpSession();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(seen).toEqual([]);
    } finally {
      delete process.env.SUMMER_NO_TELEMETRY;
    }
  });
});

describe("local tool-call errors", () => {
  const text = (value: unknown) => ({ isError: true, content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });

  it("reads the code a failed result names, never its message", () => {
    expect(toolErrorCode(text({ ok: false, error: { code: "not_signed_in", message: "Sign in at /Users/me/secret" } }))).toBe("not_signed_in");
    expect(toolErrorCode(text({ ok: false, code: "engine_not_running", error: "Summer Engine is not running" }))).toBe("engine_not_running");
    expect(toolErrorCode(text({ ok: false, failure_reason: "engine_lacks_op" }))).toBe("engine_lacks_op");
    expect(toolErrorCode(text("Plain text error"), "transport")).toBe("transport");
    expect(toolErrorCode(text({ ok: false, code: "has spaces and /paths" }))).toBeNull();
  });

  it("sends the code with a failed call, and none with a call that worked", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    });
    await saveAuthToken("file-token");
    recordLocalToolCall({ tool: "summer_play", ok: false, durationMs: 12, error: "engine_not_running" });
    recordLocalToolCall({ tool: "summer_play", ok: true, durationMs: 12, error: "ignored" });
    const deadline = Date.now() + 2000;
    while (bodies.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(bodies.find((body) => body.ok === false)).toMatchObject({ event: "mcp_tool_call", ok: false, error: "engine_not_running" });
    expect(bodies.find((body) => body.ok === true)).not.toHaveProperty("error");
  });
});

describe("usage line fields", () => {
  async function collect(count: number, run: () => void): Promise<Array<Record<string, unknown>>> {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    });
    await saveAuthToken("file-token");
    run();
    const deadline = Date.now() + 2000;
    while (bodies.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    return bodies;
  }

  it("adds the project hash, template and game client count, and drops anything that is not their shape", async () => {
    const hash = "a".repeat(64);
    const [body] = await collect(1, () =>
      recordLocalToolCall({
        tool: "summer_play",
        ok: true,
        durationMs: 5,
        usage: { projectIdHash: hash, templateId: "2d-platformer", instanceCount: 3, templateTags: ["2d", "My Secret Game"] },
      })
    );
    expect(body).toMatchObject({ projectIdHash: hash, templateId: "2d-platformer", instanceCount: 3, templateTags: ["2d"] });
    const [bad] = await collect(1, () =>
      recordLocalToolCall({ tool: "summer_play", ok: true, durationMs: 5, usage: { projectIdHash: "/Users/me/game", templateId: "My Game" } })
    );
    expect(bad).not.toHaveProperty("projectIdHash");
    expect(bad).not.toHaveProperty("templateId");
  });

  it("adds four yes/no engine facts to engine_not_running, and nothing else to other failures", async () => {
    const [notRunning] = await collect(1, () => recordLocalToolCall({ tool: "summer_play", ok: false, durationMs: 5, error: "engine_not_running" }));
    expect(notRunning.engineState).toEqual({ desktopInstalled: expect.any(Boolean), engineRunning: false, projectOpen: false, signedIn: true });
    const [other] = await collect(1, () => recordLocalToolCall({ tool: "summer_play", ok: false, durationMs: 5, error: "invalid_input" }));
    expect(other).not.toHaveProperty("engineState");
  });
});

describe("first run", () => {
  const people = { HOME: process.env.HOME } as NodeJS.ProcessEnv;

  it("prints the notice once to stderr and sends one anonymous line with no project or account data", async () => {
    const printed: string[] = [];
    const sent: Array<Record<string, unknown>> = [];
    const deps = { env: { ...people, CLAUDECODE: "1" }, write: (text: string) => printed.push(text), send: (body: Record<string, unknown>) => sent.push(body) };
    expect(await noteFirstRun("dev", deps)).toBe(true);
    expect(await noteFirstRun("dev", deps)).toBe(false);
    expect(printed).toEqual([`${TELEMETRY_NOTICE}\n\n`]);
    expect(TELEMETRY_NOTICE).toContain("SUMMER_NO_TELEMETRY=1");
    expect(sent).toEqual([
      { client: "summer-cli", event: "cli_first_run", installId: await readStoreText("feedback-install-id"), command: "dev", mcpClient: "claude-code", os: process.platform },
    ]);
  });

  it("prints and sends nothing when opted out or in CI", async () => {
    for (const env of [{ SUMMER_NO_TELEMETRY: "1" }, { DO_NOT_TRACK: "true" }, { CI: "true" }]) {
      const printed: string[] = [];
      const sent: unknown[] = [];
      expect(await noteFirstRun("mcp", { env: { ...people, ...env }, write: (text) => printed.push(text), send: (body) => sent.push(body) })).toBe(false);
      expect(printed).toEqual([]);
      expect(sent).toEqual([]);
    }
    expect(await readStoreText("telemetry-notice")).toBeNull();
  });
});
