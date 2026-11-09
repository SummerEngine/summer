import { Command } from "commander";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { launchEditor } from "../../core/engine-launch.js";
import { ENGINE_BIN_ENV } from "../../core/engine-install.js";
import { resolveLaunchPosture } from "../../core/launch-posture.js";

// The launch itself (lock, already-open check, posture flags, health wait)
// lives in core/engine-launch.ts, shared with `summer dev` and the MCP.
export { resolveRunBinary, type RunBinaryResolution } from "../../core/engine-launch.js";

interface RunOptions {
  project: boolean;
  background?: boolean;
  focus?: boolean;
  bin?: string;
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
  .option(
    "--bin <path>",
    `Engine executable to launch instead of the installed one (env: ${ENGINE_BIN_ENV}). ` +
      "On macOS this is the executable inside the bundle, e.g. /path/Summer.app/Contents/MacOS/Summer, never the .app itself"
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

    const result = await launchEditor({
      projectPath: fullProjectPath,
      posture,
      bin: opts.bin,
      out: { log: (line) => console.log(line), error: (line) => console.error(line) },
    });
    if (result.status === "starting") {
      console.log(
        "Summer Engine launched but API not responding yet.\n" +
        "It may still be loading. Run 'summer status' to check."
      );
    } else if (result.status !== "running") {
      process.exitCode = 1;
    }
  });
