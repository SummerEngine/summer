import { Command } from "commander";
import { existsSync } from "fs";
import { resolve } from "path";
import { getApiPort, checkEngineHealth } from "../lib/engine.js";

export const openCommand = new Command("open")
  .description("Open a project in Summer Engine")
  .argument("<path>", "Path to project directory (must contain project.godot)")
  .action(async (projectPath: string) => {
    const fullPath = resolve(projectPath);

    if (!existsSync(fullPath)) {
      console.error(`Directory not found: ${fullPath}`);
      process.exit(1);
    }

    if (!existsSync(`${fullPath}/project.godot`)) {
      console.error(
        `No project.godot found in ${fullPath}\n` +
        "This doesn't look like a Godot/Summer Engine project.\n" +
        "Create one with: summer create 3d-basic my-game"
      );
      process.exit(1);
    }

    const port = await getApiPort();
    const health = await checkEngineHealth(port);

    if (!health) {
      console.log("Engine not running. Launching with this project...");
      // Import dynamically to avoid circular deps
      const { runCommand } = await import("./run.js");
      await runCommand.parseAsync(["node", "summer", fullPath], { from: "user" });
      return;
    }

    console.log(`Opening project: ${fullPath}`);
    console.log(
      "Note: To switch projects, close the current one in Summer Engine first,\n" +
      "then run: summer run " + fullPath
    );
  });
