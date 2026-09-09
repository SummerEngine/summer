import { spawn as nodeSpawn } from "child_process";
import { closeSync, existsSync, fstatSync, openSync, readSync } from "fs";
import { mkdir } from "fs/promises";
import { platform, tmpdir } from "os";
import { join, resolve } from "path";
import { findEngineBinary as findInstalledEngineBinary } from "../engine-install.js";
import { sleep } from "../util/sleep.js";
import { envMs, HeadlessTimeoutError, scrubSecrets } from "./connection.js";
import {
  findWorkerEntry,
  normalizeProjectPath,
  type ReadRegistryOptions,
  type WorkerRegistryEntry,
} from "./registry.js";

/**
 * On-demand worker spawning: <engine binary> --summer-worker --path <project>
 * then poll the process registry until the worker registers itself.
 *
 * Process model (zombie hygiene):
 *   - The worker is spawned DETACHED (own process group) and unref()ed, so it
 *     deliberately outlives this CLI process — an MCP session ending must not
 *     kill a worker another session may be using. It stays discoverable via
 *     the registry; dead entries are pruned by pid liveness on every read.
 *   - While this process is alive, node's child_process reaps the child on
 *     exit (no zombie), and the exit is used to fail fast (see below).
 *   - stderr goes to a per-spawn log FILE (never a pipe): a pipe would EPIPE
 *     the worker if the CLI exits first. On exit-before-ready the log tail is
 *     read back and surfaced in the error.
 *   - argv array only — no shell, no interpolation.
 *
 * Engine-binary discovery: SUMMER_ENGINE_BIN (this layer's documented
 * override — set-but-missing means "no binary", never a silent fallback),
 * then the canonical resolver in src/core/engine-install.ts (its own
 * SUMMER_ENGINE_BINARY override + the platform install locations shared with
 * `summer install` / `summer run` / `summer doctor`). No install-path list
 * is duplicated here.
 *
 * Single-flight: concurrent spawn requests for the SAME project share one
 * spawn (module-level in-flight promise map keyed by canonical project
 * path). The first caller's options win for the shared attempt.
 */

const STDERR_TAIL_BYTES = 4096;

export function findEngineBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.SUMMER_ENGINE_BIN?.trim();
  if (override) return existsSync(override) ? override : null;
  return findInstalledEngineBinary(platform(), env);
}

/** What a launcher must report back so the poll loop can fail fast when the
 *  worker dies before registering. The default launcher wires a real child
 *  process; tests inject fakes. */
export interface LaunchHandle {
  /** Non-null once the child has exited. */
  exit(): { code: number | null; signal: NodeJS.Signals | null } | null;
  /** Last bytes of the child's stderr (best-effort, may be ""). MUST never
   *  contain the registry token — workers own their own log hygiene, but
   *  this layer additionally never logs tokens itself. */
  stderrTail(): string;
  /** Terminate the child (SIGTERM, escalating to SIGKILL after a grace
   *  period). Called whenever the spawn attempt is ABANDONED without
   *  adopting a registry entry — an unadopted worker must never be leaked.
   *  Optional so test fakes without a real process can omit it. */
  kill?(): void;
}

export type Launcher = (binary: string, args: string[]) => LaunchHandle;

export interface SpawnWorkerOptions {
  /** Explicit engine binary; defaults to findEngineBinary(). */
  binary?: string;
  /** Registry read options (test injection: registryPath / isAlive). */
  registry?: ReadRegistryOptions;
  /** Registration budget. Default SUMMER_WORKER_SPAWN_TIMEOUT_MS or 120s
   *  (first imports of large projects are slow). */
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Elapsed-time progress while waiting for the worker to register. */
  onProgress?: (progress: { phase: string; elapsedMs: number }) => void;
  /** Process launcher, injectable for tests. */
  launch?: Launcher;
}

/** Read ONLY the last STDERR_TAIL_BYTES of a file (open + seek — never the
 *  whole file, which could be huge for a long-lived chatty worker). */
function readFileTail(path: string): string {
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, STDERR_TAIL_BYTES);
      if (length === 0) return "";
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      return buffer.toString("utf-8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

function defaultLaunch(binary: string, args: string[]): LaunchHandle {
  // stderr -> file (see module doc). Directory creation (mode 0700) is done
  // in spawnWorker before the launcher runs; the log itself is 0600 — worker
  // stderr can quote project content and must not be world-readable.
  const logPath = join(
    workerLogDir(),
    `worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`
  );
  const fd = openSync(logPath, "a", 0o600);
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let launchError = "";
  // The child inherits process.env wholesale, which already carries
  // SUMMER_CACHE_DIR when set — so the spawned worker writes its registry
  // entry to the same overridden cache dir this CLI polls. (An earlier
  // explicit re-assignment of the same value was a no-op.)
  const child = nodeSpawn(binary, args, {
    detached: true,
    // detached on Windows opens a new console window for the child unless
    // hidden; a no-op elsewhere.
    windowsHide: true,
    stdio: ["ignore", "ignore", fd],
    env: process.env,
  });
  closeSync(fd);
  child.once("exit", (code, signal) => {
    exit = { code, signal };
  });
  // A spawn failure (ENOENT, EACCES) arrives as an 'error' event, not an
  // exit — without a listener it would crash the process. Treat it as an
  // immediate exit whose "stderr" is the launch error.
  child.once("error", (error) => {
    launchError = error.message;
    exit = exit ?? { code: null, signal: null };
  });
  child.unref();
  return {
    exit: () => exit,
    stderrTail: () => (launchError ? launchError : readFileTail(logPath)),
    kill: () => {
      if (exit) return;
      try {
        child.kill("SIGTERM");
      } catch {
        return; // already gone
      }
      const escalate = setTimeout(() => {
        if (!exit) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }, 5_000);
      // Never keep the CLI alive just to escalate a kill.
      escalate.unref();
    },
  };
}

function workerLogDir(): string {
  return join(tmpdir(), "summer-engine", "worker-logs");
}

// Single-flight: canonical project path -> in-flight spawn attempt.
const inFlightSpawns = new Map<string, Promise<WorkerRegistryEntry>>();

/**
 * Spawn a headless worker for `projectPath` and wait for its registry entry.
 * Resolves with the live entry; rejects on missing binary, early exit
 * (surfacing the exit code and a stderr tail), or registration timeout.
 * Concurrent calls for the same project share ONE spawn.
 */
export function spawnWorker(
  projectPath: string,
  options: SpawnWorkerOptions = {}
): Promise<WorkerRegistryEntry> {
  const target = resolve(projectPath);
  const flightKey = normalizeProjectPath(projectPath);
  const existing = inFlightSpawns.get(flightKey);
  if (existing) return existing;

  const attempt = spawnWorkerOnce(target, options).finally(() => {
    inFlightSpawns.delete(flightKey);
  });
  inFlightSpawns.set(flightKey, attempt);
  return attempt;
}

async function spawnWorkerOnce(
  target: string,
  options: SpawnWorkerOptions
): Promise<WorkerRegistryEntry> {
  const binary = options.binary ?? findEngineBinary();
  if (!binary) {
    throw new Error(
      "Summer Engine binary not found (checked the standard install locations and SUMMER_ENGINE_BIN). " +
        "Install it first: npx summer-engine install"
    );
  }

  // Baseline snapshot (stale-entry defense): a registry entry that already
  // exists for this project — even one whose pid probe still answers — must
  // NEVER satisfy the post-spawn poll. Only an entry that differs from the
  // baseline (new pid/port/token or a newer started_ts) counts as the worker
  // we just launched. This closes the "connect failed to a stale live-pid
  // entry, spawn, then immediately re-adopt the same stale entry" loop.
  const baseline = await findWorkerEntry(target, options.registry);

  const launch = options.launch ?? defaultLaunch;
  if (launch === defaultLaunch) {
    await mkdir(workerLogDir(), { recursive: true, mode: 0o700 });
  }
  const handle = launch(binary, ["--summer-worker", "--path", target]);

  const timeoutMs =
    options.timeoutMs ?? envMs("SUMMER_WORKER_SPAWN_TIMEOUT_MS", 120_000);
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const startedAt = Date.now();

  const isFreshEntry = (entry: WorkerRegistryEntry): boolean => {
    if (!baseline) return true;
    return (
      entry.pid !== baseline.pid ||
      entry.port !== baseline.port ||
      entry.token !== baseline.token ||
      (entry.startedTs ?? 0) > (baseline.startedTs ?? 0)
    );
  };

  while (Date.now() - startedAt < timeoutMs) {
    const entry = await findWorkerEntry(target, options.registry);
    if (entry && isFreshEntry(entry)) return entry;

    // Registry checked first, exit second: a worker that registers and then
    // exits still surfaces its (now dead) entry to the pruning reader, while
    // a crash-before-register fails fast here instead of burning the budget.
    const exit = handle.exit();
    if (exit) {
      // Scrub any token material out of the surfaced tail (defense in depth;
      // the tail is worker stderr and could quote its own environment).
      const tail = scrubSecrets(handle.stderrTail(), [baseline?.token]).trim();
      throw new Error(
        `Headless worker for ${target} exited before registering ` +
          `(code ${exit.code ?? "null"}${exit.signal ? `, signal ${exit.signal}` : ""}).` +
          (tail ? `\nWorker stderr (tail):\n${tail}` : "")
      );
    }

    options.onProgress?.({
      phase: "waiting_for_worker_registration",
      elapsedMs: Date.now() - startedAt,
    });
    await sleep(pollIntervalMs);
  }

  // Abandoning the attempt: never leak the just-spawned child. Kill it so a
  // worker nobody adopted (and whose registry entry never appeared) does not
  // run forever.
  handle.kill?.();
  throw new HeadlessTimeoutError(
    "spawn",
    `Spawned a headless worker for ${target}, but it did not register within ${Math.round(
      timeoutMs / 1000
    )}s (the spawned process has been terminated). First imports of large projects can be ` +
      "slow — raise SUMMER_WORKER_SPAWN_TIMEOUT_MS and retry, or open the project in the Summer editor instead."
  );
}
