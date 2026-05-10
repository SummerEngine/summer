import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EngineApiClient } from "../lib/api-client.js";
import { registerSceneTools } from "./tools/scene-tools.js";
import { registerDebugTools } from "./tools/debug-tools.js";
import { registerProjectTools } from "./tools/project-tools.js";
import { registerAssetTools } from "./tools/asset-tools.js";
import { registerGenerateTools } from "./tools/generate-tools.js";
import {
  buildBootDriftNotice,
  fetchLatestRegistryVersion,
  type BootDriftNotice,
} from "../lib/version-check.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json");

let cachedBootDriftNotice: BootDriftNotice | null = null;

export function getCachedBootDriftNotice(): BootDriftNotice | null {
  return cachedBootDriftNotice;
}

/**
 * Fire-and-forget probe of the npm registry on MCP boot. Caches the result for
 * the session. We never await this in startup so a slow / offline registry
 * never blocks tool registration. Tools that surface the notice should call
 * `getCachedBootDriftNotice()` and skip silently when null.
 */
async function probeBootDrift(): Promise<void> {
  const registry = await fetchLatestRegistryVersion();
  // Agent is unknown at the MCP layer; use a generic placeholder. Doctor still
  // prescribes the correct agent-aware command via setup recommendations.
  cachedBootDriftNotice = buildBootDriftNotice(version, registry);
}

let cachedClient: EngineApiClient | null = null;

export async function getClient(): Promise<EngineApiClient> {
  if (cachedClient) {
    return cachedClient;
  }

  try {
    cachedClient = await EngineApiClient.connect();
    return cachedClient;
  } catch {
    cachedClient = null;
    throw new Error(
      "Summer Engine is not running. Open it first, or run: npx summer-engine run"
    );
  }
}

export function resetClient(): void {
  cachedClient = null;
}

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: "summer-engine",
    version,
  });

  registerSceneTools(server);
  registerDebugTools(server);
  registerProjectTools(server);
  registerAssetTools(server);
  registerGenerateTools(server);

  // Fire-and-forget — never block tool registration on the npm registry.
  void probeBootDrift();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[summer-mcp] MCP server running v${version}.\n`);
}
