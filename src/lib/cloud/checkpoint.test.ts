import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckpoint, isGitAvailable, listCheckpoints, restoreCheckpoint, summerGitDir } from "./checkpoint.js";

const projectId = "11111111-1111-4111-8111-111111111111";
let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "summer-ckpt-"));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

async function seed(path: string, content: string): Promise<void> {
  const full = join(projectRoot, path);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content);
}

describe("SummerGit checkpoints (spec 11)", () => {
  it("git is available in this environment", async () => {
    expect(await isGitAvailable()).toBe(true);
  });

  it("creates a bare repo and a timestamped checkpoint ref", async () => {
    await seed("project.godot", "config_version=5\n");
    await seed("scripts/player.gd", "extends Node\n");
    const result = await createCheckpoint(projectRoot, projectId);
    expect(result.ref).toMatch(new RegExp(`^refs/gitsummer/${projectId}/cloud-sync-\\d{8}T\\d{6}Z$`));
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(summerGitDir(projectRoot), "HEAD"))).toBe(true);
    const refs = await listCheckpoints(projectRoot, projectId);
    expect(refs).toContain(result.ref);
  });

  it("does not checkpoint .summer/local or .godot", async () => {
    await seed("keep.gd", "x");
    await mkdir(join(projectRoot, ".summer", "local", "cloud"), { recursive: true });
    await seed(".summer/local/cloud/base.json", "{}");
    await mkdir(join(projectRoot, ".godot"), { recursive: true });
    await seed(".godot/cache.bin", "cache");
    const result = await createCheckpoint(projectRoot, projectId);
    const restored = await restoreCheckpoint(projectRoot, projectId, result.ref, ["keep.gd"]);
    expect(restored.restoredFiles).toEqual(["keep.gd"]);
  });

  it("restores checkpoint bytes and lists extraneous files instead of deleting them", async () => {
    await seed("a.gd", "original a");
    await seed("b.gd", "original b");
    const checkpoint = await createCheckpoint(projectRoot, projectId);

    // A bad sync overwrites a, deletes b, adds c.
    await seed("a.gd", "clobbered");
    await rm(join(projectRoot, "b.gd"));
    await seed("c.gd", "added by bad sync");

    const result = await restoreCheckpoint(projectRoot, projectId, checkpoint.ref, ["a.gd", "c.gd"]);
    expect(await readFile(join(projectRoot, "a.gd"), "utf8")).toBe("original a");
    expect(await readFile(join(projectRoot, "b.gd"), "utf8")).toBe("original b");
    expect(existsSync(join(projectRoot, "c.gd"))).toBe(true); // NOT deleted
    expect(result.extraneousFiles).toEqual(["c.gd"]);
  });

  it("restores by stamp as well as by full ref", async () => {
    await seed("a.gd", "v1");
    const checkpoint = await createCheckpoint(projectRoot, projectId);
    const stamp = checkpoint.ref.split("cloud-sync-")[1];
    await seed("a.gd", "v2");
    await restoreCheckpoint(projectRoot, projectId, stamp, ["a.gd"]);
    expect(await readFile(join(projectRoot, "a.gd"), "utf8")).toBe("v1");
  });

  it("prunes beyond 20 checkpoints, keeping the newest", async () => {
    await seed("a.gd", "x");
    const gitDirEnv = summerGitDir(projectRoot);
    void gitDirEnv;
    // Seed 25 fake old refs through the real plumbing by creating one real
    // checkpoint, then aliasing its commit under older stamps.
    const first = await createCheckpoint(projectRoot, projectId);
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const run = promisify(execFile);
    for (let i = 0; i < 24; i += 1) {
      const stamp = `2020010${(i % 9) + 1}T0${i % 10}000${i % 10}Z${String(i).padStart(2, "0")}`;
      await run("git", [
        "--git-dir",
        summerGitDir(projectRoot),
        "update-ref",
        `refs/gitsummer/${projectId}/cloud-sync-${stamp}`,
        first.commit,
      ]);
    }
    expect((await listCheckpoints(projectRoot, projectId)).length).toBe(25);
    await createCheckpoint(projectRoot, projectId);
    const refs = await listCheckpoints(projectRoot, projectId);
    expect(refs.length).toBe(20);
    // The newest (real) checkpoints survive; pruning removed the oldest.
    expect(refs[refs.length - 1]).toContain("cloud-sync-2");
    expect(refs.some((ref) => ref.includes("cloud-sync-20200101"))).toBe(false);
  });
});
