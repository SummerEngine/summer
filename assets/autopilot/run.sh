#!/usr/bin/env bash
# Run the autopilot against this project and print the results.
#
#   bash tests/autopilot/run.sh                    # runs autopilot.gd
#   bash tests/autopilot/run.sh my_probe.gd        # runs a different probe
#
# No editor required. This spawns the engine's offscreen verify instance, which
# has a REAL renderer — unlike --headless, which produces no pixels at all.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROBE="${1:-$PROJECT_DIR/tests/autopilot/autopilot.gd}"
OUT="$PROJECT_DIR/tests/autopilot/out"
MAX_SECONDS="${MAX_SECONDS:-40}"

# Find the engine. Override with SUMMER_BIN=/path/to/engine if it lives elsewhere.
# There is no `godot` binary on a Summer install — do not substitute one.
if [[ -n "${SUMMER_BIN:-}" ]]; then
  ENGINE="$SUMMER_BIN"
elif [[ -x "/Applications/Summer.app/Contents/MacOS/Summer" ]]; then
  ENGINE="/Applications/Summer.app/Contents/MacOS/Summer"
elif [[ -x "${LOCALAPPDATA:-}/Summer/current/Summer.exe" ]]; then
  ENGINE="${LOCALAPPDATA}/Summer/current/Summer.exe"
else
  echo "Could not find the Summer engine binary." >&2
  echo "Set SUMMER_BIN, or read engineBinaryPath from summer_get_project_context." >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT"

# --disable-crash-handler: Summer's handler popen()s atos from inside a signal
# handler, which turns a clean failure into a hang. Never arm it on an
# agent-driven run. Note there is deliberately no --headless here: headless has
# no renderer, so save_frame() would produce nothing.
"$ENGINE" \
  --disable-crash-handler \
  --path "$PROJECT_DIR" \
  --summer-verify "$PROBE" \
  --summer-verify-out "$OUT" \
  --summer-verify-max "$MAX_SECONDS" \
  >"$OUT/engine.log" 2>&1 || true

if [[ ! -f "$OUT/results.json" ]]; then
  echo "No results.json — the probe never started. Engine output:" >&2
  tail -30 "$OUT/engine.log" >&2
  exit 1
fi

cat "$OUT/results.json"
echo
echo "Frames and full log: $OUT"

# finished:false means the probe hit its time ceiling before calling finish().
# That is a failure, not a pass — exit non-zero so CI notices.
if command -v python3 >/dev/null 2>&1; then
  python3 - "$OUT/results.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
reports = d.get("reports", {})
if not d.get("finished", False):
    print("FAILED: probe did not finish (hit --summer-verify-max)", file=sys.stderr)
    sys.exit(1)
if d.get("errors_seen"):
    print(f"FAILED: {len(d['errors_seen'])} engine error(s) during the run", file=sys.stderr)
    sys.exit(1)
if reports.get("error"):
    print(f"FAILED: {reports['error']}", file=sys.stderr)
    print("Edit the CONFIG block at the top of tests/autopilot/autopilot.gd.", file=sys.stderr)
    sys.exit(1)
# Any waypoint the autopilot could not reach is a failure, whatever else passed.
missed = [k for k, v in reports.items() if k.endswith("_reached") and v is False]
if missed:
    print(f"FAILED: waypoints not reached: {', '.join(sorted(missed))}", file=sys.stderr)
    sys.exit(1)
PY
fi
