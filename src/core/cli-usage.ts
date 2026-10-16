/**
 * The usage line for CLI commands (`summer create`, `summer skills install`,
 * `summer engine play`, ...), the CLI's twin of the MCP tool-call line in
 * telemetry.ts: one per command run by a signed-in person, with the command
 * or operation name, success or the error code, duration, the CLI version and
 * the agent app (from the environment). Never arguments, paths or project
 * content. Off with SUMMER_NO_TELEMETRY=1 or DO_NOT_TRACK=1; nothing at all
 * when no account token is on disk or in SUMMER_TOKEN.
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
import { TOOLKIT_VERSION } from "./version.js";

/** `create`, `skills_install`, `engine`: the command path, words joined by `_`. */
const COMMAND = /^[a-z][a-z0-9_]{0,63}$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const BEACON = fileURLToPath(new URL("./cli-usage-beacon.js", import.meta.url));

interface Pending {
  command: string;
  op?: string;
  error?: string;
  startedAt: number;
}

let pending: Pending | null = null;

/** The command path as it is reported: `summer skills install` -> `skills_install`. */
export function cliCommandName(path: readonly string[]): string {
  return path.map((word) => word.toLowerCase().replace(/-/g, "_")).join("_");
}

/** Start timing one command; the line goes out when the process exits. Once per process. */
export function startCliCommand(command: string, op?: string, now = Date.now()): void {
  if (pending || isTelemetryDisabled() || !COMMAND.test(command)) return;
  pending = { command, ...(op && OP_NAME.test(op) ? { op } : {}), startedAt: now };
  process.once("exit", (code) => sendCliUsage(code));
}

/** The command failed with this error code (an operation answer's `error.code`). */
export function noteCliError(code: string): void {
  if (pending && ERROR_CODE.test(code)) pending.error = code;
}

/** The line's body: no arguments, paths or project content can reach it. */
export function cliUsageBody(started: Pending, exitCode: number, now = Date.now(), env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const ok = exitCode === 0 && !started.error;
  const host = resolveAgentHost(env, undefined);
  return {
    client: "summer-cli",
    event: "cli_command",
    command: started.command,
    ...(started.op ? { op: started.op } : {}),
    ok,
    ...(ok ? {} : { error: started.error ?? `exit_${exitCode}` }),
    durationMs: Math.max(0, Math.round(now - started.startedAt)),
    version: TOOLKIT_VERSION,
    ...(host.source === "none" ? {} : { agentHost: host.id }),
  };
}

/** A token on disk or in the environment; the child reads it, the parent only checks it is there. */
function signedIn(): boolean {
  return hasEnvAuthToken() || existsSync(join(getSummerDir(), "auth-token"));
}

export function sendCliUsage(exitCode: number, deps: { spawn: typeof spawn; signedIn: () => boolean } = { spawn, signedIn }): void {
  const started = pending;
  pending = null;
  if (!started || isTelemetryDisabled() || !deps.signedIn()) return;
  try {
    deps
      .spawn(process.execPath, [BEACON, JSON.stringify(cliUsageBody(started, exitCode))], { detached: true, stdio: "ignore", windowsHide: true })
      .unref();
  } catch {
    // never throws: usage is best-effort
  }
}

/** Test-only: forget the command in progress. */
export function _resetCliUsageForTests(): void {
  pending = null;
}
