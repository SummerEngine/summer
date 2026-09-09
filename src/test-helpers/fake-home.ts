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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const fakeHome = mkdtempSync(join(tmpdir(), "summer-test-home-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.HOMEDRIVE = "";
process.env.HOMEPATH = fakeHome;

afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});
