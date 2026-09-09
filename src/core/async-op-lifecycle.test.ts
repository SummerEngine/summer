import { describe, it, expect } from "vitest";

import {
  classifyOpsResponse,
  isTerminalStatus,
  pollOpToTerminal,
} from "./async-op-lifecycle.js";

describe("classifyOpsResponse", () => {
  it("treats HTTP 202 as queued and extracts the requestId", () => {
    expect(
      classifyOpsResponse(202, { accepted: true, status: "queued", requestId: "abc" })
    ).toEqual({ mode: "queued", requestId: "abc" });
  });

  it("treats a queued-shaped 200 body as queued (inspects the body, not just the status)", () => {
    expect(
      classifyOpsResponse(200, { accepted: true, status: "queued", requestId: "xyz" })
    ).toEqual({ mode: "queued", requestId: "xyz" });
  });

  it("treats a plain 200 apply result as legacy", () => {
    const body = { status: "ok", results: [] };
    expect(classifyOpsResponse(200, body)).toEqual({ mode: "legacy", legacyResult: body });
  });
});

describe("pollOpToTerminal", () => {
  it("polls until terminal and merges terminalState/appliedSeq onto the apply dict", async () => {
    const frames = [
      { requestId: "r", status: "running" },
      { requestId: "r", status: "running", appliedSeq: 1 },
      {
        requestId: "r",
        status: "done",
        result: { status: "ok", results: [{ ok: true }] },
        terminalState: "applied",
        appliedSeq: 2,
      },
    ];
    let i = 0;
    const out = await pollOpToTerminal(async () => frames[Math.min(i++, frames.length - 1)], {
      totalTimeoutMs: 10_000,
      sleep: async () => {},
    });
    expect(out.status).toBe("ok");
    expect(out.requestId).toBe("r");
    expect(out.terminalState).toBe("applied");
    expect(out.appliedSeq).toBe(2);
  });

  it("returns a truthful still-running receipt when the op never advances", async () => {
    let t = 0;
    const out = await pollOpToTerminal(async () => ({ requestId: "r", status: "running" }), {
      totalTimeoutMs: 1000,
      noProgressTimeoutMs: 500,
      requestId: "r",
      now: () => (t += 600), // each tick jumps 600ms -> trips the 500ms no-progress budget
      sleep: async () => {},
    });
    expect(out.terminalState).toBe("still_running");
    expect(out.errorClass).toBe("transient");
    expect(out.requestId).toBe("r");
    expect(out.dispatchState).toBe("sent");
    expect(out.error).toMatch(/may still be running|inspect/i);
  });

  it("does not claim an accepted queued operation was never applied", async () => {
    let t = 0;
    const out = await pollOpToTerminal(async () => ({ requestId: "q", status: "queued" }), {
      totalTimeoutMs: 1000,
      noProgressTimeoutMs: 500,
      requestId: "q",
      now: () => (t += 600),
      sleep: async () => {},
    });
    expect(out).toMatchObject({
      terminalState: "still_queued",
      dispatchState: "accepted",
      requestId: "q",
      lastKnownStatus: "queued",
    });
    expect(String(out.error)).toContain("may still run");
  });
});

describe("isTerminalStatus", () => {
  it("recognizes terminal vs non-terminal statuses", () => {
    expect(isTerminalStatus("done")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("canceled")).toBe(true);
    expect(isTerminalStatus("running")).toBe(false);
    expect(isTerminalStatus(undefined)).toBe(false);
  });
});
