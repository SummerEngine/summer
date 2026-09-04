import { Command } from "commander";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { getSummerDir } from "../../core/auth.js";
import { getApiPort, checkEngineHealth } from "../../core/engine.js";
import { findEngineBinary } from "../../core/engine-install.js";
import {
  advertisedBackgroundPosture,
  backgroundLaunchSupport,
  detectBackgroundLaunchSupport,
  planLaunch,
  resolveLaunchPosture,
  BACKGROUND_LAUNCH_FLAG,
  BACKGROUND_LAUNCH_MIN_ENGINE_VERSION,
} from "../../core/launch-posture.js";
import { sleep } from "../../core/util/sleep.js";

const LAUNCH_LOCK_STALE_MS = 60_000;
const LAUNCH_LOCK_WAIT_MS = 15_000;

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

async function removeStaleLaunchLock(lockDir: string): Promise<boolean> {
  const ownerPath = join(lockDir, "owner.json");
  try {
    const raw = await readFile(ownerPath, "utf-8");
    const owner = JSON.parse(raw) as { pid?: unknown; createdAt?: unknown };
    const pid = typeof owner.pid === "number" ? owner.pid : 0;
    const createdAt = typeof owner.createdAt === "number" ? owner.createdAt : 0;
    const staleByTime = Date.now() - createdAt > LAUNCH_LOCK_STALE_MS;
    const staleByPid = !isProcessAlive(pid);
    if (!staleByTime && !staleByPid) {
      return false;
    }
  } catch {
    // Broken owner metadata should not permanently block launches.
  }

  await rm(lockDir, { recursive: true, force: true });
  return true;
}

async function withLaunchLock<T>(fn: () => Promise<T>): Promise<T> {
  const summerDir = getSummerDir();
  await mkdir(summerDir, { recursive: true, mode: 0o700 });

  const lockDir = join(summerDir, "launch.lock");
  const ownerPath = join(lockDir, "owner.json");
  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      try {
        await writeFile(
          ownerPath,
          JSON.stringify({ pid: process.pid, createdAt: Date.now() }, null, 2),
          { encoding: "utf-8", mode: 0o600 }
        );
        return await fn();
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
        throw new Error(
          "Another `summer run` launch is still in progress. Try again in a few seconds."
        );
      }

      await sleep(100);
    }
  }
}

interface RunOptions {
  project: boolean;
  background?: boolean;
  focus?: boolean;
}

export const runCommand = new Command("run")
  .description(
    "Launch Summer Engine with a project. Without a path it launches a bare " +
      "detached editor (project manager), which requires --no-project."
  )
  .argument("[path]", "Path to a project directory (must contain project.godot)")
  .option(
    "--no-project",
    "Launch a bare detached editor (project manager) without opening a project"
  )
  .option(
    "--background",
    "Launch without taking focus: the window exists but stays behind until clicked " +
      "(default when stdout is not a terminal, i.e. an agent is driving)"
  )
  .option(
    "--focus",
    "Launch and bring the editor to the front (default when a human runs this in a terminal)"
  )
  .action(async (projectPath: string | undefined, opts: RunOptions) => {
    // Posture is decided up front so a bad flag combination fails before any
    // filesystem or engine work. Why the TTY heuristic: a human at a terminal
    // typed `summer run` to SEE the editor; an agent (no TTY on stdout) is
    // launching it as a means to an end while the user works on something else
    // and must not be interrupted. See src/core/launch-posture.ts.
    let posture: ReturnType<typeof resolveLaunchPosture>;
    try {
      posture = resolveLaunchPosture(
        { focus: opts.focus, background: opts.background },
        { stdoutIsTTY: process.stdout.isTTY === true }
      );
    } catch (error) {
      console.error((error as Error).message);
      process.exitCode = 1;
      return;
    }
    const fullProjectPath = projectPath ? resolve(projectPath) : null;
    if (!fullProjectPath && opts.project !== false) {
      console.error(
        "summer run needs a project path (a directory containing project.godot).\n" +
          "To launch a bare editor without a project, pass --no-project."
      );
      process.exitCode = 1;
      return;
    }
    if (fullProjectPath) {
      if (!existsSync(fullProjectPath)) {
        console.error(`Directory not found: ${fullProjectPath}`);
        process.exit(1);
      }

      if (!existsSync(join(fullProjectPath, "project.godot"))) {
        console.error(
          `No project.godot found in ${fullProjectPath}\n` +
          "This doesn't look like a Summer Engine project."
        );
        process.exit(1);
      }
    }

    await withLaunchLock(async () => {
      const port = await getApiPort();
      const health = await checkEngineHealth(port);

      if (health) {
        const runningProjectPath = health.project_path
          ? resolve(health.project_path)
          : null;

        if (!fullProjectPath || runningProjectPath === fullProjectPath) {
          console.log(`Summer Engine is already running (v${health.version}) on port ${port}`);
          if (health.project_name) {
            console.log(`  Project: ${health.project_name}`);
          }
          if (health.project_path) {
            console.log(`  Path: ${health.project_path}`);
          }
          return;
        }

        console.log(`Summer Engine is already running (v${health.version}) on port ${port}`);
        console.log(`  Current project: ${health.project_path ?? health.project_name ?? "unknown"}`);
        console.error(
          `Refusing to launch a second editor for: ${fullProjectPath}\n` +
          "Close or switch the current Summer Engine project first, then run this command again."
        );
        process.exitCode = 1;
        return;
      }

      const binary = findEngineBinary();
      if (!binary) {
        console.error(
          "Summer Engine not found. Install it first:\n" +
          "  summer install\n" +
          "  or download from https://summerengine.com/download"
        );
        process.exitCode = 1;
        return;
      }

      // The engine is not running yet, so /api/health cannot tell us whether
      // it honours --summer-background. Ask the binary itself (`--help`, which
      // exits headless before any window exists; cached per install) with the
      // installed version as pre-check and fallback; pass the flag only when
      // the engine is known to support it. Focus launches have nothing to decide.
      const support =
        posture === "background" ? await detectBackgroundLaunchSupport(binary) : backgroundLaunchSupport(null);
      const plan = planLaunch(posture, support);

      const args: string[] = ["--editor", ...plan.extraArgs];
      if (fullProjectPath) {
        args.unshift("--path", fullProjectPath);
      }

      if (plan.note) console.log(plan.note);
      console.log(
        plan.background
          ? "Launching Summer Engine in the background (the window will not take focus until you click it)..."
          : "Launching Summer Engine..."
      );

      // Direct executable, never `open -a`: LaunchServices activates whatever
      // it opens and would defeat --summer-background regardless of flags.
      const child = spawn(binary, args, { detached: true, stdio: "ignore" });
      // A stale or non-executable binary surfaces as an async "error" event
      // (ENOENT/EACCES). Without a listener Node raises it as an uncaught
      // exception with a raw stack; catch it and report the path instead.
      const spawnState: { error: NodeJS.ErrnoException | null } = { error: null };
      child.on("error", (error: NodeJS.ErrnoException) => {
        spawnState.error = error;
      });
      child.unref();

      // Wait for engine to start responding
      const startTime = Date.now();
      const timeout = 20000;

      while (Date.now() - startTime < timeout) {
        await sleep(500);
        if (spawnState.error) {
          reportSpawnFailure(spawnState.error, binary);
          return;
        }
        const newPort = await getApiPort();
        const h = await checkEngineHealth(newPort);
        if (h) {
          console.log(`Summer Engine running (v${h.version}) on port ${newPort}`);
          if (h.project_name) {
            console.log(`  Project: ${h.project_name}`);
          }
          // Background was wanted but the flag was withheld, and the running
          // engine now says (capabilities.launchPostures, else its version)
          // that it would have honoured it: say so, so the next launch can be
          // fixed rather than silently repeating a focus launch.
          if (posture === "background" && !plan.background) {
            const advert = advertisedBackgroundPosture(h.capabilities);
            const wouldHonour = advert ?? backgroundLaunchSupport(h.version).supported;
            if (wouldHonour) {
              console.log(
                `  Note: this engine (v${h.version}) ${advert ? "advertises" : "should support"} background launches (${BACKGROUND_LAUNCH_FLAG}, ${BACKGROUND_LAUNCH_MIN_ENGINE_VERSION}+), but that could not be confirmed before launch on this platform.`
              );
            }
          }
          return;
        }
      }

      if (spawnState.error) {
        reportSpawnFailure(spawnState.error, binary);
        return;
      }

      console.log(
        "Summer Engine launched but API not responding yet.\n" +
        "It may still be loading. Run 'summer status' to check."
      );
    });
  });

function reportSpawnFailure(error: NodeJS.ErrnoException, binary: string): void {
  const code = error.code ?? error.message;
  console.error(
    `Summer Engine binary failed to start: ${code} (${binary})\n` +
      "Re-run 'summer install' to repair the installation, or check the binary path."
  );
  process.exitCode = 1;
}
