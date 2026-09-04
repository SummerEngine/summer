#!/usr/bin/env bash
# MITL — model-in-the-loop eval: a real model (Claude Code, headless) drives THIS
# checkout's MCP server against a real Summer Engine editor on a pristine template
# project, then the autopilot smoke + task checks score the result.
#
#   bash evals/mitl/run.sh all                 # every task in tasks.yaml, sequentially
#   bash evals/mitl/run.sh fps-sprint-stamina  # one task
#
# Environment (all optional):
#   CLAUDE_CODE_OAUTH_TOKEN   login for the isolated HOME (from `claude setup-token`). Without it the
#                             model step records auth_missing and everything else still runs.
#   MITL_SCRATCH              scratch root (default $TMPDIR/summer-mitl). Projects go to
#                             $MITL_SCRATCH/projects/<task>, the isolated HOME is $MITL_SCRATCH/mitl-home.
#   MITL_RESULTS              results dir (default evals/mitl/results/<UTC date>)
#   MITL_MODEL                --model for claude (default: the account default)
#   MITL_MCP_ONLY=1           give the model ONLY the MCP tools (--tools ""); default keeps Claude Code's
#                             built-in tools with --permission-mode acceptEdits (Bash is denied and counted)
#   MITL_AGENT_TIMEOUT_S      wall limit for one `claude -p` (default 1500)
#   MITL_KEEP_PROJECT=1       do not delete the per-task project afterwards
#   MITL_GATE_MAX_S           how long to wait for other Summer processes to finish (default 5400)
#   MITL_ALLOW_ENGINE=1       REQUIRED for any engine launch. Without it every task stops before the
#                             baseline smoke (stage gate_refused) — the machine owner decides when
#                             engine processes may start (they can steal focus on macOS).
#   MITL_ENGINE_BIN           editor executable inside a bundle (default /Applications/Summer.app/Contents/MacOS/Summer;
#                             e.g. a posture-fixed dev build). Recorded per task with its /api/health version and
#                             capabilities.launchPostures — "offscreen" advertised = silent launch, absent = the
#                             engine WILL take focus on launch. SUMMER_BIN is honoured as a fallback name.
#
# Screen + HOME rules this script enforces (see README.md):
#   * the editor is launched by THIS script with --summer-offscreen --summer-no-publish; `summer run` is never used
#   * before EVERY engine launch (import pre-pass, verify run, editor) `pgrep -fl Summer.app/Contents/MacOS/Summer`
#     must be empty for 10 consecutive seconds; we never kill a process we did not start
#   * `claude` and the toolkit run with HOME=$MITL_SCRATCH/mitl-home; the real ~/.summer is only READ
#     (the editor writes its instance file there; we copy OUR entry into the fake HOME every 5 s)
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MITL="$REPO/evals/mitl"
LIB="$MITL/lib/mitl.mjs"
SUMMER_JS="$REPO/dist/bin/summer.js"
NODE="$(command -v node)"
SUMMER_BIN="${MITL_ENGINE_BIN:-${SUMMER_BIN:-/Applications/Summer.app/Contents/MacOS/Summer}}"
REAL_HOME="$HOME"
SCRATCH="${MITL_SCRATCH:-${TMPDIR:-/tmp}/summer-mitl}"
FAKE_HOME="$SCRATCH/mitl-home"
DATE_UTC="$(date -u +%Y-%m-%d)"
RESULTS="${MITL_RESULTS:-$MITL/results/$DATE_UTC}"
GATE_MAX_S="${MITL_GATE_MAX_S:-5400}"
PGREP_PATTERN='Summer.app/Contents/MacOS/Summer'

SEL="${1:-}"
if [[ -z "$SEL" || "$SEL" == "-h" || "$SEL" == "--help" ]]; then
  sed -n '2,/^set -/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
  exit 0
fi

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$RESULTS/run.log" >&2; }

[[ -x "$SUMMER_BIN" ]] || { echo "engine binary not found at $SUMMER_BIN (set SUMMER_BIN)" >&2; exit 1; }
[[ -f "$SUMMER_JS" ]] || { echo "no $SUMMER_JS — run 'npm run build' first" >&2; exit 1; }
command -v claude >/dev/null || { echo "claude CLI not on PATH" >&2; exit 1; }
mkdir -p "$RESULTS" "$SCRATCH/projects"

# ── isolated HOME: point Claude Code at THIS build once ──────────────────────────
if [[ ! -f "$FAKE_HOME/.claude.json" ]]; then
  mkdir -p "$FAKE_HOME"
  log "setting up isolated HOME $FAKE_HOME (summer setup claude-code --local-dev)"
  HOME="$FAKE_HOME" "$NODE" "$SUMMER_JS" setup claude-code --local-dev --yes >"$RESULTS/setup.log" 2>&1 || log "setup exited $? (see setup.log)"
fi
mkdir -p "$FAKE_HOME/.summer/instances"; chmod 700 "$FAKE_HOME/.summer"
if [[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  log "WARNING: CLAUDE_CODE_OAUTH_TOKEN is not set — the model step will record auth_missing (run 'claude setup-token' and export it)"
fi

# ── engine gate: nothing of ours or anyone else's may be running ─────────────────
# Real engine processes only: `pgrep -f` also matches shells whose command line merely
# contains the string (other agents' gate loops), so filter on the executable name.
summer_procs() {
  local p
  for p in $(pgrep -f "$PGREP_PATTERN" 2>/dev/null); do
    case "$(ps -o comm= -p "$p" 2>/dev/null)" in
      */MacOS/Summer) echo "$p $(ps -o args= -p "$p" 2>/dev/null | cut -c1-140)" ;;
    esac
  done
}
gate() {
  local why="$1" quiet=0 waited=0 procs
  if [[ "${MITL_ALLOW_ENGINE:-0}" != "1" ]]; then
    log "gate($why): refusing to launch an engine — set MITL_ALLOW_ENGINE=1 once you have the go-ahead for engine launches on this machine"
    return 1
  fi
  while true; do
    procs="$(summer_procs)"
    if [[ -n "$procs" ]]; then
      quiet=0
      if (( waited % 30 == 0 )); then log "gate($why): another Summer process is running — waiting ($waited s): $(printf '%s' "$procs" | head -3 | tr '\n' ';')"; fi
    else
      quiet=$((quiet + 1))
      (( quiet >= 10 )) && return 0
    fi
    waited=$((waited + 1))
    if (( waited >= GATE_MAX_S )); then log "gate($why): gave up after ${GATE_MAX_S}s"; return 1; fi
    sleep 1
  done
}

EDITOR_PID=""
SMOKE_PID=""
CUR_PROJECT=""
cleanup_engine() {
  if [[ -n "$EDITOR_PID" ]] && kill -0 "$EDITOR_PID" 2>/dev/null; then
    kill -TERM "$EDITOR_PID" 2>/dev/null || true
    for _ in $(seq 1 40); do kill -0 "$EDITOR_PID" 2>/dev/null || break; sleep 0.5; done
    kill -0 "$EDITOR_PID" 2>/dev/null && { kill -KILL "$EDITOR_PID" 2>/dev/null || true; sleep 1; }
  fi
  # an in-flight smoke (import pre-pass / verify run) and any engine we are the ancestor of
  [[ -n "$SMOKE_PID" ]] && { kill -TERM "$SMOKE_PID" 2>/dev/null || true; SMOKE_PID=""; }
  local p
  for p in $(our_engines); do
    log "stopping our engine process $p"; kill -TERM "$p" 2>/dev/null || true
  done
  sleep 1
  for p in $(our_engines); do kill -KILL "$p" 2>/dev/null || true; done
  if [[ -n "$EDITOR_PID" ]]; then
    # our own stale registry entry (engine normally removes it on exit); the editor ran with
    # HOME=$FAKE_HOME, so it lives there — the real ~/.summer is checked too, defensively.
    for f in "$FAKE_HOME"/.summer/instances/*.json "$REAL_HOME"/.summer/instances/*.json; do
      [[ -f "$f" ]] || continue
      if grep -q "\"pid\": *$EDITOR_PID[,}]" "$f" 2>/dev/null && ! kill -0 "$EDITOR_PID" 2>/dev/null; then
        log "removing OUR stale instance entry $(basename "$f") (pid $EDITOR_PID is dead)"; rm -f "$f"
      fi
    done
    EDITOR_PID=""
  fi
  rm -f "$FAKE_HOME"/.summer/instances/*.json 2>/dev/null || true
}
on_exit() { cleanup_engine; }
trap on_exit EXIT
trap 'log "interrupted — stopping our editor"; on_exit; trap - EXIT; exit 130' INT TERM

smoke_json() { # $1 project  $2 rc  $3 log
  "$NODE" "$LIB" smoke-result "$1/tests/autopilot/out/results.json" "$2" "$3"
}

run_smoke() { # $1 project  $2 log  -> rc
  local rc=0
  gate "smoke" || return 99
  # HOME=$FAKE_HOME for the same reason as the editor: the import pre-pass and the verify
  # instance are the same binary and must not see the machine's desktop session.
  ( cd "$1" && SUMMER_BIN="$SUMMER_BIN" HOME="$FAKE_HOME" bash tests/autopilot/run.sh ) >"$2" 2>&1 &
  SMOKE_PID=$!
  wait "$SMOKE_PID" || rc=$?
  SMOKE_PID=""
  return $rc
}

# Isolation audit, appended to the task notes and written to $out/isolation.txt:
#   * editor.log must not mention se_session (the editor planting the desktop cookie);
#   * the fake HOME must hold no se_session / JWT-looking material;
#   * the REAL ~/.summer must have gained no files since the task started ($out/.t0).
#     Files modified there by other processes on the machine are listed, not judged.
audit_isolation() { # $1 out
  local out="$1" hits real_new fake_hits
  {
    echo "audit $(date -u +%H:%M:%S)"
    hits="$(grep -i -c 'se_session' "$out/editor.log" 2>/dev/null || true)"
    echo "editor.log se_session mentions: ${hits:-0}"
    if [[ "${hits:-0}" != "0" ]]; then notes+=("ISOLATION: editor.log mentions se_session ${hits}x — the editor touched the desktop session"); grep -i -n 'se_session' "$out/editor.log" | head -5; fi
    fake_hits="$(grep -rIl -i -E 'se_session|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.' "$FAKE_HOME" --exclude-dir=skills --exclude-dir=node_modules 2>/dev/null | head -5)"
    echo "fake HOME session-material files: ${fake_hits:-none}"
    [[ -n "$fake_hits" ]] && notes+=("ISOLATION: fake HOME contains session-looking material: $(printf '%s' "$fake_hits" | tr '\n' ' ')")
    real_new="$(find "$REAL_HOME/.summer" -type f -newer "$out/.t0" 2>/dev/null | head -10)"
    echo "real ~/.summer files modified since task start: ${real_new:-none}"
    [[ -n "$real_new" ]] && notes+=("real ~/.summer files modified during the task (any process): $(printf '%s' "$real_new" | tr '\n' ' ')")
  } >>"$out/isolation.txt" 2>&1
  return 0
}

# Engine processes that descend from THIS script (editor, import pre-pass, verify run):
# walk each candidate's parent chain up to our pid. Anything else is someone else's.
our_engines() {
  local line p q
  while read -r line; do
    [[ -n "$line" ]] || continue
    p="${line%% *}"; q="$p"
    while [[ -n "$q" && "$q" != "1" && "$q" != "0" ]]; do
      if [[ "$q" == "$$" ]]; then echo "$p"; break; fi
      q="$(ps -o ppid= -p "$q" 2>/dev/null | tr -d ' ')"
    done
  done < <(summer_procs)
}

TOOLKIT_COMMIT="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
TOOLKIT_DIRTY="$(git -C "$REPO" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
CLAUDE_VERSION="$(claude --version 2>/dev/null | head -1)"

run_task() {
  local id="$1"
  local task_json template max_turns
  task_json="$("$NODE" "$LIB" task "$id")" || return 1
  template="$(printf '%s' "$task_json" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).template))')"
  local out="$RESULTS/$id"; mkdir -p "$out"
  local project="$SCRATCH/projects/$id"
  CUR_PROJECT="$project"
  local notes=() stage="created" engine_version="" boot_s=""
  touch "$out/.t0"   # reference for the real-~/.summer audit
  log "=== task $id (template $template) ==="

  # 1. pristine project
  rm -rf "$project"
  if ! "$NODE" "$SUMMER_JS" create "$template" "$project" --keep-git >"$out/create.log" 2>&1; then
    log "create failed (see create.log)"; stage="create_failed"
    write_meta "$out" "$stage" "" "" "$(printf '%s\n' "${notes[@]:-}")"; "$NODE" "$LIB" finalize "$id" "$out" "$RESULTS"; return 0
  fi
  cp "$REPO/assets/autopilot/"{autopilot.gd,probe_base.gd,run.sh} "$project/tests/autopilot/" 2>/dev/null || true
  local size; size="$(du -sh "$project" 2>/dev/null | cut -f1)"

  # 2. baseline smoke (import pre-pass + verify), no editor
  local rc=0
  run_smoke "$project" "$out/baseline.log" || rc=$?
  if (( rc == 99 )); then
    log "engine gate refused/timed out — task not run"; stage="gate_refused"
    write_meta "$out" "$stage" "$size" "" ""; "$NODE" "$LIB" finalize "$id" "$out" "$RESULTS"; cleanup_project "$project"; return 0
  fi
  smoke_json "$project" "$rc" "$out/baseline.log" >"$out/baseline.json"
  if (( rc != 0 )); then
    log "baseline smoke FAILED (rc $rc): $(tail -1 "$out/baseline.log")"; stage="baseline_failed"
    audit_isolation "$out"
    write_meta "$out" "$stage" "$size" "" "" "${notes[@]:-}"; "$NODE" "$LIB" finalize "$id" "$out" "$RESULTS"; cleanup_project "$project"; return 0
  fi
  log "baseline smoke PASSED: $(tail -1 "$out/baseline.log")"

  # 3. editor, offscreen, never publishing the global api-port
  gate "editor" || { stage="gate_timeout"; write_meta "$out" "$stage" "$size" "" ""; "$NODE" "$LIB" finalize "$id" "$out" "$RESULTS"; cleanup_project "$project"; return 0; }
  local t0=$SECONDS
  # HOME=$FAKE_HOME: on boot the editor restores the machine-wide desktop sign-in (native session
  # JWT in the user's data dir + the shared WKWebView cookie store) and plants the real se_session
  # cookie into its Studio webview. NSHomeDirectory honours $HOME, so Application Support, WebKit,
  # HTTPStorages and ~/.summer all move under the fake HOME — a cold machine — and the toolkit
  # finds the instance file in the fake ~/.summer/instances directly (no copy step).
  HOME="$FAKE_HOME" "$SUMMER_BIN" --editor --path "$project" --summer-offscreen --summer-no-publish --disable-crash-handler >"$out/editor.log" 2>&1 &
  EDITOR_PID=$!
  log "editor pid $EDITOR_PID launched (offscreen, HOME=$FAKE_HOME)"
  local inst
  if ! inst="$("$NODE" "$LIB" wait-instance "$project" "$EDITOR_PID" "$FAKE_HOME" 240 2>>"$out/run.err")"; then
    log "editor never became reachable: $(tail -1 "$out/run.err")"; stage="editor_unreachable"
    cleanup_engine
    audit_isolation "$out"
    write_meta "$out" "$stage" "$size" "" "" "${notes[@]:-}"; "$NODE" "$LIB" finalize "$id" "$out" "$RESULTS"; cleanup_project "$project"; return 0
  fi
  boot_s=$((SECONDS - t0))
  printf '%s\n' "$inst" >"$out/instance.json"
  engine_version="$(printf '%s' "$inst" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).engineVersion||"")))')"
  local inst_file; inst_file="$(printf '%s' "$inst" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).file))')"
  log "editor ready in ${boot_s}s (engine $engine_version), instance $(basename "$inst_file")"
  # The editor rewrites files on first open (project.godot features bump, uid/unique_id on every
  # node of the main scene, .bak). Let it settle, then commit that state so the model's diff is
  # the model's alone.
  sleep 5
  ( cd "$project" && git add -A >/dev/null 2>&1 && git -c user.name=mitl -c user.email=mitl@local commit -q -m "mitl: state after editor open (engine rewrite, import caches)" ) >>"$out/run.err" 2>&1 || notes+=("post-open baseline commit failed")

  # 4. MCP config for this build, bound to this project
  local mcp="$out/mcp.json"
  cat >"$mcp" <<EOF
{"mcpServers":{"summer-engine":{"command":"$NODE","args":["$SUMMER_JS","mcp","--project","$project"]}}}
EOF

  # 5. the model
  stage="agent"
  local agent_line
  agent_line="$("$NODE" "$LIB" agent "$id" "$project" "$FAKE_HOME" "$out" "$mcp" 2>>"$out/run.err")" || notes+=("agent step exited non-zero")
  log "agent: ${agent_line:-<no summary>}"

  # 6. task checks while the editor is still up
  stage="checks"
  local checks_line
  checks_line="$("$NODE" "$LIB" checks "$id" "$project" "$FAKE_HOME" "$out" 2>>"$out/run.err")" || notes+=("checks step exited non-zero")
  log "checks: ${checks_line:-<no summary>}"

  # 7. stop OUR editor, then the post-change smoke with the pristine probe
  cleanup_engine
  local leftover; leftover="$(summer_procs)"
  [[ -n "$leftover" ]] && notes+=("other Summer processes alive after our editor exited (not ours, not touched): $(printf '%s' "$leftover" | head -2 | tr '\n' ';')")
  local probe_modified=0
  for f in autopilot.gd probe_base.gd run.sh; do
    cmp -s "$REPO/assets/autopilot/$f" "$project/tests/autopilot/$f" || probe_modified=1
    cp "$REPO/assets/autopilot/$f" "$project/tests/autopilot/$f"
  done
  (( probe_modified )) && notes+=("agent modified tests/autopilot/* — pristine probe restored before scoring")
  stage="smoke_after"
  rc=0
  run_smoke "$project" "$out/smoke_after.log" || rc=$?
  smoke_json "$project" "$rc" "$out/smoke_after.log" >"$out/smoke_after.json"
  log "smoke after change: $(tail -1 "$out/smoke_after.log")"
  ( cd "$project" && git status --porcelain -uall ) >"$out/git-status.txt" 2>&1 || true
  ( cd "$project" && git diff --stat ) >"$out/git-diff-stat.txt" 2>&1 || true
  ( cd "$project" && git diff -- . ':(exclude).godot' ':(exclude)*.import' ':(exclude)project.godot' ':(exclude)tests/autopilot' ) >"$out/agent.diff" 2>/dev/null || true
  ( cd "$project" && git ls-files --others --exclude-standard | grep -vE '^(\.godot/|tests/autopilot/|\.summer/|project\.godot\.bak$)' | grep -vE '\.import$' | while read -r nf; do echo "=== NEW FILE: $nf"; sed -n '1,200p' "$nf" 2>/dev/null; done ) >>"$out/agent.diff" 2>/dev/null || true
  audit_isolation "$out"
  stage="done"
  write_meta "$out" "$stage" "$size" "$engine_version" "$boot_s" "${notes[@]:-}"
  "$NODE" "$LIB" finalize "$id" "$out" "$RESULTS"
  cleanup_project "$project"
}

write_meta() { # out stage size engine boot notes...
  local out="$1" stage="$2" size="$3" engine="$4" boot="$5"; shift 5
  local notes_json="[]"
  if (( $# > 0 )) && [[ -n "${1:-}" ]]; then notes_json="$(printf '%s\n' "$@" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s.split("\n").filter(Boolean))))')"; fi
  cat >"$out/meta.json" <<EOF
{"date":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","stage":"$stage","project_size":"$size","engine_version":"$engine","editor_boot_s":"$boot","engine_binary":"$SUMMER_BIN","toolkit_commit":"$TOOLKIT_COMMIT","toolkit_dirty":$TOOLKIT_DIRTY,"claude_version":"$CLAUDE_VERSION","notes":$notes_json}
EOF
}

cleanup_project() {
  if [[ "${MITL_KEEP_PROJECT:-0}" == "1" ]]; then log "keeping project $1"; return; fi
  rm -rf "$1"
}

log "MITL run: engine $SUMMER_BIN, toolkit $TOOLKIT_COMMIT (dirty files: $TOOLKIT_DIRTY), claude $CLAUDE_VERSION, node $("$NODE" --version), results $RESULTS, scratch $SCRATCH"
for id in $("$NODE" "$LIB" list "$SEL"); do
  run_task "$id"
done
log "done. summary:"
cat "$RESULTS/summary.tsv" >&2
