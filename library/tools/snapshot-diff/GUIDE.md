# summer_snapshot_diff

Diff two world snapshots into exactly what changed: added/removed node paths, changed nodes with the fields that moved (pos, scale, material fingerprint, ...), and per-class count deltas. Reads like a receipt — no wading through two full dumps.

Standard use: take summer_world_snapshot BEFORE a mutation batch, mutate, then call this with from_id (to_id omitted = the engine takes a fresh snapshot now). Verify the diff matches your INTENT: exactly the nodes you meant to add were added, nothing you didn't touch changed, nothing vanished. An empty diff after a "successful" mutation is a red flag — the change did not land (wrong scene? unsaved? unowned nodes dropped on save?).

The engine retains the last 8 snapshot ids per session; an expired/unknown id fails with failure_reason "unknown_snapshot" — take a fresh baseline and re-run the mutation check rather than guessing.
