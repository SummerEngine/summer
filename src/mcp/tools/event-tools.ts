import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withEngine } from "./with-engine.js";
import { missingEngineEventsResult } from "../../core/capability-skew.js";
import {
  EVENT_KINDS_V1,
  recentEvents,
  recentEventsArgsSchema,
  waitForEvent,
  waitForEventArgsSchema,
} from "../../core/capabilities/events.js";

/**
 * Events channel tools. The engine pushes moments (op terminal, save, play,
 * script error) on GET /api/events; these tools consume the long-poll fallback
 * so an agent can WAIT for a moment instead of sleeping and re-polling state.
 * Implementation lives in core/capabilities/events.ts (shared with the CLI
 * dispatcher and `summer events`); this file is the MCP face only.
 *
 * Whether the build has the channel is decided BEFORE anything is sent:
 * missingEngineEventsResult returns a structured engine_lacks_events result
 * when /api/health lacks capabilities.events (a capability, not an op — so it
 * is not part of the op pre-flight or CLI_KNOWN_OP_NEEDS).
 */
export function registerEventTools(server: McpServer): void {
  server.tool(
    "summer_wait_for_event",
    `Block until the engine emits a matching EVENT, or a bounded timeout elapses — the replacement for sleeping and re-polling. Use it right after summer_play to wait for play.started (the game actually booting), after a long op (import, script, save) to wait for op.applied / op.failed by requestId instead of guessing a delay, and during a playtest to catch script.error the moment it fires.

Event kinds (v1): ${EVENT_KINDS_V1.join(", ")}. Each event is {seq, kind, ts, data}; seq is a monotonic cursor.

CURSOR DISCIPLINE: events are delivered live from \`since\` (omitted = from now). An event that fired BEFORE this call is NOT delivered, so when the moment may come fast, take a cursor first: summer_recent_events returns next_seq — pass it as since BEFORE triggering the action (summer_recent_events -> summer_play -> summer_wait_for_event since:<next_seq> kinds:['play.started']). Every result carries next_seq: pass it as since on the next call to keep waiting with no gap.

match.requestId narrows op.applied / op.failed to one request (other kinds pass through). The call long-polls the engine in slices of at most 25 s until a match or timeout_seconds (default 30, max 120) elapses.

Returns {ok, matched, events, next_seq, since, timed_out, waited_ms, polls}. timed_out:true means NO matching event arrived — it is not evidence the thing did not happen (verify with summer_is_running / summer_get_diagnostics) and you must never claim an event you did not receive. A \`gap\` field means events between since and the oldest retained were evicted — re-read state instead of trusting the stream. On an engine build without the events channel (no capabilities.events in /api/health) the result is a structured engine_lacks_events failure and nothing is sent: fall back to polling the state.`,
    waitForEventArgsSchema.shape,
    async (args) =>
      withEngine(async (client) => {
        const missing = missingEngineEventsResult(client);
        if (missing) return missing;
        return waitForEvent(client, args);
      })
  );

  server.tool(
    "summer_recent_events",
    `Read the newest engine events in ONE zero-wait poll — what just happened (saves, plays, op receipts, script errors, imports, selection) and, above all, the CURSOR: its next_seq is the \`since\` to hand summer_wait_for_event BEFORE you trigger the action you will wait on.

since omitted = the newest \`limit\` sequence numbers (a kinds filter applies inside that window, so fewer may come back). since:0 = the whole retained ring from the oldest, paged — pass next_seq back as since while truncated is true. since:N = everything after N.

Each event is {seq, kind, ts, data}; kinds (v1): ${EVENT_KINDS_V1.join(", ")}. The engine retains 512 events / 10 minutes — older history is gone, so an empty result is not proof nothing happened earlier. Payloads over 4 KB arrive clamped with truncated:true inside data. On an engine build without the events channel the result is a structured engine_lacks_events failure (nothing sent).`,
    recentEventsArgsSchema.shape,
    async (args) =>
      withEngine(async (client) => {
        const missing = missingEngineEventsResult(client);
        if (missing) return missing;
        return recentEvents(client, args);
      })
  );
}
