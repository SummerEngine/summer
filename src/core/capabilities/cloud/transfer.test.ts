import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setCloudApiForTests } from "./api.js";
import { setBlobTransportForTests } from "./http.js";
import { sha256Hex } from "./manifest.js";
import { stagingDir } from "../../../project-memory/cloud-paths.js";
import { FakeCloud } from "./test-helpers/fake-cloud.js";
import { downloadBlobs, uploadBlobs } from "./transfer.js";

let cloud: FakeCloud;
let projectRoot: string;

beforeEach(async () => {
  cloud = new FakeCloud();
  setCloudApiForTests(cloud.api);
  setBlobTransportForTests(cloud.transport);
  projectRoot = await mkdtemp(join(tmpdir(), "summer-transfer-"));
  await mkdir(stagingDir(projectRoot), { recursive: true });
});

afterEach(async () => {
  setCloudApiForTests(null);
  setBlobTransportForTests(null);
  await rm(projectRoot, { recursive: true, force: true });
});

describe("uploadBlobs", () => {
  it("uploads missing blobs and skips existing ones", async () => {
    const existing = cloud.seedBlob("already there");
    const sources = new Map([
      [existing, { size: 13, bytes: Buffer.from("already there") }],
      [sha256Hex("fresh"), { size: 5, bytes: Buffer.from("fresh") }],
    ]);
    const outcome = await uploadBlobs(cloud.projectId, sources);
    expect(outcome.uploaded).toEqual([sha256Hex("fresh")]);
    expect(cloud.blobs.has(sha256Hex("fresh"))).toBe(true);
    expect(cloud.putCount).toBe(1);
  });

  it("requeues files whose bytes diverged from the diff-time hash", async () => {
    const path = join(projectRoot, "volatile.bin");
    await writeFile(path, "new content after diff");
    const staleHash = sha256Hex("content at diff time");
    const outcome = await uploadBlobs(cloud.projectId, new Map([[staleHash, { size: 20, path }]]));
    expect(outcome.requeued).toEqual([staleHash]);
    expect(cloud.blobs.has(staleHash)).toBe(false);
  });

  it("backs off on PUT 429 and counts success if the blob verified meanwhile", async () => {
    const hash = sha256Hex("contended");
    cloud.put429Hashes.add(hash);
    // Simulate another machine winning the race: blob exists by re-check time.
    const original = cloud.api.checkBlobs.bind(cloud.api);
    let checks = 0;
    cloud.api.checkBlobs = async (projectId, hashes) => {
      checks += 1;
      if (checks > 1) cloud.blobs.set(hash, Buffer.from("contended"));
      return original(projectId, hashes);
    };
    const outcome = await uploadBlobs(cloud.projectId, new Map([[hash, { size: 9, bytes: Buffer.from("contended") }]]));
    expect(outcome.uploaded).toContain(hash);
  }, 15_000);

  it("chunks check and presign batches under the server caps", async () => {
    const sources = new Map<string, { size: number; bytes: Buffer }>();
    for (let i = 0; i < 1_205; i += 1) {
      const bytes = Buffer.from(`blob-${i}`);
      sources.set(sha256Hex(bytes), { size: bytes.length, bytes });
    }
    await uploadBlobs(cloud.projectId, sources);
    expect(Math.max(...cloud.presignBatchSizes)).toBeLessThanOrEqual(500);
    expect(Math.max(...cloud.completeBatchSizes)).toBeLessThanOrEqual(500);
    expect(Math.max(...cloud.checkBatchSizes)).toBeLessThanOrEqual(10_000);
    expect(cloud.blobs.size).toBe(1_205);
  });
});

describe("downloadBlobs (two-phase pull, phase 1)", () => {
  it("stages blobs to files, hash-verified, and returns their paths", async () => {
    const hash = cloud.seedBlob("downloadable");
    const staged = await downloadBlobs(projectRoot, cloud.projectId, [hash]);
    const path = staged.get(hash)!;
    expect(path).toBe(join(stagingDir(projectRoot), hash));
    expect(await readFile(path, "utf8")).toBe("downloadable");
  });

  it("reuses already-staged verified blobs without re-downloading (journal resume)", async () => {
    const bytes = Buffer.from("resumable");
    const hash = sha256Hex(bytes);
    cloud.blobs.set(hash, bytes);
    await writeFile(join(stagingDir(projectRoot), hash), bytes);
    const staged = await downloadBlobs(projectRoot, cloud.projectId, [hash]);
    expect(staged.get(hash)).toBeDefined();
    expect(cloud.presignGetBatchSizes).toEqual([]); // no network round trip at all
  });

  it("re-downloads corrupt staged files", async () => {
    const hash = cloud.seedBlob("good bytes");
    await writeFile(join(stagingDir(projectRoot), hash), "corrupted bytes");
    const staged = await downloadBlobs(projectRoot, cloud.projectId, [hash]);
    expect(await readFile(staged.get(hash)!, "utf8")).toBe("good bytes");
  });

  it("fails loudly when the cloud is missing referenced blobs", async () => {
    await expect(downloadBlobs(projectRoot, cloud.projectId, [sha256Hex("nope")])).rejects.toThrow(/missing referenced blobs/);
  });

  it("chunks presign-get batches under 500", async () => {
    const hashes: string[] = [];
    for (let i = 0; i < 750; i += 1) hashes.push(cloud.seedBlob(`dl-${i}`));
    await downloadBlobs(projectRoot, cloud.projectId, hashes);
    expect(cloud.presignGetBatchSizes.length).toBeGreaterThan(1);
    expect(Math.max(...cloud.presignGetBatchSizes)).toBeLessThanOrEqual(500);
  });
});
