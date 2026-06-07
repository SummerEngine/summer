import { describe, it, expect } from "vitest";

import { extractOpError } from "./with-engine.js";

/**
 * 0.5.34 Block E follow-up — the CLI/MCP must NOT repeat the web's
 * "no-results envelope = silent success" masking (publicsummerengine cf17134f)
 * or the dual-shape blindness fixed in 81b825f7.
 *
 * extractOpError is the SOLE result-interpreter for every mutating MCP tool
 * (everything routed through withEngine -> executeOps/play/stop). The async
 * lifecycle (pollOpToTerminal) merges terminalState/errorClass onto the apply
 * dict; a failure terminalState or a missing results[] on a mutation must be
 * reported as a failure, never as applied.
 */
describe("extractOpError — genuine successes (must stay null)", () => {
  it("returns null for a normal applied result with results[]", () => {
    expect(
      extractOpError({
        status: "ok",
        terminalState: "applied",
        appliedSeq: 3,
        results: [{ ok: true, op: "AddNode" }],
      })
    ).toBeNull();
  });

  it("returns null for a no_op terminalState (legitimately applied nothing)", () => {
    // no_op is a SUCCESS terminal state per the contract. It may carry no
    // results[] — that must NOT be flagged as a failure.
    expect(extractOpError({ terminalState: "no_op" })).toBeNull();
  });

  it("returns null for read-style state envelopes that carry no results[]", () => {
    // State reads (health, scene, project) legitimately have no results[].
    // Only MUTATION envelopes are required to carry results[]; a read with
    // ok:true / no results[] is fine.
    expect(extractOpError({ ok: true, data: { children: [] } })).toBeNull();
    expect(extractOpError({ scene: "res://main.tscn", ok: true })).toBeNull();
  });
});

describe("extractOpError — explicit failure signals (already caught)", () => {
  it("catches top-level ok:false + error", () => {
    expect(extractOpError({ ok: false, error: "node not found" })).toBe(
      "node not found"
    );
  });

  it("catches status:error + error (poll-loop synthetic timeout)", () => {
    expect(
      extractOpError({
        status: "error",
        error: "Tool timeout - Summer Engine may be unresponsive",
      })
    ).toBe("Tool timeout - Summer Engine may be unresponsive");
  });

  it("catches a failed op inside results[]", () => {
    expect(
      extractOpError({
        status: "ok",
        results: [
          { ok: true, op: "AddNode" },
          { ok: false, op: "SetProp", error: "invalid value" },
        ],
      })
    ).toBe("invalid value");
  });

  it("catches a failed op inside results[] even with no error string", () => {
    const err = extractOpError({ results: [{ ok: false, op: "SetProp" }] });
    expect(err).not.toBeNull();
    expect(err).toMatch(/SetProp/);
  });

  it("catches a bare ok:false envelope with no error string (queue-full / backpressure shape)", () => {
    // The engine's queue-full backpressure body is {ok:false, error:"queue full",
    // errorClass:"transient"}; harden against the no-error variant too.
    expect(extractOpError({ ok: false })).not.toBeNull();
    expect(extractOpError({ ok: false, error: "queue full", errorClass: "transient" })).toBe(
      "queue full"
    );
  });
});

describe("extractOpError — failure terminalState with NO results[] (the cf17134f masking class)", () => {
  it("flags timed_out (async no-progress timeout) as a failure", () => {
    const err = extractOpError({ terminalState: "timed_out", errorClass: "transient" });
    expect(err).not.toBeNull();
    expect(err).toMatch(/tim/i);
  });

  it("flags identity_mismatch (wrong project/instance — never mutated) as a failure", () => {
    const err = extractOpError({ terminalState: "identity_mismatch", errorClass: "rejected_identity" });
    expect(err).not.toBeNull();
    expect(err).toMatch(/identity/i);
  });

  it("flags denied (approval rejected) as a failure", () => {
    expect(extractOpError({ terminalState: "denied" })).not.toBeNull();
  });

  it("flags not_connected (engine gone) as a failure", () => {
    expect(extractOpError({ terminalState: "not_connected" })).not.toBeNull();
  });

  it("flags content_mismatch as a failure", () => {
    expect(extractOpError({ terminalState: "content_mismatch" })).not.toBeNull();
  });

  it("flags canceled (user pressed Stop) as a failure", () => {
    expect(extractOpError({ terminalState: "canceled" })).not.toBeNull();
  });

  it("surfaces the engine's verbatim error when present alongside a failure terminalState", () => {
    expect(
      extractOpError({ terminalState: "identity_mismatch", error: "projectIdHash mismatch: aaa != bbb" })
    ).toBe("projectIdHash mismatch: aaa != bbb");
  });

  it("prefers the engine error string over the synthesized terminalState message", () => {
    expect(
      extractOpError({ terminalState: "timed_out", error: "queue full" })
    ).toBe("queue full");
  });
});

describe("extractOpError — non-records", () => {
  it("returns null for null/undefined/primitives", () => {
    expect(extractOpError(null)).toBeNull();
    expect(extractOpError(undefined)).toBeNull();
    expect(extractOpError("nope")).toBeNull();
    expect(extractOpError(42)).toBeNull();
  });
});
