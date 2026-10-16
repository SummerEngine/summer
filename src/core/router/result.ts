import { RouterApiError } from "./api.js";
import { errorDocsUrl, type RouterRegistry, registryError } from "./registry.js";

/**
 * The result of a Summer Router local operation (router.add_character,
 * router.check, router.push, router.pull, router.doctor, router.setup), in the
 * shape every local Summer tool answers with: `{ok: true, ...}`, or
 * `{ok: false, code, was, message, recovery, ...}`. `code` is the operation
 * contract's error code (the answer's error.code: invalid_input, conflict,
 * forbidden, not_signed_in, ...); `was` is the Summer Router tag
 * (tool_unhandled, studio_changed, ...), the answer's details.was, as on the
 * cloud router.* operations.
 */

export type RouterResult = { ok: true } & Record<string, unknown>;

export interface RouterFailure {
  ok: false;
  /** The operation contract's error code. */
  code: string;
  /** The Summer Router tag (the answer's details.was). */
  was: string;
  message: string;
  recovery: string;
  docs_url?: string;
  studio_url?: string;
  request_id?: string;
  next_step?: string;
  details?: unknown;
  [key: string]: unknown;
}

export type RouterAnswer = RouterResult | RouterFailure;

export function success(result: Record<string, unknown>): RouterResult {
  return { ok: true, ...result };
}

/** Each Summer Router tag's contract error code; any other tag is invalid_input. */
const CONTRACT_CODE: Record<string, string> = {
  character_exists: "conflict",
  character_not_found: "not_found",
  not_found: "not_found",
  studio_changed: "conflict",
  local_changes: "conflict",
  version_conflict: "conflict",
  owner_action_required: "forbidden",
  agent_access_not_enabled: "forbidden",
  router_disabled: "forbidden",
  forbidden: "forbidden",
  not_signed_in: "not_signed_in",
  credits_required: "no_credits",
  limit_reached: "over_limit",
  rate_limited: "rate_limited",
  network_error: "unavailable",
  unavailable: "unavailable",
  store_unavailable: "unavailable",
  provider_unavailable: "unavailable",
  internal_error: "internal",
  setup_failed: "internal",
};

export function failure(
  was: string,
  message: string,
  recovery: string,
  extra: Partial<Omit<RouterFailure, "ok" | "code" | "was" | "message" | "recovery">> = {}
): RouterFailure {
  const clean = Object.fromEntries(Object.entries(extra).filter(([, value]) => value !== undefined));
  return { ok: false, code: CONTRACT_CODE[was] ?? "invalid_input", was, message, recovery, ...clean };
}

export const isFailure = (answer: RouterAnswer): answer is RouterFailure => answer.ok === false;

/** The recovery for codes the management API and the creator store proxy return. */
const API_RECOVERY: Record<string, string> = {
  not_signed_in: 'Run "summer login" and approve in the browser, then retry.',
  owner_approval_required:
    "The game is live, so only its owner can change this. Run router.save_character (cloud) with the character document: it answers with the owner's approval link. Or the owner saves it on the Router tab (studio_url).",
  agent_access_not_enabled: "Confirm the email address of your Summer account, then retry.",
  version_conflict: "The character changed on Summer. Run router.pull, merge your edits, then push again.",
  invalid_input: "Fix the field the message names, then retry.",
  unavailable: "Summer Router is not on in this Summer environment yet. Retry later.",
  store_unavailable: "Summer is not reachable right now. Retry in a few minutes.",
  rate_limited: "Wait a little, then retry.",
  network_error: "Check the network and retry.",
};

export interface ApiFailureContext {
  registry?: RouterRegistry;
  studioUrl?: string;
  /** What a 404 means for this call. */
  notFound?: string;
}

export function apiFailure(error: unknown, context: ApiFailureContext = {}): RouterFailure {
  if (!(error instanceof RouterApiError)) {
    return failure("internal_error", error instanceof Error ? error.message : String(error), "Retry. If it repeats, run router.doctor and report its answer.");
  }
  const code = error.code === "owner_approval_required" ? "owner_action_required" : error.code;
  const fromRegistry = context.registry ? registryError(context.registry, error.code) : undefined;
  const notFound = error.status === 404 ? context.notFound : undefined;
  return failure(
    code,
    error.message,
    error.extra.fix ?? fromRegistry?.fix ?? API_RECOVERY[error.code] ?? notFound ?? "Read the message, fix the input, and retry.",
    {
      docs_url: error.extra.docsUrl ?? (fromRegistry ? errorDocsUrl(error.code) : undefined),
      studio_url:
        error.extra.studioUrl ??
        fromRegistry?.studio_url ??
        (error.code === "owner_approval_required" || error.code === "router_disabled" ? context.studioUrl : undefined),
      request_id: error.extra.requestId,
      next_step: error.code === "not_signed_in" ? "summer login" : undefined,
      details: error.extra.resetsAt ? { scope: error.extra.scope, resets_at: error.extra.resetsAt } : undefined,
    }
  );
}
