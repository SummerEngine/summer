#!/bin/bash
# Smoke test for the Summer Engine CLI
# Run from: tools/summer-cli/
# Requires: npm run build (dist/ must exist)

set -e

CLI="node dist/bin/summer.js"
PASS=0
FAIL=0
SKIP=0

green() { printf "\033[32m%s\033[0m\n" "$1"; }
red()   { printf "\033[31m%s\033[0m\n" "$1"; }
yellow(){ printf "\033[33m%s\033[0m\n" "$1"; }

check() {
  local name="$1"
  shift
  if eval "$@" > /dev/null 2>&1; then
    green "  PASS: $name"
    PASS=$((PASS + 1))
  else
    red "  FAIL: $name"
    FAIL=$((FAIL + 1))
  fi
}

skip() {
  yellow "  SKIP: $1 ($2)"
  SKIP=$((SKIP + 1))
}

echo ""
echo "Summer Engine CLI Smoke Tests"
echo "=============================="
echo ""

# Check build exists
if [ ! -f "dist/bin/summer.js" ]; then
  red "ERROR: dist/bin/summer.js not found. Run 'npm run build' first."
  exit 1
fi

echo "1. CLI Basics"
check "summer --help" "$CLI --help"
check "summer --version" "$CLI --version"

echo ""
echo "2. Commands (no engine needed)"
check "summer status runs" "$CLI status"
check "summer list templates" "$CLI list templates"
check "summer list projects" "$CLI list projects"

echo ""
echo "3. Create command"
TMPDIR=$(mktemp -d)
check "summer create empty" "$CLI create empty $TMPDIR/test-empty"
check "project.godot created" "test -f $TMPDIR/test-empty/project.godot"
check "main.tscn created" "test -f $TMPDIR/test-empty/main.tscn"
check "summer create 3d-basic" "$CLI create 3d-basic $TMPDIR/test-3d"
check "3d project.godot created" "test -f $TMPDIR/test-3d/project.godot"
check "3d main.tscn created" "test -f $TMPDIR/test-3d/main.tscn"
check "unknown template fails" "! $CLI create nonexistent $TMPDIR/test-bad 2>/dev/null"
rm -rf "$TMPDIR"

echo ""
echo "4. Engine-dependent commands"
if $CLI status 2>&1 | grep -q "Engine: Running"; then
  check "summer status shows running" "$CLI status 2>&1 | grep -q 'Engine: Running'"
else
  skip "Engine-dependent tests" "engine not running"
fi

echo ""
echo "=============================="
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
echo ""

if [ $FAIL -gt 0 ]; then
  red "SOME TESTS FAILED"
  exit 1
else
  green "ALL TESTS PASSED"
fi
