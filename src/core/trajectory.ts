import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Local, opt-in trajectory capture.
 *
 * When SUMMER_TRAJECTORY_DIR is set, every MCP tool call appends ONE JSONL
 * record ({ts, kind, tool, argsRedacted, ok, terminalState, errorClass,
 * failureReason, durationMs}) to <dir>/trajectory.jsonl. Local only — nothing
 * here talks to a network. Outcome signals ride the same stream: a
 * summer_library_feedback call is itself a tool call, so its outcome enums land
 * here next to the calls they judge (report notes are short enough to survive
 * redaction).
 *
 * Hard requirements, in priority order:
 *   1. OFF BY DEFAULT — with the env var unset this module is a no-op with
 *      zero behavior change.
 *   2. NEVER THROWS — capture must never break a tool call. Every fs
 *      operation is wrapped; failures are swallowed (a diagnostics stream is
 *      not worth failing real work over).
 *   3. BOUNDED — script/content bodies are redacted to shape (strings over
 *      200 chars are replaced with a length marker) and the stream rotates at
 *      16MB, keeping the last 4 rotated files.
 *
 * Eval mode (opt-in on top of the above, for eval fixtures only): when BOTH
 * SUMMER_TRAJECTORY_DIR and SUMMER_TRAJECTORY_EVAL=1 are set, every call is
 * additionally appended UNREDACTED to <dir>/trajectory.full.jsonl — full args
 * plus a bounded result summary (ok/classifiers, top-level result keys, an
 * allowlist of scalar confession fields, media by hash) — so a recorded
 * session can be REPLAYED and its perception calls judged for honesty. The
 * redacted stream is written unchanged alongside; the eval flag without the
 * directory does nothing. No result bodies, no image bytes, ever.
 */

const TRAJECTORY_FILE = "trajectory.jsonl";
const TRAJECTORY_FULL_FILE = "trajectory.full.jsonl";
const ROTATED_PATTERN = /^trajectory-\d+\.jsonl$/;
const ROTATED_FULL_PATTERN = /^trajectory\.full-\d+\.jsonl$/;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const ROTATED_KEEP = 4;
const REDACT_STRING_LIMIT = 200;
const REDACT_MAX_DEPTH = 6;
const REDACT_MAX_ENTRIES = 64;
const FULL_MAX_KEYS = 32;

export const TRAJECTORY_EVAL_ENV = "SUMMER_TRAJECTORY_EVAL";

export function getTrajectoryDir(): string | null {
  const dir = process.env.SUMMER_TRAJECTORY_DIR;
  return typeof dir === "string" && dir.trim().length > 0 ? dir.trim() : null;
}

/** True only when capture is on AND the eval flag is set — the flag alone
 *  does nothing (design rule: eval mode never changes the default). */
export function isTrajectoryEvalMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const dir = env.SUMMER_TRAJECTORY_DIR;
  if (typeof dir !== "string" || dir.trim().length === 0) return false;
  const raw = env[TRAJECTORY_EVAL_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * Keep the SHAPE of a tool call's arguments, drop the bodies: any string over
 * REDACT_STRING_LIMIT chars (script sources, file contents, notes pasted in)
 * becomes a "[redacted N chars]" marker. Objects/arrays are walked with depth
 * and entry caps so a pathological payload cannot balloon the record.
 * Exported for unit tests.
 */
export function redactTrajectoryArgs(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > REDACT_STRING_LIMIT
      ? `[redacted ${value.length} chars]`
      : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= REDACT_MAX_DEPTH) return "[redacted: depth]";
  if (Array.isArray(value)) {
    const out = value
      .slice(0, REDACT_MAX_ENTRIES)
      .map((entry) => redactTrajectoryArgs(entry, depth + 1));
    if (value.length > REDACT_MAX_ENTRIES) {
      out.push(`[redacted ${value.length - REDACT_MAX_ENTRIES} more entries]`);
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  let entries = 0;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (entries >= REDACT_MAX_ENTRIES) {
      out["[redacted]"] = "more keys";
      break;
    }
    out[key] = redactTrajectoryArgs(nested, depth + 1);
    entries += 1;
  }
  return out;
}

function rotateIfNeeded(dir: string, path: string, rotatedBase: string, rotatedPattern: RegExp): void {
  // Best-effort; a rotation failure must not block the append (which itself
  // is best-effort). statSync throws when the file does not exist yet.
  try {
    if (statSync(path).size < MAX_FILE_BYTES) return;
    renameSync(path, join(dir, `${rotatedBase}-${Date.now()}.jsonl`));
  } catch {
    return;
  }
  try {
    const rotated = readdirSync(dir)
      .filter((name) => rotatedPattern.test(name))
      .sort();
    for (const stale of rotated.slice(0, Math.max(0, rotated.length - ROTATED_KEEP))) {
      rmSync(join(dir, stale), { force: true });
    }
  } catch {
    // Old rotations linger; the next rotation retries the cleanup.
  }
}

/** Append one record to a stream file. Returns false (and stays silent) when
 *  capture is off or any fs operation fails — never throws. */
function appendRecordTo(
  fileName: string,
  rotatedBase: string,
  rotatedPattern: RegExp,
  record: Record<string, unknown>
): boolean {
  const dir = getTrajectoryDir();
  if (!dir) return false;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, fileName);
    rotateIfNeeded(dir, path, rotatedBase, rotatedPattern);
    appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}

function appendRecord(record: Record<string, unknown>): boolean {
  return appendRecordTo(TRAJECTORY_FILE, "trajectory", ROTATED_PATTERN, record);
}

function appendFullRecord(record: Record<string, unknown>): boolean {
  return appendRecordTo(TRAJECTORY_FULL_FILE, "trajectory.full", ROTATED_FULL_PATTERN, record);
}

// ---------------------------------------------------------------------------
// Eval-mode result summary (design §6.3): shape and confession fields only.
// ---------------------------------------------------------------------------

/** The complete set of result scalars the full stream may carry. Anything
 *  else in a result body stays out — the stream records that a perception
 *  call happened and what it confessed, never what it saw. */
export const TRAJECTORY_RESULT_FIELD_ALLOWLIST: readonly string[] = [
  "snapshot_id",
  "from_id",
  "to_id",
  "framing",
  "used_scene_camera",
  "environment_used",
  "used_synthetic_camera",
  "rolled_back",
  "budget_exceeded",
];

export interface TrajectoryMediaSummary {
  mime: string;
  bytes: number;
  sha256: string;
}

export interface TrajectoryResultSummary {
  ok: boolean;
  terminalState?: string;
  failureReason?: string;
  errorClass?: string;
  /** Top-level keys of the result payload (≤ FULL_MAX_KEYS). */
  keys: string[];
  /** Allowlisted scalars found at the payload top level or inside its first
   *  results[] entry (the engine op dict), plus derived counts. */
  fields: Record<string, string | number | boolean>;
  /** Image/audio blocks by hash — never inline. */
  media: TrajectoryMediaSummary[];
}

type ContentBlock = { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Pull the JSON payload + media out of a tool result. Handles the MCP
 *  content shape ({content:[text|image|audio blocks]}) and the plain object a
 *  CLI-face dispatch returns. */
function unwrapResult(result: unknown): { payload: Record<string, unknown> | null; media: TrajectoryMediaSummary[] } {
  const media: TrajectoryMediaSummary[] = [];
  if (isRecord(result) && Array.isArray(result.content)) {
    let payload: Record<string, unknown> | null = null;
    for (const block of result.content as ContentBlock[]) {
      if (!isRecord(block)) continue;
      if ((block.type === "image" || block.type === "audio") && typeof block.data === "string") {
        const bytes = Buffer.from(block.data, "base64");
        media.push({
          mime: typeof block.mimeType === "string" ? block.mimeType : "application/octet-stream",
          bytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      } else if (block.type === "text" && typeof block.text === "string" && payload === null) {
        try {
          const parsed = JSON.parse(block.text) as unknown;
          if (isRecord(parsed)) payload = parsed;
        } catch {
          // A prose text block has no keys to record.
        }
      }
    }
    return { payload, media };
  }
  return { payload: isRecord(result) ? result : null, media };
}

function collectAllowlisted(source: Record<string, unknown> | null, into: Record<string, string | number | boolean>): void {
  if (!source) return;
  for (const key of TRAJECTORY_RESULT_FIELD_ALLOWLIST) {
    if (key in into) continue;
    const value = source[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") into[key] = value;
  }
  if (!("errors_count" in into) && Array.isArray(source.errors)) into.errors_count = source.errors.length;
  const warnings = Array.isArray(source.frame_warnings)
    ? source.frame_warnings
    : isRecord(source.results) && Array.isArray(source.results.frame_warnings)
      ? source.results.frame_warnings
      : null;
  if (!("frame_warnings_count" in into) && warnings) into.frame_warnings_count = warnings.length;
}

/** Bounded, allowlisted summary of a tool result. Exported for unit tests and
 *  for the outcome-eval runner, which records replayed calls through the same
 *  function so a replay run yields the same stream shape a live session does. */
export function summarizeToolResult(
  result: unknown,
  classifiers: { ok: boolean; terminalState?: string; failureReason?: string; errorClass?: string }
): TrajectoryResultSummary {
  const { payload, media } = unwrapResult(result);
  const keys = payload ? Object.keys(payload).slice(0, FULL_MAX_KEYS) : [];
  const fields: Record<string, string | number | boolean> = {};
  collectAllowlisted(payload, fields);
  const firstOp = payload && Array.isArray(payload.results) && isRecord(payload.results[0]) ? payload.results[0] : null;
  collectAllowlisted(firstOp, fields);
  return {
    ok: classifiers.ok,
    ...(classifiers.terminalState ? { terminalState: classifiers.terminalState } : {}),
    ...(classifiers.failureReason ? { failureReason: classifiers.failureReason } : {}),
    ...(classifiers.errorClass ? { errorClass: classifiers.errorClass } : {}),
    keys,
    fields,
    media,
  };
}

export interface TrajectoryToolCall {
  tool: string;
  /** The tool's parsed arguments; `null` means the tool takes no input
   *  schema (recorded as argsRedacted: null, never as the SDK's request extra). */
  args?: unknown;
  isError?: boolean;
  terminalState?: string;
  errorClass?: string;
  failureReason?: string;
  /** Message of a handler THROW (as opposed to an isError result). Recorded
   *  with ok:false, errorClass "exception". Redacted like any other string. */
  exception?: string;
  durationMs?: number;
  /** The tool's raw result (MCP content envelope or CLI-face object). Read
   *  ONLY in eval mode, and only through summarizeToolResult — the redacted
   *  default stream never sees it. */
  result?: unknown;
}

/**
 * Does a server.tool(...) registration carry an input schema? The MCP SDK
 * accepts tool(name, description?, paramsSchema?, annotations?, cb): when a
 * paramsSchema is present the callback receives (args, extra); when it is
 * absent the callback receives (extra) ONLY — and recording extra as the
 * tool's args would write {signal, requestId, ...} junk into the stream. A
 * paramsSchema is a zod raw shape (record of zod schemas, or {} for "no
 * parameters") or a zod object instance; a flat object of primitives is
 * ToolAnnotations. Exported for unit tests.
 */
export function registrationHasInputSchema(registrationArgs: readonly unknown[]): boolean {
  // Everything between the name (index 0) and the callback (last).
  const middle = registrationArgs.slice(1, -1);
  return middle.some((candidate) => {
    if (!candidate || typeof candidate !== "object" || typeof candidate === "string") return false;
    const record = candidate as Record<string, unknown>;
    if (typeof (record as { safeParse?: unknown }).safeParse === "function" && "_def" in record) return true; // zod instance
    const values = Object.values(record);
    if (values.length === 0) return true; // {} = no parameters, still a schema
    return values.every((value) => !!value && typeof value === "object" && "_def" in (value as object));
  });
}

/** The args to record for one handler invocation: the parsed args when the
 *  tool has an input schema, else null (the SDK passes only `extra`). */
export function trajectoryArgsFor(hasInputSchema: boolean, handlerArgs: readonly unknown[]): unknown | null {
  return hasInputSchema ? (handlerArgs[0] ?? {}) : null;
}

/** One line per MCP tool call. No-op (false) when capture is off. In eval
 *  mode a second, unredacted line goes to trajectory.full.jsonl; its failure
 *  never affects the return value (the redacted stream is the contract). */
export function recordToolCall(call: TrajectoryToolCall): boolean {
  const threw = typeof call.exception === "string";
  const ok = !threw && call.isError !== true;
  const errorClass = threw ? "exception" : call.errorClass;
  const written = appendRecord({
    kind: "tool_call",
    tool: call.tool,
    argsRedacted: call.args === null ? null : redactTrajectoryArgs(call.args ?? {}),
    ok,
    ...(call.terminalState ? { terminalState: call.terminalState } : {}),
    ...(errorClass ? { errorClass } : {}),
    ...(call.failureReason ? { failureReason: call.failureReason } : {}),
    ...(threw ? { exception: redactTrajectoryArgs(call.exception) } : {}),
    ...(typeof call.durationMs === "number" ? { durationMs: call.durationMs } : {}),
  });
  if (written && isTrajectoryEvalMode()) {
    try {
      appendFullRecord({
        kind: "tool_call",
        tool: call.tool,
        args: call.args === null ? null : call.args ?? {},
        result: summarizeToolResult(call.result, {
          ok,
          terminalState: call.terminalState,
          failureReason: call.failureReason,
          errorClass,
        }),
        ...(threw ? { exception: call.exception } : {}),
        ...(typeof call.durationMs === "number" ? { durationMs: call.durationMs } : {}),
      });
    } catch {
      // Eval capture is best-effort on top of a best-effort stream.
    }
  }
  return written;
}
