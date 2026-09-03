/**
 * Engine events channel — the ONE implementation behind summer_wait_for_event,
 * summer_recent_events (MCP + `summer tool`) and `summer events` (CLI).
 *
 * Transport: GET /api/events/poll, the engine's long-poll route
 * ({events:[{seq, kind, ts, data}], next_seq, last_seq, since, truncated,
 * timed_out}). The SSE route (GET /api/events) is deliberately NOT consumed in
 * v1 — the poll loop is the portable path through MCP hosts and proxies; an
 * SSE client is a follow-up.
 *
 * Two rules every caller inherits:
 *   - `seq` is a monotonic cursor. A result's next_seq is the `since` of the
 *     next call; events are delivered live from `since`, so a caller who might
 *     miss an event that fires immediately takes a cursor FIRST (recentEvents)
 *     and passes it as `since`.
 *   - timed_out:true is reported as exactly that — no match arrived — never
 *     coerced into a failure or a success.
 *
 * Whether the engine HAS the channel is decided before anything is sent by
 * missingEngineEventsResult (core/capability-skew.ts); this module carries the
 * post-hoc twin for engines reached with the pre-flight off (HTTP 404).
 */
import { z } from "zod";
import type { EventsPollParams } from "../api-client.js";
import {
  EVENTS_FALLBACK,
  buildMissingEventsResult,
  type CapabilityAdvertisingClient,
} from "../capability-skew.js";
import { asRecord, numberFrom, stringFrom } from "../util/json.js";

/** Event kinds v1 (SCENE_SCRIPTING_CONTRACTS.md, Wave J). sys.* transport
 *  frames (sys.gap, sys.closed) are not kinds: never in the ring, never
 *  filterable, surfaced separately below. */
export const EVENT_KINDS_V1 = [
  "op.applied",
  "op.failed",
  "script.error",
  "play.started",
  "play.stopped",
  "scene.saved",
  "scene.opened",
  "import.completed",
  "selection.changed",
  "snapshot.published",
] as const;

export const WAIT_DEFAULT_SECONDS = 30;
export const WAIT_MIN_SECONDS = 1;
export const WAIT_MAX_SECONDS = 120;
/** Each held poll stays under this: below typical proxy/host idle limits and
 *  under the engine's own 60 s cap. The wait loop chains slices. */
export const POLL_SLICE_MS = 25_000;
export const WAIT_MAX_EVENTS_DEFAULT = 20;
/** Engine cap on `limit` per poll answer. */
export const POLL_LIMIT_CAP = 500;
export const RECENT_LIMIT_DEFAULT = 50;
export const RECENT_LIMIT_CAP = 200;
/** Pacing sleep after a zero-event answer that came back before its `wait`
 *  elapsed (an engine that answers held polls early would otherwise spin the
 *  loop). Exported for the CLI follow loop. */
export const PACING_MS = 250;

export interface EngineEvent {
  seq: number;
  kind: string;
  /** unix ms */
  ts?: number;
  data?: unknown;
}

/** A sys.* transport frame delivered inside a poll page. */
export interface EventsFrame {
  kind: string;
  data?: unknown;
}

/** The client surface this module needs — EngineApiClient satisfies it. */
export interface EventsClient extends CapabilityAdvertisingClient {
  pollEvents(params?: EventsPollParams, timeoutMs?: number): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Argument schemas — shared by the MCP registration (raw shape) and the CLI
// dispatcher (same zod), so both faces reject the same inputs.
// ---------------------------------------------------------------------------

const kindsSchema = z
  .array(z.string().min(1))
  .describe(
    `Event kinds to deliver (default: all). v1 kinds: ${EVENT_KINDS_V1.join(", ")}. Unknown kinds are refused before waiting when the engine advertises its list.`
  );

export const waitForEventArgsSchema = z.object({
  kinds: kindsSchema.optional(),
  since: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Deliver events with seq > since. Omit = live from now (an event that already fired is NOT delivered — take a cursor with summer_recent_events first and pass its next_seq here). 0 = replay the retained ring."
    ),
  timeout_seconds: z
    .number()
    .optional()
    .describe("How long to wait for a match (default 30, clamped 1-120). The call long-polls in slices of at most 25 s."),
  match: z
    .object({
      requestId: z
        .string()
        .min(1)
        .optional()
        .describe("Only op.applied / op.failed events for this requestId match; every other kind passes through."),
    })
    .optional()
    .describe("Extra client-side filters applied after the kinds filter."),
  max_events: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum matched events to return (default 20, cap 500)."),
});

export type WaitForEventArgs = z.infer<typeof waitForEventArgsSchema>;

export const recentEventsArgsSchema = z.object({
  since: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Deliver events with seq > since. Omit = the newest `limit` sequence numbers. 0 = the whole retained ring from the oldest (paged: pass next_seq back while truncated is true)."
    ),
  kinds: kindsSchema.optional(),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum events to return (default 50, cap 200)."),
});

export type RecentEventsArgs = z.infer<typeof recentEventsArgsSchema>;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface WaitForEventResult {
  ok: true;
  /** True when at least one event matched; events is then non-empty. */
  matched: boolean;
  events: EngineEvent[];
  /** Cursor for the next call. null only when the engine never reported one. */
  next_seq: number | null;
  /** The cursor this wait started from (the engine's live head when omitted). */
  since: number | null;
  /** True when timeout_seconds elapsed with no match. Not a failure — and not
   *  evidence the awaited thing did not happen. */
  timed_out: boolean;
  waited_ms: number;
  polls: number;
  kinds: string[] | "all";
  match?: { requestId: string };
  /** sys.gap payload when events between since and the oldest retained were
   *  evicted — the stream is not gapless; re-read state. */
  gap?: unknown;
  /** The page that produced the match was full; more matches may follow from next_seq. */
  truncated?: boolean;
  hint?: string;
}

export interface RecentEventsResult {
  ok: true;
  events: EngineEvent[];
  count: number;
  next_seq: number | null;
  last_seq: number | null;
  /** The cursor the read started from. */
  since: number | null;
  /** How `since` was chosen: the caller's value, or the newest-`limit` window. */
  window: "since" | "newest" | "ring";
  truncated: boolean;
  kinds: string[] | "all";
  gap?: unknown;
  hint: string;
}

/** Any structured failure: engine_lacks_events, unknown_event_kind, an
 *  identity_mismatch terminalState, a 503, ... Both faces classify it by its
 *  fields (MCP isError, CLI ToolResultError). */
export type EventsFailure = Record<string, unknown> & { ok: false };

// ---------------------------------------------------------------------------
// Helpers (exported for the CLI command and tests)
// ---------------------------------------------------------------------------

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Trim, drop empties, dedupe, keep order. */
export function normalizeKinds(kinds: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of kinds ?? []) {
    const kind = raw.trim();
    if (kind && !out.includes(kind)) out.push(kind);
  }
  return out;
}

/**
 * Refuse kinds the engine cannot emit — waiting on one would only time out.
 * Decidable only when the engine advertises `capabilities.events.kinds`; an
 * engine without the list lets every kind through (forward-compatible with
 * kinds newer than this CLI).
 */
export function unknownKindsFailure(
  kinds: readonly string[],
  client: CapabilityAdvertisingClient
): EventsFailure | null {
  const advertised =
    typeof client.getEngineCapabilities === "function"
      ? client.getEngineCapabilities()?.events?.kinds
      : undefined;
  if (!advertised || advertised.length === 0) return null;
  const known = new Set(advertised);
  const unknown = kinds.filter((kind) => !known.has(kind));
  if (unknown.length === 0) return null;
  return {
    ok: false,
    failure_reason: "unknown_event_kind",
    unknown_kinds: unknown,
    known_kinds: [...advertised],
    error:
      `This Summer Engine build does not emit event kind(s) ${unknown.join(", ")} — nothing was sent (waiting would only time out). ` +
      `Kinds it emits: ${advertised.join(", ")}.`,
  };
}

export interface ParsedPollPage {
  events: EngineEvent[];
  frames: EventsFrame[];
  next_seq?: number;
  last_seq?: number;
  since?: number;
  truncated: boolean;
  timed_out: boolean;
}

/** Shape-tolerant read of a poll envelope: ring events need a numeric seq and
 *  a string kind; sys.* frames are split out (they may carry no seq). */
export function parsePollPage(raw: unknown): ParsedPollPage {
  const record = asRecord(raw) ?? {};
  const events: EngineEvent[] = [];
  const frames: EventsFrame[] = [];
  if (Array.isArray(record.events)) {
    for (const entry of record.events) {
      const item = asRecord(entry);
      const kind = item ? stringFrom(item.kind) : undefined;
      if (!item || !kind) continue;
      if (kind.startsWith("sys.")) {
        frames.push({ kind, data: item.data });
        continue;
      }
      const seq = numberFrom(item.seq);
      if (seq === undefined) continue;
      const event: EngineEvent = { seq, kind };
      const ts = numberFrom(item.ts);
      if (ts !== undefined) event.ts = ts;
      if (item.data !== undefined) event.data = item.data;
      events.push(event);
    }
  }
  return {
    events,
    frames,
    next_seq: numberFrom(record.next_seq),
    last_seq: numberFrom(record.last_seq),
    since: numberFrom(record.since),
    truncated: record.truncated === true,
    timed_out: record.timed_out === true,
  };
}

/**
 * A poll answer that is a structured failure, or null on a 2xx envelope. The
 * post-hoc twin of the missingEngineEventsResult pre-flight: an engine that
 * answers HTTP 404 for the poll route has no channel (reachable only with
 * SUMMER_CAPABILITY_PREFLIGHT=off, or an advert that lies), so the answer is
 * rewritten into the same engine_lacks_events shape the pre-flight returns.
 */
export function eventsFailure(page: unknown, client: CapabilityAdvertisingClient): EventsFailure | null {
  const record = asRecord(page);
  if (!record) {
    return {
      ok: false,
      failure_reason: "malformed_events_envelope",
      error: "Summer Engine answered the events poll with a non-object body; nothing can be read from it.",
    };
  }
  if (record.ok !== false) return null;
  if (record.http_status === 404) {
    const version =
      typeof client.getEngineVersion === "function" ? client.getEngineVersion() : undefined;
    const missing = buildMissingEventsResult(version ?? null);
    return {
      ...record,
      ok: false,
      failure_reason: missing.failure_reason,
      engine_version: missing.engine_version,
      hint: missing.hint,
      error:
        "This Summer Engine build doesn't expose the events channel yet (GET /api/events/poll answered HTTP 404) — " +
        `${EVENTS_FALLBACK}, or update Summer Engine (restart it after updating).`,
    };
  }
  return record as EventsFailure;
}

/** op.* events match only when data.requestId equals the requested id; every
 *  other kind passes. */
export function selectMatches(events: readonly EngineEvent[], requestId?: string): EngineEvent[] {
  if (!requestId) return [...events];
  return events.filter((event) => {
    if (!event.kind.startsWith("op.")) return true;
    return asRecord(event.data)?.requestId === requestId;
  });
}

function gapOf(frames: readonly EventsFrame[]): unknown {
  return frames.find((frame) => frame.kind === "sys.gap")?.data;
}

function maxSeq(events: readonly EngineEvent[]): number | undefined {
  let max: number | undefined;
  for (const event of events) if (max === undefined || event.seq > max) max = event.seq;
  return max;
}

export interface EventsDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// summer_wait_for_event
// ---------------------------------------------------------------------------

/**
 * Long-poll the engine in slices of at most POLL_SLICE_MS until an event
 * passes the kinds + match filters, or timeout_seconds elapses. Every poll
 * feeds the engine's next_seq back as `since`, so nothing between slices is
 * skipped; sys.gap frames are surfaced (never counted as a match).
 */
export async function waitForEvent(
  client: EventsClient,
  args: WaitForEventArgs,
  deps: EventsDeps = {}
): Promise<WaitForEventResult | EventsFailure> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const kinds = normalizeKinds(args.kinds);
  const unknown = unknownKindsFailure(kinds, client);
  if (unknown) return unknown;
  const timeoutSeconds = clampInt(args.timeout_seconds ?? WAIT_DEFAULT_SECONDS, WAIT_MIN_SECONDS, WAIT_MAX_SECONDS);
  const maxEvents = clampInt(args.max_events ?? WAIT_MAX_EVENTS_DEFAULT, 1, POLL_LIMIT_CAP);
  const requestId = args.match?.requestId?.trim() || undefined;
  const kindsParam = kinds.length > 0 ? kinds : undefined;

  const start = now();
  const deadline = start + timeoutSeconds * 1000;
  let since: number | undefined = args.since;
  let resolvedSince: number | null = args.since ?? null;
  let polls = 0;
  let gap: unknown;

  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    const wait = Math.min(POLL_SLICE_MS, remaining);
    const pollStart = now();
    const page = await client.pollEvents({ since, kinds: kindsParam, wait, limit: maxEvents });
    const held = now() - pollStart;
    polls += 1;
    const failure = eventsFailure(page, client);
    if (failure) return failure;
    const parsed = parsePollPage(page);
    if (resolvedSince === null && parsed.since !== undefined) resolvedSince = parsed.since;
    const frameGap = gapOf(parsed.frames);
    if (frameGap !== undefined) gap = frameGap;
    const advanced = parsed.next_seq ?? maxSeq(parsed.events);
    if (advanced !== undefined) since = advanced;

    const matched = selectMatches(parsed.events, requestId).slice(0, maxEvents);
    if (matched.length > 0) {
      return {
        ok: true,
        matched: true,
        events: matched,
        next_seq: since ?? null,
        since: resolvedSince,
        timed_out: false,
        waited_ms: now() - start,
        polls,
        kinds: kinds.length > 0 ? kinds : "all",
        ...(requestId ? { match: { requestId } } : {}),
        ...(gap !== undefined ? { gap } : {}),
        ...(parsed.truncated ? { truncated: true } : {}),
      };
    }
    // A zero-event answer that returned before its hold elapsed must not spin
    // the loop (the flag is not trusted; the clock is).
    if (parsed.events.length === 0 && held < wait) await sleep(Math.min(PACING_MS, wait - held));
  }

  return {
    ok: true,
    matched: false,
    events: [],
    next_seq: since ?? null,
    since: resolvedSince,
    timed_out: true,
    waited_ms: now() - start,
    polls,
    kinds: kinds.length > 0 ? kinds : "all",
    ...(requestId ? { match: { requestId } } : {}),
    ...(gap !== undefined ? { gap } : {}),
    hint:
      `No matching event arrived within ${timeoutSeconds}s. This is not evidence that it did not happen: ` +
      "an event that fired before `since` is never delivered (take a cursor with summer_recent_events BEFORE triggering the action next time). " +
      "Verify the state directly (summer_is_running, summer_get_diagnostics, summer_get_scene_tree) and never claim an event you did not receive. " +
      "To keep waiting without a gap, call again with since = next_seq.",
  };
}

// ---------------------------------------------------------------------------
// summer_recent_events
// ---------------------------------------------------------------------------

/**
 * One zero-wait read. `since` given: everything after it (paged by limit).
 * `since` omitted: the newest `limit` sequence numbers — the poll route has no
 * "tail" mode, so this costs two zero-wait calls (learn last_seq, then read
 * from last_seq - limit). `since: 0` pages the retained ring from the oldest.
 */
export async function recentEvents(
  client: EventsClient,
  args: RecentEventsArgs
): Promise<RecentEventsResult | EventsFailure> {
  const kinds = normalizeKinds(args.kinds);
  const unknown = unknownKindsFailure(kinds, client);
  if (unknown) return unknown;
  const limit = clampInt(args.limit ?? RECENT_LIMIT_DEFAULT, 1, RECENT_LIMIT_CAP);
  const kindsParam = kinds.length > 0 ? kinds : undefined;

  let since = args.since;
  let window: RecentEventsResult["window"] = since === undefined ? "newest" : since === 0 ? "ring" : "since";
  if (since === undefined) {
    // Live-only head read: zero events, but the newest seq.
    const head = await client.pollEvents({ wait: 0, limit: 1 });
    const headFailure = eventsFailure(head, client);
    if (headFailure) return headFailure;
    const parsedHead = parsePollPage(head);
    const newest = parsedHead.last_seq ?? parsedHead.next_seq;
    if (newest === undefined) {
      since = 0;
      window = "ring";
    } else {
      since = Math.max(0, newest - limit);
    }
  }

  const page = await client.pollEvents({ since, kinds: kindsParam, wait: 0, limit });
  const failure = eventsFailure(page, client);
  if (failure) return failure;
  const parsed = parsePollPage(page);
  const nextSeq = parsed.next_seq ?? maxSeq(parsed.events) ?? since;
  const gap = gapOf(parsed.frames);
  return {
    ok: true,
    events: parsed.events,
    count: parsed.events.length,
    next_seq: nextSeq ?? null,
    last_seq: parsed.last_seq ?? null,
    since: parsed.since ?? since ?? null,
    window,
    truncated: parsed.truncated,
    kinds: kinds.length > 0 ? kinds : "all",
    ...(gap !== undefined ? { gap } : {}),
    hint:
      "Pass next_seq as `since` to summer_wait_for_event BEFORE triggering the action you will wait on, or back to this tool to read what arrived since. " +
      "The engine retains 512 events / 10 minutes — an empty result is not proof nothing happened earlier." +
      (parsed.truncated ? " truncated:true — this page was full; pass next_seq back as since for the rest." : ""),
  };
}
