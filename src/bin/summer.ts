#!/usr/bin/env node

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

const program = new Command();

program
  .name("summer")
  .description("CLI and MCP tools for Summer Engine — the AI-native game engine")
  .version("0.1.0");

program.addCommand(installCommand);
program.addCommand(loginCommand);
program.addCommand(logoutCommand);
program.addCommand(statusCommand);
program.addCommand(runCommand);
program.addCommand(openCommand);
program.addCommand(createCommand);
program.addCommand(listCommand);
program.addCommand(mcpCommand);

program.parse();
