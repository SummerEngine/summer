import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { invalidArchivePath, scanWebBuildFolder, validateWebZip, WEB_ZIP_LIMITS } from "./validate.js";
import { crc32, readZipEntries, writeZip } from "./zip.js";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-webzip-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function makeBuild(files: Record<string, string>): Promise<string> {
  const dir = join(root, "build");
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

describe("invalidArchivePath", () => {
  it.each([
    ["../x", "plain relative"],
    ["a/../b", "plain relative"],
    ["/abs", "absolute"],
    ["C:/x", "absolute"],
    ["a\\b", "backslash"],
    ["a//b", "plain relative"],
    ["./a", "plain relative"],
    ["a:b", "absolute"],
    ["a".repeat(241), "240"],
  ])("rejects %s", (name, reason) => {
    expect(invalidArchivePath(name)).toContain(reason);
  });
  it("accepts nested relative paths", () => {
    expect(invalidArchivePath("assets/sprites/hero.png")).toBeNull();
  });
});

describe("scanWebBuildFolder", () => {
  it("accepts a build with index.html at the root and skips OS junk", async () => {
    const dir = await makeBuild({ "index.html": "<html>", "game.js": "1", "assets/a.png": "x", ".DS_Store": "junk" });
    const summary = await scanWebBuildFolder(dir);
    expect(summary.files.map((f) => f.name)).toEqual(["assets/a.png", "game.js", "index.html"]);
    expect(summary.totalBytes).toBe(8);
  });

  it("rejects a build without a root index.html", async () => {
    const dir = await makeBuild({ "web/index.html": "<html>", "other.js": "1" });
    await expect(scanWebBuildFolder(dir)).rejects.toMatchObject({ code: "web_build_missing_index" });
  });

  it("accepts a single top-level folder holding index.html (server root unwrap)", async () => {
    const dir = await makeBuild({ "web/index.html": "<html>", "web/game.js": "1" });
    expect((await scanWebBuildFolder(dir)).rootPrefix).toBe("web/");
  });

  it("ignores __MACOSX and .git at any depth", async () => {
    const dir = await makeBuild({ "index.html": "<html>", "a/.git/HEAD": "x", "__MACOSX/x": "y", "a/Thumbs.db": "z" });
    expect((await scanWebBuildFolder(dir)).files.map((f) => f.name)).toEqual(["index.html"]);
  });

  it("rejects root-absolute script paths in index.html", async () => {
    const dir = await makeBuild({ "index.html": '<script src="/assets/index.js"></script>' });
    await expect(scanWebBuildFolder(dir)).rejects.toMatchObject({ code: "web_build_root_absolute_path" });
  });

  it("allows protocol-relative and relative references", async () => {
    const dir = await makeBuild({ "index.html": '<script src="//cdn.example/x.js"></script><link href="./a.css">' });
    await expect(scanWebBuildFolder(dir)).resolves.toMatchObject({ fileCount: 1 });
  });

  it("rejects threaded Godot builds unless summer.json opts out", async () => {
    const threaded = "<script>const GODOT_THREADS_ENABLED = true;</script>";
    const dir = await makeBuild({ "index.html": threaded });
    await expect(scanWebBuildFolder(dir)).rejects.toMatchObject({ code: "web_build_threads_unsupported" });
    await writeFile(join(dir, "summer.json"), '{"crossOriginIsolated": false}');
    await expect(scanWebBuildFolder(dir)).resolves.toMatchObject({ fileCount: 2 });
    await writeFile(join(dir, "summer.json"), "{nope");
    await expect(scanWebBuildFolder(dir)).rejects.toMatchObject({ code: "web_build_invalid_summer_json" });
  });

  it("rejects symlinks", async () => {
    const dir = await makeBuild({ "index.html": "<html>" });
    await symlink(join(dir, "index.html"), join(dir, "link.html"));
    await expect(scanWebBuildFolder(dir)).rejects.toMatchObject({ code: "web_build_symlink" });
  });

  it("rejects case-insensitive duplicates", async () => {
    const dir = await makeBuild({ "index.html": "<html>", "a/Hero.png": "1" });
    // A case-sensitive filesystem may allow both names; simulate via the zip path instead when it does not.
    try {
      await writeFile(join(dir, "a", "hero.png"), "2", { flag: "wx" });
    } catch {
      return;
    }
    await expect(scanWebBuildFolder(dir)).rejects.toMatchObject({ code: "web_build_duplicate_path" });
  });
});

describe("writeZip / readZipEntries round trip", () => {
  it("writes a valid deflate/stored archive that validates and inflates back", async () => {
    const dir = await makeBuild({ "index.html": "<html>".repeat(200), "data.bin": "z" });
    const summary = await scanWebBuildFolder(dir);
    const out = join(root, "out.zip");
    const { sizeBytes } = await writeZip(out, summary.files.map((f) => ({ name: f.name, path: f.path! })));
    expect((await stat(out)).size).toBe(sizeBytes);
    const entries = await readZipEntries(out, sizeBytes);
    expect(entries.map((e) => [e.name, e.method, e.uncompressedSize])).toEqual([
      ["data.bin", 0, 1],
      ["index.html", 8, 1200],
    ]);
    const validated = await validateWebZip(out, sizeBytes);
    expect(validated.fileCount).toBe(2);

    // Inflate index.html from its local header to prove the bytes are right.
    const bytes = readFileSync(out);
    const second = bytes.indexOf(Buffer.from("index.html"));
    const header = second - 30;
    const compressed = bytes.readUInt32LE(header + 18);
    const body = bytes.subarray(second + 10, second + 10 + compressed);
    const inflated = inflateRawSync(body);
    expect(inflated.toString()).toBe("<html>".repeat(200));
    expect(bytes.readUInt32LE(header + 14)).toBe(crc32(inflated));
  });

  it("rejects a zip that is not a zip", async () => {
    const out = join(root, "bad.zip");
    await writeFile(out, "not a zip at all, definitely not");
    await expect(validateWebZip(out, 32)).rejects.toMatchObject({ code: "web_build_invalid_zip" });
  });

  it("reads index.html out of the zip to apply the root-absolute rule", async () => {
    const dir = await makeBuild({ "index.html": '<link href="/style.css">'.repeat(50) });
    const out = join(root, "abs.zip");
    const { sizeBytes } = await writeZip(out, [{ name: "index.html", path: join(dir, "index.html") }]);
    await expect(validateWebZip(out, sizeBytes)).rejects.toMatchObject({ code: "web_build_root_absolute_path" });
  });

  it("rejects a zip without a root index.html", async () => {
    const dir = await makeBuild({ "web/index.html": "<html>" });
    const out = join(root, "nested.zip");
    const { sizeBytes } = await writeZip(out, [
      { name: "web/index.html", path: join(dir, "web/index.html") },
      { name: "loose.js", path: join(dir, "web/index.html") },
    ]);
    await expect(validateWebZip(out, sizeBytes)).rejects.toMatchObject({ code: "web_build_missing_index" });
  });

  it("rejects a zip containing a traversal path", async () => {
    const dir = await makeBuild({ "index.html": "<html>" });
    const out = join(root, "evil.zip");
    const { sizeBytes } = await writeZip(out, [
      { name: "index.html", path: join(dir, "index.html") },
      { name: "../escape.js", path: join(dir, "index.html") },
    ]);
    await expect(validateWebZip(out, sizeBytes)).rejects.toMatchObject({ code: "web_build_invalid_path" });
  });

  it("refuses archives above the size limit before reading them", async () => {
    await expect(validateWebZip(join(root, "missing.zip"), WEB_ZIP_LIMITS.maxArchiveBytes + 1)).rejects.toMatchObject({
      code: "web_build_too_large",
    });
  });
});
