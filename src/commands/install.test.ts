import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadFile, requireDownloadUrl, verifyChecksum, windowsInstallerArgs } from "./install.js";

describe("requireDownloadUrl", () => {
  it("returns a present URL", () => {
    expect(requireDownloadUrl("https://x/Summer.dmg", "macOS DMG")).toBe("https://x/Summer.dmg");
  });
  it("throws a clear, labeled error when the URL is missing (avoids cryptic fetch(undefined))", () => {
    expect(() => requireDownloadUrl(undefined, "macOS DMG")).toThrow(/macOS DMG/);
  });
  it("throws when the URL is empty", () => {
    expect(() => requireDownloadUrl("   ", "macOS DMG")).toThrow(/macOS DMG/);
  });
});

describe("verifyChecksum", () => {
  it("passes when the hash matches (case-insensitive)", () => {
    expect(() => verifyChecksum("ABC123", "abc123", "DMG")).not.toThrow();
  });
  it("throws on mismatch (corrupt/truncated download)", () => {
    expect(() => verifyChecksum("abc123", "deadbeef", "DMG")).toThrow(/checksum/i);
  });
  it("skips verification when no expected hash is published", () => {
    expect(() => verifyChecksum("abc123", undefined, "DMG")).not.toThrow();
    expect(() => verifyChecksum("abc123", "", "DMG")).not.toThrow();
  });
});

describe("windowsInstallerArgs (Velopack Setup.exe — NOT NSIS)", () => {
  it("uses --silent, never the NSIS /S flag (which Velopack rejects: 'unexpected argument /S')", () => {
    const args = windowsInstallerArgs();
    expect(args).toBe("--silent");
    expect(args).not.toMatch(/\/S\b/);
  });
  it("uses --installto for a custom directory, never the NSIS /D= flag", () => {
    const args = windowsInstallerArgs("C:\\Apps\\Summer Engine");
    expect(args).toContain("--silent");
    expect(args).toContain('--installto "C:\\Apps\\Summer Engine"');
    expect(args).not.toContain("/D=");
  });
});

describe("downloadFile", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("streams the body to disk and returns its sha256 (enables integrity check)", async () => {
    const body = "summer-engine-installer-bytes";
    const expected = createHash("sha256").update(body).digest("hex");
    vi.stubGlobal(
      "fetch",
      async () => new Response(body, { headers: { "content-length": String(body.length) } })
    );

    const dest = join(tmpdir(), `se-dl-test-${Date.now()}.bin`);
    try {
      const { sha256 } = await downloadFile("https://x/file", dest);
      expect(sha256).toBe(expected);
      expect(readFileSync(dest, "utf-8")).toBe(body);
    } finally {
      try {
        rmSync(dest);
      } catch {
        /* ignore */
      }
    }
  });

  it("throws Download failed on a non-2xx response", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));
    await expect(downloadFile("https://x/missing", join(tmpdir(), "se-x.bin"))).rejects.toThrow(
      /Download failed: HTTP 404/
    );
  });
});
