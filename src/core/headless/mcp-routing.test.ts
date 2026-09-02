import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineApiClient } from "../api-client.js";
import { EditorConnection } from "./editor-connection.js";
import { getHeadlessRoutedClient, resetHeadlessRouting } from "./mcp-routing.js";
import { startFakeWorker, type FakeWorker } from "./test-helpers/fake-worker.js";
import { WorkerConnection } from "./worker-connection.js";
import { WorkerEngineClient } from "./worker-engine-client.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("mcp-routing getHeadlessRoutedClient", () => {
  let projectDir: string;
  let worker: FakeWorker | null = null;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "summer-routing-"));
    await writeFile(join(projectDir, "project.godot"), "config_version=5\n");
  });

  afterEach(async () => {
    resetHeadlessRouting();
    await worker?.close();
    worker = null;
    await rm(projectDir, { recursive: true, force: true });
  });

  async function workerConnection(): Promise<WorkerConnection> {
    worker = worker ?? (await startFakeWorker({ token: "tok" }));
    return WorkerConnection.connect({
      port: worker.port,
      token: "tok",
      pid: worker.pid,
      projectPath: projectDir,
    });
  }

  it("returns null when the session has no project context", async () => {
    const resolve = vi.fn();
    const client = await getHeadlessRoutedClient(undefined, {
      resolve: resolve as never,
    });
    expect(client).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("SINGLE-FLIGHT: concurrent calls share one resolution and one connection", async () => {
    const resolve = vi.fn(async () => {
      await sleep(60);
      return workerConnection();
    });

    const [first, second] = await Promise.all([
      getHeadlessRoutedClient({ projectPath: projectDir }, { resolve: resolve as never }),
      getHeadlessRoutedClient({ projectPath: projectDir }, { resolve: resolve as never }),
    ]);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(first).not.toBeNull();
    expect(first).toBe(second); // literally the same client instance
  });

  it("keeps serving the cached worker while no editor appears (no re-resolution)", async () => {
    const resolve = vi.fn(async () => workerConnection());
    const editorProbe = vi.fn(async () => false);

    const first = await getHeadlessRoutedClient(
      { projectPath: projectDir },
      { resolve: resolve as never, editorProbe }
    );
    const second = await getHeadlessRoutedClient(
      { projectPath: projectDir },
      { resolve: resolve as never, editorProbe }
    );

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(editorProbe).toHaveBeenCalledTimes(1); // only the cached-path call
  });

  it("hands the session back to the editor path and CLOSES the superseded worker client", async () => {
    const resolve = vi.fn(async () => workerConnection());
    let editorPresent = false;
    const editorProbe = vi.fn(async () => editorPresent);

    const first = (await getHeadlessRoutedClient(
      { projectPath: projectDir },
      { resolve: resolve as never, editorProbe }
    )) as unknown as WorkerEngineClient;
    expect(first.isAlive()).toBe(true);

    // An editor opens the project between calls.
    editorPresent = true;
    const second = await getHeadlessRoutedClient(
      { projectPath: projectDir },
      { resolve: resolve as never, editorProbe }
    );

    expect(second).toBeNull(); // existing editor path takes over
    expect(first.isAlive()).toBe(false); // superseded client closed, not orphaned
  });

  it("returns null (existing path serves) when resolution picks the editor", async () => {
    const resolve = vi.fn(async () => {
      return new EditorConnection({} as EngineApiClient, projectDir);
    });
    const client = await getHeadlessRoutedClient(
      { projectPath: projectDir },
      { resolve: resolve as never }
    );
    expect(client).toBeNull();
  });

  it("propagates uncertain editor errors from the cached-worker probe", async () => {
    const resolve = vi.fn(async () => workerConnection());
    const first = await getHeadlessRoutedClient(
      { projectPath: projectDir },
      { resolve: resolve as never, editorProbe: async () => false }
    );
    expect(first).not.toBeNull();

    await expect(
      getHeadlessRoutedClient(
        { projectPath: projectDir },
        {
          resolve: resolve as never,
          editorProbe: async () => {
            throw new Error(
              "More than one Summer editor matches this project."
            );
          },
        }
      )
    ).rejects.toThrow(/More than one Summer editor matches/);
  });
});
