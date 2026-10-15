import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EngineApiClient } from "../core/api-client.js";
import type { EngineSelection } from "../core/engine.js";
import { registerSceneTools } from "./tools/scene-tools.js";
import { registerDebugTools } from "./tools/debug-tools.js";
import { registerVisualTools } from "./tools/visual-tools.js";
import { registerSeeingTools } from "./tools/seeing-tools.js";
import { registerAuditTools } from "./tools/audit-tools.js";
import { WITH_ENGINE_META, type WithEngineMeta } from "./tools/with-engine.js";
import {
  registerPlaybookPrompt,
  registerProjectTools,
} from "./tools/project-tools.js";
import { registerPerceptionTools } from "./tools/perception-tools.js";
import { registerSpatialTools } from "./tools/spatial-tools.js";
import { registerPlacementTools } from "./tools/placement-tools.js";
import { registerScriptTools } from "./tools/script-tools.js";
import { registerEventTools } from "./tools/event-tools.js";
import { registerFabricateTools } from "./tools/fabricate-tools.js";
import { registerUiTools } from "./tools/ui-tools.js";
import { registerRuntimeTools } from "./tools/runtime-tools.js";
import { registerAppTools } from "./tools/app-tools.js";
import {
  recordToolCall,
  registrationHasInputSchema,
  trajectoryArgsFor,
} from "../core/trajectory.js";
import { registerFileTools } from "./tools/file-tools.js";
import { registerAssetTools } from "./tools/asset-tools.js";
import { registerGenerateTools } from "./tools/generate-tools.js";
import { registerCreatorTools } from "./tools/creator-tools.js";
import { registerFeedbackTools } from "./tools/feedback-tools.js";
import { registerNavigationTools } from "./tools/navigation-tools.js";
import { registerLibraryTools } from "./tools/library-tools.js";
import {
  getCachedBootDriftNotice as getCachedNotice,
  setCachedBootDriftNotice,
} from "./boot-notice.js";
import { appendMcpLogEvent } from "../core/mcp-log.js";
import { defaultHostedMountDependencies, prepareHostedMount } from "./hosted-mount.js";
import { applyOpsSurface, OPS_MCP_INSTRUCTIONS, SUMMER_CALL, SUMMER_SEARCH, type CloudCaller } from "./ops-surface.js";
import { opForToolCall } from "../core/ops/contract.js";
import { v4HostedDependencies } from "../core/ops/cloud.js";
import { serveProviderSafeToolSchemas } from "./provider-safe-schema.js";
import {
  OUTPUT_CAPS,
  PROFILE_TOOL_LIMIT,
  PROFILES,
  TOOLSETS,
  annotationsFor,
  registryAuthorities,
  resolveToolSelection,
  selectionIncludes,
  withMaxCharactersArg,
  type ToolSelection,
} from "./tool-surface.js";
import { shapeToolResult, singleEditCounter } from "./tool-results.js";
import { recordLocalToolCall, recordMcpSession } from "../core/telemetry.js";
import { registerMcpClientSource, runWithToolContext } from "../core/agent-host.js";
import {
  buildBootDriftNotice,
  fetchLatestRegistryVersion,
} from "../installer/version-check.js";

import { TOOLKIT_VERSION as version } from "../core/version.js";

let processDiagnosticsInstalled = false;

const FULL_SELECTION: ToolSelection = { profile: "full", toolsets: null, ignored: [] };

export const getCachedBootDriftNotice = getCachedNotice;

/**
 * Server `instructions` in the MCP initialize response (SDK ServerOptions,
 * @modelcontextprotocol/sdk >= 1.x). Hosts hand this to the model once per
 * session, before any tool call — the place for the habits end-to-end runs
 * showed an agent needs on the first turn and would otherwise learn the hard
 * way, including scripting a run of scene edits instead of hundreds of single
 * calls. Kept under 600 characters so it costs a few hundred tokens once; the
 * full operating guide stays in the summer_agent_playbook prompt /
 * summer_get_agent_playbook tool. The last sentence names the publishing path,
 * the owner-approval rule and where review feedback is read.
 */
export const SUMMER_MCP_INSTRUCTIONS =
  "Summer Engine MCP. Call summer_get_project_context first: it binds the open project. " +
  "Before building or fixing: summer_search_library, then summer_read_library the hit. " +
  "More than 3 scene edits: one summer_run_script (snapshot, script, diff, screenshot). " +
  "After play: summer_get_diagnostics, not only summer_get_console. " +
  "All-black screenshot: no redraw yet, recapture. " +
  "Report verified entries via summer_library_feedback. " +
  "Publish: summer_export_game, summer_publish_build, summer_store_*; never alone: summer_store_submit returns the owner's approval link, summer_store_review the feedback.";

/** The same first-turn habits for a profile without engine tools (`--profile assets`). */
export const SUMMER_MCP_ASSETS_INSTRUCTIONS =
  "Summer MCP, assets profile: generation and the Summer asset library, no engine tools. " +
  "Before making an asset, summer_search_library then summer_read_library its skill (sound-effect, music-track, concept-art, prop-model). " +
  "Generation costs credits: confirm with the person first. A long job returns a jobId: summer_check_job. " +
  "Every asset lands in the person's Summer library: summer_list_my_assets, summer_get_asset_download_url. " +
  "Report verified entries via summer_library_feedback.";

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
        "Open the intended project in Summer Engine, or run: npx -y summer-engine@latest run\n" +
        "Note: only tools that touch the local project need the engine. Cloud tools " +
        "(summer_generate_*, summer_search_assets, summer_list_my_assets, summer_get_asset, " +
        "summer_check_job) work right now without it — they only need 'npx -y summer-engine@latest login'."
    );
  }
}

export function resetClient(): void {
  cachedClient = null;
}

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

/** Index of the zod raw shape among server.tool()'s middle arguments, or -1. */
function rawShapeIndex(args: readonly unknown[]): number {
  for (let index = 1; index < args.length - 1; index++) {
    const candidate = args[index];
    if (!candidate || typeof candidate !== "object" || "_def" in candidate) continue;
    const values = Object.values(candidate as Record<string, unknown>);
    if (values.length > 0 && values.every((value) => !!value && typeof value === "object" && "_def" in value)) return index;
  }
  return -1;
}

/**
 * Every local tool registers through server.tool(); this wraps each handler
 * once, so the rules hold for all of them:
 * - results leave as compact JSON; capped tools (OUTPUT_CAPS) take a
 *   maxCharacters argument and say when they cut the text;
 * - a run of single scene edits gets one line pointing at summer_run_script;
 * - each call is recorded: the opt-in trajectory, a stderr line on failure
 *   (every call under SUMMER_MCP_DEBUG=1), and, when signed in and not opted
 *   out, the tool name, success, duration and host app name (telemetry.ts).
 */
/** What every recorded call says about the surface that served it. */
interface SurfaceMeta {
  surfaceVersion: SurfaceVersion;
  profile: string;
}

function installToolCallWrapper(server: McpServer, surfaceMeta: SurfaceMeta): () => number {
  const target = server as unknown as { tool: (...args: unknown[]) => unknown };
  const original = target.tool.bind(server);
  const singleEdits = singleEditCounter();
  const hostApp = () => server.server.getClientVersion()?.name;
  let registeredToolCount = 0;
  target.tool = function patchedTool(...registration: unknown[]) {
    if (registration.length < 2) return original(...registration);
    const name = registration[0];
    if (typeof name !== "string") return original(...registration);

    const lastIdx = registration.length - 1;
    const handler = registration[lastIdx];
    if (typeof handler !== "function") return original(...registration);
    registeredToolCount += 1;
    const args = [...registration];
    const cap = OUTPUT_CAPS.get(name);
    const shapeAt = cap === undefined ? -1 : rawShapeIndex(args);
    if (shapeAt > 0) args[shapeAt] = withMaxCharactersArg(name, args[shapeAt] as Record<string, never>);
    // Schema-less tools receive only the SDK's `extra` — never record that as
    // the tool's arguments (see registrationHasInputSchema).
    const hasInputSchema = registrationHasInputSchema(args);

    args[lastIdx] = async (...handlerArgs: unknown[]) => {
      let maxCharacters = cap;
      if (shapeAt > 0 && handlerArgs[0] && typeof handlerArgs[0] === "object") {
        const { maxCharacters: requested, ...rest } = handlerArgs[0] as Record<string, unknown>;
        if (typeof requested === "number") maxCharacters = requested;
        handlerArgs = [rest, ...handlerArgs.slice(1)];
      }
      const startedAt = Date.now();
      let result: unknown;
      try {
        // Every Summer request the tool makes names it (core/agent-host.ts).
        result = await runWithToolContext(name, "mcp", () => (handler as (...a: unknown[]) => unknown)(...handlerArgs));
      } catch (error) {
        // A handler THROW never produced a result to classify; record it as
        // ok:false / exception so the stream does not silently skip failures,
        // then let the SDK turn it into the protocol error it always did.
        const durationMs = Date.now() - startedAt;
        recordToolCall({
          tool: name,
          args: trajectoryArgsFor(hasInputSchema, handlerArgs),
          exception: error instanceof Error ? error.message : String(error),
          durationMs,
        });
        recordLocalToolCall({ tool: name, op: opForToolCall(name, handlerArgs[0]), ...surfaceMeta, ok: false, durationMs, mcpClient: hostApp() });
        throw error;
      }
      const durationMs = Date.now() - startedAt;
      const record = result && typeof result === "object" ? (result as Record<PropertyKey, unknown> & { isError?: boolean }) : null;
      const isError = record?.isError === true;
      // withEngine stamps failure classifiers + retried + bound hash on a
      // non-enumerable symbol so we can log them here without every tool
      // threading its own name through withEngine.
      const meta = record ? (record[WITH_ENGINE_META] as WithEngineMeta | undefined) : undefined;
      try {
        const hint = singleEdits(name, isError);
        result = shapeToolResult(result, { maxCharacters, hint });
      } catch {
        // Shaping must never break the tool call; the raw result goes out.
      }
      try {
        recordMcpSession();
        recordLocalToolCall({ tool: name, op: opForToolCall(name, handlerArgs[0]), ...surfaceMeta, ok: !isError, durationMs, mcpClient: hostApp() });
        // Opt-in local trajectory capture: one JSONL line per tool call when
        // SUMMER_TRAJECTORY_DIR is set. recordToolCall never throws and is a
        // no-op when the env var is unset.
        recordToolCall({
          tool: name,
          args: trajectoryArgsFor(hasInputSchema, handlerArgs),
          isError,
          terminalState: meta?.terminalState,
          errorClass: meta?.errorClass,
          failureReason: meta?.failureReason,
          durationMs,
          // Read only under SUMMER_TRAJECTORY_EVAL=1 (bounded summary); the
          // default redacted stream ignores it.
          result,
        });
        if (
          result &&
          typeof result === "object" &&
          "content" in result &&
          Array.isArray((result as { content: unknown }).content)
        ) {
          const debug = process.env.SUMMER_MCP_DEBUG === "1";

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
            const texts = (result as { content: Array<{ type?: string; text?: unknown }> }).content
              .filter((e) => e && e.type === "text" && typeof e.text === "string")
              .map((e) => e.text as string);
            const chars = texts.reduce((sum, text) => sum + text.length, 0);
            const bytes = Buffer.byteLength(texts.join(""), "utf8");
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

    return original(...args);
  };
  return () => registeredToolCount;
}

/**
 * Build the MCP server with every Summer tool of the selected profile
 * registered, without connecting a transport. startMcpServer() uses this;
 * tests use it to count the live tool surface against
 * registry/generated/counts.json. Without a selection: the full profile.
 */
export type SurfaceVersion = "v3" | "v4";

/** `--surface` / SUMMER_SURFACE: v4 serves the operation catalog; anything else keeps the 3.x tools. */
export function resolveSurface(value: string | undefined, env: NodeJS.ProcessEnv = process.env): SurfaceVersion {
  return (value ?? env.SUMMER_SURFACE ?? "").trim().toLowerCase() === "v4" ? "v4" : "v3";
}

export interface CreateMcpServerOptions {
  /** v4: the operation catalog surface (ops-surface.ts). Default v3. */
  surface?: SurfaceVersion;
  /** Where v4 runs cloud operations (the hosted mount's client). */
  cloud?: CloudCaller;
}

const NO_CLOUD: CloudCaller = {
  call: async () => {
    throw new Error('The hosted Summer server is not connected. Run "summer login".');
  },
};

export function createMcpServer(
  selection: ToolSelection = FULL_SELECTION,
  options: CreateMcpServerOptions = {}
): {
  server: McpServer;
  getRegisteredToolCount: () => number;
} {
  const surface = options.surface ?? "v3";
  const engine = selection.toolsets === null || selection.toolsets.has("engine");
  const server = new McpServer(
    {
      name: "summer-engine",
      version,
    },
    {
      instructions: surface === "v4" ? OPS_MCP_INSTRUCTIONS : engine ? SUMMER_MCP_INSTRUCTIONS : SUMMER_MCP_ASSETS_INSTRUCTIONS,
    }
  );

  const getWrappedToolCount = installToolCallWrapper(server, { surfaceVersion: surface, profile: selection.profile });
  // Requests to Summer's servers name the agent app from the initialize handshake.
  registerMcpClientSource(() => server.server.getClientVersion());

  registerSceneTools(server);
  registerDebugTools(server);
  registerVisualTools(server);
  registerSeeingTools(server);
  registerAuditTools(server);
  registerProjectTools(server);
  registerFileTools(server);
  registerAssetTools(server);
  registerGenerateTools(server);
  registerCreatorTools(server);
  registerFeedbackTools(server);
  registerScriptTools(server);
  registerPerceptionTools(server);
  registerSpatialTools(server);
  registerPlacementTools(server);
  registerNavigationTools(server);
  registerLibraryTools(server);
  registerEventTools(server);
  registerFabricateTools(server);
  registerUiTools(server);
  registerRuntimeTools(server);
  registerAppTools(server);
  // The playbook is also an MCP prompt so prompt-surfacing hosts get it
  // natively (same content as the summer_get_agent_playbook tool).
  registerPlaybookPrompt(server);
  // Strict providers (Kimi, OpenAI strict) reject tuple and $ref schemas.
  serveProviderSafeToolSchemas(server);

  // Effect hints from each tool's registry authority, then the profile:
  // tools outside it are removed before any client lists them.
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
  const authorities = registryAuthorities();
  let removed = 0;
  for (const [name, tool] of Object.entries(registered)) {
    if (!selectionIncludes(selection, name, true)) {
      tool.remove();
      removed += 1;
      continue;
    }
    const authority = authorities.get(name);
    if (authority) tool.update({ annotations: annotationsFor(name, authority) });
  }

  if (surface === "v4") applyOpsSurface(server, { engine, cloud: options.cloud ?? NO_CLOUD });

  return { server, getRegisteredToolCount: () => getWrappedToolCount() - removed };
}

export interface StartMcpServerOptions {
  projectPath?: string;
  instanceId?: string;
  cwd?: string;
  /** --profile / SUMMER_PROFILE (full, engine, assets). */
  profile?: string;
  /** --toolsets / SUMMER_TOOLSETS (comma list; added to the profile). */
  toolsets?: string;
  /** --surface / SUMMER_SURFACE: v4 serves the operation catalog. */
  surface?: string;
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

  const selection = resolveToolSelection({ profile: options.profile, toolsets: options.toolsets });
  if (selection.ignored.length > 0) {
    writeMcpStderr("mcp:unknown_toolsets", {
      ignored: selection.ignored,
      profiles: Object.keys(PROFILES),
      toolsets: TOOLSETS,
    });
  }
  const surface = resolveSurface(options.surface);
  // v4 runs cloud operations through the hosted mount below, once it exists.
  let hostedCall: CloudCaller["call"] | null = null;
  const cloud: CloudCaller = { call: (name, args) => (hostedCall ? hostedCall(name, args) : NO_CLOUD.call(name, args)) };
  const { server, getRegisteredToolCount } = createMcpServer(selection, { surface, cloud });

  // Fire-and-forget — never block tool registration on the npm registry.
  void probeBootDrift().catch((error) => {
    setCachedBootDriftNotice(null);
    appendMcpLogEvent("mcp:boot_drift_probe_failed", errorDetails(error));
  });

  // Hosted Summer Engine MCP tools (store, publishing, board, Grow): ready
  // before connect, mounted after it. The first tools/list waits a few
  // seconds for the mount (not under summer doctor, which times the list).
  // A profile mounts only its hosted toolsets, and never more tools in total
  // than PROFILE_TOOL_LIMIT.
  // v4 mounts the hosted v4 surface (its direct tools; summer_search and
  // summer_call stay local and forward to it).
  const hosted = prepareHostedMount(server, surface === "v4" ? { ...defaultHostedMountDependencies, url: v4HostedDependencies.url } : undefined, {
    ...(process.env.SUMMER_MCP_DOCTOR === "1" ? { firstListWaitMs: 0 } : {}),
    ...(surface === "v4"
      ? { includeTool: (name: string) => name !== SUMMER_SEARCH && name !== SUMMER_CALL, maxTools: PROFILE_TOOL_LIMIT }
      : selection.toolsets === null
        ? {}
        : { includeTool: (name: string) => selectionIncludes(selection, name, false), maxTools: PROFILE_TOOL_LIMIT }),
  });
  hostedCall = hosted.call;

  const transport = new StdioServerTransport();
  await server.connect(transport);
  void hosted.mount();
  appendMcpLogEvent("mcp:ready", {
    version,
    pid: process.pid,
    profile: selection.profile,
    surface,
    toolCount: getRegisteredToolCount(),
  });
  process.stderr.write(`[summer-mcp] MCP server running v${version}.\n`);
}
