import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EngineApiClient } from "../lib/api-client.js";
import { registerSceneTools } from "./tools/scene-tools.js";
import { registerDebugTools } from "./tools/debug-tools.js";
import { registerVisualTools } from "./tools/visual-tools.js";
import { WITH_ENGINE_META, type WithEngineMeta } from "./tools/with-engine.js";
import { registerProjectTools } from "./tools/project-tools.js";
import { registerAssetTools } from "./tools/asset-tools.js";
import { registerGenerateTools } from "./tools/generate-tools.js";
import { registerCloudTools } from "./tools/cloud-tools.js";
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
    // The engine rotates its api-token (and can change ports) on every launch, so
    // a cached client can outlive the engine instance it was built for. If the
    // on-disk creds drifted, a silent engine restart happened — drop the stale
    // client and reconnect transparently, instead of surfacing the resulting 401
    // as a "disconnected from the project" error.
    if (await cachedClient.credentialsChanged()) {
      cachedClient = null;
    } else {
      return cachedClient;
    }
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

/**
 * Passive result-size observability. Monkey-patches server.tool() so every
 * registered handler's serialized text payload is measured and logged to
 * stderr in the existing `[summer-mcp]` JSON shape. The result itself is
 * never modified — external coding agents (Claude Code, Cursor, Codex)
 * manage their own context budgets, and silently truncating their tool
 * results is the wrong shape (see #102 revert). If a specific tool turns
 * out to produce pathological payloads in practice, the right fix is
 * adding range/depth/filter parameters to that tool — not a blanket cap.
 */
function installResultSizeLogger(server: {
  tool: (...args: unknown[]) => unknown;
}): void {
  const original = server.tool.bind(server);
  server.tool = function patchedTool(...args: unknown[]) {
    if (args.length < 2) return original(...args);
    const name = args[0];
    if (typeof name !== "string") return original(...args);

    const lastIdx = args.length - 1;
    const handler = args[lastIdx];
    if (typeof handler !== "function") return original(...args);

    const wrapped = async (...handlerArgs: unknown[]) => {
      const startedAt = Date.now();
      const result = await (handler as (...a: unknown[]) => unknown)(
        ...handlerArgs
      );
      const durationMs = Date.now() - startedAt;
      try {
        if (
          result &&
          typeof result === "object" &&
          "content" in result &&
          Array.isArray((result as { content: unknown }).content)
        ) {
          const debug = process.env.SUMMER_MCP_DEBUG === "1";
          const isError = (result as { isError?: boolean }).isError === true;
          // withEngine stamps failure classifiers + retried + bound hash on a
          // non-enumerable symbol so we can log them here without every tool
          // threading its own name through withEngine.
          const meta = (result as Record<PropertyKey, unknown>)[WITH_ENGINE_META] as
            | WithEngineMeta
            | undefined;

          // Structured per-call line. Verbose behind SUMMER_MCP_DEBUG=1; when the
          // flag is off, log ONLY failures — the success path stays quiet.
          if (debug || isError) {
            const callLine = JSON.stringify({
              event: "mcp:tool_call",
              tool: name,
              ok: !isError,
              isError,
              durationMs,
              ...(meta?.terminalState ? { terminalState: meta.terminalState } : {}),
              ...(meta?.errorClass ? { errorClass: meta.errorClass } : {}),
              ...(meta?.failureReason ? { failureReason: meta.failureReason } : {}),
              ...(meta?.retried ? { retried: true } : {}),
              ...(meta?.boundProjectIdHash
                ? { boundProjectIdHash: meta.boundProjectIdHash }
                : {}),
            });
            process.stderr.write(`[summer-mcp] ${callLine}\n`);
          }

          if (debug) {
            let chars = 0;
            for (const entry of (result as { content: Array<{ type?: string; text?: unknown }> })
              .content) {
              if (entry && entry.type === "text" && typeof entry.text === "string") {
                chars += entry.text.length;
              }
            }
            const bytes = Buffer.byteLength(
              (result as { content: Array<{ type?: string; text?: unknown }> }).content
                .filter((e) => e && e.type === "text" && typeof e.text === "string")
                .map((e) => e.text as string)
                .join(""),
              "utf8"
            );
            const line = JSON.stringify({
              event: "mcp:result_size",
              tool_name: name,
              chars,
              bytes,
            });
            process.stderr.write(`[summer-mcp] ${line}\n`);
          }
        }
      } catch {
        // Telemetry must never break the tool call.
      }
      return result;
    };

    const newArgs = [...args];
    newArgs[lastIdx] = wrapped;
    return original(...newArgs);
  } as typeof server.tool;
}

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: "summer-engine",
    version,
  });

  // Passive observability: log result-size to stderr but do not modify
  // results. See installResultSizeLogger above.
  installResultSizeLogger(
    server as unknown as { tool: (...args: unknown[]) => unknown }
  );

  registerSceneTools(server);
  registerDebugTools(server);
  registerVisualTools(server);
  registerProjectTools(server);
  registerAssetTools(server);
  registerGenerateTools(server);
  registerCloudTools(server);

  // Fire-and-forget — never block tool registration on the npm registry.
  void probeBootDrift();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[summer-mcp] MCP server running v${version}.\n`);
}
