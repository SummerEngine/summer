import { execFileSync } from "child_process";
import { mkdtemp, realpath, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkerRegistryEntry } from "./registry.js";
import { spawnWorker } from "./spawn.js";
import { WorkerConnection } from "./worker-connection.js";
import { WorkerEngineClient } from "./worker-engine-client.js";

/**
 * REAL integration test — spawns the actual engine worker binary and drives
 * it through the real WorkerConnection + WorkerEngineClient facade.
 *
 * Gated on SUMMER_ENGINE_BIN (or SUMMER_ENGINE_BINARY; skipped cleanly when
 * neither is set):
 *
 *   SUMMER_ENGINE_BIN=/path/to/Summer npx vitest run src/core/headless/worker-integration.test.ts
 *
 * Uses the engine's real registry (default cache dir) and real spawn path —
 * first import of the scratch project can take a while, hence the long
 * timeouts. The spawned worker is SIGTERMed on teardown.
 */

// Either this layer's override or the engine-install contract name gates the run.
const ENGINE_BIN = (
  process.env.SUMMER_ENGINE_BIN ?? process.env.SUMMER_ENGINE_BINARY
)?.trim();
const SLOW = 180_000;

describe.runIf(Boolean(ENGINE_BIN))("real worker integration", () => {
  let projectDir: string;
  let entry: WorkerRegistryEntry;
  let connection: WorkerConnection;
  let client: WorkerEngineClient;

  beforeAll(async () => {
    // realpath: on macOS mkdtemp returns /var/... which is a symlink to
    // /private/var/... — the engine registers the canonical path, so the
    // test works with the canonical form (and normalizeProjectPath does the
    // same for every lookup).
    projectDir = await realpath(
      await mkdtemp(join(tmpdir(), "summer-worker-it-"))
    );
    await writeFile(
      join(projectDir, "project.godot"),
      'config_version=5\n\n[application]\nconfig/name="HeadlessIT"\n'
    );

    entry = await spawnWorker(projectDir, {
      binary: ENGINE_BIN!,
      timeoutMs: 120_000,
    });
    connection = await WorkerConnection.connect({
      port: entry.port,
      token: entry.token,
      pid: entry.pid,
      projectPath: projectDir,
    });
    client = new WorkerEngineClient(connection);
  }, SLOW);

  afterAll(async () => {
    try {
      connection?.close();
    } catch {
      /* already dead */
    }
    if (entry?.pid) {
      try {
        process.kill(entry.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    // Belt-and-braces: even when NO registry entry was adopted (spawn or
    // handshake aborted mid-way), never leave a worker running against the
    // scratch project — match by the unique project path in its argv.
    // (spawnWorker's own timeout path also kills its child; this covers
    // every other abort.)
    if (projectDir) {
      try {
        execFileSync("pkill", ["-f", projectDir], { stdio: "ignore" });
      } catch {
        /* pkill exits 1 when nothing matched — nothing leaked */
      }
      await rm(projectDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("registers in the real registry and answers ping over the v1.1 handshake", async () => {
    expect(entry.role).toBe("worker");
    expect(connection.isAlive()).toBe(true);
    await expect(connection.call("ping")).resolves.toBeDefined();
  });

  it(
    "status answers through the facade",
    async () => {
      const status = await client.health();
      expect(status).toBeDefined();
    },
    SLOW
  );

  it(
    "fs write/read roundtrip through the facade",
    async () => {
      const content = `hello worker ${Date.now()}`;
      const write = (await client.executeOps([
        { op: "WriteFile", path: "res://it_hello.txt", content },
      ])) as { ok: boolean };
      expect(write.ok).toBe(true);

      const read = await client.readFile("res://it_hello.txt");
      expect(JSON.stringify(read)).toContain(content);
    },
    SLOW
  );

  it(
    "import completes (progress-tolerant long op)",
    async () => {
      await expect(
        connection.call("import", {}, { timeoutMs: 150_000 })
      ).resolves.toBeDefined();
    },
    SLOW
  );

  it(
    "scene.read on a freshly written scene through the facade",
    async () => {
      const scene =
        '[gd_scene format=3]\n\n[node name="Root" type="Node"]\n';
      await client.executeOps([
        { op: "WriteFile", path: "res://it_main.tscn", content: scene },
      ]);
      await connection.call("import", {}, { timeoutMs: 150_000 });

      const state = await client.getSceneState("res://it_main.tscn");
      expect(state).toBeDefined();
      expect(JSON.stringify(state)).toContain("Root");
    },
    SLOW
  );
});
