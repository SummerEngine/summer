#!/usr/bin/env bash
# Summer Engine — SessionStart hook
#
# Event:    SessionStart (matcher: startup|clear|compact)
# Purpose:  Orient Claude on every fresh Summer-enabled session.
#           Detect Summer project + GameSoul + first-run state and surface a
#           short greeting as additional context.
#
# Input:    JSON on stdin with { session_id, source, model, cwd, ... }
#           Common Claude Code env vars: $CLAUDE_PROJECT_DIR, $CLAUDE_PLUGIN_ROOT
# Output:   JSON on stdout with hookSpecificOutput.additionalContext
#           (also emits Cursor / Copilot CLI variants based on host env vars)
# Exit:     Always 0 — never block session start.
#
# Portability: bash 3.2+ (macOS default), POSIX-friendly, works on Git Bash.
#              Uses `grep -E` not `grep -P`. File checks only: no network,
#              no child processes beyond grep/awk/find, so it returns at once.

set +e  # Hooks must never kill the session.

# ---------- Resolve project dir ----------
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"

# ---------- Build the orientation lines (max 3) ----------
LINES=()

# Line 1: Summer ready + skill count
# The count is the number of Summer skills actually loaded by THIS host — the
# plugin's bundled library when running as a plugin. Outside a plugin root we
# cannot tell Summer skills from the user's own, so the number is dropped
# rather than reporting the whole library as if it were installed.
SKILL_COUNT=""
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-${CURSOR_PLUGIN_ROOT:-}}"
if [ -n "$PLUGIN_ROOT" ] && [ -d "${PLUGIN_ROOT}/library/skills" ]; then
    SKILL_COUNT=$(find "${PLUGIN_ROOT}/library/skills" -mindepth 2 -maxdepth 2 -name SKILL.md 2>/dev/null | grep -c .)
    case "$SKILL_COUNT" in
        ''|0|*[!0-9]*) SKILL_COUNT="" ;;
    esac
fi
if [ -n "$SKILL_COUNT" ]; then
    LINES+=("Summer ready. ${SKILL_COUNT} skills.")
else
    LINES+=("Summer ready.")
fi

# Line 2: Summer project + GameSoul one-liner (only if project.godot exists)
if [ -f "${PROJECT_DIR}/project.godot" ]; then
    PROJECT_NAME=$(grep -E '^config/name=' "${PROJECT_DIR}/project.godot" 2>/dev/null \
        | head -1 | sed 's/^config\/name=//;s/^"//;s/"$//')
    [ -z "$PROJECT_NAME" ] && PROJECT_NAME=$(basename "$PROJECT_DIR")

    SOUL_FILE="${PROJECT_DIR}/.summer/GameSoul.md"
    if [ -f "$SOUL_FILE" ]; then
        # First non-empty, non-heading paragraph (one line)
        SOUL_LINE=$(awk 'BEGIN{p=""} /^[^#[:space:]]/ && NF>0 {p=$0; exit} END{print p}' \
            "$SOUL_FILE" 2>/dev/null | cut -c1-120)
        if [ -n "$SOUL_LINE" ]; then
            LINES+=("Summer project: ${PROJECT_NAME}. GameSoul: ${SOUL_LINE}")
        else
            LINES+=("Summer project: ${PROJECT_NAME}.")
        fi
    else
        LINES+=("Summer project: ${PROJECT_NAME}.")
    fi
fi

# Line 3: first-run / sign-in hint, from local files only. No network and no
# `summer doctor` here: SessionStart blocks the session until it returns, and a
# doctor run (npm registry, engine probe, MCP boot) can take seconds. The full
# check is one call away (`summer doctor`, or /summer:start on a first run).
SUMMER_HOME="${HOME}/.summer"
ENGINE_FOUND=""
for candidate in "/Applications/Summer.app" "${HOME}/Applications/Summer.app" \
    "${LOCALAPPDATA:-}/Programs/Summer" "${LOCALAPPDATA:-}/SummerEngine" "${HOME}/.local/share/summer-engine"; do
    if [ -e "$candidate" ]; then ENGINE_FOUND=1; break; fi
done
if [ -n "${SUMMER_BIN:-}${SUMMER_ENGINE_BINARY:-}" ]; then ENGINE_FOUND=1; fi
# /summer:start is the Claude Code plugin command; other hosts get the CLI.
START_HINT="run: npx -y summer-engine@latest setup"
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -z "${CURSOR_PLUGIN_ROOT:-}" ]; then
    START_HINT="suggest /summer:start (sets up Summer and makes a first playable game in about five minutes)"
fi
if [ ! -d "$SUMMER_HOME" ] && [ -z "$ENGINE_FOUND" ] && [ -z "${SUMMER_TOKEN:-}" ]; then
    LINES+=("Summer is not set up on this machine yet. When the user wants to make a game, ${START_HINT}.")
elif [ ! -f "${SUMMER_HOME}/auth-token" ] && [ -z "${SUMMER_TOKEN:-}" ]; then
    LINES+=("Summer CLI is not signed in: asset and publishing tools need \`summer login\` (or sign in to the summer-cloud server in /mcp).")
fi

# ---------- Compose context ----------
CONTEXT=""
for line in "${LINES[@]}"; do
    if [ -z "$CONTEXT" ]; then CONTEXT="$line"
    else CONTEXT="${CONTEXT}"$'\n'"$line"
    fi
done

# Bail with empty JSON if we somehow have no lines
if [ -z "$CONTEXT" ]; then
    printf '{}\n'
    exit 0
fi

# ---------- JSON-escape for embedding ----------
escape_for_json() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\n'/\\n}"
    s="${s//$'\r'/\\r}"
    s="${s//$'\t'/\\t}"
    printf '%s' "$s"
}
CONTEXT_ESC=$(escape_for_json "$CONTEXT")

# ---------- Emit per-host shape ----------
# Cursor: top-level additional_context (snake_case)
# Claude Code: nested hookSpecificOutput.additionalContext
# Copilot CLI / SDK standard: top-level additionalContext (camelCase)
if [ -n "${CURSOR_PLUGIN_ROOT:-}" ]; then
    printf '{"additional_context":"%s"}\n' "$CONTEXT_ESC"
elif [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -z "${COPILOT_CLI:-}" ]; then
    printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$CONTEXT_ESC"
else
    printf '{"additionalContext":"%s"}\n' "$CONTEXT_ESC"
fi

exit 0
