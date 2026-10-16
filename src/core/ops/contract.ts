import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "../package-root.js";
import { isLocalOp } from "./areas.js";

/**
 * The Summer operation catalog, the part this package needs (contract 1).
 * Every Summer operation has one name (`area.action`), one effect, one
 * approval rule and one answer shape; the MCP surface, the CLI and the
 * store profiles are views of it. The machine contract is
 * registry/schemas/operation.schema.json; old 3.x tool names map to
 * operations in registry/operations/legacy-names.json.
 *
 * Engine and local operations run in this package. Cloud operations run on
 * the hosted Summer server; this package reaches them through its v4
 * surface (summer_search, summer_call) with the person's sign-in.
 */

export const CONTRACT_VERSION = 1;

export const EFFECTS = ["read", "write", "spend", "publish", "player_facing", "destructive"] as const;
export type Effect = (typeof EFFECTS)[number];
export type Approval = "none" | "confirm" | "owner";
export type Provider = "engine" | "local" | "cloud";

export const MIN_APPROVAL: Record<Effect, Approval> = {
  read: "none",
  write: "none",
  spend: "none",
  publish: "owner",
  player_facing: "owner",
  destructive: "confirm",
};

export type ErrorCode =
  | "invalid_input"
  | "not_signed_in"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "idempotency_conflict"
  | "in_progress"
  | "rate_limited"
  | "no_credits"
  | "over_limit"
  | "engine_not_running"
  | "engine_lacks_op"
  | "unsupported"
  | "not_in_profile"
  | "moved"
  | "outcome_unknown"
  | "unavailable"
  | "internal";

export type NextStep = { op: string; input?: Record<string, unknown> } | { url: string; label: string } | { say: string };
export type Retry = "no" | "safe" | "same_key" | "after";
export type OpErrorBody = { code: ErrorCode; message: string; next?: NextStep; retry: Retry; details?: Record<string, unknown>; requestId?: string };
export type JobState = "queued" | "running" | "awaiting_approval" | "done" | "failed" | "cancelled" | "declined" | "expired" | "stale";
export type JobRef = { id: string; op?: string; state: JobState; progress?: number; pollAfterSeconds?: number };

/** The one answer shape every operation gives, in every view. */
export type Answer =
  | { ok: true; status: "done"; result: unknown; warnings?: string[] }
  | { ok: true; status: "running"; job: JobRef; warnings?: string[] }
  | { ok: true; status: "needs_approval"; approval: { id: string; url: string; who: "owner" | "person"; summary: string; expiresAt?: string }; job: JobRef; warnings?: string[] }
  | { ok: true; status: "dry_run"; preview: Record<string, unknown>; warnings?: string[] }
  | { ok: false; error: OpErrorBody };

export function errorAnswer(code: ErrorCode, message: string, options: { next?: NextStep; retry?: Retry; details?: Record<string, unknown> } = {}): Answer {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(options.next ? { next: options.next } : {}),
      retry: options.retry ?? (code === "rate_limited" || code === "unavailable" || code === "in_progress" ? "after" : code === "engine_not_running" ? "safe" : code === "outcome_unknown" ? "same_key" : "no"),
      ...(options.details ? { details: options.details } : {}),
    },
  };
}

// ── Names ────────────────────────────────────────────────────────────────────

export const OP_NAME = /^(whoami|[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)$/;

/** `games.list` -> `summer_games_list`. */
export function mcpNameOf(op: string): string {
  return `summer_${op.replace(/\./g, "_")}`;
}

/** `assets generate-image` -> `assets.generate_image`; `whoami` stays. */
export function opFromCli(area: string, action?: string): string {
  const clean = (part: string) => part.trim().toLowerCase().replace(/-/g, "_");
  return action ? `${clean(area)}.${clean(action)}` : clean(area);
}

export type LegacyRow = { op: string; kind: "same" | "merge" | "split" | "keep"; note: string };

let legacyCache: Record<string, LegacyRow> | null = null;

/** registry/operations/legacy-names.json: every 3.x tool name (and `#action`) to its operation. */
export function legacyNames(): Record<string, LegacyRow> {
  if (legacyCache) return legacyCache;
  try {
    const parsed = JSON.parse(readFileSync(join(PACKAGE_ROOT, "registry", "operations", "legacy-names.json"), "utf8")) as { names?: Record<string, LegacyRow> };
    legacyCache = parsed.names ?? {};
  } catch {
    legacyCache = {};
  }
  return legacyCache;
}

/** A 3.x name as its operation name; an operation name unchanged. */
export function resolveOpName(name: string): string {
  const trimmed = name.trim();
  return legacyNames()[trimmed]?.op ?? trimmed;
}

/**
 * Local operations a 3.x tool runs although legacy-names.json maps that
 * tool to a cloud operation: the local-only input is its own operation
 * (apps.publish_folder reads a folder on disk; apps.publish takes files).
 */
export const LOCAL_RUNNERS: Readonly<Record<string, string>> = { "apps.publish_folder": "summer_app_publish" };

export { isLocalOp };

/**
 * The local 3.x tools that run an operation here, first choice first: the
 * tool the op was renamed from before the tools merged into it.
 */
export function localToolsFor(op: string): string[] {
  if (LOCAL_RUNNERS[op]) return [LOCAL_RUNNERS[op]];
  const rank = (row: LegacyRow) => (row.kind === "merge" ? 1 : 0);
  return Object.entries(legacyNames())
    .filter(([name, row]) => row.op === op && !name.includes("#"))
    .sort(([, a], [, b]) => rank(a) - rank(b))
    .map(([name]) => name);
}

// ── Job ids ──────────────────────────────────────────────────────────────────

const JOB_KINDS = new Set(["gen", "op", "apr", "plan", "build", "upload", "engine"]);

/** `<kind>:<backend id>`; an id without a known kind is a 3.x generation job. */
export function parseJobId(id: string): { kind: string; parts: string[] } | null {
  const trimmed = id.trim();
  if (!/^[A-Za-z0-9._~:-]{1,260}$/.test(trimmed)) return null;
  const [head, ...rest] = trimmed.split(":");
  return JOB_KINDS.has(head) && rest.length > 0 && rest.every(Boolean) ? { kind: head, parts: rest } : { kind: "gen", parts: [trimmed] };
}

// ── Telemetry ────────────────────────────────────────────────────────────────

const AREA_TOOL = /^summer_([a-z]+)_([a-z][a-z0-9_]*)$/;

/**
 * The operation a tool call ran, for usage telemetry: summer_call's `op`,
 * summer_search's own op, a 3.x name's op, or a v4 tool's op from its name
 * (areas are single words, so the first underscore after `summer_` is the dot).
 */
export function opForToolCall(tool: string, args: unknown): string | null {
  if (tool === "summer_call") {
    const call = args && typeof args === "object" ? (args as { op?: unknown; input?: unknown }) : {};
    if (typeof call.op !== "string") return null;
    const name = call.op.trim();
    // A mixed 3.x tool: the action in its input picks the operation; an engine operation's own tool name is the operation.
    const input = call.input && typeof call.input === "object" ? (call.input as Record<string, unknown>) : {};
    const action = typeof input.action === "string" ? input.action : typeof input.mode === "string" ? input.mode : null;
    const resolved =
      (action ? legacyNames()[`${name}#${action}`]?.op : undefined) ??
      (name.startsWith("summer_engine_") ? `engine.${name.slice("summer_engine_".length)}` : resolveOpName(name));
    return OP_NAME.test(resolved) ? resolved : null;
  }
  if (tool === "summer_search") return "ops.search";
  if (tool === "summer_whoami") return "whoami";
  // A split 3.x tool: its action (or mode) argument picks the operation.
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const action = typeof record.action === "string" ? record.action : typeof record.mode === "string" ? record.mode : null;
  const split = action ? legacyNames()[`${tool}#${action}`]?.op : undefined;
  if (split) return split;
  const legacy = legacyNames()[tool]?.op;
  if (legacy) return legacy;
  const match = tool.match(AREA_TOOL);
  return match ? `${match[1]}.${match[2]}` : null;
}
