import { execFile } from "child_process";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { promisify } from "util";
import { localCloudDir } from "../../../project-memory/cloud-paths.js";

const execFileAsync = promisify(execFile);

/** Timestamped refs (spec 11): refs/gitsummer/<projectId>/cloud-sync-<utcstamp>. */
const KEEP_CHECKPOINTS = 20;

export interface CheckpointResult {
  ref: string;
  commit: string;
}

export function summerGitDir(projectRoot: string): string {
  return join(projectRoot, ".summer", "local", "git");
}

export async function isGitAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function git(projectRoot: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const gitDir = summerGitDir(projectRoot);
  const { stdout } = await execFileAsync(
    "git",
    ["--git-dir", gitDir, "--work-tree", projectRoot, "-c", "core.quotepath=false", "-c", "core.bare=false", ...args],
    {
      cwd: projectRoot,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Summer Cloud",
        GIT_AUTHOR_EMAIL: "cloud@summerengine.com",
        GIT_COMMITTER_NAME: "Summer Cloud",
        GIT_COMMITTER_EMAIL: "cloud@summerengine.com",
        ...env,
      },
    }
  );
  return stdout.trim();
}

async function ensureBareRepo(projectRoot: string): Promise<void> {
  const gitDir = summerGitDir(projectRoot);
  if (!existsSync(join(gitDir, "HEAD"))) {
    await mkdir(join(projectRoot, ".summer", "local"), { recursive: true });
    await execFileAsync("git", ["init", "--bare", gitDir], { cwd: projectRoot });
  }
  await ensureExclude(gitDir);
}

/** Mirrors GitOps::_ensure_summergit_exclude so checkpoints skip SummerGit's own state. */
async function ensureExclude(gitDir: string): Promise<void> {
  const excludePath = join(gitDir, "info", "exclude");
  const sentinelBegin = "# >>> Summer Engine BEGIN (do not edit between sentinels)";
  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
    if (existing.includes(sentinelBegin)) return;
  } catch {
    // info/ exists after git init --bare; file may not.
  }
  if (existing && !existing.endsWith("\n")) existing += "\n";
  existing += `${sentinelBegin}\n.summer/local/\n.godot/\n# <<< Summer Engine END\n`;
  await mkdir(join(gitDir, "info"), { recursive: true });
  await writeFile(excludePath, existing, "utf8");
}

function checkpointIndexFile(projectRoot: string): string {
  return join(localCloudDir(projectRoot), "checkpoint-index");
}

export function checkpointStamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * Full-tree SummerGit checkpoint before any destructive apply (spec 11).
 * Plumbing only: stage all into a private index, write-tree, commit-tree,
 * update-ref. Keeps the last KEEP_CHECKPOINTS refs.
 */
export async function createCheckpoint(projectRoot: string, projectId: string): Promise<CheckpointResult> {
  if (!(await isGitAvailable())) {
    throw new Error(
      "git is required for the pre-sync safety checkpoint and was not found on PATH. Install git (run summer doctor to verify), then retry."
    );
  }
  await ensureBareRepo(projectRoot);
  await mkdir(localCloudDir(projectRoot), { recursive: true, mode: 0o700 });

  // A private index file so checkpoints never fight the engine's own index.
  const indexFile = checkpointIndexFile(projectRoot);
  await rm(indexFile, { force: true });
  const env = { GIT_INDEX_FILE: indexFile };

  await git(projectRoot, ["add", "-A", "--", "."], env);
  const tree = await git(projectRoot, ["write-tree"], env);
  const stamp = checkpointStamp();
  const commit = await git(projectRoot, ["commit-tree", tree, "-m", `Summer Cloud pre-sync checkpoint ${stamp}`], env);
  const ref = `refs/gitsummer/${projectId}/cloud-sync-${stamp}`;
  await git(projectRoot, ["update-ref", ref, commit]);
  await rm(indexFile, { force: true });

  await pruneCheckpoints(projectRoot, projectId);
  return { ref, commit };
}

export async function listCheckpoints(projectRoot: string, projectId: string): Promise<string[]> {
  try {
    const out = await git(projectRoot, [
      "for-each-ref",
      "--format=%(refname)",
      `refs/gitsummer/${projectId}/`,
    ]);
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((ref) => ref.includes("/cloud-sync-"))
      .sort();
  } catch {
    return [];
  }
}

async function pruneCheckpoints(projectRoot: string, projectId: string): Promise<void> {
  const refs = await listCheckpoints(projectRoot, projectId);
  const excess = refs.slice(0, Math.max(0, refs.length - KEEP_CHECKPOINTS));
  for (const ref of excess) {
    await git(projectRoot, ["update-ref", "-d", ref]).catch(() => {});
  }
}

export interface CheckpointRestoreResult {
  ref: string;
  restoredFiles: string[];
  /** Files present on disk but not in the checkpoint; restore does not delete them. */
  extraneousFiles: string[];
}

/**
 * Restores a checkpoint's bytes (spec 11). checkout-index restores bytes but
 * does not delete files a bad sync ADDED, so the result lists extraneous
 * files for the user or agent to remove.
 */
export async function restoreCheckpoint(
  projectRoot: string,
  projectId: string,
  refOrStamp: string,
  currentTrackedFiles: readonly string[]
): Promise<CheckpointRestoreResult> {
  if (!(await isGitAvailable())) {
    throw new Error("git is required to restore checkpoints and was not found on PATH.");
  }
  const ref = refOrStamp.startsWith("refs/")
    ? refOrStamp
    : `refs/gitsummer/${projectId}/cloud-sync-${refOrStamp}`;

  const indexFile = checkpointIndexFile(projectRoot);
  await rm(indexFile, { force: true });
  const env = { GIT_INDEX_FILE: indexFile };
  await git(projectRoot, ["read-tree", ref], env);
  await git(projectRoot, ["checkout-index", "-a", "-f"], env);
  await rm(indexFile, { force: true });

  const inCheckpoint = new Set(
    (await git(projectRoot, ["ls-tree", "-r", "--name-only", ref])).split("\n").filter(Boolean)
  );
  const restoredFiles = [...inCheckpoint].sort();
  const extraneousFiles = currentTrackedFiles.filter((path) => !inCheckpoint.has(path)).sort();
  return { ref, restoredFiles, extraneousFiles };
}
