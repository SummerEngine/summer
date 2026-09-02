#!/usr/bin/env bash
# Cross-platform hook dispatcher.
# Usage: run-hook.cmd <hook-name>
# Reads stdin, forwards to <plugin-root>/hooks/<hook-name>.sh
# On Windows, Claude Code / Cursor / Codex invoke this via Git-Bash.

HOOK_NAME="$1"
shift || true

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_SCRIPT="$HOOK_DIR/$HOOK_NAME.sh"

if [ ! -f "$HOOK_SCRIPT" ]; then
  # Missing hook = no-op (don't break the host).
  exit 0
fi

if [ ! -x "$HOOK_SCRIPT" ]; then
  # Not executable yet (likely fresh checkout). Fall back to bash invocation.
  exec bash "$HOOK_SCRIPT" "$@"
fi

exec "$HOOK_SCRIPT" "$@"
