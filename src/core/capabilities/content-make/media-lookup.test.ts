import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { magick, requireTools, which } from "./media.js";

const windows = process.platform === "win32";

describe("content.make media tool lookup", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "summer-media-lookup-"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function makeBin(name: string): string {
    const dir = join(root, name);
    mkdirSync(dir);
    return dir;
  }

  it("skips a directory with the same name as a tool", () => {
    const name = windows ? "ffmpeg.exe" : "ffmpeg";
    mkdirSync(join(root, name));
    const bin = makeBin("bin");
    const file = join(bin, name);
    writeFileSync(file, "fixture", { mode: 0o755 });

    expect(which("ffmpeg", [root, bin].join(delimiter))).toBe(file);
  });

  it.runIf(!windows)("looks for executable files and preserves spaces in POSIX PATH entries", async () => {
    const first = makeBin("first");
    const bin = makeBin("media tools ");
    writeFileSync(join(first, "magick"), "not executable", { mode: 0o644 });
    const file = join(bin, "magick");
    writeFileSync(file, "#!/bin/sh\nprintf 42", { mode: 0o755 });
    vi.stubEnv("PATH", [first, bin].join(delimiter));

    expect(which("magick")).toBe(file);
    expect(() => requireTools(["magick"])).not.toThrow();
    await expect(magick([])).resolves.toMatchObject({ stdout: "42" });
  });

  it.runIf(windows)("accepts a launchable Windows executable and skips batch wrappers", async () => {
    const wrappers = makeBin("wrappers");
    writeFileSync(join(wrappers, "magick.cmd"), "@echo off\r\n");
    writeFileSync(join(wrappers, "magick.bat"), "@echo off\r\n");
    vi.stubEnv("PATHEXT", ".CMD;.BAT;.COM;.EXE");
    vi.stubEnv("PATH", wrappers);

    expect(() => requireTools(["magick"])).toThrow(expect.objectContaining({ code: "content_tool_missing" }));

    const bin = makeBin("media; tools");
    const file = join(bin, "magick.exe");
    copyFileSync(process.execPath, file);
    vi.stubEnv("PATH", [wrappers, `"${bin}"`].join(delimiter));

    expect(which("magick")).toBe(file);
    expect(() => requireTools(["magick"])).not.toThrow();
    const { stdout } = await magick(["-p", "42"]);
    expect(stdout.trim()).toBe("42");
  });
});
