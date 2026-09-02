import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * withEngine must tell a PRE-APPLY throw apart from a transport failure.
 *
 * Before this test existed every throw inside the tool closure — including
 * argument validation that never sent a byte — came back as
 * errorClass:"transport", dropped the cached client, and told the model the
 * mutation "may have partially applied; inspect the target before retrying".
 * The agent would then go read the scene looking for a change that never
 * happened. Tagged throws (ToolInputError / UnsupportedOperationError) now
 * classify as "input" / "unsupported": nothing sent, client kept, no recovery
 * recipe. An untagged throw keeps the conservative transport treatment.
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

import {
  ToolInputError,
  UnsupportedOperationError,
  WITH_ENGINE_META,
  withEngine,
  type WithEngineMeta,
} from "./with-engine.js";

afterEach(() => vi.clearAllMocks());

type Result = { content: { text?: string }[]; isError?: boolean };

function text(res: Result): string {
  return res.content[0]?.text ?? "";
}

function meta(res: Result): WithEngineMeta | undefined {
  return (res as unknown as Record<PropertyKey, unknown>)[WITH_ENGINE_META] as WithEngineMeta | undefined;
}

describe("withEngine — thrown-error classes", () => {
  it("ToolInputError → errorClass input, failure_reason invalid_input, client kept, no recovery recipe", async () => {
    mockGetClient.mockResolvedValue({ getBoundProjectIdHash: () => "hash-a" });
    const res = await withEngine(async () => {
      throw new ToolInputError("gap must not exceed maxDistance.");
    });
    expect(res.isError).toBe(true);
    const body = JSON.parse(text(res));
    expect(body.error).toBe("gap must not exceed maxDistance.");
    expect(body.failure_reason).toBe("invalid_input");
    expect(body.errorClass).toBe("input");
    expect(body.sent).toBe(false);
    expect(text(res)).not.toContain("may have partially applied");
    expect(text(res)).not.toContain("Recovery:");
    expect(meta(res)).toMatchObject({
      errorClass: "input",
      failureReason: "invalid_input",
      retried: false,
      boundProjectIdHash: "hash-a",
    });
    // Nothing was sent, so the cached client is still good — never dropped.
    expect(mockResetClient).not.toHaveBeenCalled();
    // And never retried: a bad argument does not get better on a second try.
    expect(mockGetClient).toHaveBeenCalledTimes(1);
  });

  it("UnsupportedOperationError → errorClass unsupported, client kept, no recovery recipe", async () => {
    mockGetClient.mockResolvedValue({});
    const res = await withEngine(async () => {
      throw new UnsupportedOperationError('"inspectNode" is not supported by the headless worker serving this project.');
    });
    expect(res.isError).toBe(true);
    const body = JSON.parse(text(res));
    expect(body.failure_reason).toBe("unsupported_operation");
    expect(body.errorClass).toBe("unsupported");
    expect(body.sent).toBe(false);
    expect(body.error).toContain("headless worker");
    expect(text(res)).not.toContain("Recovery:");
    expect(meta(res)?.errorClass).toBe("unsupported");
    expect(mockResetClient).not.toHaveBeenCalled();
  });

  it("an untagged throw keeps the conservative transport treatment (reset + recovery recipe)", async () => {
    mockGetClient.mockResolvedValue({});
    const res = await withEngine(async () => {
      throw new Error("fetch failed");
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("fetch failed");
    expect(text(res)).toContain("Recovery:");
    expect(text(res)).toContain("do NOT blind-retry");
    expect(meta(res)?.errorClass).toBe("transport");
    expect(mockResetClient).toHaveBeenCalled();
  });

  it("classifies by symbol tag, so a structurally-tagged error from another module copy still counts", async () => {
    mockGetClient.mockResolvedValue({});
    const foreign = Object.assign(new Error("subjectPaths must not contain duplicates."), {
      [Symbol.for("summer.thrownErrorClass")]: "input",
    });
    const res = await withEngine(async () => {
      throw foreign;
    });
    expect(meta(res)?.errorClass).toBe("input");
    expect(mockResetClient).not.toHaveBeenCalled();
  });
});
