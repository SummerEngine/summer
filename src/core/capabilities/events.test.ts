import { describe, expect, it, vi } from "vitest";
import {
  EVENT_KINDS_V1,
  PACING_MS,
  POLL_LIMIT_CAP,
  POLL_SLICE_MS,
  RECENT_LIMIT_CAP,
  WAIT_MAX_EVENTS_DEFAULT,
  WAIT_MAX_SECONDS,
  eventsFailure,
  normalizeKinds,
  parsePollPage,
  recentEvents,
  selectMatches,
  unknownKindsFailure,
  waitForEvent,
  type EventsClient,
} from "./events.js";

type Page = Record<string, unknown> & {
  /** Test-only: how long the fake engine "held" the request (default: the
   *  requested wait, i.e. a genuinely held long-poll). */
  hold?: number;
};

const WITH_CHANNEL = { events: { kinds: [...EVENT_KINDS_V1], ring: 512 } };

/**
 * Scripted engine: answers pages in order (the last one repeats), advancing a
 * fake clock by the requested `wait` per poll unless the page names its own
 * `hold`. Records every pollEvents call.
 */
function scripted(pages: Page[], capabilities: unknown = WITH_CHANNEL) {
  const calls: Array<Record<string, unknown>> = [];
  const sleeps: number[] = [];
  let clock = 1_000_000;
  let index = 0;
  const client: EventsClient = {
    getEngineCapabilities: () => capabilities as never,
    getEngineVersion: () => "0.6.0",
    async pollEvents(params) {
      const request = { ...(params ?? {}) };
      calls.push(request);
      const page = pages[Math.min(index, pages.length - 1)]!;
      index += 1;
      clock += page.hold ?? (typeof request.wait === "number" ? request.wait : 0);
      const { hold: _hold, ...answer } = page;
      return answer;
    },
  };
  const deps = {
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
  };
  return { client, calls, sleeps, deps };
}

const idle = (next_seq: number): Page => ({ ok: true, events: [], next_seq, last_seq: next_seq, since: next_seq, timed_out: true });

describe("waitForEvent", () => {
  it("returns on the first matching event and feeds the engine's next_seq back as since", async () => {
    const { client, calls, deps } = scripted([
      idle(41),
      {
        ok: true,
        events: [{ seq: 42, kind: "play.started", ts: 1_700_000_000_000, data: { scene: "res://main.tscn", by: "agent" } }],
        next_seq: 42,
        timed_out: false,
        hold: 900,
      },
    ]);
    const result = await waitForEvent(client, { kinds: ["play.started"] }, deps);
    expect(result).toMatchObject({
      ok: true,
      matched: true,
      timed_out: false,
      polls: 2,
      next_seq: 42,
      since: 41,
      kinds: ["play.started"],
    });
    expect((result as { events: unknown[] }).events).toEqual([
      { seq: 42, kind: "play.started", ts: 1_700_000_000_000, data: { scene: "res://main.tscn", by: "agent" } },
    ]);
    // First poll: live from now (no since); every later poll chains next_seq.
    expect(calls[0]).toEqual({ since: undefined, kinds: ["play.started"], wait: POLL_SLICE_MS, limit: WAIT_MAX_EVENTS_DEFAULT });
    expect(calls[1]!.since).toBe(41);
  });

  it("filters op.* events by match.requestId and lets other kinds through", async () => {
    const { client, deps } = scripted([
      { ok: true, events: [{ seq: 5, kind: "op.applied", data: { requestId: "r1", kind: "SaveScene" } }], next_seq: 5, hold: 10 },
      {
        ok: true,
        events: [
          { seq: 6, kind: "op.applied", data: { requestId: "r1" } },
          { seq: 7, kind: "script.error", data: { path: "res://a.gd", line: 3, message: "boom" } },
          { seq: 8, kind: "op.failed", data: { requestId: "r2", failure_reason: "timeout" } },
        ],
        next_seq: 8,
        hold: 10,
      },
    ]);
    const result = await waitForEvent(
      client,
      { kinds: ["op.applied", "op.failed", "script.error"], match: { requestId: "r2" } },
      deps
    );
    expect(result).toMatchObject({ matched: true, polls: 2, match: { requestId: "r2" } });
    expect((result as { events: Array<{ seq: number }> }).events.map((event) => event.seq)).toEqual([7, 8]);
  });

  it("reports a timeout honestly: no events, timed_out true, cursor kept, slices <= 25 s", async () => {
    const { client, calls, deps } = scripted([idle(7)]);
    const result = await waitForEvent(client, { kinds: ["play.started"], timeout_seconds: 60 }, deps);
    expect(result).toMatchObject({
      ok: true,
      matched: false,
      events: [],
      timed_out: true,
      next_seq: 7,
      waited_ms: 60_000,
      polls: 3,
    });
    expect(String((result as { hint: string }).hint)).toContain("not evidence");
    expect(calls.map((call) => call.wait)).toEqual([25_000, 25_000, 10_000]);
    for (const call of calls) expect(call.wait as number).toBeLessThanOrEqual(POLL_SLICE_MS);
  });

  it("clamps timeout_seconds to 1..120 and max_events to the engine's limit cap", async () => {
    const long = scripted([idle(1)]);
    const longResult = await waitForEvent(long.client, { timeout_seconds: 999, max_events: 99_999 }, long.deps);
    expect(longResult).toMatchObject({ timed_out: true, waited_ms: WAIT_MAX_SECONDS * 1000 });
    expect(long.calls[0]!.limit).toBe(POLL_LIMIT_CAP);
    expect(long.calls[0]!.kinds).toBeUndefined();
    expect((longResult as { kinds: unknown }).kinds).toBe("all");

    const short = scripted([idle(1)]);
    await waitForEvent(short.client, { timeout_seconds: 0 }, short.deps);
    expect(short.calls).toHaveLength(1);
    expect(short.calls[0]!.wait).toBe(1000);
  });

  it("refuses an event kind the engine does not emit BEFORE sending, when the engine advertises its kinds", async () => {
    const { client, calls, deps } = scripted([idle(1)]);
    const result = await waitForEvent(client, { kinds: ["play.begun", "play.started"] }, deps);
    expect(result).toMatchObject({
      ok: false,
      failure_reason: "unknown_event_kind",
      unknown_kinds: ["play.begun"],
    });
    expect(String((result as { error: string }).error)).toContain("play.begun");
    expect(calls).toEqual([]);
  });

  it("lets unknown kinds through when the engine advertises the channel without a kinds list (forward-compatible)", async () => {
    const { client, calls, deps } = scripted(
      [{ ok: true, events: [{ seq: 1, kind: "future.kind" }], next_seq: 1, hold: 5 }],
      { events: {} }
    );
    const result = await waitForEvent(client, { kinds: ["future.kind"] }, deps);
    expect(result).toMatchObject({ matched: true });
    expect(calls).toHaveLength(1);
  });

  it("rewrites an HTTP 404 answer (pre-flight off, no channel) into engine_lacks_events", async () => {
    const { client, deps } = scripted([{ ok: false, http_status: 404, error: "Engine API error 404: not found" }]);
    const result = await waitForEvent(client, {}, deps);
    expect(result).toMatchObject({
      ok: false,
      failure_reason: "engine_lacks_events",
      engine_version: "0.6.0",
      http_status: 404,
    });
    expect(String((result as { error: string }).error)).toContain("HTTP 404");
    expect(String((result as { hint: string }).hint)).toContain("summer_is_running");
  });

  it("passes a structured 409 identity_mismatch through unchanged (the faces classify terminalState)", async () => {
    const failure = { ok: false, http_status: 409, terminalState: "identity_mismatch", errorClass: "rejected_identity" };
    const { client, deps } = scripted([failure]);
    expect(await waitForEvent(client, {}, deps)).toEqual(failure);
  });

  it("surfaces a sys.gap frame without counting it as a match, and paces an early empty answer", async () => {
    const { client, deps, sleeps } = scripted([
      { ok: true, events: [{ kind: "sys.gap", data: { since: 5, oldest_retained: 100 } }], next_seq: 150, timed_out: false, hold: 0 },
      { ok: true, events: [{ seq: 151, kind: "scene.saved", data: { path: "res://main.tscn", by: "agent" } }], next_seq: 151, hold: 10 },
    ]);
    const result = await waitForEvent(client, { since: 5, kinds: ["scene.saved"] }, deps);
    expect(result).toMatchObject({ matched: true, since: 5, gap: { since: 5, oldest_retained: 100 }, polls: 2 });
    expect((result as { events: Array<{ seq: number }> }).events.map((event) => event.seq)).toEqual([151]);
    expect(sleeps).toEqual([PACING_MS]);
  });

  it("never spins on an engine that answers held polls instantly with nothing", async () => {
    const { client, deps, sleeps, calls } = scripted([{ ok: true, events: [], next_seq: 3, timed_out: false, hold: 0 }]);
    const result = await waitForEvent(client, { timeout_seconds: 1 }, deps);
    expect(result).toMatchObject({ timed_out: true });
    // Every poll was followed by a pacing sleep; the loop was bounded by the
    // clock, not by luck.
    expect(sleeps.length).toBe(calls.length);
    expect(calls.length).toBeLessThanOrEqual(Math.ceil(1000 / PACING_MS) + 1);
  });
});

describe("recentEvents", () => {
  it("with since omitted reads the newest `limit` sequence numbers in two zero-wait calls", async () => {
    const { client, calls } = scripted([
      { ok: true, events: [], next_seq: 130, last_seq: 130, since: 130 },
      { ok: true, events: [{ seq: 129, kind: "scene.saved" }, { seq: 130, kind: "play.started" }], next_seq: 130, last_seq: 130, since: 80 },
    ]);
    const result = await recentEvents(client, {});
    expect(calls).toEqual([
      { wait: 0, limit: 1 },
      { since: 80, kinds: undefined, wait: 0, limit: 50 },
    ]);
    expect(result).toMatchObject({ ok: true, count: 2, next_seq: 130, last_seq: 130, since: 80, window: "newest", truncated: false, kinds: "all" });
    expect(String((result as { hint: string }).hint)).toContain("next_seq");
  });

  it("with since given reads once from that cursor; since 0 pages the ring and says so when truncated", async () => {
    const one = scripted([{ ok: true, events: [{ seq: 12, kind: "op.applied" }], next_seq: 12, last_seq: 40, since: 11 }]);
    const fromCursor = await recentEvents(one.client, { since: 11, kinds: ["op.applied"], limit: 5 });
    expect(one.calls).toEqual([{ since: 11, kinds: ["op.applied"], wait: 0, limit: 5 }]);
    expect(fromCursor).toMatchObject({ window: "since", since: 11, next_seq: 12, kinds: ["op.applied"] });

    const ring = scripted([{ ok: true, events: [{ seq: 1, kind: "scene.opened" }], next_seq: 1, last_seq: 600, since: 0, truncated: true }]);
    const replay = await recentEvents(ring.client, { since: 0, limit: 1 });
    expect(replay).toMatchObject({ window: "ring", truncated: true, next_seq: 1 });
    expect(String((replay as { hint: string }).hint)).toContain("truncated:true");
  });

  it("falls back to the whole ring when the head read carries no sequence numbers", async () => {
    const { client, calls } = scripted([{ ok: true, events: [] }, { ok: true, events: [] }]);
    const result = await recentEvents(client, {});
    expect(calls[1]!.since).toBe(0);
    expect(result).toMatchObject({ window: "ring", count: 0, next_seq: 0 });
  });

  it("clamps limit to the cap, refuses unknown kinds before sending, and rewrites a 404", async () => {
    const capped = scripted([{ ok: true, events: [], last_seq: 1000 }, { ok: true, events: [] }]);
    await recentEvents(capped.client, { limit: 9999 });
    expect(capped.calls[1]!.limit).toBe(RECENT_LIMIT_CAP);
    expect(capped.calls[1]!.since).toBe(1000 - RECENT_LIMIT_CAP);

    const unknown = scripted([{ ok: true, events: [] }]);
    expect(await recentEvents(unknown.client, { kinds: ["nope"] })).toMatchObject({ failure_reason: "unknown_event_kind" });
    expect(unknown.calls).toEqual([]);

    const missing = scripted([{ ok: false, http_status: 404, error: "Engine API error 404: not found" }]);
    expect(await recentEvents(missing.client, { since: 0 })).toMatchObject({ failure_reason: "engine_lacks_events" });
  });
});

describe("events helpers", () => {
  it("normalizeKinds trims, drops empties, and dedupes in order", () => {
    expect(normalizeKinds([" play.started ", "", "scene.saved", "play.started"])).toEqual(["play.started", "scene.saved"]);
    expect(normalizeKinds(undefined)).toEqual([]);
  });

  it("parsePollPage keeps well-formed ring events, splits sys.* frames out, and tolerates junk", () => {
    const parsed = parsePollPage({
      ok: true,
      events: [
        { seq: 1, kind: "scene.saved", ts: 5, data: { path: "a" } },
        { kind: "sys.closed", data: { reason: "wait_elapsed" } },
        { seq: "2", kind: "play.started" },
        { seq: 3 },
        "garbage",
        null,
      ],
      next_seq: 3,
      last_seq: "x",
      truncated: 1,
      timed_out: true,
    });
    expect(parsed.events).toEqual([{ seq: 1, kind: "scene.saved", ts: 5, data: { path: "a" } }]);
    expect(parsed.frames).toEqual([{ kind: "sys.closed", data: { reason: "wait_elapsed" } }]);
    expect(parsed).toMatchObject({ next_seq: 3, last_seq: undefined, truncated: false, timed_out: true });
    expect(parsePollPage(null)).toMatchObject({ events: [], frames: [], truncated: false, timed_out: false });
  });

  it("selectMatches applies requestId to op.* only", () => {
    const events = [
      { seq: 1, kind: "op.applied", data: { requestId: "a" } },
      { seq: 2, kind: "op.failed", data: { requestId: "b" } },
      { seq: 3, kind: "play.started" },
    ];
    expect(selectMatches(events).map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(selectMatches(events, "b").map((event) => event.seq)).toEqual([2, 3]);
  });

  it("unknownKindsFailure is decidable only with an advertised kinds list", () => {
    expect(unknownKindsFailure(["x"], {})).toBeNull();
    expect(unknownKindsFailure(["x"], { getEngineCapabilities: () => ({ events: {} }) })).toBeNull();
    expect(unknownKindsFailure(["x"], { getEngineCapabilities: () => ({ events: { kinds: ["x"] } }) })).toBeNull();
    expect(
      unknownKindsFailure(["x", "y"], { getEngineCapabilities: () => ({ events: { kinds: ["x"] } }) })
    ).toMatchObject({ failure_reason: "unknown_event_kind", unknown_kinds: ["y"], known_kinds: ["x"] });
  });

  it("eventsFailure classifies non-object bodies and leaves 2xx envelopes alone", () => {
    const client = { getEngineVersion: () => "0.6.0" };
    expect(eventsFailure("nope", client)).toMatchObject({ ok: false, failure_reason: "malformed_events_envelope" });
    expect(eventsFailure({ ok: true, events: [] }, client)).toBeNull();
    expect(eventsFailure({ events: [] }, client)).toBeNull();
    expect(eventsFailure({ ok: false, http_status: 503, error: "no bus" }, client)).toMatchObject({ http_status: 503 });
  });

  it("sleep default is only reached when the fake clock is not injected (smoke)", async () => {
    const pollEvents = vi.fn().mockResolvedValue({ ok: true, events: [{ seq: 1, kind: "play.started" }], next_seq: 1 });
    const result = await waitForEvent(
      { pollEvents, getEngineCapabilities: () => ({ events: {} }) },
      { kinds: ["play.started"], timeout_seconds: 1 }
    );
    expect(result).toMatchObject({ matched: true, polls: 1 });
  });
});
