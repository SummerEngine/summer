#!/usr/bin/env node

// Composition root: the only module allowed to import both the cli and mcp
// layers. All command wiring lives in src/cli; the MCP server and its
// `summer mcp` command live in src/mcp.
import { runCli } from "../cli/index.js";
import { mcpCommand } from "../mcp/command.js";

runCli(mcpCommand);
