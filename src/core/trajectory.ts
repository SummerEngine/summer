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
 */

const TRAJECTORY_FILE = "trajectory.jsonl";
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const ROTATED_KEEP = 4;
const REDACT_STRING_LIMIT = 200;
const REDACT_MAX_DEPTH = 6;
const REDACT_MAX_ENTRIES = 64;

export function getTrajectoryDir(): string | null {
  const dir = process.env.SUMMER_TRAJECTORY_DIR;
  return typeof dir === "string" && dir.trim().length > 0 ? dir.trim() : null;
}

export function isTrajectoryCaptureEnabled(): boolean {
  return getTrajectoryDir() !== null;
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

function rotateIfNeeded(dir: string, path: string): void {
  // Best-effort; a rotation failure must not block the append (which itself
  // is best-effort). statSync throws when the file does not exist yet.
  try {
    if (statSync(path).size < MAX_FILE_BYTES) return;
    renameSync(path, join(dir, `trajectory-${Date.now()}.jsonl`));
  } catch {
    return;
  }
  try {
    const rotated = readdirSync(dir)
      .filter((name) => /^trajectory-\d+\.jsonl$/.test(name))
      .sort();
    for (const stale of rotated.slice(0, Math.max(0, rotated.length - ROTATED_KEEP))) {
      rmSync(join(dir, stale), { force: true });
    }
  } catch {
    // Old rotations linger; the next rotation retries the cleanup.
  }
}

/** Append one record to the stream. Returns false (and stays silent) when
 *  capture is off or any fs operation fails — never throws. */
function appendRecord(record: Record<string, unknown>): boolean {
  const dir = getTrajectoryDir();
  if (!dir) return false;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, TRAJECTORY_FILE);
    rotateIfNeeded(dir, path);
    appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}

export interface TrajectoryToolCall {
  tool: string;
  args?: unknown;
  isError?: boolean;
  terminalState?: string;
  errorClass?: string;
  failureReason?: string;
  durationMs?: number;
}

/** One line per MCP tool call. No-op (false) when capture is off. */
export function recordToolCall(call: TrajectoryToolCall): boolean {
  return appendRecord({
    kind: "tool_call",
    tool: call.tool,
    argsRedacted: redactTrajectoryArgs(call.args ?? {}),
    ok: call.isError !== true,
    ...(call.terminalState ? { terminalState: call.terminalState } : {}),
    ...(call.errorClass ? { errorClass: call.errorClass } : {}),
    ...(call.failureReason ? { failureReason: call.failureReason } : {}),
    ...(typeof call.durationMs === "number" ? { durationMs: call.durationMs } : {}),
  });
}
