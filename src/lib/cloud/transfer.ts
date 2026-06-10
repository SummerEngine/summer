import { mkdir, readFile } from "fs/promises";
import { join } from "path";
import { getCloudApi, type PresignedBlob } from "./api.js";
import { getBlobTransport } from "./http.js";
import { sha256Hex } from "./manifest.js";
import { stagingDir } from "./paths.js";

/** Server batch caps (spec 7.5 to 7.8); the server 400s above these. */
export const CHECK_BATCH = 10_000;
export const PRESIGN_BATCH = 500;
export const COMPLETE_BATCH = 500;
export const PRESIGN_GET_BATCH = 500;

const UPLOAD_CONCURRENCY = 16;
const DOWNLOAD_CONCURRENCY = 32;
const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000];

export interface UploadSource {
  size: number;
  path?: string;
  bytes?: Buffer;
}

export interface UploadOutcome {
  uploaded: string[];
  /** Hashes whose bytes diverged from the diff-time hash; requeue next run. */
  requeued: string[];
}

export async function uploadBlobs(projectId: string, blobs: Map<string, UploadSource>): Promise<UploadOutcome> {
  const api = getCloudApi();
  const hashes = [...blobs.keys()];
  const outcome: UploadOutcome = { uploaded: [], requeued: [] };
  if (!hashes.length) return outcome;

  const missing = new Set<string>();
  for (const chunk of chunks(hashes, CHECK_BATCH)) {
    for (const hash of (await api.checkBlobs(projectId, chunk)).missing) missing.add(hash);
  }
  if (!missing.size) return outcome;

  // JIT presign loop: presign in batches as the upload queue drains so URLs
  // stay fresh on slow links.
  const queue = [...missing];
  while (queue.length) {
    const batch = queue.splice(0, PRESIGN_BATCH);
    const toPresign = batch.map((sha256) => {
      const source = blobs.get(sha256);
      if (!source) throw new Error(`Missing upload source for ${sha256}`);
      return { sha256, size: source.size };
    });
    const signed = await api.presignBlobs(projectId, toPresign);
    const completed: Array<{ sha256: string; uploadId: string }> = [];

    await runWithConcurrency(signed.blobs, UPLOAD_CONCURRENCY, async (item) => {
      if (item.status === "exists") return;
      if (item.status !== "upload" || !item.url || !item.uploadId || !item.headers) {
        throw new Error(item.message || `Could not presign ${item.sha256}: ${item.status}`);
      }
      const result = await putWithRetry(projectId, item, blobs.get(item.sha256)!);
      if (result === "uploaded") {
        completed.push({ sha256: item.sha256, uploadId: item.uploadId });
        outcome.uploaded.push(item.sha256);
      } else if (result === "already-verified") {
        outcome.uploaded.push(item.sha256);
      } else {
        outcome.requeued.push(item.sha256);
      }
    });

    for (const completeChunk of chunks(completed, COMPLETE_BATCH)) {
      if (!completeChunk.length) continue;
      const result = await api.completeBlobs(projectId, completeChunk);
      const failed = result.uploads.filter((upload) => upload.status !== "verified");
      if (failed.length) {
        throw new Error(`Cloud upload completion failed: ${failed.map((f) => `${f.sha256}:${f.status}`).join(", ")}`);
      }
    }
  }

  return outcome;
}

type PutResult = "uploaded" | "already-verified" | "requeued";

async function putWithRetry(
  projectId: string,
  item: PresignedBlob,
  source: UploadSource
): Promise<PutResult> {
  const api = getCloudApi();
  const transport = getBlobTransport();
  // Re-hash the bytes that are actually sent (spec 8.6.4); on divergence from
  // the diff-time hash, abort this file and requeue it for the next run.
  const bytes = source.bytes ?? (await readFile(source.path!));
  if (sha256Hex(bytes) !== item.sha256) {
    return "requeued";
  }
  for (let attempt = 0; ; attempt += 1) {
    const status = await transport.put(item.url!, item.headers!, bytes);
    if (status >= 200 && status < 300) return "uploaded";
    if (status === 429) {
      // R2 per-key write throttling: back off 1s and re-check; verified means
      // someone else won the race with identical bytes.
      await sleep(1_000);
      const recheck = await api.checkBlobs(projectId, [item.sha256]);
      if (!recheck.missing.includes(item.sha256)) return "already-verified";
    }
    if (attempt >= RETRY_BACKOFF_MS.length) {
      throw new Error(`R2 upload failed for ${item.sha256}: ${status}`);
    }
    await sleep(RETRY_BACKOFF_MS[attempt]);
  }
}

/**
 * Two-phase pull, phase 1 (spec 8.7): stream every needed blob to
 * .summer/local/cloud/staging/{sha256}, verify its sha256, fsync. Returns the
 * staged file path per hash. Already-staged blobs with a verified hash are
 * reused (journal resume).
 */
export async function downloadBlobs(projectRoot: string, projectId: string, hashes: string[]): Promise<Map<string, string>> {
  const api = getCloudApi();
  const transport = getBlobTransport();
  const unique = [...new Set(hashes)];
  const staged = new Map<string, string>();
  await mkdir(stagingDir(projectRoot), { recursive: true, mode: 0o700 });

  const needed: string[] = [];
  for (const hash of unique) {
    const path = join(stagingDir(projectRoot), hash);
    if (await isStagedAndValid(path, hash)) {
      staged.set(hash, path);
    } else {
      needed.push(hash);
    }
  }

  for (const chunk of chunks(needed, PRESIGN_GET_BATCH)) {
    const signed = await api.presignGet(projectId, chunk);
    if (signed.missing.length) {
      throw new Error(`Cloud is missing referenced blobs: ${signed.missing.join(", ")}`);
    }
    await runWithConcurrency(chunk, DOWNLOAD_CONCURRENCY, async (hash) => {
      const url = signed.urls[hash];
      if (!url) throw new Error(`No URL for ${hash}`);
      const path = join(stagingDir(projectRoot), hash);
      for (let attempt = 0; ; attempt += 1) {
        const result = await transport.getToFile(url, path);
        if (result.status >= 200 && result.status < 300) {
          if (result.sha256 !== hash) throw new Error(`Downloaded blob hash mismatch: ${hash}`);
          staged.set(hash, path);
          return;
        }
        if (attempt >= RETRY_BACKOFF_MS.length) {
          throw new Error(`Download failed for ${hash}: ${result.status}`);
        }
        await sleep(RETRY_BACKOFF_MS[attempt]);
      }
    });
  }

  return staged;
}

async function isStagedAndValid(path: string, hash: string): Promise<boolean> {
  try {
    const bytes = await readFile(path);
    return sha256Hex(bytes) === hash;
  } catch {
    return false;
  }
}

async function runWithConcurrency<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const pending = [...items];
  const errors: unknown[] = [];
  const runners = Array.from({ length: Math.min(limit, pending.length) }, async () => {
    while (pending.length) {
      const item = pending.shift();
      if (item === undefined) return;
      try {
        await worker(item);
      } catch (err) {
        errors.push(err);
      }
    }
  });
  await Promise.all(runners);
  if (errors.length) throw errors[0];
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
