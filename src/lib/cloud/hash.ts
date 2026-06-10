import { createHash } from "crypto";
import { open, readdir } from "fs/promises";
import { join } from "path";
import { cacheEntryFor, cacheHit, readHashCache, writeHashCache, type HashCache, type StatLike } from "./hash-cache.js";
import { isHardExcludedDir, isHardExcludedFile, isIgnoredByRules, loadTrackedRules, type TrackedRules } from "./rules.js";
import type { LocalFileStat, ManifestFile, WalkResult } from "./types.js";
import { findPathCollisions, validateCloudPath } from "./validate-path.js";

export interface WalkOptions {
  /** Sync start time for the racily-clean rule. Defaults to now. */
  syncStartMs?: number;
  /** Skip reading/writing hash-cache.json (used by tests). */
  noCache?: boolean;
}

export async function walkProject(projectRoot: string, options: WalkOptions = {}): Promise<WalkResult> {
  const rules = await loadTrackedRules(projectRoot);
  const syncStartMs = options.syncStartMs ?? Date.now();
  const cache: HashCache = options.noCache ? {} : await readHashCache(projectRoot);
  const nextCache: HashCache = {};

  const files: Record<string, ManifestFile> = {};
  const fileByHash = new Map<string, string>();
  const diskPathByKey = new Map<string, string>();
  const statByKey = new Map<string, LocalFileStat>();
  const skippedSymlinks: string[] = [];
  const unstablePaths: string[] = [];

  async function walk(dir: string, relKey: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    const siblingNames = new Set(entries.map((entry) => entry.name.normalize("NFC")));
    for (const entry of entries) {
      // Manifest keys are NFC; diskPathByKey keeps the actual byte names for I/O.
      const nfcName = entry.name.normalize("NFC");
      const fullPath = join(dir, entry.name);
      const key = relKey ? `${relKey}/${nfcName}` : nfcName;
      if (!key || key === "summer-cloud.json") continue;
      if (entry.isSymbolicLink()) {
        skippedSymlinks.push(key);
        continue;
      }
      if (entry.isDirectory()) {
        if (isHardExcludedDir(key, nfcName)) continue;
        if (isIgnoredByRules(key, true, rules)) continue;
        await walk(fullPath, key);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isHardExcludedFile(key, nfcName, siblingNames)) continue;
      if (isIgnoredByRules(key, false, rules)) continue;
      const valid = validateCloudPath(key);
      if (!valid.ok) {
        throw new Error(`Refusing to sync invalid path ${key}: ${valid.reason}`);
      }
      const hashed = await hashStableFile(fullPath, cache[key], syncStartMs);
      if (!hashed) {
        unstablePaths.push(key);
        continue;
      }
      files[key] = { sha256: hashed.sha256, size: hashed.size };
      nextCache[key] = cacheEntryFor(hashed.sha256, hashed.stat);
      diskPathByKey.set(key, fullPath);
      statByKey.set(key, {
        size: hashed.size,
        mtimeNs: hashed.stat.mtimeNs.toString(),
        inode: hashed.stat.ino.toString(),
      });
      if (!fileByHash.has(hashed.sha256)) {
        fileByHash.set(hashed.sha256, fullPath);
      }
    }
  }

  await walk(projectRoot, "");

  const collisions = findPathCollisions(Object.keys(files));
  if (collisions.length) {
    const lines = collisions.map((c) => `${c.a} and ${c.b} (${c.kind})`).join("; ");
    throw new Error(`On-disk file names collide after normalization and cannot sync: ${lines}. Rename one of each pair.`);
  }

  if (!options.noCache) {
    await writeHashCache(projectRoot, nextCache).catch(() => {});
  }
  return { files, fileByHash, diskPathByKey, statByKey, skippedSymlinks, unstablePaths };
}

interface StableHash {
  sha256: string;
  size: number;
  stat: StatLike;
}

/**
 * Per-file stability check (spec 8.6.2): fstat the open fd before hashing,
 * hash, fstat again; on any difference re-read; after 3 attempts return null
 * so the caller excludes the file from THIS push and carries forward its
 * previous manifest entry. Never throws for instability.
 */
async function hashStableFile(
  path: string,
  cached: ReturnType<typeof cacheEntryFor> | undefined,
  syncStartMs: number
): Promise<StableHash | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const handle = await open(path, "r");
    try {
      const before = statLike(await handle.stat({ bigint: true }));
      if (cacheHit(cached, before, syncStartMs)) {
        return { sha256: cached!.sha256, size: Number(before.size), stat: before };
      }
      const bytes = await handle.readFile();
      const after = statLike(await handle.stat({ bigint: true }));
      if (before.size === after.size && before.mtimeNs === after.mtimeNs && before.ino === after.ino) {
        return {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.length,
          stat: after,
        };
      }
    } finally {
      await handle.close();
    }
  }
  return null;
}

function statLike(stat: { size: bigint; mtimeNs: bigint; ctimeNs: bigint; ino: bigint }): StatLike {
  return { size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs, ino: stat.ino };
}

export type { TrackedRules };
