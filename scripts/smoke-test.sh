#!/bin/bash
# Smoke test for the Summer
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
echo "Summer Smoke Tests"
echo "=============================="
echo ""

# Check build exists
if [ ! -f "dist/bin/summer.js" ]; then
  red "ERROR: dist/bin/summer.js not found. Run 'npm run build' first."
  exit 1
fi

echo "1. Unit tests"
if npm test --silent > /dev/null 2>&1; then
  green "  PASS: npm test"
  PASS=$((PASS + 1))
else
  red "  FAIL: npm test"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "2. CLI Basics"
check "summer --help" "$CLI --help"
check "summer --version" "$CLI --version"

echo ""
echo "3. Commands (no engine needed)"
check "summer status runs" "$CLI status"
check "summer list templates" "$CLI list templates"
check "summer list projects" "$CLI list projects"
check "summer skills list" "$CLI skills list"
check "summer mcp setup --print cursor" "$CLI mcp setup cursor --print | grep -q 'summer-engine'"
check "summer mcp setup cursor dry-run json" "$CLI mcp setup cursor --scope user --dry-run --json"
check "summer doctor json" "$CLI doctor --json"

echo ""
echo "4. Create command"
TMPDIR=$(mktemp -d)
check "summer mcp setup cursor writes config" "SUMMER_CURSOR_MCP_CONFIG_FILE=$TMPDIR/cursor-mcp.json $CLI mcp setup cursor --scope user"
check "cursor mcp config written" "grep -q 'summer-engine' $TMPDIR/cursor-mcp.json"
check "summer mcp setup codex local dev dry-run" "SUMMER_CODEX_CONFIG_FILE=$TMPDIR/codex-config.toml $CLI mcp setup codex --scope user --local-dev --dry-run"
check "codex dry-run did not write" "test ! -f $TMPDIR/codex-config.toml"
check "summer setup wrapper dry-run json" "SUMMER_CURSOR_MCP_CONFIG_FILE=$TMPDIR/setup-cursor-mcp.json SUMMER_SKILLS_DIR=$TMPDIR/setup-skills $CLI setup cursor --scope user --dry-run --json"
check "summer create empty" "$CLI create empty $TMPDIR/test-empty"
check "project.godot created" "test -f $TMPDIR/test-empty/project.godot"
check "main.tscn created" "test -f $TMPDIR/test-empty/main.tscn"
check "summer create 3d-basic" "$CLI create 3d-basic $TMPDIR/test-3d"
check "3d project.godot created" "test -f $TMPDIR/test-3d/project.godot"
check "3d main.tscn created" "test -f $TMPDIR/test-3d/main.tscn"
check "summer skills install fps-controller" "SUMMER_SKILLS_DIR=$TMPDIR/summer-skills $CLI skills install fps-controller"
check "fps-controller installed" "test -f $TMPDIR/summer-skills/fps-controller/SKILL.md"
check "summer skills install --all" "SUMMER_SKILLS_DIR=$TMPDIR/summer-skills-all $CLI skills install --all"
check "all skills installed" "test -f $TMPDIR/summer-skills-all/gdscript-patterns/SKILL.md"
check "summer skills install --as-cursor-skill" "SUMMER_SKILLS_DIR=$TMPDIR/cursor-skills $CLI skills install fps-controller --as-cursor-skill"
check "cursor skill installed" "test -f $TMPDIR/cursor-skills/summer-fps-controller.mdc"
check "unknown template fails" "! $CLI create nonexistent $TMPDIR/test-bad 2>/dev/null"
rm -rf "$TMPDIR"

echo ""
echo "5. Engine-dependent commands"
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
