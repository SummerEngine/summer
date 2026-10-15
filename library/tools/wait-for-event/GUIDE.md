# summer_wait_for_event

Block until the engine emits a matching EVENT, or a bounded timeout elapses — the replacement for sleeping and re-polling. Use it right after summer_play to wait for play.started (the game actually booting), after a long op (import, script, save) to wait for op.applied / op.failed by requestId instead of guessing a delay, and during a playtest to catch script.error the moment it fires.

Event kinds (v1): op.applied, op.failed, script.error, play.started, play.stopped, scene.saved, scene.opened, import.completed, selection.changed, snapshot.published. Each event is {seq, kind, ts, data}; seq is a monotonic cursor.

CURSOR DISCIPLINE: events are delivered live from `since` (omitted = from now). An event that fired BEFORE this call is NOT delivered, so when the moment may come fast, take a cursor first: summer_recent_events returns next_seq — pass it as since BEFORE triggering the action (summer_recent_events -> summer_play -> summer_wait_for_event since:<next_seq> kinds:['play.started']). Every result carries next_seq: pass it as since on the next call to keep waiting with no gap.

match.requestId narrows op.applied / op.failed to one request (other kinds pass through). The call long-polls the engine in slices of at most 25 s until a match or timeout_seconds (default 30, max 120) elapses.

Returns {ok, matched, events, next_seq, since, timed_out, waited_ms, polls}. timed_out:true means NO matching event arrived — it is not evidence the thing did not happen (verify with summer_is_running / summer_get_diagnostics) and you must never claim an event you did not receive. A `gap` field means events between since and the oldest retained were evicted — re-read state instead of trusting the stream. On an engine build without the events channel (no capabilities.events in /api/health) the result is a structured engine_lacks_events failure and nothing is sent: fall back to polling the state.
