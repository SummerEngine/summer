import { afterEach, describe, expect, it } from "vitest";
import { startFakeWorker, type FakeWorker } from "./test-helpers/fake-worker.js";
import { WorkerConnection } from "./worker-connection.js";
import { WorkerEngineClient } from "./worker-engine-client.js";

async function connectedClient(
  worker: FakeWorker
): Promise<{ client: WorkerEngineClient; connection: WorkerConnection }> {
  const connection = await WorkerConnection.connect({
    port: worker.port,
    token: "secret",
    pid: worker.pid,
    projectPath: "/tmp/project",
  });
  return { client: new WorkerEngineClient(connection), connection };
}

describe("WorkerEngineClient", () => {
  let worker: FakeWorker | null = null;
  let cleanup: (() => void) | null = null;

  afterEach(async () => {
    cleanup?.();
    cleanup = null;
    await worker?.close();
    worker = null;
  });

  it("maps typed client methods onto worker ops", async () => {
    worker = await startFakeWorker({ token: "secret" });
    const { client, connection } = await connectedClient(worker);
    cleanup = () => connection.close();

    await client.health();
    await client.readFile("res://main.gd", 1000);
    await client.getFsTree("res://", 50);
    await client.getSceneState("res://main.tscn", { depth: 3 });
    await client.play("res://main.tscn");
    await client.stop();

    const ops = worker.requests.map((request) => request.op);
    expect(ops).toEqual([
      "ping", // connect verification
      "status",
      "fs.read",
      "fs.list",
      "scene.read",
      "game.run",
      "game.stop",
    ]);
    // Pinned worker param names: fs.read {path,maxBytes}, fs.list {dir},
    // scene.read {path} (depth/limit are NOT in the worker contract).
    // res:// is STRIPPED before anything crosses the wire; the default
    // fs.list root maps to "" (project root), never "res://".
    expect(worker.requests[2].params).toEqual({
      path: "main.gd",
      maxBytes: 1000,
    });
    expect(worker.requests[3].params).toEqual({ dir: "" });
    expect(worker.requests[4].params).toEqual({ path: "main.tscn" });
    expect(worker.requests[5].params).toEqual({ scene: "main.tscn" });
  });

  it("clamps fs.read maxBytes to the worker's 8MiB ceiling", async () => {
    worker = await startFakeWorker({ token: "secret" });
    const { client, connection } = await connectedClient(worker);
    cleanup = () => connection.close();

    await client.readFile("res://big.bin", 64 * 1024 * 1024);
    const read = worker.requests.find((request) => request.op === "fs.read");
    expect(read?.params).toEqual({
      path: "big.bin",
      maxBytes: 8 * 1024 * 1024,
    });
  });

  it("maps GetConsoleOutput to game.logs {tail} with client-side filtering", async () => {
    worker = await startFakeWorker({
      token: "secret",
      handler: (op, _params, emit) => {
        if (op === "ping") return emit.ok({ pong: true });
        emit.ok({ running: true, lines: ["INFO boot", "ERROR boom", "INFO ok"] });
      },
    });
    const { client, connection } = await connectedClient(worker);
    cleanup = () => connection.close();

    const result = (await client.executeOps([
      { op: "GetConsoleOutput", max_lines: 50, filter: "ERROR" },
    ])) as { results: Array<{ lines: string[] }> };

    const logs = worker.requests.find((request) => request.op === "game.logs");
    expect(logs?.params).toEqual({ tail: 50 }); // filter NOT sent to the worker
    expect(result.results[0].lines).toEqual(["ERROR boom"]);
  });

  it("maps IsGameRunning to game.logs and reads result.running", async () => {
    worker = await startFakeWorker({
      token: "secret",
      handler: (op, _params, emit) => {
        if (op === "ping") return emit.ok({ pong: true });
        emit.ok({ running: true, lines: [] });
      },
    });
    const { client, connection } = await connectedClient(worker);
    cleanup = () => connection.close();

    const result = (await client.executeOps([{ op: "IsGameRunning" }])) as {
      results: Array<{ op: string; running: boolean }>;
    };

    // status has NO running field — the flag must come from game.logs.
    expect(
      worker.requests.filter((request) => request.op === "game.logs")
    ).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ op: "IsGameRunning", running: true });
  });

  it("IsGameRunning maps the no-game state to false, never throws (old and new worker shapes)", async () => {
    // Old shape: pre-first-run game.logs ERRORS. Must map to running:false.
    worker = await startFakeWorker({
      token: "secret",
      handler: (op, _params, emit) => {
        if (op === "ping") return emit.ok({ pong: true });
        emit.error("no_game: no game session has been started");
      },
    });
    const first = await connectedClient(worker);
    cleanup = () => first.connection.close();
    const oldShape = (await first.client.executeOps([{ op: "IsGameRunning" }])) as {
      results: Array<{ running: boolean }>;
    };
    expect(oldShape.results[0].running).toBe(false);
    first.connection.close();
    await worker.close();

    // New shape: worker answers {running:false} pre-first-run.
    worker = await startFakeWorker({
      token: "secret",
      handler: (op, _params, emit) => {
        if (op === "ping") return emit.ok({ pong: true });
        emit.ok({ running: false, lines: [] });
      },
    });
    const second = await connectedClient(worker);
    cleanup = () => second.connection.close();
    const newShape = (await second.client.executeOps([{ op: "IsGameRunning" }])) as {
      results: Array<{ running: boolean }>;
    };
    expect(newShape.results[0].running).toBe(false);
  });

  it("translates a WriteFile-only executeOps batch to fs.write", async () => {
    worker = await startFakeWorker({ token: "secret" });
    const { client, connection } = await connectedClient(worker);
    cleanup = () => connection.close();

    const result = (await client.executeOps([
      { op: "WriteFile", path: "res://a.gd", content: "x", expectedSha256: "ff" },
    ])) as { ok: boolean; results: unknown[] };

    expect(result.ok).toBe(true);
    const write = worker.requests.find((request) => request.op === "fs.write");
    expect(write?.params).toMatchObject({
      path: "a.gd", // res:// stripped
      content: "x",
      expectedSha256: "ff",
    });
  });

  it("fails loudly (before applying anything) on ops without a worker equivalent", async () => {
    worker = await startFakeWorker({ token: "secret" });
    const { client, connection } = await connectedClient(worker);
    cleanup = () => connection.close();

    await expect(
      client.executeOps([{ op: "WriteFile", path: "a", content: "b" }, { op: "AddNode" }])
    ).rejects.toThrow(/not supported by the headless worker/);
    // Fail-closed: the WriteFile before the unsupported op must NOT have run.
    expect(worker.requests.some((request) => request.op === "fs.write")).toBe(false);

    await expect(client.inspectNode("/root")).rejects.toThrow(
      /not supported by the headless worker/
    );
  });

  it("maps a needs_display screenshot failure to an honest structured result", async () => {
    worker = await startFakeWorker({
      token: "secret",
      handler: (op, _params, emit) => {
        if (op === "ping") return emit.ok({ pong: true });
        emit.error("needs_display");
      },
    });
    const { client, connection } = await connectedClient(worker);
    cleanup = () => connection.close();

    const snapshot = await client.gameSnapshot();
    expect(snapshot.ok).toBe(false);
    expect(snapshot.failureReason).toBe("needs_display");
  });

  it("kill-the-worker-mid-request: clean error, then credentialsChanged() evicts", async () => {
    worker = await startFakeWorker({
      token: "secret",
      handler: (op, _params, emit, socket) => {
        if (op === "ping") return emit.ok({ pong: true });
        socket.destroy(); // die mid-request
      },
    });
    const { client, connection } = await connectedClient(worker);
    cleanup = () => connection.close();

    await expect(client.readFile("res://a.gd")).rejects.toThrow(
      /final state is unknown; do not retry blindly/
    );
    expect(client.isAlive()).toBe(false);
    // getClient()'s cache check calls credentialsChanged() — a dead worker
    // client reports drift so it is evicted and the next call re-resolves.
    await expect(client.credentialsChanged()).resolves.toBe(true);
  });
});

describe("WorkerEngineClient capability getters (EngineApiClient parity)", () => {
  let worker: FakeWorker | null = null;
  let cleanup: (() => void) | null = null;

  afterEach(async () => {
    cleanup?.();
    cleanup = null;
    await worker?.close();
    worker = null;
  });

  it("returns undefined before any status read, then the worker's advert after health()", async () => {
    worker = await startFakeWorker({
      token: "secret",
      handler: (op, params, emit) =>
        op === "status"
          ? emit.ok({ version: "0.5.71", capabilities: { protocolVersion: 1, opKinds: ["WriteFile", "GetConsoleOutput"] } })
          : emit.ok({ echoed: true, op, params }),
    });
    const { client, connection } = await connectedClient(worker);
    cleanup = () => connection.close();

    expect(client.getEngineCapabilities()).toBeUndefined();
    expect(client.getEngineVersion()).toBeUndefined();
    await client.health();
    expect(client.getEngineCapabilities()).toEqual({ protocolVersion: 1, opKinds: ["WriteFile", "GetConsoleOutput"] });
    expect(client.getEngineVersion()).toBe("0.5.71");
  });

  it("a status without an advert leaves the getters undefined (absence proves nothing)", async () => {
    worker = await startFakeWorker({ token: "secret" });
    const { client, connection } = await connectedClient(worker);
    cleanup = () => connection.close();
    await client.health();
    expect(client.getEngineCapabilities()).toBeUndefined();
    expect(client.getEngineVersion()).toBeUndefined();
  });

  it("unsupported() throws are tagged for withEngine's 'unsupported' class", async () => {
    worker = await startFakeWorker({ token: "secret" });
    const { client, connection } = await connectedClient(worker);
    cleanup = () => connection.close();
    const thrown = await client.inspectNode("/root").catch((error: unknown) => error);
    expect((thrown as Record<PropertyKey, unknown>)[Symbol.for("summer.thrownErrorClass")]).toBe("unsupported");
  });

  it("pollEvents (the editor's events channel) is unsupported headless — tagged, never faked", async () => {
    worker = await startFakeWorker({ token: "secret" });
    const { client, connection } = await connectedClient(worker);
    cleanup = () => connection.close();
    const thrown = await client.pollEvents({ wait: 0 }).catch((error: unknown) => error);
    expect((thrown as Error).message).toContain("pollEvents");
    expect((thrown as Record<PropertyKey, unknown>)[Symbol.for("summer.thrownErrorClass")]).toBe("unsupported");
  });
});
