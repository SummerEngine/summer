import { OAuthError } from "../oauth.js";
import { errorAnswer, type Answer } from "./contract.js";

/**
 * Why a call to the hosted v4 surface threw, in the one error shape. Only a
 * sign-in problem says to sign in: an unreachable server says so with its
 * cause, and a call that was sent and then timed out says its outcome is
 * unknown, so a write is not blindly sent twice.
 */

/** A hosted call the mount could not make, with the mount's code (hosted-mount.ts call()). */
export class HostedCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly recovery: string
  ) {
    super(message);
    this.name = "HostedCallError";
  }
}

/** The sign-in is missing, expired or refused: signing in again fixes it. */
const SIGN_IN_CODES = new Set(["store_login_required", "store_login_expired", "oauth_token_invalid", "invalid_grant", "access_denied", "unauthorized", "not_signed_in"]);

const SIGN_IN = { say: "Run: npx -y summer-engine login" };
const CHECK_FIRST = "It may have happened. Check it (jobs.get, or the operation's own read) before you try again, and retry only with the same idempotencyKey.";

export function hostedFailure(error: unknown): Answer {
  const coded = error instanceof HostedCallError || error instanceof OAuthError ? error : null;
  if (coded) {
    const message = coded instanceof OAuthError ? coded.message.replace(` ${coded.recovery}`, "") : coded.message;
    if (SIGN_IN_CODES.has(coded.code)) return errorAnswer("not_signed_in", message, { next: SIGN_IN, details: { was: coded.code } });
    return errorAnswer("unavailable", message, { next: { say: coded.recovery.replace(/^Recovery:\s*/, "") || "Try again in a minute." }, details: { was: coded.code } });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/\b401\b|unauthori[sz]ed|invalid_token/i.test(message)) {
    return errorAnswer("not_signed_in", `The Summer server did not accept the sign-in: ${message}`, { next: SIGN_IN });
  }
  if (/timed? ?out|timeout|-32001|aborted/i.test(message)) {
    return errorAnswer("outcome_unknown", `The Summer server did not answer in time: ${message}`, { next: { say: CHECK_FIRST } });
  }
  return errorAnswer("unavailable", `The Summer server did not answer: ${message}`, { next: { say: "Check the network, then try again in a minute." } });
}
