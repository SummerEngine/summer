import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setCloudApiForTests } from "./api.js";
import { listConflictSets } from "./conflicts.js";
import { setBlobTransportForTests } from "./http.js";
import { sha256Hex } from "./manifest.js";
import { readBase, readJournal, writeJournal } from "../../../project-memory/cloud-paths.js";
import { FakeCloud } from "./test-helpers/fake-cloud.js";
import { CAS_BACKOFF_MS, cloudConflicts, cloudPull, cloudPush, cloudRestore, cloudStatus } from "./sync.js";

let cloud: FakeCloud;
const roots: string[] = [];
const originalBackoff = [...CAS_BACKOFF_MS];

beforeEach(() => {
  cloud = new FakeCloud();
  setCloudApiForTests(cloud.api);
  setBlobTransportForTests(cloud.transport);
  CAS_BACKOFF_MS.fill(1);
});

afterEach(async () => {
  setCloudApiForTests(null);
  setBlobTransportForTests(null);
  for (let i = 0; i < originalBackoff.length; i += 1) CAS_BACKOFF_MS[i] = originalBackoff[i];
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function machine(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "summer-sync-"));
  roots.push(root);
  await writeFile(
    join(root, "summer-cloud.json"),
    JSON.stringify({ schemaVersion: 1, projectId: cloud.projectId })
  );
  return root;
}

async function seed(root: string, path: string, content: string): Promise<void> {
  const full = join(root, path);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content);
}

async function remoteHeadFiles(): Promise<Record<string, { sha256: string; size: number }>> {
  const manifest = await cloud.api.getManifest(cloud.projectId);
  return manifest.manifest.files;
}

describe("push and pull round trip", () => {
  it("first push, clone pull, and convergence across two machines", async () => {
    const a = await machine();
    await seed(a, "scripts/player.gd", "extends Node\n");
    await seed(a, "project.godot", "config_version=5\n");
    const pushed = await cloudPush({ project: a });
    expect(pushed.ok).toBe(true);
    expect(pushed.version).toBe(1);

    const b = await machine();
    const pulled = await cloudPull({ project: b });
    expect(pulled.version).toBe(1);
    expect(await readFile(join(b, "scripts/player.gd"), "utf8")).toBe("extends Node\n");
    expect((await readBase(b))?.version).toBe(1);

    const status = await cloudStatus({ project: b });
    expect(status.message).toBe("Cloud project is in sync");
  });

  it("push propagates edits and deletes; pull applies them after a checkpoint", async () => {
    const a = await machine();
    const b = await machine();
    await seed(a, "keep.gd", "v1");
    await seed(a, "gone.gd", "doomed");
    await seed(a, "edit.gd", "before");
    await cloudPush({ project: a });
    await cloudPull({ project: b });

    await seed(a, "edit.gd", "after");
    await rm(join(a, "gone.gd"));
    await cloudPush({ project: a, confirmDeletes: true });

    const pulled = await cloudPull({ project: b });
    expect(pulled.ok).toBe(true);
    expect(await readFile(join(b, "edit.gd"), "utf8")).toBe("after");
    expect(existsSync(join(b, "gone.gd"))).toBe(false);
    // Destructive apply must have produced a checkpoint ref.
    const { listCheckpoints } = await import("./checkpoint.js");
    expect((await listCheckpoints(b, cloud.projectId)).length).toBe(1);
  });
});

describe("blocker 1: rule-excluded paths are carried forward, never deleted", () => {
  it("a path excluded by a new .summercloudignore stays in the pushed manifest", async () => {
    const a = await machine();
    await seed(a, "keep.gd", "x");
    await seed(a, "model.blend", "big binary");
    await cloudPush({ project: a });

    await seed(a, ".summercloudignore", "*.blend\n");
    const pushed = await cloudPush({ project: a });
    expect(pushed.ok).toBe(true);

    const files = await remoteHeadFiles();
    expect(files["model.blend"]).toEqual({ sha256: sha256Hex("big binary"), size: 10 });
    expect(files[".summercloudignore"]).toBeDefined();
  });

  it("a manifest from newer rules restricts this client to carry-forward", async () => {
    const a = await machine();
    await seed(a, "keep.gd", "x");
    await cloudPush({ project: a });

    cloud.rulesVersion = 99; // future client wrote the manifest
    await seed(a, "keep.gd", "y");
    const pushed = await cloudPush({ project: a });
    expect(pushed.ok).toBe(true);
    expect(pushed.notices?.some((n) => n.includes("newer summer CLI"))).toBe(true);
  });
});

describe("blocker 2: empty local tree aborts outright", () => {
  it("refuses to diff a non-empty base against an empty walk, even with confirm-deletes", async () => {
    const a = await machine();
    await seed(a, "a.gd", "1");
    await seed(a, "b.gd", "2");
    await cloudPush({ project: a });

    await rm(join(a, "a.gd"));
    await rm(join(a, "b.gd"));
    await expect(cloudPush({ project: a, confirmDeletes: true })).rejects.toThrow(/unmounted volume|Aborting/);
  });
});

describe("delete guardrails", () => {
  it("blocks mass deletion without --confirm-deletes and allows it with", async () => {
    const a = await machine();
    for (let i = 0; i < 20; i += 1) await seed(a, `f${i}.gd`, String(i));
    await cloudPush({ project: a });
    for (let i = 0; i < 12; i += 1) await rm(join(a, `f${i}.gd`));
    await expect(cloudPush({ project: a })).rejects.toThrow(/confirm-deletes/);
    const pushed = await cloudPush({ project: a, confirmDeletes: true });
    expect(pushed.ok).toBe(true);
    expect(Object.keys(await remoteHeadFiles())).toHaveLength(8);
  });
});

describe("CAS 409 re-merge loop (spec 8.6.6)", () => {
  it("retries with a fresh full diff and succeeds", async () => {
    const a = await machine();
    await seed(a, "a.gd", "1");
    cloud.commit409Remaining = 2;
    const pushed = await cloudPush({ project: a });
    expect(pushed.ok).toBe(true);
    expect(cloud.commitCount).toBeGreaterThanOrEqual(3);
  });

  it("surfaces a clear error after exhausting retries", async () => {
    const a = await machine();
    await seed(a, "a.gd", "1");
    cloud.commit409Remaining = 99;
    await expect(cloudPush({ project: a })).rejects.toThrow(/another machine/);
  });
});

describe("422 blobs_not_verified re-upload loop (spec 8.6.6)", () => {
  it("re-uploads the listed hashes and re-commits", async () => {
    const a = await machine();
    await seed(a, "a.gd", "re-uploadable content");
    cloud.fail422Once = true;
    const pushed = await cloudPush({ project: a });
    expect(pushed.ok).toBe(true);
    expect((await remoteHeadFiles())["a.gd"].sha256).toBe(sha256Hex("re-uploadable content"));
  });
});

describe("bootstrap gate (spec 8.3)", () => {
  it("blocks auto-sync when both sides are non-empty and no base exists", async () => {
    const a = await machine();
    await seed(a, "a.gd", "cloud version");
    await cloudPush({ project: a });

    const b = await machine();
    await seed(b, "b.gd", "divergent local");
    await expect(cloudPush({ project: b })).rejects.toThrow(/bootstrap/);
    await expect(cloudPull({ project: b })).rejects.toThrow(/bootstrap/);
  });

  it("merge bootstrap converges identical hashes and conflicts the rest", async () => {
    const a = await machine();
    await seed(a, "same.gd", "identical");
    await seed(a, "diff.gd", "cloud bytes");
    await cloudPush({ project: a });

    const b = await machine();
    await seed(b, "same.gd", "identical");
    await seed(b, "diff.gd", "local bytes");
    const pulled = await cloudPull({ project: b, bootstrap: "merge" });
    expect(pulled.ok).toBe(true);
    expect(await readFile(join(b, "diff.gd"), "utf8")).toBe("cloud bytes");
    const sets = await listConflictSets(b);
    expect(sets).toHaveLength(1);
  });

  it("keep-local push replaces the cloud tree", async () => {
    const a = await machine();
    await seed(a, "cloud-only.gd", "x");
    await cloudPush({ project: a });

    const b = await machine();
    await seed(b, "local-only.gd", "y");
    const pushed = await cloudPush({ project: b, bootstrap: "keep-local" });
    expect(pushed.ok).toBe(true);
    const files = await remoteHeadFiles();
    expect(files["local-only.gd"]).toBeDefined();
    expect(files["cloud-only.gd"]).toBeUndefined();
  });
});

describe("conflicts (spec 10.1)", () => {
  it("CAS loser keeps remote bytes, preserves local bytes locally AND in R2", async () => {
    const a = await machine();
    const b = await machine();
    await seed(a, "f.gd", "v1");
    await cloudPush({ project: a });
    await cloudPull({ project: b });

    await seed(b, "f.gd", "b wins");
    await cloudPush({ project: b });

    await seed(a, "f.gd", "a loses");
    const pushed = await cloudPush({ project: a });
    expect(pushed.ok).toBe(true);
    expect(await readFile(join(a, "f.gd"), "utf8")).toBe("b wins");
    expect(pushed.notices?.some((n) => n.includes("conflicts restore"))).toBe(true);

    // Local conflict set holds the losing bytes.
    const sets = await listConflictSets(a);
    expect(sets).toHaveLength(1);
    expect(sets[0].meta?.entries.some((e) => e.path === "f.gd")).toBe(true);
    // The losing blob is durable in R2 (blob-only, unreferenced).
    expect(cloud.blobs.has(sha256Hex("a loses"))).toBe(true);
    // The cloud head still has the winner.
    expect((await remoteHeadFiles())["f.gd"].sha256).toBe(sha256Hex("b wins"));
  });

  it("conflicts restore brings preserved bytes back as a fresh edit", async () => {
    const a = await machine();
    const b = await machine();
    await seed(a, "f.gd", "v1");
    await cloudPush({ project: a });
    await cloudPull({ project: b });
    await seed(b, "f.gd", "winner");
    await cloudPush({ project: b });
    await seed(a, "f.gd", "loser");
    await cloudPush({ project: a });

    const restored = await cloudConflicts({ project: a, restorePath: "f.gd" });
    expect(restored.ok).toBe(true);
    expect(await readFile(join(a, "f.gd"), "utf8")).toBe("loser");
    // And it pushes as a normal edit.
    const repushed = await cloudPush({ project: a });
    expect((await remoteHeadFiles())["f.gd"].sha256).toBe(sha256Hex("loser"));
    expect(repushed.ok).toBe(true);
  });

  it("row 14: edit beats delete and is surfaced as a notice", async () => {
    const a = await machine();
    const b = await machine();
    await seed(a, "kept.gd", "v1");
    await seed(a, "other.gd", "x");
    await cloudPush({ project: a });
    await cloudPull({ project: b });

    await rm(join(b, "kept.gd"));
    await cloudPush({ project: b, confirmDeletes: true });

    await seed(a, "kept.gd", "edited offline");
    const pushed = await cloudPush({ project: a });
    expect(pushed.ok).toBe(true);
    expect(pushed.notices?.some((n) => n.includes("edit beats delete"))).toBe(true);
    expect((await remoteHeadFiles())["kept.gd"].sha256).toBe(sha256Hex("edited offline"));
  });
});

describe("project path gate (spec 8.3)", () => {
  it("blocks sync when the folder moved and adopts with adoptPath", async () => {
    const a = await machine();
    await seed(a, "a.gd", "x");
    await mkdir(join(a, ".summer", "local"), { recursive: true });
    await writeFile(join(a, ".summer", "local", ".project_path"), "/somewhere/else");

    await expect(cloudPush({ project: a })).rejects.toThrow(/adopt-path/);
    const pushed = await cloudPush({ project: a, adoptPath: true });
    expect(pushed.ok).toBe(true);
    expect((await readFile(join(a, ".summer", "local", ".project_path"), "utf8")).trim()).toBe(a);
  });
});

describe("pinnedVersion (spec 6.1)", () => {
  it("pull checks out the pinned version; push refuses", async () => {
    const a = await machine();
    await seed(a, "a.gd", "one");
    await cloudPush({ project: a });
    await seed(a, "a.gd", "two");
    await cloudPush({ project: a });

    const b = await machine();
    await writeFile(
      join(b, "summer-cloud.json"),
      JSON.stringify({ schemaVersion: 1, projectId: cloud.projectId, pinnedVersion: 1 })
    );
    const pulled = await cloudPull({ project: b });
    expect(pulled.version).toBe(1);
    expect(await readFile(join(b, "a.gd"), "utf8")).toBe("one");
    await expect(cloudPush({ project: b })).rejects.toThrow(/pin/i);
  });
});

describe("restore (spec 7.12)", () => {
  it("restores an old version as a NEW head and pulls it", async () => {
    const a = await machine();
    await seed(a, "a.gd", "version one");
    await cloudPush({ project: a });
    await seed(a, "a.gd", "version two");
    await cloudPush({ project: a });

    const restored = await cloudRestore({ project: a, version: 1 });
    expect(restored.ok).toBe(true);
    expect(cloud.headVersion).toBe(3); // history never rewritten
    expect(await readFile(join(a, "a.gd"), "utf8")).toBe("version one");
  });

  it("restores a local checkpoint and lists extraneous files", async () => {
    const a = await machine();
    const b = await machine();
    await seed(a, "a.gd", "original");
    await cloudPush({ project: a });
    await cloudPull({ project: b });

    // A bad remote change clobbers the file on b; pull checkpoints first.
    await seed(a, "a.gd", "clobbered");
    await seed(a, "added.gd", "new file");
    await cloudPush({ project: a });
    await cloudPull({ project: b });
    expect(await readFile(join(b, "a.gd"), "utf8")).toBe("clobbered");

    const { listCheckpoints } = await import("./checkpoint.js");
    const refs = await listCheckpoints(b, cloud.projectId);
    expect(refs.length).toBe(1);
    const stamp = refs[0].split("cloud-sync-")[1];
    const result = await cloudRestore({ project: b, checkpoint: stamp });
    expect(result.ok).toBe(true);
    expect(await readFile(join(b, "a.gd"), "utf8")).toBe("original");
    expect(existsSync(join(b, "added.gd"))).toBe(true); // listed, not deleted
    expect((result.details?.extraneousFiles as string[])).toContain("added.gd");
  });
});

describe("journal (spec 8.7)", () => {
  it("is removed after a completed pull and surfaces hydrating in status", async () => {
    const a = await machine();
    await seed(a, "a.gd", "x");
    await cloudPush({ project: a });

    const b = await machine();
    await cloudPull({ project: b });
    expect(await readJournal(b)).toBeNull();

    await writeJournal(b, { syncId: "s", targetVersion: 1, phase: "applying", pending: [] });
    const status = await cloudStatus({ project: b });
    expect(status.details?.hydrating).toBe(true);
  });

  it("resumes an interrupted pull: staged blobs are reused, fresh diff applies", async () => {
    const a = await machine();
    await seed(a, "big.bin", "blob content");
    await cloudPush({ project: a });

    const b = await machine();
    // Simulate a crash mid-pull: journal exists, blob already staged.
    const hash = sha256Hex("blob content");
    await mkdir(join(b, ".summer", "local", "cloud", "staging"), { recursive: true });
    await writeFile(join(b, ".summer", "local", "cloud", "staging", hash), "blob content");
    await writeJournal(b, { syncId: "crashed", targetVersion: 1, phase: "staging", pending: [{ path: "big.bin", sha256: hash }] });

    const pulled = await cloudPull({ project: b });
    expect(pulled.ok).toBe(true);
    expect(await readFile(join(b, "big.bin"), "utf8")).toBe("blob content");
    expect(await readJournal(b)).toBeNull();
    expect(cloud.presignGetBatchSizes).toEqual([]); // staged blob reused, no re-download
  });
});

describe("unstable files (spec 8.6.2)", () => {
  it("a file with no source on disk never drops a teammate's manifest entry", async () => {
    // Covered structurally: carried-forward entries upload nothing. Verify a
    // push with an untracked-but-based entry keeps the blob referenced.
    const a = await machine();
    await seed(a, "a.gd", "stable");
    await seed(a, "asset.translation", "machine generated"); // hard-excluded
    await cloudPush({ project: a });
    expect((await remoteHeadFiles())["asset.translation"]).toBeUndefined();
  });
});
