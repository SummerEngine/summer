/**
 * Library-feedback client (CONTRACT.md §10, v1 = mailbox).
 *
 * Fire-and-forget POST of batched library-entry outcome reports to the
 * Summer gateway. Structurally leak-proof by schema (enums + hard caps —
 * no field can carry project files, chat content, or code), 1s timeout,
 * silent failure, never throws, never retries, never blocks the agent
 * for more than the timeout.
 *
 * Consent (SELF_IMPROVING_LIBRARY.md §3.4):
 * - SUMMER_NO_TELEMETRY=1 or DO_NOT_TRACK=1 → nothing is ever sent.
 * - First-run notice BEFORE the first event (CONTRACT §10): the first call
 *   ever made on a machine sends NOTHING and returns a one-paragraph notice
 *   of what a report contains + the opt-out env vars; sending starts on the
 *   next call.
 * - Authenticated installs attribute via the auth bearer; anonymous
 *   installs use a random persisted install id (a uuid — no hardware,
 *   user, or project identity).
 *
 * No stdout writes anywhere in this module (stdio MCP protocol);
 * nothing is logged on failure — silence is the contract.
 */
import { randomUUID } from "node:crypto";
import { getAuthToken } from "../auth.js";
import { resolveGatewayUrl } from "../config.js";
import { readStoreText, writeStoreText } from "../store.js";

import { TOOLKIT_VERSION } from "../version.js";

const FEEDBACK_PATH = "/api/mcp/library-feedback";
const TIMEOUT_MS = 1000;
const INSTALL_ID_FILE = "feedback-install-id";
const FIRST_RUN_MARKER_FILE = "feedback-first-run";

/** Random per-MCP-server-process session id. Never persisted. */
let sessionId: string | null = null;

export function getFeedbackSessionId(): string {
  if (!sessionId) sessionId = randomUUID();
  return sessionId;
}

/** Test-only seam. */
export function _resetFeedbackSessionForTests(): void {
  sessionId = null;
}

async function feedbackUrl(): Promise<string> {
  return `${await resolveGatewayUrl()}${FEEDBACK_PATH}`;
}

/** Kill switches: send NOTHING when either is set to "1". */
export function isFeedbackDisabled(): boolean {
  return (
    process.env.SUMMER_NO_TELEMETRY === "1" || process.env.DO_NOT_TRACK === "1"
  );
}

/**
 * Anonymous install id: a random uuid persisted once in ~/.summer/.
 * Falls back to an ephemeral uuid if the store is unreadable/unwritable —
 * feedback must never fail because the store does.
 */
export async function getInstallId(): Promise<string> {
  try {
    const existing = await readStoreText(INSTALL_ID_FILE);
    if (existing?.trim()) return existing.trim();
    const created = randomUUID();
    await writeStoreText(INSTALL_ID_FILE, created);
    return created;
  } catch {
    return randomUUID();
  }
}

/**
 * First-run notice gate: returns true exactly once per machine — the first
 * time the feedback tool is ever called — and writes the marker so every
 * later call returns false. That first call sends nothing (the notice must
 * precede the first event). Errors → false (no notice beats a crash, and
 * the disclosure also lives in the tool description).
 */
export async function consumeFirstRunNotice(): Promise<boolean> {
  try {
    const marker = await readStoreText(FIRST_RUN_MARKER_FILE);
    if (marker !== null) return false;
    await writeStoreText(FIRST_RUN_MARKER_FILE, new Date().toISOString());
    return true;
  } catch {
    return false;
  }
}

/** Every field a report POST carries, in one place so the tool description,
 *  the first-run notice and the tests cannot disagree about what is sent. */
export const FEEDBACK_FIELDS_SENT =
  "the library entry ids you used (entry_id), one outcome word per entry, your optional note and deviation " +
  "(280 characters max each, about the entry itself), engine_version, agent_model (your self-reported model id), " +
  "toolkit_version (this CLI's version), client (the host app name/version from the MCP handshake), " +
  "session_id (a random id per MCP server process, never persisted), and — only when not logged in — " +
  "install_id (a random uuid stored in ~/.summer/; no hardware, user, or project identity). When logged in, " +
  "the Summer account bearer token is sent instead of install_id.";

export const FIRST_RUN_NOTICE =
  "First use of summer_library_feedback on this machine — NOTHING has been sent yet, including this batch. " +
  "Call the tool again with the same reports to send them; this notice appears only once. " +
  `What every report sends to Summer (POST ${FEEDBACK_PATH}): ${FEEDBACK_FIELDS_SENT} ` +
  "The report schema has no field for project files, chat content, or code. Reports are used to fix and " +
  "re-rank library entries, so this user's own future sessions load better ones. Opt out any time by setting " +
  "SUMMER_NO_TELEMETRY=1 or DO_NOT_TRACK=1 — then nothing is ever sent.";

export interface LibraryFeedbackReport {
  entry_id: string;
  outcome:
    | "worked"
    | "worked_with_fixes"
    | "wrong"
    | "outdated"
    | "incomplete"
    | "did_not_apply"
    | "misrouted";
  note?: string;
  deviation?: string;
}

export interface SendLibraryFeedbackInput {
  reports: LibraryFeedbackReport[];
  engine_version: string;
  /** Self-reported model id of the reporting agent ("unknown" allowed). */
  agent_model: string;
  /**
   * Host app identity ("name version", e.g. "claude-code 2.1.0") captured
   * from the MCP initialize handshake by the server adapter — never
   * self-reported by the agent. Omitted when the handshake carried none.
   */
  client?: string;
}

/**
 * Why a batch was dropped — so an agent can tell a missing endpoint from a
 * network blip (E2E 2026-09-03 F-03: production answered 404 and the tool
 * said only `dropped: true`). Describes the RESPONSE only; nothing about it
 * is sent anywhere.
 */
export type FeedbackDropReason =
  /** HTTP 404 — the gateway has no library-feedback route (deploy order). */
  | "endpoint_missing"
  /** Any other 4xx — the gateway refused this batch (auth, schema, rate). */
  | "rejected"
  /** 5xx — the gateway failed; the route exists. */
  | "server_error"
  /** fetch threw: offline, DNS, TLS, or the 1s timeout. No response at all. */
  | "network";

export interface SendLibraryFeedbackResult {
  /** true ONLY when the gateway accepted the report (2xx) within the timeout. */
  recorded: boolean;
  /** present (true) only when disabled by env — nothing sent. */
  disabled?: boolean;
  /** present (true) only on the very first call ever made on this machine —
   *  nothing sent; `notice` explains and asks for a re-send. */
  first_run?: boolean;
  /** present (true) when the POST failed / timed out / was refused. There is
   *  no queue and no retry: the batch is gone. Honest, non-fatal. */
  dropped?: boolean;
  /** present alongside dropped — the HTTP status the gateway answered with;
   *  absent when the request never got a response (reason "network"). */
  status?: number;
  /** present alongside dropped — see FeedbackDropReason. */
  reason?: FeedbackDropReason;
  /** present only alongside first_run. */
  notice?: string;
}

/** Classify a non-2xx response. Exported for tests. */
export function dropReasonForStatus(status: number): FeedbackDropReason {
  if (status === 404) return "endpoint_missing";
  if (status >= 500) return "server_error";
  return "rejected";
}

/**
 * Send one batched feedback report. Never throws. Blocks at most TIMEOUT_MS.
 *
 * Result matrix:
 * - env kill switch          → { recorded: false, disabled: true }     (nothing sent)
 * - first call on machine    → { recorded: false, first_run: true, notice } (nothing sent)
 * - gateway accepted (2xx)   → { recorded: true }
 * - non-2xx                  → { recorded: false, dropped: true, status, reason } (no retry exists)
 * - fetch threw / timed out  → { recorded: false, dropped: true, reason: "network" }
 */
export async function sendLibraryFeedback(
  input: SendLibraryFeedbackInput
): Promise<SendLibraryFeedbackResult> {
  if (isFeedbackDisabled()) {
    return { recorded: false, disabled: true };
  }

  // The notice must precede the first event: the first call on a machine
  // returns the disclosure and sends nothing at all.
  if (await consumeFirstRunNotice()) {
    return { recorded: false, first_run: true, notice: FIRST_RUN_NOTICE };
  }

  try {
    let token: string | null = null;
    try {
      token = await getAuthToken();
    } catch {
      token = null;
    }

    const body: Record<string, unknown> = {
      reports: input.reports,
      engine_version: input.engine_version,
      agent_model: input.agent_model,
      session_id: getFeedbackSessionId(),
      toolkit_version: TOOLKIT_VERSION,
    };
    if (input.client) body.client = input.client;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    } else {
      body.install_id = await getInstallId();
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(await feedbackUrl(), {
        method: "POST",
        signal: ctrl.signal,
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        return {
          recorded: false,
          dropped: true,
          status: res.status,
          reason: dropReasonForStatus(res.status),
        };
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Silent failure is the contract: no retry, no log, no throw. The reason
    // is for the caller's result only — nothing is sent about it.
    return { recorded: false, dropped: true, reason: "network" };
  }

  return { recorded: true };
}
