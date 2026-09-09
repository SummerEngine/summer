import { describe, it, expect } from "vitest";

import { extractOpError, missingEngineOpResult, withTransportRecovery } from "./with-engine.js";

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

describe("extractOpError — classified failures preserve failure_reason (E-hotfix 2.8.1)", () => {
  it("surfaces a nested failure_reason even when the envelope carries its own error string", () => {
    const text = extractOpError({
      status: "error",
      terminalState: "failed",
      errorClass: "fatal",
      error: "failed",
      results: [
        {
          ok: false,
          op: "SimulateInput",
          error: "SimulateInput must be sent as a single op so it cannot block the editor thread.",
          failure_reason: "unsupported_transport",
        },
      ],
    });
    const parsed = JSON.parse(text ?? "");
    expect(parsed.failure_reason).toBe("unsupported_transport");
    expect(parsed.error).toBe("failed");
    expect(parsed.op_error).toContain("single op");
    expect(parsed.op).toBe("SimulateInput");
    expect(parsed.terminalState).toBe("failed");
  });

  it("prefers the failed op's precise error over the generic terminal-state sentence (the 2.8.0 masking bug)", () => {
    const text = extractOpError({
      terminalState: "failed",
      errorClass: "fatal",
      results: [
        {
          ok: false,
          op: "SaveScene",
          error: "SaveScene must be sent as a single op so it cannot block the editor thread.",
          failure_reason: "unsupported_transport",
        },
      ],
    });
    const parsed = JSON.parse(text ?? "");
    expect(parsed.error).toContain("must be sent as a single op");
    expect(parsed.failure_reason).toBe("unsupported_transport");
    expect(text).not.toContain("Engine operation failed (terminalState: failed)");
  });

  it("keeps the informative envelope error (plain text) when the failed results entry has no classifier", () => {
    expect(
      extractOpError({
        status: "error",
        error: "scene locked by running game — stop first",
        results: [{ ok: false, op: "SetProp" }],
      })
    ).toBe("scene locked by running game — stop first");
  });

  it("surfaces a nested failure_reason on an ok:false envelope", () => {
    const text = extractOpError({
      ok: false,
      error: "op rejected",
      results: [{ ok: false, op: "SimulateInput", failure_reason: "unsupported_transport" }],
    });
    const parsed = JSON.parse(text ?? "");
    expect(parsed.failure_reason).toBe("unsupported_transport");
    expect(parsed.error).toBe("op rejected");
  });

  it("surfaces a top-level failure_reason on a bare terminal envelope (no error, no results)", () => {
    const text = extractOpError({ terminalState: "timed_out", failure_reason: "queue_full" });
    const parsed = JSON.parse(text ?? "");
    expect(parsed.failure_reason).toBe("queue_full");
    expect(parsed.terminalState).toBe("timed_out");
    expect(parsed.error).toMatch(/timed out/i);
  });

  it("accepts the camelCase failureReason spelling on nested entries", () => {
    const text = extractOpError({
      terminalState: "failed",
      results: [{ ok: false, op: "AddNode", failureReason: "skipped" }],
    });
    const parsed = JSON.parse(text ?? "");
    expect(parsed.failure_reason).toBe("skipped");
  });
});

describe("withTransportRecovery — every transport failure teaches recovery", () => {
  it("appends the recovery recipe to a bare transport error", () => {
    const taught = withTransportRecovery("fetch failed");
    expect(taught.startsWith("fetch failed")).toBe(true);
    expect(taught).toContain("summer_get_project_context");
    expect(taught).toContain("do NOT blind-retry");
    expect(taught).toContain("smaller scripts/batches");
  });

  it("does not stack a second recipe on the connect-path failure (already prescriptive)", () => {
    const connect = "Summer Engine is not running.\nOpen the intended project in Summer Engine, or run: npx summer-engine run";
    expect(withTransportRecovery(connect)).toBe(connect);
  });
});

describe("missingEngineOpResult — capability pre-flight", () => {
  it("lets the call through when the client has no capability getters (older mocks / no advert)", () => {
    expect(missingEngineOpResult({}, "RunSceneScript", "use X")).toBeNull();
    expect(
      missingEngineOpResult({ getEngineCapabilities: () => undefined }, "RunSceneScript", "use X")
    ).toBeNull();
  });

  it("returns a structured engine_lacks_op result naming op, engine version and fallback when the advert lacks the op", () => {
    const result = missingEngineOpResult(
      {
        getEngineCapabilities: () => ({ opKinds: ["AddNode"] }),
        getEngineVersion: () => "0.5.61",
      },
      "GetWorldSnapshot",
      "use summer_get_scene_tree"
    );
    expect(result).toMatchObject({
      ok: false,
      op: "GetWorldSnapshot",
      failure_reason: "engine_lacks_op",
      engine_version: "0.5.61",
    });
    expect(result!.error).toContain("summer_get_scene_tree");
    // extractOpError classifies it like any engine op failure.
    expect(extractOpError(result)).toContain("GetWorldSnapshot");
  });

  it("stays null when the advertised op list includes the op", () => {
    expect(
      missingEngineOpResult(
        { getEngineCapabilities: () => ({ opKinds: ["GetWorldSnapshot"] }) },
        "GetWorldSnapshot",
        "use X"
      )
    ).toBeNull();
  });
});
