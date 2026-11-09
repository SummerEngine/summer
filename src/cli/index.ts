import { Command } from "commander";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { tokenCommand } from "./commands/token.js";
import { statusCommand } from "./commands/status.js";
import { runCommand } from "./commands/run.js";
import { openCommand } from "./commands/open.js";
import { installCommand } from "./commands/install.js";
import { createCommand } from "./commands/create.js";
import { devCommand } from "./commands/dev.js";
import { listCommand } from "./commands/list.js";
import { memoryCommand } from "./commands/memory.js";
import { skillsCommand } from "./commands/skills.js";
import { setupCommand } from "./commands/setup.js";
import { doctorCommand } from "./commands/doctor.js";
import { planCommand } from "./commands/plan.js";
import { debugCommand } from "./commands/debug.js";
import { configCommand } from "./commands/config.js";
import { eventsCommand } from "./commands/events.js";
import { previewCommand } from "./commands/preview.js";
import { toolCommand } from "./commands/tool.js";
import { apiCommand } from "./commands/api.js";
import { opsCliCommands } from "./commands/ops.js";
import { getBanner } from "./banner.js";
import { runRootAction } from "./root-action.js";
import { c, sym } from "../core/format.js";
import { resolveSurface } from "../core/tool-profiles.js";
import { trackCommandUsage } from "./command-usage.js";

import { TOOLKIT_VERSION as version } from "../core/version.js";

/**
 * Build and run the summer CLI. The `mcp` command is injected by the bin
 * entry (the composition root) so the cli layer never imports from src/mcp.
 */
export function runCli(mcpCommand: Command): void {
  const program = new Command();

  program
    .name("summer")
    .description("CLI and MCP tools for Summer Engine — the AI-native game engine")
    .version(version)
    .action((_opts: unknown, command: Command) => {
      runRootAction(command.args, () => printIntro(version));
    });

  program.addCommand(devCommand);
  program.addCommand(installCommand);
  program.addCommand(loginCommand);
  program.addCommand(logoutCommand);
  program.addCommand(tokenCommand);
  program.addCommand(statusCommand);
  program.addCommand(runCommand);
  program.addCommand(openCommand);
  program.addCommand(createCommand);
  program.addCommand(listCommand);
  program.addCommand(memoryCommand);
  program.addCommand(skillsCommand);
  program.addCommand(mcpCommand);
  program.addCommand(setupCommand);
  program.addCommand(doctorCommand);
  program.addCommand(debugCommand);
  program.addCommand(planCommand);
  program.addCommand(configCommand);
  program.addCommand(eventsCommand);
  program.addCommand(previewCommand);
  program.addCommand(toolCommand);
  program.addCommand(apiCommand);
  // The 4.0 operation catalog (`summer <area> <action>`); SUMMER_SURFACE=v3 leaves it out.
  if (resolveSurface(undefined) === "v4") {
    for (const command of opsCliCommands()) program.addCommand(command);
  }

  trackCommandUsage(program);

  program.parseAsync().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

function printIntro(version: string): void {
  console.log("");
  console.log(getBanner());
  console.log("");
  console.log(`     ${sym.arrow()} ${c.bold("Summer Engine")} ${c.dim("v" + version)}  ${c.dim("·")}  AI-native game engine`);
  console.log("");
  console.log(`     ${c.bold("Setup wizard")}`);
  console.log(`     Open Claude Code, Cursor, Codex, Copilot, Devin Desktop (formerly Windsurf), or another supported agent and paste:`);
  console.log(`     ${c.brand("\"Install Summer Engine and let's make a game.\"")}`);
  console.log("");
  console.log(`     ${c.bold("Manual commands")}`);
  console.log(`     ${c.dim("$")} npx -y summer-engine@latest dev   ${c.dim("# install, create a starter project, open it")}`);
  console.log(`     ${c.dim("$")} npx -y summer-engine@latest setup claude-code --yes`);
  console.log(`     ${c.dim("$")} npx -y summer-engine@latest create 3d-basic my-game`);
  console.log(`     ${c.dim("$")} npx -y summer-engine@latest plan make a small arena shooter`);
  console.log(`     ${c.dim("$")} npx -y summer-engine@latest debug "player crashes on pickup"`);
  console.log(`     ${c.dim("$")} npx -y summer-engine@latest memory`);
  console.log(`     ${c.dim("$")} npx -y summer-engine@latest doctor`);
  console.log("");
  console.log(`     ${c.bold("Slash commands")} ${c.dim("(in your AI agent)")}`);
  console.log(`     ${c.brand("/summer debug")}   ${c.dim("Create a support-ready debug report")}`);
  console.log(`     ${c.brand("/debug")}   ${c.dim("Triage and fix a bug end-to-end")}`);
  console.log(`     ${c.brand("/play")}    ${c.dim("Run the game and report state")}`);
  console.log("");
  console.log(`     ${c.dim("Docs:")} https://summerengine.com/docs`);
  console.log(`     ${c.dim("Source:")} https://github.com/summerengine/summer`);
  console.log("");
}
