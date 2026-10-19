/**
 * Installing Summer Engine: `summer install`, the engine step of `summer
 * dev`, and the MCP's `projects.open_local` (with the person's yes). Never
 * exits the process; every failure is an EngineInstallError whose reason is
 * the usage line's error code. The `summer install` command is
 * src/cli/commands/install.ts.
 */
import { execFileSync, execSync } from "child_process";
import { createInterface } from "node:readline/promises";
import { createHash } from "crypto";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { homedir, tmpdir, platform } from "os";
import { basename, dirname, join, resolve } from "path";
import { getSummerDir } from "./store.js";
import { processIsAlive } from "./util/process.js";
import { sleep } from "./util/sleep.js";
import {
  DEFAULT_DOWNLOAD_BYTES,
  ENGINE_BINARY_ENV,
  EngineInstallError,
  INSTALL_RETRY,
  INSTALL_SPACE_FACTOR,
  LINUX_ENGINE_BINARY_NAME,
  asInstallError,
  checkDiskSpace,
  chooseMacDestination,
  errorDetail,
  formatSize,
  installFailureReason,
  recordEngineInstall,
  windowsEnginePaths,
  type FreeSpace,
  type InstallFailureReason,
  type LinuxReleaseAsset,
  findExtractedEngineBinary,
  linuxArchiveKind,
  linuxEngineInstallDir,
  pickLinuxReleaseAsset,
  resolveLinuxInstallSource,
} from "./engine-install.js";

export { EngineInstallError, type InstallFailureReason };

const RELEASES_URL = "https://www.summerengine.com/api/desktop/releases";
const DOWNLOAD_PAGE = "https://summerengine.com/download";

interface ReleaseInfo {
  latest: {
    macos?: { version: string; dmg_url: string; dmg_sha256?: string };
    windows?: { version: string; url: string; sha256?: string };
  };
}

/** Guard a download URL from the releases endpoint. A missing/empty URL (an
 *  outdated or misconfigured endpoint) otherwise becomes a cryptic
 *  fetch(undefined) failure — surface it clearly with a manual fallback. */
export function requireDownloadUrl(value: string | undefined, label: string): string {
  if (!value || value.trim().length === 0) {
    throw new EngineInstallError(
      "release_info",
      `Release info is missing the ${label} download URL; the releases endpoint may be ` +
        `outdated. Download manually from ${DOWNLOAD_PAGE}`
    );
  }
  return value;
}

/** Verify a downloaded file's sha256 against the expected hash from the releases
 *  endpoint. Skipped when no expected hash is published. Catches a truncated or
 *  corrupted download (a ~700 MB install over a flaky network) before it becomes a
 *  confusing DMG-mount / installer failure downstream. */
export function verifyChecksum(actual: string, expected: string | undefined, label: string): void {
  if (!expected || expected.trim().length === 0) return; // nothing published to verify against
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new EngineInstallError(
      "checksum",
      `${label} checksum mismatch: the download was corrupted or incomplete ` +
        `(expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…). Run: ${INSTALL_RETRY}`
    );
  }
}

// The bundle-version readers live in core (src/core/launch-posture.ts) because
// `summer run` needs the installed version BEFORE the engine is up to decide
// whether it may pass --summer-background; re-exported here for install.test.ts.
import { parseMacBundleVersion, readMacBundleVersion } from "./launch-posture.js";
export { parseMacBundleVersion, readMacBundleVersion };

export function isSameVersion(installed: string | null, latest: string): boolean {
  if (!installed) return false;
  const norm = (value: string) => value.trim().replace(/^v/i, "");
  return norm(installed) === norm(latest);
}

export type MacInstallPlan =
  | { action: "install" }
  | { action: "up-to-date"; version: string }
  | { action: "needs-confirmation"; installed: string | null }
  | { action: "refuse"; reason: string };

/** Decide what `summer install` may do about an existing /Applications/Summer.app.
 *  Replacing an installed engine is destructive, so it needs --yes or a TTY
 *  prompt; an equal version is a no-op success. */
export function planMacInstall(input: {
  exists: boolean;
  installedVersion: string | null;
  latestVersion: string;
  yes: boolean;
  isTTY: boolean;
  /** The command that repeats this install (with its --path), for the refusal. */
  retry?: string;
}): MacInstallPlan {
  if (!input.exists) return { action: "install" };
  if (isSameVersion(input.installedVersion, input.latestVersion)) {
    return { action: "up-to-date", version: input.latestVersion };
  }
  if (input.yes) return { action: "install" };
  if (input.isTTY) return { action: "needs-confirmation", installed: input.installedVersion };
  return {
    action: "refuse",
    reason:
      `Summer Engine ${input.installedVersion ?? "(unknown version)"} is already installed; ` +
      `updating to v${input.latestVersion} replaces it. To confirm, run: ${input.retry ?? INSTALL_RETRY} --yes`,
  };
}

export type ShellExec = (command: string) => void;

/** Replace destApp with the bundle on the mounted DMG WITHOUT a window where
 *  no engine exists: copy to <destApp>.new first, and only after that
 *  succeeds remove the old bundle and rename the staged copy into place. A
 *  failed copy leaves the existing install untouched. */
export function replaceMacApp(mountPoint: string, destApp: string, exec: ShellExec, staged = `${destApp}.new`): void {
  exec(`rm -rf "${staged}"`);
  try {
    exec(`cp -R "${mountPoint}/Summer.app" "${staged}"`);
  } catch (err) {
    try { exec(`rm -rf "${staged}"`); } catch { /* best effort */ }
    throw err;
  }
  exec(`rm -rf "${destApp}"`);
  exec(`mv "${staged}" "${destApp}"`);
}

/** The mount point hdiutil attach printed (the /Volumes/... column), or null. */
export function parseMountPoint(hdiutilOutput: string): string | null {
  return (
    hdiutilOutput
      .split("\n")
      .filter((line) => line.includes("/Volumes/"))
      .map((line) => line.trim().split("\t").pop()?.trim())
      .find(Boolean) ?? null
  );
}

/** Mount the DMG and return its mount point; any failure is `mount`. */
export function attachDmg(dmgPath: string, exec: (command: string) => string): string {
  let output: string;
  try {
    output = exec(`hdiutil attach "${dmgPath}" -nobrowse -noverify -noautoopen`);
  } catch (err) {
    throw asInstallError(
      err,
      "mount",
      (detail) => `Could not open the downloaded DMG (${detail}). Download it from ${DOWNLOAD_PAGE} and drag Summer to Applications.`
    );
  }
  const mountPoint = parseMountPoint(output);
  if (!mountPoint) {
    throw new EngineInstallError(
      "mount",
      `The downloaded DMG opened without a mount point. Download it from ${DOWNLOAD_PAGE} and drag Summer to Applications.`
    );
  }
  return mountPoint;
}

/** Eject the DMG, best effort: a busy volume ("resource busy") gets one retry
 *  with -force, and a failure here never fails an install that already
 *  succeeded. Returns whether it ejected. */
export function detachDmg(mountPoint: string, exec: (command: string) => unknown): boolean {
  for (const command of [`hdiutil detach "${mountPoint}" -quiet`, `hdiutil detach "${mountPoint}" -quiet -force`]) {
    try {
      exec(command);
      return true;
    } catch {
      // retry once with -force, then give up
    }
  }
  return false;
}

/** Whether the engine executable at this path is running: pgrep on a pattern
 *  anchored to the start of the command line, so a process that only mentions
 *  the path in its arguments does not count. pgrep exits 1 on no match. */
export function isEngineRunning(binary: string, execFile: (file: string, args: string[]) => string): boolean {
  const pattern = `^${binary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`;
  try {
    return execFile("pgrep", ["-f", pattern]).trim().length > 0;
  } catch {
    return false;
  }
}

/** Remove partial downloads / staged bundles when the user interrupts. The
 *  returned function removes the handlers; every install path calls it. */
function cleanupOnSignal(paths: string[]): () => void {
  const handler = () => {
    for (const path of paths) {
      try { rmSync(path, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    process.exit(130);
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/** Velopack Setup.exe install args. Velopack is NOT NSIS: silent install is
 *  `--silent` and a custom directory is `--installto <dir>` (per Velopack's
 *  setup.exe CLI). The old NSIS flags (/S, /D=) are rejected by the Velopack
 *  installer with "unexpected argument '/S' found" — this is the wizard bug. */
export function windowsInstallerArgs(customPath?: string): string {
  return customPath ? `--silent --installto "${customPath}"` : "--silent";
}

/** Printed after an install: the first start of a new engine is slow and silent. */
export const FIRST_START_NOTE =
  "The first start of a new engine version can take several minutes with no output " +
  "(the system checks the new app and the engine builds its caches). Later starts are fast.";

/** Where the Velopack installer put Summer.exe: <dir>/current/Summer.exe for --path, else the default locations. */
export function windowsInstalledBinary(customPath?: string, exists: (path: string) => boolean = existsSync): string | null {
  const candidates = customPath
    ? [join(customPath, "current", "Summer.exe"), join(customPath, "Summer.exe")]
    : windowsEnginePaths();
  return candidates.find((path) => exists(path)) ?? null;
}

/**
 * Download progress: rewrites one line on a terminal; elsewhere (an agent,
 * a log file) one line per 10%, so a 700 MB download is about ten lines
 * instead of hundreds of kilobytes.
 */
export function createProgressReporter(isTTY: boolean, write: (text: string) => void) {
  let lastStep = -1;
  return (downloaded: number, total: number) => {
    if (total <= 0) return;
    const pct = Math.min(100, Math.floor((downloaded / total) * 100));
    const mb = (downloaded / 1024 / 1024).toFixed(1);
    if (isTTY) {
      write(`\r  ${pct}% (${mb}MB)`);
      return;
    }
    const step = Math.floor(pct / 10);
    if (step > lastStep) {
      lastStep = step;
      write(`  ${pct}% (${mb}MB)\n`);
    }
  };
}

// ------------------------------------------------------------ installEngine

export interface InstallEngineOptions {
  /** Custom install directory (macOS: <path>/Summer.app). */
  path?: string;
  /** Replace an older installed engine without asking. */
  yes?: boolean;
  /** Progress and result lines; console.log when not given. */
  log?: (line: string) => void;
  /** Whether a person can answer a prompt on stdin; no prompt unless true. */
  isTTY?: boolean;
}

export interface InstallEngineResult {
  /** The engine executable, or null when the Windows installer put it somewhere unknown. */
  binary: string | null;
  version: string | null;
  /** The bundle (macOS) or folder the engine is in. */
  destination: string;
  /** Nothing was replaced: already up to date, an existing binary registered, or the update was declined. */
  alreadyInstalled: boolean;
}

/** The machine around an install; tests replace any of it. */
export interface InstallDeps {
  platform: NodeJS.Platform;
  arch: string;
  /** Run a shell command and return stdout; throws with stderr in the message.
   *  `inherit` hands the terminal to the command (the Windows installer). */
  exec: (command: string, inherit?: boolean) => string;
  /** Run a program without a shell (pgrep); throws on a non-zero exit. */
  execFile: (file: string, args: string[]) => string;
  fetch: typeof fetch;
  freeSpace: FreeSpace;
  canWrite: (path: string) => boolean;
  tmpDir: string;
  home: string;
  env: NodeJS.ProcessEnv;
  confirm: (question: string) => Promise<boolean>;
  record: (binary: string, version: string | null) => Promise<void>;
  /** Rewrite one progress line instead of printing one per 10%. */
  stdoutIsTTY: boolean;
}

/** The nearest folder that exists at or above `path`. */
function existingAncestor(path: string): string {
  let dir = resolve(path);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}

function freeSpaceOf(path: string): { bytes: number; volume: string } {
  const dir = existingAncestor(path);
  const stats = statfsSync(dir);
  return { bytes: Number(stats.bavail) * Number(stats.bsize), volume: String(statSync(dir).dev) };
}

/** Whether this user may create or replace `path` (judged on the nearest existing folder). */
function isWritable(path: string): boolean {
  try {
    accessSync(existingAncestor(path), fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultInstallDeps(): InstallDeps {
  return {
    platform: platform(),
    arch: process.arch,
    exec: (command, inherit) => {
      if (!inherit) return execSync(command, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      execSync(command, { stdio: "inherit" });
      return "";
    },
    execFile: (file, args) => execFileSync(file, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }),
    fetch: (input, init) => fetch(input, init),
    freeSpace: freeSpaceOf,
    canWrite: isWritable,
    tmpDir: tmpdir(),
    home: homedir(),
    env: process.env,
    confirm,
    record: recordEngineInstall,
    stdoutIsTTY: Boolean(process.stdout.isTTY),
  };
}

/**
 * Install Summer Engine for this platform: `summer install`, and the engine
 * step of `summer dev`. Never exits the process and asks on stdin only when
 * `isTTY` is true; every failure is an EngineInstallError whose reason is the
 * telemetry code and whose message ends in one next step.
 */
export async function installEngine(
  opts: InstallEngineOptions,
  deps: Partial<InstallDeps> = {}
): Promise<InstallEngineResult> {
  const d: InstallDeps = { ...defaultInstallDeps(), ...deps };
  const log = opts.log ?? ((line: string) => console.log(line));
  // `summer install`, `summer dev --yes` and projects.open_local can start at
  // once: one install at a time; the next one then finds the engine in place.
  return withInstallLock(log, () => installUnlocked(opts, d, log));
}

/** ~/.summer/install.lock: held while one install runs. A holder whose
 *  process is gone, or that is hours old, is stale and removed. */
export const INSTALL_LOCK_DIR = "install.lock";
const INSTALL_LOCK_STALE_MS = 2 * 60 * 60_000;

async function withInstallLock<T>(log: (line: string) => void, fn: () => Promise<T>): Promise<T> {
  const lockDir = join(getSummerDir(), INSTALL_LOCK_DIR);
  mkdirSync(dirname(lockDir), { recursive: true, mode: 0o700 });
  let said = false;
  while (true) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const owner = lockOwner(lockDir);
      if (!owner) continue; // released meanwhile
      if ((owner.pid && !processIsAlive(owner.pid)) || Date.now() - owner.createdAt > INSTALL_LOCK_STALE_MS) {
        takeOverStaleLock(lockDir, owner);
        continue;
      }
      if (!said) log("Another Summer Engine install is running; waiting for it to finish...");
      said = true;
      await sleep(1_000);
      continue;
    }
    try {
      writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: Date.now() }), { mode: 0o600 });
      return await fn();
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  }
}

export type LockOwner = { pid: number; createdAt: number };

/** Who holds the lock: owner.json, or (just made, not written yet) the folder's age. Null when it is gone. */
function lockOwner(lockDir: string): LockOwner | null {
  try {
    const owner = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf-8")) as Partial<LockOwner>;
    if (typeof owner.pid === "number" && typeof owner.createdAt === "number") return { pid: owner.pid, createdAt: owner.createdAt };
  } catch {
    // just created by its holder, or broken: judged by age
  }
  try {
    return { pid: 0, createdAt: statSync(lockDir).mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Remove a stale lock so that only one waiter wins: rename it aside (one
 * rename of a folder succeeds), then check that the folder moved is still
 * the stale one judged. If a live holder took the lock in between, put its
 * lock back.
 */
export function takeOverStaleLock(lockDir: string, stale: LockOwner): void {
  const aside = `${lockDir}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(lockDir, aside);
  } catch {
    return; // another waiter took it over first, or it was released
  }
  const moved = lockOwner(aside);
  if (moved && moved.pid === stale.pid && moved.createdAt === stale.createdAt) {
    rmSync(aside, { recursive: true, force: true });
    return;
  }
  try {
    renameSync(aside, lockDir);
  } catch {
    rmSync(aside, { recursive: true, force: true });
  }
}

async function installUnlocked(opts: InstallEngineOptions, d: InstallDeps, log: (line: string) => void): Promise<InstallEngineResult> {

  if (d.platform === "linux") return installLinux(opts, d, log);
  if (d.platform !== "darwin" && d.platform !== "win32") {
    throw new EngineInstallError(
      "unsupported_platform",
      `Summer Engine does not install on ${d.platform}; it runs on macOS, Windows and Linux (x86_64). ` +
        `See ${DOWNLOAD_PAGE}`
    );
  }

  log("Fetching latest release info...");
  let releases: ReleaseInfo;
  try {
    const res = await d.fetch(RELEASES_URL, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    releases = (await res.json()) as ReleaseInfo;
    if (!releases?.latest) throw new Error("no latest release in the answer");
  } catch (err) {
    throw new EngineInstallError(
      "release_info",
      `Could not fetch the Summer Engine release info (${errorDetail(err)}). Download the engine from ${DOWNLOAD_PAGE}`
    );
  }

  return d.platform === "darwin" ? installMac(releases, opts, d, log) : installWindows(releases, opts, d, log);
}

/** The command that repeats this install. */
function retryCommand(opts: InstallEngineOptions): string {
  return opts.path ? `${INSTALL_RETRY} --path "${opts.path}"` : INSTALL_RETRY;
}

function nextSteps(log: (line: string) => void): void {
  log("\nNext steps:");
  log("  summer dev    # Create a starter project and open it");
}

/** Start a download: the open response and its size (0 when the server sends none). */
async function openDownload(url: string, fetchFn: typeof fetch): Promise<{ res: Response; bytes: number }> {
  let res: Response;
  try {
    res = await fetchFn(url);
  } catch (err) {
    throw new EngineInstallError(
      "download",
      `Download failed: ${errorDetail(err)}. Check your connection, then run: ${INSTALL_RETRY}`
    );
  }
  if (!res.ok || !res.body) {
    throw new EngineInstallError(
      "download",
      `Download failed: HTTP ${res.status}. Check your connection, then run: ${INSTALL_RETRY}`
    );
  }
  return { res, bytes: parseInt(res.headers.get("content-length") || "0", 10) || 0 };
}

/** Refuse before writing a byte when the download or the install would not fit. */
function requireSpace(res: Response, needs: Array<{ path: string; bytes: number }>, freeSpace: FreeSpace): void {
  try {
    checkDiskSpace(needs, freeSpace);
  } catch (err) {
    void res.body?.cancel().catch(() => {});
    throw err;
  }
}

/** Stream the body to disk, hashing as it goes. */
async function saveDownload(
  res: Response,
  dest: string,
  report: (downloaded: number, total: number) => void
): Promise<{ sha256: string }> {
  mkdirSync(dirname(dest), { recursive: true });
  const fileStream = createWriteStream(dest);
  const readable = Readable.fromWeb(res.body as import("stream/web").ReadableStream);

  // Hash while streaming (the 'data' listener and the pipe both see every chunk
  // in flowing mode), so we get integrity for free without a second read pass.
  const hash = createHash("sha256");
  let downloaded = 0;
  const total = parseInt(res.headers.get("content-length") || "0", 10);
  readable.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    downloaded += chunk.length;
    report(downloaded, total);
  });

  await pipeline(readable, fileStream);
  return { sha256: hash.digest("hex") };
}

/** Download, check the space first, verify the hash. The file is removed on failure. */
async function downloadVerified(
  url: string,
  dest: string,
  needs: (bytes: number) => Array<{ path: string; bytes: number }>,
  label: string,
  expectedSha256: string | undefined,
  d: InstallDeps,
  log: (line: string) => void
): Promise<void> {
  try {
    const { res, bytes } = await openDownload(url, d.fetch);
    requireSpace(res, needs(bytes || DEFAULT_DOWNLOAD_BYTES), d.freeSpace);
    log(`Downloading ${label}${bytes ? ` (${formatSize(bytes)})` : ""}...`);
    const report = createProgressReporter(
      d.stdoutIsTTY,
      d.stdoutIsTTY ? (text) => process.stdout.write(text) : (text) => log(text.replace(/\n$/, ""))
    );
    const { sha256 } = await saveDownload(res, dest, report);
    if (d.stdoutIsTTY) process.stdout.write("\n");
    verifyChecksum(sha256, expectedSha256, label);
  } catch (err) {
    try { rmSync(dest, { force: true }); } catch { /* best effort */ }
    throw asInstallError(
      err,
      "download",
      (detail) => `The download stopped (${detail}). Check your connection, then run: ${INSTALL_RETRY}`
    );
  }
}

async function recordInstall(d: InstallDeps, binary: string, version: string | null, log: (line: string) => void) {
  try {
    await d.record(binary, version);
  } catch (err) {
    // The engine is installed; only the pointer for later commands is missing.
    log(`Note: could not record the install (${errorDetail(err)}); set SUMMER_BIN=${binary} if summer cannot find it.`);
  }
}

async function installMac(
  releases: ReleaseInfo,
  opts: InstallEngineOptions,
  d: InstallDeps,
  log: (line: string) => void
): Promise<InstallEngineResult> {
  const info = releases.latest.macos;
  if (!info) {
    throw new EngineInstallError("release_info", `The release info lists no macOS build. Download the engine from ${DOWNLOAD_PAGE}`);
  }
  const dmgUrl = requireDownloadUrl(info.dmg_url, "macOS DMG");
  log(`Latest version: ${info.version}`);

  const canReplace = (app: string) => d.canWrite(dirname(app)) && d.canWrite(app);
  const { destApp, fallback } = chooseMacDestination({ customPath: opts.path, home: d.home, canReplace });
  if (!canReplace(destApp)) {
    throw new EngineInstallError(
      "permission",
      `This user cannot write to ${existsSync(destApp) ? destApp : dirname(destApp)}. ` +
        `Install into a folder you own: ${INSTALL_RETRY} --path <folder>`
    );
  }
  if (fallback) log(`/Applications is not writable for this user, so the engine goes to ${destApp}.`);

  const destBinary = join(destApp, "Contents", "MacOS", "Summer");
  const exists = existsSync(destApp);
  const installedVersion = exists ? readMacBundleVersion(destApp) : null;
  const plan = planMacInstall({
    exists,
    installedVersion,
    latestVersion: info.version,
    yes: Boolean(opts.yes),
    isTTY: Boolean(opts.isTTY),
    retry: retryCommand(opts),
  });
  if (plan.action === "up-to-date") {
    await recordInstall(d, destBinary, plan.version, log);
    log(`Summer Engine v${plan.version} is already installed at ${destApp} (up to date).`);
    return { binary: destBinary, version: plan.version, destination: destApp, alreadyInstalled: true };
  }
  if (plan.action === "refuse") throw new EngineInstallError("needs_confirmation", plan.reason);
  if (plan.action === "needs-confirmation") {
    log(`Summer Engine ${plan.installed ?? "(unknown version)"} is installed at ${destApp}.`);
    if (!(await d.confirm(`Replace it with v${info.version}?`))) {
      log("Cancelled. Nothing was changed.");
      return { binary: destBinary, version: installedVersion, destination: destApp, alreadyInstalled: true };
    }
  }
  const refuseWhileRunning = () => {
    if (existsSync(destApp) && isEngineRunning(destBinary, d.execFile)) {
      throw new EngineInstallError(
        "app_running",
        `Summer Engine is running from ${destApp}, so it cannot be replaced now. ` +
          `Quit Summer Engine, then run: ${INSTALL_RETRY} --yes`
      );
    }
  };
  refuseWhileRunning();

  // Names of this process's own: an install another process left behind never shares them.
  const dmgPath = join(d.tmpDir, `Summer-v${info.version}-${process.pid}.dmg`);
  const staged = `${destApp}.new-${process.pid}`;
  const releaseSignals = cleanupOnSignal([dmgPath, staged]);
  try {
    await downloadVerified(
      dmgUrl,
      dmgPath,
      (bytes) => [
        { path: d.tmpDir, bytes },
        { path: dirname(destApp), bytes: bytes * INSTALL_SPACE_FACTOR },
      ],
      `Summer Engine v${info.version} DMG`,
      info.dmg_sha256,
      d,
      log
    );

    log("Mounting DMG...");
    const mountPoint = attachDmg(dmgPath, d.exec);
    try {
      // Again after the download: the person may have opened Summer meanwhile.
      refuseWhileRunning();
      log(`Installing to ${destApp}...`);
      mkdirSync(dirname(destApp), { recursive: true });
      // A staged copy an interrupted install left behind: its process is gone (`.new-<pid>`, or the older `.new`).
      for (const name of readdirSync(dirname(destApp))) {
        const left = new RegExp(`^${basename(destApp).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.new(?:-(\\d+))?$`).exec(name);
        if (left && (!left[1] || !processIsAlive(Number(left[1])))) rmSync(join(dirname(destApp), name), { recursive: true, force: true });
      }
      replaceMacApp(mountPoint, destApp, (command) => { d.exec(command); }, staged);
    } catch (err) {
      throw asInstallError(
        err,
        "copy",
        (detail) =>
          `Could not copy Summer.app to ${destApp} (${detail}); ` +
          `${exists ? "the existing engine was left in place" : "nothing was installed"}. ` +
          `Install it by hand from ${DOWNLOAD_PAGE}`
      );
    } finally {
      if (!detachDmg(mountPoint, d.exec)) log(`Note: could not eject ${mountPoint}; eject it in Finder later.`);
    }
  } finally {
    try { rmSync(dmgPath, { force: true }); } catch { /* best effort */ }
    releaseSignals();
  }

  log("Done!");
  await recordInstall(d, destBinary, info.version, log);
  log(`\nSummer Engine v${info.version} installed to ${destApp}`);
  log(FIRST_START_NOTE);
  nextSteps(log);
  return { binary: destBinary, version: info.version, destination: destApp, alreadyInstalled: false };
}

async function installWindows(
  releases: ReleaseInfo,
  opts: InstallEngineOptions,
  d: InstallDeps,
  log: (line: string) => void
): Promise<InstallEngineResult> {
  const info = releases.latest.windows;
  if (!info) {
    throw new EngineInstallError("release_info", `The release info lists no Windows build. Download the engine from ${DOWNLOAD_PAGE}`);
  }
  const exeUrl = requireDownloadUrl(info.url, "Windows installer");
  log(`Latest version: ${info.version}`);

  const installDir = opts.path ?? join(d.env.LOCALAPPDATA ?? d.home, "SummerEngine");
  if (!d.canWrite(installDir)) {
    throw new EngineInstallError(
      "permission",
      `This user cannot write to ${installDir}. Install into a folder you own: ${INSTALL_RETRY} --path <folder>`
    );
  }

  const exePath = join(d.tmpDir, `Summer-v${info.version}-${process.pid}.exe`);
  const releaseSignals = cleanupOnSignal([exePath]);
  try {
    await downloadVerified(
      exeUrl,
      exePath,
      (bytes) => [
        { path: d.tmpDir, bytes },
        { path: installDir, bytes: bytes * INSTALL_SPACE_FACTOR },
      ],
      `Summer Engine v${info.version} installer`,
      info.sha256,
      d,
      log
    );
  } finally {
    releaseSignals();
  }

  log("Running installer...");
  try {
    d.exec(`"${exePath}" ${windowsInstallerArgs(opts.path)}`, true);
  } catch (err) {
    // The installer stays on disk so the next step can name it.
    throw asInstallError(err, "installer", (detail) => `The Summer Engine installer failed (${detail}). Run it yourself: ${exePath}`);
  }
  try { rmSync(exePath, { force: true }); } catch { /* best effort */ }

  const installed = windowsInstalledBinary(opts.path);
  if (installed) await recordInstall(d, installed, info.version, log);
  log(`\nSummer Engine v${info.version} installed${installed ? ` to ${installed}` : "!"}`);
  log(FIRST_START_NOTE);
  nextSteps(log);
  return {
    binary: installed,
    version: info.version,
    destination: installed ? dirname(installed) : installDir,
    alreadyInstalled: false,
  };
}

// ------------------------------------------------------------------- Linux
// Source resolution, release picking, and archive detection live in
// core/engine-install.ts; this section is the process I/O around them.

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/** Register an existing binary the same way a download install does: the
 *  canonical ~/.summer/engine/summer-linux-x86_64 path points at it, so
 *  `summer run`/`summer doctor` find it even when the env var is not set. */
function registerExistingLinuxBinary(
  sourcePath: string,
  destDir: string,
  destBinary: string,
  log: (line: string) => void
): void {
  const absolute = resolve(sourcePath);
  if (!existsSync(absolute)) {
    throw new EngineInstallError(
      "copy",
      `${ENGINE_BINARY_ENV} points at ${absolute}, but nothing exists there. ` +
        `Set it to the engine binary, then run: ${INSTALL_RETRY}`
    );
  }
  try {
    chmodSync(absolute, 0o755);
  } catch {
    // Best effort — a read-only mount still works if already executable.
  }
  try {
    mkdirSync(destDir, { recursive: true });
    if (absolute !== destBinary) {
      rmSync(destBinary, { force: true });
      symlinkSync(absolute, destBinary);
    }
  } catch (err) {
    throw asInstallError(err, "copy", (detail) => `Could not link ${destBinary} to ${absolute} (${detail}). Run: ${INSTALL_RETRY} --path <folder>`);
  }
  log(`Registered existing engine binary: ${absolute}`);
  log(`  -> ${destBinary}`);
}

async function fetchLinuxReleaseAsset(apiUrl: string, fetchFn: typeof fetch): Promise<LinuxReleaseAsset> {
  const res = await fetchFn(apiUrl, {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return pickLinuxReleaseAsset(await res.json());
}

/** The published .sha256 for a Linux artifact; a missing one skips the check, as before. */
async function fetchLinuxChecksum(sha256Url: string | undefined, fetchFn: typeof fetch): Promise<string | undefined> {
  if (!sha256Url) return undefined;
  try {
    const res = await fetchFn(sha256Url, { signal: AbortSignal.timeout(15000) });
    return res.ok ? (await res.text()).trim().split(/\s+/, 1)[0] : undefined;
  } catch (err) {
    throw new EngineInstallError(
      "download",
      `Could not fetch the Linux artifact checksum (${errorDetail(err)}). Check your connection, then run: ${INSTALL_RETRY}`
    );
  }
}

async function installLinux(
  opts: InstallEngineOptions,
  d: InstallDeps,
  log: (line: string) => void
): Promise<InstallEngineResult> {
  if (d.arch !== "x64") {
    throw new EngineInstallError(
      "unsupported_platform",
      `Linux ${d.arch} has no published Summer Engine artifact yet (x86_64 only). ` +
        `Build from source, set ${ENGINE_BINARY_ENV} to the binary, then run: ${INSTALL_RETRY}`
    );
  }

  const destDir = opts.path ? resolve(opts.path) : linuxEngineInstallDir();
  const destBinary = join(destDir, LINUX_ENGINE_BINARY_NAME);
  const source = resolveLinuxInstallSource(d.env);

  if (source.kind === "binary") {
    registerExistingLinuxBinary(source.path, destDir, destBinary, log);
    await recordInstall(d, destBinary, null, log);
    printLinuxNextSteps(destBinary, log);
    return { binary: destBinary, version: null, destination: destDir, alreadyInstalled: true };
  }
  if (!d.canWrite(destDir)) {
    throw new EngineInstallError(
      "permission",
      `This user cannot write to ${destDir}. Install into a folder you own: ${INSTALL_RETRY} --path <folder>`
    );
  }

  let url = source.kind === "url" ? source.url : "";
  let sha256Url: string | undefined;
  let versionLabel = "custom";
  if (source.kind === "release") {
    log("Fetching latest Linux release info...");
    try {
      const asset = await fetchLinuxReleaseAsset(source.apiUrl, d.fetch);
      url = asset.url;
      sha256Url = asset.sha256Url;
      versionLabel = asset.version;
    } catch (err) {
      throw new EngineInstallError(
        "release_info",
        `Could not resolve a Linux release artifact (${errorDetail(err)}). See ${DOWNLOAD_PAGE}`
      );
    }
    log(`Latest Linux release: ${versionLabel}`);
  }

  const kind = linuxArchiveKind(url);
  const stamp = Date.now();
  const downloadPath = join(
    d.tmpDir,
    `summer-engine-${stamp}.${kind === "binary" ? "bin" : kind === "zip" ? "zip" : "tar.gz"}`
  );
  const extractDir = join(d.tmpDir, `summer-engine-extract-${stamp}`);
  const releaseSignals = cleanupOnSignal([downloadPath, extractDir]);
  try {
    const expected = await fetchLinuxChecksum(sha256Url, d.fetch);
    await downloadVerified(
      url,
      downloadPath,
      (bytes) => [
        { path: d.tmpDir, bytes },
        { path: destDir, bytes: bytes * INSTALL_SPACE_FACTOR },
      ],
      "Linux artifact",
      expected,
      d,
      log
    );

    let extractedBinary = downloadPath;
    if (kind !== "binary") {
      try {
        mkdirSync(extractDir, { recursive: true });
        d.exec(
          kind === "tar.gz"
            ? `tar -xzf "${downloadPath}" -C "${extractDir}"`
            : `unzip -oq "${downloadPath}" -d "${extractDir}"`
        );
      } catch (err) {
        throw asInstallError(err, "download", (detail) => `Could not unpack the Linux artifact (${detail}). Run: ${INSTALL_RETRY}`);
      }
      const found = findExtractedEngineBinary(walkFiles(extractDir));
      if (!found) {
        throw new EngineInstallError(
          "download",
          `The downloaded archive contains no engine binary (expected ${LINUX_ENGINE_BINARY_NAME}). See ${DOWNLOAD_PAGE}`
        );
      }
      extractedBinary = found;
    }

    // Replace, never edit in place: an engine reading its own binary mid-write
    // is worse than a moment with no file. rename first (same tmpfs), copy as
    // the cross-device fallback.
    try {
      mkdirSync(destDir, { recursive: true });
      rmSync(destBinary, { force: true });
      try {
        renameSync(extractedBinary, destBinary);
      } catch {
        d.exec(`cp "${extractedBinary}" "${destBinary}"`);
      }
      chmodSync(destBinary, 0o755);
    } catch (err) {
      throw asInstallError(err, "copy", (detail) => `Could not put the engine at ${destBinary} (${detail}). Run: ${INSTALL_RETRY} --path <folder>`);
    }
  } finally {
    rmSync(downloadPath, { force: true });
    rmSync(extractDir, { recursive: true, force: true });
    releaseSignals();
  }

  const version = versionLabel === "custom" ? null : versionLabel;
  await recordInstall(d, destBinary, version, log);
  log(`\nSummer Engine (${versionLabel}) installed to ${destBinary}`);
  log(FIRST_START_NOTE);
  printLinuxNextSteps(destBinary, log);
  return { binary: destBinary, version, destination: destDir, alreadyInstalled: false };
}

function printLinuxNextSteps(binary: string, log: (line: string) => void): void {
  log("\nNext steps:");
  log("  summer dev      # Create a starter project and open it");
  log("  summer doctor   # Verify the setup");
  log(`  ${binary} --headless --editor --path <project>   # Headless engine`);
}

export async function downloadFile(url: string, dest: string): Promise<{ sha256: string }> {
  const { res } = await openDownload(url, (input, init) => fetch(input, init));
  const isTTY = Boolean(process.stdout.isTTY);
  const result = await saveDownload(res, dest, createProgressReporter(isTTY, (text) => process.stdout.write(text)));
  if (isTTY) process.stdout.write("\n");
  return result;
}
