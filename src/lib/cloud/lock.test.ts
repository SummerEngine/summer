import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireCloudLock } from "./lock.js";
import { lockPath } from "./lock-path.js";

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "summer-lock-"));
  await mkdir(join(projectRoot, ".summer", "local", "cloud"), { recursive: true });
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

describe("acquireCloudLock (spec 8.2)", () => {
  it("acquires, writes a full payload, and releases", async () => {
    const lock = await acquireCloudLock(projectRoot, "cli");
    const payload = JSON.parse(await readFile(lockPath(projectRoot), "utf8"));
    expect(payload.pid).toBe(process.pid);
    expect(payload.face).toBe("cli");
    expect(typeof payload.token).toBe("string");
    expect(typeof payload.startedAt).toBe("string");
    expect(typeof payload.heartbeatAt).toBe("string");
    await lock.release();
    await expect(stat(lockPath(projectRoot))).rejects.toThrow();
  });

  it("a second contender waits then fails while the lock is fresh", async () => {
    const lock = await acquireCloudLock(projectRoot);
    const t0 = Date.now();
    await expect(acquireCloudLock(projectRoot)).rejects.toThrow(/already in progress/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(9_000);
    await lock.release();
  }, 20_000);

  it("takes over a stale lock (heartbeat older than 120s)", async () => {
    const stale = {
      pid: 99999,
      face: "cli",
      token: "dead",
      startedAt: new Date(Date.now() - 600_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 300_000).toISOString(),
    };
    await writeFile(lockPath(projectRoot), JSON.stringify(stale));
    const lock = await acquireCloudLock(projectRoot);
    const payload = JSON.parse(await readFile(lockPath(projectRoot), "utf8"));
    expect(payload.pid).toBe(process.pid);
    await lock.release();
  });

  it("treats an unparseable young lock file as FRESH (holder between create and write)", async () => {
    await writeFile(lockPath(projectRoot), "");
    await expect(acquireCloudLock(projectRoot)).rejects.toThrow(/already in progress/);
  }, 20_000);

  it("treats an unparseable old lock file as stale by mtime", async () => {
    await writeFile(lockPath(projectRoot), "");
    const old = new Date(Date.now() - 300_000);
    await utimes(lockPath(projectRoot), old, old);
    const lock = await acquireCloudLock(projectRoot);
    await lock.release();
  });

  it("only one of two concurrent waiters wins a stale takeover", async () => {
    const stale = {
      pid: 99999,
      face: "cli",
      token: "dead",
      startedAt: new Date(Date.now() - 600_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 300_000).toISOString(),
    };
    await writeFile(lockPath(projectRoot), JSON.stringify(stale));
    const results = await Promise.allSettled([acquireCloudLock(projectRoot), acquireCloudLock(projectRoot)]);
    const wins = results.filter((r) => r.status === "fulfilled");
    const losses = results.filter((r) => r.status === "rejected");
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    if (wins[0].status === "fulfilled") await wins[0].value.release();
  }, 20_000);

  it("release does not remove a lock that was taken over by someone else", async () => {
    const lock = await acquireCloudLock(projectRoot);
    // Simulate a takeover writing a different owner.
    await writeFile(lockPath(projectRoot), JSON.stringify({ pid: 1, face: "cli", token: "other", startedAt: "x", heartbeatAt: new Date().toISOString() }));
    await lock.release();
    const payload = JSON.parse(await readFile(lockPath(projectRoot), "utf8"));
    expect(payload.token).toBe("other");
  });
});
