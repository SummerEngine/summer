import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Transient-disconnect recovery, NARROWED for mutation-safety.
 *
 * The engine rotates its api-token on every launch and can move ports, so a
 * restart that lands DURING a tool call shows up as a stale-token 401 or a
 * connect failure. withEngine retries ONCE, but only where nothing could have
 * been applied:
 *   - a connect/preflight failure (getClient threw — request never submitted)
 *   - a stale-token 401/403 (engine rejects at auth, before queue/apply)
 *
 * It must NOT retry:
 *   - a generic connection error thrown from INSIDE the tool closure (could be a
 *     disconnect mid-operation where a mutation already partially applied, and
 *     the MCP sends no idempotency key the engine can dedup on)
 *   - soft failure terminal states (not_connected / identity_mismatch): a retry
 *     cannot fix a project switch — surface it
 *   - ambiguous/intentional failures (timed_out / invalid op / 5xx)
 */

const mockGetClient = vi.fn();
const mockResetClient = vi.fn();

vi.mock("../server.js", () => ({
  getClient: (...args: unknown[]) => mockGetClient(...args),
  resetClient: (...args: unknown[]) => mockResetClient(...args),
}));

vi.mock("../../core/telemetry.js", () => ({
  recordMcpSession: vi.fn(),
}));

import { withEngine, isAuthError } from "./with-engine.js";

afterEach(() => vi.clearAllMocks());

function resultText(res: { content: { text?: string }[]; isError?: boolean }): string {
  return res.content[0]?.text ?? "";
}

describe("withEngine — safe retry only where nothing could have applied", () => {
  it("retries once after a stale-token 401 (pre-apply auth reject) and recovers", async () => {
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

  it("retries a connect/preflight failure (getClient threw — nothing submitted)", async () => {
    let getCalls = 0;
    mockGetClient.mockImplementation(async () => {
      getCalls += 1;
      if (getCalls === 1) throw new Error("Summer Engine is not running");
      return {};
    });
    let fnCalls = 0;
    const res = await withEngine(async () => {
      fnCalls += 1;
      return { ok: true, value: 7 };
    });
    expect(getCalls).toBe(2);
    expect(fnCalls).toBe(1);
    expect(res.isError).toBeFalsy();
    expect(resultText(res)).toContain("7");
  });

  it("does NOT retry a generic connection error thrown from inside fn (may be mid-mutation)", async () => {
    mockGetClient.mockResolvedValue({});
    let calls = 0;
    const res = await withEngine(async () => {
      calls += 1;
      throw new Error("fetch failed"); // ECONNREFUSED after submission — unsafe to retry
    });
    expect(calls).toBe(1); // no double-submit
    expect(mockResetClient).toHaveBeenCalled(); // still drops the stale client
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/fetch failed/i);
  });

  it("surfaces a not_connected terminalState without retrying", async () => {
    mockGetClient.mockResolvedValue({});
    let calls = 0;
    const res = await withEngine(async () => {
      calls += 1;
      return { terminalState: "not_connected" };
    });
    expect(calls).toBe(1);
    expect(res.isError).toBe(true);
  });

  it("surfaces identity_mismatch (project switch) without retrying — a retry can't fix it", async () => {
    mockGetClient.mockResolvedValue({});
    let calls = 0;
    const res = await withEngine(async () => {
      calls += 1;
      return { terminalState: "identity_mismatch", error: "projectIdHash mismatch" };
    });
    expect(calls).toBe(1);
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/mismatch/i);
  });

  it("does NOT retry an ambiguous timed_out (op may have landed) — surfaces it", async () => {
    mockGetClient.mockResolvedValue({});
    let calls = 0;
    const res = await withEngine(async () => {
      calls += 1;
      return { terminalState: "timed_out" };
    });
    expect(calls).toBe(1);
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

  it("surfaces the disconnect after a 401 that persists across the retry", async () => {
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

  it("does NOT retry a 500 (may have mutated) — surfaces and resets", async () => {
    mockGetClient.mockResolvedValue({});
    let calls = 0;
    const res = await withEngine(async () => {
      calls += 1;
      throw new Error("Engine API error 500: internal");
    });
    expect(calls).toBe(1);
    expect(mockResetClient).toHaveBeenCalled();
    expect(res.isError).toBe(true);
  });
});

describe("isAuthError", () => {
  it("matches 401/403/unauthorized only", () => {
    expect(isAuthError(new Error("Engine API error 401: x"))).toBe(true);
    expect(isAuthError(new Error("Engine API error 403"))).toBe(true);
    expect(isAuthError(new Error("Unauthorized"))).toBe(true);
  });

  it("does NOT match connection/timeout errors (unsafe to retry from inside fn)", () => {
    expect(isAuthError(new Error("fetch failed"))).toBe(false);
    expect(isAuthError(new Error("ECONNREFUSED"))).toBe(false);
    expect(isAuthError(new Error("The operation timed out"))).toBe(false);
    expect(isAuthError(new Error("Engine API error 500"))).toBe(false);
  });
});
