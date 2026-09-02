import { afterEach, describe, expect, it } from "vitest";
import { WorkerOpError } from "./connection.js";
import { startFakeWorker, type FakeWorker } from "./test-helpers/fake-worker.js";
import { WorkerConnection } from "./worker-connection.js";

function connect(
  worker: FakeWorker,
  overrides: Partial<Parameters<typeof WorkerConnection.connect>[0]> = {}
): Promise<WorkerConnection> {
  return WorkerConnection.connect({
    port: worker.port,
    token: "secret",
    pid: worker.pid,
    projectPath: "/tmp/project",
    ...overrides,
  });
}

describe("WorkerConnection (protocol v1.1)", () => {
  let worker: FakeWorker | null = null;
  let connection: WorkerConnection | null = null;

  afterEach(async () => {
    connection?.close();
    connection = null;
    await worker?.close();
    worker = null;
  });

  it("completes the mutual-auth handshake (hello proof verified, auth answered) and pings", async () => {
    worker = await startFakeWorker({ token: "secret" });
    connection = await connect(worker);
    expect(connection.isAlive()).toBe(true);
    // The fake worker only accepts requests after verifying the client's
    // auth proof, so a recorded ping proves both directions authenticated.
    expect(worker.requests[0]?.op).toBe("ping");
  });

  it("rejects a worker whose hello proof does not match the registry token (fixed message, no token)", async () => {
    worker = await startFakeWorker({ token: "secret", badProof: true });
    const attempt = connect(worker, { token: "secret-token-value-must-not-leak" });
    await expect(attempt).rejects.toThrow(
      /\[headless:auth\].*worker proof mismatch/
    );
    const error = await attempt.catch((e: Error) => e);
    expect((error as Error).message).not.toContain(
      "secret-token-value-must-not-leak"
    );
  });

  it("rejects a stale-token client the same way (proof cannot be verified)", async () => {
    worker = await startFakeWorker({ token: "actual-worker-token" });
    const attempt = connect(worker, { token: "STALE-token-value-must-not-leak" });
    await expect(attempt).rejects.toThrow(
      /\[headless:auth\].*worker proof mismatch/
    );
    const error = await attempt.catch((e: Error) => e);
    expect((error as Error).message).not.toContain(
      "STALE-token-value-must-not-leak"
    );
  });

  it("rejects a hello whose pid does not match the registry pid (pid-reuse defense)", async () => {
    worker = await startFakeWorker({ token: "secret" });
    await expect(connect(worker, { pid: worker.pid + 1 })).rejects.toThrow(
      /\[headless:auth\].*worker pid mismatch/
    );
  });

  it("times out with a fixed auth error when the worker never sends hello", async () => {
    worker = await startFakeWorker({ token: "secret", noHello: true });
    await expect(
      connect(worker, { helloTimeoutMs: 150 })
    ).rejects.toThrow(/\[headless:auth\].*no hello within 150ms/);
  });

  it("connect failure to a closed port never contains the token", async () => {
    // Grab a port that is definitely closed by opening and closing a server.
    const probe = await startFakeWorker({ token: "x" });
    const closedPort = probe.port;
    await probe.close();
    const attempt = WorkerConnection.connect({
      port: closedPort,
      token: "super-secret-token",
      pid: 1234,
      projectPath: "/tmp/project",
      connectTimeoutMs: 500,
    });
    await expect(attempt).rejects.toThrow(/\[headless:connect\]/);
    const error = await attempt.catch((e: Error) => e);
    expect((error as Error).message).not.toContain("super-secret-token");
  });

  it("correlates out-of-order responses by id", async () => {
    const pendingEmits: Array<() => void> = [];
    worker = await startFakeWorker({
      token: "secret",
      handler: (op, params, emit) => {
        if (op === "ping") return emit.ok({ pong: true });
        // Answer 'slow' only after 'fast' has been answered — out of order.
        if (params.which === "slow") {
          pendingEmits.push(() => emit.ok({ which: "slow" }));
        } else {
          emit.ok({ which: "fast" });
          for (const flush of pendingEmits.splice(0)) flush();
        }
      },
    });
    connection = await connect(worker);
    const slow = connection.call("fs.read", { which: "slow" });
    const fast = connection.call("fs.read", { which: "fast" });
    await expect(fast).resolves.toEqual({ which: "fast" });
    await expect(slow).resolves.toEqual({ which: "slow" });
  });

  it("reassembles a multibyte codepoint split across TCP chunks", async () => {
    const payload = { text: "sûmmér — ☀️🌊 multibyte" };
    worker = await startFakeWorker({
      token: "secret",
      handler: (op, _params, emit, socket, id) => {
        if (op === "ping") return emit.ok({ pong: true });
        const frame = Buffer.from(
          JSON.stringify({ id, ok: true, result: payload }) + "\n",
          "utf-8"
        );
        // Split INSIDE the multibyte emoji bytes: find the sun emoji's first
        // byte and cut one byte after it.
        const emojiStart = frame.indexOf(Buffer.from("☀️", "utf-8"));
        const cut = emojiStart + 1;
        socket.write(frame.subarray(0, cut));
        setTimeout(() => socket.write(frame.subarray(cut)), 20);
      },
    });
    connection = await connect(worker);
    await expect(connection.call("fs.read")).resolves.toEqual(payload);
  });

  it("destroys the connection when an un-terminated frame exceeds the cap", async () => {
    worker = await startFakeWorker({
      token: "secret",
      handler: (op, _params, emit, socket) => {
        if (op === "ping") return emit.ok({ pong: true });
        // 4KiB of garbage with no newline against a 1KiB cap.
        socket.write(Buffer.alloc(4096, 0x41));
      },
    });
    connection = await connect(worker, { maxFrameBytes: 1024 });
    await expect(connection.call("fs.read")).rejects.toThrow(
      /un-terminated frame larger than 1024 bytes/
    );
    expect(connection.isAlive()).toBe(false);
  });

  it("surfaces interim progress events to the caller", async () => {
    worker = await startFakeWorker({
      token: "secret",
      handler: (op, _params, emit) => {
        if (op === "ping") return emit.ok({ pong: true });
        emit.progress({ pct: 25 });
        emit.progress({ pct: 90 });
        emit.ok({ imported: 3 });
      },
    });
    connection = await connect(worker);
    const seen: unknown[] = [];
    const result = await connection.call(
      "import",
      {},
      { onProgress: (p) => seen.push(p) }
    );
    expect(result).toEqual({ imported: 3 });
    expect(seen).toEqual([{ pct: 25 }, { pct: 90 }]);
  });

  it("maps ok:false responses to WorkerOpError with a structured code", async () => {
    worker = await startFakeWorker({
      token: "secret",
      handler: (op, _params, emit) => {
        if (op === "ping") return emit.ok({ pong: true });
        emit.error("sha256_mismatch: content changed since read");
      },
    });
    connection = await connect(worker);
    const attempt = connection.call("fs.write", { path: "a", content: "b" });
    await expect(attempt).rejects.toThrow("sha256_mismatch");
    const error = (await attempt.catch((e: unknown) => e)) as WorkerOpError;
    expect(error).toBeInstanceOf(WorkerOpError);
    expect(error.code).toBe("sha256_mismatch");
    // A failed op does not kill the channel.
    expect(connection.isAlive()).toBe(true);
  });

  it("scrubs the token out of worker-supplied op errors", async () => {
    worker = await startFakeWorker({
      token: "secret",
      handler: (op, _params, emit) => {
        if (op === "ping") return emit.ok({ pong: true });
        emit.error("worker exploded, auth was secret");
      },
    });
    connection = await connect(worker);
    const error = (await connection
      .call("fs.read")
      .catch((e: Error) => e)) as Error;
    expect(error.message).not.toContain("secret");
    expect(error.message).toContain("[redacted]");
  });

  it("fails all pending calls cleanly when the socket drops, and stays dead", async () => {
    worker = await startFakeWorker({
      token: "secret",
      handler: (op, _params, emit, socket) => {
        if (op === "ping") return emit.ok({ pong: true });
        socket.destroy(); // drop mid-request, no response
      },
    });
    connection = await connect(worker);
    await expect(connection.call("fs.read")).rejects.toThrow(
      /connection (closed|error)/i
    );
    expect(connection.isAlive()).toBe(false);
    // No reconnect-on-drop: subsequent calls fail immediately and cleanly.
    await expect(connection.call("ping")).rejects.toThrow(/closed/i);
  });

  it("a read-only op timeout leaves the connection usable", async () => {
    worker = await startFakeWorker({
      token: "secret",
      handler: (op, _params, emit) => {
        if (op === "ping") return emit.ok({ pong: true });
        if (op === "status") return emit.ok({ fine: true });
        // swallow fs.read
      },
    });
    connection = await connect(worker);
    await expect(
      connection.call("fs.read", {}, { timeoutMs: 100 })
    ).rejects.toThrow(/\[headless:op\].*no response or progress for 100ms/);
    // Channel survives a read-only timeout.
    expect(connection.isAlive()).toBe(true);
    await expect(connection.call("status")).resolves.toEqual({ fine: true });
  });

  it("QUARANTINES the connection when a MUTATING op times out (unknown outcome)", async () => {
    worker = await startFakeWorker({
      token: "secret",
      handler: (op, _params, emit) => {
        if (op === "ping") return emit.ok({ pong: true });
        // swallow fs.write — outcome unknown
      },
    });
    connection = await connect(worker);
    await expect(
      connection.call("fs.write", { path: "a", content: "b" }, { timeoutMs: 100 })
    ).rejects.toThrow(/outcome is UNKNOWN[\s\S]*quarantined/);
    // The whole connection is dead so nothing can silently retry into it.
    expect(connection.isAlive()).toBe(false);
    await expect(connection.call("ping")).rejects.toThrow(/quarantined/i);
  });

  it("progress events keep a slow op alive past its inactivity timeout", async () => {
    worker = await startFakeWorker({
      token: "secret",
      handler: (op, _params, emit) => {
        if (op === "ping") return emit.ok({ pong: true });
        // Total runtime 240ms with progress every 60ms; inactivity budget is
        // only 120ms — the op must survive because progress restarts it.
        let ticks = 0;
        const interval = setInterval(() => {
          ticks += 1;
          emit.progress({ tick: ticks });
          if (ticks === 4) {
            clearInterval(interval);
            emit.ok({ done: true });
          }
        }, 60);
      },
    });
    connection = await connect(worker);
    const seen: unknown[] = [];
    await expect(
      connection.call("import", {}, { timeoutMs: 120, onProgress: (p) => seen.push(p) })
    ).resolves.toEqual({ done: true });
    expect(seen.length).toBe(4);
  });
});
