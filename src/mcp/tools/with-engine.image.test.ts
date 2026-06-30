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

vi.mock("../../lib/telemetry.js", () => ({
  recordMcpSession: vi.fn(),
}));

import { withEngine } from "./with-engine.js";

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
});
