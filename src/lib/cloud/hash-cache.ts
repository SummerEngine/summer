import { readFile } from "fs/promises";
import { hashCachePath, writeJsonAtomic } from "./paths.js";

export interface HashCacheEntry {
  sha256: string;
  size: number;
  mtimeNs: string;
  ctimeNs: string;
  inode: string;
}

export type HashCache = Record<string, HashCacheEntry>;

export async function readHashCache(projectRoot: string): Promise<HashCache> {
  try {
    const parsed = JSON.parse(await readFile(hashCachePath(projectRoot), "utf8")) as HashCache;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeHashCache(projectRoot: string, cache: HashCache): Promise<void> {
  await writeJsonAtomic(hashCachePath(projectRoot), cache);
}

export interface StatLike {
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  ino: bigint;
}

/**
 * Cache hit rule (spec 6.2): rehash when any field differs, and apply Git's
 * racily-clean rule: any file whose mtime is at or after the sync start time
 * is rehashed regardless of cache.
 */
export function cacheHit(entry: HashCacheEntry | undefined, stat: StatLike, syncStartMs: number): boolean {
  if (!entry) return false;
  if (BigInt(entry.size) !== stat.size) return false;
  if (entry.mtimeNs !== stat.mtimeNs.toString()) return false;
  if (entry.ctimeNs !== stat.ctimeNs.toString()) return false;
  if (entry.inode !== stat.ino.toString()) return false;
  const mtimeMs = Number(stat.mtimeNs / 1_000_000n);
  if (mtimeMs >= syncStartMs) return false;
  return true;
}

export function cacheEntryFor(sha256: string, stat: StatLike): HashCacheEntry {
  return {
    sha256,
    size: Number(stat.size),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    inode: stat.ino.toString(),
  };
}
