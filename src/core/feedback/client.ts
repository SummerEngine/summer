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
 * - First-run notice: the first call ever made on a machine returns a
 *   one-paragraph notice of what was sent + the opt-out env vars.
 * - Authenticated installs attribute via the auth bearer; anonymous
 *   installs use a random persisted install id (a uuid — no hardware,
 *   user, or project identity).
 *
 * No stdout writes anywhere in this module (stdio MCP protocol);
 * nothing is logged on failure — silence is the contract.
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { getAuthToken } from "../auth.js";
import { resolveGatewayUrl } from "../config.js";
import { readStoreText, writeStoreText } from "../store.js";

const require = createRequire(import.meta.url);
const { version: TOOLKIT_VERSION } = require("../../../package.json") as {
  version: string;
};

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

export function getToolkitVersion(): string {
  return TOOLKIT_VERSION;
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
 * later call returns false. Errors → false (no notice beats a crash, and
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

export const FIRST_RUN_NOTICE =
  "First feedback report from this machine — what was just sent to Summer: the library entry IDs you used, " +
  "an outcome word for each, your optional short notes (280 characters max, about the entry itself), the " +
  "engine/toolkit versions, the reporting model's self-reported id, and the host app name/version from the " +
  "MCP handshake. The report schema has no field for project files, chat content, or code. " +
  "Reports are attributed to your Summer account if you are logged in, otherwise to an anonymous random " +
  "install id stored in ~/.summer/. They are used to fix and re-rank library entries, so this user's own " +
  "future sessions load better ones. Opt out any time by setting SUMMER_NO_TELEMETRY=1 or DO_NOT_TRACK=1 — " +
  "then nothing is ever sent. This notice appears only once.";

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

export interface SendLibraryFeedbackResult {
  /** false only when a kill-switch env var suppressed the send entirely. */
  recorded: boolean;
  /** present (true) only when disabled by env. */
  disabled?: boolean;
  /** present (false) only when the POST did not land — honest, non-fatal. */
  queued?: boolean;
  /** present only on the very first call ever made on this machine. */
  notice?: string;
}

/**
 * Send one batched feedback report. Never throws. Blocks at most TIMEOUT_MS.
 *
 * Result matrix:
 * - env kill switch          → { recorded: false, disabled: true }
 * - gateway accepted (2xx)   → { recorded: true }
 * - any failure / timeout    → { recorded: true, queued: false }
 * - first call on machine    → + { notice: FIRST_RUN_NOTICE }
 */
export async function sendLibraryFeedback(
  input: SendLibraryFeedbackInput
): Promise<SendLibraryFeedbackResult> {
  if (isFeedbackDisabled()) {
    return { recorded: false, disabled: true };
  }

  const result: SendLibraryFeedbackResult = { recorded: true };

  try {
    if (await consumeFirstRunNotice()) {
      result.notice = FIRST_RUN_NOTICE;
    }

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
      if (!res.ok) result.queued = false;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Silent failure is the contract: no retry, no log, no throw.
    result.queued = false;
  }

  return result;
}
