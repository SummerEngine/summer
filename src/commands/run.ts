import { Command } from "commander";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { platform } from "os";
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

function findEngineBinary(): string | null {
  const paths = platform() === "darwin" ? MAC_PATHS : WIN_PATHS;
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

export const runCommand = new Command("run")
  .description("Launch Summer Engine, optionally opening a project")
  .argument("[path]", "Path to a project directory (must contain project.godot)")
  .action(async (projectPath?: string) => {
    const port = await getApiPort();
    const health = await checkEngineHealth(port);

    if (health && !projectPath) {
      console.log(`Summer Engine is already running (v${health.version}) on port ${port}`);
      if (health.project_name) {
        console.log(`  Project: ${health.project_name}`);
      }
      return;
    }

    const binary = findEngineBinary();
    if (!binary) {
      console.error(
        "Summer Engine not found. Install it first:\n" +
        "  summer install\n" +
        "  or download from https://summerengine.com/download"
      );
      process.exit(1);
    }

    const args: string[] = ["--editor"];
    if (projectPath) {
      args.unshift("--path", projectPath);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
