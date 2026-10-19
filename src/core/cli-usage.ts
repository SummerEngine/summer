/**
 * The usage line for CLI commands that run on this computer (`summer create`,
 * `summer skills install`, `summer engine play`, a local `summer tool`, ...),
 * in the schema of the MCP tool-call line (telemetry.ts) with surface `cli`:
 * one per command run by a signed-in person, with the tool (`summer_call`
 * plus the operation for `summer <area> <action>`, the summer_* tool for
 * `summer tool`, else the command name), success or the error code, duration
 * and the agent app named in the environment, plus the closed-shape fields
 * of usage-fields.ts (project id hash, template, game clients started,
 * engine state) and, on a `summer login` that worked, this machine's install
 * id so the anonymous first-run line joins the account. Never arguments,
 * paths or project content. Off with SUMMER_NO_TELEMETRY=1 or DO_NOT_TRACK=1; nothing
 * at all when no account token is on disk or in SUMMER_TOKEN. A command that
 * ran on Summer's server (a cloud operation, a hosted `summer tool`) sends no
 * line: the server records it from the request's `X-Summer-Client-Surface: cli`.
 *
 * It costs the command nothing: when the process exits, a detached child
 * (cli-usage-beacon.ts) sends the line, so no command waits for Summer's
 * server, prints anything, or loses the line to process.exit().
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isTelemetryDisabled, resolveAgentHost } from "./agent-host.js";
import { hasEnvAuthToken } from "./auth.js";
import { OP_NAME } from "./ops/contract.js";
import { getSummerDir } from "./store.js";
import { processUsageFields } from "./usage-fields.js";

/** What the server accepts as a tool: `summer_call`, `summer_play`, `create`, `skills_install`. */
const TOOL = /^[a-z][a-z0-9_]{0,79}$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const BEACON = fileURLToPath(new URL("./cli-usage-beacon.js", import.meta.url));

interface Pending {
  tool: string;
  op?: string;
  error?: string;
  startedAt: number;
  /** It ran on Summer's server, which records it. */
  hosted?: boolean;
}

let pending: Pending | null = null;

/** The command path as a tool name: `summer skills install` -> `skills_install`. */
export function cliCommandName(path: readonly string[]): string {
  return path.map((word) => word.toLowerCase().replace(/-/g, "_")).join("_");
}

/**
 * Start timing one command; the line goes out when the process exits. Once
 * per process. An operation (`summer <area> <action>`, `whoami`) reports as
 * `summer_call` with that operation; any other command as its own name.
 */
export function startCliCommand(command: string, op?: string, now = Date.now()): void {
  if (pending || isTelemetryDisabled()) return;
  const isOp = op !== undefined && OP_NAME.test(op);
  const tool = isOp ? "summer_call" : command;
  if (!TOOL.test(tool)) return;
  pending = { tool, ...(isOp ? { op } : {}), startedAt: now };
  process.once("exit", (code) => sendCliUsage(code));
}

/** `summer tool <name>` ran this local summer_* tool: report it under its own name. */
export function noteCliTool(tool: string): void {
  if (pending && /^summer_[a-z0-9_]{1,72}$/.test(tool)) {
    pending.tool = tool;
    delete pending.op;
  }
}

/** The command ran on Summer's server, which records it: send no line. */
export function noteCliHosted(): void {
  if (pending) pending.hosted = true;
}

/** The command failed with this error code (an operation answer's `error.code`). */
export function noteCliError(code: string): void {
  if (pending && ERROR_CODE.test(code)) pending.error = code;
}

/** The line's body: no arguments, paths or project content can reach it. */
export function cliUsageBody(
  started: Pending,
  exitCode: number,
  now = Date.now(),
  env: NodeJS.ProcessEnv = process.env
): Record<string, unknown> {
  const ok = exitCode === 0 && !started.error;
  return {
    client: "summer-cli",
    event: "mcp_tool_call",
    surface: "cli",
    tool: started.tool,
    ...(started.op ? { op: started.op } : {}),
    ok,
    ...(ok ? {} : { error: started.error ?? `exit_${exitCode}` }),
    durationMs: Math.max(0, Math.round(now - started.startedAt)),
    mcpClient: resolveAgentHost(env, undefined).id,
    surfaceVersion: "v4",
    // The child (cli-usage-beacon.ts) checks these again and adds the template and engine state.
    ...processUsageFields(),
  };
}

/** A token on disk or in the environment; the child reads it, the parent only checks it is there. */
function signedIn(): boolean {
  return hasEnvAuthToken() || existsSync(join(getSummerDir(), "auth-token"));
}

export function sendCliUsage(exitCode: number, deps: { spawn?: typeof spawn; signedIn?: () => boolean } = {}): void {
  const started = pending;
  pending = null;
  if (!started || started.hosted || isTelemetryDisabled() || !(deps.signedIn ?? signedIn)()) return;
  try {
    (deps.spawn ?? spawn)(process.execPath, [BEACON, JSON.stringify(cliUsageBody(started, exitCode))], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      // A debugger flag (--inspect-brk) would make the child wait forever.
      env: { ...process.env, NODE_OPTIONS: (process.env.NODE_OPTIONS ?? "").replace(/--inspect\S*/g, "").trim() },
    }).unref();
  } catch {
    // never throws: usage is best-effort
  }
}

/** Test-only: forget the command in progress. */
export function _resetCliUsageForTests(): void {
  pending = null;
}
