import { resolve as resolvePath } from "path";
import { EngineApiClient } from "../api-client.js";
import type { ProjectConnection } from "./connection.js";
import { EditorConnection } from "./editor-connection.js";
import {
  findWorkerEntry,
  type ReadRegistryOptions,
  type WorkerRegistryEntry,
} from "./registry.js";
import { spawnWorker, type SpawnWorkerOptions } from "./spawn.js";
import { WorkerConnection } from "./worker-connection.js";

/**
 * resolveProjectConnection — the routing decision, in fixed priority order:
 *
 *   1. EDITOR   a live editor that has the project open (today's transport,
 *               via the existing instance registry in ~/.summer/instances)
 *   2. WORKER   a live headless worker registered for the project in
 *               <editor cache dir>/summer_processes.cfg
 *   3. SPAWN    launch `<engine> --summer-worker --path <project>`, wait for
 *               its registry entry (up to ~120s), connect to it
 *
 * Every step is injectable for tests; the defaults wire the real editor
 * discovery (core/engine.ts resolveEngineConnection via EngineApiClient),
 * the real registry reader, and the real spawner.
 */

export interface ResolveProjectConnectionOptions {
  registry?: ReadRegistryOptions;
  spawn?: Omit<SpawnWorkerOptions, "registry">;
  onProgress?: (progress: { phase: string; elapsedMs?: number }) => void;
  /** Test seams. Defaults are the real implementations. */
  deps?: {
    tryEditor?: (projectPath: string) => Promise<EditorConnection>;
    findWorker?: (
      projectPath: string,
      registry?: ReadRegistryOptions
    ) => Promise<WorkerRegistryEntry | null>;
    spawnWorker?: (
      projectPath: string,
      options?: SpawnWorkerOptions
    ) => Promise<WorkerRegistryEntry>;
    connectWorker?: (
      entry: WorkerRegistryEntry,
      projectPath: string
    ) => Promise<WorkerConnection>;
  };
}

async function defaultTryEditor(projectPath: string): Promise<EditorConnection> {
  // resolveEngineConnection (inside connect) throws when no live editor
  // matches this exact project — ONLY that failure class is the signal to
  // fall through to the worker path (see isNoEditorForProjectError).
  const client = await EngineApiClient.connect({ projectPath });
  return new EditorConnection(client, projectPath);
}

/**
 * Classify an editor-resolution failure. Routing may fall through to a
 * worker ONLY when the failure positively means "no live editor has this
 * project" (core/engine.ts: no registry match, or legacy no-api-token).
 * Everything else — ambiguity ("more than one editor matches"), identity
 * changes, an editor that exists but is not responding, auth failures, a
 * path that is not a project — means the editor's presence is UNCERTAIN, and
 * a worker must never write while that is true. Those errors RETHROW.
 * Exported for tests and for mcp-routing.
 */
export function isNoEditorForProjectError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("No running Summer editor matches") ||
    message.includes("no api-token found")
  );
}

function defaultConnectWorker(
  entry: WorkerRegistryEntry,
  projectPath: string
): Promise<WorkerConnection> {
  return WorkerConnection.connect({
    port: entry.port,
    token: entry.token,
    pid: entry.pid,
    projectPath,
  });
}

export async function resolveProjectConnection(
  projectPath: string,
  options: ResolveProjectConnectionOptions = {}
): Promise<ProjectConnection> {
  const target = resolvePath(projectPath);
  const tryEditor = options.deps?.tryEditor ?? defaultTryEditor;
  const findWorker = options.deps?.findWorker ?? findWorkerEntry;
  const doSpawn = options.deps?.spawnWorker ?? spawnWorker;
  const connectWorker = options.deps?.connectWorker ?? defaultConnectWorker;

  // 1. Editor beats worker. ONLY a positive "no editor has this project"
  // falls through — ambiguity/identity/auth/unresponsive-editor errors
  // rethrow, because a worker must never write while an editor's presence is
  // uncertain.
  try {
    return await tryEditor(target);
  } catch (error) {
    if (!isNoEditorForProjectError(error)) throw error;
  }

  // 2. Live worker from the registry. A stale entry whose process answers the
  // pid probe but whose socket/handshake is gone falls through to spawn —
  // and spawnWorker snapshots it as a baseline so the stale entry can never
  // satisfy the post-spawn poll.
  const existing = await findWorker(target, options.registry);
  if (existing) {
    try {
      return await connectWorker(existing, target);
    } catch {
      options.onProgress?.({ phase: "registry_worker_unreachable" });
    }
  }

  // 3. Spawn on demand, then connect.
  options.onProgress?.({ phase: "spawning_worker" });
  const entry = await doSpawn(target, {
    ...options.spawn,
    registry: options.registry,
    onProgress: options.onProgress,
  });
  return connectWorker(entry, target);
}
