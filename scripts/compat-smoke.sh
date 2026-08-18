#!/bin/bash
# compat-smoke.sh — latest-MCP x candidate-engine compatibility smoke gate.
#
# Builds the LOCAL summer-cli, starts its real MCP server over stdio, and
# drives the real summer_* tool handlers against the RUNNING Summer editor —
# exercising the actual op-composition layer (scene-tools batch splitting)
# that unit tests on both sides mock away. See compat-smoke.mjs for the
# incident this guards against (MCP 2.7.0-2.8.0 x engine 0.5.60+ batch
# wholesale rejection).
#
# PRECONDITION: a running Summer editor with a SCRATCH project open. The gate
# mutates that project's open/main scene (and creates a throwaway prefab
# .tscn), then cleans up after itself. Do not point it at a project you care
# about. e.g.:
#   summer create empty /tmp/compat-scratch && open it in Summer Engine
#
# Usage:
#   bash tools/summer-cli/scripts/compat-smoke.sh [--project <path>]
#
# --project is required only when more than one Summer editor is running.
# Env: SUMMER_COMPAT_SKIP_BUILD=1 skips npm run build (dist/ must exist).
#
# Exit codes: 0 compatible, 1 incompatibility/failure, 2 precondition not met.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="$(dirname "$SCRIPT_DIR")"

cd "$CLI_DIR"

if [ "${SUMMER_COMPAT_SKIP_BUILD:-0}" = "1" ]; then
  if [ ! -f "dist/bin/summer.js" ]; then
    echo "[compat-smoke] SUMMER_COMPAT_SKIP_BUILD=1 but dist/bin/summer.js is missing. Run 'npm run build' first." >&2
    exit 1
  fi
  echo "[compat-smoke] Skipping build (SUMMER_COMPAT_SKIP_BUILD=1)."
else
  echo "[compat-smoke] Building local CLI (npm run build)..."
  npm run build
fi

exec node "$SCRIPT_DIR/compat-smoke.mjs" "$@"
