import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { conflictsDir, writeJsonAtomic } from "../../project-memory/cloud-paths.js";
import { containedProjectPath } from "./containment.js";

/**
 * Conflict sets (spec 10.1). Losing bytes never enter the synced tree; they
 * live under .summer/local/cloud/conflicts/<utcstamp>/<original relative
 * path> plus meta.json, and the losing blob is also pushed to R2 (blob-only,
 * granted, unreferenced) so recovery survives the machine.
 */

export interface ConflictEntry {
  path: string;
  localSha256?: string;
  remoteSha256?: string;
  winner: "remote" | "local";
  /** True when this entry is sidecar bytes kept for reference inside the set. */
  sidecar?: boolean;
  note?: string;
}

export interface ConflictMeta {
  schemaVersion: 1;
  stamp: string;
  projectId: string;
  baseVersion: number | null;
  targetVersion: number | null;
  entries: ConflictEntry[];
}

const KEEP_SETS = 20;
const KEEP_DAYS = 30;

export class ConflictSetWriter {
  private entries: ConflictEntry[] = [];
  private wrotePaths = new Set<string>();

  constructor(
    private readonly projectRoot: string,
    readonly stamp: string,
    private readonly projectId: string,
    private readonly baseVersion: number | null,
    private readonly targetVersion: number | null
  ) {}

  get setDir(): string {
    return join(conflictsDir(this.projectRoot), this.stamp);
  }

  /** Preserves the current on-disk bytes of `path` into the conflict set. */
  async preserve(path: string, entry: Omit<ConflictEntry, "path">, sourcePath?: string): Promise<boolean> {
    const source = sourcePath ?? join(this.projectRoot, path);
    const target = join(this.setDir, path);
    try {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(source, target);
    } catch {
      return false; // Nothing local to preserve.
    }
    if (!this.wrotePaths.has(path)) {
      this.wrotePaths.add(path);
      this.entries.push({ path, ...entry });
    }
    return true;
  }

  hasEntries(): boolean {
    return this.entries.length > 0;
  }

  listEntries(): ConflictEntry[] {
    return [...this.entries];
  }

  async finalize(): Promise<void> {
    if (!this.entries.length) return;
    const meta: ConflictMeta = {
      schemaVersion: 1,
      stamp: this.stamp,
      projectId: this.projectId,
      baseVersion: this.baseVersion,
      targetVersion: this.targetVersion,
      entries: this.entries,
    };
    await writeJsonAtomic(join(this.setDir, "meta.json"), meta);
    await pruneConflictSets(this.projectRoot);
  }
}

export function conflictStamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export async function listConflictSets(projectRoot: string): Promise<Array<{ stamp: string; meta: ConflictMeta | null }>> {
  let names: string[] = [];
  try {
    names = (await readdir(conflictsDir(projectRoot), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  const sets: Array<{ stamp: string; meta: ConflictMeta | null }> = [];
  for (const stamp of names) {
    let meta: ConflictMeta | null = null;
    try {
      meta = JSON.parse(await readFile(join(conflictsDir(projectRoot), stamp, "meta.json"), "utf8")) as ConflictMeta;
    } catch {
      meta = null;
    }
    sets.push({ stamp, meta });
  }
  return sets;
}

/** Retention (spec 6.2): last 20 conflict sets or 30 days, whichever is more. */
export async function pruneConflictSets(projectRoot: string): Promise<void> {
  const sets = await listConflictSets(projectRoot);
  if (sets.length <= KEEP_SETS) return;
  const cutoffMs = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  const excess = sets.slice(0, sets.length - KEEP_SETS);
  for (const set of excess) {
    const dir = join(conflictsDir(projectRoot), set.stamp);
    try {
      const info = await stat(dir);
      if (info.mtimeMs >= cutoffMs) continue; // Younger than 30 days: keep.
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Ignore unreadable sets.
    }
  }
}

export interface ConflictRestoreResult {
  path: string;
  stamp: string;
}

/**
 * `summer cloud conflicts restore <path>`: copies the preserved bytes back
 * into the project tree as a fresh edit (next push syncs it normally).
 */
export async function restoreConflictPath(projectRoot: string, path: string, stamp?: string): Promise<ConflictRestoreResult> {
  const sets = await listConflictSets(projectRoot);
  const candidates = (stamp ? sets.filter((set) => set.stamp === stamp) : sets).reverse();
  for (const set of candidates) {
    const source = join(conflictsDir(projectRoot), set.stamp, path);
    try {
      const bytes = await readFile(source);
      const target = await containedProjectPath(projectRoot, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
      return { path, stamp: set.stamp };
    } catch {
      continue;
    }
  }
  throw new Error(stamp ? `No preserved bytes for ${path} in conflict set ${stamp}` : `No preserved bytes found for ${path} in any conflict set`);
}
