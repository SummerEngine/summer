/**
 * Engine substrate for the outcome evals: one fresh editor per task.
 *
 * boot    -> spawn the editor on a throwaway project copy (headless, or under
 *            xvfb-run with Mesa llvmpipe — the recipe the engine E2E driver and
 *            CI use), --summer-no-publish so it never steals the machine-global
 *            ~/.summer/api-port binding from a developer's own editor.
 * ready   -> discover the instance through the SAME registry code the toolkit's
 *            `summer mcp --project` uses (src/core/engine.ts
 *            resolveEngineConnection: ~/.summer/instances/*.json, resourceRoot
 *            match, live pid, fresh heartbeat, health check) — which is also
 *            exactly what the engine repo's run_e2e.sh discover_instance does.
 * ops     -> raw op envelopes through the toolkit's EngineApiClient (identity
 *            bound: every request carries instanceId + projectIdHash).
 * stop    -> TERM the editor pid, never the xvfb-run launcher first (a TERM'd
 *            xvfb-run orphans its X server), escalate to KILL.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { EngineApiClient } from "../../../dist/core/api-client.js";
import { resolveEngineConnection, type EngineConnection } from "../../../dist/core/engine.js";
import type { ToolDispatchContext } from "../../../dist/core/capabilities/tool-dispatch.js";
import { processIsAlive } from "../../../dist/core/util/process.js";

export type RenderMode = "headless" | "xvfb" | "native";

export interface BootOptions {
  binary: string;
  projectDir: string;
  render: RenderMode;
  /** Editor stdout/stderr land here (editor.log). */
  logPath: string;
  bootTimeoutMs?: number;
}

export interface EditorHandle {
  connection: EngineConnection;
  client: EngineApiClient;
  /** Engine process id (from the registry entry / health). */
  enginePid: number;
  /** What we forked: xvfb-run or the editor itself. */
  launcherPid: number;
  render: RenderMode;
  /** Raw /api/health at ready time. */
  health: Record<string, unknown>;
  stop(): Promise<void>;
}

const DEFAULT_BOOT_TIMEOUT_MS = 180_000;

/** The editor binary: SUMMER_EDITOR_BIN (the engine E2E driver's variable)
 *  first, then the toolkit's SUMMER_ENGINE_BINARY. Returns null when neither
 *  names an executable — the caller refuses instead of guessing. */
export function findEditorBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const key of ["SUMMER_EDITOR_BIN", "SUMMER_ENGINE_BINARY"]) {
    const value = env[key]?.trim();
    if (value && existsSync(value) && statSync(value).isFile()) return value;
  }
  return null;
}

export function hasXvfb(): boolean {
  const probe = spawnSync("xvfb-run", ["--help"], { stdio: "ignore" });
  return !probe.error;
}

/** Pick the render mode: an explicit request wins; otherwise xvfb when
 *  available (every MVP-0 task boots a game or renders), else headless. */
export function defaultRenderMode(explicit?: string): RenderMode {
  if (explicit === "headless" || explicit === "xvfb" || explicit === "native") return explicit;
  if (explicit) throw new Error(`unknown render mode "${explicit}" (headless | xvfb | native)`);
  return hasXvfb() ? "xvfb" : "headless";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function childrenOf(pid: number): number[] {
  const out = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
  if (out.error || out.status !== 0) return [];
  return out.stdout
    .split(/\s+/)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function launchArgs(options: BootOptions): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  // --audio-driver Dummy: no sound device on CI runners/containers.
  // --disable-crash-handler: an agent-driven run should exit, not hang on a
  // crash dialog (headless-scripting skill).
  const common = [
    "--editor",
    "--path",
    options.projectDir,
    "--audio-driver",
    "Dummy",
    "--summer-no-publish",
    "--disable-crash-handler",
  ];
  switch (options.render) {
    case "headless":
      return { command: options.binary, args: ["--headless", ...common], env: process.env };
    case "xvfb":
      // Software OpenGL 3 via Mesa llvmpipe; --rendering-driver opengl3 so the
      // editor does not first try (and fail) Vulkan on a display with no ICD.
      return {
        command: "xvfb-run",
        args: ["-a", "-s", "-screen 0 1280x720x24", options.binary, ...common, "--rendering-driver", "opengl3"],
        env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: "1", GALLIUM_DRIVER: "llvmpipe" },
      };
    case "native":
      return { command: options.binary, args: common, env: process.env };
  }
}

export async function bootEditor(options: BootOptions): Promise<EditorHandle> {
  if (!existsSync(options.projectDir + "/project.godot")) {
    throw new Error(`no project.godot in ${options.projectDir}`);
  }
  mkdirSync(dirname(options.logPath), { recursive: true });
  const logFd = openSync(options.logPath, "a");
  const { command, args, env } = launchArgs(options);
  let child: ChildProcess;
  try {
    child = spawn(command, args, { env, stdio: ["ignore", logFd, logFd], detached: false });
  } finally {
    closeSync(logFd);
  }
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  child.on("error", () => {
    exited = true;
  });
  const launcherPid = child.pid ?? 0;
  const deadline = Date.now() + (options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS);

  let connection: EngineConnection | null = null;
  while (!connection) {
    if (exited) {
      throw new Error(
        `editor exited before it became reachable; tail of ${options.logPath}:\n${tailFile(options.logPath)}`
      );
    }
    if (Date.now() > deadline) {
      await terminate(launcherPid, undefined, child);
      throw new Error(
        `editor not reachable after ${Math.round((options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS) / 1000)}s (project ${options.projectDir}); tail of ${options.logPath}:\n${tailFile(options.logPath)}`
      );
    }
    try {
      connection = await resolveEngineConnection({ projectPath: options.projectDir });
    } catch {
      await sleep(1000);
    }
  }

  const client = await EngineApiClient.connect({ projectPath: options.projectDir });
  const health = (await client.health()) as Record<string, unknown>;
  const enginePid =
    connection.instance?.pid ?? (typeof health.pid === "number" ? (health.pid as number) : launcherPid);

  return {
    connection,
    client,
    enginePid,
    launcherPid,
    render: options.render,
    health,
    stop: () => terminate(launcherPid, enginePid, child),
  };
}

async function terminate(launcherPid: number, enginePid: number | undefined, child: ChildProcess): Promise<void> {
  const children = childrenOf(launcherPid);
  const target = enginePid && processIsAlive(enginePid) ? enginePid : launcherPid;
  try {
    process.kill(target, "SIGTERM");
  } catch {
    // already gone
  }
  for (let i = 0; i < 40 && processIsAlive(launcherPid); i++) await sleep(500);
  if (processIsAlive(launcherPid)) {
    for (const pid of [enginePid, ...children, launcherPid]) {
      if (!pid) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
    for (let i = 0; i < 10 && processIsAlive(launcherPid); i++) await sleep(200);
  }
  child.unref();
}

export function tailFile(path: string, lines = 40): string {
  try {
    const text = readFileSync(path, "utf8");
    return text.split("\n").slice(-lines).join("\n");
  } catch {
    return "(no log)";
  }
}

// ---------------------------------------------------------------------------
// Op helpers
// ---------------------------------------------------------------------------

export type JsonRecord = Record<string, unknown>;

/** The per-op result dicts inside an /api/ops envelope (async apply dict or
 *  legacy body). Empty when the envelope carries none. */
export function opResults(envelope: unknown): JsonRecord[] {
  if (!envelope || typeof envelope !== "object") return [];
  const env = envelope as JsonRecord;
  const direct = env.results;
  if (Array.isArray(direct)) return direct.filter((r) => r && typeof r === "object") as JsonRecord[];
  const nested = env.result;
  if (nested && typeof nested === "object" && Array.isArray((nested as JsonRecord).results)) {
    return ((nested as JsonRecord).results as unknown[]).filter((r) => r && typeof r === "object") as JsonRecord[];
  }
  return [];
}

export interface OpOutcome {
  ok: boolean;
  /** The single op's result dict (first results[] entry), or the envelope
   *  itself when the engine returned none. */
  result: JsonRecord;
  envelope: JsonRecord;
  failure_reason?: string;
  error?: string;
}

function readFailure(record: JsonRecord): { failure_reason?: string; error?: string } {
  const reason =
    typeof record.failure_reason === "string"
      ? record.failure_reason
      : typeof record.failureReason === "string"
        ? record.failureReason
        : undefined;
  const error = typeof record.error === "string" ? record.error : undefined;
  return { ...(reason ? { failure_reason: reason } : {}), ...(error ? { error } : {}) };
}

const SUCCESS_TERMINAL = new Set(["applied", "no_op"]);

/** Send ONE op through the identity-bound client and classify the outcome
 *  (envelope terminalState + the op's own ok flag). Never throws on an engine
 *  failure — the caller decides whether missing evidence fails a predicate. */
export async function runOp(
  client: EngineApiClient,
  op: JsonRecord,
  timeoutMs = 120_000,
  options?: JsonRecord
): Promise<OpOutcome> {
  let envelope: JsonRecord;
  try {
    envelope = (await client.executeOps([op], options, timeoutMs)) as JsonRecord;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, result: {}, envelope: { error: message }, error: message, failure_reason: "transport_error" };
  }
  const results = opResults(envelope);
  const result = results[0] ?? envelope;
  const terminal = typeof envelope.terminalState === "string" ? envelope.terminalState : undefined;
  const terminalOk = terminal === undefined || SUCCESS_TERMINAL.has(terminal);
  const ok = terminalOk && result.ok !== false && envelope.ok !== false && envelope.status !== "error";
  const failure = ok ? {} : { ...readFailure(envelope), ...readFailure(result) };
  if (!ok && !failure.failure_reason && terminal && !terminalOk) failure.failure_reason = terminal;
  return { ok, result, envelope, ...failure };
}

/** A dispatch context for the toolkit's tool table that binds to the eval
 *  editor by PROJECT PATH (registry match on resourceRoot), the way
 *  `summer mcp --project <dir>` binds — never through the machine-global
 *  ~/.summer/api-port pointer, which the eval editor does not publish. */
export function createProjectDispatchContext(projectDir: string): ToolDispatchContext {
  let cached: EngineApiClient | null = null;
  return {
    async engine() {
      if (cached) return cached;
      cached = await EngineApiClient.connect({ projectPath: projectDir });
      return cached;
    },
  };
}
