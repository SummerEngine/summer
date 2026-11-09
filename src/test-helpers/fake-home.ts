/**
 * Runs before EVERY test file (vitest setupFiles): point HOME (and the Windows
 * equivalents) at a fresh temp dir so os.homedir() — and with it getSummerDir()
 * and every "default ~/.summer" code path — resolves to a throwaway store.
 * setSummerDirForTests(null) therefore restores THIS fake home, not the real
 * one. Tests that want their own store still call setSummerDirForTests(dir).
 *
 * Why: a test that forgot the seam appended to the real ~/.summer/mcp.log
 * (2026-09-09). No test may touch the real ~/.summer.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// The real path, as a person's home is: macOS tmpdir() is under /var, a symlink to /private/var.
const fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "summer-test-home-")));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.HOMEDRIVE = "";
process.env.HOMEPATH = fakeHome;
// Agent config locations that would otherwise point outside the fake home.
process.env.APPDATA = join(fakeHome, "AppData", "Roaming");
for (const name of ["CODEX_HOME", "XDG_CONFIG_HOME", "SUMMER_CODEX_RULES_FILE", "SUMMER_CLAUDE_SETTINGS_FILE"]) delete process.env[name];
// The MCP opens the session's project in Summer Engine when no editor runs
// (core/engine-self-start.ts); /Applications/Summer.app is not under HOME, so
// no test may launch it. Tests of the launch pass their own env and launcher.
process.env.SUMMER_AUTO_LAUNCH = "0";

afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});
