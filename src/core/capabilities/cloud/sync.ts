import { randomUUID } from "crypto";
import { stat } from "fs/promises";
import { resolve } from "path";
import { CloudApiError, getCloudApi, type RemoteManifest } from "./api.js";
import { applyRemotePlan } from "./apply.js";
import { createCheckpoint, listCheckpoints, restoreCheckpoint } from "./checkpoint.js";
import { ConflictSetWriter, conflictStamp, listConflictSets, restoreConflictPath } from "./conflicts.js";
import { assertDeleteGuard, assertNotEmptyLocalTree, diffManifests, type DiffPlan } from "./diff.js";
import {
  notifyEngineAfterApply,
  readProjectPathMarker,
  saveDirtyScenesIfRunning,
  writeProjectPathMarker,
} from "./engine-bridge.js";
import { walkProject } from "./hash.js";
import { acquireCloudLock } from "../../../project-memory/cloud-lock.js";
import { serializeManifest, sha256Hex } from "./manifest.js";
import {
  ensureCloudDirs,
  projectDisplayName,
  readBase,
  readBinding,
  readJournal,
  removeJournal,
  resolveProjectRoot,
  writeBase,
  writeBinding,
  writeJournal,
} from "../../../project-memory/cloud-paths.js";
import { isTrackedByCurrentRules, loadTrackedRules, RULES_VERSION, type TrackedRules } from "./rules.js";
import { downloadBlobs, uploadBlobs, type UploadSource } from "./transfer.js";
import type { BaseState, CloudManifest, SyncOptions, SyncResult, WalkResult } from "./types.js";

const CAS_RETRY_ATTEMPTS = 5;
/** Jittered 409 backoff schedule. Exported so tests can shrink the delays. */
export const CAS_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
const REUPLOAD_ATTEMPTS = 3;

type Face = "cli" | "mcp" | "engine";

export interface SyncRunOptions extends SyncOptions {
  face?: Face;
}

export async function cloudInit(options: SyncRunOptions = {}): Promise<SyncResult> {
  const projectRoot = resolveProjectRoot(options.project);
  await ensureCloudDirs(projectRoot);
  const existing = await readBinding(projectRoot);
  if (existing) {
    return { ok: true, action: "init", projectId: existing.projectId, message: "Project is already bound to Summer Cloud" };
  }

  const name = await projectDisplayName(projectRoot);
  const created = await getCloudApi().createCloudProject({ name });
  await writeBinding(projectRoot, { schemaVersion: 1, projectId: created.projectId });
  // base.json is only ever replaced under the sync lock (spec 8.2).
  const lock = await acquireCloudLock(projectRoot, options.face ?? "cli");
  try {
    await writeBase(projectRoot, {
      schemaVersion: 1,
      projectId: created.projectId,
      version: created.headVersion,
      rulesVersion: RULES_VERSION,
      files: {},
    });
  } finally {
    await lock.release();
  }
  return { ok: true, action: "init", projectId: created.projectId, version: created.headVersion, message: "Summer Cloud enabled" };
}

export async function cloudStatus(options: SyncRunOptions = {}): Promise<SyncResult> {
  const projectRoot = resolveProjectRoot(options.project);
  const binding = await requireBinding(projectRoot);
  const api = getCloudApi();
  const [base, project, local, journal, conflictSets] = await Promise.all([
    readBase(projectRoot),
    api.getCloudProject(binding.projectId),
    walkProject(projectRoot),
    readJournal(projectRoot),
    listConflictSets(projectRoot),
  ]);
  const remote = await api.getManifest(binding.projectId, binding.pinnedVersion);
  const rules = await loadTrackedRules(projectRoot);
  const notices: string[] = [];
  const localManifest = buildLocalManifest(binding.projectId, remote, base, local, rules, notices);
  const plan = diffManifests(baseToManifest(base, binding.projectId), localManifest, remote.manifest);
  return {
    ok: true,
    action: "status",
    projectId: binding.projectId,
    version: project.headVersion,
    message: summarizePlan(plan),
    notices,
    details: {
      localFiles: Object.keys(local.files).length,
      remoteFiles: Object.keys(remote.manifest.files).length,
      baseVersion: base?.version ?? null,
      pinnedVersion: binding.pinnedVersion ?? null,
      push: plan.pushPaths.length + plan.deleteRemotePaths.length,
      pull: plan.pullPaths.length + plan.deleteLocalPaths.length,
      conflicts: plan.conflictPaths.length,
      keepLocal: plan.keepLocalPaths,
      hydrating: Boolean(journal),
      conflictSets: conflictSets.map((set) => set.stamp),
      skippedSymlinks: local.skippedSymlinks,
      unstablePaths: local.unstablePaths,
    },
  };
}

export async function cloudPush(options: SyncRunOptions = {}): Promise<SyncResult> {
  const projectRoot = resolveProjectRoot(options.project);
  await ensureCloudDirs(projectRoot);
  const binding = await requireBinding(projectRoot);
  if (binding.pinnedVersion !== undefined) {
    throw new Error(`summer-cloud.json pins version ${binding.pinnedVersion} (read-only checkout). Remove pinnedVersion to push.`);
  }
  const notices: string[] = [];
  await assertProjectPathGate(projectRoot, options, notices);
  const lock = await acquireCloudLock(projectRoot, options.face ?? "cli");
  try {
    await saveDirtyScenesIfRunning(projectRoot);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await pushOnce(projectRoot, binding.projectId, options, notices);
      } catch (err) {
        // Spec 8.6.6: on CAS 409 re-fetch head, re-run the FULL diff, retry
        // with a fresh syncId. Bounded with jittered backoff.
        if (err instanceof CloudApiError && err.status === 409 && attempt < CAS_RETRY_ATTEMPTS - 1) {
          await sleep(jitter(CAS_BACKOFF_MS[Math.min(attempt, CAS_BACKOFF_MS.length - 1)]));
          continue;
        }
        if (err instanceof CloudApiError && err.status === 409) {
          throw new Error("Project is being synced from another machine, retry later");
        }
        throw err;
      }
    }
  } finally {
    await lock.release();
  }
}

async function pushOnce(projectRoot: string, projectId: string, options: SyncRunOptions, notices: string[]): Promise<SyncResult> {
  const api = getCloudApi();
  const remote = await api.getManifest(projectId);
  const base = await readBase(projectRoot);
  const walked = await walkProject(projectRoot, { syncStartMs: Date.now() });
  assertBootstrapGate("push", base, walked, remote, options);

  const rules = await loadTrackedRules(projectRoot);
  const local = buildLocalManifest(projectId, remote, base, walked, rules, notices);
  const baseFileCount = Object.keys(base?.files ?? {}).length;
  // Hard abort BEFORE any confirmation (spec 8.5): a non-empty base with an
  // empty local walk reads as 100% deletions and must never be pushable.
  assertNotEmptyLocalTree(baseFileCount, Object.keys(walked.files).length);

  const plan = diffManifests(baseToManifest(base, projectId), local, remote.manifest);
  assertDeleteGuard(plan, baseFileCount, options.confirmDeletes);

  // Spec 8.6.3: if pulls are needed, run the pull phase first so the push
  // manifests a converged tree (skipped only for the keep-local bootstrap).
  const needsRemote = plan.pullPaths.length + plan.deleteLocalPaths.length + plan.conflictPaths.length;
  if (needsRemote && options.bootstrap !== "keep-local") {
    await pullPhase(projectRoot, projectId, plan, remote, base, walked, notices);
  } else {
    notices.push(...rowNotices(plan));
  }

  const finalWalk = await walkProject(projectRoot, { syncStartMs: Date.now() });
  const finalManifest = buildLocalManifest(projectId, remote, options.bootstrap === "keep-local" ? null : base, finalWalk, rules, notices);
  if (options.bootstrap === "keep-local") {
    // Keep-local replaces the cloud tree with the local one (spec 8.3.b).
    finalManifest.files = { ...finalWalk.files };
  }

  const uploadSources = new Map<string, UploadSource>();
  for (const [, file] of Object.entries(finalManifest.files)) {
    const source = finalWalk.fileByHash.get(file.sha256);
    if (source) uploadSources.set(file.sha256, { size: file.size, path: source });
  }

  const outcome = await uploadBlobs(projectId, uploadSources);
  if (outcome.requeued.length) {
    applyRequeuedCarryForward(finalManifest, base, new Set(outcome.requeued), notices);
  }

  const committed = await commitWithReuploadLoop(projectId, finalManifest, remote.version, (hash) =>
    finalWalk.fileByHash.get(hash)
  );
  await writeBase(projectRoot, { ...finalManifest, version: committed.version });
  return {
    ok: true,
    action: "push",
    projectId,
    version: committed.version,
    message: "Pushed to Summer Cloud",
    notices: [...new Set(notices)],
  };
}

async function commitWithReuploadLoop(
  projectId: string,
  manifest: CloudManifest,
  baseVersion: number,
  diskPathForHash: (hash: string) => string | undefined
): Promise<{ version: number }> {
  const api = getCloudApi();
  const manifestBytes = serializeManifest(manifest);
  const manifestSha256 = sha256Hex(manifestBytes);
  await uploadBlobs(projectId, new Map([[manifestSha256, { size: manifestBytes.length, bytes: manifestBytes }]]));

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await api.commitManifest(projectId, {
        baseVersion,
        manifestSha256,
        syncId: randomUUID(),
        rulesVersion: Math.max(manifest.rulesVersion, RULES_VERSION),
      });
    } catch (err) {
      // Spec 8.6.6: 422 blobs_not_verified lists hashes to re-upload; the
      // client has the bytes, it just hashed them. Also covers the GC race.
      if (err instanceof CloudApiError && err.status === 422 && err.code === "blobs_not_verified" && attempt < REUPLOAD_ATTEMPTS - 1) {
        const missing = extractMissingHashes(err);
        if (!missing.length) throw err;
        const sizeByHash = new Map<string, number>();
        for (const file of Object.values(manifest.files)) sizeByHash.set(file.sha256, file.size);
        const sources = new Map<string, UploadSource>();
        for (const hash of missing) {
          if (hash === manifestSha256) {
            sources.set(hash, { size: manifestBytes.length, bytes: manifestBytes });
            continue;
          }
          const path = diskPathForHash(hash);
          const size = sizeByHash.get(hash);
          if (path && size !== undefined) sources.set(hash, { size, path });
        }
        if (!sources.size) throw err;
        await uploadBlobs(projectId, sources);
        continue;
      }
      throw err;
    }
  }
}

function extractMissingHashes(err: CloudApiError): string[] {
  const fromDetails = (err.details as { missing?: unknown; blobs?: unknown }) ?? {};
  const list = Array.isArray(fromDetails.missing)
    ? fromDetails.missing
    : Array.isArray(fromDetails.blobs)
      ? fromDetails.blobs
      : [];
  return list.filter((value): value is string => typeof value === "string");
}

export async function cloudPull(options: SyncRunOptions = {}): Promise<SyncResult> {
  const projectRoot = resolveProjectRoot(options.project);
  await ensureCloudDirs(projectRoot);
  const binding = await requireBinding(projectRoot);
  const notices: string[] = [];
  await assertProjectPathGate(projectRoot, options, notices);
  const lock = await acquireCloudLock(projectRoot, options.face ?? "cli");
  try {
    await saveDirtyScenesIfRunning(projectRoot);
    const api = getCloudApi();
    const remote = await api.getManifest(binding.projectId, binding.pinnedVersion);
    const base = await readBase(projectRoot);
    const walked = await walkProject(projectRoot, { syncStartMs: Date.now() });
    assertBootstrapGate("pull", base, walked, remote, options);

    const rules = await loadTrackedRules(projectRoot);
    const local = buildLocalManifest(binding.projectId, remote, base, walked, rules, notices);
    const plan = diffManifests(baseToManifest(base, binding.projectId), local, remote.manifest);

    await pullPhase(projectRoot, binding.projectId, plan, remote, base, walked, notices);

    await writeBase(projectRoot, { ...remote.manifest, version: remote.version });
    return {
      ok: true,
      action: "pull",
      projectId: binding.projectId,
      version: remote.version,
      message: "Pulled from Summer Cloud",
      notices: [...new Set(notices)],
    };
  } finally {
    await lock.release();
  }
}

/**
 * Two-phase pull (spec 8.7): stage (journal phase "staging"), then apply
 * (journal phase "applying"), then conflict finalization, R2 preservation of
 * losing bytes, journal removal, and engine notification.
 */
async function pullPhase(
  projectRoot: string,
  projectId: string,
  plan: DiffPlan,
  remote: RemoteManifest,
  base: BaseState | null,
  walked: WalkResult,
  notices: string[]
): Promise<void> {
  const paths = [...plan.pullPaths, ...plan.deleteLocalPaths, ...plan.conflictPaths];
  if (!paths.length) {
    notices.push(...rowNotices(plan));
    return;
  }

  const syncId = randomUUID();
  const pending = paths.map((path) => ({ path, sha256: remote.manifest.files[path]?.sha256 ?? "" }));
  const hashes = pending.map((entry) => entry.sha256).filter(Boolean);
  // The base version of project.godot is needed for its key-level 3-way merge.
  const baseGodot = base?.files["project.godot"]?.sha256;
  if (baseGodot && plan.conflictPaths.includes("project.godot")) hashes.push(baseGodot);

  await writeJournal(projectRoot, { syncId, targetVersion: remote.version, phase: "staging", pending });
  const staged = await downloadBlobs(projectRoot, projectId, hashes);
  await writeJournal(projectRoot, { syncId, targetVersion: remote.version, phase: "applying", pending });

  const conflicts = new ConflictSetWriter(projectRoot, conflictStamp(), projectId, base?.version ?? null, remote.version);
  const applyResult = await applyRemotePlan(projectRoot, plan, remote.manifest, {
    staged,
    diskPathByKey: walked.diskPathByKey,
    statByKey: walked.statByKey,
    conflicts,
    base,
    onBeforeDestructive: async () => {
      await createCheckpoint(projectRoot, projectId);
    },
  });
  await conflicts.finalize();

  // Push the losing bytes to R2 (blob-only, granted, unreferenced) so
  // conflict recovery survives this machine (spec 10.1).
  if (applyResult.preservedLocalHashes.size) {
    const sources = new Map<string, UploadSource>();
    for (const [hash, path] of applyResult.preservedLocalHashes) {
      try {
        const info = await stat(path);
        sources.set(hash, { size: info.size, path });
      } catch {
        // The file may have been deleted by the apply; preservation copy only.
      }
    }
    try {
      await uploadBlobs(projectId, sources);
    } catch (err) {
      notices.push(`Conflict copies are saved locally but could not be backed up to the cloud: ${(err as Error).message}`);
    }
  }

  await removeJournal(projectRoot);
  notices.push(...applyResult.notices);
  notices.push(...rowNotices(plan));
  await notifyEngineAfterApply(projectRoot, applyResult.appliedPaths);
}

function rowNotices(plan: DiffPlan): string[] {
  // Row 14 (spec 8.4): edit beats delete must be surfaced, even when no pull
  // work was needed.
  return plan.keepLocalPaths.map((path) => `${path}: deleted in cloud but edited here; keeping local file (edit beats delete)`);
}

export async function cloudConflicts(options: SyncRunOptions & { restorePath?: string; set?: string } = {}): Promise<SyncResult> {
  const projectRoot = resolveProjectRoot(options.project);
  if (options.restorePath) {
    const restored = await restoreConflictPath(projectRoot, options.restorePath, options.set);
    return {
      ok: true,
      action: "conflicts-restore",
      message: `Restored ${restored.path} from conflict set ${restored.stamp}. Run summer cloud push to sync it.`,
      details: restored as unknown as Record<string, unknown>,
    };
  }
  const sets = await listConflictSets(projectRoot);
  return {
    ok: true,
    action: "conflicts",
    message: sets.length ? `${sets.length} conflict set(s)` : "No local conflict sets",
    details: {
      conflictSets: sets.map((set) => ({
        stamp: set.stamp,
        files: set.meta?.entries.map((entry) => entry.path) ?? [],
      })),
    },
  };
}

export async function cloudRestore(options: SyncRunOptions & { version?: number; checkpoint?: string } = {}): Promise<SyncResult> {
  const projectRoot = resolveProjectRoot(options.project);
  const binding = await requireBinding(projectRoot);

  if (options.checkpoint) {
    const lock = await acquireCloudLock(projectRoot, options.face ?? "cli");
    try {
      const walked = await walkProject(projectRoot);
      const restored = await restoreCheckpoint(projectRoot, binding.projectId, options.checkpoint, Object.keys(walked.files));
      const message = restored.extraneousFiles.length
        ? `Checkpoint restored. ${restored.extraneousFiles.length} file(s) were added after this checkpoint and were NOT deleted; review and remove them manually.`
        : "Checkpoint restored.";
      return {
        ok: true,
        action: "restore-checkpoint",
        projectId: binding.projectId,
        message,
        details: { ref: restored.ref, extraneousFiles: restored.extraneousFiles },
      };
    } finally {
      await lock.release();
    }
  }

  if (!options.version) throw new Error("restore requires --version <n> or --checkpoint <stamp>");
  // Spec 7.12: restore creates a NEW head version equal to toVersion's
  // manifest server-side; the pull then converges the local tree onto it.
  const api = getCloudApi();
  for (let attempt = 0; ; attempt += 1) {
    const project = await api.getCloudProject(binding.projectId);
    try {
      await api.restoreVersion(binding.projectId, {
        toVersion: options.version,
        baseVersion: project.headVersion,
        syncId: randomUUID(),
      });
      break;
    } catch (err) {
      if (err instanceof CloudApiError && err.status === 409 && attempt < CAS_RETRY_ATTEMPTS - 1) {
        await sleep(jitter(CAS_BACKOFF_MS[Math.min(attempt, CAS_BACKOFF_MS.length - 1)]));
        continue;
      }
      throw err;
    }
  }
  const pulled = await cloudPull(options);
  return {
    ...pulled,
    action: "restore",
    message: `Cloud project restored to the contents of version ${options.version} (as a new head version) and pulled locally`,
  };
}

export async function cloudCheckpoints(options: SyncRunOptions = {}): Promise<SyncResult> {
  const projectRoot = resolveProjectRoot(options.project);
  const binding = await requireBinding(projectRoot);
  const refs = await listCheckpoints(projectRoot, binding.projectId);
  return {
    ok: true,
    action: "checkpoints",
    projectId: binding.projectId,
    message: refs.length ? `${refs.length} local checkpoint(s)` : "No local checkpoints",
    details: { checkpoints: refs.map((ref) => ref.split("/").pop() ?? ref) },
  };
}

async function requireBinding(projectRoot: string) {
  const binding = await readBinding(projectRoot);
  if (!binding?.projectId) {
    throw new Error("Project is not cloud-enabled. Run: summer cloud init");
  }
  return binding;
}

/**
 * Finder-copy gate (spec 8.3): two directories must never fight over one
 * projectId. On marker mismatch, block and offer adopt (--adopt-path) or
 * fork (re-init).
 */
async function assertProjectPathGate(projectRoot: string, options: SyncRunOptions, notices: string[]): Promise<void> {
  const marker = await readProjectPathMarker(projectRoot);
  if (!marker) return;
  const here = resolve(projectRoot);
  if (resolve(marker) === here) return;
  if (options.adoptPath) {
    await writeProjectPathMarker(here);
    notices.push(`Adopted new project path: ${here}`);
    return;
  }
  throw new Error(
    `This folder (${here}) does not match the recorded project path (${marker}). ` +
      "If you moved the project, re-run with --adopt-path. " +
      "If this is a copy, delete summer-cloud.json and run summer cloud init to fork it into a new cloud project."
  );
}

function assertBootstrapGate(
  direction: "push" | "pull",
  base: BaseState | null,
  walked: WalkResult,
  remote: RemoteManifest,
  options: SyncRunOptions
): void {
  if (base) return;
  const localCount = Object.keys(walked.files).length;
  const remoteCount = Object.keys(remote.manifest.files).length;
  if (localCount > 0 && remoteCount > 0 && !options.bootstrap) {
    throw new Error(
      "Cloud and local project both have files but this machine has no sync base. Re-run with --bootstrap merge, keep-cloud, or keep-local."
    );
  }
  if (direction === "push" && options.bootstrap === "keep-cloud") {
    throw new Error("Use `summer cloud pull --bootstrap keep-cloud` to keep the cloud version on a no-base project.");
  }
  if (direction === "pull" && options.bootstrap === "keep-local") {
    throw new Error("Use `summer cloud push --bootstrap keep-local` to keep the local version on a no-base project.");
  }
}

/**
 * Local manifest construction with carry-forward (spec 13 and 8.6.2):
 * - Base entries that no longer match the CURRENT tracked rules are carried
 *   forward UNCHANGED, never read as deletions (data-loss blocker 1).
 * - Files that kept changing while hashing carry forward their previous
 *   manifest entry so the path is never dropped.
 * - A manifest produced by newer rules than this client knows restricts the
 *   client: entries it cannot evaluate are carried forward verbatim.
 */
function buildLocalManifest(
  projectId: string,
  remote: RemoteManifest,
  base: BaseState | null,
  walked: WalkResult,
  rules: TrackedRules,
  notices: string[]
): CloudManifest {
  const files = { ...walked.files };
  const unstable = new Set(walked.unstablePaths);
  const staleRules = remote.rulesVersion > RULES_VERSION;
  if (staleRules) {
    notices.push("This project was synced by a newer summer CLI; untracked entries are carried forward unchanged. Update summer CLI.");
  }
  for (const [path, entry] of Object.entries(base?.files ?? {})) {
    if (files[path]) continue;
    if (unstable.has(path)) {
      files[path] = entry;
      notices.push(`${path}: file kept changing during sync; carried forward, will retry next run`);
      continue;
    }
    if (staleRules || !isTrackedByCurrentRules(path, rules)) {
      // Excluded by current rules (or unevaluable under newer rules): carry
      // forward unchanged; only tracked-and-absent paths may become deletions.
      files[path] = entry;
    }
  }
  // Unstable files with no base entry but a remote entry: carry the remote
  // entry so a teammate's file never reads as deleted.
  for (const path of unstable) {
    if (!files[path] && remote.manifest.files[path]) {
      files[path] = remote.manifest.files[path];
    }
  }
  return { schemaVersion: 1, projectId, rulesVersion: Math.max(RULES_VERSION, remote.rulesVersion), files };
}

function applyRequeuedCarryForward(
  manifest: CloudManifest,
  base: BaseState | null,
  requeued: ReadonlySet<string>,
  notices: string[]
): void {
  for (const [path, file] of Object.entries(manifest.files)) {
    if (!requeued.has(file.sha256)) continue;
    const baseEntry = base?.files[path];
    if (baseEntry) {
      manifest.files[path] = baseEntry;
    } else {
      delete manifest.files[path];
    }
    notices.push(`${path}: file changed while uploading; carried forward, will retry next run`);
  }
}

function baseToManifest(base: BaseState | null, projectId: string): CloudManifest {
  return base ?? { schemaVersion: 1, projectId, rulesVersion: RULES_VERSION, files: {} };
}

function summarizePlan(plan: DiffPlan): string {
  const push = plan.pushPaths.length + plan.deleteRemotePaths.length;
  const pull = plan.pullPaths.length + plan.deleteLocalPaths.length;
  const conflicts = plan.conflictPaths.length;
  if (!push && !pull && !conflicts) return "Cloud project is in sync";
  return `push ${push}, pull ${pull}, conflicts ${conflicts}`;
}

function jitter(ms: number): number {
  return Math.round(ms * (0.5 + Math.random()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
