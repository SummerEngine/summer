import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  downloadFile,
  isSameVersion,
  parseMacBundleVersion,
  planMacInstall,
  replaceMacApp,
  requireDownloadUrl,
  verifyChecksum,
  windowsInstallerArgs,
} from "./install.js";

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

describe("planMacInstall (never rm -rf an installed engine silently)", () => {
  const base = { exists: true, installedVersion: "0.5.70", latestVersion: "0.5.71", yes: false, isTTY: false };

  it("installs straight away when nothing is installed", () => {
    expect(planMacInstall({ ...base, exists: false })).toEqual({ action: "install" });
  });
  it("is a no-op success when the installed version already matches (v-prefix tolerant)", () => {
    expect(planMacInstall({ ...base, installedVersion: "v0.5.71" })).toEqual({
      action: "up-to-date",
      version: "0.5.71",
    });
    expect(isSameVersion("0.5.71", "v0.5.71")).toBe(true);
    expect(isSameVersion(null, "0.5.71")).toBe(false);
  });
  it("refuses to replace without --yes when there is no TTY to ask", () => {
    const plan = planMacInstall(base);
    expect(plan.action).toBe("refuse");
    expect((plan as { reason: string }).reason).toMatch(/--yes/);
  });
  it("asks on a TTY and proceeds with --yes", () => {
    expect(planMacInstall({ ...base, isTTY: true })).toEqual({
      action: "needs-confirmation",
      installed: "0.5.70",
    });
    expect(planMacInstall({ ...base, yes: true })).toEqual({ action: "install" });
  });
});

describe("parseMacBundleVersion", () => {
  it("reads CFBundleShortVersionString from Info.plist", () => {
    const plist = `<plist><dict>
      <key>CFBundleName</key><string>Summer</string>
      <key>CFBundleShortVersionString</key>
      <string>0.5.71</string>
    </dict></plist>`;
    expect(parseMacBundleVersion(plist)).toBe("0.5.71");
    expect(parseMacBundleVersion("<plist/>")).toBeNull();
  });
});

describe("replaceMacApp", () => {
  it("stages to <dest>.new and only then removes the old bundle (no engine-less window)", () => {
    const commands: string[] = [];
    replaceMacApp("/Volumes/Summer", "/Applications/Summer.app", (command) => {
      commands.push(command);
    });
    expect(commands).toEqual([
      'rm -rf "/Applications/Summer.app.new"',
      'cp -R "/Volumes/Summer/Summer.app" "/Applications/Summer.app.new"',
      'rm -rf "/Applications/Summer.app"',
      'mv "/Applications/Summer.app.new" "/Applications/Summer.app"',
    ]);
  });

  it("leaves the existing install untouched when the copy fails", () => {
    const commands: string[] = [];
    expect(() =>
      replaceMacApp("/Volumes/Summer", "/Applications/Summer.app", (command) => {
        commands.push(command);
        if (command.startsWith("cp ")) throw new Error("disk full");
      })
    ).toThrow(/disk full/);
    expect(commands.some((command) => command === 'rm -rf "/Applications/Summer.app"')).toBe(false);
    expect(commands.at(-1)).toBe('rm -rf "/Applications/Summer.app.new"');
  });
});
