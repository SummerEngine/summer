import { chmod, copyFile, lstat, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { basename, dirname, join } from "path";
import { containedProjectPath } from "./containment.js";
import type { ConflictSetWriter } from "./conflicts.js";
import type { DiffPlan, PathDecision } from "./diff.js";
import { mergeProjectGodot } from "./project-godot-merge.js";
import type { CloudManifest, LocalFileStat } from "./types.js";
import { casefoldKey } from "./validate-path.js";

export interface ApplyContext {
  /** Staged blob path per sha256 (downloaded and hash-verified). */
  staged: Map<string, string>;
  /** Actual on-disk byte-name path per NFC manifest key (from the walk). */
  diskPathByKey: Map<string, string>;
  /** Pre-image stats captured at hash time for the apply-time stat check. */
  statByKey: Map<string, LocalFileStat>;
  /** Conflict set writer; losing bytes are preserved through it. */
  conflicts: ConflictSetWriter;
  /** Base manifest (for the project.godot 3-way merge). */
  base: CloudManifest | null;
  /** Called once before the first destructive apply (modify or delete). */
  onBeforeDestructive: () => Promise<void>;
}

export interface ApplyResult {
  /** Paths written or deleted on disk (for the engine rescan). */
  appliedPaths: string[];
  notices: string[];
  /** Local hashes preserved as conflict losers (pushed to R2 by the caller). */
  preservedLocalHashes: Map<string, string>;
}

const RENAME_RETRIES = 7;
const RENAME_BACKOFF_MS = 50;

/**
 * Two-phase pull, phase 2 (spec 8.7). Fixed order: renames first (case-only
 * renames as two-step), then writes (project.godot and *.tscn last), then
 * deletes. Every write is an atomic rename from staging; every modify or
 * delete is preceded by exactly one full-tree checkpoint and a pre-image
 * stat check that routes drifted files to conflicts instead of overwriting.
 */
export async function applyRemotePlan(
  projectRoot: string,
  plan: DiffPlan,
  remote: CloudManifest,
  context: ApplyContext
): Promise<ApplyResult> {
  const result: ApplyResult = { appliedPaths: [], notices: [], preservedLocalHashes: new Map() };
  const decisionByPath = new Map(plan.decisions.map((d) => [d.path, d]));

  let writes = [...plan.pullPaths, ...plan.conflictPaths].filter((path) => remote.files[path]);
  let deletes = [...plan.deleteLocalPaths];
  if (!writes.length && !deletes.length) return result;

  // Checkpoint before ANY destructive apply (spec 11): a modify of an
  // existing file or a delete.
  let checkpointed = false;
  const ensureCheckpoint = async () => {
    if (checkpointed) return;
    checkpointed = true;
    await context.onBeforeDestructive();
  };
  for (const path of writes) {
    if (await pathExistsOnDisk(projectRoot, path, context)) {
      await ensureCheckpoint();
      break;
    }
  }
  if (!checkpointed && deletes.length) await ensureCheckpoint();

  // Phase: renames. A delete-local plus pull pair with the same content hash
  // and casefold-equal keys is a case-only rename, executed as a two-step
  // rename so case-insensitive volumes never lose the file (spec 8.7).
  const renamed = await applyCaseOnlyRenames(projectRoot, plan, remote, context, decisionByPath, result);
  writes = writes.filter((path) => !renamed.has(path));
  deletes = deletes.filter((path) => !renamed.has(path));

  // Phase: writes, with project.godot and *.tscn last so a partially
  // hydrated project is never scanned with dangling scene dependencies.
  const stagedUseCount = new Map<string, number>();
  for (const path of writes) {
    const hash = remote.files[path].sha256;
    stagedUseCount.set(hash, (stagedUseCount.get(hash) ?? 0) + 1);
  }
  writes.sort((a, b) => writeOrderRank(a) - writeOrderRank(b) || (a < b ? -1 : a > b ? 1 : 0));

  for (const path of writes) {
    const decision = decisionByPath.get(path);
    const remoteFile = remote.files[path];
    const isConflict = plan.conflictPaths.includes(path);

    // Pre-image stat check (spec 8.7): a file that changed between diff and
    // apply is routed to conflicts instead of being blindly overwritten.
    const drifted = await driftedSinceDiff(projectRoot, path, context);
    if (isConflict || drifted) {
      await preserveLoser(projectRoot, path, decision, remoteFile.sha256, context, result, drifted && !isConflict);
    }

    if (path === "project.godot" && isConflict) {
      const merged = await mergeProjectGodotFromContext(projectRoot, path, decision, remote, context, result);
      if (merged) {
        result.appliedPaths.push(path);
        continue;
      }
    }

    const stagedPath = context.staged.get(remoteFile.sha256);
    if (!stagedPath) throw new Error(`Missing staged blob for ${path} (${remoteFile.sha256})`);
    const remaining = stagedUseCount.get(remoteFile.sha256)! - 1;
    stagedUseCount.set(remoteFile.sha256, remaining);
    await placeFromStaging(projectRoot, path, stagedPath, remaining > 0, context);
    result.appliedPaths.push(path);
  }

  // Phase: deletes.
  const survivingFold = new Map<string, string>();
  for (const key of Object.keys(remote.files)) survivingFold.set(casefoldKey(key), key);

  for (const path of deletes) {
    const decision = decisionByPath.get(path);
    const onDisk = context.diskPathByKey.get(path) ?? join(projectRoot, path);

    // Pre-image check: a delete target edited since the diff is row 14 now
    // (edit beats delete); keep the local file and surface it.
    if (await driftedSinceDiff(projectRoot, path, context)) {
      result.notices.push(`${path}: changed during sync; kept local file (edit beats delete)`);
      continue;
    }

    // Inode-gated casefold skip (spec 8.7): a delete whose casefolded path
    // equals a surviving manifest key is skipped only when a samefile check
    // proves both names map to one on-disk file.
    const survivor = survivingFold.get(casefoldKey(path));
    if (survivor && survivor !== path) {
      if (await isSameFile(onDisk, join(projectRoot, survivor))) {
        continue;
      }
    }

    if (decision?.local?.sha256) {
      result.preservedLocalHashes.set(decision.local.sha256, onDisk);
    }
    await rm(onDisk, { force: true });
    result.appliedPaths.push(path);
  }

  for (const path of plan.keepLocalPaths) {
    result.notices.push(`${path}: deleted in cloud but edited here; keeping local file (edit beats delete)`);
  }
  for (const path of plan.restoredRemotePaths) {
    result.notices.push(`${path}: deleted here but edited in cloud; restored the cloud file (edit beats delete)`);
  }

  return result;
}

function writeOrderRank(path: string): number {
  if (path === "project.godot") return 2;
  if (path.endsWith(".tscn")) return 1;
  return 0;
}

async function pathExistsOnDisk(projectRoot: string, path: string, context: ApplyContext): Promise<boolean> {
  const onDisk = context.diskPathByKey.get(path) ?? join(projectRoot, path);
  try {
    await lstat(onDisk);
    return true;
  } catch {
    return false;
  }
}

async function driftedSinceDiff(projectRoot: string, path: string, context: ApplyContext): Promise<boolean> {
  const recorded = context.statByKey.get(path);
  if (!recorded) return false;
  const onDisk = context.diskPathByKey.get(path) ?? join(projectRoot, path);
  try {
    const info = await lstat(onDisk, { bigint: true });
    return Number(info.size) !== recorded.size || info.mtimeNs.toString() !== recorded.mtimeNs;
  } catch {
    return false; // Gone since the diff; nothing to preserve.
  }
}

async function preserveLoser(
  projectRoot: string,
  path: string,
  decision: PathDecision | undefined,
  remoteSha256: string,
  context: ApplyContext,
  result: ApplyResult,
  drifted: boolean
): Promise<void> {
  const onDisk = context.diskPathByKey.get(path) ?? join(projectRoot, path);
  const localSha = decision?.local?.sha256;
  const preserved = await context.conflicts.preserve(
    path,
    {
      localSha256: localSha,
      remoteSha256,
      winner: "remote",
      note: drifted ? "changed between diff and apply" : undefined,
    },
    onDisk
  );
  if (preserved) {
    if (localSha) result.preservedLocalHashes.set(localSha, join(context.conflicts.setDir, path));
    result.notices.push(`${path}: cloud version won; your bytes are preserved (summer cloud conflicts restore ${path})`);
    // Sidecar bytes ride inside the conflict set for reference, never as a
    // second conflict copy in the scanned tree (spec 8.4).
    for (const suffix of [".import", ".uid"]) {
      const sidecar = `${path}${suffix}`;
      const sidecarOnDisk = context.diskPathByKey.get(sidecar) ?? join(projectRoot, sidecar);
      await context.conflicts.preserve(sidecar, { winner: "remote", sidecar: true }, sidecarOnDisk);
    }
  }
}

async function mergeProjectGodotFromContext(
  projectRoot: string,
  path: string,
  decision: PathDecision | undefined,
  remote: CloudManifest,
  context: ApplyContext,
  result: ApplyResult
): Promise<boolean> {
  const baseHash = context.base?.files[path]?.sha256;
  const baseStaged = baseHash ? context.staged.get(baseHash) : undefined;
  const remoteStaged = context.staged.get(remote.files[path].sha256);
  const onDisk = context.diskPathByKey.get(path) ?? join(projectRoot, path);
  if (!remoteStaged) return false;
  let baseText = "";
  let localText = "";
  let remoteText = "";
  try {
    baseText = baseStaged ? await readFile(baseStaged, "utf8") : "";
    localText = await readFile(onDisk, "utf8");
    remoteText = await readFile(remoteStaged, "utf8");
  } catch {
    return false; // Fall through to whole-file remote-wins via the caller.
  }
  const merged = mergeProjectGodot(baseText, localText, remoteText);
  if (merged.fallback) {
    result.notices.push("project.godot: could not parse all three versions; cloud file won whole-file, local copy preserved");
    return false;
  }
  for (const losing of merged.losingValues) {
    const where = losing.section ? `[${losing.section}] ` : "";
    result.notices.push(`project.godot: ${where}${losing.key}: cloud value won; local value was: ${losing.localValue}`);
  }
  const target = await containedProjectPath(projectRoot, path);
  const tmp = join(dirname(target), `.${basename(target)}.summer-cloud-tmp`);
  await writeFile(tmp, merged.merged, "utf8");
  await renameWithRetry(tmp, target);
  return true;
}

/**
 * Atomic placement from staging (spec 8.7): clear a read-only attribute on
 * the destination, then rename from staging into place (same volume). When
 * the same blob lands at several paths, all but the last use copy.
 */
async function placeFromStaging(
  projectRoot: string,
  path: string,
  stagedPath: string,
  keepStaged: boolean,
  context: ApplyContext
): Promise<void> {
  const target = await containedProjectPath(projectRoot, path);
  await clearReadOnly(target);
  // The walker's byte-name map may point at an NFD or different-case name for
  // this key; replace that exact on-disk file so we never strand a twin.
  const onDisk = context.diskPathByKey.get(path);
  if (onDisk && onDisk !== target) {
    await clearReadOnly(onDisk);
    await rm(onDisk, { force: true });
  }
  if (keepStaged) {
    const tmp = join(dirname(target), `.${basename(target)}.summer-cloud-tmp`);
    await copyFile(stagedPath, tmp);
    await renameWithRetry(tmp, target);
  } else {
    await renameWithRetry(stagedPath, target);
  }
}

async function clearReadOnly(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if ((info.mode & 0o200) === 0) {
      await chmod(path, info.mode | 0o200);
    }
  } catch {
    // Missing file: nothing to clear.
  }
}

/** Windows retry ladder (spec 8.7): EPERM/EBUSY/EACCES, 50 ms doubling, 7 tries. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  let delay = RENAME_BACKOFF_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!retryable || attempt >= RENAME_RETRIES - 1) throw err;
      await sleep(delay);
      delay *= 2;
    }
  }
}

async function applyCaseOnlyRenames(
  projectRoot: string,
  plan: DiffPlan,
  remote: CloudManifest,
  context: ApplyContext,
  decisionByPath: Map<string, PathDecision>,
  result: ApplyResult
): Promise<Set<string>> {
  const done = new Set<string>();
  const deleteByFold = new Map<string, string>();
  for (const path of plan.deleteLocalPaths) deleteByFold.set(casefoldKey(path), path);

  for (const pullPath of plan.pullPaths) {
    const oldPath = deleteByFold.get(casefoldKey(pullPath));
    if (!oldPath || oldPath === pullPath) continue;
    const oldDecision = decisionByPath.get(oldPath);
    const remoteFile = remote.files[pullPath];
    if (!remoteFile || oldDecision?.local?.sha256 !== remoteFile.sha256) continue;
    if (await driftedSinceDiff(projectRoot, oldPath, context)) continue;

    const source = context.diskPathByKey.get(oldPath) ?? join(projectRoot, oldPath);
    const target = await containedProjectPath(projectRoot, pullPath);
    const tmp = join(dirname(target), `.${basename(target)}.summer-cloud-rename-tmp`);
    try {
      await renameWithRetry(source, tmp);
      await renameWithRetry(tmp, target);
    } catch {
      continue; // Fall back to download-and-delete handling for this pair.
    }
    done.add(pullPath);
    done.add(oldPath);
    result.appliedPaths.push(pullPath);
  }
  return done;
}

async function isSameFile(a: string, b: string): Promise<boolean> {
  try {
    const [ia, ib] = await Promise.all([stat(a, { bigint: true }), stat(b, { bigint: true })]);
    return ia.dev === ib.dev && ia.ino === ib.ino;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
