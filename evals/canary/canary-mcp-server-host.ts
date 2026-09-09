#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// This evaluation-only host starts the actual built MCP server module beside
// the CLI entry. The keepalive makes lifecycle deterministic for one-shot
// gateway processes; the SDK client's stdin closure releases it.
const requestedEntry = process.argv[2];
const requestedProject = process.argv[3];
if (!requestedEntry) {
  process.stderr.write("canary MCP host requires the built Summer CLI entry path.\n");
  process.exit(2);
}
if (!requestedProject) {
  process.stderr.write("canary MCP host requires an exact project path.\n");
  process.exit(2);
}

const serverEntry = realpathSync(requestedEntry);
const projectPath = realpathSync(requestedProject);
const serverModulePath = realpathSync(resolve(dirname(serverEntry), "../mcp/server.js"));
const keepAlive = setInterval(() => undefined, 60_000);

const serverModule = (await import(pathToFileURL(serverModulePath).href)) as {
  startMcpServer?: (options: {
    projectPath: string;
    cwd: string;
  }) => Promise<void>;
};
if (typeof serverModule.startMcpServer !== "function") {
  throw new Error(`Built Summer server module has no startMcpServer(): ${serverModulePath}`);
}
await serverModule.startMcpServer({ projectPath, cwd: projectPath });
const release = (): void => clearInterval(keepAlive);
process.stdin.once("end", release);
process.stdin.once("close", release);
