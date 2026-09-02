#!/usr/bin/env bash
# Summer Engine — Pre-commit doctor hook (OPT-IN)
#
# Event:    PreToolUse (matcher: "Bash", if: "Bash(git commit*)") — registered
#           in hooks/hooks.json (Claude Code) and hooks/hooks-cursor.json.
# Purpose:  Run `summer doctor` before any git commit the agent is about to
#           make. Block the commit on fail. Allow with warnings on warning.
#
# Status:   OPT-IN. The hook is always registered but exits 0 immediately
#           unless one of these is set:
#             CLAUDE_PLUGIN_OPTION_ENABLE_PRE_COMMIT_DOCTOR=true
#               Claude Code exports every plugin userConfig value to hook
#               processes as CLAUDE_PLUGIN_OPTION_<KEY>; this is the
#               `enable_pre_commit_doctor` toggle from plugin.json.
#             SUMMER_PRE_COMMIT_DOCTOR=1
#               Manual / other-host opt-in (also the envVar Gemini's
#               gemini-extension.json `settings` entry maps to).
#
# Input:    JSON on stdin: { tool_name, tool_input: { command, ... }, ... }
# Output:   On fail: stderr explanation, exit 2 (blocks commit).
#           On warning: stderr warnings, exit 0 (allows commit).
#           On ok, opt-in unset, or no `summer` CLI on PATH: silent, exit 0.
#           (No npx fallback: a cold `npx summer-engine` download would blow
#           the 30s hook budget mid-commit. Install the CLI to use this hook.)
#
# Doctor JSON shape (src/core/capabilities/doctor.ts):
#   { ok, checks: [{ id, label, status: "ok"|"warning"|"fail", message }], summary }
#
# Portability: bash 3.2+, POSIX-friendly. jq optional.

set +e

# ---------- Opt-in gate ----------
is_truthy() {
    case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
        1|true|yes|on) return 0 ;;
        *) return 1 ;;
    esac
}
if ! is_truthy "${CLAUDE_PLUGIN_OPTION_ENABLE_PRE_COMMIT_DOCTOR:-}" \
   && ! is_truthy "${SUMMER_PRE_COMMIT_DOCTOR:-}"; then
    cat >/dev/null
    exit 0
fi

INPUT=$(cat)

# ---------- Parse the command ----------
COMMAND=""
if command -v jq >/dev/null 2>&1; then
    # Claude Code PreToolUse: .tool_input.command; Cursor beforeShellExecution: .command
    COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // .command // empty' 2>/dev/null)
fi
if [ -z "$COMMAND" ]; then
    COMMAND=$(printf '%s' "$INPUT" \
        | grep -oE '"command"[[:space:]]*:[[:space:]]*"[^"]*"' \
        | head -1 \
        | sed 's/^"command"[[:space:]]*:[[:space:]]*"//;s/"$//')
fi

# ---------- Bail early if not a git commit ----------
if ! printf '%s' "$COMMAND" | grep -qE '^[[:space:]]*git[[:space:]]+commit'; then
    exit 0
fi

# ---------- Bail if `summer` CLI missing ----------
if ! command -v summer >/dev/null 2>&1; then
    # Don't block — user may have installed via plugin only.
    exit 0
fi

# ---------- Run doctor ----------
DOCTOR_OUT=$(summer doctor --json 2>/dev/null)
if [ -z "$DOCTOR_OUT" ]; then
    exit 0
fi

# ---------- Parse status ----------
HAS_FAIL=0
HAS_WARN=0
FAIL_MSGS=""
WARN_MSGS=""

if command -v jq >/dev/null 2>&1; then
    FAIL_MSGS=$(printf '%s' "$DOCTOR_OUT" \
        | jq -r '.checks[]? | select((.status // "" | ascii_downcase) == "fail") | "  - " + (.label // .name // "?") + ": " + (.message // "")' 2>/dev/null)
    WARN_MSGS=$(printf '%s' "$DOCTOR_OUT" \
        | jq -r '.checks[]? | select((.status // "" | ascii_downcase) | IN("warning", "warn")) | "  - " + (.label // .name // "?") + ": " + (.message // "")' 2>/dev/null)
    [ -n "$FAIL_MSGS" ] && HAS_FAIL=1
    [ -n "$WARN_MSGS" ] && HAS_WARN=1
else
    # Fallback: substring sniffing
    if printf '%s' "$DOCTOR_OUT" | grep -q '"status"[[:space:]]*:[[:space:]]*"(FAIL|fail)"'; then
        HAS_FAIL=1
        FAIL_MSGS=$(printf '%s' "$DOCTOR_OUT" \
            | grep -oE '"status"[[:space:]]*:[[:space:]]*"(FAIL|fail)"[^}]*"message"[[:space:]]*:[[:space:]]*"[^"]*"' \
            | sed -E 's/.*"message"[[:space:]]*:[[:space:]]*"([^"]*)"/  - \1/')
    fi
    if printf '%s' "$DOCTOR_OUT" | grep -q '"status"[[:space:]]*:[[:space:]]*"(WARN|warn|warning)"'; then
        HAS_WARN=1
        WARN_MSGS=$(printf '%s' "$DOCTOR_OUT" \
            | grep -oE '"status"[[:space:]]*:[[:space:]]*"(WARN|warn|warning)"[^}]*"message"[[:space:]]*:[[:space:]]*"[^"]*"' \
            | sed -E 's/.*"message"[[:space:]]*:[[:space:]]*"([^"]*)"/  - \1/')
    fi
fi

# ---------- FAIL: block ----------
if [ "$HAS_FAIL" -eq 1 ]; then
    {
        echo "=== Summer doctor: fail — commit blocked ==="
        echo "$FAIL_MSGS"
        echo ""
        echo "Fix the failures above, or run: summer doctor"
        echo "To bypass: turn off the plugin option enable_pre_commit_doctor (or unset SUMMER_PRE_COMMIT_DOCTOR)."
        echo "============================================"
    } >&2
    exit 2
fi

# ---------- WARN: allow with notice ----------
if [ "$HAS_WARN" -eq 1 ]; then
    {
        echo "=== Summer doctor: warning — commit allowed ==="
        echo "$WARN_MSGS"
        echo "============================================"
    } >&2
fi

exit 0
