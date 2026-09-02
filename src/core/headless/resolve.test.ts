import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineApiClient } from "../api-client.js";
import { EditorConnection } from "./editor-connection.js";
import { REGISTRY_FILENAME } from "./registry.js";
import { isNoEditorForProjectError, resolveProjectConnection } from "./resolve.js";
import { spawnWorker, type LaunchHandle } from "./spawn.js";
import { startFakeWorker, type FakeWorker } from "./test-helpers/fake-worker.js";

const PROJECT = "/Users/dev/FakeGame";

function fakeEditor(): EditorConnection {
  return new EditorConnection({} as EngineApiClient, PROJECT);
}

function idleHandle(): LaunchHandle {
  return { exit: () => null, stderrTail: () => "" };
}

function registryText(port: number, token: string, pid = process.pid): string {
  return [
    `["${PROJECT}"]`,
    'role="worker"',
    `pid=${pid}`,
    `port=${port}`,
    `token="${token}"`,
    "started_ts=1756700000",
  ].join("\n");
}

describe("resolveProjectConnection", () => {
  let dir: string;
  let registryPath: string;
  let worker: FakeWorker | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "summer-resolve-"));
    registryPath = join(dir, REGISTRY_FILENAME);
  });

  afterEach(async () => {
    await worker?.close();
    worker = null;
    await rm(dir, { recursive: true, force: true });
  });

  it("classifies editor errors: only positive no-editor messages fall through", () => {
    expect(
      isNoEditorForProjectError(
        new Error(
          "No running Summer editor matches project /x. Open that project in Summer Engine and retry."
        )
      )
    ).toBe(true);
    expect(
      isNoEditorForProjectError(
        new Error(
          "Summer Engine is not running (no api-token found). Open Summer Engine first."
        )
      )
    ).toBe(true);
    for (const uncertain of [
      "More than one Summer editor matches this project. Select one with `summer mcp --instance <id>`:",
      "Summer Engine registry identity changed on port 6550; refusing to connect to the wrong editor.",
      "Summer Engine project identity changed on port 6550; refusing to connect to the wrong project.",
      "Summer Engine instance abc is not responding on port 6550.",
      "No project.godot found at or above /not/a/project.",
      "Engine API error 401: unauthorized",
    ]) {
      expect(isNoEditorForProjectError(new Error(uncertain))).toBe(false);
    }
  });

  it("RETHROWS ambiguous/uncertain editor errors instead of falling through to a worker", async () => {
    worker = await startFakeWorker({ token: "tok" });
    await writeFile(registryPath, registryText(worker.port, "tok"));

    await expect(
      resolveProjectConnection(PROJECT, {
        registry: { registryPath, isAlive: () => true },
        deps: {
          tryEditor: async () => {
            throw new Error(
              "More than one Summer editor matches this project. Select one with `summer mcp --instance <id>`:"
            );
          },
        },
      })
    ).rejects.toThrow(/More than one Summer editor matches/);
    // The worker was never contacted while editor presence was uncertain.
    expect(worker.requests).toHaveLength(0);
  });

  it("prefers a live editor over a live worker", async () => {
    worker = await startFakeWorker({ token: "tok" });
    await writeFile(registryPath, registryText(worker.port, "tok"));

    const connection = await resolveProjectConnection(PROJECT, {
      registry: { registryPath, isAlive: () => true },
      deps: { tryEditor: async () => fakeEditor() },
    });

    expect(connection.kind).toBe("editor");
    // The worker was never contacted.
    expect(worker.requests).toHaveLength(0);
  });

  it("falls back to a live registered worker when no editor matches", async () => {
    worker = await startFakeWorker({ token: "tok" });
    await writeFile(registryPath, registryText(worker.port, "tok"));

    const connection = await resolveProjectConnection(PROJECT, {
      registry: { registryPath, isAlive: () => true },
      deps: {
        tryEditor: async () => {
          throw new Error("No running Summer editor matches this project.");
        },
      },
    });

    expect(connection.kind).toBe("worker");
    expect(await connection.call("ping")).toBeTruthy();
    connection.close();
  });

  it("matches registry sections with a trailing slash on the lookup path", async () => {
    worker = await startFakeWorker({ token: "tok" });
    await writeFile(registryPath, registryText(worker.port, "tok"));

    const connection = await resolveProjectConnection(`${PROJECT}/`, {
      registry: { registryPath, isAlive: () => true },
      deps: {
        tryEditor: async () => {
          throw new Error("No running Summer editor matches this project.");
        },
      },
    });
    expect(connection.kind).toBe("worker");
    connection.close();
  });

  it("spawns a worker on demand when neither editor nor worker exists", async () => {
    worker = await startFakeWorker({ token: "spawned-tok" });
    const port = worker.port;

    // The mocked launcher plays the engine's part: it registers the worker.
    const launch = vi.fn((_binary: string, _args: string[]): LaunchHandle => {
      void writeFile(registryPath, registryText(port, "spawned-tok"));
      return idleHandle();
    });

    const connection = await resolveProjectConnection(PROJECT, {
      registry: { registryPath, isAlive: () => true },
      spawn: {
        binary: "/fake/summer-bin",
        launch,
        timeoutMs: 5000,
        pollIntervalMs: 10,
      },
      deps: {
        tryEditor: async () => {
          throw new Error("No running Summer editor matches this project.");
        },
      },
    });

    expect(launch).toHaveBeenCalledTimes(1);
    expect(connection.kind).toBe("worker");
    expect(await connection.call("status")).toBeTruthy();
    connection.close();
  });

  it("spawn path passes --summer-worker --path <project> as argv (no shell)", async () => {
    const seen: Array<{ binary: string; args: string[] }> = [];
    worker = await startFakeWorker({ token: "tok" });
    const port = worker.port;

    await expect(
      spawnWorker(PROJECT, {
        binary: "/fake/summer-bin",
        registry: { registryPath, isAlive: () => true },
        timeoutMs: 5000,
        pollIntervalMs: 20,
        launch: (binary, args) => {
          seen.push({ binary, args });
          // Simulate slow registration: write the entry shortly after launch.
          setTimeout(() => {
            void writeFile(registryPath, registryText(port, "tok"));
          }, 50);
          return idleHandle();
        },
      })
    ).resolves.toMatchObject({ port, token: "tok" });

    expect(seen).toEqual([
      {
        binary: "/fake/summer-bin",
        args: ["--summer-worker", "--path", PROJECT],
      },
    ]);
  });

  it("single-flight: concurrent resolves with no backend spawn exactly ONE worker", async () => {
    worker = await startFakeWorker({ token: "tok" });
    const port = worker.port;

    const launch = vi.fn((): LaunchHandle => {
      setTimeout(() => {
        void writeFile(registryPath, registryText(port, "tok"));
      }, 60);
      return idleHandle();
    });

    const optionsFor = () => ({
      registry: { registryPath, isAlive: () => true },
      spawn: {
        binary: "/fake/summer-bin",
        launch,
        timeoutMs: 5000,
        pollIntervalMs: 10,
      },
      deps: {
        tryEditor: async () => {
          throw new Error("No running Summer editor matches this project.");
        },
      },
    });

    const [first, second] = await Promise.all([
      resolveProjectConnection(PROJECT, optionsFor()),
      resolveProjectConnection(PROJECT, optionsFor()),
    ]);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(first.kind).toBe("worker");
    expect(second.kind).toBe("worker");
    first.close();
    second.close();
  });

  it("surfaces exit code and stderr tail when the worker dies before registering", async () => {
    await expect(
      spawnWorker(PROJECT, {
        binary: "/fake/summer-bin",
        registry: { registryPath, isAlive: () => true },
        timeoutMs: 5000,
        pollIntervalMs: 10,
        launch: () => ({
          exit: () => ({ code: 3, signal: null }),
          stderrTail: () => "ERROR: project file is corrupt\n",
        }),
      })
    ).rejects.toThrow(
      /exited before registering \(code 3\)[\s\S]*project file is corrupt/
    );
  });

  it("default launcher captures a real crashed process's stderr", async () => {
    // Use the node binary itself as the "engine": it rejects --summer-worker
    // and exits fast, exercising the real spawn + stderr-file capture path.
    await expect(
      spawnWorker(PROJECT, {
        binary: process.execPath,
        registry: { registryPath, isAlive: () => true },
        timeoutMs: 10_000,
        pollIntervalMs: 25,
      })
    ).rejects.toThrow(/exited before registering[\s\S]*(bad option|summer-worker)/);
  });

  it("a nonexistent binary path surfaces the launch error instead of crashing", async () => {
    await expect(
      spawnWorker(PROJECT, {
        binary: "/definitely/not/a/real/engine-binary",
        registry: { registryPath, isAlive: () => true },
        timeoutMs: 5000,
        pollIntervalMs: 25,
      })
    ).rejects.toThrow(/exited before registering[\s\S]*ENOENT/);
  });

  it("spawn timeout is a stage-tagged HeadlessTimeoutError and KILLS the abandoned child", async () => {
    const kill = vi.fn();
    await expect(
      spawnWorker(PROJECT, {
        binary: "/fake/summer-bin",
        registry: { registryPath, isAlive: () => true },
        timeoutMs: 120,
        pollIntervalMs: 20,
        launch: () => ({ ...idleHandle(), kill }),
      })
    ).rejects.toThrow(/\[headless:spawn\].*did not register within/);
    // The just-spawned child must never be leaked on an abandoned attempt.
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("normalizeProjectPath realpaths symlinked lookups (macOS /var vs /private/var)", async () => {
    // The engine canonicalizes section paths; a symlinked lookup path must
    // still match. tmpdir() on macOS returns the /var symlink form.
    const symlinked = await mkdtemp(join(tmpdir(), "summer-realpath-"));
    const { realpath } = await import("fs/promises");
    const canonical = await realpath(symlinked);
    try {
      worker = await startFakeWorker({ token: "tok" });
      // Registry section written with the CANONICAL path (engine behavior).
      await writeFile(
        registryPath,
        [
          `["${canonical}"]`,
          'role="worker"',
          `pid=${process.pid}`,
          `port=${worker.port}`,
          'token="tok"',
        ].join("\n")
      );
      // Lookup with the SYMLINKED form must still find it.
      const { findWorkerEntry } = await import("./registry.js");
      const entry = await findWorkerEntry(symlinked, {
        registryPath,
        isAlive: () => true,
      });
      expect(entry?.token).toBe("tok");
    } finally {
      await rm(symlinked, { recursive: true, force: true });
    }
  });

  it("a stale live-pid entry can NEVER satisfy the post-spawn poll (baseline snapshot)", async () => {
    worker = await startFakeWorker({ token: "fresh-tok" });
    const port = worker.port;
    // A stale entry with a LIVE pid already sits in the registry (its socket
    // is dead — that is why we are spawning).
    await writeFile(registryPath, registryText(9999, "stale-tok"));

    const entry = await spawnWorker(PROJECT, {
      binary: "/fake/summer-bin",
      registry: { registryPath, isAlive: () => true },
      timeoutMs: 5000,
      pollIntervalMs: 10,
      launch: () => {
        // The real worker replaces the section shortly after launch.
        setTimeout(() => {
          void writeFile(registryPath, registryText(port, "fresh-tok"));
        }, 60);
        return idleHandle();
      },
    });

    expect(entry.token).toBe("fresh-tok");
    expect(entry.port).toBe(port);
  });

  it("times out (instead of re-adopting the stale entry) when the spawned worker never replaces it", async () => {
    // Stale live-pid entry present the whole time; launch never updates it.
    await writeFile(registryPath, registryText(9999, "stale-tok"));

    await expect(
      spawnWorker(PROJECT, {
        binary: "/fake/summer-bin",
        registry: { registryPath, isAlive: () => true },
        timeoutMs: 150,
        pollIntervalMs: 20,
        launch: idleHandle,
      })
    ).rejects.toThrow(/\[headless:spawn\].*did not register within/);
  });

  it("dead-pid registry entries are pruned, so resolution proceeds to spawn", async () => {
    worker = await startFakeWorker({ token: "tok" });
    const port = worker.port;
    // Entry exists but its pid is dead — must be ignored.
    await writeFile(registryPath, registryText(9999, "stale-tok", 4194304));

    const spawned = vi.fn(async () => {
      await writeFile(registryPath, registryText(port, "tok", process.pid));
      return {
        projectPath: PROJECT,
        role: "worker",
        pid: process.pid,
        port,
        token: "tok",
      };
    });

    const connection = await resolveProjectConnection(PROJECT, {
      registry: { registryPath, isAlive: (pid) => pid === process.pid },
      deps: {
        tryEditor: async () => {
          throw new Error("No running Summer editor matches this project.");
        },
        spawnWorker: spawned,
      },
    });

    expect(spawned).toHaveBeenCalledTimes(1);
    expect(connection.kind).toBe("worker");
    connection.close();
  });
});
