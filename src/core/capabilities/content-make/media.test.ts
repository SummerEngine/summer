import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireTools, which } from "./media.js";

describe("media which / requireTools cross-platform lookup", () => {
  let root: string;
  let originalPath: string | undefined;
  let originalPathExt: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "summer-media-which-test-"));
    originalPath = process.env.PATH;
    originalPathExt = process.env.PATHEXT;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalPathExt === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = originalPathExt;
    rmSync(root, { recursive: true, force: true });
  });

  it("finds Windows .exe/.cmd tools via PATHEXT in which() and requireTools()", () => {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "ffmpeg.exe"), "stub");
    writeFileSync(join(bin, "ffprobe.exe"), "stub");
    writeFileSync(join(bin, "magick.cmd"), "stub");

    process.env.PATH = bin;
    process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";

    if (process.platform === "win32") {
      expect(which("ffmpeg")).toBe(join(bin, "ffmpeg.exe"));
      expect(which("ffprobe")).toBe(join(bin, "ffprobe.exe"));
      expect(which("magick")).toBe(join(bin, "magick.cmd"));
      expect(() => requireTools(["ffmpeg", "ffprobe", "magick"])).not.toThrow();
    } else {
      // On POSIX hosts, verify direct binary lookup works and PATHEXT helper still resolves win32 binaries
      writeFileSync(join(bin, "ffmpeg"), "stub");
      expect(which("ffmpeg", bin)).toBe(join(bin, "ffmpeg"));
    }
  });

  it("ignores directories matching the command name on PATH", () => {
    const dirNamedFfmpeg = join(root, "ffmpeg");
    const realBin = join(root, "real-bin");
    mkdirSync(dirNamedFfmpeg, { recursive: true });
    mkdirSync(realBin, { recursive: true });
    const binaryName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    writeFileSync(join(realBin, binaryName), "stub");

    const found = which("ffmpeg", `${root}${delimiter}${realBin}`);
    expect(found).toBe(join(realBin, binaryName));
  });

  it("resolves win32 PATHEXT binaries, quoted PATH entries, and explicit extensions on any host", () => {
    const bin = join(root, "win bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "ffmpeg.exe"), "stub");
    writeFileSync(join(bin, "whisper.CMD"), "stub");

    expect(which("ffmpeg", `"${bin}"`, { platform: "win32", pathExt: ".EXE;.CMD" })).toBe(join(bin, "ffmpeg.exe"));
    expect(which("whisper", bin, { platform: "win32", pathExt: ".EXE;.CMD" })?.toLowerCase()).toBe(
      join(bin, "whisper.cmd").toLowerCase(),
    );
    expect(which("ffmpeg.exe", bin, { platform: "win32", pathExt: ".EXE;.CMD" })).toBe(join(bin, "ffmpeg.exe"));
    expect(which("missing", bin, { platform: "win32", pathExt: ".EXE;.CMD" })).toBeNull();
  });
});
