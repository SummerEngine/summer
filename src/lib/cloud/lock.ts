import { randomUUID } from "crypto";
import { open, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { lockPath } from "./lock-path.js";

export interface CloudLock {
  release(): Promise<void>;
}

const STALE_MS = 120_000;
const WAIT_MS = 10_000;
const HEARTBEAT_MS = 30_000;

type Face = "cli" | "mcp" | "engine";

interface LockPayload {
  pid: number;
  face: Face;
  token: string;
  startedAt: string;
  heartbeatAt: string;
}

/**
 * Per-project sync mutex (spec 8.2). O_EXCL create, 30s heartbeat, stale only
 * by heartbeat age (120s). Two fixed races: the payload is written to the fd
 * before close and verified by token after create (a contender that reads an
 * empty just-created file treats parse failure as FRESH while the file is
 * young); takeover goes through an atomic rename so two waiters can never
 * both remove the same stale lock and both proceed.
 */
export async function acquireCloudLock(projectRoot: string, face: Face = "cli"): Promise<CloudLock> {
  const path = lockPath(projectRoot);
  const started = Date.now();
  const token = randomUUID();

  while (Date.now() - started < WAIT_MS) {
    const acquired = await tryCreate(path, face, token);
    if (acquired) return acquired;

    if (await isStale(path)) {
      await takeoverStale(path);
      continue;
    }
    await sleep(250);
  }

  throw new Error("Summer Cloud sync already in progress");
}

async function tryCreate(path: string, face: Face, token: string): Promise<CloudLock | null> {
  const startedAt = new Date().toISOString();
  let file;
  try {
    file = await open(path, "wx", 0o600);
  } catch {
    return null;
  }
  try {
    await file.writeFile(JSON.stringify(payload(face, token, startedAt)), { encoding: "utf8" });
    await file.sync();
  } finally {
    await file.close();
  }

  // Re-check ownership: a racing waiter may have taken the file over between
  // our create and write. If the token on disk is not ours, we lost.
  if (!(await ownsLock(path, token))) {
    return null;
  }

  const heartbeat = setInterval(() => {
    void writeFile(path, JSON.stringify(payload(face, token, startedAt)), { encoding: "utf8" }).catch(() => {});
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  return {
    async release() {
      clearInterval(heartbeat);
      if (await ownsLock(path, token)) {
        await rm(path, { force: true });
      }
    },
  };
}

function payload(face: Face, token: string, startedAt: string): LockPayload {
  return { pid: process.pid, face, token, startedAt, heartbeatAt: new Date().toISOString() };
}

async function ownsLock(path: string, token: string): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Partial<LockPayload>;
    return raw.token === token;
  } catch {
    return false;
  }
}

async function isStale(path: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    // Gone already; the create loop will race for it.
    return false;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    const heartbeat = parsed.heartbeatAt ? Date.parse(parsed.heartbeatAt) : NaN;
    if (!Number.isFinite(heartbeat)) throw new Error("no heartbeat");
    return Date.now() - heartbeat > STALE_MS;
  } catch {
    // Unparseable: probably a holder between open('wx') and write. Treat as
    // fresh while the file is young; stale only once the mtime ages out.
    try {
      const info = await stat(path);
      return Date.now() - info.mtimeMs > STALE_MS;
    } catch {
      return false;
    }
  }
}

async function takeoverStale(path: string): Promise<void> {
  // Atomic claim: only one waiter wins the rename; the loser's rename fails
  // with ENOENT and it simply retries the exclusive create.
  const claimed = `${path}.takeover.${process.pid}.${Date.now()}`;
  try {
    await rename(path, claimed);
  } catch {
    return;
  }
  // Verify what we actually grabbed. If it turned fresh under us (the holder
  // heartbeated between our staleness read and the rename), restore it
  // without ever clobbering a lock someone else created in the gap.
  try {
    const content = await readFile(claimed, "utf8");
    const parsed = JSON.parse(content) as Partial<LockPayload>;
    const heartbeat = parsed.heartbeatAt ? Date.parse(parsed.heartbeatAt) : NaN;
    if (Number.isFinite(heartbeat) && Date.now() - heartbeat <= STALE_MS) {
      try {
        const file = await open(path, "wx", 0o600);
        await file.writeFile(content, { encoding: "utf8" });
        await file.close();
      } catch {
        // Someone else already created a new lock; the displaced holder's
        // next heartbeat write will contend through ownsLock on release.
      }
      await rm(claimed, { force: true });
      return;
    }
  } catch {
    // Unparseable claimed file: it aged past staleness to get here; discard.
  }
  await rm(claimed, { force: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
