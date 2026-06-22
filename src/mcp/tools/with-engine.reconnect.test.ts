import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Transient-disconnect recovery. The engine rotates its api-token on every launch
 * and can move ports, so a restart that lands DURING a tool call shows up as a
 * stale-token 401, an ECONNREFUSED on the old port, or a soft `not_connected` /
 * `identity_mismatch` terminal state. withEngine must drop the cached client and
 * retry ONCE so the drop heals itself instead of surfacing as "disconnected".
 *
 * It must NOT retry ambiguous/intentional failures (timed_out / content_mismatch
 * / denied / canceled) — those could double-apply a mutation or mask user intent.
 */

const mockGetClient = vi.fn();
const mockResetClient = vi.fn();

vi.mock("../server.js", () => ({
  getClient: (...args: unknown[]) => mockGetClient(...args),
  resetClient: (...args: unknown[]) => mockResetClient(...args),
}));

vi.mock("../../lib/telemetry.js", () => ({
  recordMcpSession: vi.fn(),
}));

import { withEngine } from "./with-engine.js";

afterEach(() => vi.clearAllMocks());

function resultText(res: { content: { text: string }[]; isError?: boolean }): string {
  return res.content[0]?.text ?? "";
}

describe("withEngine — transparent reconnect on a transient drop", () => {
  it("retries once after a stale-token 401 and returns the recovered result", async () => {
    mockGetClient.mockResolvedValue({});
    let calls = 0;
    const res = await withEngine(async () => {
      calls += 1;
      if (calls === 1) throw new Error("Engine API error 401: bad token");
      return { ok: true, value: 42 };
    });
    expect(calls).toBe(2);
    expect(mockResetClient).toHaveBeenCalled();
    expect(res.isError).toBeFalsy();
    expect(resultText(res)).toContain("42");
  });

  it("retries once after an ECONNREFUSED on the old port", async () => {
    mockGetClient.mockResolvedValue({});
    let calls = 0;
    const res = await withEngine(async () => {
      calls += 1;
      if (calls === 1) throw new Error("fetch failed");
      return { ok: true };
    });
    expect(calls).toBe(2);
    expect(res.isError).toBeFalsy();
  });

  it("retries once on a soft not_connected terminalState (nothing applied) then succeeds", async () => {
    mockGetClient.mockResolvedValue({});
    let calls = 0;
    const res = await withEngine(async () => {
      calls += 1;
      if (calls === 1) return { terminalState: "not_connected" };
      return { status: "ok", terminalState: "applied", results: [{ ok: true, op: "AddNode" }] };
    });
    expect(calls).toBe(2);
    expect(mockResetClient).toHaveBeenCalled();
    expect(res.isError).toBeFalsy();
  });

  it("retries once on identity_mismatch (wrong instance — never mutated) then succeeds", async () => {
    mockGetClient.mockResolvedValue({});
    let calls = 0;
    const res = await withEngine(async () => {
      calls += 1;
      if (calls === 1) return { terminalState: "identity_mismatch" };
      return { status: "ok", terminalState: "applied", results: [{ ok: true }] };
    });
    expect(calls).toBe(2);
    expect(res.isError).toBeFalsy();
  });

  it("does NOT retry an ambiguous timed_out (op may have landed) — surfaces it", async () => {
    mockGetClient.mockResolvedValue({});
    let calls = 0;
    const res = await withEngine(async () => {
      calls += 1;
      return { terminalState: "timed_out" };
    });
    expect(calls).toBe(1); // no double-submit
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/tim/i);
  });

  it("does NOT retry a normal op failure (invalid value) — surfaces immediately", async () => {
    mockGetClient.mockResolvedValue({});
    let calls = 0;
    const res = await withEngine(async () => {
      calls += 1;
      return { results: [{ ok: false, op: "SetProp", error: "invalid value" }] };
    });
    expect(calls).toBe(1);
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("invalid value");
  });

  it("surfaces the disconnect after the retry also fails (engine truly down)", async () => {
    mockGetClient.mockResolvedValue({});
    let calls = 0;
    const res = await withEngine(async () => {
      calls += 1;
      throw new Error("Engine API error 401: still bad");
    });
    expect(calls).toBe(2);
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/401/);
  });

  it("still resets the client on a non-retriable throw (preserves prior behavior)", async () => {
    mockGetClient.mockResolvedValue({});
    let calls = 0;
    const res = await withEngine(async () => {
      calls += 1;
      throw new Error("Engine API error 500: internal");
    });
    expect(calls).toBe(1); // a 500 may have mutated — do not retry
    expect(mockResetClient).toHaveBeenCalled();
    expect(res.isError).toBe(true);
  });
});
