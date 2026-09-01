import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { walkProject } from "./hash.js";
import { readHashCache } from "./hash-cache.js";
import { sha256Hex } from "./manifest.js";

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "summer-walk-"));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

async function seed(path: string, content: string): Promise<void> {
  const full = join(projectRoot, path);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content);
}

describe("walkProject tracked set (spec 13)", () => {
  it("hashes tracked files and applies hard excludes", async () => {
    await seed("project.godot", "config_version=5\n");
    await seed("scripts/player.gd", "extends Node\n");
    await seed("assets/m.png.import", "[remap]\n");
    await seed(".env", "SECRET=1\n");
    await seed(".env.local", "SECRET=2\n");
    await seed(".DS_Store", "junk");
    await seed("Thumbs.db", "junk");
    await seed("desktop.ini", "junk");
    await seed("project.godot.bak", "old");
    await seed("ui.translation", "bin");
    await seed("scratch.tmp", "tmp");
    await mkdir(join(projectRoot, "node_modules", "x"), { recursive: true });
    await seed("node_modules/x/i.js", "js");
    await mkdir(join(projectRoot, ".godot"), { recursive: true });
    await seed(".godot/cache.bin", "cache");
    await mkdir(join(projectRoot, ".summer", "local", "cloud"), { recursive: true });
    await seed(".summer/local/cloud/base.json", "{}");
    await seed(".summer/skills/skill.md", "tracked");
    await seed("summer-cloud.json", "{}");
    await mkdir(join(projectRoot, "android"), { recursive: true });
    await seed("android/build.gradle", "x");

    const walk = await walkProject(projectRoot, { noCache: true });
    expect(Object.keys(walk.files).sort()).toEqual([
      ".summer/skills/skill.md",
      "assets/m.png.import",
      "project.godot",
      "scripts/player.gd",
    ]);
  });

  it("excludes Godot safe-save temps only when the base file exists", async () => {
    await seed("level.tscn", "scene");
    await seed("level.tscn-Xy12ab", "tmp write");
    await seed("orphan.tscn-Xy12ab", "no base file");
    const walk = await walkProject(projectRoot, { noCache: true });
    expect(walk.files["level.tscn-Xy12ab"]).toBeUndefined();
    expect(walk.files["orphan.tscn-Xy12ab"]).toBeDefined();
  });

  it("applies .summercloudignore as exclude-only", async () => {
    await seed(".summercloudignore", "*.blend\nbuild/\n");
    await seed("model.blend", "blend");
    await seed("a/model.blend", "blend");
    await mkdir(join(projectRoot, "build"), { recursive: true });
    await seed("build/out.bin", "bin");
    await seed("keep.gd", "gd");
    const walk = await walkProject(projectRoot, { noCache: true });
    expect(Object.keys(walk.files).sort()).toEqual([".summercloudignore", "keep.gd"]);
  });

  it("skips symlinks and reports them", async () => {
    await seed("real.gd", "x");
    await symlink(join(projectRoot, "real.gd"), join(projectRoot, "link.gd"));
    const walk = await walkProject(projectRoot, { noCache: true });
    expect(walk.files["link.gd"]).toBeUndefined();
    expect(walk.skippedSymlinks).toEqual(["link.gd"]);
  });

  it("NFC-normalizes manifest keys and keeps a byte-name map for I/O", async () => {
    const nfdName = "cafe\u0301.gd"; // NFD on disk
    await seed(nfdName, "x");
    const walk = await walkProject(projectRoot, { noCache: true });
    const nfcKey = nfdName.normalize("NFC");
    expect(walk.files[nfcKey]).toBeDefined();
    const diskPath = walk.diskPathByKey.get(nfcKey)!;
    expect(await readFile(diskPath, "utf8")).toBe("x");
  });

  it("records correct hashes and sizes", async () => {
    await seed("a.gd", "hello");
    const walk = await walkProject(projectRoot, { noCache: true });
    expect(walk.files["a.gd"]).toEqual({ sha256: sha256Hex("hello"), size: 5 });
    expect(walk.fileByHash.get(sha256Hex("hello"))).toBe(join(projectRoot, "a.gd"));
  });
});

describe("hash cache (spec 6.2)", () => {
  it("reuses cached hashes for unchanged files and persists the cache", async () => {
    await seed("a.gd", "hello");
    // Backdate so the racily-clean rule does not force a rehash.
    const old = new Date(Date.now() - 60_000);
    await utimes(join(projectRoot, "a.gd"), old, old);

    const first = await walkProject(projectRoot, { syncStartMs: Date.now() });
    expect(first.files["a.gd"].sha256).toBe(sha256Hex("hello"));
    const cache = await readHashCache(projectRoot);
    expect(cache["a.gd"].sha256).toBe(sha256Hex("hello"));

    // Poison the cache entry; a second walk must trust it (fields match).
    cache["a.gd"].sha256 = "f".repeat(64);
    const { writeHashCache } = await import("./hash-cache.js");
    await writeHashCache(projectRoot, cache);
    const second = await walkProject(projectRoot, { syncStartMs: Date.now() });
    expect(second.files["a.gd"].sha256).toBe("f".repeat(64));
  });

  it("racily-clean rule: mtime at or after sync start forces a rehash", async () => {
    await seed("a.gd", "hello");
    const old = new Date(Date.now() - 60_000);
    await utimes(join(projectRoot, "a.gd"), old, old);
    await walkProject(projectRoot, { syncStartMs: Date.now() });

    const cache = await readHashCache(projectRoot);
    cache["a.gd"].sha256 = "f".repeat(64);
    const { writeHashCache } = await import("./hash-cache.js");
    await writeHashCache(projectRoot, cache);

    // Sync start set BEFORE the file's mtime: cache must be ignored.
    const walk = await walkProject(projectRoot, { syncStartMs: old.getTime() - 1_000 });
    expect(walk.files["a.gd"].sha256).toBe(sha256Hex("hello"));
  });

  it("rehashes when size or content stats change", async () => {
    await seed("a.gd", "hello");
    const old = new Date(Date.now() - 60_000);
    await utimes(join(projectRoot, "a.gd"), old, old);
    await walkProject(projectRoot, { syncStartMs: Date.now() });

    await seed("a.gd", "changed!");
    const old2 = new Date(Date.now() - 30_000);
    await utimes(join(projectRoot, "a.gd"), old2, old2);
    const walk = await walkProject(projectRoot, { syncStartMs: Date.now() });
    expect(walk.files["a.gd"].sha256).toBe(sha256Hex("changed!"));
  });
});
