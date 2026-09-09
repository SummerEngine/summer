#!/usr/bin/env bash
# Cross-platform hook dispatcher (bash side).
# Usage: run-hook.sh <hook-name>
# Reads stdin, forwards to <plugin-root>/hooks/<hook-name>.sh
# Hosts reference run-hook.cmd, a bash/cmd.exe polyglot that lands here on
# every platform that has bash (macOS, Linux, Git Bash / WSL on Windows).

HOOK_NAME="$1"
shift || true

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_SCRIPT="$HOOK_DIR/$HOOK_NAME.sh"

if [ ! -f "$HOOK_SCRIPT" ]; then
  # Missing hook = no-op (don't break the host).
  exit 0
fi

# Always go through bash: fresh checkouts / npm tarballs may drop the exec bit.
exec bash "$HOOK_SCRIPT" "$@"
