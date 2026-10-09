import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROBE_DIR_PREFIX, assertPrivateDir, makeProbeDir, runProbe } from "./probe.js";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("seeing run directory (the engine loads the wrapper scene from it as code)", () => {
  it("is a private mkdtemp directly in the OS temp dir, with no shared fixed parent", async () => {
    const dir = await makeProbeDir();
    made.push(dir);
    expect(dirname(dir)).toBe(tmpdir());
    expect(basename(dir).startsWith(PROBE_DIR_PREFIX)).toBe(true);
    if (process.platform !== "win32") expect(statSync(dir).mode & 0o777).toBe(0o700);
    // Two calls never share a directory.
    const other = await makeProbeDir();
    made.push(other);
    expect(other).not.toBe(dir);
  });

  it.skipIf(process.platform === "win32")("refuses a symlinked or group/other-accessible directory", async () => {
    const real = mkdtempSync(join(tmpdir(), "seeing-real-"));
    made.push(real);
    const link = join(tmpdir(), `seeing-link-${process.pid}-${Date.now()}`);
    symlinkSync(real, link);
    made.push(link);
    await expect(assertPrivateDir(link)).rejects.toThrow(/not a real directory/);
    const shared = join(real, "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o775);
    await expect(assertPrivateDir(shared)).rejects.toThrow(/group\/other/);
    chmodSync(shared, 0o700);
    await expect(assertPrivateDir(shared)).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("runProbe writes nothing into a run directory it does not trust", async () => {
    const real = mkdtempSync(join(tmpdir(), "seeing-real-"));
    made.push(real);
    chmodSync(real, 0o777);
    const client = { executeOps: async () => ({}) };
    await expect(runProbe(client, { scenePath: "res://a.tscn", config: { mode: "analyze" }, size: [16, 16] }, real)).rejects.toThrow(/group\/other/);
  });
});
