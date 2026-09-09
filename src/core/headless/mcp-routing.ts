import { EngineApiClient } from "../api-client.js";
import { findProjectRoot, type EngineSelection } from "../engine.js";
import { isNoEditorForProjectError, resolveProjectConnection } from "./resolve.js";
import { normalizeProjectPath } from "./registry.js";
import { WorkerConnection } from "./worker-connection.js";
import { WorkerEngineClient } from "./worker-engine-client.js";

/**
 * The ONLY hook the existing MCP server calls into this module — and only
 * when SUMMER_HEADLESS_ROUTING=1 (see src/mcp/server.ts getClient, which
 * dynamic-imports this file so the flag-off path never even loads it).
 *
 * Behavior contract:
 *   - returns null whenever the existing code path should handle the call:
 *       * no project context on the session (no projectPath, cwd not inside
 *         a project) — legacy single-editor discovery stays in charge
 *       * a live EDITOR has the project open — the existing EngineApiClient
 *         path (caching, credential-drift, identity binding) serves it
 *         EXACTLY as with the flag off
 *   - returns a WorkerEngineClient (cast to EngineApiClient — it implements
 *     the full public method surface) only when no editor has the project,
 *     connecting to a live registered worker or spawning one on demand.
 *   - editor-resolution errors that do NOT positively mean "no editor has
 *     this project" (ambiguity, identity change, unresponsive editor) are
 *     RETHROWN — a worker must never write while an editor's presence is
 *     uncertain.
 *   - SINGLE-FLIGHT per project: concurrent tool calls share one in-flight
 *     resolution, so a burst of first calls can never spawn more than one
 *     worker or open more than one connection. A superseded cached
 *     connection is always closed, never orphaned.
 */

interface RoutingDeps {
  /** Full resolution (editor -> worker -> spawn). Test seam. */
  resolve: typeof resolveProjectConnection;
  /** Cheap "does a live editor have this project?" probe used to hand a
   *  cached worker back to the editor path. Test seam. */
  editorProbe: (projectPath: string) => Promise<boolean>;
}

async function defaultEditorProbe(projectPath: string): Promise<boolean> {
  try {
    await EngineApiClient.connect({ projectPath });
    return true;
  } catch (error) {
    if (isNoEditorForProjectError(error)) return false;
    // Ambiguity / identity / unresponsive-editor: presence uncertain — the
    // caller must NOT keep serving from a worker. Propagate.
    throw error;
  }
}

const defaultDeps: RoutingDeps = {
  resolve: resolveProjectConnection,
  editorProbe: defaultEditorProbe,
};

let cachedWorker: { key: string; client: WorkerEngineClient } | null = null;
// Single-flight: normalized project path -> in-flight routing decision.
const inFlightRoutes = new Map<string, Promise<EngineApiClient | null>>();

async function projectPathFromSelection(
  selection?: EngineSelection
): Promise<string | null> {
  if (selection?.projectPath) {
    return (await findProjectRoot(selection.projectPath)) ?? null;
  }
  if (selection?.cwd) {
    return findProjectRoot(selection.cwd);
  }
  return null;
}

function dropCachedWorker(): void {
  cachedWorker?.client.close();
  cachedWorker = null;
}

export async function getHeadlessRoutedClient(
  selection?: EngineSelection,
  deps: Partial<RoutingDeps> = {}
): Promise<EngineApiClient | null> {
  const { resolve, editorProbe } = { ...defaultDeps, ...deps };
  const projectPath = await projectPathFromSelection(selection);
  if (!projectPath) return null;
  const key = normalizeProjectPath(projectPath);

  const inFlight = inFlightRoutes.get(key);
  if (inFlight) return inFlight;

  const route = (async (): Promise<EngineApiClient | null> => {
    // Editor beats worker on EVERY call, not just at first resolution: if an
    // editor opened the project after a worker started serving it, hand the
    // session back to the untouched editor path (and close the worker
    // client — never orphan it). The probe is cheap (instance registry read
    // + one short-timeout health GET).
    if (cachedWorker && cachedWorker.key === key && cachedWorker.client.isAlive()) {
      if (await editorProbe(projectPath)) {
        dropCachedWorker();
        return null;
      }
      return cachedWorker.client as unknown as EngineApiClient;
    }
    // Cached client is for another project or dead — close before replacing.
    dropCachedWorker();

    const connection = await resolve(projectPath);
    if (connection.kind === "editor") {
      // Discard the probe connection (HTTP, nothing to tear down) and let
      // the untouched existing path do what it does today.
      connection.close();
      return null;
    }

    const client = new WorkerEngineClient(connection as WorkerConnection);
    cachedWorker = { key, client };
    return client as unknown as EngineApiClient;
  })().finally(() => {
    inFlightRoutes.delete(key);
  });

  inFlightRoutes.set(key, route);
  return route;
}

/** Test-only: drop the cached worker client and any in-flight routes. */
export function resetHeadlessRouting(): void {
  dropCachedWorker();
  inFlightRoutes.clear();
}
