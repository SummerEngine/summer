#!/usr/bin/env node
/**
 * Blind tool-canary gateway — CLI (stdio MCP proxy in front of the real
 * `summer mcp` server; see README.md).
 *
 * Origin: SummerEngine/SummerEngine branch codex/world-tool-balanced-suite-ready,
 * tools/summer-cli/src/dev/canary-gateway.ts (Marcus / frozaken). Ported into
 * evals/canary/ 2026-09-03. Edits: `.ts` import specifiers (Node type
 * stripping), the host is launched as `.ts`, and the default --server-entry is
 * this checkout's dist/bin/summer.js.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CANARY_TOOL_NAMES,
  CallBudget,
  type CatalogPolicy,
  GatewayError,
  type McpToolRecord,
  assertNoCanaryRawOpEscape,
  assertToolVisible,
  canonicalJson,
  catalogSnapshot,
  filterCatalog,
  isCanaryToolName,
  jsonBytes,
  sanitizeMediaBlocks,
  sha256,
} from "./canary-gateway-core.ts";

interface GatewayOptions {
  projectPath: string;
  artifactsPath: string;
  policy: CatalogPolicy;
  maxCalls: number;
  timeoutMs: number;
  serverEntry: string;
  serverHostEntry: string;
  command: "list" | "describe" | "call";
  toolName?: string;
  args?: Record<string, unknown>;
}

interface BudgetState {
  version: 1;
  maxCalls: number;
  usedCalls: number;
}

interface ConnectedGateway {
  client: Client;
  transport: StdioClientTransport;
  visibleTools: McpToolRecord[];
  catalogHash: string;
  startupLatencyMs: number;
  connectLatencyMs: number;
  listToolsLatencyMs: number;
  stderrTail: () => string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_CALLS_LIMIT = 1_000;
const STDERR_TAIL_BYTES = 4_096;

export async function runCanaryGateway(argv: readonly string[]): Promise<unknown> {
  const options = parseOptions(argv);
  mkdirSync(options.artifactsPath, { recursive: true, mode: 0o700 });

  let connected: ConnectedGateway | undefined;
  try {
    connected = await connectGateway(options);
    persistTrialFiles(options, connected.visibleTools, connected.catalogHash);
    appendEvent(options.artifactsPath, {
      event: "startup",
      projectPath: options.projectPath,
      policy: options.policy,
      catalogHash: connected.catalogHash,
      visibleToolCount: connected.visibleTools.length,
      startupLatencyMs: connected.startupLatencyMs,
      connectLatencyMs: connected.connectLatencyMs,
      listToolsLatencyMs: connected.listToolsLatencyMs,
      server: connected.client.getServerVersion(),
      serverStderrTail: connected.stderrTail(),
    });

    if (options.command === "list") {
      return {
        ok: true,
        catalogHash: connected.catalogHash,
        toolCount: connected.visibleTools.length,
        tools: connected.visibleTools.map((tool) => tool.name),
      };
    }

    const toolName = options.toolName as string;
    if (options.command === "describe") {
      return {
        ok: true,
        catalogHash: connected.catalogHash,
        tool: assertToolVisible(toolName, connected.visibleTools),
      };
    }

    return await callTool(options, connected, toolName, options.args ?? {});
  } catch (error) {
    appendEvent(options.artifactsPath, {
      event: connected ? "gateway_error" : "startup_error",
      command: options.command,
      tool: options.toolName,
      error: errorDetails(error),
      ...(connected
        ? {
            catalogHash: connected.catalogHash,
            startupLatencyMs: connected.startupLatencyMs,
            serverStderrTail: connected.stderrTail(),
          }
        : {}),
    });
    throw error;
  } finally {
    if (connected) {
      await connected.client.close().catch(() => undefined);
      await connected.transport.close().catch(() => undefined);
    }
  }
}

async function connectGateway(options: GatewayOptions): Promise<ConnectedGateway> {
  const client = new Client({ name: "summer-canary-gateway", version: "1.0.0" });
  const serverStderrPath = join(options.artifactsPath, "mcp-server.stderr.log");
  const serverStderrFd = openSync(serverStderrPath, "a", 0o600);
  let serverStderrFdOpen = true;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      options.serverHostEntry,
      options.serverEntry,
      options.projectPath,
    ],
    cwd: options.projectPath,
    env: inheritedEnv({ SUMMER_ENGINE_PROJECT: options.projectPath }),
    // A real file descriptor keeps the server's diagnostics out of stdout and
    // avoids buffering an unbounded stderr pipe during image-heavy trials.
    stderr: serverStderrFd,
  });
  const closeServerStderrFd = (): void => {
    if (!serverStderrFdOpen) return;
    serverStderrFdOpen = false;
    closeSync(serverStderrFd);
  };
  const stderrTail = (): string => {
    try {
      return readFileSync(serverStderrPath, "utf8").slice(-STDERR_TAIL_BYTES).trim();
    } catch {
      return "";
    }
  };

  const startupStarted = performance.now();
  try {
    await client.connect(transport, { timeout: options.timeoutMs });
    const connectLatencyMs = elapsedMs(startupStarted);
    const listStarted = performance.now();
    const upstreamTools = await listAllTools(client, options.timeoutMs);
    const listToolsLatencyMs = elapsedMs(listStarted);
    const visibleTools = filterCatalog(upstreamTools, options.policy);
    const snapshot = catalogSnapshot(visibleTools);
    closeServerStderrFd();
    return {
      client,
      transport,
      visibleTools,
      catalogHash: snapshot.sha256,
      startupLatencyMs: elapsedMs(startupStarted),
      connectLatencyMs,
      listToolsLatencyMs,
      stderrTail,
    };
  } catch (error) {
    closeServerStderrFd();
    const stderr = stderrTail();
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    throw new GatewayError(
      "mcp_startup_failed",
      `Actual Summer MCP startup/list failed: ${errorMessage(error)}` +
        (stderr ? `; server stderr: ${stderr.slice(-1_000)}` : "")
    );
  }
}

async function listAllTools(client: Client, timeoutMs: number): Promise<McpToolRecord[]> {
  const tools: McpToolRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs });
    tools.push(...(page.tools as McpToolRecord[]));
    cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
  } while (cursor);
  return tools;
}

async function callTool(
  options: GatewayOptions,
  connected: ConnectedGateway,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const reserved = reserveBudgetCall(options.artifactsPath, options.maxCalls);
  const budget = reserved.budget;
  const callIndex = reserved.callIndex;
  const gateStarted = performance.now();
  let gateLatencyMs: number | undefined;
  let mcpCallStarted: number | undefined;

  try {
    assertToolVisible(toolName, connected.visibleTools);
    assertNoCanaryRawOpEscape(toolName, args);
    gateLatencyMs = elapsedMs(gateStarted);
    mcpCallStarted = performance.now();
    const result = await connected.client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: options.timeoutMs }
    );
    const mcpCallLatencyMs = elapsedMs(mcpCallStarted);
    const resultBytes = jsonBytes(result);
    const sanitized = sanitizeMediaBlocks(result, (media) => {
      const mediaDir = join(options.artifactsPath, "media");
      mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
      const extension = mediaExtension(media.type, media.mimeType);
      const filePath = join(
        mediaDir,
        `call-${String(callIndex).padStart(3, "0")}-block-${String(media.blockIndex).padStart(2, "0")}${extension}`
      );
      writeFileSync(filePath, media.bytes, { flag: "wx", mode: 0o600 });
      return { filePath };
    });
    const sanitizedResultBytes = jsonBytes(sanitized.result);
    appendEvent(options.artifactsPath, {
      event: "mcp_call",
      callIndex,
      maxCalls: options.maxCalls,
      remainingCalls: budget.remainingCalls,
      tool: toolName,
      inputBytes: jsonBytes(args),
      inputSha256: sha256(canonicalJson(args)),
      startupLatencyMs: connected.startupLatencyMs,
      gateLatencyMs,
      mcpCallLatencyMs,
      resultBytes,
      sanitizedResultBytes,
      toolReportedError:
        isRecord(result) && result.isError === true,
      mediaFiles: sanitized.mediaFiles,
    });

    return {
      ok: true,
      catalogHash: connected.catalogHash,
      callIndex,
      maxCalls: options.maxCalls,
      remainingCalls: budget.remainingCalls,
      timing: {
        startupLatencyMs: connected.startupLatencyMs,
        connectLatencyMs: connected.connectLatencyMs,
        listToolsLatencyMs: connected.listToolsLatencyMs,
        mcpCallLatencyMs,
      },
      resultBytes,
      result: sanitized.result,
    };
  } catch (error) {
    appendEvent(options.artifactsPath, {
      event: "mcp_call_error",
      callIndex,
      maxCalls: options.maxCalls,
      remainingCalls: budget.remainingCalls,
      tool: toolName,
      inputBytes: jsonBytes(args),
      inputSha256: sha256(canonicalJson(args)),
      startupLatencyMs: connected.startupLatencyMs,
      gateLatencyMs: gateLatencyMs ?? elapsedMs(gateStarted),
      forwardedToMcp: mcpCallStarted !== undefined,
      mcpCallLatencyMs:
        mcpCallStarted === undefined ? undefined : elapsedMs(mcpCallStarted),
      error: errorDetails(error),
    });
    throw error;
  }
}

function persistTrialFiles(
  options: GatewayOptions,
  visibleTools: readonly McpToolRecord[],
  catalogHash: string
): void {
  const snapshot = catalogSnapshot(visibleTools);
  if (snapshot.sha256 !== catalogHash) {
    throw new GatewayError("catalog_hash_mismatch", "Catalog changed during snapshot creation.");
  }
  assertOrWriteExact(join(options.artifactsPath, "catalog.json"), snapshot.canonical);
  assertOrWriteExact(join(options.artifactsPath, "catalog.sha256"), snapshot.sha256);
  assertOrWriteExact(
    join(options.artifactsPath, "trial.json"),
    canonicalJson({
      version: 1,
      projectPath: options.projectPath,
      serverEntry: options.serverEntry,
      serverHostEntry: options.serverHostEntry,
      policy: options.policy,
      canaryToolNames: CANARY_TOOL_NAMES,
      maxCalls: options.maxCalls,
      timeoutMs: options.timeoutMs,
      catalogHash,
    })
  );
}

function loadBudget(artifactsPath: string, maxCalls: number): CallBudget {
  const path = join(artifactsPath, "budget.json");
  if (!existsSync(path)) return new CallBudget(maxCalls);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new GatewayError(
      "invalid_call_budget_state",
      `Could not read the persisted call budget: ${errorMessage(error)}`
    );
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    parsed.maxCalls !== maxCalls ||
    typeof parsed.usedCalls !== "number"
  ) {
    throw new GatewayError(
      "invalid_call_budget_state",
      "Persisted budget does not match this trial's fixed maxCalls."
    );
  }
  return new CallBudget(maxCalls, parsed.usedCalls);
}

function reserveBudgetCall(
  artifactsPath: string,
  maxCalls: number
): { budget: CallBudget; callIndex: number } {
  const lockPath = join(artifactsPath, "budget.lock");
  let lockFd: number;
  try {
    lockFd = openSync(lockPath, "wx", 0o600);
  } catch {
    throw new GatewayError(
      "call_budget_locked",
      "Another gateway process is updating this trial's call budget."
    );
  }

  try {
    closeSync(lockFd);
    const budget = loadBudget(artifactsPath, maxCalls);
    const callIndex = budget.consume();
    const state: BudgetState = {
      version: 1,
      maxCalls: budget.maxCalls,
      usedCalls: budget.usedCalls,
    };
    atomicWrite(join(artifactsPath, "budget.json"), canonicalJson(state));
    return { budget, callIndex };
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // A failed cleanup keeps the budget fail-closed on later calls.
    }
  }
}

function appendEvent(artifactsPath: string, details: Record<string, unknown>): void {
  try {
    mkdirSync(artifactsPath, { recursive: true, mode: 0o700 });
    appendFileSync(
      join(artifactsPath, "calls.jsonl"),
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...details })}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  } catch {
    // Evidence logging cannot replace the primary gateway error.
  }
}

function assertOrWriteExact(path: string, expected: string): void {
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== expected) {
      throw new GatewayError(
        "trial_artifact_mismatch",
        `${path} does not match this invocation; use a fresh artifacts directory.`
      );
    }
    return;
  }
  writeFileSync(path, expected, { flag: "wx", encoding: "utf8", mode: 0o600 });
}

function atomicWrite(path: string, value: string): void {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, value, { flag: "wx", encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
}

function parseOptions(argv: readonly string[]): GatewayOptions {
  const values = new Map<string, string>();
  const positional: string[] = [];
  const valuedOptions = new Set([
    "--project",
    "--artifacts",
    "--policy",
    "--canary",
    "--max-calls",
    "--timeout-ms",
    "--server-entry",
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      throw new GatewayError("help", usage());
    }
    if (valuedOptions.has(token)) {
      const value = argv[index + 1];
      if (!value) throw new GatewayError("invalid_arguments", `${token} requires a value.`);
      if (values.has(token)) {
        throw new GatewayError("invalid_arguments", `${token} may only be provided once.`);
      }
      values.set(token, value);
      index += 1;
      continue;
    }
    if (token.startsWith("--")) {
      throw new GatewayError("invalid_arguments", `Unknown option ${token}.`);
    }
    positional.push(token);
  }

  const projectValue = requiredOption(values, "--project");
  const projectPath = canonicalExistingPath(projectValue, "project");
  if (!statSync(projectPath).isDirectory() || !existsSync(join(projectPath, "project.godot"))) {
    throw new GatewayError(
      "invalid_project",
      `Project must be a directory containing project.godot: ${projectPath}`
    );
  }

  const artifactsValue = requiredOption(values, "--artifacts");
  const artifactsPath = canonicalDirectory(artifactsValue);
  const policyMode = requiredOption(values, "--policy");
  const canary = values.get("--canary");
  let policy: CatalogPolicy;
  if (policyMode === "control") {
    if (canary !== undefined) {
      throw new GatewayError("invalid_policy", "Control policy must not specify --canary.");
    }
    policy = { mode: "control" };
  } else if (policyMode === "treatment") {
    if (!canary || !isCanaryToolName(canary)) {
      throw new GatewayError(
        "invalid_policy",
        `Treatment policy requires --canary with one of: ${CANARY_TOOL_NAMES.join(", ")}.`
      );
    }
    policy = { mode: "treatment", canary };
  } else {
    throw new GatewayError("invalid_policy", "--policy must be control or treatment.");
  }

  const maxCalls = positiveInteger(
    requiredOption(values, "--max-calls"),
    "--max-calls",
    MAX_CALLS_LIMIT
  );
  const timeoutMs = positiveInteger(
    values.get("--timeout-ms") ?? String(DEFAULT_TIMEOUT_MS),
    "--timeout-ms",
    MAX_TIMEOUT_MS
  );
  // evals/canary/ -> <repo>/dist/bin/summer.js (run `npm run build` first).
  const defaultServerEntry = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../dist/bin/summer.js"
  );
  const serverEntry = canonicalExistingPath(
    values.get("--server-entry") ?? defaultServerEntry,
    "built Summer CLI server entry"
  );
  if (!statSync(serverEntry).isFile() || extname(serverEntry) !== ".js") {
    throw new GatewayError(
      "invalid_server_entry",
      `Built Summer CLI server entry must be a JavaScript file: ${serverEntry}`
    );
  }
  // The host runs unbuilt: Node (>= 22.18) strips its types like the rest of
  // evals/ and scripts/.
  const serverHostEntry = canonicalExistingPath(
    resolve(dirname(fileURLToPath(import.meta.url)), "canary-mcp-server-host.ts"),
    "canary MCP server host"
  );

  const command = positional[0];
  if (command !== "list" && command !== "describe" && command !== "call") {
    throw new GatewayError("invalid_arguments", usage());
  }
  if (command === "list" && positional.length !== 1) {
    throw new GatewayError("invalid_arguments", "list does not accept positional arguments.");
  }
  if (command === "describe" && positional.length !== 2) {
    throw new GatewayError("invalid_arguments", "describe requires exactly one tool name.");
  }
  if (command === "call" && positional.length !== 3) {
    throw new GatewayError("invalid_arguments", "call requires a tool name and one JSON object.");
  }

  return {
    projectPath,
    artifactsPath,
    policy,
    maxCalls,
    timeoutMs,
    serverEntry,
    serverHostEntry,
    command,
    toolName: positional[1],
    args: command === "call" ? parseCallArgs(positional[2]) : undefined,
  };
}

function parseCallArgs(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new GatewayError("invalid_call_json", `Call JSON is invalid: ${errorMessage(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new GatewayError("invalid_call_json", "Call JSON must be an object.");
  }
  return parsed;
}

function requiredOption(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new GatewayError("invalid_arguments", `${name} is required.`);
  return value;
}

function positiveInteger(value: string, name: string, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new GatewayError(
      "invalid_arguments",
      `${name} must be an integer between 1 and ${maximum}.`
    );
  }
  return parsed;
}

function canonicalExistingPath(value: string, label: string): string {
  const absolute = resolve(value);
  try {
    return realpathSync(absolute);
  } catch {
    throw new GatewayError("path_not_found", `${label} path does not exist: ${absolute}`);
  }
}

function canonicalDirectory(value: string): string {
  const absolute = resolve(value);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const canonical = realpathSync(absolute);
  if (!statSync(canonical).isDirectory()) {
    throw new GatewayError("invalid_artifacts_path", `Artifacts path is not a directory: ${canonical}`);
  }
  return canonical;
}

function inheritedEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

function mediaExtension(type: "image" | "audio", mimeType: string): string {
  const extensions: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/flac": ".flac",
  };
  return extensions[mimeType.toLowerCase()] ?? (type === "image" ? ".img" : ".audio");
}

function elapsedMs(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorDetails(error: unknown): { code: string; message: string } {
  return {
    code: error instanceof GatewayError ? error.code : "gateway_failure",
    message: errorMessage(error).slice(0, 2_000),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function usage(): string {
  return [
    "Usage:",
    "  canary-gateway --project <path> --artifacts <path> --policy control --max-calls <n> list",
    "  canary-gateway --project <path> --artifacts <path> --policy treatment --canary <tool> --max-calls <n> describe <tool>",
    "  canary-gateway --project <path> --artifacts <path> --policy treatment --canary <tool> --max-calls <n> call <tool> '<JSON object>'",
  ].join("\n");
}

async function main(): Promise<void> {
  try {
    const result = await runCanaryGateway(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: errorDetails(error) })}\n`);
    process.exitCode = error instanceof GatewayError && error.code === "help" ? 0 : 1;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  void main();
}
