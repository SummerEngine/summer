import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EngineApiClient } from "../core/api-client.js";
import type { EngineSelection } from "../core/engine.js";
import { registerSceneTools } from "./tools/scene-tools.js";
import { registerDebugTools } from "./tools/debug-tools.js";
import { registerVisualTools } from "./tools/visual-tools.js";
import { WITH_ENGINE_META, type WithEngineMeta } from "./tools/with-engine.js";
import { registerProjectTools } from "./tools/project-tools.js";
import { registerFileTools } from "./tools/file-tools.js";
import { registerAssetTools } from "./tools/asset-tools.js";
import { registerGenerateTools } from "./tools/generate-tools.js";
import { registerCloudTools } from "./tools/cloud-tools.js";
import { registerCreatorTools } from "./tools/creator-tools.js";
import { registerFeedbackTools } from "./tools/feedback-tools.js";
import {
  getCachedBootDriftNotice as getCachedNotice,
  setCachedBootDriftNotice,
} from "./boot-notice.js";
import { appendMcpLogEvent } from "../core/mcp-log.js";
import {
  buildBootDriftNotice,
  fetchLatestRegistryVersion,
} from "../installer/version-check.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json");

let processDiagnosticsInstalled = false;

export const getCachedBootDriftNotice = getCachedNotice;

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
  setCachedBootDriftNotice(buildBootDriftNotice(version, registry));
}

let cachedClient: EngineApiClient | null = null;
let engineSelection: EngineSelection | undefined;

export function configureMcpEngineSelection(
  selection?: EngineSelection
): void {
  engineSelection = selection ? { ...selection } : undefined;
  cachedClient = null;
}

export async function getClient(): Promise<EngineApiClient> {
  // Opt-in per-project routing (editor -> live worker -> spawned worker).
  // OFF by default: with the flag unset this block is skipped entirely and
  // src/core/headless/ is never even loaded (dynamic import). With the flag
  // set, the router returns null whenever the existing path should serve the
  // call (no project context, or a live editor has the project open), so
  // editor behavior stays identical. See docs/HEADLESS_ROUTING.md.
  if (process.env.SUMMER_HEADLESS_ROUTING === "1") {
    const { getHeadlessRoutedClient } = await import(
      "../core/headless/mcp-routing.js"
    );
    const routed = await getHeadlessRoutedClient(engineSelection);
    if (routed) return routed;
  }

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
    cachedClient = await EngineApiClient.connect(engineSelection);
    return cachedClient;
  } catch (error) {
    cachedClient = null;
    const reason =
      error instanceof Error
        ? error.message
        : "Summer Engine is not running.";
    throw new Error(
      reason + "\n" +
        "Open the intended project in Summer Engine, or run: npx summer-engine run\n" +
        "Note: only tools that touch the local project need the engine. Cloud tools " +
        "(summer_generate_*, summer_search_assets, summer_list_my_assets, summer_get_asset, " +
        "summer_check_job) work right now without it — they only need 'npx summer-engine login'."
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
function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

function writeMcpStderr(event: string, details: Record<string, unknown> = {}): void {
  process.stderr.write(`[summer-mcp] ${JSON.stringify({ event, ...details })}\n`);
}

function installMcpProcessDiagnostics(): void {
  if (processDiagnosticsInstalled) return;
  processDiagnosticsInstalled = true;

  process.once("uncaughtException", (error) => {
    const details = errorDetails(error);
    appendMcpLogEvent("mcp:uncaught_exception", details);
    writeMcpStderr("mcp:uncaught_exception", {
      message: details.message,
      log: "~/.summer/mcp.log",
    });
    process.exit(1);
  });

  process.once("unhandledRejection", (reason) => {
    const details = errorDetails(reason);
    appendMcpLogEvent("mcp:unhandled_rejection", details);
    writeMcpStderr("mcp:unhandled_rejection", {
      message: details.message,
      log: "~/.summer/mcp.log",
    });
    process.exit(1);
  });

  process.once("SIGTERM", () => {
    appendMcpLogEvent("mcp:sigterm", { pid: process.pid });
    process.exit(0);
  });

  process.once("SIGINT", () => {
    appendMcpLogEvent("mcp:sigint", { pid: process.pid });
    process.exit(0);
  });

  process.once("exit", (code) => {
    appendMcpLogEvent("mcp:exit", { pid: process.pid, code });
  });
}

function installResultSizeLogger(server: {
  tool: (...args: unknown[]) => unknown;
}): () => number {
  const original = server.tool.bind(server);
  let registeredToolCount = 0;
  server.tool = function patchedTool(...args: unknown[]) {
    if (args.length < 2) return original(...args);
    const name = args[0];
    if (typeof name !== "string") return original(...args);

    const lastIdx = args.length - 1;
    const handler = args[lastIdx];
    if (typeof handler !== "function") return original(...args);
    registeredToolCount += 1;

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
            appendMcpLogEvent("mcp:result_size", {
              toolName: name,
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
  return () => registeredToolCount;
}

export interface StartMcpServerOptions {
  projectPath?: string;
  instanceId?: string;
  cwd?: string;
}

export async function startMcpServer(
  options: StartMcpServerOptions = {}
): Promise<void> {
  configureMcpEngineSelection({
    instanceId:
      options.instanceId ?? process.env.SUMMER_ENGINE_INSTANCE_ID,
    projectPath:
      options.projectPath ?? process.env.SUMMER_ENGINE_PROJECT,
    cwd: options.cwd ?? process.cwd(),
  });
  installMcpProcessDiagnostics();
  appendMcpLogEvent("mcp:start", {
    version,
    pid: process.pid,
    node: process.version,
    cwd: process.cwd(),
    selection: {
      instanceId: options.instanceId ? "explicit" : undefined,
      projectPath: options.projectPath ? "explicit" : undefined,
      cwd: options.cwd ?? process.cwd(),
    },
  });

  const server = new McpServer({
    name: "summer-engine",
    version,
  });

  // Passive observability: log result-size to stderr but do not modify
  // results. See installResultSizeLogger above.
  const getRegisteredToolCount = installResultSizeLogger(
    server as unknown as { tool: (...args: unknown[]) => unknown }
  );

  registerSceneTools(server);
  registerDebugTools(server);
  registerVisualTools(server);
  registerProjectTools(server);
  registerFileTools(server);
  registerAssetTools(server);
  registerGenerateTools(server);
  registerCloudTools(server);
  registerCreatorTools(server);
  registerFeedbackTools(server);

  // Fire-and-forget — never block tool registration on the npm registry.
  void probeBootDrift().catch((error) => {
    setCachedBootDriftNotice(null);
    appendMcpLogEvent("mcp:boot_drift_probe_failed", errorDetails(error));
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  appendMcpLogEvent("mcp:ready", {
    version,
    pid: process.pid,
    toolCount: getRegisteredToolCount(),
  });
  process.stderr.write(`[summer-mcp] MCP server running v${version}.\n`);
}
