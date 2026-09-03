import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../server.js", () => ({
  getClient: vi.fn(),
  resetClient: vi.fn(),
}));

vi.mock("../../core/telemetry.js", () => ({
  recordMcpSession: vi.fn(),
}));

import { getClient } from "../server.js";
import { registerEventTools } from "./event-tools.js";
import { EVENT_KINDS_V1 } from "../../core/capabilities/events.js";

type RegisteredTool = {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

function tools(): RegisteredTool[] {
  const registered: RegisteredTool[] = [];
  registerEventTools({
    tool(
      name: string,
      _description: string,
      _schema: Record<string, unknown>,
      handler: (args: Record<string, unknown>) => Promise<unknown>
    ) {
      registered.push({ name, handler });
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
  const envelope = result as { content?: Array<{ text?: string }> };
  return envelope.content?.[0]?.text ?? "";
}

const WITH_CHANNEL = { events: { kinds: [...EVENT_KINDS_V1], ring: 512, sse: true, poll: true } };

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.SUMMER_CAPABILITY_PREFLIGHT;
});

describe("summer_wait_for_event", () => {
  it("registers both events tools", () => {
    expect(tools().map((entry) => entry.name)).toEqual(["summer_wait_for_event", "summer_recent_events"]);
  });

  it("refuses BEFORE sending when /api/health advertises capabilities without an events block", async () => {
    const pollEvents = vi.fn();
    vi.mocked(getClient).mockResolvedValue({
      pollEvents,
      getEngineCapabilities: () => ({ opKinds: ["AddNode"], singleOnlyOps: ["SaveScene"] }),
      getEngineVersion: () => "0.5.70",
    } as never);

    const result = (await tool("summer_wait_for_event").handler({ kinds: ["play.started"] })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(pollEvents).not.toHaveBeenCalled();
    expect(text(result)).toContain("engine_lacks_events");
    expect(text(result)).toContain("0.5.70");
    expect(text(result)).toContain("summer_is_running");
    expect(text(result)).not.toContain("engine_lacks_op");
  });

  it("refuses when the engine advertises no capabilities at all (absence proves the channel is missing)", async () => {
    const pollEvents = vi.fn();
    vi.mocked(getClient).mockResolvedValue({ pollEvents, getEngineCapabilities: () => undefined } as never);
    const result = (await tool("summer_wait_for_event").handler({})) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("engine_lacks_events");
    expect(pollEvents).not.toHaveBeenCalled();
  });

  it("waits through the channel and returns the matched event with the next cursor", async () => {
    const pollEvents = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, events: [], next_seq: 9, since: 9, timed_out: true })
      .mockResolvedValueOnce({
        ok: true,
        events: [{ seq: 10, kind: "play.started", ts: 1, data: { scene: "res://main.tscn", by: "agent" } }],
        next_seq: 10,
        timed_out: false,
      });
    vi.mocked(getClient).mockResolvedValue({
      pollEvents,
      getEngineCapabilities: () => WITH_CHANNEL,
      getEngineVersion: () => "0.6.0",
    } as never);

    const result = (await tool("summer_wait_for_event").handler({ kinds: ["play.started"], timeout_seconds: 30 })) as {
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(text(result)) as Record<string, unknown>;
    expect(parsed).toMatchObject({ ok: true, matched: true, next_seq: 10, since: 9, timed_out: false, polls: 2 });
    expect(pollEvents.mock.calls[0]![0]).toMatchObject({ kinds: ["play.started"], limit: 20 });
    expect(pollEvents.mock.calls[0]![0].wait).toBeLessThanOrEqual(25_000);
    expect(pollEvents.mock.calls[1]![0]).toMatchObject({ since: 9 });
  });

  it("reports a timeout as a plain (non-error) result with timed_out:true and no fabricated events", async () => {
    const pollEvents = vi.fn().mockResolvedValue({ ok: true, events: [], next_seq: 3, since: 3, timed_out: true });
    vi.mocked(getClient).mockResolvedValue({ pollEvents, getEngineCapabilities: () => WITH_CHANNEL } as never);

    const result = (await tool("summer_wait_for_event").handler({ kinds: ["scene.saved"], timeout_seconds: 1 })) as {
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(text(result)) as Record<string, unknown>;
    expect(parsed).toMatchObject({ ok: true, matched: false, events: [], timed_out: true, next_seq: 3 });
    expect(String(parsed.hint)).toContain("never claim an event you did not receive");
  });

  it("refuses an unknown kind as a structured input failure, nothing sent", async () => {
    const pollEvents = vi.fn();
    vi.mocked(getClient).mockResolvedValue({ pollEvents, getEngineCapabilities: () => WITH_CHANNEL } as never);
    const result = (await tool("summer_wait_for_event").handler({ kinds: ["game.started"] })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("unknown_event_kind");
    expect(pollEvents).not.toHaveBeenCalled();
  });

  it("with SUMMER_CAPABILITY_PREFLIGHT=off sends anyway and rewrites the engine's 404 into engine_lacks_events", async () => {
    process.env.SUMMER_CAPABILITY_PREFLIGHT = "off";
    const pollEvents = vi.fn().mockResolvedValue({ ok: false, http_status: 404, error: "Engine API error 404: not found" });
    vi.mocked(getClient).mockResolvedValue({
      pollEvents,
      getEngineCapabilities: () => ({ opKinds: ["AddNode"] }),
      getEngineVersion: () => "0.5.70",
    } as never);
    const result = (await tool("summer_wait_for_event").handler({})) as { isError?: boolean };
    expect(pollEvents).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("engine_lacks_events");
    expect(text(result)).toContain("HTTP 404");
  });

  it("surfaces a 409 identity_mismatch with the rebind hint (no retry, nothing fabricated)", async () => {
    const pollEvents = vi
      .fn()
      .mockResolvedValue({ ok: false, http_status: 409, terminalState: "identity_mismatch", errorClass: "rejected_identity" });
    vi.mocked(getClient).mockResolvedValue({ pollEvents, getEngineCapabilities: () => WITH_CHANNEL } as never);
    const result = (await tool("summer_wait_for_event").handler({})) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("identity_mismatch");
    expect(text(result)).toContain("summer_get_project_context");
    expect(pollEvents).toHaveBeenCalledTimes(1);
  });
});

describe("summer_recent_events", () => {
  it("shares the pre-flight: engine_lacks_events before sending", async () => {
    const pollEvents = vi.fn();
    vi.mocked(getClient).mockResolvedValue({ pollEvents, getEngineCapabilities: () => ({ opKinds: [] }) } as never);
    const result = (await tool("summer_recent_events").handler({})) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("engine_lacks_events");
    expect(pollEvents).not.toHaveBeenCalled();
  });

  it("reads the newest window with two zero-wait polls and returns the cursor", async () => {
    const pollEvents = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, events: [], next_seq: 100, last_seq: 100, since: 100 })
      .mockResolvedValueOnce({
        ok: true,
        events: [{ seq: 99, kind: "scene.saved", data: { path: "res://main.tscn", by: "human" } }, { seq: 100, kind: "play.stopped" }],
        next_seq: 100,
        last_seq: 100,
        since: 90,
      });
    vi.mocked(getClient).mockResolvedValue({ pollEvents, getEngineCapabilities: () => WITH_CHANNEL } as never);
    const result = (await tool("summer_recent_events").handler({ limit: 10 })) as { isError?: boolean };
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(text(result)) as Record<string, unknown>;
    expect(parsed).toMatchObject({ ok: true, count: 2, next_seq: 100, since: 90, window: "newest" });
    expect(pollEvents.mock.calls.map((call) => call[0])).toEqual([
      { wait: 0, limit: 1 },
      { since: 90, kinds: undefined, wait: 0, limit: 10 },
    ]);
  });
});
