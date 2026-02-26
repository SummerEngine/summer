import { Command } from "commander";
import { startMcpServer } from "../mcp/server.js";

export const mcpCommand = new Command("mcp")
  .description("Start the MCP server for AI tool integration (Cursor, Claude Code, etc.)")
  .action(async () => {
    await startMcpServer();
  });
