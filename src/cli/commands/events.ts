/**
 * summer events — the shell face of the engine events channel.
 *
 *   summer events                       the newest events (one zero-wait read)
 *   summer events --follow              stream events until Ctrl-C
 *   summer events --kinds play.started,script.error --since 120 --json
 *
 * Streams through the SAME long-poll route the MCP tools use
 * (core/capabilities/events.ts over GET /api/events/poll, slices <= 25 s, the
 * engine's next_seq fed back as `since` so nothing between polls is skipped).
 * The engine also serves SSE on GET /api/events; consuming it here is a
 * follow-up — the poll loop is the portable route through every host and
 * proxy, and the output is identical.
 *
 * Output: one line per event. JSON ({seq, kind, ts, data}) when --json is set
 * or stdout is not a TTY; a readable `time  #seq  kind  data` line otherwise.
 * Engines without the channel print the structured engine_lacks_events
 * receipt (the same one `summer tool wait-for-event` prints) and exit 1.
 */
import { Command } from "commander";
import {
  createDefaultDispatchContext,
} from "../../core/capabilities/tool-dispatch.js";
import { missingEngineEventsResult } from "../../core/capability-skew.js";
import {
  PACING_MS,
  POLL_SLICE_MS,
  RECENT_LIMIT_CAP,
  RECENT_LIMIT_DEFAULT,
  eventsFailure,
  normalizeKinds,
  parsePollPage,
  recentEvents,
  type EngineEvent,
  type EventsClient,
  type EventsFrame,
} from "../../core/capabilities/events.js";

export interface EventsCommandOptions {
  follow?: boolean;
  kinds?: string;
  since?: string;
  limit?: string;
  json?: boolean;
}

/** Everything runEvents touches outside its arguments — injected so tests
 *  run the command against a scripted engine and capture its lines. */
export interface EventsIo {
  engine(): Promise<EventsClient>;
  out(line: string): void;
  err(line: string): void;
  isTTY: boolean;
  /** --follow: consulted after every poll; return true to stop (tests). The
   *  real command never stops — Ctrl-C ends it. */
  shouldStop?: (state: { polls: number; printed: number }) => boolean;
  /** --follow: per-poll hold (default POLL_SLICE_MS). */
  pollWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function parseKindsOption(raw: string | undefined): string[] {
  return normalizeKinds(raw ? raw.split(",") : []);
}

export function parseSinceOption(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `--since must be a non-negative integer sequence number, got "${raw}". Recovery: pass the next_seq printed by a previous run, or 0 to replay the retained ring.`
    );
  }
  return value;
}

export function parseLimitOption(raw: string | undefined): number {
  if (raw === undefined) return RECENT_LIMIT_DEFAULT;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1 || value > RECENT_LIMIT_CAP) {
    throw new Error(
      `--limit must be a whole number from 1 through ${RECENT_LIMIT_CAP}, got "${raw}".`
    );
  }
  return value;
}

const TTY_DATA_MAX_CHARS = 300;

function clockOf(ts: number | undefined): string {
  if (ts === undefined) return "--:--:--.---";
  return new Date(ts).toISOString().slice(11, 23);
}

/** One event as a line: JSON verbatim, or `time  #seq  kind  data` for a TTY
 *  (data compacted and truncated so the terminal stays scannable). */
export function formatEventLine(event: EngineEvent, json: boolean): string {
  if (json) return JSON.stringify(event);
  let data = event.data === undefined ? "" : JSON.stringify(event.data);
  if (data.length > TTY_DATA_MAX_CHARS) data = `${data.slice(0, TTY_DATA_MAX_CHARS - 1)}…`;
  return `${clockOf(event.ts)}  #${event.seq}  ${event.kind}${data ? `  ${data}` : ""}`;
}

/** A sys.* transport frame (sys.gap / sys.closed) as a line. */
export function formatFrameLine(frame: EventsFrame, json: boolean): string {
  if (json) return JSON.stringify(frame);
  const data = frame.data === undefined ? "" : `  ${JSON.stringify(frame.data)}`;
  return `${clockOf(undefined)}  #-  ${frame.kind}${data}`;
}

function maxSeq(events: readonly EngineEvent[]): number | undefined {
  let max: number | undefined;
  for (const event of events) if (max === undefined || event.seq > max) max = event.seq;
  return max;
}

/** Run the command; returns the process exit code (0 ok, 1 structured failure). */
export async function runEvents(opts: EventsCommandOptions, io: EventsIo): Promise<number> {
  const kinds = parseKindsOption(opts.kinds);
  const since = parseSinceOption(opts.since);
  const limit = parseLimitOption(opts.limit);
  const json = opts.json === true || !io.isTTY;
  const kindsParam = kinds.length > 0 ? kinds : undefined;

  const client = await io.engine();
  const missing = missingEngineEventsResult(client);
  if (missing) {
    io.out(JSON.stringify(missing, null, 2));
    return 1;
  }

  if (!opts.follow) {
    const result = await recentEvents(client, { since, kinds: kindsParam, limit });
    if (result.ok === false) {
      io.out(JSON.stringify(result, null, 2));
      return 1;
    }
    for (const event of result.events) io.out(formatEventLine(event, json));
    if (!json) {
      io.err(
        `${result.count} event(s)${result.truncated ? " (page full — more remain)" : ""}; next_seq ${result.next_seq ?? "?"}. ` +
          `Stream live: summer events --follow${result.next_seq !== null ? ` --since ${result.next_seq}` : ""}`
      );
    }
    return 0;
  }

  const wait = io.pollWaitMs ?? POLL_SLICE_MS;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = io.now ?? (() => Date.now());
  if (!json) {
    io.err(
      `Following engine events${kinds.length > 0 ? ` (${kinds.join(", ")})` : ""}${since !== undefined ? ` from seq ${since}` : " from now"} — Ctrl-C to stop.`
    );
  }
  let cursor = since;
  let polls = 0;
  let printed = 0;
  for (;;) {
    const pollStart = now();
    const page = await client.pollEvents({ since: cursor, kinds: kindsParam, wait, limit: RECENT_LIMIT_CAP });
    const held = now() - pollStart;
    polls += 1;
    const failure = eventsFailure(page, client);
    if (failure) {
      io.out(JSON.stringify(failure, null, 2));
      return 1;
    }
    const parsed = parsePollPage(page);
    for (const frame of parsed.frames) io.out(formatFrameLine(frame, json));
    for (const event of parsed.events) {
      io.out(formatEventLine(event, json));
      printed += 1;
    }
    const advanced = parsed.next_seq ?? maxSeq(parsed.events);
    if (advanced !== undefined) cursor = advanced;
    if (io.shouldStop?.({ polls, printed })) return 0;
    // An engine that answers a held poll early with nothing must not spin us.
    if (parsed.events.length === 0 && held < wait) await sleep(Math.min(PACING_MS, wait - held));
  }
}

function defaultIo(): EventsIo {
  const ctx = createDefaultDispatchContext();
  return {
    engine: () => ctx.engine(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    isTTY: process.stdout.isTTY === true,
  };
}

export const eventsCommand = new Command("events")
  .description("Print recent engine events, or --follow them live (one line per event; JSON when piped)")
  .option("--follow", "Keep streaming events until Ctrl-C (long-poll loop over /api/events/poll)")
  .option("--kinds <csv>", "Comma-separated event kinds, e.g. play.started,script.error (default: all)")
  .option(
    "--since <seq>",
    "Start after this sequence number (0 = replay the retained ring). Default: the newest events, or live from now with --follow"
  )
  .option("--limit <n>", `Events to print without --follow (default ${RECENT_LIMIT_DEFAULT}, max ${RECENT_LIMIT_CAP})`)
  .option("--json", "One JSON object per line (automatic when stdout is not a TTY)")
  .action(async (opts: EventsCommandOptions) => {
    const code = await runEvents(opts, defaultIo());
    if (code !== 0) process.exitCode = code;
  });
