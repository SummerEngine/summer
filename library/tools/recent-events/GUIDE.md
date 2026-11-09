# summer_recent_events

Read the newest engine events in ONE zero-wait poll — what just happened (saves, plays, op receipts, script errors, imports, selection) and, above all, the CURSOR: its next_seq is the `since` to hand summer_wait_for_event BEFORE you trigger the action you will wait on.

since omitted = the newest `limit` sequence numbers (a kinds filter applies inside that window, so fewer may come back). since:0 = the whole retained ring from the oldest, paged — pass next_seq back as since while truncated is true. since:N = everything after N.

Each event is {seq, kind, ts, data}; kinds (v1): op.applied, op.failed, script.error, play.started, play.stopped, scene.saved, scene.opened, import.completed, selection.changed, snapshot.published. The engine retains 512 events / 10 minutes — older history is gone, so an empty result is not proof nothing happened earlier. Payloads over 4 KB arrive clamped with truncated:true inside data. On an engine build without the events channel the result is a structured engine_lacks_events failure (nothing sent).
