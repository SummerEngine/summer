#!/usr/bin/env node

import { createRequire } from "node:module";
import { Command } from "commander";
import { mcpCommand } from "../commands/mcp.js";
import { loginCommand } from "../commands/login.js";
import { logoutCommand } from "../commands/logout.js";
import { statusCommand } from "../commands/status.js";
import { runCommand } from "../commands/run.js";
import { openCommand } from "../commands/open.js";
import { installCommand } from "../commands/install.js";
import { createCommand } from "../commands/create.js";
import { listCommand } from "../commands/list.js";
import { memoryCommand } from "../commands/memory.js";
import { skillsCommand } from "../commands/skills.js";
import { orchestratorCommand } from "../commands/orchestrator.js";
import { setupCommand } from "../commands/setup.js";
import { doctorCommand } from "../commands/doctor.js";
import { planCommand } from "../commands/plan.js";
import { cloudCommand } from "../commands/cloud.js";
import { getBanner } from "../lib/banner.js";
import { c, sym } from "../lib/format.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json");

const program = new Command();

program
  .name("summer")
  .description("CLI and MCP tools for Summer Engine — the AI-native game engine")
  .version(version)
  .action(() => {
    printIntro(version);
  });

program.addCommand(installCommand);
program.addCommand(loginCommand);
program.addCommand(logoutCommand);
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
program.addCommand(planCommand);
program.addCommand(orchestratorCommand);
program.addCommand(cloudCommand);

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

function printIntro(version: string): void {
  console.log("");
  console.log(getBanner());
  console.log("");
  console.log(`     ${sym.arrow()} ${c.bold("Summer Engine")} ${c.dim("v" + version)}  ${c.dim("·")}  AI-native game engine`);
  console.log("");
  console.log(`     ${c.bold("Setup wizard")}`);
  console.log(`     Open Claude Code, Cursor, Codex, Copilot, Windsurf, or another supported agent and paste:`);
  console.log(`     ${c.brand("\"Install Summer Engine and let's make a game.\"")}`);
  console.log("");
  console.log(`     ${c.bold("Manual commands")}`);
  console.log(`     ${c.dim("$")} npx -y summer-engine@latest setup claude-code --yes`);
  console.log(`     ${c.dim("$")} npx -y summer-engine@latest create 3d-basic my-game`);
  console.log(`     ${c.dim("$")} npx -y summer-engine@latest plan make a small arena shooter`);
  console.log(`     ${c.dim("$")} npx -y summer-engine@latest memory`);
  console.log(`     ${c.dim("$")} npx -y summer-engine@latest doctor`);
  console.log("");
  console.log(`     ${c.bold("Slash commands")} ${c.dim("(in your AI agent)")}`);
  console.log(`     ${c.brand("/debug")}   ${c.dim("Triage and fix a bug end-to-end")}`);
  console.log(`     ${c.brand("/play")}    ${c.dim("Run the game and report state")}`);
  console.log("");
  console.log(`     ${c.dim("Docs:")} https://summerengine.com/docs`);
  console.log(`     ${c.dim("Source:")} https://github.com/SummerEngine/summer-engine-agent`);
  console.log("");
}
