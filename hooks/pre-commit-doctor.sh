#!/usr/bin/env bash
# Summer Engine — Pre-commit doctor hook (OPT-IN)
#
# Event:    PreToolUse (matcher: Bash, if: "Bash(git commit*)")
# Purpose:  Run `summer doctor` before any git commit Claude is about to make.
#           Block the commit on FAIL. Allow with warnings on WARN.
#
# Status:   OPT-IN. Not registered in the Summer plugin manifest by default.
#
# To enable, add to ~/.claude/settings.json (or .claude/settings.json):
#
#   {
#     "hooks": {
#       "PreToolUse": [
#         {
#           "matcher": "Bash",
#           "hooks": [
#             {
#               "type": "command",
#               "command": "${CLAUDE_PLUGIN_ROOT}/hooks/pre-commit-doctor.sh",
#               "if": "Bash(git commit*)",
#               "timeout": 15
#             }
#           ]
#         }
#       ]
#     }
#   }
#
# Then: chmod +x ${CLAUDE_PLUGIN_ROOT}/hooks/pre-commit-doctor.sh
#
# Input:    JSON on stdin: { tool_name, tool_input: { command, ... }, ... }
# Output:   On FAIL: stderr explanation, exit 2 (blocks commit).
#           On WARN: stderr warnings, exit 0 (allows commit).
#           On PASS or no `summer` CLI: silent, exit 0.
#
# Portability: bash 3.2+, POSIX-friendly. jq optional.

set +e

INPUT=$(cat)

# ---------- Parse the command ----------
COMMAND=""
if command -v jq >/dev/null 2>&1; then
    COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
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
        | jq -r '.checks[]? | select(.status == "FAIL") | "  - " + (.name // "?") + ": " + (.message // "")' 2>/dev/null)
    WARN_MSGS=$(printf '%s' "$DOCTOR_OUT" \
        | jq -r '.checks[]? | select(.status == "WARN") | "  - " + (.name // "?") + ": " + (.message // "")' 2>/dev/null)
    [ -n "$FAIL_MSGS" ] && HAS_FAIL=1
    [ -n "$WARN_MSGS" ] && HAS_WARN=1
else
    # Fallback: substring sniffing
    if printf '%s' "$DOCTOR_OUT" | grep -q '"status"[[:space:]]*:[[:space:]]*"FAIL"'; then
        HAS_FAIL=1
        FAIL_MSGS=$(printf '%s' "$DOCTOR_OUT" \
            | grep -oE '"status"[[:space:]]*:[[:space:]]*"FAIL"[^}]*"message"[[:space:]]*:[[:space:]]*"[^"]*"' \
            | sed -E 's/.*"message"[[:space:]]*:[[:space:]]*"([^"]*)"/  - \1/')
    fi
    if printf '%s' "$DOCTOR_OUT" | grep -q '"status"[[:space:]]*:[[:space:]]*"WARN"'; then
        HAS_WARN=1
        WARN_MSGS=$(printf '%s' "$DOCTOR_OUT" \
            | grep -oE '"status"[[:space:]]*:[[:space:]]*"WARN"[^}]*"message"[[:space:]]*:[[:space:]]*"[^"]*"' \
            | sed -E 's/.*"message"[[:space:]]*:[[:space:]]*"([^"]*)"/  - \1/')
    fi
fi

# ---------- FAIL: block ----------
if [ "$HAS_FAIL" -eq 1 ]; then
    {
        echo "=== Summer doctor: FAIL — commit blocked ==="
        echo "$FAIL_MSGS"
        echo ""
        echo "Fix the failures above, or run: summer doctor"
        echo "To bypass once: disable the pre-commit-doctor hook in settings.json."
        echo "============================================"
    } >&2
    exit 2
fi

# ---------- WARN: allow with notice ----------
if [ "$HAS_WARN" -eq 1 ]; then
    {
        echo "=== Summer doctor: WARN — commit allowed ==="
        echo "$WARN_MSGS"
        echo "============================================"
    } >&2
fi

exit 0
