import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * withEngine `toContent` mapping — the screenshot tool hands the raw engine
 * frame back as an MCP image content block so a vision-capable client (Claude
 * Code) sees the actual pixels, instead of the JSON-stringified-text default.
 *
 * Contract:
 *  - toContent runs ONLY on genuine success (after extractOpError clears).
 *  - a failure result still surfaces as a text error; toContent is never called
 *    (so a failed snapshot never produces a broken image block).
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

import { withEngine, WITH_ENGINE_META, type WithEngineMeta } from "./with-engine.js";

afterEach(() => vi.clearAllMocks());

describe("withEngine — toContent image mapping", () => {
  it("maps a successful snapshot to an MCP image content block", async () => {
    mockGetClient.mockResolvedValue({});
    const res = await withEngine(
      async () => ({ ok: true, base64: "ZmFrZQ==", mime: "image/jpeg", width: 1280, height: 1018 }),
      {
        toContent: (snap: any) => [
          { type: "image", data: snap.base64, mimeType: snap.mime },
          { type: "text", text: `Editor viewport (${snap.width}x${snap.height}).` },
        ],
      }
    );
    expect(res.isError).toBeFalsy();
    const image = res.content.find((c: any) => c.type === "image") as any;
    expect(image).toBeDefined();
    expect(image.data).toBe("ZmFrZQ==");
    expect(image.mimeType).toBe("image/jpeg");
    const text = res.content.find((c: any) => c.type === "text") as any;
    expect(text.text).toContain("1280x1018");
  });

  it("surfaces a failed snapshot as text and never calls toContent", async () => {
    mockGetClient.mockResolvedValue({});
    const toContent = vi.fn();
    const res = await withEngine(
      async () => ({ ok: false, error: "Snapshot response did not include image data." }),
      { toContent }
    );
    expect(res.isError).toBe(true);
    expect(toContent).not.toHaveBeenCalled();
    expect(res.content[0]).toMatchObject({ type: "text" });
    expect((res.content[0] as any).text).toContain("did not include image data");
  });

  it("onResult short-circuits a successful result before toContent (bridge-required honesty)", async () => {
    mockGetClient.mockResolvedValue({});
    const toContent = vi.fn();
    const res = await withEngine(
      async () => ({ ok: true, failureReason: "bridge_required", error: "needs bridge" }),
      {
        toContent,
        onResult: (snap: any) =>
          snap.failureReason === "bridge_required"
            ? { content: [{ type: "text", text: "Game capture not available." }], isError: true }
            : null,
      }
    );
    expect(res.isError).toBe(true);
    expect(toContent).not.toHaveBeenCalled();
    expect((res.content[0] as any).text).toContain("not available");
  });

  it("onResult returning null falls through to toContent", async () => {
    mockGetClient.mockResolvedValue({});
    const res = await withEngine(
      async () => ({ ok: true, base64: "ZmFrZQ==", mime: "image/png" }),
      {
        onResult: () => null,
        toContent: (snap: any) => [{ type: "image", data: snap.base64, mimeType: snap.mime }],
      }
    );
    expect(res.isError).toBeFalsy();
    expect(res.content.find((c: any) => c.type === "image")).toBeDefined();
  });
});

describe("withEngine — structured-log metadata stamping", () => {
  const meta = (res: unknown): WithEngineMeta | undefined =>
    (res as Record<PropertyKey, unknown>)[WITH_ENGINE_META] as WithEngineMeta | undefined;

  it("stamps retried:false and the bound hash on a first-attempt success", async () => {
    mockGetClient.mockResolvedValue({ getBoundProjectIdHash: () => "hash-abc" });
    const res = await withEngine(async () => ({ ok: true }));
    expect(meta(res)?.retried).toBe(false);
    expect(meta(res)?.boundProjectIdHash).toBe("hash-abc");
  });

  it("stamps failure classifiers (terminalState/errorClass) on an op failure", async () => {
    mockGetClient.mockResolvedValue({ getBoundProjectIdHash: () => undefined });
    const res = await withEngine(async () => ({
      ok: false,
      terminalState: "identity_mismatch",
      errorClass: "rejected_identity",
      error: "projectIdHash mismatch",
    }));
    expect(res.isError).toBe(true);
    expect(meta(res)?.terminalState).toBe("identity_mismatch");
    expect(meta(res)?.errorClass).toBe("rejected_identity");
  });

  it("stamps retried:true after a stale-token 401 recovery", async () => {
    mockGetClient
      .mockResolvedValueOnce({ getBoundProjectIdHash: () => "h" })
      .mockResolvedValueOnce({ getBoundProjectIdHash: () => "h" });
    let calls = 0;
    const res = await withEngine(async () => {
      calls += 1;
      if (calls === 1) throw new Error("Engine API error 401: unauthorized");
      return { ok: true };
    });
    expect(res.isError).toBeFalsy();
    expect(meta(res)?.retried).toBe(true);
  });
});
