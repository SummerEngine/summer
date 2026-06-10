import { createHash } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { EngineApiClient } from "../api-client.js";
import { checkEngineHealth, getApiPort, getApiToken } from "../engine.js";

/**
 * Engine coordination (spec 8.6.1 and 8.7). All calls degrade gracefully: an
 * unreachable engine never blocks a sync; the stability check and conflict
 * routing cover the gaps.
 */

/** sha256 hex of the stable .summer/local/.project_id (mirrors SummerEngineIdentity::project_id_hash). */
export async function readProjectIdHash(projectRoot: string): Promise<string | null> {
  try {
    const id = (await readFile(join(projectRoot, ".summer", "local", ".project_id"), "utf8")).trim();
    if (!id) return null;
    return createHash("sha256").update(id, "utf8").digest("hex");
  } catch {
    return null;
  }
}

export async function readProjectPathMarker(projectRoot: string): Promise<string | null> {
  try {
    const marker = (await readFile(join(projectRoot, ".summer", "local", ".project_path"), "utf8")).trim();
    return marker || null;
  } catch {
    return null;
  }
}

export async function writeProjectPathMarker(projectRoot: string): Promise<void> {
  const dir = join(projectRoot, ".summer", "local");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".project_path"), projectRoot, "utf8");
}

interface EngineSession {
  client: EngineApiClient;
  projectIdHash: string;
  scene?: string;
}

async function connectForProject(projectRoot: string): Promise<EngineSession | null> {
  const projectIdHash = await readProjectIdHash(projectRoot);
  if (!projectIdHash) return null;
  try {
    const port = await getApiPort();
    const token = await getApiToken();
    if (!token) return null;
    const health = await checkEngineHealth(port);
    if (!health) return null;
    // A different project's engine instance must never be asked to save or
    // rescan; the executor rejects mismatches too, but skip the round trip.
    if (health.projectIdHash && health.projectIdHash !== projectIdHash) return null;
    return { client: new EngineApiClient(port, token), projectIdHash, scene: health.scene };
  } catch {
    return null;
  }
}

/**
 * Before hashing (spec 8.6.1): ask the running engine to flush dirty scenes
 * to disk so the walk hashes what the user actually sees.
 */
export async function saveDirtyScenesIfRunning(projectRoot: string): Promise<boolean> {
  const session = await connectForProject(projectRoot);
  if (!session) return false;
  try {
    await session.client.executeOps([{ op: "SaveDirtyScenes" }], { projectIdHash: session.projectIdHash });
    return true;
  } catch {
    return false;
  }
}

/**
 * After apply (spec 8.7): trigger a filesystem rescan and reload the open
 * scene if the pull replaced it. ScanChanges is the engine-side hook; older
 * engines without it simply reject the op and the editor's own focus scan
 * picks the changes up.
 */
export async function notifyEngineAfterApply(projectRoot: string, appliedPaths: readonly string[]): Promise<void> {
  if (!appliedPaths.length) return;
  const session = await connectForProject(projectRoot);
  if (!session) return;
  try {
    await session.client.executeOps([{ op: "ScanChanges" }], { projectIdHash: session.projectIdHash });
  } catch {
    // Engine build without the ScanChanges op; non-fatal.
  }
  try {
    const scene = session.scene;
    if (scene && scene.startsWith("res://")) {
      const sceneRel = scene.slice("res://".length);
      if (appliedPaths.includes(sceneRel)) {
        await session.client.executeOps([{ op: "OpenScene", path: scene }], { projectIdHash: session.projectIdHash });
      }
    }
  } catch {
    // Reload is best-effort; the editor reloads from disk on focus.
  }
}
