import { describe, expect, it } from "vitest";
import {
  eventsCommand,
  formatEventLine,
  formatFrameLine,
  parseKindsOption,
  parseLimitOption,
  parseSinceOption,
  runEvents,
  type EventsIo,
} from "./events.js";
import { EVENT_KINDS_V1, POLL_SLICE_MS, RECENT_LIMIT_CAP } from "../../core/capabilities/events.js";
import type { EventsClient } from "../../core/capabilities/events.js";

const WITH_CHANNEL = { events: { kinds: [...EVENT_KINDS_V1], ring: 512 } };

type Page = Record<string, unknown>;

function scriptedIo(
  pages: Page[],
  options: { capabilities?: unknown; isTTY?: boolean; stopAfterPolls?: number } = {}
): { io: EventsIo; out: string[]; err: string[]; calls: Array<Record<string, unknown>> } {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Array<Record<string, unknown>> = [];
  let index = 0;
  let clock = 0;
  const client: EventsClient = {
    getEngineCapabilities: () => (options.capabilities === undefined ? WITH_CHANNEL : options.capabilities) as never,
    getEngineVersion: () => "0.6.0",
    async pollEvents(params) {
      const request = { ...(params ?? {}) };
      calls.push(request);
      const page = pages[Math.min(index, pages.length - 1)]!;
      index += 1;
      clock += typeof request.wait === "number" ? request.wait : 0;
      return page;
    },
  };
  const io: EventsIo = {
    engine: async () => client,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    isTTY: options.isTTY ?? false,
    now: () => clock,
    sleep: async () => {},
    shouldStop: options.stopAfterPolls === undefined ? undefined : ({ polls }) => polls >= options.stopAfterPolls!,
  };
  return { io, out, err, calls };
}

describe("summer events command", () => {
  it("is registered as 'events' with --follow, --kinds, --since, --limit, --json", () => {
    expect(eventsCommand.name()).toBe("events");
    const longs = eventsCommand.options.map((option) => option.long);
    expect(longs).toEqual(expect.arrayContaining(["--follow", "--kinds", "--since", "--limit", "--json"]));
    expect(eventsCommand.helpInformation()).toContain("--follow");
  });

  it("parses its options strictly", () => {
    expect(parseKindsOption(undefined)).toEqual([]);
    expect(parseKindsOption("play.started, script.error,,play.started")).toEqual(["play.started", "script.error"]);
    expect(parseSinceOption(undefined)).toBeUndefined();
    expect(parseSinceOption("0")).toBe(0);
    expect(parseSinceOption(" 42 ")).toBe(42);
    expect(() => parseSinceOption("-1")).toThrow(/non-negative integer/);
    expect(() => parseSinceOption("abc")).toThrow(/non-negative integer/);
    expect(parseLimitOption(undefined)).toBe(50);
    expect(parseLimitOption("200")).toBe(200);
    expect(() => parseLimitOption("201")).toThrow(/1 through 200/);
    expect(() => parseLimitOption("0")).toThrow(/1 through 200/);
  });

  it("formats one line per event: JSON verbatim, or time / seq / kind / data for a TTY", () => {
    const event = { seq: 42, kind: "play.started", ts: Date.UTC(2026, 8, 3, 12, 34, 56, 789), data: { scene: "res://main.tscn" } };
    expect(formatEventLine(event, true)).toBe(JSON.stringify(event));
    expect(formatEventLine(event, false)).toBe('12:34:56.789  #42  play.started  {"scene":"res://main.tscn"}');
    expect(formatEventLine({ seq: 1, kind: "play.stopped" }, false)).toBe("--:--:--.---  #1  play.stopped");
    expect(formatFrameLine({ kind: "sys.gap", data: { since: 1, oldest_retained: 9 } }, false)).toBe(
      '--:--:--.---  #-  sys.gap  {"since":1,"oldest_retained":9}'
    );
    // TTY lines truncate huge payloads; JSON never does.
    const huge = { seq: 2, kind: "script.error", data: { message: "x".repeat(1000) } };
    expect(formatEventLine(huge, false).length).toBeLessThan(400);
    expect(formatEventLine(huge, true)).toContain("x".repeat(1000));
  });

  it("prints the newest events as JSON lines when piped and exits 0", async () => {
    const { io, out, err, calls } = scriptedIo([
      { ok: true, events: [], next_seq: 60, last_seq: 60, since: 60 },
      {
        ok: true,
        events: [{ seq: 59, kind: "scene.saved", ts: 1, data: { path: "res://a.tscn", by: "agent" } }, { seq: 60, kind: "play.started", ts: 2 }],
        next_seq: 60,
        last_seq: 60,
        since: 10,
      },
    ]);
    expect(await runEvents({}, io)).toBe(0);
    expect(out.map((line) => JSON.parse(line))).toEqual([
      { seq: 59, kind: "scene.saved", ts: 1, data: { path: "res://a.tscn", by: "agent" } },
      { seq: 60, kind: "play.started", ts: 2 },
    ]);
    expect(err).toEqual([]); // JSON mode: no chatter on stderr
    expect(calls).toEqual([
      { wait: 0, limit: 1 },
      { since: 10, kinds: undefined, wait: 0, limit: 50 },
    ]);
  });

  it("on a TTY prints readable lines plus a stderr summary naming the follow command", async () => {
    const { io, out, err } = scriptedIo(
      [{ ok: true, events: [{ seq: 5, kind: "op.applied", data: { requestId: "r1" } }], next_seq: 5, last_seq: 5, since: 4 }],
      { isTTY: true }
    );
    expect(await runEvents({ since: "4", kinds: "op.applied,op.failed" }, io)).toBe(0);
    expect(out).toEqual(['--:--:--.---  #5  op.applied  {"requestId":"r1"}']);
    expect(err[0]).toContain("1 event(s)");
    expect(err[0]).toContain("summer events --follow --since 5");
  });

  it("prints the structured engine_lacks_events receipt and exits 1 on a build without the channel (nothing sent)", async () => {
    const { io, out, calls } = scriptedIo([], { capabilities: { opKinds: ["AddNode"] } });
    expect(await runEvents({ follow: true }, io)).toBe(1);
    expect(calls).toEqual([]);
    const printed = JSON.parse(out.join("\n")) as Record<string, unknown>;
    expect(printed).toMatchObject({ ok: false, failure_reason: "engine_lacks_events", engine_version: "0.6.0" });
    expect(String(printed.error)).toContain("Update Summer Engine");
  });

  it("--follow streams across polls, chains next_seq as since, and holds each poll for at most 25 s", async () => {
    const { io, out, calls } = scriptedIo(
      [
        { ok: true, events: [{ seq: 101, kind: "play.started", ts: 1 }], next_seq: 101, timed_out: false },
        { ok: true, events: [], next_seq: 101, timed_out: true },
        {
          ok: true,
          events: [
            { kind: "sys.gap", data: { since: 101, oldest_retained: 300 } },
            { seq: 301, kind: "script.error", ts: 3, data: { path: "res://a.gd", line: 7, message: "boom", source: "game" } },
          ],
          next_seq: 301,
          timed_out: false,
        },
      ],
      { stopAfterPolls: 3 }
    );
    expect(await runEvents({ follow: true, kinds: "play.started,script.error", since: "100" }, io)).toBe(0);
    expect(out.map((line) => JSON.parse(line))).toEqual([
      { seq: 101, kind: "play.started", ts: 1 },
      { kind: "sys.gap", data: { since: 101, oldest_retained: 300 } },
      { seq: 301, kind: "script.error", ts: 3, data: { path: "res://a.gd", line: 7, message: "boom", source: "game" } },
    ]);
    expect(calls.map((call) => call.since)).toEqual([100, 101, 101]);
    for (const call of calls) {
      expect(call.kinds).toEqual(["play.started", "script.error"]);
      expect(call.wait).toBe(POLL_SLICE_MS);
      expect(call.limit).toBe(RECENT_LIMIT_CAP);
    }
  });

  it("--follow stops with the structured receipt when the engine answers a 409 identity_mismatch", async () => {
    const { io, out } = scriptedIo(
      [{ ok: false, http_status: 409, terminalState: "identity_mismatch", errorClass: "rejected_identity" }],
      { stopAfterPolls: 5 }
    );
    expect(await runEvents({ follow: true }, io)).toBe(1);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ ok: false, terminalState: "identity_mismatch" });
  });
});
