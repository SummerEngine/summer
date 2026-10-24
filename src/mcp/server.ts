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
import { registerLocalProjectTools } from "./tools/local-project-tools.js";
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
import { registerApiTools } from "./tools/api-tools.js";
import { registerNavigationTools } from "./tools/navigation-tools.js";
import { registerLibraryTools } from "./tools/library-tools.js";
import {
  getCachedBootDriftNotice as getCachedNotice,
  setCachedBootDriftNotice,
} from "./boot-notice.js";
import { appendMcpLogEvent } from "../core/mcp-log.js";
import { defaultHostedMountDependencies, prepareHostedMount } from "./hosted-mount.js";
import { applyOpsSurface, hostedFileTools, OPS_MCP_ASSETS_INSTRUCTIONS, OPS_MCP_INSTRUCTIONS, SUMMER_CALL, SUMMER_SEARCH, type CloudCaller } from "./ops-surface.js";
import { FileSaver } from "../core/ops/save-files.js";
import { runInAppStudio } from "../core/ops/studio-page.js";
import { opForToolCall } from "../core/ops/contract.js";
import { knownOp } from "../core/ops/catalog.js";
import { v4HostedUrl } from "../core/ops/cloud.js";
import { serveProviderSafeToolSchemas } from "./provider-safe-schema.js";
import { legacyHostedDescription, resolveLegacy, takeLegacyToolset } from "./legacy-toolset.js";
import { refreshInstalledSkills, refreshNotice } from "../installer/skills-refresh.js";
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
import { shapeToolResult, singleEditCounter, withSignInLink } from "./tool-results.js";
import { SignInLinks } from "../core/sign-in-link.js";
import { recordLocalToolCall, recordMcpSession, toolErrorCode } from "../core/telemetry.js";
import { boundProject, type UsageFields } from "../core/usage-fields.js";
import { currentToolContext, registerMcpClientSource, runWithToolContext } from "../core/agent-host.js";
import {
  buildBootDriftNotice,
  fetchLatestRegistryVersion,
} from "../installer/version-check.js";

import { TOOLKIT_VERSION as version } from "../core/version.js";
import { ENGINE_FREE_NOTE, engineNotRunningFromConnectError } from "../core/error-codes.js";
import { selfStartEngine } from "../core/engine-self-start.js";
import { resolveSurface, type SurfaceVersion } from "../core/tool-profiles.js";
import { OAuthError } from "../core/oauth.js";

let processDiagnosticsInstalled = false;

const FULL_SELECTION: ToolSelection = { profile: "full", toolsets: null, ignored: [] };

export const getCachedBootDriftNotice = getCachedNotice;

/**
 * Server `instructions` in the MCP initialize response (SDK ServerOptions,
 * @modelcontextprotocol/sdk >= 1.x). Hosts hand this to the model once per
 * session, before any tool call — the place for the habits end-to-end runs
 * showed an agent needs on the first turn and would otherwise learn the hard
 * way, including scripting a run of scene edits instead of hundreds of single
 * calls. Kept under 800 characters so it costs a few hundred tokens once; the
 * full operating guide stays in the summer_agent_playbook prompt /
 * summer_get_agent_playbook tool. The publish sentence names the publishing
 * path, the user's confirmation and that going live has no staff wait; the last
 * says an agent may open the editor and play the game in a window.
 */
export const SUMMER_MCP_INSTRUCTIONS =
  "Summer Engine MCP. Call summer_get_project_context first: it binds the open project. " +
  "Before building or fixing: summer_search_library, then summer_read_library the hit. " +
  "More than 3 scene edits: one summer_run_script (snapshot, script, diff, screenshot). " +
  "After play: summer_get_diagnostics, not only summer_get_console. " +
  "All-black screenshot: no redraw yet, recapture. " +
  "Report verified entries via summer_library_feedback. " +
  "Publish: summer_export_game, summer_publish_build, skill/release-checklist, summer_go_live, each confirmed. Live once automated checks pass: never say wait for review. " +
  "Opening the editor and playing the game in a window is allowed and expected: summer_play, then summer_screenshot or summer_frame_shot; close what you opened, one editor at a time.";

/** The same first-turn habits for a profile without engine tools (`--profile assets`). */
export const SUMMER_MCP_ASSETS_INSTRUCTIONS =
  "Summer MCP, assets profile: generation and the Summer asset library, no engine tools. " +
  "Read skill/summer-assets, then the asset's skill (sound-effect, prop-model, ...): stop at the file, skip its engine steps. " +
  "Generation costs credits: confirm first. A job returns a jobId: summer_check_job. " +
  "Hand over files with summer_get_asset_download_url. " +
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

/** The session's editor selection (projects.open_local opens its project). */
export function currentMcpEngineSelection(): EngineSelection | undefined {
  return engineSelection ? { ...engineSelection } : undefined;
}

/** Bind the session to the project projects.open_local opened, with the client it connected. */
export function bindMcpProject(projectRoot: string, client: EngineApiClient): void {
  engineSelection = { cwd: projectRoot };
  cachedClient = client;
}

/** The step's log lines go to the MCP log and stderr, never stdout (the protocol). */
export function logEngineSelfStart(line: string): void {
  appendMcpLogEvent("mcp:engine_self_start", { line });
  writeMcpStderr("mcp:engine_self_start", { line });
}

/** `launch: false`: connect only, never open the editor (summer_open lists and prints with no side effects). */
export async function getClient(options: { launch?: boolean } = {}): Promise<EngineApiClient> {
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
    // Nothing reachable: a coded error withEngine renders as JSON
    // (engine_not_running). Anything else (several editors open, …) already
    // says how to pick one.
    const notRunning = engineNotRunningFromConnectError(reason);
    if (notRunning && options.launch === false) throw notRunning;
    if (notRunning) {
      // Open the session's project ourselves when we can, else a coded
      // error with the one command that gets there (core/engine-self-start.ts).
      cachedClient = await selfStartEngine(engineSelection, notRunning, { log: logEngineSelfStart });
      return cachedClient;
    }
    throw new Error(
      reason + "\n" +
        "Open the intended project in Summer Engine, or run: npx -y summer-engine@latest run <project-path>\n" +
        "Note: " + ENGINE_FREE_NOTE
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

function installToolCallWrapper(server: McpServer, surfaceMeta: SurfaceMeta, signInLinks = new SignInLinks()): () => number {
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
      // A tool another tool runs (summer_call, a v4 operation over its 3.x
      // tool) is part of that call: only the outer call sends a usage line.
      const nested = currentToolContext() !== undefined;
      // What the call notes for its line (core/usage-fields.ts), shared with any tool it runs.
      let noted: UsageFields = {};
      const recordUsage = (ok: boolean, durationMs: number, error?: string | null) => {
        const bound = boundProject();
        const usage = { ...(bound ? { projectIdHash: bound } : {}), ...noted };
        if (!nested) recordLocalToolCall({ tool: name, op: knownOp(opForToolCall(name, handlerArgs[0])), ...surfaceMeta, ok, durationMs, mcpClient: hostApp(), error, usage });
      };
      let result: unknown;
      try {
        // Every Summer request the tool makes names it (core/agent-host.ts).
        result = await runWithToolContext(name, "mcp", () => {
          noted = currentToolContext()?.usage ?? {};
          return (handler as (...a: unknown[]) => unknown)(...handlerArgs);
        });
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
        recordUsage(false, durationMs, "exception");
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
      if (isError && !nested) {
        // A cloud tool that needs a sign-in answers with a link the agent can
        // show; the sign-in it starts turns the tool on without a restart.
        result = await withSignInLink(result, toolErrorCode(result, meta?.failureReason ?? meta?.errorClass), signInLinks);
      }
      try {
        recordMcpSession();
        recordUsage(!isError, durationMs, isError ? toolErrorCode(result, meta?.failureReason ?? meta?.errorClass) : null);
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
export { resolveSurface, type SurfaceVersion };

export interface CreateMcpServerOptions {
  /** v4: the operation catalog surface (ops-surface.ts). Default v3 here; startMcpServer resolves v4 by default. */
  surface?: SurfaceVersion;
  /** Where v4 runs cloud operations (the hosted mount's client). */
  cloud?: CloudCaller;
  /** v4 only: list every local 3.x name too (the legacy toolset, legacy-toolset.ts). */
  legacy?: boolean;
  /** One line for this session only, after the instructions (e.g. the installed skills were refreshed). */
  notice?: string | null;
}

const NO_CLOUD: CloudCaller = {
  call: async () => {
    throw new OAuthError("store_login_required", "The hosted Summer server is not connected.", 'Recovery: run "summer login".');
  },
};

export function createMcpServer(
  selection: ToolSelection = FULL_SELECTION,
  options: CreateMcpServerOptions = {}
): {
  server: McpServer;
  getRegisteredToolCount: () => number;
  /** v4: saves generated files on this machine (the mounted hosted tools share it). */
  files: FileSaver;
} {
  const surface = options.surface ?? "v3";
  // A profile without engine tools (assets) gets the no-engine instructions,
  // playbook and task plan, so nothing points the agent at a tool it lacks.
  const engine = !selection.toolsets || selection.toolsets.has("engine");
  const server = new McpServer(
    {
      name: "summer-engine",
      version,
    },
    {
      instructions:
        (surface === "v4"
          ? engine ? OPS_MCP_INSTRUCTIONS : OPS_MCP_ASSETS_INSTRUCTIONS
          : engine ? SUMMER_MCP_INSTRUCTIONS : SUMMER_MCP_ASSETS_INSTRUCTIONS) +
        (options.notice ? ` ${options.notice} Tell the person once.` : ""),
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
  registerProjectTools(server, { engine });
  registerLocalProjectTools(server);
  registerFileTools(server);
  registerAssetTools(server);
  registerGenerateTools(server);
  registerCreatorTools(server);
  registerFeedbackTools(server);
  registerApiTools(server);
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
  registerPlaybookPrompt(server, { engine });
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

  // Without engine tools nothing imports a file into a project, so files save into it by default.
  const files = new FileSaver({ saveByDefault: !engine });
  if (surface === "v4") {
    // Studio page ops go to the running app's own Studio tab when it offers them (no engine launch).
    const studio = (op: string, input: Record<string, unknown>) => runInAppStudio(op, input, () => getClient({ launch: false }));
    applyOpsSurface(server, { engine, cloud: options.cloud ?? NO_CLOUD, legacy: options.legacy === true, files, studio });
  }

  return { server, getRegisteredToolCount: () => getWrappedToolCount() - removed, files };
}

/** What the hosted tools a profile mounts are, for summer_store_tools. */
function hostedToolsLabel(toolsets: ReadonlySet<string>): string | undefined {
  if (toolsets.has("ship")) return "Summer store and publishing tools";
  if (toolsets.has("tools")) return "Tool Factory tools (summer_tool_*) and asset editing tools";
  return undefined;
}

/**
 * First v4 start after an upgrade: bring the installed Summer skills to this
 * version before the legacy decision, which stays on while they are 3.x (and
 * whenever the config asks for it). Not on the v3 surface, whose people chose
 * the 3.x tools, and not under summer doctor's boot probe, whose session would
 * swallow the one notice. A fault here never stops the server.
 */
export function refreshSkillsAfterUpgrade(surface: SurfaceVersion): string | null {
  if (surface !== "v4" || process.env.SUMMER_MCP_DOCTOR === "1") return null;
  try {
    const { refreshed, failures } = refreshInstalledSkills(version);
    if (failures.length > 0) appendMcpLogEvent("mcp:skills_refresh_failed", { version, failures });
    const notice = refreshNotice(refreshed, failures);
    if (notice) {
      appendMcpLogEvent("mcp:skills_refreshed", { version, notice });
      process.stderr.write(`[summer-mcp] ${notice}\n`);
    }
    return notice;
  } catch (error) {
    appendMcpLogEvent("mcp:skills_refresh_failed", { version, ...errorDetails(error) });
    return null;
  }
}

export interface StartMcpServerOptions {
  projectPath?: string;
  instanceId?: string;
  cwd?: string;
  /** --profile / SUMMER_PROFILE (full, engine, assets). */
  profile?: string;
  /** --toolsets / SUMMER_TOOLSETS (comma list; added to the profile). */
  toolsets?: string;
  /** --surface / SUMMER_SURFACE: v4 (default) serves the operation catalog; v3 the 3.x tools. */
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

  const surface = resolveSurface(options.surface);
  const skillsNotice = refreshSkillsAfterUpgrade(surface);
  // `legacy` is not a toolset of its own: it lists the 3.x names on the v4 surface.
  const toolsetList = takeLegacyToolset(options.toolsets ?? process.env.SUMMER_TOOLSETS);
  const legacy = surface === "v4" ? resolveLegacy(toolsetList.requested) : { on: false, reason: "off" as const };
  const selection = resolveToolSelection({ profile: options.profile, toolsets: toolsetList.toolsets });
  if (selection.ignored.length > 0) {
    writeMcpStderr("mcp:unknown_toolsets", {
      ignored: selection.ignored,
      profiles: Object.keys(PROFILES),
      toolsets: TOOLSETS,
    });
  }
  // v4 runs cloud operations through the hosted mount below, once it exists.
  let hostedCall: CloudCaller["call"] | null = null;
  const cloud: CloudCaller = { call: (name, args) => (hostedCall ? hostedCall(name, args) : NO_CLOUD.call(name, args)) };
  const { server, getRegisteredToolCount, files } = createMcpServer(selection, { surface, cloud, legacy: legacy.on, notice: skillsNotice });

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
  // v4 mounts the hosted v4 surface (its direct tools for this profile;
  // summer_search and summer_call stay local and forward to it).
  // The legacy toolset (below) mounts after this mount, and again after a retry of it.
  let legacyHosted: ReturnType<typeof prepareHostedMount> | null = null;
  const hosted = prepareHostedMount(server, surface === "v4" ? { ...defaultHostedMountDependencies, url: v4HostedUrl(selection.profile) } : undefined, {
    ...(process.env.SUMMER_MCP_DOCTOR === "1" ? { firstListWaitMs: 0 } : {}),
    onMounted: () => void legacyHosted?.mount(),
    ...(surface === "v4"
      ? { includeTool: (name: string) => name !== SUMMER_SEARCH && name !== SUMMER_CALL, maxTools: PROFILE_TOOL_LIMIT, local: hostedFileTools(files) }
      : selection.toolsets === null
        ? {}
        : {
            includeTool: (name: string) => selectionIncludes(selection, name, false),
            maxTools: PROFILE_TOOL_LIMIT,
            hostedToolsLabel: hostedToolsLabel(selection.toolsets),
          }),
  });
  hostedCall = hosted.call;
  // The legacy toolset also lists the hosted 3.x names this profile listed in
  // 3.x, from the hosted 3.x surface, each running its 3.x tool, under the
  // same limit as in 3.x. Its sign-in waits for the v4 mount's (a token
  // refresh is not shared), so it starts at boot and the first tools/list
  // still waits for it.
  legacyHosted = legacy.on
    ? prepareHostedMount(
        server,
        {
          ...defaultHostedMountDependencies,
          token: async () => {
            await hosted.mount();
            return defaultHostedMountDependencies.token();
          },
        },
        {
          ...(process.env.SUMMER_MCP_DOCTOR === "1" ? { firstListWaitMs: 0 } : {}),
          ...(selection.toolsets === null ? {} : { includeTool: (name: string) => selectionIncludes(selection, name, false), maxTools: PROFILE_TOOL_LIMIT }),
          describe: legacyHostedDescription,
        }
      )
    : null;

  const transport = new StdioServerTransport();
  await server.connect(transport);
  void hosted.mount();
  void legacyHosted?.mount();
  appendMcpLogEvent("mcp:ready", {
    version,
    pid: process.pid,
    profile: selection.profile,
    surface,
    ...(surface === "v4" ? { legacy: legacy.reason } : {}),
    toolCount: getRegisteredToolCount(),
  });
  process.stderr.write(`[summer-mcp] MCP server running v${version}.\n`);
}
