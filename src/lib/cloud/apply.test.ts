import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyRemotePlan, type ApplyContext } from "./apply.js";
import { ConflictSetWriter, conflictStamp } from "./conflicts.js";
import { containedProjectPath } from "./containment.js";
import { diffManifests } from "./diff.js";
import { walkProject } from "./hash.js";
import { sha256Hex } from "./manifest.js";
import { stagingDir, conflictsDir } from "../../project-memory/cloud-paths.js";
import type { CloudManifest } from "./types.js";

const projectId = "11111111-1111-4111-8111-111111111111";
let projectRoot: string;
let checkpoints: number;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "summer-apply-"));
  await mkdir(stagingDir(projectRoot), { recursive: true });
  checkpoints = 0;
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

function manifest(files: CloudManifest["files"]): CloudManifest {
  return { schemaVersion: 1, projectId, rulesVersion: 1, files };
}

const entry = (content: string) => ({ sha256: sha256Hex(content), size: Buffer.byteLength(content) });

async function seed(path: string, content: string): Promise<void> {
  const full = join(projectRoot, path);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content);
}

async function stage(content: string): Promise<string> {
  const hash = sha256Hex(content);
  await writeFile(join(stagingDir(projectRoot), hash), content);
  return hash;
}

async function contextFor(remote: CloudManifest, base: CloudManifest | null = null): Promise<ApplyContext> {
  const walk = await walkProject(projectRoot, { noCache: true });
  const staged = new Map<string, string>();
  for (const file of Object.values(remote.files)) {
    const path = join(stagingDir(projectRoot), file.sha256);
    if (existsSync(path)) staged.set(file.sha256, path);
  }
  if (base) {
    for (const file of Object.values(base.files)) {
      const path = join(stagingDir(projectRoot), file.sha256);
      if (existsSync(path)) staged.set(file.sha256, path);
    }
  }
  return {
    staged,
    diskPathByKey: walk.diskPathByKey,
    statByKey: walk.statByKey,
    conflicts: new ConflictSetWriter(projectRoot, conflictStamp(), projectId, 1, 2),
    base,
    onBeforeDestructive: async () => {
      checkpoints += 1;
    },
  };
}

describe("applyRemotePlan (spec 8.7)", () => {
  it("writes pulled files atomically from staging", async () => {
    const remote = manifest({ "new.gd": entry("remote bytes") });
    await stage("remote bytes");
    const plan = diffManifests(manifest({}), manifest({}), remote);
    const context = await contextFor(remote);
    const result = await applyRemotePlan(projectRoot, plan, remote, context);
    expect(await readFile(join(projectRoot, "new.gd"), "utf8")).toBe("remote bytes");
    expect(result.appliedPaths).toEqual(["new.gd"]);
    expect(checkpoints).toBe(0); // pure add: nothing destructive
  });

  it("checkpoints exactly once before any modify or delete", async () => {
    await seed("mod.gd", "old");
    await seed("del.gd", "doomed");
    const base = manifest({ "mod.gd": entry("old"), "del.gd": entry("doomed") });
    const remote = manifest({ "mod.gd": entry("new") });
    await stage("new");
    const plan = diffManifests(base, base, remote);
    const context = await contextFor(remote, base);
    await applyRemotePlan(projectRoot, plan, remote, context);
    expect(checkpoints).toBe(1);
    expect(await readFile(join(projectRoot, "mod.gd"), "utf8")).toBe("new");
    expect(existsSync(join(projectRoot, "del.gd"))).toBe(false);
  });

  it("applies project.godot and *.tscn after other writes", async () => {
    const remote = manifest({
      "project.godot": entry("config_version=5\n"),
      "level.tscn": entry("scene"),
      "a.gd": entry("script"),
      "z.png": entry("img"),
    });
    for (const content of ["config_version=5\n", "scene", "script", "img"]) await stage(content);
    const plan = diffManifests(manifest({}), manifest({}), remote);
    const context = await contextFor(remote);
    const result = await applyRemotePlan(projectRoot, plan, remote, context);
    const order = result.appliedPaths;
    expect(order.indexOf("a.gd")).toBeLessThan(order.indexOf("level.tscn"));
    expect(order.indexOf("z.png")).toBeLessThan(order.indexOf("level.tscn"));
    expect(order.indexOf("level.tscn")).toBeLessThan(order.indexOf("project.godot"));
  });

  it("duplicate-content blobs land at every path", async () => {
    const remote = manifest({ "a.gd": entry("same"), "b.gd": entry("same") });
    await stage("same");
    const plan = diffManifests(manifest({}), manifest({}), remote);
    const context = await contextFor(remote);
    await applyRemotePlan(projectRoot, plan, remote, context);
    expect(await readFile(join(projectRoot, "a.gd"), "utf8")).toBe("same");
    expect(await readFile(join(projectRoot, "b.gd"), "utf8")).toBe("same");
  });

  it("clears read-only attributes before replacing", async () => {
    await seed("locked.gd", "old");
    await chmod(join(projectRoot, "locked.gd"), 0o444);
    const base = manifest({ "locked.gd": entry("old") });
    const remote = manifest({ "locked.gd": entry("new") });
    await stage("new");
    const plan = diffManifests(base, base, remote);
    const context = await contextFor(remote, base);
    await applyRemotePlan(projectRoot, plan, remote, context);
    expect(await readFile(join(projectRoot, "locked.gd"), "utf8")).toBe("new");
  });

  it("preserves conflict losers with meta.json and sidecar bytes in the set", async () => {
    await seed("player.png", "local image");
    await seed("player.png.import", "local import");
    const base = manifest({ "player.png": entry("base image"), "player.png.import": entry("base import") });
    const remote = manifest({ "player.png": entry("remote image"), "player.png.import": entry("base import") });
    const local = manifest({ "player.png": entry("local image"), "player.png.import": entry("local import") });
    await stage("remote image");
    await stage("base import");
    const plan = diffManifests(base, local, remote);
    const context = await contextFor(remote, base);
    const result = await applyRemotePlan(projectRoot, plan, remote, context);
    await context.conflicts.finalize();

    expect(await readFile(join(projectRoot, "player.png"), "utf8")).toBe("remote image");
    const setDir = context.conflicts.setDir;
    expect(await readFile(join(setDir, "player.png"), "utf8")).toBe("local image");
    expect(await readFile(join(setDir, "player.png.import"), "utf8")).toBe("local import");
    const meta = JSON.parse(await readFile(join(setDir, "meta.json"), "utf8"));
    expect(meta.entries.some((e: { path: string }) => e.path === "player.png")).toBe(true);
    expect(result.preservedLocalHashes.has(sha256Hex("local image"))).toBe(true);
    // No conflict copy may ever appear in the scanned tree.
    const tree = await walkProject(projectRoot, { noCache: true });
    expect(Object.keys(tree.files).some((k) => k.includes("conflict"))).toBe(false);
  });

  it("pre-image stat check routes drift between diff and apply to conflicts", async () => {
    await seed("drift.gd", "at diff time");
    const base = manifest({ "drift.gd": entry("at diff time") });
    const remote = manifest({ "drift.gd": entry("remote") });
    await stage("remote");
    const plan = diffManifests(base, base, remote); // plain pull at diff time
    const context = await contextFor(remote, base);

    // The user saves between diff and apply.
    await writeFile(join(projectRoot, "drift.gd"), "edited after diff!");

    const result = await applyRemotePlan(projectRoot, plan, remote, context);
    await context.conflicts.finalize();
    expect(await readFile(join(projectRoot, "drift.gd"), "utf8")).toBe("remote");
    expect(await readFile(join(context.conflicts.setDir, "drift.gd"), "utf8")).toBe("edited after diff!");
    expect(result.notices.some((n) => n.includes("drift.gd"))).toBe(true);
  });

  it("pre-image stat check turns a drifted delete into keep-local", async () => {
    await seed("del.gd", "unchanged");
    const base = manifest({ "del.gd": entry("unchanged") });
    const remote = manifest({});
    const plan = diffManifests(base, base, remote); // delete-local at diff time
    const context = await contextFor(remote, base);

    await writeFile(join(projectRoot, "del.gd"), "edited after diff, must survive");

    const result = await applyRemotePlan(projectRoot, plan, remote, context);
    expect(await readFile(join(projectRoot, "del.gd"), "utf8")).toBe("edited after diff, must survive");
    expect(result.notices.some((n) => n.includes("del.gd"))).toBe(true);
  });

  it("executes case-only renames as a two-step rename, never delete-then-write", async () => {
    await seed("foo.gd", "same bytes");
    const base = manifest({ "foo.gd": entry("same bytes") });
    const remote = manifest({ "Foo.gd": entry("same bytes") });
    const local = manifest({ "foo.gd": entry("same bytes") });
    const plan = diffManifests(base, local, remote);
    // Sanity: this diffs as delete foo.gd + pull Foo.gd.
    expect(plan.deleteLocalPaths).toEqual(["foo.gd"]);
    expect(plan.pullPaths).toEqual(["Foo.gd"]);
    const context = await contextFor(remote, base);
    // No staged blob on purpose: the rename path must not need a download.
    context.staged.clear();
    await applyRemotePlan(projectRoot, plan, remote, context);
    expect(await readFile(join(projectRoot, "Foo.gd"), "utf8")).toBe("same bytes");
    const walk = await walkProject(projectRoot, { noCache: true });
    expect(Object.keys(walk.files)).toEqual(["Foo.gd"]);
  });

  it("skips a casefold-twin delete when inode proves one file (case-insensitive volume)", async () => {
    await seed("foo.gd", "old bytes");
    const caseInsensitive = existsSync(join(projectRoot, "FOO.GD"));
    if (!caseInsensitive) return; // Case-sensitive volume: nothing to prove here.
    // Remote renamed foo.gd to Foo.gd AND edited it: not a pure case-only
    // rename, so it goes through write-then-delete; the inode gate must stop
    // the delete from removing the file the write just landed on.
    const base = manifest({ "foo.gd": entry("old bytes") });
    const local = manifest({ "foo.gd": entry("old bytes") });
    const remote = manifest({ "Foo.gd": entry("new bytes") });
    await stage("new bytes");
    const plan = diffManifests(base, local, remote);
    expect(plan.deleteLocalPaths).toEqual(["foo.gd"]);
    expect(plan.pullPaths).toEqual(["Foo.gd"]);
    const context = await contextFor(remote, base);
    await applyRemotePlan(projectRoot, plan, remote, context);
    expect(await readFile(join(projectRoot, "Foo.gd"), "utf8")).toBe("new bytes");
  });

  it("merges project.godot at key level on conflict", async () => {
    const baseText = 'config_version=5\n\n[application]\n\nconfig/name="Base"\nrun/main_scene="res://main.tscn"\n';
    const localText = 'config_version=5\n\n[application]\n\nconfig/name="Base"\nrun/main_scene="res://local.tscn"\n';
    const remoteText = 'config_version=5\n\n[application]\n\nconfig/name="Remote"\nrun/main_scene="res://main.tscn"\n';
    await seed("project.godot", localText);
    const base = manifest({ "project.godot": entry(baseText) });
    const local = manifest({ "project.godot": entry(localText) });
    const remote = manifest({ "project.godot": entry(remoteText) });
    await stage(baseText);
    await stage(remoteText);
    const plan = diffManifests(base, local, remote);
    expect(plan.conflictPaths).toEqual(["project.godot"]);
    const context = await contextFor(remote, base);
    await applyRemotePlan(projectRoot, plan, remote, context);
    const merged = await readFile(join(projectRoot, "project.godot"), "utf8");
    expect(merged).toContain('config/name="Remote"'); // remote-only change
    expect(merged).toContain('run/main_scene="res://local.tscn"'); // local-only change survives
  });

  it("falls back to whole-file remote-wins for unparseable project.godot", async () => {
    const remoteText = 'config_version=5\n\n[application]\n\nconfig/name="Remote"\n';
    await seed("project.godot", "((((( broken");
    const base = manifest({ "project.godot": entry("also broken (((") });
    const local = manifest({ "project.godot": entry("((((( broken") });
    const remote = manifest({ "project.godot": entry(remoteText) });
    await stage(remoteText);
    await stage("also broken (((");
    const plan = diffManifests(base, local, remote);
    const context = await contextFor(remote, base);
    await applyRemotePlan(projectRoot, plan, remote, context);
    await context.conflicts.finalize();
    expect(await readFile(join(projectRoot, "project.godot"), "utf8")).toBe(remoteText);
    expect(await readFile(join(context.conflicts.setDir, "project.godot"), "utf8")).toBe("((((( broken");
  });
});

describe("write containment (spec 9)", () => {
  it("refuses to write through a symlinked directory component", async () => {
    const outside = await mkdtemp(join(tmpdir(), "summer-outside-"));
    try {
      await symlink(outside, join(projectRoot, "evil"));
      await expect(containedProjectPath(projectRoot, "evil/escape.gd")).rejects.toThrow(/symlink/i);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses traversal keys outright", async () => {
    await expect(containedProjectPath(projectRoot, "../escape.gd")).rejects.toThrow(/unsafe|dot/i);
  });

  it("refuses to replace a symlink target file", async () => {
    await seed("real.gd", "x");
    await symlink(join(projectRoot, "real.gd"), join(projectRoot, "link.gd"));
    await expect(containedProjectPath(projectRoot, "link.gd")).rejects.toThrow(/symlink/i);
  });

  it("creates nested parents and returns the target inside the root", async () => {
    const target = await containedProjectPath(projectRoot, "a/b/c.gd");
    expect(target.startsWith(await (await import("fs/promises")).realpath(projectRoot))).toBe(true);
    expect((await stat(join(projectRoot, "a", "b"))).isDirectory()).toBe(true);
  });
});

describe("conflict set retention", () => {
  it("prunes to the last 20 sets when they are older than 30 days", async () => {
    const { pruneConflictSets } = await import("./conflicts.js");
    const { utimes } = await import("fs/promises");
    for (let i = 0; i < 25; i += 1) {
      const stamp = `2020010${(i % 9) + 1}T${String(i).padStart(2, "0")}0000Z`;
      const dir = join(conflictsDir(projectRoot), stamp);
      await mkdir(dir, { recursive: true });
      const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      await utimes(dir, old, old);
    }
    await pruneConflictSets(projectRoot);
    const { listConflictSets } = await import("./conflicts.js");
    expect((await listConflictSets(projectRoot)).length).toBe(20);
  });

  it("keeps sets younger than 30 days even beyond 20", async () => {
    const { pruneConflictSets, listConflictSets } = await import("./conflicts.js");
    for (let i = 0; i < 25; i += 1) {
      const stamp = `2026010${(i % 9) + 1}T${String(i).padStart(2, "0")}0000Z`;
      await mkdir(join(conflictsDir(projectRoot), stamp), { recursive: true });
    }
    await pruneConflictSets(projectRoot);
    expect((await listConflictSets(projectRoot)).length).toBe(25);
  });
});
