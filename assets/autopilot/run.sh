#!/usr/bin/env bash
# Run the autopilot against this project and print the results.
#
#   bash tests/autopilot/run.sh                    # runs autopilot.gd
#   bash tests/autopilot/run.sh my_probe.gd        # runs a different probe
#   bash tests/autopilot/run.sh --reimport         # rebuild the .godot/ caches first
#
# First run on a fresh checkout: the engine's standard editor import runs once,
# headless, to build the .godot/ caches a never-opened project does not have —
# imported textures/fonts/audio/models, uid_cache.bin, global_script_class_cache.cfg.
# Without them the game boots into "Unable to open file ...ctex", "invalid UID" and
# "Could not find type" errors that are not bugs in your game. The pass is skipped
# once .godot/global_script_class_cache.cfg exists; --reimport forces it.
#
# The verify run itself needs no editor. It spawns the engine's offscreen verify
# instance, which has a REAL renderer — unlike --headless, which produces no pixels
# at all (fine for importing, useless for frames).
#
# Exit code: 0 when the probe finished, every configured waypoint was reached and the
# engine logged no ERROR / SCRIPT ERROR. WARNINGs are printed and counted, not failed.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROBE="$PROJECT_DIR/tests/autopilot/autopilot.gd"
REIMPORT=0
for arg in "$@"; do
  case "$arg" in
    --reimport) REIMPORT=1 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) PROBE="$arg" ;;
  esac
done
OUT="$PROJECT_DIR/tests/autopilot/out"
MAX_SECONDS="${MAX_SECONDS:-40}"
IMPORT_MAX_SECONDS="${IMPORT_MAX_SECONDS:-300}"

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

# ── Import pre-pass ───────────────────────────────────────────────────────────────
# `--import` is Godot's own "start the editor, import everything, quit" mode; Summer
# is an editor build, so it is available. --headless keeps it off your screen. It
# reads and writes only this project (.godot/, and any missing *.import files),
# needs no network, and is bounded by IMPORT_MAX_SECONDS. While it runs, the engine
# registers itself in ~/.summer/instances/ like any instance (publishesGlobal:false,
# so it never hijacks a running editor) and removes that entry on exit. Only a
# watchdog kill can leave the entry behind; the next engine start reaps it.
CLASS_CACHE="$PROJECT_DIR/.godot/global_script_class_cache.cfg"
if [[ "$REIMPORT" == 1 || ! -f "$CLASS_CACHE" ]]; then
  if [[ "$REIMPORT" == 1 ]]; then
    echo "Importing assets (--reimport) ..."
  else
    echo "Importing assets (first run on this checkout: building .godot/ caches) ..."
  fi
  import_started=$SECONDS
  "$ENGINE" --headless --import --disable-crash-handler --path "$PROJECT_DIR" \
    >"$OUT/import.log" 2>&1 &
  import_pid=$!
  import_timed_out=0
  while kill -0 "$import_pid" 2>/dev/null; do
    if (( SECONDS - import_started >= IMPORT_MAX_SECONDS )); then
      kill "$import_pid" 2>/dev/null || true
      sleep 2
      kill -9 "$import_pid" 2>/dev/null || true
      import_timed_out=1
      break
    fi
    sleep 1
  done
  import_rc=0
  wait "$import_pid" || import_rc=$?
  if [[ "$import_timed_out" == 1 ]]; then
    echo "FAILED: asset import did not finish within ${IMPORT_MAX_SECONDS}s (raise IMPORT_MAX_SECONDS). Log: $OUT/import.log" >&2
    tail -20 "$OUT/import.log" >&2
    exit 1
  fi
  if [[ ! -f "$CLASS_CACHE" ]]; then
    echo "FAILED: asset import exited $import_rc without writing .godot/global_script_class_cache.cfg. Log: $OUT/import.log" >&2
    tail -20 "$OUT/import.log" >&2
    exit 1
  fi
  imported_files=$(find "$PROJECT_DIR/.godot/imported" -type f 2>/dev/null | wc -l | tr -d ' ')
  echo "Imported: ${imported_files} files under .godot/imported in $((SECONDS - import_started))s (exit ${import_rc}; log: tests/autopilot/out/import.log)"
else
  echo "Import: skipped, .godot/ caches present (pass --reimport to rebuild them)"
fi

# ── Verify run ────────────────────────────────────────────────────────────────────
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

# ── Verdict ───────────────────────────────────────────────────────────────────────
# Every errors_seen entry is one line the engine's SummerVerifyLogger::log_error wrote
# (modules/1summer_engine/verify/summer_verify_logger.cpp), shaped exactly
#
#     LEVEL|file:line|function|code|rationale
#
# where LEVEL is core/io/logger.h error_type_string(): ERROR, WARNING, SCRIPT ERROR
# or SHADER ERROR. The logger records every level, so a run can be "red" on nothing
# but warnings; only WARNING is downgraded here. Anything else — including a level
# this script has never seen — fails the run.
#
# finished:false means the probe hit its time ceiling before calling finish(). That
# is a failure, not a pass. So is any configured waypoint the autopilot missed.
if command -v python3 >/dev/null 2>&1; then
  python3 - "$OUT/results.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
reports = d.get("reports", {})
errors, warnings = [], []
for line in d.get("errors_seen", []):
    (warnings if line.split("|", 1)[0] == "WARNING" else errors).append(line)

def show(lines, limit=10):
    for l in lines[:limit]:
        print(f"  {l}", file=sys.stderr)
    if len(lines) > limit:
        print(f"  ... {len(lines) - limit} more in results.json", file=sys.stderr)

if warnings:
    print(f"WARNINGS: {len(warnings)} engine warning(s) during the run (not failures):", file=sys.stderr)
    show(warnings)
if not d.get("finished", False):
    print("FAILED: probe did not finish (hit --summer-verify-max)", file=sys.stderr)
    sys.exit(1)
if errors:
    print(f"FAILED: {len(errors)} engine error(s) during the run:", file=sys.stderr)
    show(errors)
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
reached = sum(1 for k, v in reports.items() if k.endswith("_reached") and v is True)
what = "smoke test: booted and ran" if reports.get("smoke") else f"{reached} waypoint(s) reached"
print(f"PASSED: {what}, {len(d.get('frames', []))} frame(s), 0 errors, {len(warnings)} warning(s)")
PY
else
  # No python3 (Git Bash on Windows, minimal containers). Coarse line-based reading
  # of the same file: Godot pretty-prints results.json one array element / key per
  # line, so the LEVEL prefix and the report keys are greppable. Fail closed.
  echo "python3 not found: using a coarse shell reading of results.json"
  n_err=$(grep -cE '^[[:space:]]*"(ERROR|SCRIPT ERROR|SHADER ERROR)\|' "$OUT/results.json" || true)
  n_warn=$(grep -cE '^[[:space:]]*"WARNING\|' "$OUT/results.json" || true)
  if (( n_warn > 0 )); then
    echo "WARNINGS: ${n_warn} engine warning(s) during the run (not failures)" >&2
  fi
  if ! grep -qE '^[[:space:]]*"finished": true' "$OUT/results.json"; then
    echo "FAILED: probe did not finish (hit --summer-verify-max)" >&2
    exit 1
  fi
  if (( n_err > 0 )); then
    echo "FAILED: ${n_err} engine error(s) during the run" >&2
    exit 1
  fi
  if grep -qE '^[[:space:]]*"error": ' "$OUT/results.json"; then
    echo "FAILED: probe reported an error (reports.error). Edit the CONFIG block at the top of tests/autopilot/autopilot.gd." >&2
    exit 1
  fi
  if grep -qE '_reached": false' "$OUT/results.json"; then
    echo "FAILED: waypoints not reached" >&2
    exit 1
  fi
  echo "PASSED: 0 errors, ${n_warn} warning(s)"
fi
