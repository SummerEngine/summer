import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ENGINE_BINARY_ENV,
  ENGINE_URL_ENV,
  LINUX_ASSET_PATTERN,
  LINUX_ENGINE_BINARY_NAME,
  LINUX_RELEASES_API_URL,
  engineBinaryCandidates,
  findEngineBinary,
  findExtractedEngineBinary,
  linuxArchiveKind,
  linuxEnginePaths,
  pickLinuxReleaseAsset,
  resolveLinuxInstallSource,
} from "./engine-install.js";

describe("engineBinaryCandidates", () => {
  it("linux looks in ~/.summer/engine (where summer install registers)", () => {
    const candidates = engineBinaryCandidates("linux", {});
    expect(candidates).toEqual(linuxEnginePaths());
    expect(candidates[0].endsWith(join(".summer", "engine", LINUX_ENGINE_BINARY_NAME))).toBe(
      true
    );
  });

  it("SUMMER_ENGINE_BINARY is the first candidate on every platform", () => {
    for (const os of ["linux", "darwin", "win32"] as const) {
      const candidates = engineBinaryCandidates(os, {
        [ENGINE_BINARY_ENV]: "/opt/prebuilt/engine",
        HOME: "/home/u",
        LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
        PROGRAMFILES: "C:\\Program Files",
      });
      expect(candidates[0]).toBe("/opt/prebuilt/engine");
      expect(candidates.length).toBeGreaterThan(1);
    }
  });

  it("mac and windows keep their installer locations", () => {
    expect(engineBinaryCandidates("darwin", { HOME: "/home/u" })).toContain(
      "/Applications/Summer.app/Contents/MacOS/Summer"
    );
    expect(
      engineBinaryCandidates("win32", {
        LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
        PROGRAMFILES: "C:\\Program Files",
      })
    ).toContain("C:\\Users\\u\\AppData\\Local\\SummerEngine\\current\\Summer.exe");
  });
});

describe("findEngineBinary", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("returns the env-named binary when it exists", () => {
    dir = mkdtempSync(join(tmpdir(), "se-engine-test-"));
    const binary = join(dir, "engine");
    writeFileSync(binary, "#!/bin/sh\n");
    expect(findEngineBinary("linux", { [ENGINE_BINARY_ENV]: binary })).toBe(binary);
  });

  it("falls through a set-but-missing env override instead of reporting a phantom install", () => {
    dir = mkdtempSync(join(tmpdir(), "se-engine-test-"));
    // win32 candidates are fully env-derived, so every path is provably absent
    // on any host running this test.
    expect(
      findEngineBinary("win32", {
        [ENGINE_BINARY_ENV]: join(dir, "missing-engine"),
        LOCALAPPDATA: join(dir, "local"),
        PROGRAMFILES: join(dir, "programs"),
      })
    ).toBeNull();
  });
});

describe("resolveLinuxInstallSource (env-driven resolution order)", () => {
  it("SUMMER_ENGINE_BINARY wins over everything (prebuilt cloud containers)", () => {
    const source = resolveLinuxInstallSource({
      [ENGINE_BINARY_ENV]: "/opt/engine/summer",
      [ENGINE_URL_ENV]: "https://example.com/engine.tar.gz",
    });
    expect(source).toEqual({ kind: "binary", path: "/opt/engine/summer" });
  });

  it("SUMMER_ENGINE_URL is next (any artifact URL)", () => {
    const source = resolveLinuxInstallSource({
      [ENGINE_URL_ENV]: "https://example.com/engine.tar.gz",
    });
    expect(source).toEqual({ kind: "url", url: "https://example.com/engine.tar.gz" });
  });

  it("defaults to the published release listing — Linux is supported, no refusal path", () => {
    expect(resolveLinuxInstallSource({})).toEqual({
      kind: "release",
      apiUrl: LINUX_RELEASES_API_URL,
    });
  });

  it("ignores blank env values instead of treating them as sources", () => {
    const source = resolveLinuxInstallSource({
      [ENGINE_BINARY_ENV]: "   ",
      [ENGINE_URL_ENV]: "",
    });
    expect(source.kind).toBe("release");
  });
});

describe("pickLinuxReleaseAsset", () => {
  const linuxAsset = {
    name: "Summer-linux-x86_64-v0.5.70.tar.gz",
    browser_download_url: "https://dl/Summer-linux-x86_64-v0.5.70.tar.gz",
  };
  const shaAsset = {
    name: "Summer-linux-x86_64-v0.5.70.tar.gz.sha256",
    browser_download_url: "https://dl/Summer-linux-x86_64-v0.5.70.tar.gz.sha256",
  };

  it("skips CLI releases (no Linux asset) and finds the newest engine release", () => {
    const picked = pickLinuxReleaseAsset([
      { tag_name: "v2.8.0", draft: false, prerelease: false, assets: [] },
      { tag_name: "v0.5.70", draft: false, prerelease: false, assets: [linuxAsset, shaAsset] },
    ]);
    expect(picked.version).toBe("v0.5.70");
    expect(picked.url).toBe(linuxAsset.browser_download_url);
    expect(picked.sha256Url).toBe(shaAsset.browser_download_url);
  });

  it("skips drafts and prereleases", () => {
    const picked = pickLinuxReleaseAsset([
      { tag_name: "v0.6.0", draft: true, prerelease: false, assets: [linuxAsset] },
      { tag_name: "v0.5.9", draft: false, prerelease: true, assets: [linuxAsset] },
      { tag_name: "v0.5.8", draft: false, prerelease: false, assets: [linuxAsset] },
    ]);
    expect(picked.version).toBe("v0.5.8");
  });

  it("omits sha256Url when no checksum asset was published", () => {
    const picked = pickLinuxReleaseAsset([
      { tag_name: "v0.5.8", draft: false, prerelease: false, assets: [linuxAsset] },
    ]);
    expect(picked.sha256Url).toBeUndefined();
  });

  it("names both env escape hatches when nothing is published yet", () => {
    expect(() => pickLinuxReleaseAsset([])).toThrow(/SUMMER_ENGINE_URL/);
    expect(() => pickLinuxReleaseAsset([])).toThrow(/SUMMER_ENGINE_BINARY/);
  });

  it("release.yml naming contract matches the pattern the CLI looks for", () => {
    expect(LINUX_ASSET_PATTERN.test("Summer-linux-x86_64-v0.5.70.tar.gz")).toBe(true);
    expect(LINUX_ASSET_PATTERN.test("Summer-mac-v0.5.70.zip")).toBe(false);
    expect(LINUX_ASSET_PATTERN.test("Summer-linux-x86_64-v0.5.70.tar.gz.sha256")).toBe(false);
  });
});

describe("linuxArchiveKind", () => {
  it("classifies tar.gz, tgz, zip, and raw binaries (query strings ignored)", () => {
    expect(linuxArchiveKind("https://x/Summer-linux-x86_64-v1.tar.gz")).toBe("tar.gz");
    expect(linuxArchiveKind("https://x/engine.tgz?token=abc")).toBe("tar.gz");
    expect(linuxArchiveKind("https://x/engine.ZIP")).toBe("zip");
    expect(linuxArchiveKind("https://x/summer-linux-x86_64")).toBe("binary");
  });
});

describe("findExtractedEngineBinary", () => {
  it("prefers the canonical artifact name", () => {
    expect(
      findExtractedEngineBinary([
        "/tmp/x/README.md",
        `/tmp/x/${LINUX_ENGINE_BINARY_NAME}`,
      ])
    ).toBe(`/tmp/x/${LINUX_ENGINE_BINARY_NAME}`);
  });

  it("accepts a single-file archive whatever the name", () => {
    expect(findExtractedEngineBinary(["/tmp/x/whatever.bin"])).toBe("/tmp/x/whatever.bin");
  });

  it("recognizes an engine binary packed straight from a source build's bin/", () => {
    expect(
      findExtractedEngineBinary(["/tmp/x/notes.txt", "/tmp/x/godot.linuxbsd.editor.x86_64"])
    ).toBe("/tmp/x/godot.linuxbsd.editor.x86_64");
  });

  it("returns null rather than guessing among unrelated files", () => {
    expect(findExtractedEngineBinary(["/tmp/x/a.txt", "/tmp/x/b.txt"])).toBeNull();
  });
});
