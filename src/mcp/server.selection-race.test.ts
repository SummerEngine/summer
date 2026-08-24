import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeClient {
  id: string;
  credentialsChanged: () => Promise<boolean>;
}

const { connect } = vi.hoisted(() => ({
  connect: vi.fn<(
    selection?: { projectPath?: string }
  ) => Promise<FakeClient>>(),
}));

vi.mock("../lib/api-client.js", () => ({
  EngineApiClient: { connect },
}));

import {
  configureMcpEngineSelection,
  getClient,
  queueMcpEngineSelectionRefresh,
} from "./server.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function client(id: string): FakeClient {
  return { id, credentialsChanged: vi.fn(async () => false) };
}

beforeEach(() => {
  connect.mockReset();
  configureMcpEngineSelection({ projectPath: "/initial" });
});

describe("dynamic MCP engine selection", () => {
  it("blocks connection until an initial roots refresh completes", async () => {
    const roots = deferred<void>();
    const current = client("current");
    connect.mockResolvedValue(current);

    const refresh = queueMcpEngineSelectionRefresh(async () => {
      await roots.promise;
      configureMcpEngineSelection({ projectPath: "/from-roots" });
    });
    const pending = getClient();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(connect).not.toHaveBeenCalled();

    roots.resolve();
    await refresh;
    await expect(pending).resolves.toBe(current);
    expect(connect).toHaveBeenCalledWith({ projectPath: "/from-roots" });
  });

  it("waits for a newer roots refresh queued while an older one is pending", async () => {
    const firstRoots = deferred<void>();
    const secondRoots = deferred<void>();
    const current = client("current");
    connect.mockResolvedValue(current);

    const firstRefresh = queueMcpEngineSelectionRefresh(() => firstRoots.promise);
    const pending = getClient();
    const secondRefresh = queueMcpEngineSelectionRefresh(() => secondRoots.promise);
    firstRoots.resolve();
    await firstRefresh;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(connect).not.toHaveBeenCalled();

    secondRoots.resolve();
    await secondRefresh;
    await expect(pending).resolves.toBe(current);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("discards an in-flight connection when the project selection changes", async () => {
    const firstConnect = deferred<FakeClient>();
    const stale = client("stale");
    const current = client("current");
    connect
      .mockImplementationOnce(() => firstConnect.promise)
      .mockResolvedValueOnce(current);

    const pending = getClient();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    configureMcpEngineSelection({ projectPath: "/current" });
    firstConnect.resolve(stale);

    await expect(pending).resolves.toBe(current);
    expect(connect).toHaveBeenNthCalledWith(1, { projectPath: "/initial" });
    expect(connect).toHaveBeenNthCalledWith(2, { projectPath: "/current" });
  });

  it("does not return a cached client cleared during credential validation", async () => {
    const check = deferred<boolean>();
    const stale: FakeClient = {
      id: "stale",
      credentialsChanged: vi.fn(() => check.promise),
    };
    const current = client("current");
    connect.mockResolvedValueOnce(stale).mockResolvedValueOnce(current);

    await expect(getClient()).resolves.toBe(stale);
    const pending = getClient();
    await vi.waitFor(() =>
      expect(stale.credentialsChanged).toHaveBeenCalledTimes(1)
    );
    configureMcpEngineSelection({ projectPath: "/current" });
    check.resolve(false);

    await expect(pending).resolves.toBe(current);
  });
});
