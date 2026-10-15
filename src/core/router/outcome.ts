import { resolveAgentHost } from "../agent-host.js";
import { RouterApiError } from "./api.js";
import { errorDocsUrl, type RouterRegistry, registryError } from "./registry.js";

/**
 * One result shape for every `summer router` command, for people and agents:
 *
 * - Agent mode (--json, stdout is not a terminal, or an agent environment
 *   such as Claude Code or Codex): stdout holds only the result as one JSON
 *   object; messages go to stderr; nothing prompts.
 * - Exit codes: 0 success, 1 the command ran and failed (validation, API,
 *   expectation), 2 usage error (bad flags, no project, no game id).
 * - A failure always carries error.code (a stable tag), error.message and
 *   error.fix; a human step carries one URL (studio_url or browser_url).
 */

export type ExitCode = 0 | 1 | 2;

export interface RouterOutcome {
  exitCode: ExitCode;
  result: Record<string, unknown>;
  /** Human-readable lines for a terminal. */
  lines: string[];
}

export interface RouterFailure {
  code: string;
  message: string;
  fix: string;
  docs_url?: string;
  studio_url?: string;
  request_id?: string;
  details?: unknown;
}

export function success(result: Record<string, unknown>, lines: string[]): RouterOutcome {
  return { exitCode: 0, result: { ok: true, ...result }, lines };
}

export function failure(error: RouterFailure, options: { exit?: 1 | 2; result?: Record<string, unknown>; lines?: string[] } = {}): RouterOutcome {
  const clean = Object.fromEntries(Object.entries(error).filter(([, value]) => value !== undefined)) as unknown as RouterFailure;
  const lines = options.lines ?? [];
  return {
    exitCode: options.exit ?? 1,
    result: { ok: false, ...(options.result ?? {}), error: clean },
    lines: [...lines, `Error (${error.code}): ${error.message}`, `Fix: ${error.fix}`, ...(error.studio_url ? [`Open: ${error.studio_url}`] : [])],
  };
}

export function usageError(code: string, message: string, fix: string): RouterOutcome {
  return failure({ code, message, fix }, { exit: 2 });
}

/** True when output must be machine-readable and prompt-free. */
export function isAgentMode(json: boolean | undefined, stdoutIsTTY: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  if (json) return true;
  if (!stdoutIsTTY) return true;
  if (env.CI && env.CI !== "0" && env.CI.toLowerCase() !== "false") return true;
  const host = resolveAgentHost(env, undefined);
  return host.source === "env" || host.source === "override";
}

export interface RouterIo {
  out(text: string): void;
  err(text: string): void;
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
}

export function emit(io: RouterIo, outcome: RouterOutcome, json: boolean | undefined): ExitCode {
  if (isAgentMode(json, io.isTTY, io.env)) {
    io.out(JSON.stringify(outcome.result, null, 2));
    if (outcome.exitCode !== 0) for (const line of outcome.lines.slice(-3)) io.err(line);
  } else {
    const write = outcome.exitCode === 0 ? io.out : io.err;
    for (const line of outcome.lines) write(line);
  }
  return outcome.exitCode;
}

/** The fix for codes the management API and the creator store proxy return. */
const API_FIXES: Record<string, string> = {
  not_signed_in: 'Run "summer login" and approve in the browser, then retry.',
  owner_approval_required: "Only the game's owner can change this. Ask them to open studio_url and save it there.",
  agent_access_not_enabled: "Confirm the email address of your Summer account, then retry.",
  version_conflict: 'The character changed on Summer. Run "summer router pull", merge your edits, then push again.',
  invalid_input: "Fix the field the message names, then retry.",
  unavailable: "Summer Router is not on in this Summer environment yet. Retry later.",
  store_unavailable: "Summer is not reachable right now. Retry in a few minutes.",
  rate_limited: "Wait a little, then retry.",
  network_error: "Check the network and retry.",
};

export interface ApiFailureContext {
  registry?: RouterRegistry;
  studioUrl?: string;
  /** What the command was doing, for 404s ("game", "character", "route"). */
  notFound?: string;
}

export function apiFailure(error: unknown, context: ApiFailureContext = {}): RouterOutcome {
  if (!(error instanceof RouterApiError)) {
    return failure({ code: "internal_error", message: error instanceof Error ? error.message : String(error), fix: "Retry. If it repeats, run summer router doctor --json and report the output." });
  }
  const tag = error.code === "owner_approval_required" ? "owner_action_required" : error.code;
  const fromRegistry = context.registry ? registryError(context.registry, error.code) : undefined;
  const notFound = error.status === 404 ? context.notFound : undefined;
  const fix =
    error.extra.fix ??
    fromRegistry?.fix ??
    API_FIXES[error.code] ??
    (notFound ? notFound : "Read the message, fix the input, and retry.");
  return failure(
    {
      code: tag,
      message: error.message,
      fix,
      docs_url: error.extra.docsUrl ?? (fromRegistry ? errorDocsUrl(error.code) : undefined),
      studio_url:
        error.extra.studioUrl ??
        fromRegistry?.studio_url ??
        (error.code === "owner_approval_required" || error.code === "ai_disabled" ? context.studioUrl : undefined),
      request_id: error.extra.requestId,
      details: error.extra.resetsAt ? { scope: error.extra.scope, resets_at: error.extra.resetsAt } : undefined,
    },
    { result: error.code === "not_signed_in" ? { next_step: "summer login" } : {} }
  );
}
