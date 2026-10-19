/**
 * Launch Summer Engine on a project and wait until its local API answers:
 * the one launch path behind `summer run`, `summer dev` and the MCP's
 * self-start (src/mcp/server.ts getClient), so all three agree on the
 * posture (launch-posture.ts), the launch lock, and when an editor counts as
 * already open.
 */
import { execFileSync, spawn } from "child_process";
import { readFileSync, realpathSync } from "fs";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { getSummerDir } from "./auth.js";
import { writeStoreJson } from "./store.js";
import { checkEngineHealth, getApiPort, listEngineInstances, type EngineHealth } from "./engine.js";
import {
  describeEngineExecutableProblem,
  ENGINE_BIN_ENV,
  engineBinaryOverride,
  findEngineBinary,
} from "./engine-install.js";
import {
  advertisedBackgroundPosture,
  backgroundLaunchSupport,
  detectBackgroundLaunchSupport,
  planLaunch,
  BACKGROUND_LAUNCH_FLAG,
  BACKGROUND_LAUNCH_MIN_ENGINE_VERSION,
  type LaunchPosture,
} from "./launch-posture.js";
import { processIsAlive } from "./util/process.js";
import { sleep } from "./util/sleep.js";

const LAUNCH_LOCK_STALE_MS = 60_000;
const LAUNCH_LOCK_WAIT_MS = 15_000;

/** How long `summer run` waits for the local API after a launch. */
export const RUN_WAIT_MS = 20_000;

async function removeStaleLaunchLock(lockDir: string): Promise<boolean> {
  const ownerPath = join(lockDir, "owner.json");
  try {
    const raw = await readFile(ownerPath, "utf-8");
    const owner = JSON.parse(raw) as { pid?: unknown; createdAt?: unknown };
    const pid = typeof owner.pid === "number" ? owner.pid : 0;
    const createdAt = typeof owner.createdAt === "number" ? owner.createdAt : 0;
    const staleByTime = Date.now() - createdAt > LAUNCH_LOCK_STALE_MS;
    const staleByPid = !processIsAlive(pid);
    if (!staleByTime && !staleByPid) {
      return false;
    }
  } catch {
    // Broken owner metadata should not permanently block launches.
  }

  await rm(lockDir, { recursive: true, force: true });
  return true;
}

/** Another launch holds ~/.summer/launch.lock: it is starting an editor right now. */
export class LaunchLockBusyError extends Error {
  constructor() {
    super("Another `summer run` launch is still in progress. Try again in a few seconds.");
    this.name = "LaunchLockBusyError";
  }
}

/** Hold ~/.summer/launch.lock while `fn` runs. A launch that waits longer
 *  than the stale age calls `heartbeat` so other launchers keep waiting. */
export async function withLaunchLock<T>(fn: (heartbeat: () => Promise<void>) => Promise<T>): Promise<T> {
  const summerDir = getSummerDir();
  await mkdir(summerDir, { recursive: true, mode: 0o700 });

  const lockDir = join(summerDir, "launch.lock");
  const ownerPath = join(lockDir, "owner.json");
  const startedAt = Date.now();
  const writeOwner = () =>
    writeFile(ownerPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });

  while (true) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      try {
        await writeOwner();
        return await fn(() => writeOwner().catch(() => undefined));
      } finally {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }

      if (await removeStaleLaunchLock(lockDir)) {
        continue;
      }

      if (Date.now() - startedAt > LAUNCH_LOCK_WAIT_MS) {
        throw new LaunchLockBusyError();
      }

      await sleep(100);
    }
  }
}

export type RunBinaryResolution =
  | { binary: string; source: "--bin" | typeof ENGINE_BIN_ENV | "installed" }
  | { binary: null; error: string };

/**
 * Which engine executable a launch uses (and probes with --help):
 * `--bin <path>`, else SUMMER_BIN, else the installed engine
 * (findEngineBinary, which also honours the older SUMMER_ENGINE_BINARY).
 * An explicit override is never silently swapped for the installed engine:
 * a missing path or a bare `.app` bundle is an error, because the caller
 * asked for THAT build.
 */
export function resolveRunBinary(
  binFlag: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): RunBinaryResolution {
  const fromEnv = engineBinaryOverride(env);
  const explicit = binFlag?.trim()
    ? { source: "--bin" as const, path: binFlag.trim() }
    : fromEnv?.name === ENGINE_BIN_ENV
      ? { source: ENGINE_BIN_ENV as typeof ENGINE_BIN_ENV, path: fromEnv.path }
      : null;
  if (explicit) {
    const path = resolve(explicit.path);
    const problem = describeEngineExecutableProblem(path, explicit.source);
    return problem ? { binary: null, error: problem } : { binary: path, source: explicit.source };
  }
  const installed = findEngineBinary();
  if (!installed) {
    return {
      binary: null,
      error:
        "Summer Engine not found. Install it first:\n" +
        "  summer install\n" +
        "  or download from https://summerengine.com/download\n" +
        `To launch a build that is not installed, pass --bin <executable> or set ${ENGINE_BIN_ENV}.`,
    };
  }
  return { binary: installed, source: "installed" };
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The editor the last `summer dev` / `summer run` / MCP launch started: ~/.summer/last-launch.json. */
export const LAST_LAUNCH_FILE = "last-launch.json";

export interface LastLaunch {
  projectPath: string;
  pid: number;
  at: number;
}

/** The last launch while its editor process is alive, else null. */
export function lastLaunch(): LastLaunch | null {
  try {
    const record = JSON.parse(readFileSync(join(getSummerDir(), LAST_LAUNCH_FILE), "utf-8")) as Partial<LastLaunch>;
    if (typeof record.projectPath !== "string" || typeof record.pid !== "number" || typeof record.at !== "number") return null;
    return processIsAlive(record.pid) ? (record as LastLaunch) : null;
  } catch {
    return null;
  }
}

export type OpenEditor =
  | { kind: "none" }
  | { kind: "this"; port: number; health: EngineHealth }
  /** An editor process has this project but does not answer: busy, or still importing. */
  | { kind: "starting"; port: number | null }
  | { kind: "other"; port: number; health: EngineHealth; project: string };

/**
 * Whether an editor already has this project open, has another project open,
 * is starting on it, or nothing answers. Live editors publish
 * ~/.summer/instances/<id>.json with their project root; an entry whose
 * process is alive counts as this project's editor even when it does not
 * answer (a long import), and so does the last launch while its process
 * lives (it registers only once it is up). Older engines publish only the
 * global port pointer, whose /api/health does not say which project is open
 * (so any editor there counts as "another project" unless no project was asked for).
 */
export async function findOpenEditor(projectPath: string | null): Promise<OpenEditor> {
  if (projectPath) {
    const root = canonical(projectPath);
    const instances = await listEngineInstances(Date.now(), getSummerDir(), { anyHeartbeat: true });
    for (const instance of instances.filter((i) => i.resourceRoot === root)) {
      const health = await checkEngineHealth(instance.port);
      return health ? { kind: "this", port: instance.port, health } : { kind: "starting", port: instance.port };
    }
    const last = lastLaunch();
    if ((last && canonical(last.projectPath) === root) || editorStartingFor(root)) return { kind: "starting", port: null };
    for (const instance of instances) {
      const health = await checkEngineHealth(instance.port);
      if (!health) continue;
      const project = instance.projectName ? `${instance.projectName} (${instance.resourceRoot})` : instance.resourceRoot;
      return { kind: "other", port: instance.port, health, project };
    }
  }
  const port = await getApiPort();
  const health = await checkEngineHealth(port);
  if (!health) return { kind: "none" };
  const running = health.project_path ? resolve(health.project_path) : null;
  if (!projectPath || running === resolve(projectPath)) return { kind: "this", port, health };
  return { kind: "other", port, health, project: health.project_path ?? health.project_name ?? "unknown" };
}

/** Whether an editor process was started on this project (its command line
 *  has `--path <project> --editor`), whether or not it answers yet. */
export function editorStartingFor(projectPath: string): boolean {
  if (process.platform === "win32") return false;
  const pattern = `--path ${projectPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} --editor`;
  try {
    return execFileSync("pgrep", ["-f", "--", pattern], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
  } catch {
    return false; // pgrep exits 1 when nothing matches
  }
}

export interface LaunchOutput {
  log: (line: string) => void;
  error: (line: string) => void;
}

export interface LaunchEditorOptions {
  /** Directory holding project.godot, or null for a bare editor (project manager). */
  projectPath: string | null;
  posture: LaunchPosture;
  /** `--bin`; else SUMMER_BIN, else the installed engine (resolveRunBinary). */
  bin?: string;
  /** How long to wait for the local API after launching. Default RUN_WAIT_MS. */
  waitMs?: number;
  /** One "still starting" line this often while waiting; 0 = none. */
  progressEveryMs?: number;
  out: LaunchOutput;
}

export type LaunchEditorResult =
  | { status: "running"; launched: boolean; port: number; health: EngineHealth; pid?: number }
  | { status: "other_project"; project: string }
  | { status: "no_binary"; error: string }
  | { status: "spawn_failed"; binary: string; code: string }
  /** Launched (or found starting), but the API did not answer within waitMs (a first import can take minutes). */
  | { status: "starting"; binary: string | null; pid?: number };

/**
 * Open the project in an editor unless one already has it: refuse a second
 * editor while another project is open, launch with the posture's flags
 * (direct executable, detached), and poll /api/health until it answers or
 * waitMs passes. Prints what it does through `out`; the caller words the end.
 */
export async function launchEditor(options: LaunchEditorOptions): Promise<LaunchEditorResult> {
  const { out, posture } = options;
  const projectPath = options.projectPath ? resolve(options.projectPath) : null;
  const waitMs = options.waitMs ?? RUN_WAIT_MS;
  const progressEveryMs = options.progressEveryMs ?? 0;

  return withLaunchLock(async (heartbeat) => {
    // Poll /api/health (the instance's port when known, else the pointer)
    // until the editor answers or waitMs passes; `onUp` adds the caller's lines.
    const waitForApi = async (
      port: number | null,
      failed: () => LaunchEditorResult | null,
      onUp: (health: EngineHealth) => void
    ): Promise<LaunchEditorResult | null> => {
      const startTime = Date.now();
      let nextProgress = startTime + progressEveryMs;
      let nextHeartbeat = startTime + 10_000;
      while (Date.now() - startTime < waitMs) {
        await sleep(500);
        const failure = failed();
        if (failure) return failure;
        const probe = port ?? (await getApiPort());
        const health = await checkEngineHealth(probe);
        if (health) {
          out.log(`Summer Engine running (v${health.version}) on port ${probe}`);
          if (health.project_name) {
            out.log(`  Project: ${health.project_name}`);
          }
          onUp(health);
          return { status: "running", launched: true, port: probe, health };
        }
        if (progressEveryMs > 0 && Date.now() >= nextProgress) {
          out.log(`  Still starting (${Math.round((Date.now() - startTime) / 1000)} s); the first open imports the project's assets...`);
          nextProgress += progressEveryMs;
        }
        if (Date.now() >= nextHeartbeat) {
          nextHeartbeat += 10_000;
          await heartbeat();
        }
      }
      return failed();
    };

    const open = await findOpenEditor(projectPath);
    if (open.kind === "this") {
      out.log(`Summer Engine is already running (v${open.health.version}) on port ${open.port}`);
      if (open.health.project_name) out.log(`  Project: ${open.health.project_name}`);
      if (open.health.project_path) out.log(`  Path: ${open.health.project_path}`);
      return { status: "running", launched: false, port: open.port, health: open.health };
    }
    if (open.kind === "other") {
      out.log(`Summer Engine is already running (v${open.health.version}) on port ${open.port}`);
      out.log(`  Current project: ${open.project}`);
      out.error(
        `Refusing to launch a second editor for: ${projectPath}\n` +
          "Close or switch the current Summer Engine project first, then run this command again."
      );
      return { status: "other_project", project: open.project };
    }
    // An editor already has this project but does not answer yet (importing,
    // or busy): wait for it, never start a second one.
    if (open.kind === "starting") {
      out.log(`Summer Engine is already starting with ${projectPath}; waiting for it...`);
      const waited = await waitForApi(open.port, () => null, () => {});
      return waited?.status === "running" ? { ...waited, launched: false } : (waited ?? { status: "starting", binary: null });
    }

    const resolved = resolveRunBinary(options.bin);
    if (resolved.binary === null) {
      out.error(resolved.error);
      return { status: "no_binary", error: resolved.error };
    }
    const binary = resolved.binary;
    if (resolved.source !== "installed") {
      out.log(`Using engine from ${resolved.source}: ${binary}`);
    }

    // The engine is not running yet, so /api/health cannot tell us whether
    // it honours --summer-background. Ask THAT binary itself (`--help`, which
    // exits headless before any window exists; cached per install) with the
    // installed version as pre-check and fallback; pass the flag only when
    // the engine is known to support it. Focus launches have nothing to decide.
    const support =
      posture === "background" ? await detectBackgroundLaunchSupport(binary) : backgroundLaunchSupport(null);
    const plan = planLaunch(posture, support);

    const args: string[] = ["--editor", ...plan.extraArgs];
    if (projectPath) {
      args.unshift("--path", projectPath);
    }

    if (plan.note) out.log(plan.note);
    out.log(
      plan.background
        ? "Launching Summer Engine in the background (the window will not take focus until you click it)..."
        : "Launching Summer Engine..."
    );

    // Direct executable, never `open -a`: LaunchServices activates whatever
    // it opens and would defeat --summer-background regardless of flags.
    const child = spawn(binary, args, { detached: true, stdio: "ignore" });
    // A stale or non-executable binary surfaces as an async "error" event
    // (ENOENT/EACCES). Without a listener Node raises it as an uncaught
    // exception with a raw stack; catch it and report the path instead. An
    // editor that exits with an error before its API answers (no display, a
    // crash on open, killed by the system) ends the wait at once.
    const spawnState: { error: NodeJS.ErrnoException | null; exit: string | null } = { error: null, exit: null };
    child.on("error", (error: NodeJS.ErrnoException) => {
      spawnState.error = error;
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (code !== 0) spawnState.exit = signal ? `killed by ${signal}` : `exited with code ${code}`;
    });
    child.unref();
    if (projectPath && child.pid) {
      // Other launchers (another `summer dev`, the MCP) wait for this editor
      // until it registers, and the MCP finds the project through it.
      await writeStoreJson(LAST_LAUNCH_FILE, { projectPath, pid: child.pid, at: Date.now() } satisfies LastLaunch).catch(() => undefined);
    }

    const spawnFailed = (): LaunchEditorResult | null => {
      const code = spawnState.error ? (spawnState.error.code ?? spawnState.error.message) : spawnState.exit;
      if (!code) return null;
      out.error(
        `Summer Engine binary failed to start: ${code} (${binary})\n` +
          "Re-run 'summer install' to repair the installation, or check the binary path."
      );
      return { status: "spawn_failed", binary, code };
    };

    const result = await waitForApi(null, spawnFailed, (health) => {
      // Background was wanted but the flag was withheld, and the running
      // engine now says (capabilities.launchPostures, else its version)
      // that it would have honoured it: say so, so the next launch can be
      // fixed rather than silently repeating a focus launch.
      if (posture === "background" && !plan.background) {
        const advert = advertisedBackgroundPosture(health.capabilities);
        const wouldHonour = advert ?? backgroundLaunchSupport(health.version).supported;
        if (wouldHonour) {
          out.log(
            `  Note: this engine (v${health.version}) ${advert ? "advertises" : "should support"} background launches (${BACKGROUND_LAUNCH_FLAG}, ${BACKGROUND_LAUNCH_MIN_ENGINE_VERSION}+), but that could not be confirmed before launch on this platform.`
          );
        }
      }
    });
    if (result?.status === "running") return { ...result, pid: child.pid };
    return result ?? { status: "starting", binary, pid: child.pid };
  });
}
