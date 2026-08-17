import { Command } from "commander";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { platform } from "os";
import { join, resolve } from "path";
import { getSummerDir } from "../lib/auth.js";
import { getApiPort, checkEngineHealth } from "../lib/engine.js";

const MAC_PATHS = [
  "/Applications/Summer.app/Contents/MacOS/Summer",
  `${process.env.HOME}/Applications/Summer.app/Contents/MacOS/Summer`,
];

const WIN_PATHS = [
  `${process.env.LOCALAPPDATA}\\SummerEngine\\current\\Summer.exe`,
  `${process.env.LOCALAPPDATA}\\Programs\\Summer Engine\\Summer.exe`,
  `${process.env.PROGRAMFILES}\\Summer Engine\\Summer.exe`,
];

const LAUNCH_LOCK_STALE_MS = 60_000;
const LAUNCH_LOCK_WAIT_MS = 15_000;

function findEngineBinary(): string | null {
  const paths = platform() === "darwin" ? MAC_PATHS : WIN_PATHS;
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

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

export const runCommand = new Command("run")
  .description("Launch Summer Engine, optionally opening a project")
  .argument("[path]", "Path to a project directory (must contain project.godot)")
  .action(async (projectPath?: string) => {
    const fullProjectPath = projectPath ? resolve(projectPath) : null;
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

      const args: string[] = ["--editor"];
      if (fullProjectPath) {
        args.unshift("--path", fullProjectPath);
      }

      console.log("Launching Summer Engine...");

      const child = spawn(binary, args, { detached: true, stdio: "ignore" });
      child.unref();

      // Wait for engine to start responding
      const startTime = Date.now();
      const timeout = 20000;

      while (Date.now() - startTime < timeout) {
        await sleep(500);
        const newPort = await getApiPort();
        const h = await checkEngineHealth(newPort);
        if (h) {
          console.log(`Summer Engine running (v${h.version}) on port ${newPort}`);
          if (h.project_name) {
            console.log(`  Project: ${h.project_name}`);
          }
          return;
        }
      }

      console.log(
        "Summer Engine launched but API not responding yet.\n" +
        "It may still be loading. Run 'summer status' to check."
      );
    });
  });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
