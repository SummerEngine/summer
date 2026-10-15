/**
 * Stable codes for the failures any Summer tool can hit before it does its
 * job: the engine is not running, the person is not signed in, the account
 * has no credits left, or the network failed. Agents branch on `code` and
 * follow `recovery` (one next step); the older fields each tool returned
 * (`error`, `message`, `hint`) stay next to them so 3.x callers keep working.
 *
 * The store sign-in keeps its own code, `store_login_required`
 * (core/oauth.ts): it is a second grant with its own recovery
 * (`summer login --store`).
 */

export type SummerErrorCode = "ENGINE_NOT_RUNNING" | "AUTH_REQUIRED" | "NO_CREDITS" | "NETWORK_ERROR";

export const SIGN_IN_COMMAND = "npx -y summer-engine@latest login";
export const CREDITS_URL = "https://summerengine.com/studio/credits";

/** The one sentence every tool uses when there is no Summer account token. */
export const NOT_SIGNED_IN = "Not signed in to Summer.";
/** A token the server refused (expired, revoked): plain `login` would say
 *  "Already logged in", so the step forces a new sign-in. */
export const SIGN_IN_AGAIN_RECOVERY = `Ask the person to sign in again: ${SIGN_IN_COMMAND} --force`;

/** The one next step per code, as the MCP face words it (the agent may not
 *  have `summer` on PATH, so commands go through npx). */
export const RECOVERY: Record<SummerErrorCode, string> = {
  ENGINE_NOT_RUNNING:
    "Open the project in Summer Engine, or run: npx -y summer-engine@latest run <project-path> (the folder that holds project.godot).",
  AUTH_REQUIRED: `Ask the person to sign in: ${SIGN_IN_COMMAND}`,
  NO_CREDITS: `Ask the person to add credits: ${CREDITS_URL}`,
  NETWORK_ERROR: "Check the network connection, then retry.",
};

/** The same steps for `summer tool` in a shell, where `summer` is the CLI. */
export const CLI_RECOVERY: Record<SummerErrorCode, string> = {
  ...RECOVERY,
  ENGINE_NOT_RUNNING: "Open the project in Summer Engine, or run: summer run <project-path> (the folder that holds project.godot).",
  AUTH_REQUIRED: "Run: summer login",
};

export interface CodedFailure {
  ok: false;
  code: SummerErrorCode;
  error: string;
  recovery: string;
}

/** `{ok:false, code, error, recovery}` first, then any other fields the
 *  tool already returned (`message`, `hint`, `status`, …). The four named
 *  fields win over `extra`; `recovery` defaults to the MCP wording. */
export function codedFailure(
  code: SummerErrorCode,
  error: string,
  extra: Record<string, unknown> = {},
  recovery: string = RECOVERY[code]
): CodedFailure & Record<string, unknown> {
  const named: CodedFailure = { ok: false, code, error, recovery };
  return Object.assign({ ...named }, extra, named);
}

/** The code for a failed Summer web request by HTTP status, when it is one
 *  of the shared ones. */
export function codeForStatus(status: number): SummerErrorCode | null {
  if (status === 401) return "AUTH_REQUIRED";
  if (status === 402) return "NO_CREDITS";
  return null;
}

/** `fetch failed` says nothing; Node puts the real reason on `cause`
 *  (`connect ECONNREFUSED 127.0.0.1:443`, `getaddrinfo ENOTFOUND …`). */
export function describeNetworkError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  const causeMessage = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return causeMessage && !message.includes(causeMessage) ? `${message} (${causeMessage})` : message;
}

/** The engine connect failure that means "nothing is running for this
 *  project", worded for the person; the raw reason (token files, instance
 *  registry paths) stays in the logs, not in the line the agent repeats. */
export class EngineNotRunningError extends Error {
  readonly code = "ENGINE_NOT_RUNNING" as const;
  constructor(message: string, readonly reason: string) {
    super(message);
    this.name = "EngineNotRunningError";
  }
}

/** A connect error from core/engine.ts → EngineNotRunningError when it means
 *  no editor is reachable; null for the others (several editors open, …),
 *  which already say what to do. */
export function engineNotRunningFromConnectError(reason: string): EngineNotRunningError | null {
  const port = reason.match(/not responding on port (\d+)/)?.[1];
  if (port) return new EngineNotRunningError(`Summer Engine is not responding on port ${port}.`, reason);
  if (/^No running Summer editor matches/.test(reason)) {
    return new EngineNotRunningError(reason.split(/(?<=\.)\s/)[0], reason);
  }
  if (/not running/i.test(reason)) return new EngineNotRunningError("Summer Engine is not running.", reason);
  return null;
}

/** Engine-free tools keep working while the engine is down. */
export const ENGINE_FREE_NOTE =
  "Only tools that touch the local project need the engine. Library, generation and asset tools " +
  "(summer_search_library, summer_generate_*, summer_search_assets, summer_list_my_assets, summer_get_asset, summer_check_job) work now.";
