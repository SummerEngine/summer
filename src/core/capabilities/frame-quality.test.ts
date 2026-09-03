import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "../package-root.js";
import { analyzeFrameBase64, analyzeJpegFrame, describeFlatFrame } from "./frame-quality.js";

/**
 * Real frames from the 2026-09-03 end-to-end run (docs/design/E2E-2026-09-03.md,
 * F-01). 01 is the all-black viewport capture the MCP face returned with a
 * "describe what you see" caption; the others are genuine editor, offscreen,
 * game and probe frames from the same session. The probe frames carry restart
 * markers (DRI=80), so they also exercise the restart path.
 */
const E2E_DIR = join(PACKAGE_ROOT, "docs", "design", "e2e");
const frame = (name: string): Buffer => readFileSync(join(E2E_DIR, name));

const REAL_CONTENT = [
  "02-mcp-scene-render-pausemenu.jpg",
  "03-cli-viewport-with-label.jpg",
  "04-mcp-viewport-preplay.jpg",
  "05-mcp-game-frame.jpg",
  "06-probe-00_start.jpg",
  "07-probe-02_waypoint_1.jpg",
];

describe("analyzeJpegFrame — the e2e black frame", () => {
  it("is uniform, flat and black", () => {
    const q = analyzeJpegFrame(frame("01-mcp-viewport-black.jpg"));
    expect(q.analyzable).toBe(true);
    expect(q.width).toBe(1072);
    expect(q.height).toBe(1280);
    expect(q.uniform).toBe(true);
    expect(q.flat).toBe(true);
    expect(q.tone).toBe("black");
    expect(q.meanLuma).toBeLessThan(8);
    expect(q.lumaSpread).toBe(0);
    expect(q.chromaSpread).toBe(0);
    // 1072x1280 at 4:2:0 -> 67 x 80 MCUs x 4 luma blocks each.
    expect(q.lumaBlocks).toBe(67 * 80 * 4);
    expect(describeFlatFrame(q)).toContain("uniformly black");
  });
});

describe("analyzeJpegFrame — frames with real content", () => {
  it.each(REAL_CONTENT)("%s is neither uniform nor flat", (name) => {
    const q = analyzeJpegFrame(frame(name));
    expect(q.analyzable).toBe(true);
    expect(q.uniform).toBe(false);
    expect(q.flat).toBe(false);
    expect(q.tone).toBeUndefined();
    // Real frames spread across most of the luma range; the threshold that
    // flags a flat frame is 4.
    expect(q.lumaSpread).toBeGreaterThan(60);
  });

  it("reports the frame geometry the SOF header declares", () => {
    const q = analyzeJpegFrame(frame("05-mcp-game-frame.jpg"));
    expect([q.width, q.height]).toEqual([1280, 719]);
    // 1280x719 -> 80 x 45 MCUs (16 px) x 4 luma blocks.
    expect(q.lumaBlocks).toBe(80 * 45 * 4);
  });

  it("decodes every frame in well under the cost of a capture", () => {
    const started = performance.now();
    for (const name of REAL_CONTENT) analyzeJpegFrame(frame(name));
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

describe("analyzeJpegFrame — inputs it must refuse without throwing", () => {
  it("rejects non-JPEG bytes", () => {
    const q = analyzeJpegFrame(Buffer.from("\x89PNG\r\n\x1a\n not a jpeg", "latin1"));
    expect(q.analyzable).toBe(false);
    expect(q.reason).toContain("SOI");
    expect(q.uniform).toBe(false);
    expect(q.flat).toBe(false);
  });

  it("rejects an empty buffer", () => {
    expect(analyzeJpegFrame(new Uint8Array(0)).analyzable).toBe(false);
  });

  it("rejects a JPEG truncated inside its headers", () => {
    const q = analyzeJpegFrame(frame("04-mcp-viewport-preplay.jpg").subarray(0, 300));
    expect(q.analyzable).toBe(false);
    expect(typeof q.reason).toBe("string");
  });

  it("never claims uniform for a scan truncated mid-way", () => {
    const full = frame("04-mcp-viewport-preplay.jpg");
    const q = analyzeJpegFrame(full.subarray(0, Math.floor(full.length / 2)));
    // Either the walk fails (not analysable) or it sees the real, non-uniform
    // blocks it did decode — it must not report a flat frame.
    expect(q.flat).toBe(false);
  });

  it("refuses a synthetic progressive JPEG header", () => {
    // SOI, then an SOF2 segment header — enough to be recognised and refused.
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xc2, 0x00, 0x0b, 0x08, 0x00, 0x10, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00]);
    const q = analyzeJpegFrame(bytes);
    expect(q.analyzable).toBe(false);
    expect(q.reason).toContain("progressive");
  });
});

describe("analyzeFrameBase64", () => {
  it("decodes the base64 the engine ships in the snapshot payload", () => {
    const q = analyzeFrameBase64(frame("01-mcp-viewport-black.jpg").toString("base64"), "image/jpeg");
    expect(q.uniform).toBe(true);
  });

  it("does not analyse non-JPEG mime types", () => {
    const q = analyzeFrameBase64("AAAA", "image/png");
    expect(q.analyzable).toBe(false);
    expect(q.reason).toContain("image/png");
  });
});
